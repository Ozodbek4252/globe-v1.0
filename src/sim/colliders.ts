// What a walking person cannot pass through: building walls (as line segments), tree trunks and
// lamp posts (as small circles), and water (as a fine grid, with bridges as exceptions). Pure: no DOM,
// no Three.js. Walls are line segments, not grid cells, so a person slides smoothly along a wall at
// any angle instead of stepping along a staircase.

import {
  OCC_BRIDGE,
  OCC_BUILDING,
  OCC_WATER,
  createGrid,
  occupancyAt,
  rasterizePolygon,
  stampPolyline,
  type Grid,
} from './grid';

export interface RingSource {
  outer: readonly number[];
  holes?: readonly (readonly number[])[];
}

/** The parts of a city the colliders are built from. CityData has exactly this shape. */
export interface ColliderSource {
  halfSize: number;
  buildings: readonly RingSource[];
  areas: readonly (RingSource & { kind: string })[];
  waterways: readonly { points: readonly number[]; width: number }[];
  roads: readonly { points: readonly number[]; width: number; bridge?: boolean }[];
}

/** Round obstacles: `data` holds an x, y pair every `stride` numbers, each `radius` metres wide. */
export interface Obstacles {
  data: ArrayLike<number>;
  stride: number;
  count: number;
  radius: number;
}

export interface Colliders {
  /** The play area is the square -half to +half. */
  half: number;
  /** Side of a spatial-hash cell, in metres. */
  cell: number;
  cols: number;
  /** Where the hash grid starts (its lower-left corner), in metres. */
  origin: number;
  /** x0, y0, x1, y1 for each wall segment. */
  segments: Float32Array;
  segCount: number;
  segStart: Int32Array;
  segItems: Int32Array;
  /** x, y, radius for each round obstacle. */
  circles: Float32Array;
  circleCount: number;
  circStart: Int32Array;
  circItems: Int32Array;
  /** Water, bridges and building interiors, in 1 m cells. */
  field: Grid;
  // scratch space for de-duplicating the result of a query; it never changes any answer
  seenSeg: Int32Array;
  seenCirc: Int32Array;
  stamp: { value: number };
}

const CELL = 8;

/** Build the collision world for a city. `obstacles` are things like trees and lamp posts. */
export function buildColliders(
  source: ColliderSource,
  obstacles: readonly Obstacles[] = [],
): Colliders {
  const half = source.halfSize;
  const reach = half + 40; // buildings at the edge can overhang the play area a little
  const origin = -reach;
  const cols = Math.ceil((reach * 2) / CELL);

  // ---- wall segments from every building ring
  const segs: number[] = [];
  const addRing = (ring: readonly number[]): void => {
    const n = ring.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = ring[i * 2];
      const y0 = ring[i * 2 + 1];
      const x1 = ring[j * 2];
      const y1 = ring[j * 2 + 1];
      if (x0 === x1 && y0 === y1) continue;
      segs.push(x0, y0, x1, y1);
    }
  };
  for (const b of source.buildings) {
    addRing(b.outer);
    for (const h of b.holes ?? []) addRing(h);
  }
  const segments = Float32Array.from(segs);
  const segCount = segments.length / 4;

  // ---- round obstacles
  const circ: number[] = [];
  for (const set of obstacles) {
    for (let i = 0; i < set.count; i++) {
      circ.push(set.data[i * set.stride], set.data[i * set.stride + 1], set.radius);
    }
  }
  const circles = Float32Array.from(circ);
  const circleCount = circles.length / 3;

  const cellOf = (v: number): number =>
    Math.max(0, Math.min(cols - 1, Math.floor((v - origin) / CELL)));

  // ---- spatial hashes in compressed row form: start[cell]..start[cell+1] indexes into items
  const segHash = hashByBounds(segCount, cols, (i, out) => {
    const x0 = segments[i * 4];
    const y0 = segments[i * 4 + 1];
    const x1 = segments[i * 4 + 2];
    const y1 = segments[i * 4 + 3];
    out[0] = cellOf(Math.min(x0, x1));
    out[1] = cellOf(Math.min(y0, y1));
    out[2] = cellOf(Math.max(x0, x1));
    out[3] = cellOf(Math.max(y0, y1));
  });
  const circHash = hashByBounds(circleCount, cols, (i, out) => {
    const x = circles[i * 3];
    const y = circles[i * 3 + 1];
    const r = circles[i * 3 + 2];
    out[0] = cellOf(x - r);
    out[1] = cellOf(y - r);
    out[2] = cellOf(x + r);
    out[3] = cellOf(y + r);
  });

  // ---- water and building interiors (fine grid), with bridges as exceptions
  const field = createGrid(half, 1);
  for (const b of source.buildings) rasterizePolygon(field, b.outer, b.holes, OCC_BUILDING);
  for (const a of source.areas) {
    if (a.kind === 'water') rasterizePolygon(field, a.outer, a.holes, OCC_WATER);
  }
  for (const w of source.waterways) stampPolyline(field, w.points, w.width / 2, OCC_WATER);
  for (const r of source.roads) {
    if (r.bridge) stampPolyline(field, r.points, r.width / 2 + 0.6, OCC_BRIDGE);
  }

  return {
    half,
    cell: CELL,
    cols,
    origin,
    segments,
    segCount,
    segStart: segHash.start,
    segItems: segHash.items,
    circles,
    circleCount,
    circStart: circHash.start,
    circItems: circHash.items,
    field,
    seenSeg: new Int32Array(segCount),
    seenCirc: new Int32Array(circleCount),
    stamp: { value: 0 },
  };
}

