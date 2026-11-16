import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadWorld, type JsonLoader } from '../src/map/data';
import { cardInfo } from '../src/map/info';
import { countryNames, findCountry } from '../src/map/search';
import type { Country, World } from '../src/map/types';

const fromDisk: JsonLoader = async (path) =>
  JSON.parse(await readFile(resolve('public', path), 'utf8')) as unknown;

let world: World;
beforeAll(async () => {
  world = await loadWorld(fromDisk);
});

const codeOf = (query: string): string | undefined => findCountry(world.countries, query)?.code;

describe('findCountry', () => {
  it('matches a full name, ignoring case and surrounding spaces', () => {
    expect(codeOf('Uzbekistan')).toBe('UZB');
    expect(codeOf('  uZbEkIsTaN ')).toBe('UZB');
  });

  it('prefers an exact name over a longer name that starts the same way', () => {
    expect(codeOf('niger')).toBe('NER'); // not Nigeria
    expect(codeOf('nigeri')).toBe('NGA');
  });

  it('falls back to names that start with the text', () => {
    expect(codeOf('uzb')).toBe('UZB');
    expect(codeOf('braz')).toBe('BRA');
  });

  it('takes the first match in data order when several names start with the text', () => {
    // Natural Earth lists the United States of America before the United Arab Emirates.
    expect(codeOf('united')).toBe(
      world.countries.find((c) => c.props.n.startsWith('United'))?.code,
    );
  });

  it('falls back to formal names that contain the text', () => {
    expect(codeOf('bolivarian')).toBe('VEN');
    expect(codeOf('democratic people')).toBe('PRK');
  });

  it('returns the first formal-name match in data order, like the legacy search', () => {
    // "Republic of Korea" is inside both formal names; North Korea's comes first in the data.
    expect(codeOf('republic of korea')).toBe('PRK');
  });

  it('finds nothing for blank or unknown text', () => {
    expect(codeOf('')).toBeUndefined();
    expect(codeOf('   ')).toBeUndefined();
    expect(codeOf('zzzz')).toBeUndefined();
  });
});

describe('countryNames', () => {
  it('lists every country once, in plain sort order', () => {
    const names = countryNames(world.countries);
    expect(names).toHaveLength(177);
    expect(names).toEqual([...names].sort());
    expect(names).toContain('Uzbekistan');
    expect(new Set(names).size).toBe(177);
  });
});

describe('cardInfo', () => {
  const country = (code: string): Country => {
    const c = world.byCode.get(code);
    if (!c) throw new Error(`${code} missing`);
    return c;
  };

  it('describes a country with the legacy rows in order', () => {
    const info = cardInfo(country('UZB'));
    expect(info.title).toBe('Uzbekistan');
    expect(info.subtitle).toBe('Republic of Uzbekistan');
    expect(info.rows.map(([label]) => label)).toEqual([
      'Capital',
      'Continent',
      'Region',
      'Population',
      'Area',
      'Density',
      'GDP',
      'GDP / person',
      'Income',
    ]);
    const row = (label: string): string => info.rows.find(([l]) => l === label)?.[1] ?? '';
    expect(row('Capital')).toBe('Tashkent');
    expect(row('Continent')).toBe('Asia');
    expect(row('Population')).toBe('33.6 M');
    expect(row('GDP')).toBe('$57.9 B');
    expect(row('GDP / person')).toBe('$1,725');
    expect(row('Income')).toBe('Lower middle income');
    expect(row('Area')).toMatch(/^≈ \d{3},000 km²$/);
    expect(row('Density')).toMatch(/^\d+\.\d \/km²$/);
  });

  it('shows the subregion when the formal name is the same as the name', () => {
    const antarctica = country('ATA');
    const info = cardInfo(antarctica);
    expect(info.subtitle).toBe(antarctica.props.s);
    expect(info.rows[0]).toEqual(['Capital', '—']);
  });

  it('shows a dash for missing figures', () => {
    const base = country('UZB');
    const blank: Country = {
      ...base,
      props: { ...base.props, p: 0, g: 0, i: '', cap: '' },
      dens: null,
      gpc: null,
    };
    const rows = Object.fromEntries(cardInfo(blank).rows);
    expect(rows).toMatchObject({
      Capital: '—',
      Population: '—',
      Density: '—',
      GDP: '—',
      'GDP / person': '—',
      Income: '—',
    });
  });
});
