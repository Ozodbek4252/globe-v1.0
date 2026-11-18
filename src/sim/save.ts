// Saving and loading a game. A game is plain data, so it can be written out and read back exactly:
// the saved game, stepped with the same inputs, plays out as the original would have. What is saved
// is everything that changes; what can be rebuilt from the map (the flow field, the indexes, the
// target slots) is not. Pure: no DOM, no storage; the caller keeps the result wherever it likes.

import type { Rng } from '../lib/rng';
import {
  copyStash,
  countPopulation,
  createGame,
  emptyStash,
  type GameOptions,
  type GameState,
  type GameStats,
  type GameStatus,
  type GameWorld,
  type Pickup,
  type Stash,
  type WeaponName,
} from './game';
import type { Noise } from './horde';
import type { PlayerState } from './player';
import { KIND, KINDS, type Car } from './vehicle';
import type { LedgerEntry } from './window';

/** The arrays and counters of one of the in-place structures (the horde, the people, the buildings). */
export type SavedArrays = Record<string, ArrayBufferView | number>;

export interface SavedGame {
  version: 1;
  /** What the game was created with, so the same structures can be made again. */
  options: GameOptions;
  game: {
    tick: number;
    time: number;
    status: GameStatus;
    player: PlayerState;
    health: number;
    sinceHurt: number;
    weapon: WeaponName;
    ammo: number;
    reserve: number;
    hasShotgun: boolean;
    /** Absent in games saved before there was a rifle. */
    hasRifle?: boolean;
    food: number;
    /** Each gun's magazine and spare rounds; a save from when there were two guns has just the other one's. */
    stash: Stash | { ammo: number; reserve: number };
    reloading: number;
    fireCooldown: number;
    shoveCooldown: number;
    noises: Noise[];
    stepTimer: number;
    pickups: Pickup[];
    used: boolean[];
    clock: number;
    night: number;
    homeCursor: number;
    countTimer: number;
    radarOn: boolean;
    inside: number;
    doors: number[];
    breached: boolean[];
    doorEventTimer: number;
    /** The cars and the one being driven (absent in games saved before there were cars). */
    cars?: Car[];
    driving?: number;
    stats: GameStats;
    rng: number;
  };
  horde: SavedArrays;
  humans: SavedArrays;
  outbreak: SavedArrays;
  /**
   * For a game in a window of a bigger city: where the window's centre is (metres east and north of
   * the city's origin), and what the outbreak has done to every building the game has held.
   */
  city?: { origin: [number, number]; ledger: [number, LedgerEntry][] };
}

/** Scratch space, things rebuilt each step, and things fixed by the map: not worth saving. */
const NOT_SAVED = new Set(['grid', 'rng', 'pushed', 'capacity']);

export function packArrays(thing: object): SavedArrays {
  const out: SavedArrays = {};
  for (const [key, value] of Object.entries(thing)) {
    if (NOT_SAVED.has(key)) continue;
    if (ArrayBuffer.isView(value)) out[key] = (value as Float32Array).slice();
    else if (typeof value === 'number') out[key] = value;
  }
  const rng = (thing as { rng?: Rng }).rng;
  if (rng) out.rngState = rng.state;
  return out;
}

export function unpackArrays(thing: object, saved: SavedArrays): void {
  const target = thing as Record<string, unknown>;
  for (const [key, value] of Object.entries(saved)) {
    if (key === 'rngState') {
      (thing as { rng: Rng }).rng.state = value as number;
    } else if (ArrayBuffer.isView(value)) {
      const into = target[key];
      if (!ArrayBuffer.isView(into)) continue;
      const from = value as unknown as ArrayLike<number>;
      const dest = into as unknown as { set(a: ArrayLike<number>): void; length: number };
      // a save from a game with more room than this one: take what fits
      dest.set(
        from.length <= dest.length ? from : Array.prototype.slice.call(from, 0, dest.length),
      );
    } else if (typeof value === 'number' && typeof target[key] === 'number') {
      target[key] = value;
    }
  }
}

