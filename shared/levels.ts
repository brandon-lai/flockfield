// EXP and levels (PRD "EXP and levels").
//
// EXP to go from L to L+1 is round(10 * L^1.5): level 2 after 10 active
// minutes, level 5 after ~3 hours, level 10 after ~18.5 hours. There is no
// cap -- the curve is its own cap (level 50 is about 1,100 hours) -- but the
// look stops changing at 30, when the flower crown arrives.

export const expToNext = (level: number) => Math.round(10 * Math.pow(level, 1.5));

export interface Progress {
  level: number;
  /** EXP earned inside the current level. */
  into: number;
  /** EXP the current level needs in total. */
  next: number;
}

export function progressFromExp(exp: number): Progress {
  let level = 1;
  let left = Math.max(0, Math.floor(exp));
  for (;;) {
    const need = expToNext(level);
    if (left < need) return { level, into: left, next: need };
    left -= need;
    level++;
  }
}

export const levelFromExp = (exp: number) => progressFromExp(exp).level;

/** Total EXP needed to reach `level` from nothing. */
export function expForLevel(level: number): number {
  let t = 0;
  for (let l = 1; l < level; l++) t += expToNext(l);
  return t;
}

// Visual growth: lambs until 5, fluffier wool every 5 levels, accessories at
// milestones.
export const isLamb = (level: number) => level < 5;
export const fluffTier = (level: number) => Math.min(6, Math.floor(level / 5));
export const ACCESSORY_LEVELS = { bow: 10, bell: 20, crown: 30 } as const;
