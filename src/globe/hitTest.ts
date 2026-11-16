import { geoContains, type GeoProjection } from 'd3-geo';
import { featureOf } from '../map/data';
import type { Country } from '../map/types';

export interface HitContext {
  /** the projection as configured for the last frame */
  proj: GeoProjection;
  width: number;
  height: number;
  /** globe radius in CSS pixels */
  scale: number;
  visible: readonly Country[];
  detailed: boolean;
}

/** The country under a point on the stage (CSS pixels), or null for sea and space. */
export function countryAt(x: number, y: number, hit: HitContext): Country | null {
  if (Math.hypot(x - hit.width / 2, y - hit.height / 2) > hit.scale) return null;
  const lonLat = hit.proj.invert?.([x, y]);
  if (!lonLat) return null;
  for (const country of hit.visible) {
    if (geoContains(featureOf(country, hit.detailed), lonLat)) return country;
  }
  return null;
}
