import { describe, expect, it } from 'vitest';
import { createRng } from '../src/lib/rng';
import { buildColliders } from '../src/sim/colliders';
import {
  createGame,
  createGameWorld,
  drainEvents,
  NO_INPUT,
  stepGame,
  type GameOptions,
  type GameState,
  type GameWorld,
} from '../src/sim/game';
import { hordeChecksum, spawnZombie, ZKind, ZState } from '../src/sim/horde';
import { HState, spawnHuman } from '../src/sim/humans';
import type { PlaceBuilding } from '../src/sim/places';
import {
  advanceEntry,
  advanceLedger,
  applyLedger,
  enterWindow,
  foldOutside,
  ledgerOutside,
  migrateGame,
  readLedger,
  shiftGame,
  shiftLedger,
  SPREAD,
  stashWindow,
  type Ledger,
  type LedgerEntry,
} from '../src/sim/window';
import { box, DT } from './helpers/town';

/** The same city seen through two windows: buildings in city coordinates, each window with its own origin. */
const CITY: PlaceBuilding[] = Array.from({ length: 16 }, (_, i) => ({
  id: 1000 + i,
  outer: box(((i % 4) - 1) * 400 + 20, (Math.floor(i / 4) - 1) * 400 + 20, 30),
  height: 18,
  kind: 'apartments',
}));

/** A window of the city: `half` around `origin`, holding the buildings whose centre falls inside it. */
function windowWorld(origin: [number, number], half: number): GameWorld {
  const buildings = CITY.filter((b) => {
    const cx = b.outer[0] + 15 - origin[0];
    const cy = b.outer[1] + 15 - origin[1];
    return Math.abs(cx) <= half && Math.abs(cy) <= half;
  }).map((b) => ({
    ...b,
    outer: b.outer.map((v, k) => v - (k % 2 === 0 ? origin[0] : origin[1])),
  }));
  const colliders = buildColliders({
    halfSize: half,
    buildings: buildings.map((b) => ({ outer: b.outer })),
    areas: [],
    waterways: [],
    roads: [],
  });
  return createGameWorld(colliders, [0, 0], buildings);
}

const OPTIONS: GameOptions = {
  seed: 4,
  startX: 0,
  startY: 0,
  clumps: 0,
  patients: 0,
  density: 300,
  cycle: false,
  routine: false,
};

const people = (g: GameState): number =>
  g.population.healthy + g.population.bitten + g.population.zombies;

const run = (g: GameState, world: GameWorld, seconds: number): void => {
  for (let s = 0; s < Math.round(seconds / DT); s++) {
    stepGame(g, NO_INPUT, world, DT);
    drainEvents(g);
  }
};

describe('shifting the game', () => {
  it('moves everything with a position, and a runner keeps their direction', () => {
    const world = windowWorld([0, 0], 800);
    const g = createGame(world, OPTIONS);
    const z = spawnZombie(g.horde, 10, 20, ZKind.WALKER, ZState.INVESTIGATE);
    g.horde.tx[z] = 50;
    g.horde.ty[z] = 60;
    const walker = spawnHuman(g.humans, 1, 2, HState.WALK);
    g.humans.tx[walker] = 30;
    g.humans.ty[walker] = 40;
    const runner = spawnHuman(g.humans, 3, 4, HState.FLEE);
    g.humans.tx[runner] = 1;
    g.humans.ty[runner] = 0;
    g.pickups.push({ kind: 'food', x: 5, y: 6, taken: false });
    shiftGame(g, -100, 200);
    expect([g.player.x, g.player.y]).toEqual([-100, 200]);
    expect([g.horde.x[z], g.horde.y[z], g.horde.tx[z], g.horde.ty[z]]).toEqual([
      -90, 220, -50, 260,
    ]);
    expect([g.humans.x[walker], g.humans.tx[walker]]).toEqual([-99, -70]);
    expect([g.humans.tx[runner], g.humans.ty[runner]]).toEqual([1, 0]);
    expect(g.pickups.at(-1)).toMatchObject({ x: -95, y: 206 });
  });
});

