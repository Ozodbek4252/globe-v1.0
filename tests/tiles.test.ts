import { describe, expect, it } from 'vitest';
import { convertOverpass, type OverpassElement } from '../src/city/osm';
import {
  mergeTiles,
  parseTileIndex,
  sceneryTiles,
  tileAt,
  tileBounds,
  windowHalf,
  windowTiles,
  type TileIndex,
} from '../src/city/tiles';
import type { CityData } from '../src/city/types';

const index: TileIndex = {
  version: 1,
  id: 'test',
  name: 'Test',
  center: [69.28, 41.35],
  tileSize: 1000,
  generated: '2026-11-17',
  attribution: 'test',
  tiles: [],
};

/** A tile with one square building at (bx, by) in its own coordinates, and a road along its bottom. */
const tile = (tx: number, ty: number, bx = 0, by = 0): CityData => ({
  version: 1,
  id: 'test',
  name: 'Test',
  center: index.center,
  halfSize: 500,
  origin: [tx * 1000, ty * 1000],
  buildings: [
    {
      id: tx * 100 + ty,
      outer: [bx, by, bx + 10, by, bx + 10, by + 10, bx, by + 10],
      height: 6,
      estimated: true,
      kind: 'house',
    },
  ],
  roads: [{ kind: 'residential', points: [-500, -490, 500, -490], width: 7 }],
  areas: [],
  waterways: [],
  trees: [bx + 20, by + 20],
  towers: [],
  attribution: 'test',
  generated: '2026-11-17',
});

describe('which tile', () => {
  it('is the square a point falls in, each centred on a multiple of the tile size', () => {
    expect(tileAt(index, 0, 0)).toEqual([0, 0]);
    expect(tileAt(index, 499, -499)).toEqual([0, 0]);
    expect(tileAt(index, 501, 0)).toEqual([1, 0]);
    expect(tileAt(index, -1501, 2400)).toEqual([-2, 2]);
    expect(tileAt(index, -1500, 0)).toEqual([-1, 0]); // the edge belongs to the tile on its right
  });

  it('a window is the square of tiles round one, and its half-size follows', () => {
    expect(windowTiles(0, 0, 0)).toEqual([[0, 0]]);
    expect(windowTiles(2, -1, 1)).toHaveLength(9);
    expect(windowTiles(2, -1, 1)[0]).toEqual([1, -2]);
    expect(windowTiles(2, -1, 1)[8]).toEqual([3, 0]);
    expect(windowHalf(index, 1)).toBe(1500);
    expect(windowHalf(index, 2)).toBe(2500);
  });

  it('scenery is the square round the camera less the window', () => {
    // looking at the window's own centre tile, or any tile of it: only what lies beyond its edge
    expect(sceneryTiles([0, 0], [0, 0])).toEqual([]);
    expect(sceneryTiles([1, 0], [0, 0])).toEqual([
      [2, -1],
      [2, 0],
      [2, 1],
    ]);
    expect(sceneryTiles([1, 1], [0, 0])).toHaveLength(5);
    // two tiles out: the camera's square shares a column with the window
    expect(sceneryTiles([2, 0], [0, 0])).toHaveLength(6);
    // far away: the whole square
    expect(sceneryTiles([5, -5], [0, 0])).toHaveLength(9);
    expect(sceneryTiles([5, -5], [0, 0])).toEqual(windowTiles(5, -5, 1));
  });

  it('a city reaches to the outer edges of its outermost tiles', () => {
    expect(tileBounds(index)).toBeNull();
    const entry = (tx: number, ty: number) => ({
      tx,
      ty,
      file: '',
      buildings: 0,
      roads: 0,
      areas: 0,
      bytes: 0,
    });
    const some = { ...index, tiles: [entry(-2, 0), entry(1, 3), entry(0, 0)] };
    expect(tileBounds(some)).toEqual({ minX: -2500, maxX: 1500, minY: -500, maxY: 3500 });
  });
});

