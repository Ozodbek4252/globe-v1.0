import { describe, expect, it } from 'vitest';
import { DAY, nightness, outdoorShare } from '../src/sim/daylight';
import { spawnZombie, ZKind, ZState } from '../src/sim/horde';
import { HState } from '../src/sim/humans';
import { stepRoutine } from '../src/sim/game';
import { emptyStreets, house, NEIGHBOURHOOD, town } from './helpers/town';

/** How many of the city's well are out in the street, as a share. */
const outShare = (g: ReturnType<typeof town>['g']): number => g.humans.alive / g.population.healthy;

describe('the clock', () => {
  it('starts in the morning, and at the hour it is told to', () => {
    expect(town(NEIGHBOURHOOD, { cycle: true }).g.clock).toBe(DAY.start);
    expect(town(NEIGHBOURHOOD, { cycle: true, startHour: 17.4 }).g.clock).toBeCloseTo(17.4, 9);
    expect(town(NEIGHBOURHOOD, { startHour: 27 }).g.clock).toBeCloseTo(3, 9); // 27 is 3 the next morning
  });

  it('goes by an hour for each minute of play', () => {
    const { g, run } = town(NEIGHBOURHOOD, { cycle: true, startHour: 9 });
    run(60);
    expect(g.clock).toBeCloseTo(10, 2);
    run(30);
    expect(g.clock).toBeCloseTo(10.5, 2);
    expect(g.time).toBeCloseTo(90, 1);
  });

  it('goes round midnight and starts again', () => {
    const { g, run } = town(NEIGHBOURHOOD, { cycle: true, startHour: 23.5 });
    run(60);
    expect(g.clock).toBeCloseTo(0.5, 2);
    expect(g.clock).toBeGreaterThanOrEqual(0);
    expect(g.clock).toBeLessThan(24);
  });

  it('stands still when told to, and the night with it', () => {
    const { g, run } = town(NEIGHBOURHOOD, { cycle: false, startHour: 22 });
    expect(g.night).toBe(1);
    run(90);
    expect(g.clock).toBe(22);
    expect(g.night).toBe(1);
  });

  it('stops when the survivor is dead', () => {
    const { g, run } = town(NEIGHBOURHOOD, { cycle: true, startHour: 12 });
    run(10);
    const hour = g.clock;
    g.status = 'lost';
    run(30);
    expect(g.clock).toBe(hour);
  });

  it('falls dark with the evening, using the sun times it is given', () => {
    const { g, run } = town(NEIGHBOURHOOD, {
      cycle: true,
      startHour: 16.5,
      sunrise: 6,
      sunset: 18,
    });
    expect(g.night).toBe(0);
    run(60); // half past five
    expect(g.night).toBe(0);
    run(90); // seven
    expect(g.night).toBeGreaterThan(0.3);
    expect(g.night).toBeLessThan(1);
    run(120); // nine
    expect(g.night).toBe(1);
    expect(g.night).toBeCloseTo(nightness(g.clock, 6, 18), 9);
  });

  it('shows in what the game says: the same hour, the same night', () => {
    const a = town(NEIGHBOURHOOD, { startHour: 20, sunrise: 6, sunset: 18 });
    const b = town(NEIGHBOURHOOD, { startHour: 20, sunrise: 6, sunset: 22 });
    expect(a.g.night).toBe(1);
    expect(b.g.night).toBeLessThan(0.2); // the sun sets later there
  });
});

describe('the dead at night, in the game', () => {
  const damageTaken = (hour: number): number => {
    const { g, run } = town(NEIGHBOURHOOD, { startHour: hour, population: false });
    const i = spawnZombie(g.horde, 1, 0, ZKind.WALKER, ZState.CHASE);
    g.horde.pace[i] = 1;
    g.health = 1e6;
    run(15);
    return g.stats.damageTaken;
  };

  it('hit harder and faster than by day', () => {
    const day = damageTaken(12);
    const night = damageTaken(23);
    expect(day).toBeGreaterThan(0);
    expect(night).toBeGreaterThan(day * 1.4);
  });

  it("wear a building's door down faster", () => {
    const doorLeft = (hour: number): number => {
      const t = town([house(1, 100, 100)], { startHour: hour });
      emptyStreets(t.g); // nobody outside to go for instead
      const o = t.g.outbreak;
      o.doorHp[0] = 1000;
      // a zombie six metres from the door, facing it
      const x = o.doorX[0];
      const y = o.doorY[0];
      const away = Math.hypot(x - 110, y - 110) || 1;
      const nx = (x - 110) / away;
      const ny = (y - 110) / away;
      const z = spawnZombie(t.g.horde, x + nx * 6, y + ny * 6, ZKind.WALKER, ZState.WANDER);
      t.g.horde.heading[z] = Math.atan2(-ny, -nx);
      t.g.horde.timer[z] = 1000;
      t.g.horde.pace[z] = 1;
      t.run(25);
      return o.doorHp[0];
    };
    const day = doorLeft(12);
    const night = doorLeft(23);
    expect(day).toBeLessThan(1000); // it did work at the door by day
    expect(1000 - night).toBeGreaterThan((1000 - day) * 1.4);
  });
});

