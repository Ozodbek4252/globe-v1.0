// The people you are trying to save. They hide where they are until you come near; then they follow
// you, a little slower than you walk and nowhere near as fast as you run. You can leave them behind
// a shelter's door, or bring them to the helicopter. Zombies go for them too (see horde.ts, Targets).
//
// State lives in parallel typed arrays, mutated in place, like the horde. Pure and seeded: no DOM, no
// Three.js, no clocks.

import { nextFloat, nextRange, type Rng } from '../lib/rng';
import { clearance, moveCircle, resolveCircle, type Colliders } from './colliders';
import { flowStep, type FlowField } from './flow';
import { angleDelta } from './player';
import { lineOfSight } from './raycast';
import { validSpot, type GameWorld } from './world';

export const CIVILIAN = {
  radius: 0.34,
  health: 40,
  /** A little slower than the survivor walks (3.2 m/s), and a burst to catch up when left behind. */
  walk: 3.0,
  catchUp: 4.6,
  /** How close a follower stays to the survivor. */
  followGap: 2.4,
  /** How close you must come to a hiding survivor, with a clear line, for them to join you. */
  recruit: 3.6,
  /** Followers this close to a shelter's door go in with you. */
  shelterRange: 12,
  /** Followers this close to the helicopter when it lands are saved. */
  saveRange: 30,
  /** Seconds a body lies there. */
  linger: 8,
} as const;

export const CState = {
  /** Waiting where they are, afraid. */
  HIDING: 0,
  /** Coming with you. */
  FOLLOWING: 1,
  /** Behind a shelter's door. */
  SHELTERED: 2,
  DEAD: 3,
  /** Taken off by the helicopter. */
  SAVED: 4,
} as const;

export interface Civilians {
  count: number;
  /** How many of the slots hold a real person in this game (the rest could not be placed). */
  placed: number;
  x: Float32Array;
  y: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  heading: Float32Array;
  health: Float32Array;
  state: Uint8Array;
  /** For the sheltered: which shelter (a place id); otherwise -1. */
  shelter: Int16Array;
  deadT: Float32Array;
  /** Seconds spent pushing against something without getting anywhere. */
  stuck: Float32Array;
  /** Total distance walked, which drives the walk animation. */
  travelled: Float32Array;
  /** Scratch: who was nudged this step. */
  pushed: Uint8Array;
}

export function createCivilians(count: number): Civilians {
  return {
    count,
    placed: count,
    x: new Float32Array(count),
    y: new Float32Array(count),
    vx: new Float32Array(count),
    vy: new Float32Array(count),
    heading: new Float32Array(count),
    health: new Float32Array(count).fill(CIVILIAN.health),
    state: new Uint8Array(count),
    shelter: new Int16Array(count).fill(-1),
    deadT: new Float32Array(count),
    stuck: new Float32Array(count),
    travelled: new Float32Array(count),
    pushed: new Uint8Array(count),
  };
}

/**
 * Put `count` survivors into hiding around the start, each tucked in close to a building and out of
 * everyone's way: some way from the start and from one another. Returns how many could be placed.
 */
export function hideCivilians(
  c: Civilians,
  world: GameWorld,
  rng: Rng,
  start: readonly [number, number],
): number {
  let placed = 0;
  for (let i = 0; i < c.count; i++) {
    for (let attempt = 0; attempt < 400; attempt++) {
      const a = nextFloat(rng) * Math.PI * 2;
      const r = nextRange(rng, 60, 520);
      const x = start[0] + Math.cos(a) * r;
      const y = start[1] + Math.sin(a) * r;
      if (!validSpot(world, x, y, 1.5)) continue;
      // against a wall if we can (a doorway or an alley), anywhere decent if not
      if (attempt < 250 && clearance(world.colliders, x, y, 6) > 3.2) continue;
      let clash = false;
      for (let j = 0; j < placed; j++) {
        if (Math.hypot(c.x[j] - x, c.y[j] - y) < (attempt < 300 ? 35 : 12)) {
          clash = true;
          break;
        }
      }
      if (clash) continue;
      c.x[placed] = x;
      c.y[placed] = y;
      c.heading[placed] = nextFloat(rng) * Math.PI * 2;
      c.state[placed] = CState.HIDING;
      placed++;
      break;
    }
  }
  // any that could not be placed are simply not part of this game
  c.placed = placed;
  for (let i = placed; i < c.count; i++) c.state[i] = CState.DEAD;
  for (let i = placed; i < c.count; i++) c.deadT[i] = CIVILIAN.linger + 1;
  return placed;
}

