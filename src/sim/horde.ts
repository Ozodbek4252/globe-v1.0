// The horde: hundreds of zombies, each a small mind with eyes, ears and a nose. Pure and seeded: the
// same horde, noises and survivor position always give the same next step. No DOM, no Three.js.
//
// State lives in parallel typed arrays (one slot per zombie), mutated in place, so a thousand
// zombies cost no allocation per step. Slots are reused when the dead are cleared away.

import { createRng, nextFloat, nextRange, type Rng } from '../lib/rng';
import { moveCircle, resolveCircle, type Colliders } from './colliders';
import { flowStep, navCell, type FlowField, type NavGrid } from './flow';
import { lineOfSight } from './raycast';
import { angleDelta, PLAYER } from './player';

export const ZState = {
  /** Shambling about, not yet aware of anyone. */
  WANDER: 0,
  /** Heard something: heading to where it was. */
  INVESTIGATE: 1,
  /** Knows where the survivor is and is coming. */
  CHASE: 2,
  /** Close enough to strike: winding up, then recovering. */
  ATTACK: 3,
  /** Down. Lies there for a while, then the slot is freed. */
  DEAD: 4,
  /** An unused slot. */
  FREE: 5,
} as const;

export const ZKind = { WALKER: 0, RUNNER: 1 } as const;

/** Tuning in metres and seconds. */
export const ZOMBIE = {
  radius: 0.34,
  kinds: [
    // walkers are slower than a walking survivor (3.2 m/s); runners are faster, but slower than a sprint (6.2)
    { health: 100, chase: 2.3, damage: 14, windup: 0.5, cooldown: 1.2 },
    { health: 50, chase: 3.7, damage: 9, windup: 0.32, cooldown: 0.9 },
  ],
  wanderSpeed: 0.8,
  investigateSpeed: 1.5,
  /** How far one sees (in front, with a clear line), how far once on the trail, and how far one smells. */
  sight: 26,
  chaseSight: 36,
  smell: 3.5,
  /** cos of the half-angle of the field of view; -0.2 is about 100 degrees each side. */
  fovCos: -0.2,
  /** Centre-to-centre distance at which a zombie starts to strike, and at which a strike still lands. */
  attackStart: 1.05,
  attackReach: 1.5,
  /** Seconds without a sign of the survivor before a chaser gives up the trail. */
  loseTrack: 6,
  /** A chasing zombie rouses others this close. */
  alertRadius: 9,
  /** How far it sees a target in the open (with a clear line), and how far it notices one while chasing. */
  targetSight: 16,
  targetNear: 5,
  /** Each zombie thinks (senses) once every this many steps, staggered across the horde. */
  perceptionEvery: 12,
  /** Seconds a body lies there. */
  linger: 6,
  /** Beyond this the horde is simulated coarsely: every fourth step with a four times longer step. */
  farRange: 130,
  /** Zombies are kept from stacking within this window around the survivor. */
  windowRadius: 96,
  cell: 4,
  /** How quickly velocity follows the wish (per second) and how fast a zombie turns (radians/s). */
  accel: 7,
  turnRate: 9,
} as const;

export interface Noise {
  x: number;
  y: number;
  /** Zombies this close hear it. */
  radius: number;
  /** Seconds left. */
  ttl: number;
}

/**
 * Other things a zombie can go for besides the survivor: people hiding or walking in the open, and the
 * doors of shelters with people behind them. Slots are stable (a zombie remembers its target by slot), so
 * the caller fills and empties slots, and zombies never learn who is in them.
 */
export interface Targets {
  /** Number of slots. */
  count: number;
  x: Float32Array;
  y: Float32Array;
  /** 1 when the slot holds something to go for. */
  active: Uint8Array;
  /** Damage zombies have dealt to each slot. The caller applies it and clears it. */
  damage: Float32Array;
}

export function createTargets(count: number): Targets {
  return {
    count,
    x: new Float32Array(count),
    y: new Float32Array(count),
    active: new Uint8Array(count),
    damage: new Float32Array(count),
  };
}

