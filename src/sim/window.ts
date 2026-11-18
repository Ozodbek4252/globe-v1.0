// Moving the game from one window of a big city to the next. The game always plays on one square map
// whose centre is the origin; in a city too big to hold at once, that square is a window of tiles
// around the survivor, and when they walk far enough the window moves. What moves with it:
//
//   - the survivor, the horde, the people in the street and the supplies, shifted into the new
//     window's coordinates; anyone the new window does not hold is folded into the counts of the
//     nearest building, so nobody is created or lost;
//   - a ledger, by building (its OpenStreetMap id), of what the outbreak has done to each building
//     the game has ever held: its people (well, bitten, turned), its door, where it stands, and
//     whether a shop was searched or a shelter breached. Buildings the window sees for the first
//     time are fresh.
//
// The ledger is not a still picture. Every so often it is advanced: the outbreak goes on inside each
// building, the turned come out into its street as a roaming count, and the roaming batter the door
// they stand at, bite through it, and move on to the nearest doors with people behind them, so the
// outbreak keeps crossing the city where nobody is looking; the roaming just beyond the window's edge
// walk into it and become zombies the game plays.
//
// Pure and seeded: no DOM, no fetching.

import {
  copyStash,
  countPopulation,
  createGame,
  GAME,
  type GameOptions,
  type GameState,
  type GameWorld,
} from './game';
import { nextFloat, nextRange, type Rng } from '../lib/rng';
import { removeZombie, spawnZombie, ZKind, ZState } from './horde';
import { HState, releaseHuman } from './humans';
import { POP, roundSeeded } from './population';
import { packArrays, unpackArrays } from './save';
import { CAR, parkCars, type Car } from './vehicle';
import { validSpot } from './world';

/** What is remembered about a building when its tile is not loaded. */
export interface LedgerEntry {
  healthy: number;
  incubating: number;
  undead: number;
  doorHp: number;
  open: boolean;
  /** For a building that is a place: searched (shops, the armory, the radar) or breached (a shelter). */
  used: boolean;
  breached: boolean;
  /** What is left of a shelter's door (the game's own door, not the building's). */
  shelterDoor: number;
  /**
   * The turned who are out in the street near this building, not as individuals: zombies the window
   * left behind, and those who came out while the tile was away. They take to the street as
   * individuals when the tile is loaded again.
   */
  roaming: number;
  /** The game tick this was last brought up to date; the outbreak inside goes on from there. */
  tick: number;
  /**
   * Where the door is, in the current window's coordinates (the whole ledger moves with the window).
   * NaN when it is not known: a building nobody can get to, or an entry from an older save; such a
   * building takes no part in the spread.
   */
  x: number;
  y: number;
  /** Whether the building is a shelter (its door is the game's own, far stronger one). */
  shelter: boolean;
}

export type Ledger = Map<number, LedgerEntry>;

/**
 * The outbreak between buildings while nobody is looking. The roaming at a door with people behind
 * it batter it and bite through it; with nobody well left in theirs they move on to the nearest doors
 * that still have, splitting up as they go. Per zombie-second, capped at a doorful of them.
 */
export const SPREAD = {
  /** How far the roaming look for the next door with people behind it (metres), and over how many they split. */
  reach: 70,
  fanout: 2,
  /** How many fit at one door; what each does to it per second; how many bites each lands per second once it is open. */
  atDoor: 6,
  blow: 8,
  bite: 0.3,
  /** Roaming this far beyond the window's edge (metres) walk into it: at most this many per building and per pass. */
  edge: 120,
  enterEach: 20,
  enterMost: 80,
} as const;

/** A fresh entry for a building the ledger has not seen (nobody in it, as far as it knows). */
const emptyEntry = (tick: number, x = Number.NaN, y = Number.NaN): LedgerEntry => ({
  healthy: 0,
  incubating: 0,
  undead: 0,
  doorHp: 0,
  open: false,
  used: false,
  breached: false,
  shelterDoor: GAME.shelter.door,
  roaming: 0,
  tick,
  x,
  y,
  shelter: false,
});

