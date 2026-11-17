// Cuts a whole city into 1 km tiles the game can stream. The input is what osmium makes of an
// OpenStreetMap extract; the output is one gzipped tile file per square kilometre that has anything in
// it, and an index of them. Run it in Docker (nothing needs installing on the host):
//
//   # 1. an extract of the city from a country file (Geofabrik), with osmium
//   docker run --rm -v "${PWD}:/data" -w /data stefda/osmium-tool \
//     osmium extract --bbox 69.05,41.15,69.50,41.45 -o tashkent-wide.osm.pbf uzbekistan-latest.osm.pbf
//   docker run --rm -v "${PWD}:/data" -w /data stefda/osmium-tool \
//     osmium export tashkent-wide.osm.pbf -f geojsonseq --add-unique-id type_id -o tashkent.geojsonseq
//
//   # 2. the tiles
//   docker compose run --rm --entrypoint node tools --max-old-space-size=4096 scripts/tile-city.mjs \
//     --id tashkent --name "Tashkent" --lat 41.3457 --lon 69.2848 --in /path/tashkent.geojsonseq
//
// Options
//   --id        folder name and id under public/cities/, e.g. tashkent   (required)
//   --name      display name                                              (default: the id)
//   --lat/--lon the city's origin: tile (0, 0) is centred on it           (required)
//   --in        the GeoJSONSeq file osmium exported                       (required)
//   --tile      side of a tile in metres                                  (default 1000)
//   --reach     how far from the origin to look, in metres, each way      (default 15000)
//   --out       output folder                                             (default public/cities)
//
// Tile (tx, ty) covers x in [tx*tile - tile/2, tx*tile + tile/2) and the same for y, in metres east
// and north of the origin; each tile's coordinates are kept relative to its own centre, with that
// centre's offset written in the file (`origin`), so the game can place it anywhere.
// Output is OpenStreetMap data (c) OpenStreetMap contributors, ODbL: keep the attribution.

import { createReadStream, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { gzipSync } from 'node:zlib';
import { convertOverpass, makeProjector } from '../src/city/osm.ts';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 && args[i + 1] ? args[i + 1] : fallback;
};
const need = (name) => {
  const v = arg(name);
  if (v === undefined) {
    console.error(`Missing --${name}. See the header of scripts/tile-city.mjs.`);
    process.exit(2);
  }
  return v;
};

const id = need('id');
const lat = Number(need('lat'));
const lon = Number(need('lon'));
const input = resolve(need('in'));
const name = arg('name', id);
const tile = Number(arg('tile', '1000'));
const reach = Number(arg('reach', '15000'));
const outDir = resolve(arg('out', 'public/cities'), id);
if (![lat, lon, tile, reach].every(Number.isFinite)) {
  console.error('--lat, --lon, --tile and --reach must be numbers');
  process.exit(2);
}

const project = makeProjector(lon, lat);
const half = tile / 2;
const tileOf = (v) => Math.round(v / tile);

/** A GeoJSON feature from osmium, as the element the converter reads (what Overpass would have sent). */
function toElement(feature) {
  const props = feature.properties ?? {};
  // osmium 1.7 writes the id as "w123" / "n123" / "r123" (--add-unique-id type_id); newer ones can add
  // @type and @id properties instead
  const unique = String(feature.id ?? props['@id'] ?? '');
  const prefix = { n: 'node', w: 'way', r: 'relation' }[unique[0]];
  const type = props['@type'] ?? prefix;
  const fid = Number(props['@type'] ? props['@id'] : unique.slice(1));
  if (!type || !Number.isFinite(fid)) return null;
  const tags = {};
  for (const [k, v] of Object.entries(props))
    if (!k.startsWith('@') && k !== 'id') tags[k] = String(v);
  const g = feature.geometry;
  if (!g) return null;
  const ring = (coords) => coords.map(([x, y]) => ({ lon: x, lat: y }));
  switch (g.type) {
    case 'Point':
      return { type: 'node', id: fid, lon: g.coordinates[0], lat: g.coordinates[1], tags };
    case 'LineString':
      return { type: 'way', id: fid, tags, geometry: ring(g.coordinates) };
    case 'Polygon': {
      const [outer, ...holes] = g.coordinates;
      if (type === 'way' && holes.length === 0) {
        return { type: 'way', id: fid, tags, geometry: ring(outer) };
      }
      return {
        type: 'relation',
        id: fid,
        tags: { ...tags, type: 'multipolygon' },
        members: [
          { type: 'way', ref: 0, role: 'outer', geometry: ring(outer) },
          ...holes.map((h, k) => ({ type: 'way', ref: k + 1, role: 'inner', geometry: ring(h) })),
        ],
      };
    }
    case 'MultiPolygon': {
      const members = [];
      let ref = 0;
      for (const polygon of g.coordinates) {
        polygon.forEach((r, k) =>
          members.push({
            type: 'way',
            ref: ref++,
            role: k === 0 ? 'outer' : 'inner',
            geometry: ring(r),
          }),
        );
      }
      return { type: 'relation', id: fid, tags: { ...tags, type: 'multipolygon' }, members };
    }
    default:
      return null;
  }
}

