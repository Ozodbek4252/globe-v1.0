import { describe, expect, it } from 'vitest';
import { buildColliders, insideBuilding } from '../src/sim/colliders';
import { createGameWorld } from '../src/sim/game';
import { createHorde, rebuildZombieIndex, spawnZombie, ZKind, ZState } from '../src/sim/horde';
import {
  biteHuman,
  createHumans,
  HState,
  HUMAN,
  spawnHuman,
  stepHumans,
  type HumanContext,
} from '../src/sim/humans';
import type { PlaceBuilding } from '../src/sim/places';
import { createOutbreak } from '../src/sim/population';
import { createPointIndex, rebuildIndex } from '../src/sim/spatial';

const DT = 1 / 60;

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

/** Open ground (half-size 300 m) with some buildings, a crowd of up to 20, and a record of who went in or turned. */
function street(buildings: PlaceBuilding[] = [], capacity = 20) {
  const colliders = buildColliders({
    halfSize: 300,
    buildings: buildings.map((b) => ({ outer: b.outer })),
    areas: [],
    waterways: [],
    roads: [],
  });
  const world = createGameWorld(colliders, [0, 0], buildings);
  const horde = createHorde(40, 1);
  const zombies = createPointIndex(300, 10, 40);
  const outbreak = createOutbreak(buildings, world);
  const doors = createPointIndex(300, 16, Math.max(1, outbreak.count));
  rebuildIndex(
    doors,
    outbreak.count,
    outbreak.doorX,
    outbreak.doorY,
    (i) => !Number.isNaN(outbreak.doorX[i]),
  );
  const humans = createHumans(capacity, 3);
  const entered: number[] = [];
  const turned: [number, number][] = [];
  const ctx: HumanContext = {
    colliders,
    nav: world.nav,
    reachable: world.reachable,
    horde,
    zombies,
    doors,
    outbreak,
    noises: [],
    px: 0,
    py: 0,
    onEnter: (b) => entered.push(b),
    onTurn: (x, y) => turned.push([x, y]),
  };
  let tick = 0;
  const run = (seconds: number): void => {
    for (let s = 0; s < Math.round(seconds / DT); s++) {
      rebuildZombieIndex(horde, zombies);
      stepHumans(humans, ctx, DT, tick++);
    }
  };
  /** A zombie that stays where it is (the horde itself is not stepped here). */
  const zombie = (x: number, y: number): number =>
    spawnZombie(horde, x, y, ZKind.WALKER, ZState.WANDER);
  return { colliders, world, humans, horde, outbreak, ctx, entered, turned, run, zombie };
}

describe('people in the street', () => {
  it('stroll about, and keep out of the walls', () => {
    const hall: PlaceBuilding = { id: 1, outer: box(20, -20, 30, 40), height: 8, kind: 'other' };
    const t = street([hall]);
    const i = spawnHuman(t.humans, 5, 0);
    for (let s = 0; s < 120; s++) {
      t.run(1);
      expect(insideBuilding(t.colliders, t.humans.x[i], t.humans.y[i])).toBe(false);
    }
    expect(t.humans.travelled[i]).toBeGreaterThan(20);
    expect(t.humans.state[i]).toBe(HState.WALK);
  });

  it('run from a zombie they can see, away from it, and faster than they stroll', () => {
    const t = street();
    t.zombie(8, 0);
    const i = spawnHuman(t.humans, 0, 0);
    t.run(0.5);
    expect(t.humans.state[i]).toBe(HState.FLEE);
    t.run(2);
    expect(t.humans.x[i]).toBeLessThan(-4);
    expect(Math.hypot(t.humans.vx[i], t.humans.vy[i])).toBeGreaterThan(HUMAN.walk * 2);
  });

  it('settle down again once the danger has gone', () => {
    const t = street();
    const z = t.zombie(8, 0);
    const i = spawnHuman(t.humans, 0, 0);
    t.run(1);
    expect(t.humans.state[i]).toBe(HState.FLEE);
    t.horde.state[z] = ZState.FREE; // it is gone
    t.run(HUMAN.scare + 2);
    expect(t.humans.state[i]).toBe(HState.WALK);
  });

  it('do not notice a zombie far off or behind a wall', () => {
    const wall: PlaceBuilding = { id: 1, outer: box(4, -30, 3, 60), height: 8, kind: 'other' };
    const t = street([wall]);
    t.zombie(14, 0); // 14 m off but behind the building
    t.zombie(-60, 0); // out of range
    const i = spawnHuman(t.humans, 0, 0);
    t.humans.timer[i] = 100; // standing about
    t.run(3);
    expect(t.humans.state[i]).toBe(HState.WALK);
  });

  it('run from gunfire but not from footsteps', () => {
    const t = street();
    const i = spawnHuman(t.humans, 0, 0);
    t.humans.timer[i] = 100;
    t.ctx.noises = [{ x: 15, y: 0, radius: 25, ttl: 2 }];
    t.run(1);
    expect(t.humans.state[i]).toBe(HState.WALK);
    t.ctx.noises = [{ x: 15, y: 0, radius: 75, ttl: 2 }];
    t.run(2);
    expect(t.humans.state[i]).toBe(HState.FLEE);
    expect(t.humans.x[i]).toBeLessThan(-3);
  });

  it('make for a door if one is near, and go in', () => {
    const house: PlaceBuilding = { id: 1, outer: box(30, -10, 20, 20), height: 8, kind: 'house' };
    const t = street([house]);
    const door = { x: t.outbreak.doorX[0], y: t.outbreak.doorY[0] };
    expect(Number.isNaN(door.x)).toBe(false);
    // a person 14 m from the door, with a zombie beyond them: the door is the way out
    const side = door.x < 40 ? -1 : 1; // keep clear of the building itself
    const i = spawnHuman(t.humans, door.x + side * 14, door.y);
    t.zombie(door.x + side * 20, door.y);
    const before = t.outbreak.healthy[0];
    t.run(8);
    expect(t.entered).toEqual([0]);
    expect(t.humans.state[i]).toBe(HState.FREE);
    expect(t.humans.alive).toBe(0);
    expect(before).toBeGreaterThan(0);
  });

  it('do not run for a door that has been broken down', () => {
    const house: PlaceBuilding = { id: 1, outer: box(30, -10, 20, 20), height: 8, kind: 'house' };
    const t = street([house]);
    t.outbreak.open[0] = 1;
    const i = spawnHuman(t.humans, t.outbreak.doorX[0] - 8, t.outbreak.doorY[0]);
    t.zombie(t.humans.x[i] - 6, t.humans.y[i]);
    t.run(6);
    expect(t.entered).toEqual([]);
    expect(t.humans.state[i]).not.toBe(HState.FREE);
  });
});