export interface CivilianContext {
  colliders: Colliders;
  /** The flow field toward the survivor, for finding a way round buildings. */
  flow: FlowField;
  px: number;
  py: number;
  /** The survivor is indoors: nobody can join them, and followers wait. */
  hidden: boolean;
  /** False once the game is over. */
  playing: boolean;
}

/** How many are in a state. */
export function countIn(c: Civilians, state: number): number {
  let n = 0;
  for (let i = 0; i < c.count; i++) if (c.state[i] === state) n++;
  return n;
}

/** Advance everyone by `dt` seconds. Returns how many joined the survivor this step. */
export function stepCivilians(c: Civilians, ctx: CivilianContext, dt: number): number {
  let recruited = 0;
  const near2 = CIVILIAN.recruit * CIVILIAN.recruit;
  for (let i = 0; i < c.count; i++) {
    const state = c.state[i];
    if (state === CState.DEAD) {
      c.deadT[i] += dt;
      continue;
    }
    if (state === CState.SHELTERED || state === CState.SAVED) continue;
    const dx = ctx.px - c.x[i];
    const dy = ctx.py - c.y[i];
    const d2 = dx * dx + dy * dy;

    if (state === CState.HIDING) {
      if (
        ctx.playing &&
        !ctx.hidden &&
        d2 < near2 &&
        lineOfSight(ctx.colliders, c.x[i], c.y[i], ctx.px, ctx.py)
      ) {
        c.state[i] = CState.FOLLOWING;
        recruited++;
      }
      continue;
    }
    follow(c, i, ctx, Math.sqrt(d2), dx, dy, dt);
  }
  if (ctx.playing) separate(c, ctx);
  return recruited;
}

/** Keep up with the survivor, going round whatever is in the way. */
function follow(
  c: Civilians,
  i: number,
  ctx: CivilianContext,
  d: number,
  dx: number,
  dy: number,
  dt: number,
): void {
  let wishX = 0;
  let wishY = 0;
  if (ctx.playing && !ctx.hidden && d > CIVILIAN.followGap) {
    // faster the further behind: a burst to catch up, easing off as they close in
    const speed = Math.min(
      CIVILIAN.catchUp,
      Math.max(1, CIVILIAN.walk + (d - 6) * 0.35) *
        Math.min(1, (d - CIVILIAN.followGap) / 1.2 + 0.25),
    );
    let ux = dx / d;
    let uy = dy / d;
    // round a corner, follow the flow field; in the open, go straight
    if (c.stuck[i] > 0.4 || !lineOfSight(ctx.colliders, c.x[i], c.y[i], ctx.px, ctx.py)) {
      const step = flowStep(ctx.flow, c.x[i], c.y[i]);
      if (step) {
        ux = step[0];
        uy = step[1];
      }
    }
    wishX = ux * speed;
    wishY = uy * speed;
  }
  const k = Math.min(1, 8 * dt);
  c.vx[i] += (wishX - c.vx[i]) * k;
  c.vy[i] += (wishY - c.vy[i]) * k;
  const speed = Math.hypot(c.vx[i], c.vy[i]);
  if (speed < 0.01) {
    c.stuck[i] = 0;
    return;
  }
  const [nx, ny] = moveCircle(
    ctx.colliders,
    c.x[i],
    c.y[i],
    c.x[i] + c.vx[i] * dt,
    c.y[i] + c.vy[i] * dt,
    CIVILIAN.radius,
  );
  const moved = Math.hypot(nx - c.x[i], ny - c.y[i]);
  c.stuck[i] = moved < speed * dt * 0.3 ? c.stuck[i] + dt : Math.max(0, c.stuck[i] - dt);
  c.x[i] = nx;
  c.y[i] = ny;
  c.travelled[i] += moved;
  if (speed > 0.3) {
    const turn = angleDelta(c.heading[i], Math.atan2(c.vy[i], c.vx[i]));
    const most = 9 * dt;
    c.heading[i] += Math.abs(turn) <= most ? turn : Math.sign(turn) * most;
  }
}

