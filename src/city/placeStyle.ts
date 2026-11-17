// How each kind of place looks, in one place that needs no Three.js, so the 3D markers and the HUD
// radar agree and the HUD does not pull the 3D library into the main bundle.

import type { PlaceKind } from '../sim/places';

/** Hex colours (0xRRGGBB). */
export const PLACE_COLOURS: Record<PlaceKind, number> = {
  radar: 0x4aa8ff,
  shelter: 0x35d0c0,
  supplies: 0xf0b54a,
  armory: 0xff6a3a,
};

/** A short name for a kind of place, for the HUD. */
export const PLACE_LABELS: Record<PlaceKind, string> = {
  radar: 'Radar',
  shelter: 'Shelter',
  supplies: 'Supplies',
  armory: 'Armory',
};

/** The colour as a CSS string. */
export const cssColour = (kind: PlaceKind): string =>
  `#${PLACE_COLOURS[kind].toString(16).padStart(6, '0')}`;
