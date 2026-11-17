// Places you can play, drawn on the globe: a pin for each, a skull on the ones that have fallen, and a
// patch of darkness over a fallen place when the night lights are on. Plain TypeScript, no Vue.

import { geoDistance, type GeoProjection } from 'd3-geo';
import type { GlobeMarker } from './types';

/** How close (in pixels) a click or hover must be to count as on a marker. */
export const MARKER_HIT = 13;

/**
 * Whether the point faces us: on the near half of the globe. `rot` is the projection's rotation
 * (the point at the centre of the view is [-rot[0], -rot[1]]).
 */
export function facing(rot: readonly [number, number, number], lon: number, lat: number): boolean {
  return geoDistance([lon, lat], [-rot[0], -rot[1]]) < Math.PI / 2 - 0.02;
}

/** Where a marker is on the screen, or null if it is on the far side of the globe. */
export function markerPosition(
  proj: GeoProjection,
  rot: readonly [number, number, number],
  marker: GlobeMarker,
): [number, number] | null {
  if (!facing(rot, marker.lon, marker.lat)) return null;
  return proj([marker.lon, marker.lat]);
}

/** The marker nearest (x, y), if one is within `reach` pixels. */
export function markerAt(
  proj: GeoProjection,
  rot: readonly [number, number, number],
  markers: readonly GlobeMarker[],
  x: number,
  y: number,
  reach: number = MARKER_HIT,
): GlobeMarker | null {
  let best: GlobeMarker | null = null;
  let bestD = reach * reach;
  for (const marker of markers) {
    const at = markerPosition(proj, rot, marker);
    if (!at) continue;
    const d = (at[0] - x) ** 2 + (at[1] - y) ** 2;
    if (d <= bestD) {
      bestD = d;
      best = marker;
    }
  }
  return best;
}

const GOLD = '#f0b54a';
const FALLEN = '#e0483c';

/** Draw the pins (and the names, when zoomed in) on the map canvas. Coordinates are CSS pixels. */
export function drawMarkers(
  ctx: CanvasRenderingContext2D,
  proj: GeoProjection,
  rot: readonly [number, number, number],
  markers: readonly GlobeMarker[],
  zoom: number,
  chosen: string | null,
): void {
  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = "600 12px 'Alegreya Sans', 'Gill Sans', sans-serif";
  for (const marker of markers) {
    const at = markerPosition(proj, rot, marker);
    if (!at) continue;
    const [x, y] = at;
    const fallen = marker.fallen;
    const here = marker.id === chosen;
    const colour = fallen ? FALLEN : GOLD;
    const r = here ? 6.5 : 4.5;
    // a ring that pulses outwards from the chosen one, so it can be found
    if (here) {
      ctx.strokeStyle = colour;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, r + 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = 'rgba(8, 12, 20, 0.85)';
    ctx.beginPath();
    ctx.arc(x, y, r + 1.8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = colour;
    ctx.beginPath();
    if (fallen) {
      // a cross, for a place that has fallen
      const s = r * 0.9;
      ctx.lineWidth = 2.4;
      ctx.strokeStyle = colour;
      ctx.moveTo(x - s, y - s);
      ctx.lineTo(x + s, y + s);
      ctx.moveTo(x + s, y - s);
      ctx.lineTo(x - s, y + s);
      ctx.stroke();
    } else {
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    if (zoom >= 2.2 || here) {
      ctx.lineWidth = 3;
      ctx.strokeStyle = 'rgba(8, 12, 20, 0.9)';
      ctx.strokeText(marker.name, x + r + 6, y);
      ctx.fillStyle = fallen ? '#ffb3ab' : '#fff1d4';
      ctx.fillText(marker.name, x + r + 6, y);
    }
  }
  ctx.restore();
}

/**
 * The darkness over fallen places: a soft black blot where each one's lights were. Drawn on its own
 * canvas above the lights; `scale` is the projection's scale in pixels per radian.
 */
export function drawDarkness(
  ctx: CanvasRenderingContext2D,
  proj: GeoProjection,
  rot: readonly [number, number, number],
  markers: readonly GlobeMarker[],
  scale: number,
): void {
  for (const marker of markers) {
    if (!marker.fallen) continue;
    const at = markerPosition(proj, rot, marker);
    if (!at) continue;
    // the glow of a big city reaches about 100 km, but never so small a patch that it cannot be seen,
    // nor so big it blots out a coast
    const radius = Math.min(120, Math.max(20, (100 / 6371) * scale));
    const g = ctx.createRadialGradient(at[0], at[1], 0, at[0], at[1], radius);
    g.addColorStop(0, 'rgba(2, 4, 8, 0.96)');
    g.addColorStop(0.55, 'rgba(2, 4, 8, 0.8)');
    g.addColorStop(1, 'rgba(2, 4, 8, 0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(at[0], at[1], radius, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** The crosses on fallen places, on the same canvas as the darkness so the darkness does not cover them. */
export function drawFallenMarks(
  ctx: CanvasRenderingContext2D,
  proj: GeoProjection,
  rot: readonly [number, number, number],
  markers: readonly GlobeMarker[],
): void {
  ctx.save();
  ctx.lineWidth = 2.4;
  ctx.strokeStyle = FALLEN;
  for (const marker of markers) {
    if (!marker.fallen) continue;
    const at = markerPosition(proj, rot, marker);
    if (!at) continue;
    const s = 4;
    ctx.beginPath();
    ctx.moveTo(at[0] - s, at[1] - s);
    ctx.lineTo(at[0] + s, at[1] + s);
    ctx.moveTo(at[0] + s, at[1] - s);
    ctx.lineTo(at[0] - s, at[1] + s);
    ctx.stroke();
  }
  ctx.restore();
}
