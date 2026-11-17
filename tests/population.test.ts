import { describe, expect, it } from 'vitest';
import { createRng } from '../src/lib/rng';
import { buildColliders, insideBuilding } from '../src/sim/colliders';
import { createGameWorld } from '../src/sim/game';
import type { PlaceBuilding } from '../src/sim/places';
import {
  batter,
  biteInside,
  createOutbreak,
  indoorCounts,
  POP,
  residentsOf,
  roundSeeded,
  seedOutbreak,
  stepOutbreak,
  takeIn,
  type Outbreak,
} from '../src/sim/population';
import { loadTashkent } from './helpers/tashkent';

const box = (x: number, y: number, w: number, h = w): number[] => [
  x,
  y,
  x + w,
  y,
  x + w,
  y + h,
  x,
  y + h,
];

const block = (id: number, x: number, y: number, w: number, height: number, kind = 'apartments') =>
  ({ id, outer: box(x, y, w), height, kind }) satisfies PlaceBuilding;

/** A map of open ground (half-size 600 m) with the given buildings on it. */
function town(buildings: PlaceBuilding[]) {
  const colliders = buildColliders({
    halfSize: 600,
    buildings: buildings.map((b) => ({ outer: b.outer })),
    areas: [],
    waterways: [],
    roads: [],
  });
  const world = createGameWorld(colliders, [0, 0], buildings);
  return { colliders, world };
}

describe('how many people a building holds', () => {
  it('grows with the floors, and differs by kind', () => {
    const area = 400;
    const flat = residentsOf({ height: 3, kind: 'apartments' }, area);
    const tall = residentsOf({ height: 30, kind: 'apartments' }, area);
    expect(tall).toBeGreaterThan(flat * 8);
    // the same footprint and height: a block of flats is denser than a house, a church emptier than either
    const sameHeight = (kind: string): number => residentsOf({ height: 9, kind }, area);
    expect(sameHeight('apartments')).toBeGreaterThan(sameHeight('house'));
    expect(sameHeight('house')).toBeGreaterThan(sameHeight('religious'));
  });

  it('puts nobody in a shed, a kiosk or a garage', () => {
    expect(residentsOf({ height: 3, kind: 'house' }, 20)).toBe(0);
    expect(residentsOf({ height: 3, kind: 'garage' }, 500)).toBe(0);
    expect(residentsOf({ height: 3, kind: 'other' }, 34)).toBe(0);
  });

  it('rounds stochastically, so small shares are not lost', () => {
    const rng = createRng(2);
    let total = 0;
    for (let i = 0; i < 4000; i++) total += roundSeeded(0.25, rng);
    expect(total).toBeGreaterThan(900);
    expect(total).toBeLessThan(1100);
    expect(roundSeeded(3, rng)).toBe(3);
  });
});

describe('the people of a city', () => {
  const buildings = [
    block(1, 100, 100, 30, 30),
    block(2, 200, 100, 20, 6, 'house'),
    block(3, -100, -100, 20, 3, 'garage'),
    block(4, -300, 200, 40, 12, 'commercial'),
  ];

  it('start indoors, all well, each building with its own door on open ground', () => {
    const { world, colliders } = town(buildings);
    const o = createOutbreak(buildings, world);
    expect(o.count).toBe(4);
    expect(o.healthy[0]).toBeGreaterThan(o.healthy[1]); // the tall block holds more than the house
    expect(o.healthy[2]).toBe(0); // nobody sleeps in a garage
    for (let b = 0; b < o.count; b++) {
      expect(o.incubating[b]).toBe(0);
      expect(o.undead[b]).toBe(0);
      expect(o.open[b]).toBe(0);
      if (o.healthy[b] > 0) {
        expect(Number.isNaN(o.doorX[b])).toBe(false);
        expect(insideBuilding(colliders, o.doorX[b], o.doorY[b])).toBe(false);
        expect(o.doorHp[b]).toBeGreaterThan(0);
      }
    }
    expect(o.initial).toBe(indoorCounts(o).healthy);
  });

  it('can be scaled to a known number of people', () => {
    const { world } = town(buildings);
    const natural = createOutbreak(buildings, world).initial;
    const scaled = createOutbreak(buildings, world, new Set(), 600, natural * 5);
    expect(Math.abs(scaled.initial - natural * 5)).toBeLessThanOrEqual(buildings.length);
    // the shares between buildings stay the same
    const natural0 = createOutbreak(buildings, world).healthy;
    expect(scaled.healthy[0] / scaled.healthy[1]).toBeCloseTo(natural0[0] / natural0[1], 0);
  });

  it('gives bigger buildings stronger doors, up to a limit, and shelters the strongest', () => {
    const { world } = town(buildings);
    const o = createOutbreak(buildings, world, new Set([3]), 600);
    expect(o.doorHp[0]).toBeGreaterThan(o.doorHp[1]);
    expect(o.doorHp[0]).toBeLessThanOrEqual(POP.doorMax);
    expect(o.doorHp[3]).toBe(600);
  });

  it('leaves out a building nobody can get to', () => {
    // a house in a walled courtyard that the survivor can never reach
    const ring = { outer: box(100, 100, 60), holes: [[120, 120, 120, 140, 140, 140, 140, 120]] };
    const inner = block(2, 125, 125, 10, 6, 'house');
    const outerList: PlaceBuilding[] = [block(1, 100, 100, 60, 6, 'house'), inner];
    const colliders = buildColliders({
      halfSize: 600,
      buildings: [ring, { outer: inner.outer }],
      areas: [],
      waterways: [],
      roads: [],
    });
    const world = createGameWorld(colliders, [0, 0], outerList);
    const o = createOutbreak(outerList, world);
    expect(o.healthy[0]).toBeGreaterThan(0);
    expect(o.healthy[1]).toBe(0);
    expect(Number.isNaN(o.doorX[1])).toBe(true);
  });

  it('are the same for the same map', () => {
    const { world } = town(buildings);
    const a = createOutbreak(buildings, world);
    const b = createOutbreak(buildings, world);
    expect(Array.from(a.healthy)).toEqual(Array.from(b.healthy));
    expect(Array.from(a.doorX)).toEqual(Array.from(b.doorX));
  });
});

