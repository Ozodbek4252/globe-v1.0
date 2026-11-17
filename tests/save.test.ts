import { describe, expect, it } from 'vitest';
import {
  createGame,
  drainEvents,
  NO_INPUT,
  stepGame,
  type GameInput,
  type GameOptions,
  type GameState,
} from '../src/sim/game';
import { hordeChecksum } from '../src/sim/horde';
import { isSavedGame, loadGame, saveGame } from '../src/sim/save';
import { DT, NEIGHBOURHOOD, town } from './helpers/town';

/** A game with everything going: people, the outbreak, the day, groups of zombies, the survivor moving. */
const OPTIONS: GameOptions = {
  seed: 9,
  startX: 0,
  startY: 0,
  clumps: 20,
  patients: 2,
  density: 250,
  cycle: true,
  routine: true,
  startHour: 17.5,
};

const moves = (k: number): GameInput => ({
  ...NO_INPUT,
  moveX: Math.cos(k * 0.7),
  moveY: Math.sin(k * 0.7),
  sprint: k % 3 === 0,
  aim: [20, 10],
  fire: k % 2 === 0,
  reload: k % 11 === 0,
  shove: k % 7 === 0,
});

const fingerprint = (g: GameState): string =>
  [
    hordeChecksum(g.horde),
    g.health,
    g.ammo,
    g.reserve,
    g.food,
    g.time,
    g.tick,
    g.clock,
    g.stats.kills,
    g.player.x,
    g.player.y,
    g.rng.state,
    g.horde.rng.state,
    g.humans.rng.state,
    g.humans.alive,
    g.population.healthy,
    g.population.bitten,
    g.population.zombies,
    g.pickups.filter((p) => p.taken).length,
  ].join('|');

describe('saving and loading', () => {
  it('plays on from a save exactly as the original would have', () => {
    const { world } = town(NEIGHBOURHOOD, OPTIONS);
    const original = createGame(world, OPTIONS);
    const step = (g: GameState, k: number): void => {
      for (let s = 0; s < 30; s++) {
        stepGame(g, moves(k), world, DT);
        drainEvents(g);
      }
    };
    for (let k = 0; k < 40; k++) step(original, k);
    // the save is plain data: a structured clone of it is as good as the thing itself
    const saved = structuredClone(saveGame(original, OPTIONS));
    expect(isSavedGame(saved)).toBe(true);
    const copy = loadGame(world, saved);
    expect(fingerprint(copy)).toBe(fingerprint(original));
    for (let k = 40; k < 100; k++) {
      step(original, k);
      step(copy, k);
      expect(fingerprint(copy)).toBe(fingerprint(original));
    }
  }, 60_000);

  it('keeps the survivor, the guns, the supplies and the places as they were', () => {
    const { g, world, run } = town(NEIGHBOURHOOD, { seed: 2 });
    g.health = 37;
    g.food = 61.5;
    g.hasShotgun = true;
    g.weapon = 'shotgun';
    g.ammo = 4;
    g.reserve = 9;
    g.stash.pistol = { ammo: 11, reserve: 30 };
    g.pickups[0].taken = true;
    g.radarOn = true;
    g.used[0] = true;
    run(1);
    const options: GameOptions = { ...OPTIONS, seed: 2, cycle: false, routine: false };
    const loaded = loadGame(world, saveGame(g, options));
    expect(loaded.health).toBeCloseTo(g.health, 6);
    expect(loaded.food).toBeCloseTo(g.food, 6);
    expect(loaded.hasShotgun).toBe(true);
    expect(loaded.weapon).toBe('shotgun');
    expect([loaded.ammo, loaded.reserve]).toEqual([4, 9]);
    expect(loaded.stash.pistol).toEqual({ ammo: 11, reserve: 30 });
    expect(loaded.pickups[0].taken).toBe(true);
    expect(loaded.radarOn).toBe(true);
    expect(loaded.used[0]).toBe(true);
    expect(loaded.time).toBeCloseTo(g.time, 6);
    expect(loaded.events).toEqual([]);
    expect(loaded.cycle).toBe(false);
  });

  it('carries the time of day and the night with it', () => {
    const { g, world } = town(NEIGHBOURHOOD, { startHour: 22, sunrise: 6, sunset: 18 });
    const loaded = loadGame(
      world,
      saveGame(g, { ...OPTIONS, startHour: 22, sunrise: 6, sunset: 18 }),
    );
    expect(loaded.clock).toBe(22);
    expect(loaded.night).toBe(1);
  });

  it('knows a saved game from anything else', () => {
    expect(isSavedGame(null)).toBe(false);
    expect(isSavedGame({})).toBe(false);
    expect(
      isSavedGame({ version: 2, options: {}, game: {}, horde: {}, humans: {}, outbreak: {} }),
    ).toBe(false);
    expect(isSavedGame('paris')).toBe(false);
  });
});