describe('putting tiles together', () => {
  it('moves each tile to its place in the window, with the window centre as the origin', () => {
    const merged = mergeTiles(index, [tile(0, 0), tile(1, 0), tile(0, 1, 100, 100)], [0, 0], 1);
    expect(merged.halfSize).toBe(1500);
    expect(merged.origin).toEqual([0, 0]);
    expect(merged.buildings).toHaveLength(3);
    expect(merged.buildings[1].outer.slice(0, 2)).toEqual([1000, 0]);
    expect(merged.buildings[2].outer.slice(0, 2)).toEqual([100, 1100]);
    expect(merged.roads[1].points).toEqual([500, -490, 1500, -490]);
    expect(merged.trees).toEqual([20, 20, 1020, 20, 120, 1120]);
  });

  it('is relative to the window centre, so a window away from the city centre still has its origin at 0', () => {
    const merged = mergeTiles(index, [tile(5, 5), tile(6, 5)], [5000, 5000], 1);
    expect(merged.origin).toEqual([5000, 5000]);
    expect(merged.buildings[0].outer.slice(0, 2)).toEqual([0, 0]);
    expect(merged.buildings[1].outer.slice(0, 2)).toEqual([1000, 0]);
  });

  it('adds nothing for missing tiles and keeps everything inside the window', () => {
    const merged = mergeTiles(index, [tile(-1, -1), tile(1, 1)], [0, 0], 1);
    for (const b of merged.buildings) {
      for (let i = 0; i < b.outer.length; i += 2) {
        expect(Math.abs(b.outer[i])).toBeLessThanOrEqual(1500);
        expect(Math.abs(b.outer[i + 1])).toBeLessThanOrEqual(1500);
      }
    }
  });
});

describe('the index', () => {
  it('reads a good one and drops entries that make no sense', () => {
    const parsed = parseTileIndex({
      ...index,
      tiles: [
        { tx: 0, ty: 0, file: 't_0_0.json.gz', buildings: 5, roads: 2, areas: 1, bytes: 100 },
        { tx: 0.5, ty: 0, file: 'x' },
        { tx: 1, ty: 1 },
        'junk',
      ],
    });
    expect(parsed?.tiles).toHaveLength(1);
    expect(parsed?.tileSize).toBe(1000);
  });

  it('is null for anything else', () => {
    expect(parseTileIndex(null)).toBeNull();
    expect(parseTileIndex({ version: 2 })).toBeNull();
    expect(parseTileIndex({ ...index, center: [1] })).toBeNull();
  });
});

describe('a tile cut by the converter', () => {
  it('is centred on its own origin, and two neighbours line up exactly', () => {
    // one building straddling the border between tile (0, 0) and tile (1, 0), at x = 500 m
    const project = (x: number, y: number) => ({
      lon: 69.28 + x / 83350, // roughly a degree of longitude at 41 N
      lat: 41.35 + y / 111000,
    });
    const way: OverpassElement = {
      type: 'way',
      id: 7,
      tags: { building: 'yes' },
      geometry: [
        project(480, 0),
        project(520, 0),
        project(520, 20),
        project(480, 20),
        project(480, 0),
      ],
    };
    const options = {
      id: 't',
      name: 'T',
      center: [69.28, 41.35] as [number, number],
      halfSize: 500,
      generated: '',
    };
    const left = convertOverpass({ elements: [way] }, { ...options, origin: [0, 0] });
    const right = convertOverpass({ elements: [way] }, { ...options, origin: [1000, 0] });
    // its centroid is on the border: exactly one of the two tiles owns it
    expect(left.buildings.length + right.buildings.length).toBe(1);
    const owner = left.buildings.length ? left : right;
    expect(owner.origin).toEqual(left.buildings.length ? [0, 0] : [1000, 0]);
    // and put back into the city, its corner is where it was
    const merged = mergeTiles(index, [left, right], [0, 0], 1);
    const xs = merged.buildings[0].outer.filter((_, i) => i % 2 === 0);
    // (the test projects with a rough scale, so the place is within a couple of metres; the width is exact)
    expect(Math.abs(Math.min(...xs) - 480)).toBeLessThan(3);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(40, 0);
  });
});
