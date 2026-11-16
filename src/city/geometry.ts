// Turns CityData into mesh data (typed arrays). Pure: no DOM, no Three.js, so it can be unit tested.
//
// City space is x east, y north, z up (metres). Every vertex is written to the output in Three.js
// space (x east, y up, z south), which is a proper rotation, so triangle winding carries over: a
// triangle that is counter-clockwise seen from outside in city space is the same in Three.js space.

import earcut from 'earcut';
import { hash01 } from '../lib/hash';
import { pointInFlatRing } from '../sim/grid';
import {
  ASPHALT,
  DOME,
  GROUND,
  PATH,
  ROOF_PROP,
  ROOFS,
  WALLS,
  WATER,
  mix,
  scale,
  srgb,
  type Rgb,
} from './palette';
import type { CityArea, CityBuilding, CityRoad, CityTower, CityWaterway, RoadKind } from './types';

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  uvs: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

export interface MeshBuilder {
  /** Add a vertex given in city space; returns its index. */
  vertex(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    u: number,
    v: number,
    color: Rgb,
  ): number;
  triangle(a: number, b: number, c: number): void;
  /** Two triangles (a, b, c) and (a, c, d). */
  quad(a: number, b: number, c: number, d: number): void;
  vertexCount(): number;
  finish(): MeshData;
}

export function createMeshBuilder(): MeshBuilder {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];
  return {
    vertex(x, y, z, nx, ny, nz, u, v, color) {
      positions.push(x, z, -y);
      normals.push(nx, nz, -ny);
      uvs.push(u, v);
      colors.push(color[0], color[1], color[2]);
      return positions.length / 3 - 1;
    },
    triangle(a, b, c) {
      indices.push(a, b, c);
    },
    quad(a, b, c, d) {
      indices.push(a, b, c, a, c, d);
    },
    vertexCount: () => positions.length / 3,
    finish: () => ({
      positions: Float32Array.from(positions),
      normals: Float32Array.from(normals),
      uvs: Float32Array.from(uvs),
      colors: Float32Array.from(colors),
      indices: Uint32Array.from(indices),
    }),
  };
}

/** The facade texture is a grid of window cells; walls are mapped so one cell is one window bay. */
export const FACADE = { cols: 8, rows: 8, tileW: 3.3, tileH: 3.1 } as const;

const pick = <T>(items: readonly T[], r: number): T =>
  items[Math.min(items.length - 1, Math.floor(r * items.length))];

// ---------- triangulation ----------

/** Triangulate a polygon with holes. Returns the vertex coordinates and CCW triangle indices. */
export function triangulate(
  outer: readonly number[],
  holes?: readonly (readonly number[])[],
): { coords: number[]; indices: number[] } {
  const coords = [...outer];
  const holeStarts: number[] = [];
  for (const h of holes ?? []) {
    holeStarts.push(coords.length / 2);
    coords.push(...h);
  }
  const raw = earcut(coords, holeStarts.length > 0 ? holeStarts : undefined, 2);
  const indices: number[] = [];
  for (let i = 0; i < raw.length; i += 3) {
    const a = raw[i];
    const b = raw[i + 1];
    const c = raw[i + 2];
    const cross =
      (coords[b * 2] - coords[a * 2]) * (coords[c * 2 + 1] - coords[a * 2 + 1]) -
      (coords[b * 2 + 1] - coords[a * 2 + 1]) * (coords[c * 2] - coords[a * 2]);
    // Slivers under 0.01 m² are invisible, and 32-bit vertex positions can flip their winding.
    if (Math.abs(cross) < 0.02) continue;
    if (cross > 0) indices.push(a, b, c);
    else indices.push(a, c, b);
  }
  return { coords, indices };
}

/** Add a flat polygon at height z, facing up. */
export function addFlatPolygon(
  mesh: MeshBuilder,
  outer: readonly number[],
  holes: readonly (readonly number[])[] | undefined,
  z: number,
  color: Rgb,
  uvScale = 0.05,
): void {
  const { coords, indices } = triangulate(outer, holes);
  const base = mesh.vertexCount();
  for (let i = 0; i < coords.length; i += 2) {
    const x = coords[i];
    const y = coords[i + 1];
    mesh.vertex(x, y, z, 0, 0, 1, x * uvScale, y * uvScale, color);
  }
  for (let i = 0; i < indices.length; i += 3) {
    mesh.triangle(base + indices[i], base + indices[i + 1], base + indices[i + 2]);
  }
}