/**
 * The outbreak inside a building while its tile was away, brought up to `tick`: the same rules as
 * `stepOutbreak`, in strides of up to twenty seconds, by day (the night is not known from here). The
 * turned who come out join the roaming; the well do not run out into a street nobody holds.
 */
export function advanceEntry(e: LedgerEntry, tick: number, rng: Rng): void {
  let seconds = Math.max(0, (tick - e.tick) / 60);
  e.tick = tick;
  if (e.incubating + e.undead === 0 || seconds < 1) return;
  while (seconds > 0) {
    const stride = Math.min(20, seconds);
    seconds -= stride;
    const turned = Math.min(
      e.incubating,
      roundSeeded((e.incubating * stride) / POP.incubation, rng),
    );
    e.incubating -= turned;
    e.undead += turned;
    const bitten = Math.min(e.healthy, roundSeeded(e.undead * POP.bite * stride, rng));
    e.healthy -= bitten;
    e.incubating += bitten;
    if (e.undead >= 2 || (e.undead > 0 && e.healthy === 0 && e.incubating === 0)) {
      const out = Math.min(e.undead, Math.max(1, roundSeeded(e.undead * POP.emerge * stride, rng)));
      e.undead -= out;
      e.roaming += out;
    }
    if (e.incubating + e.undead === 0) break;
  }
}

/**
 * A ledger from a saved game. A game saved before the ledger kept roaming zombies and a tick has
 * entries without them: they are taken as up to date at `tick`, with nobody roaming.
 */
export function readLedger(
  entries: readonly [number, Partial<LedgerEntry>][],
  tick: number,
  onRepair?: (id: number, entry: Partial<LedgerEntry>, fields: string[]) => void,
): Ledger {
  const ledger: Ledger = new Map();
  const blank = emptyEntry(tick);
  for (const [id, e] of entries) {
    const bad: string[] = [];
    const num = (key: keyof LedgerEntry, fallback: number): number => {
      const v = e[key];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
      bad.push(key);
      return fallback;
    };
    const flag = (key: keyof LedgerEntry): boolean => {
      const v = e[key];
      if (typeof v === 'boolean') return v;
      bad.push(key);
      return false;
    };
    // a save from before the ledger knew where buildings stood: not known, and not a fault
    const where = (key: 'x' | 'y'): number => {
      const v = e[key];
      return typeof v === 'number' && Number.isFinite(v) ? v : Number.NaN;
    };
    ledger.set(id, {
      healthy: num('healthy', 0),
      incubating: num('incubating', 0),
      undead: num('undead', 0),
      doorHp: num('doorHp', blank.doorHp),
      open: flag('open'),
      used: flag('used'),
      breached: flag('breached'),
      shelterDoor: num('shelterDoor', blank.shelterDoor),
      roaming: num('roaming', 0),
      tick: num('tick', tick),
      x: where('x'),
      y: where('y'),
      shelter: e.shelter === true,
    });
    if (bad.length > 0) onRepair?.(id, e, bad);
  }
  return ledger;
}

/**
 * Bring every entry up to `tick`: the outbreak inside each building, then the roaming at the doors
 * (see `SPREAD`). `skip` names the buildings the window holds now: the game plays those itself, and
 * their entries are stale until the window moves on. Cheap for a quiet entry, which is looked at once.
 */
export function advanceLedger(
  ledger: Ledger,
  tick: number,
  rng: Rng,
  skip?: ReadonlySet<number>,
): void {
  const street: { e: LedgerEntry; seconds: number }[] = [];
  for (const [id, e] of ledger) {
    if (skip?.has(id)) continue;
    const seconds = (tick - e.tick) / 60;
    advanceEntry(e, tick, rng);
    if (e.roaming > 0 && seconds >= 1 && !Number.isNaN(e.x)) street.push({ e, seconds });
  }
  if (street.length > 0) spreadRoaming(ledger, street, rng, skip);
}

