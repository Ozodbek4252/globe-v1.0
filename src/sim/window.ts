// Moving the game from one window of a big city to the next. The game always plays on one square map
// whose centre is the origin; in a city too big to hold at once, that square is a window of tiles
// around the survivor, and when they walk far enough the window moves. What moves with it:
//
//   - the survivor, the horde, the people in the street and the supplies, shifted into the new
//     window's coordinates; anyone the new window does not hold is folded into the counts of the
//     nearest building, so nobody is created or lost;
//   - a ledger, by building (its OpenStreetMap id), of what the outbreak has done to each building
//     the game has ever held: its people (well, bitten, turned), its door, and whether a shop was
//     searched or a shelter breached. Buildings the window sees for the first time are fresh.
//
// Pure and seeded: no DOM, no fetching.

import {
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
}

export type Ledger = Map<number, LedgerEntry>;

/** A fresh entry for a building the ledger has not seen (nobody in it, as far as it knows). */
const emptyEntry = (tick: number): LedgerEntry => ({
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
): Ledger {
  const ledger: Ledger = new Map();
  for (const [id, e] of entries) {
    ledger.set(id, {
      ...emptyEntry(tick),
      ...e,
      roaming: Number.isFinite(e.roaming) ? (e.roaming as number) : 0,
      tick: Number.isFinite(e.tick) ? (e.tick as number) : tick,
    });
  }
  return ledger;
}

/** Bring every entry up to `tick` (cheap: an entry with nobody sick is skipped at once). */
export function advanceLedger(ledger: Ledger, tick: number, rng: Rng): void {
  for (const e of ledger.values()) advanceEntry(e, tick, rng);
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
 * Everyone beyond `half` of the origin leaves the street for the nearest building the game knows:
 * zombies stay in its street, as roaming in the ledger; people go in as well ones (the bitten as
 * bitten). Returns how many of each were folded.
 */
export function foldOutside(
  g: GameState,
  world: GameWorld,
  half: number,
  ledger: Ledger,
): { zombies: number; people: number } {
  const out = { zombies: 0, people: 0 };
  const h = g.horde;
  for (let i = 0; i < h.used; i++) {
    if (h.state[i] >= ZState.DEAD) continue;
    if (Math.abs(h.x[i]) <= half && Math.abs(h.y[i]) <= half) continue;
    const b = nearestBuilding(g, h.x[i], h.y[i]);
    if (b >= 0) {
      const id = world.buildings[b].id;
      const entry = ledger.get(id) ?? emptyEntry(g.tick);
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
    if (Math.abs(p.x[i]) <= half && Math.abs(p.y[i]) <= half) continue;
    const b = nearestBuilding(g, p.x[i], p.y[i]);
    if (b >= 0) {
      if (s === HState.BITTEN) g.outbreak.incubating[b]++;
      else g.outbreak.healthy[b]++;
    }
    releaseHuman(p, i);
    out.people++;
  }
  g.pickups = g.pickups.filter((pick) => Math.abs(pick.x) <= half && Math.abs(pick.y) <= half);
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
  shiftGame(old, shift[0], shift[1]);
  // fold against the new window's extent, with the old buildings still at hand to take them in
  foldOutside(old, oldWorld, newWorld.colliders.half, ledger);
  stashWindow(old, oldWorld, ledger); // the fold changed some counts
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
  g.food = old.food;
  g.stash = { ...old.stash };
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
