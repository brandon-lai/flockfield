// Fixed-for-life looks, rolled once at creation (PRD "Identity and look").

import { pickWeighted, type Rng } from "./rng";

export const WOOL = {
  cream: "#f7edd8",
  white: "#fbfaf5",
  gray: "#d6d5da",
  brown: "#d4ae8f",
  black: "#4a4446",
} as const;
export type Wool = keyof typeof WOOL;
export const WOOL_KEYS = Object.keys(WOOL) as Wool[];

export const FACE = ["#f3d4c4", "#c99f80", "#6b4c3c", "#3a3234"] as const;
export const BOW = ["#ff8fab", "#8ec5ff", "#ffd166", "#b69cff", "#ff9f7a"] as const;

export interface Traits {
  wool: number; // index into WOOL_KEYS
  face: number; // index into FACE
  ears: number; // 0 floppy, 1 perky, 2 small and round
  puff: number; // 0..1 wool puffiness
  bow: number; // accessory colour, used once the bow unlocks
  seed: number;
}

export function rollTraits(r: Rng): Traits {
  // Black wool is the rare one.
  const wool = WOOL_KEYS.indexOf(
    pickWeighted(r, { cream: 30, white: 30, gray: 18, brown: 17, black: 5 } as Record<Wool, number>),
  );
  // Darker wool reads best with a darker face; light wool takes any.
  const face =
    WOOL_KEYS[wool] === "black"
      ? 3
      : Number(pickWeighted(r, { "0": 40, "1": 25, "2": 22, "3": 13 } as Record<string, number>));
  return {
    wool,
    face,
    ears: Math.floor(r() * 3),
    puff: Math.round(r() * 100) / 100,
    bow: Math.floor(r() * BOW.length),
    seed: Math.floor(r() * 2 ** 31),
  };
}

export function isTraits(t: unknown): t is Traits {
  const o = t as Traits;
  return (
    !!o &&
    [o.wool, o.face, o.ears, o.puff, o.bow, o.seed].every((v) => typeof v === "number" && Number.isFinite(v))
  );
}
