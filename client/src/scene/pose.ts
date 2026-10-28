// Turns a sheep's current intent into a pose, every frame. This is where the
// "cute at a glance" lives: the timing of hops, the head dipping to graze,
// the slow flop into sleep. Everything is a function of the intent and the
// shared clock, so two screens showing the same sheep show the same motion.

import type { Intent } from "../../../shared/protocol";
import { intentPosition, walkMs, SPEED } from "../../../shared/sim";
import type { Traits } from "../../../shared/traits";
import { terrainHeight } from "../../../shared/world";

export interface Pose {
  hop: number;
  squash: number;
  lie: number;
  roll: number;
  pitch: number;
  yaw: number;
  hroll: number;
  eye: number;
  flick: number;
}

export interface ClientSheep {
  id: string;
  traits: Traits;
  country: string | null;
  level: number;
  intent: Intent;
  mine: boolean;
  x: number;
  z: number;
  y: number;
  heading: number;
  walkPhase: number;
  walkAmt: number;
  pose: Pose;
  /** ms (client clock) when it appeared / was told to leave; drives fade in and out. */
  bornAt: number;
  leaveAt: number;
  /** Bitmask of one-shot effects already fired for the current intent. */
  once: number;
  onceKey: number;
  nextZ: number;
  /** Set briefly by level-up so the renderer can sparkle. */
  sparkleUntil: number;
}

export type Emit = (kind: "z" | "heart" | "puff" | "crumb" | "sparkle" | "crunch" | "sneeze" | "butterfly", x: number, y: number, z: number, s: ClientSheep) => void;

export function newPose(): Pose {
  return { hop: 0, squash: 1, lie: 0, roll: 0, pitch: 0.1, yaw: 0, hroll: 0, eye: 1, flick: 0 };
}

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
function angleTo(from: number, to: number, k: number) {
  let d = to - from;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return from + d * k;
}
/** Seeded 0..1 noise per sheep and time, for blinks and flicks. */
function pulse(t: number, seed: number, period: number, width: number) {
  const p = (t / period + (seed % 997) / 997) % 1;
  return p < width ? Math.sin((p / width) * Math.PI) : 0;
}

const ONCE = { heart: 1, puff: 2, boop: 4, land: 8, sneeze: 16 };

/** Local offset (forward, left) for play variants that leave the spot and come back. */
function playPath(variant: number, u: number, r: number): [number, number] {
  const a = u * Math.PI * 2;
  if (variant === 1) return [Math.sin(a) * r, (1 - Math.cos(a)) * r];
  return [Math.sin(a) * r * 1.2, Math.sin(2 * a) * r * 0.7];
}