/** The bounding box of an element's points, in metres from the origin. */
function bounds(el) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const take = (lonV, latV) => {
    const [x, y] = project(lonV, latV);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  };
  if (el.type === 'node') take(el.lon, el.lat);
  else if (el.type === 'way') for (const p of el.geometry) take(p.lon, p.lat);
  else for (const m of el.members) for (const p of m.geometry) take(p.lon, p.lat);
  return { minX, minY, maxX, maxY };
}

/** Whether an element is worth anything to the game (so the rest need not be kept in memory). */
function wanted(tags) {
  return (
    (tags.building && tags.building !== 'no') ||
    tags.highway ||
    tags.waterway ||
    tags.natural ||
    tags.landuse ||
    tags.leisure ||
    tags.amenity === 'parking' ||
    tags.man_made ||
    tags.place === 'square'
  );
}

// ---- read everything once, binning each element into the tiles it touches
const byTile = new Map(); // "tx,ty" -> elements
let read = 0;
let kept = 0;
const rl = createInterface({ input: createReadStream(input), crlfDelay: Infinity });
for await (const rawLine of rl) {
  // GeoJSONSeq puts a record separator (0x1e) before each line
  const line = (rawLine.charCodeAt(0) === 0x1e ? rawLine.slice(1) : rawLine).trim();
  if (!line) continue;
  read++;
  let feature;
  try {
    feature = JSON.parse(line);
  } catch {
    continue;
  }
  const el = toElement(feature);
  if (!el || !wanted(el.tags)) continue;
  const b = bounds(el);
  if (b.maxX < -reach || b.minX > reach || b.maxY < -reach || b.minY > reach) continue;
  kept++;
  // a building or a tree lands in one tile (its centroid, decided by the converter); areas and roads
  // are handed to every tile their box touches, and the converter clips them
  const tx0 = Math.max(-Math.ceil(reach / tile), tileOf(b.minX));
  const tx1 = Math.min(Math.ceil(reach / tile), tileOf(b.maxX));
  const ty0 = Math.max(-Math.ceil(reach / tile), tileOf(b.minY));
  const ty1 = Math.min(Math.ceil(reach / tile), tileOf(b.maxY));
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const key = `${tx},${ty}`;
      const list = byTile.get(key);
      if (list) list.push(el);
      else byTile.set(key, [el]);
    }
  }
  if (read % 200000 === 0) console.log(`  read ${read} features, kept ${kept}`);
}
console.log(`Read ${read} features, kept ${kept}, in ${byTile.size} tiles`);

// ---- convert each tile and write it
mkdirSync(outDir, { recursive: true });
const generated = new Date().toISOString().slice(0, 10);
const index = {
  version: 1,
  id,
  name,
  center: [lon, lat],
  tileSize: tile,
  generated,
  attribution: 'Map data (c) OpenStreetMap contributors, ODbL 1.0',
  tiles: [],
};
let bytes = 0;
let totalBuildings = 0;
for (const [key, elements] of byTile) {
  const [tx, ty] = key.split(',').map(Number);
  const data = convertOverpass(
    { elements },
    {
      id: `${id}/${tx},${ty}`,
      name,
      center: [lon, lat],
      halfSize: half,
      origin: [tx * tile, ty * tile],
      generated,
    },
  );
  // an empty square of farmland is not a tile: the game treats a missing tile as open ground
  if (data.buildings.length === 0 && data.roads.length === 0 && data.areas.length === 0) continue;
  const json = JSON.stringify(data);
  const gz = gzipSync(json, { level: 9 });
  const file = `t_${tx}_${ty}.json.gz`;
  writeFileSync(resolve(outDir, file), gz);
  bytes += gz.length;
  totalBuildings += data.buildings.length;
  index.tiles.push({
    tx,
    ty,
    file,
    buildings: data.buildings.length,
    roads: data.roads.length,
    areas: data.areas.length,
    bytes: gz.length,
  });
}
index.tiles.sort((a, b) => a.ty - b.ty || a.tx - b.tx);
writeFileSync(resolve(outDir, 'index.json'), JSON.stringify(index) + '\n');

const txs = index.tiles.map((t) => t.tx);
const tys = index.tiles.map((t) => t.ty);
console.log(
  `\nWrote ${index.tiles.length} tiles to ${outDir} (${(bytes / 1048576).toFixed(1)} MB gzipped)`,
);
console.log(
  `  buildings ${totalBuildings}; tiles x ${Math.min(...txs)}..${Math.max(...txs)}, y ${Math.min(...tys)}..${Math.max(...tys)}`,
);
const busiest = [...index.tiles].sort((a, b) => b.buildings - a.buildings).slice(0, 5);
console.log(
  `  busiest: ${busiest.map((t) => `(${t.tx},${t.ty}) ${t.buildings} buildings ${(t.bytes / 1024).toFixed(0)} KB`).join('; ')}`,
);
