// Two ways to reach a pasture, behind one interface:
//
//  RemoteLink: the shared pasture. POST /register once per device, then one
//    WebSocket that carries hello / viewport / heartbeat / feed / pet.
//  LocalLink: no server configured (or ?offline=1). Runs the same Pasture
//    simulation in the page so the scene can be built and judged offline. It
//    says so on screen and earns nothing -- it does not pretend to be shared.

import { progressFromExp } from "../../shared/levels";
import {
  FEED_COOLDOWN_MS,
  HEARTBEAT_MS,
  PET_COOLDOWN_MS,
  type ClientMsg,
  type ServerMsg,
  type SheepWire,
  type You,
} from "../../shared/protocol";
import { rng } from "../../shared/rng";
import { Pasture, TICK_MS, type SimSheep } from "../../shared/sim";
import { isTraits, rollTraits, type Traits } from "../../shared/traits";

export type LinkStatus = "connecting" | "online" | "reconnecting" | "offline-mode" | "unreachable" | "rate-limited";

export interface Link {
  readonly kind: "remote" | "local";
  status: LinkStatus;
  /** Server clock minus local clock, ms. */
  offset: number;
  /** True if this device had no sheep before this visit. */
  firstVisit: boolean;
  send(m: ClientMsg): void;
  onMessage: (m: ServerMsg) => void;
  onStatus: (s: LinkStatus) => void;
  start(): void;
}

const OWNER_KEY = "flock.owner";
const COOKIE = "flock_owner";

interface Owner {
  sheepId: string;
  ownerToken: string;
}

function safeGet(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeSet(k: string, v: string | null) {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    // Private mode: the cookie backup still works.
  }
}

/** Owner token from localStorage, falling back to the backup cookie (PRD "Device identity"). */
export function loadOwner(): Owner | null {
  const parse = (s: string | null) => {
    if (!s) return null;
    try {
      const o = JSON.parse(s) as Owner;
      return typeof o.sheepId === "string" && /^[0-9a-f]{32}$/.test(o.ownerToken) ? o : null;
    } catch {
      return null;
    }
  };
  const ls = parse(safeGet(OWNER_KEY));
  if (ls) return ls;
  const m = document.cookie.match(new RegExp(`(?:^|; )${COOKIE}=([^;]*)`));
  const ck = parse(m ? decodeURIComponent(m[1]) : null);
  if (ck) safeSet(OWNER_KEY, JSON.stringify(ck));
  return ck;
}

function saveOwner(o: Owner | null) {
  safeSet(OWNER_KEY, o ? JSON.stringify(o) : null);
  const v = o ? encodeURIComponent(JSON.stringify(o)) : "";
  const age = o ? 60 * 60 * 24 * 400 : 0;
  document.cookie = `${COOKIE}=${v}; max-age=${age}; path=/; samesite=lax${location.protocol === "https:" ? "; secure" : ""}`;
}

export class RemoteLink implements Link {
  readonly kind = "remote";
  status: LinkStatus = "connecting";
  offset = 0;
  firstVisit = false;
  onMessage: (m: ServerMsg) => void = () => {};
  onStatus: (s: LinkStatus) => void = () => {};
  private ws: WebSocket | null = null;
  private owner: Owner | null = loadOwner();
  private backoff = 800;
  private beat: ReturnType<typeof setInterval> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private lastViewport: ClientMsg | null = null;
  private failures = 0;

  constructor(private base: string) {}

  start() {
    this.firstVisit = !this.owner;
    void this.connect();
    document.addEventListener("visibilitychange", () => {
      // Back in view: one heartbeat now restarts the clock (the hidden gap earns nothing).
      if (document.visibilityState === "visible") this.send({ t: "heartbeat" });
    });
  }

  private set(s: LinkStatus) {
    if (this.status === s) return;
    this.status = s;
    this.onStatus(s);
  }

  private async register(): Promise<boolean> {
    try {
      const r = await fetch(`${this.base}/register`, { method: "POST" });
      if (r.status === 429) {
        this.set("rate-limited");
        return false;
      }
      if (!r.ok) throw new Error(String(r.status));
      const o = (await r.json()) as Owner;
      this.owner = o;
      saveOwner(o);
      return true;
    } catch {
      return false;
    }
  }

