// The pasture Durable Object: one object holds the whole flock (PRD "Scale":
// start with one, shard by chunk range later). It owns the truth -- who owns
// which sheep, EXP, level, what every sheep is doing -- runs the behaviour
// tick at 2 Hz while anyone is watching, and streams intents to each socket
// for the chunks near its viewport.

import { DurableObject } from "cloudflare:workers";
import { progressFromExp } from "../../shared/levels";
import {
  BARN_AFTER_MS,
  FEED_COOLDOWN_MS,
  FOODS,
  HEARTBEAT_MS,
  PET_COOLDOWN_MS,
  type ClientMsg,
  type Fx,
  type Intent,
  type ServerMsg,
  type SheepWire,
  type You,
} from "../../shared/protocol";
import { rng } from "../../shared/rng";
import { Pasture, TICK_MS, type SimSheep } from "../../shared/sim";
import { isTraits, rollTraits, type Traits } from "../../shared/traits";
import { chunkOf } from "../../shared/world";

export interface Env {
  PASTURE: DurableObjectNamespace<PastureDO>;
  IP_HASH_SECRET?: string;
  /** Seconds of visible time per EXP. 60 in production; tests shorten it. */
  EXP_SECONDS?: string;
  /** Registrations allowed per IP per hour. */
  REGISTER_PER_HOUR?: string;
  WILD_FLOOR?: string;
}

interface Conn {
  sheepId: string | null;
  chunks: Set<number>;
  known: Set<string>;
}

interface Owner {
  sheepId: string;
  exp: number;
  activeMs: number;
  createdAt: number;
  lastFedAt: number;
  /** The one socket whose heartbeats earn EXP. */
  primary: WebSocket | null;
  lastBeatAt: number;
  bankMs: number;
  dirty: boolean;
  fresh: boolean;
}

interface Row {
  id: string;
  owner_token_hash: string;
  country: string;
  traits: string;
  exp: number;
  level: number;
  x: number;
  y: number;
  active_ms: number;
  last_active_at: number | null;
  last_fed_at: number | null;
  last_seen_at: number;
  created_at: number;
  [k: string]: SqlStorageValue;
}

/** A heartbeat more than this long after the last one means the tab was hidden; the gap earns nothing. */
const BEAT_GAP_MS = HEARTBEAT_MS * 1.5;
const FLUSH_MS = 60_000;
const MAX_MSG = 8_192;
const MAX_CHUNKS = 400;