export interface HordeContext {
  world: Colliders;
  /** Anything else to go for. Optional: with none, zombies only ever hunt the survivor. */
  targets?: Targets;
  nav: NavGrid;
  /** The flow field toward the survivor; the caller keeps it up to date. */
  flow: FlowField;
  /** 1 on walkable ground that connects to the survivor's start. */
  reachable: Uint8Array;
  px: number;
  py: number;
  /** False once the survivor is down: zombies lose interest. */
  playerAlive: boolean;
  /**
   * The survivor is indoors, behind a door: nothing can see, smell or hear them. Zombies already on
   * the trail still come to the door, and what they do to the survivor they do to the door instead.
   */
  hidden?: boolean;
  noises: readonly Noise[];
}

interface HordeGrid {
  side: number;
  originX: number;
  originY: number;
  start: Int32Array;
  items: Int32Array;
  fill: Int32Array;
  /** The grid cell each zombie is in this step, or -1 if outside the window. */
  cellOf: Int32Array;
}

export interface Horde {
  capacity: number;
  /** One past the highest slot ever used. Slots below it may be free; check `state`. */
  used: number;
  /** Zombies standing (alive). */
  alive: number;
  x: Float32Array;
  y: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  heading: Float32Array;
  health: Float32Array;
  /** Personal speed multiplier, so no two zombies keep step. */
  pace: Float32Array;
  /** State clock: idle time (wander), time on a trail (investigate), time since last seen (chase). */
  timer: Float32Array;
  /** Time into the current attack phase. */
  attackT: Float32Array;
  /** Seconds left reeling from a shove or a hit. */
  stun: Float32Array;
  /** Seconds since death. */
  deadT: Float32Array;
  /** Where it is heading (NaN: no destination yet). */
  tx: Float32Array;
  ty: Float32Array;
  /** Seconds spent pushing against something without getting anywhere. */
  stuck: Float32Array;
  /** The target slot this zombie is going for instead of the survivor, or -1. */
  victim: Int16Array;
  kind: Uint8Array;
  state: Uint8Array;
  /** Attack phase: 0 winding up, 1 recovering. */
  phase: Uint8Array;
  /** Whether it had a clear line to the survivor when it last looked. */
  clear: Uint8Array;
  freeList: Int32Array;
  freeCount: number;
  rng: Rng;
  grid: HordeGrid;
  /** Outputs of the latest step. */
  damage: number;
  /** Damage dealt to the door the survivor is behind (when hidden). */
  doorDamage: number;
  /** Zombies with their hands on the survivor right now. */
  engaged: number;
  lastHitX: number;
  lastHitY: number;
  pushed: Uint8Array;
}

export function createHorde(capacity: number, seed: number): Horde {
  const side = Math.ceil((ZOMBIE.windowRadius * 2) / ZOMBIE.cell);
  return {
    capacity,
    used: 0,
    alive: 0,
    x: new Float32Array(capacity),
    y: new Float32Array(capacity),
    vx: new Float32Array(capacity),
    vy: new Float32Array(capacity),
    heading: new Float32Array(capacity),
    health: new Float32Array(capacity),
    pace: new Float32Array(capacity),
    timer: new Float32Array(capacity),
    attackT: new Float32Array(capacity),
    stun: new Float32Array(capacity),
    deadT: new Float32Array(capacity),
    tx: new Float32Array(capacity),
    ty: new Float32Array(capacity),
    stuck: new Float32Array(capacity),
    victim: new Int16Array(capacity).fill(-1),
    kind: new Uint8Array(capacity),
    state: new Uint8Array(capacity).fill(ZState.FREE),
    phase: new Uint8Array(capacity),
    clear: new Uint8Array(capacity),
    freeList: new Int32Array(capacity),
    freeCount: 0,
    rng: createRng(seed),
    grid: {
      side,
      originX: 0,
      originY: 0,
      start: new Int32Array(side * side + 1),
      items: new Int32Array(capacity),
      fill: new Int32Array(side * side),
      cellOf: new Int32Array(capacity).fill(-1),
    },
    damage: 0,
    doorDamage: 0,
    engaged: 0,
    lastHitX: 0,
    lastHitY: 0,
    pushed: new Uint8Array(capacity),
  };
}

