import { describe, expect, it } from 'vitest';
import {
  buildColliders,
  clearance,
  findSpawn,
  inWater,
  insideBuilding,
  moveCircle,
  resolveCircle,
  type ColliderSource,
} from '../src/sim/colliders';

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

const world = (
  extra: Partial<ColliderSource> = {},
  obstacles: Parameters<typeof buildColliders>[1] = [],
) =>
  buildColliders(
    {
      halfSize: 100,
      buildings: [{ outer: sq(0, 0, 10) }],
      areas: [],
      waterways: [],
      roads: [],
      ...extra,
    },
    obstacles,
  );

describe('walls', () => {
  const w = world();

  it('keeps a person a body-radius away from a wall', () => {
    const [x, y] = resolveCircle(w, 5, -0.1, 0.4); // pressed against the south wall from just outside
    expect(x).toBeCloseTo(5, 6);
    expect(y).toBeCloseTo(-0.4, 6);
  });

  it('stops walking into a wall', () => {
    let x = 5;
    let y = -3;
    for (let i = 0; i < 100; i++) [x, y] = moveCircle(w, x, y, x, y + 0.05, 0.4);
    expect(y).toBeCloseTo(-0.4, 6);
    expect(x).toBeCloseTo(5, 6);
  });

  it('slides along a wall when walking at it at an angle', () => {
    let x = 2;
    let y = -3;
    for (let i = 0; i < 120; i++) [x, y] = moveCircle(w, x, y, x + 0.05, y + 0.05, 0.4);
    expect(y).toBeLessThanOrEqual(-0.4 + 1e-6); // never inside
    expect(x).toBeGreaterThan(2 + 3); // kept moving along the wall
  });

  it('slides smoothly along a diagonal wall too', () => {
    const diamond = [0, -10, 10, 0, 0, 10, -10, 0]; // a diamond: its walls are at 45 degrees
    const d = world({ buildings: [{ outer: diamond }] });
    // distance from a point to the diamond's outline: the nearest of its four sides
    const edges = [
      [0, -10, 10, 0],
      [10, 0, 0, 10],
      [0, 10, -10, 0],
      [-10, 0, 0, -10],
    ] as const;
    const distanceToDiamond = (px: number, py: number): number =>
      Math.min(
        ...edges.map(([x0, y0, x1, y1]) => {
          const t = Math.max(
            0,
            Math.min(
              1,
              ((px - x0) * (x1 - x0) + (py - y0) * (y1 - y0)) / ((x1 - x0) ** 2 + (y1 - y0) ** 2),
            ),
          );
          return Math.hypot(px - (x0 + (x1 - x0) * t), py - (y0 + (y1 - y0) * t));
        }),
      );
    // walk west into the north-east face (not the exact tip, where a head-on push has no sideways to go)
    let x = 20;
    let y = 3;
    for (let i = 0; i < 400; i++) {
      [x, y] = moveCircle(d, x, y, x - 0.05, y, 0.4);
      expect(distanceToDiamond(x, y)).toBeGreaterThanOrEqual(0.4 - 1e-6); // never closer than the body radius
    }
    expect(y).toBeGreaterThan(6); // slid up the face rather than stopping dead
  });

  it('goes around a corner without catching', () => {
    let x = -3;
    let y = 5;
    for (let i = 0; i < 400; i++) [x, y] = moveCircle(w, x, y, x + 0.04, y - 0.04, 0.4);
    expect(y).toBeLessThan(0); // came out the far side
  });

  it('cannot tunnel through a wall at sprint speed', () => {
    const dt = 1 / 60;
    let x = 5;
    let y = -30;
    for (let i = 0; i < 1200; i++) [x, y] = moveCircle(w, x, y, x, y + 6.2 * dt, 0.4);
    expect(y).toBeCloseTo(-0.4, 4);
  });

  it('keeps courtyard walls solid from inside, too', () => {
    const ring = world({
      buildings: [{ outer: sq(0, 0, 40), holes: [[15, 15, 15, 25, 25, 25, 25, 15]] }],
    });
    let [x, y] = [20, 20]; // inside the courtyard hole
    for (let i = 0; i < 200; i++) [x, y] = moveCircle(ring, x, y, x + 0.1, y, 0.4);
    expect(x).toBeLessThanOrEqual(25 - 0.4 + 1e-6);
  });
});

