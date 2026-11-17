import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTileIndex } from '../src/city/tiles';
import type { CityData } from '../src/city/types';
import {
  cityHash,
  loadPlayable,
  markInPlay,
  parseCityHash,
  parseOutcomes,
  parsePlayable,
  reclaim,
  recordDeath,
  recordFall,
  serializeOutcomes,
  type Outcomes,
} from '../src/map/playable';

const good = {
  id: 'paris',
  name: 'Paris',
  country: 'France',
  lat: 48.86,
  lon: 2.29,
  density: 21000,
  kind: 'city',
  blurb: 'A city.',
  tiled: false,
};

describe('the list of places', () => {
  it('reads a good entry as it is', () => {
    expect(parsePlayable([good])).toEqual([good]);
  });

  it('makes a place a city unless it says village, and a missing blurb empty', () => {
    const [a, b] = parsePlayable([
      { ...good, id: 'a', kind: 'metropolis', blurb: undefined },
      { ...good, id: 'b', kind: 'village' },
    ]);
    expect(a.kind).toBe('city');
    expect(a.blurb).toBe('');
    expect(b.kind).toBe('village');
  });

  it('drops what is not an entry, keeps the others, and the first of a repeated id', () => {
    const list = parsePlayable([
      good,
      null,
      'paris',
      { ...good, id: 'Bad Id' }, // ids are file names
      { ...good, id: '../up' },
      { ...good, id: 'x1', name: '' },
      { ...good, id: 'x2', lat: 91 },
      { ...good, id: 'x3', lon: -181 },
      { ...good, id: 'x4', density: 0 },
      { ...good, id: 'x5', lat: Number.NaN },
      { ...good, id: 'x6', country: undefined },
      { ...good, name: 'Another Paris' }, // the id is taken
      { ...good, id: 'rome', name: 'Rome' },
    ]);
    expect(list.map((p) => p.id)).toEqual(['paris', 'rome']);
    expect(list[0].name).toBe('Paris');
  });

  it('is an empty list for anything that is not a list', () => {
    expect(parsePlayable(null)).toEqual([]);
    expect(parsePlayable({ id: 'paris' })).toEqual([]);
    expect(parsePlayable('paris')).toEqual([]);
  });

  it('is fetched from cities/index.json', async () => {
    const asked: string[] = [];
    const list = await loadPlayable((path) => {
      asked.push(path);
      return Promise.resolve([good]);
    });
    expect(asked).toEqual(['cities/index.json']);
    expect(list).toHaveLength(1);
  });

  it('passes a failed fetch on to the caller', async () => {
    await expect(loadPlayable(() => Promise.reject(new Error('offline')))).rejects.toThrow(
      'offline',
    );
  });
});

describe('what happened in a place', () => {
  it('counts your deaths there and remembers the longest you lasted; the city goes on', () => {
    let o: Outcomes = {};
    o = recordDeath(o, 'paris', 187.9);
    expect(o.paris).toEqual({ best: 187, fallen: false, deaths: 1 });
    o = recordDeath(o, 'paris', 95);
    expect(o.paris).toEqual({ best: 187, fallen: false, deaths: 2 });
    o = recordDeath(o, 'paris', 240);
    expect(o.paris.best).toBe(240);
  });

  it('falls when nobody is left in it, which ends the game there', () => {
    let o: Outcomes = markInPlay(recordDeath({}, 'paris', 100), 'paris', 300);
    expect(o.paris.inPlay).toBe(300);
    o = recordFall(o, 'paris', 412.6);
    expect(o.paris).toEqual({ best: 412, fallen: true, deaths: 1 });
    // dying in a fallen place (a new game there) does not pick it back up
    expect(recordDeath(o, 'paris', 10).paris.fallen).toBe(true);
    expect(recordFall({}, 'oia', 60).oia).toEqual({ best: 60, fallen: true, deaths: 0 });
  });

  it('keeps each place on its own, and never changes what it was given', () => {
    const before: Outcomes = { paris: { best: 100, fallen: true, deaths: 1 } };
    const after = recordFall(before, 'tokyo', 50);
    expect(Object.keys(after).sort()).toEqual(['paris', 'tokyo']);
    expect(Object.keys(before)).toEqual(['paris']);
    expect(after.paris).toBe(before.paris);
  });

  it('can be reclaimed: the lights come on but the record stays', () => {
    const o = reclaim(recordFall(recordDeath({}, 'paris', 120), 'paris', 130), 'paris');
    expect(o.paris).toEqual({ best: 130, fallen: false, deaths: 1 });
  });

  it('has nothing to reclaim in a place never played', () => {
    const o: Outcomes = {};
    expect(reclaim(o, 'paris')).toBe(o);
  });

  it('is remembered across a reload', () => {
    const o = recordDeath(recordDeath({}, 'paris', 120), 'tokyo', 30);
    expect(parseOutcomes(serializeOutcomes(o))).toEqual(o);
  });

  it('survives whatever is in storage', () => {
    expect(parseOutcomes(null)).toEqual({});
    expect(parseOutcomes('')).toEqual({});
    expect(parseOutcomes('{not json')).toEqual({});
    expect(parseOutcomes('[1,2]')).toEqual({});
    expect(parseOutcomes('"paris"')).toEqual({});
    expect(
      parseOutcomes(
        JSON.stringify({
          good: { best: 10, fallen: true, deaths: 2 },
          nonsense: 5,
          negative: { best: -1, fallen: true, deaths: 1 },
          missing: { fallen: true },
          odd: { best: 12.7, fallen: 'yes', deaths: 1.2 },
        }),
      ),
    ).toEqual({
      good: { best: 10, fallen: true, deaths: 2 },
      odd: { best: 12, fallen: false, deaths: 1 },
    });
  });
});

