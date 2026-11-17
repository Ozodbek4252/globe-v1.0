// The rules of one game: the survivor, the horde, the pistol, noise, supplies, waves, and the clock
// to rescue. Pure and seeded: the same seed and the same inputs replay the same game. No DOM, no Three.js.
//
// The horde is mutated in place (see horde.ts). Everything the picture needs to react to (a shot, a
// kill, a hit taken) is queued as an event for the renderer to drain.

import { createRng, nextFloat, nextInt, nextRange, type Rng } from '../lib/rng';
import {
  createCivilians,
  CState,
  evacuate,
  hideCivilians,
  hurtCivilian,
  loseShelter,
  occupants,
  stepCivilians,
  takeShelter,
  type Civilians,
} from './civilians';
import { findSpawn, type Colliders } from './colliders';
import {
  buildNavGrid,
  createFlowField,
  navCell,
  reachableFrom,
  updateFlow,
  type FlowField,
} from './flow';
import {
  createHorde,
  createTargets,
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
  type Targets,
} from './horde';
import { choosePlaces, PLACES, type Place, type PlaceBuilding } from './places';
import { createPlayer, speedOf, stepPlayer, PLAYER, type PlayerState } from './player';
import { rayCircleHit, rayWallHit } from './raycast';
import { validSpot, type GameWorld } from './world';

// These used to live here; they are re-exported so the rest of the code does not care.
export { validSpot };
export type { GameWorld };

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
    pellets: 1,
    /** How far a shot carries (metres). */
    noise: 60,
  },
  /** The armory's gun: eight pellets in a wide cone, deadly close up, weak and loud at range, slow to reload. */
  shotgun: {
    mag: 6,
    reserve: 12,
    reserveCap: 40,
    reload: 2.6,
    interval: 0.85,
    damage: 28,
    range: 16,
    spread: 0.12,
    moveSpread: 0.03,
    sprintSpread: 0.2,
    hitRadius: 0.42,
    pellets: 8,
    noise: 75,
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
    shove: 8,
    walkEvery: 0.55,
    sprintEvery: 0.35,
    ttl: 0.5,
    shotTtl: 0.8,
  },
  capacity: 1000,
  clumps: 70,
  /** Survivors hiding around the map at the start. */
  civilians: 10,
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
  /** What searching a shop or clinic gives (a roll decides which). */
  loot: { ammo: 24, health: 40, both: 0.2 },
  /** Zombies with their hands on you slow you down by this much each, to a floor. */
  grabSlow: 0.18,
  grabFloor: 0.4,
  /** The helicopter is heard this many seconds before it lands, and every zombie in earshot comes. */
  inbound: 14,
  inboundNoise: 130,
  shelter: {
    /** How much battering a shelter's door takes, and how much of each blow lands on it (a hit is 9-14). */
    door: 600,
    doorFactor: 0.4,
    /** Health regained per second indoors (to full), with no waiting. */
    heal: 3.5,
    /** What the survivor suffers when the door gives way and the horde floods in. */
    breachDamage: 25,
    /** The bursting door throws back everything this near (metres), hard, and stuns it (seconds). */
    breachBlast: 5,
    breachBlastSpeed: 8,
    breachStun: 1.6,
  },
} as const;

export type GameStatus = 'playing' | 'won' | 'lost';

export type WeaponName = 'pistol' | 'shotgun';

/** The numbers that make one gun different from another. */
export interface WeaponConfig {
  mag: number;
  reserve: number;
  reserveCap: number;
  reload: number;
  interval: number;
  damage: number;
  range: number;
  spread: number;
  moveSpread: number;
  sprintSpread: number;
  hitRadius: number;
  pellets: number;
  noise: number;
}