// ---------- buildings ----------

/** Wall quads around a ring (outer rings run CCW, holes CW, so the normal always points away from the solid). */
function addWalls(
  mesh: MeshBuilder,
  ring: readonly number[],
  height: number,
  color: Rgb,
  uOffset: number,
  vRow: number,
): void {
  const n = ring.length / 2;
  const ao = 0.7 + 0.2 * Math.min(1, height / 30);
  const bottom = scale(color, ao);
  const spanU = FACADE.tileW * FACADE.cols;
  let along = 0;
  for (let i = 0; i < n; i++) {
    const x0 = ring[i * 2];
    const y0 = ring[i * 2 + 1];
    const x1 = ring[((i + 1) % n) * 2];
    const y1 = ring[((i + 1) % n) * 2 + 1];
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 0.05) continue;
    const nx = dy / len;
    const ny = -dx / len;
    const u0 = (along + uOffset) / spanU;
    const u1 = (along + len + uOffset) / spanU;
    const v0 = vRow / FACADE.rows;
    const v1 = (vRow + height / FACADE.tileH) / FACADE.rows;
    const b0 = mesh.vertex(x0, y0, 0, nx, ny, 0, u0, v0, bottom);
    const b1 = mesh.vertex(x1, y1, 0, nx, ny, 0, u1, v0, bottom);
    const t1 = mesh.vertex(x1, y1, height, nx, ny, 0, u1, v1, color);
    const t0 = mesh.vertex(x0, y0, height, nx, ny, 0, u0, v1, color);
    mesh.quad(b0, b1, t1, t0);
    along += len;
  }
}

/** An upright box with its base at z0, rotated by `angle` about its centre. Top and four sides. */
function addBox(
  mesh: MeshBuilder,
  cx: number,
  cy: number,
  z0: number,
  w: number,
  d: number,
  h: number,
  angle: number,
  color: Rgb,
): void {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const corner = (sx: number, sy: number): [number, number] => [
    cx + (sx * w * c - sy * d * s) / 2,
    cy + (sx * w * s + sy * d * c) / 2,
  ];
  const ring = [corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)]; // CCW
  const side = scale(color, 0.85);
  for (let i = 0; i < 4; i++) {
    const [x0, y0] = ring[i];
    const [x1, y1] = ring[(i + 1) % 4];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const nx = (y1 - y0) / len;
    const ny = -(x1 - x0) / len;
    const b0 = mesh.vertex(x0, y0, z0, nx, ny, 0, 0, 0, side);
    const b1 = mesh.vertex(x1, y1, z0, nx, ny, 0, 0, 0, side);
    const t1 = mesh.vertex(x1, y1, z0 + h, nx, ny, 0, 0, 0, side);
    const t0 = mesh.vertex(x0, y0, z0 + h, nx, ny, 0, 0, 0, side);
    mesh.quad(b0, b1, t1, t0);
  }
  const a = mesh.vertex(ring[0][0], ring[0][1], z0 + h, 0, 0, 1, 0, 0, color);
  const b = mesh.vertex(ring[1][0], ring[1][1], z0 + h, 0, 0, 1, 0, 0, color);
  const cc = mesh.vertex(ring[2][0], ring[2][1], z0 + h, 0, 0, 1, 0, 0, color);
  const dd = mesh.vertex(ring[3][0], ring[3][1], z0 + h, 0, 0, 1, 0, 0, color);
  mesh.quad(a, b, cc, dd);
}

/** A list of colours (one per profile band) rather than a single colour. */
const isPalette = (c: Rgb | readonly Rgb[]): c is readonly Rgb[] => typeof c[0] !== 'number';

/** [radius, height] points from the bottom, going outward and then up and inward over the top. */
export type Profile = readonly (readonly [r: number, z: number])[];

/**
 * A surface of revolution about a vertical axis (domes, towers, tanks). Each profile segment is its
 * own band of quads with a flat-per-band normal, smooth around the axis.
 */
