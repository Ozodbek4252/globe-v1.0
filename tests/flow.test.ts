import { describe, expect, it } from 'vitest';
import {
  buildColliders,
  insideBuilding,
  moveCircle,
  type ColliderSource,
} from '../src/sim/colliders';
import {
  buildNavGrid,
  createFlowField,
  flowStep,
  navCell,
  reachableFrom,
  updateFlow,
} from '../src/sim/flow';

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
    buildings: [],
    areas: [],
    waterways: [],
    roads: [],
    ...extra,
  });

const openAt = (nav: ReturnType<typeof buildNavGrid>, x: number, y: number): number =>
  nav.open[navCell(nav, y) * nav.size + navCell(nav, x)];

describe('walkability grid', () => {
  it('blocks buildings and open water, keeps ground and bridges walkable', () => {
    const c = world({
      buildings: [{ outer: sq(10, 10, 8) }],
      waterways: [{ points: [-60, 0, 60, 0], width: 10 }],
      roads: [{ points: [20, -10, 20, 10], width: 6, bridge: true }],
    });
    const nav = buildNavGrid(c);
    expect(nav.size).toBe(100);
    expect(openAt(nav, 14, 14)).toBe(0); // inside the building
    expect(openAt(nav, 14, 30)).toBe(1); // open ground
    expect(openAt(nav, -30, 0)).toBe(0); // in the river
    expect(openAt(nav, 20, 0)).toBe(1); // on the bridge
  });
});

describe('what can be reached', () => {
  it('leaves out a walled-in courtyard', () => {
    const ring = { outer: sq(-20, -20, 40), holes: [sq(-10, -10, 20).reverse()] };
    const nav = buildNavGrid(world({ buildings: [ring] }));
    const seen = reachableFrom(nav, 60, 60);
    const at = (x: number, y: number): number => seen[navCell(nav, y) * nav.size + navCell(nav, x)];
    expect(at(60, 60)).toBe(1);
    expect(at(-40, 0)).toBe(1);
    expect(at(0, 0)).toBe(0); // inside the courtyard, which nothing outside can enter
  });

  it('starts from the nearest open cell when the point is inside a wall', () => {
    const nav = buildNavGrid(world({ buildings: [{ outer: sq(-3, -3, 6) }] }));
    const seen = reachableFrom(nav, 0, 0);
    expect(seen[navCell(nav, 40) * nav.size + navCell(nav, 40)]).toBe(1);
  });

  it('returns nothing for a point outside the map', () => {
    const nav = buildNavGrid(world());
    expect(reachableFrom(nav, 1000, 1000).every((v) => v === 0)).toBe(true);
  });
});

describe('flow field', () => {
  const wall = { outer: sq(-1, -30, 2, 60) }; // a long wall across the middle
  const c = world({ buildings: [wall] });
  const nav = buildNavGrid(c);

  it('points toward the target when nothing is in the way', () => {
    const f = createFlowField(nav);
    updateFlow(f, 41, 1); // a cell centre
    const dir = flowStep(f, 11, 1); // also a cell centre, on the same row
    expect(dir).not.toBeNull();
    expect(dir![0]).toBeCloseTo(1, 6);
    expect(Math.abs(dir![1])).toBeLessThan(1e-6);
    const diagonal = flowStep(f, 11, 31); // 30 m across and 30 m down: straight along the diagonal
    expect(diagonal![0]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(diagonal![1]).toBeCloseTo(-Math.SQRT1_2, 6);
  });

  it('walks close to a straight line across open ground, not an L', () => {
    const f = createFlowField(nav);
    updateFlow(f, 41, 21);
    let x = 11;
    let y = 1;
    let worst = 0;
    let steps = 0;
    for (; steps < 120; steps++) {
      const dir = flowStep(f, x, y);
      if (!dir) break; // inside the target's cell: the walker takes over
      x += dir[0] * 0.5;
      y += dir[1] * 0.5;
      // distance from the straight line (11, 1) to (41, 21)
      worst = Math.max(worst, Math.abs((x - 11) * 20 - (y - 1) * 30) / Math.hypot(20, 30));
    }
    expect(Math.hypot(x - 41, y - 21)).toBeLessThanOrEqual(2);
    expect(worst).toBeLessThan(4.5); // eight directions cannot be exact; an L-shaped path would be ~8 m off
    expect(steps * 0.5).toBeLessThan(40); // the straight distance is 36 m, the 8-direction best 38.3 m
  });

  it('gets someone out of a blocked cell next to a wall', () => {
    const f = createFlowField(nav);
    updateFlow(f, -20, 0);
    // pressed against the wall's east face: inside the blocked margin of the grid
    expect(flowStep(f, 1.3, 0)).not.toBeNull();
  });

  it('leads around a wall instead of into it', () => {
    const f = createFlowField(nav);
    updateFlow(f, 10, 0);
    let x = -10;
    let y = 0;
    let steps = 0;
    for (; steps < 600; steps++) {
      const dir = flowStep(f, x, y);
      if (!dir) break; // inside the target's cell
      [x, y] = moveCircle(c, x, y, x + dir[0] * 0.5, y + dir[1] * 0.5, 0.34);
      expect(insideBuilding(c, x, y)).toBe(false);
    }
    expect(steps).toBeLessThan(600);
    expect(Math.hypot(x - 10, y)).toBeLessThanOrEqual(2.5);
    expect(steps).toBeGreaterThan(100); // a real detour past the wall's end, not a straight line
  });

  it('gives no direction to a point that cannot reach the target', () => {
    const ring = { outer: sq(-20, -20, 40), holes: [sq(-10, -10, 20).reverse()] };
    const closed = buildNavGrid(world({ buildings: [ring] }));
    const f = createFlowField(closed);
    updateFlow(f, 0, 0); // the target is in the courtyard
    expect(flowStep(f, 40, 40)).toBeNull();
    expect(flowStep(f, 5, 5)).not.toBeNull();
  });

  it('gives no direction outside the window, on the target, or before it is updated', () => {
    const f = createFlowField(nav, 10); // a small window: 21 cells, about 42 m across
    expect(flowStep(f, 0, 0)).toBeNull(); // not yet updated
    updateFlow(f, 0, 50);
    expect(flowStep(f, 80, 50)).toBeNull(); // far outside the window
    expect(flowStep(f, 0.2, 50.2)).toBeNull(); // already there
    expect(flowStep(f, 15, 50)).not.toBeNull();
  });

  it('recovers when the target is moved', () => {
    const f = createFlowField(nav);
    updateFlow(f, 30, 0);
    const a = [...flowStep(f, 10, 45)!]; // above the wall's north end, with a clear way either side
    updateFlow(f, -30, 0);
    const b = flowStep(f, 10, 45);
    expect(a[0]).toBeGreaterThan(0);
    expect(b![0]).toBeLessThan(0);
  });

  it('is invalid when the target is off the map or fully walled in', () => {
    const f = createFlowField(nav);
    updateFlow(f, 5000, 5000);
    expect(f.valid).toBe(false);
  });

  it('moves a target that stands inside a building to the nearest open ground', () => {
    const f = createFlowField(nav);
    updateFlow(f, 0, 0); // on top of the wall
    expect(f.valid).toBe(true);
    expect(flowStep(f, 20, 0)).not.toBeNull();
  });
});
