// The rules of one game: the survivor, the city's people, the outbreak spreading through them, the guns,
// noise, hunger, shelters. There is no rescue and no cure: the game goes on until the survivor dies, and
// the score is how long that took. Pure and seeded: the same seed and the same inputs replay the same
// game. No DOM, no Three.js.
//
// The horde and the people in the street are mutated in place (see horde.ts, humans.ts). Everything the
// picture needs to react to (a shot, a kill, a hit taken) is queued as an event for the renderer to drain.

import { createRng, nextFloat, nextInt, nextRange, type Rng } from '../lib/rng';
import type { Colliders } from './colliders';
import {
  buildNavGrid,
  createFlowField,
  navCell,
  reachableFrom,
  updateFlow,
  type FlowField,
} from './flow';
import {
  biteHuman,
  createHumans,
  HState,
  HUMAN,
  spawnHuman,
  stepHumans,
  type HumanContext,
  type Humans,
} from './humans';
import {
  createHorde,
  createTargets,
  damageZombie,
  isAlive,
  rebuildZombieIndex,
  shoveZombie,
  spawnZombie,
  stepHorde,
  ZKind,
  ZOMBIE,
  ZState,
  type Horde,
  type Noise,
  type Targets,
} from './horde';
import { DAY, fear, nightness, outdoorShare, wrapHour } from './daylight';
import { choosePlaces, PLACES, type Place, type PlaceBuilding } from './places';
import {
  batter,
  biteInside,
  createOutbreak,
  indoorCounts,
  roundSeeded,
  seedOutbreak,
  stepOutbreak,
  takeIn,
  type Outbreak,
} from './population';
import { createPointIndex, rebuildIndex, type PointIndex } from './spatial';
import { createPlayer, speedOf, stepPlayer, PLAYER, type PlayerState } from './player';
import { rayCircleHit, rayWallHit } from './raycast';
import { validSpot, type GameWorld } from './world';

// These used to live here; they are re-exported so the rest of the code does not care.
export { validSpot };
export type { GameWorld };

/** Tuning, in metres, seconds and points of health. */
export const GAME = {
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
  /** The most zombies on the streets at once, and people in the street (the rest are indoors, counted). */
  capacity: 4000,
  streetPeople: 4000,
  /** Zombies in the streets at the start. None: the outbreak starts indoors, somewhere far off. */
  clumps: 0,
  outbreak: {
    /** Buildings where it begins, and how far from the survivor at least (metres). */
    patients: 3,
    minDistance: 350,
    /** Of those who turn, the share that are runners. */
    runners: 0.12,
    /** Real-world people per square kilometre to spread over the city (Tashkent: about 2.6 million over 335 km²). */
    density: 7700,
  },
  pickups: {
    ammo: 14,
    ammoAmount: 15,
    medkit: 6,
    medkitAmount: 40,
    food: 10,
    foodAmount: 35,
    radius: 1.5,
    /** The most pickups lying about at once (the ones zombies drop can fill this up). */
    max: 160,
  },
  /** Hunger: food drains steadily; at zero you starve. There is no rescue, so you have to keep finding it. */
  food: { max: 100, drain: 0.22, starve: 1.2 },
  /** The fallback when a gun is dry: always there, slower and shorter than a gun, and it takes three to fell a walker. */
  melee: {
    range: 1.9,
    cone: Math.cos((60 * Math.PI) / 180),
    damage: 34,
    cooldown: 0.8,
    knock: 5,
    stun: 0.5,
    noise: 7,
  },
  /** Chance a zombie killed by you was carrying something (they were people once). */
  drops: { ammo: 0.13, food: 0.06, medkit: 0.04, ammoAmount: 8 },
  /** What searching a shop or clinic gives (a roll decides which). */
  loot: { ammo: 24, health: 40, food: 40, both: 0.2 },
  /** Zombies with their hands on you slow you down by this much each, to a floor. */
  grabSlow: 0.18,
  grabFloor: 0.4,
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

/** There is no winning: you play until you die. */
export type GameStatus = 'playing' | 'lost';

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
  kind: 'ammo' | 'medkit' | 'food';
  taken: boolean;
  /** How much it gives, when not the standard amount (a drop from a zombie is smaller). */
  amount?: number;
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
  /** A swing of the melee weapon (the gun is dry). */
  | { type: 'swing'; x: number; y: number; heading: number }
  | { type: 'pickup'; kind: 'ammo' | 'medkit' | 'food'; x: number; y: number }
  /** A shop, clinic or armory was searched: what it gave (`shotgun` when it was the armory's gun). */
  | {
      type: 'loot';
      place: number;
      ammo: number;
      health: number;
      food: number;
      armory: boolean;
      shotgun: boolean;
    }
  /** The gun in hand changed. */
  | { type: 'weapon'; weapon: WeaponName }
  /** The radar is on: the survivor can see the horde now. */
  | { type: 'radar'; place: number }
  | { type: 'enter'; place: number }
  | { type: 'leave'; place: number }
  /** The door of the shelter you are in took a beating; `fraction` of it is left (0 to 1). */
  | { type: 'door'; place: number; fraction: number }
  /** The door gave way: the horde is in, and the shelter is lost. */
  | { type: 'breach'; place: number }
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
    buildings,
    places: [],
  };
  world.places = choosePlaces(buildings, start, world);
  return world;
}

