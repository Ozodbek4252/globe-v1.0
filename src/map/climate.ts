import { range } from 'd3-array';
import { geoCircle } from 'd3-geo';
import { interpolateRgb } from 'd3-interpolate';
import type { Polygon } from 'geojson';

/** Physical mode: approximate climate belts, tinted by latitude. [latitude, colour] */
export const climateStops: readonly (readonly [number, string])[] = [
  [-90, '#f2f6f8'],
  [-62, '#e6ecef'],
  [-56, '#a8b49a'],
  [-46, '#5f8550'],
  [-36, '#8e9b5c'],
  [-28, '#c9ad76'],
  [-20, '#bfa66f'],
  [-12, '#78924a'],
  [0, '#3e7a37'],
  [10, '#4d8239'],
  [17, '#a39c5a'],
  [24, '#d7bd85'],
  [31, '#ccb17b'],
  [38, '#97955d'],
  [46, '#6c8b4e'],
  [56, '#4f7348'],
  [64, '#8a9a7e'],
  [70, '#c9d1c4'],
  [78, '#eef2f4'],
  [90, '#f6f8fa'],
];

export function climateAt(lat: number): string {
  for (let i = 1; i < climateStops.length; i++) {
    const [a, ca] = climateStops[i - 1];
    const [b, cb] = climateStops[i];
    if (lat <= b) return interpolateRgb(ca, cb)((lat - a) / (b - a));
  }
  return climateStops.at(-1)![1];
}

const BAND = 2;

export interface ClimateBand {
  color: string;
  /** cap of the sphere from the north pole down to this latitude */
  circle: Polygon;
}

let bands: ClimateBand[] | null = null;

/** Stacked polar caps, drawn from the pole outward so each band overpaints the last. Built once. */
export function climateBands(): readonly ClimateBand[] {
  bands ??= range(-90 + BAND, 90, BAND).map((lat) => ({
    color: climateAt(lat + BAND / 2),
    circle: geoCircle()
      .center([0, 90])
      .radius(90 - lat)(),
  }));
  return bands;
}

/** Base colour under the bands (the southern polar cap). */
export const climateBase = (): string => climateAt(-89);
