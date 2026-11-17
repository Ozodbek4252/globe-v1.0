import { geoBounds, geoPath } from 'd3-geo';
import { createEmitter } from '../lib/emitter';
import { wrapLon } from '../lib/geo';
import { sunPosition } from '../lib/sun';
import { createBorderLod } from '../map/data';
import { DEFAULT_MODE_ID, modeById } from '../map/modes';
import type { Country } from '../map/types';
import { drawScene } from './draw2d';
import { countryAt, type HitContext } from './hitTest';
import { attachInput } from './input';
import { CANVAS_FONT_FACES } from './labels';
import { createLightsGL } from './lightsGL';
import { drawDarkness, drawFallenMarks, drawMarkers, markerAt } from './markers';
import { baseScaleFor, createProjection, DEFAULT_ROT, visibleCountries } from './projection';
import { createState, flyTo, setZoom, stepMotion } from './state';
import {
  DEFAULT_LAYERS,
  type GlobeApi,
  type GlobeMarker,
  type GlobeOptions,
  type HoverInfo,
  type Layers,
  type PicksState,
  type ViewInfo,
} from './types';

/**
 * Create the interactive globe inside `host` and return its API.
 *
 * `host` must be a sized element (it is observed for size changes). The globe adds three
 * canvases to it, one for the map, one for the night lights and, above them, one for the darkness
 * over fallen places, and sets `isolation: isolate` on it so the lights blend with the map and
 * nothing else. A static host is made `position: relative` so the lights canvas can overlay the map;
 * a host that is already positioned is left alone.
 *
 * This module is plain TypeScript and knows nothing about Vue.
 */