/** Bucket `count` things by the cells their bounding box covers. */
function hashByBounds(
  count: number,
  cols: number,
  bounds: (index: number, out: Int32Array) => void,
): { start: Int32Array; items: Int32Array } {
  const cells = cols * cols;
  const start = new Int32Array(cells + 1);
  const box = new Int32Array(4);
  for (let i = 0; i < count; i++) {
    bounds(i, box);
    for (let cy = box[1]; cy <= box[3]; cy++)
      for (let cx = box[0]; cx <= box[2]; cx++) start[cy * cols + cx + 1]++;
  }
  for (let c = 0; c < cells; c++) start[c + 1] += start[c];
  const items = new Int32Array(start[cells]);
  const fill = start.slice(0, cells);
  for (let i = 0; i < count; i++) {
    bounds(i, box);
    for (let cy = box[1]; cy <= box[3]; cy++) {
      for (let cx = box[0]; cx <= box[2]; cx++) items[fill[cy * cols + cx]++] = i;
    }
  }
  return { start, items };
}

/** Closest point on a segment to a point. */
function closestOnSegment(
  px: number,
  py: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  out: [number, number],
): void {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x0) * dx + (py - y0) * dy) / len2));
  out[0] = x0 + dx * t;
  out[1] = y0 + dy * t;
}

const nearest: [number, number] = [0, 0];

/** Whether the straight path from one point to another crosses any wall (a short path: only the walls near it are checked). */
function crossesWall(c: Colliders, x0: number, y0: number, x1: number, y1: number): boolean {
  const cx = Math.floor(((x0 + x1) / 2 - c.origin) / c.cell);
  const cy = Math.floor(((y0 + y1) / 2 - c.origin) / c.cell);
  const stamp = ++c.stamp.value;
  for (let gy = Math.max(0, cy - 1); gy <= Math.min(c.cols - 1, cy + 1); gy++) {
    for (let gx = Math.max(0, cx - 1); gx <= Math.min(c.cols - 1, cx + 1); gx++) {
      const cell = gy * c.cols + gx;
      for (let k = c.segStart[cell]; k < c.segStart[cell + 1]; k++) {
        const s = c.segItems[k];
        if (c.seenSeg[s] === stamp) continue;
        c.seenSeg[s] = stamp;
        const ax = c.segments[s * 4];
        const ay = c.segments[s * 4 + 1];
        const bx = c.segments[s * 4 + 2];
        const by = c.segments[s * 4 + 3];
        // the two ends of each are on opposite sides of the other
        const d1 = (bx - ax) * (y0 - ay) - (by - ay) * (x0 - ax);
        const d2 = (bx - ax) * (y1 - ay) - (by - ay) * (x1 - ax);
        if (d1 * d2 >= 0) continue;
        const d3 = (x1 - x0) * (ay - y0) - (y1 - y0) * (ax - x0);
        const d4 = (x1 - x0) * (by - y0) - (y1 - y0) * (bx - x0);
        if (d3 * d4 < 0) return true;
      }
    }
  }
  return false;
}