describe('the people of the city through the day', () => {
  it('start with as many out as the hour calls for: few at night, many in the morning rush', () => {
    const small = town(NEIGHBOURHOOD, { startHour: 3 }).g;
    const rush = town(NEIGHBOURHOOD, { startHour: 8.5 }).g;
    expect(outShare(small)).toBeLessThan(outdoorShare(3) * 2 + 0.01);
    expect(outShare(rush)).toBeGreaterThan(outShare(small) * 4);
    expect(outShare(rush)).toBeGreaterThan(0.08);
    expect(outShare(rush)).toBeLessThan(0.2);
  });

  it('go out in the morning: the street fills as the rush begins', () => {
    const { g, run } = town(NEIGHBOURHOOD, { startHour: 4, routine: true });
    const before = g.humans.alive;
    const start = g.population.healthy + g.population.bitten + g.population.zombies;
    g.clock = 8.5; // the cycle is off, so the hour stays where it is put
    run(90);
    expect(g.humans.alive).toBeGreaterThan(before * 4);
    expect(outShare(g)).toBeGreaterThan(outdoorShare(8.5) * 0.8);
    expect(outShare(g)).toBeLessThan(outdoorShare(8.5) * 1.3);
    // they came out of the buildings: nobody was made
    expect(g.population.healthy + g.population.bitten + g.population.zombies).toBe(start);
  });

  it('go home in the evening: the street empties and the buildings fill', () => {
    const { g, run } = town(NEIGHBOURHOOD, { startHour: 17.5, routine: true });
    const out = g.humans.alive;
    const start = g.population.healthy;
    const indoors = (): number => g.outbreak.healthy.reduce((n, v) => n + v, 0);
    const inBefore = indoors();
    expect(out).toBeGreaterThan(30);
    g.clock = 23; // the small hours are coming
    run(150);
    expect(g.humans.alive).toBeLessThan(out * 0.4);
    expect(outShare(g)).toBeLessThan(outdoorShare(23) * 2 + 0.02);
    expect(indoors()).toBeGreaterThan(inBefore); // they are behind their doors again
    expect(g.population.healthy).toBe(start); // none lost on the way
    // and every one of them got in through a door: none stands inside a wall
    for (let i = 0; i < g.humans.used; i++) {
      expect(g.humans.state[i] === HState.FREE || Number.isFinite(g.humans.x[i])).toBe(true);
    }
  });

  it('keep the same crowd out all day if the routine is switched off', () => {
    const { g, run } = town(NEIGHBOURHOOD, { startHour: 4, routine: false });
    const before = g.humans.alive;
    g.clock = 8.5;
    run(60);
    expect(g.humans.alive).toBe(before);
  });

  it('are made and lost by nobody: well, bitten and turned always add up, a whole day through', () => {
    const { g, run } = town(NEIGHBOURHOOD, {
      cycle: true,
      routine: true,
      startHour: 6,
      patients: 2,
    });
    const start = g.population.initial;
    g.health = 1e9; // the clock only runs while the survivor lives
    for (let k = 0; k < 24; k++) {
      run(60); // an hour of the day
      const p = g.population;
      expect(p.healthy + p.bitten + p.zombies).toBe(start);
    }
    expect(g.clock).toBeCloseTo(6, 1); // a whole day has gone by
  }, 120_000);

  it('stay in when the dead fill the streets: the more turned, the fewer out', () => {
    const outAfter = (turned: number): number => {
      const { g, run } = town(NEIGHBOURHOOD, { startHour: 4, routine: true });
      // the dead, indoors and well out of the way: the city can only hear about them
      g.outbreak.undead[0] += turned;
      g.outbreak.healthy[0] -= Math.min(turned, g.outbreak.healthy[0]);
      g.clock = 8.5;
      run(90);
      return g.humans.alive;
    };
    const calm = outAfter(0);
    const afraid = outAfter(40);
    expect(calm).toBeGreaterThan(40);
    expect(afraid).toBeLessThan(calm * 0.6);
  });

  it('do not come out of a building the dead are in', () => {
    const { g, world } = town(NEIGHBOURHOOD, { startHour: 4 });
    emptyStreets(g);
    g.clock = 8.5;
    // with everyone well, the morning rush brings people out...
    for (let k = 0; k < 30; k++) stepRoutine(g, world);
    expect(g.humans.alive).toBeGreaterThan(20);
    // ...but not out of buildings with the dead in them or someone bitten (the outbreak has its own
    // way of emptying a building: they flee, and that is not the day)
    emptyStreets(g);
    for (let b = 0; b < g.outbreak.count; b++) {
      if (b % 2 === 0) g.outbreak.undead[b] = 1;
      else g.outbreak.incubating[b] = 1;
    }
    const before = Array.from(g.outbreak.healthy);
    for (let k = 0; k < 60; k++) stepRoutine(g, world);
    expect(g.humans.alive).toBe(0);
    expect(Array.from(g.outbreak.healthy)).toEqual(before);
  });

  it('only go out of buildings that have people in them, and never from one with a broken door', () => {
    const { g, run } = town([house(1, 100, 100), house(2, 300, 100)], {
      startHour: 4,
      routine: true,
    });
    emptyStreets(g);
    g.outbreak.open[1] = 1;
    g.clock = 8.5;
    const before = g.outbreak.healthy[1];
    run(60);
    expect(g.outbreak.healthy[1]).toBe(before);
    expect(g.humans.alive).toBeGreaterThan(0);
  });
});
