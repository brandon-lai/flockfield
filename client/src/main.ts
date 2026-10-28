import * as THREE from "three";
import "./style.css";
import { DAY_MS, nightAmount } from "../../shared/clock";
import { isLamb } from "../../shared/levels";
import type { Intent, ServerMsg, SheepWire, You } from "../../shared/protocol";
import { CHUNK, chunkId } from "../../shared/world";
import { Sound } from "./audio";
import { CameraRig } from "./camera";
import { LocalLink, RemoteLink, type Link, type LinkStatus } from "./net";
import { Critters } from "./scene/critters";
import { Foods } from "./scene/food";
import { Particles } from "./scene/particles";
import { newPose, updateSheep, type ClientSheep, type Emit } from "./scene/pose";
import { SheepRenderer } from "./scene/sheepRenderer";
import { Sky } from "./scene/sky";
import { Meadow } from "./scene/terrain";
import { Props } from "./scene/props";
import { UI } from "./ui";

const params = new URLSearchParams(location.search);
const SERVER = (import.meta.env.VITE_PASTURE_URL as string | undefined)?.replace(/\/$/, "");
const mobile = matchMedia("(pointer: coarse)").matches || innerWidth < 600;
const HINT_KEY = "flock.hinted";

// ------------------------------------------------------------ scene

const canvas = document.getElementById("scene") as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(devicePixelRatio, mobile ? 1.6 : 1.75));
const scene = new THREE.Scene();
const rig = new CameraRig(canvas);
const sky = new Sky(scene);
const meadow = new Meadow(scene, mobile);
const props = new Props(scene);
const flock = new SheepRenderer(scene);
const particles = new Particles(scene);
const foods = new Foods(scene);
const critters = new Critters(scene);
const sound = new Sound(mobile);
const ui = new UI();

function resize() {
  const w = innerWidth;
  const h = innerHeight;
  renderer.setSize(w, h, false);
  rig.resize(w, h);
}
addEventListener("resize", resize);
resize();

// ------------------------------------------------------------ state

const sheep = new Map<string, ClientSheep>();
let you: You | null = null;
let myId: string | null = null;
let welcomed = false;
let placedCamera = false;

const offline = !SERVER || params.has("offline");
const link: Link = offline
  ? new LocalLink(Math.min(3000, Math.max(1, Number(params.get("flock")) || 40)), Math.max(1, Number(params.get("level")) || 1))
  : new RemoteLink(SERVER!);
ui.offline = offline;
// Offline only: ?phase=0.8 shifts the local clock to that point in the day, for judging night by eye.
if (offline && params.has("phase")) {
  const want = Number(params.get("phase")) * DAY_MS;
  link.offset = want - (Date.now() % DAY_MS);
}

const serverNow = () => Date.now() + link.offset;

function upsert(w: SheepWire) {
  const existing = sheep.get(w.id);
  if (existing) {
    existing.intent = w.intent;
    existing.level = w.level;
    existing.leaveAt = 0;
    return existing;
  }
  const [x, z] = w.intent.from;
  const s: ClientSheep = {
    id: w.id,
    traits: w.traits,
    country: w.country,
    level: w.level,
    intent: w.intent,
    mine: w.id === myId,
    x,
    z,
    y: 0,
    heading: w.intent.face,
    walkPhase: (w.traits.seed % 100) / 10,
    walkAmt: 0,
    pose: newPose(),
    bornAt: performance.now(),
    leaveAt: 0,
    once: 0,
    onceKey: 0,
    nextZ: 0,
    sparkleUntil: 0,
  };
  sheep.set(w.id, s);
  return s;
}

function mine() {
  return myId ? sheep.get(myId) : undefined;
}

// ------------------------------------------------------------ messages