export interface GameOptions {
  seed: number;
  startX: number;
  startY: number;
  /** Zombies in the streets at the start, as groups. 0 for none. */
  clumps?: number;
  capacity?: number;
  /** False for a city with no people in it at all (for tests): no outbreak, no one in the street. */
  population?: boolean;
  /** Where the outbreak begins: how many buildings (0 for none; the city stays well). */
  patients?: number;
  /** People per square kilometre to spread over the city, from a real-world figure. */
  density?: number;
  /** The hour (local, 0-24) the game begins at. Default: `DAY.start`. */
  startHour?: number;
  /** False to leave the people where they are: nobody goes out or comes home (for tests). */
  routine?: boolean;
  /** False to stop the clock where it is (for tests and screenshots): no day and night. */
  cycle?: boolean;
  /** When the sun rises and sets over this place, in hours; they say when the night is. */
  sunrise?: number;
  sunset?: number;
}

export interface GameStats {
  kills: number;
  shots: number;
  hits: number;
  damageTaken: number;
  shoves: number;
}

/** Who is in the city, and in what condition (people indoors and in the street together). */
export interface Population {
  /** Well, bitten and turning, and turned (the zombies on the streets and those still indoors). */
  healthy: number;
  bitten: number;
  zombies: number;
  /** The people the city had when the game began. */
  initial: number;
}

export interface GameState {
  tick: number;
  /** Seconds survived: the score. */
  time: number;
  status: GameStatus;
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
  /** How well fed the survivor is, 0 to 100. */
  food: number;
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
  /** Which places have been used up: shops and the armory once searched, the radar once powered. */
  used: boolean[];
  /** The city's people: indoors, counted per building, and in the street, as individuals. */
  outbreak: Outbreak;
  humans: Humans;
  population: Population;
  /**
   * What zombies can go for besides the survivor: each person in the street (slots 0 to capacity - 1),
   * then each building's door (capacity + the building's number), active while someone is behind it.
   */
  targets: Targets;
  /** Where the zombies and the doors are, for anyone who needs to know what is near. */
  zombieIndex: PointIndex;
  doorIndex: PointIndex;
  humanContext: HumanContext;
  /** For each building, the shelter (a place id) it is, or -1. */
  shelterOf: Int16Array;
  /** The hour of the day (local, 0-24): it moves on as you play. */
  clock: number;
  /** Whether people come and go through the day. */
  routine: boolean;
  /** Whether it moves on at all. */
  cycle: boolean;
  /** When the sun rises and sets here, and how dark it is now (0 day, 1 night). */
  sunrise: number;
  sunset: number;
  night: number;
  /** Where the next person sent home is looked for (so it is not always the same people). */
  homeCursor: number;
  /** Seconds since the population was last counted. */
  countTimer: number;
  /** The radar is on, so the horde is visible. */
  radarOn: boolean;
  /** The shelter the survivor is in (a place id), or -1. */
  inside: number;
  /** What is left of each shelter's door (0 for places that are not shelters). */
  doors: number[];
  /** Shelters whose doors have given way: they can not be used again. */
  breached: boolean[];
  /** Seconds since the last "door" event, so a beating does not flood the event queue. */
  doorEventTimer: number;
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
  const half = world.colliders.half;
  const startHour = wrapHour(options.startHour ?? DAY.start);
  const sunrise = options.sunrise ?? DAY.sunrise;
  const sunset = options.sunset ?? DAY.sunset;

