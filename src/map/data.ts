import type { Feature, FeatureCollection, Geometry } from 'geojson';
import { geoArea, geoCentroid, geoDistance, geoStream } from 'd3-geo';
import { R_EARTH_KM, type LonLat } from '../lib/geo';
import { publicUrl } from '../lib/url';
import type { City, Country, CountryProps, HiBorders, World } from './types';

/** Loads a JSON file from `public/`, given a path relative to it. Swappable for tests. */
export type JsonLoader = (path: string) => Promise<unknown>;

export const fetchJson: JsonLoader = async (path) => {
  const res = await fetch(publicUrl(path));
  if (!res.ok) throw new Error(`Could not load ${path} (${res.status})`);
  return (await res.json()) as unknown;
};

// ---------- 1:110m world ----------

/** Extra radius so a country is not culled the moment its edge touches the screen. */
const BOUND_MARGIN = 0.03;

/** Smallest circle around the centroid that contains every vertex. */
export function boundingCircle(feature: Feature<Geometry>): { center: LonLat; radius: number } {
  const center = geoCentroid(feature);
  let radius = 0;
  geoStream(feature, {
    point(x, y) {
      radius = Math.max(radius, geoDistance(center, [x, y]));
    },
    lineStart() {},
    lineEnd() {},
    polygonStart() {},
    polygonEnd() {},
    sphere() {},
  });
  return { center, radius: radius + BOUND_MARGIN };
}

export function buildCountry(feature: Country['feature']): Country {
  const props = feature.properties;
  const area = geoArea(feature) * R_EARTH_KM * R_EARTH_KM;
  const { center, radius } = boundingCircle(feature);
  return {
    code: props.a,
    props,
    feature,
    hi: null,
    area,
    dens: props.p > 0 ? props.p / area : null,
    gpc: props.p > 0 && props.g > 0 ? (props.g * 1e6) / props.p : null,
    center,
    radius,
  };
}

function featuresOf<P>(raw: unknown, what: string): Feature<Geometry, P>[] {
  const fc = raw as Partial<FeatureCollection<Geometry, P>> | null;
  if (!fc || !Array.isArray(fc.features)) throw new Error(`${what} is not a FeatureCollection`);
  return fc.features;
}

/** cities.json rows are [name, lon, lat, population, isCapital]. */
function parseCities(raw: unknown): City[] {
  if (!Array.isArray(raw)) throw new Error('cities.json is not an array');
  return (raw as [string, number, number, number, number][]).map(
    ([name, lon, lat, pop, capital]) => ({ name, lon, lat, pop, capital: !!capital }),
  );
}

export function buildWorld(raw: {
  countries: unknown;
  rivers: unknown;
  lakes: unknown;
  cities: unknown;
}): World {
  const countries = featuresOf<CountryProps>(raw.countries, 'countries-110m.json').map((f) =>
    buildCountry(f as Country['feature']),
  );
  const cities = parseCities(raw.cities);
  return {
    countries,
    byCode: new Map(countries.map((c) => [c.code, c])),
    labelOrder: [...countries].sort((a, b) => a.props.lr - b.props.lr),
    rivers: { type: 'FeatureCollection', features: featuresOf(raw.rivers, 'rivers.json') },
    lakes: { type: 'FeatureCollection', features: featuresOf(raw.lakes, 'lakes.json') },
    cities,
    capitals: cities.filter((c) => c.capital),
  };
}

/** Fetch the four small data files in parallel and build the world. */
export async function loadWorld(load: JsonLoader = fetchJson): Promise<World> {
  const [countries, rivers, lakes, cities] = await Promise.all([
    load('data/countries-110m.json'),
    load('data/rivers.json'),
    load('data/lakes.json'),
    load('data/cities.json'),
  ]);
  return buildWorld({ countries, rivers, lakes, cities });
}

// ---------- 1:50m borders, loaded the first time the user zooms in ----------

export const HI_ZOOM = 2.6;

/** Build the detailed feature for a country from its 50m geometry parts. */
export function hiFeature(props: CountryProps, parts: Geometry[]): Feature<Geometry, CountryProps> {
  const [first] = parts;
  return {
    type: 'Feature',
    properties: props,
    geometry:
      parts.length === 1 && first ? first : { type: 'GeometryCollection', geometries: parts },
  };
}

export function attachHiBorders(world: World, borders: HiBorders): void {
  for (const country of world.countries) {
    const parts = borders[country.code];
    if (!parts) continue;
    country.hi = hiFeature(country.props, parts);
  }
}

export interface BorderLod {
  /**
   * True when zoomed in far enough and the 50m data has arrived. The first call at a high
   * zoom starts the download (once; a failed download is not retried, as in the legacy page).
   */
  isDetailed(zoom: number): boolean;
}

export function createBorderLod(
  world: World,
  { load = fetchJson, onReady }: { load?: JsonLoader; onReady?: () => void } = {},
): BorderLod {
  let state: 'idle' | 'loading' | 'ready' = 'idle';

  function start(): void {
    state = 'loading';
    load('data/countries-50m.json')
      .then((borders) => {
        attachHiBorders(world, borders as HiBorders);
        state = 'ready';
        onReady?.();
      })
      .catch(() => {});
  }

  return {
    isDetailed(zoom) {
      if (zoom >= HI_ZOOM && state === 'idle') start();
      return zoom >= HI_ZOOM && state === 'ready';
    },
  };
}

/** The feature to draw or hit-test for a country at the current detail level. */
export function featureOf(country: Country, detailed: boolean): Feature<Geometry, CountryProps> {
  return (detailed && country.hi) || country.feature;
}
