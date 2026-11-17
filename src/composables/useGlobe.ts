import {
  computed,
  markRaw,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  shallowRef,
  type ShallowRef,
} from 'vue';
import { createGlobe } from '../globe/createGlobe';
import { DEFAULT_ROT } from '../globe/projection';
import {
  DEFAULT_LAYERS,
  type GlobeApi,
  type GlobeMarker,
  type HoverInfo,
  type LayerName,
  type Layers,
  type Unsubscribe,
  type ViewInfo,
} from '../globe/types';
import { wrapLon } from '../lib/geo';
import { readStored, writeStored } from '../lib/storage';
import { loadWorld } from '../map/data';
import { cardInfo } from '../map/info';
import { DEFAULT_MODE_ID, isModeId, modeById, tooltipValue, type ModeId } from '../map/modes';
import { findCountry } from '../map/search';
import type { Country, World } from '../map/types';

const MODE_KEY = 'atlas-mode';

export interface PickItem {
  code: string;
  name: string;
}

export interface TipInfo {
  name: string;
  value: string;
  x: number;
  y: number;
}

/**
 * The only place Vue meets the globe. It owns the small UI state (current mode, picks, hovered
 * country, layer flags, view readout) and forwards actions to the GlobeApi.
 *
 * The world (all the geometry) is kept in a markRaw'd shallowRef and never made reactive.
 */
export function useGlobe(host: Readonly<ShallowRef<HTMLElement | null>>) {
  const world = shallowRef<World | null>(null);
  const loadError = ref('');

  const saved = readStored(MODE_KEY);
  const modeId = ref<ModeId>(isModeId(saved) ? saved : DEFAULT_MODE_ID);
  const layers = reactive<Layers>({ ...DEFAULT_LAYERS });
  const picks = shallowRef<string[]>([]);
  const selected = ref<string | null>(null);
  const hover = shallowRef<HoverInfo | null>(null);
  const view = shallowRef<ViewInfo>({
    lat: -DEFAULT_ROT[1],
    lon: wrapLon(-DEFAULT_ROT[0]),
    zoom: 1,
  });
  const lightsStatus = ref('');

  // Not reactive: the API object is only ever called, never rendered.
  let globe: GlobeApi | null = null;
  let disposed = false;
  let paused = false; // remembered, because the globe may not exist yet when something covers it
  // likewise the pins: they may be set before the globe has loaded
  let markers: readonly GlobeMarker[] = [];
  let chosenMarker: string | null = null;
  const markerListeners = new Set<(id: string) => void>();
  const unsubscribe: Unsubscribe[] = [];

  writeStored(MODE_KEY, modeId.value);

  onMounted(async () => {
    let loaded: World;
    try {
      loaded = markRaw(await loadWorld());
    } catch (error) {
      loadError.value = error instanceof Error ? error.message : 'Could not load the map data.';
      return;
    }
    if (disposed || !host.value) return;
    world.value = loaded;
    globe = createGlobe(host.value, { world: loaded, mode: modeId.value, layers: { ...layers } });
    if (paused) globe.setPaused(true);
    globe.setMarkers(markers);
    globe.setChosenMarker(chosenMarker);
    unsubscribe.push(
      globe.onMarkerClick((id) => markerListeners.forEach((listener) => listener(id))),
      globe.onHover((h) => (hover.value = h)),
      globe.onPicksChange((s) => {
        picks.value = s.picks;
        selected.value = s.selected;
      }),
      globe.onViewChange((v) => (view.value = v)),
      globe.onLightsStatus((message) => (lightsStatus.value = message)),
    );
  });

  onBeforeUnmount(() => {
    disposed = true;
    for (const stop of unsubscribe) stop();
    globe?.destroy();
    globe = null;
  });

  // ---------- derived, for the components ----------
  const mode = computed(() => modeById(modeId.value));

  const pickItems = computed<PickItem[]>(() => {
    const byCode = world.value?.byCode;
    return picks.value.flatMap((code) => {
      const country = byCode?.get(code);
      return country ? [{ code, name: country.props.n }] : [];
    });
  });

  const selectedCountry = computed<Country | null>(() =>
    selected.value ? (world.value?.byCode.get(selected.value) ?? null) : null,
  );
  const card = computed(() => (selectedCountry.value ? cardInfo(selectedCountry.value) : null));

  const tip = computed<TipInfo | null>(() => {
    const h = hover.value;
    const country = h && world.value?.byCode.get(h.code);
    if (!h || !country) return null;
    return {
      name: country.props.n,
      value: tooltipValue(mode.value, country),
      x: h.x,
      y: h.y,
    };
  });

  // ---------- actions ----------
  function setMode(id: ModeId): void {
    modeId.value = id;
    globe?.setMode(id);
    writeStored(MODE_KEY, id);
  }

  function setLayer(name: LayerName, on: boolean): void {
    layers[name] = on;
    globe?.setLayer(name, on);
  }

  /** Search box: find by what was typed, then select and fly there. */
  function searchCountry(query: string): void {
    const country = world.value && findCountry(world.value.countries, query);
    if (country) globe?.selectCountry(country.code);
  }

  return {
    world,
    loadError,
    modeId,
    mode,
    layers,
    picks,
    pickItems,
    selected,
    selectedCountry,
    card,
    hover,
    tip,
    view,
    lightsStatus,
    setMode,
    setLayer,
    searchCountry,
    selectCountry: (code: string): void => globe?.selectCountry(code),
    togglePick: (code: string): void => globe?.togglePick(code),
    closeCard: (): void => globe?.closeCard(),
    clearPicks: (): void => globe?.clearPicks(),
    setPaused(value: boolean): void {
      paused = value;
      globe?.setPaused(value);
    },
    zoomIn: (): void => globe?.zoomBy(1.4),
    zoomOut: (): void => globe?.zoomBy(1 / 1.4),
    resetView: (): void => globe?.resetView(),
    setMarkers(next: readonly GlobeMarker[]): void {
      markers = next;
      globe?.setMarkers(next);
    },
    setChosenMarker(id: string | null): void {
      chosenMarker = id;
      globe?.setChosenMarker(id);
    },
    flyToPoint: (lat: number, lon: number, zoom?: number): void =>
      globe?.flyToPoint(lat, lon, zoom),
    /** Called with the id of a pin when it is clicked. Returns a function that stops listening. */
    onMarkerClick(listener: (id: string) => void): () => void {
      markerListeners.add(listener);
      return () => markerListeners.delete(listener);
    },
  };
}
