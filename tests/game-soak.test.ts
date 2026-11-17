import { describe, expect, it } from 'vitest';
import {
  createGame,
  createGameWorld,
  drainEvents,
  stepGame,
  type GameInput,
} from '../src/sim/game';
import { HState } from '../src/sim/humans';
import { sendHunting, ZState } from '../src/sim/horde';
import { loadTashkent } from './helpers/tashkent';

const DT = 1 / 60;

describe('minutes of play in the real Tashkent', () => {
  const t = loadTashkent();
  const world = createGameWorld(t.colliders, t.spawn, t.city.buildings);

  it('keeps every zombie and every person on open ground, and every number sane', () => {
    const g = createGame(world, {
      seed: 21,
      startX: t.spawn[0],
      startY: t.spawn[1],
      clumps: 150,
      patients: 12, // plenty of places for the outbreak to begin, so it is spreading all the way through
    });
    const startAlive = g.horde.alive;
    expect(startAlive).toBeGreaterThan(300);
    const startPeople = g.population.healthy + g.population.bitten + g.population.zombies;
    expect(g.humans.alive).toBeGreaterThan(1000); // the few percent who are outdoors
    expect(world.places.length).toBeGreaterThan(5);

    // wake a third of the horde so the whole crowd is on the move at once
    for (let i = 0; i < g.horde.used; i += 3) sendHunting(g.horde, i, 400);

    const half = world.colliders.half;
    let maxStreet = 0;
    let turned = 0;
    const steps = 60 * 100; // a hundred seconds
    for (let s = 0; s < steps; s++) {
      // a scripted survivor: walks a wide loop, sprints now and then, and keeps shooting
      const time = s * DT;
      const a = time * 0.18;
      const input: GameInput = {
        moveX: Math.cos(a),
        moveY: Math.sin(a),
        sprint: Math.floor(time / 4) % 3 === 0,
        aim: [g.player.x + Math.cos(a + 0.6) * 15, g.player.y + Math.sin(a + 0.6) * 15],
        fire: Math.floor(time) % 2 === 0,
        reload: s % 600 === 0,
        shove: s % 240 === 0,
        interact: s % 300 === 0,
        weapon: s % 1500 === 0 ? 2 : s % 1500 === 750 ? 1 : 0,
      };
      // keep the survivor alive and fed so the soak covers the whole run
      if (g.health < 30) g.health = 100;
      g.food = 100;
      stepGame(g, input, world, DT);
      drainEvents(g);
      maxStreet = Math.max(maxStreet, g.horde.alive);

      if (s % 60 !== 0) continue;
      let counted = 0;
      for (let i = 0; i < g.horde.used; i++) {
        const state = g.horde.state[i];
        if (state === ZState.FREE) continue;
        const x = g.horde.x[i];
        const y = g.horde.y[i];
        if (!Number.isFinite(x) || !Number.isFinite(y))
          throw new Error(`zombie ${i} is at ${x}, ${y}`);
        if (Math.abs(x) > half || Math.abs(y) > half) throw new Error(`zombie ${i} left the map`);
        if (state < ZState.DEAD) {
          counted++;
          if (t.insideBuilding(x, y))
            throw new Error(`zombie ${i} is inside a building at ${x}, ${y}`);
        }
      }
      expect(counted).toBe(g.horde.alive);

      let walking = 0;
      for (let i = 0; i < g.humans.used; i++) {
        const state = g.humans.state[i];
        if (state === HState.FREE) continue;
        const x = g.humans.x[i];
        const y = g.humans.y[i];
        if (!Number.isFinite(x) || !Number.isFinite(y))
          throw new Error(`person ${i} is at ${x}, ${y}`);
        if (Math.abs(x) > half || Math.abs(y) > half) throw new Error(`person ${i} left the map`);
        if (t.insideBuilding(x, y))
          throw new Error(`person ${i} is inside a building at ${x}, ${y}`);
        if (state !== HState.BITTEN) walking++;
      }
      expect(walking).toBe(g.humans.alive);

      for (let k = 0; k < g.targets.count; k++) {
        if (g.targets.damage[k] !== 0)
          throw new Error(`target ${k} was left with damage unapplied`);
      }
      for (let b = 0; b < g.outbreak.count; b++) {
        if (g.outbreak.healthy[b] < 0 || g.outbreak.incubating[b] < 0 || g.outbreak.undead[b] < 0)
          throw new Error(`building ${b} has a negative number of people`);
      }
      // nobody appears from nowhere: the well, the bitten and the turned never outnumber the city
      // (the zombies in the groups at the start were never part of it)
      const people = g.population.healthy + g.population.bitten + g.population.zombies;
      expect(people).toBeLessThanOrEqual(startPeople + startAlive);
      turned = g.population.zombies;
      expect(g.ammo).toBeGreaterThanOrEqual(0);
      expect(g.ammo).toBeLessThanOrEqual(15);
      expect(g.reserve).toBeGreaterThanOrEqual(0);
      expect(g.health).toBeGreaterThanOrEqual(0);
      expect(g.health).toBeLessThanOrEqual(100);
      expect(t.insideBuilding(g.player.x, g.player.y)).toBe(false);
    }
    expect(g.stats.shots).toBeGreaterThan(20);
    expect(turned).toBeGreaterThan(0);
    expect(maxStreet).toBeLessThanOrEqual(g.horde.capacity);
  }, 120_000);
});
