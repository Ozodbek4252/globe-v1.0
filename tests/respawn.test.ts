import { describe, expect, it } from 'vitest';
import { insideBuilding } from '../src/sim/colliders';
import { GAME, respawn } from '../src/sim/game';
import { hordeChecksum, spawnZombie, ZKind, ZState } from '../src/sim/horde';
import { DT, NEIGHBOURHOOD, town } from './helpers/town';

describe('the next survivor', () => {
  /** A city some way into the outbreak, whose survivor has just died. */
  const fallen = () => {
    const t = town(NEIGHBOURHOOD, { patients: 2, clumps: 10, cycle: true, startHour: 17 });
    t.run(60);
    t.g.hasShotgun = true;
    t.g.weapon = 'shotgun';
    t.g.used[0] = true;
    t.g.pickups[0].taken = true;
    t.g.health = 0.001;
    const z = spawnZombie(t.g.horde, t.g.player.x + 1, t.g.player.y, ZKind.WALKER, ZState.ATTACK);
    t.g.horde.attackT[z] = 0.49;
    t.run(3);
    expect(t.g.status).toBe('lost');
    return t;
  };

  it('steps into the same city: the horde, the people, the outbreak, the clock and the doors as they were', () => {
    const t = fallen();
    const horde = hordeChecksum(t.g.horde);
    const people = [...t.g.outbreak.healthy];
    const street = t.g.humans.alive;
    const clock = t.g.clock;
    respawn(t.g, t.world, 0, 0);
    expect(hordeChecksum(t.g.horde)).toBe(horde);
    expect([...t.g.outbreak.healthy]).toEqual(people);
    expect(t.g.humans.alive).toBe(street);
    expect(t.g.clock).toBe(clock);
    expect(t.g.used[0]).toBe(true); // what was searched stays searched
  });

  it('is a fresh person: full health and pack, the clock of their own run at zero', () => {
    const t = fallen();
    respawn(t.g, t.world, 0, 0);
    expect(t.g.status).toBe('playing');
    expect(t.g.time).toBe(0);
    expect(t.g.health).toBe(GAME.health);
    expect(t.g.food).toBe(GAME.food.max);
    expect(t.g.weapon).toBe('pistol');
    expect(t.g.hasShotgun).toBe(false);
    expect([t.g.ammo, t.g.reserve]).toEqual([GAME.weapon.mag, GAME.weapon.reserve]);
    expect(t.g.stats.kills).toBe(0);
    expect(t.g.inside).toBe(-1);
    expect(t.g.events).toEqual([]);
  });

  it('stands on open ground near the start, away from the dead, and finds supplies laid out again', () => {
    const t = fallen();
    // a knot of zombies right on the start
    for (let k = 0; k < 6; k++)
      spawnZombie(t.g.horde, k * 0.8 - 2, 0.5, ZKind.WALKER, ZState.WANDER);
    const taken = t.g.pickups.filter((p) => p.taken).length;
    expect(taken).toBeGreaterThan(0);
    respawn(t.g, t.world, 0, 0);
    expect(insideBuilding(t.colliders, t.g.player.x, t.g.player.y)).toBe(false);
    expect(Math.hypot(t.g.player.x, t.g.player.y)).toBeLessThan(100);
    let nearest = Infinity;
    for (let i = 0; i < t.g.horde.used; i++) {
      if (t.g.horde.state[i] >= ZState.DEAD) continue;
      nearest = Math.min(
        nearest,
        Math.hypot(t.g.horde.x[i] - t.g.player.x, t.g.horde.y[i] - t.g.player.y),
      );
    }
    expect(nearest).toBeGreaterThan(12);
    expect(t.g.pickups.every((p) => !p.taken)).toBe(true);
    expect(t.g.pickups.length).toBeGreaterThanOrEqual(
      GAME.pickups.ammo + GAME.pickups.medkit + GAME.pickups.food,
    );
    expect(t.g.pickups.length).toBeLessThanOrEqual(GAME.pickups.max);
  });

  it('plays on: the new survivor can be hurt and the day goes by', () => {
    const t = fallen();
    respawn(t.g, t.world, 0, 0);
    const clock = t.g.clock;
    t.run(2);
    expect(t.g.status).toBe('playing');
    expect(t.g.time).toBeCloseTo(2, 1);
    expect(t.g.clock).toBeGreaterThan(clock);
    const z = spawnZombie(t.g.horde, t.g.player.x + 1, t.g.player.y, ZKind.WALKER, ZState.ATTACK);
    t.g.horde.attackT[z] = 0.49;
    for (let s = 0; s < 60; s++) t.run(DT);
    expect(t.g.health).toBeLessThan(GAME.health);
  });
});
