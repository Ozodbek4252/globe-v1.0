// Procedural textures, drawn once on a canvas: building facades with window bays (and a matching map of
// which windows are lit at night), road markings, ground grain and the perimeter glow. Browser only.
// Everything is seeded, so the city looks the same on every visit.

import {
  CanvasTexture,
  ClampToEdgeWrapping,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three';
import { hash01 } from '../lib/hash';
import { FACADE } from './geometry';

function canvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const el = document.createElement('canvas');
  el.width = width;
  el.height = height;
  const ctx = el.getContext('2d');
  if (!ctx) throw new Error('2D canvas is not available');
  return [el, ctx];
}

function texture(el: HTMLCanvasElement, anisotropy: number, repeat = true): CanvasTexture {
  const t = new CanvasTexture(el);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = repeat ? RepeatWrapping : ClampToEdgeWrapping;
  t.minFilter = LinearMipmapLinearFilter;
  t.anisotropy = anisotropy;
  return t;
}

const CELL = 64;

export interface FacadeTextures {
  /** Wall and window colour, multiplied by the per-vertex wall colour. */
  map: CanvasTexture;
  /** Which windows glow at night. */
  emissive: CanvasTexture;
}

/**
 * An 8 x 8 grid of window bays. One bay is one tile (FACADE.tileW by FACADE.tileH metres) on the
 * wall, so a floor is one row and a bay of the building is one column.
 */
export function createFacadeTextures(anisotropy: number): FacadeTextures {
  const size = CELL * FACADE.cols;
  const [wall, w] = canvas(size, size);
  const [glow, g] = canvas(size, size);
  w.fillStyle = '#ffffff';
  w.fillRect(0, 0, size, size);
  g.fillStyle = '#000000';
  g.fillRect(0, 0, size, size);

  for (let row = 0; row < FACADE.rows; row++) {
    for (let col = 0; col < FACADE.cols; col++) {
      const x = col * CELL;
      const y = row * CELL;
      const r = (salt: number): number => hash01(row * 97 + col, salt);

      // a faint band at the floor line, so walls read as storeys
      w.fillStyle = 'rgba(0,0,0,0.07)';
      w.fillRect(x, y + CELL - 5, CELL, 5);
      w.fillStyle = 'rgba(255,255,255,0.25)';
      w.fillRect(x, y, CELL, 2);

      // window
      const wx = x + 15;
      const wy = y + 12;
      const ww = CELL - 30;
      const wh = CELL - 28;
      // the frame
      w.fillStyle = '#d9d6cf';
      w.fillRect(wx - 2, wy - 2, ww + 4, wh + 4);
      // the glass: dark, a little different in each bay; some show a bright curtain
      const curtain = r(1) < 0.22;
      const lum = 17 + r(2) * 14;
      w.fillStyle = curtain
        ? `hsl(40, 30%, ${46 + r(3) * 16}%)`
        : `hsl(${205 + r(4) * 20}, 22%, ${lum}%)`;
      w.fillRect(wx, wy, ww, wh);
      // a soft reflection of the sky across the upper part
      const refl = w.createLinearGradient(wx, wy, wx + ww, wy + wh);
      refl.addColorStop(0, 'rgba(190,215,255,0.34)');
      refl.addColorStop(0.5, 'rgba(190,215,255,0.05)');
      refl.addColorStop(1, 'rgba(190,215,255,0)');
      w.fillStyle = refl;
      w.fillRect(wx, wy, ww, wh);
      // mullion and sill
      w.fillStyle = '#c4c1ba';
      w.fillRect(wx + ww / 2 - 1, wy, 2, wh);
      w.fillStyle = 'rgba(0,0,0,0.28)';
      w.fillRect(wx - 3, wy + wh + 2, ww + 6, 3);

      // night: a share of the windows are lit, warm or the blue of a television
      const lit = r(5);
      if (lit < 0.3) {
        const warm = r(6) > 0.12;
        g.fillStyle = warm
          ? `rgb(255, ${190 + Math.floor(r(7) * 40)}, ${110 + Math.floor(r(8) * 50)})`
          : 'rgb(150, 190, 255)';
        g.fillRect(wx, wy, ww, wh);
        g.fillStyle = 'rgba(0,0,0,0.35)';
        g.fillRect(wx + ww / 2 - 1, wy, 2, wh);
      }
    }
  }
  return { map: texture(wall, anisotropy), emissive: texture(glow, anisotropy) };
}

/** Asphalt with edge lines and a dashed centre line. Across the road is v, along it is u (8 m per repeat). */
export function createRoadTexture(anisotropy: number): CanvasTexture {
  const [el, ctx] = canvas(256, 128);
  ctx.fillStyle = '#4b4e52';
  ctx.fillRect(0, 0, 256, 128);
  for (let i = 0; i < 2600; i++) {
    const x = hash01(i, 1) * 256;
    const y = hash01(i, 2) * 128;
    const v = 58 + Math.floor(hash01(i, 3) * 40);
    ctx.fillStyle = `rgba(${v},${v},${v + 3},${0.18 + hash01(i, 4) * 0.25})`;
    ctx.fillRect(x, y, 1 + hash01(i, 5) * 2, 1 + hash01(i, 6) * 2);
  }
  // edge lines
  ctx.fillStyle = 'rgba(232,230,220,0.72)';
  ctx.fillRect(0, 8, 256, 3);
  ctx.fillRect(0, 117, 256, 3);
  // dashed centre line
  ctx.fillStyle = 'rgba(240,232,200,0.85)';
  ctx.fillRect(10, 62, 120, 4);
  return texture(el, anisotropy);
}

/** Fine grain for the ground, so large flat areas do not look like plastic. Tiles every 40 m. */
export function createGroundTexture(anisotropy: number): CanvasTexture {
  const [el, ctx] = canvas(256, 256);
  ctx.fillStyle = '#ececec';
  ctx.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 5200; i++) {
    const x = hash01(i, 11) * 256;
    const y = hash01(i, 12) * 256;
    const v = 190 + Math.floor(hash01(i, 13) * 65);
    ctx.fillStyle = `rgba(${v},${v},${v},${0.2 + hash01(i, 14) * 0.3})`;
    const s = 1 + hash01(i, 15) * 3;
    ctx.fillRect(x, y, s, s);
  }
  for (let i = 0; i < 60; i++) {
    const x = hash01(i, 21) * 256;
    const y = hash01(i, 22) * 256;
    const rad = 10 + hash01(i, 23) * 28;
    const grad = ctx.createRadialGradient(x, y, 0, x, y, rad);
    grad.addColorStop(0, 'rgba(120,120,120,0.10)');
    grad.addColorStop(1, 'rgba(120,120,120,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  return texture(el, anisotropy);
}

/** A soft round glow: bright in the middle, fading to nothing at the edge. For lamp light pools. */
export function createGlowTexture(): CanvasTexture {
  const [el, ctx] = canvas(128, 128);
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
  grad.addColorStop(0.6, 'rgba(255,255,255,0.15)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 128, 128);
  const t = new CanvasTexture(el);
  t.colorSpace = SRGBColorSpace;
  t.wrapS = t.wrapT = ClampToEdgeWrapping;
  return t;
}

/** A vertical fade (opaque at the bottom, clear at the top) for the quarantine perimeter wall. */
export function createPerimeterTexture(): CanvasTexture {
  const [el, ctx] = canvas(8, 128);
  const grad = ctx.createLinearGradient(0, 128, 0, 0);
  grad.addColorStop(0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.15, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 8, 128);
  const t = new CanvasTexture(el);
  t.colorSpace = SRGBColorSpace;
  return t;
}
