// The places you can play, and what has become of them. Pure: no DOM, no Three.js.
//
// `public/cities/index.json` lists the playable places. Each has a map file next to it
// (`public/cities/<id>.json`, made by scripts/fetch-city.mjs from OpenStreetMap). What happened to a
// place is remembered per browser: how long you lasted there, and whether it has fallen (you died in
// it and the outbreak took it). A fallen place goes dark on the globe until you reclaim it.

import { fetchJson, type JsonLoader } from './data';

export type PlaceKind = 'city' | 'village';

export interface Playable {
  /** The file name: `public/cities/<id>.json`. */
  id: string;
  name: string;
  /** The country's name, for the card. */
  country: string;
  lat: number;
  lon: number;
  /** People per square kilometre in the district, for the size of the crowd. */
  density: number;
  kind: PlaceKind;
  /** A line about the place, for the card. */
  blurb: string;
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * Read the list. A bad entry is dropped rather than failing the whole list (the others are still
 * playable); an entry that is not an object, or is missing something, is not an entry.
 */
export function parsePlayable(raw: unknown): Playable[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Playable[] = [];
  for (const item of raw as unknown[]) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    if (!isText(r.id) || !/^[a-z0-9-]+$/.test(r.id) || seen.has(r.id)) continue;
    if (!isText(r.name) || !isText(r.country)) continue;
    if (!isNumber(r.lat) || r.lat < -90 || r.lat > 90) continue;
    if (!isNumber(r.lon) || r.lon < -180 || r.lon > 180) continue;
    if (!isNumber(r.density) || r.density <= 0) continue;
    seen.add(r.id);
    out.push({
      id: r.id,
      name: r.name,
      country: r.country,
      lat: r.lat,
      lon: r.lon,
      density: r.density,
      kind: r.kind === 'village' ? 'village' : 'city',
      blurb: typeof r.blurb === 'string' ? r.blurb : '',
    });
  }
  return out;
}

/**
 * Which place an address asks for: `#city=paris` is Paris, a bare `#city` is Tashkent (the first place
 * there was, and what old links mean), anything else is no place.
 */
export function parseCityHash(hash: string): string | null {
  const match = /^#city(?:=([a-z0-9-]+))?$/.exec(hash);
  return match ? (match[1] ?? 'tashkent') : null;
}

export const cityHash = (id: string): string => `#city=${id}`;

export async function loadPlayable(load: JsonLoader = fetchJson): Promise<Playable[]> {
  return parsePlayable(await load('cities/index.json'));
}

// ---------- what happened there ----------

export interface Outcome {
  /** The longest you have lasted there, in seconds. */
  best: number;
  /** You died there, and the lights went out. */
  fallen: boolean;
  /** How many times you died there. */
  deaths: number;
  /** Seconds survived in a game saved there and not finished: it can be continued. */
  inPlay?: number;
}

/** A game is going on at a place (saved after `seconds`), or has stopped (0: the record is cleared). */
export function markInPlay(outcomes: Outcomes, id: string, seconds: number): Outcomes {
  const before = outcomes[id] ?? { best: 0, fallen: false, deaths: 0 };
  if (seconds <= 0) {
    if (before.inPlay === undefined) return outcomes;
    return {
      ...outcomes,
      [id]: { best: before.best, fallen: before.fallen, deaths: before.deaths },
    };
  }
  return { ...outcomes, [id]: { ...before, inPlay: Math.floor(seconds) } };
}

export type Outcomes = Readonly<Record<string, Outcome>>;

/** You died in a place after `seconds`: it has fallen, and the record is updated. */
export function recordDeath(outcomes: Outcomes, id: string, seconds: number): Outcomes {
  const before = outcomes[id];
  // the city goes on without that survivor: a game going on there stays going on
  return {
    ...outcomes,
    [id]: {
      ...before,
      best: Math.max(before?.best ?? 0, Math.max(0, Math.floor(seconds))),
      fallen: true,
      deaths: (before?.deaths ?? 0) + 1,
    },
  };
}

/** Take a fallen place back, so that it can be played again and its lights come on. The record stays. */
export function reclaim(outcomes: Outcomes, id: string): Outcomes {
  const before = outcomes[id];
  if (!before) return outcomes;
  return { ...outcomes, [id]: { ...before, fallen: false } };
}

export const OUTCOMES_KEY = 'atlas-outcomes';

/** Read what was stored; anything that does not look right is ignored. */
export function parseOutcomes(text: string | null): Outcomes {
  if (!text) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
  const out: Record<string, Outcome> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const v = value as Record<string, unknown>;
    if (!isNumber(v.best) || v.best < 0 || !isNumber(v.deaths) || v.deaths < 0) continue;
    out[id] = { best: Math.floor(v.best), fallen: v.fallen === true, deaths: Math.floor(v.deaths) };
    if (isNumber(v.inPlay) && v.inPlay > 0) out[id].inPlay = Math.floor(v.inPlay);
  }
  return out;
}

export const serializeOutcomes = (outcomes: Outcomes): string => JSON.stringify(outcomes);
