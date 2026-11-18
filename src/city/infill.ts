// Houses where OpenStreetMap has the streets but not the buildings. In much of the Fergana Valley
// every lane is mapped and the residential land is drawn, yet only one house in a hundred is: a town
// of 25,000 people shows up as 150 buildings. The game needs buildings (people live in them, shelters
// and the radar are chosen from them), so the missing ones are made up here, deterministically from
// the map: courtyard houses shoulder to shoulder along each street, inside the residential land, clear
// of the roads, the water, the parks and whatever is really mapped. They are marked as estimated and
// carry ids far above any OSM id. Pure: no DOM, no Three.js, no randomness beyond a hash of the input.

import { hash01 } from '../lib/hash.ts';
import {
  OCC_BUILDING,
  OCC_ROAD,
  OCC_WATER,
  createGrid,
  occupancyAt,
  rasterizePolygon,
  stampPolyline,
  type Grid,
} from '../sim/grid.ts';
import type { BuildingKind, CityBuilding, CityData, RoadKind } from './types.ts';

export const INFILL = {
  /** The streets that houses front. */
  fronting: ['residential', 'tertiary', 'secondary'] as readonly RoadKind[],
  /** Streets where, now and then, a bigger building stands instead of a house. */
  bigger: ['tertiary', 'secondary'] as readonly RoadKind[],
  /** From the edge of the road to the front wall, metres. */
  setback: 2.5,
  /** Width along the street, lowest and highest. */
  frontage: [9, 15],
  /** Depth away from the street. */
  depth: [8, 12],
  /** Space between neighbours. */
  gap: [1, 4],
  /** Wall height: one or two storeys. */
  height: [3.2, 6.5],
  /**
   * One frontage in about this many on a bigger street is a block of flats or a public building
   * (big enough for a shelter); on a lane, one in `bigEveryLane` is a school or a clinic.
   */
  bigEvery: 14,
  bigEveryLane: 45,
  /** A house keeps this far from anything already standing, metres. */
  clear: 2,
  /** Grid cell for the checks, metres. */
  cell: 2,
  /** Ids start here, far above any OpenStreetMap way id. */
  firstId: 2_000_000_000,
} as const;

/** Land that is not for building on, even inside the residential rings. */
const RESERVED = 32;
/** Inside one of the rings houses may go in. */
const WITHIN = 64;
/** A house made up here (they may stand wall to wall; only mapped buildings get the clear margin). */
const MADE = 128;
const BLOCKED = OCC_BUILDING | OCC_ROAD | OCC_WATER | RESERVED | MADE;

const lerp = (lo: number, hi: number, t: number): number => lo + (hi - lo) * t;
const round1 = (v: number): number => Math.round(v * 10) / 10;

interface Lot {
  frontage: number;
  depth: number;
  height: number;
  kind: BuildingKind;
}

/** What goes on the next lot along a street: nearly always a house (always, when `plain`). */
function nextLot(kind: RoadKind, seed: number, k: number, plain = false): Lot {
  // mixed twice: one hash of (seed, k) at a stride is not evenly spread enough on its own
  const lot = Math.floor(hash01(seed, k) * 0x7fffffff);
  const r = (salt: number): number => hash01(lot, salt);
  const every = INFILL.bigger.includes(kind) ? INFILL.bigEvery : INFILL.bigEveryLane;
  if (!plain && r(1) < 1 / every) {
    // a four-entrance block of flats, or a school or clinic: either is room enough to shelter in
    return INFILL.bigger.includes(kind) && r(2) < 0.6
      ? {
          frontage: lerp(44, 60, r(3)),
          depth: lerp(12, 14, r(4)),
          height: lerp(10, 13, r(5)),
          kind: 'apartments',
        }
      : {
          frontage: lerp(30, 40, r(3)),
          depth: lerp(14, 18, r(4)),
          height: lerp(6.5, 8, r(5)),
          kind: 'civic',
        };
  }
  return {
    frontage: lerp(INFILL.frontage[0], INFILL.frontage[1], r(3)),
    depth: lerp(INFILL.depth[0], INFILL.depth[1], r(4)),
    height: lerp(INFILL.height[0], INFILL.height[1], r(5)),
    kind: 'house',
  };
}

/**
 * Whether a rectangle (centre c, half-sizes hf along u and hd along n) stands on free residential
 * land, with `clear` metres to spare from any mapped building.
 */
