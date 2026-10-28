import { describe, expect, it } from "vitest";
import { expForLevel, expToNext, progressFromExp } from "../shared/levels";
import { Pasture, intentEnd, intentPosition, walkMs } from "../shared/sim";
import { rollTraits } from "../shared/traits";
import { rng } from "../shared/rng";
import { blocked, pathClear, WORLD, terrainHeight } from "../shared/world";
import { nightAmount, DAY_MS } from "../shared/clock";

describe("levels", () => {
  it("matches the PRD's curve", () => {
    expect(expToNext(1)).toBe(10);
    expect(expForLevel(2)).toBe(10); // ~10 minutes
    expect(expForLevel(5) / 60).toBeCloseTo(2.83, 1); // "about 3 hours"
    expect(expForLevel(10) / 60).toBeCloseTo(18.5, 1); // "about 18.5 hours"
  });
  it("round-trips exp to progress", () => {
    for (let e = 0; e < 3000; e += 7) {
      const p = progressFromExp(e);
      expect(expForLevel(p.level) + p.into).toBe(e);
      expect(p.into).toBeLessThan(p.next);
    }
  });
});

describe("clock", () => {
  it("has both day and night every hour, night about a third", () => {
    let night = 0;
    for (let t = 0; t < DAY_MS; t += 10_000) if (nightAmount(t) > 0.5) night++;
    const frac = night / (DAY_MS / 10_000);
    expect(frac).toBeGreaterThan(0.2);
    expect(frac).toBeLessThan(0.4);
  });
});

describe("world", () => {
  it("keeps the spawn meadow clear and has a pond in the first 400x400", () => {
    expect(blocked(0, 0, 3)).toBe(false);
    expect(WORLD.ponds.some((p) => Math.abs(p.x) < 200 && Math.abs(p.z) < 200)).toBe(true);
    expect(Number.isFinite(terrainHeight(12.3, -40))).toBe(true);
  });
});

function flock(n: number, now: number) {
  const p = new Pasture({ seed: 9 });
  const r = rng(4);
  for (let i = 0; i < n; i++) {
    const [x, z] = p.spawnPoint();
    p.add({ id: `s${i}`, traits: rollTraits(r), country: "NZ", level: 1, x, z }, now);
    p.sheep.get(`s${i}`)!.ownerOnline = i % 2 === 0;
  }
  return p;
}

describe("simulation", () => {
  it("runs a flock for an hour without walking through scenery or bunching up", () => {
    const t0 = 1_800_000_000_000;
    const p = flock(150, t0);
    const seen = new Set<string>();
    let moves = 0;
    let stacked = 0;
    let checks = 0;
    for (let t = t0; t < t0 + 60 * 60_000; t += 500) {
      for (const i of p.tick(t)) {
        seen.add(i.state);
        expect(i.duration).toBeGreaterThan(0);
        if (i.from[0] !== i.to[0] || i.from[1] !== i.to[1]) {
          moves++;
          expect(blocked(i.to[0], i.to[1], 0.9)).toBe(false);
          expect(pathClear(i.from[0], i.from[1], i.to[0], i.to[1], 0.7)).toBe(true);
        }
      }
      if ((t - t0) % 60_000 === 0) {
        // Resting sheep keep their distance (walkers may pass close by).
        const rest = [...p.sheep.values()].filter((s) => walkMs(s.intent) === 0 || t > s.intent.startAt + walkMs(s.intent));
        for (let a = 0; a < rest.length; a++)
          for (let b = a + 1; b < rest.length; b++) {
            const pa = intentPosition(rest[a].intent, t);
            const pb = intentPosition(rest[b].intent, t);
            checks++;
            if (Math.hypot(pa[0] - pb[0], pa[1] - pb[1]) < 1.2) stacked++;
          }
      }
    }
    for (const st of ["wander", "graze", "idle", "play", "social", "sleep"]) expect(seen).toContain(st);
    expect(moves).toBeGreaterThan(1000);
    expect(stacked / checks).toBeLessThan(0.001);
  });

  it("feeds: trots to the food, then hops; cooldown holds", () => {
    const t0 = 1_800_000_000_000;
    const p = flock(10, t0);
    p.tick(t0);
    const i = p.feed("s0", "carrot", t0 + 1000);
    expect(typeof i).toBe("object");
    if (typeof i === "string") return;
    expect(i.state).toBe("eat");
    expect(i.food?.kind).toBe("carrot");
    const [fx, fz] = [i.food!.x, i.food!.z];
    expect(Math.hypot(fx - i.to[0], fz - i.to[1])).toBeCloseTo(1.05, 1);
    expect(p.feed("s0", "hay", t0 + 2000)).toBe("cooldown");
    let next;
    for (let t = t0 + 1000; t < intentEnd(i) + 3000; t += 500) for (const x of p.tick(t)) if (x.id === "s0" && !next) next = x;
    expect(next?.state).toBe("play");
    expect(p.feed("s0", "hay", t0 + 2 * 60_000 + 1001)).not.toBe("cooldown");
  });

  it("tops the flock up with wild sheep and lets them leave as owned ones arrive", () => {
    const p = new Pasture({ wildFloor: 20 });
    p.balanceWild(0, rollTraits);
    expect(p.sheep.size).toBe(20);
    for (let i = 0; i < 5; i++) p.add({ id: `o${i}`, traits: rollTraits(rng(i)), country: "JP", level: 1, x: i * 3, z: 0 }, 0);
    const { removed } = p.balanceWild(0, rollTraits);
    expect(removed.length).toBe(5);
    expect(p.sheep.size).toBe(20);
  });
});
