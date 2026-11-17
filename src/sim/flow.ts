// Getting around buildings. A coarse walkability grid for the whole map, and a "flow field": for a
// window around a target (the survivor), the number of steps from every open cell to that target, so
// anything standing in the window can walk downhill to reach it. Pure: no DOM, no Three.js.

import { OCC_BRIDGE, OCC_BUILDING, OCC_WATER } from './grid';
import type { Colliders } from './colliders';

export interface NavGrid {
  /** Cell side in metres (2 m by default). */
  cell: number;
  half: number;
  /** Cells per side. */
  size: number;
  /** 1 where a person can stand, 0 inside buildings and over water (bridges count as ground). */
  open: Uint8Array;
}

/** Build the walkability grid from the collision world's fine grid (cells must be a whole number of metres). */
export function buildNavGrid(c: Colliders, cell = 2): NavGrid {
  const size = Math.ceil((c.half * 2) / cell);
  const open = new Uint8Array(size * size);
  const field = c.field;
  for (let cy = 0; cy < size; cy++) {
    for (let cx = 0; cx < size; cx++) {
      let free = 1;
      for (let sy = 0; sy < cell && free; sy++) {
        for (let sx = 0; sx < cell; sx++) {
          const fx = cx * cell + sx;
          const fy = cy * cell + sy;
          if (fx >= field.size || fy >= field.size) continue;
          const bits = field.data[fy * field.size + fx];
          if (
            (bits & OCC_BUILDING) !== 0 ||
            ((bits & OCC_WATER) !== 0 && (bits & OCC_BRIDGE) === 0)
          ) {
            free = 0;
            break;
          }
        }
      }
      open[cy * size + cx] = free;
    }
  }
  return { cell, half: c.half, size, open };
}

export function navCell(nav: NavGrid, v: number): number {
  return Math.floor((v + nav.half) / nav.cell);
}

const inside = (nav: NavGrid, cx: number, cy: number): boolean =>
  cx >= 0 && cy >= 0 && cx < nav.size && cy < nav.size;

/** Which cells can be walked to from a point at all (4-connected). One full pass; do it once per map. */
export function reachableFrom(nav: NavGrid, x: number, y: number): Uint8Array {
  const seen = new Uint8Array(nav.size * nav.size);
  const queue = new Int32Array(nav.size * nav.size);
  let cx = navCell(nav, x);
  let cy = navCell(nav, y);
  if (!inside(nav, cx, cy)) return seen;
  // start from the nearest open cell if the point itself is in a blocked one
  if (!nav.open[cy * nav.size + cx]) {
    const found = nearestOpen(nav, cx, cy, 6);
    if (!found) return seen;
    [cx, cy] = found;
  }
  let head = 0;
  let tail = 0;
  queue[tail++] = cy * nav.size + cx;
  seen[cy * nav.size + cx] = 1;
  while (head < tail) {
    const index = queue[head++];
    const px = index % nav.size;
    const py = (index - px) / nav.size;
    for (const [dx, dy] of FOUR) {
      const nx = px + dx;
      const ny = py + dy;
      if (!inside(nav, nx, ny)) continue;
      const n = ny * nav.size + nx;
      if (seen[n] || !nav.open[n]) continue;
      seen[n] = 1;
      queue[tail++] = n;
    }
  }
  return seen;
}

const FOUR = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
] as const;

const EIGHT = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
] as const;

function nearestOpen(
  nav: NavGrid,
  cx: number,
  cy: number,
  maxRing: number,
): [number, number] | null {
  for (let ring = 1; ring <= maxRing; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (inside(nav, nx, ny) && nav.open[ny * nav.size + nx]) return [nx, ny];
      }
    }
  }
  return null;
}

export interface FlowField {
  nav: NavGrid;
  /** Window radius in cells: the field covers a square of 2 * radius + 1 cells around the target. */
  radius: number;
  side: number;
  /** Cell coordinates of the window's lower-left corner. */
  originX: number;
  originY: number;
  /** Where the field leads: the centre of the target cell, in metres. */
  targetX: number;
  targetY: number;
  /** Steps to the target for each window cell, or -1 where it cannot be reached. */
  dist: Int16Array;
  /** Whether the field holds a usable result. */
  valid: boolean;
  queue: Int32Array;
}

export function createFlowField(nav: NavGrid, radiusCells = 90): FlowField {
  const side = radiusCells * 2 + 1;
  return {
    nav,
    radius: radiusCells,
    side,
    originX: 0,
    originY: 0,
    targetX: 0,
    targetY: 0,
    dist: new Int16Array(side * side).fill(-1),
    valid: false,
    queue: new Int32Array(side * side),
  };
}

