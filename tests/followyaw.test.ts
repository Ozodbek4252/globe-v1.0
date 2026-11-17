import { describe, expect, it } from 'vitest';
import { cameraPosition } from '../src/city/cameraRig';
import { openestYaw } from '../src/city/followYaw';
import { buildColliders, insideBuilding } from '../src/sim/colliders';

const sq = (x: number, y: number, w: number, h = w): number[] => [
  x,
  y,
  x + w,
  y,
  x + w,
  y + h,
  x,
  y + h,
];
const world = (buildings: { outer: number[] }[]) =>
  buildColliders({ halfSize: 300, buildings, areas: [], waterways: [], roads: [] });

/** Where the camera would stand on the ground, in city metres, for a yaw. */
const cameraAt = (x: number, y: number, yaw: number, flat: number): [number, number] => {
  const [cx, , cz] = cameraPosition({ x: 0, z: 0, yaw, pitch: 0, distance: flat });
  return [x + cx, y - cz];
};

describe('openestYaw', () => {
  it('keeps the preferred angle in open ground', () => {
    expect(openestYaw(world([]), 0, 0, 16, 0.35)).toBeCloseTo(0.35, 9);
  });

  it('moves the camera off a side that has a building in the way', () => {
    // a big building directly south of the survivor, where a yaw-0 camera would stand
    const w = world([{ outer: sq(-30, -22, 60, 18) }]);
    const yaw = openestYaw(w, 0, 0, 16, 0);
    const [cx, cy] = cameraAt(0, 0, yaw, 16);
    expect(insideBuilding(w, cx, cy)).toBe(false);
    expect(Math.abs(yaw)).toBeGreaterThan(0.5); // it did choose another side
  });

  it('finds the way out when three sides are built up', () => {
    // walls to the south, east and west: only the north is open (camera at yaw pi)
    const w = world([
      { outer: sq(-30, -26, 60, 20) },
      { outer: sq(8, -6, 20, 40) },
      { outer: sq(-28, -6, 20, 40) },
    ]);
    const yaw = openestYaw(w, 0, 0, 16, 0);
    const [cx, cy] = cameraAt(0, 0, yaw, 16);
    expect(insideBuilding(w, cx, cy)).toBe(false);
    expect(cy).toBeGreaterThan(5); // the camera ends up to the north
  });

  it('is deterministic', () => {
    const w = world([{ outer: sq(-30, -22, 60, 18) }]);
    expect(openestYaw(w, 0, 0, 16, 0.35)).toBe(openestYaw(w, 0, 0, 16, 0.35));
  });
});
