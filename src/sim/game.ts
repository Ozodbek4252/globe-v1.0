// The rules of one game: the survivor, the horde, the pistol, noise, supplies, waves, and the clock
// to rescue. Pure and seeded: the same seed and the same inputs replay the same game. No DOM, no Three.js.
//
// The horde is mutated in place (see horde.ts). Everything the picture needs to react to (a shot, a
// kill, a hit taken) is queued as an event for the renderer to drain.

import { createRng, nextFloat, nextInt, nextRange, type Rng } from '../lib/rng';
import { clearance, insideBuilding, type Colliders } from './colliders';
import {
  buildNavGrid,
  createFlowField,
  navCell,
  reachableFrom,
  updateFlow,
  type FlowField,
  type NavGrid,
} from './flow';
import {
  createHorde,
  damageZombie,
  isAlive,
  sendHunting,
  shoveZombie,
  spawnZombie,
  stepHorde,
  ZKind,
  ZState,
  type Horde,
  type Noise,
} from './horde';
import { createPlayer, speedOf, stepPlayer, PLAYER, type PlayerState } from './player';
import { rayCircleHit, rayWallHit } from './raycast';

/** Tuning, in metres, seconds and points of health. */
export const GAME = {
  /** Seconds until the helicopter lands. */
  rescueAt: 300,
  health: 100,
  /** Health comes back by itself, slowly, but only up to this, and only after a quiet spell. */
  regenCap: 60,
  regenDelay: 8,
  regenRate: 2.5,
  weapon: {
    mag: 15,
    reserve: 45,
    reserveCap: 150,
    reload: 1.6,
    interval: 0.28,
    damage: 55,
    range: 32,
    /** Half-angle of the cone shots fall in, radians: standing, walking, sprinting. */
    spread: 0.02,
    moveSpread: 0.04,
    sprintSpread: 0.12,
    hitRadius: 0.42,
  },
  shove: {
    cooldown: 1.6,
    range: 2.3,
    cone: Math.cos((65 * Math.PI) / 180),
    speed: 9,
    stun: 1.1,
    damage: 10,
  },
  noise: {
    walk: 5,
    sprint: 16,
    shot: 60,
    shove: 8,
    walkEvery: 0.55,
    sprintEvery: 0.35,
    ttl: 0.5,
    shotTtl: 0.8,
  },
  capacity: 1000,
  clumps: 70,
  waves: {
    first: 20,
    every: 40,
    base: 6,
    perWave: 3,
    minRange: 90,
    maxRange: 140,
    runnerChance: 0.05,
    runnerMax: 0.35,
  },
  pickups: { ammo: 14, ammoAmount: 15, medkit: 6, medkitAmount: 40, radius: 1.5 },
  /** Zombies with their hands on you slow you down by this much each, to a floor. */
  grabSlow: 0.18,
  grabFloor: 0.4,
} as const;

export type GameStatus = 'playing' | 'won' | 'lost';

export interface Pickup {
  x: number;
  y: number;
  kind: 'ammo' | 'medkit';
  taken: boolean;
}

export type GameEvent =
  | {
      type: 'shot';
      x: number;
      y: number;
      endX: number;
      endY: number;
      hit: 'zombie' | 'wall' | 'none';
    }
  | { type: 'hit'; x: number; y: number; kill: boolean }
  | { type: 'hurt'; amount: number; fromX: number; fromY: number }
  | { type: 'noise'; x: number; y: number; radius: number }
  | { type: 'reload' }
  | { type: 'reloaded' }
  | { type: 'empty' }
  | { type: 'shove'; x: number; y: number; heading: number }
  | { type: 'pickup'; kind: 'ammo' | 'medkit'; x: number; y: number }
  | { type: 'wave'; number: number; size: number; angle: number }
  | { type: 'won' }
  | { type: 'lost' };

export interface GameInput {
  moveX: number;
  moveY: number;
  sprint: boolean;
  /** Where the mouse points, as a point in the city; null when there is no pointer. */
  aim: readonly [number, number] | null;
  /** The trigger is held. */
  fire: boolean;
  /** Asked to reload / to shove this step (the caller sends each once per press). */
  reload: boolean;
  shove: boolean;
}

export const NO_INPUT: GameInput = {
  moveX: 0,
  moveY: 0,
  sprint: false,
  aim: null,
  fire: false,
  reload: false,
  shove: false,
};

/** The fixed things about a map that games on it share. */
export interface GameWorld {
  colliders: Colliders;
  nav: NavGrid;
  /** 1 where a person can walk to from the start. */
  reachable: Uint8Array;
}

