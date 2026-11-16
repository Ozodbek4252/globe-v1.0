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
import { baseScaleFor, createProjection, DEFAULT_ROT, visibleCountries } from './projection';
import { createState, flyTo, setZoom, stepMotion } from './state';
import {
  DEFAULT_LAYERS,
  type GlobeApi,
  type GlobeOptions,
  type HoverInfo,
  type Layers,
  type PicksState,
  type ViewInfo,
} from './types';

/**
 * Create the interactive globe inside `host` and return its API.
 *
 * `host` must be a sized element (it is observed for size changes). The globe adds two
 * canvases to it, one for the map and one for the night lights, and sets `isolation: isolate`
 * on it so the lights blend with the map and nothing else. A static host is made `position:
 * relative` so the lights canvas can overlay the map; a host that is already positioned is left alone.
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

  host.append(lightsCanvas, canvas);

  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser does not support 2D canvas');
  const ctx: CanvasRenderingContext2D = context;

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

  const hoverEvents = createEmitter<HoverInfo | null>();
  const picksEvents = createEmitter<PicksState>();
  const viewEvents = createEmitter<ViewInfo>();
  const lightsStatusEvents = createEmitter<string>();

  const lod = createBorderLod(world, {
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
    canvas.width = Math.round(r.width * state.dpr);
    canvas.height = Math.round(r.height * state.dpr);
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
      sun: mode.id === 'daynight' ? sunPosition(new Date()) : null,
    });
  }

  function emitView(): void {
    viewEvents.emit({ lat: -state.rot[1], lon: wrapLon(-state.rot[0]), zoom: state.zoom });
  }

  // ---------- loop ----------
  let last = performance.now();
  let frameId = 0;
  function frame(now: number): void {
    const dt = Math.min(64, now - last);
    last = now;
    stepMotion(state, now, dt, { spin: layers.spin, hasPicks: picks.size > 0 });
    if (state.dirty) {
      draw();
      emitView();
      state.dirty = false;
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
      toggle(countryAt(x, y, hitContext()));
    },
    escape: clearPicks,
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

    onHover: hoverEvents.on,
    onPicksChange: picksEvents.on,
    onViewChange: viewEvents.on,
    onLightsStatus: lightsStatusEvents.on,

    destroy() {
      cancelAnimationFrame(frameId);
      clearInterval(sunTimer);
      resizeObserver.disconnect();
      detachInput();
      hoverEvents.clear();
      picksEvents.clear();
      viewEvents.clear();
      lightsStatusEvents.clear();
      canvas.remove();
      lightsCanvas.remove();
    },
  };
}
