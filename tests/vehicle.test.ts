import { describe, expect, it } from 'vitest';
import { buildColliders, insideBuilding } from '../src/sim/colliders';
import {
  createGame,
  createGameWorld,
  drainEvents,
  interactionAt,
  NO_INPUT,
  stepGame,
  type GameEvent,
  type GameOptions,
  type GameState,
  type GameWorld,
} from '../src/sim/game';
import { spawnZombie, ZKind, ZState } from '../src/sim/horde';
import type { PlaceBuilding } from '../src/sim/places';
import { PLAYER } from '../src/sim/player';
import { loadGame, saveGame } from '../src/sim/save';
import { CAR, onRoad, parkCars, stepCar, type Car } from '../src/sim/vehicle';
import { validSpot } from '../src/sim/world';
import { migrateGame, shiftGame, type Ledger } from '../src/sim/window';
import { box, DT, house, town } from './helpers/town';
import { loadCityById } from './helpers/tashkent';
import { createRng } from '../src/lib/rng';

/** A straight road, 8 m wide, along y = `y` from x0 to x1. */
const road = (x0: number, x1: number, y = 0, width = 8) => ({ points: [x0, y, x1, y], width });

/** A few houses off the road, well clear of the car's way. */
const HOUSES: PlaceBuilding[] = [
  house(1, -300, 60),
  house(2, -100, 60),
  house(3, 100, 60),
  house(4, 300, 60),
  house(5, -200, -90),
  house(6, 200, -90),
];

const QUIET: Partial<GameOptions> = { population: false, patients: 0, clumps: 0 };

/** Hold the pedal (`throttle`: W is 1, S is -1) and the wheel (`steer`: A is 1, D is -1) for a while. */
function drive(
  g: GameState,
  world: GameWorld,
  seconds: number,
  throttle: number,
  steer: number,
  events?: GameEvent[],
): void {
  for (let s = 0; s < Math.round(seconds / DT); s++) {
    stepGame(g, { ...NO_INPUT, throttle, steer }, world, DT);
    const got = drainEvents(g);
    if (events) events.push(...got);
  }
}

/** Walk (on foot) in a direction for a while. */
function walk(g: GameState, world: GameWorld, seconds: number, moveX: number, moveY: number): void {
  for (let s = 0; s < Math.round(seconds / DT); s++) {
    stepGame(g, { ...NO_INPUT, moveX, moveY }, world, DT);
    drainEvents(g);
  }
}

/** Stand the survivor at a car's door and press F. */
function getIn(g: GameState, world: GameWorld, car: number): GameEvent[] {
  const c = g.cars[car];
  g.player = { ...g.player, x: c.x, y: c.y + CAR.radius + 1, vx: 0, vy: 0 };
  stepGame(g, { ...NO_INPUT, interact: true }, world, DT);
  return drainEvents(g);
}