export function createGlobe(host: HTMLElement, options: GlobeOptions): GlobeApi {
  const { world } = options;
  const reduceMotion =
    options.reducedMotion ?? matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- DOM ----------
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.style.isolation = 'isolate';

  const lightsCanvas = document.createElement('canvas');
  lightsCanvas.setAttribute('aria-hidden', 'true');
  Object.assign(lightsCanvas.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    display: 'none',
    pointerEvents: 'none',
    mixBlendMode: 'screen',
    zIndex: '1',
  } satisfies Partial<CSSStyleDeclaration>);

  const canvas = document.createElement('canvas');
  canvas.tabIndex = 0;
  canvas.setAttribute(
    'aria-label',
    'Interactive 3D globe. Arrow keys rotate, plus and minus zoom.',
  );
  Object.assign(canvas.style, {
    display: 'block',
    width: '100%',
    height: '100%',
    cursor: 'grab',
    touchAction: 'none',
    outline: 'none',
  } satisfies Partial<CSSStyleDeclaration>);

  // above the lights: a soft black patch over each fallen place, so its lights go out
  const darkCanvas = document.createElement('canvas');
  darkCanvas.setAttribute('aria-hidden', 'true');
  Object.assign(darkCanvas.style, {
    position: 'absolute',
    inset: '0',
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
    zIndex: '2',
  } satisfies Partial<CSSStyleDeclaration>);

  host.append(lightsCanvas, canvas, darkCanvas);

  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser does not support 2D canvas');
  const ctx: CanvasRenderingContext2D = context;
  const darkContext = darkCanvas.getContext('2d');
  if (!darkContext) throw new Error('This browser does not support 2D canvas');
  const darkCtx: CanvasRenderingContext2D = darkContext;

  // ---------- state ----------
  const state = createState();
  const proj = createProjection();
  const path = geoPath(proj, ctx);
  const layers: Layers = { ...DEFAULT_LAYERS, ...options.layers };
  let mode = modeById(options.mode ?? DEFAULT_MODE_ID);

  const picks = new Set<Country>();
  let selected: Country | null = null;
  let hovered: Country | null = null;
  let visible: readonly Country[] = world.countries;
  let detailed = false;

  let markers: readonly GlobeMarker[] = [];
  let chosenMarker: string | null = null;

  const hoverEvents = createEmitter<HoverInfo | null>();
  const markerEvents = createEmitter<string>();
  const zoomInEvents = createEmitter<string>();
  let wheeledIn = 0;
  const picksEvents = createEmitter<PicksState>();
  const viewEvents = createEmitter<ViewInfo>();
  const lightsStatusEvents = createEmitter<string>();

  const lod = createBorderLod(world, {
    onReady: () => {
      state.dirty = true;
    },
  });

  const lights = createLightsGL(lightsCanvas, {
    onStatus: lightsStatusEvents.emit,
    onReady: () => {
      state.dirty = true;
    },
  });

  // ---------- size ----------
  function resize(): void {
    const r = host.getBoundingClientRect();
    state.width = r.width;
    state.height = r.height;
    state.dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = darkCanvas.width = Math.round(r.width * state.dpr);
    canvas.height = darkCanvas.height = Math.round(r.height * state.dpr);
    state.baseScale = baseScaleFor(r.width, r.height);
    state.dirty = true;
  }
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);

  // ---------- drawing ----------
  function draw(): void {
    const { width, height, rot, zoom } = state;
    const scale = state.baseScale * zoom;
    detailed = lod.isDetailed(zoom);
    proj
      .translate([width / 2, height / 2])
      .scale(scale)
      .rotate(rot)
      .precision(detailed ? 0 : 0.4);
    visible = visibleCountries(world.countries, { rot, scale, width, height });
    const sun = mode.id === 'daynight' ? sunPosition(new Date()) : null;

    drawScene({
      ctx,
      proj,
      path,
      width,
      height,
      dpr: state.dpr,
      scale,
      zoom,
      rot,
      mode,
      layers,
      world,
      visible,
      detailed,
      picks,
      hovered,
      selected,
      sun,
    });
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    drawMarkers(ctx, proj, rot, markers, zoom, chosenMarker);

    // WebGL night lights go on top of the 2D map; in Day & night they show on the night side only.
    lights?.render({
      on: layers.lights || sun !== null,
      sun,
      width: canvas.width,
      height: canvas.height,
      scale: scale * state.dpr,
      rot,
    });

    // and over the lights, the dark patches where places have fallen (only while the lights are on)
    darkCtx.setTransform(1, 0, 0, 1, 0, 0);
    darkCtx.clearRect(0, 0, darkCanvas.width, darkCanvas.height);
    if (layers.lights && markers.some((m) => m.fallen)) {
      darkCtx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
      drawDarkness(darkCtx, proj, rot, markers, scale);
      drawFallenMarks(darkCtx, proj, rot, markers);
    }
  }

  function emitView(): void {
    viewEvents.emit({ lat: -state.rot[1], lon: wrapLon(-state.rot[0]), zoom: state.zoom });
  }

  // ---------- loop ----------
  let last = performance.now();
  let frameId = 0;
  let paused = false;
  function frame(now: number): void {
    const dt = Math.min(64, now - last);
    last = now;
    if (!paused) {
      stepMotion(state, now, dt, { spin: layers.spin, hasPicks: picks.size > 0 });
      if (state.dirty) {
        draw();
        emitView();
        state.dirty = false;
      }
    }
    frameId = requestAnimationFrame(frame);
  }

  // the sun moves, so redraw Day & night once a minute
  const sunTimer = setInterval(() => {
    if (mode.id === 'daynight') state.dirty = true;
  }, 60000);

  // Canvas text uses web fonts. Ask for them explicitly (the legacy page only got them as a side
  // effect of DOM text using the same faces) and redraw once they have arrived.
  const redraw = (): void => {
    state.dirty = true;
  };
  void Promise.all(CANVAS_FONT_FACES.map((face) => document.fonts.load(face)))
    .catch(() => []) // offline or blocked: keep the fallback font
    .then(redraw);
  void document.fonts.ready.then(redraw);

  // ---------- picking ----------
  function hitContext(): HitContext {
    return {
      proj,
      width: state.width,
      height: state.height,
      scale: state.baseScale * state.zoom,
      visible,
      detailed: lod.isDetailed(state.zoom),
    };
  }

  function notifyPicks(): void {
    picksEvents.emit({
      picks: [...picks].map((c) => c.code),
      selected: selected?.code ?? null,
    });
  }

  function flyToCountryRecord(country: Country): void {
    const { lx, ly } = country.props;
    const [[x0, y0], [x1, y1]] = geoBounds(country.feature);
    const span = Math.max(Math.abs(y1 - y0), Math.min(Math.abs(x1 - x0), 360 - Math.abs(x1 - x0)));
    const zoom = Math.max(1, Math.min(6, 55 / Math.max(span, 4)));
    flyTo(state, [lx, ly], Math.max(state.zoom, zoom), reduceMotion);
  }

  /** Make `country` the card's country and pick it; optionally fly there. Does not notify. */
  function applySelect(country: Country | null, fly: boolean): void {
    selected = country;
    state.dirty = true;
    if (!country) return;
    picks.add(country);
    if (fly) flyToCountryRecord(country);
  }

  function toggle(country: Country | null): void {
    if (!country) return;
    if (picks.has(country)) {
      picks.delete(country);
      if (selected === country) applySelect([...picks].at(-1) ?? null, false);
    } else {
      applySelect(country, false);
    }
    notifyPicks();
    state.dirty = true;
  }

  function clearPicks(): void {
    picks.clear();
    applySelect(null, false);
    notifyPicks();
  }

  // ---------- input ----------
  const detachInput = attachInput(canvas, state, {
    hover(x, y, event) {
      // over a pin, the pointer says "click me", and the country under it is left out of it
      const overPin = markerAt(proj, state.rot, markers, x, y) !== null;
      canvas.style.cursor = overPin ? 'pointer' : 'grab';
      if (overPin) {
        if (hovered) {
          hovered = null;
          state.dirty = true;
        }
        hoverEvents.emit(null);
        return;
      }
      const country = countryAt(x, y, hitContext());
      if (country !== hovered) {
        hovered = country;
        state.dirty = true;
      }
      if (country && event.pointerType === 'mouse') {
        hoverEvents.emit({ code: country.code, x: event.clientX, y: event.clientY });
      } else {
        hoverEvents.emit(null);
      }
    },
    leave() {
      hovered = null;
      hoverEvents.emit(null);
      state.dirty = true;
    },
    dragMoved() {
      hoverEvents.emit(null);
    },
    click(x, y) {
      const pin = markerAt(proj, state.rot, markers, x, y);
      if (pin) {
        markerEvents.emit(pin.id);
        return;
      }
      toggle(countryAt(x, y, hitContext()));
    },
    escape: clearPicks,
    zoomPastMax() {
      // a few notches past the closest the globe goes, over a pin: into that place
      const pin = markerAt(proj, state.rot, markers, state.width / 2, state.height / 2, 90);
      if (!pin) {
        wheeledIn = 0;
        return;
      }
      if (++wheeledIn >= 3) {
        wheeledIn = 0;
        zoomInEvents.emit(pin.id);
      }
    },
  });

  resize();
  frameId = requestAnimationFrame(frame);

  // ---------- API ----------
  function countryByCode(code: string): Country | undefined {
    return world.byCode.get(code);
  }

  return {
    setMode(id) {
      mode = modeById(id);
      state.dirty = true;
    },
    setLayer(name, on) {
      layers[name] = on;
      state.dirty = true;
    },
    setPaused(value) {
      paused = value;
      if (!value) state.dirty = true; // catch up on anything that changed meanwhile
    },

    selectCountry(code) {
      const country = countryByCode(code);
      if (!country) return;
      applySelect(country, true);
      notifyPicks();
    },
    flyToCountry(code) {
      const country = countryByCode(code);
      if (country) flyToCountryRecord(country);
    },
    togglePick(code) {
      toggle(countryByCode(code) ?? null);
    },
    closeCard() {
      selected = null;
      state.dirty = true;
      notifyPicks();
    },
    clearPicks,

    zoomBy(factor) {
      setZoom(state, state.zoom * factor);
    },
    resetView() {
      clearPicks();
      flyTo(state, [-DEFAULT_ROT[0], -DEFAULT_ROT[1]], 1, reduceMotion);
    },

    setMarkers(next) {
      markers = next;
      state.dirty = true;
    },
    setChosenMarker(id) {
      chosenMarker = id;
      state.dirty = true;
    },
    flyToPoint(lat, lon, zoom = 5) {
      flyTo(state, [lon, lat], Math.max(state.zoom, zoom), reduceMotion);
    },

    onHover: hoverEvents.on,
    onMarkerClick: markerEvents.on,
    onZoomIntoMarker: zoomInEvents.on,
    onPicksChange: picksEvents.on,
    onViewChange: viewEvents.on,
    onLightsStatus: lightsStatusEvents.on,

    destroy() {
      cancelAnimationFrame(frameId);
      clearInterval(sunTimer);
      resizeObserver.disconnect();
      detachInput();
      lights?.dispose();
      hoverEvents.clear();
      markerEvents.clear();
      zoomInEvents.clear();
      picksEvents.clear();
      viewEvents.clear();
      lightsStatusEvents.clear();
      canvas.remove();
      lightsCanvas.remove();
      darkCanvas.remove();
    },
  };
}