export function addRevolve(
  mesh: MeshBuilder,
  cx: number,
  cy: number,
  z0: number,
  profile: Profile,
  segments: number,
  color: Rgb | readonly Rgb[],
): void {
  for (let p = 0; p + 1 < profile.length; p++) {
    const [r0, h0] = profile[p];
    const [r1, h1] = profile[p + 1];
    const dr = r1 - r0;
    const dz = h1 - h0;
    const len = Math.hypot(dr, dz);
    if (len < 1e-6) continue;
    const nr = dz / len; // outward component of the band's normal
    const nz = -dr / len;
    const col = isPalette(color) ? color[Math.min(p, color.length - 1)] : color;
    // decide the quad order once: its geometric normal must agree with the intended one
    const probe = (r: number, h: number, t: number): [number, number, number] => [
      cx + r * Math.cos(t),
      cy + r * Math.sin(t),
      z0 + h,
    ];
    const pa = probe(r0, h0, 0);
    const pb = probe(r0, h0, 0.3);
    const pc = probe(r1, h1, 0.3);
    const ux = pb[0] - pa[0];
    const uy = pb[1] - pa[1];
    const uz = pb[2] - pa[2];
    const vx = pc[0] - pa[0];
    const vy = pc[1] - pa[1];
    const vz = pc[2] - pa[2];
    const gx = uy * vz - uz * vy;
    const gy = uz * vx - ux * vz;
    const gz = ux * vy - uy * vx;
    const mx = Math.cos(0.15) * nr;
    const my = Math.sin(0.15) * nr;
    const flip = gx * mx + gy * my + gz * nz < 0;
    for (let j = 0; j < segments; j++) {
      const t0 = (j / segments) * Math.PI * 2;
      const t1 = ((j + 1) / segments) * Math.PI * 2;
      const vtx = (r: number, h: number, t: number): number =>
        mesh.vertex(
          cx + r * Math.cos(t),
          cy + r * Math.sin(t),
          z0 + h,
          Math.cos(t) * nr,
          Math.sin(t) * nr,
          nz,
          t / (Math.PI * 2),
          h * 0.05,
          col,
        );
      const a = vtx(r0, h0, t0);
      const b = vtx(r0, h0, t1);
      const c = vtx(r1, h1, t1);
      const d = vtx(r1, h1, t0);
      if (flip) mesh.quad(a, d, c, b);
      else mesh.quad(a, b, c, d);
    }
  }
}

/** Quarter-circle dome profile of a given radius, on a short drum. */
export function domeProfile(radius: number): Profile {
  const profile: [number, number][] = [
    [radius, 0],
    [radius, 1.4],
  ];
  const steps = 5;
  for (let i = 1; i <= steps; i++) {
    const a = (i / steps) * (Math.PI / 2);
    profile.push([radius * Math.cos(a), 1.4 + radius * 0.95 * Math.sin(a)]);
  }
  return profile;
}

/** Longest edge direction of a ring, so rooftop props line up with the building. */
function dominantAngle(ring: readonly number[]): number {
  let best = 0;
  let angle = 0;
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const dx = ring[((i + 1) % n) * 2] - ring[i * 2];
    const dy = ring[((i + 1) % n) * 2 + 1] - ring[i * 2 + 1];
    const len = Math.hypot(dx, dy);
    if (len > best) {
      best = len;
      angle = Math.atan2(dy, dx);
    }
  }
  return angle;
}

const insideSolid = (b: CityBuilding, x: number, y: number): boolean =>
  pointInFlatRing(b.outer, x, y) && !(b.holes ?? []).some((h) => pointInFlatRing(h, x, y));

/** Footprint area in square metres (absolute, ignoring holes). */
export function footprintArea(ring: readonly number[]): number {
  let sum = 0;
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    sum += ring[i * 2] * ring[((i + 1) % n) * 2 + 1] - ring[((i + 1) % n) * 2] * ring[i * 2 + 1];
  }
  return Math.abs(sum / 2);
}

export interface BuildingMeshes {
  walls: MeshData;
  roofs: MeshData;
}