/** The configuration of the gun in hand. */
export function weaponConfig(name: WeaponName): WeaponConfig {
  return name === 'shotgun' ? GAME.shotgun : GAME.weapon;
}

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
  /** A shop, clinic or armory was searched: what it gave (`shotgun` when it was the armory's gun). */
  | { type: 'loot'; place: number; ammo: number; health: number; armory: boolean; shotgun: boolean }
  /** The gun in hand changed. */
  | { type: 'weapon'; weapon: WeaponName }
  /** The radar is on: the survivor can see the horde now. */
  | { type: 'radar'; place: number }
  | { type: 'enter'; place: number }
  | { type: 'leave'; place: number }
  /** The door of the shelter you are in took a beating; `fraction` of it is left (0 to 1). */
  | { type: 'door'; place: number; fraction: number }
  /** The door gave way: the horde is in, and the shelter is lost, with `lost` people behind it. */
  | { type: 'breach'; place: number; lost: number }
  /** Someone hiding has joined the survivor: `following` is how many are with them now. */
  | { type: 'recruit'; following: number }
  /** `count` followers went into a shelter with the survivor. */
  | { type: 'sheltered'; count: number; place: number }
  /** Someone was killed (in the open) at this spot. */
  | { type: 'civilianDown'; x: number; y: number }
  /** The helicopter landed and took `count` people. */
  | { type: 'saved'; count: number }
  | { type: 'wave'; number: number; size: number; angle: number }
  /** The helicopter is coming: `angle` is the direction it flies in from, `seconds` how long until it is here. */
  | { type: 'rescue'; angle: number; seconds: number; x: number; y: number }
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
  /** Asked to reload / to shove / to use whatever is at the door (the caller sends each once per press). */
  reload: boolean;
  shove: boolean;
  interact: boolean;
  /** Take out a gun: 1 the pistol, 2 the shotgun (once found); 0 for no change. Sent once per press. */
  weapon: 0 | 1 | 2;
}

export const NO_INPUT: GameInput = {
  moveX: 0,
  moveY: 0,
  sprint: false,
  aim: null,
  fire: false,
  reload: false,
  shove: false,
  interact: false,
  weapon: 0,
};

/**
 * Build the shared world for a map. `buildings` (the city's building list) is what the places are chosen
 * from; with none, the map simply has no radar, shelters or shops.
 */
export function createGameWorld(
  colliders: Colliders,
  start: readonly [number, number],
  buildings: readonly PlaceBuilding[] = [],
): GameWorld {
  const nav = buildNavGrid(colliders);
  const world: GameWorld = {
    colliders,
    nav,
    reachable: reachableFrom(nav, start[0], start[1]),
    places: [],
  };
  world.places = choosePlaces(buildings, start, world);
  return world;
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
  /** Survivors hiding around the map. 0 for none. */
  civilians?: number;
}

