// Wire messages (PRD "Messages"). The server sends behaviour intents, never
// per-frame positions; clients interpolate.

import type { Traits } from "./traits";

export const FOODS = ["clover", "dandelion", "apple", "carrot", "hay"] as const;
export type Food = (typeof FOODS)[number];

export type State = "wander" | "graze" | "idle" | "play" | "social" | "sleep" | "eat" | "petted" | "drop";

export interface Intent {
  id: string;
  state: State;
  from: [number, number];
  to: [number, number];
  startAt: number;
  duration: number;
  /** Per-intent random int, so every client picks the same play variant, nibble rhythm, etc. */
  variant: number;
  /** Facing (radians, atan2(dz, dx)) once the sheep has arrived / while it stands. */
  face: number;
  /** social: the sheep being visited. */
  other?: string;
  /** eat: what was dropped and where. */
  food?: { kind: Food; x: number; z: number };
}

export interface SheepWire {
  id: string;
  traits: Traits;
  /** ISO 3166-1 alpha-2, "XX" when unknown, null for a wild (ownerless) sheep. */
  country: string | null;
  level: number;
  intent: Intent;
}

export interface You {
  sheepId: string;
  level: number;
  exp: number;
  into: number;
  next: number;
  /** Credited active seconds, for "time together". */
  activeSeconds: number;
  createdAt: number;
  /** False when another tab holds this sheep's EXP. */
  primary: boolean;
  feedReadyAt: number;
  petReadyAt: number;
}

export type ClientMsg =
  | { t: "hello"; token: string | null; sentAt: number }
  | { t: "viewport"; chunks: number[] }
  | { t: "heartbeat" }
  | { t: "feed"; food: Food }
  | { t: "pet" }
  | { t: "ping"; sentAt: number };

export type FxKind = "feed" | "pet" | "levelup" | "arrive";
export interface Fx {
  sheepId: string;
  kind: FxKind;
  at: number;
  food?: Food;
}

export type ServerMsg =
  | { t: "welcome"; now: number; sentAt: number; you: You | null; world: WorldInfo }
  | { t: "snapshot"; sheep: SheepWire[] }
  | { t: "spawn"; sheep: SheepWire[] }
  | { t: "despawn"; ids: string[] }
  | { t: "intent"; intents: Intent[] }
  | { t: "fx"; fx: Fx[] }
  | { t: "you"; you: You }
  | { t: "level"; id: string; level: number }
  | { t: "world"; world: WorldInfo }
  | { t: "pong"; now: number; sentAt: number }
  | { t: "error"; code: string; message: string };

export interface WorldInfo {
  sheep: number;
  half: number;
}

export const HEARTBEAT_MS = 30_000;
export const FEED_COOLDOWN_MS = 2 * 60_000;
export const PET_COOLDOWN_MS = 4_000;
/** Sheep whose owners have been away this long rest in the barn (not loaded into the pasture). */
export const BARN_AFTER_MS = 30 * 24 * 60 * 60_000;
