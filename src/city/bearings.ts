// Directions, in words and on the screen. Pure maths: no Three.js, no DOM.
// City space: x east, y north; angles are radians counter-clockwise from east.

import { groundAxes } from './cameraRig';

const COMPASS = [
  'north',
  'north-east',
  'east',
  'south-east',
  'south',
  'south-west',
  'west',
  'north-west',
] as const;

/** The compass word for a direction in city space: "north", "south-west", and so on. */
export function compassName(angle: number): string {
  const bearing = (((90 - (angle * 180) / Math.PI) % 360) + 360) % 360; // clockwise from north
  return COMPASS[Math.round(bearing / 45) % 8];
}

/**
 * A city offset (dx east, dy north, in metres) as a screen offset for a camera turned to `yaw`:
 * [right, up], in the same metres. This is the map for a radar that always has "up" ahead of the camera.
 */
export function screenOffset(yaw: number, dx: number, dy: number): [number, number] {
  const axes = groundAxes(yaw);
  return [dx * axes.right[0] + -dy * axes.right[1], dx * axes.forward[0] + -dy * axes.forward[1]];
}

/**
 * Where a direction in the city (dx east, dy north) points on the screen for a camera turned to `yaw`:
 * radians clockwise from straight up the screen, so 0 is up, a quarter turn is right, and so on.
 */
export function screenAngle(yaw: number, dx: number, dy: number): number {
  const [right, up] = screenOffset(yaw, dx, dy);
  return Math.atan2(right, up);
}