link.onStatus = (s: LinkStatus) => renderStatus(s);
link.onMessage = (m: ServerMsg) => {
  switch (m.t) {
    case "welcome":
      welcomed = true;
      rig.half = m.world.half;
      if (m.you) {
        myId = m.you.sheepId;
        setYou(m.you);
      } else if (!placedCamera) {
        // A spectator (no sheep of our own, e.g. rate-limited) starts above the middle of the flock.
        // Decided by what the server says, not a timer: on a slow phone the timer fired before
        // our own sheep arrived and the camera never found it.
        placedCamera = true;
        rig.jumpTo(0, 0, 60);
      }
      for (const s of sheep.values()) s.mine = s.id === myId;
      break;
    case "snapshot":
    case "spawn":
      for (const w of m.sheep) {
        const s = upsert(w);
        s.mine = s.id === myId;
        if (s.mine && !placedCamera) placeCamera(s);
      }
      break;
    case "intent":
      for (const i of m.intents) {
        const s = sheep.get(i.id);
        if (s) {
          s.intent = i;
          s.leaveAt = 0;
        }
      }
      break;
    case "despawn":
      for (const id of m.ids) {
        const s = sheep.get(id);
        if (s && !s.mine) s.leaveAt = performance.now();
      }
      break;
    case "level": {
      const s = sheep.get(m.id);
      if (s) s.level = m.level;
      break;
    }
    case "you": {
      const up = !!you && m.you.level > you.level;
      setYou(m.you, up);
      break;
    }
    case "world":
      rig.half = m.world.half;
      break;
    case "fx":
      for (const f of m.fx) {
        const s = sheep.get(f.sheepId);
        if (!s) continue;
        if (f.kind === "levelup") {
          s.sparkleUntil = performance.now() + 1500;
          particles.burst("sparkle", s.x, s.y + 1.4, s.z, 26, 3.2, 0.42, 1300);
          if (s.mine) {
            sound.chime();
            sound.baa({ lamb: isLamb(s.level), happy: true });
          }
        } else if (f.kind === "feed" && s.mine) sound.pop();
        else if (f.kind === "pet" && s.mine) sound.baa({ lamb: isLamb(s.level), happy: true });
        else if (f.kind === "arrive" && s.mine) setTimeout(() => sound.baa({ lamb: true }), 700);
      }
      break;
    case "error":
      if (m.code === "cooldown") ui.flash("Your sheep is still full.");
      else if (m.code === "busy") ui.flash("Your sheep is busy just now.");
      else if (m.code === "no_room") ui.flash("No room to drop that here.");
      break;
  }
  renderStatus(link.status);
};

function setYou(y: You, levelUp = false) {
  you = y;
  ui.clockOffset = link.offset;
  ui.setYou(y, levelUp);
  const s = sheep.get(y.sheepId);
  if (s) s.level = y.level;
}

function renderStatus(s: LinkStatus) {
  if (s === "offline-mode") ui.setStatus("Offline pasture — not shared, nothing is saved.", true);
  else if (s === "reconnecting" && welcomed) ui.setStatus("Reconnecting to the pasture…");
  else if (s === "unreachable") ui.setStatus("Can't reach the pasture right now. Still trying…", true);
  else if (s === "rate-limited" && !you) ui.setStatus("Lots of new sheep from your network today — you're watching for now.", true);
  else if (you && !you.primary) ui.setStatus("Your sheep is being watched in another tab.");
  else ui.setStatus(null);
}

// ------------------------------------------------------------ first visit / return

let label: { until: number } | null = null;

function placeCamera(s: ClientSheep) {
  placedCamera = true;
  const [x, z] = s.intent.to;
  if (link.firstVisit) {
    // The lamb drops in near the centre of the view; the camera eases toward it, then lets go.
    rig.jumpTo(x + 4, z + 10, 58);
    setTimeout(() => rig.flyTo(x, z, 30, 2400), 500);
    label = { until: performance.now() + 9000 };
    let hinted = false;
    try {
      hinted = !!localStorage.getItem(HINT_KEY);
      localStorage.setItem(HINT_KEY, "1");
    } catch {
      hinted = false;
    }
    if (!hinted) setTimeout(() => ui.showHint(), 3200);
  } else {
    // Return visit: open straight on your sheep, wherever it wandered to.
    rig.jumpTo(x, z, 34);
  }
}


