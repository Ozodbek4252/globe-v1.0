import { describe, expect, it } from 'vitest';
import { createRng, nextFloat, nextInt, nextPick, nextRange } from '../src/lib/rng';

describe('seeded random numbers', () => {
  it('repeats exactly for the same seed', () => {
    const a = createRng(1234);
    const b = createRng(1234);
    for (let i = 0; i < 100; i++) expect(nextFloat(a)).toBe(nextFloat(b));
  });

  it('differs between seeds', () => {
    const a = createRng(1);
    const b = createRng(2);
    const xs = Array.from({ length: 8 }, () => nextFloat(a));
    const ys = Array.from({ length: 8 }, () => nextFloat(b));
    expect(xs).not.toEqual(ys);
  });

  it('is pinned: the first values never change (saved games depend on it)', () => {
    const r = createRng(42);
    expect([nextFloat(r), nextFloat(r), nextFloat(r)].map((v) => Math.round(v * 1e6))).toEqual([
      601104, 448291, 852466,
    ]);
  });

  it('stays inside its ranges', () => {
    const r = createRng(7);
    for (let i = 0; i < 5000; i++) {
      const f = nextFloat(r);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      const n = nextInt(r, 6);
      expect(Number.isInteger(n)).toBe(true);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(6);
      const v = nextRange(r, -3, 5);
      expect(v).toBeGreaterThanOrEqual(-3);
      expect(v).toBeLessThan(5);
    }
  });

  it('covers every die face roughly evenly', () => {
    const r = createRng(99);
    const counts = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 6000; i++) counts[nextInt(r, 6)]++;
    for (const c of counts) expect(Math.abs(c - 1000)).toBeLessThan(150);
  });

  it('picks from a list and survives a zero seed', () => {
    const r = createRng(0);
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(nextPick(r, ['a', 'b', 'c']));
    expect([...seen].sort()).toEqual(['a', 'b', 'c']);
  });
});
