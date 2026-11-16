// Street lamps along the main streets, a little back from the kerb. Deterministic, and kept out of
// buildings and water. Place these before trees so trees avoid them.

import { hash01 } from '../lib/hash';
import {
  OCC_BUILDING,
  OCC_ROAD,
  OCC_TREE,
  OCC_WATER,
  cellCoord,
  isFree,
  type Grid,
} from '../sim/grid';
import type { CityData, RoadKind } from './types';

/** Floats per lamp in LampSet.data: x, y, height of the light in metres. */
export const LAMP_STRIDE = 3;

export interface LampSet {
  data: Float32Array;
  count: number;
}

export const MAX_LAMPS = 4200;

/** Metres between lamps for the streets that have them. */
const SPACING: Partial<Record<RoadKind, number>> = {
  primary: 30,
  secondary: 32,
  tertiary: 34,
  residential: 40,
};

export function placeLamps(city: CityData, grid: Grid): LampSet {
  const out: number[] = [];
  city.roads.forEach((road, index) => {
    const spacing = SPACING[road.kind];
    if (!spacing) return;
    const offset = road.width / 2 + 1.3;
    let carry = hash01(index, 61) * spacing;
    let side = hash01(index, 62) < 0.5 ? 1 : -1;
    const p = road.points;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i];
      const ay = p[i + 1];
      const bx = p[i + 2];
      const by = p[i + 3];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 0.5) continue;
      const dx = (bx - ax) / len;
      const dy = (by - ay) / len;
      let at = carry;
      while (at <= len) {
        const x = ax - dy * offset * side + dx * at;
        const y = ay + dx * offset * side + dy * at;
        // alternate sides so the street is lit evenly
        side = -side;
        if (
          out.length / LAMP_STRIDE < MAX_LAMPS &&
          isFree(grid, x, y, OCC_BUILDING | OCC_ROAD | OCC_WATER | OCC_TREE)
        ) {
          out.push(x, y, 6.2);
          const cx = cellCoord(grid, x);
          const cy = cellCoord(grid, y);
          if (cx >= 0 && cy >= 0) grid.data[cy * grid.size + cx] |= OCC_TREE;
        }
        at += spacing;
      }
      carry = at - len;
    }
  });
  return { data: Float32Array.from(out), count: out.length / LAMP_STRIDE };
}
