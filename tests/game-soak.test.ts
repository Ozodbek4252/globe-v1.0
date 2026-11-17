import { describe, expect, it } from 'vitest';
import {
  createGame,
  createGameWorld,
  drainEvents,
  stepGame,
  type GameInput,
} from '../src/sim/game';
import { CState } from '../src/sim/civilians';
import { sendHunting, ZState } from '../src/sim/horde';
import { loadTashkent } from './helpers/tashkent';

const DT = 1 / 60;

describe('minutes of play in the real Tashkent', () => {
  const t = loadTashkent();
  const world = createGameWorld(t.colliders, t.spawn, t.city.buildings);

  it('keeps every zombie on open ground and every number sane', () => {
    const g = createGame(world, {
      seed: 21,
      startX: t.spawn[0],
      startY: t.spawn[1],
      rescueAt: 1e9,
      clumps: 150,
    });
    const startAlive = g.horde.alive;
    expect(startAlive).toBeGreaterThan(300);

    // wake a third of them so the whole crowd is on the move at once
    for (let i = 0; i < g.horde.used; i += 3) sendHunting(g.horde, i, 400);

    // and have most of the survivors already with the survivor, so they are under pressure too
    const people = g.civilians;
    expect(world.places.length).toBeGreaterThan(5);
    let following = 0;
    for (let i = 0; i < people.count; i++) {
      if (people.state[i] !== CState.HIDING || i % 3 === 2) continue;
      people.x[i] = t.spawn[0] + (i % 4) * 1.5;
      people.y[i] = t.spawn[1] + 2 + Math.floor(i / 4);
      people.state[i] = CState.FOLLOWING;
      following++;
    }
    expect(following).toBeGreaterThanOrEqual(4);

    const half = world.colliders.half;
    let waves = 0;
    let maxAlive = 0;
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
      // keep the survivor alive so the soak covers the whole run
      if (g.health < 30) g.health = 100;
      stepGame(g, input, world, DT);
      for (const e of drainEvents(g)) if (e.type === 'wave') waves++;
      maxAlive = Math.max(maxAlive, g.horde.alive);

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
      for (let i = 0; i < people.count; i++) {
        const state = people.state[i];
        if (state === CState.DEAD || state === CState.SAVED || state === CState.SHELTERED) continue;
        const x = people.x[i];
        const y = people.y[i];
        if (!Number.isFinite(x) || !Number.isFinite(y))
          throw new Error(`person ${i} is at ${x}, ${y}`);
        if (Math.abs(x) > half || Math.abs(y) > half) throw new Error(`person ${i} left the map`);
        if (t.insideBuilding(x, y))
          throw new Error(`person ${i} is inside a building at ${x}, ${y}`);
      }
      for (let k = 0; k < g.targets.count; k++) {
        if (g.targets.damage[k] !== 0)
          throw new Error(`target ${k} was left with damage unapplied`);
      }
      expect(g.stats.lost + g.stats.saved).toBeLessThanOrEqual(people.count);
      expect(g.ammo).toBeGreaterThanOrEqual(0);
      expect(g.ammo).toBeLessThanOrEqual(15);
      expect(g.reserve).toBeGreaterThanOrEqual(0);
      expect(g.health).toBeGreaterThanOrEqual(0);
      expect(g.health).toBeLessThanOrEqual(100);
      expect(t.insideBuilding(g.player.x, g.player.y)).toBe(false);
    }
    expect(waves).toBeGreaterThanOrEqual(2);
    expect(g.stats.shots).toBeGreaterThan(20);
    expect(maxAlive).toBeGreaterThan(startAlive); // the waves added to the crowd
  }, 120_000);
});
