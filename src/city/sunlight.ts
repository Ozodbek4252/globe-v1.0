// The sun over the city and the colour of the sky, from the real date and time. Pure.

import { unitVector, type Vec3 } from '../lib/geo';
import { sunPosition } from '../lib/sun';
import { mix, srgb, type Rgb } from './palette';

export interface SunAngles {
  /** Degrees above the horizon (negative at night). */
  elevation: number;
  /** Degrees clockwise from north. */
  azimuth: number;
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Where the sun is in the sky at a place, for a moment in time. */
export function localSun(date: Date | number, lon: number, lat: number): SunAngles {
  const [sunLon, sunLat] = sunPosition(date);
  const sun = unitVector([sunLon, sunLat]);
  const up = unitVector([lon, lat]);
  const east: Vec3 = [-Math.sin((lon * Math.PI) / 180), Math.cos((lon * Math.PI) / 180), 0];
  const north: Vec3 = [
    -Math.sin((lat * Math.PI) / 180) * Math.cos((lon * Math.PI) / 180),
    -Math.sin((lat * Math.PI) / 180) * Math.sin((lon * Math.PI) / 180),
    Math.cos((lat * Math.PI) / 180),
  ];
  const elevation = (Math.asin(Math.max(-1, Math.min(1, dot(sun, up))) * 1) * 180) / Math.PI;
  const azimuth = ((Math.atan2(dot(sun, east), dot(sun, north)) * 180) / Math.PI + 360) % 360;
  return { elevation, azimuth };
}

/** A direction toward the sun in Three.js space (x east, y up, z south), unit length. */
export function sunDirection({ elevation, azimuth }: SunAngles): Vec3 {
  const el = (elevation * Math.PI) / 180;
  const az = (azimuth * Math.PI) / 180;
  return [Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)];
}

export interface SkyPalette {
  zenith: Rgb;
  horizon: Rgb;
  /** Colour of the main light: the sun by day, the moon by night. */
  light: Rgb;
  lightIntensity: number;
  hemiSky: Rgb;
  hemiGround: Rgb;
  hemiIntensity: number;
  /** A soft light from the side away from the sun, so shaded walls keep their shape. */
  fillIntensity: number;
  /** 0 by day, 1 deep in the night: how much the windows and street lamps glow. */
  windowGlow: number;
  /** Camera exposure: higher when the light is low, as a real camera would adjust. */
  exposure: number;
  /** How much of the sun's glow is painted around it in the sky. */
  sunGlow: number;
}

interface Key {
  elevation: number;
  zenith: number;
  horizon: number;
  light: number;
  lightIntensity: number;
  hemiSky: number;
  hemiGround: number;
  hemiIntensity: number;
  fillIntensity: number;
  windowGlow: number;
  exposure: number;
  sunGlow: number;
}

// Keyframes by sun elevation, lowest first. Colours are sRGB hex, mixed in linear space. The sun's
// intensity is deliberately not proportional to how high it is: a low sun is boosted (and the exposure
// raised) so golden hour and dusk stay readable instead of going murky.
const KEYS: Key[] = [
  {
    elevation: -18,
    zenith: 0x05080f,
    horizon: 0x101a33,
    light: 0x8fa6dc,
    lightIntensity: 1.5,
    hemiSky: 0x33477a,
    hemiGround: 0x141a26,
    hemiIntensity: 2.0,
    fillIntensity: 0.5,
    windowGlow: 1,
    exposure: 1.9,
    sunGlow: 0,
  },
  {
    elevation: -8,
    zenith: 0x0c1730,
    horizon: 0x3a3a5e,
    light: 0x93a8dc,
    lightIntensity: 1.5,
    hemiSky: 0x40568c,
    hemiGround: 0x1a1e2c,
    hemiIntensity: 2.0,
    fillIntensity: 0.5,
    windowGlow: 0.95,
    exposure: 1.85,
    sunGlow: 0.2,
  },
  {
    elevation: -2,
    zenith: 0x1c2f5e,
    horizon: 0xc2694e,
    light: 0xff8450,
    lightIntensity: 3.2,
    hemiSky: 0x6679a6,
    hemiGround: 0x362c2e,
    hemiIntensity: 1.7,
    fillIntensity: 0.55,
    windowGlow: 0.65,
    exposure: 1.75,
    sunGlow: 1,
  },
  {
    elevation: 4,
    zenith: 0x35568f,
    horizon: 0xf2a062,
    light: 0xffa258,
    lightIntensity: 5.4,
    hemiSky: 0x8ea4cc,
    hemiGround: 0x54463e,
    hemiIntensity: 1.6,
    fillIntensity: 0.6,
    windowGlow: 0.3,
    exposure: 1.6,
    sunGlow: 1,
  },
  {
    elevation: 12,
    zenith: 0x4676b8,
    horizon: 0xf4cc98,
    light: 0xffcb92,
    lightIntensity: 5.2,
    hemiSky: 0xa4bbdc,
    hemiGround: 0x625748,
    hemiIntensity: 1.5,
    fillIntensity: 0.55,
    windowGlow: 0,
    exposure: 1.35,
    sunGlow: 0.7,
  },
  {
    elevation: 30,
    zenith: 0x3b7bd0,
    horizon: 0xcfe0f0,
    light: 0xfff0dc,
    lightIntensity: 4.2,
    hemiSky: 0xb0c8e8,
    hemiGround: 0x685e50,
    hemiIntensity: 1.25,
    fillIntensity: 0.4,
    windowGlow: 0,
    exposure: 1.1,
    sunGlow: 0.4,
  },
  {
    elevation: 65,
    zenith: 0x2e72d0,
    horizon: 0xbcd8f2,
    light: 0xfff8ec,
    lightIntensity: 3.9,
    hemiSky: 0xb6d0f0,
    hemiGround: 0x6e6455,
    hemiIntensity: 1.15,
    fillIntensity: 0.35,
    windowGlow: 0,
    exposure: 1,
    sunGlow: 0.3,
  },
];

const lin = (hex: number): Rgb => srgb(hex);

/** Sky, light and window glow for a sun elevation in degrees, blended smoothly between keyframes. */
export function skyPalette(elevation: number): SkyPalette {
  const first = KEYS[0];
  const last = KEYS[KEYS.length - 1];
  const e = Math.max(first.elevation, Math.min(last.elevation, elevation));
  let i = 0;
  while (i < KEYS.length - 2 && e > KEYS[i + 1].elevation) i++;
  const a = KEYS[i];
  const b = KEYS[i + 1];
  const raw = (e - a.elevation) / (b.elevation - a.elevation);
  const t = raw * raw * (3 - 2 * raw); // smoothstep: no visible seams at the keyframes
  const num = (x: number, y: number): number => x + (y - x) * t;
  return {
    zenith: mix(lin(a.zenith), lin(b.zenith), t),
    horizon: mix(lin(a.horizon), lin(b.horizon), t),
    light: mix(lin(a.light), lin(b.light), t),
    lightIntensity: num(a.lightIntensity, b.lightIntensity),
    hemiSky: mix(lin(a.hemiSky), lin(b.hemiSky), t),
    hemiGround: mix(lin(a.hemiGround), lin(b.hemiGround), t),
    hemiIntensity: num(a.hemiIntensity, b.hemiIntensity),
    fillIntensity: num(a.fillIntensity, b.fillIntensity),
    windowGlow: num(a.windowGlow, b.windowGlow),
    exposure: num(a.exposure, b.exposure),
    sunGlow: num(a.sunGlow, b.sunGlow),
  };
}