export function createGameWorld(colliders: Colliders, start: readonly [number, number]): GameWorld {
  const nav = buildNavGrid(colliders);
  return { colliders, nav, reachable: reachableFrom(nav, start[0], start[1]) };
}

export interface GameOptions {
  seed: number;
  startX: number;
  startY: number;
  rescueAt?: number;
  /** Zombies in the streets at the start, as groups. 0 for none. */
  clumps?: number;
  /** Turn the waves off (for tests). */
  waves?: boolean;
  capacity?: number;
}

export interface GameStats {
  kills: number;
  shots: number;
  hits: number;
  damageTaken: number;
  shoves: number;
}

export interface GameState {
  tick: number;
  time: number;
  status: GameStatus;
  rescueAt: number;
  player: PlayerState;
  health: number;
  /** Seconds since last hurt. */
  sinceHurt: number;
  ammo: number;
  reserve: number;
  /** Seconds of reloading left; 0 when not reloading. */
  reloading: number;
  fireCooldown: number;
  shoveCooldown: number;
  horde: Horde;
  flow: FlowField;
  flowTimer: number;
  flowCell: number;
  noises: Noise[];
  stepTimer: number;
  pickups: Pickup[];
  wave: number;
  nextWave: number;
  wavesOn: boolean;
  stats: GameStats;
  events: GameEvent[];
  rng: Rng;
}

const MAX_EVENTS = 256;

function emit(g: GameState, e: GameEvent): void {
  if (g.events.length >= MAX_EVENTS) g.events.shift();
  g.events.push(e);
}

/** Take the events queued since the last call. */
export function drainEvents(g: GameState): GameEvent[] {
  const events = g.events;
  g.events = [];
  return events;
}

/** Whether (x, y) is somewhere a person could stand and could walk to from the start. */
export function validSpot(world: GameWorld, x: number, y: number, needed = 1): boolean {
  const { nav, colliders } = world;
  if (Math.abs(x) > colliders.half - 6 || Math.abs(y) > colliders.half - 6) return false;
  const cx = navCell(nav, x);
  const cy = navCell(nav, y);
  if (cx < 0 || cy < 0 || cx >= nav.size || cy >= nav.size) return false;
  const index = cy * nav.size + cx;
  if (!nav.open[index] || !world.reachable[index]) return false;
  return !insideBuilding(colliders, x, y) && clearance(colliders, x, y, needed + 1) >= needed;
}

export function createGame(world: GameWorld, options: GameOptions): GameState {
  const rng = createRng(options.seed);
  const flow = createFlowField(world.nav);
  updateFlow(flow, options.startX, options.startY);
  const g: GameState = {
    tick: 0,
    time: 0,
    status: 'playing',
    rescueAt: options.rescueAt ?? GAME.rescueAt,
    player: createPlayer(options.startX, options.startY),
    health: GAME.health,
    sinceHurt: 99,
    ammo: GAME.weapon.mag,
    reserve: GAME.weapon.reserve,
    reloading: 0,
    fireCooldown: 0,
    shoveCooldown: 0,
    horde: createHorde(options.capacity ?? GAME.capacity, (options.seed * 2654435761) >>> 0),
    flow,
    flowTimer: 0,
    flowCell: -1,
    noises: [],
    stepTimer: 0,
    pickups: [],
    wave: 0,
    nextWave: GAME.waves.first,
    wavesOn: options.waves ?? true,
    stats: { kills: 0, shots: 0, hits: 0, damageTaken: 0, shoves: 0 },
    events: [],
    rng,
  };
  scatterPickups(g, world);
  scatterClumps(g, world, options.clumps ?? GAME.clumps);
  return g;
}

/** Scatter groups of zombies across the map, none near the start. */
function scatterClumps(g: GameState, world: GameWorld, clumps: number): void {
  const half = world.colliders.half;
  const { rng, player } = g;
  let placed = 0;
  for (let attempt = 0; attempt < clumps * 30 && placed < clumps; attempt++) {
    const cx = nextRange(rng, -half + 20, half - 20);
    const cy = nextRange(rng, -half + 20, half - 20);
    if (Math.hypot(cx - player.x, cy - player.y) < 70) continue;
    if (!validSpot(world, cx, cy, 2)) continue;
    const size = 3 + nextInt(rng, 8);
    for (let k = 0; k < size; k++) {
      for (let tries = 0; tries < 4; tries++) {
        const a = nextFloat(rng) * Math.PI * 2;
        const r = nextFloat(rng) * 4;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        if (!validSpot(world, x, y, 0.6)) continue;
        spawnZombie(g.horde, x, y, ZKind.WALKER, ZState.WANDER);
        break;
      }
    }
    placed++;
  }
}