/** Keep people from standing on one another or on the survivor. */
function separate(c: Civilians, ctx: CivilianContext): void {
  const gap = CIVILIAN.radius * 2.2;
  const keep = 1.3; // from the survivor
  const moved = c.pushed;
  moved.fill(0);
  for (let i = 0; i < c.count; i++) {
    const si = c.state[i];
    if (si !== CState.FOLLOWING && si !== CState.HIDING) continue;
    for (let j = i + 1; j < c.count; j++) {
      const sj = c.state[j];
      if (sj !== CState.FOLLOWING && sj !== CState.HIDING) continue;
      const dx = c.x[j] - c.x[i];
      const dy = c.y[j] - c.y[i];
      const d = Math.hypot(dx, dy);
      if (d >= gap) continue;
      const nx = d > 1e-4 ? dx / d : 1;
      const ny = d > 1e-4 ? dy / d : 0;
      const push = Math.min((gap - d) / 2, 0.05);
      c.x[i] -= nx * push;
      c.y[i] -= ny * push;
      c.x[j] += nx * push;
      c.y[j] += ny * push;
      moved[i] = 1;
      moved[j] = 1;
    }
    if (si === CState.FOLLOWING && !ctx.hidden) {
      const dx = c.x[i] - ctx.px;
      const dy = c.y[i] - ctx.py;
      const d = Math.hypot(dx, dy);
      if (d < keep) {
        const nx = d > 1e-4 ? dx / d : 1;
        const ny = d > 1e-4 ? dy / d : 0;
        c.x[i] = ctx.px + nx * keep;
        c.y[i] = ctx.py + ny * keep;
        moved[i] = 1;
      }
    }
  }
  // never into a wall
  for (let i = 0; i < c.count; i++) {
    if (!moved[i]) continue;
    const [x, y] = resolveCircle(ctx.colliders, c.x[i], c.y[i], CIVILIAN.radius);
    c.x[i] = x;
    c.y[i] = y;
  }
}

/** Hurt someone. Returns true if that killed them. */
export function hurtCivilian(c: Civilians, i: number, amount: number): boolean {
  if (c.state[i] !== CState.HIDING && c.state[i] !== CState.FOLLOWING) return false;
  c.health[i] -= amount;
  if (c.health[i] > 0) return false;
  c.health[i] = 0;
  c.state[i] = CState.DEAD;
  c.deadT[i] = 0;
  c.vx[i] = 0;
  c.vy[i] = 0;
  return true;
}

/** The survivor goes into a shelter: every follower near its door goes in too. Returns how many. */
export function takeShelter(c: Civilians, place: number, doorX: number, doorY: number): number {
  let n = 0;
  const r2 = CIVILIAN.shelterRange * CIVILIAN.shelterRange;
  for (let i = 0; i < c.count; i++) {
    if (c.state[i] !== CState.FOLLOWING) continue;
    if ((c.x[i] - doorX) ** 2 + (c.y[i] - doorY) ** 2 > r2) continue;
    c.state[i] = CState.SHELTERED;
    c.shelter[i] = place;
    c.vx[i] = 0;
    c.vy[i] = 0;
    n++;
  }
  return n;
}

/** How many are behind a shelter's door. */
export function occupants(c: Civilians, place: number): number {
  let n = 0;
  for (let i = 0; i < c.count; i++)
    if (c.state[i] === CState.SHELTERED && c.shelter[i] === place) n++;
  return n;
}

/** The door gave way: everyone behind it is lost. Returns how many. */
export function loseShelter(c: Civilians, place: number): number {
  let n = 0;
  for (let i = 0; i < c.count; i++) {
    if (c.state[i] !== CState.SHELTERED || c.shelter[i] !== place) continue;
    c.state[i] = CState.DEAD;
    c.deadT[i] = CIVILIAN.linger + 1; // they die out of sight, indoors
    c.shelter[i] = -1;
    n++;
  }
  return n;
}

/**
 * The helicopter lands. Followers close to it are taken aboard, and so is everyone safe behind a door
 * that held. Returns how many were saved.
 */
export function evacuate(c: Civilians, landX: number, landY: number): number {
  let n = 0;
  const r2 = CIVILIAN.saveRange * CIVILIAN.saveRange;
  for (let i = 0; i < c.count; i++) {
    const s = c.state[i];
    const near = s === CState.FOLLOWING && (c.x[i] - landX) ** 2 + (c.y[i] - landY) ** 2 <= r2;
    if (!near && s !== CState.SHELTERED) continue;
    c.state[i] = CState.SAVED;
    c.shelter[i] = -1;
    n++;
  }
  return n;
}