/** Extrude a group of buildings into wall and roof meshes (they use different materials). */
export function buildBuildings(buildings: readonly CityBuilding[]): BuildingMeshes {
  const walls = createMeshBuilder();
  const roofs = createMeshBuilder();
  for (const b of buildings) {
    const r = (salt: number): number => hash01(b.id, salt);
    const wall = scale(pick(WALLS[b.kind], r(1)), 0.92 + r(2) * 0.16);
    const roof = scale(pick(ROOFS[b.kind], r(3)), 0.9 + r(4) * 0.2);
    const uOffset = r(5) * FACADE.tileW * FACADE.cols;
    const vRow = Math.floor(r(6) * FACADE.rows);

    addWalls(walls, b.outer, b.height, wall, uOffset, vRow);
    for (const hole of b.holes ?? []) addWalls(walls, hole, b.height, wall, uOffset, vRow);
    addFlatPolygon(roofs, b.outer, b.holes, b.height, roof);

    const area = footprintArea(b.outer);

    // Domes on mosques and madrasas, the turquoise Tashkent skyline.
    if ((b.roof === 'dome' || b.kind === 'religious') && area > 120) {
      const [cx, cy] = ringCentre(b.outer);
      const radius = Math.min(9, Math.max(2.2, Math.sqrt(area) * 0.28));
      if (insideSolid(b, cx, cy))
        addRevolve(roofs, cx, cy, b.height, domeProfile(radius), 14, [
          mix(wall, DOME, 0.2),
          DOME,
          DOME,
          DOME,
          DOME,
          DOME,
        ]);
      continue;
    }

    // Rooftop clutter (stair housings, AC units, tanks) so flat roofs are not blank.
    if (area > 150 && b.height > 6 && b.kind !== 'house') {
      const angle = dominantAngle(b.outer);
      const bounds = ringBounds(b.outer);
      const count = Math.floor(r(7) * 3);
      for (let i = 0; i < count; i++) {
        const w = 1.4 + r(10 + i) * 2.4;
        const d = 1.2 + r(20 + i) * 2.2;
        const h = 1 + r(30 + i) * 1.8;
        for (let attempt = 0; attempt < 6; attempt++) {
          const x = bounds[0] + (bounds[2] - bounds[0]) * hash01(b.id, 100 + i * 7 + attempt);
          const y = bounds[1] + (bounds[3] - bounds[1]) * hash01(b.id, 200 + i * 7 + attempt);
          const reach = Math.max(w, d) * 0.75;
          const fits = [
            [x - reach, y - reach],
            [x + reach, y - reach],
            [x + reach, y + reach],
            [x - reach, y + reach],
          ].every(([px, py]) => insideSolid(b, px, py));
          if (!fits) continue;
          addBox(roofs, x, y, b.height, w, d, h, angle, scale(ROOF_PROP, 0.85 + r(40 + i) * 0.3));
          break;
        }
      }
    }
  }
  return { walls: walls.finish(), roofs: roofs.finish() };
}

function ringBounds(ring: readonly number[]): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    minX = Math.min(minX, ring[i]);
    maxX = Math.max(maxX, ring[i]);
    minY = Math.min(minY, ring[i + 1]);
    maxY = Math.max(maxY, ring[i + 1]);
  }
  return [minX, minY, maxX, maxY];
}

function ringCentre(ring: readonly number[]): [number, number] {
  const [x0, y0, x1, y1] = ringBounds(ring);
  return [(x0 + x1) / 2, (y0 + y1) / 2];
}

/** Split buildings into square tiles (by footprint centre) so each tile is culled as one mesh. */
export function chunkBuildings(buildings: readonly CityBuilding[], size: number): CityBuilding[][] {
  const tiles = new Map<string, CityBuilding[]>();
  for (const b of buildings) {
    const [cx, cy] = ringCentre(b.outer);
    const key = `${Math.floor(cx / size)},${Math.floor(cy / size)}`;
    const tile = tiles.get(key);
    if (tile) tile.push(b);
    else tiles.set(key, [b]);
  }
  return [...tiles.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, v]) => v);
}

// ---------- roads and water lines ----------

/**
 * A strip of constant width along a polyline. u runs along the line in `uPerMetre` units, v across
 * it from 0 (right edge) to 1 (left edge).
 *
 * Gentle bends get a mitred join. Where the turn is sharp, or the segments are too short for a clean
 * mitre (the inner edge would cross itself and fold), the strip ends with a flat cap and a round
 * disc covers the joint instead.
 */