/** The roaming at a building's own door: batter it, and once it is open bite whoever is behind it. */
function batterEntry(e: LedgerEntry, seconds: number, rng: Rng): void {
  const at = Math.min(e.roaming, SPREAD.atDoor);
  let left = seconds;
  const shut = e.shelter ? !e.breached : !e.open;
  if (shut) {
    const hp = e.shelter ? e.shelterDoor : e.doorHp;
    const takes = hp / (at * SPREAD.blow); // seconds until it gives way
    if (takes >= seconds) {
      if (e.shelter) e.shelterDoor = hp - at * SPREAD.blow * seconds;
      else e.doorHp = hp - at * SPREAD.blow * seconds;
      return;
    }
    left = seconds - takes;
    e.open = true;
    if (e.shelter) {
      e.shelterDoor = 0;
      e.breached = true;
    } else e.doorHp = 0;
  }
  const bitten = Math.min(e.healthy, roundSeeded(at * SPREAD.bite * left, rng));
  e.healthy -= bitten;
  e.incubating += bitten;
}

/** The entries with a door and people behind it, by cell of `SPREAD.reach`, for finding the nearest. */
function targetGrid(ledger: Ledger, skip?: ReadonlySet<number>): Map<string, LedgerEntry[]> {
  const grid = new Map<string, LedgerEntry[]>();
  for (const [id, e] of ledger) {
    if (e.healthy <= 0 || Number.isNaN(e.x) || skip?.has(id)) continue;
    const key = `${Math.floor(e.x / SPREAD.reach)},${Math.floor(e.y / SPREAD.reach)}`;
    const cell = grid.get(key);
    if (cell) cell.push(e);
    else grid.set(key, [e]);
  }
  return grid;
}

/** The nearest `SPREAD.fanout` doors within reach of `e` that still have someone well behind them. */
function nearestTargets(grid: Map<string, LedgerEntry[]>, e: LedgerEntry): LedgerEntry[] {
  const cx = Math.floor(e.x / SPREAD.reach);
  const cy = Math.floor(e.y / SPREAD.reach);
  const found: { t: LedgerEntry; d: number }[] = [];
  for (let gx = cx - 1; gx <= cx + 1; gx++) {
    for (let gy = cy - 1; gy <= cy + 1; gy++) {
      const cell = grid.get(`${gx},${gy}`);
      if (!cell) continue;
      for (const t of cell) {
        if (t === e || t.healthy <= 0) continue;
        const d = Math.hypot(t.x - e.x, t.y - e.y);
        if (d <= SPREAD.reach) found.push({ t, d });
      }
    }
  }
  found.sort((a, b) => a.d - b.d);
  return found.slice(0, SPREAD.fanout).map((f) => f.t);
}

/**
 * What the roaming do over their stride: those at a door with people behind it work on it; those
 * whose building has nobody well left move to the nearest doors that have, and are theirs next time.
 */
function spreadRoaming(
  ledger: Ledger,
  street: readonly { e: LedgerEntry; seconds: number }[],
  rng: Rng,
  skip?: ReadonlySet<number>,
): void {
  for (const { e, seconds } of street) if (e.healthy > 0) batterEntry(e, seconds, rng);
  let grid: Map<string, LedgerEntry[]> | null = null;
  for (const { e } of street) {
    if (e.healthy > 0 || e.roaming <= 0) continue;
    grid ??= targetGrid(ledger, skip);
    const targets = nearestTargets(grid, e);
    if (targets.length === 0) continue;
    const share = Math.floor(e.roaming / targets.length);
    for (let k = 1; k < targets.length; k++) {
      targets[k].roaming += share;
      e.roaming -= share;
    }
    targets[0].roaming += e.roaming;
    e.roaming = 0;
  }
}

/** Move every entry's door by (dx, dy): the ledger in the next window's coordinates. */
export function shiftLedger(ledger: Ledger, dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return;
  for (const e of ledger.values()) {
    e.x += dx;
    e.y += dy;
  }
}

/**
 * The roaming of buildings just beyond the window's edge walk into it, as zombies the game plays, a
 * few at a time near where their door is. Returns how many came in.
 */