  // The city's people: who lives where comes from the buildings, how many there are from a real density.
  const withPeople = options.population ?? true;
  const km2 = ((half * 2) / 1000) ** 2;
  const outbreak = createOutbreak(
    withPeople ? world.buildings : [],
    world,
    new Set(),
    GAME.shelter.door,
    (options.density ?? GAME.outbreak.density) * km2,
  );
  const horde = createHorde(options.capacity ?? GAME.capacity, (options.seed * 2654435761) >>> 0);
  const humans = createHumans(withPeople ? GAME.streetPeople : 0, (options.seed * 40503 + 7) >>> 0);
  const zombieIndex = createPointIndex(half, 10, horde.capacity);
  const doorIndex = createPointIndex(half, 16, Math.max(1, outbreak.count));
  rebuildIndex(
    doorIndex,
    outbreak.count,
    outbreak.doorX,
    outbreak.doorY,
    (i) => !Number.isNaN(outbreak.doorX[i]),
  );
  const shelterOf = new Int16Array(outbreak.count).fill(-1);
  for (const place of world.places) {
    if (place.kind === 'shelter' && place.building < outbreak.count)
      shelterOf[place.building] = place.id;
  }
  const humanContext: HumanContext = {
    colliders: world.colliders,
    nav: world.nav,
    reachable: world.reachable,
    horde,
    zombies: zombieIndex,
    doors: doorIndex,
    outbreak,
    noises: [],
    px: options.startX,
    py: options.startY,
    onEnter: (b) => takeIn(outbreak, b),
    onTurn: (x, y) => turnZombie(horde, rng, x, y),
  };

  const g: GameState = {
    tick: 0,
    time: 0,
    status: 'playing',
    player: createPlayer(options.startX, options.startY),
    health: GAME.health,
    sinceHurt: 99,
    weapon: 'pistol',
    ammo: GAME.weapon.mag,
    reserve: GAME.weapon.reserve,
    hasShotgun: false,
    food: GAME.food.max,
    stash: { ammo: 0, reserve: 0 },
    reloading: 0,
    fireCooldown: 0,
    shoveCooldown: 0,
    horde,
    flow,
    flowTimer: 0,
    flowCell: -1,
    noises: [],
    stepTimer: 0,
    pickups: [],
    used: world.places.map(() => false),
    outbreak,
    humans,
    population: { healthy: 0, bitten: 0, zombies: 0, initial: outbreak.initial },
    targets: createTargets(humans.capacity + outbreak.count, half),
    zombieIndex,
    doorIndex,
    humanContext,
    shelterOf,
    clock: startHour,
    routine: options.routine ?? true,
    cycle: options.cycle ?? true,
    sunrise,
    sunset,
    night: nightness(startHour, sunrise, sunset),
    homeCursor: 0,
    countTimer: 0,
    radarOn: false,
    inside: -1,
    doors: world.places.map((p) => (p.kind === 'shelter' ? GAME.shelter.door : 0)),
    breached: world.places.map(() => false),
    doorEventTimer: 0,
    stats: { kills: 0, shots: 0, hits: 0, damageTaken: 0, shoves: 0 },
    events: [],
    rng,
  };
  scatterPickups(g, world);
  scatterClumps(g, world, options.clumps ?? GAME.clumps);
  scatterStreetPeople(g, world);
  seedOutbreak(
    outbreak,
    rng,
    options.patients ?? GAME.outbreak.patients,
    [options.startX, options.startY],
    GAME.outbreak.minDistance,
  );
  countPopulation(g);
  return g;
}

