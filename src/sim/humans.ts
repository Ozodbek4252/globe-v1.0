// The people in the street: a few percent of the city, as individuals. They wander about, run from
// zombies (for the nearest door if there is one), and if a zombie gets them they stagger on for a few
// seconds and then turn. Everyone else is indoors and counted per building (see population.ts).
//
// State lives in parallel typed arrays, mutated in place, like the horde. Pure and seeded: no DOM, no
// Three.js, no clocks.

import { createRng, nextFloat, nextRange, type Rng } from '../lib/rng';
import { moveCircleLong, type Colliders } from './colliders';
import { navCell, type NavGrid } from './flow';
import { isAlive, type Horde, type Noise } from './horde';
import { angleDelta } from './player';
import { lineOfSight } from './raycast';
import { forEachNear, type PointIndex } from './spatial';
import type { Outbreak } from './population';

export const HState = {
  /** Going about their day. */
  WALK: 0,
  /** Running from something. */
  FLEE: 1,
  /** Bitten: staggering on, about to turn. */
  BITTEN: 2,
  /** An unused slot. */
  FREE: 3,
} as const;

/** Tuning, in metres and seconds. */
export const HUMAN = {
  radius: 0.34,
  walk: 1.25,
  /** A frightened person's pace: slower than the survivor's sprint (7.6), faster than a walker (2.3). */
  flee: 4.1,
  /** How slowly the bitten stagger, and how long before they turn. */
  bitten: 0.6,
  incubation: 7,
  /** How far they notice a zombie (with a clear line, or at once when it is very close). */
  sight: 15,
  /** How long a scare lasts, after the last sign of danger. */
  scare: 4.5,
  /** Beyond this from the survivor they are simulated coarsely: every fourth step with a four times longer step. */
  farRange: 220,
  perceptionEvery: 12,
  accel: 9,
  turnRate: 9,
} as const;

export interface Humans {
  capacity: number;
  /** One past the highest slot ever used. */
  used: number;
  /** People standing about outdoors (not bitten, not gone). */
  alive: number;
  x: Float32Array;
  y: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  heading: Float32Array;
  /** Personal pace multiplier. */
  pace: Float32Array;
  /** Idle time (walking), scare left (fleeing), time to turn (bitten). */
  timer: Float32Array;
  /** Where they are heading (NaN: nowhere yet); for a runner, the direction they are running in. */
  tx: Float32Array;
  ty: Float32Array;
  stuck: Float32Array;
  /** Total distance walked, which drives the walk animation. */
  travelled: Float32Array;
  state: Uint8Array;
  freeList: Int32Array;
  freeCount: number;
  rng: Rng;
}

export function createHumans(capacity: number, seed: number): Humans {
  return {
    capacity,
    used: 0,
    alive: 0,
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    vx: new Float32Array(capacity),
    vy: new Float32Array(capacity),
    heading: new Float32Array(capacity),
    pace: new Float32Array(capacity),
    timer: new Float32Array(capacity),
    tx: new Float32Array(capacity),
    ty: new Float32Array(capacity),
    stuck: new Float32Array(capacity),
    travelled: new Float32Array(capacity),
    state: new Uint8Array(capacity).fill(HState.FREE),
    freeList: new Int32Array(capacity),
    freeCount: 0,
    rng: createRng(seed),
  };
}

/** Put a person in the street. Returns their slot, or -1 if the street is full. */
export function spawnHuman(h: Humans, x: number, y: number, state: number = HState.WALK): number {
  let i: number;
  if (h.freeCount > 0) i = h.freeList[--h.freeCount];
  else if (h.used < h.capacity) i = h.used++;
  else return -1;
  h.x[i] = x;
  h.y[i] = y;
  h.vx[i] = 0;
  h.vy[i] = 0;
  h.heading[i] = nextFloat(h.rng) * Math.PI * 2;
  h.pace[i] = 0.85 + nextFloat(h.rng) * 0.3;
  h.timer[i] = state === HState.WALK ? nextFloat(h.rng) * 6 : HUMAN.scare;
  h.tx[i] = Number.NaN;
  h.ty[i] = Number.NaN;
  h.stuck[i] = 0;
  h.travelled[i] = nextFloat(h.rng) * 100;
  h.state[i] = state;
  h.alive++;
  return i;
}

function release(h: Humans, i: number): void {
  if (h.state[i] !== HState.BITTEN) h.alive--;
  h.state[i] = HState.FREE;
  h.freeList[h.freeCount++] = i;
}

/** A zombie got them: they stagger on for a few seconds, then turn. Returns false if they were not free to be bitten. */
export function biteHuman(h: Humans, i: number): boolean {
  if (h.state[i] !== HState.WALK && h.state[i] !== HState.FLEE) return false;
  h.state[i] = HState.BITTEN;
  h.timer[i] = HUMAN.incubation;
  h.alive--; // no longer someone the horde goes for, nor someone the radar counts as well
  return true;
}