const enc = new TextEncoder();
async function sha256(s: string) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class PastureDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private pasture: Pasture;
  private conns = new Map<WebSocket, Conn>();
  private owners = new Map<string, Owner>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastFlush = Date.now();
  private expMs: number;
  // Measured from day one (PRD "Scale"): one-minute rolling message counts.
  private stats = { in: 0, out: 0, windowStart: Date.now(), lastIn: 0, lastOut: 0, tickMs: 0, peakConns: 0 };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.expMs = Number(env.EXP_SECONDS ?? 60) * 1000;
    this.pasture = new Pasture({ wildFloor: Number(env.WILD_FLOOR ?? 40), seed: Date.now() & 0x7fffffff });
    ctx.blockConcurrencyWhile(async () => this.load());
  }

  private load() {
    this.sql.exec(`create table if not exists sheep (
      id text primary key,
      owner_token_hash text not null unique,
      country text not null,
      traits text not null,
      exp integer not null default 0,
      level integer not null default 1,
      x real not null,
      y real not null,
      active_ms integer not null default 0,
      last_active_at integer,
      last_fed_at integer,
      last_seen_at integer not null,
      created_at integer not null
    )`);
    this.sql.exec(`create table if not exists register_log (ip_hash text not null, at integer not null)`);
    this.sql.exec(`create index if not exists register_log_ip on register_log (ip_hash, at)`);

    const now = Date.now();
    // Sheep whose owners have been gone 30 days rest in the barn: kept, not loaded.
    for (const row of this.sql.exec<Row>(`select * from sheep where last_seen_at > ?`, now - BARN_AFTER_MS)) {
      this.addRow(row, now, false);
    }
    this.pasture.balanceWild(now, rollTraits);

    // Sockets survive an object restart under the hibernation API; re-adopt them.
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment() as { sheepId: string | null; chunks: number[] } | null;
      this.conns.set(ws, { sheepId: a?.sheepId ?? null, chunks: new Set(a?.chunks ?? []), known: new Set() });
      if (a?.sheepId) this.attachOwner(ws, a.sheepId);
    }
    if (this.conns.size) this.start();
  }

  private addRow(row: Row, now: number, arriving: boolean): SimSheep | null {
    let traits: Traits;
    try {
      traits = JSON.parse(row.traits);
      if (!isTraits(traits)) return null;
    } catch {
      return null;
    }
    const s = this.pasture.add(
      { id: row.id, traits, country: row.country, level: row.level, x: row.x, z: row.y, lastFedAt: row.last_fed_at ?? 0 },
      now,
      arriving,
    );
    this.owners.set(row.id, {
      sheepId: row.id,
      exp: row.exp,
      activeMs: row.active_ms,
      createdAt: row.created_at,
      lastFedAt: row.last_fed_at ?? 0,
      primary: null,
      lastBeatAt: 0,
      bankMs: 0,
      dirty: false,
      fresh: arriving,
    });
    return s;
  }

  // ------------------------------------------------------------ HTTP

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ sheepId: null, chunks: [] });
      this.conns.set(pair[1], { sheepId: null, chunks: new Set(), known: new Set() });
      this.stats.peakConns = Math.max(this.stats.peakConns, this.conns.size);
      this.start();
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === "/register" && req.method === "POST") return this.register(req);
    if (url.pathname === "/stats") return Response.json(this.statsBody());
    return new Response("not found", { status: 404 });
  }

  private async register(req: Request): Promise<Response> {
    const now = Date.now();
    const ipHash = req.headers.get("x-ip-hash") ?? "unknown";
    const country = req.headers.get("x-country") ?? "XX";
    const limit = Number(this.env.REGISTER_PER_HOUR ?? 5);
    this.sql.exec(`delete from register_log where at < ?`, now - 3_600_000);
    const recent = this.sql.exec<{ n: number }>(`select count(*) as n from register_log where ip_hash = ?`, ipHash).one().n;
    if (recent >= limit) {
      return Response.json({ error: "rate_limited", message: "Too many new sheep from here. Try again in an hour." }, { status: 429 });
    }
    this.sql.exec(`insert into register_log (ip_hash, at) values (?, ?)`, ipHash, now);

    const id = crypto.randomUUID();
    const token = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const traits = rollTraits(rng(crypto.getRandomValues(new Uint32Array(1))[0]));
    const [x, z] = this.pasture.spawnPoint();
    const row: Row = {
      id,
      owner_token_hash: await sha256(token),
      country,
      traits: JSON.stringify(traits),
      exp: 0,
      level: 1,
      x,
      y: z,
      active_ms: 0,
      last_active_at: null,
      last_fed_at: null,
      last_seen_at: now,
      created_at: now,
    };
    this.sql.exec(
      `insert into sheep (id, owner_token_hash, country, traits, exp, level, x, y, active_ms, last_seen_at, created_at)
       values (?, ?, ?, ?, 0, 1, ?, ?, 0, ?, ?)`,
      row.id, row.owner_token_hash, row.country, row.traits, row.x, row.y, now, now,
    );
    const s = this.addRow(row, now, true);
    if (s) this.route([s.intent], now);
    this.rebalance(now);
    // Only the hash is stored; this response is the one time the token exists server-side.
    return Response.json({ sheepId: id, ownerToken: token });
  }

  // ------------------------------------------------------------ sockets

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    this.stats.in++;
    if (typeof raw !== "string" || raw.length > MAX_MSG) return;
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const conn = this.conns.get(ws);
    if (!conn) return;
    const now = Date.now();
    switch (msg.t) {
      case "hello":
        return this.hello(ws, conn, msg.token, msg.sentAt, now);
      case "viewport":
        return this.viewport(ws, conn, msg.chunks, now);
      case "heartbeat":
        return this.heartbeat(ws, conn, now);
      case "feed":
        return this.feed(ws, conn, msg.food, now);
      case "pet":
        return this.pet(ws, conn, now);
      case "ping":
        return this.send(ws, { t: "pong", now, sentAt: Number(msg.sentAt) || 0 });
    }
  }

  async webSocketClose(ws: WebSocket) {
    this.drop(ws);
  }

  async webSocketError(ws: WebSocket) {
    this.drop(ws);
  }

  private drop(ws: WebSocket) {
    const conn = this.conns.get(ws);
    this.conns.delete(ws);
    if (conn?.sheepId) {
      const o = this.owners.get(conn.sheepId);
      const others = [...this.conns].filter(([, c]) => c.sheepId === conn.sheepId).map(([w]) => w);
      if (o && o.primary === ws) {
        o.primary = others[0] ?? null;
        o.lastBeatAt = 0;
        if (o.primary) this.sendYou(o);
      }
      if (!others.length) {
        const s = this.pasture.sheep.get(conn.sheepId);
        if (s) s.ownerOnline = false;
        if (o) o.dirty = true;
        // Positions are saved on disconnect as well as on the timer.
        this.flush(Date.now());
      }
    }
    if (!this.conns.size) this.stop();
  }

  private async hello(ws: WebSocket, conn: Conn, token: string | null, sentAt: number, now: number) {
    let sheepId: string | null = null;
    if (typeof token === "string" && /^[0-9a-f]{32}$/.test(token)) {
      const hash = await sha256(token);
      const row = this.sql.exec<Row>(`select * from sheep where owner_token_hash = ?`, hash).toArray()[0];
      if (row) {
        sheepId = row.id;
        if (!this.pasture.sheep.has(row.id)) {
          // Back from the barn.
          const s = this.addRow(row, now, false);
          if (s) this.route([s.intent], now);
          this.rebalance(now);
        }
      }
    }
    if (token && !sheepId) this.send(ws, { t: "error", code: "unknown_token", message: "That sheep isn't in this pasture." });

    conn.sheepId = sheepId;
    ws.serializeAttachment({ sheepId, chunks: [...conn.chunks] });
    let you: You | null = null;
    if (sheepId) {
      const o = this.attachOwner(ws, sheepId);
      this.sql.exec(`update sheep set last_seen_at = ? where id = ?`, now, sheepId);
      const s = this.pasture.sheep.get(sheepId)!;
      // A brand-new lamb drops in when its owner is actually looking.
      if (o.fresh) {
        o.fresh = false;
        const [x, z] = s.intent.to;
        s.intent = { ...s.intent, state: "drop", from: [x, z], to: [x, z], startAt: now, duration: 2600 };
        this.route([s.intent], now);
        this.fx({ sheepId, kind: "arrive", at: now });
      }
      you = this.youOf(o, ws);
      conn.known.add(sheepId);
    }
    this.send(ws, { t: "welcome", now, sentAt: Number(sentAt) || 0, you, world: this.worldInfo() });
    if (sheepId) this.send(ws, { t: "snapshot", sheep: [this.wire(this.pasture.sheep.get(sheepId)!)] });
  }

  private attachOwner(ws: WebSocket, sheepId: string): Owner {
    const o = this.owners.get(sheepId)!;
    const s = this.pasture.sheep.get(sheepId);
    if (s) s.ownerOnline = true;
    if (!o.primary || !this.conns.has(o.primary)) {
      o.primary = ws;
      o.lastBeatAt = 0;
    }
    return o;
  }

  private viewport(ws: WebSocket, conn: Conn, chunks: unknown, now: number) {
    if (!Array.isArray(chunks)) return;
    conn.chunks = new Set(chunks.slice(0, MAX_CHUNKS).filter((c): c is number => Number.isInteger(c)));
    ws.serializeAttachment({ sheepId: conn.sheepId, chunks: [...conn.chunks] });
    const add: SheepWire[] = [];
    const gone: string[] = [];
    for (const s of this.pasture.sheep.values()) {
      const rel = this.relevant(conn, s.intent);
      if (rel && !conn.known.has(s.id)) {
        add.push(this.wire(s));
        conn.known.add(s.id);
      } else if (!rel && conn.known.has(s.id)) {
        gone.push(s.id);
        conn.known.delete(s.id);
      }
    }
    if (add.length) this.send(ws, { t: "snapshot", sheep: add });
    if (gone.length) this.send(ws, { t: "despawn", ids: gone });
    void now;
  }

  /**
   * EXP (PRD "EXP and levels", "Abuse"): credited from heartbeats, never from a
   * number the client sends. Only the primary socket earns. Each heartbeat
   * banks the wall time since the previous one, provided the gap is short
   * enough that the tab was visible throughout; 60 s banked is 1 EXP. Banking
   * wall time means no rate of heartbeats can earn faster than 1 per minute.
   */
  private heartbeat(ws: WebSocket, conn: Conn, now: number) {
    if (!conn.sheepId) return;
    const o = this.owners.get(conn.sheepId);
    if (!o) return;
    if (o.primary !== ws) {
      // The primary tab went quiet (hidden or asleep): this visible one takes over.
      if (o.primary && this.conns.has(o.primary) && now - o.lastBeatAt < BEAT_GAP_MS) return;
      const prev = o.primary;
      o.primary = ws;
      o.lastBeatAt = 0;
      if (prev && this.conns.has(prev)) this.send(prev, { t: "you", you: this.youOf(o, prev) });
    }
    const gap = now - o.lastBeatAt;
    o.lastBeatAt = now;
    if (gap > BEAT_GAP_MS) {
      this.sendYou(o);
      return;
    }
    o.bankMs += gap;
    o.activeMs += gap;
    o.dirty = true;
    if (o.bankMs >= this.expMs) {
      o.bankMs -= this.expMs;
      const before = progressFromExp(o.exp).level;
      o.exp += 1;
      const after = progressFromExp(o.exp).level;
      this.sql.exec(`update sheep set exp = ?, level = ?, active_ms = ?, last_active_at = ? where id = ?`, o.exp, after, o.activeMs, now, o.sheepId);
      if (after > before) this.levelUp(o.sheepId, after, now);
    }
    this.sendYou(o);
  }

  private levelUp(id: string, level: number, now: number) {
    const s = this.pasture.sheep.get(id);
    if (!s) return;
    s.level = level;
    for (const [ws, c] of this.conns) if (c.known.has(id)) this.send(ws, { t: "level", id, level });
    const i = this.pasture.celebrate(id, now);
    if (i) this.route([i], now);
    this.fx({ sheepId: id, kind: "levelup", at: now });
  }

  private feed(ws: WebSocket, conn: Conn, food: unknown, now: number) {
    if (!conn.sheepId || !FOODS.includes(food as never)) return;
    const o = this.owners.get(conn.sheepId);
    const r = this.pasture.feed(conn.sheepId, food as (typeof FOODS)[number], now);
    if (typeof r === "string") {
      this.send(ws, { t: "error", code: r, message: r === "cooldown" ? "Your sheep is still full." : "Can't feed right now." });
      if (o) this.send(ws, { t: "you", you: this.youOf(o, ws) });
      return;
    }
    if (o) {
      o.lastFedAt = now;
      this.sql.exec(`update sheep set last_fed_at = ? where id = ?`, now, o.sheepId);
    }
    this.route([r], now);
    this.fx({ sheepId: conn.sheepId, kind: "feed", at: now, food: r.food?.kind });
    if (o) this.sendYou(o);
  }

  private pet(ws: WebSocket, conn: Conn, now: number) {
    if (!conn.sheepId) return;
    const r = this.pasture.pet(conn.sheepId, now);
    if (typeof r === "string") {
      if (r !== "cooldown") this.send(ws, { t: "error", code: r, message: "Your sheep is busy." });
      return;
    }
    this.route([r], now);
    this.fx({ sheepId: conn.sheepId, kind: "pet", at: now });
  }

  // ------------------------------------------------------------ tick

  private start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.step(), TICK_MS);
  }

  private stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.flush(Date.now());
  }

  private step() {
    const t = performance.now();
    const now = Date.now();
    const changed = this.pasture.tick(now);
    if (changed.length) this.route(changed, now);
    if (now - this.lastFlush > FLUSH_MS) this.flush(now);
    if (now - this.stats.windowStart > 60_000) {
      this.stats.lastIn = this.stats.in;
      this.stats.lastOut = this.stats.out;
      this.stats.in = this.stats.out = 0;
      this.stats.windowStart = now;
    }
    this.stats.tickMs = this.stats.tickMs * 0.9 + (performance.now() - t) * 0.1;
  }

  private flush(now: number) {
    this.lastFlush = now;
    for (const o of this.owners.values()) {
      if (!o.dirty) continue;
      const s = this.pasture.sheep.get(o.sheepId);
      if (!s) continue;
      const [x, z] = s.intent.to;
      const level = progressFromExp(o.exp).level;
      this.sql.exec(
        `update sheep set x = ?, y = ?, exp = ?, level = ?, active_ms = ?, last_seen_at = ? where id = ?`,
        x, z, o.exp, level, o.activeMs, s.ownerOnline ? now : this.lastSeen(o.sheepId, now), o.sheepId,
      );
      o.dirty = s.ownerOnline;
    }
  }

  private lastSeen(id: string, now: number) {
    const r = this.sql.exec<{ t: number }>(`select last_seen_at as t from sheep where id = ?`, id).toArray()[0];
    return r?.t ?? now;
  }

  // ------------------------------------------------------------ fan-out

  private relevant(conn: Conn, i: Intent) {
    return conn.sheepId === i.id || conn.chunks.has(chunkOf(i.from[0], i.from[1])) || conn.chunks.has(chunkOf(i.to[0], i.to[1]));
  }

  /** Send changed intents to the sockets that can see them: intent if known, spawn if new, despawn if it walked out. */
  private route(intents: Intent[], _now: number) {
    for (const [ws, conn] of this.conns) {
      if (!conn.chunks.size && !conn.sheepId) continue;
      const upd: Intent[] = [];
      const spawn: SheepWire[] = [];
      const gone: string[] = [];
      for (const i of intents) {
        const rel = this.relevant(conn, i);
        if (rel) {
          if (conn.known.has(i.id)) upd.push(i);
          else {
            const s = this.pasture.sheep.get(i.id);
            if (s) {
              spawn.push(this.wire(s));
              conn.known.add(i.id);
            }
          }
        } else if (conn.known.has(i.id)) {
          gone.push(i.id);
          conn.known.delete(i.id);
        }
      }
      if (spawn.length) this.send(ws, { t: "spawn", sheep: spawn });
      if (upd.length) this.send(ws, { t: "intent", intents: upd });
      if (gone.length) this.send(ws, { t: "despawn", ids: gone });
    }
  }

  private fx(f: Fx) {
    for (const [ws, c] of this.conns) if (c.known.has(f.sheepId)) this.send(ws, { t: "fx", fx: [f] });
  }

  /** Keep wild sheep topped up, and tell everyone when the flock or the plain changes size. */
  private rebalance(now: number) {
    const before = this.worldInfo();
    const { added, removed } = this.pasture.balanceWild(now, rollTraits);
    if (added.length) this.route(added.map((s) => s.intent), now);
    if (removed.length) {
      for (const [ws, c] of this.conns) {
        const ids = removed.filter((id) => c.known.delete(id));
        if (ids.length) this.send(ws, { t: "despawn", ids });
      }
    }
    const after = this.worldInfo();
    if (after.half !== before.half || after.sheep !== before.sheep) {
      for (const ws of this.conns.keys()) this.send(ws, { t: "world", world: after });
    }
  }

  private worldInfo() {
    return { sheep: this.pasture.sheep.size, half: this.pasture.half };
  }

  private wire(s: SimSheep): SheepWire {
    return { id: s.id, traits: s.traits, country: s.wild ? null : s.country, level: s.level, intent: s.intent };
  }

  private youOf(o: Owner, ws?: WebSocket): You {
    const p = progressFromExp(o.exp);
    return {
      sheepId: o.sheepId,
      level: p.level,
      exp: o.exp,
      into: p.into,
      next: p.next,
      activeSeconds: Math.floor(o.activeMs / 1000),
      createdAt: o.createdAt,
      primary: ws ? o.primary === ws : true,
      feedReadyAt: o.lastFedAt + FEED_COOLDOWN_MS,
      petReadyAt: (this.pasture.sheep.get(o.sheepId)?.lastPetAt ?? 0) + PET_COOLDOWN_MS,
    };
  }

  /** Progress goes to every tab of the sheep; each is told whether it is the earning one. */
  private sendYou(o: Owner) {
    for (const [ws, c] of this.conns) if (c.sheepId === o.sheepId) this.send(ws, { t: "you", you: this.youOf(o, ws) });
  }

  private send(ws: WebSocket, m: ServerMsg) {
    try {
      ws.send(JSON.stringify(m));
      this.stats.out++;
    } catch {
      // Socket already closing; webSocketClose will clean up.
    }
  }

  private statsBody() {
    const owned = this.pasture.ownedCount;
    const elapsed = Math.max(1, (Date.now() - this.stats.windowStart) / 1000);
    return {
      connections: this.conns.size,
      peakConnections: this.stats.peakConns,
      sheepLive: this.pasture.sheep.size,
      sheepOwned: owned,
      sheepWild: this.pasture.sheep.size - owned,
      sheepTotal: this.sql.exec<{ n: number }>(`select count(*) as n from sheep`).one().n,
      half: this.pasture.half,
      msgsInPerSec: +(this.stats.in / elapsed).toFixed(2),
      msgsOutPerSec: +(this.stats.out / elapsed).toFixed(2),
      lastMinute: { in: this.stats.lastIn, out: this.stats.lastOut },
      tickMs: +this.stats.tickMs.toFixed(3),
      ticking: !!this.timer,
    };
  }
}