/** A zombie turns up where a bitten person fell: mostly a walker, now and then a runner. */
function turnZombie(horde: Horde, rng: Rng, x: number, y: number): void {
  const kind = nextFloat(rng) < GAME.outbreak.runners ? ZKind.RUNNER : ZKind.WALKER;
  spawnZombie(horde, x, y, kind, ZState.WANDER);
}

/** The few percent of everyone who are out in the street at the start, each near their own door. */
function scatterStreetPeople(g: GameState, world: GameWorld): void {
  const { outbreak: o, humans, rng } = g;
  const share = outdoorShare(g.clock); // how many are out at this hour of the day
  for (let b = 0; b < o.count && humans.alive < humans.capacity; b++) {
    if (o.healthy[b] <= 0) continue;
    const want = roundSeeded(o.healthy[b] * share, rng);
    // a big block puts a crowd out, who spread further from its door than a few from a house
    const reach = 10 + 2.5 * Math.sqrt(want);
    for (let k = 0; k < want && humans.alive < humans.capacity; k++) {
      for (let tries = 0; tries < 6; tries++) {
        const a = nextFloat(rng) * Math.PI * 2;
        const r = nextRange(rng, 1.5, reach);
        const x = o.doorX[b] + Math.cos(a) * r;
        const y = o.doorY[b] + Math.sin(a) * r;
        if (!validSpot(world, x, y, 0.6)) continue;
        spawnHuman(humans, x, y, HState.WALK);
        o.healthy[b]--;
        break;
      }
    }
  }
}

/** Count everyone: indoors and in the street. Done about once a second. */
function countPopulation(g: GameState): void {
  const inside = indoorCounts(g.outbreak);
  let bitten = inside.incubating;
  for (let i = 0; i < g.humans.used; i++) if (g.humans.state[i] === HState.BITTEN) bitten++;
  g.population.healthy = inside.healthy + g.humans.alive;
  g.population.bitten = bitten;
  g.population.zombies = inside.undead + g.horde.alive;
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
  for (let i = 0; i < GAME.pickups.food; i++) want.push('food');
  // the first few have set distances from the start: ammunition near, first aid and food a bit further
  const near: [Pickup['kind'], number, number][] = [
    ['ammo', 35, 60],
    ['medkit', 60, 100],
    ['ammo', 90, 130],
    ['food', 50, 110],
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
    // the day goes by: an hour for each minute of play (unless the clock is stopped)
    if (g.cycle) {
      g.clock = wrapHour(g.clock + (dt * DAY.hoursPerMinute) / 60);
      g.night = nightness(g.clock, g.sunrise, g.sunset);
    }
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

    // hunger: it never stops, indoors or out. Without food you starve, and nothing heals.
    g.food = Math.max(0, g.food - GAME.food.drain * dt);
    if (g.food <= 0) {
      const starving = GAME.food.starve * dt;
      g.health -= starving;
      g.stats.damageTaken += starving;
      g.sinceHurt = 0;
    } else if (g.inside >= 0) {
      // safe for now: rest and recover to full health
      g.health = Math.min(GAME.health, g.health + GAME.shelter.heal * dt);
    } else if (g.sinceHurt > GAME.regenDelay && g.health < GAME.regenCap) {
      // outdoors, regain a little health after a quiet spell
      g.health = Math.min(GAME.regenCap, g.health + GAME.regenRate * dt);
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

  // everyone out in the street looks about and moves (where the zombies are is indexed first)
  rebuildZombieIndex(g.horde, g.zombieIndex);
  const hc = g.humanContext;
  hc.px = g.player.x;
  hc.py = g.player.y;
  hc.noises = g.noises;
  stepHumans(g.humans, hc, dt, g.tick);

  refreshTargets(g);
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
      night: g.night,
    },
    dt,
    g.tick,
  );

  g.doorEventTimer = Math.max(0, g.doorEventTimer - dt);
  // zombies that were after the survivor (indoors) hit the door they are behind...
  if (playing && g.inside >= 0 && g.horde.doorDamage > 0) {
    damageDoor(g, world, g.inside, g.horde.doorDamage);
  }
  // ...and those after other people bite them, or hit the doors that hide them
  applyTargetDamage(g, world);

  // once a second, the outbreak moves on inside the buildings
  g.countTimer += dt;
  if (g.countTimer >= 1) {
    const seconds = g.countTimer;
    g.countTimer = 0;
    stepOutbreak(
      g.outbreak,
      seconds,
      g.rng,
      (b, n) => emitZombies(g, world, b, n),
      (b, n) => emitHumans(g, world, b, n, true),
      g.night,
    );
    if (g.routine) stepRoutine(g, world);
    countPopulation(g);
  }

  if (playing) {
    if (damage > 0) hurt(g, damage, g.horde.lastHitX, g.horde.lastHitY);
    if (g.health <= 0) {
      g.health = 0;
      g.status = 'lost';
      g.player = { ...g.player, vx: 0, vy: 0, sprinting: false };
      emit(g, { type: 'lost' });
    }
  }
}

