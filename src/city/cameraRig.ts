// The strategy-game camera: it looks at a point on the ground from above and behind. All maths, no
// Three.js, so it is easy to test. Three.js space: x east, y up, z south.

export interface Rig {
  /** The ground point being looked at. */
  x: number;
  z: number;
  /** Radians. 0 looks north, positive turns the camera toward the east. */
  yaw: number;
  /** Radians above the horizon. */
  pitch: number;
  /** Metres from the target to the camera. */
  distance: number;
}

export const MIN_PITCH = (18 * Math.PI) / 180;
export const MAX_PITCH = (82 * Math.PI) / 180;
export const MIN_DISTANCE = 24;
export const MAX_DISTANCE = 1100;

export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Ground directions of the view: where the camera looks and where its right-hand side is. */
export function groundAxes(yaw: number): { forward: [number, number]; right: [number, number] } {
  return {
    forward: [-Math.sin(yaw), -Math.cos(yaw)],
    right: [Math.cos(yaw), -Math.sin(yaw)],
  };
}

/** Move the target in the view's own directions: `forward` is away from the camera, `right` to its right. */
export function pan(rig: Rig, forward: number, right: number): Rig {
  const axes = groundAxes(rig.yaw);
  return {
    ...rig,
    x: rig.x + axes.forward[0] * forward + axes.right[0] * right,
    z: rig.z + axes.forward[1] * forward + axes.right[1] * right,
  };
}

export function rotate(rig: Rig, dYaw: number, dPitch: number): Rig {
  return { ...rig, yaw: rig.yaw + dYaw, pitch: clamp(rig.pitch + dPitch, MIN_PITCH, MAX_PITCH) };
}

/** Multiply the distance by `factor` (below 1 zooms in). */
export function zoom(rig: Rig, factor: number): Rig {
  return { ...rig, distance: clamp(rig.distance * factor, MIN_DISTANCE, MAX_DISTANCE) };
}

/** Keep the target inside the play area (a little beyond its edge). */
export function keepInside(rig: Rig, half: number, margin = 40): Rig {
  const limit = half + margin;
  return { ...rig, x: clamp(rig.x, -limit, limit), z: clamp(rig.z, -limit, limit) };
}

const shortestAngle = (from: number, to: number): number => {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
};

/**
 * Ease the current view toward the goal, independent of frame rate. `rate` is how quickly it closes
 * the gap (about 6 feels snappy, 2 feels cinematic).
 */
export function ease(current: Rig, goal: Rig, dt: number, rate = 7): Rig {
  const k = 1 - Math.exp(-rate * dt);
  return {
    x: current.x + (goal.x - current.x) * k,
    z: current.z + (goal.z - current.z) * k,
    yaw: current.yaw + shortestAngle(current.yaw, goal.yaw) * k,
    pitch: current.pitch + (goal.pitch - current.pitch) * k,
    // zoom is multiplicative, so ease it in log space for an even feel from near to far
    distance: Math.exp(
      Math.log(current.distance) + (Math.log(goal.distance) - Math.log(current.distance)) * k,
    ),
  };
}

/** Camera position for a view. The camera looks from there at (rig.x, 0, rig.z). */
export function cameraPosition(rig: Rig): [number, number, number] {
  const flat = Math.cos(rig.pitch) * rig.distance;
  return [
    rig.x + Math.sin(rig.yaw) * flat,
    Math.sin(rig.pitch) * rig.distance,
    rig.z + Math.cos(rig.yaw) * flat,
  ];
}

/** How many metres of ground one screen pixel covers at the target, for dragging the map under the cursor. */
export function metresPerPixel(rig: Rig, fovDegrees: number, viewHeightPx: number): number {
  return (2 * rig.distance * Math.tan((fovDegrees * Math.PI) / 360)) / viewHeightPx;
}
