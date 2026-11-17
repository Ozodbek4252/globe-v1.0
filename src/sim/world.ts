// The fixed things about a map that every game on it shares, and the question "can a person stand
// here?". Pure: no DOM, no Three.js.

import { clearance, insideBuilding, type Colliders } from './colliders';
import { navCell, type NavGrid } from './flow';
import type { Place, PlaceBuilding } from './places';

export interface GameWorld {
  colliders: Colliders;
  nav: NavGrid;
  /** 1 where a person can walk to from the start. */
  reachable: Uint8Array;
  /** Every building (the people of the city live in them), numbered by position in this list. */
  buildings: readonly PlaceBuilding[];
  /** The buildings that do something (radar, shelters, supplies, armory), with their doors. */
  places: readonly Place[];
}

/**
 * The building map is a 1 m grid, so a point just inside a wall can read as outside it, but never by
 * more than half a cell's diagonal (0.71 m). Asking for at least this much clearance from every wall
 * means such a point is never taken for open ground.
 */
const RASTER_MARGIN = 0.75;

/** Whether (x, y) is somewhere a person could stand and could walk to from the start. */
export function validSpot(world: GameWorld, x: number, y: number, needed = 1): boolean {
  const { nav, colliders } = world;
  if (Math.abs(x) > colliders.half - 6 || Math.abs(y) > colliders.half - 6) return false;
  const cx = navCell(nav, x);
  const cy = navCell(nav, y);
  if (cx < 0 || cy < 0 || cx >= nav.size || cy >= nav.size) return false;
  const index = cy * nav.size + cx;
  if (!nav.open[index] || !world.reachable[index]) return false;
  const margin = Math.max(needed, RASTER_MARGIN);
  return !insideBuilding(colliders, x, y) && clearance(colliders, x, y, margin + 1) >= margin;
}