/**
 * Fill the target slots for this step: each person out in the street, then (after them) each building's
 * door for as long as anyone well is behind it, so the horde comes for the doors that matter.
 */
function refreshTargets(g: GameState): void {
  const t = g.targets;
  const h = g.humans;
  const o = g.outbreak;
  for (let i = 0; i < h.used; i++) {
    const s = h.state[i];
    t.active[i] = s === HState.WALK || s === HState.FLEE || s === HState.HOME ? 1 : 0;
    t.x[i] = h.x[i];
    t.y[i] = h.y[i];
  }
  const base = h.capacity;
  for (let b = 0; b < o.count; b++) {
    const k = base + b;
    t.active[k] = o.healthy[b] > 0 && !Number.isNaN(o.doorX[b]) ? 1 : 0;
    t.x[k] = o.doorX[b];
    t.y[k] = o.doorY[b];
  }
}

/** Apply what zombies did to the people and doors they went for, and clear it. */
function applyTargetDamage(g: GameState, world: GameWorld): void {
  const t = g.targets;
  const h = g.humans;
  const o = g.outbreak;
  for (let i = 0; i < h.used; i++) {
    if (t.damage[i] <= 0) continue;
    t.damage[i] = 0;
    biteHuman(h, i);
  }
  const base = h.capacity;
  const blow = ZOMBIE.kinds[ZKind.WALKER].damage;
  for (let b = 0; b < o.count; b++) {
    const dealt = t.damage[base + b];
    if (dealt <= 0) continue;
    t.damage[base + b] = 0;
    const place = g.shelterOf[b];
    if (place >= 0) {
      // a shelter's door is the one the survivor uses too
      if (!g.breached[place]) damageDoor(g, world, place, dealt);
      else biteThrough(o, b, dealt, blow);
    } else if (o.open[b] === 1) biteThrough(o, b, dealt, blow);
    else batter(o, b, dealt);
  }
}

/** Zombies at an open door bite whoever is just inside, one person for each blow. */
function biteThrough(o: Outbreak, b: number, dealt: number, blow: number): void {
  const bites = Math.max(1, Math.round(dealt / blow));
  for (let n = 0; n < bites; n++) if (!biteInside(o, b)) return;
}

/** Somewhere to stand in the street a few metres from (x, y), or null if none turns up. */
function streetSpot(g: GameState, world: GameWorld, x: number, y: number): [number, number] | null {
  for (let tries = 0; tries < 6; tries++) {
    const a = nextFloat(g.rng) * Math.PI * 2;
    const r = nextRange(g.rng, 1.2, 9);
    const sx = x + Math.cos(a) * r;
    const sy = y + Math.sin(a) * r;
    if (validSpot(world, sx, sy, 0.6)) return [sx, sy];
  }
  return null;
}

