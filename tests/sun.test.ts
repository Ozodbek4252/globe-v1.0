import { describe, expect, it } from 'vitest';
import { sunPosition } from '../src/lib/sun';

describe('sunPosition', () => {
  // Golden values: the output of the original function in the first single-file index.html
  // (git commit ac482a7) for these moments.
  const golden: [string, number, number][] = [
    ['2000-01-01T12:00:00Z', 0.8241750650725521, -23.033503799852458],
    ['2000-01-01T18:00:00Z', -89.14623157619098, -23.013430209602173],
    ['2024-03-20T03:06:00Z', 135.35623067145355, 0.0009939480406432912],
    ['2024-06-20T20:51:00Z', -132.30418374030705, 23.43578254672871],
    ['2024-12-21T09:20:00Z', 39.56161297498738, -23.43571646252048],
    ['2026-11-16T09:30:00Z', 33.68330366284101, -18.776625972502533],
    ['1999-07-04T00:00:00Z', -178.94529164991337, 22.93193634359263],
    ['2038-01-19T03:14:07Z', 134.11976143331924, -20.327201194259576],
  ];

  it.each(golden)('matches the legacy implementation at %s', (iso, lon, lat) => {
    const [gotLon, gotLat] = sunPosition(new Date(iso));
    expect(gotLon).toBeCloseTo(lon, 6);
    expect(gotLat).toBeCloseTo(lat, 6);
  });

  // Independent checks against astronomy, so a bug copied from the legacy code would still show up.
  describe('against known astronomy', () => {
    it('J2000.0: declination -23.03°, sun just east of Greenwich (equation of time ≈ -3.3 min)', () => {
      const [lon, lat] = sunPosition(new Date('2000-01-01T12:00:00Z'));
      expect(lat).toBeCloseTo(-23.03, 1);
      expect(lon).toBeGreaterThan(0.7);
      expect(lon).toBeLessThan(1.0);
    });

    it('is on the equator at the March 2024 equinox (03:06 UTC)', () => {
      const [, lat] = sunPosition(new Date('2024-03-20T03:06:00Z'));
      expect(Math.abs(lat)).toBeLessThan(0.05);
    });

    it('reaches the tropics at the solstices (axial tilt ≈ 23.44°)', () => {
      const [, june] = sunPosition(new Date('2024-06-20T20:51:00Z'));
      const [, december] = sunPosition(new Date('2024-12-21T09:20:00Z'));
      expect(june).toBeCloseTo(23.44, 1);
      expect(december).toBeCloseTo(-23.44, 1);
    });

    it('moves west by 15° per hour', () => {
      const [a] = sunPosition(new Date('2024-05-01T06:00:00Z'));
      const [b] = sunPosition(new Date('2024-05-01T07:00:00Z'));
      const step = (((b - a + 540) % 360) - 180) * -1; // westward degrees, wrapped
      expect(step).toBeGreaterThan(14.95);
      expect(step).toBeLessThan(15.05);
    });

    it('stays within valid longitude and latitude ranges', () => {
      for (let day = 0; day < 366; day += 7) {
        const [lon, lat] = sunPosition(Date.UTC(2025, 0, 1 + day, day % 24));
        expect(lon).toBeGreaterThanOrEqual(-180);
        expect(lon).toBeLessThan(180);
        expect(Math.abs(lat)).toBeLessThanOrEqual(23.45);
      }
    });
  });

  it('accepts a Date or a millisecond timestamp', () => {
    const iso = '2024-06-20T20:51:00Z';
    expect(sunPosition(Date.parse(iso))).toEqual(sunPosition(new Date(iso)));
  });
});
