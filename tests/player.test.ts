import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LAMP_STRIDE, placeLamps } from '../src/city/lamps';
import { buildOccupancy } from '../src/city/occupancy';
import { TREE_STRIDE, placeTrees } from '../src/city/trees';
import type { CityData } from '../src/city/types';
import { hash01 } from '../src/lib/hash';
import { buildColliders, findSpawn, inWater } from '../src/sim/colliders';
import { pointInFlatRing } from '../src/sim/grid';
import {
  PLAYER,
  angleDelta,
  createPlayer,
  speedOf,
  stepPlayer,
  type PlayerInput,
  type PlayerState,
} from '../src/sim/player';

const DT = 1 / 60;
const open = buildColliders({ halfSize: 500, buildings: [], areas: [], waterways: [], roads: [] });
const walls = buildColliders({
  halfSize: 500,
  buildings: [{ outer: [-50, 20, 50, 20, 50, 30, -50, 30] }], // a long wall to the north
  areas: [],
  waterways: [],
  roads: [],
});

const run = (start: PlayerState, input: PlayerInput, seconds: number, w = open): PlayerState => {
  let p = start;
  for (let i = 0; i < Math.round(seconds / DT); i++) p = stepPlayer(p, input, w, DT);
  return p;
};
const idle: PlayerInput = { moveX: 0, moveY: 0, sprint: false };
const east: PlayerInput = { moveX: 1, moveY: 0, sprint: false };

describe('aiming and being held back', () => {
  it('faces the aim direction even when walking another way', () => {
    const p = run(createPlayer(0, 0), { ...east, face: Math.PI / 2 }, 1); // walks east, faces north
    expect(angleDelta(p.heading, Math.PI / 2)).toBeCloseTo(0, 6);
    expect(p.x).toBeGreaterThan(2.5);
  });

  it('turns to face a target quickly, but not instantly', () => {
    const p = stepPlayer(createPlayer(0, 0, 0), { ...idle, face: Math.PI }, open, DT);
    expect(p.heading).toBeCloseTo(PLAYER.aimTurnRate * DT, 9);
    const done = run(createPlayer(0, 0, 0), { ...idle, face: Math.PI }, 0.2);
    expect(angleDelta(done.heading, Math.PI)).toBeCloseTo(0, 6);
  });

  it('keeps turning with the walk when there is no aim, as before', () => {
    const none = run(createPlayer(0, 0, 0), { ...east, face: null }, 0.5);
    const unset = run(createPlayer(0, 0, 0), east, 0.5);
    expect(none).toEqual(unset);
  });

  it('is slowed by a multiplier on top speed, for walking and sprinting', () => {
    const walk = run(createPlayer(0, 0), { ...east, slow: 0.5 }, 1);
    expect(speedOf(walk)).toBeCloseTo(PLAYER.walkSpeed * 0.5, 6);
    const sprint = run(createPlayer(0, 0), { ...east, sprint: true, slow: 0.5 }, 1);
    expect(speedOf(sprint)).toBeCloseTo(PLAYER.sprintSpeed * 0.5, 6);
    const normal = run(createPlayer(0, 0), { ...east, slow: 1 }, 1);
    expect(normal).toEqual(run(createPlayer(0, 0), east, 1));
  });
});

describe('walking', () => {
  it('speeds up to walking pace and no faster', () => {
    const p = run(createPlayer(0, 0), east, 1);
    expect(speedOf(p)).toBeCloseTo(PLAYER.walkSpeed, 6);
    expect(p.x).toBeGreaterThan(2.5);
    expect(p.x).toBeLessThan(3.3);
  });

  it('builds speed over a moment rather than instantly', () => {
    const p = stepPlayer(createPlayer(0, 0), east, open, DT);
    expect(speedOf(p)).toBeCloseTo(PLAYER.accel * DT, 9);
    expect(speedOf(p)).toBeLessThan(PLAYER.walkSpeed);
  });

  it('stops within a fraction of a second when you let go', () => {
    const moving = run(createPlayer(0, 0), east, 1);
    const stopped = run(moving, idle, 0.2);
    expect(speedOf(stopped)).toBe(0);
    expect(stopped.x - moving.x).toBeLessThan(0.5);
  });

  it('is no faster diagonally', () => {
    const p = run(createPlayer(0, 0), { moveX: 1, moveY: 1, sprint: false }, 1);
    expect(speedOf(p)).toBeCloseTo(PLAYER.walkSpeed, 6);
  });

  it('ignores a tiny stick or key value', () => {
    const p = run(createPlayer(0, 0), { moveX: 0.01, moveY: 0, sprint: false }, 0.5);
    expect(p.x).toBe(0);
  });

  it('counts the distance walked for the walk animation', () => {
    const p = run(createPlayer(0, 0), east, 2);
    expect(p.travelled).toBeCloseTo(p.x, 6);
  });
});