/** Add a zombie. Returns its slot, or -1 if the horde is full. */
export function spawnZombie(
  h: Horde,
  x: number,
  y: number,
  kind: number = ZKind.WALKER,
  state: number = ZState.WANDER,
): number {
  let i: number;
  if (h.freeCount > 0) i = h.freeList[--h.freeCount];
  else if (h.used < h.capacity) i = h.used++;
  else return -1;
  h.x[i] = x;
  h.y[i] = y;
  h.vx[i] = 0;
  h.vy[i] = 0;
  h.heading[i] = nextFloat(h.rng) * Math.PI * 2;
  h.health[i] = ZOMBIE.kinds[kind].health;
  h.pace[i] = 0.88 + nextFloat(h.rng) * 0.24;
  h.timer[i] = state === ZState.WANDER ? nextFloat(h.rng) * 3 : 0;
  h.attackT[i] = 0;
  h.stun[i] = 0;
  h.deadT[i] = 0;
  h.tx[i] = Number.NaN;
  h.ty[i] = Number.NaN;
  h.stuck[i] = 0;
  h.victim[i] = -1;
  h.kind[i] = kind;
  h.state[i] = state;
  h.phase[i] = 0;
  h.clear[i] = 0;
  h.alive++;
  return i;
}

export function isAlive(h: Horde, i: number): boolean {
  return h.state[i] < ZState.DEAD;
}

function kill(h: Horde, i: number): void {
  h.state[i] = ZState.DEAD;
  h.deadT[i] = 0;
  h.vx[i] = 0;
  h.vy[i] = 0;
  h.alive--;
}

function release(h: Horde, i: number): void {
  h.state[i] = ZState.FREE;
  h.freeList[h.freeCount++] = i;
}

/** Hurt a zombie. Returns true if that killed it. A hit also turns it on whoever hit it. */
export function damageZombie(
  h: Horde,
  i: number,
  amount: number,
  fromX: number,
  fromY: number,
): boolean {
  if (!isAlive(h, i)) return false;
  h.health[i] -= amount;
  if (h.health[i] <= 0) {
    kill(h, i);
    return true;
  }
  // flinch, lurch away from the blow, and come for the one who did it
  const dx = h.x[i] - fromX;
  const dy = h.y[i] - fromY;
  const d = Math.hypot(dx, dy) || 1;
  h.vx[i] = (dx / d) * 1.5;
  h.vy[i] = (dy / d) * 1.5;
  h.stun[i] = Math.max(h.stun[i], 0.18);
  if (h.state[i] !== ZState.ATTACK) h.state[i] = ZState.CHASE;
  h.timer[i] = 0;
  // it knows where the blow came from, so if it loses sight it goes to that spot
  h.tx[i] = fromX;
  h.ty[i] = fromY;
  h.victim[i] = -1; // and it turns on whoever did it, not on whoever it was after
  return false;
}

/** Throw a zombie back and leave it reeling. */
export function shoveZombie(
  h: Horde,
  i: number,
  dirX: number,
  dirY: number,
  speed: number,
  stunSeconds: number,
): void {
  if (!isAlive(h, i)) return;
  h.vx[i] = dirX * speed;
  h.vy[i] = dirY * speed;
  h.stun[i] = Math.max(h.stun[i], stunSeconds);
  if (h.state[i] === ZState.ATTACK) {
    h.state[i] = ZState.CHASE;
    h.phase[i] = 0;
    h.attackT[i] = 0;
  }
}

/** Send a zombie to a place: it goes to see what is there. */
export function sendTo(h: Horde, i: number, x: number, y: number): void {
  if (!isAlive(h, i)) return;
  h.state[i] = ZState.INVESTIGATE;
  h.tx[i] = x;
  h.ty[i] = y;
  h.timer[i] = 0;
  h.stuck[i] = 0;
}

/** Put a zombie on the survivor's trail for a long while (it gives up only after `seconds`). */
export function sendHunting(h: Horde, i: number, seconds: number): void {
  if (!isAlive(h, i)) return;
  h.state[i] = ZState.CHASE;
  h.timer[i] = ZOMBIE.loseTrack - seconds;
}

