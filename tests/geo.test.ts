import { describe, expect, it } from 'vitest';
import { antipode, clampLat, unitVector, wrapLon } from '../src/lib/geo';

describe('wrapLon', () => {
  it.each([
    [0, 0],
    [179, 179],
    [180, -180],
    [190, -170],
    [-190, 170],
    [-180, -180],
    [359, -1],
    [-30, -30],
  ])('%d -> %d', (input, expected) => {
    expect(wrapLon(input)).toBe(expected);
  });

  // Documented limitation kept from the legacy page: the formula is exact for inputs within one
  // turn of the range. A globe left spinning for minutes can drift past that.
  it('keeps the legacy behaviour for angles more than one turn out', () => {
    expect(wrapLon(-600)).toBe(-240);
  });
});

describe('clampLat', () => {
  it('stops short of the poles', () => {
    expect(clampLat(95)).toBe(89);
    expect(clampLat(-95)).toBe(-89);
    expect(clampLat(45)).toBe(45);
  });
});

describe('antipode', () => {
  it('flips to the far side of the sphere', () => {
    expect(antipode([10, 20])).toEqual([190, -20]);
    expect(antipode([-170, -45])).toEqual([10, 45]);
  });
});

describe('unitVector', () => {
  it('points x at lon 0, y at lon 90 and z at the north pole', () => {
    const near = (v: number[], w: number[]): void =>
      v.forEach((n, i) => expect(n).toBeCloseTo(w[i] ?? NaN, 12));
    near(unitVector([0, 0]), [1, 0, 0]);
    near(unitVector([90, 0]), [0, 1, 0]);
    near(unitVector([0, 90]), [0, 0, 1]);
    near(unitVector([180, 0]), [-1, 0, 0]);
  });

  it('is always length 1', () => {
    for (const [lon, lat] of [
      [12.3, -45.6],
      [-170, 80],
      [99, 0.5],
    ] as const) {
      const [x, y, z] = unitVector([lon, lat]);
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 12);
    }
  });
});
