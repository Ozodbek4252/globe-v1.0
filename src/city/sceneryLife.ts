// Life in the tiles beyond the window, where the free camera looks: people walking the streets on
// fixed rounds, cars at the kerbs, and the turned the ledger says are roaming there, drifting about
// the doors they came out of. None of it is the game: no senses, no collisions, no counts change.
// It only looks like a city going on, so the window's edge is not a line where the city stops.
//
// Seeded by the tile, so a tile looks the same each time it is drawn.

import { createRng, nextFloat, nextRange, type Rng } from '../lib/rng';
import { OCC_BUILDING, OCC_WATER, occupancyAt, type Grid } from '../sim/grid';
import { createHorde, spawnZombie, ZKind, ZState, type Horde } from '../sim/horde';
import { createHumans, HState, spawnHuman, type Humans } from '../sim/humans';
import { CAR, parkAlong, type Car } from '../sim/vehicle';
import type { WorldRoad } from '../sim/world';

export const LIFE = {
  /** People on the pavements of a tile: so many per kilometre of street, up to a cap. */
  walkersPerKm: 16,
  walkersMost: 400,
  /** How fast they stroll (m/s), and how long a pause lasts when one stops (seconds). */
  walkSpeed: [1.0, 1.5] as const,
  pause: [2, 9] as const,
  pauseChance: 0.02,
  /** The turned drawn roaming a tile, at most; how fast they drift; how far from their door they stray. */
  shamblersMost: 60,
  shambleSpeed: [0.45, 0.8] as const,
  shambleRadius: 28,
} as const;

/** A street as a round: its polyline, the distance to each vertex, and how far from the middle to walk. */
interface Round {
  points: readonly number[];
  cum: Float32Array;
  length: number;
  kerb: number;
}

function roundsOf(roads: readonly WorldRoad[]): Round[] {
  const out: Round[] = [];
  for (const r of roads) {
    const n = r.points.length / 2;
    if (n < 2) continue;
    const cum = new Float32Array(n);
    for (let i = 1; i < n; i++) {
      cum[i] =
        cum[i - 1] +
        Math.hypot(
          r.points[i * 2] - r.points[i * 2 - 2],
          r.points[i * 2 + 1] - r.points[i * 2 - 1],
        );
    }
    const length = cum[n - 1];
    if (length < 30) continue;
    out.push({ points: r.points, cum, length, kerb: Math.max(0.6, r.width / 2 - 0.8) });
  }
  return out;
}

/** The point `along` metres down a round, and the unit direction of the street there. */
function pointAt(r: Round, along: number, out: Float32Array): void {
  const n = r.cum.length;
  let i = 1;
  while (i < n - 1 && r.cum[i] < along) i++;
  const ax = r.points[(i - 1) * 2];
  const ay = r.points[(i - 1) * 2 + 1];
  const bx = r.points[i * 2];
  const by = r.points[i * 2 + 1];
  const seg = r.cum[i] - r.cum[i - 1];
  const t = seg > 1e-6 ? Math.max(0, Math.min(1, (along - r.cum[i - 1]) / seg)) : 0;
  out[0] = ax + (bx - ax) * t;
  out[1] = ay + (by - ay) * t;
  const len = Math.hypot(bx - ax, by - ay) || 1;
  out[2] = (bx - ax) / len;
  out[3] = (by - ay) / len;
}

export interface Walkers {
  /** The people, as the people renderer wants them. `humans.used` is how many are out right now. */
  humans: Humans;
  count: number;
  /** Move everyone by `dt`; `share` (0 to 1) is how many of them are out at this hour. */
  step(dt: number, share: number): void;
}

/** People strolling the pavements of these streets, up and down, pausing now and then. */
export function createWalkers(
  roads: readonly WorldRoad[],
  seed: number,
  most: number = LIFE.walkersMost,
): Walkers {
  const rounds = roundsOf(roads);
  const km = rounds.reduce((n, r) => n + r.length, 0) / 1000;
  const count = Math.min(most, Math.round(km * LIFE.walkersPerKm));
  const humans = createHumans(Math.max(1, count), seed);
  const rng = createRng(seed ^ 0x7a1c);
  const round = new Int32Array(count);
  const along = new Float32Array(count);
  const dir = new Int8Array(count);
  const speed = new Float32Array(count);
  const rest = new Float32Array(count);
  const p = new Float32Array(4);
  if (rounds.length > 0) {
    // a round in proportion to its length, so long streets get their share of people
    const total = rounds.reduce((n, r) => n + r.length, 0);
    for (let i = 0; i < count; i++) {
      let pick = nextFloat(rng) * total;
      let k = 0;
      while (k < rounds.length - 1 && pick > rounds[k].length) pick -= rounds[k++].length;
      round[i] = k;
      along[i] = nextFloat(rng) * rounds[k].length;
      dir[i] = nextFloat(rng) < 0.5 ? 1 : -1;
      speed[i] = nextRange(rng, LIFE.walkSpeed[0], LIFE.walkSpeed[1]);
      pointAt(rounds[k], along[i], p);
      const side = dir[i];
      const slot = spawnHuman(
        humans,
        p[0] + p[3] * rounds[k].kerb * side,
        p[1] - p[2] * rounds[k].kerb * side,
        HState.WALK,
      );
      if (slot >= 0) humans.heading[slot] = Math.atan2(p[3] * dir[i], p[2] * dir[i]);
    }
  }
  const place = (i: number): void => {
    const r = rounds[round[i]];
    pointAt(r, along[i], p);
    // on the right-hand pavement of the way they walk
    const side = dir[i];
    humans.x[i] = p[0] + p[3] * r.kerb * side;
    humans.y[i] = p[1] - p[2] * r.kerb * side;
    const vx = p[2] * dir[i] * speed[i];
    const vy = p[3] * dir[i] * speed[i];
    humans.vx[i] = vx;
    humans.vy[i] = vy;
    humans.heading[i] = Math.atan2(vy, vx);
  };
  return {
    humans,
    count,
    step(dt, share) {
      // whoever is beyond `used` is indoors: the renderer draws up to `used`
      humans.used = Math.max(0, Math.min(count, Math.round(count * share)));
      if (dt <= 0) return;
      for (let i = 0; i < humans.used; i++) {
        if (rest[i] > 0) {
          rest[i] -= dt;
          humans.vx[i] = 0;
          humans.vy[i] = 0;
          continue;
        }
        const r = rounds[round[i]];
        along[i] += dir[i] * speed[i] * dt;
        if (along[i] >= r.length) {
          along[i] = r.length;
          dir[i] = -1;
        } else if (along[i] <= 0) {
          along[i] = 0;
          dir[i] = 1;
        }
        humans.travelled[i] += speed[i] * dt;
        if (nextFloat(rng) < LIFE.pauseChance * dt)
          rest[i] = nextRange(rng, LIFE.pause[0], LIFE.pause[1]);
        place(i);
      }
    },
  };
}