export interface HumanContext {
  colliders: Colliders;
  nav: NavGrid;
  reachable: Uint8Array;
  horde: Horde;
  /** Where the zombies are (rebuilt each step by the caller). */
  zombies: PointIndex;
  /** Where the doors are (built once). */
  doors: PointIndex;
  outbreak: Outbreak;
  noises: readonly Noise[];
  /** The survivor, to know which people are far enough away to simulate coarsely. */
  px: number;
  py: number;
  /** Someone came in out of the street through a building's door. */
  onEnter: (building: number) => void;
  /** Someone bitten has turned, here. */
  onTurn: (x: number, y: number) => void;
}

// ---- what a person notices ---------------------------------------------------------------------------
const scan = {
  ctx: null as HumanContext | null,
  x: 0,
  y: 0,
  threatX: 0,
  threatY: 0,
  threats: 0,
  doorBest: -1,
  doorBestD2: 0,
};

function visitZombie(z: number, d2: number): void {
  const ctx = scan.ctx;
  if (!ctx || !isAlive(ctx.horde, z)) return;
  // close by, they know at once; farther off they need a clear line
  if (d2 > 25 && !lineOfSight(ctx.colliders, scan.x, scan.y, ctx.horde.x[z], ctx.horde.y[z]))
    return;
  const w = 1 / Math.max(d2, 1);
  scan.threatX += (scan.x - ctx.horde.x[z]) * w;
  scan.threatY += (scan.y - ctx.horde.y[z]) * w;
  scan.threats++;
}

function visitDoor(b: number, d2: number): void {
  const ctx = scan.ctx;
  if (!ctx || ctx.outbreak.open[b] || d2 >= scan.doorBestD2) return;
  scan.doorBest = b;
  scan.doorBestD2 = d2;
}

/** Look around: is something coming? If so, run, away from it and toward a door if there is one. */
function sense(h: Humans, i: number, ctx: HumanContext): void {
  const s = h.state[i];
  if (s !== HState.WALK && s !== HState.FLEE) return;
  const x = h.x[i];
  const y = h.y[i];
  scan.ctx = ctx;
  scan.x = x;
  scan.y = y;
  scan.threatX = 0;
  scan.threatY = 0;
  scan.threats = 0;
  forEachNear(ctx.zombies, x, y, HUMAN.sight, ctx.horde.x, ctx.horde.y, visitZombie);
  // a gunshot or a scream nearby sends people running too, away from where it was
  for (const n of ctx.noises) {
    if (n.ttl <= 0 || n.radius < 30) continue; // footsteps do not scare anyone; gunfire does
    const dx = x - n.x;
    const dy = y - n.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > n.radius * n.radius || d2 < 1) continue;
    scan.threatX += dx / d2;
    scan.threatY += dy / d2;
    scan.threats++;
  }
  if (scan.threats === 0) return;

  let ax = scan.threatX;
  let ay = scan.threatY;
  const len = Math.hypot(ax, ay) || 1;
  ax /= len;
  ay /= len;
  // a door within reach is somewhere to go, so long as it is not toward the danger
  scan.doorBest = -1;
  scan.doorBestD2 = 40 * 40;
  forEachNear(ctx.doors, x, y, 40, ctx.outbreak.doorX, ctx.outbreak.doorY, visitDoor);
  if (scan.doorBest >= 0) {
    const dx = ctx.outbreak.doorX[scan.doorBest] - x;
    const dy = ctx.outbreak.doorY[scan.doorBest] - y;
    const d = Math.hypot(dx, dy) || 1;
    if ((dx / d) * ax + (dy / d) * ay > -0.35) {
      ax = ax * 0.5 + (dx / d) * 1.1;
      ay = ay * 0.5 + (dy / d) * 1.1;
      const n = Math.hypot(ax, ay) || 1;
      ax /= n;
      ay /= n;
    }
  }
  h.state[i] = HState.FLEE;
  h.timer[i] = HUMAN.scare;
  h.tx[i] = ax;
  h.ty[i] = ay;
}

// ---- moving about ------------------------------------------------------------------------------------
function walkAt(
  h: Humans,
  i: number,
  ctx: HumanContext,
  dirX: number,
  dirY: number,
  speed: number,
  dt: number,
): void {
  const k = Math.min(1, HUMAN.accel * dt);
  h.vx[i] += (dirX * speed - h.vx[i]) * k;
  h.vy[i] += (dirY * speed - h.vy[i]) * k;
  const v = Math.hypot(h.vx[i], h.vy[i]);
  if (v < 0.005) return;
  const x = h.x[i];
  const y = h.y[i];
  const [nx, ny] = moveCircleLong(
    ctx.colliders,
    x,
    y,
    x + h.vx[i] * dt,
    y + h.vy[i] * dt,
    HUMAN.radius,
  );
  const moved = Math.hypot(nx - x, ny - y);
  h.stuck[i] = moved < v * dt * 0.3 ? h.stuck[i] + dt : Math.max(0, h.stuck[i] - dt);
  h.x[i] = nx;
  h.y[i] = ny;
  h.travelled[i] += moved;
  if (v > 0.25) {
    const turn = angleDelta(h.heading[i], Math.atan2(h.vy[i], h.vx[i]));
    const most = HUMAN.turnRate * dt;
    h.heading[i] += Math.abs(turn) <= most ? turn : Math.sign(turn) * most;
  }
}