/** Ammunition and first aid, spread out; a few close to the start so there is somewhere to run to. */
function scatterPickups(g: GameState, world: GameWorld): void {
  const { rng, player } = g;
  const half = world.colliders.half;
  const want: Pickup['kind'][] = [];
  for (let i = 0; i < GAME.pickups.ammo; i++) want.push('ammo');
  for (let i = 0; i < GAME.pickups.medkit; i++) want.push('medkit');
  // the first three have set distances from the start: ammunition near, first aid a bit further
  const near: [Pickup['kind'], number, number][] = [
    ['ammo', 35, 60],
    ['medkit', 60, 100],
    ['ammo', 90, 130],
  ];
  const spaced = (x: number, y: number, gap: number): boolean =>
    g.pickups.every((p) => Math.hypot(p.x - x, p.y - y) >= gap);
  for (const [kind, lo, hi] of near) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const a = nextFloat(rng) * Math.PI * 2;
      const r = nextRange(rng, lo, hi);
      const x = player.x + Math.cos(a) * r;
      const y = player.y + Math.sin(a) * r;
      if (!validSpot(world, x, y, 2) || !spaced(x, y, 25)) continue;
      g.pickups.push({ x, y, kind, taken: false });
      want.splice(want.indexOf(kind), 1);
      break;
    }
  }
  for (const kind of want) {
    for (let attempt = 0; attempt < 300; attempt++) {
      const x = nextRange(rng, -half + 20, half - 20);
      const y = nextRange(rng, -half + 20, half - 20);
      if (Math.hypot(x - player.x, y - player.y) < 25) continue;
      // keep supplies well apart, but on a small or crowded map settle for closer rather than go without
      const gap = attempt < 120 ? 60 : attempt < 220 ? 35 : 12;
      if (!validSpot(world, x, y, 2) || !spaced(x, y, gap)) continue;
      g.pickups.push({ x, y, kind, taken: false });
      break;
    }
  }
}

function addNoise(g: GameState, x: number, y: number, radius: number, ttl: number): void {
  if (g.noises.length >= 16) g.noises.shift();
  g.noises.push({ x, y, radius, ttl });
}

function hurt(g: GameState, amount: number, fromX: number, fromY: number): void {
  g.health -= amount;
  g.sinceHurt = 0;
  g.stats.damageTaken += amount;
  emit(g, { type: 'hurt', amount, fromX, fromY });
}

// ---------------------------------------------------------------------------------------------------

/** Advance the game by `dt` seconds (keep it small, ideally 1/60). */
export function stepGame(g: GameState, input: GameInput, world: GameWorld, dt: number): void {
  g.tick++;
  const colliders = world.colliders;
  const playing = g.status === 'playing';

  // noises fade
  for (const n of g.noises) n.ttl -= dt;
  g.noises = g.noises.filter((n) => n.ttl > 0);

  if (playing) {
    g.time += dt;
    g.sinceHurt += dt;
    g.fireCooldown = Math.max(0, g.fireCooldown - dt);
    g.shoveCooldown = Math.max(0, g.shoveCooldown - dt);

    // the survivor
    const p0 = g.player;
    let face: number | null = null;
    if (input.aim && Math.hypot(input.aim[0] - p0.x, input.aim[1] - p0.y) > 0.6) {
      face = Math.atan2(input.aim[1] - p0.y, input.aim[0] - p0.x);
    }
    const slow = Math.max(GAME.grabFloor, 1 - GAME.grabSlow * g.horde.engaged);
    g.player = stepPlayer(
      p0,
      { moveX: input.moveX, moveY: input.moveY, sprint: input.sprint, face, slow },
      colliders,
      dt,
    );
    const p = g.player;

    // footsteps: sprinting is loud, walking is quiet, standing still is silent
    if (speedOf(p) > 1.2) {
      g.stepTimer -= dt;
      if (g.stepTimer <= 0) {
        const loud = p.sprinting;
        const radius = loud ? GAME.noise.sprint : GAME.noise.walk;
        addNoise(g, p.x, p.y, radius, GAME.noise.ttl);
        if (loud) emit(g, { type: 'noise', x: p.x, y: p.y, radius });
        g.stepTimer = loud ? GAME.noise.sprintEvery : GAME.noise.walkEvery;
      }
    } else g.stepTimer = 0;

    stepWeapon(g, input, face, colliders, dt);
    if (input.shove) tryShove(g);
    collectPickups(g);

    // regain a little health after a quiet spell
    if (g.sinceHurt > GAME.regenDelay && g.health < GAME.regenCap) {
      g.health = Math.min(GAME.regenCap, g.health + GAME.regenRate * dt);
    }

    if (g.wavesOn && g.time >= g.nextWave) spawnWave(g, world);
  }

  // the flow field the horde follows to reach the survivor
  g.flowTimer -= dt;
  if (g.flowTimer <= 0) {
    const cell = navCell(world.nav, g.player.y) * world.nav.size + navCell(world.nav, g.player.x);
    if (cell !== g.flowCell || !g.flow.valid) {
      updateFlow(g.flow, g.player.x, g.player.y);
      g.flowCell = cell;
    }
    g.flowTimer = 0.25;
  }

  const damage = stepHorde(
    g.horde,
    {
      world: colliders,
      nav: world.nav,
      flow: g.flow,
      reachable: world.reachable,
      px: g.player.x,
      py: g.player.y,
      playerAlive: playing,
      noises: g.noises,
    },
    dt,
    g.tick,
  );

  if (playing) {
    if (damage > 0) hurt(g, damage, g.horde.lastHitX, g.horde.lastHitY);
    if (g.health <= 0) {
      g.health = 0;
      g.status = 'lost';
      g.player = { ...g.player, vx: 0, vy: 0, sprinting: false };
      emit(g, { type: 'lost' });
    } else if (g.time >= g.rescueAt) {
      g.status = 'won';
      emit(g, { type: 'won' });
    }
  }
}

