// Converts an OpenStreetMap (Overpass API) extract into the compact CityData format.
//
// Pure functions, no DOM and no I/O, so the same code runs in the browser build, in Vitest and in
// scripts/fetch-city.mjs under Node. Value imports carry a ".ts" extension for that reason.

import { hash01 } from '../lib/hash.ts';
import type {
  AreaKind,
  BuildingKind,
  CityArea,
  CityBuilding,
  CityData,
  CityRoad,
  CityTower,
  CityWaterway,
  RoadKind,
  WaterwayKind,
} from './types';

// ---------- Overpass response (the parts we read) ----------

export interface OverpassPoint {
  lat: number;
  lon: number;
}

export interface OverpassMember {
  type: 'node' | 'way' | 'relation';
  ref: number;
  role: string;
  geometry?: (OverpassPoint | null)[];
}

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  geometry?: (OverpassPoint | null)[];
  members?: OverpassMember[];
}

export interface OverpassResponse {
  elements: OverpassElement[];
}

export type Point = [x: number, y: number];

// ---------- projection ----------

/** Metres per degree of longitude and latitude at a latitude (WGS84 series). */
function metresPerDegree(latDeg: number): { lon: number; lat: number } {
  const phi = (latDeg * Math.PI) / 180;
  return {
    lat: 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi),
    lon: 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi),
  };
}

/** Longitude/latitude to metres east/north of the centre. Accurate to well under a metre per km. */
export function makeProjector(lon0: number, lat0: number): (lon: number, lat: number) => Point {
  const m = metresPerDegree(lat0);
  return (lon, lat) => [(lon - lon0) * m.lon, (lat - lat0) * m.lat];
}

/** [south, west, north, east] covering the playable square plus a margin, for the Overpass query. */
export function boundingBox(
  [lon0, lat0]: [number, number],
  halfSize: number,
  margin = 60,
): [number, number, number, number] {
  const m = metresPerDegree(lat0);
  const reach = halfSize + margin;
  const dLat = reach / m.lat;
  const dLon = reach / m.lon;
  const r = (n: number): number => Math.round(n * 1e6) / 1e6;
  return [r(lat0 - dLat), r(lon0 - dLon), r(lat0 + dLat), r(lon0 + dLon)];
}

const AREA_LANDUSE =
  'grass|meadow|forest|recreation_ground|village_green|cemetery|farmland|orchard|vineyard|allotments|reservoir|basin';
const AREA_LEISURE =
  'park|garden|pitch|playground|stadium|sports_centre|track|common|nature_reserve';
const AREA_NATURAL = 'water|wood|scrub|grassland|sand';
const TOWER_MAN_MADE = 'tower|mast|chimney|water_tower';

/** The Overpass QL query for everything the game uses inside the bounding box. */
export function overpassQuery(center: [number, number], halfSize: number): string {
  const [s, w, n, e] = boundingBox(center, halfSize);
  const multi = '["type"="multipolygon"]';
  return `[out:json][timeout:180][bbox:${s},${w},${n},${e}];
(
  way["building"]["building"!="no"];
  relation["building"]${multi};
  way["highway"];
  way["waterway"~"^(river|canal|stream)$"];
  way["natural"~"^(${AREA_NATURAL})$"];
  relation["natural"~"^(${AREA_NATURAL})$"]${multi};
  way["landuse"~"^(${AREA_LANDUSE})$"];
  relation["landuse"~"^(${AREA_LANDUSE})$"]${multi};
  way["leisure"~"^(${AREA_LEISURE})$"];
  relation["leisure"~"^(${AREA_LEISURE})$"]${multi};
  way["amenity"="parking"];
  way["place"="square"];
  node["natural"="tree"];
  node["man_made"~"^(${TOWER_MAN_MADE})$"];
  way["man_made"~"^(${TOWER_MAN_MADE})$"];
);
out tags geom;`;
}

// ---------- geometry helpers ----------

/** Shoelace area: positive for counter-clockwise rings. */
export function signedArea(ring: readonly Point[]): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

/** The ring in the requested direction (a copy). */
export function orient(ring: readonly Point[], counterClockwise: boolean): Point[] {
  const ccw = signedArea(ring) >= 0;
  return ccw === counterClockwise ? [...ring] : [...ring].reverse();
}