/** A building's turned people come out into the street. Returns how many were placed. */
function emitZombies(g: GameState, world: GameWorld, b: number, n: number): number {
  const o = g.outbreak;
  let placed = 0;
  for (let k = 0; k < n; k++) {
    const spot = streetSpot(g, world, o.doorX[b], o.doorY[b]);
    if (!spot) break;
    const kind = nextFloat(g.rng) < GAME.outbreak.runners ? ZKind.RUNNER : ZKind.WALKER;
    if (spawnZombie(g.horde, spot[0], spot[1], kind, ZState.WANDER) < 0) break;
    placed++;
  }
  return placed;
}

/**
 * A building's well people go out into the street: running from the dead inside (`fleeing`), or just
 * leaving for the day. Returns how many were placed.
 */
function emitHumans(
  g: GameState,
  world: GameWorld,
  b: number,
  n: number,
  fleeing: boolean,
): number {
  const o = g.outbreak;
  let placed = 0;
  for (let k = 0; k < n; k++) {
    const spot = streetSpot(g, world, o.doorX[b], o.doorY[b]);
    if (!spot) break;
    const i = spawnHuman(g.humans, spot[0], spot[1], fleeing ? HState.FLEE : HState.WALK);
    if (i < 0) break;
    if (fleeing) {
      // away from the building, whichever way the door faces
      const a = Math.atan2(spot[1] - o.doorY[b], spot[0] - o.doorX[b]);
      g.humans.tx[i] = Math.cos(a);
      g.humans.ty[i] = Math.sin(a);
    }
    placed++;
  }
  return placed;
}

/**
 * The people's day. Each second the number out in the street is brought toward what the hour calls for
 * (a few percent in the small hours, over a tenth in the morning rush and the evening), fewer the more
 * frightened the city is: some leave their buildings, and when there are too many out, some start for
 * home. Nobody is made or lost: they are counted in the building they leave or go back to.
 */