  private async connect() {
    if (!this.owner && !(await this.register())) {
      // Rate limited: still watch the pasture, just without a sheep of our own.
      if (this.status !== "rate-limited") return this.retry();
    }
    const url = this.base.replace(/^http/, "ws") + "/ws";
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this.failures = 0;
      this.backoff = 800;
      ws.send(JSON.stringify({ t: "hello", token: this.owner?.ownerToken ?? null, sentAt: Date.now() } satisfies ClientMsg));
      if (this.lastViewport) ws.send(JSON.stringify(this.lastViewport));
    };
    ws.onmessage = (e) => {
      let m: ServerMsg;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      if (m.t === "welcome" || m.t === "pong") {
        const rtt = Date.now() - m.sentAt;
        if (m.sentAt && rtt < 10_000) this.offset = m.now + rtt / 2 - Date.now();
        if (m.t === "welcome") {
          if (this.status !== "rate-limited" || m.you) this.set("online");
          this.startTimers();
        }
      }
      if (m.t === "error" && m.code === "unknown_token") {
        // The pasture does not know this token (a reset server): start over with a new lamb.
        saveOwner(null);
        this.owner = null;
        this.firstVisit = true;
        ws.close();
        return;
      }
      this.onMessage(m);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.stopTimers();
      this.failures++;
      this.retry();
    };
  }

  private retry() {
    this.set(this.failures >= 3 ? "unreachable" : "reconnecting");
    setTimeout(() => void this.connect(), this.backoff);
    this.backoff = Math.min(15_000, this.backoff * 1.7);
  }

  private startTimers() {
    this.stopTimers();
    this.send({ t: "heartbeat" });
    this.beat = setInterval(() => {
      if (document.visibilityState === "visible") this.send({ t: "heartbeat" });
    }, HEARTBEAT_MS);
    this.ping = setInterval(() => this.send({ t: "ping", sentAt: Date.now() }), 20_000);
  }

  private stopTimers() {
    if (this.beat) clearInterval(this.beat);
    if (this.ping) clearInterval(this.ping);
    this.beat = this.ping = null;
  }

  send(m: ClientMsg) {
    if (m.t === "viewport") this.lastViewport = m;
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }
}

const LOCAL_KEY = "flock.local";

export class LocalLink implements Link {
  readonly kind = "local";
  status: LinkStatus = "offline-mode";
  offset = 0;
  firstVisit = false;
  onMessage: (m: ServerMsg) => void = () => {};
  onStatus: (s: LinkStatus) => void = () => {};
  private pasture: Pasture;
  private mine: SimSheep | null = null;
  private createdAt = Date.now();
  private level: number;

  constructor(private flockSize: number, level: number) {
    this.pasture = new Pasture({ wildFloor: flockSize, seed: 7 });
    this.level = level;
  }

  start() {
    const now = Date.now();
    let saved: { traits: Traits; x: number; z: number; createdAt: number } | null = null;
    try {
      saved = JSON.parse(safeGet(LOCAL_KEY) ?? "null");
      if (saved && !isTraits(saved.traits)) saved = null;
    } catch {
      saved = null;
    }
    this.firstVisit = !saved;
    const traits = saved?.traits ?? rollTraits(rng(now & 0xffffff));
    this.pasture.balanceWild(now, rollTraits);
    const [x, z] = saved ? [saved.x, saved.z] : this.pasture.spawnPoint();
    this.createdAt = saved?.createdAt ?? now;
    this.mine = this.pasture.add({ id: "mine", traits, country: "XX", level: this.level, x, z }, now, !saved);
    this.mine.ownerOnline = true;
    this.pasture.balanceWild(now, rollTraits);
    const save = () =>
      safeSet(LOCAL_KEY, JSON.stringify({ traits, x: this.mine!.intent.to[0], z: this.mine!.intent.to[1], createdAt: this.createdAt }));
    save();
    setInterval(save, 10_000);

    queueMicrotask(() => {
      this.onStatus(this.status);
      this.onMessage({ t: "welcome", now, sentAt: now, you: this.you(), world: { sheep: this.pasture.sheep.size, half: this.pasture.half } });
      this.onMessage({ t: "snapshot", sheep: [...this.pasture.sheep.values()].map(wire) });
    });
    setInterval(() => {
      const changed = this.pasture.tick(Date.now());
      if (changed.length) this.onMessage({ t: "intent", intents: changed });
    }, TICK_MS);
  }

  private you(): You {
    const p = progressFromExp(0);
    return {
      sheepId: "mine",
      level: this.level,
      exp: 0,
      into: 0,
      next: p.next,
      activeSeconds: 0,
      createdAt: this.createdAt,
      primary: true,
      feedReadyAt: (this.mine?.lastFedAt ?? 0) + FEED_COOLDOWN_MS,
      petReadyAt: (this.mine?.lastPetAt ?? 0) + PET_COOLDOWN_MS,
    };
  }

  send(m: ClientMsg) {
    const now = Date.now();
    if (m.t === "feed" || m.t === "pet") {
      const r = m.t === "feed" ? this.pasture.feed("mine", m.food, now) : this.pasture.pet("mine", now);
      if (typeof r === "string") {
        this.onMessage({ t: "error", code: r, message: r === "cooldown" ? "Your sheep is still full." : "Your sheep is busy." });
      } else {
        this.onMessage({ t: "intent", intents: [r] });
        this.onMessage({ t: "fx", fx: [{ sheepId: "mine", kind: m.t, at: now, food: m.t === "feed" ? m.food : undefined }] });
      }
      this.onMessage({ t: "you", you: this.you() });
    }
  }
}

function wire(s: SimSheep): SheepWire {
  return { id: s.id, traits: s.traits, country: s.wild ? null : s.country, level: s.level, intent: s.intent };
}