export function updateSheep(s: ClientSheep, t: number, dt: number, near: boolean, emit: Emit) {
  const i = s.intent;
  if (s.onceKey !== i.startAt) {
    s.onceKey = i.startAt;
    s.once = 0;
  }
  const st = (t - i.startAt) / 1000;
  const dur = i.duration / 1000;
  const left = dur - st;
  const wm = walkMs(i) / 1000;
  const seed = s.traits.seed;
  const sec = t / 1000;
  let [x, z] = intentPosition(i, t);
  let desired = i.face;
  let moving = wm > 0 && st < wm && st >= 0;
  if (moving) desired = Math.atan2(i.to[1] - i.from[1], i.to[0] - i.from[0]);

  // Targets for the smoothed parts of the pose.
  let pitch = 0.08;
  let yaw = Math.sin(sec * 0.45 + seed) * 0.18;
  let hroll = 0;
  let lie = 0;
  let roll = 0;
  let hop = 0;
  let squash = 1;
  let eye = 1 - pulse(sec, seed, 3.7 + (seed % 5) * 0.4, 0.045);
  let flick = pulse(sec, seed * 7, 5.3, 0.08);
  let stride = 7.5;
  let speed = SPEED[i.state] ?? 0;

  switch (i.state) {
    case "drop": {
      // Falls in, lands with a squash, one small bounce.
      if (st < 0.55) {
        const f = st / 0.55;
        hop = 7 * (1 - f * f);
        squash = 1.12;
      } else if (st < 1.05) {
        const f = (st - 0.55) / 0.5;
        hop = Math.sin(f * Math.PI) * 0.55;
        squash = f < 0.18 ? 0.72 + f * 1.2 : 1 + Math.sin(f * Math.PI) * 0.08;
        if (!(s.once & ONCE.land)) {
          s.once |= ONCE.land;
          if (near) emit("puff", x, 0.1, z, s);
        }
      } else {
        const f = clamp((st - 1.05) / 0.25);
        squash = 0.86 + 0.14 * f;
      }
      eye = 1;
      break;
    }
    case "wander":
      if (moving) {
        pitch = 0.12 + Math.sin(s.walkPhase * 2) * 0.04;
        roll = Math.sin(s.walkPhase) * 0.06;
        yaw = Math.sin(sec * 0.8 + seed) * 0.08;
      } else {
        yaw = Math.sin(sec * 0.7 + seed) * 0.5;
      }
      break;
    case "graze": {
      // Head down, nibbling in little bursts; now and then the head comes up to chew and look.
      const look = pulse(sec, seed * 3 + i.variant, 9, 0.16);
      const nib = Math.max(0, Math.sin(sec * 1.3 + seed)) * Math.sin(sec * 13) * 0.07;
      pitch = 1.02 * (1 - look) + nib + look * 0.05;
      yaw = Math.sin(sec * 0.35 + seed) * 0.25 * (1 - look) + look * Math.sin(seed) * 0.6;
      break;
    }
    case "idle": {
      yaw = Math.sin(sec * 0.6 + seed) * 0.62;
      pitch = -0.05 + Math.sin(sec * 0.43 + seed * 2) * 0.12;
      flick = Math.max(flick, pulse(sec, seed * 11, 2.6, 0.1));
      break;
    }
    case "play": {
      const v = i.variant % 3;
      const u = clamp(st / dur);
      // Hops: a parabola per hop, squash on landing, stretch in the air.
      const rate = v === 0 ? 1.35 : 2.1;
      const h = (st * rate) % 1;
      const height = v === 0 ? 0.6 : 0.28;
      const fadeIn = smooth(0, 0.15, u) * (1 - smooth(0.9, 1, u));
      hop = 4 * h * (1 - h) * height * fadeIn;
      squash = h < 0.14 ? 1 - 0.22 * (1 - h / 0.14) * fadeIn : 1 + 0.1 * Math.sin(h * Math.PI) * fadeIn;
      pitch = v === 2 ? -0.32 : -0.08;
      roll = Math.sin(st * rate * Math.PI) * 0.08 * fadeIn;
      if (v !== 0) {
        const r = 1.5;
        const [f0, l0] = playPath(v, u, r);
        const [f1, l1] = playPath(v, Math.min(1, u + 0.01), r);
        const c = Math.cos(i.face);
        const sn = Math.sin(i.face);
        // forward = (cos, sin), left = (-sin, cos) in (x, z)
        x += f0 * c - l0 * sn;
        z += f0 * sn + l0 * c;
        const dx = (f1 - f0) * c - (l1 - l0) * sn;
        const dz = (f1 - f0) * sn + (l1 - l0) * c;
        if (Math.hypot(dx, dz) > 1e-5) desired = Math.atan2(dz, dx);
        moving = u > 0.02 && u < 0.98;
        speed = 1.8;
        if (v === 2 && near) {
          const [fb, lb] = playPath(v, Math.min(1, u + 0.07), r);
          emit("butterfly", i.from[0] + fb * c - lb * sn, 1.4 + Math.sin(st * 5) * 0.25, i.from[1] + fb * sn + lb * c, s);
        }
      }
      break;
    }
    case "social": {
      if (!moving) {
        // Nose boop, then stand together.
        const b = st - wm;
        const boop = smooth(0.6, 1.0, b) * (1 - smooth(1.3, 1.8, b));
        pitch = 0.25 * boop + 0.05;
        yaw = boop > 0 ? 0 : Math.sin(sec * 0.5 + seed) * 0.3;
        x += Math.cos(i.face) * 0.14 * boop;
        z += Math.sin(i.face) * 0.14 * boop;
        if (b > 1.0 && !(s.once & ONCE.boop)) {
          s.once |= ONCE.boop;
          if (near) emit("heart", x + Math.cos(i.face) * 0.9, 1.75, z + Math.sin(i.face) * 0.9, s);
        }
      } else {
        roll = Math.sin(s.walkPhase) * 0.06;
        pitch = 0.1;
      }
      break;
    }
    case "sleep": {
      lie = left > 1.4 ? 1 : 0;
      eye = 0.08;
      pitch = 0.42;
      yaw = 0.5 * (seed % 2 ? 1 : -1);
      hroll = 0.28 * (seed % 2 ? 1 : -1);
      if (near && st > 1.5 && left > 1.5 && performance.now() > s.nextZ) {
        s.nextZ = performance.now() + 1900 + (seed % 700);
        emit("z", x, 1.4, z, s);
      }
      break;
    }
    case "eat": {
      stride = 9;
      if (moving) {
        roll = Math.sin(s.walkPhase) * 0.07;
        pitch = 0.2;
      } else {
        const kind = i.food?.kind;
        const chewRate = kind === "hay" ? 5 : 10;
        pitch = 0.92 + Math.sin(sec * chewRate) * (kind === "hay" ? 0.05 : 0.08);
        eye = kind === "hay" ? 0.55 : eye;
        yaw = Math.sin(sec * 1.1) * 0.05;
        if (near && (kind === "apple" || kind === "carrot") && Math.sin(sec * chewRate) > 0.995) emit("crunch", x, 0.3, z, s);
        if (kind === "dandelion" && left < 0.8) {
          // A little sneeze.
          const k = smooth(0.8, 0.55, left) * (1 - smooth(0.4, 0.15, left));
          pitch = 0.92 - k * 1.3;
          squash = 1 - k * 0.08;
          if (left < 0.5 && !(s.once & ONCE.sneeze)) {
            s.once |= ONCE.sneeze;
            if (near) emit("sneeze", x + Math.cos(i.face) * 1.0, 1.0, z + Math.sin(i.face) * 1.0, s);
          }
        }
      }
      break;
    }
    case "petted": {
      const k = smooth(0, 0.35, st) * (1 - smooth(1.6, 2.0, st));
      eye = 1 - 0.9 * k;
      roll = 0.2 * k * (seed % 2 ? 1 : -1);
      hroll = 0.32 * k * (seed % 2 ? 1 : -1);
      pitch = -0.12 * k;
      squash = 1 - 0.05 * k;
      if (!(s.once & ONCE.heart)) {
        s.once |= ONCE.heart;
        emit("heart", x, 2.1, z, s);
      }
      break;
    }
  }

  // Smooth the slow parts so state changes ease rather than snap.
  const p = s.pose;
  const k = (rate: number) => 1 - Math.exp(-dt * rate);
  p.pitch += (pitch - p.pitch) * k(7);
  p.yaw += (yaw - p.yaw) * k(4);
  p.hroll += (hroll - p.hroll) * k(4);
  p.lie += (lie - p.lie) * k(lie > p.lie ? 2.2 : 3.5);
  p.roll += (roll - p.roll) * k(10);
  p.eye = eye;
  p.flick = flick;
  p.hop = hop;
  p.squash = squash;

  s.heading = angleTo(s.heading, desired, k(moving ? 7 : 3.2));
  s.walkAmt += ((moving ? 1 : 0) - s.walkAmt) * k(9);
  s.walkPhase += dt * speed * stride * (0.4 + 0.6 * s.walkAmt);
  s.x = x;
  s.z = z;
  s.y = terrainHeight(x, z);
}
