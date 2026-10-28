// The behaviour simulation (PRD "Behaviors" and "Simulation").
//
// One Pasture holds every live sheep. The server ticks it at 2 Hz and
// broadcasts whatever intents changed; the offline client runs the exact same
// class locally. Each sheep runs a small state machine with weighted random
// transitions. Movement is chosen here -- target points that are clear of
// scenery and of other sheep -- and only the endpoints travel on the wire.

import { nightAmount } from "./clock";
import { FEED_COOLDOWN_MS, PET_COOLDOWN_MS, type Food, type Intent, type State } from "./protocol";
import { hashString, pickWeighted, range, rng, type Rng } from "./rng";
import type { Traits } from "./traits";
import { blocked, inBounds, pathClear, walkableHalf } from "./world";

export const TICK_MS = 500;
/** Sheep whose owners are away (and wild sheep) are re-planned every 4th tick. */
const SLOW_EVERY = 4;

export const SPEED: Partial<Record<State, number>> = { wander: 0.95, social: 1.15, eat: 2.6 };
export const EAT_SECONDS: Record<Food, number> = { clover: 6, dandelion: 6.5, apple: 5, carrot: 9, hay: 14 };
/** Sheep body radius for collision, in world units. */
export const SHEEP_R = 0.95;
/** How close two resting sheep may stand. */
const PERSONAL_SPACE = 2.1;
const FOOD_GAP = 1.05;

export interface SimSheep {
  id: string;
  traits: Traits;
  country: string | null;
  level: number;
  wild: boolean;
  ownerOnline: boolean;
  intent: Intent;
  playBoostUntil: number;
  lastFedAt: number;
  lastPetAt: number;
  slot: number;
}

