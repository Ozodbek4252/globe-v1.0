/** Small sphere helpers. Angles are degrees unless a name says otherwise. */

export const RAD = Math.PI / 180;

/** Mean Earth radius in km, used to turn steradians into km². */
export const R_EARTH_KM = 6371;

export type LonLat = [lon: number, lat: number];
export type Vec3 = [x: number, y: number, z: number];

/**
 * Map an angle into [-180, 180). Same formula as the legacy page, so it is only exact
 * for inputs within one turn of the range (see the note in the project summary).
 */
export function wrapLon(deg: number): number {
  return ((deg + 540) % 360) - 180;
}

/** Keep the view away from the poles, where the orthographic rotation flips. */
export function clampLat(lat: number): number {
  return Math.max(-89, Math.min(89, lat));
}

/** The point opposite `p` on the sphere. */
export function antipode([lon, lat]: LonLat): LonLat {
  return [lon + 180, -lat];
}

/** Unit vector for a lon/lat position (x toward lon 0, z toward the north pole). */
export function unitVector([lon, lat]: LonLat): Vec3 {
  const cl = Math.cos(lat * RAD);
  return [cl * Math.cos(lon * RAD), cl * Math.sin(lon * RAD), Math.sin(lat * RAD)];
}
