// A flat grid over the whole map for "who is near here?" questions about thousands of moving points.
// Rebuilt from scratch each step by counting sort: no allocation, and cheap next to what it saves.
// Pure: no DOM, no Three.js.

export interface PointIndex {
  /** Side of a cell in metres. */
  cell: number;
  /** Cells per side, and where the grid starts (its lower-left corner), in metres. */
  side: number;
  origin: number;
  /** Items in cell c are items[start[c] .. start[c + 1]). */
  start: Int32Array;
  items: Int32Array;
  /** Scratch: the cell each point went into, or -1. */
  cellOf: Int32Array;
  fill: Int32Array;
}

/** An index for up to `capacity` points on a map that spans -half to +half. */
export function createPointIndex(half: number, cell: number, capacity: number): PointIndex {
  const reach = half + cell * 2;
  const side = Math.ceil((reach * 2) / cell);
  return {
    cell,
    side,
    origin: -reach,
    start: new Int32Array(side * side + 1),
    items: new Int32Array(capacity),
    cellOf: new Int32Array(capacity).fill(-1),
    fill: new Int32Array(side * side),
  };
}

/** Put points 0..n-1 into the grid. `include(i)` says whether a point takes part. */
export function rebuildIndex(
  ix: PointIndex,
  n: number,
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  include: (i: number) => boolean,
): void {
  const { cell, side, origin, start } = ix;
  const cells = side * side;
  start.fill(0);
  for (let i = 0; i < n; i++) {
    ix.cellOf[i] = -1;
    if (!include(i)) continue;
    const cx = Math.floor((xs[i] - origin) / cell);
    const cy = Math.floor((ys[i] - origin) / cell);
    if (cx < 0 || cy < 0 || cx >= side || cy >= side) continue;
    const c = cy * side + cx;
    ix.cellOf[i] = c;
    start[c + 1]++;
  }
  for (let c = 0; c < cells; c++) start[c + 1] += start[c];
  ix.fill.set(start.subarray(0, cells));
  for (let i = 0; i < n; i++) {
    const c = ix.cellOf[i];
    if (c >= 0) ix.items[ix.fill[c]++] = i;
  }
}

/** Call `visit(i, distance squared)` for every indexed point within `radius` of (x, y). */
export function forEachNear(
  ix: PointIndex,
  x: number,
  y: number,
  radius: number,
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  visit: (i: number, d2: number) => void,
): void {
  const { cell, side, origin, start, items } = ix;
  const r2 = radius * radius;
  const x0 = Math.max(0, Math.floor((x - radius - origin) / cell));
  const x1 = Math.min(side - 1, Math.floor((x + radius - origin) / cell));
  const y0 = Math.max(0, Math.floor((y - radius - origin) / cell));
  const y1 = Math.min(side - 1, Math.floor((y + radius - origin) / cell));
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      const c = cy * side + cx;
      for (let k = start[c]; k < start[c + 1]; k++) {
        const i = items[k];
        const dx = xs[i] - x;
        const dy = ys[i] - y;
        const d2 = dx * dx + dy * dy;
        if (d2 <= r2) visit(i, d2);
      }
    }
  }
}
