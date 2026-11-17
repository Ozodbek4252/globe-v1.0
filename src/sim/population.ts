// The city's people, and how the outbreak moves through them. Pure and seeded: no DOM, no Three.js.
//
// Nearly everyone is indoors at any moment, so people are counted per building: how many are healthy,
// how many have been bitten and are turning, how many have turned and are still inside. A few percent
// are out in the street as individuals (see humans.ts). Infection spreads inside a building by itself;
// when enough have turned, they come out through the door as zombies you can see.

import { nextFloat, type Rng } from '../lib/rng';
import { findDoor, type PlaceBuilding } from './places';
import { validSpot, type GameWorld } from './world';

/** Tuning, in seconds and people. */
export const POP = {
  /** Fraction of the floor area people actually occupy (walls, stairs and so on take the rest). */
  netFloor: 0.78,
  /** Floor height used to count storeys when a building only has a height. */
  storey: 3.1,
  /** At night the dead bite this much more often (the same dark that quickens them in the street). */
  night: 0.5,
  /** Inside a building: bites per zombie per second; seconds from a bite to turning. */
  bite: 0.11,
  incubation: 14,
  /** Once two have turned (or nobody healthy is left), this fraction of the turned come out each second. */
  emerge: 0.3,
  /** When zombies are inside, this fraction of the healthy flee out into the street each second. */
  flee: 0.12,
  /** Door strength: a base, plus some per square metre of footprint, up to a cap. A shelter's is far stronger. */
  doorBase: 40,
  doorPerArea: 0.12,
  doorMax: 260,
} as const;

/** How many people are in a building at once, from its footprint, height and kind. A plain estimate. */
export function residentsOf(b: { height: number; kind: string }, area: number): number {
  if (area < 35) return 0; // a shed or a kiosk
  const floors = Math.max(1, Math.round(b.height / POP.storey));
  const floorArea = area * floors * POP.netFloor;
  let each: number; // square metres of floor for each person present
  switch (b.kind) {
    case 'apartments':
      each = 20;
      break;
    case 'house':
      each = 32;
      break;
    case 'commercial':
      each = 45; // workers and customers
      break;
    case 'civic':
      each = 28;
      break;
    case 'religious':
      each = 90;
      break;
    case 'industrial':
      each = 80;
      break;
    case 'garage':
      return 0;
    default:
      each = floors <= 2 ? 32 : 22; // 'other' is mostly houses and small blocks
  }
  return Math.round(floorArea / each);
}

const ringArea = (ring: readonly number[]): number => {
  let a = 0;
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += ring[i * 2] * ring[j * 2 + 1] - ring[j * 2] * ring[i * 2 + 1];
  }
  return Math.abs(a) / 2;
};

export interface Outbreak {
  /** Number of buildings. */
  count: number;
  /** Per building: people inside who are well, bitten and turning, and turned but still inside. */
  healthy: Int32Array;
  incubating: Int32Array;
  undead: Int32Array;
  /** Where the door is (NaN for a building with no usable door), and how much battering it can take. */
  doorX: Float32Array;
  doorY: Float32Array;
  doorHp: Float32Array;
  /** 1 once the door has given way. */
  open: Uint8Array;
  /** The people in the city when the game began, for "how much of it is left". */
  initial: number;
  /** Seconds since the last once-a-second step. */
  clock: number;
}

/**
 * Work out who lives where and where each door is. `strong` lists buildings (by index) whose doors are
 * extra strong (shelters).
 */
export function createOutbreak(
  buildings: readonly PlaceBuilding[],
  world: GameWorld,
  strong: ReadonlySet<number> = new Set(),
  shelterDoor = 600,
  /**
   * The real number of people to spread over the buildings (a known density times the area). The
   * buildings decide who lives where; this decides how many there are. Omit to trust the estimate.
   */
  total?: number,
): Outbreak {
  const n = buildings.length;
  const o: Outbreak = {
    count: n,
    healthy: new Int32Array(n),
    incubating: new Int32Array(n),
    undead: new Int32Array(n),
    doorX: new Float32Array(n).fill(Number.NaN),
    doorY: new Float32Array(n).fill(Number.NaN),
    doorHp: new Float32Array(n),
    open: new Uint8Array(n),
    initial: 0,
    clock: 0,
  };
  // who could live where, and where the doors are
  const areas = new Float64Array(n);
  const raw = new Float64Array(n);
  let rawTotal = 0;
  for (let i = 0; i < n; i++) {
    areas[i] = ringArea(buildings[i].outer);
    const people = residentsOf(buildings[i], areas[i]);
    if (people <= 0) continue;
    const door = findDoor(world, buildings[i].outer);
    if (!door) continue; // nobody can get to it, so the story never reaches it
    raw[i] = people;
    rawTotal += people;
    o.doorX[i] = door.x;
    o.doorY[i] = door.y;
    o.doorHp[i] = strong.has(i)
      ? shelterDoor
      : Math.min(POP.doorMax, POP.doorBase + areas[i] * POP.doorPerArea);
  }
  // scale to the real total, if one is known
  const scale = total !== undefined && rawTotal > 0 ? total / rawTotal : 1;
  for (let i = 0; i < n; i++) {
    const people = Math.round(raw[i] * scale);
    o.healthy[i] = people;
    o.initial += people;
  }
  return o;
}