export interface SheepInit {
  id: string;
  traits: Traits;
  country: string | null;
  level: number;
  wild?: boolean;
  x: number;
  z: number;
  lastFedAt?: number;
  face?: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/** How long the walking part of an intent takes, in ms. */
export function walkMs(i: Intent): number {
  const sp = SPEED[i.state];
  if (!sp) return 0;
  return (Math.hypot(i.to[0] - i.from[0], i.to[1] - i.from[1]) / sp) * 1000;
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/** Where an intent puts its sheep at time t. Server and client both use this. */
export function intentPosition(i: Intent, t: number): [number, number] {
  const w = walkMs(i);
  if (w <= 0) return i.from;
  const f = Math.min(1, Math.max(0, (t - i.startAt) / w));
  // Gentle start and stop on a walk; a trot to food is brisker.
  const e = i.state === "eat" ? 1 - (1 - f) ** 2 : easeInOut(f);
  return [i.from[0] + (i.to[0] - i.from[0]) * e, i.from[1] + (i.to[1] - i.from[1]) * e];
}

export const intentEnd = (i: Intent) => i.startAt + i.duration;

export interface PastureOptions {
  /** Minimum flock size. Shortfall is made up with wild sheep that leave as owned ones arrive. */
  wildFloor?: number;
  seed?: number;
}

export class Pasture {
  readonly sheep = new Map<string, SimSheep>();
  private r: Rng;
  private tickNo = 0;
  private nextSlot = 0;
  private wildFloor: number;
  /** Spatial hash of where each sheep is standing or heading. Rebuilt every tick. */
  private grid = new Map<number, SimSheep[]>();
  private static GCELL = 6;

  constructor(opts: PastureOptions = {}) {
    this.r = rng(opts.seed ?? 1);
    this.wildFloor = opts.wildFloor ?? 0;
  }

  get ownedCount() {
    let n = 0;
    for (const s of this.sheep.values()) if (!s.wild) n++;
    return n;
  }

  get half() {
    return walkableHalf(this.sheep.size);
  }

  add(init: SheepInit, now: number, arriving = false): SimSheep {
    const s: SimSheep = {
      id: init.id,
      traits: init.traits,
      country: init.country,
      level: init.level,
      wild: !!init.wild,
      ownerOnline: false,
      playBoostUntil: 0,
      lastFedAt: init.lastFedAt ?? 0,
      lastPetAt: 0,
      slot: this.nextSlot++,
      intent: {
        id: init.id,
        state: arriving ? "drop" : "idle",
        from: [r2(init.x), r2(init.z)],
        to: [r2(init.x), r2(init.z)],
        startAt: now,
        duration: arriving ? 2600 : 1000 + this.r() * 4000,
        variant: Math.floor(this.r() * 1e6),
        face: r2(init.face ?? this.r() * Math.PI * 2 - Math.PI),
      },
    };
    this.sheep.set(s.id, s);
    this.index(s);
    return s;
  }

  remove(id: string) {
    this.sheep.delete(id);
  }

  position(s: SimSheep, now: number) {
    return intentPosition(s.intent, now);
  }

  /** A clear spot near the existing flock, so a newcomer lands among friends. */
  spawnPoint(): [number, number] {
    const half = walkableHalf(this.sheep.size + 1);
    const all = [...this.sheep.values()];
    for (let attempt = 0; attempt < 60; attempt++) {
      let x: number;
      let z: number;
      if (all.length && attempt < 40) {
        const near = all[Math.floor(this.r() * all.length)].intent.to;
        const a = this.r() * Math.PI * 2;
        const d = range(this.r, 3, 9);
        x = near[0] + Math.cos(a) * d;
        z = near[1] + Math.sin(a) * d;
      } else {
        x = range(this.r, -half * 0.3, half * 0.3);
        z = range(this.r, -half * 0.3, half * 0.3);
      }
      if (!inBounds(x, z, half, 8) || blocked(x, z, SHEEP_R + 0.6) || this.crowded(x, z, undefined)) continue;
      return [r2(x), r2(z)];
    }
    return [0, 0];
  }

  /**
   * Add or remove wild sheep so the flock never drops below the floor. Returns
   * what changed so the caller can tell clients.
   */
  balanceWild(now: number, makeTraits: (r: Rng) => Traits): { added: SimSheep[]; removed: string[] } {
    const added: SimSheep[] = [];
    const removed: string[] = [];
    const owned = this.ownedCount;
    let wild = this.sheep.size - owned;
    const want = Math.max(0, this.wildFloor - owned);
    while (wild > want) {
      const w = [...this.sheep.values()].find((s) => s.wild);
      if (!w) break;
      this.remove(w.id);
      removed.push(w.id);
      wild--;
    }
    for (let n = 0; wild < want; n++) {
      // Wild ids are stable per slot so a restart does not reshuffle them.
      let i = 0;
      while (this.sheep.has(`wild-${i}`)) i++;
      const id = `wild-${i}`;
      const [x, z] = this.spawnPoint();
      const s = this.add(
        { id, traits: makeTraits(rng(hashString(id))), country: null, level: 1 + Math.floor(rng(hashString(id) ^ 7)() * 12), wild: true, x, z },
        now,
      );
      added.push(s);
      wild++;
    }
    return { added, removed };
  }

  /** Advance the flock. Returns the intents that changed. */
  tick(now: number): Intent[] {
    this.tickNo++;
    this.rebuildGrid();
    const out: Intent[] = [];
    for (const s of this.sheep.values()) {
      if (now < intentEnd(s.intent)) continue;
      const lively = s.ownerOnline;
      if (!lively && (this.tickNo + s.slot) % SLOW_EVERY !== 0) continue;
      s.intent = this.plan(s, now);
      this.index(s);
      out.push(s.intent);
    }
    return out;
  }

  feed(id: string, food: Food, now: number): Intent | string {
    const s = this.sheep.get(id);
    if (!s) return "no_sheep";
    if (now - s.lastFedAt < FEED_COOLDOWN_MS) return "cooldown";
    if (s.intent.state === "drop" && now < intentEnd(s.intent)) return "busy";
    const [x, z] = this.position(s, now);
    const heading = s.intent.face;
    // Drop the food a little in front of the sheep, wherever there is room.
    for (let attempt = 0; attempt < 12; attempt++) {
      const a = heading + (attempt === 0 ? 0 : (this.r() - 0.5) * Math.PI * 1.6);
      const d = range(this.r, 2.6, 3.6);
      const fx = x + Math.cos(a) * d;
      const fz = z + Math.sin(a) * d;
      const dir = Math.atan2(fz - z, fx - x);
      const tx = fx - Math.cos(dir) * FOOD_GAP;
      const tz = fz - Math.sin(dir) * FOOD_GAP;
      if (blocked(fx, fz, 0.4) || blocked(tx, tz, SHEEP_R) || !pathClear(x, z, tx, tz, SHEEP_R * 0.8)) continue;
      const i: Intent = {
        id,
        state: "eat",
        from: [r2(x), r2(z)],
        to: [r2(tx), r2(tz)],
        startAt: now,
        duration: 0,
        variant: Math.floor(this.r() * 1e6),
        food: { kind: food, x: r2(fx), z: r2(fz) },
        face: r2(dir),
      };
      i.duration = Math.round(walkMs(i) + EAT_SECONDS[food] * 1000);
      s.intent = i;
      s.lastFedAt = now;
      s.playBoostUntil = intentEnd(i) + 60_000;
      this.index(s);
      return i;
    }
    return "no_room";
  }

  pet(id: string, now: number): Intent | string {
    const s = this.sheep.get(id);
    if (!s) return "no_sheep";
    if (now - s.lastPetAt < PET_COOLDOWN_MS) return "cooldown";
    if (s.intent.state === "drop" && now < intentEnd(s.intent)) return "busy";
    const [x, z] = this.position(s, now);
    // Interrupting a meal would strand the food on everyone's screen.
    if (s.intent.state === "eat" && now < intentEnd(s.intent)) return "busy";
    s.lastPetAt = now;
    s.playBoostUntil = now + 60_000;
    s.intent = this.stand(s, "petted", x, z, now, 2000);
    return s.intent;
  }

  /** Level-up: a happy jump. */
  celebrate(id: string, now: number): Intent | null {
    const s = this.sheep.get(id);
    if (!s) return null;
    if (s.intent.state === "eat" && now < intentEnd(s.intent)) return null;
    const [x, z] = this.position(s, now);
    s.intent = this.stand(s, "play", x, z, now, 2600, 0);
    return s.intent;
  }

  // ------------------------------------------------------------ planning

  private stand(s: SimSheep, state: State, x: number, z: number, now: number, duration: number, variant?: number): Intent {
    return {
      id: s.id,
      state,
      from: [r2(x), r2(z)],
      to: [r2(x), r2(z)],
      startAt: now,
      duration: Math.round(duration),
      variant: variant ?? Math.floor(this.r() * 1e6),
      face: s.intent.face,
    };
  }

  private plan(s: SimSheep, now: number): Intent {
    const prev = s.intent;
    const [x, z] = intentPosition(prev, now);
    const night = nightAmount(now);
    const boosted = now < s.playBoostUntil;
    // Lively sheep: owner here (or wild). Absent owners' sheep mostly sleep and graze.
    const away = !s.wild && !s.ownerOnline;

    // After eating, a happy hop.
    if (prev.state === "eat") return this.stand(s, "play", x, z, now, range(this.r, 2200, 3200), 0);
    // After sleeping, stand a moment and look around before anything else.
    if (prev.state === "sleep") return this.stand(s, "idle", x, z, now, range(this.r, 3000, 6000));

    const w: Record<string, number> = {
      wander: 3,
      graze: 4,
      idle: 2.4,
      play: 0.8,
      social: 1.3,
      sleep: 0.45,
    };
    w.sleep *= 1 + night * 9;
    w.play *= 1 - night * 0.75;
    w.wander *= 1 - night * 0.5;
    w.social *= 1 - night * 0.4;
    if (boosted) w.play *= 6;
    if (away) {
      w.play *= 0.25;
      w.social *= 0.4;
      w.wander *= 0.5;
      w.sleep *= 1.6;
      w.graze *= 1.3;
    }
    // Don't do the same playful thing twice in a row.
    if (prev.state === "play") w.play *= 0.3;

    const choice = pickWeighted(this.r, w) as State;
    switch (choice) {
      case "wander":
        return this.planWander(s, x, z, now) ?? this.stand(s, "graze", x, z, now, range(this.r, 10_000, 40_000));
      case "social":
        return this.planSocial(s, x, z, now) ?? this.planWander(s, x, z, now) ?? this.stand(s, "idle", x, z, now, range(this.r, 3000, 10_000));
      case "graze":
        return this.stand(s, "graze", x, z, now, range(this.r, 10_000, 40_000));
      case "idle":
        return this.stand(s, "idle", x, z, now, range(this.r, 3000, 10_000));
      case "sleep":
        return this.stand(s, "sleep", x, z, now, range(this.r, 30_000, 120_000) * (1 + night * 0.6));
      case "play": {
        // 0 hop in place, 1 frolic a short loop, 2 chase a butterfly. The loop
        // and the chase leave the spot briefly, so they need room.
        let v = Math.floor(this.r() * 3);
        if (v !== 0 && blocked(x, z, 3.2)) v = 0;
        const variant = Math.floor(this.r() * 1e5) * 3 + v;
        return this.stand(s, "play", x, z, now, range(this.r, 3000, 8000), variant);
      }
    }
    return this.stand(s, "idle", x, z, now, 4000);
  }

  private planWander(s: SimSheep, x: number, z: number, now: number): Intent | null {
    const half = this.half;
    const neighbours = this.near(x, z, 20, s);
    for (let attempt = 0; attempt < 10; attempt++) {
      let tx: number;
      let tz: number;
      const dist = range(this.r, 2.5, 11);
      if (!inBounds(x, z, half, 6)) {
        // Outside the plain (it shrank, or we spawned at the edge): head home.
        const a = Math.atan2(-z, -x) + (this.r() - 0.5);
        tx = x + Math.cos(a) * dist;
        tz = z + Math.sin(a) * dist;
      } else if (neighbours.length && this.r() < 0.45) {
        // Cohesion: drift toward the local group, so flocks form.
        let cx = 0;
        let cz = 0;
        for (const n of neighbours) {
          cx += n.intent.to[0];
          cz += n.intent.to[1];
        }
        cx /= neighbours.length;
        cz /= neighbours.length;
        const a = Math.atan2(cz - z, cx - x) + (this.r() - 0.5) * 1.2;
        const d = Math.min(dist, Math.hypot(cx - x, cz - z) + 2);
        tx = x + Math.cos(a) * d;
        tz = z + Math.sin(a) * d;
      } else {
        const a = this.r() * Math.PI * 2;
        tx = x + Math.cos(a) * dist;
        tz = z + Math.sin(a) * dist;
      }
      if (Math.hypot(tx - x, tz - z) < 1.5) continue;
      if (inBounds(x, z, half, 6) && !inBounds(tx, tz, half, 6)) continue;
      if (blocked(tx, tz, SHEEP_R) || this.crowded(tx, tz, s)) continue;
      if (!pathClear(x, z, tx, tz, SHEEP_R * 0.8)) continue;
      const i: Intent = {
        id: s.id,
        state: "wander",
        from: [r2(x), r2(z)],
        to: [r2(tx), r2(tz)],
        startAt: now,
        duration: 0,
        variant: Math.floor(this.r() * 1e6),
        face: r2(Math.atan2(tz - z, tx - x)),
      };
      // A short pause at the end, inside the PRD's 5-20 s.
      i.duration = Math.round(Math.max(5000, Math.min(20_000, walkMs(i) + range(this.r, 600, 2600))));
      return i;
    }
    return null;
  }

  private planSocial(s: SimSheep, x: number, z: number, now: number): Intent | null {
    // Visit a nearby sheep that is standing still for long enough to be found there.
    const cands = this.near(x, z, 16, s).filter((o) => {
      const st = o.intent.state;
      if (st === "wander" || st === "eat" || st === "drop" || st === "social") return false;
      return intentEnd(o.intent) - now > 6000;
    });
    if (!cands.length) return null;
    const o = cands[Math.floor(this.r() * cands.length)];
    const [ox, oz] = o.intent.to;
    for (let attempt = 0; attempt < 6; attempt++) {
      // Approach from our side, slightly off-axis, and stop at nose distance.
      const a = Math.atan2(z - oz, x - ox) + (this.r() - 0.5) * 1.4;
      const tx = ox + Math.cos(a) * 1.75;
      const tz = oz + Math.sin(a) * 1.75;
      if (blocked(tx, tz, SHEEP_R) || !pathClear(x, z, tx, tz, SHEEP_R * 0.8)) continue;
      if (this.near(tx, tz, 1.4, s).some((n) => n !== o)) continue;
      const i: Intent = {
        id: s.id,
        state: "social",
        from: [r2(x), r2(z)],
        to: [r2(tx), r2(tz)],
        startAt: now,
        duration: 0,
        variant: Math.floor(this.r() * 1e6),
        other: o.id,
        face: r2(Math.atan2(oz - tz, ox - tx)),
      };
      i.duration = Math.round(Math.max(5000, Math.min(15_000, walkMs(i) + range(this.r, 3000, 7000))));
      if (i.duration > intentEnd(o.intent) - now) continue;
      return i;
    }
    return null;
  }

  // ------------------------------------------------------------ spatial hash

  private cellKey(x: number, z: number) {
    return (Math.floor(x / Pasture.GCELL) + 5000) * 20000 + (Math.floor(z / Pasture.GCELL) + 5000);
  }

  private rebuildGrid() {
    this.grid.clear();
    for (const s of this.sheep.values()) this.index(s);
  }

  private index(s: SimSheep) {
    const k = this.cellKey(s.intent.to[0], s.intent.to[1]);
    let list = this.grid.get(k);
    if (!list) this.grid.set(k, (list = []));
    if (!list.includes(s)) list.push(s);
  }

  /** Sheep whose destination is within `rad` of (x, z). */
  private near(x: number, z: number, rad: number, except?: SimSheep): SimSheep[] {
    const out: SimSheep[] = [];
    const c = Pasture.GCELL;
    const x0 = Math.floor((x - rad) / c);
    const x1 = Math.floor((x + rad) / c);
    const z0 = Math.floor((z - rad) / c);
    const z1 = Math.floor((z + rad) / c);
    const seen = new Set<SimSheep>();
    for (let cx = x0; cx <= x1; cx++)
      for (let cz = z0; cz <= z1; cz++) {
        const list = this.grid.get((cx + 5000) * 20000 + (cz + 5000));
        if (!list) continue;
        for (const o of list) {
          if (o === except || seen.has(o) || !this.sheep.has(o.id)) continue;
          // Entries go stale when a sheep re-plans mid-tick; check the live target.
          if (Math.hypot(o.intent.to[0] - x, o.intent.to[1] - z) > rad) continue;
          seen.add(o);
          out.push(o);
        }
      }
    return out;
  }

  /** Separation: is (x, z) inside another sheep's personal space? */
  private crowded(x: number, z: number, except: SimSheep | undefined) {
    return this.near(x, z, PERSONAL_SPACE, except).length > 0;
  }
}
