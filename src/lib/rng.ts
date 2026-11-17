// A small seeded random number generator (mulberry32). Games built on it replay exactly: the same seed
// and the same inputs give the same game. The state is one number, advanced in place by each call.

export interface Rng {
  state: number;
}

export function createRng(seed: number): Rng {
  return { state: seed >>> 0 || 0x9e3779b9 };
}

/** The next number in [0, 1). */
export function nextFloat(rng: Rng): number {
  rng.state = (rng.state + 0x6d2b79f5) >>> 0;
  let t = rng.state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** A whole number from 0 up to, but not including, `n`. */
export function nextInt(rng: Rng, n: number): number {
  return Math.floor(nextFloat(rng) * n);
}

/** A number in [lo, hi). */
export function nextRange(rng: Rng, lo: number, hi: number): number {
  return lo + nextFloat(rng) * (hi - lo);
}

/** One of the items, chosen at random. */
export function nextPick<T>(rng: Rng, items: readonly T[]): T {
  return items[nextInt(rng, items.length)];
}