describe('where it begins', () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    block(i + 1, ((i % 6) - 3) * 160, (Math.floor(i / 6) - 2) * 160, 30, 15),
  );

  it('is a few buildings with people in them, far from the survivor and from each other', () => {
    const { world } = town(many);
    const o = createOutbreak(many, world);
    const before = indoorCounts(o).healthy;
    const chosen = seedOutbreak(o, createRng(5), 3, [0, 0], 300);
    expect(chosen).toHaveLength(3);
    for (const b of chosen) {
      expect(Math.hypot(o.doorX[b], o.doorY[b])).toBeGreaterThanOrEqual(300);
      expect(o.undead[b]).toBe(2);
    }
    for (let i = 0; i < chosen.length; i++) {
      for (let j = i + 1; j < chosen.length; j++) {
        const a = chosen[i];
        const b = chosen[j];
        expect(Math.hypot(o.doorX[a] - o.doorX[b], o.doorY[a] - o.doorY[b])).toBeGreaterThanOrEqual(
          250,
        );
      }
    }
    // the people who turned came out of the same city
    const now = indoorCounts(o);
    expect(now.healthy + now.undead).toBe(before);
  });

  it('is the same for the same seed, and not for another', () => {
    const { world } = town(many);
    const pick = (seed: number): number[] =>
      seedOutbreak(createOutbreak(many, world), createRng(seed), 3, [0, 0], 300);
    expect(pick(1)).toEqual(pick(1));
    expect(pick(1)).not.toEqual(pick(2));
  });

  it('can be left out altogether', () => {
    const { world } = town(many);
    expect(seedOutbreak(createOutbreak(many, world), createRng(1), 0, [0, 0], 300)).toEqual([]);
  });
});

describe('the outbreak inside a building', () => {
  /** One building with the given people in it, and a street that records who comes out. */
  function inside(healthy: number, incubating = 0, undead = 0) {
    const o: Outbreak = {
      count: 1,
      healthy: Int32Array.of(healthy),
      incubating: Int32Array.of(incubating),
      undead: Int32Array.of(undead),
      doorX: Float32Array.of(0),
      doorY: Float32Array.of(0),
      doorHp: Float32Array.of(100),
      open: Uint8Array.of(0),
      initial: healthy + incubating + undead,
      clock: 0,
    };
    const out = { zombies: 0, humans: 0, room: Infinity };
    const rng = createRng(4);
    const second = (): void =>
      stepOutbreak(
        o,
        1,
        rng,
        (_, n) => {
          const placed = Math.min(n, out.room);
          out.zombies += placed;
          return placed;
        },
        (_, n) => {
          const placed = Math.min(n, out.room);
          out.humans += placed;
          return placed;
        },
      );
    const total = (): number =>
      o.healthy[0] + o.incubating[0] + o.undead[0] + out.zombies + out.humans;
    return { o, out, second, total };
  }

  it('does nothing where nobody is sick', () => {
    const { o, second } = inside(40);
    for (let s = 0; s < 120; s++) second();
    expect(o.healthy[0]).toBe(40);
  });

  it('turns the bitten after about the incubation time', () => {
    const { o, out, second } = inside(0, 10);
    for (let s = 0; s < POP.incubation * 0.5; s++) second();
    expect(o.incubating[0]).toBeGreaterThan(0);
    for (let s = 0; s < POP.incubation * 3; s++) second();
    expect(o.incubating[0]).toBe(0);
    expect(o.undead[0] + out.zombies).toBe(10);
  });

  it('spreads from the turned to the well, and nobody is created or lost on the way', () => {
    const { o, out, second, total } = inside(30, 0, 3);
    let last = 30;
    for (let s = 0; s < 90; s++) {
      second();
      expect(total()).toBe(33);
      expect(o.healthy[0]).toBeLessThanOrEqual(last);
      last = o.healthy[0];
    }
    expect(out.zombies).toBeGreaterThan(3); // it spread, and they came out
    expect(out.humans).toBeGreaterThan(0); // and some of the well ran for it
  });

  it('lets the turned out once two of them can, or when nobody is left to bite', () => {
    const one = inside(0, 0, 1); // alone and nobody to bite: comes out
    for (let s = 0; s < 20; s++) one.second();
    expect(one.out.zombies).toBe(1);
    const alone = inside(10, 0, 1); // one turned among the well: stays in, biting
    alone.second();
    expect(alone.out.zombies).toBe(0);
  });

  it('keeps people inside when the street has no room', () => {
    const { o, out, second, total } = inside(10, 0, 6);
    out.room = 0;
    for (let s = 0; s < 40; s++) second();
    expect(out.zombies + out.humans).toBe(0);
    expect(total()).toBe(16);
    expect(o.undead[0] + o.incubating[0]).toBeGreaterThan(6);
  });

  it('is the same every time', () => {
    const run = (): string => {
      const t = inside(25, 2, 2);
      for (let s = 0; s < 60; s++) t.second();
      return [t.o.healthy[0], t.o.incubating[0], t.o.undead[0], t.out.zombies, t.out.humans].join();
    };
    expect(run()).toBe(run());
  });

  it('takes a bite at a time, and takes people in off the street', () => {
    const { o } = inside(2);
    expect(biteInside(o, 0)).toBe(true);
    expect(biteInside(o, 0)).toBe(true);
    expect(biteInside(o, 0)).toBe(false); // nobody well left
    expect(o.incubating[0]).toBe(2);
    takeIn(o, 0);
    expect(o.healthy[0]).toBe(1);
  });

  it('has a door that gives way once, after enough blows', () => {
    const { o } = inside(5);
    expect(batter(o, 0, 60)).toBe(false);
    expect(o.open[0]).toBe(0);
    expect(batter(o, 0, 60)).toBe(true);
    expect(o.open[0]).toBe(1);
    expect(batter(o, 0, 60)).toBe(false); // already open: it has not broken again
    expect(o.doorHp[0]).toBe(0);
  });
});

