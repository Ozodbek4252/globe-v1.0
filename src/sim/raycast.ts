// Rays against the city: do two points see each other, and where does a bullet stop? Walls are the
// building segments in the collision world. Pure: no DOM, no Three.js.

import type { Colliders } from './colliders';

/**
 * Walk a ray from (x0, y0) to (x1, y1) and return how far along it (0 to 1) it first meets a wall,
 * or Infinity if it reaches the end clear. Visits only the hash cells the ray passes through.
 */
export function rayWallHit(c: Colliders, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0;
  const dy = y1 - y0;
  if (dx === 0 && dy === 0) return Infinity;
  const { cell, origin, cols } = c;

  let cx = Math.floor((x0 - origin) / cell);
  let cy = Math.floor((y0 - origin) / cell);
  const endX = Math.floor((x1 - origin) / cell);
  const endY = Math.floor((y1 - origin) / cell);
  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  let tMaxX = dx !== 0 ? (origin + (dx > 0 ? cx + 1 : cx) * cell - x0) / dx : Infinity;
  let tMaxY = dy !== 0 ? (origin + (dy > 0 ? cy + 1 : cy) * cell - y0) / dy : Infinity;
  const tDeltaX = dx !== 0 ? cell / Math.abs(dx) : Infinity;
  const tDeltaY = dy !== 0 ? cell / Math.abs(dy) : Infinity;

  let best = Infinity;
  for (let guard = 0; guard < cols * 2 + 4; guard++) {
    if (cx >= 0 && cx < cols && cy >= 0 && cy < cols) {
      const index = cy * cols + cx;
      for (let k = c.segStart[index]; k < c.segStart[index + 1]; k++) {
        const s = c.segItems[k] * 4;
        const ax = c.segments[s];
        const ay = c.segments[s + 1];
        const ex = c.segments[s + 2] - ax;
        const ey = c.segments[s + 3] - ay;
        const denom = dx * ey - dy * ex;
        if (Math.abs(denom) < 1e-12) continue; // parallel
        const px = ax - x0;
        const py = ay - y0;
        const t = (px * ey - py * ex) / denom; // along the ray
        const u = (px * dy - py * dx) / denom; // along the wall
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1 && t < best) best = t;
      }
    }
    // a hit inside the cell we just searched is nearer than anything in the cells still to come
    if (best <= Math.min(tMaxX, tMaxY)) break;
    if (cx === endX && cy === endY) break;
    if (tMaxX < tMaxY) {
      tMaxX += tDeltaX;
      cx += stepX;
    } else {
      tMaxY += tDeltaY;
      cy += stepY;
    }
  }
  return best <= 1 ? best : Infinity;
}

/** True when nothing solid lies between the two points. */
export function lineOfSight(c: Colliders, x0: number, y0: number, x1: number, y1: number): boolean {
  return rayWallHit(c, x0, y0, x1, y1) === Infinity;
}

/**
 * How far along a ray (a start point and a unit direction) it first touches a circle, or Infinity if it
 * misses or the circle is behind it. Returns 0 when the ray starts inside the circle.
 */
export function rayCircleHit(
  x: number,
  y: number,
  dirX: number,
  dirY: number,
  cx: number,
  cy: number,
  r: number,
): number {
  const fx = x - cx;
  const fy = y - cy;
  const b = fx * dirX + fy * dirY;
  const c = fx * fx + fy * fy - r * r;
  if (c <= 0) return 0;
  const disc = b * b - c;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : Infinity;
}