export function addRibbon(
  mesh: MeshBuilder,
  points: readonly number[],
  width: number,
  z: number,
  color: Rgb,
  uPerMetre: number,
): void {
  // drop repeated points
  const pts: [number, number][] = [];
  for (let i = 0; i < points.length; i += 2) {
    const last = pts[pts.length - 1];
    const p: [number, number] = [points[i], points[i + 1]];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 0.05) pts.push(p);
  }
  if (pts.length < 2) return;
  const half = width / 2;

  const dirs: [number, number][] = [];
  const lengths: number[] = [];
  const along: number[] = [0];
  for (let i = 0; i + 1 < pts.length; i++) {
    const dx = pts[i + 1][0] - pts[i][0];
    const dy = pts[i + 1][1] - pts[i][1];
    const len = Math.hypot(dx, dy);
    dirs.push([dx / len, dy / len]);
    lengths.push(len);
    along.push(along[i] + len);
  }

  // Split into runs that can be mitred; the vertices where it cannot be done get a disc.
  const runs: number[][] = [];
  const discs: number[] = [];
  let run = [0];
  for (let i = 1; i < pts.length - 1; i++) {
    run.push(i);
    const a = dirs[i - 1];
    const b = dirs[i];
    const dot = a[0] * b[0] + a[1] * b[1];
    const tanHalfTurn = Math.sqrt(Math.max(0, (1 - dot) / Math.max(1e-9, 1 + dot)));
    const clean = dot > -0.01 && half * tanHalfTurn <= 0.5 * Math.min(lengths[i - 1], lengths[i]);
    if (!clean) {
      runs.push(run);
      discs.push(i);
      run = [i];
    }
  }
  run.push(pts.length - 1);
  runs.push(run);

  for (const indices of runs) {
    const left: number[] = [];
    const right: number[] = [];
    indices.forEach((i, k) => {
      const first = k === 0;
      const last = k === indices.length - 1;
      const prev = dirs[Math.max(0, i - 1)];
      const next = dirs[Math.min(dirs.length - 1, i)];
      // flat ends use their own segment's direction, interior vertices the bisector
      const seg = first ? next : last ? prev : null;
      let tx = seg ? seg[0] : prev[0] + next[0];
      let ty = seg ? seg[1] : prev[1] + next[1];
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl;
      ty /= tl;
      const nx = -ty;
      const ny = tx;
      const reach = seg ? half : half / Math.max(0.5, nx * -next[1] + ny * next[0]);
      const p = pts[i];
      const u = along[i] * uPerMetre;
      left.push(mesh.vertex(p[0] + nx * reach, p[1] + ny * reach, z, 0, 0, 1, u, 1, color));
      right.push(mesh.vertex(p[0] - nx * reach, p[1] - ny * reach, z, 0, 0, 1, u, 0, color));
    });
    for (let k = 0; k + 1 < left.length; k++) {
      mesh.quad(right[k], right[k + 1], left[k + 1], left[k]);
    }
  }

  // round discs over the sharp joints
  const sides = 10;
  for (const i of discs) {
    const [cx, cy] = pts[i];
    const u = along[i] * uPerMetre;
    const centre = mesh.vertex(cx, cy, z, 0, 0, 1, u, 0.5, color);
    const rim: number[] = [];
    for (let s = 0; s < sides; s++) {
      const t = (s / sides) * Math.PI * 2;
      rim.push(
        mesh.vertex(cx + Math.cos(t) * half, cy + Math.sin(t) * half, z, 0, 0, 1, u, 0.5, color),
      );
    }
    for (let s = 0; s < sides; s++) mesh.triangle(centre, rim[s], rim[(s + 1) % sides]);
  }
}

export interface RoadMeshes {
  /** Wide roads, drawn with lane-marking texture. */
  major: MeshData;
  /** Residential and service streets. */
  minor: MeshData;
  /** Footpaths and pedestrian ways. */
  paths: MeshData;
}

const MAJOR: ReadonlySet<RoadKind> = new Set([
  'motorway',
  'trunk',
  'primary',
  'secondary',
  'tertiary',
]);

/** Roads of one kind sit slightly above the next narrower kind so junctions do not z-fight. */
const ROAD_Z: Record<RoadKind, number> = {
  path: 0.04,
  pedestrian: 0.045,
  service: 0.05,
  residential: 0.06,
  tertiary: 0.07,
  secondary: 0.08,
  primary: 0.09,
  trunk: 0.1,
  motorway: 0.11,
};

