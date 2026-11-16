// Extracts the embedded `const DATA = {...}` object from the legacy single-file app
// into standalone JSON files under public/data/.
//
//   node scripts/extract-data.mjs [--src legacy/index.html] [--out public/data]
//
// Output (coordinates and properties are copied untouched):
//   countries-110m.json  GeoJSON FeatureCollection  (Natural Earth 1:110m countries)
//   rivers.json          GeoJSON FeatureCollection
//   lakes.json           GeoJSON FeatureCollection
//   cities.json          array of [name, lon, lat, population, isCapital]
//
// One-off: the generated files are committed. Once legacy/ is deleted this script
// has nothing left to read and can be deleted too.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const srcPath = resolve(root, arg('src', 'legacy/index.html'));
const outDir = resolve(root, arg('out', 'public/data'));

const html = readFileSync(srcPath, 'utf8');
// DATA sits on a single line: `const DATA = {...};`
const match = /^const DATA = (\{.*\});?[ \t]*\r?$/m.exec(html);
if (!match) {
  console.error(`Could not find a single-line "const DATA = {...};" in ${srcPath}`);
  process.exit(1);
}

const data = JSON.parse(match[1]);
for (const key of ['countries', 'rivers', 'lakes', 'cities']) {
  if (!Array.isArray(data[key])) {
    console.error(`DATA.${key} is missing or not an array`);
    process.exit(1);
  }
}

const featureCollection = (features) => ({ type: 'FeatureCollection', features });

const files = {
  'countries-110m.json': featureCollection(data.countries),
  'rivers.json': featureCollection(data.rivers),
  'lakes.json': featureCollection(data.lakes),
  'cities.json': data.cities,
};

mkdirSync(outDir, { recursive: true });
for (const [name, value] of Object.entries(files)) {
  const target = resolve(outDir, name);
  writeFileSync(target, JSON.stringify(value) + '\n');
  // Read back and compare, so a bad write can't slip through silently.
  const again = JSON.parse(readFileSync(target, 'utf8'));
  if (!isDeepStrictEqual(again, value)) {
    console.error(`Round-trip mismatch for ${name}`);
    process.exit(1);
  }
  const kb = (Buffer.byteLength(JSON.stringify(value)) / 1024).toFixed(1);
  const count = Array.isArray(value) ? value.length : value.features.length;
  console.log(`${name.padEnd(22)} ${String(count).padStart(4)} items  ${kb.padStart(7)} KB`);
}