/** A number summarising where every zombie is and what it is doing: for tests that compare two runs. */
export function hordeChecksum(h: Horde): number {
  let sum = 0;
  for (let i = 0; i < h.used; i++) {
    if (h.state[i] === ZState.FREE) continue;
    sum += h.x[i] * 1.1 + h.y[i] * 1.7 + h.state[i] * 13 + h.health[i] * 0.01;
  }
  return sum;
}

// ---------------------------------------------------------------------------------------------------

/** Advance every zombie by `dt` seconds. Returns the damage the survivor took this step. */
export function stepHorde(h: Horde, ctx: HordeContext, dt: number, tick: number): number {
  h.damage = 0;
  h.doorDamage = 0;
  h.engaged = 0;
  buildGrid(h, ctx.px, ctx.py);
  const far2 = ZOMBIE.farRange * ZOMBIE.farRange;
  for (let i = 0; i < h.used; i++) {
    const s = h.state[i];
    if (s === ZState.FREE) continue;
    if (s === ZState.DEAD) {
      h.deadT[i] += dt;
      if (h.deadT[i] > ZOMBIE.linger) release(h, i);
      continue;
    }
    const dx = ctx.px - h.x[i];
    const dy = ctx.py - h.y[i];
    const d2 = dx * dx + dy * dy;
    const far = d2 > far2;
    if (far && ((i + tick) & 3) !== 0) continue;
    const step = far ? dt * 4 : dt;
    if ((i + tick) % ZOMBIE.perceptionEvery === 0) perceive(h, i, ctx, d2, step);
    act(h, i, ctx, d2, step);
  }
  separate(h, ctx);
  return h.damage;
}

function buildGrid(h: Horde, px: number, py: number): void {
  const g = h.grid;
  const cell = ZOMBIE.cell;
  g.originX = Math.floor(px / cell) * cell - (g.side / 2) * cell;
  g.originY = Math.floor(py / cell) * cell - (g.side / 2) * cell;
  g.start.fill(0);
  for (let i = 0; i < h.used; i++) {
    g.cellOf[i] = -1;
    if (h.state[i] >= ZState.DEAD) continue;
    const cx = Math.floor((h.x[i] - g.originX) / cell);
    const cy = Math.floor((h.y[i] - g.originY) / cell);
    if (cx < 0 || cy < 0 || cx >= g.side || cy >= g.side) continue;
    const c = cy * g.side + cx;
    g.cellOf[i] = c;
    g.start[c + 1]++;
  }
  for (let c = 0; c < g.side * g.side; c++) g.start[c + 1] += g.start[c];
  g.fill.set(g.start.subarray(0, g.side * g.side));
  for (let i = 0; i < h.used; i++) {
    const c = g.cellOf[i];
    if (c >= 0) g.items[g.fill[c]++] = i;
  }
}