describe('the people of the real Tashkent district', () => {
  const t = loadTashkent();
  const world = createGameWorld(t.colliders, t.spawn, t.city.buildings);

  it('add up to the real density when asked', () => {
    const km2 = ((t.colliders.half * 2) / 1000) ** 2;
    const target = 7700 * km2;
    const o = createOutbreak(t.city.buildings, world, new Set(), 600, target);
    expect(o.initial).toBeGreaterThan(target * 0.98);
    expect(o.initial).toBeLessThan(target * 1.02);
  });

  it('live behind doors on open ground, and the tall blocks hold the most', () => {
    const o = createOutbreak(t.city.buildings, world);
    let inhabited = 0;
    let biggest = 0;
    let biggestKind = '';
    t.city.buildings.forEach((b, i) => {
      if (o.healthy[i] <= 0) return;
      inhabited++;
      expect(t.insideBuilding(o.doorX[i], o.doorY[i])).toBe(false);
      if (o.healthy[i] > biggest) {
        biggest = o.healthy[i];
        biggestKind = b.kind;
      }
    });
    expect(inhabited).toBeGreaterThan(1500);
    expect(biggest).toBeGreaterThan(80);
    expect(['apartments', 'commercial', 'civic', 'other']).toContain(biggestKind);
  });
});

describe('the outbreak at night', () => {
  it('spreads faster: the dead bite more often in the dark', () => {
    const wellAfter = (night: number): number => {
      const o: Outbreak = {
        count: 1,
        healthy: Int32Array.of(60),
        incubating: Int32Array.of(0),
        undead: Int32Array.of(3),
        doorX: Float32Array.of(0),
        doorY: Float32Array.of(0),
        doorHp: Float32Array.of(100),
        open: Uint8Array.of(0),
        initial: 63,
        clock: 0,
      };
      const rng = createRng(9);
      // nobody leaves the building and nobody comes out, so the bites are all there is to count
      for (let s = 0; s < 12; s++)
        stepOutbreak(
          o,
          1,
          rng,
          () => 0,
          () => 0,
          night,
        );
      return o.healthy[0];
    };
    expect(wellAfter(1)).toBeLessThan(wellAfter(0));
    expect(POP.night).toBeGreaterThan(0);
  });

  it('is the same by day as it was before there was a night', () => {
    const run = (night?: number): string => {
      const o: Outbreak = {
        count: 1,
        healthy: Int32Array.of(30),
        incubating: Int32Array.of(2),
        undead: Int32Array.of(2),
        doorX: Float32Array.of(0),
        doorY: Float32Array.of(0),
        doorHp: Float32Array.of(100),
        open: Uint8Array.of(0),
        initial: 34,
        clock: 0,
      };
      const rng = createRng(3);
      for (let s = 0; s < 40; s++) {
        if (night === undefined)
          stepOutbreak(
            o,
            1,
            rng,
            (_, n) => n,
            (_, n) => n,
          );
        else
          stepOutbreak(
            o,
            1,
            rng,
            (_, n) => n,
            (_, n) => n,
            night,
          );
      }
      return [o.healthy[0], o.incubating[0], o.undead[0]].join();
    };
    expect(run(0)).toBe(run());
  });
});
