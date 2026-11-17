// The fixed things about a map that every game on it shares, and the question "can a person stand
// here?". Pure: no DOM, no Three.js.

import { clearance, insideBuilding, type Colliders } from './colliders';
import { navCell, type NavGrid } from './flow';
import type { Place } from './places';

export interface GameWorld {
  colliders: Colliders;
  nav: NavGrid;
  /** 1 where a person can walk to from the start. */
  reachable: Uint8Array;
  /** The buildings that do something (radar, shelters, supplies, armory), with their doors. */
  places: readonly Place[];
}

/** Whether (x, y) is somewhere a person could stand and could walk to from the start. */
export function validSpot(world: GameWorld, x: number, y: number, needed = 1): boolean {
  const { nav, colliders } = world;
  if (Math.abs(x) > colliders.half - 6 || Math.abs(y) > colliders.half - 6) return false;
  const cx = navCell(nav, x);
  const cy = navCell(nav, y);
  if (cx < 0 || cy < 0 || cx >= nav.size || cy >= nav.size) return false;
  const index = cy * nav.size + cx;
  if (!nav.open[index] || !world.reachable[index]) return false;
  return !insideBuilding(colliders, x, y) && clearance(colliders, x, y, needed + 1) >= needed;
}
