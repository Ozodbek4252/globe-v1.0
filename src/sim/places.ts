// Buildings with a job. The city is full of ordinary buildings you cannot enter; a few are picked out
// and given a role, each with a door on the street where you stand to use it:
//
//   radar     a tall building with a radar on the roof. Power it up and you can see the horde.
//   shelter   a big, solid building. Go inside to hide, heal and reload, for as long as the door holds.
//   supplies  a shop or clinic with something worth taking.
//   armory    a warehouse with a better gun.
//
// The choice is made from the map data alone (size, height, kind, name), with no randomness, so the
// same city always gets the same places. Pure: no DOM, no Three.js.

import { clearance, insideBuilding } from './colliders';
import { validSpot, type GameWorld } from './world';

export type PlaceKind = 'radar' | 'shelter' | 'supplies' | 'armory';

/** What a building has to offer for the choice (CityBuilding has all of this). */
export interface PlaceBuilding {
  id: number;
  /** Counter-clockwise outline, flat [x0, y0, x1, y1, ...] in metres. */
  outer: readonly number[];
  height: number;
  kind: string;
  name?: string;
}

export interface Place {
  id: number;
  kind: PlaceKind;
  name: string;
  /** Which building it is, by position in the list the places were chosen from. */
  building: number;
  /** The door: a spot on open ground outside the building where you stand to use it. */
  x: number;
  y: number;
  /** A unit vector pointing out of the building at the door. */
  nx: number;
  ny: number;
  /** The building's footprint in square metres. */
  area: number;
}

export const PLACES = {
  /** How close to the door you must stand. */
  reach: 2.6,
  /** A building must have a wall at least this long to have a door in it. */
  minWall: 3.5,
} as const;

const ringArea = (ring: readonly number[]): number => {
  let a = 0;
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += ring[i * 2] * ring[j * 2 + 1] - ring[j * 2] * ring[i * 2 + 1];
  }
  return Math.abs(a) / 2;
};

interface Door {
  x: number;
  y: number;
  nx: number;
  ny: number;
}

/**
 * The best door for a building: the middle of a wall with open, reachable street in front of it. Of
 * the walls that qualify, the one with the most room in front wins (the first one, on a tie).
 */
export function findDoor(world: GameWorld, ring: readonly number[]): Door | null {
  const n = ring.length / 2;
  let best: Door | null = null;
  let bestRoom = -1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const dx = ring[j * 2] - ring[i * 2];
    const dy = ring[j * 2 + 1] - ring[i * 2 + 1];
    const len = Math.hypot(dx, dy);
    if (len < PLACES.minWall) continue;
    // outer rings run counter-clockwise, so the outside is on the right of each wall
    const nx = dy / len;
    const ny = -dx / len;
    const mx = (ring[i * 2] + ring[j * 2]) / 2;
    const my = (ring[i * 2 + 1] + ring[j * 2 + 1]) / 2;
    const x = mx + nx * 1.8;
    const y = my + ny * 1.8;
    if (!validSpot(world, x, y, 0.8)) continue;
    // room in front: how far you could walk straight out from the door before meeting something
    let room = 0;
    for (const out of [3, 6, 9, 12]) {
      const sx = mx + nx * out;
      const sy = my + ny * out;
      if (insideBuilding(world.colliders, sx, sy) || clearance(world.colliders, sx, sy, 3) < 1.2)
        break;
      room = out;
    }
    if (room > bestRoom) {
      bestRoom = room;
      best = { x, y, nx, ny };
    }
  }
  return best;
}

const GENERIC: Record<PlaceKind, Record<string, string>> = {
  radar: { _: 'Rooftop radar' },
  shelter: {
    apartments: 'Apartment block',
    civic: 'Civic building',
    religious: 'Place of worship',
    commercial: 'Shopping centre',
    industrial: 'Works',
    _: 'Large building',
  },
  supplies: { commercial: 'Shop', civic: 'Clinic', _: 'Store' },
  armory: { industrial: 'Warehouse', _: 'Depot' },
};

const nameFor = (kind: PlaceKind, b: PlaceBuilding): string =>
  b.name ?? GENERIC[kind][b.kind] ?? GENERIC[kind]._;

interface Candidate {
  index: number;
  building: PlaceBuilding;
  area: number;
  /** undefined until asked for; null if the building has no usable door. */
  door: Door | null | undefined;
}

/** How many of each to choose. */
const WANTED = { shelter: 4, supplies: 8 } as const;

/** How far from the start (metres, as the door is from it) each kind may be: lowest and highest. */
const WALK = {
  radar: [150, 450],
  radarFallback: [90, 650],
  shelterNear: [8, 180],
  shelterFar: [150, 520],
  armory: [200, 560],
  suppliesNear: [40, 130],
  suppliesMax: 520,
} as const;

/**
 * Choose the places for a map. `start` is where the survivor begins: the first shelter is close to
 * it, supplies are within a short walk, and the radar is far enough to be an expedition.
 */
