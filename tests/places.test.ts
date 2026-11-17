import { describe, expect, it } from 'vitest';
import { buildColliders, insideBuilding, type ColliderSource } from '../src/sim/colliders';
import { createGameWorld } from '../src/sim/game';
import { choosePlaces, findDoor, PLACES, type PlaceBuilding } from '../src/sim/places';
import { navCell } from '../src/sim/flow';
import { loadTashkent } from './helpers/tashkent';

/** A square building as a counter-clockwise outline. */
const box = (x: number, y: number, w: number, h = w): number[] => [
  x,
  y,
  x + w,
  y,
  x + w,
  y + h,
  x,
  y + h,
];

const building = (
  id: number,
  x: number,
  y: number,
  w: number,
  extra: Partial<PlaceBuilding> = {},
): PlaceBuilding => ({
  id,
  outer: box(x, y, w, extra.outer ? 0 : w),
  height: 10,
  kind: 'other',
  ...extra,
});

/** A map of open ground (half-size 700 m) with the given buildings in it. */
function mapOf(buildings: PlaceBuilding[], extra: Partial<ColliderSource> = {}) {
  const colliders = buildColliders({
    halfSize: 700,
    buildings,
    areas: [],
    waterways: [],
    roads: [],
    ...extra,
  });
  const world = createGameWorld(colliders, [0, 0], buildings);
  return { colliders, world, places: world.places };
}

describe('doors', () => {
  it('puts the door in the middle of a wall, on the outside, on ground you can stand on', () => {
    const b = [building(1, 100, 100, 30)];
    const { world, colliders } = mapOf(b);
    const door = findDoor(world, b[0].outer);
    expect(door).not.toBeNull();
    const { x, y, nx, ny } = door!;
    expect(insideBuilding(colliders, x, y)).toBe(false);
    expect(Math.hypot(nx, ny)).toBeCloseTo(1, 9);
    // 1.8 m out from the middle of a wall of the square
    const wallX = x - nx * 1.8;
    const wallY = y - ny * 1.8;
    const onWall =
      [100, 130].some((v) => Math.abs(wallX - v) < 1e-6) ||
      [100, 130].some((v) => Math.abs(wallY - v) < 1e-6);
    expect(onWall).toBe(true);
    // pointing out: a step further out is not inside
    expect(insideBuilding(colliders, x + nx * 3, y + ny * 3)).toBe(false);
    expect(insideBuilding(colliders, x - nx * 3, y - ny * 3)).toBe(true);
  });

  it('chooses the side with room in front of it', () => {
    // neighbours 3 m from the north, south and east walls leave only the west side open
    const b = [
      building(1, 100, 100, 30),
      building(2, 133, 100, 30),
      building(3, 100, 133, 30),
      building(4, 100, 67, 30),
    ];
    const { world } = mapOf(b);
    const door = findDoor(world, b[0].outer)!;
    expect(door.nx).toBeCloseTo(-1, 9); // faces west
    expect(door.ny).toBeCloseTo(0, 9);
  });

  it('finds nothing for a building with no wall long enough, or one boxed in', () => {
    const tiny = [building(1, 100, 100, 3)];
    expect(findDoor(mapOf(tiny).world, tiny[0].outer)).toBeNull();
  });
});