export function enterWindow(
  g: GameState,
  world: GameWorld,
  ledger: Ledger,
  most: number = SPREAD.enterMost,
): number {
  const half = world.colliders.half;
  const inWindow = new Set(world.buildings.map((b) => b.id));
  const inside = half - 12;
  let placed = 0;
  for (const [id, e] of ledger) {
    if (placed >= most) break;
    if (e.roaming <= 0 || Number.isNaN(e.x) || inWindow.has(id)) continue;
    if (Math.abs(e.x) > half + SPREAD.edge || Math.abs(e.y) > half + SPREAD.edge) continue;
    const ex = Math.max(-inside, Math.min(inside, e.x));
    const ey = Math.max(-inside, Math.min(inside, e.y));
    let n = Math.min(e.roaming, SPREAD.enterEach, most - placed);
    while (n > 0) {
      let spot: [number, number] | null = null;
      for (let tries = 0; tries < 8 && !spot; tries++) {
        const a = nextFloat(g.rng) * Math.PI * 2;
        const r = nextRange(g.rng, 6, 40);
        const x = ex + Math.cos(a) * r;
        const y = ey + Math.sin(a) * r;
        if (Math.abs(x) < inside && Math.abs(y) < inside && validSpot(world, x, y, 0.6))
          spot = [x, y];
      }
      if (!spot) break;
      const kind = nextFloat(g.rng) < GAME.outbreak.runners ? ZKind.RUNNER : ZKind.WALKER;
      if (spawnZombie(g.horde, spot[0], spot[1], kind, ZState.WANDER) < 0) return placed;
      e.roaming--;
      placed++;
      n--;
    }
  }
  return placed;
}

/** What the ledger holds for buildings the window does not: the rest of the city, as last known. */
export function ledgerOutside(
  ledger: Ledger,
  world: GameWorld,
): { healthy: number; bitten: number; zombies: number } {
  const inWindow = new Set(world.buildings.map((b) => b.id));
  const out = { healthy: 0, bitten: 0, zombies: 0 };
  for (const [id, e] of ledger) {
    if (inWindow.has(id)) continue;
    out.healthy += e.healthy;
    out.bitten += e.incubating;
    out.zombies += e.undead + e.roaming;
  }
  return out;
}

/** Write every building of the window into the ledger, as it is now. */
export function stashWindow(g: GameState, world: GameWorld, ledger: Ledger): void {
  const o = g.outbreak;
  const placeOf = new Map(world.places.map((p) => [p.building, p]));
  for (let b = 0; b < o.count; b++) {
    const id = world.buildings[b].id;
    const place = placeOf.get(b);
    ledger.set(id, {
      healthy: o.healthy[b],
      incubating: o.incubating[b],
      undead: o.undead[b],
      doorHp: o.doorHp[b],
      open: o.open[b] === 1,
      roaming: ledger.get(id)?.roaming ?? 0,
      tick: g.tick,
      used: place ? g.used[place.id] : (ledger.get(id)?.used ?? false),
      breached: place ? g.breached[place.id] : (ledger.get(id)?.breached ?? false),
      shelterDoor: place ? g.doors[place.id] : (ledger.get(id)?.shelterDoor ?? GAME.shelter.door),
      x: o.doorX[b],
      y: o.doorY[b],
      shelter: place?.kind === 'shelter',
    });
  }
}

/** Give the buildings of a window what the ledger remembers about them. Buildings not in it stay fresh. */
export function applyLedger(g: GameState, world: GameWorld, ledger: Ledger): void {
  const o = g.outbreak;
  for (let b = 0; b < o.count; b++) {
    const entry = ledger.get(world.buildings[b].id);
    if (!entry) continue;
    advanceEntry(entry, g.tick, g.rng); // what happened inside while the tile was away
    o.healthy[b] = entry.healthy;
    o.incubating[b] = entry.incubating;
    o.undead[b] = entry.undead;
    o.doorHp[b] = entry.doorHp;
    o.open[b] = entry.open ? 1 : 0;
  }
  for (const place of world.places) {
    const entry = ledger.get(world.buildings[place.building].id);
    if (!entry) continue;
    g.used[place.id] = entry.used;
    g.breached[place.id] = entry.breached;
    if (place.kind === 'shelter') g.doors[place.id] = entry.shelterDoor;
  }
  releaseRoaming(g, world, ledger);
}

