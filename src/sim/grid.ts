// A square occupancy grid over the play area, in metres. Pure: no DOM, no Three.js.
//
// Used now to keep trees out of buildings and roads, and next for collision and pathfinding.
// Each cell holds a bit set describing what covers it.

/** Bits stored per cell. */
export const OCC_BUILDING = 1;
export const OCC_ROAD = 2;
export const OCC_WATER = 4;
export const OCC_TREE = 8;

export interface Grid {
  /** Cell side in metres. */
  cell: number;
  /** Half the side of the covered square in metres: it spans -half to +half on both axes. */
  half: number;
  /** Cells per side. */
  size: number;
  data: Uint8Array;
}

export function createGrid(half: number, cell: number): Grid {
  const size = Math.ceil((half * 2) / cell);
  return { cell, half, size, data: new Uint8Array(size * size) };
}

/** Cell column or row for a coordinate in metres, or -1 outside the grid. */
export function cellCoord(grid: Grid, v: number): number {
  const i = Math.floor((v + grid.half) / grid.cell);
  return i >= 0 && i < grid.size ? i : -1;
}

/** Bits at a point in metres; 0 outside the grid. */
export function occupancyAt(grid: Grid, x: number, y: number): number {
  const cx = cellCoord(grid, x);
  const cy = cellCoord(grid, y);
  return cx < 0 || cy < 0 ? 0 : grid.data[cy * grid.size + cx];
}

/** True when none of the bits in `mask` are set at the point (points outside the grid are not free). */
export function isFree(grid: Grid, x: number, y: number, mask = 0xff): boolean {
  if (cellCoord(grid, x) < 0 || cellCoord(grid, y) < 0) return false;
  return (occupancyAt(grid, x, y) & mask) === 0;
}

/** Centre of a cell in metres. */
export function cellCentre(grid: Grid, cx: number, cy: number): [number, number] {
  return [-grid.half + (cx + 0.5) * grid.cell, -grid.half + (cy + 0.5) * grid.cell];
}

/** Even-odd test of a point against a flat ring [x0, y0, x1, y1, ...]. */
export function pointInFlatRing(ring: ArrayLike<number>, x: number, y: number): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2];
    const yi = ring[i * 2 + 1];
    const xj = ring[j * 2];
    const yj = ring[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Set `bit` on every cell whose centre is inside the polygon (outer ring minus holes). */
export function rasterizePolygon(
  grid: Grid,
  outer: ArrayLike<number>,
  holes: readonly ArrayLike<number>[] | undefined,
  bit: number,
): void {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < outer.length; i += 2) {
    minX = Math.min(minX, outer[i]);
    maxX = Math.max(maxX, outer[i]);
    minY = Math.min(minY, outer[i + 1]);
    maxY = Math.max(maxY, outer[i + 1]);
  }
  const x0 = Math.max(0, Math.floor((minX + grid.half) / grid.cell));
  const x1 = Math.min(grid.size - 1, Math.floor((maxX + grid.half) / grid.cell));
  const y0 = Math.max(0, Math.floor((minY + grid.half) / grid.cell));
  const y1 = Math.min(grid.size - 1, Math.floor((maxY + grid.half) / grid.cell));
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      const [x, y] = cellCentre(grid, cx, cy);
      if (!pointInFlatRing(outer, x, y)) continue;
      if (holes?.some((h) => pointInFlatRing(h, x, y))) continue;
      grid.data[cy * grid.size + cx] |= bit;
    }
  }
}

/** Set `bit` on every cell within `radius` metres of a flat polyline [x0, y0, x1, y1, ...]. */
export function stampPolyline(
  grid: Grid,
  points: ArrayLike<number>,
  radius: number,
  bit: number,
): void {
  const step = Math.max(0.5, grid.cell / 2);
  for (let i = 0; i + 3 < points.length; i += 2) {
    const ax = points[i];
    const ay = points[i + 1];
    const bx = points[i + 2];
    const by = points[i + 3];
    const length = Math.hypot(bx - ax, by - ay);
    const samples = Math.max(1, Math.ceil(length / step));
    for (let s = 0; s <= samples; s++) {
      const t = s / samples;
      stampDisc(grid, ax + (bx - ax) * t, ay + (by - ay) * t, radius, bit);
    }
  }
}

function stampDisc(grid: Grid, x: number, y: number, radius: number, bit: number): void {
  const x0 = Math.max(0, Math.floor((x - radius + grid.half) / grid.cell));
  const x1 = Math.min(grid.size - 1, Math.floor((x + radius + grid.half) / grid.cell));
  const y0 = Math.max(0, Math.floor((y - radius + grid.half) / grid.cell));
  const y1 = Math.min(grid.size - 1, Math.floor((y + radius + grid.half) / grid.cell));
  const r2 = radius * radius;
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      const [px, py] = cellCentre(grid, cx, cy);
      if ((px - x) ** 2 + (py - y) ** 2 <= r2) grid.data[cy * grid.size + cx] |= bit;
    }
  }
}

/** How many cells have any of the bits in `mask` set. */
export function countCells(grid: Grid, mask = 0xff): number {
  let n = 0;
  for (const v of grid.data) if ((v & mask) !== 0) n++;
  return n;
}