/** Everything about a game, as plain data (with typed arrays), to be stored and loaded later. */
export function saveGame(g: GameState, options: GameOptions): SavedGame {
  return {
    version: 1,
    options: { ...options },
    game: {
      tick: g.tick,
      time: g.time,
      status: g.status,
      player: { ...g.player },
      health: g.health,
      sinceHurt: g.sinceHurt,
      weapon: g.weapon,
      ammo: g.ammo,
      reserve: g.reserve,
      hasShotgun: g.hasShotgun,
      hasRifle: g.hasRifle,
      food: g.food,
      stash: copyStash(g.stash),
      reloading: g.reloading,
      fireCooldown: g.fireCooldown,
      shoveCooldown: g.shoveCooldown,
      noises: g.noises.map((n) => ({ ...n })),
      stepTimer: g.stepTimer,
      pickups: g.pickups.map((p) => ({ ...p })),
      used: [...g.used],
      clock: g.clock,
      night: g.night,
      homeCursor: g.homeCursor,
      countTimer: g.countTimer,
      radarOn: g.radarOn,
      inside: g.inside,
      doors: [...g.doors],
      breached: [...g.breached],
      doorEventTimer: g.doorEventTimer,
      cars: g.cars.map((c) => ({ ...c })),
      driving: g.driving,
      stats: { ...g.stats },
      rng: g.rng.state,
    },
    horde: packArrays(g.horde),
    humans: packArrays(g.humans),
    outbreak: packArrays(g.outbreak),
  };
}

/** Whether something read from storage is a saved game this code can load. */
export function isSavedGame(data: unknown): data is SavedGame {
  if (typeof data !== 'object' || data === null) return false;
  const d = data as Partial<SavedGame>;
  return (
    d.version === 1 &&
    typeof d.options === 'object' &&
    d.options !== null &&
    typeof d.game === 'object' &&
    d.game !== null &&
    typeof d.horde === 'object' &&
    typeof d.humans === 'object' &&
    typeof d.outbreak === 'object'
  );
}

/** A game as it was when it was saved, on the same map. */
export function loadGame(world: GameWorld, saved: SavedGame): GameState {
  // the same structures as the saved game had (the same capacities, the same map), then its contents
  const g = createGame(world, { ...saved.options, patients: 0, clumps: 0 });
  const s = saved.game;
  g.tick = s.tick;
  g.time = s.time;
  g.status = s.status;
  g.player = { ...s.player };
  g.health = s.health;
  g.sinceHurt = s.sinceHurt;
  g.weapon = s.weapon;
  g.ammo = s.ammo;
  g.reserve = s.reserve;
  g.hasShotgun = s.hasShotgun;
  g.hasRifle = s.hasRifle ?? false;
  g.food = s.food;
  if ('pistol' in s.stash) g.stash = copyStash(s.stash);
  else {
    // two guns: what was stashed belonged to the one not in hand
    g.stash = emptyStash();
    g.stash[s.weapon === 'pistol' ? 'shotgun' : 'pistol'] = { ...s.stash };
  }
  g.reloading = s.reloading;
  g.fireCooldown = s.fireCooldown;
  g.shoveCooldown = s.shoveCooldown;
  g.noises = s.noises.map((n) => ({ ...n }));
  g.stepTimer = s.stepTimer;
  g.pickups = s.pickups.map((p) => ({ ...p }));
  g.used = [...s.used];
  g.clock = s.clock;
  g.night = s.night;
  g.homeCursor = s.homeCursor;
  g.countTimer = s.countTimer;
  g.radarOn = s.radarOn;
  g.inside = s.inside;
  g.doors = [...s.doors];
  g.breached = [...s.breached];
  g.doorEventTimer = s.doorEventTimer;
  // (a game saved before there were cars keeps the ones just parked for it)
  // (a save from a build whose cars could not break has no condition: as good as new)
  // (a save from before there were kinds of car: they were all sedans)
  if (s.cars)
    g.cars = s.cars.map((c) => {
      const kind = typeof c.kind === 'number' && KINDS[c.kind] ? c.kind : KIND.SEDAN;
      return { ...c, kind, hp: c.hp ?? KINDS[kind].hp };
    });
  g.driving = s.cars ? (s.driving ?? -1) : -1;
  g.stats = { ...s.stats };
  g.rng.state = s.rng;
  unpackArrays(g.horde, saved.horde);
  unpackArrays(g.humans, saved.humans);
  unpackArrays(g.outbreak, saved.outbreak);
  // what is rebuilt: the flow field on the first step, the counts now
  g.flowTimer = 0;
  g.flowCell = -1;
  g.events = [];
  countPopulation(g);
  return g;
}
