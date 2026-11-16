// Where the trees go: the ones OpenStreetMap maps, plus a believable scatter in parks and forests and
// along streets, kept out of buildings, roads and water. Deterministic: same city, same trees.

import { hash01 } from '../lib/hash';
import {
  OCC_BUILDING,
  OCC_ROAD,
  OCC_TREE,
  OCC_WATER,
  cellCoord,
  isFree,
  pointInFlatRing,
  type Grid,
} from '../sim/grid';
import type { AreaKind, CityData, CityRoad, RoadKind } from './types';

/** Floats per tree in TreeSet.data: x, y, height, crown radius, tint (0..1), shape (0 round, 1 tall and narrow). */
export const TREE_STRIDE = 6;

export interface TreeSet {
  data: Float32Array;
  count: number;
}

/** Upper bound, so a huge forest cannot flood the GPU. */
export const MAX_TREES = 9000;

/** Trees per square metre by kind of area. */
const DENSITY: Partial<Record<AreaKind, number>> = {
  forest: 1 / 45,
  park: 1 / 200,
  cemetery: 1 / 260,
  farmland: 1 / 500,
  grass: 1 / 1100,
};

/** Spacing in metres between street trees, for the streets that get them. */
const STREET_SPACING: Partial<Record<RoadKind, number>> = {
  primary: 13,
  secondary: 12,
  tertiary: 12,
  residential: 15,
};

const SEED = 4242;

export function placeTrees(city: CityData, grid: Grid): TreeSet {
  const out: number[] = [];
  let serial = 0;

  const clearOfBuildings = (x: number, y: number, reach: number): boolean =>
    [
      [0, 0],
      [reach, 0],
      [-reach, 0],
      [0, reach],
      [0, -reach],
    ].every(([dx, dy]) => isFree(grid, x + dx, y + dy, OCC_BUILDING));

  const add = (x: number, y: number, forest: boolean): boolean => {
    if (out.length / TREE_STRIDE >= MAX_TREES) return false;
    if (!isFree(grid, x, y, OCC_BUILDING | OCC_ROAD | OCC_WATER | OCC_TREE)) return false;
    if (!clearOfBuildings(x, y, 1.8)) return false;
    const r = (salt: number): number => hash01(SEED + serial, salt);
    const tall = r(1) < 0.2;
    const height = tall ? 11 + r(2) * 6 : (forest ? 7 : 6) + r(2) * 6;
    const crown = tall ? 1.5 + r(3) * 0.8 : 2.4 + r(3) * 2.2 + (forest ? 0.4 : 0);
    out.push(x, y, height, crown, r(4), tall ? 1 : 0);
    serial++;
    const cx = cellCoord(grid, x);
    const cy = cellCoord(grid, y);
    if (cx >= 0 && cy >= 0) grid.data[cy * grid.size + cx] |= OCC_TREE;
    return true;
  };

  // 1. trees OpenStreetMap knows about
  for (let i = 0; i + 1 < city.trees.length; i += 2) add(city.trees[i], city.trees[i + 1], false);

  // 2. fill parks and woods on a jittered grid
  for (const area of city.areas) {
    const density = DENSITY[area.kind];
    if (!density) continue;
    const spacing = Math.sqrt(1 / density);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < area.outer.length; i += 2) {
      minX = Math.min(minX, area.outer[i]);
      maxX = Math.max(maxX, area.outer[i]);
      minY = Math.min(minY, area.outer[i + 1]);
      maxY = Math.max(maxY, area.outer[i + 1]);
    }
    for (let y = minY; y <= maxY; y += spacing) {
      for (let x = minX; x <= maxX; x += spacing) {
        const jx = x + (hash01(Math.round(x * 10), Math.round(y * 10) + 11) - 0.5) * spacing * 0.9;
        const jy = y + (hash01(Math.round(x * 10) + 5, Math.round(y * 10)) - 0.5) * spacing * 0.9;
        if (!pointInFlatRing(area.outer, jx, jy)) continue;
        if (area.holes?.some((h) => pointInFlatRing(h, jx, jy))) continue;
        add(jx, jy, area.kind === 'forest');
      }
    }
  }

  // 3. street trees, a little way back from the kerb on either side
  city.roads.forEach((road, index) => streetTrees(road, index, add));

  return { data: Float32Array.from(out), count: out.length / TREE_STRIDE };
}

function streetTrees(
  road: CityRoad,
  index: number,
  add: (x: number, y: number, forest: boolean) => boolean,
): void {
  const spacing = STREET_SPACING[road.kind];
  if (!spacing) return;
  const offset = road.width / 2 + 2.6;
  let carry = hash01(index, 31) * spacing; // distance to the next tree, so roads do not all start in step
  const p = road.points;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i];
    const ay = p[i + 1];
    const bx = p[i + 2];
    const by = p[i + 3];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 0.5) continue;
    const dx = (bx - ax) / len;
    const dy = (by - ay) / len;
    let at = carry;
    while (at <= len) {
      const x = ax + dx * at;
      const y = ay + dy * at;
      for (const side of [1, -1]) {
        if (hash01(index * 977 + Math.round(at * 10), side + 40) < 0.72)
          add(x - dy * offset * side, y + dx * offset * side, false);
      }
      at += spacing * (0.85 + hash01(index, Math.round(at * 10) + 50) * 0.3);
    }
    carry = at - len;
  }
}
