import type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon } from 'geojson';
import type { LonLat } from '../lib/geo';

/** Properties of a 1:110m country feature, as extracted from the legacy page. */
export interface CountryProps {
  /** name */
  n: string;
  /** formal name */
  f: string;
  /** ADM0_A3 code, unique, also the key into countries-50m.json */
  a: string;
  /** continent */
  c: string;
  /** subregion */
  s: string;
  /** population (2019 estimate) */
  p: number;
  /** GDP, millions of US dollars (2019 estimate) */
  g: number;
  /** World Bank income group */
  i: string;
  /** Natural Earth map colour index, 1 to 7 */
  m: number;
  /** capital city name */
  cap: string;
  /** label anchor */
  lx: number;
  ly: number;
  /** label rank: lower ranks are labelled first and from further out */
  lr: number;
}

/**
 * One country: the 110m feature plus values derived once at load.
 * Holds geometry, so keep it out of Vue reactivity (the world is markRaw'd).
 */
export interface Country {
  /** same as props.a */
  code: string;
  props: CountryProps;
  feature: Feature<Polygon | MultiPolygon, CountryProps>;
  /** 1:50m feature, filled in once countries-50m.json has loaded */
  hi: Feature<Geometry, CountryProps> | null;
  /** km², measured from the simplified borders */
  area: number;
  /** people per km², null without population data */
  dens: number | null;
  /** GDP per person in US dollars, null without data */
  gpc: number | null;
  /** bounding circle, used to skip countries that are off screen */
  center: LonLat;
  /** bounding circle radius in radians */
  radius: number;
}

export interface City {
  name: string;
  lon: number;
  lat: number;
  pop: number;
  capital: boolean;
}

export interface World {
  countries: Country[];
  byCode: Map<string, Country>;
  /** countries sorted by label rank (stable), so labels can be filtered without sorting each frame */
  labelOrder: Country[];
  rivers: FeatureCollection<Geometry, { n: string }>;
  lakes: FeatureCollection<Geometry, { n: string }>;
  cities: City[];
  /** the subset of cities flagged as capitals; these are the ones drawn */
  capitals: City[];
}

/** countries-50m.json: geometry parts per ADM0_A3 code. */
export type HiBorders = Record<string, Geometry[]>;
