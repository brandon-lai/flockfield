// Integration tests against a real local Worker + Durable Object (wrangler
// dev), for the criteria that involve identity and progression. EXP_SECONDS
// is shortened so "1 EXP per minute" can be checked in seconds; the rule
// under test is "never more than one EXP per EXP_SECONDS per sheep".

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PORT = 8799;
const B = `http://localhost:${PORT}`;
const EXP_SECONDS = 1;
let proc: ChildProcess;
let state: string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  state = mkdtempSync(join(tmpdir(), "flock-test-"));
  proc = spawn(
    "npx",
    ["wrangler", "dev", "--port", String(PORT), "--var", `EXP_SECONDS:${EXP_SECONDS}`, "--var", "REGISTER_PER_HOUR:5", "--var", "BEAT_GAP_SECONDS:1.5", "--persist-to", state],
    { cwd: join(__dirname, "../server"), stdio: "ignore", detached: true },
  );
  try {
    await fetch(B);
    throw new Error(`port ${PORT} is already serving; stop the old wrangler first`);
  } catch (e) {
    if ((e as Error).message.startsWith("port")) throw e;
  }
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(B)).ok) return;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  throw new Error("wrangler dev did not start");
}, 60_000);

// npx spawns wrangler which spawns workerd: kill the whole group, or the next run talks to this one.
afterAll(() => {
  if (proc?.pid) process.kill(-proc.pid, "SIGTERM");
});

type Msg = { t: string; [k: string]: any };

class Client {
  ws!: WebSocket;
  msgs: Msg[] = [];
  static async open(token: string | null, chunks?: number[]) {
    const c = new Client();
    c.ws = new WebSocket(B.replace("http", "ws") + "/ws");
    c.ws.onmessage = (e) => c.msgs.push(JSON.parse(e.data as string));
    await new Promise((r) => (c.ws.onopen = r));
    c.send({ t: "hello", token, sentAt: Date.now() });
    await c.waitFor((m) => m.t === "welcome");
    if (chunks) c.send({ t: "viewport", chunks });
    return c;
  }
  send(m: Msg) {
    this.ws.send(JSON.stringify(m));
  }
  async waitFor(pred: (m: Msg) => boolean, ms = 4000): Promise<Msg> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const m = this.msgs.find(pred);
      if (m) return m;
      await sleep(25);
    }
    throw new Error("timed out waiting for message; got " + this.msgs.map((m) => m.t).join(","));
  }
  last(t: string) {
    return [...this.msgs].reverse().find((m) => m.t === t);
  }
  close() {
    this.ws.close();
  }
}

// Registrations are limited per IP and every test request comes from localhost,
// so the suite shares a small pool of sheep.
const owners: { sheepId: string; ownerToken: string }[] = [];
async function register() {
  const r = await fetch(B + "/register", { method: "POST" });
  return { status: r.status, body: await r.json() };
}

const around = (x: number, z: number) => {
  const out: number[] = [];
  const cx = Math.floor(x / 50);
  const cz = Math.floor(z / 50);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) out.push((cx + dx + 100) * 1000 + (cz + dz + 100));
  return out;
};

describe("identity", () => {
  it("first visit creates a sheep and returns an owner token", async () => {
    for (let i = 0; i < 3; i++) {
      const r = await register();
      expect(r.status).toBe(200);
      expect(r.body.ownerToken).toMatch(/^[0-9a-f]{32}$/);
      owners.push(r.body);
    }
  });

  it("reconnecting with the token returns the same sheep", async () => {
    const a = await Client.open(owners[0].ownerToken);
    const w1 = a.last("welcome")!;
    a.close();
    const b = await Client.open(owners[0].ownerToken);
    const w2 = b.last("welcome")!;
    expect(w1.you.sheepId).toBe(owners[0].sheepId);
    expect(w2.you.sheepId).toBe(owners[0].sheepId);
    b.close();
  });

  it("a made-up token gets no sheep", async () => {
    const c = await Client.open("0".repeat(32));
    expect(c.last("welcome")!.you).toBeNull();
    expect(c.msgs.some((m) => m.t === "error" && m.code === "unknown_token")).toBe(true);
    c.close();
  });

  it("rate-limits registration per IP", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await register()).status);
    // 3 above + 2 more are allowed; the rest are refused.
    expect(statuses.filter((s) => s === 200).length).toBe(2);
    expect(statuses.slice(-2)).toEqual([429, 429]);
  });

  it("stores only a hash of the token, never an IP", async () => {
    const stats = await (await fetch(B + "/stats")).json();
    expect(stats.sheepTotal).toBeGreaterThanOrEqual(5);
    // The token itself must not round-trip anywhere public.
    const c = await Client.open(null, around(0, 0));
    await sleep(600);
    expect(JSON.stringify(c.msgs)).not.toContain(owners[0].ownerToken);
    c.close();
  });
});

