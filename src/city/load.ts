import { fetchJson, type JsonLoader } from '../map/data';
import type { CityData } from './types';

/** Fetch a city file from public/cities/<id>.json and check it is in the format this code reads. */
export async function loadCity(id: string, load: JsonLoader = fetchJson): Promise<CityData> {
  const raw = (await load(`cities/${id}.json`)) as Partial<CityData> | null;
  if (!raw || raw.version !== 1 || !Array.isArray(raw.buildings) || !Array.isArray(raw.roads)) {
    throw new Error(`The map data for "${id}" is not in the expected format.`);
  }
  return raw as CityData;
}