describe('round obstacles', () => {
  it('stops at a tree trunk and slides round it', () => {
    const trees = { data: [20, 0], stride: 2, count: 1, radius: 0.35 };
    const t = world({ buildings: [] }, [trees]);
    let x = 10;
    let y = 0.01;
    for (let i = 0; i < 400; i++) [x, y] = moveCircle(t, x, y, x + 0.05, y, 0.4);
    expect(x).toBeGreaterThan(20 + 0.5); // got past it
    expect(Math.hypot(x - 20, y)).toBeGreaterThanOrEqual(0.75 - 1e-3);
  });

  it('reads trees from interleaved data with a stride', () => {
    const lamps = { data: [5, 5, 6.2, 30, 30, 6.2], stride: 3, count: 2, radius: 0.15 };
    const t = world({ buildings: [] }, [lamps]);
    expect(resolveCircle(t, 5.1, 5, 0.4)[0]).toBeGreaterThan(5.4);
    expect(resolveCircle(t, 30.1, 30, 0.4)[0]).toBeGreaterThan(30.4);
  });
});

describe('water and bridges', () => {
  const lake = { kind: 'water', outer: sq(20, -20, 40, 40) };

  it('stops at the water edge', () => {
    const l = world({ buildings: [], areas: [lake] });
    let x = 10;
    let y = 0;
    for (let i = 0; i < 300; i++) [x, y] = moveCircle(l, x, y, x + 0.1, y, 0.4);
    expect(x).toBeLessThan(20);
    expect(x).toBeGreaterThan(19);
    expect(inWater(l, x, y, 0.4)).toBe(false);
  });

  it('slides along the shore', () => {
    const l = world({ buildings: [], areas: [lake] });
    let x = 10;
    let y = -10;
    for (let i = 0; i < 300; i++) [x, y] = moveCircle(l, x, y, x + 0.1, y + 0.1, 0.4);
    expect(x).toBeLessThan(20);
    expect(y).toBeGreaterThan(5); // kept going north along the bank
  });

  it('lets you cross on a bridge', () => {
    const l = world({
      buildings: [],
      areas: [lake],
      roads: [{ points: [0, 0, 80, 0], width: 6, bridge: true }],
    });
    let x = 10;
    let y = 0;
    for (let i = 0; i < 900; i++) [x, y] = moveCircle(l, x, y, x + 0.1, y, 0.4);
    expect(x).toBeGreaterThan(65); // all the way across
  });

  it('lets someone who is already in the water wade out', () => {
    const l = world({ buildings: [], areas: [lake] });
    let x = 30;
    let y = 0;
    for (let i = 0; i < 200; i++) [x, y] = moveCircle(l, x, y, x - 0.1, y, 0.4);
    expect(x).toBeLessThan(20);
  });

  it('treats thin waterways as water too', () => {
    const c = world({ buildings: [], waterways: [{ points: [20, -50, 20, 50], width: 6 }] });
    let x = 5;
    for (let i = 0; i < 300; i++) [x] = moveCircle(c, x, 0, x + 0.1, 0, 0.4);
    expect(x).toBeLessThan(17);
  });
});

describe('the edge of the map', () => {
  it('cannot walk off the play area', () => {
    const e = world({ buildings: [] });
    let x = 90;
    let y = 0;
    for (let i = 0; i < 400; i++) [x, y] = moveCircle(e, x, y, x + 0.1, y, 0.4);
    expect(x).toBeCloseTo(100 - 0.4, 6);
  });
});

describe('clearance and spawning', () => {
  const w = world();

  it('measures the distance to the nearest wall', () => {
    expect(clearance(w, 5, -3)).toBeCloseTo(3, 6);
    expect(clearance(w, 50, 50, 8)).toBe(8); // nothing near: capped at the search radius
  });

  it('knows when a point is inside a building, even far from its walls', () => {
    const big = world({ buildings: [{ outer: sq(0, 0, 60) }] });
    expect(clearance(big, 30, 30, 8)).toBe(8); // the middle of a big building is far from every wall...
    expect(insideBuilding(big, 30, 30)).toBe(true); // ...but is still inside
    expect(insideBuilding(big, 70, 30)).toBe(false);
  });

  it('never spawns inside a big building', () => {
    const big = world({ buildings: [{ outer: sq(0, 0, 60) }] });
    const [x, y] = findSpawn(big, [30, 30]);
    expect(insideBuilding(big, x, y)).toBe(false);
  });

  it('keeps a spot that is already fine', () => {
    expect(findSpawn(w, [40, 40])).toEqual([40, 40]);
  });

  it('moves a spawn point out of a building into open ground', () => {
    const [x, y] = findSpawn(w, [5, 5]);
    expect(clearance(w, x, y)).toBeGreaterThanOrEqual(3);
    expect(Math.hypot(x - 5, y - 5)).toBeLessThan(25);
  });

  it('will not spawn in water', () => {
    const l = world({ buildings: [], areas: [{ kind: 'water', outer: sq(-30, -30, 60) }] });
    const [x, y] = findSpawn(l, [0, 0]);
    expect(inWater(l, x, y, 3)).toBe(false);
  });
});