export interface GameStats {
  kills: number;
  shots: number;
  hits: number;
  damageTaken: number;
  shoves: number;
  /** How many survivors have joined you, died, and been saved. */
  recruited: number;
  lost: number;
  saved: number;
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
  /** The gun in hand, and its magazine and spare rounds. */
  weapon: WeaponName;
  ammo: number;
  reserve: number;
  /** The shotgun has been found. */
  hasShotgun: boolean;
  /** The magazine and spare rounds of the gun that is not in hand. */
  stash: { ammo: number; reserve: number };
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
  /** The direction (radians, counter-clockwise from east) the next wave will come from. */
  waveAngle: number;
  wavesOn: boolean;
  /** Which places have been used up: shops and the armory once searched, the radar once powered. */
  used: boolean[];
  /** The people to save. */
  civilians: Civilians;
  /** What zombies can go for besides the survivor: each civilian, then each place's door. */
  targets: Targets;
  /** Where the helicopter will land, once it has been heard. */
  landing: [number, number] | null;
  /** The radar is on, so the horde and the next wave are visible. */
  radarOn: boolean;
  /** The shelter the survivor is in (a place id), or -1. */
  inside: number;
  /** What is left of each shelter's door (0 for places that are not shelters). */
  doors: number[];
  /** Shelters whose doors have given way: they can not be used again. */
  breached: boolean[];
  /** Seconds since the last "door" event, so a beating does not flood the event queue. */
  doorEventTimer: number;
  /** The helicopter has been heard and is on its way. */
  inbound: boolean;
  inboundTimer: number;
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
    weapon: 'pistol',
    ammo: GAME.weapon.mag,
    reserve: GAME.weapon.reserve,
    hasShotgun: false,
    stash: { ammo: 0, reserve: 0 },
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
    waveAngle: nextFloat(rng) * Math.PI * 2,
    wavesOn: options.waves ?? true,
    used: world.places.map(() => false),
    civilians: createCivilians(options.civilians ?? GAME.civilians),
    targets: createTargets((options.civilians ?? GAME.civilians) + world.places.length),
    landing: null,
    radarOn: false,
    inside: -1,
    doors: world.places.map((p) => (p.kind === 'shelter' ? GAME.shelter.door : 0)),
    breached: world.places.map(() => false),
    doorEventTimer: 0,
    inbound: false,
    inboundTimer: 0,
    stats: {
      kills: 0,
      shots: 0,
      hits: 0,
      damageTaken: 0,
      shoves: 0,
      recruited: 0,
      lost: 0,
      saved: 0,
    },
    events: [],
    rng,
  };
  scatterPickups(g, world);
  scatterClumps(g, world, options.clumps ?? GAME.clumps);
  hideCivilians(g.civilians, world, rng, [options.startX, options.startY]);
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

    // Indoors there is no walking, aiming, shooting or shoving: only reloading, resting and leaving.
    const indoors = g.inside >= 0;
    const act: GameInput = indoors
      ? { ...NO_INPUT, reload: input.reload, interact: input.interact }
      : input;

    // the survivor
    const p0 = g.player;
    let face: number | null = null;
    if (act.aim && Math.hypot(act.aim[0] - p0.x, act.aim[1] - p0.y) > 0.6) {
      face = Math.atan2(act.aim[1] - p0.y, act.aim[0] - p0.x);
    }
    const slow = Math.max(GAME.grabFloor, 1 - GAME.grabSlow * g.horde.engaged);
    g.player = stepPlayer(
      p0,
      { moveX: act.moveX, moveY: act.moveY, sprint: act.sprint, face, slow },
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

    stepWeapon(g, act, face, colliders, dt);
    if (act.shove) tryShove(g);
    if (act.interact) interact(g, world);
    if (!indoors) collectPickups(g);

    if (g.inside >= 0) {
      // safe for now: rest and recover to full health
      g.health = Math.min(GAME.health, g.health + GAME.shelter.heal * dt);
    } else if (g.sinceHurt > GAME.regenDelay && g.health < GAME.regenCap) {
      // outdoors, regain a little health after a quiet spell
      g.health = Math.min(GAME.regenCap, g.health + GAME.regenRate * dt);
    }

    if (g.wavesOn && g.time >= g.nextWave) spawnWave(g, world);

    // the people to save: they join you when you come near, and follow
    const recruited = stepCivilians(
      g.civilians,
      { colliders, flow: g.flow, px: p.x, py: p.y, hidden: g.inside >= 0, playing: true },
      dt,
    );
    if (recruited > 0) {
      g.stats.recruited += recruited;
      emit(g, { type: 'recruit', following: countFollowing(g) });
    }

    // the helicopter's engines carry for miles: for its last seconds, everything comes
    if (g.time >= g.rescueAt - GAME.inbound) {
      if (!g.inbound) {
        g.inbound = true;
        // it lands on open ground a little ahead of the way the survivor is facing
        const [lx, ly] = findSpawn(
          colliders,
          [p.x + Math.cos(p.heading) * 11, p.y + Math.sin(p.heading) * 11],
          35,
          7,
        );
        g.landing = [lx, ly];
        emit(g, {
          type: 'rescue',
          angle: nextFloat(g.rng) * Math.PI * 2,
          seconds: GAME.inbound,
          x: lx,
          y: ly,
        });
      }
      g.inboundTimer -= dt;
      if (g.inboundTimer <= 0) {
        addNoise(g, p.x, p.y, GAME.inboundNoise, 1.3);
        g.inboundTimer = 1;
      }
    }
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

  refreshTargets(g, world, playing);
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
      hidden: playing && g.inside >= 0,
      targets: g.targets,
      noises: g.noises,
    },
    dt,
    g.tick,
  );

  if (playing) {
    g.doorEventTimer = Math.max(0, g.doorEventTimer - dt);
    // zombies that were after the survivor (indoors) hit the door they are behind...
    if (g.inside >= 0 && g.horde.doorDamage > 0) damageDoor(g, world, g.inside, g.horde.doorDamage);
    // ...and those after other people hit them, or the doors that hide them
    applyTargetDamage(g, world);
    if (damage > 0) hurt(g, damage, g.horde.lastHitX, g.horde.lastHitY);
    if (g.health <= 0) {
      g.health = 0;
      g.status = 'lost';
      g.player = { ...g.player, vx: 0, vy: 0, sprinting: false };
      emit(g, { type: 'lost' });
    } else if (g.time >= g.rescueAt) {
      g.status = 'won';
      // the helicopter takes the followers near it and everyone safe behind a door that held
      const [lx, ly] = g.landing ?? [g.player.x, g.player.y];
      g.stats.saved = evacuate(g.civilians, lx, ly);
      emit(g, { type: 'saved', count: g.stats.saved });
      emit(g, { type: 'won' });
    }
  }
}

