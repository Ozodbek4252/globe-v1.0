import { describe, expect, it } from 'vitest';
import {
  cellCentre,
  cellCoord,
  countCells,
  createGrid,
  isFree,
  occupancyAt,
  OCC_BUILDING,
  OCC_ROAD,
  OCC_WATER,
  pointInFlatRing,
  rasterizePolygon,
  stampPolyline,
} from '../src/sim/grid';

const square = (x: number, y: number, s: number): number[] => [
  x,
  y,
  x + s,
  y,
  x + s,
  y + s,
  x,
  y + s,
];

describe('grid', () => {
  it('covers the square and maps metres to cells', () => {
    const g = createGrid(100, 2);
    expect(g.size).toBe(100);
    expect(g.data).toHaveLength(10_000);
    expect(cellCoord(g, -100)).toBe(0);
    expect(cellCoord(g, 99.9)).toBe(99);
    expect(cellCoord(g, 100)).toBe(-1);
    expect(cellCoord(g, -100.1)).toBe(-1);
    expect(cellCentre(g, 0, 0)).toEqual([-99, -99]);
  });

  it('tests points against rings', () => {
    expect(pointInFlatRing(square(0, 0, 10), 5, 5)).toBe(true);
    expect(pointInFlatRing(square(0, 0, 10), 15, 5)).toBe(false);
    // a concave "L"
    const l = [0, 0, 10, 0, 10, 4, 4, 4, 4, 10, 0, 10];
    expect(pointInFlatRing(l, 2, 8)).toBe(true);
    expect(pointInFlatRing(l, 8, 8)).toBe(false);
  });

  it('fills a polygon with about its area', () => {
    const g = createGrid(100, 1);
    rasterizePolygon(g, square(-10, -10, 20), undefined, OCC_BUILDING);
    expect(countCells(g, OCC_BUILDING)).toBe(400);
    expect(occupancyAt(g, 0, 0)).toBe(OCC_BUILDING);
    expect(occupancyAt(g, 15, 0)).toBe(0);
  });

  it('leaves holes empty', () => {
    const g = createGrid(100, 1);
    rasterizePolygon(g, square(-10, -10, 20), [square(-2, -2, 4)], OCC_BUILDING);
    expect(countCells(g, OCC_BUILDING)).toBe(400 - 16);
    expect(occupancyAt(g, 0, 0)).toBe(0);
    expect(occupancyAt(g, 8, 8)).toBe(OCC_BUILDING);
  });

  it('ignores the part of a polygon outside the grid', () => {
    const g = createGrid(50, 1);
    rasterizePolygon(g, square(40, 40, 30), undefined, OCC_WATER);
    expect(countCells(g, OCC_WATER)).toBe(100); // only the 10 x 10 inside
  });

  it('stamps a line with a width', () => {
    const g = createGrid(100, 1);
    stampPolyline(g, [-50, 0, 50, 0], 3, OCC_ROAD);
    // a 100 m long, 6 m wide band, plus rounded ends
    expect(countCells(g, OCC_ROAD)).toBeGreaterThan(560);
    expect(countCells(g, OCC_ROAD)).toBeLessThan(660);
    expect(occupancyAt(g, 0, 2)).toBe(OCC_ROAD);
    expect(occupancyAt(g, 0, 5)).toBe(0);
  });

  it('combines bits and reports free space', () => {
    const g = createGrid(100, 1);
    rasterizePolygon(g, square(0, 0, 10), undefined, OCC_BUILDING);
    stampPolyline(g, [0, 5, 10, 5], 1, OCC_ROAD);
    expect(occupancyAt(g, 5, 5) & (OCC_BUILDING | OCC_ROAD)).toBe(OCC_BUILDING | OCC_ROAD);
    expect(isFree(g, 5, 5)).toBe(false);
    expect(isFree(g, 5, 5, OCC_WATER)).toBe(true); // only water counts
    expect(isFree(g, 50, 50)).toBe(true);
    expect(isFree(g, 500, 0)).toBe(false); // outside the grid is never free
  });
});
