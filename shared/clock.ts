// One shared world clock: one in-world day per real hour, the same for every
// viewer. (Open question "Day and night": shared, because it is one pasture --
// if your screen says night, every sheep you see should be the sleepy one.)

export const DAY_MS = 60 * 60 * 1000;

/** 0..1 through the day; 0 is dawn. */
export const dayPhase = (now: number) => (((now % DAY_MS) + DAY_MS) % DAY_MS) / DAY_MS;

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Sun height, -1..1. Daylight is about two thirds of the cycle. */
export const sunHeight = (now: number) => Math.sin(2 * Math.PI * dayPhase(now) + 0.32);

/** 0 in daylight, 1 deep at night. */
export const nightAmount = (now: number) => 1 - smooth(-0.62, -0.28, sunHeight(now));