/** Drop a repeated closing point and consecutive duplicates. */
export function dedupeRing(ring: readonly Point[]): Point[] {
  const out: Point[] = [];
  for (const p of ring) {
    const last = out[out.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 1 && first && last && first[0] === last[0] && first[1] === last[1]) out.pop();
  return out;
}

export function ringCentroid(ring: readonly Point[]): Point {
  const area = signedArea(ring);
  if (Math.abs(area) < 1e-6) {
    const n = ring.length || 1;
    return [ring.reduce((s, p) => s + p[0], 0) / n, ring.reduce((s, p) => s + p[1], 0) / n];
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const cross = a[0] * b[1] - b[0] * a[1];
    cx += (a[0] + b[0]) * cross;
    cy += (a[1] + b[1]) * cross;
  }
  return [cx / (6 * area), cy / (6 * area)];
}

export function pointInRing(ring: readonly Point[], [x, y]: Point): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) {
      inside = !inside;
    }
  }
  return inside;
}

/** Sutherland-Hodgman clip of a polygon to the square [-half, half]. May return [] when outside. */
export function clipRing(ring: readonly Point[], half: number): Point[] {
  const planes: ((p: Point) => number)[] = [
    (p) => half - p[0],
    (p) => p[0] + half,
    (p) => half - p[1],
    (p) => p[1] + half,
  ];
  let out: Point[] = [...ring];
  for (const distance of planes) {
    const input = out;
    out = [];
    for (let i = 0; i < input.length; i++) {
      const a = input[i];
      const b = input[(i + 1) % input.length];
      const da = distance(a);
      const db = distance(b);
      if (da >= 0) out.push(a);
      if (da >= 0 !== db >= 0) {
        const t = da / (da - db);
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    if (out.length < 3) return [];
  }
  return out;
}

/** Liang-Barsky clip of a polyline to the square. A line leaving and re-entering becomes two lines. */
export function clipLine(points: readonly Point[], half: number): Point[][] {
  const result: Point[][] = [];
  let current: Point[] = [];
  const flush = (): void => {
    if (current.length >= 2) result.push(current);
    current = [];
  };
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    let t0 = 0;
    let t1 = 1;
    let visible = true;
    const tests: [number, number][] = [
      [-dx, a[0] + half],
      [dx, half - a[0]],
      [-dy, a[1] + half],
      [dy, half - a[1]],
    ];
    for (const [p, q] of tests) {
      if (p === 0) {
        if (q < 0) visible = false;
      } else {
        const r = q / p;
        if (p < 0) t0 = Math.max(t0, r);
        else t1 = Math.min(t1, r);
      }
    }
    if (!visible || t0 > t1) {
      flush();
      continue;
    }
    const start: Point = [a[0] + dx * t0, a[1] + dy * t0];
    const end: Point = [a[0] + dx * t1, a[1] + dy * t1];
    if (current.length === 0 || t0 > 0) {
      flush();
      current.push(start);
    }
    current.push(end);
    if (t1 < 1) flush();
  }
  flush();
  return result;
}

/** Join way fragments end to end into closed rings (OSM splits big multipolygon rings across ways). */
export function assembleRings(segments: readonly (readonly Point[])[]): Point[][] {
  const same = (a: Point, b: Point): boolean => a[0] === b[0] && a[1] === b[1];
  const pool: Point[][] = segments.filter((s) => s.length >= 2).map((s) => [...s]);
  const rings: Point[][] = [];
  while (pool.length > 0) {
    let cur = pool.pop()!;
    let grew = true;
    while (grew && !(cur.length >= 4 && same(cur[0], cur[cur.length - 1]))) {
      grew = false;
      for (let i = 0; i < pool.length; i++) {
        const s = pool[i];
        const head = cur[0];
        const tail = cur[cur.length - 1];
        let joined: Point[] | null = null;
        if (same(tail, s[0])) joined = cur.concat(s.slice(1));
        else if (same(tail, s[s.length - 1])) joined = cur.concat(s.slice(0, -1).reverse());
        else if (same(head, s[s.length - 1])) joined = s.slice(0, -1).concat(cur);
        else if (same(head, s[0])) joined = s.slice(1).reverse().concat(cur);
        if (joined) {
          cur = joined;
          pool.splice(i, 1);
          grew = true;
          break;
        }
      }
    }
    if (cur.length >= 4 && same(cur[0], cur[cur.length - 1])) rings.push(cur.slice(0, -1));
  }
  return rings;
}

// ---------- tag parsing ----------

/** "12", "12.5 m", "40 ft", "12,5" to metres. Null when it is not a length. */
export function parseMeters(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^\s*(-?\d+(?:[.,]\d+)?)\s*(m|meters?|metres?|ft|feet|')?\s*$/i.exec(value);
  if (!m) return null;
  const n = parseFloat((m[1] ?? '').replace(',', '.'));
  if (!Number.isFinite(n)) return null;
  const unit = (m[2] ?? 'm').toLowerCase();
  return unit === 'ft' || unit === 'feet' || unit === "'" ? n * 0.3048 : n;
}

/** First whole number in a levels tag ("5", "5;6", "5-6"). Null when absent or not positive. */
export function parseLevels(value: string | undefined): number | null {
  if (!value) return null;
  const m = /\d+(?:[.,]\d+)?/.exec(value);
  if (!m) return null;
  const n = Math.round(parseFloat(m[0].replace(',', '.')));
  return n > 0 ? n : null;
}

const HOUSE = new Set([
  'house',
  'detached',
  'semidetached_house',
  'terrace',
  'bungalow',
  'cabin',
  'farm',
  'villa',
  'hut',
  'static_caravan',
]);
const APARTMENTS = new Set(['apartments', 'dormitory', 'hotel', 'block']);
const COMMERCIAL = new Set([
  'commercial',
  'retail',
  'office',
  'supermarket',
  'shop',
  'bank',
  'mall',
]);
const INDUSTRIAL = new Set([
  'industrial',
  'warehouse',
  'factory',
  'manufacture',
  'storage_tank',
  'silo',
  'hangar',
  'service',
]);
const CIVIC = new Set([
  'civic',
  'public',
  'government',
  'school',
  'kindergarten',
  'hospital',
  'university',
  'college',
  'fire_station',
  'train_station',
  'transportation',
  'museum',
  'theatre',
  'stadium',
  'sports_hall',
  'sports_centre',
  'library',
  'townhall',
  'clinic',
]);
const RELIGIOUS = new Set([
  'religious',
  'mosque',
  'church',
  'cathedral',
  'chapel',
  'temple',
  'synagogue',
  'shrine',
  'monastery',
]);
const GARAGE = new Set([
  'garage',
  'garages',
  'carport',
  'shed',
  'roof',
  'parking',
  'greenhouse',
  'barn',
  'stable',
  'cowshed',
  'toilets',
  'container',
  'kiosk',
]);

/** Group OSM's many building values into the handful of looks the game has. */
export function classifyBuilding(tags: Record<string, string>, area: number): BuildingKind {
  const b = tags.building ?? 'yes';
  if (RELIGIOUS.has(b) || tags.amenity === 'place_of_worship') return 'religious';
  if (GARAGE.has(b)) return 'garage';
  if (INDUSTRIAL.has(b)) return 'industrial';
  if (
    CIVIC.has(b) ||
    ['school', 'hospital', 'university', 'college', 'kindergarten', 'clinic'].includes(
      tags.amenity ?? '',
    )
  )
    return 'civic';
  if (COMMERCIAL.has(b) || tags.shop || tags.office) return 'commercial';
  if (APARTMENTS.has(b) || tags.tourism === 'hotel') return 'apartments';
  const levels = parseLevels(tags['building:levels']) ?? 0;
  if (b === 'residential') return area > 380 || levels >= 4 ? 'apartments' : 'house';
  if (HOUSE.has(b)) return 'house';
  if (b === 'yes' && levels >= 4) return 'apartments';
  return 'other';
}

/** A believable wall height for a building that OSM gives no height for. Deterministic per id. */
export function estimateHeight(kind: BuildingKind, area: number, id: number): number {
  const r = hash01(id, 7);
  const pick = (levels: number): number => levels * 3.1;
  switch (kind) {
    case 'house':
      return pick(r < 0.7 ? 1 : 2) + (r < 0.7 ? 0.4 : 0);
    case 'apartments': {
      // Soviet-era Tashkent: mostly 5 and 9 storeys, some 4, 12 and 16.
      const levels = r < 0.1 ? 4 : r < 0.6 ? 5 : r < 0.85 ? 9 : r < 0.95 ? 12 : 16;
      return pick(levels);
    }
    case 'commercial':
      return pick(
        area < 300
          ? 2 + Math.floor(r * 2)
          : area < 1500
            ? 3 + Math.floor(r * 2)
            : 4 + Math.floor(r * 4),
      );
    case 'industrial':
      return 6 + r * 4;
    case 'civic':
      return pick(area < 600 ? 2 : 3 + Math.floor(r * 2));
    case 'religious':
      return 9 + r * 5;
    case 'garage':
      return 2.6 + r * 0.8;
    default:
      // Unknown building: scale with footprint, since a small unlabelled box is usually a shed or house.
      if (area < 60) return 3 + r * 0.6;
      if (area < 200) return pick(1 + Math.floor(r * 2));
      if (area < 600) return pick(2 + Math.floor(r * 2));
      if (area < 2000) return pick(3 + Math.floor(r * 3));
      return pick(4 + Math.floor(r * 3));
  }
}

export function buildingHeight(
  tags: Record<string, string>,
  kind: BuildingKind,
  area: number,
  id: number,
): { height: number; estimated: boolean } {
  const clamp = (h: number): number => Math.min(500, Math.max(2.4, h));
  const tagged = parseMeters(tags.height) ?? parseMeters(tags['building:height']);
  if (tagged && tagged > 0) return { height: clamp(tagged), estimated: false };
  const levels = parseLevels(tags['building:levels']);
  if (levels) return { height: clamp(levels * 3.1), estimated: false };
  return { height: clamp(estimateHeight(kind, area, id)), estimated: true };
}

const ROOF_SHAPES = new Set([
  'flat',
  'gabled',
  'hipped',
  'dome',
  'pyramidal',
  'skillion',
  'round',
  'onion',
]);

// ---------- roads, areas, towers ----------

const ROAD_BY_HIGHWAY: Record<string, RoadKind> = {
  motorway: 'motorway',
  motorway_link: 'motorway',
  trunk: 'trunk',
  trunk_link: 'trunk',
  primary: 'primary',
  primary_link: 'primary',
  secondary: 'secondary',
  secondary_link: 'secondary',
  tertiary: 'tertiary',
  tertiary_link: 'tertiary',
  residential: 'residential',
  unclassified: 'residential',
  living_street: 'residential',
  service: 'service',
  track: 'service',
  pedestrian: 'pedestrian',
  footway: 'path',
  path: 'path',
  cycleway: 'path',
  steps: 'path',
  bridleway: 'path',
};

const ROAD_WIDTH: Record<RoadKind, number> = {
  motorway: 14,
  trunk: 14,
  primary: 12,
  secondary: 10,
  tertiary: 8,
  residential: 6,
  service: 4,
  pedestrian: 4,
  path: 1.8,
};

export function roadKindOf(tags: Record<string, string>): RoadKind | null {
  return ROAD_BY_HIGHWAY[tags.highway ?? ''] ?? null;
}

export function roadWidth(tags: Record<string, string>, kind: RoadKind): number {
  const tagged = parseMeters(tags.width);
  if (tagged && tagged >= 1 && tagged <= 60) return tagged;
  const lanes = parseLevels(tags.lanes);
  if (lanes && kind !== 'path' && kind !== 'pedestrian')
    return Math.min(30, Math.max(ROAD_WIDTH[kind] * 0.7, lanes * 3.3 + 1));
  return ROAD_WIDTH[kind];
}

const WATERWAY_WIDTH: Record<WaterwayKind, number> = { river: 18, canal: 10, stream: 3 };

export function areaKindOf(tags: Record<string, string>): AreaKind | null {
  const { natural, landuse, leisure, amenity, place, waterway, highway } = tags;
  if (
    natural === 'water' ||
    landuse === 'reservoir' ||
    landuse === 'basin' ||
    waterway === 'riverbank'
  )
    return 'water';
  if (leisure && /^(park|garden|common|nature_reserve)$/.test(leisure)) return 'park';
  if (leisure && /^(pitch|playground|stadium|sports_centre|track)$/.test(leisure)) return 'sport';
  if (landuse === 'forest' || natural === 'wood' || natural === 'scrub') return 'forest';
  if (landuse && /^(grass|meadow|village_green|recreation_ground)$/.test(landuse)) return 'grass';
  if (natural === 'grassland') return 'grass';
  if (landuse === 'cemetery') return 'cemetery';
  if (landuse && /^(farmland|orchard|vineyard|allotments)$/.test(landuse)) return 'farmland';
  if (natural === 'sand') return 'sand';
  if (amenity === 'parking') return 'parking';
  if (place === 'square' || (highway === 'pedestrian' && tags.area === 'yes')) return 'plaza';
  return null;
}

const TOWER_KINDS = new Set(['tower', 'mast', 'chimney', 'water_tower']);
const TOWER_DEFAULT_HEIGHT: Record<CityTower['kind'], number> = {
  tower: 40,
  mast: 40,
  chimney: 40,
  water_tower: 25,
};

// ---------- the conversion ----------

export interface ConvertOptions {
  id: string;
  name: string;
  /** [longitude, latitude] */
  center: [number, number];
  halfSize: number;
  /**
   * For a tile of a bigger city: where this square's centre is, in metres east and north of `center`.
   * Everything is projected from `center` (so neighbouring tiles line up to the millimetre) and then
   * shifted so the tile's own centre is (0, 0). The offset is written into the output as `origin`.
   */
  origin?: Point;
  /** ISO date stamped into the output. */
  generated: string;
}

/** Round to 0.1 m. The "+ 0" turns -0 into 0. */
const round1 = (n: number): number => Math.round(n * 10) / 10 + 0;
const flatten = (ring: readonly Point[]): number[] =>
  ring.flatMap((p) => [round1(p[0]), round1(p[1])]);

type Geometry = readonly (OverpassPoint | null)[] | undefined;

function toPoints(geometry: Geometry, project: (lon: number, lat: number) => Point): Point[] {
  const out: Point[] = [];
  for (const p of geometry ?? []) if (p) out.push(project(p.lon, p.lat));
  return out;
}

const isClosed = (geometry: Geometry): boolean => {
  const g = (geometry ?? []).filter((p): p is OverpassPoint => p !== null);
  const first = g[0];
  const last = g[g.length - 1];
  return g.length >= 4 && !!first && !!last && first.lat === last.lat && first.lon === last.lon;
};

interface PolygonShape {
  outer: Point[];
  holes: Point[][];
}

/** Rings of a multipolygon relation: outers assembled from member ways, inners attached by containment. */
function relationShapes(
  members: readonly OverpassMember[],
  project: (lon: number, lat: number) => Point,
): PolygonShape[] {
  const outers = assembleRings(
    members
      .filter((m) => m.type === 'way' && m.role !== 'inner')
      .map((m) => toPoints(m.geometry, project)),
  ).map((r) => orient(dedupeRing(r), true));
  const inners = assembleRings(
    members
      .filter((m) => m.type === 'way' && m.role === 'inner')
      .map((m) => toPoints(m.geometry, project)),
  ).map((r) => orient(dedupeRing(r), false));
  const shapes: PolygonShape[] = outers
    .filter((r) => r.length >= 3)
    .map((outer) => ({ outer, holes: [] }));
  for (const hole of inners) {
    const probe = hole[0];
    if (!probe || hole.length < 3) continue;
    const owner = shapes.find((s) => pointInRing(s.outer, probe));
    owner?.holes.push(hole);
  }
  return shapes;
}

/** Turn an Overpass extract into CityData. Output order is by OSM id, so re-runs diff cleanly. */
export function convertOverpass(response: OverpassResponse, options: ConvertOptions): CityData {
  const { halfSize } = options;
  const fromCenter = makeProjector(options.center[0], options.center[1]);
  const [ox, oy] = options.origin ?? [0, 0];
  const project = (lonV: number, latV: number): Point => {
    const p = fromCenter(lonV, latV);
    return [p[0] - ox, p[1] - oy];
  };
  const inside = ([x, y]: Point): boolean => Math.abs(x) <= halfSize && Math.abs(y) <= halfSize;
  const elements = [...response.elements].sort((a, b) => a.id - b.id);

  const buildings: CityBuilding[] = [];
  const roads: CityRoad[] = [];
  const areas: CityArea[] = [];
  const waterways: CityWaterway[] = [];
  const towers: CityTower[] = [];
  const trees: number[] = [];

  const addBuilding = (
    el: OverpassElement,
    tags: Record<string, string>,
    shape: PolygonShape,
  ): void => {
    const outer = dedupeRing(shape.outer);
    const area = Math.abs(signedArea(outer));
    if (outer.length < 3 || area < 6) return;
    if (!inside(ringCentroid(outer))) return;
    const kind = classifyBuilding(tags, area);
    const { height, estimated } = buildingHeight(tags, kind, area, el.id);
    const roof = ROOF_SHAPES.has(tags['roof:shape'] ?? '') ? tags['roof:shape'] : undefined;
    const holes = shape.holes.map((h) => dedupeRing(h)).filter((h) => h.length >= 3);
    const building: CityBuilding = {
      id: el.id,
      outer: flatten(orient(outer, true)),
      height: round1(height),
      estimated,
      kind,
    };
    if (holes.length > 0) building.holes = holes.map((h) => flatten(orient(h, false)));
    if (roof) building.roof = roof;
    if (tags.name) building.name = tags.name.slice(0, 48);
    buildings.push(building);
  };

  const addArea = (kind: AreaKind, shape: PolygonShape): void => {
    const outer = clipRing(orient(dedupeRing(shape.outer), true), halfSize);
    if (outer.length < 3 || Math.abs(signedArea(outer)) < 8) return;
    const holes = shape.holes
      .map((h) => clipRing(orient(dedupeRing(h), false), halfSize))
      .filter((h) => h.length >= 3 && Math.abs(signedArea(h)) >= 4);
    const area: CityArea = { kind, outer: flatten(outer) };
    if (holes.length > 0) area.holes = holes.map((h) => flatten(orient(h, false)));
    areas.push(area);
  };

  for (const el of elements) {
    const tags = el.tags ?? {};

    if (el.type === 'node') {
      if (el.lat === undefined || el.lon === undefined) continue;
      const p = project(el.lon, el.lat);
      if (!inside(p)) continue;
      if (tags.natural === 'tree') trees.push(round1(p[0]), round1(p[1]));
      const tk = tags.man_made;
      if (tk && TOWER_KINDS.has(tk)) towers.push(towerAt(p, tk as CityTower['kind'], tags));
      continue;
    }

    if (el.type === 'relation') {
      if (tags.type !== 'multipolygon' || !el.members) continue;
      const shapes = relationShapes(el.members, project);
      if (tags.building && tags.building !== 'no') for (const s of shapes) addBuilding(el, tags, s);
      else {
        const kind = areaKindOf(tags);
        if (kind) for (const s of shapes) addArea(kind, s);
      }
      continue;
    }

    // ways
    const pts = toPoints(el.geometry, project);
    if (pts.length < 2) continue;
    const closed = isClosed(el.geometry);

    if (tags.building && tags.building !== 'no') {
      if (closed) addBuilding(el, tags, { outer: orient(dedupeRing(pts), true), holes: [] });
      continue;
    }

    const tk = tags.man_made;
    if (tk && TOWER_KINDS.has(tk)) {
      const c = closed ? ringCentroid(dedupeRing(pts)) : pts[0];
      if (inside(c)) towers.push(towerAt(c, tk as CityTower['kind'], tags));
      continue;
    }

    if (tags.highway) {
      const kind = roadKindOf(tags);
      if (
        kind &&
        tags.area !== 'yes' &&
        !/^(yes|building_passage|culvert)$/.test(tags.tunnel ?? '')
      ) {
        const width = round1(roadWidth(tags, kind));
        const bridge = !!tags.bridge && tags.bridge !== 'no';
        for (const piece of clipLine(pts, halfSize)) {
          const length = piece.reduce(
            (s, p, i) =>
              i === 0 ? 0 : s + Math.hypot(p[0] - piece[i - 1][0], p[1] - piece[i - 1][1]),
            0,
          );
          if (length < 2) continue;
          const road: CityRoad = { kind, points: flatten(piece), width };
          if (bridge) road.bridge = true;
          if (tags.name && (kind === 'primary' || kind === 'secondary' || kind === 'tertiary'))
            road.name = tags.name.slice(0, 40);
          roads.push(road);
        }
        continue;
      }
    }

    const waterway = tags.waterway;
    if (waterway === 'river' || waterway === 'canal' || waterway === 'stream') {
      const width = parseMeters(tags.width) ?? WATERWAY_WIDTH[waterway];
      for (const piece of clipLine(pts, halfSize))
        waterways.push({ kind: waterway, points: flatten(piece), width: round1(width) });
      continue;
    }

    const kind = areaKindOf(tags);
    if (kind && closed) addArea(kind, { outer: dedupeRing(pts), holes: [] });
  }

  return {
    version: 1,
    id: options.id,
    name: options.name,
    center: options.center,
    halfSize,
    ...(options.origin ? { origin: [round1(ox), round1(oy)] as [number, number] } : {}),
    buildings,
    roads,
    areas,
    waterways,
    trees,
    towers,
    attribution: '© OpenStreetMap contributors (ODbL)',
    generated: options.generated,
  };
}

function towerAt(p: Point, kind: CityTower['kind'], tags: Record<string, string>): CityTower {
  const tower: CityTower = {
    x: round1(p[0]),
    y: round1(p[1]),
    height: round1(parseMeters(tags.height) ?? TOWER_DEFAULT_HEIGHT[kind]),
    kind,
  };
  if (tags.name) tower.name = tags.name.slice(0, 48);
  return tower;
}