// ------------------------------------------------------------ input

rig.onUserMove = () => {
  if (label && performance.now() > label.until - 6000) {
    label = null;
    ui.fadeLabel();
  }
};

function pick(px: number, py: number): ClientSheep | null {
  let best: ClientSheep | null = null;
  let bestD = Infinity;
  const w = innerWidth;
  const h = innerHeight;
  for (const d of flock.drawn) {
    const sx = ((d.px + 1) / 2) * w;
    const sy = ((1 - d.py) / 2) * h;
    const dist = Math.hypot(sx - px, sy - py);
    const reach = Math.max(mobile ? 26 : 18, d.r * 0.75);
    if (dist < reach && dist - (d.s.mine ? 8 : 0) < bestD) {
      best = d.s;
      bestD = dist - (d.s.mine ? 8 : 0);
    }
  }
  return best;
}

rig.onTap = (e) => {
  const s = pick(e.x, e.y);
  if (!s) {
    ui.hideCard();
    return;
  }
  ui.showCard(s);
  focusAboveCard(s);
};
rig.onHover = (e) => canvas.classList.toggle("over-sheep", !!e && !!pick(e.x, e.y));

/**
 * Ease the camera so the sheep sits in the upper part of the screen, clear of
 * the card. Screen-down is world +z, and the ground visible at the target is
 * about 0.83 x the camera distance tall, so +0.2 x dist lifts the sheep ~a
 * quarter of the screen.
 */
function focusAboveCard(s: ClientSheep) {
  const d = Math.min(rig.dist, 45);
  rig.flyTo(s.x, s.z + d * 0.2, d, 800);
}

ui.badge.addEventListener("click", () => {
  const s = mine();
  if (!s) return;
  ui.showCard(s);
  focusAboveCard(s);
});
ui.find.addEventListener("click", () => {
  const s = mine();
  if (s) rig.flyTo(s.x, s.z, Math.min(Math.max(rig.dist, 24), 40), 1500);
});
ui.onFeed = (food) => link.send({ t: "feed", food });
ui.onPet = () => link.send({ t: "pet" });
ui.setSound(sound.on);
sound.onChange = (on) => ui.setSound(on);
ui.soundBtn.addEventListener("click", () => sound.toggle());

// ------------------------------------------------------------ viewport subscriptions

let lastChunks = "";
function updateViewport() {
  const pts = rig.footprint();
  if (pts.length < 4) return;
  let x0 = Infinity;
  let x1 = -Infinity;
  let z0 = Infinity;
  let z1 = -Infinity;
  for (const p of pts) {
    x0 = Math.min(x0, p.x);
    x1 = Math.max(x1, p.x);
    z0 = Math.min(z0, p.z);
    z1 = Math.max(z1, p.z);
  }
  // Subscribe one chunk past the edges so sheep arrive before they're on screen.
  const cx0 = Math.floor(x0 / CHUNK) - 1;
  const cx1 = Math.floor(x1 / CHUNK) + 1;
  const cz0 = Math.floor(z0 / CHUNK) - 1;
  const cz1 = Math.floor(z1 / CHUNK) + 1;
  const ids: number[] = [];
  for (let cx = cx0; cx <= cx1; cx++) for (let cz = cz0; cz <= cz1; cz++) ids.push(chunkId(cx, cz));
  const key = ids.join(",");
  if (key === lastChunks) return;
  lastChunks = key;
  link.send({ t: "viewport", chunks: ids.slice(0, 400) });
}
setInterval(updateViewport, 300);

// ------------------------------------------------------------ frame loop

