// The static world: terrain, obstacles, walkable bounds. Shared verbatim by the
// server (which steers sheep around obstacles) and the client (which draws
// them), so a sheep never walks through a tree on one screen and around it on
// another.

import { hash2, rng, range } from "./rng";

export const WORLD_SEED = 20261027;
/** Obstacles and scenery are generated out to this half-extent. */
export const MAX_HALF = 800;
/** The ground is drawn this far beyond the walkable edge, so the edge of the world is never on screen. */
export const GROUND_MARGIN = 420;
export const CHUNK = 50;

/**
 * Walkable half-extent for a given population. The PRD starts at 400 x 400
 * and grows the plain as the flock grows; growing with sqrt(count) keeps
 * density constant (one sheep per ~530 square units) past 300 sheep.
 */
export function walkableHalf(sheepCount: number): number {
  return Math.min(MAX_HALF, Math.max(200, 200 * Math.sqrt(sheepCount / 300)));
}

export interface Pond {
  x: number;
  z: number;
  r: number;
}
export interface Tree {
  x: number;
  z: number;
  r: number;
  s: number;
  kind: number;
}
export interface Rock {
  x: number;
  z: number;
  r: number;
}
export interface Wall {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** 0 = wooden fence, 1 = low stone wall */
  kind: number;
}

export interface WorldMap {
  ponds: Pond[];
  trees: Tree[];
  rocks: Rock[];
  walls: Wall[];
}

// Ponds are placed by hand near the middle (the first 400 x 400 has to be
// pretty on day one) and procedurally further out.
const HAND_PONDS: Pond[] = [
  { x: 52, z: -38, r: 17 },
  { x: -118, z: 96, r: 12 },
];

function generate(): WorldMap {
  const r = rng(WORLD_SEED);
  const ponds = [...HAND_PONDS];
  while (ponds.length < 9) {
    const x = range(r, -MAX_HALF + 60, MAX_HALF - 60);
    const z = range(r, -MAX_HALF + 60, MAX_HALF - 60);
    if (Math.hypot(x, z) < 230) continue;
    const pr = range(r, 10, 24);
    if (ponds.some((p) => Math.hypot(p.x - x, p.z - z) < p.r + pr + 60)) continue;
    ponds.push({ x, z, r: pr });
  }

  const nearPond = (x: number, z: number, pad: number) =>
    ponds.some((p) => Math.hypot(p.x - x, p.z - z) < p.r + pad);

  // Trees grow in groves, plus a few loners so the plain is not bare.
  const trees: Tree[] = [];
  const groves = 46;
  for (let g = 0; g < groves; g++) {
    const gx = range(r, -MAX_HALF, MAX_HALF);
    const gz = range(r, -MAX_HALF, MAX_HALF);
    // Keep the spawn meadow open.
    if (Math.hypot(gx, gz) < 45) continue;
    const n = 3 + Math.floor(r() * 7);
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2;
      const d = Math.sqrt(r()) * 22;
      const x = gx + Math.cos(a) * d;
      const z = gz + Math.sin(a) * d;
      const s = range(r, 0.8, 1.35);
      if (nearPond(x, z, 5)) continue;
      if (trees.some((t) => Math.hypot(t.x - x, t.z - z) < 4.5)) continue;
      trees.push({ x, z, r: 1.6 * s, s, kind: Math.floor(r() * 3) });
    }
  }
  for (let i = 0; i < 140; i++) {
    const x = range(r, -MAX_HALF, MAX_HALF);
    const z = range(r, -MAX_HALF, MAX_HALF);
    if (Math.hypot(x, z) < 30 || nearPond(x, z, 5)) continue;
    const s = range(r, 0.9, 1.4);
    trees.push({ x, z, r: 1.6 * s, s, kind: Math.floor(r() * 3) });
  }

  const rocks: Rock[] = [];
  for (let i = 0; i < 520; i++) {
    const x = range(r, -MAX_HALF, MAX_HALF);
    const z = range(r, -MAX_HALF, MAX_HALF);
    if (nearPond(x, z, 2)) continue;
    rocks.push({ x, z, r: range(r, 0.35, 1.25) });
  }

  // Fences and low walls: short runs with gaps, never across a pond.
  const walls: Wall[] = [];
  for (let i = 0; i < 70; i++) {
    const ax = range(r, -MAX_HALF + 20, MAX_HALF - 20);
    const az = range(r, -MAX_HALF + 20, MAX_HALF - 20);
    if (Math.hypot(ax, az) < 40) continue;
    const kind = r() < 0.55 ? 0 : 1;
    const segs = 1 + Math.floor(r() * 3);
    let x = ax;
    let z = az;
    let ang = r() * Math.PI * 2;
    for (let s = 0; s < segs; s++) {
      const len = range(r, 12, 30);
      const bx = x + Math.cos(ang) * len;
      const bz = z + Math.sin(ang) * len;
      let ok = true;
      for (let t = 0; t <= 1; t += 0.1) {
        if (nearPond(x + (bx - x) * t, z + (bz - z) * t, 4)) ok = false;
      }
      if (ok) walls.push({ ax: x, az: z, bx, bz, kind });
      // Leave a gap a sheep can walk through, then turn a corner.
      const gap = range(r, 4, 9);
      x = bx + Math.cos(ang) * gap;
      z = bz + Math.sin(ang) * gap;
      ang += (r() < 0.5 ? -1 : 1) * Math.PI * range(r, 0.35, 0.5);
    }
  }
  // Rocks inside tree trunks or walls look like mistakes; drop them.
  const keptRocks = rocks.filter(
    (k) =>
      !trees.some((t) => Math.hypot(t.x - k.x, t.z - k.z) < t.r + k.r + 0.5) &&
      !walls.some((w) => segDist(k.x, k.z, w) < k.r + 1),
  );
  return { ponds, trees, rocks: keptRocks, walls };
}

