import { describe, expect, it } from 'vitest';
import { cityFallen, countPopulation, NO_INPUT, stepGame } from '../src/sim/game';
import { HState } from '../src/sim/humans';
import { DT, NEIGHBOURHOOD, town } from './helpers/town';

/** The outbreak takes everyone on the map: all the people turn, indoors and in the street. */
function wipe(g: ReturnType<typeof town>['g']): void {
  const o = g.outbreak;
  for (let b = 0; b < o.count; b++) {
    o.undead[b] += o.healthy[b] + o.incubating[b];
    o.healthy[b] = 0;
    o.incubating[b] = 0;
  }
  const h = g.humans;
  for (let i = 0; i < h.used; i++) {
    if (h.state[i] === HState.FREE) continue;
    h.state[i] = HState.FREE;
    h.freeList[h.freeCount++] = i;
  }
  h.alive = 0;
}

describe('the city falls', () => {
  it('when not one of its people is left well or turning, and then the game is over', () => {
    const { g, world, run, events } = town(NEIGHBOURHOOD);
    expect(g.population.initial).toBeGreaterThan(0);
    run(2);
    expect(g.status).toBe('playing');
    expect(cityFallen(g)).toBe(false);
    wipe(g);
    countPopulation(g);
    expect(cityFallen(g)).toBe(true);
    run(1.5);
    expect(g.status).toBe('fallen');
    expect(events.filter((e) => e.type === 'fallen')).toHaveLength(1);
    expect(g.health).toBeGreaterThan(0); // the survivor is alive: it is the city that is gone
    // nothing moves on: the survivor stays put and the clock stops counting
    const { x, y } = g.player;
    const time = g.time;
    for (let s = 0; s < 60; s++) stepGame(g, { ...NO_INPUT, moveX: 1 }, world, DT);
    expect(g.player.x).toBe(x);
    expect(g.player.y).toBe(y);
    expect(g.time).toBe(time);
  });

  it('not while someone is still turning: the bitten count as people until they turn', () => {
    const { g, run } = town(NEIGHBOURHOOD);
    wipe(g);
    g.outbreak.incubating[0] = 1;
    countPopulation(g);
    expect(cityFallen(g)).toBe(false);
    run(1.5);
    expect(g.status).toBe('playing');
  });

  it('not while people are left beyond this map (the rest of a big city)', () => {
    const { g, run } = town(NEIGHBOURHOOD);
    wipe(g);
    g.beyond = { healthy: 3, bitten: 0, zombies: 1000 };
    countPopulation(g);
    expect(cityFallen(g)).toBe(false);
    run(1.5);
    expect(g.status).toBe('playing');
    g.beyond = { healthy: 0, bitten: 0, zombies: 1003 };
    run(1.5);
    expect(g.status).toBe('fallen');
  });

  it('never, in a place with nobody in it to begin with', () => {
    const { g, run } = town(NEIGHBOURHOOD, { population: false });
    expect(g.population.initial).toBe(0);
    run(2);
    expect(g.status).toBe('playing');
  });
});