describe('cars parked in the streets', () => {
  it('stand along the roads, apart from each other, on open ground, pointing along the road', () => {
    const { g, world, colliders } = town(HOUSES, QUIET, 800, [
      road(-700, 700),
      road(-700, 700, -400),
    ]);
    expect(g.cars.length).toBeGreaterThan(6);
    for (const car of g.cars) {
      expect(onRoad(colliders, car.x, car.y)).toBe(true);
      expect(insideBuilding(colliders, car.x, car.y)).toBe(false);
      expect(validSpot(world, car.x, car.y, CAR.radius)).toBe(true);
      expect(car.fuel).toBeGreaterThanOrEqual(CAR.fuelFound[0]);
      expect(car.fuel).toBeLessThanOrEqual(CAR.fuelFound[1]);
      expect(car.hp).toBe(CAR.hp);
      // along the road (east or west), on its right-hand side
      expect(Math.abs(Math.sin(car.heading))).toBeLessThan(1e-6);
      const roadY = Math.abs(car.y) < 200 ? 0 : -400;
      expect(Math.abs(Math.abs(car.y - roadY) - (4 - 1.5))).toBeLessThan(1e-6);
    }
    for (let i = 0; i < g.cars.length; i++) {
      for (let j = i + 1; j < g.cars.length; j++) {
        const d = Math.hypot(g.cars[i].x - g.cars[j].x, g.cars[i].y - g.cars[j].y);
        expect(d).toBeGreaterThanOrEqual(CAR.parkGap);
      }
    }
    expect(g.driving).toBe(-1);
  });

  it('are not found where there are no roads, and not on footpaths', () => {
    expect(town(HOUSES, QUIET).g.cars).toHaveLength(0);
    expect(town(HOUSES, QUIET, 800, [road(-700, 700, 0, 2)]).g.cars).toHaveLength(0);
  });

  it('are the same for the same seed, and others for another', () => {
    const a = town(HOUSES, { ...QUIET, seed: 5 }, 800, [road(-700, 700)]).g.cars;
    const b = town(HOUSES, { ...QUIET, seed: 5 }, 800, [road(-700, 700)]).g.cars;
    const c = town(HOUSES, { ...QUIET, seed: 6 }, 800, [road(-700, 700)]).g.cars;
    expect(b).toEqual(a);
    expect(c).not.toEqual(a);
  });

  it('are never more than the most, and keep off ground they are told to', () => {
    const { world } = town(HOUSES, QUIET, 800, [road(-700, 700), road(-700, 700, -400)]);
    const few = parkCars(world, createRng(1), 3);
    expect(few).toHaveLength(3);
    const east = parkCars(world, createRng(1), 60, (x) => x < 0);
    expect(east.length).toBeGreaterThan(0);
    for (const car of east) expect(car.x).toBeGreaterThanOrEqual(0);
  });

  it('stand in the streets of a real city, on its roads and in nobody’s house', () => {
    const t = loadCityById('tashkent');
    const world = createGameWorld(t.colliders, t.spawn, t.city.buildings, t.city.roads);
    const cars = parkCars(world, createRng(3));
    expect(cars.length).toBeGreaterThanOrEqual(20);
    for (const car of cars) {
      expect(onRoad(t.colliders, car.x, car.y)).toBe(true);
      expect(t.insideBuilding(car.x, car.y)).toBe(false);
    }
  });
});