export function buildRoads(roads: readonly CityRoad[]): RoadMeshes {
  const major = createMeshBuilder();
  const minor = createMeshBuilder();
  const paths = createMeshBuilder();
  roads.forEach((road, i) => {
    const jitter = 0.94 + hash01(i, 11) * 0.12;
    const z = ROAD_Z[road.kind] + (road.bridge ? 0.5 : 0);
    if (road.kind === 'path' || road.kind === 'pedestrian') {
      addRibbon(paths, road.points, road.width, z, scale(PATH, jitter), 0.1);
    } else if (MAJOR.has(road.kind)) {
      // The lane-marking texture carries the asphalt colour itself, so it is only dimmed here.
      addRibbon(major, road.points, road.width, z, [jitter, jitter, jitter], 1 / 8);
    } else {
      addRibbon(minor, road.points, road.width, z, scale(ASPHALT, jitter * 1.08), 0.1);
    }
  });
  return { major: major.finish(), minor: minor.finish(), paths: paths.finish() };
}

// ---------- ground and water ----------

const GROUND_Z: Partial<Record<CityArea['kind'], number>> = {
  sand: 0.01,
  farmland: 0.012,
  forest: 0.014,
  grass: 0.014,
  park: 0.016,
  cemetery: 0.016,
  sport: 0.02,
  plaza: 0.024,
  parking: 0.028,
};

export interface GroundMeshes {
  land: MeshData;
  water: MeshData;
}

export function buildGround(
  areas: readonly CityArea[],
  waterways: readonly CityWaterway[],
): GroundMeshes {
  const land = createMeshBuilder();
  const water = createMeshBuilder();
  areas.forEach((area, i) => {
    const jitter = 0.94 + hash01(i, 21) * 0.12;
    if (area.kind === 'water') addFlatPolygon(water, area.outer, area.holes, 0.03, scale(WATER, 1));
    else
      addFlatPolygon(
        land,
        area.outer,
        area.holes,
        GROUND_Z[area.kind] ?? 0.014,
        scale(GROUND[area.kind], jitter),
      );
  });
  for (const w of waterways) addRibbon(water, w.points, w.width, 0.032, scale(WATER, 1), 0.1);
  return { land: land.finish(), water: water.finish() };
}

// ---------- landmark towers ----------

const CONCRETE = srgb(0xbdb8ac);
const CONCRETE_DARK = srgb(0x8f8b82);
const STEEL = srgb(0xc9ccd0);

function towerProfile(tower: CityTower): { profile: Profile; colors: Rgb[] } {
  const H = tower.height;
  if (tower.kind === 'tower' && H >= 120) {
    // TV tower: splayed concrete base, shaft, a two-tier pod, then a steel mast.
    const pod = H * 0.3;
    const pr = Math.max(6, H * 0.03);
    const shaft = Math.max(2.6, H * 0.011);
    const profile: [number, number][] = [
      [shaft * 4.2, 0],
      [shaft * 1.5, H * 0.1],
      [shaft, pod],
      [shaft, pod + 4],
      [pr * 0.9, pod + 4],
      [pr, pod + 7],
      [pr, pod + 14],
      [pr * 0.7, pod + 17],
      [shaft * 0.8, pod + 17],
      [shaft * 0.8, H * 0.7],
      [shaft * 0.3, H * 0.72],
      [shaft * 0.12, H],
    ];
    const colors = profile
      .slice(1)
      .map((_, i) => (i >= 3 && i <= 8 ? CONCRETE_DARK : i >= 9 ? STEEL : CONCRETE));
    return { profile, colors };
  }
  if (tower.kind === 'chimney') {
    const r = Math.max(1.4, H * 0.045);
    return {
      profile: [
        [r * 1.3, 0],
        [r * 0.8, H],
      ],
      colors: [srgb(0x9b6a55)],
    };
  }
  if (tower.kind === 'water_tower') {
    const r = Math.max(3, H * 0.2);
    return {
      profile: [
        [r * 0.35, 0],
        [r * 0.35, H * 0.62],
        [r, H * 0.66],
        [r, H * 0.9],
        [r * 0.3, H],
      ],
      colors: [CONCRETE, CONCRETE_DARK, CONCRETE_DARK, CONCRETE_DARK],
    };
  }
  const r = Math.max(0.6, H * 0.02);
  return {
    profile: [
      [r * 2.4, 0],
      [r, H * 0.3],
      [r * 0.35, H],
    ],
    colors: [STEEL, STEEL],
  };
}

export function buildTowers(towers: readonly CityTower[]): MeshData {
  const mesh = createMeshBuilder();
  for (const tower of towers) {
    const { profile, colors } = towerProfile(tower);
    addRevolve(mesh, tower.x, tower.y, 0, profile, 16, colors);
  }
  return mesh.finish();
}
