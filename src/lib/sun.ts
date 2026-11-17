import type { LonLat } from './geo';

/** Local time runs about an hour ahead of UTC for every 15 degrees east (Tashkent, at 69 E, is UTC+5). */
export const utcOffsetHours = (longitude: number): number => Math.round(longitude / 15);

const J2000_NOON_UTC = Date.UTC(2000, 0, 1, 12);
const MS_PER_DAY = 864e5;

/**
 * Sub-solar point (where the sun is straight overhead) for a moment in time.
 * Low-precision solar coordinates (about 0.01° in latitude), good for a day/night terminator.
 * Returns [longitude, latitude] in degrees, longitude in [-180, 180).
 */
export function sunPosition(date: Date | number): LonLat {
  const rad = Math.PI / 180;
  const d = (Number(date) - J2000_NOON_UTC) / MS_PER_DAY; // days since J2000.0
  const g = (357.529 + 0.98560028 * d) * rad; // mean anomaly
  const q = 280.459 + 0.98564736 * d; // mean longitude
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad; // ecliptic longitude
  const e = (23.439 - 0.00000036 * d) * rad; // obliquity of the ecliptic
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L)) / rad;
  const gmst = (((18.697374558 + 24.06570982441908 * d) % 24) + 24) % 24; // hours
  let lon = ra - gmst * 15;
  lon = ((lon + 540) % 360) - 180;
  return [lon, dec / rad];
}