/**
 * Push a circle of radius `r` out of every wall and round obstacle it overlaps. Returns the corrected
 * centre. A few passes settle corners and gaps where two pushes fight.
 */
export function resolveCircle(c: Colliders, x: number, y: number, r: number): [number, number] {
  let px = x;
  let py = y;
  for (let pass = 0; pass < 4; pass++) {
    let moved = false;
    const cx = Math.floor((px - c.origin) / c.cell);
    const cy = Math.floor((py - c.origin) / c.cell);
    const stamp = ++c.stamp.value;
    for (let gy = Math.max(0, cy - 1); gy <= Math.min(c.cols - 1, cy + 1); gy++) {
      for (let gx = Math.max(0, cx - 1); gx <= Math.min(c.cols - 1, cx + 1); gx++) {
        const cell = gy * c.cols + gx;
        for (let k = c.segStart[cell]; k < c.segStart[cell + 1]; k++) {
          const s = c.segItems[k];
          if (c.seenSeg[s] === stamp) continue;
          c.seenSeg[s] = stamp;
          const x0 = c.segments[s * 4];
          const y0 = c.segments[s * 4 + 1];
          const x1 = c.segments[s * 4 + 2];
          const y1 = c.segments[s * 4 + 3];
          closestOnSegment(px, py, x0, y0, x1, y1, nearest);
          const dx = px - nearest[0];
          const dy = py - nearest[1];
          const d2 = dx * dx + dy * dy;
          if (d2 >= r * r) continue;
          const d = Math.sqrt(d2);
          if (d > 1e-6) {
            px += (dx / d) * (r - d);
            py += (dy / d) * (r - d);
          } else {
            // exactly on the wall: step out along its normal
            const len = Math.hypot(x1 - x0, y1 - y0) || 1;
            px += (-(y1 - y0) / len) * r;
            py += ((x1 - x0) / len) * r;
          }
          moved = true;
        }
        for (let k = c.circStart[cell]; k < c.circStart[cell + 1]; k++) {
          const o = c.circItems[k];
          if (c.seenCirc[o] === stamp) continue;
          c.seenCirc[o] = stamp;
          const ox = c.circles[o * 3];
          const oy = c.circles[o * 3 + 1];
          const reach = r + c.circles[o * 3 + 2];
          const dx = px - ox;
          const dy = py - oy;
          const d2 = dx * dx + dy * dy;
          if (d2 >= reach * reach) continue;
          const d = Math.sqrt(d2);
          if (d > 1e-6) {
            px += (dx / d) * (reach - d);
            py += (dy / d) * (reach - d);
          } else {
            px += reach;
          }
          moved = true;
        }
      }
    }
    if (!moved) break;
  }
  return [px, py];
}

/** Distance from a point to the nearest wall or round obstacle's edge, up to `max` metres. */
export function clearance(c: Colliders, x: number, y: number, max = 8): number {
  let best = max;
  const cx = Math.floor((x - c.origin) / c.cell);
  const cy = Math.floor((y - c.origin) / c.cell);
  for (let gy = Math.max(0, cy - 1); gy <= Math.min(c.cols - 1, cy + 1); gy++) {
    for (let gx = Math.max(0, cx - 1); gx <= Math.min(c.cols - 1, cx + 1); gx++) {
      const cell = gy * c.cols + gx;
      for (let k = c.segStart[cell]; k < c.segStart[cell + 1]; k++) {
        const s = c.segItems[k];
        closestOnSegment(
          x,
          y,
          c.segments[s * 4],
          c.segments[s * 4 + 1],
          c.segments[s * 4 + 2],
          c.segments[s * 4 + 3],
          nearest,
        );
        best = Math.min(best, Math.hypot(x - nearest[0], y - nearest[1]));
      }
      for (let k = c.circStart[cell]; k < c.circStart[cell + 1]; k++) {
        const o = c.circItems[k];
        best = Math.min(
          best,
          Math.hypot(x - c.circles[o * 3], y - c.circles[o * 3 + 1]) - c.circles[o * 3 + 2],
        );
      }
    }
  }
  return Math.max(0, best);
}

/** True if the point is inside a building (to the nearest metre). Clearance alone cannot tell, since the middle of a big building is far from every wall. */
export function insideBuilding(c: Colliders, x: number, y: number): boolean {
  return (occupancyAt(c.field, x, y) & OCC_BUILDING) !== 0;
}