/** How many people are with the survivor now. */
export function countFollowing(g: GameState): number {
  let n = 0;
  for (let i = 0; i < g.civilians.count; i++) if (g.civilians.state[i] === CState.FOLLOWING) n++;
  return n;
}

/** Fill the target slots for this step: each person in the open, then each shelter door with someone behind it. */
function refreshTargets(g: GameState, world: GameWorld, playing: boolean): void {
  const t = g.targets;
  const c = g.civilians;
  for (let i = 0; i < c.count; i++) {
    const live = playing && (c.state[i] === CState.HIDING || c.state[i] === CState.FOLLOWING);
    t.active[i] = live ? 1 : 0;
    t.x[i] = c.x[i];
    t.y[i] = c.y[i];
  }
  for (const place of world.places) {
    const k = c.count + place.id;
    const watched =
      playing && place.kind === 'shelter' && !g.breached[place.id] && occupants(c, place.id) > 0;
    t.active[k] = watched ? 1 : 0;
    t.x[k] = place.x;
    t.y[k] = place.y;
  }
}

/** Apply what zombies did to the people and doors they went for, and clear it. */
function applyTargetDamage(g: GameState, world: GameWorld): void {
  const t = g.targets;
  const c = g.civilians;
  for (let i = 0; i < c.count; i++) {
    if (t.damage[i] <= 0) continue;
    const x = c.x[i];
    const y = c.y[i];
    if (hurtCivilian(c, i, t.damage[i])) {
      g.stats.lost++;
      emit(g, { type: 'civilianDown', x, y });
    }
    t.damage[i] = 0;
  }
  for (const place of world.places) {
    const k = c.count + place.id;
    if (t.damage[k] <= 0) continue;
    if (!g.breached[place.id]) damageDoor(g, world, place.id, t.damage[k]);
    t.damage[k] = 0;
  }
}

/** Zombies are hitting a shelter's door. If it gives way they are in: everyone behind it is lost. */
function damageDoor(g: GameState, world: GameWorld, id: number, blows: number): void {
  const place = world.places[id];
  g.doors[id] = Math.max(0, g.doors[id] - blows * GAME.shelter.doorFactor);
  if (g.doors[id] <= 0) {
    breach(g, world, id);
    return;
  }
  // tell the picture, but not sixty times a second
  if (g.inside === id && g.doorEventTimer <= 0) {
    g.doorEventTimer = 0.4;
    emit(g, { type: 'door', place: place.id, fraction: g.doors[id] / GAME.shelter.door });
  }
}

/** The door gave way. The survivor (if inside) is thrown out hurt, anyone else behind it is lost. */
function breach(g: GameState, world: GameWorld, id: number): void {
  const place = world.places[id];
  g.breached[id] = true;
  const lost = loseShelter(g.civilians, id);
  g.stats.lost += lost;
  emit(g, { type: 'breach', place: id, lost });
  if (g.inside === id) {
    g.inside = -1;
    hurt(g, GAME.shelter.breachDamage, place.x + place.nx, place.y + place.ny);
  }
  // the door bursts open and throws back whatever is at it: a moment to run or fight
  const h = g.horde;
  const r = GAME.shelter.breachBlast;
  for (let i = 0; i < h.used; i++) {
    if (!isAlive(h, i)) continue;
    const dx = h.x[i] - place.x;
    const dy = h.y[i] - place.y;
    const d = Math.hypot(dx, dy);
    if (d > r) continue;
    const away = d > 1e-3 ? [dx / d, dy / d] : [place.nx, place.ny];
    shoveZombie(h, i, away[0], away[1], GAME.shelter.breachBlastSpeed, GAME.shelter.breachStun);
  }
}