export function stepRoutine(g: GameState, world: GameWorld): void {
  const { outbreak: o, humans } = g;
  if (o.count === 0 || humans.capacity === 0) return;
  const p = g.population;
  const calm = 1 - 0.9 * fear(p.zombies, p.initial);
  const want = Math.min(humans.capacity, Math.round(outdoorShare(g.clock) * calm * p.healthy));
  const have = humans.alive;

  if (have < want) {
    // some leave: the bigger the building, the likelier it is that someone does
    const going = Math.min(want - have, Math.max(6, Math.ceil((want - have) * 0.3)));
    let left = 0;
    for (let tries = 0; tries < going * 8 && left < going; tries++) {
      const b = Math.floor(nextFloat(g.rng) * o.count);
      const healthy = o.healthy[b];
      if (healthy < 1 || Number.isNaN(o.doorX[b])) continue;
      // nobody goes out of a building the dead are in
      if (o.undead[b] > 0 || o.incubating[b] > 0 || o.open[b] === 1) continue;
      if (nextFloat(g.rng) > 0.15 + healthy / 150) continue;
      const out = emitHumans(g, world, b, 1, false);
      o.healthy[b] -= out;
      left += out;
    }
  } else if (have > want * 1.1 + 5) {
    // some go home
    const sending = Math.min(have - want, Math.max(6, Math.ceil((have - want) * 0.3)));
    let sent = 0;
    for (let k = 0; k < humans.used && sent < sending; k++) {
      const i = (g.homeCursor + k) % humans.used;
      if (humans.state[i] !== HState.WALK) continue;
      humans.state[i] = HState.HOME;
      humans.timer[i] = HUMAN.homePatience;
      humans.tx[i] = Number.NaN;
      sent++;
      g.homeCursor = i + 1;
    }
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
  if (place.building < g.outbreak.count) g.outbreak.open[place.building] = 1; // whoever else is in there is now in reach
  emit(g, { type: 'breach', place: id });
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
      // nothing left to shoot: the click turns into a swing of whatever you have in hand
      emit(g, { type: 'empty' });
      tryMelee(g, face ?? g.player.heading);
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
      if (killed) registerKill(g, h.x[target], h.y[target]);
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

/** Put a pickup down, reusing the room of one already taken when the ground is full. */
function addPickup(g: GameState, pickup: Pickup): void {
  if (g.pickups.length < GAME.pickups.max) {
    g.pickups.push(pickup);
    return;
  }
  const spent = g.pickups.findIndex((p) => p.taken);
  if (spent >= 0) g.pickups[spent] = pickup;
}

/** A zombie died by the survivor's hand: count it, and perhaps it was carrying something. */
function registerKill(g: GameState, x: number, y: number): void {
  g.stats.kills++;
  const roll = nextFloat(g.rng);
  const D = GAME.drops;
  if (roll < D.ammo) addPickup(g, { x, y, kind: 'ammo', taken: false, amount: D.ammoAmount });
  else if (roll < D.ammo + D.food) addPickup(g, { x, y, kind: 'food', taken: false });
  else if (roll < D.ammo + D.food + D.medkit) addPickup(g, { x, y, kind: 'medkit', taken: false });
}

/** Swing at whatever is in front: a cone, short reach, three to fell a walker. Works with an empty gun. */
function tryMelee(g: GameState, heading: number): void {
  if (g.fireCooldown > 0) return;
  const m = GAME.melee;
  const { player: p, horde: h } = g;
  const fx = Math.cos(heading);
  const fy = Math.sin(heading);
  g.fireCooldown = m.cooldown;
  addNoise(g, p.x, p.y, m.noise, GAME.noise.ttl);
  emit(g, { type: 'swing', x: p.x, y: p.y, heading });
  for (let i = 0; i < h.used; i++) {
    if (!isAlive(h, i)) continue;
    const ox = h.x[i] - p.x;
    const oy = h.y[i] - p.y;
    const d = Math.hypot(ox, oy);
    if (d > m.range || d < 1e-4) continue;
    if ((ox * fx + oy * fy) / d < m.cone) continue;
    const killed = damageZombie(h, i, m.damage, p.x, p.y);
    emit(g, { type: 'hit', x: h.x[i], y: h.y[i], kill: killed });
    if (killed) registerKill(g, h.x[i], h.y[i]);
    else shoveZombie(h, i, ox / d, oy / d, m.knock, m.stun);
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
      registerKill(g, h.x[i], h.y[i]);
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
      addReserve(g, 'pistol', pick.amount ?? GAME.pickups.ammoAmount);
    } else if (pick.kind === 'food') {
      if (g.food > GAME.food.max - 10) continue; // not worth wasting while nearly full
      g.food = Math.min(GAME.food.max, g.food + (pick.amount ?? GAME.pickups.foodAmount));
    } else {
      if (g.health >= GAME.health) continue;
      g.health = Math.min(GAME.health, g.health + (pick.amount ?? GAME.pickups.medkitAmount));
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
      food: 0,
      armory: true,
      shotgun: true,
    });
    return true;
  }
  let ammo = 0;
  let health = 0;
  let food = 0;
  const roll = nextFloat(g.rng);
  if (roll < GAME.loot.both) {
    ammo = Math.round(GAME.loot.ammo / 2);
    food = Math.round(GAME.loot.food / 2);
  } else if (roll < 0.4) ammo = GAME.loot.ammo;
  else if (roll < 0.65) health = GAME.loot.health;
  else food = GAME.loot.food;
  const gotAmmo = addReserve(g, 'pistol', ammo);
  const gotHealth = Math.min(health, GAME.health - g.health);
  const gotFood = Math.min(food, GAME.food.max - g.food);
  g.health += gotHealth;
  g.food += gotFood;
  // with nothing useful to take (full pack, health and stomach) the place is left as it was, for later
  g.used[place.id] = gotAmmo > 0 || gotHealth > 0 || gotFood > 0;
  emit(g, {
    type: 'loot',
    place: place.id,
    ammo: gotAmmo,
    health: Math.round(gotHealth),
    food: Math.round(gotFood),
    armory: false,
    shotgun: false,
  });
  return true;
}
