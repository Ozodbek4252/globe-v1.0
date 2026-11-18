import { describe, expect, it } from 'vitest';
import { createGame, drainEvents, NO_INPUT, stepGame, type GameOptions } from '../src/sim/game';
import { senses, spellAt, WEATHER, weatherAt } from '../src/sim/weather';
import { weatherFog, weatherPalette } from '../src/city/weatherLook';
import { skyPalette } from '../src/city/sunlight';
import { DT, NEIGHBOURHOOD, town } from './helpers/town';

describe('the weather', () => {
  it('comes in spells by the seed: mostly clear, some rain, some fog, never anything else', () => {
    const counts = { clear: 0, rain: 0, fog: 0 };
    for (let slot = 1; slot <= 2000; slot++) counts[spellAt(slot, 11).kind]++;
    expect(counts.rain / 2000).toBeGreaterThan(0.15);
    expect(counts.rain / 2000).toBeLessThan(0.4);
    expect(counts.fog / 2000).toBeGreaterThan(0.08);
    expect(counts.fog / 2000).toBeLessThan(0.3);
    expect(counts.clear).toBeGreaterThan(counts.rain + counts.fog);
  });

  it('is the same for the same seed and time, changes gently, and stays within bounds', () => {
    expect(weatherAt(1234, 5)).toEqual(weatherAt(1234, 5));
    let last = weatherAt(0, 5);
    for (let s = 1; s < 4 * WEATHER.spell; s++) {
      const w = weatherAt(s, 5);
      expect(w.intensity).toBeGreaterThanOrEqual(0);
      expect(w.intensity).toBeLessThanOrEqual(1);
      if (w.kind === 'clear') expect(w.intensity).toBe(0);
      // a second never changes it much (a kind may switch only while both are faint)
      if (w.kind === last.kind) expect(Math.abs(w.intensity - last.intensity)).toBeLessThan(0.03);
      else expect(Math.max(w.intensity, last.intensity)).toBeLessThan(0.6);
      last = w;
    }
    // over a long while, every kind turns up
    const seen = new Set<string>();
    for (let s = 0; s < 40 * WEATHER.spell; s += 200) seen.add(weatherAt(s, 5).kind);
    expect(seen.size).toBe(3);
  });

  it('can be fixed, for a link or a test', () => {
    expect(weatherAt(99, 1, 'fog')).toEqual({ kind: 'fog', intensity: 1 });
    expect(weatherAt(99, 1, 'clear')).toEqual({ kind: 'clear', intensity: 0 });
  });

  it('dulls the senses: rain the ears and eyes and the street, fog the eyes most of all', () => {
    expect(senses({ kind: 'clear', intensity: 0 })).toEqual({ sight: 1, hearing: 1, outdoors: 1 });
    const rain = senses({ kind: 'rain', intensity: 1 });
    expect(rain.sight).toBeLessThan(1);
    expect(rain.hearing).toBeLessThan(1);
    expect(rain.outdoors).toBeLessThan(0.5);
    const fog = senses({ kind: 'fog', intensity: 1 });
    expect(fog.sight).toBeLessThan(rain.sight);
    expect(fog.hearing).toBe(1);
  });
});

describe('the weather in the game', () => {
  const options: Partial<GameOptions> = { population: true, patients: 0, clumps: 0, routine: true };

  it('keeps people in when it rains', () => {
    const out = (weather: GameOptions['weather']): number => {
      const { g, run } = town(NEIGHBOURHOOD, { ...options, weather }, 800);
      run(40);
      return g.humans.alive;
    };
    const clear = out('clear');
    const rain = out('rain');
    expect(clear).toBeGreaterThan(20);
    expect(rain).toBeLessThan(clear * 0.7);
  });

  it('is on the state from the first step, and the same after a save', () => {
    const { g, world } = town(NEIGHBOURHOOD, { ...options, weather: 'fog' }, 800);
    stepGame(g, NO_INPUT, world, DT);
    drainEvents(g);
    expect(g.weather).toEqual({ kind: 'fog', intensity: 1 });
    const other = createGame(world, { seed: 3, startX: 0, startY: 0, clumps: 0, patients: 0 });
    expect(other.forcedWeather).toBeNull();
    expect(other.weather.kind).toMatch(/clear|rain|fog/);
  });
});

describe('the look of the weather', () => {
  it('leaves a clear sky alone, darkens it for rain, whitens it for fog, and never brightens the night', () => {
    const noon = skyPalette(60);
    expect(weatherPalette(noon, { kind: 'clear', intensity: 0 })).toBe(noon);
    const rain = weatherPalette(noon, { kind: 'rain', intensity: 1 });
    expect(rain.lightIntensity).toBeLessThan(noon.lightIntensity * 0.6);
    expect(rain.horizon[0] + rain.horizon[1] + rain.horizon[2]).toBeLessThan(
      noon.horizon[0] + noon.horizon[1] + noon.horizon[2],
    );
    const fog = weatherPalette(noon, { kind: 'fog', intensity: 1 });
    expect(fog.sunGlow).toBeLessThan(noon.sunGlow * 0.3);
    const night = skyPalette(-20, 0);
    const foggyNight = weatherPalette(night, { kind: 'fog', intensity: 1 });
    const sum = (c: readonly number[]): number => c[0] + c[1] + c[2];
    expect(sum(foggyNight.horizon)).toBeLessThanOrEqual(sum(night.horizon) + 0.1);
  });

  it('draws the fog in: close in a fog, nearer than usual in rain', () => {
    expect(weatherFog({ kind: 'clear', intensity: 0 })).toEqual({ near: 450, far: 3400 });
    const fog = weatherFog({ kind: 'fog', intensity: 1 });
    expect(fog.far).toBeLessThan(400);
    const rain = weatherFog({ kind: 'rain', intensity: 0.5 });
    expect(rain.far).toBeLessThan(3400);
    expect(rain.far).toBeGreaterThan(fog.far);
  });
});