export interface Door {
  x: number;
  y: number;
  /** How many roam here. */
  count: number;
}

export interface Shamblers {
  /** The turned, as the zombie renderer wants them (a new horde whenever the doors change). */
  readonly horde: Horde;
  /** The doors the turned roam about now; nothing changes when they are the same as last time. */
  set(doors: readonly Door[]): void;
  step(dt: number): void;
}

/** The turned drifting about the doors they came out of, a few steps at a time. */
export function createShamblers(seed: number, most: number = LIFE.shamblersMost): Shamblers {
  let horde = createHorde(most, seed, 600);
  let homeX = new Float32Array(0);
  let homeY = new Float32Array(0);
  let tx = new Float32Array(0);
  let ty = new Float32Array(0);
  let wait = new Float32Array(0);
  let pace = new Float32Array(0);
  let key = '';
  const rng: Rng = createRng(seed ^ 0x2e5d);
  const roam = (i: number): void => {
    const a = nextFloat(rng) * Math.PI * 2;
    const r = nextRange(rng, 2, LIFE.shambleRadius);
    tx[i] = homeX[i] + Math.cos(a) * r;
    ty[i] = homeY[i] + Math.sin(a) * r;
  };
  return {
    get horde() {
      return horde;
    },
    set(doors) {
      const next = doors.map((d) => `${Math.round(d.x)},${Math.round(d.y)}:${d.count}`).join(';');
      if (next === key) return;
      key = next;
      horde = createHorde(most, seed, 600);
      const total = doors.reduce((n, d) => n + d.count, 0);
      const want = Math.min(most, total);
      homeX = new Float32Array(want);
      homeY = new Float32Array(want);
      tx = new Float32Array(want);
      ty = new Float32Array(want);
      wait = new Float32Array(want);
      pace = new Float32Array(want);
      let placed = 0;
      // each door's share of the figures, at least one each while there is room
      for (const d of doors) {
        const n = Math.max(1, Math.round((d.count / Math.max(1, total)) * want));
        for (let k = 0; k < n && placed < want; k++) {
          const a = nextFloat(rng) * Math.PI * 2;
          const r = nextRange(rng, 3, LIFE.shambleRadius);
          const x = d.x + Math.cos(a) * r;
          const y = d.y + Math.sin(a) * r;
          const kind = nextFloat(rng) < 0.12 ? ZKind.RUNNER : ZKind.WALKER;
          const slot = spawnZombie(horde, x, y, kind, ZState.WANDER);
          if (slot < 0) break;
          homeX[placed] = d.x;
          homeY[placed] = d.y;
          pace[placed] = nextRange(rng, LIFE.shambleSpeed[0], LIFE.shambleSpeed[1]);
          roam(placed);
          placed++;
        }
      }
    },
    step(dt) {
      if (dt <= 0) return;
      for (let i = 0; i < horde.used; i++) {
        if (wait[i] > 0) {
          wait[i] -= dt;
          horde.vx[i] = 0;
          horde.vy[i] = 0;
          continue;
        }
        const dx = tx[i] - horde.x[i];
        const dy = ty[i] - horde.y[i];
        const d = Math.hypot(dx, dy);
        if (d < 0.5) {
          wait[i] = nextRange(rng, 1, 5);
          roam(i);
          continue;
        }
        const vx = (dx / d) * pace[i];
        const vy = (dy / d) * pace[i];
        horde.x[i] += vx * dt;
        horde.y[i] += vy * dt;
        horde.vx[i] = vx;
        horde.vy[i] = vy;
        horde.heading[i] = Math.atan2(vy, vx);
      }
    },
  };
}

/** Cars at the kerbs of a tile's streets, kept off buildings and water by its occupancy grid. */
export function parkInTile(
  roads: readonly WorldRoad[],
  half: number,
  grid: Grid,
  seed: number,
  most: number = Math.ceil(CAR.parkMost / 9),
): Car[] {
  const rng = createRng(seed ^ 0x0ca7);
  const fits = (x: number, y: number, radius: number): boolean => {
    for (const [ox, oy] of [
      [0, 0],
      [radius, 0],
      [-radius, 0],
      [0, radius],
      [0, -radius],
    ]) {
      if ((occupancyAt(grid, x + ox, y + oy) & (OCC_BUILDING | OCC_WATER)) !== 0) return false;
    }
    return true;
  };
  return parkAlong(roads, half, rng, fits, most);
}