/** Eyes, ears and nose. Runs for each zombie only every few steps. */
function perceive(h: Horde, i: number, ctx: HordeContext, d2: number, dt: number): void {
  const s = h.state[i];
  if (s === ZState.ATTACK || h.stun[i] > 0) return;
  const x = h.x[i];
  const y = h.y[i];
  const d = Math.sqrt(d2);
  const interval = dt * ZOMBIE.perceptionEvery;

  let aware = false;
  h.clear[i] = 0;
  if (ctx.playerAlive && !ctx.hidden) {
    const range = s === ZState.CHASE ? ZOMBIE.chaseSight : ZOMBIE.sight;
    if (d < range) {
      const clear = lineOfSight(ctx.world, x, y, ctx.px, ctx.py);
      h.clear[i] = clear ? 1 : 0;
      if (d < ZOMBIE.smell) aware = true;
      else if (clear) {
        const facing =
          s === ZState.CHASE ||
          (ctx.px - x) * Math.cos(h.heading[i]) + (ctx.py - y) * Math.sin(h.heading[i]) >
            ZOMBIE.fovCos * d;
        if (facing) aware = true;
      }
    }
  }

  const targets = ctx.targets;

  // A zombie already going for a target stays on it while it is there and not far off, unless the
  // survivor turns up close by.
  const victim = h.victim[i];
  if (victim >= 0) {
    const stillThere =
      targets !== undefined &&
      targets.active[victim] === 1 &&
      (targets.x[victim] - x) ** 2 + (targets.y[victim] - y) ** 2 < 22 * 22;
    if (stillThere && !(aware && d < ZOMBIE.targetNear)) return;
    if (stillThere) h.victim[i] = -1;
    else {
      dropVictim(h, i);
      if (!aware) return;
    }
  }

  if (aware) {
    if (s !== ZState.CHASE) rouse(h, i, ctx);
    h.timer[i] = 0;
    h.tx[i] = ctx.px;
    h.ty[i] = ctx.py;
    return;
  }

  // not aware of the survivor: is there someone else worth going for?
  if (targets) {
    const reach = s === ZState.CHASE ? ZOMBIE.targetNear : ZOMBIE.targetSight;
    let best = -1;
    let bestD2 = reach * reach;
    for (let k = 0; k < targets.count; k++) {
      if (targets.active[k] !== 1) continue;
      const dx = targets.x[k] - x;
      const dy = targets.y[k] - y;
      const dd = dx * dx + dy * dy;
      if (dd >= bestD2) continue;
      // close by, it smells them through anything; farther off it needs a clear line
      if (
        dd > ZOMBIE.smell * ZOMBIE.smell &&
        !lineOfSight(ctx.world, x, y, targets.x[k], targets.y[k])
      ) {
        continue;
      }
      best = k;
      bestD2 = dd;
    }
    if (best >= 0) {
      h.victim[i] = best;
      h.state[i] = ZState.CHASE;
      h.timer[i] = 0;
      h.stuck[i] = 0;
      return;
    }
  }

  if (s === ZState.CHASE) {
    h.timer[i] += interval;
    if (h.timer[i] > ZOMBIE.loseTrack) {
      h.timer[i] = 0;
      if (Number.isNaN(h.tx[i])) {
        h.state[i] = ZState.WANDER; // never saw anyone, only knew they were somewhere: just drift
        h.timer[i] = 1;
      } else h.state[i] = ZState.INVESTIGATE; // lost them: go to where they were last seen
    }
    return;
  }
  for (const n of ctx.noises) {
    if (n.ttl <= 0) continue;
    const nx = n.x - x;
    const ny = n.y - y;
    if (nx * nx + ny * ny < n.radius * n.radius) {
      h.state[i] = ZState.INVESTIGATE;
      h.tx[i] = n.x;
      h.ty[i] = n.y;
      h.timer[i] = 0;
      h.stuck[i] = 0;
      return;
    }
  }
}

/** Stop going for a target and drift off. */
function dropVictim(h: Horde, i: number): void {
  h.victim[i] = -1;
  h.state[i] = ZState.WANDER;
  h.timer[i] = 1;
  h.tx[i] = Number.NaN;
  h.stuck[i] = 0;
}

/** A zombie has just spotted the survivor: it starts to chase and its groans bring the neighbours. */
function rouse(h: Horde, i: number, ctx: HordeContext): void {
  h.state[i] = ZState.CHASE;
  h.timer[i] = 0;
  const g = h.grid;
  const c = g.cellOf[i];
  if (c < 0) return;
  const cx = c % g.side;
  const cy = (c - cx) / g.side;
  const r2 = ZOMBIE.alertRadius * ZOMBIE.alertRadius;
  for (let gy = Math.max(0, cy - 2); gy <= Math.min(g.side - 1, cy + 2); gy++) {
    for (let gx = Math.max(0, cx - 2); gx <= Math.min(g.side - 1, cx + 2); gx++) {
      const cell = gy * g.side + gx;
      for (let k = g.start[cell]; k < g.start[cell + 1]; k++) {
        const j = g.items[k];
        if (j === i || h.state[j] !== ZState.WANDER) continue;
        const dx = h.x[j] - h.x[i];
        const dy = h.y[j] - h.y[i];
        if (dx * dx + dy * dy > r2) continue;
        h.state[j] = ZState.INVESTIGATE;
        h.tx[j] = ctx.px;
        h.ty[j] = ctx.py;
        h.timer[j] = 0;
        h.stuck[j] = 0;
      }
    }
  }
}

