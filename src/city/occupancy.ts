import {
  OCC_BUILDING,
  OCC_ROAD,
  OCC_WATER,
  createGrid,
  rasterizePolygon,
  stampPolyline,
  type Grid,
} from '../sim/grid';
import type { CityData } from './types';

/** What covers each cell of the play area: buildings, roads and paths, water. Cells are 2 m by default. */
export function buildOccupancy(city: CityData, cell = 2): Grid {
  const grid = createGrid(city.halfSize, cell);
  for (const b of city.buildings) rasterizePolygon(grid, b.outer, b.holes, OCC_BUILDING);
  for (const a of city.areas) {
    if (a.kind === 'water') rasterizePolygon(grid, a.outer, a.holes, OCC_WATER);
  }
  for (const w of city.waterways) stampPolyline(grid, w.points, w.width / 2, OCC_WATER);
  for (const r of city.roads) stampPolyline(grid, r.points, r.width / 2 + 0.4, OCC_ROAD);
  return grid;
}