describe('folding whoever leaves the window', () => {
  it('turns them into counts in the nearest building, and nobody is lost', () => {
    const world = windowWorld([0, 0], 800);
    const g = createGame(world, OPTIONS);
    const indoorsBefore = g.outbreak.healthy.reduce((n, v) => n + v, 0);
    const aliveBefore = g.humans.alive; // the street crowd the game put out itself
    spawnZombie(g.horde, 900, 0, ZKind.WALKER, ZState.WANDER); // outside
    spawnZombie(g.horde, 100, 0, ZKind.WALKER, ZState.WANDER); // inside
    spawnHuman(g.humans, -900, 0, HState.WALK); // outside
    const bitten = spawnHuman(g.humans, 0, 900, HState.WALK); // outside, bitten
    g.humans.state[bitten] = HState.BITTEN;
    g.humans.alive--;
    const ledger: Ledger = new Map();
    const folded = foldOutside(g, world, 800, ledger);
    expect(folded).toEqual({ zombies: 1, people: 2 });
    expect(g.horde.alive).toBe(1);
    // the zombie outside stays in the street of the nearest building, as roaming
    let roaming = 0;
    for (const e of ledger.values()) roaming += e.roaming;
    expect(roaming).toBe(1);
    expect(g.humans.alive).toBe(aliveBefore); // the two outsiders are gone, the crowd is still there
    const o = g.outbreak;
    let undead = 0;
    let incubating = 0;
    let healthy = 0;
    for (let b = 0; b < o.count; b++) {
      undead += o.undead[b];
      incubating += o.incubating[b];
      healthy += o.healthy[b];
    }
    // the people outside went indoors, by kind; the inside zombie is still in the street
    expect(undead).toBe(0);
    expect(incubating).toBe(1);
    expect(healthy).toBe(indoorsBefore + 1); // the one well person who was outside went in
  });
});

describe('the ledger', () => {
  it('remembers a building by its id, and gives it back to any window that holds it', () => {
    const a = windowWorld([0, 0], 800);
    const ga = createGame(a, OPTIONS);
    const id = a.buildings[0].id;
    ga.outbreak.undead[0] = 7;
    ga.outbreak.healthy[0] = 3;
    ga.outbreak.open[0] = 1;
    const ledger: Ledger = new Map();
    stashWindow(ga, a, ledger);
    expect(ledger.get(id)).toMatchObject({
      undead: 7,
      healthy: 3,
      open: true,
      x: ga.outbreak.doorX[0],
      y: ga.outbreak.doorY[0],
      shelter: false,
    });

    const b = windowWorld([400, 0], 800); // another window that also holds that building
    const gb = createGame(b, OPTIONS);
    const slot = b.buildings.findIndex((x) => x.id === id);
    expect(slot).toBeGreaterThanOrEqual(0);
    applyLedger(gb, b, ledger);
    expect([gb.outbreak.undead[slot], gb.outbreak.healthy[slot], gb.outbreak.open[slot]]).toEqual([
      7, 3, 1,
    ]);
  });

  it('keeps a searched shop searched and a breached shelter breached', () => {
    const a = windowWorld([0, 0], 800);
    const ga = createGame(a, OPTIONS);
    expect(a.places.length).toBeGreaterThan(0);
    for (const p of a.places) {
      ga.used[p.id] = true;
      ga.breached[p.id] = true;
    }
    const ledger: Ledger = new Map();
    stashWindow(ga, a, ledger);
    const gb = createGame(a, OPTIONS);
    applyLedger(gb, a, ledger);
    expect(gb.used.every(Boolean)).toBe(true);
    expect(gb.breached.every(Boolean)).toBe(true);
  });
});

const entry = (healthy: number, incubating: number, undead: number): LedgerEntry => ({
  healthy,
  incubating,
  undead,
  doorHp: 100,
  open: false,
  used: false,
  breached: false,
  shelterDoor: 600,
  roaming: 0,
  tick: 0,
  x: Number.NaN,
  y: Number.NaN,
  shelter: false,
});
const total = (e: LedgerEntry): number => e.healthy + e.incubating + e.undead + e.roaming;