function act(h: Horde, i: number, ctx: HordeContext, d2: number, dt: number): void {
  // a victim only means something while chasing or striking
  if (h.victim[i] >= 0 && h.state[i] !== ZState.CHASE && h.state[i] !== ZState.ATTACK) {
    h.victim[i] = -1;
  }
  if (h.stun[i] > 0) {
    h.stun[i] -= dt;
    const k = Math.exp(-6 * dt);
    h.vx[i] *= k;
    h.vy[i] *= k;
    move(h, i, ctx, dt);
    return;
  }
  switch (h.state[i]) {
    case ZState.WANDER:
      wander(h, i, ctx, dt);
      break;
    case ZState.INVESTIGATE:
      investigate(h, i, ctx, dt);
      break;
    case ZState.CHASE:
      chase(h, i, ctx, d2, dt);
      break;
    case ZState.ATTACK:
      attack(h, i, ctx, d2, dt);
      break;
  }
}

/** Steer toward a wanted velocity, then move with walls in the way. */
function walk(
  h: Horde,
  i: number,
  ctx: HordeContext,
  dirX: number,
  dirY: number,
  speed: number,
  dt: number,
): void {
  const k = Math.min(1, ZOMBIE.accel * dt);
  h.vx[i] += (dirX * speed - h.vx[i]) * k;
  h.vy[i] += (dirY * speed - h.vy[i]) * k;
  move(h, i, ctx, dt);
}

function move(h: Horde, i: number, ctx: HordeContext, dt: number): void {
  const x = h.x[i];
  const y = h.y[i];
  const vx = h.vx[i];
  const vy = h.vy[i];
  const speed = Math.hypot(vx, vy);
  if (speed < 0.005) return;
  const [nx, ny] = moveCircle(ctx.world, x, y, x + vx * dt, y + vy * dt, ZOMBIE.radius);
  const moved = Math.hypot(nx - x, ny - y);
  h.stuck[i] = moved < speed * dt * 0.3 ? h.stuck[i] + dt : Math.max(0, h.stuck[i] - dt);
  h.x[i] = nx;
  h.y[i] = ny;
  if (speed > 0.25) {
    const turn = angleDelta(h.heading[i], Math.atan2(vy, vx));
    const most = ZOMBIE.turnRate * dt;
    h.heading[i] += Math.abs(turn) <= most ? turn : Math.sign(turn) * most;
  }
}