function stepWeapon(
  g: GameState,
  input: GameInput,
  face: number | null,
  colliders: Colliders,
  dt: number,
): void {
  const w = GAME.weapon;
  // reloading
  if (g.reloading > 0) {
    g.reloading -= dt;
    if (g.reloading <= 0) {
      g.reloading = 0;
      const load = Math.min(w.mag - g.ammo, g.reserve);
      g.ammo += load;
      g.reserve -= load;
      emit(g, { type: 'reloaded' });
    }
  } else if (input.reload && g.ammo < w.mag && g.reserve > 0) {
    g.reloading = w.reload;
    emit(g, { type: 'reload' });
  }

  if (!input.fire || g.fireCooldown > 0 || g.reloading > 0) return;
  if (g.ammo <= 0) {
    if (g.reserve > 0) {
      g.reloading = w.reload;
      emit(g, { type: 'reload' });
    } else {
      emit(g, { type: 'empty' });
      g.fireCooldown = 0.4;
    }
    return;
  }
  fireShot(g, face ?? g.player.heading, colliders);
}

function fireShot(g: GameState, aimAngle: number, colliders: Colliders): void {
  const w = GAME.weapon;
  const { player: p, horde: h, rng } = g;
  const moving = Math.min(1, speedOf(p) / PLAYER.walkSpeed);
  const spread = p.sprinting ? w.sprintSpread : w.spread + w.moveSpread * moving;
  const angle = aimAngle + (nextFloat(rng) - nextFloat(rng)) * spread;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);

  let reach: number = w.range;
  let hit: 'zombie' | 'wall' | 'none' = 'none';
  const wall = rayWallHit(colliders, p.x, p.y, p.x + dx * w.range, p.y + dy * w.range);
  if (wall !== Infinity) {
    reach = wall * w.range;
    hit = 'wall';
  }
  let target = -1;
  for (let i = 0; i < h.used; i++) {
    if (!isAlive(h, i)) continue;
    const ox = h.x[i] - p.x;
    const oy = h.y[i] - p.y;
    const along = ox * dx + oy * dy;
    if (along < -1 || along > reach + 1) continue;
    const across = Math.abs(ox * dy - oy * dx);
    if (across > w.hitRadius + 0.3) continue;
    const t = rayCircleHit(p.x, p.y, dx, dy, h.x[i], h.y[i], w.hitRadius);
    if (t <= reach) {
      reach = t;
      target = i;
      hit = 'zombie';
    }
  }
  const endX = p.x + dx * reach;
  const endY = p.y + dy * reach;
  emit(g, { type: 'shot', x: p.x, y: p.y, endX, endY, hit });
  addNoise(g, p.x, p.y, GAME.noise.shot, GAME.noise.shotTtl);
  emit(g, { type: 'noise', x: p.x, y: p.y, radius: GAME.noise.shot });
  g.stats.shots++;
  g.ammo--;
  g.fireCooldown = w.interval;
  if (target >= 0) {
    g.stats.hits++;
    const killed = damageZombie(h, target, w.damage, p.x, p.y);
    if (killed) g.stats.kills++;
    emit(g, { type: 'hit', x: endX, y: endY, kill: killed });
  }
  if (g.ammo === 0 && g.reserve > 0) {
    g.reloading = w.reload;
    emit(g, { type: 'reload' });
  }
}

