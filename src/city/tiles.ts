// A city too big to load at once is cut into square tiles (scripts/tile-city.mjs). The game plays in a
// window of them around the survivor: this is the arithmetic of which tiles that is, and how their
// pieces are put together into one map with the window's centre as the origin. Pure: no fetch here.

import type { CityArea, CityBuilding, CityData, CityRoad, CityTower, CityWaterway } from './types';

export interface TileEntry {
  tx: number;
  ty: number;
  file: string;
  buildings: number;
  roads: number;
  areas: number;
  bytes: number;
}

export interface TileIndex {
  version: 1;
  id: string;
  name: string;
  /** [longitude, latitude] of the city's origin: tile (0, 0) is centred on it. */
  center: [number, number];
  /** Side of a tile in metres. */
  tileSize: number;
  generated: string;
  attribution: string;
  tiles: TileEntry[];
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Read an index file; anything that is not one is null. Tile entries that do not make sense are dropped. */
export function parseTileIndex(raw: unknown): TileIndex | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || typeof r.id !== 'string' || typeof r.name !== 'string') return null;
  if (!Array.isArray(r.center) || r.center.length !== 2 || !r.center.every(isNumber)) return null;
  if (!isNumber(r.tileSize) || r.tileSize <= 0 || !Array.isArray(r.tiles)) return null;
  const tiles: TileEntry[] = [];
  for (const item of r.tiles as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const t = item as Record<string, unknown>;
    if (!Number.isInteger(t.tx) || !Number.isInteger(t.ty) || typeof t.file !== 'string') continue;
    tiles.push({
      tx: t.tx as number,
      ty: t.ty as number,
      file: t.file,
      buildings: isNumber(t.buildings) ? t.buildings : 0,
      roads: isNumber(t.roads) ? t.roads : 0,
      areas: isNumber(t.areas) ? t.areas : 0,
      bytes: isNumber(t.bytes) ? t.bytes : 0,
    });
  }
  return {
    version: 1,
    id: r.id,
    name: r.name,
    center: [r.center[0], r.center[1]],
    tileSize: r.tileSize,
    generated: typeof r.generated === 'string' ? r.generated : '',
    attribution: typeof r.attribution === 'string' ? r.attribution : '',
    tiles,
  };
}

export const tileKey = (tx: number, ty: number): string => `${tx},${ty}`;

/** Which tile a point (metres east and north of the city's origin) is in. */
export function tileAt(index: Pick<TileIndex, 'tileSize'>, x: number, y: number): [number, number] {
  return [Math.round(x / index.tileSize) + 0, Math.round(y / index.tileSize) + 0]; // + 0: never -0
}

/** The tiles of the window `radius` tiles out from (tx, ty) each way: a 3 by 3 square for radius 1. */
export function windowTiles(tx: number, ty: number, radius: number): [number, number][] {
  const out: [number, number][] = [];
  for (let y = ty - radius; y <= ty + radius; y++) {
    for (let x = tx - radius; x <= tx + radius; x++) out.push([x, y]);
  }
  return out;
}

/** The window's half-size in metres: the tiles out from the centre, and the centre tile's own half. */
export const windowHalf = (index: Pick<TileIndex, 'tileSize'>, radius: number): number =>
  (radius + 0.5) * index.tileSize;

/**
 * The tiles to draw as scenery when the camera looks past the window: the square `radius` out from
 * the tile the camera looks at, less the window (the same square round `centre`). None while the
 * camera looks at the window's own centre tile.
 */
export function sceneryTiles(
  camera: readonly [number, number],
  centre: readonly [number, number],
  radius = 1,
): [number, number][] {
  return windowTiles(camera[0], camera[1], radius).filter(
    ([x, y]) => Math.abs(x - centre[0]) > radius || Math.abs(y - centre[1]) > radius,
  );
}

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/**
 * How far a tiled city reaches, in metres east and north of its origin: the outer edges of its
 * outermost tiles. Null for an index with no tiles.
 */
export function tileBounds(index: Pick<TileIndex, 'tileSize' | 'tiles'>): Bounds | null {
  if (index.tiles.length === 0) return null;
  const half = index.tileSize / 2;
  const b: Bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  for (const t of index.tiles) {
    b.minX = Math.min(b.minX, t.tx * index.tileSize - half);
    b.maxX = Math.max(b.maxX, t.tx * index.tileSize + half);
    b.minY = Math.min(b.minY, t.ty * index.tileSize - half);
    b.maxY = Math.max(b.maxY, t.ty * index.tileSize + half);
  }
  return b;
}

const shiftFlat = (flat: readonly number[], dx: number, dy: number): number[] =>
  flat.map((v, i) => Math.round((v + (i % 2 === 0 ? dx : dy)) * 10) / 10);

/**
 * One map out of the tiles of a window, with the window's centre as the origin. Each tile's pieces
 * are moved by where its own centre lies in the window. Tiles that are missing (open ground) add
 * nothing. The result carries `origin`: where the window's centre is in the city.
 */
export function mergeTiles(
  index: TileIndex,
  tiles: readonly CityData[],
  centre: [number, number],
  radius: number,
): CityData {
  const [wx, wy] = centre;
  const buildings: CityBuilding[] = [];
  const roads: CityRoad[] = [];
  const areas: CityArea[] = [];
  const waterways: CityWaterway[] = [];
  const towers: CityTower[] = [];
  const trees: number[] = [];
  for (const tile of tiles) {
    const [ox, oy] = tile.origin ?? [0, 0];
    const dx = ox - wx;
    const dy = oy - wy;
    for (const b of tile.buildings) {
      const moved: CityBuilding = { ...b, outer: shiftFlat(b.outer, dx, dy) };
      if (b.holes) moved.holes = b.holes.map((h) => shiftFlat(h, dx, dy));
      buildings.push(moved);
    }
    for (const r of tile.roads) roads.push({ ...r, points: shiftFlat(r.points, dx, dy) });
    for (const a of tile.areas) {
      const moved: CityArea = { ...a, outer: shiftFlat(a.outer, dx, dy) };
      if (a.holes) moved.holes = a.holes.map((h) => shiftFlat(h, dx, dy));
      areas.push(moved);
    }
    for (const w of tile.waterways) waterways.push({ ...w, points: shiftFlat(w.points, dx, dy) });
    for (const t of tile.towers) towers.push({ ...t, x: t.x + dx, y: t.y + dy });
    trees.push(...shiftFlat(tile.trees, dx, dy));
  }
  return {
    version: 1,
    id: index.id,
    name: index.name,
    center: index.center,
    halfSize: windowHalf(index, radius),
    origin: [wx, wy],
    buildings,
    roads,
    areas,
    waterways,
    trees,
    towers,
    attribution: index.attribution || '© OpenStreetMap contributors (ODbL)',
    generated: index.generated,
  };
}