describe('the places that ship with the game', () => {
  const raw = JSON.parse(readFileSync(resolve('public/cities/index.json'), 'utf8')) as unknown;
  const places = parsePlayable(raw);

  it('are all valid entries (none was dropped)', () => {
    expect((raw as unknown[]).length).toBe(places.length);
    expect(places.length).toBeGreaterThanOrEqual(6);
    expect(places.some((p) => p.kind === 'village')).toBe(true);
    expect(places.some((p) => p.id === 'tashkent')).toBe(true);
  });

  it.each(places.map((p) => [p.id, p] as const))('%s has a map file that matches', (id, place) => {
    if (place.tiled) {
      // a whole city in tiles: the index, and every tile it lists
      const index = parseTileIndex(
        JSON.parse(readFileSync(resolve(`public/cities/${id}/index.json`), 'utf8')) as unknown,
      );
      expect(index).not.toBeNull();
      if (!index) return;
      expect(index.id).toBe(id);
      expect(index.name).toBe(place.name);
      expect(index.center[0]).toBeCloseTo(place.lon, 2);
      expect(index.center[1]).toBeCloseTo(place.lat, 2);
      expect(index.tiles.length).toBeGreaterThan(50);
      expect(index.tiles.some((t) => t.tx === 0 && t.ty === 0)).toBe(true); // the start
      for (const t of index.tiles)
        expect(existsSync(resolve(`public/cities/${id}/${t.file}`))).toBe(true);
      expect(index.attribution).toMatch(/OpenStreetMap/);
      return;
    }
    const city = JSON.parse(readFileSync(resolve(`public/cities/${id}.json`), 'utf8')) as CityData;
    expect(city.version).toBe(1);
    expect(city.id).toBe(id);
    expect(city.name).toBe(place.name);
    // the pin is where the map is centred
    expect(city.center[0]).toBeCloseTo(place.lon, 2);
    expect(city.center[1]).toBeCloseTo(place.lat, 2);
    expect(city.buildings.length).toBeGreaterThan(100);
    expect(city.roads.length).toBeGreaterThan(10);
    expect(city.attribution).toMatch(/OpenStreetMap/);
  });

  it('are described in the data notice', () => {
    const notice = readFileSync(resolve('public/cities/README.md'), 'utf8');
    for (const p of places) {
      const file = p.tiled ? `${p.id}/` : `${p.id}.json`;
      expect(notice, `${file} in the notice`).toContain(file);
    }
  });
});

describe('a game going on at a place', () => {
  it('is marked with the seconds so far, kept across a reload, and cleared with zero', () => {
    let o: Outcomes = {};
    o = markInPlay(o, 'paris', 187.6);
    expect(o.paris).toEqual({ best: 0, fallen: false, deaths: 0, inPlay: 187 });
    expect(parseOutcomes(serializeOutcomes(o))).toEqual(o);
    o = markInPlay(o, 'paris', 0);
    expect(o.paris).toEqual({ best: 0, fallen: false, deaths: 0 });
  });

  it('goes on after a death: the city is still there for the next survivor', () => {
    let o: Outcomes = markInPlay({}, 'paris', 70);
    o = recordDeath(o, 'paris', 90);
    expect(o.paris.inPlay).toBe(70);
    expect(o.paris.best).toBe(90);
    expect(o.paris.fallen).toBe(false);
    // once nobody is left there, the game is over: nothing is in play any more
    const gone = recordFall(o, 'paris', 95);
    expect(gone.paris.inPlay).toBeUndefined();
    expect(gone.paris.fallen).toBe(true);
  });

  it('leaves a record alone that has nothing to clear', () => {
    const o: Outcomes = { paris: { best: 10, fallen: false, deaths: 1 } };
    expect(markInPlay(o, 'paris', 0)).toBe(o);
  });
});

describe('the address of a place', () => {
  it('names a place with #city=<id>, and a bare #city means Tashkent', () => {
    expect(parseCityHash('#city=paris')).toBe('paris');
    expect(parseCityHash('#city=new-york-2')).toBe('new-york-2');
    expect(parseCityHash('#city')).toBe('tashkent');
  });

  it('means no place for anything else', () => {
    expect(parseCityHash('')).toBeNull();
    expect(parseCityHash('#')).toBeNull();
    expect(parseCityHash('#city=')).toBeNull();
    expect(parseCityHash('#cityx')).toBeNull();
    expect(parseCityHash('#city=Paris')).toBeNull(); // ids are lower case
    expect(parseCityHash('#city=../etc')).toBeNull();
    expect(parseCityHash('#city=paris&x=1')).toBeNull();
  });

  it('round-trips', () => {
    for (const id of ['paris', 'tashkent', 'oia']) expect(parseCityHash(cityHash(id))).toBe(id);
  });
});
