import { easeCubicInOut } from 'd3-ease';
import { interpolateArray, interpolateNumber } from 'd3-interpolate';
import { clampLat, wrapLon, type LonLat } from '../lib/geo';
import { clampZoom, DEFAULT_ROT, type Rotation } from './projection';

/** An animated move to a new rotation and zoom. */
export interface Flight {
  /** performance.now() when it started */
  t0: number;
  /** milliseconds */
  dur: number;
  ir: (t: number) => Rotation;
  iz: (t: number) => number;
}

/** The mutable view state shared by the render loop, input handling and the API. */
export interface GlobeState {
  /** stage size in CSS pixels */
  width: number;
  height: number;
  /** device pixel ratio, capped at 2 */
  dpr: number;
  /** globe radius in CSS pixels at zoom 1 */
  baseScale: number;
  rot: Rotation;
  zoom: number;
  /** inertia, in degrees per millisecond */
  vel: [number, number];
  flying: Flight | null;
  dragging: boolean;
  /** something changed: redraw on the next frame */
  dirty: boolean;
}

export function createState(): GlobeState {
  return {
    width: 0,
    height: 0,
    dpr: 1,
    baseScale: 300,
    rot: [...DEFAULT_ROT],
    zoom: 1,
    vel: [0, 0],
    flying: null,
    dragging: false,
    dirty: true,
  };
}

export function setZoom(state: GlobeState, zoom: number): void {
  state.zoom = clampZoom(zoom);
  state.flying = null;
  state.dirty = true;
}

const FLIGHT_MS = 1000;
const SPIN_DEG_PER_MS = 0.006;

/** Advance flight, inertia and auto-spin by one frame. */
export function stepMotion(
  state: GlobeState,
  now: number,
  dt: number,
  options: { spin: boolean; hasPicks: boolean },
): void {
  const { flying } = state;
  if (flying) {
    const t = Math.min(1, (now - flying.t0) / flying.dur);
    const e = easeCubicInOut(t);
    state.rot = flying.ir(e);
    state.zoom = flying.iz(e);
    state.dirty = true;
    if (t >= 1) state.flying = null;
  } else if (!state.dragging) {
    const [vx, vy] = state.vel;
    if (Math.abs(vx) > 0.01 || Math.abs(vy) > 0.01) {
      state.rot[0] += vx * dt;
      state.rot[1] = clampLat(state.rot[1] + vy * dt);
      const decay = Math.pow(0.94, dt / 16);
      state.vel[0] *= decay;
      state.vel[1] *= decay;
      state.dirty = true;
    } else if (options.spin && !options.hasPicks) {
      state.rot[0] += SPIN_DEG_PER_MS * dt;
      state.dirty = true;
    }
  }
}

/** Centre the view on a lon/lat, optionally changing zoom, taking the short way round. */
export function flyTo(
  state: GlobeState,
  [lon, lat]: LonLat,
  zoom: number | undefined,
  reduceMotion: boolean,
): void {
  const target: Rotation = [-lon, -lat, 0];
  target[0] = state.rot[0] + wrapLon(target[0] - state.rot[0]);
  const toZoom = zoom ?? state.zoom;
  if (reduceMotion) {
    state.rot = target;
    state.zoom = toZoom;
    state.dirty = true;
    return;
  }
  state.flying = {
    t0: performance.now(),
    dur: FLIGHT_MS,
    ir: interpolateArray([...state.rot], target),
    iz: interpolateNumber(state.zoom, toZoom),
  };
  state.vel = [0, 0];
}