/** Take out the other gun. The magazine and spare rounds of each stay with it. */
function switchWeapon(g: GameState, to: WeaponName): void {
  if (to === g.weapon || (to === 'shotgun' && !g.hasShotgun)) return;
  g.reloading = 0; // a half-done reload is lost
  [g.ammo, g.stash.ammo] = [g.stash.ammo, g.ammo];
  [g.reserve, g.stash.reserve] = [g.stash.reserve, g.reserve];
  g.weapon = to;
  g.fireCooldown = 0.4; // a moment to bring it up
  emit(g, { type: 'weapon', weapon: to });
}

/** Spare rounds for a gun, in hand or not. */
function reserveOf(g: GameState, which: WeaponName): number {
  return which === g.weapon ? g.reserve : g.stash.reserve;
}

/** Add spare rounds to a gun (in hand or not), up to what it can carry. Returns how many went in. */
function addReserve(g: GameState, which: WeaponName, rounds: number): number {
  const room = weaponConfig(which).reserveCap - reserveOf(g, which);
  const added = Math.max(0, Math.min(rounds, room));
  if (which === g.weapon) g.reserve += added;
  else g.stash.reserve += added;
  return added;
}

function stepWeapon(
  g: GameState,
  input: GameInput,
  face: number | null,
  colliders: Colliders,
  dt: number,
): void {
  if (input.weapon !== 0) switchWeapon(g, input.weapon === 2 ? 'shotgun' : 'pistol');
  const w = weaponConfig(g.weapon);
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
  const w = weaponConfig(g.weapon);
  const { player: p, horde: h, rng } = g;
  const moving = Math.min(1, speedOf(p) / PLAYER.walkSpeed);
  const spread = p.sprinting ? w.sprintSpread : w.spread + w.moveSpread * moving;

  let anyHit = false;
  // a pistol round wanders a little off the aim; shotgun pellets fan out across the whole cone
  for (let k = 0; k < w.pellets; k++) {
    const wander =
      w.pellets === 1
        ? (nextFloat(rng) - nextFloat(rng)) * spread
        : (nextFloat(rng) * 2 - 1) * spread;
    const angle = aimAngle + wander;
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
    if (target >= 0) {
      anyHit = true;
      const killed = damageZombie(h, target, w.damage, p.x, p.y);
      if (killed) g.stats.kills++;
      emit(g, { type: 'hit', x: endX, y: endY, kill: killed });
    }
  }
  addNoise(g, p.x, p.y, w.noise, GAME.noise.shotTtl);
  emit(g, { type: 'noise', x: p.x, y: p.y, radius: w.noise });
  g.stats.shots++;
  if (anyHit) g.stats.hits++;
  g.ammo--;
  g.fireCooldown = w.interval;
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
      // pistol rounds, whichever gun is in hand
      if (reserveOf(g, 'pistol') >= GAME.weapon.reserveCap) continue; // leave it for later
      addReserve(g, 'pistol', GAME.pickups.ammoAmount);
    } else {
      if (g.health >= GAME.health) continue;
      g.health = Math.min(GAME.health, g.health + GAME.pickups.medkitAmount);
    }
    pick.taken = true;
    emit(g, { type: 'pickup', kind: pick.kind, x: pick.x, y: pick.y });
  }
}

/** What the survivor could do right now at a door, if anything. */
export interface Interaction {
  place: Place;
  /** A short verb phrase for the prompt: "Power up the radar", "Search Baraka Savdo". */
  label: string;
}

/** The place whose door the survivor is standing at, and what using it would do. Null if none. */
export function interactionAt(g: GameState, world: GameWorld): Interaction | null {
  if (g.status !== 'playing') return null;
  // indoors, the only thing to do is leave
  if (g.inside >= 0) {
    const place = world.places[g.inside];
    return { place, label: 'Leave the shelter' };
  }
  let near: Place | null = null;
  let nearest: number = PLACES.reach;
  for (const place of world.places) {
    const d = Math.hypot(place.x - g.player.x, place.y - g.player.y);
    if (d <= nearest) {
      nearest = d;
      near = place;
    }
  }
  if (!near) return null;
  switch (near.kind) {
    case 'radar':
      return g.used[near.id] ? null : { place: near, label: 'Power up the radar' };
    case 'supplies':
    case 'armory':
      return g.used[near.id] ? null : { place: near, label: `Search ${near.name}` };
    default:
      return g.breached[near.id] ? null : { place: near, label: 'Go inside' };
  }
}