describe('choosing places', () => {
  it('makes a radar of the tallest big building a few hundred metres away', () => {
    const { places } = mapOf([
      building(1, 250, 0, 40, { height: 30 }),
      building(2, 0, 300, 40, { height: 22 }),
      building(3, 500, 500, 40, { height: 60 }), // taller, but out of walking range
      building(4, 20, 20, 40, { height: 40 }), // taller, but too close to be an expedition
    ]);
    const radar = places.filter((p) => p.kind === 'radar');
    expect(radar).toHaveLength(1);
    expect(radar[0].building).toBe(0);
  });

  it('has no radar when nothing qualifies', () => {
    const { places } = mapOf([building(1, 250, 0, 40, { height: 4 })]);
    expect(places.filter((p) => p.kind === 'radar')).toHaveLength(0);
  });

  it('puts the first shelter close, the others apart, and never reuses a building', () => {
    const b: PlaceBuilding[] = [
      building(1, 40, 0, 40, { name: 'Close hall' }),
      building(2, 300, 0, 40),
      building(3, 310, 20, 40),
      building(4, 0, -320, 40, { kind: 'civic' }),
      building(5, -300, 0, 40),
      building(6, 0, 330, 40),
    ];
    const { places } = mapOf(b);
    const shelters = places.filter((p) => p.kind === 'shelter');
    expect(shelters.length).toBeGreaterThanOrEqual(3);
    expect(shelters[0].name).toBe('Close hall');
    for (let i = 1; i < shelters.length; i++) {
      for (let j = 0; j < i; j++) {
        expect(
          Math.hypot(shelters[i].x - shelters[j].x, shelters[i].y - shelters[j].y),
        ).toBeGreaterThanOrEqual(150);
      }
    }
    expect(new Set(places.map((p) => p.building)).size).toBe(places.length);
  });

  it('names a place after its building, or else by what it is', () => {
    const buildings = [
      building(1, 200, 0, 30, { name: 'Baraka Savdo', kind: 'commercial', height: 5 }),
      building(2, 0, 120, 30, { kind: 'commercial', height: 5 }),
      building(3, -250, 0, 30, { kind: 'apartments', height: 5 }),
    ];
    const { places } = mapOf(buildings);
    expect(places.length).toBeGreaterThanOrEqual(2);
    for (const p of places) {
      const b = buildings[p.building];
      if (b.name) expect(p.name).toBe(b.name);
      else expect(p.name).not.toBe('');
    }
    expect(places.some((p) => p.name === 'Baraka Savdo')).toBe(true);
    // a nameless one is called after its kind, not left blank or called undefined
    const generic = places.filter((p) => !buildings[p.building].name).map((p) => p.name);
    expect(generic.length).toBeGreaterThan(0);
    for (const name of generic) expect(name).toMatch(/^[A-Z][a-z]+( [a-z]+)*$/);
  });

  it('ignores specks and gives every place a door that works', () => {
    const b: PlaceBuilding[] = [
      building(1, 60, 0, 6, { kind: 'commercial' }), // 36 m2: too small
      building(2, 150, 0, 25, { kind: 'commercial' }),
      building(3, -150, 0, 30, { kind: 'commercial', name: 'Clinic 5' }),
    ];
    const { places, colliders, world } = mapOf(b);
    expect(places.some((p) => p.building === 0)).toBe(false);
    for (const p of places) {
      expect(insideBuilding(colliders, p.x, p.y)).toBe(false);
      expect(
        world.reachable[navCell(world.nav, p.y) * world.nav.size + navCell(world.nav, p.x)],
      ).toBe(1);
      expect(PLACES.reach).toBeGreaterThan(1.8); // you can reach the door from where you stand to use it
    }
  });

  it('gives the same places every time', () => {
    const b: PlaceBuilding[] = [];
    for (let i = 0; i < 30; i++) {
      b.push(
        building(i, ((i * 97) % 600) - 300, ((i * 53) % 600) - 300, 25 + (i % 4) * 8, {
          height: 8 + (i % 7) * 4,
        }),
      );
    }
    const a = mapOf(b).places;
    const c = mapOf(b).places;
    expect(a).toEqual(c);
  });

  it('makes none from no buildings', () => {
    expect(mapOf([]).places).toEqual([]);
  });

  it('can be called with nothing to choose from', () => {
    const { world } = mapOf([]);
    expect(choosePlaces([], [0, 0], world)).toEqual([]);
  });
});

describe('the real Tashkent', () => {
  const t = loadTashkent();
  const world = createGameWorld(t.colliders, t.spawn, t.city.buildings);
  const of = (kind: string) => world.places.filter((p) => p.kind === kind);
  const fromStart = (p: { x: number; y: number }): number =>
    Math.hypot(p.x - t.spawn[0], p.y - t.spawn[1]);

  it('has a radar, shelters, an armory and supplies, all within a walk', () => {
    expect(of('radar')).toHaveLength(1);
    expect(of('shelter').length).toBeGreaterThanOrEqual(3);
    expect(of('armory')).toHaveLength(1);
    expect(of('supplies').length).toBeGreaterThanOrEqual(4);
    for (const p of world.places) expect(fromStart(p)).toBeLessThan(650);
  });

  it('has a shelter close to the start, so there is somewhere to run to', () => {
    expect(Math.min(...of('shelter').map(fromStart))).toBeLessThan(180);
  });

  it('puts every door on open, reachable ground, outside every building', () => {
    for (const p of world.places) {
      expect(t.insideBuilding(p.x, p.y)).toBe(false);
      expect(t.insideBuilding(p.x - p.nx * 3, p.y - p.ny * 3)).toBe(true); // the building is behind the door
      expect(
        world.reachable[navCell(world.nav, p.y) * world.nav.size + navCell(world.nav, p.x)],
      ).toBe(1);
    }
  });

  it('is the same every time, and quick to work out', () => {
    const again = createGameWorld(t.colliders, t.spawn, t.city.buildings);
    expect(again.places).toEqual(world.places);
  });
});