/** Stochastic rounding: 2.3 becomes 2 seven times in ten and 3 three times in ten. */
export function roundSeeded(x: number, rng: Rng): number {
  const whole = Math.floor(x);
  return whole + (nextFloat(rng) < x - whole ? 1 : 0);
}

/** People in the city now, in each condition (indoors only; the streets are counted by the caller). */
export function indoorCounts(o: Outbreak): { healthy: number; incubating: number; undead: number } {
  let healthy = 0;
  let incubating = 0;
  let undead = 0;
  for (let i = 0; i < o.count; i++) {
    healthy += o.healthy[i];
    incubating += o.incubating[i];
    undead += o.undead[i];
  }
  return { healthy, incubating, undead };
}

/** Where the outbreak begins: `count` buildings with plenty of people, well away from the survivor. */
export function seedOutbreak(
  o: Outbreak,
  rng: Rng,
  count: number,
  awayFrom: readonly [number, number],
  minDistance: number,
): number[] {
  const chosen: number[] = [];
  for (let attempt = 0; attempt < 4000 && chosen.length < count; attempt++) {
    const b = Math.floor(nextFloat(rng) * o.count);
    if (o.healthy[b] < 6 || Number.isNaN(o.doorX[b])) continue;
    if (Math.hypot(o.doorX[b] - awayFrom[0], o.doorY[b] - awayFrom[1]) < minDistance) continue;
    if (chosen.some((c) => Math.hypot(o.doorX[c] - o.doorX[b], o.doorY[c] - o.doorY[b]) < 250))
      continue;
    chosen.push(b);
    o.undead[b] += 2;
    o.healthy[b] -= 2;
  }
  return chosen;
}

/** A person indoors is bitten (by a zombie at an open door, or inside). */
export function biteInside(o: Outbreak, b: number): boolean {
  if (o.healthy[b] <= 0) return false;
  o.healthy[b]--;
  o.incubating[b]++;
  return true;
}

/** A person comes in out of the street and shuts the door behind them. */
export function takeIn(o: Outbreak, b: number): void {
  o.healthy[b]++;
}

/**
 * One second of the outbreak inside every building. `emitZombies(b, n)` and `emitHumans(b, n)` try to
 * put that many onto the street and return how many were actually placed (the street can be full).
 */
export function stepOutbreak(
  o: Outbreak,
  seconds: number,
  rng: Rng,
  emitZombies: (building: number, n: number) => number,
  emitHumans: (building: number, n: number) => number,
  /** How dark it is, 0 to 1: the dead bite more often at night. */
  night = 0,
): void {
  const bite = POP.bite * (1 + POP.night * night);
  for (let b = 0; b < o.count; b++) {
    let h = o.healthy[b];
    let i = o.incubating[b];
    let u = o.undead[b];
    if (i + u === 0) continue;

    // the bitten turn
    const turned = Math.min(i, roundSeeded((i * seconds) / POP.incubation, rng));
    i -= turned;
    u += turned;
    // the turned bite the well
    const bitten = Math.min(h, roundSeeded(u * bite * seconds, rng));
    h -= bitten;
    i += bitten;
    o.healthy[b] = h;
    o.incubating[b] = i;
    o.undead[b] = u;

    // the well, seeing it, run for the street
    if (u > 0 && h > 0) {
      const out = Math.min(h, roundSeeded(h * POP.flee * seconds, rng));
      if (out > 0) o.healthy[b] -= emitHumans(b, out);
    }
    // the turned come out, once there are enough of them or nobody is left to bite
    u = o.undead[b];
    if (u >= 2 || (u > 0 && o.healthy[b] === 0 && o.incubating[b] === 0)) {
      const want = Math.min(u, Math.max(1, roundSeeded(u * POP.emerge * seconds, rng)));
      o.undead[b] -= emitZombies(b, want);
    }
  }
}

/** A zombie battering a building's door. Returns true when it has just given way. */
export function batter(o: Outbreak, b: number, damage: number): boolean {
  if (o.open[b]) return false;
  o.doorHp[b] -= damage;
  if (o.doorHp[b] > 0) return false;
  o.doorHp[b] = 0;
  o.open[b] = 1;
  return true;
}

/** Whether (x, y) next to a building's door is somewhere a person could stand (used to place the street's people). */
export function standableNear(world: GameWorld, x: number, y: number): boolean {
  return validSpot(world, x, y, 0.8);
}
