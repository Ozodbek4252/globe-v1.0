import type { GeoPath, GeoProjection } from 'd3-geo';
import type { LonLat } from '../lib/geo';
import type { ModeDef } from '../map/modes';
import type { Country, World } from '../map/types';
import type { Rotation } from './projection';
import type { Layers } from './types';

/** Everything the 2D renderer needs for one frame. Built fresh each frame by createGlobe. */
export interface Scene {
  ctx: CanvasRenderingContext2D;
  /** already translated, scaled and rotated for this frame */
  proj: GeoProjection;
  /** draws onto ctx */
  path: GeoPath;
  /** CSS pixels */
  width: number;
  height: number;
  dpr: number;
  /** globe radius in CSS pixels: baseScale * zoom */
  scale: number;
  zoom: number;
  rot: Readonly<Rotation>;
  mode: ModeDef;
  layers: Readonly<Layers>;
  world: World;
  /** countries that can be on screen this frame */
  visible: readonly Country[];
  /** use the 1:50m borders */
  detailed: boolean;
  picks: ReadonlySet<Country>;
  hovered: Country | null;
  selected: Country | null;
  /** sub-solar point in Day & night mode, otherwise null */
  sun: LonLat | null;
}