const emit: Emit = (kind, x, y, z, s) => {
  const gy = s.y;
  switch (kind) {
    case "z":
      particles.spawn("z", x + 0.3, gy + y, z, { vy: 0.45, vx: 0.15, life: 2600, size: 0.42 });
      break;
    case "heart":
      particles.spawn("heart", x, gy + y, z, { vy: 0.7, life: 1500, size: 0.55 });
      break;
    case "puff":
      particles.burst("puff", x, gy + y, z, 8, 1.4, 0.7, 700);
      break;
    case "sneeze":
      particles.burst("seed", x, gy + y, z, 7, 1.6, 0.35, 1600);
      break;
    case "crunch":
      particles.burst("crumb", x + Math.cos(s.intent.face) * 0.9, gy + 0.6, z + Math.sin(s.intent.face) * 0.9, 2, 1.2, 0.12, 500);
      if (s.mine) sound.crunch();
      break;
    case "butterfly":
      critters.pin(x, y, z, s.traits.seed);
      break;
    case "sparkle":
      particles.burst("sparkle", x, gy + y, z, 10, 2, 0.35);
      break;
  }
};

const stats = { fps: 0, frameMs: 0, cpuMs: 0, drawn: 0, near: 0, known: 0 };
let last = performance.now();
let loaded = false;
let lastFrameAt = 0;

function frame() {
  requestAnimationFrame(frame);
  const nowP = performance.now();
  const dt = Math.min(0.1, (nowP - last) / 1000);
  last = nowP;
  const t = serverNow();
  const time = nowP / 1000;

  rig.update(dt);
  const night = nightAmount(t);
  sky.update(t, rig.target, rig.dist);
  sound.night = night;

  // Retire sheep that have finished fading out.
  for (const [id, s] of sheep) if (s.leaveAt && nowP - s.leaveAt > 500) sheep.delete(id);

  for (const s of sheep.values()) updateSheep(s, t, dt, flock.nearIds.has(s.id) || s.mine, emit);
  flock.render(sheep.values(), rig.camera, innerHeight, nowP, night);
  const intents: Intent[] = [];
  for (const s of sheep.values()) intents.push(s.intent);
  foods.update(intents, t);
  meadow.update(rig.target, rig.camera.position, time);
  props.update(time, night, sky.fogColor);
  critters.update(time, rig.target, night, rig.dist, renderer.getPixelRatio());
  particles.update(dt);
  stats.cpuMs = stats.cpuMs * 0.9 + (performance.now() - nowP) * 0.1;
  renderer.render(scene, rig.camera);

  // "This is your sheep."
  const me = mine();
  if (label && me && nowP < label.until) {
    const v = new THREE.Vector3(me.x, me.y + (isLamb(me.level) ? 1.6 : 2.2) + me.pose.hop, me.z).project(rig.camera);
    ui.placeLabel(((v.x + 1) / 2) * innerWidth, ((1 - v.y) / 2) * innerHeight);
  } else if (label) {
    label = null;
    ui.fadeLabel();
  }

  if (!loaded && welcomed && placedCamera) {
    loaded = true;
    ui.doneLoading();
  }

  stats.frameMs = stats.frameMs * 0.95 + (nowP - lastFrameAt) * 0.05;
  stats.fps = Math.round(1000 / Math.max(1, stats.frameMs));
  lastFrameAt = nowP;
  stats.drawn = flock.drawn.length;
  stats.near = flock.nearIds.size;
  stats.known = sheep.size;
}

// Never leave the loading screen up forever.
setTimeout(() => {
  if (!loaded) {
    loaded = true;
    ui.doneLoading();
  }
}, 7000);

// Compile every shader before saying hello: the new lamb's drop starts when
// the server hears from us, and it should land on a screen that can show it.
requestAnimationFrame(frame);
renderer
  .compileAsync(scene, rig.camera)
  .catch(() => undefined)
  .finally(() => link.start());

// For the verification probes.
(window as unknown as { __flock: unknown }).__flock = { renderer, sheep, rig, link, stats, get you() { return you; }, pick, ui };
