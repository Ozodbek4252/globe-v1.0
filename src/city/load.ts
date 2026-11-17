import { fetchJson, type JsonLoader } from '../map/data';
import { publicUrl } from '../lib/url';
import { isSavedGame } from '../sim/save';
import { mergeTiles, parseTileIndex, tileAt, tileKey, windowTiles, type TileIndex } from './tiles';
import type { CityData } from './types';

/** Check that something loaded is in the format this code reads. */
function asCityData(raw: unknown, what: string): CityData {
  const data = raw as Partial<CityData> | null;
  if (!data || data.version !== 1 || !Array.isArray(data.buildings) || !Array.isArray(data.roads)) {
    throw new Error(`The map data for "${what}" is not in the expected format.`);
  }
  return data as CityData;
}

/** Fetch a city file from public/cities/<id>.json and check it is in the format this code reads. */
export async function loadCity(id: string, load: JsonLoader = fetchJson): Promise<CityData> {
  return asCityData(await load(`cities/${id}.json`), id);
}

/** Fetch a gzipped JSON file from `public/` and unpack it in the browser. */
export const fetchGzipJson: JsonLoader = async (path) => {
  const res = await fetch(publicUrl(path));
  if (!res.ok || !res.body) throw new Error(`Could not load ${path} (${res.status})`);
  const unpacked = res.body.pipeThrough(new DecompressionStream('gzip'));
  return (await new Response(unpacked).json()) as unknown;
};

export interface TiledLoaders {
  /** Loads plain JSON (the index). */
  json?: JsonLoader;
  /** Loads gzipped JSON (the tiles). */
  gzip?: JsonLoader;
}

/** The index of a tiled city: public/cities/<id>/index.json. */
export async function loadTileIndex(id: string, load: JsonLoader = fetchJson): Promise<TileIndex> {
  const index = parseTileIndex(await load(`cities/${id}/index.json`));
  if (!index) throw new Error(`The tile index for "${id}" is not in the expected format.`);
  return index;
}

/**
 * Where a saved game's window was (metres east and north of the city's origin), or the city's origin
 * for a save from a map that stands alone, or anything that is not a save.
 */
export function savedWindowOrigin(saved: unknown): [number, number] {
  return isSavedGame(saved) && saved.city ? saved.city.origin : [0, 0];
}

/** Tiles fetched once and kept, and windows made of them. */
export interface TileStore {
  index: TileIndex;
  /** The window round tile (tx, ty), from the cache where it can be. */
  window(tx: number, ty: number, radius?: number): Promise<CityData>;
  /** Start fetching the tiles of the window round (tx, ty); nothing waits for it. */
  prefetch(tx: number, ty: number, radius?: number): void;
}

export function createTileStore(index: TileIndex, loaders: TiledLoaders = {}): TileStore {
  const load = loaders.gzip ?? fetchGzipJson;
  const have = new Map(index.tiles.map((t) => [tileKey(t.tx, t.ty), t]));
  const cache = new Map<string, Promise<CityData>>();
  const tile = (tx: number, ty: number): Promise<CityData> | null => {
    const key = tileKey(tx, ty);
    const entry = have.get(key);
    if (!entry) return null; // open ground
    let pending = cache.get(key);
    if (!pending) {
      pending = load(`cities/${index.id}/${entry.file}`).then((raw) =>
        asCityData(raw, `${index.id} ${key}`),
      );
      pending.catch(() => cache.delete(key)); // a failed fetch can be tried again
      cache.set(key, pending);
    }
    return pending;
  };
  const tilesOf = (tx: number, ty: number, radius: number): Promise<CityData>[] =>
    windowTiles(tx, ty, radius)
      .map(([x, y]) => tile(x, y))
      .filter((p): p is Promise<CityData> => p !== null);
  return {
    index,
    async window(tx, ty, radius = 1) {
      const tiles = await Promise.all(tilesOf(tx, ty, radius));
      return mergeTiles(index, tiles, [tx * index.tileSize, ty * index.tileSize], radius);
    },
    prefetch(tx, ty, radius = 1) {
      for (const p of tilesOf(tx, ty, radius)) p.catch(() => undefined);
    },
  };
}

/**
 * The window of a tiled city around a point (metres east and north of the city's origin): the tiles
 * `radius` out from the one the point is in, fetched together and put into one map whose origin is
 * the window's centre. A tile that does not exist is open ground and is simply left out.
 */
export async function loadTiledWindow(
  index: TileIndex,
  around: [number, number],
  radius = 1,
  loaders: TiledLoaders = {},
): Promise<CityData> {
  const load = loaders.gzip ?? fetchGzipJson;
  const have = new Map(index.tiles.map((t) => [`${t.tx},${t.ty}`, t]));
  const [cx, cy] = tileAt(index, around[0], around[1]);
  const wanted = windowTiles(cx, cy, radius).filter(([tx, ty]) => have.has(`${tx},${ty}`));
  const tiles = await Promise.all(
    wanted.map(async ([tx, ty]) => {
      const entry = have.get(`${tx},${ty}`);
      if (!entry) throw new Error('unreachable');
      return asCityData(await load(`cities/${index.id}/${entry.file}`), `${index.id} ${tx},${ty}`);
    }),
  );
  return mergeTiles(index, tiles, [cx * index.tileSize, cy * index.tileSize], radius);
}
