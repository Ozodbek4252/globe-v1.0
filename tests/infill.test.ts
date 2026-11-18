import { describe, expect, it } from 'vitest';
import { INFILL, infillHouses } from '../src/city/infill';
import type { CityBuilding, CityData, CityRoad } from '../src/city/types';

const square = (x0: number, y0: number, x1: number, y1: number): number[] => [
  x0,
  y0,
  x1,
  y0,
  x1,
  y1,
  x0,
  y1,
];

const road = (kind: CityRoad['kind'], points: number[], width: number): CityRoad => ({
  kind,
  points,
  width,
});

const mapped: CityBuilding = {
  id: 77,
  outer: square(40, 6, 52, 18),
  height: 6,
  estimated: false,
  kind: 'house',
};

const city = (over: Partial<CityData> = {}): CityData => ({
  version: 1,
  id: 'test',
  name: 'Test',
  center: [71, 40.5],
  halfSize: 400,
  buildings: [mapped],
  // a lane east-west, a bigger street north-south through it
  roads: [road('residential', [-150, 0, 150, 0], 6), road('tertiary', [0, -300, 0, 300], 8)],
  areas: [{ kind: 'water', outer: square(-150, 5, -100, 40) }],
  waterways: [],
  trees: [],
  towers: [],
  attribution: 'test',
  generated: '2026-11-18',
  ...over,
});

const everywhere = [square(-350, -350, 350, 350)];

const bbox = (b: CityBuilding): [number, number, number, number] => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let i = 0; i < b.outer.length; i += 2) {
    x0 = Math.min(x0, b.outer[i]);
    x1 = Math.max(x1, b.outer[i]);
    y0 = Math.min(y0, b.outer[i + 1]);
    y1 = Math.max(y1, b.outer[i + 1]);
  }
  return [x0, y0, x1, y1];
};
const overlap = (a: CityBuilding, b: CityBuilding): boolean => {
  const [ax0, ay0, ax1, ay1] = bbox(a);
  const [bx0, by0, bx1, by1] = bbox(b);
  return ax0 < bx1 && bx0 < ax1 && ay0 < by1 && by0 < ay1;
};

describe('houses where the map has streets but no buildings', () => {
  const houses = infillHouses(city(), everywhere);

  it('lines both sides of every fronting street, shoulder to shoulder', () => {
    // 300 m of lane and 600 m of street, two sides each, a lot every 12 to 16 m, less the crossing
    // and the few big lots
    expect(houses.length).toBeGreaterThan(85);
    const north = houses.filter(
      (h) => bbox(h)[1] > 0 && bbox(h)[1] < 20 && Math.abs(bbox(h)[0]) < 140,
    );
    const south = houses.filter(
      (h) => bbox(h)[3] < 0 && bbox(h)[3] > -20 && Math.abs(bbox(h)[0]) < 140,
    );
    expect(north.length).toBeGreaterThan(5);
    expect(south.length).toBeGreaterThan(5);
    for (const h of houses) {
      expect(h.estimated).toBe(true);
      expect(h.id).toBeGreaterThanOrEqual(INFILL.firstId);
      expect(h.height).toBeGreaterThanOrEqual(3);
      expect(['house', 'apartments', 'civic']).toContain(h.kind);
      expect(h.outer).toHaveLength(8);
    }
    expect(new Set(houses.map((h) => h.id)).size).toBe(houses.length);
  });

  it('keeps off the roads, the water, the mapped building and each other', () => {
    for (const h of houses) {
      const [x0, y0, x1, y1] = bbox(h);
      const nearestY = Math.min(Math.abs(y0), Math.abs(y1));
      const nearestX = Math.min(Math.abs(x0), Math.abs(x1));
      if (nearestY < 20) {
        // fronting the lane along y = 0 (6 m wide): set back from it, and off the street's 8 m
        expect(nearestY).toBeGreaterThanOrEqual(3 + INFILL.setback - 0.3);
        expect(nearestX).toBeGreaterThanOrEqual(4);
      } else {
        // fronting the street along x = 0
        expect(nearestX).toBeGreaterThanOrEqual(4 + INFILL.setback - 0.3);
      }
      expect(overlap(h, mapped)).toBe(false);
      expect(x1 < -150 || x0 > -100 || y1 < 5 || y0 > 40).toBe(true); // not in the pond
    }
    for (let i = 0; i < houses.length; i++) {
      for (let j = i + 1; j < houses.length; j++) {
        expect(overlap(houses[i], houses[j]), `${i} and ${j}`).toBe(false);
      }
    }
  });

  it('puts a bigger building now and then, big enough to shelter in; flats only on the bigger street', () => {
    const big = houses.filter((h) => h.kind !== 'house');
    expect(big.length).toBeGreaterThan(1);
    for (const h of big) {
      const [x0, y0, x1, y1] = bbox(h);
      expect((x1 - x0) * (y1 - y0)).toBeGreaterThan(400);
      expect(h.height).toBeGreaterThan(6);
      if (h.kind === 'apartments') expect(Math.min(Math.abs(x0), Math.abs(x1))).toBeLessThan(10);
    }
    expect(big.some((h) => h.kind === 'apartments')).toBe(true);
  });

  it('stays inside the residential land, and builds nothing without any', () => {
    const east = infillHouses(city(), [square(20, -350, 350, 350)]);
    expect(east.length).toBeGreaterThan(10);
    for (const h of east) expect(bbox(h)[0]).toBeGreaterThanOrEqual(20);
    expect(infillHouses(city(), [])).toEqual([]);
  });

  it('is the same every time, and leaves the map it was given alone', () => {
    const a = city();
    const before = JSON.stringify(a);
    const again = infillHouses(a, everywhere);
    expect(again).toEqual(houses);
    expect(JSON.stringify(a)).toBe(before);
  });

  it('follows a street that is not on the grid', () => {
    const slanted = infillHouses(
      city({ buildings: [], areas: [], roads: [road('residential', [-200, -100, 200, 100], 6)] }),
      everywhere,
    );
    expect(slanted.length).toBeGreaterThan(40);
    for (const h of slanted) {
      // every corner is at least 3 + setback from the line through the origin with slope 1/2
      for (let i = 0; i < 8; i += 2) {
        const d = Math.abs(h.outer[i + 1] - h.outer[i] / 2) / Math.sqrt(1.25);
        expect(d).toBeGreaterThanOrEqual(3 + INFILL.setback - 0.3);
      }
    }
  });
});
