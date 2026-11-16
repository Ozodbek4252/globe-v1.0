import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  baseScaleFor,
  clampZoom,
  DEFAULT_ROT,
  MAX_ZOOM,
  MIN_ZOOM,
  viewCenter,
  visibleCountries,
} from '../src/globe/projection';
import { createState, flyTo, setZoom, stepMotion } from '../src/globe/state';
import { loadWorld, type JsonLoader } from '../src/map/data';
import type { World } from '../src/map/types';

const idle = { spin: false, hasPicks: false };

describe('zoom', () => {
  it('clamps to the legacy limits', () => {
    expect(clampZoom(0.1)).toBe(MIN_ZOOM);
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(3)).toBe(3);
    expect([MIN_ZOOM, MAX_ZOOM]).toEqual([0.6, 12]);
  });

  it('setZoom clamps, cancels a flight and marks the view dirty', () => {
    const state = createState();
    flyTo(state, [10, 10], 4, false);
    state.dirty = false;
    setZoom(state, 50);
    expect(state.zoom).toBe(MAX_ZOOM);
    expect(state.flying).toBeNull();
    expect(state.dirty).toBe(true);
  });
});

describe('stepMotion', () => {
  it('coasts on inertia and slows down', () => {
    const state = createState();
    state.vel = [0.05, 0.02];
    const before = [...state.rot];
    stepMotion(state, 0, 16, idle);
    expect(state.rot[0]).toBeCloseTo((before[0] ?? 0) + 0.8, 10);
    expect(state.rot[1]).toBeCloseTo((before[1] ?? 0) + 0.32, 10);
    expect(state.vel[0]).toBeCloseTo(0.05 * 0.94, 10);
    expect(state.dirty).toBe(true);
  });

  it('stops coasting once the speed is negligible', () => {
    const state = createState();
    state.vel = [0.005, 0.005];
    state.dirty = false;
    stepMotion(state, 0, 16, idle);
    expect(state.rot).toEqual([...DEFAULT_ROT]);
    expect(state.dirty).toBe(false);
  });

  it('never carries the view past the latitude limits', () => {
    const state = createState();
    state.rot[1] = 88;
    state.vel = [0, 0.5];
    stepMotion(state, 0, 16, idle);
    expect(state.rot[1]).toBe(89);
  });

  it('spins slowly when enabled, but not while countries are picked or dragging', () => {
    const spinning = createState();
    stepMotion(spinning, 0, 100, { spin: true, hasPicks: false });
    expect(spinning.rot[0]).toBeCloseTo(DEFAULT_ROT[0] + 0.6, 10);

    const picked = createState();
    stepMotion(picked, 0, 100, { spin: true, hasPicks: true });
    expect(picked.rot[0]).toBe(DEFAULT_ROT[0]);

    const dragging = createState();
    dragging.dragging = true;
    stepMotion(dragging, 0, 100, { spin: true, hasPicks: false });
    expect(dragging.rot[0]).toBe(DEFAULT_ROT[0]);
  });
});

describe('flyTo', () => {
  // A flight starts at performance.now(), which has a fractional part. Pin it to a value where
  // (t0 + 1000) - t0 is 999.9999999999999, which once made this suite fail on CI but not locally.
  beforeEach(() => {
    vi.spyOn(performance, 'now').mockReturnValue(147.209915);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('animates over one second with ease in-out and then stops', () => {
    const state = createState();
    flyTo(state, [60, 40], 3, false);
    const flight = state.flying;
    if (!flight) throw new Error('no flight started');

    stepMotion(state, flight.t0 + 500, 16, idle); // halfway: cubic in-out is exactly half
    expect(state.zoom).toBeCloseTo(2, 10);
    expect(state.flying).not.toBeNull();

    // Step just past the end: landing exactly on t0 + dur is at the mercy of float rounding.
    stepMotion(state, flight.t0 + flight.dur + 1, 16, idle);
    expect(state.rot).toEqual([-60, -40, 0]);
    expect(state.zoom).toBe(3);
    expect(state.flying).toBeNull();
  });

  it('takes the short way round the globe', () => {
    const state = createState();
    state.rot = [170, 0, 0]; // looking at lon -170
    flyTo(state, [170, 0], undefined, false); // target lon 170: 20° away through the date line
    const flight = state.flying;
    if (!flight) throw new Error('no flight started');
    stepMotion(state, flight.t0 + flight.dur + 1, 16, idle);
    expect(state.rot[0]).toBe(190);
  });

  it('keeps the current zoom when none is given and stops any coasting', () => {
    const state = createState();
    state.zoom = 2.5;
    state.vel = [1, 1];
    flyTo(state, [0, 0], undefined, false);
    expect(state.vel).toEqual([0, 0]);
    const flight = state.flying;
    if (!flight) throw new Error('no flight started');
    expect(flight.iz(1)).toBe(2.5);
  });

  it('jumps straight there with reduced motion', () => {
    const state = createState();
    flyTo(state, [60, 40], 3, true);
    expect(state.flying).toBeNull();
    expect(state.rot).toEqual([-60, -40, 0]);
    expect(state.zoom).toBe(3);
    expect(state.dirty).toBe(true);
  });
});

describe('visibleCountries', () => {
  let world: World;
  beforeAll(async () => {
    const fromDisk: JsonLoader = async (path) =>
      JSON.parse(await readFile(resolve('public', path), 'utf8')) as unknown;
    world = await loadWorld(fromDisk);
  });

  it('skips nothing while the whole globe is in view', () => {
    const scale = baseScaleFor(990, 800);
    const visible = visibleCountries(world.countries, {
      rot: [...DEFAULT_ROT],
      scale,
      width: 990,
      height: 800,
    });
    expect(visible).toBe(world.countries);
  });

  it('keeps only countries near the view when zoomed in', () => {
    const scale = baseScaleFor(990, 800) * 8;
    const visible = visibleCountries(world.countries, {
      rot: [-64, -41, 0], // looking at Uzbekistan
      scale,
      width: 990,
      height: 800,
    });
    const codes = new Set(visible.map((c) => c.code));
    expect(codes.has('UZB')).toBe(true);
    expect(codes.has('KAZ')).toBe(true);
    expect(codes.has('BRA')).toBe(false);
    expect(codes.has('AUS')).toBe(false);
    expect(visible.length).toBeLessThan(world.countries.length / 3);
  });

  it('centres the view on the negated rotation', () => {
    expect(viewCenter([-30, -22, 0])).toEqual([30, 22]);
  });
});