describe('at the wheel', () => {
  it('you get in at the door, ride along at a speed no one on foot has, and the prompt says so', () => {
    const { g, world } = town(HOUSES, QUIET, 800, [road(-700, 700)]);
    const car = g.cars.findIndex((c) => Math.cos(c.heading) > 0 && c.x < 300); // one pointing east with road ahead
    expect(car).toBeGreaterThanOrEqual(0);
    // too far away: nothing to do
    g.player = { ...g.player, x: g.cars[car].x, y: g.cars[car].y + 8 };
    expect(interactionAt(g, world)).toBeNull();
    g.player = { ...g.player, y: g.cars[car].y + CAR.radius + 1 };
    const here = interactionAt(g, world);
    expect(here?.kind).toBe('car');
    expect(here?.label).toBe('Get in');

    const events = getIn(g, world, car);
    expect(g.driving).toBe(car);
    expect(events.some((e) => e.type === 'car' && e.what === 'enter')).toBe(true);
    expect(interactionAt(g, world)?.label).toBe('Get out');

    const start = g.cars[car].x;
    drive(g, world, 5, 1, 0);
    const c = g.cars[car];
    expect(c.x - start).toBeGreaterThan(60);
    expect(c.speed).toBeGreaterThan(PLAYER.sprintSpeed * 1.5);
    expect(c.speed).toBeLessThanOrEqual(CAR.topRoad + 1e-6);
    // the survivor is in it
    expect(g.player.x).toBe(c.x);
    expect(g.player.y).toBe(c.y);
    expect(Math.hypot(g.player.vx, g.player.vy)).toBeCloseTo(c.speed, 6);
    expect(c.fuel).toBeLessThan(CAR.fuelFound[1]);
  });

  it('is far slower off the road, and cannot be turned standing still', () => {
    const { g, world } = town(HOUSES, QUIET, 800, [road(-700, 700)]);
    g.cars.push({ x: -300, y: -250, heading: 0, speed: 0, fuel: 1, hp: CAR.hp }); // on the grass
    const car = g.cars.length - 1;
    getIn(g, world, car);
    const heading = g.cars[car].heading;
    drive(g, world, 2, 0, 1); // the wheel alone, no pedal: it neither moves nor turns
    expect(g.cars[car].speed).toBe(0);
    expect(g.cars[car].heading).toBe(heading);
    drive(g, world, 8, 1, 0);
    expect(g.cars[car].speed).toBeGreaterThan(PLAYER.walkSpeed);
    expect(g.cars[car].speed).toBeLessThanOrEqual(CAR.topOff + 1e-6);
  });

  it('steers left with A and right with D while rolling, and S brakes, then backs up', () => {
    const { g, world } = town(HOUSES, QUIET, 800, [road(-700, 700)]);
    g.cars.push({ x: -400, y: 0, heading: 0, speed: 0, fuel: 1, hp: CAR.hp });
    const car = g.cars.length - 1;
    getIn(g, world, car);
    const c = g.cars[car];
    drive(g, world, 2, 1, 1); // W and A: forward, turning left (counter-clockwise, toward north)
    expect(c.heading).toBeGreaterThan(0.4);
    expect(c.y).toBeGreaterThan(1);
    expect(c.speed).toBeGreaterThan(0);
    const left = c.heading;
    drive(g, world, 2, 1, -1); // W and D: back round to the right
    expect(c.heading).toBeLessThan(left);
    // S: the brakes, then reverse
    drive(g, world, 1, -1, 0);
    expect(c.speed).toBeLessThanOrEqual(0);
    drive(g, world, 3, -1, 0);
    expect(c.speed).toBeLessThan(-1);
    expect(c.speed).toBeGreaterThanOrEqual(-CAR.reverse - 1e-6);
    // backing up with the wheel turned swings the nose the other way, as in a real car
    const h = c.heading;
    drive(g, world, 1, -1, 1);
    expect(c.heading).toBeLessThan(h);
  });

  it('is stopped by a wall, never crosses one, and a hard crash costs the car and the driver', () => {
    const wall: PlaceBuilding[] = [house(1, 60, -15, 30), ...HOUSES.slice(4)];
    const { g, world, colliders } = town(wall, QUIET, 800, [road(-700, 60)]);
    g.cars.push({ x: -150, y: 0, heading: 0, speed: 0, fuel: 1, hp: CAR.hp });
    const car = g.cars.length - 1;
    getIn(g, world, car);
    const events: GameEvent[] = [];
    let top = 0;
    for (let s = 0; s < 60 * 12; s++) {
      stepGame(g, { ...NO_INPUT, throttle: 1 }, world, DT);
      events.push(...drainEvents(g));
      const c = g.cars[car];
      top = Math.max(top, c.speed);
      expect(insideBuilding(colliders, c.x, c.y)).toBe(false);
      expect(c.x).toBeLessThanOrEqual(60 - CAR.radius + 0.05);
    }
    expect(top).toBeGreaterThan(CAR.hurtSpeed);
    const crash = events.find((e) => e.type === 'car' && e.what === 'crash');
    expect(crash).toBeDefined();
    expect(crash && crash.type === 'car' && crash.force).toBeGreaterThan(CAR.hurtSpeed);
    expect(g.cars[car].hp).toBeLessThan(CAR.hp);
    expect(g.health).toBeLessThan(100);
    expect(g.stats.damageTaken).toBeGreaterThan(0);
    // a loud bang: a noise the horde can hear
    expect(events.some((e) => e.type === 'noise' && e.radius === CAR.crashNoise)).toBe(true);
  });

  it('runs down whoever is in the road, and the car takes a knock for each', () => {
    const { g, world } = town(HOUSES, QUIET, 800, [road(-700, 700)]);
    g.cars.push({ x: -300, y: 0, heading: 0, speed: 0, fuel: 1, hp: CAR.hp });
    const car = g.cars.length - 1;
    getIn(g, world, car);
    for (let k = 0; k < 6; k++)
      spawnZombie(g.horde, -150 + k * 3, (k % 3) - 1, ZKind.WALKER, ZState.WANDER);
    const events: GameEvent[] = [];
    drive(g, world, 12, 1, 0, events);
    expect(g.stats.kills).toBeGreaterThanOrEqual(3);
    expect(events.some((e) => e.type === 'hit' && e.kill)).toBe(true);
    expect(g.cars[car].hp).toBeLessThan(CAR.hp);
    expect(g.cars[car].x).toBeGreaterThan(-100); // it drove on through
    expect(g.health).toBe(100); // nobody laid a hand on the driver
  });

  it('takes most of a blow for you, until it is wrecked', () => {
    const { g, world } = town(HOUSES, QUIET, 800, [road(-700, 700)]);
    g.cars.push({ x: -300, y: 0, heading: 0, speed: 0, fuel: 1, hp: CAR.hp });
    const car = g.cars.length - 1;
    getIn(g, world, car);
    for (let k = 0; k < 2; k++) {
      const a = (k / 2) * Math.PI * 2;
      spawnZombie(g.horde, -300 + Math.cos(a) * 1.6, Math.sin(a) * 1.6, ZKind.WALKER, ZState.CHASE);
    }
    drive(g, world, 4, 0, 0);
    const worn = CAR.hp - g.cars[car].hp;
    expect(worn).toBeGreaterThan(0);
    expect(worn).toBeLessThan(CAR.hp);
    expect(g.stats.damageTaken).toBeGreaterThan(0);
    expect(worn).toBeGreaterThan(g.stats.damageTaken * 2);
    // once wrecked, everything lands on you
    g.cars[car].hp = 0;
    const before = g.stats.damageTaken;
    drive(g, world, 6, 0, 0);
    expect(g.stats.damageTaken - before).toBeGreaterThan(20);
    drive(g, world, 3, 1, 0);
    expect(g.cars[car].speed).toBe(0); // and it will not go
  });

  it('runs out of fuel, and an empty car goes nowhere', () => {
    const { g, world } = town(HOUSES, QUIET, 800, [road(-700, 700)]);
    g.cars.push({ x: -300, y: 0, heading: 0, speed: 0, fuel: 0.004, hp: CAR.hp });
    const car = g.cars.length - 1;
    getIn(g, world, car);
    const events: GameEvent[] = [];
    drive(g, world, 10, 1, 0, events);
    expect(g.cars[car].fuel).toBe(0);
    expect(events.filter((e) => e.type === 'car' && e.what === 'fuel')).toHaveLength(1);
    expect(g.cars[car].speed).toBe(0);
    expect(interactionAt(g, world)?.name).toBe('Out of fuel');
    const x = g.cars[car].x;
    drive(g, world, 2, 1, 0);
    expect(g.cars[car].x).toBe(x);
  });

  it('is loud: the engine is a noise the horde hears, louder the faster you go', () => {
    const { g, world } = town(HOUSES, QUIET, 800, [road(-700, 700)]);
    g.cars.push({ x: -300, y: 0, heading: 0, speed: 0, fuel: 1, hp: CAR.hp });
    getIn(g, world, g.cars.length - 1);
    drive(g, world, 0.5, 1, 0);
    const slow = Math.max(...g.noises.map((n) => n.radius));
    expect(slow).toBeGreaterThanOrEqual(CAR.noiseIdle);
    drive(g, world, 6, 1, 0);
    const fast = Math.max(...g.noises.map((n) => n.radius));
    expect(fast).toBeGreaterThan(slow);
    expect(fast).toBeGreaterThan(CAR.noiseTop * 0.8);
  });

  it('lets you out beside it, on open ground, and stays where you left it', () => {
    const { g, world } = town(HOUSES, QUIET, 800, [road(-700, 700)]);
    g.cars.push({ x: -300, y: 0, heading: 0, speed: 0, fuel: 1, hp: CAR.hp });
    const car = g.cars.length - 1;
    getIn(g, world, car);
    drive(g, world, 3, 1, 0);
    expect(g.cars[car].speed).toBeGreaterThan(0); // still rolling: getting out stops it
    stepGame(g, { ...NO_INPUT, interact: true }, world, DT);
    const events = drainEvents(g);
    expect(g.driving).toBe(-1);
    expect(events.some((e) => e.type === 'car' && e.what === 'exit')).toBe(true);
    const c = { ...g.cars[car] };
    expect(c.speed).toBe(0);
    const d = Math.hypot(g.player.x - c.x, g.player.y - c.y);
    expect(d).toBeGreaterThan(CAR.width / 2);
    expect(d).toBeLessThan(CAR.length);
    expect(validSpot(world, g.player.x, g.player.y, PLAYER.radius)).toBe(true);
    // on foot again: walking works, and the car is still there to get back into
    walk(g, world, 2, 0, 1);
    expect(g.player.y).toBeGreaterThan(c.y + 4);
    expect(g.cars[car]).toEqual(c);
  });

  it('plays out the same from a save, with the cars and the wheel as they were', () => {
    const { g, world } = town(HOUSES, { ...QUIET, population: true, clumps: 4 }, 800, [
      road(-700, 700),
    ]);
    g.cars.push({ x: -300, y: 0, heading: 0, speed: 0, fuel: 0.6, hp: 70 });
    const car = g.cars.length - 1;
    getIn(g, world, car);
    drive(g, world, 3, 1, 0.2);
    const saved = saveGame(g, {
      seed: 1,
      startX: 0,
      startY: 0,
      ...QUIET,
      population: true,
      clumps: 4,
    });
    const copy = loadGame(world, JSON.parse(JSON.stringify(saved)) as typeof saved);
    expect(copy.driving).toBe(car);
    expect(copy.cars).toEqual(g.cars);
    drive(g, world, 4, 0.8, -0.4);
    drive(copy, world, 4, 0.8, -0.4);
    expect(copy.cars[car]).toEqual(g.cars[car]);
    expect(copy.player).toEqual(g.player);
  });

  it('loads a game saved before there were cars, parked as a new game would be', () => {
    const { g, world } = town(HOUSES, QUIET, 800, [road(-700, 700)]);
    const saved = saveGame(g, { seed: 1, startX: 0, startY: 0, ...QUIET });
    delete saved.game.cars;
    delete saved.game.driving;
    const old = loadGame(world, saved);
    expect(old.cars.length).toBe(g.cars.length);
    expect(old.driving).toBe(-1);
  });
});