/** Recompute the field around a new target point. Cheap enough to do several times a second. */
export function updateFlow(f: FlowField, targetX: number, targetY: number): void {
  const { nav } = f;
  let tx = navCell(nav, targetX);
  let ty = navCell(nav, targetY);
  f.valid = false;
  if (!inside(nav, tx, ty)) return;
  if (!nav.open[ty * nav.size + tx]) {
    const found = nearestOpen(nav, tx, ty, 4);
    if (!found) return;
    [tx, ty] = found;
  }
  f.originX = tx - f.radius;
  f.originY = ty - f.radius;
  f.targetX = -nav.half + (tx + 0.5) * nav.cell;
  f.targetY = -nav.half + (ty + 0.5) * nav.cell;
  f.dist.fill(-1);

  const start = (ty - f.originY) * f.side + (tx - f.originX);
  f.dist[start] = 0;
  let head = 0;
  let tail = 0;
  f.queue[tail++] = start;
  while (head < tail) {
    const index = f.queue[head++];
    const wx = index % f.side;
    const wy = (index - wx) / f.side;
    const d = f.dist[index];
    for (const [dx, dy] of EIGHT) {
      const nwx = wx + dx;
      const nwy = wy + dy;
      if (nwx < 0 || nwy < 0 || nwx >= f.side || nwy >= f.side) continue;
      const cx = f.originX + nwx;
      const cy = f.originY + nwy;
      if (!inside(nav, cx, cy) || !nav.open[cy * nav.size + cx]) continue;
      // a diagonal step must not squeeze between two blocked corners
      if (dx !== 0 && dy !== 0) {
        const ax = f.originX + wx + dx;
        const ay = f.originY + wy;
        const bx = f.originX + wx;
        const by = f.originY + wy + dy;
        if (!nav.open[ay * nav.size + ax] || !nav.open[by * nav.size + bx]) continue;
      }
      const n = nwy * f.side + nwx;
      if (f.dist[n] !== -1) continue;
      f.dist[n] = d + 1;
      f.queue[tail++] = n;
    }
  }
  f.valid = true;
}

const out: [number, number] = [0, 0];

/**
 * The direction (a unit vector) to walk from (x, y) to get closer to the flow field's target, or null
 * when the point is outside the window, cannot reach the target, or is already in the target's cell
 * (the caller then walks straight at the target). The returned array is reused by the next call:
 * read it before calling again, or copy it.
 */
export function flowStep(f: FlowField, x: number, y: number): [number, number] | null {
  if (!f.valid) return null;
  const { nav } = f;
  const cx = navCell(nav, x);
  const cy = navCell(nav, y);
  const wx = cx - f.originX;
  const wy = cy - f.originY;
  if (wx < 0 || wy < 0 || wx >= f.side || wy >= f.side) return null;
  const here = f.dist[wy * f.side + wx];
  if (here === 0) return null;
  // Someone pressed against a wall stands in a blocked cell (distance -1): any reachable neighbour
  // is a way out. Otherwise only a cell nearer the target will do.
  const blockedHere = nav.open[cy * nav.size + cx] === 0;
  let bestDist = here > 0 ? here - 1 : Infinity; // a neighbour can be at best one step nearer
  const toX = f.targetX - x;
  const toY = f.targetY - y;
  const toLen = Math.hypot(toX, toY) || 1;
  let bestDot = -Infinity;
  let bx = 0;
  let by = 0;
  for (const [dx, dy] of EIGHT) {
    const nwx = wx + dx;
    const nwy = wy + dy;
    if (nwx < 0 || nwy < 0 || nwx >= f.side || nwy >= f.side) continue;
    const d = f.dist[nwy * f.side + nwx];
    if (d < 0 || d > bestDist) continue;
    if (!blockedHere && dx !== 0 && dy !== 0) {
      const ax = cx + dx;
      const by2 = cy + dy;
      if (!nav.open[cy * nav.size + ax] || !nav.open[by2 * nav.size + cx]) continue;
    }
    // among equally near cells, prefer the one most toward the target: open ground gives straight paths
    const dot = (dx * toX + dy * toY) / ((dx !== 0 && dy !== 0 ? Math.SQRT2 : 1) * toLen);
    if (d < bestDist || dot > bestDot) {
      bestDist = d;
      bestDot = dot;
      bx = dx;
      by = dy;
    }
  }
  if (bx === 0 && by === 0) return null;
  // aim at the middle of that cell
  const targetX = -nav.half + (cx + bx + 0.5) * nav.cell;
  const targetY = -nav.half + (cy + by + 0.5) * nav.cell;
  const ddx = targetX - x;
  const ddy = targetY - y;
  const len = Math.hypot(ddx, ddy) || 1;
  out[0] = ddx / len;
  out[1] = ddy / len;
  return out;
}