function fits(
  grid: Grid,
  cx: number,
  cy: number,
  ux: number,
  uy: number,
  nx: number,
  ny: number,
  hf: number,
  hd: number,
): boolean {
  // a lattice about 1.5 m apart that always includes the edges, so nothing pokes past a check
  const lattice = (half: number): number[] => {
    const n = Math.max(1, Math.ceil((2 * half) / 1.5));
    return Array.from({ length: n + 1 }, (_, i) => -half + (i * 2 * half) / n);
  };
  const occ = (a: number, b: number): number =>
    occupancyAt(grid, cx + ux * a + nx * b, cy + uy * a + ny * b);
  for (const a of lattice(hf)) {
    for (const b of lattice(hd)) {
      const o = occ(a, b);
      if ((o & WITHIN) === 0 || (o & BLOCKED) !== 0) return false;
    }
  }
  for (const a of lattice(hf + INFILL.clear)) {
    for (const b of lattice(hd + INFILL.clear)) if ((occ(a, b) & OCC_BUILDING) !== 0) return false;
  }
  return true;
}

/**
 * Make up the houses of a map: along every fronting street, on both sides, inside the `within` rings
 * (flat [x0, y0, ...] in metres: the residential land), never on a road, water, a park or a mapped
 * building. The result is the new buildings only, in the map's coordinates, in a fixed order.
 */
export function infillHouses(city: CityData, within: readonly ArrayLike<number>[]): CityBuilding[] {
  const out: CityBuilding[] = [];
  if (within.length === 0) return out;
  const grid = createGrid(city.halfSize, INFILL.cell);
  for (const ring of within) rasterizePolygon(grid, ring, undefined, WITHIN);
  for (const b of city.buildings) rasterizePolygon(grid, b.outer, b.holes, OCC_BUILDING);
  for (const a of city.areas) {
    rasterizePolygon(grid, a.outer, a.holes, a.kind === 'water' ? OCC_WATER : RESERVED);
  }
  for (const w of city.waterways) stampPolyline(grid, w.points, w.width / 2 + 1, OCC_WATER);
  for (const r of city.roads) stampPolyline(grid, r.points, r.width / 2 + 0.5, OCC_ROAD);

  city.roads.forEach((road, roadIndex) => {
    if (!INFILL.fronting.includes(road.kind)) return;
    const offset = road.width / 2 + INFILL.setback;
    const p = road.points;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i];
      const ay = p[i + 1];
      const dx = p[i + 2] - ax;
      const dy = p[i + 3] - ay;
      const len = Math.hypot(dx, dy);
      if (len < INFILL.frontage[0]) continue;
      const ux = dx / len;
      const uy = dy / len;
      for (const side of [1, -1]) {
        const nx = -uy * side;
        const ny = ux * side;
        const seed = (roadIndex * 131 + i) * 2 + (side > 0 ? 0 : 1);
        let s = lerp(0, INFILL.gap[1], hash01(seed, 0));
        for (let k = 0; s < len; k++) {
          let lot = nextLot(road.kind, seed, k * 2 + 2);
          // a big building that does not fit in what is left of the street gives way to a house
          if (lot.kind !== 'house' && s + lot.frontage > len)
            lot = nextLot(road.kind, seed, k * 2 + 2, true);
          const hf = lot.frontage / 2;
          const hd = lot.depth / 2;
          if (s + lot.frontage > len) break;
          const mid = s + hf;
          const cx = ax + ux * mid + nx * (offset + hd);
          const cy = ay + uy * mid + ny * (offset + hd);
          if (fits(grid, cx, cy, ux, uy, nx, ny, hf, hd)) {
            const corners = [
              [cx - ux * hf - nx * hd, cy - uy * hf - ny * hd],
              [cx + ux * hf - nx * hd, cy + uy * hf - ny * hd],
              [cx + ux * hf + nx * hd, cy + uy * hf + ny * hd],
              [cx - ux * hf + nx * hd, cy - uy * hf + ny * hd],
            ];
            // outer rings run counter-clockwise
            let area = 0;
            for (let c = 0; c < 4; c++) {
              const [x0, y0] = corners[c];
              const [x1, y1] = corners[(c + 1) % 4];
              area += x0 * y1 - x1 * y0;
            }
            if (area < 0) corners.reverse();
            const outer = corners.flatMap(([x, y]) => [round1(x), round1(y)]);
            rasterizePolygon(grid, outer, undefined, MADE);
            out.push({
              id: INFILL.firstId + out.length,
              outer,
              height: round1(lot.height),
              estimated: true,
              kind: lot.kind,
            });
          }
          s += lot.frontage + lerp(INFILL.gap[0], INFILL.gap[1], hash01(seed, k * 2 + 1));
        }
      }
    }
  });
  return out;
}
