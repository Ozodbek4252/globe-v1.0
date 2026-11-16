/**
 * Deterministic pseudo-random number in [0, 1) from two integers. The same inputs always give the
 * same output, on every machine, so per-building and per-tree variation is reproducible.
 */
export function hash01(a: number, b = 0): number {
  let h = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296;
}
