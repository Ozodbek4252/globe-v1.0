// What the weather does to the picture: the sky's palette greyed and dimmed, and the fog drawn in.
// Pure, so it can be tested without a renderer.

import type { Weather } from '../sim/weather';
import { mix, type Rgb } from './palette';
import type { SkyPalette } from './sunlight';

const RAIN_GREY: Rgb = [0.36, 0.39, 0.44];
const FOG_GREY: Rgb = [0.72, 0.74, 0.78];

/** The palette of the hour in this weather: rain darkens and greys it, fog whitens it; by night neither brightens it. */
export function weatherPalette(p: SkyPalette, w: Weather): SkyPalette {
  if (w.intensity <= 0) return p;
  const rain = w.kind === 'rain';
  const grey = rain ? RAIN_GREY : FOG_GREY;
  // the grey is scaled to the sky's own brightness, so a foggy night is still a night
  const bright = Math.min(1, (p.horizon[0] + p.horizon[1] + p.horizon[2]) / 1.8 + 0.05);
  const g: Rgb = [grey[0] * bright, grey[1] * bright, grey[2] * bright];
  const t = (rain ? 0.7 : 0.75) * w.intensity;
  return {
    ...p,
    zenith: mix(p.zenith, g, t),
    horizon: mix(p.horizon, g, t),
    hemiSky: mix(p.hemiSky, g, t * 0.6),
    light: mix(p.light, g, t * 0.5),
    lightIntensity: p.lightIntensity * (1 - (rain ? 0.6 : 0.45) * w.intensity),
    hemiIntensity: p.hemiIntensity * (1 - 0.15 * w.intensity),
    sunGlow: p.sunGlow * (1 - 0.85 * w.intensity),
  };
}

/** Where the fog begins and where it is complete, in this weather (clear: the given defaults). */
export function weatherFog(w: Weather, near = 450, far = 3400): { near: number; far: number } {
  const i = w.intensity;
  if (i <= 0) return { near, far };
  if (w.kind === 'fog') return { near: near + (35 - near) * i, far: far + (330 - far) * i };
  return { near: near + (220 - near) * i, far: far + (1500 - far) * i };
}