/** True if any part of a circle at (x, y) is in water that has no bridge over it. */
export function inWater(c: Colliders, x: number, y: number, r: number): boolean {
  for (const [dx, dy] of [
    [0, 0],
    [r, 0],
    [-r, 0],
    [0, r],
    [0, -r],
  ] as const) {
    const bits = occupancyAt(c.field, x + dx, y + dy);
    if ((bits & OCC_WATER) !== 0 && (bits & OCC_BRIDGE) === 0) return true;
  }
  return false;
}

/**
 * Move a circle from one point to another, sliding along walls and stopping at the water's edge.
 * Returns where it ends up. Safe for any step shorter than the circle's radius.
 */
export function moveCircle(
  c: Colliders,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  r: number,
): [number, number] {
  const limit = c.half - r;
  const clampPoint = (x: number, y: number): [number, number] => [
    Math.max(-limit, Math.min(limit, x)),
    Math.max(-limit, Math.min(limit, y)),
  ];
  const [targetX, targetY] = clampPoint(toX, toY);
  const [rx, ry] = resolveCircle(c, targetX, targetY, r);
  const [x, y] = clampPoint(rx, ry);
  // Wedged in a gap too narrow for the body (a funnel between two buildings, say), the body already
  // overlaps a wall, so a step can end beyond it; and the pushes of the walls cannot all be answered,
  // so what comes out is a compromise that can be on the far side. A body never crosses a wall: such a
  // move is refused. (Only a step that touched something needs checking; most in open ground do not.)
  if (Math.hypot(rx - targetX, ry - targetY) > 1e-6 && crossesWall(c, fromX, fromY, x, y)) {
    return [fromX, fromY];
  }
  if (!inWater(c, x, y, r) || inWater(c, fromX, fromY, r)) return [x, y]; // a person already in water may wade out
  // water ahead: slide along the shore on whichever axis is still free
  const alongX = clampPoint(resolveCircle(c, toX, fromY, r)[0], fromY);
  const alongY = clampPoint(fromX, resolveCircle(c, fromX, toY, r)[1]);
  const freeX = !inWater(c, alongX[0], alongX[1], r);
  const freeY = !inWater(c, alongY[0], alongY[1], r);
  if (freeX && freeY) {
    return Math.abs(toX - fromX) >= Math.abs(toY - fromY) ? alongX : alongY;
  }
  if (freeX) return alongX;
  if (freeY) return alongY;
  return [fromX, fromY];
}

/**
 * `moveCircle` for a move of any length: split into pieces shorter than the circle's radius, so that
 * something moving fast (or in a long coarse time step) cannot step through a wall.
 */
export function moveCircleLong(
  c: Colliders,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  r: number,
): [number, number] {
  const distance = Math.hypot(toX - fromX, toY - fromY);
  const pieces = Math.ceil(distance / (r * 0.8));
  if (pieces <= 1) return moveCircle(c, fromX, fromY, toX, toY, r);
  const stepX = (toX - fromX) / pieces;
  const stepY = (toY - fromY) / pieces;
  let x = fromX;
  let y = fromY;
  // each piece starts from where the last one ended (a blocked piece leaves it short of the line)
  for (let k = 0; k < pieces; k++) [x, y] = moveCircle(c, x, y, x + stepX, y + stepY, r);
  return [x, y];
}

/**
 * The nearest comfortable standing spot to `near`: clear of walls and trees by `needed` metres and out of
 * the water. Searches in widening rings. Returns `near` if nothing suitable is found within `maxRadius`.
 */
export function findSpawn(
  c: Colliders,
  near: readonly [number, number],
  maxRadius = 200,
  needed = 3,
): [number, number] {
  const ok = (x: number, y: number): boolean =>
    Math.abs(x) < c.half - 5 &&
    Math.abs(y) < c.half - 5 &&
    !insideBuilding(c, x, y) &&
    clearance(c, x, y, needed + 1) >= needed &&
    !inWater(c, x, y, needed);
  if (ok(near[0], near[1])) return [near[0], near[1]];
  for (let radius = 3; radius <= maxRadius; radius += 3) {
    const steps = Math.max(8, Math.ceil((2 * Math.PI * radius) / 3));
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const x = near[0] + Math.cos(a) * radius;
      const y = near[1] + Math.sin(a) * radius;
      if (ok(x, y)) return [x, y];
    }
  }
  return [near[0], near[1]];
}