describe('facing', () => {
  it('turns to face the way it is going', () => {
    const p = run(createPlayer(0, 0, 0), { moveX: 0, moveY: 1, sprint: false }, 1);
    expect(p.heading).toBeCloseTo(Math.PI / 2, 6);
  });

  it('turns the short way round and no faster than the turn rate', () => {
    const start = createPlayer(0, 0, Math.PI - 0.1);
    const next = stepPlayer(
      { ...start, vx: -3, vy: -0.3 },
      { moveX: -1, moveY: -1, sprint: false },
      open,
      DT,
    );
    expect(Math.abs(angleDelta(start.heading, next.heading))).toBeLessThanOrEqual(
      PLAYER.turnRate * DT + 1e-9,
    );
  });

  it('keeps its heading when standing still', () => {
    const p = run(createPlayer(0, 0, 1.2), idle, 1);
    expect(p.heading).toBe(1.2);
  });

  it('measures angles the short way', () => {
    expect(angleDelta(0.1, -0.1)).toBeCloseTo(-0.2, 12);
    expect(angleDelta(3.0, -3.0)).toBeCloseTo(2 * Math.PI - 6, 12);
  });
});

describe('sprinting and stamina', () => {
  const sprint: PlayerInput = { moveX: 1, moveY: 0, sprint: true };

  it('runs faster and tires', () => {
    const p = run(createPlayer(0, 0), sprint, 1);
    expect(speedOf(p)).toBeCloseTo(PLAYER.sprintSpeed, 6);
    expect(p.sprinting).toBe(true);
    expect(p.stamina).toBeCloseTo(1 - PLAYER.staminaDrain, 2);
  });

  it('runs out of breath after about five seconds and drops to a walk', () => {
    const p = run(createPlayer(0, 0), sprint, 5.5);
    expect(p.exhausted).toBe(true);
    expect(p.sprinting).toBe(false);
    expect(speedOf(p)).toBeCloseTo(PLAYER.walkSpeed, 6);
  });

  it('cannot sprint again until rested, then can', () => {
    let p = run(createPlayer(0, 0), sprint, 5.5);
    p = run(p, sprint, 0.5); // still holding shift: no sprint, no recovery progress to speak of
    expect(p.exhausted).toBe(true);
    p = run(p, idle, 3); // rest
    expect(p.exhausted).toBe(false);
    expect(p.stamina).toBeGreaterThan(PLAYER.exhaustedUntil);
    p = run(p, sprint, 1);
    expect(p.sprinting).toBe(true);
  });

  it('only drains while actually running, and refills after a pause', () => {
    const standing = run(createPlayer(0, 0), { moveX: 0, moveY: 0, sprint: true }, 2);
    expect(standing.stamina).toBe(1);
    let p = run(createPlayer(0, 0), sprint, 2);
    const tired = p.stamina;
    p = run(p, idle, 0.5); // within the pause: no refill yet
    expect(p.stamina).toBe(tired);
    p = run(p, idle, 3);
    expect(p.stamina).toBeGreaterThan(tired + 0.3); // refilled (the cap is 1)
    expect(p.stamina).toBeLessThanOrEqual(1);
  });

  it('never leaves the 0 to 1 range', () => {
    let p = createPlayer(0, 0);
    for (let i = 0; i < 3000; i++) {
      p = stepPlayer(p, { moveX: 1, moveY: 0, sprint: Math.floor(i / 300) % 2 === 0 }, open, DT);
      expect(p.stamina).toBeGreaterThanOrEqual(0);
      expect(p.stamina).toBeLessThanOrEqual(1);
    }
  });
});

describe('walls', () => {
  it('lose you all your speed against them', () => {
    const p = run(createPlayer(0, 0), { moveX: 0, moveY: 1, sprint: true }, 6, walls);
    expect(p.y).toBeCloseTo(20 - PLAYER.radius, 3);
    expect(speedOf(p)).toBeLessThan(0.1);
  });

  it('let you slide along them when you push at an angle', () => {
    const p = run(createPlayer(0, 0), { moveX: 1, moveY: 1, sprint: false }, 8, walls);
    expect(p.x).toBeGreaterThan(10);
    expect(p.y).toBeLessThanOrEqual(20 - PLAYER.radius + 1e-6);
  });
});

