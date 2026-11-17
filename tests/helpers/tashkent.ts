// A real city from public/cities as the tests see it: collision world (with trees and lamp posts) and an
// independent "is this point inside a building?" check that does not use the game's own grids, so a
// bug in those cannot hide itself. Each is built once and shared.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { LAMP_STRIDE, placeLamps } from '../../src/city/lamps';
import { buildOccupancy } from '../../src/city/occupancy';
import { TREE_STRIDE, placeTrees } from '../../src/city/trees';
import { mergeTiles, parseTileIndex, tileKey, windowTiles } from '../../src/city/tiles';
import type { CityData } from '../../src/city/types';
import { buildColliders, findSpawn, type Colliders } from '../../src/sim/colliders';
import { pointInFlatRing } from '../../src/sim/grid';

export interface TestCity {
  city: CityData;
  colliders: Colliders;
  /** The open ground nearest the tallest tower, or the centre of the map. */
  spawn: [number, number];
  insideBuilding: (x: number, y: number) => boolean;
}

const cache = new Map<string, TestCity>();

export const loadTashkent = (): TestCity => loadCityById('tashkent');

/** A tiled city's window of 3 by 3 tiles around its origin, read straight from the files. */
function readTiledWindow(id: string): CityData {
  const index = parseTileIndex(
    JSON.parse(readFileSync(resolve(`public/cities/${id}/index.json`), 'utf8')) as unknown,
  );
  if (!index) throw new Error(`${id}: bad tile index`);
  const have = new Map(index.tiles.map((t) => [tileKey(t.tx, t.ty), t]));
  const tiles = windowTiles(0, 0, 1)
    .map(([tx, ty]) => have.get(tileKey(tx, ty)))
    .filter((t) => t !== undefined)
    .map(
      (t) =>
        JSON.parse(
          gunzipSync(readFileSync(resolve(`public/cities/${id}/${t.file}`))).toString('utf8'),
        ) as CityData,
    );
  return mergeTiles(index, tiles, [0, 0], 1);
}

/** Any city in public/cities, by id: one file, or the window round the origin of a tiled one. */
export function loadCityById(id: string): TestCity {
  const cached = cache.get(id);
  if (cached) return cached;
  const city = existsSync(resolve(`public/cities/${id}/index.json`))
    ? readTiledWindow(id)
    : (JSON.parse(readFileSync(resolve(`public/cities/${id}.json`), 'utf8')) as CityData);
  const grid = buildOccupancy(city, 2);
  const lamps = placeLamps(city, grid);
  const trees = placeTrees(city, grid);
  const colliders = buildColliders(city, [
    { data: trees.data, stride: TREE_STRIDE, count: trees.count, radius: 0.35 },
    { data: lamps.data, stride: LAMP_STRIDE, count: lamps.count, radius: 0.15 },
  ]);

  // buildings bucketed by 50 m cell, so the check only looks at the few nearby
  const bucket = new Map<string, CityData['buildings']>();
  for (const b of city.buildings) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < b.outer.length; i += 2) {
      minX = Math.min(minX, b.outer[i]);
      maxX = Math.max(maxX, b.outer[i]);
      minY = Math.min(minY, b.outer[i + 1]);
      maxY = Math.max(maxY, b.outer[i + 1]);
    }
    for (let cy = Math.floor(minY / 50); cy <= Math.floor(maxY / 50); cy++) {
      for (let cx = Math.floor(minX / 50); cx <= Math.floor(maxX / 50); cx++) {
        const key = `${cx},${cy}`;
        const list = bucket.get(key);
        if (list) list.push(b);
        else bucket.set(key, [b]);
      }
    }
  }
  const insideBuilding = (x: number, y: number): boolean =>
    (bucket.get(`${Math.floor(x / 50)},${Math.floor(y / 50)}`) ?? []).some(
      (b) =>
        pointInFlatRing(b.outer, x, y) && !(b.holes ?? []).some((h) => pointInFlatRing(h, x, y)),
    );

  const tower = city.towers.find((t) => t.height > 100);
  const spawn = findSpawn(colliders, tower ? [tower.x, tower.y] : [0, 0], 200, 5);
  const loaded: TestCity = { city, colliders, spawn, insideBuilding };
  cache.set(id, loaded);
  return loaded;
}
