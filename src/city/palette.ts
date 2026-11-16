// Colours for the city. Three.js does lighting in linear colour space, so hex values written the way
// designers write them (sRGB) are converted once here.

import type { AreaKind, BuildingKind } from './types';

export type Rgb = [r: number, g: number, b: number];

const toLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** 0xRRGGBB (sRGB) to linear RGB in 0..1. */
export function srgb(hex: number): Rgb {
  return [
    toLinear(((hex >> 16) & 255) / 255),
    toLinear(((hex >> 8) & 255) / 255),
    toLinear((hex & 255) / 255),
  ];
}

export function scale([r, g, b]: Rgb, k: number): Rgb {
  return [r * k, g * k, b * k];
}

export function mix(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Wall colours per building kind: Tashkent's sand, whitewash, concrete and glass. */
export const WALLS: Record<BuildingKind, Rgb[]> = {
  house: [0xd9c9a8, 0xcdb894, 0xe6dcc3, 0xc9a98a, 0xb99c7e].map(srgb),
  apartments: [0xc9c4b8, 0xb8b3a6, 0xd6cfbf, 0xa9a59b, 0xbfae98].map(srgb),
  commercial: [0xb7bec6, 0x9fa9b3, 0xc9c2b4, 0x8e9aa8].map(srgb),
  industrial: [0x8d8f8a, 0x9a8f80, 0x7d8386].map(srgb),
  civic: [0xe0d4b8, 0xd2c7a8, 0xc8d0d0].map(srgb),
  religious: [0xe3d8bd, 0xd9ccaa].map(srgb),
  garage: [0x8a8478, 0x7f8788, 0x9c8f7f].map(srgb),
  other: [0xcbbfa6, 0xbcae94, 0xd4c9b2, 0xb0a590, 0xc2b8a8].map(srgb),
};

/** Roof colours: terracotta and slate on houses, tar and concrete elsewhere. */
export const ROOFS: Record<BuildingKind, Rgb[]> = {
  house: [0x8c4a3a, 0x6b6f73, 0x7a5a48, 0x8a5a44].map(srgb),
  apartments: [0x5b5e61, 0x6a6c6e, 0x4f5254].map(srgb),
  commercial: [0x5d6064, 0x74777a, 0x4f5356].map(srgb),
  industrial: [0x6a6d70, 0x5b5f61].map(srgb),
  civic: [0x7a5a48, 0x5b5e61].map(srgb),
  religious: [0x6e7a78, 0x7a6f5f].map(srgb),
  garage: [0x5b5e61, 0x6d6a64].map(srgb),
  other: [0x7a5a48, 0x6b6f73, 0x5b5e61, 0x8a5a44].map(srgb),
};

export const ROOF_PROP = srgb(0x6d7074);
export const DOME = srgb(0x2fa3a0); // the turquoise of Samarkand and Tashkent domes

/** Flat ground colours by area kind. */
export const GROUND: Record<AreaKind, Rgb> = {
  water: srgb(0x3d6a86),
  park: srgb(0x5f7a4a),
  grass: srgb(0x778a55),
  forest: srgb(0x4a6840),
  sport: srgb(0x5c8a4e),
  cemetery: srgb(0x6f7a55),
  farmland: srgb(0x93865c),
  sand: srgb(0xc2b280),
  plaza: srgb(0xb5ada0),
  parking: srgb(0x5a5c5e),
};

export const TERRAIN = srgb(0x8d8876);
export const ASPHALT = srgb(0x3b3e41);
export const PATH = srgb(0x8c8776);
export const WATER = srgb(0x3d6a86);
