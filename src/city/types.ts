/**
 * The compact city format the game loads (public/cities/<id>.json), produced from OpenStreetMap by
 * scripts/fetch-city.mjs.
 *
 * Coordinates are metres: x grows east, y grows north, the origin is the district centre. Rings and
 * lines are flat arrays [x0, y0, x1, y1, ...] rounded to 0.1 m. Rings are not closed (the first point
 * is not repeated); outer rings run counter-clockwise and holes clockwise.
 */

export type BuildingKind =
  'house' | 'apartments' | 'commercial' | 'industrial' | 'civic' | 'religious' | 'garage' | 'other';

export interface CityBuilding {
  /** OSM id. Stable, and the seed for per-building variation. */
  id: number;
  outer: number[];
  holes?: number[][];
  /** Wall height in metres. */
  height: number;
  /** True when the height was guessed (OSM had neither a height nor a levels tag). */
  estimated: boolean;
  kind: BuildingKind;
  /** OSM roof:shape, when tagged. */
  roof?: string;
  name?: string;
}

export type RoadKind =
  | 'motorway'
  | 'trunk'
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'residential'
  | 'service'
  | 'pedestrian'
  | 'path';

export interface CityRoad {
  kind: RoadKind;
  points: number[];
  /** Metres. */
  width: number;
  bridge?: boolean;
  name?: string;
}

export type AreaKind =
  | 'water'
  | 'park'
  | 'grass'
  | 'forest'
  | 'sport'
  | 'cemetery'
  | 'farmland'
  | 'sand'
  | 'plaza'
  | 'parking';

export interface CityArea {
  kind: AreaKind;
  outer: number[];
  holes?: number[][];
}

export type WaterwayKind = 'river' | 'canal' | 'stream';

export interface CityWaterway {
  kind: WaterwayKind;
  points: number[];
  width: number;
}

export interface CityTower {
  x: number;
  y: number;
  /** Metres. */
  height: number;
  kind: 'tower' | 'mast' | 'chimney' | 'water_tower';
  name?: string;
}

export interface CityData {
  version: 1;
  id: string;
  name: string;
  /** [longitude, latitude] of the origin. */
  center: [number, number];
  /** The playable area is the square from -halfSize to +halfSize on both axes, in metres. */
  halfSize: number;
  /**
   * For a tile of a bigger city: where this square's centre is, in metres east and north of `center`
   * (the whole city's origin). Absent for a map that stands on its own.
   */
  origin?: [number, number];
  buildings: CityBuilding[];
  roads: CityRoad[];
  areas: CityArea[];
  waterways: CityWaterway[];
  /** Flat [x0, y0, x1, y1, ...] positions of mapped trees. */
  trees: number[];
  towers: CityTower[];
  attribution: string;
  /** ISO date of the OpenStreetMap extract. */
  generated: string;
}
