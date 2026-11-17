import { describe, expect, it } from 'vitest';
import { insideBuilding } from '../src/sim/colliders';
import {
  createGame,
  createGameWorld,
  drainEvents,
  GAME,
  NO_INPUT,
  stepGame,
  validSpot,
  type GameInput,
} from '../src/sim/game';
import { sendHunting, spawnZombie, ZKind, ZState } from '../src/sim/horde';
import { HState, HUMAN, spawnHuman } from '../src/sim/humans';
import { loadTashkent } from './helpers/tashkent';
import { box, DT, emptyStreets, house, NEIGHBOURHOOD, town } from './helpers/town';

describe('a city at the start', () => {
  it('is full of people, all well, with no zombies, wave or rescue in sight', () => {
    const { g } = town(NEIGHBOURHOOD);
    expect(g.population.healthy).toBeGreaterThan(300);
    expect(g.population.bitten).toBe(0);
    expect(g.population.zombies).toBe(0);
    expect(g.horde.alive).toBe(0);
    expect(g.population.initial).toBe(g.outbreak.initial);
    expect(g.status).toBe('playing');
  });

  it('has as many people as the real density says', () => {
    const density = 5000;
    const { g } = town(NEIGHBOURHOOD, { density });
    const km2 = (1600 / 1000) ** 2;
    const target = density * km2;
    expect(g.population.initial).toBeGreaterThan(target * 0.97);
    expect(g.population.initial).toBeLessThan(target * 1.03);
    // and every one of them is accounted for, in a building or in the street
    expect(g.population.healthy).toBe(g.population.initial);
  });

  it('puts about a tenth in the street (as the hour has it), near their own doors, on open ground', () => {
    const { g, colliders } = town(NEIGHBOURHOOD);
    expect(g.humans.alive).toBeGreaterThan(5);
    expect(g.humans.alive).toBeLessThan(g.population.initial * 0.2);
    for (let i = 0; i < g.humans.used; i++) {
      expect(insideBuilding(colliders, g.humans.x[i], g.humans.y[i])).toBe(false);
      let nearest = Infinity;
      for (let b = 0; b < g.outbreak.count; b++) {
        nearest = Math.min(
          nearest,
          Math.hypot(g.humans.x[i] - g.outbreak.doorX[b], g.humans.y[i] - g.outbreak.doorY[b]),
        );
      }
      expect(nearest).toBeLessThan(40); // a big block puts out a crowd, who spread further
    }
  });

  it('starts with the patients far from the survivor, and nobody turned if there are none', () => {
    const calm = town(NEIGHBOURHOOD, { patients: 0 });
    expect(calm.g.population.zombies).toBe(0);
    const sick = town(NEIGHBOURHOOD, { patients: 2 });
    expect(sick.g.population.zombies).toBe(4);
    for (let b = 0; b < sick.g.outbreak.count; b++) {
      if (sick.g.outbreak.undead[b] === 0) continue;
      const d = Math.hypot(sick.g.outbreak.doorX[b], sick.g.outbreak.doorY[b]);
      expect(d).toBeGreaterThanOrEqual(GAME.outbreak.minDistance);
    }
  });

  it('is the same for the same seed, and different for another', () => {
    const play = (seed: number): string => {
      const t = town(NEIGHBOURHOOD, { seed, patients: 3 });
      t.run(90);
      const p = t.g.population;
      return [p.healthy, p.bitten, p.zombies, t.g.horde.alive, t.g.humans.alive].join();
    };
    expect(play(4)).toBe(play(4));
    expect(play(4)).not.toBe(play(5));
  }, 60_000);
});

