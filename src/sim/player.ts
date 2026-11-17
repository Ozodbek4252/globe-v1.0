// The survivor: how one person moves. Pure functions on plain data: the same state and input always
// give the same result, and nothing here touches the DOM or Three.js. City space: x east, y north.

import { moveCircle, type Colliders } from './colliders';

/** Tuning, in metres and seconds. One place so the feel is easy to change. */
export const PLAYER = {
  /** Body radius used for collisions. */
  radius: 0.38,
  /** A brisk walk, and a real sprint (7.6 m/s is 27 km/h: a fit person flat out; walkers cannot touch it). */
  walkSpeed: 3.4,
  sprintSpeed: 7.6,
  /** How quickly speed builds when you press a key, and bleeds off when you let go (m/s²). */
  accel: 26,
  decel: 34,
  /** How fast the body turns to face where it is going (radians/s). */
  turnRate: 14,
  /** Turning to face the aim point is faster, so the gun follows the mouse closely. */
  aimTurnRate: 24,
  /** Stamina is 0 to 1. Sprinting uses it (about 14 s flat out), resting restores it (about 5 s) after a short pause. */
  staminaDrain: 0.07,
  staminaRegen: 0.2,
  regenDelay: 0.9,
  /** After running dry you cannot sprint again until stamina climbs back to this. */
  exhaustedUntil: 0.3,
} as const;

export interface PlayerState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Radians, counter-clockwise from east (the direction the survivor faces). */
  heading: number;
  stamina: number;
  /** Out of breath: cannot sprint until stamina recovers. */
  exhausted: boolean;
  sprinting: boolean;
  /** Seconds since sprinting stopped, so stamina waits a moment before refilling. */
  rest: number;
  /** Total distance walked in metres, which drives the walk animation. */
  travelled: number;
}

export interface PlayerInput {
  /** Desired direction in city space (east, north). Any length; it is capped at 1. */
  moveX: number;
  moveY: number;
  sprint: boolean;
  /** Face this direction (radians, counter-clockwise from east) instead of the way you walk: aiming. */
  face?: number | null;
  /** Multiplies top speed, 0 to 1: zombies hanging on slow you down. Default 1. */
  slow?: number;
}

export function createPlayer(x: number, y: number, heading = Math.PI / 2): PlayerState {
  return {
    x,
    y,
    vx: 0,
    vy: 0,
    heading,
    stamina: 1,
    exhausted: false,
    sprinting: false,
    rest: 0,
    travelled: 0,
  };
}

/** The smallest signed angle that turns `from` into `to`. */
export function angleDelta(from: number, to: number): number {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/** Advance the survivor by `dt` seconds (keep it small, ideally 1/60). Returns the new state. */
export function stepPlayer(
  p: PlayerState,
  input: PlayerInput,
  world: Colliders,
  dt: number,
): PlayerState {
  const mag = Math.hypot(input.moveX, input.moveY);
  const pressing = mag > 0.05;
  const dirX = pressing ? input.moveX / Math.max(1, mag) : 0;
  const dirY = pressing ? input.moveY / Math.max(1, mag) : 0;

  // sprint needs breath
  const wantsSprint = input.sprint && pressing;
  let exhausted = p.exhausted;
  const sprinting = wantsSprint && !exhausted && p.stamina > 0;
  let stamina = p.stamina;
  let rest = p.rest;
  if (sprinting) {
    stamina = Math.max(0, stamina - PLAYER.staminaDrain * dt);
    rest = 0;
    if (stamina === 0) exhausted = true;
  } else {
    rest += dt;
    if (rest >= PLAYER.regenDelay) stamina = Math.min(1, stamina + PLAYER.staminaRegen * dt);
    if (exhausted && stamina >= PLAYER.exhaustedUntil) exhausted = false;
  }

  // speed builds and bleeds off at a fixed rate, so movement has weight
  const top = (sprinting ? PLAYER.sprintSpeed : PLAYER.walkSpeed) * (input.slow ?? 1);
  const targetX = dirX * top;
  const targetY = dirY * top;
  const dvx = targetX - p.vx;
  const dvy = targetY - p.vy;
  const dv = Math.hypot(dvx, dvy);
  const maxDv = (pressing ? PLAYER.accel : PLAYER.decel) * dt;
  let vx = p.vx;
  let vy = p.vy;
  if (dv <= maxDv || dv === 0) {
    vx = targetX;
    vy = targetY;
  } else {
    vx += (dvx / dv) * maxDv;
    vy += (dvy / dv) * maxDv;
  }

  // move, sliding along walls
  const [x, y] = moveCircle(world, p.x, p.y, p.x + vx * dt, p.y + vy * dt, PLAYER.radius);
  const moved = Math.hypot(x - p.x, y - p.y);
  // walls take away speed: keep only what actually carried the survivor
  if (dt > 0) {
    const realVx = (x - p.x) / dt;
    const realVy = (y - p.y) / dt;
    if (Math.hypot(realVx, realVy) < Math.hypot(vx, vy)) {
      vx = realVx;
      vy = realVy;
    }
  }

  // turn toward where you are aiming, or else toward the direction of travel
  let heading = p.heading;
  const face = input.face ?? null;
  const aiming = face !== null;
  if (aiming || Math.hypot(vx, vy) > 0.4) {
    const want = face ?? Math.atan2(vy, vx);
    const turn = angleDelta(heading, want);
    const maxTurn = (aiming ? PLAYER.aimTurnRate : PLAYER.turnRate) * dt;
    heading += Math.abs(turn) <= maxTurn ? turn : Math.sign(turn) * maxTurn;
  }

  return {
    x,
    y,
    vx,
    vy,
    heading,
    stamina,
    exhausted,
    sprinting,
    rest,
    travelled: p.travelled + moved,
  };
}

/** Speed in metres per second. */
export function speedOf(p: PlayerState): number {
  return Math.hypot(p.vx, p.vy);
}