export function choosePlaces(
  buildings: readonly PlaceBuilding[],
  start: readonly [number, number],
  world: GameWorld,
): Place[] {
  const candidates: Candidate[] = [];
  buildings.forEach((building, index) => {
    const area = ringArea(building.outer);
    if (area >= 60) candidates.push({ index, building, area, door: undefined });
  });
  const doorOf = (c: Candidate): Door | null => {
    if (c.door === undefined) c.door = findDoor(world, c.building.outer);
    return c.door;
  };

  const places: Place[] = [];
  const taken = new Set<number>();
  const fromStart = (d: Door): number => Math.hypot(d.x - start[0], d.y - start[1]);
  /** True when the door is at least `gap` metres from every place (of `kind`, if given) so far. */
  const apart = (d: Door, gap: number, kind?: PlaceKind): boolean =>
    places.every((p) => (kind && p.kind !== kind) || Math.hypot(p.x - d.x, p.y - d.y) >= gap);

  /** The highest-scoring building that passes both tests; `before` is cheap and runs without a door. */
  const best = (
    before: (c: Candidate) => boolean,
    after: (c: Candidate, d: Door) => boolean,
    score: (c: Candidate, d: Door) => number,
  ): [Candidate, Door] | null => {
    let found: [Candidate, Door] | null = null;
    let top = -Infinity;
    for (const c of candidates) {
      if (taken.has(c.index) || !before(c)) continue;
      const door = doorOf(c);
      if (!door || !after(c, door)) continue;
      const s = score(c, door);
      if (s > top) {
        top = s;
        found = [c, door];
      }
    }
    return found;
  };
  const add = (kind: PlaceKind, found: [Candidate, Door] | null): boolean => {
    if (!found) return false;
    const [c, door] = found;
    taken.add(c.index);
    places.push({
      id: places.length,
      kind,
      name: nameFor(kind, c.building),
      building: c.index,
      x: door.x,
      y: door.y,
      nx: door.nx,
      ny: door.ny,
      area: c.area,
    });
    return true;
  };
  const named = (c: Candidate): number => (c.building.name ? 1.4 : 1);
  const civic = (c: Candidate): number =>
    ['civic', 'religious'].includes(c.building.kind) ? 1.3 : 1;

  // the radar: the tallest building a few hundred metres off (the nearer ones come first as a fallback)
  const tall = (c: Candidate): number => c.building.height * 1000 + c.area;
  // Everything is within a walk of the start: the game lasts five minutes and the survivor walks
  // about 3 m/s, so a place a kilometre away is not a place, it is a different game.
  const within = (d: Door, [lo, hi]: readonly [number, number]): boolean =>
    fromStart(d) >= lo && fromStart(d) <= hi;
  add(
    'radar',
    best(
      (c) => c.building.height >= 15 && c.area >= 400,
      (_, d) => within(d, WALK.radar),
      tall,
    ) ??
      best(
        (c) => c.building.height >= 9 && c.area >= 300,
        (_, d) => within(d, WALK.radarFallback),
        tall,
      ),
  );

  // shelters: the first big, solid building near the start, the rest spread around it
  add(
    'shelter',
    best(
      (c) => c.area >= 500,
      (_, d) => within(d, WALK.shelterNear),
      (c, d) => (named(c) * civic(c) * Math.min(c.area, 4000)) / (50 + fromStart(d)),
    ),
  );

  // an armory: somewhere worth the trip. Chosen before the other shelters, which are easier to find.
  const industrial = (c: Candidate): boolean => c.building.kind === 'industrial';
  add(
    'armory',
    best(
      (c) => (industrial(c) || c.building.kind === 'commercial') && c.area >= 500,
      (_, d) => within(d, WALK.armory) && apart(d, 80),
      (c) => (industrial(c) ? 2 : 1) * c.area,
    ) ??
      best(
        (c) => c.area >= 1000,
        (_, d) => within(d, WALK.armory) && apart(d, 80),
        (c) => c.area,
      ),
  );

  while (places.filter((p) => p.kind === 'shelter').length < WANTED.shelter) {
    const found = best(
      (c) => c.area >= 700,
      (_, d) => within(d, WALK.shelterFar) && apart(d, 150, 'shelter') && apart(d, 60),
      (c, d) => (named(c) * civic(c) * Math.min(c.area, 6000)) / (200 + fromStart(d)),
    );
    if (!add('shelter', found)) break;
  }

  // supplies: one within a short walk of the start, then shops and clinics around it
  const shop = (c: Candidate): boolean => ['commercial', 'civic'].includes(c.building.kind);
  add(
    'supplies',
    best(
      (c) => shop(c) && c.area >= 100,
      (_, d) => within(d, WALK.suppliesNear) && apart(d, 30),
      (c) => c.area,
    ),
  );
  while (places.filter((p) => p.kind === 'supplies').length < WANTED.supplies) {
    const found = best(
      (c) => (shop(c) || !!c.building.name) && c.area >= 100,
      (_, d) => within(d, [0, WALK.suppliesMax]) && apart(d, 90),
      (c) => named(c) * c.area,
    );
    if (!add('supplies', found)) break;
  }
  return places;
}