describe('the infection spreading', () => {
  it('turns people inside a building, and they come out into the street', () => {
    const { g, run } = town(NEIGHBOURHOOD, { patients: 1 });
    const before = g.population.healthy;
    run(120);
    expect(g.horde.alive).toBeGreaterThanOrEqual(3);
    expect(g.population.zombies).toBeGreaterThan(g.horde.alive - 1);
    expect(g.population.healthy).toBeLessThan(before - 2);
  }, 60_000);

  it('never makes or loses people on its own', () => {
    const { g, run } = town(NEIGHBOURHOOD, { patients: 2 });
    const start = g.population.initial;
    for (let k = 0; k < 40; k++) {
      run(5);
      const p = g.population;
      expect(p.healthy + p.bitten + p.zombies).toBe(start);
    }
  }, 60_000);

  it('is bitten by a zombie in the street, turns a few seconds later, and joins them', () => {
    const { g, run } = town([house(1, 300, 300)]);
    emptyStreets(g);
    const i = spawnHuman(g.humans, 40, 0, HState.WALK);
    g.humans.timer[i] = 1000; // standing about, and not looking
    // a runner, which can catch a frightened person (5.2 m/s against 4.1)
    const z = spawnZombie(g.horde, 36, 0, ZKind.RUNNER, ZState.WANDER);
    g.horde.heading[z] = 0;
    g.horde.timer[z] = 1000;
    for (let s = 0; s < 40 && g.humans.state[i] !== HState.BITTEN; s++) run(0.25);
    expect(g.humans.state[i]).toBe(HState.BITTEN);
    run(1); // the city is counted once a second
    expect(g.population.bitten).toBeGreaterThanOrEqual(1);
    run(HUMAN.incubation);
    expect(g.humans.state[i]).toBe(HState.FREE);
    expect(g.horde.alive).toBe(2);
  });

  it('can be run from: a person who sees a walker coming gets away', () => {
    const { g, run } = town([house(1, 300, 300)]);
    emptyStreets(g);
    const i = spawnHuman(g.humans, 40, 0, HState.WALK);
    const z = spawnZombie(g.horde, 33, 0, ZKind.WALKER, ZState.WANDER);
    g.horde.heading[z] = 0;
    g.horde.timer[z] = 1000;
    run(12);
    expect(g.humans.state[i]).not.toBe(HState.BITTEN);
    expect(g.humans.state[i]).not.toBe(HState.FREE);
  });
});

describe('doors', () => {
  const lone = (hp: number) => {
    const t = town([house(1, 100, 100)]);
    emptyStreets(t.g); // nobody outside to go for instead
    const o = t.g.outbreak;
    expect(o.healthy[0]).toBeGreaterThan(5);
    o.doorHp[0] = hp;
    // a zombie a few metres from the door, facing it
    const x = o.doorX[0];
    const y = o.doorY[0];
    const center = { x: 110, y: 110 };
    const out = Math.hypot(x - center.x, y - center.y) || 1;
    const nx = (x - center.x) / out;
    const ny = (y - center.y) / out;
    const z = spawnZombie(t.g.horde, x + nx * 6, y + ny * 6, ZKind.WALKER, ZState.WANDER);
    t.g.horde.heading[z] = Math.atan2(-ny, -nx);
    t.g.horde.timer[z] = 1000;
    return { ...t, o, z };
  };

  it('are battered by a zombie that sees the people behind them, and give way in the end', () => {
    const { run, o, g } = lone(120);
    const before = o.healthy[0];
    run(8);
    expect(o.doorHp[0]).toBeLessThan(120);
    expect(o.open[0]).toBe(0);
    expect(o.healthy[0]).toBe(before); // nobody is hurt while the door holds
    run(60);
    expect(o.open[0]).toBe(1);
    expect(o.incubating[0] + o.undead[0]).toBeGreaterThan(0); // and then the people inside are bitten
    expect(g.stats.damageTaken).toBe(0); // the survivor was never involved
  });

  it('hold against a zombie when they are strong enough, for as long as anyone looks', () => {
    const { run, o } = lone(1e6);
    run(60);
    expect(o.open[0]).toBe(0);
    expect(o.incubating[0] + o.undead[0]).toBe(0);
  });

  it('let the infection through: bitten, turned, and out into the street, from one zombie', () => {
    const { run, g } = lone(30);
    run(150);
    expect(g.outbreak.open[0]).toBe(1);
    expect(g.horde.alive).toBeGreaterThanOrEqual(4);
  }, 60_000);

  it('are left alone when nobody is behind them', () => {
    const { run, o, g } = lone(40);
    o.healthy[0] = 0;
    run(30);
    expect(o.doorHp[0]).toBe(40);
    expect(g.targets.active[g.humans.capacity]).toBe(0);
  });
});

describe('hiding', () => {
  it('stops zombies chasing the survivor once they are out of sight, even out in the open', () => {
    const { g, run } = town([{ id: 1, outer: box(-40, 14, 80, 4), height: 8, kind: 'other' }], {
      population: false,
    });
    const z = spawnZombie(g.horde, 10, 0, ZKind.WALKER, ZState.WANDER);
    g.horde.heading[z] = Math.PI;
    g.horde.timer[z] = 1000;
    run(0.8);
    expect(g.horde.state[z]).toBe(ZState.CHASE);
    // the survivor slips round behind the long wall and stays there
    g.player = { ...g.player, x: 0, y: 30, vx: 0, vy: 0 };
    run(14);
    expect(g.horde.state[z]).not.toBe(ZState.CHASE);
    expect(g.status).toBe('playing');
    expect(g.health).toBe(GAME.health);
  });
});

