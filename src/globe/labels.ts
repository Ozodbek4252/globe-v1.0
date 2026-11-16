import { geoDistance } from 'd3-geo';
import { viewCenter } from './projection';
import type { Scene } from './scene';

const TAU = 2 * Math.PI;

/**
 * The web-font faces drawn on the canvas. Canvas text does not wait for a font that nothing in
 * the DOM has requested, so createGlobe loads these up front and redraws when they arrive.
 */
export const CANVAS_FONT_FACES = ["700 13px 'Alegreya Sans SC'", "500 11.5px 'Alegreya Sans'"];

/** Screen rectangles already taken by labels, so later labels can skip a crowded spot. */
export interface LabelBoxes {
  /** Claim a rectangle unconditionally. */
  reserve(x: number, y: number, w: number, h: number): void;
  /** Claim the rectangle if it overlaps nothing claimed so far. Returns whether it did. */
  tryPlace(x: number, y: number, w: number, h: number): boolean;
}

export function createLabelBoxes(): LabelBoxes {
  const boxes: [number, number, number, number][] = [];
  return {
    reserve(x, y, w, h) {
      boxes.push([x, y, w, h]);
    },
    tryPlace(x, y, w, h) {
      for (const b of boxes) {
        if (x < b[0] + b[2] && x + w > b[0] && y < b[1] + b[3] && y + h > b[1]) return false;
      }
      boxes.push([x, y, w, h]);
      return true;
    },
  };
}

/** Capital-city dots, with names once zoomed in. */
export function drawCapitals(scene: Scene, boxes: LabelBoxes): void {
  const { ctx, proj, zoom, world } = scene;
  const center = viewCenter(scene.rot);
  ctx.font = "500 11.5px 'Alegreya Sans', sans-serif";
  ctx.textBaseline = 'middle';
  for (const city of world.capitals) {
    if (geoDistance([city.lon, city.lat], center) > 1.35) continue;
    const pt = proj([city.lon, city.lat]);
    if (!pt) continue;
    ctx.beginPath();
    ctx.arc(pt[0], pt[1], 2.6, 0, TAU);
    ctx.fillStyle = '#fff';
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = '#111';
    ctx.stroke();
    if (zoom >= 1.8) {
      const w = ctx.measureText(city.name).width;
      if (boxes.tryPlace(pt[0] + 4, pt[1] - 7, w + 4, 14)) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = 'rgba(6,10,19,.8)';
        ctx.strokeText(city.name, pt[0] + 6, pt[1]);
        ctx.fillStyle = '#e8edf5';
        ctx.fillText(city.name, pt[0] + 6, pt[1]);
      }
    }
  }
}

/** Highest label rank shown at a zoom level: more countries are named as you zoom in. */
function maxRankAt(zoom: number): number {
  return zoom < 1.3 ? 3 : zoom < 2 ? 4 : zoom < 3.2 ? 5 : 7;
}

export function drawCountryLabels(scene: Scene, boxes: LabelBoxes): void {
  const { ctx, proj, zoom, world, picks, selected } = scene;
  const center = viewCenter(scene.rot);
  const maxRank = maxRankAt(zoom);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // world.labelOrder is already sorted by rank, so filtering keeps the legacy draw order
  for (const country of world.labelOrder) {
    const p = country.props;
    if (p.lr > maxRank && country !== selected) continue;
    const dist = geoDistance([p.lx, p.ly], center);
    if (dist > 1.25) continue;
    const pt = proj([p.lx, p.ly]);
    if (!pt) continue;
    const size = p.lr <= 2 ? 13 : p.lr <= 4 ? 11.5 : 10.5;
    ctx.font = `700 ${size}px 'Alegreya Sans SC', sans-serif`;
    const text = p.n.toUpperCase();
    const w = ctx.measureText(text).width + 6;
    if (country !== selected && !boxes.tryPlace(pt[0] - w / 2, pt[1] - size / 2 - 2, w, size + 4)) {
      continue;
    }
    const fade = Math.max(0, Math.min(1, (1.25 - dist) / 0.3));
    ctx.globalAlpha = fade;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(6,10,19,.65)';
    ctx.strokeText(text, pt[0], pt[1]);
    ctx.fillStyle = picks.has(country) ? '#fff4dc' : 'rgba(240,244,250,.92)';
    ctx.fillText(text, pt[0], pt[1]);
    ctx.globalAlpha = 1;
  }
}