/** The roaming zombies of the window's buildings take to the street, near their doors, as room allows. */
export function releaseRoaming(g: GameState, world: GameWorld, ledger: Ledger): number {
  const o = g.outbreak;
  let placed = 0;
  for (let b = 0; b < o.count; b++) {
    const entry = ledger.get(world.buildings[b].id);
    if (!entry || entry.roaming <= 0 || Number.isNaN(o.doorX[b])) continue;
    while (entry.roaming > 0) {
      let spot: [number, number] | null = null;
      for (let tries = 0; tries < 8 && !spot; tries++) {
        const a = nextFloat(g.rng) * Math.PI * 2;
        const r = nextRange(g.rng, 6, 70);
        const x = o.doorX[b] + Math.cos(a) * r;
        const y = o.doorY[b] + Math.sin(a) * r;
        if (validSpot(world, x, y, 0.6)) spot = [x, y];
      }
      if (!spot) break;
      const kind = nextFloat(g.rng) < GAME.outbreak.runners ? ZKind.RUNNER : ZKind.WALKER;
      if (spawnZombie(g.horde, spot[0], spot[1], kind, ZState.WANDER) < 0) return placed;
      entry.roaming--;
      placed++;
    }
  }
  return placed;
}

/** Move everything with a position by (dx, dy): the new window's coordinates. */
export function shiftGame(g: GameState, dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return;
  g.player = { ...g.player, x: g.player.x + dx, y: g.player.y + dy };
  const h = g.horde;
  for (let i = 0; i < h.used; i++) {
    if (h.state[i] === ZState.FREE) continue;
    h.x[i] += dx;
    h.y[i] += dy;
    if (!Number.isNaN(h.tx[i])) {
      h.tx[i] += dx;
      h.ty[i] += dy;
    }
  }
  h.lastHitX += dx;
  h.lastHitY += dy;
  const p = g.humans;
  for (let i = 0; i < p.used; i++) {
    const s = p.state[i];
    if (s === HState.FREE) continue;
    p.x[i] += dx;
    p.y[i] += dy;
    // a runner's target is a direction, not a place
    if (s !== HState.FLEE && !Number.isNaN(p.tx[i])) {
      p.tx[i] += dx;
      p.ty[i] += dy;
    }
  }
  for (const pick of g.pickups) {
    pick.x += dx;
    pick.y += dy;
  }
  for (const car of g.cars) {
    car.x += dx;
    car.y += dy;
  }
  for (const n of g.noises) {
    n.x += dx;
    n.y += dy;
  }
}

