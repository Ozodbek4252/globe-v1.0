import { geoDistance, geoOrthographic, type GeoProjection } from 'd3-geo';
import type { LonLat } from '../lib/geo';
import type { Country } from '../map/types';

/** d3 rotation: [lambda, phi, gamma]. The view is centred on [-lambda, -phi]. */
export type Rotation = [lambda: number, phi: number, gamma: number];

export const DEFAULT_ROT: Readonly<Rotation> = [-30, -22, 0];
export const MIN_ZOOM = 0.6;
export const MAX_ZOOM = 12;

export function createProjection(): GeoProjection {
  return geoOrthographic().clipAngle(90).precision(0.4);
}

/** Globe radius in pixels at zoom 1. */
export function baseScaleFor(width: number, height: number): number {
  return Math.min(width, height) * 0.42;
}

export function clampZoom(zoom: number): number {
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
}

/** The lon/lat at the centre of the screen. */
export function viewCenter(rot: Readonly<Rotation>): LonLat {
  return [-rot[0], -rot[1]];
}

/**
 * Countries whose bounding circle reaches the visible part of the globe.
 * When the whole sphere is in view there is nothing to skip.
 */
export function visibleCountries(
  countries: readonly Country[],
  view: { rot: Readonly<Rotation>; scale: number; width: number; height: number },
): readonly Country[] {
  const { rot, scale, width, height } = view;
  const reach = Math.asin(Math.min(1, Math.hypot(width, height) / 2 / scale));
  if (reach >= Math.PI / 2 - 1e-6) return countries;
  const center = viewCenter(rot);
  return countries.filter((c) => geoDistance(c.center, center) - c.radius < reach);
}