describe('a tile that is away', () => {
  it('goes on with the outbreak inside: the bitten turn, the turned bite, and some come out', () => {
    const e = entry(80, 0, 3);
    const rng = createRng(5);
    advanceEntry(e, 60 * 120, rng); // two minutes
    expect(e.tick).toBe(60 * 120);
    expect(e.healthy).toBeLessThan(80);
    expect(e.roaming).toBeGreaterThan(0);
    expect(total(e)).toBe(83);
    // and again, from where it got to
    const before = e.healthy;
    advanceEntry(e, 60 * 240, rng);
    expect(e.healthy).toBeLessThanOrEqual(before);
    expect(total(e)).toBe(83);
  });

  it('leaves a well building alone, and costs nothing to look at', () => {
    const e = entry(80, 0, 0);
    advanceEntry(e, 60 * 3600, createRng(1));
    expect(e).toMatchObject({ healthy: 80, roaming: 0, tick: 60 * 3600 });
  });

  it('is the same for the same seed', () => {
    const run = (): string => {
      const e = entry(50, 2, 2);
      advanceEntry(e, 60 * 600, createRng(9));
      return JSON.stringify(e);
    };
    expect(run()).toBe(run());
  });

  it('sends its roaming into the street when it comes back, as room allows, and nobody is lost', () => {
    const world = windowWorld([0, 0], 800);
    const g = createGame(world, { ...OPTIONS, capacity: 12 });
    const ledger: Ledger = new Map();
    const id = world.buildings[0].id;
    ledger.set(id, { ...entry(5, 0, 0), roaming: 20 });
    applyLedger(g, world, ledger);
    expect(g.horde.alive).toBe(12); // the street is full
    expect(ledger.get(id)?.roaming).toBe(8); // the rest wait their turn
    for (let i = 0; i < g.horde.used; i++) {
      if (g.horde.state[i] >= ZState.DEAD) continue;
      const d = Math.hypot(g.horde.x[i] - g.outbreak.doorX[0], g.horde.y[i] - g.outbreak.doorY[0]);
      expect(d).toBeLessThan(75);
    }
  });

  it('is counted with the rest of the city', () => {
    const world = windowWorld([0, 0], 800);
    const ledger: Ledger = new Map();
    ledger.set(world.buildings[0].id, entry(10, 1, 2)); // in the window: not counted as outside
    ledger.set(999_001, { ...entry(30, 4, 5), roaming: 6 }); // elsewhere
    ledger.set(999_002, entry(7, 0, 0));
    expect(ledgerOutside(ledger, world)).toEqual({ healthy: 37, bitten: 4, zombies: 11 });
  });
});