describe('the real Tashkent district', () => {
  const t = loadTashkent();
  const world = createGameWorld(t.colliders, t.spawn, t.city.buildings);

  it('gives the survivor a quiet start, and then the outbreak spreads', () => {
    const g = createGame(world, { seed: 7, startX: t.spawn[0], startY: t.spawn[1] });
    expect(g.population.zombies).toBe(GAME.outbreak.patients * 2);
    expect(g.horde.alive).toBe(0);
    const start = g.population.initial;
    const km2 = ((t.colliders.half * 2) / 1000) ** 2; // the real density over the whole map
    expect(start).toBeGreaterThan(GAME.outbreak.density * km2 * 0.95);
    expect(start).toBeLessThan(GAME.outbreak.density * km2 * 1.05);
    const idle: GameInput = { ...NO_INPUT };
    let nearest = Infinity;
    for (let s = 0; s < 60 * 150; s++) {
      g.health = 100;
      g.food = 100;
      stepGame(g, idle, world, DT);
      drainEvents(g);
      if (s === 60 * 45) {
        // the first minute is calm: nothing near the survivor
        for (let i = 0; i < g.horde.used; i++) {
          if (g.horde.state[i] >= ZState.DEAD) continue;
          nearest = Math.min(
            nearest,
            Math.hypot(g.horde.x[i] - g.player.x, g.horde.y[i] - g.player.y),
          );
        }
      }
    }
    expect(nearest).toBeGreaterThan(100);
    expect(g.horde.alive).toBeGreaterThan(30); // by two and a half minutes the street has them
    expect(g.population.healthy).toBeLessThan(start - 20);
    expect(g.population.healthy + g.population.bitten + g.population.zombies).toBe(start);
  }, 120_000);
});

describe('where people can be put', () => {
  const t = loadTashkent();
  const world = createGameWorld(t.colliders, t.spawn, t.city.buildings);

  it('is never somewhere inside a building, even a few centimetres inside a wall', () => {
    // around a spot where the 1 m building map once read a point 0.6 m inside a wall as open ground
    let inside = 0;
    for (let x = -612; x <= -586; x += 0.1) {
      for (let y = 752; y <= 778; y += 0.1) {
        if (!t.insideBuilding(x, y)) continue;
        inside++;
        if (validSpot(world, x, y, 0.6)) throw new Error(`${x}, ${y} is inside a building`);
      }
    }
    expect(inside).toBeGreaterThan(1000);
    expect(validSpot(world, -597.916, 766.034, 0.6)).toBe(false);
  });
});

describe('sending people hunting', () => {
  it('still works as before (the horde does not care where a hunter came from)', () => {
    const { g, run } = town([house(1, 300, 300)], { population: false });
    const z = spawnZombie(g.horde, 60, 0, ZKind.WALKER, ZState.CHASE);
    sendHunting(g.horde, z, 60);
    run(30);
    expect(g.stats.damageTaken).toBeGreaterThan(0);
  });
});

describe('the turned, coming out', () => {
  it('set off down the street instead of crowding the door they came out of', () => {
    const { g, run } = town(NEIGHBOURHOOD, { patients: 1 });
    for (let s = 0; s < 60 * 120 && g.horde.alive === 0; s++) run(DT);
    expect(g.horde.alive).toBeGreaterThan(0);
    // the moment they are out, each has somewhere to go, 20 to 45 m off (one step's walk at most since)
    for (let i = 0; i < g.horde.used; i++) {
      if (g.horde.state[i] >= ZState.DEAD) continue;
      expect(g.horde.state[i]).toBe(ZState.INVESTIGATE);
      const d = Math.hypot(g.horde.tx[i] - g.horde.x[i], g.horde.ty[i] - g.horde.y[i]);
      expect(d).toBeGreaterThan(19);
      expect(d).toBeLessThan(46);
    }
  });
});

describe('a person and a zombie in the same street', () => {
  it('the person runs when the zombie is still a street away, and the zombie comes after them', () => {
    const { g, run } = town([house(1, 300, 300)]);
    emptyStreets(g);
    const i = spawnHuman(g.humans, 0, 0, HState.WALK);
    g.humans.timer[i] = 1000; // standing about
    const z = spawnZombie(g.horde, 28, 0, ZKind.WALKER, ZState.WANDER);
    g.horde.heading[z] = Math.PI; // facing them, 28 m off
    g.horde.timer[z] = 1000;
    g.player = { ...g.player, x: -300, y: -300 }; // the survivor is nowhere near
    run(1);
    expect(g.humans.state[i]).toBe(HState.FLEE);
    expect(g.humans.x[i]).toBeLessThan(0); // away from it
    expect(g.horde.state[z]).toBe(ZState.CHASE);
    expect(g.horde.victim[z]).toBe(i);
    run(3);
    expect(g.horde.x[z]).toBeLessThan(26); // and it is coming
  });
});
