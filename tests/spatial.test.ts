import { describe, expect, it } from 'vitest';
import { createRng, nextRange } from '../src/lib/rng';
import { createPointIndex, forEachNear, rebuildIndex } from '../src/sim/spatial';

describe('the point index', () => {
  const random = (n: number, half: number, seed: number) => {
    const rng = createRng(seed);
    const xs = new Float32Array(n);
    const ys = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      xs[i] = nextRange(rng, -half, half);
      ys[i] = nextRange(rng, -half, half);
    }
    return { xs, ys };
  };
  const near = (
    ix: ReturnType<typeof createPointIndex>,
    xs: Float32Array,
    ys: Float32Array,
    x: number,
    y: number,
    r: number,
  ): number[] => {
    const found: number[] = [];
    forEachNear(ix, x, y, r, xs, ys, (i) => found.push(i));
    return found.sort((a, b) => a - b);
  };

  it('finds exactly the points within the radius, the same as looking at every one', () => {
    const half = 500;
    const { xs, ys } = random(2000, half, 3);
    const ix = createPointIndex(half, 10, 2000);
    rebuildIndex(ix, 2000, xs, ys, () => true);
    const rng = createRng(8);
    for (let q = 0; q < 60; q++) {
      const x = nextRange(rng, -half, half);
      const y = nextRange(rng, -half, half);
      const r = nextRange(rng, 1, 60);
      const expected: number[] = [];
      for (let i = 0; i < 2000; i++)
        if ((xs[i] - x) ** 2 + (ys[i] - y) ** 2 <= r * r) expected.push(i);
      expect(near(ix, xs, ys, x, y, r)).toEqual(expected);
    }
  });

  it('reports the squared distance, and leaves out points that do not take part', () => {
    const xs = Float32Array.from([0, 3, 6, 100]);
    const ys = Float32Array.from([0, 4, 0, 0]);
    const ix = createPointIndex(200, 10, 4);
    rebuildIndex(ix, 4, xs, ys, (i) => i !== 2);
    const seen = new Map<number, number>();
    forEachNear(ix, 0, 0, 20, xs, ys, (i, d2) => seen.set(i, d2));
    expect([...seen.keys()].sort()).toEqual([0, 1]);
    expect(seen.get(1)).toBe(25);
  });

  it('forgets everything when it is rebuilt', () => {
    const xs = new Float32Array([5, 5]);
    const ys = new Float32Array([5, 5]);
    const ix = createPointIndex(100, 10, 2);
    rebuildIndex(ix, 2, xs, ys, () => true);
    expect(near(ix, xs, ys, 5, 5, 2)).toEqual([0, 1]);
    xs[0] = 80;
    rebuildIndex(ix, 2, xs, ys, () => true);
    expect(near(ix, xs, ys, 5, 5, 2)).toEqual([1]);
    expect(near(ix, xs, ys, 80, 5, 2)).toEqual([0]);
  });

  it('copes with points off the map and searches that run off its edge', () => {
    const xs = Float32Array.from([-5000, 95, 0]);
    const ys = Float32Array.from([0, 95, 5000]);
    const ix = createPointIndex(100, 10, 3);
    rebuildIndex(ix, 3, xs, ys, () => true);
    expect(near(ix, xs, ys, 100, 100, 50)).toEqual([1]);
    expect(near(ix, xs, ys, 5000, 5000, 10)).toEqual([]);
  });
});