describe('the street beyond the window', () => {
  const STRIDE = 60 * 20; // ticks: the ledger is advanced every twenty seconds
  /** A row of houses `apart` metres along a street, ten people in each, numbered from the west. */
  const row = (n: number, apart = 24): Ledger => {
    const ledger: Ledger = new Map();
    for (let i = 0; i < n; i++)
      ledger.set(100 + i, { ...entry(10, 0, 0), doorHp: 60, x: i * apart, y: 0 });
    return ledger;
  };
  const house = (ledger: Ledger, i: number): LedgerEntry => ledger.get(100 + i)!;
  const everyone = (ledger: Ledger): number =>
    [...ledger.values()].reduce((n, e) => n + total(e), 0);
  const minutes = (ledger: Ledger, m: number, seed = 3, skip?: Set<number>): void => {
    const rng = createRng(seed);
    for (let k = 1; k <= m * 3; k++) advanceLedger(ledger, k * STRIDE, rng, skip);
  };

  it('batters the door they stand at, bites through it, and moves on down the street', () => {
    const ledger = row(12);
    Object.assign(house(ledger, 0), { healthy: 0, roaming: 4 });
    ledger.set(999, { ...entry(10, 0, 0), x: 1000, y: 0 }); // a house across the city
    minutes(ledger, 10);
    // the outbreak went down the row, house by house, and nobody was made or lost on the way
    const touched = Array.from({ length: 12 }, (_, i) => house(ledger, i).healthy < 10);
    const reached = touched.lastIndexOf(true);
    expect(reached).toBeGreaterThanOrEqual(4);
    expect(touched.slice(0, reached).every(Boolean)).toBe(true);
    expect(house(ledger, 0).roaming).toBe(0); // they moved on
    expect(house(ledger, 1).open).toBe(true);
    expect(ledger.get(999)).toMatchObject({ healthy: 10, roaming: 0 });
    expect(everyone(ledger)).toBe(11 * 10 + 4 + 10);
  });

  it('does not reach across a gap wider than its reach', () => {
    const ledger = row(6, SPREAD.reach + 10);
    Object.assign(house(ledger, 0), { healthy: 0, roaming: 6 });
    minutes(ledger, 10);
    expect(house(ledger, 1).healthy).toBe(10);
    expect(house(ledger, 0).roaming).toBe(6);
  });

  it("leaves the window's own buildings to the game", () => {
    const ledger = row(8);
    Object.assign(house(ledger, 0), { healthy: 0, roaming: 4 });
    minutes(ledger, 10, 3, new Set([101])); // house 1 is in the window
    expect(house(ledger, 1)).toMatchObject({ healthy: 10, roaming: 0, tick: 0 });
    expect(house(ledger, 2).healthy).toBeLessThan(10); // the next one is within reach
  });

  it("breaks a shelter's own door, and the game sees it breached", () => {
    const ledger: Ledger = new Map();
    ledger.set(1, { ...entry(10, 0, 0), x: 0, y: 0, shelter: true, roaming: 6 });
    advanceLedger(ledger, STRIDE, createRng(1));
    expect(ledger.get(1)).toMatchObject({ breached: true, open: true, shelterDoor: 0 });
    expect(ledger.get(1)!.healthy).toBeLessThan(10);
  });

  it('is the same for the same seed', () => {
    const run = (): string => {
      const ledger = row(10);
      Object.assign(house(ledger, 0), { healthy: 0, roaming: 3 });
      minutes(ledger, 6, 11);
      return JSON.stringify([...ledger]);
    };
    expect(run()).toBe(run());
  });

  it('walks into the window from just beyond its edge, and no further off', () => {
    const world = windowWorld([0, 0], 800);
    const g = createGame(world, OPTIONS);
    const before = g.horde.alive;
    const ledger: Ledger = new Map();
    ledger.set(999_001, { ...entry(0, 0, 0), x: 850, y: 0, roaming: 5 }); // just past the east edge
    ledger.set(999_002, { ...entry(0, 0, 0), x: 2000, y: 0, roaming: 5 }); // far off
    ledger.set(world.buildings[0].id, { ...entry(0, 0, 0), x: 0, y: 0, roaming: 3 }); // the window's own
    expect(enterWindow(g, world, ledger)).toBe(5);
    expect(g.horde.alive).toBe(before + 5);
    expect(ledger.get(999_001)?.roaming).toBe(0);
    expect(ledger.get(999_002)?.roaming).toBe(5);
    expect(ledger.get(world.buildings[0].id)?.roaming).toBe(3);
    for (let i = 0; i < g.horde.used; i++) {
      if (g.horde.state[i] >= ZState.DEAD) continue;
      expect(g.horde.x[i]).toBeGreaterThan(740);
      expect(g.horde.x[i]).toBeLessThan(800);
    }
  });

  it('moves with the window', () => {
    const ledger: Ledger = new Map();
    ledger.set(1, { ...entry(1, 0, 0), x: 10, y: 20 });
    ledger.set(2, entry(1, 0, 0));
    shiftLedger(ledger, -400, 5);
    expect(ledger.get(1)).toMatchObject({ x: -390, y: 25 });
    expect(Number.isNaN(ledger.get(2)!.x)).toBe(true);
  });
});

describe('a ledger read from a save', () => {
  it('fills in what an older save did not keep, so nothing counts as NaN', () => {
    const old = {
      healthy: 12,
      incubating: 1,
      undead: 0,
      doorHp: 50,
      open: false,
      used: false,
      breached: false,
      shelterDoor: 0,
    };
    const ledger = readLedger([[7, old]], 600);
    const e = ledger.get(7);
    expect(e?.roaming).toBe(0);
    expect(e?.tick).toBe(600);
    expect(e?.healthy).toBe(12);
    expect(Number.isNaN(e?.x)).toBe(true); // where it stands is not known
    expect(e?.shelter).toBe(false);
    // a save from before the ledger knew where buildings stand is not a fault
    const repaired: number[] = [];
    readLedger([[9, { ...old, roaming: 0, tick: 5 }]], 600, (id) => repaired.push(id));
    expect(repaired).toEqual([]);
    const out = ledgerOutside(ledger, windowWorld([0, 0], 800));
    expect(Number.isFinite(out.healthy + out.bitten + out.zombies)).toBe(true);
    expect(out.healthy).toBe(12);
    // a full entry is kept as it is
    const full = readLedger([[8, { ...old, roaming: 3, tick: 120 }]], 600).get(8);
    expect(full?.roaming).toBe(3);
    expect(full?.tick).toBe(120);
  });
});

