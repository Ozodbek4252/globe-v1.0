import { describe, expect, it } from 'vitest';
import { buildOccupancy } from '../src/city/occupancy';
import { createShamblers, createWalkers, LIFE, parkInTile } from '../src/city/sceneryLife';
import type { CityData } from '../src/city/types';
import { OCC_BUILDING, occupancyAt } from '../src/sim/grid';
import { HState } from '../src/sim/humans';
import { box } from './helpers/town';

/** Two streets crossing, 8 m wide, and a few houses beside them. */
const ROADS = [
  { kind: 'residential' as const, points: [-400, 0, 400, 0], width: 8 },
  { kind: 'residential' as const, points: [0, -400, 0, 400], width: 8 },
];
const CITY: CityData = {
  version: 1,
  id: 'test',
  name: 'Test',
  center: [0, 0],
  halfSize: 500,
  buildings: [
    { id: 1, outer: box(30, 20, 30), height: 6, kind: 'house', estimated: false },
    { id: 2, outer: box(-80, 20, 30), height: 6, kind: 'house', estimated: false },
    { id: 3, outer: box(30, -60, 30), height: 6, kind: 'house', estimated: false },
  ],
  roads: ROADS,
  areas: [],
  waterways: [],
  trees: [],
  towers: [],
  attribution: '',
  generated: '',
};

/** How far a point is from the nearest street's centre line. */
function offStreet(x: number, y: number): number {
  return Math.min(Math.abs(y), Math.abs(x));
}

describe('people in the tiles beyond the window', () => {
  it('walk their streets up and down on the pavement, pause now and then, and are the same for a seed', () => {
    const w = createWalkers(ROADS, 7);
    expect(w.count).toBe(Math.round(1.6 * LIFE.walkersPerKm));
    w.step(0, 1);
    const h = w.humans;
    expect(h.used).toBe(w.count);
    const beforeX = Float32Array.from(h.x);
    const beforeY = Float32Array.from(h.y);
    for (let k = 0; k < 60 * 20; k++) w.step(1 / 60, 1);
    let moved = 0;
    for (let i = 0; i < w.count; i++) {
      expect(h.state[i]).toBe(HState.WALK);
      expect(Math.abs(h.x[i])).toBeLessThanOrEqual(400.5);
      expect(Math.abs(h.y[i])).toBeLessThanOrEqual(400.5);
      const off = offStreet(h.x[i], h.y[i]);
      expect(off).toBeGreaterThan(2); // not in the middle of the road
      expect(off).toBeLessThan(4.5); // and not off it
      if (Math.hypot(h.x[i] - beforeX[i], h.y[i] - beforeY[i]) > 1) moved++;
    }
    expect(moved).toBeGreaterThan(w.count * 0.5);
    const again = createWalkers(ROADS, 7);
    for (let k = 0; k < 60 * 20; k++) again.step(1 / 60, 1);
    expect(Array.from(again.humans.x)).toEqual(Array.from(h.x));
  });

  it('go in as the share falls, without anyone being lost', () => {
    const w = createWalkers(ROADS, 7);
    w.step(1 / 60, 0.5);
    expect(w.humans.used).toBe(Math.round(w.count * 0.5));
    w.step(1 / 60, 0);
    expect(w.humans.used).toBe(0);
    w.step(1 / 60, 1);
    expect(w.humans.used).toBe(w.count);
  });
});

describe('the turned roaming a tile beyond the window', () => {
  it('stand about their doors by the ledger counts, drift but never far, and are left alone while nothing changes', () => {
    const s = createShamblers(3, 20);
    s.set([
      { x: 100, y: 100, count: 30 },
      { x: -200, y: 50, count: 10 },
    ]);
    const horde = s.horde;
    expect(horde.alive).toBe(20);
    for (let k = 0; k < 60 * 30; k++) s.step(1 / 60);
    for (let i = 0; i < horde.used; i++) {
      const dA = Math.hypot(horde.x[i] - 100, horde.y[i] - 100);
      const dB = Math.hypot(horde.x[i] + 200, horde.y[i] - 50);
      expect(Math.min(dA, dB)).toBeLessThan(LIFE.shambleRadius + 1);
    }
    s.set([
      { x: 100, y: 100, count: 30 },
      { x: -200, y: 50, count: 10 },
    ]);
    expect(s.horde).toBe(horde); // the same doors: nobody jumps
    s.set([{ x: 0, y: 0, count: 2 }]);
    expect(s.horde).not.toBe(horde);
    expect(s.horde.alive).toBe(2);
    s.set([]);
    expect(s.horde.alive).toBe(0);
  });
});

describe('cars in a tile beyond the window', () => {
  it('stand at the kerbs and never in a house', () => {
    const grid = buildOccupancy(CITY, 2);
    const cars = parkInTile(ROADS, 500, grid, 5, 200);
    expect(cars.length).toBeGreaterThan(40);
    for (const c of cars) {
      expect(offStreet(c.x, c.y)).toBeLessThan(4);
      expect(occupancyAt(grid, c.x, c.y) & OCC_BUILDING).toBe(0);
    }
    expect(parkInTile(ROADS, 500, grid, 5, 200)).toEqual(cars);
  });
});
