// The weather: clear, rain or fog, coming and going in spells, as a pure function of the game's seed
// and how long it has been played, so a saved game has the same sky when it is taken up again and
// nothing needs saving. What it does to the game is in `senses`: rain dulls the horde's eyes and
// ears and keeps people indoors; fog blinds everyone.

import { hash01 } from '../lib/hash';

export type WeatherKind = 'clear' | 'rain' | 'fog';

export interface Weather {
  kind: WeatherKind;
  /** 0 (none) to 1 (as heavy as it gets); always 0 when clear. */
  intensity: number;
}

export const CLEAR: Weather = { kind: 'clear', intensity: 0 };

export const WEATHER = {
  /** A spell of weather lasts this long (seconds of play), and one spell turns into the next over this long. */
  spell: 600,
  change: 75,
  /** The share of spells that are rain, and fog (the rest are clear). */
  rain: 0.26,
  fog: 0.18,
  /** Rain at full strength: what it takes off the horde's sight, off every noise's reach, and off the share of people outdoors. */
  rainSight: 0.3,
  rainHearing: 0.4,
  rainOutdoors: 0.65,
  /** Fog at full strength: what it takes off sight (yours too), and off the people outdoors. */
  fogSight: 0.65,
  fogOutdoors: 0.2,
} as const;

/** The weather of one spell (`slot` counts spells from the start of the game). The first is always clear. */
export function spellAt(slot: number, seed: number): Weather {
  if (slot <= 0) return CLEAR;
  const r = hash01(seed ^ 0x5eed, slot * 2 + 1);
  const strength = 0.45 + 0.55 * hash01(seed, slot * 2 + 2);
  if (r < WEATHER.rain) return { kind: 'rain', intensity: strength };
  if (r < WEATHER.rain + WEATHER.fog) return { kind: 'fog', intensity: strength };
  return CLEAR;
}

/**
 * The weather `seconds` into a game with this seed. At the start of a spell the last one fades out
 * as the new one comes in. `forced` fixes it for the whole game (a link, a test).
 */
export function weatherAt(
  seconds: number,
  seed: number,
  forced: WeatherKind | null = null,
): Weather {
  if (forced) return forced === 'clear' ? CLEAR : { kind: forced, intensity: 1 };
  const slot = Math.floor(seconds / WEATHER.spell);
  const now = spellAt(slot, seed);
  const t = seconds - slot * WEATHER.spell;
  if (t >= WEATHER.change) return now;
  const before = spellAt(slot - 1, seed);
  const f = t / WEATHER.change;
  if (before.kind === now.kind)
    return { kind: now.kind, intensity: before.intensity + (now.intensity - before.intensity) * f };
  const fading = before.intensity * (1 - f);
  const coming = now.intensity * f;
  return fading >= coming
    ? { kind: before.kind, intensity: fading }
    : { kind: now.kind, intensity: coming };
}

export interface Senses {
  /** Multipliers, 1 in clear weather: how far the horde sees, how far a noise is heard, how many people are out. */
  sight: number;
  hearing: number;
  outdoors: number;
}

export function senses(w: Weather): Senses {
  const i = w.intensity;
  if (w.kind === 'rain')
    return {
      sight: 1 - WEATHER.rainSight * i,
      hearing: 1 - WEATHER.rainHearing * i,
      outdoors: 1 - WEATHER.rainOutdoors * i,
    };
  if (w.kind === 'fog')
    return { sight: 1 - WEATHER.fogSight * i, hearing: 1, outdoors: 1 - WEATHER.fogOutdoors * i };
  return { sight: 1, hearing: 1, outdoors: 1 };
}