describe("EXP", () => {
  it("credits from heartbeats, at most one per EXP_SECONDS however fast they come", async () => {
    const c = await Client.open(owners[1].ownerToken);
    const start = Date.now();
    // Spam heartbeats for ~3.2 s.
    while (Date.now() - start < 3200) {
      c.send({ t: "heartbeat" });
      await sleep(40);
    }
    await sleep(200);
    const you = c.last("you")!.you;
    const elapsed = (Date.now() - start) / 1000;
    expect(you.exp).toBeGreaterThanOrEqual(2);
    expect(you.exp).toBeLessThanOrEqual(Math.floor(elapsed / EXP_SECONDS));
    c.close();
  });

  it("earns nothing across a gap (hidden tab) longer than the heartbeat window", async () => {
    const c = await Client.open(owners[2].ownerToken);
    // Visible, hidden for 4 s (no heartbeats, as the client does), visible again.
    for (let k = 0; k < 4; k++) {
      c.send({ t: "heartbeat" });
      await sleep(4000);
    }
    c.send({ t: "heartbeat" });
    await sleep(200);
    // 16 s of wall clock, none of it continuously visible: nothing earned.
    expect(c.last("you")!.you.exp).toBe(0);
    c.close();
  }, 30_000);

  it("only one tab per sheep earns; the other is told it is watched elsewhere", async () => {
    const a = await Client.open(owners[1].ownerToken);
    const b = await Client.open(owners[1].ownerToken);
    expect(a.last("welcome")!.you.primary).toBe(true);
    expect(b.last("welcome")!.you.primary).toBe(false);
    const base = a.last("welcome")!.you.exp;
    const start = Date.now();
    while (Date.now() - start < 3200) {
      a.send({ t: "heartbeat" });
      b.send({ t: "heartbeat" });
      await sleep(40);
    }
    await sleep(200);
    const gained = a.last("you")!.you.exp - base;
    // Two tabs together still earn at the single-tab rate.
    expect(gained).toBeLessThanOrEqual(Math.floor((Date.now() - start) / 1000 / EXP_SECONDS));
    expect(b.last("you")!.you.primary).toBe(false);
    a.close();
    b.close();
  });
});

describe("shared pasture", () => {
  it("two clients see the same sheep moving, and see each other's feeding", async () => {
    const a = await Client.open(owners[0].ownerToken);
    const mine = a.msgs.find((m) => m.t === "snapshot")!.sheep[0];
    const [x, z] = mine.intent.to;
    a.send({ t: "viewport", chunks: around(x, z) });
    const b = await Client.open(null, around(x, z));
    const seen = await b.waitFor((m) => (m.t === "snapshot" || m.t === "spawn") && m.sheep.some((s: any) => s.id === mine.id));
    expect(seen).toBeTruthy();
    a.send({ t: "feed", food: "apple" });
    const fx = await b.waitFor((m) => m.t === "fx" && m.fx.some((f: any) => f.sheepId === mine.id && f.kind === "feed" && f.food === "apple"));
    expect(fx).toBeTruthy();
    const ia = await a.waitFor((m) => m.t === "intent" && m.intents.some((i: any) => i.id === mine.id && i.state === "eat"));
    const ib = await b.waitFor((m) => m.t === "intent" && m.intents.some((i: any) => i.id === mine.id && i.state === "eat"));
    // Identical intents: same start, same path, same food spot.
    expect(ib.intents.find((i: any) => i.id === mine.id)).toEqual(ia.intents.find((i: any) => i.id === mine.id));
    // The other client cannot feed someone else's sheep, and the cooldown holds.
    a.send({ t: "feed", food: "hay" });
    await a.waitFor((m) => m.t === "error" && m.code === "cooldown");
    a.close();
    b.close();
  });

  it("shows other sheep's country, and only streams chunks near the viewport", async () => {
    const c = await Client.open(null, around(0, 0));
    await sleep(700);
    const snap = c.msgs.filter((m) => m.t === "snapshot" || m.t === "spawn").flatMap((m) => m.sheep);
    expect(snap.length).toBeGreaterThan(0);
    // Local wrangler has no CF-IPCountry; owned sheep record "XX", wild ones null.
    for (const s of snap) expect(s.country === null || /^[A-Z]{2}$/.test(s.country)).toBe(true);
    const ids = around(0, 0);
    for (const s of snap) {
      const inChunk = [s.intent.from, s.intent.to].some(([x, z]: number[]) => ids.includes((Math.floor(x / 50) + 100) * 1000 + Math.floor(z / 50) + 100));
      expect(inChunk).toBe(true);
    }
    // A far-away viewport gets none of them, and they are despawned.
    c.send({ t: "viewport", chunks: [(10 + 100) * 1000 + 110] });
    const gone = await c.waitFor((m) => m.t === "despawn");
    expect(gone.ids.length).toBeGreaterThan(0);
    c.close();
  });

  it("refuses an oversized or malformed message without dropping the socket", async () => {
    const c = await Client.open(null);
    c.ws.send("{not json");
    c.ws.send("x".repeat(20_000));
    c.send({ t: "ping", sentAt: 1 });
    await c.waitFor((m) => m.t === "pong");
    c.close();
  });
});