describe('moving to the next window', () => {
  it('carries the survivor, the horde, the street and the clock, shifted, and the counts add up', () => {
    const a = windowWorld([0, 0], 800);
    const ga = createGame(a, { ...OPTIONS, patients: 1, routine: false });
    for (let k = 0; k < 8; k++)
      spawnZombie(ga.horde, 300 + k * 2, 100, ZKind.WALKER, ZState.WANDER);
    ga.player = { ...ga.player, x: 350, y: 0 };
    run(ga, a, 20);
    ga.health = 55;
    ga.ammo = 3;
    const totalBefore = people(ga) + 0;
    const streetBefore = ga.horde.alive + ga.humans.alive;
    const checksum = hordeChecksum(ga.horde);

    // the window moves one block east: the old origin is now at x = -400
    const b = windowWorld([400, 0], 800);
    const ledger: Ledger = new Map();
    const gb = migrateGame(ga, a, b, OPTIONS, [-400, 0], ledger);
    expect(gb.player.x).toBeCloseTo(350 - 400, 6);
    expect(gb.health).toBe(55);
    expect(gb.ammo).toBe(3);
    expect(gb.time).toBeCloseTo(ga.time, 6);
    expect(gb.clock).toBe(ga.clock);
    // the zombies are the same ones, 400 m to the west in the new coordinates
    expect(gb.horde.alive + gb.humans.alive).toBeLessThanOrEqual(streetBefore);
    expect(hordeChecksum(gb.horde)).not.toBe(checksum); // moved
    shiftGame(gb, 400, 0);
    expect(hordeChecksum(gb.horde)).toBeCloseTo(checksum, 3); // and the same once moved back
    shiftGame(gb, -400, 0);
    // people: those in buildings both windows hold are the same; buildings only one holds come and go
    const shared = b.buildings.filter((x) => a.buildings.some((y) => y.id === x.id));
    for (const bld of shared) {
      const ia = a.buildings.findIndex((x) => x.id === bld.id);
      const ib = b.buildings.findIndex((x) => x.id === bld.id);
      expect(gb.outbreak.healthy[ib] + gb.outbreak.undead[ib] + gb.outbreak.incubating[ib]).toBe(
        ga.outbreak.healthy[ia] + ga.outbreak.undead[ia] + ga.outbreak.incubating[ia],
      );
    }
    expect(totalBefore).toBeGreaterThan(0);
    // the ledger knows where the old window's buildings stand, in the new coordinates
    const first = ledger.get(a.buildings[0].id)!;
    expect(first.x).toBeCloseTo(ga.outbreak.doorX[0] - 400, 3);
    expect(first.y).toBeCloseTo(ga.outbreak.doorY[0], 3);
    // and it plays on
    run(gb, b, 5);
    expect(gb.status).toBe('playing');
  });

  it('is the same game when the window does not move', () => {
    const a = windowWorld([0, 0], 800);
    const ga = createGame(a, { ...OPTIONS, patients: 1 });
    for (let k = 0; k < 5; k++) spawnZombie(ga.horde, 100 + k * 2, 50, ZKind.WALKER, ZState.WANDER);
    run(ga, a, 10);
    const ledger: Ledger = new Map();
    const gb = migrateGame(ga, a, windowWorld([0, 0], 800), OPTIONS, [0, 0], ledger);
    expect(hordeChecksum(gb.horde)).toBeCloseTo(hordeChecksum(ga.horde), 6);
    expect(people(gb)).toBe(people(ga));
    expect(Array.from(gb.outbreak.healthy)).toEqual(Array.from(ga.outbreak.healthy));
  });
});