/** The nearest building with a door to a point, or -1. */
function nearestBuilding(g: GameState, x: number, y: number): number {
  const o = g.outbreak;
  let best = -1;
  let bestD = Infinity;
  for (let b = 0; b < o.count; b++) {
    const dx = o.doorX[b];
    if (Number.isNaN(dx)) continue;
    const d = (dx - x) ** 2 + (o.doorY[b] - y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

/**
 * Everyone beyond `half` of `centre` leaves the street for the nearest building the game knows:
 * zombies stay in its street, as roaming in the ledger; people go in as well ones (the bitten as
 * bitten). Returns how many of each were folded.
 */
export function foldOutside(
  g: GameState,
  world: GameWorld,
  half: number,
  ledger: Ledger,
  centre: readonly [number, number] = [0, 0],
): { zombies: number; people: number } {
  const out = { zombies: 0, people: 0 };
  const within = (x: number, y: number): boolean =>
    Math.abs(x - centre[0]) <= half && Math.abs(y - centre[1]) <= half;
  const h = g.horde;
  const o = g.outbreak;
  for (let i = 0; i < h.used; i++) {
    if (h.state[i] >= ZState.DEAD) continue;
    if (within(h.x[i], h.y[i])) continue;
    const b = nearestBuilding(g, h.x[i], h.y[i]);
    if (b >= 0) {
      const id = world.buildings[b].id;
      const entry = ledger.get(id) ?? emptyEntry(g.tick, o.doorX[b], o.doorY[b]);
      entry.roaming++;
      ledger.set(id, entry);
    }
    removeZombie(h, i);
    out.zombies++;
  }
  const p = g.humans;
  for (let i = 0; i < p.used; i++) {
    const s = p.state[i];
    if (s === HState.FREE) continue;
    if (within(p.x[i], p.y[i])) continue;
    const b = nearestBuilding(g, p.x[i], p.y[i]);
    if (b >= 0) {
      if (s === HState.BITTEN) o.incubating[b]++;
      else o.healthy[b]++;
    }
    releaseHuman(p, i);
    out.people++;
  }
  g.pickups = g.pickups.filter((pick) => within(pick.x, pick.y));
  return out;
}

/**
 * The game, carried into a new window. `shift` is where the old origin lies in the new window's
 * coordinates. The old window's buildings go into the ledger first; whoever the new window does not
 * hold is folded into buildings; the new window's buildings take what the ledger has for them, the
 * rest start fresh (its street starts empty, and fills as the hour calls for).
 */
export function migrateGame(
  old: GameState,
  oldWorld: GameWorld,
  newWorld: GameWorld,
  options: GameOptions,
  shift: [number, number],
  ledger: Ledger,
): GameState {
  stashWindow(old, oldWorld, ledger);
  // fold against the new window's extent (its centre is at -shift in the old coordinates), with the
  // old buildings still at hand to take them in
  foldOutside(old, oldWorld, newWorld.colliders.half, ledger, [-shift[0], -shift[1]]);
  stashWindow(old, oldWorld, ledger); // the fold changed some counts
  shiftGame(old, shift[0], shift[1]);
  shiftLedger(ledger, shift[0], shift[1]);
  advanceLedger(ledger, old.tick, old.rng); // and the rest of the city has not stood still

  const g = createGame(newWorld, {
    ...options,
    startX: old.player.x,
    startY: old.player.y,
    patients: 0,
    clumps: 0,
  });
  // the new window's own street people would double those carried over: start it empty
  g.humans.state.fill(HState.FREE);
  g.humans.used = 0;
  g.humans.alive = 0;
  g.humans.freeCount = 0;
  applyLedger(g, newWorld, ledger);

  // the survivor and their things
  g.tick = old.tick;
  g.time = old.time;
  g.status = old.status;
  g.player = { ...old.player };
  g.health = old.health;
  g.sinceHurt = old.sinceHurt;
  g.weapon = old.weapon;
  g.ammo = old.ammo;
  g.reserve = old.reserve;
  g.hasShotgun = old.hasShotgun;
  g.hasRifle = old.hasRifle;
  g.food = old.food;
  g.stash = copyStash(old.stash);
  g.reloading = old.reloading;
  g.fireCooldown = old.fireCooldown;
  g.shoveCooldown = old.shoveCooldown;
  g.noises = old.noises.map((n) => ({ ...n }));
  g.stepTimer = old.stepTimer;
  g.pickups = old.pickups.map((p) => ({ ...p }));
  g.clock = old.clock;
  g.night = old.night;
  g.homeCursor = 0;
  g.countTimer = old.countTimer;
  g.radarOn = old.radarOn;
  g.inside = -1; // a shelter is a place of the old window; nobody moves while inside, so this is never a loss
  g.doorEventTimer = old.doorEventTimer;
  // The cars the new window still holds come along (the one being driven first of all); the ground
  // the old window covered keeps them as they were, and only the new ground gets fresh ones.
  const newHalf = newWorld.colliders.half;
  const oldHalf = oldWorld.colliders.half;
  const seenBefore = (x: number, y: number): boolean =>
    Math.abs(x - shift[0]) <= oldHalf && Math.abs(y - shift[1]) <= oldHalf;
  const kept: Car[] = [];
  let driving = -1;
  old.cars.forEach((car, i) => {
    if (Math.abs(car.x) > newHalf - 6 || Math.abs(car.y) > newHalf - 6) return;
    if (i === old.driving) driving = kept.length;
    kept.push({ ...car });
  });
  g.cars = kept.concat(
    parkCars(newWorld, g.rng, Math.max(0, CAR.parkMost - kept.length), seenBefore),
  );
  g.driving = driving;
  g.engineTimer = old.engineTimer;
  g.stats = { ...old.stats };
  g.rng.state = old.rng.state;
  // the horde and the street, as they stand
  unpackArrays(g.horde, packArrays(old.horde));
  unpackArrays(g.humans, packArrays(old.humans));
  g.flowTimer = 0;
  g.flowCell = -1;
  g.events = [];
  countPopulation(g);
  return g;
}