function pickWanderTarget(h: Horde, i: number, ctx: HordeContext): boolean {
  for (let attempt = 0; attempt < 6; attempt++) {
    const a = nextFloat(h.rng) * Math.PI * 2;
    const r = nextRange(h.rng, 6, 22);
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

function wander(h: Horde, i: number, ctx: HordeContext, dt: number): void {
  if (h.timer[i] > 0) {
    h.timer[i] -= dt;
    walk(h, i, ctx, 0, 0, 0, dt);
    return;
  }
  if (Number.isNaN(h.tx[i])) {
    if (!pickWanderTarget(h, i, ctx)) {
      h.timer[i] = 2;
      return;
    }
    h.stuck[i] = 0;
  }
  const dx = h.tx[i] - h.x[i];
  const dy = h.ty[i] - h.y[i];
  const d = Math.hypot(dx, dy);
  if (d < 1.2 || h.stuck[i] > 1) {
    h.tx[i] = Number.NaN; // arrived, or blocked: rest a while, then pick somewhere else
    h.timer[i] = 1 + nextFloat(h.rng) * 4;
    h.stuck[i] = 0;
    return;
  }
  walk(h, i, ctx, dx / d, dy / d, ZOMBIE.wanderSpeed * h.pace[i], dt);
}

function investigate(h: Horde, i: number, ctx: HordeContext, dt: number): void {
  h.timer[i] += dt;
  const tx = h.tx[i];
  const ty = h.ty[i];
  const dx = tx - h.x[i];
  const dy = ty - h.y[i];
  const d = Math.hypot(dx, dy);
  // an investigation always has a place to go; with none (d is NaN) there is nothing to do but drift
  if (!(d >= 1.5) || h.timer[i] > 14 || h.stuck[i] > 1.5) {
    h.state[i] = ZState.WANDER; // nothing here: drift off again
    h.tx[i] = Number.NaN;
    h.timer[i] = 0.5 + nextFloat(h.rng) * 2;
    h.stuck[i] = 0;
    return;
  }
  let dirX = dx / d;
  let dirY = dy / d;
  // if the noise was the survivor, follow the flow field so buildings are walked around
  if (Math.hypot(tx - ctx.px, ty - ctx.py) < 12) {
    const flow = flowStep(ctx.flow, h.x[i], h.y[i]);
    if (flow) {
      dirX = flow[0];
      dirY = flow[1];
    }
  }
  walk(h, i, ctx, dirX, dirY, ZOMBIE.investigateSpeed * h.pace[i], dt);
}

/** Walk straight at a target and strike it when close. A target out of reach round a wall is given up on. */
function chaseVictim(h: Horde, i: number, ctx: HordeContext, dt: number): void {
  const t = ctx.targets;
  const v = h.victim[i];
  if (!t || t.active[v] !== 1 || h.stuck[i] > 2) {
    dropVictim(h, i);
    return;
  }
  const dx = t.x[v] - h.x[i];
  const dy = t.y[v] - h.y[i];
  const d = Math.hypot(dx, dy);
  if (d < ZOMBIE.attackStart && lineOfSight(ctx.world, h.x[i], h.y[i], t.x[v], t.y[v])) {
    h.state[i] = ZState.ATTACK;
    h.phase[i] = 0;
    h.attackT[i] = 0;
    return;
  }
  walk(h, i, ctx, dx / (d || 1), dy / (d || 1), ZOMBIE.kinds[h.kind[i]].chase * h.pace[i], dt);
}

function chase(h: Horde, i: number, ctx: HordeContext, d2: number, dt: number): void {
  if (!ctx.playerAlive) {
    h.victim[i] = -1;
    h.state[i] = ZState.WANDER;
    h.tx[i] = Number.NaN;
    h.timer[i] = 1;
    return;
  }
  if (h.victim[i] >= 0) {
    chaseVictim(h, i, ctx, dt);
    return;
  }
  // A zombie that cannot see the survivor (indoors) only follows a cold trail: once it has gone
  // without a sign for long enough it gives up, even if it is standing at the door.
  if (ctx.hidden && h.timer[i] > ZOMBIE.loseTrack) {
    h.timer[i] = 0;
    if (Number.isNaN(h.tx[i])) {
      h.state[i] = ZState.WANDER;
      h.timer[i] = 1;
    } else h.state[i] = ZState.INVESTIGATE;
    return;
  }
  const d = Math.sqrt(d2);
  if (d < ZOMBIE.attackStart && lineOfSight(ctx.world, h.x[i], h.y[i], ctx.px, ctx.py)) {
    h.state[i] = ZState.ATTACK;
    h.phase[i] = 0;
    h.attackT[i] = 0;
    return;
  }
  let dirX = (ctx.px - h.x[i]) / (d || 1);
  let dirY = (ctx.py - h.y[i]) / (d || 1);
  if (!(h.clear[i] === 1 && d < 20) && d > 2.5) {
    const flow = flowStep(ctx.flow, h.x[i], h.y[i]);
    if (flow) {
      dirX = flow[0];
      dirY = flow[1];
    }
  }
  walk(h, i, ctx, dirX, dirY, ZOMBIE.kinds[h.kind[i]].chase * h.pace[i], dt);
}

function attack(h: Horde, i: number, ctx: HordeContext, d2: number, dt: number): void {
  const kind = ZOMBIE.kinds[h.kind[i]];
  walk(h, i, ctx, 0, 0, 0, dt); // plant its feet

  // who it is striking: a target slot if it has one that is still there, otherwise the survivor
  const v = h.victim[i];
  const targets = v >= 0 && ctx.targets?.active[v] === 1 ? ctx.targets : undefined;
  const aimX = targets ? targets.x[v] : ctx.px;
  const aimY = targets ? targets.y[v] : ctx.py;
  const d = targets ? Math.hypot(aimX - h.x[i], aimY - h.y[i]) : Math.sqrt(d2);

  const want = Math.atan2(aimY - h.y[i], aimX - h.x[i]);
  const turn = angleDelta(h.heading[i], want);
  const most = ZOMBIE.turnRate * 1.5 * dt;
  h.heading[i] += Math.abs(turn) <= most ? turn : Math.sign(turn) * most;

  h.attackT[i] += dt;
  if (!targets && ctx.playerAlive && d < ZOMBIE.attackReach) h.engaged++;
  if (h.phase[i] === 0) {
    if (h.attackT[i] >= kind.windup) {
      if (d <= ZOMBIE.attackReach && lineOfSight(ctx.world, h.x[i], h.y[i], aimX, aimY)) {
        if (targets) targets.damage[v] += kind.damage;
        else if (ctx.playerAlive) {
          if (ctx.hidden) h.doorDamage += kind.damage;
          else {
            h.damage += kind.damage;
            h.lastHitX = h.x[i];
            h.lastHitY = h.y[i];
          }
        }
      }
      h.phase[i] = 1;
      h.attackT[i] = 0;
    }
  } else if (h.attackT[i] >= kind.cooldown) {
    h.state[i] = targets || ctx.playerAlive ? ZState.CHASE : ZState.WANDER;
    // Seeing the survivor refreshes the trail; battering a door they are behind does not. (A target
    // has no trail: the zombie either still has it in reach or lets go.)
    h.timer[i] = ctx.hidden && !targets ? h.timer[i] + kind.windup + kind.cooldown : 0;
    h.phase[i] = 0;
    h.attackT[i] = 0;
    if (!targets && !ctx.playerAlive) h.tx[i] = Number.NaN;
  }
}

/** Keep zombies from stacking on each other (and on the survivor), near the survivor only. */
function separate(h: Horde, ctx: HordeContext): void {
  const g = h.grid;
  const minDist = ZOMBIE.radius * 1.75;
  const min2 = minDist * minDist;
  const playerGap = ZOMBIE.radius + PLAYER.radius * 0.9;
  h.pushed.fill(0, 0, h.used);
  for (let i = 0; i < h.used; i++) {
    const c = g.cellOf[i];
    if (c < 0 || h.state[i] >= ZState.DEAD) continue;
    const cx = c % g.side;
    const cy = (c - cx) / g.side;
    for (let gy = Math.max(0, cy - 1); gy <= Math.min(g.side - 1, cy + 1); gy++) {
      for (let gx = Math.max(0, cx - 1); gx <= Math.min(g.side - 1, cx + 1); gx++) {
        const cell = gy * g.side + gx;
        for (let k = g.start[cell]; k < g.start[cell + 1]; k++) {
          const j = g.items[k];
          if (j <= i || h.state[j] >= ZState.DEAD) continue;
          const dx = h.x[j] - h.x[i];
          const dy = h.y[j] - h.y[i];
          const d2 = dx * dx + dy * dy;
          if (d2 >= min2) continue;
          const d = Math.sqrt(d2);
          let nx: number;
          let ny: number;
          if (d > 1e-4) {
            nx = dx / d;
            ny = dy / d;
          } else {
            const a = (((i * 2654435761) >>> 0) / 4294967296) * Math.PI * 2;
            nx = Math.cos(a);
            ny = Math.sin(a);
          }
          const push = Math.min((minDist - d) * 0.5, 0.04);
          h.x[i] -= nx * push;
          h.y[i] -= ny * push;
          h.x[j] += nx * push;
          h.y[j] += ny * push;
          h.pushed[i] = 1;
          h.pushed[j] = 1;
        }
      }
    }
    // not through the survivor either
    const px = h.x[i] - ctx.px;
    const py = h.y[i] - ctx.py;
    const pd2 = px * px + py * py;
    if (ctx.playerAlive && pd2 < playerGap * playerGap) {
      const pd = Math.sqrt(pd2);
      const ux = pd > 1e-4 ? px / pd : 1;
      const uy = pd > 1e-4 ? py / pd : 0;
      h.x[i] = ctx.px + ux * playerGap;
      h.y[i] = ctx.py + uy * playerGap;
      h.pushed[i] = 1;
    }
  }
  // a shove from a neighbour must never leave anyone inside a wall
  for (let i = 0; i < h.used; i++) {
    if (!h.pushed[i]) continue;
    const [x, y] = resolveCircle(ctx.world, h.x[i], h.y[i], ZOMBIE.radius);
    h.x[i] = x;
    h.y[i] = y;
  }
}
