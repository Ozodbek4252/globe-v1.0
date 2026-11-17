import { describe, expect, it } from 'vitest';
import { sunTimes } from '../src/city/sunlight';
import { DAY, fear, nightness, outdoorShare, PANIC_AT, wrapHour } from '../src/sim/daylight';

describe('the hour', () => {
  it('wraps round a 24-hour clock, either way', () => {
    expect(wrapHour(25.5)).toBeCloseTo(1.5, 9);
    expect(wrapHour(-1)).toBe(23);
    expect(wrapHour(24)).toBe(0);
    expect(wrapHour(12)).toBe(12);
    expect(wrapHour(48.25)).toBeCloseTo(0.25, 9);
  });
});

describe('how dark it is', () => {
  const rise = 6.5;
  const set = 18;

  it('is none in broad daylight and full in the dead of night', () => {
    for (const h of [8, 10, 12, 14, 16]) expect(nightness(h, rise, set)).toBe(0);
    for (const h of [20, 22, 0, 2, 4]) expect(nightness(h, rise, set)).toBe(1);
  });

  it('falls dark over about an hour and a half around sunset, and lightens round sunrise', () => {
    let last = 0;
    for (let h = 17; h <= 19.8; h += 0.1) {
      const n = nightness(h, rise, set);
      expect(n).toBeGreaterThanOrEqual(last - 1e-9); // only ever darker in the evening
      last = n;
    }
    expect(nightness(17, rise, set)).toBe(0);
    expect(nightness(18, rise, set)).toBeGreaterThan(0.02); // dusk has begun at sunset
    expect(nightness(18, rise, set)).toBeLessThan(0.3);
    expect(nightness(19.5, rise, set)).toBeGreaterThan(0.95);
    last = 1;
    for (let h = 4; h <= 7.2; h += 0.1) {
      const n = nightness(h, rise, set);
      expect(n).toBeLessThanOrEqual(last + 1e-9); // only ever lighter in the morning
      last = n;
    }
    expect(nightness(6.5, rise, set)).toBeLessThan(0.3);
    expect(nightness(7.5, rise, set)).toBe(0);
  });

  it('stays between 0 and 1 and is continuous across midnight', () => {
    for (let h = 0; h <= 24; h += 0.05) {
      const n = nightness(h, rise, set);
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThanOrEqual(1);
    }
    expect(nightness(23.99, rise, set)).toBeCloseTo(nightness(0, rise, set), 6);
    expect(nightness(24 + 20, rise, set)).toBeCloseTo(nightness(20, rise, set), 9);
  });

  it('follows the sun times it is given: a later sunset is a later night', () => {
    expect(nightness(19, 6, 18)).toBeGreaterThan(nightness(19, 6, 20));
    expect(nightness(5.5, 5, 20)).toBeLessThan(nightness(5.5, 7, 20));
  });

  it('has defaults for a place that does not say', () => {
    expect(nightness(12)).toBe(0);
    expect(nightness(0)).toBe(1);
    expect(DAY.sunrise).toBeLessThan(DAY.sunset);
  });
});

describe('who is out of doors', () => {
  it('is few in the small hours and most in the morning and the evening', () => {
    const night = outdoorShare(3);
    const morning = outdoorShare(8.5);
    const evening = outdoorShare(17.5);
    expect(night).toBeLessThan(0.03);
    expect(morning).toBeGreaterThan(night * 5);
    expect(evening).toBeGreaterThan(night * 5);
    expect(outdoorShare(12)).toBeGreaterThan(0.08);
  });

  it('is a share, always, and changes smoothly through the day', () => {
    let last = outdoorShare(0);
    for (let h = 0; h <= 24; h += 0.05) {
      const s = outdoorShare(h);
      expect(s).toBeGreaterThan(0);
      expect(s).toBeLessThan(0.2);
      expect(Math.abs(s - last)).toBeLessThan(0.01); // no jumps
      last = s;
    }
  });

  it('wraps: 24 is the same as 0, and a later day is the same day', () => {
    expect(outdoorShare(24)).toBeCloseTo(outdoorShare(0), 9);
    expect(outdoorShare(30)).toBeCloseTo(outdoorShare(6), 9);
    expect(outdoorShare(-2)).toBeCloseTo(outdoorShare(22), 9);
  });
});

describe('fear', () => {
  it('is none when nobody has turned, and total when the dead are a few percent of the city', () => {
    expect(fear(0, 30000)).toBe(0);
    expect(fear(PANIC_AT * 30000, 30000)).toBe(1);
    expect(fear(1e6, 30000)).toBe(1);
  });

  it('grows with the dead, in proportion', () => {
    expect(fear(150, 30000)).toBeCloseTo(150 / (PANIC_AT * 30000), 9);
    expect(fear(300, 30000)).toBeGreaterThan(fear(150, 30000));
  });

  it('copes with an empty city', () => {
    expect(fear(5, 0)).toBe(0);
  });
});

describe('when the sun rises and sets', () => {
  const day = Date.UTC(2026, 8, 22); // the day the game uses, near the equinox

  it('is about twelve hours of day near the equinox, anywhere', () => {
    for (const [lon, lat, zone] of [
      [69.28, 41.35, 5], // Tashkent
      [2.29, 48.86, 0], // Paris
      [139.75, 35.66, 9], // Tokyo
      [-73.99, 40.76, -5], // New York
      [151.2, -33.86, 10], // Sydney
    ] as const) {
      const t = sunTimes(lon, lat, day, zone);
      expect(t, `${lon}, ${lat}`).not.toBeNull();
      if (!t) continue;
      expect(t.sunrise).toBeGreaterThan(4);
      expect(t.sunrise).toBeLessThan(8.5);
      expect(t.sunset).toBeGreaterThan(16.5);
      expect(t.sunset).toBeLessThan(20.5);
      expect(t.sunset - t.sunrise).toBeGreaterThan(11);
      expect(t.sunset - t.sunrise).toBeLessThan(13);
    }
  });

  it('puts the sun up at noon and down at midnight, whatever the time zone says', () => {
    const t = sunTimes(69.28, 41.35, day, 5);
    expect(t).not.toBeNull();
    if (!t) return;
    expect(t.sunrise).toBeLessThan(12);
    expect(t.sunset).toBeGreaterThan(12);
  });

  it('has none in the polar night or the midnight sun', () => {
    expect(sunTimes(0, 89.5, Date.UTC(2026, 11, 21), 0)).toBeNull();
    expect(sunTimes(0, 89.5, Date.UTC(2026, 5, 21), 0)).toBeNull();
  });
});