function pickTarget(h: Humans, i: number, ctx: HumanContext): boolean {
  for (let attempt = 0; attempt < 6; attempt++) {
    const a = nextFloat(h.rng) * Math.PI * 2;
    const r = nextRange(h.rng, 8, 28);
    const tx = h.x[i] + Math.cos(a) * r;
    const ty = h.y[i] + Math.sin(a) * r;
    const cx = navCell(ctx.nav, tx);
    const cy = navCell(ctx.nav, ty);
    if (cx < 0 || cy < 0 || cx >= ctx.nav.size || cy >= ctx.nav.size) continue;
    const index = cy * ctx.nav.size + cx;
    if (!ctx.nav.open[index] || !ctx.reachable[index]) continue;
    h.tx[i] = tx;
    h.ty[i] = ty;
    return true;
  }
  return false;
}

const doorProbe = { ctx: null as HumanContext | null, best: -1, bestD2: 0 };
function visitNearDoor(b: number, d2: number): void {
  const ctx = doorProbe.ctx;
  if (!ctx || ctx.outbreak.open[b] || d2 >= doorProbe.bestD2) return;
  doorProbe.best = b;
  doorProbe.bestD2 = d2;
}

function stepOne(h: Humans, i: number, ctx: HumanContext, dt: number): void {
  const state = h.state[i];
  if (state === HState.BITTEN) {
    h.timer[i] -= dt;
    if (h.timer[i] <= 0) {
      const x = h.x[i];
      const y = h.y[i];
      release(h, i);
      ctx.onTurn(x, y);
      return;
    }
    // staggering about, no longer sure of anything
    if (Number.isNaN(h.tx[i]) || h.stuck[i] > 1) {
      pickTarget(h, i, ctx);
      h.stuck[i] = 0;
    }
    const dx = h.tx[i] - h.x[i];
    const dy = h.ty[i] - h.y[i];
    const d = Math.hypot(dx, dy) || 1;
    walkAt(h, i, ctx, dx / d, dy / d, HUMAN.bitten, dt);
    return;
  }

  if (state === HState.FLEE) {
    h.timer[i] -= dt;
    if (h.timer[i] <= 0) {
      h.state[i] = HState.WALK;
      h.timer[i] = 1 + nextFloat(h.rng) * 3;
      h.tx[i] = Number.NaN;
      return;
    }
    // jammed against a wall: veer off to one side and try again
    if (h.stuck[i] > 0.4) {
      const a = Math.atan2(h.ty[i], h.tx[i]) + (nextFloat(h.rng) < 0.5 ? 1.2 : -1.2);
      h.tx[i] = Math.cos(a);
      h.ty[i] = Math.sin(a);
      h.stuck[i] = 0;
    }
    walkAt(h, i, ctx, h.tx[i], h.ty[i], HUMAN.flee * h.pace[i], dt);
    // reached a door: in, and the door shut behind them
    doorProbe.ctx = ctx;
    doorProbe.best = -1;
    doorProbe.bestD2 = 2.2 * 2.2;
    forEachNear(
      ctx.doors,
      h.x[i],
      h.y[i],
      2.2,
      ctx.outbreak.doorX,
      ctx.outbreak.doorY,
      visitNearDoor,
    );
    if (doorProbe.best >= 0) {
      release(h, i);
      ctx.onEnter(doorProbe.best);
    }
    return;
  }

  // walking about
  if (h.timer[i] > 0) {
    h.timer[i] -= dt;
    walkAt(h, i, ctx, 0, 0, 0, dt);
    return;
  }
  if (Number.isNaN(h.tx[i])) {
    if (!pickTarget(h, i, ctx)) {
      h.timer[i] = 2;
      return;
    }
    h.stuck[i] = 0;
  }
  const dx = h.tx[i] - h.x[i];
  const dy = h.ty[i] - h.y[i];
  const d = Math.hypot(dx, dy);
  if (d < 1.2 || h.stuck[i] > 1) {
    h.tx[i] = Number.NaN;
    h.timer[i] = 2 + nextFloat(h.rng) * 8;
    h.stuck[i] = 0;
    return;
  }
  walkAt(h, i, ctx, dx / d, dy / d, HUMAN.walk * h.pace[i], dt);
}

/** Advance everyone by `dt` seconds (keep it small, ideally 1/60). */
export function stepHumans(h: Humans, ctx: HumanContext, dt: number, tick: number): void {
  const far2 = HUMAN.farRange * HUMAN.farRange;
  for (let i = 0; i < h.used; i++) {
    if (h.state[i] === HState.FREE) continue;
    const dx = ctx.px - h.x[i];
    const dy = ctx.py - h.y[i];
    const far = dx * dx + dy * dy > far2;
    if (far && ((i + tick) & 3) !== 0) continue;
    const step = far ? dt * 4 : dt;
    if ((i + tick) % HUMAN.perceptionEvery === 0) sense(h, i, ctx);
    stepOne(h, i, ctx, step);
  }
}