describe('cars and the window of a big city', () => {
  const BLOCKS: PlaceBuilding[] = Array.from({ length: 6 }, (_, i) => ({
    id: 100 + i,
    outer: box((i - 2) * 400 + 20, 80, 30),
    height: 18,
    kind: 'apartments',
  }));
  /** A window `half` around `origin`, with a long east-west road through the whole city. */
  function windowWorld(origin: [number, number], half: number): GameWorld {
    const buildings = BLOCKS.filter(
      (b) =>
        Math.abs(b.outer[0] + 15 - origin[0]) <= half &&
        Math.abs(b.outer[1] + 15 - origin[1]) <= half,
    ).map((b) => ({
      ...b,
      outer: b.outer.map((v, k) => v - (k % 2 === 0 ? origin[0] : origin[1])),
    }));
    const roads = [road(-3000 - origin[0], 3000 - origin[0], -origin[1])];
    const colliders = buildColliders({
      halfSize: half,
      buildings: buildings.map((b) => ({ outer: b.outer })),
      areas: [],
      waterways: [],
      roads,
    });
    return createGameWorld(colliders, [0, 0], buildings, roads);
  }
  const OPTIONS: GameOptions = { seed: 4, startX: 0, startY: 0, ...QUIET };

  it('moves them with everything else', () => {
    const a = windowWorld([0, 0], 800);
    const g = createGame(a, OPTIONS);
    const before: Car[] = g.cars.map((c) => ({ ...c }));
    shiftGame(g, -400, 30);
    g.cars.forEach((c, i) => {
      expect(c.x).toBeCloseTo(before[i].x - 400, 6);
      expect(c.y).toBeCloseTo(before[i].y + 30, 6);
      expect(c.heading).toBe(before[i].heading);
    });
  });

  it('carries the cars the next window holds, the one you drive first of all, and parks new ones only on new ground', () => {
    const a = windowWorld([0, 0], 800);
    const ga = createGame(a, OPTIONS);
    ga.cars.push({ x: 350, y: 0, heading: 0, speed: 0, fuel: 0.5, hp: 80 });
    const mine = ga.cars.length - 1;
    getIn(ga, a, mine);
    drive(ga, a, 2, 1, 0);
    const carsBefore = ga.cars.map((c) => ({ ...c }));
    const driven = { ...ga.cars[mine] };

    const b = windowWorld([400, 0], 800);
    const ledger: Ledger = new Map();
    const gb = migrateGame(ga, a, b, OPTIONS, [-400, 0], ledger);
    // the car I am in came along, under me
    expect(gb.driving).toBeGreaterThanOrEqual(0);
    const now = gb.cars[gb.driving];
    expect(now.x).toBeCloseTo(driven.x - 400, 6);
    expect(now.fuel).toBe(driven.fuel);
    expect(now.hp).toBe(80);
    expect(gb.player.x).toBe(now.x);
    // every old car the new window holds is there, where it was; none the window does not hold
    const inside = carsBefore.filter((c) => Math.abs(c.x - 400) <= 800 - 6);
    for (const c of inside) {
      expect(gb.cars.some((d) => Math.abs(d.x - (c.x - 400)) < 1e-6 && d.y === c.y)).toBe(true);
    }
    for (const c of gb.cars) expect(Math.abs(c.x)).toBeLessThanOrEqual(800);
    // the new ones stand east of the old window's edge, which was at x = 800 (now 400)
    const fresh = gb.cars.filter((d) => !inside.some((c) => Math.abs(d.x - (c.x - 400)) < 1e-6));
    expect(fresh.length).toBeGreaterThan(0);
    for (const c of fresh) expect(c.x).toBeGreaterThan(400);
    expect(gb.cars.length).toBeLessThanOrEqual(CAR.parkMost);
    // and it drives on
    const wasAt = now.x;
    drive(gb, b, 3, 1, 0);
    expect(gb.cars[gb.driving].x).toBeGreaterThan(wasAt + 20);
  });
});

describe('the car on its own', () => {
  it('a step with nothing pressed leaves a standing car exactly where it is', () => {
    const colliders = buildColliders({
      halfSize: 200,
      buildings: [],
      areas: [],
      waterways: [],
      roads: [],
    });
    const car: Car = { x: 1, y: 2, heading: 0.3, speed: 0, fuel: 1, hp: CAR.hp };
    const r = stepCar(car, { throttle: 0, steer: 0 }, colliders, DT);
    expect(car).toEqual({ x: 1, y: 2, heading: 0.3, speed: 0, fuel: 1, hp: CAR.hp });
    expect(r).toEqual({ crash: 0, running: false });
  });
});
