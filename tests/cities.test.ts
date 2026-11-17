import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
import { parsePlayable } from '../src/map/playable';
import { loadCityById } from './helpers/tashkent';

const DT = 1 / 60;

const places = parsePlayable(
  JSON.parse(readFileSync(resolve('public/cities/index.json'), 'utf8')) as unknown,
);

describe.each(places.map((p) => [p.id, p] as const))('playing in %s', (id, place) => {
  const t = loadCityById(id);
  const world = createGameWorld(t.colliders, t.spawn, t.city.buildings);
  const half = t.colliders.half;

  it('starts on open ground, with a place for each job the map allows', () => {
    expect(t.insideBuilding(t.spawn[0], t.spawn[1])).toBe(false);
    const kinds = world.places.map((p) => p.kind);
    // every map has somewhere to hide and a way to see the horde; the rest depends on what is mapped
    expect(kinds).toContain('radar');
    expect(kinds).toContain('shelter');
    expect(kinds.length).toBeGreaterThanOrEqual(3);
    for (const p of world.places) expect(t.insideBuilding(p.x, p.y)).toBe(false);
  });

  it("is full of people in the place's own density, nearly all indoors", () => {
    const g = createGame(world, {
      seed: 3,
      startX: t.spawn[0],
      startY: t.spawn[1],
      density: place.density,
    });
    const km2 = ((half * 2) / 1000) ** 2;
    const target = place.density * km2;
    expect(g.population.initial).toBeGreaterThan(target * 0.95);
    expect(g.population.initial).toBeLessThan(target * 1.05);
    expect(g.population.zombies).toBeGreaterThan(0); // the outbreak has begun somewhere
    expect(g.horde.alive).toBe(0);
    expect(g.humans.alive).toBeGreaterThan(0);
    expect(g.humans.alive).toBeLessThan(g.population.initial * 0.15);
  });

  it('keeps everyone out of the buildings and every number sane, with the outbreak running', () => {
    const g = createGame(world, {
      seed: 11,
      startX: t.spawn[0],
      startY: t.spawn[1],
      density: place.density,
      clumps: 60, // some zombies already in the streets
      patients: 12,
    });
    for (let i = 0; i < g.horde.used; i += 2) sendHunting(g.horde, i, 200);
    const start = g.population.healthy + g.population.bitten + g.population.zombies;
    const streetStart = g.horde.alive;
    for (let s = 0; s < 60 * 40; s++) {
      const time = s * DT;
      const a = time * 0.2;
      const input: GameInput = {
        moveX: Math.cos(a),
        moveY: Math.sin(a),
        throttle: 0,
        steer: 0,
        sprint: Math.floor(time / 4) % 3 === 0,
        aim: [g.player.x + Math.cos(a + 0.6) * 15, g.player.y + Math.sin(a + 0.6) * 15],
        fire: Math.floor(time) % 2 === 0,
        reload: s % 600 === 0,
        shove: s % 240 === 0,
        interact: s % 300 === 0,
        weapon: 0,
      };
      if (g.health < 30) g.health = 100;
      g.food = 100;
      stepGame(g, input, world, DT);
      drainEvents(g);
      if (s % 60 !== 0) continue;
      for (let i = 0; i < g.horde.used; i++) {
        if (g.horde.state[i] >= ZState.DEAD) continue;
        const x = g.horde.x[i];
        const y = g.horde.y[i];
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`zombie ${i}: ${x}, ${y}`);
        if (Math.abs(x) > half || Math.abs(y) > half) throw new Error(`zombie ${i} left the map`);
        if (t.insideBuilding(x, y)) throw new Error(`zombie ${i} is inside a building: ${x}, ${y}`);
      }
      for (let i = 0; i < g.humans.used; i++) {
        if (g.humans.state[i] === HState.FREE) continue;
        const x = g.humans.x[i];
        const y = g.humans.y[i];
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`person ${i}: ${x}, ${y}`);
        if (t.insideBuilding(x, y)) throw new Error(`person ${i} is inside a building: ${x}, ${y}`);
      }
      const p = g.population;
      expect(p.healthy + p.bitten + p.zombies).toBeLessThanOrEqual(start + streetStart);
      expect(t.insideBuilding(g.player.x, g.player.y)).toBe(false);
    }
    expect(g.population.zombies).toBeGreaterThan(0);
  }, 120_000);
});
