// A small town on open ground for tests of the people and the outbreak: a few buildings, a crowd of a
// few hundred (not a real city's thousands, so the tests run quickly), and a game in it.

import { buildColliders } from '../../src/sim/colliders';
import {
  createGame,
  createGameWorld,
  drainEvents,
  NO_INPUT,
  stepGame,
  type GameEvent,
  type GameInput,
  type GameOptions,
} from '../../src/sim/game';
import { HState } from '../../src/sim/humans';
import type { PlaceBuilding } from '../../src/sim/places';

export const DT = 1 / 60;

export const box = (x: number, y: number, w: number, h = w): number[] => [
  x,
  y,
  x + w,
  y,
  x + w,
  y + h,
  x,
  y + h,
];

/** Send everyone out in the street indoors-and-gone, so that a test about doors is about doors. */
export function emptyStreets(g: ReturnType<typeof createGame>): void {
  const h = g.humans;
  h.state.fill(HState.FREE);
  h.used = 0;
  h.alive = 0;
  h.freeCount = 0;
}

/**
 * A town of the given buildings on open ground, with its people and no outbreak unless asked for. By
 * default the day stands still and nobody comes or goes, so that a test is about one thing; pass
 * `cycle: true` and `routine: true` for the real thing.
 */
export function town(buildings: PlaceBuilding[], options: Partial<GameOptions> = {}, half = 800) {
  const colliders = buildColliders({
    halfSize: half,
    buildings: buildings.map((b) => ({ outer: b.outer })),
    areas: [],
    waterways: [],
    roads: [],
  });
  const world = createGameWorld(colliders, [0, 0], buildings);
  const g = createGame(world, {
    seed: 1,
    startX: 0,
    startY: 0,
    clumps: 0,
    patients: 0,
    density: 250,
    cycle: false,
    routine: false,
    ...options,
  });
  const events: GameEvent[] = [];
  const run = (seconds: number, input: Partial<GameInput> = {}): void => {
    for (let s = 0; s < Math.round(seconds / DT); s++) {
      stepGame(g, { ...NO_INPUT, ...input }, world, DT);
      events.push(...drainEvents(g));
    }
  };
  return { g, world, colliders, events, run };
}

export const house = (id: number, x: number, y: number, w = 20, height = 6): PlaceBuilding => ({
  id,
  outer: box(x, y, w),
  height,
  kind: 'house',
});

/** Twelve blocks spread over the map, some near the start and most far from it. */
export const NEIGHBOURHOOD: PlaceBuilding[] = Array.from({ length: 12 }, (_, i) => ({
  id: i + 1,
  outer: box(((i % 4) - 2) * 300 + 20, (Math.floor(i / 4) - 1) * 300 + 20, 30),
  height: 18,
  kind: 'apartments',
}));
