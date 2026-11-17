import { describe, expect, it } from 'vitest';
import { buildColliders, type ColliderSource } from '../src/sim/colliders';
import { lineOfSight, rayCircleHit, rayWallHit } from '../src/sim/raycast';
import { createRng, nextRange } from '../src/lib/rng';

const sq = (x: number, y: number, w: number, h = w): number[] => [
  x,
  y,
  x + w,
  y,
  x + w,
  y + h,
  x,
  y + h,
];

const world = (extra: Partial<ColliderSource> = {}) =>
  buildColliders({
    halfSize: 100,
    buildings: [{ outer: sq(0, 0, 10) }],
    areas: [],
    waterways: [],
    roads: [],
    ...extra,
  });

describe('rays against walls', () => {
  const w = world();

  it('reports how far along a ray the first wall is', () => {
    // from x = -5 to x = 15 along y = 5; the west wall is at x = 0, a quarter of the way
    expect(rayWallHit(w, -5, 5, 15, 5)).toBeCloseTo(0.25, 6);
    expect(rayWallHit(w, 15, 5, -5, 5)).toBeCloseTo(0.25, 6); // and the east wall from the other side
  });

  it('is clear when the ray passes by or stops short', () => {
    expect(rayWallHit(w, -5, -5, 15, -5)).toBe(Infinity);
    expect(rayWallHit(w, -5, 5, -1, 5)).toBe(Infinity);
    expect(lineOfSight(w, -5, 5, -1, 5)).toBe(true);
    expect(lineOfSight(w, -5, 5, 15, 5)).toBe(false);
  });

  it('has nothing to hit with a zero-length ray', () => {
    expect(rayWallHit(w, 3, 3, 3, 3)).toBe(Infinity);
  });

  it('sees out of a building through its wall too', () => {
    expect(rayWallHit(w, 5, 5, 5, 25)).toBeCloseTo(0.25, 6);
  });

  it('works across many hash cells and on diagonals', () => {
    const far = world({ buildings: [{ outer: sq(60, -3, 4, 6) }] });
    expect(rayWallHit(far, -90, 0, 90, 0)).toBeCloseTo(150 / 180, 6);
    // a diagonal ray to a wall 60 m away
    const hit = rayWallHit(far, 30, -30, 70, 10); // passes x = 60 at y = 0
    expect(hit).toBeCloseTo(0.75, 6);
    expect(lineOfSight(far, -95, 95, 95, -95)).toBe(true);
  });

  it('agrees with checking every wall one by one', () => {
    const rng = createRng(5);
    const buildings = [];
    for (let i = 0; i < 40; i++) {
      buildings.push({
        outer: sq(nextRange(rng, -90, 80), nextRange(rng, -90, 80), 4 + i * 0.2, 5),
      });
    }
    const city = world({ buildings });
    const brute = (x0: number, y0: number, x1: number, y1: number): number => {
      const dx = x1 - x0;
      const dy = y1 - y0;
      let best = Infinity;
      for (let i = 0; i < city.segCount; i++) {
        const ax = city.segments[i * 4];
        const ay = city.segments[i * 4 + 1];
        const ex = city.segments[i * 4 + 2] - ax;
        const ey = city.segments[i * 4 + 3] - ay;
        const denom = dx * ey - dy * ex;
        if (Math.abs(denom) < 1e-12) continue;
        const t = ((ax - x0) * ey - (ay - y0) * ex) / denom;
        const u = ((ax - x0) * dy - (ay - y0) * dx) / denom;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1 && t < best) best = t;
      }
      return best;
    };
    let hits = 0;
    for (let i = 0; i < 600; i++) {
      const x0 = nextRange(rng, -99, 99);
      const y0 = nextRange(rng, -99, 99);
      const x1 = nextRange(rng, -99, 99);
      const y1 = nextRange(rng, -99, 99);
      const got = rayWallHit(city, x0, y0, x1, y1);
      const want = brute(x0, y0, x1, y1);
      if (want === Infinity) expect(got).toBe(Infinity);
      else {
        expect(got).toBeCloseTo(want, 9);
        hits++;
      }
    }
    expect(hits).toBeGreaterThan(50); // the comparison was not vacuous
  });
});

describe('rays against circles', () => {
  it('finds where a ray first touches a circle', () => {
    expect(rayCircleHit(0, 0, 1, 0, 10, 0, 2)).toBeCloseTo(8, 9);
    expect(rayCircleHit(0, 0, 0, 1, 0, 10, 1)).toBeCloseTo(9, 9);
  });

  it('misses a circle beside or behind the ray', () => {
    expect(rayCircleHit(0, 0, 1, 0, 10, 5, 2)).toBe(Infinity);
    expect(rayCircleHit(0, 0, 1, 0, -10, 0, 2)).toBe(Infinity);
  });

  it('counts a start inside the circle as touching at once', () => {
    expect(rayCircleHit(10.5, 0, 1, 0, 10, 0, 2)).toBe(0);
  });

  it('grazes a circle at its edge', () => {
    expect(rayCircleHit(0, 2, 1, 0, 10, 0, 2)).toBeCloseTo(10, 6);
  });
});