function tryShove(g: GameState): void {
  if (g.shoveCooldown > 0) return;
  const s = GAME.shove;
  const { player: p, horde: h } = g;
  const fx = Math.cos(p.heading);
  const fy = Math.sin(p.heading);
  g.shoveCooldown = s.cooldown;
  g.stats.shoves++;
  addNoise(g, p.x, p.y, GAME.noise.shove, GAME.noise.ttl);
  emit(g, { type: 'shove', x: p.x, y: p.y, heading: p.heading });
  emit(g, { type: 'noise', x: p.x, y: p.y, radius: GAME.noise.shove });
  for (let i = 0; i < h.used; i++) {
    if (!isAlive(h, i)) continue;
    const ox = h.x[i] - p.x;
    const oy = h.y[i] - p.y;
    const d = Math.hypot(ox, oy);
    if (d > s.range || d < 1e-4) continue;
    if ((ox * fx + oy * fy) / d < s.cone) continue;
    if (damageZombie(h, i, s.damage, p.x, p.y)) {
      g.stats.kills++;
      emit(g, { type: 'hit', x: h.x[i], y: h.y[i], kill: true });
      continue;
    }
    shoveZombie(h, i, ox / d, oy / d, s.speed, s.stun); // after the damage, whose flinch it replaces
  }
}

function collectPickups(g: GameState): void {
  const { player: p } = g;
  const r2 = GAME.pickups.radius * GAME.pickups.radius;
  for (const pick of g.pickups) {
    if (pick.taken) continue;
    const dx = pick.x - p.x;
    const dy = pick.y - p.y;
    if (dx * dx + dy * dy > r2) continue;
    if (pick.kind === 'ammo') {
      if (g.reserve >= GAME.weapon.reserveCap) continue; // leave it for later
      g.reserve = Math.min(GAME.weapon.reserveCap, g.reserve + GAME.pickups.ammoAmount);
    } else {
      if (g.health >= GAME.health) continue;
      g.health = Math.min(GAME.health, g.health + GAME.pickups.medkitAmount);
    }
    pick.taken = true;
    emit(g, { type: 'pickup', kind: pick.kind, x: pick.x, y: pick.y });
  }
}

/** A band of zombies appears out of sight, some distance away, already on the survivor's trail. */
function spawnWave(g: GameState, world: GameWorld): void {
  const { rng, player: p, horde: h } = g;
  const W = GAME.waves;
  g.wave++;
  g.nextWave += W.every;
  const size = W.base + W.perWave * g.wave;
  const runner = Math.min(W.runnerMax, W.runnerChance * g.wave);

  let sx = p.x;
  let sy = p.y;
  let angle = 0;
  let found = false;
  for (let attempt = 0; attempt < 80 && !found; attempt++) {
    const a = nextFloat(rng) * Math.PI * 2;
    const r = nextRange(rng, W.minRange, W.maxRange);
    const x = p.x + Math.cos(a) * r;
    const y = p.y + Math.sin(a) * r;
    if (!validSpot(world, x, y, 1.5)) continue;
    // prefer places the survivor cannot see; after many tries, settle for any
    if (attempt < 60 && rayWallHit(world.colliders, p.x, p.y, x, y) === Infinity) continue;
    sx = x;
    sy = y;
    angle = a;
    found = true;
  }
  if (!found) return; // nowhere to come from this time; the next wave will do
  let count = 0;
  for (let k = 0; k < size; k++) {
    for (let tries = 0; tries < 6; tries++) {
      const a = nextFloat(rng) * Math.PI * 2;
      const r = nextFloat(rng) * 5;
      const x = sx + Math.cos(a) * r;
      const y = sy + Math.sin(a) * r;
      if (!validSpot(world, x, y, 0.6)) continue;
      const i = spawnZombie(
        h,
        x,
        y,
        nextFloat(rng) < runner ? ZKind.RUNNER : ZKind.WALKER,
        ZState.CHASE,
      );
      if (i < 0) break;
      sendHunting(h, i, 70);
      count++;
      break;
    }
  }
  if (count > 0) emit(g, { type: 'wave', number: g.wave, size: count, angle });
}

/** Seconds until rescue (never below zero). */
export function rescueIn(g: GameState): number {
  return Math.max(0, g.rescueAt - g.time);
}
