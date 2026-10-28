// Deterministic randomness shared by the server simulation and the client.
// Nothing in shared/ may call Math.random: the world map and trait rolls have
// to come out identical on every machine.

export type Rng = () => number;

/** mulberry32: small, fast, and good enough for scattering sheep. */
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over a string, for turning ids into seeds. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Integer hash of two ints and a seed, as a float in [0, 1). */
export function hash2(x: number, y: number, seed = 0): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export const range = (r: Rng, lo: number, hi: number) => lo + (hi - lo) * r();

export function pickWeighted<T extends string>(r: Rng, weights: Record<T, number>): T {
  let total = 0;
  for (const k in weights) total += Math.max(0, weights[k]);
  let x = r() * total;
  let last: T | undefined;
  for (const k in weights) {
    const w = Math.max(0, weights[k]);
    if (w <= 0) continue;
    last = k;
    if ((x -= w) < 0) return k;
  }
  return last as T;
}