function segDist(px: number, pz: number, w: Wall): number {
  const dx = w.bx - w.ax;
  const dz = w.bz - w.az;
  const l2 = dx * dx + dz * dz || 1;
  const t = Math.max(0, Math.min(1, ((px - w.ax) * dx + (pz - w.az) * dz) / l2));
  return Math.hypot(px - (w.ax + dx * t), pz - (w.az + dz * t));
}

export const WORLD: WorldMap = generate();

// ---------------------------------------------------------------- terrain

/** Ground height around every pond; the water sits just above it. */
export const POND_RIM = 0.15;

function rolling(x: number, z: number): number {
  return (
    1.5 * Math.sin(x * 0.0173 + 0.7) * Math.cos(z * 0.0141 - 0.3) +
    0.7 * Math.sin((x + z) * 0.0311 + 1.9) +
    0.35 * Math.cos(x * 0.061 - z * 0.047)
  );
}

/** Gently rolling ground, with smooth basins for ponds. */
export function terrainHeight(x: number, z: number): number {
  let h = rolling(x, z);
  for (const p of WORLD.ponds) {
    const d = Math.hypot(x - p.x, z - p.z);
    const inner = p.r + 1.6;
    const outer = p.r + 11;
    if (d < outer) {
      // Flat rim at the water line out past the shore, easing back into the hills.
      const t = d <= inner ? 1 : 1 - (d - inner) / (outer - inner);
      const k = t * t * (3 - 2 * t);
      const bowl = d < p.r ? -0.9 * (1 - (d / p.r) ** 2) : 0;
      h = h * (1 - k) + (POND_RIM + bowl) * k;
    }
  }
  return h;
}

// ---------------------------------------------------------------- collision

interface Circle {
  x: number;
  z: number;
  r: number;
}

const CELL = 25;
const grid = new Map<number, { circles: Circle[]; walls: Wall[] }>();
const key = (cx: number, cz: number) => (cx + 1000) * 4000 + (cz + 1000);
function cellAt(cx: number, cz: number) {
  const k = key(cx, cz);
  let c = grid.get(k);
  if (!c) grid.set(k, (c = { circles: [], walls: [] }));
  return c;
}
function addCircle(c: Circle) {
  const x0 = Math.floor((c.x - c.r) / CELL);
  const x1 = Math.floor((c.x + c.r) / CELL);
  const z0 = Math.floor((c.z - c.r) / CELL);
  const z1 = Math.floor((c.z + c.r) / CELL);
  for (let cx = x0; cx <= x1; cx++) for (let cz = z0; cz <= z1; cz++) cellAt(cx, cz).circles.push(c);
}
for (const p of WORLD.ponds) addCircle({ x: p.x, z: p.z, r: p.r + 1.2 });
for (const t of WORLD.trees) addCircle({ x: t.x, z: t.z, r: t.r * 0.55 });
for (const k of WORLD.rocks) if (k.r > 0.6) addCircle({ x: k.x, z: k.z, r: k.r });
for (const w of WORLD.walls) {
  const len = Math.hypot(w.bx - w.ax, w.bz - w.az);
  for (let t = 0; t <= len; t += CELL / 2) {
    const f = t / len;
    const cx = Math.floor((w.ax + (w.bx - w.ax) * f) / CELL);
    const cz = Math.floor((w.az + (w.bz - w.az) * f) / CELL);
    for (let dx = -1; dx <= 1; dx++)
      for (let dz = -1; dz <= 1; dz++) {
        const c = cellAt(cx + dx, cz + dz);
        if (!c.walls.includes(w)) c.walls.push(w);
      }
  }
}

/** True if a sheep of radius `r` standing at (x, z) would overlap scenery. */
export function blocked(x: number, z: number, r = 1): boolean {
  const c = grid.get(key(Math.floor(x / CELL), Math.floor(z / CELL)));
  if (!c) return false;
  for (const o of c.circles) if (Math.hypot(o.x - x, o.z - z) < o.r + r) return true;
  for (const w of c.walls) if (segDist(x, z, w) < 0.5 + r) return true;
  return false;
}

/** True if a sheep can walk the straight line from a to b. */
export function pathClear(ax: number, az: number, bx: number, bz: number, r = 1): boolean {
  const len = Math.hypot(bx - ax, bz - az);
  const steps = Math.max(1, Math.ceil(len / 0.75));
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (blocked(ax + (bx - ax) * t, az + (bz - az) * t, r)) return false;
  }
  return true;
}

export function inBounds(x: number, z: number, half: number, pad = 2): boolean {
  return Math.abs(x) < half - pad && Math.abs(z) < half - pad;
}

// ---------------------------------------------------------------- chunks

/** Integer chunk id. Chunks are CHUNK x CHUNK world units. */
export function chunkId(cx: number, cz: number): number {
  return (cx + 100) * 1000 + (cz + 100);
}
export function chunkOf(x: number, z: number): number {
  return chunkId(Math.floor(x / CHUNK), Math.floor(z / CHUNK));
}
export function chunkCoords(id: number): [number, number] {
  return [Math.floor(id / 1000) - 100, (id % 1000) - 100];
}

/** Decorative per-cell scatter (flowers etc.) with no shared state. */
export const scatter = hash2;
