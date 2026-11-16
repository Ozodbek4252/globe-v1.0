// Downloads a district from OpenStreetMap (Overpass API) and writes the compact city file the game
// loads. Run it in Docker (nothing needs installing on the host):
//
//   docker compose run --rm --entrypoint node tools scripts/fetch-city.mjs \
//     --id tashkent --name "Tashkent" --lat 41.3433 --lon 69.2849 --half 1000
//
// Options
//   --id       file name and id, e.g. tashkent            (required)
//   --name     display name                                (default: the id)
//   --lat/--lon  centre of the play area, in degrees       (required)
//   --half     half the side of the square play area, m    (default 1000)
//   --out      output folder                               (default public/cities)
//   --raw      also save the raw Overpass response here, and reuse it next time if it exists
//
// The conversion itself lives in src/city/osm.ts (tested); Node runs that TypeScript directly.
// Output is OpenStreetMap data (c) OpenStreetMap contributors, ODbL: keep the attribution.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { convertOverpass, overpassQuery } from '../src/city/osm.ts';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i > -1 && args[i + 1] ? args[i + 1] : fallback;
};
const need = (name) => {
  const v = arg(name);
  if (v === undefined) {
    console.error(`Missing --${name}. See the header of scripts/fetch-city.mjs.`);
    process.exit(2);
  }
  return v;
};

const id = need('id');
const lat = Number(need('lat'));
const lon = Number(need('lon'));
const halfSize = Number(arg('half', '1000'));
const name = arg('name', id);
const outDir = resolve(arg('out', 'public/cities'));
const rawPath = arg('raw');
if (![lat, lon, halfSize].every(Number.isFinite)) {
  console.error('--lat, --lon and --half must be numbers');
  process.exit(2);
}

// Public Overpass servers are shared and sometimes busy (502/504), so try each a few times.
const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function download(query) {
  let last;
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length];
    try {
      console.log(`Overpass request ${attempt + 1} to ${new URL(url).host} ...`);
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'user-agent': 'city-data-extractor/1.0',
        },
        body: 'data=' + encodeURIComponent(query),
        signal: AbortSignal.timeout(240_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (e) {
      last = e;
      console.log(`  failed: ${e.message}`);
      await sleep(4000 * (attempt + 1));
    }
  }
  throw last;
}

let rawText;
if (rawPath && existsSync(rawPath)) {
  console.log(`Using saved response ${rawPath}`);
  rawText = readFileSync(rawPath, 'utf8');
} else {
  rawText = await download(overpassQuery([lon, lat], halfSize));
  if (rawPath) {
    mkdirSync(dirname(resolve(rawPath)), { recursive: true });
    writeFileSync(rawPath, rawText);
    console.log(`Saved raw response to ${rawPath}`);
  }
}

const response = JSON.parse(rawText);
if (!Array.isArray(response.elements)) throw new Error('Unexpected response: no "elements" array');

const city = convertOverpass(response, {
  id,
  name,
  center: [lon, lat],
  halfSize,
  generated: new Date().toISOString().slice(0, 10),
});

mkdirSync(outDir, { recursive: true });
const target = resolve(outDir, `${id}.json`);
const json = JSON.stringify(city);
writeFileSync(target, json + '\n');

const estimated = city.buildings.filter((b) => b.estimated).length;
const kinds = {};
for (const b of city.buildings) kinds[b.kind] = (kinds[b.kind] ?? 0) + 1;
const tallest = city.buildings.reduce((m, b) => Math.max(m, b.height), 0);
console.log(`\nWrote ${target}`);
console.log(
  `  ${(json.length / 1024).toFixed(0)} KB (${(gzipSync(json).length / 1024).toFixed(0)} KB gzipped)`,
);
console.log(
  `  buildings ${city.buildings.length} (${estimated} with estimated height, tallest ${tallest} m)`,
);
console.log(
  `  kinds ${Object.entries(kinds)
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(', ')}`,
);
console.log(
  `  roads ${city.roads.length}, waterways ${city.waterways.length}, areas ${city.areas.length}, trees ${city.trees.length / 2}, towers ${city.towers.length}`,
);
for (const t of city.towers)
  console.log(`  tower: ${t.name ?? t.kind} ${t.height} m at ${t.x}, ${t.y}`);
