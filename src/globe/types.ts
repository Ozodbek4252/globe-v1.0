import type { Unsubscribe } from '../lib/emitter';
import type { ModeId } from '../map/modes';
import type { World } from '../map/types';

export type { Unsubscribe };

export type LayerName = 'labels' | 'grid' | 'cities' | 'lights' | 'spin';
export type Layers = Record<LayerName, boolean>;

export const DEFAULT_LAYERS: Readonly<Layers> = {
  labels: true,
  grid: true,
  cities: false,
  lights: false,
  spin: false,
};

/** Pointer position over a country, in client (viewport) pixels, for placing a tooltip. */
export interface HoverInfo {
  code: string;
  x: number;
  y: number;
}

/** Selected countries (in the order they were picked) and which one the info card shows. */
export interface PicksState {
  picks: string[];
  selected: string | null;
}

/** What the globe is centred on. */
export interface ViewInfo {
  lat: number;
  lon: number;
  zoom: number;
}

export interface GlobeOptions {
  /** Loaded data. The globe never mutates it apart from attaching 1:50m borders. */
  world: World;
  mode?: ModeId;
  layers?: Partial<Layers>;
  /** Jump instead of animate. Defaults to the user's prefers-reduced-motion setting. */
  reducedMotion?: boolean;
}

/**
 * The only surface the UI layer touches. Countries are identified by their ADM0_A3 code.
 * Nothing here depends on Vue; subscribe with the on* methods and call the returned function to stop.
 */
export interface GlobeApi {
  setMode(id: ModeId): void;
  setLayer(name: LayerName, on: boolean): void;
  /** Stop drawing and animating (for example while something is covering the globe). */
  setPaused(paused: boolean): void;

  /** Add to the picks, open the info card and fly there (search box, chips). */
  selectCountry(code: string): void;
  /** Fly to a country without changing the picks. */
  flyToCountry(code: string): void;
  /** What a click on the map does: pick the country, or drop it if already picked. */
  togglePick(code: string): void;
  /** Hide the info card but keep the picks (the card's close button). */
  closeCard(): void;
  clearPicks(): void;

  zoomBy(factor: number): void;
  /** Clear the picks and fly back to the starting view. */
  resetView(): void;

  /** The country under the pointer, or null. Fires on every mouse move over the globe. */
  onHover(listener: (hover: HoverInfo | null) => void): Unsubscribe;
  onPicksChange(listener: (state: PicksState) => void): Unsubscribe;
  /** Fires after each redraw. */
  onViewChange(listener: (view: ViewInfo) => void): Unsubscribe;
  /** Night-lights loading status text; empty when there is nothing to say. */
  onLightsStatus(listener: (message: string) => void): Unsubscribe;

  destroy(): void;
}