/** Use whatever is at the survivor's door. Returns whether anything happened. */
function interact(g: GameState, world: GameWorld): boolean {
  const here = interactionAt(g, world);
  if (!here) return false;
  const { place } = here;
  if (place.kind === 'radar') {
    g.used[place.id] = true;
    g.radarOn = true;
    emit(g, { type: 'radar', place: place.id });
    return true;
  }
  if (place.kind === 'shelter') {
    if (g.inside >= 0) {
      g.inside = -1;
      emit(g, { type: 'leave', place: place.id });
    } else {
      g.inside = place.id;
      g.player = { ...g.player, vx: 0, vy: 0, sprinting: false };
      g.reloading = 0; // the reload is forgotten while the door closes: simpler than a half-finished one
      emit(g, { type: 'enter', place: place.id });
      // everyone following you who is near the door goes in with you
      const taken = takeShelter(g.civilians, place.id, place.x, place.y);
      if (taken > 0) emit(g, { type: 'sheltered', count: taken, place: place.id });
    }
    return true;
  }
  // supplies and the armory: something to take
  if (place.kind === 'armory') {
    // the armory's gun, with its shells, and pistol rounds besides
    const gotAmmo = addReserve(g, 'pistol', GAME.loot.ammo);
    g.hasShotgun = true;
    // (it starts loaded: until you take it out, its magazine and spare shells wait in the stash)
    g.stash.ammo = g.weapon === 'shotgun' ? g.stash.ammo : GAME.shotgun.mag;
    addReserve(g, 'shotgun', GAME.shotgun.reserve);
    g.used[place.id] = true;
    emit(g, {
      type: 'loot',
      place: place.id,
      ammo: gotAmmo,
      health: 0,
      armory: true,
      shotgun: true,
    });
    return true;
  }
  let ammo = 0;
  let health = 0;
  const roll = nextFloat(g.rng);
  if (roll < GAME.loot.both) {
    ammo = Math.round(GAME.loot.ammo / 2);
    health = Math.round(GAME.loot.health / 2);
  } else if (roll < 0.6) ammo = GAME.loot.ammo;
  else health = GAME.loot.health;
  const gotAmmo = addReserve(g, 'pistol', ammo);
  const gotHealth = Math.min(health, GAME.health - g.health);
  g.health += gotHealth;
  // with nothing useful to take (full pack, full health) the place is left as it was, for later
  g.used[place.id] = gotAmmo > 0 || gotHealth > 0;
  emit(g, {
    type: 'loot',
    place: place.id,
    ammo: gotAmmo,
    health: Math.round(gotHealth),
    armory: false,
    shotgun: false,
  });
  return true;
}

/** A band of zombies appears out of sight, some distance away, already on the survivor's trail. */
function spawnWave(g: GameState, world: GameWorld): void {
  const { rng, player: p, horde: h } = g;
  const W = GAME.waves;
  g.wave++;
  g.nextWave += W.every;
  const heading = g.waveAngle;
  g.waveAngle = nextFloat(rng) * Math.PI * 2; // where the one after will come from
  const size = W.base + W.perWave * g.wave;
  const runner = Math.min(W.runnerMax, W.runnerChance * g.wave);

  let sx = p.x;
  let sy = p.y;
  let angle = 0;
  let found = false;
  // The direction was settled when the last wave came (the radar shows it), so it comes from there:
  // first from a spot the survivor cannot see, then from any spot that way, and only as a last resort
  // from anywhere at all.
  for (let attempt = 0; attempt < 80 && !found; attempt++) {
    const aimed = attempt < 70;
    const a = aimed ? heading + (nextFloat(rng) - 0.5) * 0.9 : nextFloat(rng) * Math.PI * 2;
    const r = nextRange(rng, W.minRange, W.maxRange);
    const x = p.x + Math.cos(a) * r;
    const y = p.y + Math.sin(a) * r;
    if (!validSpot(world, x, y, 1.5)) continue;
    if (attempt < 40 && rayWallHit(world.colliders, p.x, p.y, x, y) === Infinity) continue;
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