describe('determinism', () => {
  it('gives the same result for the same inputs', () => {
    const script = (i: number): PlayerInput => ({
      moveX: Math.cos(i * 0.05),
      moveY: Math.sin(i * 0.031),
      sprint: i % 400 < 150,
    });
    const play = (): PlayerState => {
      let p = createPlayer(1, 2);
      for (let i = 0; i < 2000; i++) p = stepPlayer(p, script(i), walls, DT);
      return p;
    };
    expect(play()).toEqual(play());
  });

  it('does not change the state it is given', () => {
    const p = createPlayer(0, 0);
    const copy = { ...p };
    stepPlayer(p, east, open, DT);
    expect(p).toEqual(copy);
  });
});

describe('a long walk through the real Tashkent', () => {
  const city = JSON.parse(readFileSync(resolve('public/cities/tashkent.json'), 'utf8')) as CityData;
  const grid = buildOccupancy(city, 2);
  const lamps = placeLamps(city, grid);
  const trees = placeTrees(city, grid);
  const colliders = buildColliders(city, [
    { data: trees.data, stride: TREE_STRIDE, count: trees.count, radius: 0.35 },
    { data: lamps.data, stride: LAMP_STRIDE, count: lamps.count, radius: 0.15 },
  ]);

  // buildings bucketed by 50 m cell, so "am I inside a building?" only checks the few nearby
  const bucket = new Map<string, CityData['buildings']>();
  for (const b of city.buildings) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < b.outer.length; i += 2) {
      minX = Math.min(minX, b.outer[i]);
      maxX = Math.max(maxX, b.outer[i]);
      minY = Math.min(minY, b.outer[i + 1]);
      maxY = Math.max(maxY, b.outer[i + 1]);
    }
    for (let cy = Math.floor(minY / 50); cy <= Math.floor(maxY / 50); cy++) {
      for (let cx = Math.floor(minX / 50); cx <= Math.floor(maxX / 50); cx++) {
        const key = `${cx},${cy}`;
        const list = bucket.get(key);
        if (list) list.push(b);
        else bucket.set(key, [b]);
      }
    }
  }
  const insideBuilding = (x: number, y: number): boolean =>
    (bucket.get(`${Math.floor(x / 50)},${Math.floor(y / 50)}`) ?? []).some(
      (b) =>
        pointInFlatRing(b.outer, x, y) && !(b.holes ?? []).some((h) => pointInFlatRing(h, x, y)),
    );

  it('spawns in the open near the TV tower', () => {
    const tower = city.towers.find((t) => t.height > 100)!;
    const [x, y] = findSpawn(colliders, [tower.x, tower.y]);
    expect(insideBuilding(x, y)).toBe(false);
    expect(inWater(colliders, x, y, 3)).toBe(false);
    expect(Math.hypot(x - tower.x, y - tower.y)).toBeLessThan(120);
  });

  it('never ends up in a building, in the water, or off the map', () => {
    const tower = city.towers.find((t) => t.height > 100)!;
    const [sx, sy] = findSpawn(colliders, [tower.x, tower.y]);
    let p = createPlayer(sx, sy);
    let travelled = 0;
    const steps = 40_000;
    for (let i = 0; i < steps; i++) {
      // a steady heading for a stretch, then a new one: a wanderer who bumps into things
      const leg = Math.floor(i / 70);
      const angle = hash01(leg, 3) * Math.PI * 2;
      const input: PlayerInput = {
        moveX: Math.cos(angle),
        moveY: Math.sin(angle),
        sprint: hash01(leg, 4) < 0.35,
      };
      const before = p;
      p = stepPlayer(p, input, colliders, DT);
      travelled += Math.hypot(p.x - before.x, p.y - before.y);
      if (insideBuilding(p.x, p.y))
        throw new Error(`inside a building at step ${i}: ${p.x}, ${p.y}`);
      if (inWater(colliders, p.x, p.y, 0))
        throw new Error(`in the water at step ${i}: ${p.x}, ${p.y}`);
      if (Math.abs(p.x) > city.halfSize || Math.abs(p.y) > city.halfSize)
        throw new Error(`off the map at step ${i}`);
    }
    expect(travelled).toBeGreaterThan(1500); // it really did walk, not stand pinned somewhere
  });
});
