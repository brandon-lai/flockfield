// Fixed-angle camera (PRD "Camera"): pan and zoom only, never rotate. Drag
// to pan, wheel or pinch to zoom toward the pointer, eased fly-to for "find
// my sheep". The target is clamped to the walkable plain, and the ground runs
// far enough past it that the edge of the world is never on screen.

import * as THREE from "three";
import { terrainHeight } from "../../shared/world";

export const PITCH = THREE.MathUtils.degToRad(56);
export const MIN_DIST = 13;
export const MAX_DIST = 200;

export interface TapEvent {
  x: number;
  y: number;
  nx: number;
  ny: number;
}

export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  readonly target = new THREE.Vector3();
  dist = 42;
  half = 200;
  private pointers = new Map<number, { x: number; y: number }>();
  private dragStart: { x: number; y: number; t: number; moved: number } | null = null;
  private pinchStart: { d: number; dist: number } | null = null;
  private vel = new THREE.Vector2();
  private fly: { from: THREE.Vector3; to: THREE.Vector3; d0: number; d1: number; t0: number; dur: number } | null = null;
  private ray = new THREE.Raycaster();
  private plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  onTap: (e: TapEvent) => void = () => {};
  onHover: (e: TapEvent | null) => void = () => {};
  onUserMove: () => void = () => {};

  constructor(private el: HTMLElement) {
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.5, 2400);
    el.addEventListener("pointerdown", this.down);
    el.addEventListener("pointermove", this.move);
    el.addEventListener("pointerup", this.up);
    el.addEventListener("pointercancel", this.up);
    el.addEventListener("pointerleave", () => this.onHover(null));
    el.addEventListener("wheel", this.wheel, { passive: false });
  }

  get flying() {
    return !!this.fly;
  }

  resize(w: number, h: number) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  flyTo(x: number, z: number, dist = this.dist, dur = 1400) {
    this.fly = { from: this.target.clone(), to: new THREE.Vector3(x, 0, z), d0: this.dist, d1: dist, t0: performance.now(), dur };
    this.vel.set(0, 0);
  }

  jumpTo(x: number, z: number, dist = this.dist) {
    this.fly = null;
    this.target.set(x, 0, z);
    this.dist = dist;
  }

  /** Ground point under a screen position (NDC). */
  groundAt(nx: number, ny: number, out = new THREE.Vector3()): THREE.Vector3 | null {
    this.ray.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    this.plane.constant = -this.target.y;
    return this.ray.ray.intersectPlane(this.plane, out);
  }

  /** The four corners of the view on the ground, for chunk subscriptions. */
  footprint(): THREE.Vector3[] {
    const out: THREE.Vector3[] = [];
    for (const [x, y] of [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ]) {
      const p = this.groundAt(x, y);
      if (p) out.push(p);
    }
    return out;
  }

  update(dt: number) {
    if (this.fly) {
      const f = Math.min(1, (performance.now() - this.fly.t0) / this.fly.dur);
      const e = f < 0.5 ? 4 * f * f * f : 1 - (-2 * f + 2) ** 3 / 2;
      this.target.lerpVectors(this.fly.from, this.fly.to, e);
      this.dist = this.fly.d0 + (this.fly.d1 - this.fly.d0) * e;
      if (f >= 1) this.fly = null;
    } else if (!this.pointers.size && this.vel.lengthSq() > 1e-4) {
      // A little glide after letting go.
      this.target.x += this.vel.x * dt;
      this.target.z += this.vel.y * dt;
      this.vel.multiplyScalar(Math.exp(-dt * 5));
    }
    this.clamp();
    const ty = terrainHeight(this.target.x, this.target.z);
    this.target.y += (ty - this.target.y) * Math.min(1, dt * 4);
    this.camera.position.set(this.target.x, this.target.y + this.dist * Math.sin(PITCH), this.target.z + this.dist * Math.cos(PITCH));
    this.camera.lookAt(this.target);
    this.camera.updateMatrixWorld();
  }

  private clamp() {
    const h = this.half + 10;
    this.target.x = Math.max(-h, Math.min(h, this.target.x));
    this.target.z = Math.max(-h, Math.min(h, this.target.z));
    this.dist = Math.max(MIN_DIST, Math.min(MAX_DIST, this.dist));
  }

  private ndc(e: { clientX: number; clientY: number }) {
    const r = this.el.getBoundingClientRect();
    return { nx: ((e.clientX - r.left) / r.width) * 2 - 1, ny: -((e.clientY - r.top) / r.height) * 2 + 1 };
  }

  private down = (e: PointerEvent) => {
    try {
      this.el.setPointerCapture(e.pointerId);
    } catch {
      // Not every pointer can be captured (synthetic events); panning still works.
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.fly = null;
    this.vel.set(0, 0);
    if (this.pointers.size === 1) this.dragStart = { x: e.clientX, y: e.clientY, t: performance.now(), moved: 0 };
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinchStart = { d: Math.hypot(a.x - b.x, a.y - b.y), dist: this.dist };
      if (this.dragStart) this.dragStart.moved = 99;
    }
  };

  private move = (e: PointerEvent) => {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) {
      if (e.pointerType === "mouse") this.onHover({ x: e.clientX, y: e.clientY, ...this.ndc(e) });
      return;
    }
    const cur = { x: e.clientX, y: e.clientY };
    if (this.pointers.size === 1) {
      // Keep the ground point under the finger under the finger.
      const np = this.ndc({ clientX: prev.x, clientY: prev.y });
      const nc = this.ndc({ clientX: cur.x, clientY: cur.y });
      const a = this.groundAt(np.nx, np.ny);
      const b = this.groundAt(nc.nx, nc.ny, new THREE.Vector3());
      if (a && b) {
        const dx = a.x - b.x;
        const dz = a.z - b.z;
        this.target.x += dx;
        this.target.z += dz;
        const dt = Math.max(1 / 120, (e.timeStamp - (this.lastMoveT || e.timeStamp)) / 1000);
        this.vel.set(dx / dt, dz / dt).clampLength(0, 400);
      }
      this.lastMoveT = e.timeStamp;
      if (this.dragStart) this.dragStart.moved += Math.hypot(cur.x - prev.x, cur.y - prev.y);
      if (this.dragStart && this.dragStart.moved > 6) {
        this.el.classList.add("dragging");
        this.onUserMove();
      }
    } else if (this.pointers.size === 2 && this.pinchStart) {
      const others = [...this.pointers.entries()].find(([id]) => id !== e.pointerId)![1];
      const midPrev = { clientX: (prev.x + others.x) / 2, clientY: (prev.y + others.y) / 2 };
      const midCur = { clientX: (cur.x + others.x) / 2, clientY: (cur.y + others.y) / 2 };
      const d = Math.hypot(cur.x - others.x, cur.y - others.y);
      const before = this.groundAt(this.ndc(midPrev).nx, this.ndc(midPrev).ny);
      this.dist = this.pinchStart.dist * (this.pinchStart.d / Math.max(10, d));
      this.clamp();
      this.update(0);
      const after = this.groundAt(this.ndc(midCur).nx, this.ndc(midCur).ny);
      if (before && after) {
        this.target.x += before.x - after.x;
        this.target.z += before.z - after.z;
      }
      this.onUserMove();
    }
    this.pointers.set(e.pointerId, cur);
  };
  private lastMoveT = 0;

  private up = (e: PointerEvent) => {
    const had = this.pointers.has(e.pointerId);
    this.pointers.delete(e.pointerId);
    this.el.classList.remove("dragging");
    if (this.pointers.size < 2) this.pinchStart = null;
    if (!had) return;
    const ds = this.dragStart;
    if (!this.pointers.size) {
      this.dragStart = null;
      // A tap, not a drag: no glide.
      if (ds && ds.moved < 8 && performance.now() - ds.t < 600) {
        this.vel.set(0, 0);
        this.onTap({ x: e.clientX, y: e.clientY, ...this.ndc(e) });
      }
      // A slow release should not fling.
      if (e.timeStamp - this.lastMoveT > 80) this.vel.set(0, 0);
    }
  };

  private wheel = (e: WheelEvent) => {
    e.preventDefault();
    this.fly = null;
    const { nx, ny } = this.ndc(e);
    const before = this.groundAt(nx, ny);
    // Trackpad pinch arrives as ctrl+wheel with small deltas.
    const k = e.ctrlKey ? 0.012 : 0.0016;
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    this.dist *= Math.exp(delta * k);
    this.clamp();
    this.update(0);
    const after = this.groundAt(nx, ny);
    if (before && after) {
      this.target.x += before.x - after.x;
      this.target.z += before.z - after.z;
    }
    this.onUserMove();
  };
}