describe('the bitten', () => {
  it('stagger on for a few seconds and then turn, once, where they are', () => {
    const t = street();
    const i = spawnHuman(t.humans, 10, 10);
    expect(t.humans.alive).toBe(1);
    expect(biteHuman(t.humans, i)).toBe(true);
    expect(t.humans.alive).toBe(0); // no longer one of the well
    t.run(HUMAN.incubation - 1);
    expect(t.turned).toHaveLength(0);
    expect(t.humans.state[i]).toBe(HState.BITTEN);
    const walked = Math.hypot(t.humans.x[i] - 10, t.humans.y[i] - 10);
    expect(walked).toBeGreaterThan(0.5);
    expect(walked).toBeLessThan(HUMAN.bitten * HUMAN.incubation); // slowly
    t.run(2);
    expect(t.turned).toHaveLength(1);
    expect(Math.hypot(t.turned[0][0] - 10, t.turned[0][1] - 10)).toBeLessThan(
      HUMAN.bitten * HUMAN.incubation,
    );
    expect(t.humans.state[i]).toBe(HState.FREE);
    t.run(5);
    expect(t.turned).toHaveLength(1);
  });

  it('can only be bitten once, and not when gone', () => {
    const t = street();
    const i = spawnHuman(t.humans, 0, 0);
    expect(biteHuman(t.humans, i)).toBe(true);
    expect(biteHuman(t.humans, i)).toBe(false);
    t.run(HUMAN.incubation + 1);
    expect(biteHuman(t.humans, i)).toBe(false);
  });
});

describe('the street as a whole', () => {
  it('is full at its capacity, and a slot that is freed is used again', () => {
    const t = street([], 2);
    const a = spawnHuman(t.humans, 0, 0);
    const b = spawnHuman(t.humans, 5, 0);
    expect(spawnHuman(t.humans, 9, 0)).toBe(-1);
    biteHuman(t.humans, a);
    t.run(HUMAN.incubation + 1); // they turn and are gone from the street
    const c = spawnHuman(t.humans, 9, 0);
    expect(c).toBe(a);
    expect(t.humans.alive).toBe(2);
    expect(b).not.toBe(c);
  });

  it('still move when far from the survivor, though less often', () => {
    const t = street();
    t.ctx.px = 250;
    t.ctx.py = 250; // everyone here is far (over 220 m) from the survivor
    const i = spawnHuman(t.humans, -100, -100);
    t.humans.timer[i] = 0;
    t.run(30);
    expect(t.humans.travelled[i]).toBeGreaterThan(3);
  });

  it('play out the same way every time', () => {
    const play = (): string => {
      const t = street();
      for (let k = 0; k < 10; k++) spawnHuman(t.humans, k * 6 - 30, 0);
      t.zombie(0, 10);
      t.run(20);
      return Array.from(
        { length: 10 },
        (_, k) => `${t.humans.x[k].toFixed(3)},${t.humans.y[k].toFixed(3)}`,
      ).join('|');
    };
    expect(play()).toBe(play());
  });
});
