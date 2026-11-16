import { describe, expect, it } from 'vitest';
import {
  continentColors,
  DEFAULT_MODE_ID,
  densScale,
  gpcScale,
  incomeColors,
  isModeId,
  modeById,
  MODES,
  NO_DATA,
  politicalColors,
  popScale,
  tooltipValue,
  type ModeId,
  type ModeSubject,
} from '../src/map/modes';
import type { CountryProps } from '../src/map/types';

function subject(
  props: Partial<CountryProps> = {},
  extra: { dens?: number | null; gpc?: number | null } = {},
): ModeSubject {
  return {
    props: {
      n: 'Testland',
      f: 'Republic of Testland',
      a: 'TST',
      c: 'Asia',
      s: 'Central Asia',
      p: 1_000_000,
      g: 5000,
      i: 'Lower middle income',
      m: 1,
      cap: 'Testville',
      lx: 0,
      ly: 0,
      lr: 3,
      ...props,
    },
    dens: extra.dens === undefined ? 10 : extra.dens,
    gpc: extra.gpc === undefined ? 5000 : extra.gpc,
  };
}

/** "rgb(30, 42, 77)" or "#1e2a4d" -> [30, 42, 77] */
function rgb(color: string): number[] {
  if (color.startsWith('#')) {
    return [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  }
  return (color.match(/\d+/g) ?? []).map(Number);
}

const fillOf = (id: ModeId, s: ModeSubject): string => {
  const fill = modeById(id).fill;
  if (!fill) throw new Error(`${id} has no fill`);
  return fill(s);
};

describe('MODES', () => {
  it('lists the nine legacy modes in order with unique ids', () => {
    expect(MODES.map((m) => m.id)).toEqual([
      'physical',
      'natural',
      'political',
      'continents',
      'population',
      'density',
      'gdp',
      'income',
      'daynight',
    ]);
    expect(MODES.map((m) => m.name)).toEqual([
      'Physical',
      'Natural',
      'Political',
      'Continents',
      'Population',
      'Density',
      'GDP per person',
      'Income group',
      'Day & night',
    ]);
  });

  it('starts on Natural and validates stored ids', () => {
    expect(DEFAULT_MODE_ID).toBe('natural');
    expect(isModeId('gdp')).toBe(true);
    expect(isModeId('nope')).toBe(false);
    expect(isModeId(null)).toBe(false);
  });

  it('leaves fill undefined only for the modes that paint land themselves', () => {
    expect(MODES.filter((m) => !m.fill).map((m) => m.id)).toEqual(['physical', 'daynight']);
  });

  it('gives every mode a two-stop ocean and a legend', () => {
    for (const m of MODES) {
      expect(m.ocean).toHaveLength(2);
      expect(m.legend.kind).toMatch(/^(bar|swatches|note)$/);
    }
  });
});

describe('fill functions', () => {
  it('natural: one land colour for everyone', () => {
    expect(fillOf('natural', subject())).toBe('#7a6a48');
    expect(fillOf('natural', subject({ c: 'Europe' }))).toBe('#7a6a48');
  });

  it('political: cycles through the seven Natural Earth colours by m', () => {
    expect(fillOf('political', subject({ m: 1 }))).toBe(politicalColors[0]);
    expect(fillOf('political', subject({ m: 7 }))).toBe(politicalColors[6]);
    expect(fillOf('political', subject({ m: 8 }))).toBe(politicalColors[0]);
  });

  it('continents: uses the continent palette, grey for unknown', () => {
    expect(fillOf('continents', subject({ c: 'Asia' }))).toBe(continentColors.Asia);
    expect(fillOf('continents', subject({ c: 'Africa' }))).toBe('#d98b4a');
    expect(fillOf('continents', subject({ c: 'Atlantis' }))).toBe(NO_DATA);
  });

  it('income: uses the World Bank palette, grey for unknown or missing', () => {
    expect(fillOf('income', subject({ i: 'Low income' }))).toBe(incomeColors['Low income']);
    expect(fillOf('income', subject({ i: 'High income: OECD' }))).toBe('#3f8fc4');
    expect(fillOf('income', subject({ i: '' }))).toBe(NO_DATA);
  });

  describe('population (log scale 500K to 1.4B, clamped)', () => {
    it('is grey with no population', () => {
      expect(fillOf('population', subject({ p: 0 }))).toBe(NO_DATA);
      expect(fillOf('population', subject({ p: -99 }))).toBe(NO_DATA);
    });
    it('starts and ends on the first and last colour stops', () => {
      expect(rgb(fillOf('population', subject({ p: 5e5 })))).toEqual(rgb('#1e2a4d'));
      expect(rgb(fillOf('population', subject({ p: 1.4e9 })))).toEqual(rgb('#f7e67c'));
    });
    it('clamps outside the domain', () => {
      expect(fillOf('population', subject({ p: 100 }))).toBe(
        fillOf('population', subject({ p: 5e5 })),
      );
      expect(fillOf('population', subject({ p: 9e9 }))).toBe(
        fillOf('population', subject({ p: 1.4e9 })),
      );
    });
    it('matches the scale it is built on', () => {
      expect(fillOf('population', subject({ p: 34e6 }))).toBe(popScale(34e6));
    });
  });

  describe('density (log scale 1 to 1000 per km²)', () => {
    it('is grey without a density', () => {
      expect(fillOf('density', subject({}, { dens: null }))).toBe(NO_DATA);
    });
    it('starts and ends on the first and last colour stops, clamped', () => {
      expect(rgb(fillOf('density', subject({}, { dens: 1 })))).toEqual(rgb('#2a1f3d'));
      expect(rgb(fillOf('density', subject({}, { dens: 1000 })))).toEqual(rgb('#f9d77e'));
      expect(fillOf('density', subject({}, { dens: 8358 }))).toBe(densScale(1000));
    });
  });

  describe('GDP per person (log scale $500 to $100,000)', () => {
    it('is grey without a value', () => {
      expect(fillOf('gdp', subject({}, { gpc: null }))).toBe(NO_DATA);
    });
    it('starts and ends on the first and last colour stops, clamped', () => {
      expect(rgb(fillOf('gdp', subject({}, { gpc: 500 })))).toEqual(rgb('#173440'));
      expect(rgb(fillOf('gdp', subject({}, { gpc: 100000 })))).toEqual(rgb('#f3f1a2'));
      expect(fillOf('gdp', subject({}, { gpc: 150000 }))).toBe(gpcScale(100000));
    });
  });
});

describe('tooltipValue', () => {
  it('shows the capital in modes without a value of their own', () => {
    for (const id of ['physical', 'natural', 'political', 'daynight'] as const) {
      expect(tooltipValue(modeById(id), subject())).toBe('Capital: Testville');
    }
  });
  it('shows nothing when there is no capital', () => {
    expect(tooltipValue(modeById('natural'), subject({ cap: '' }))).toBe('');
    expect(tooltipValue(modeById('physical'), subject({ cap: '' }))).toBe('');
  });
  it('shows the mode value otherwise', () => {
    expect(tooltipValue(modeById('continents'), subject({ c: 'Europe' }))).toBe('Europe');
    expect(tooltipValue(modeById('population'), subject({ p: 34_232_050 }))).toBe('34.2 M');
    expect(tooltipValue(modeById('population'), subject({ p: 0 }))).toBe('no data');
    expect(tooltipValue(modeById('density'), subject({}, { dens: 76.25 }))).toBe('76.3 /km²');
    expect(tooltipValue(modeById('density'), subject({}, { dens: null }))).toBe('no data');
    expect(tooltipValue(modeById('gdp'), subject({}, { gpc: 1792.4 }))).toBe('$1,792');
    expect(tooltipValue(modeById('gdp'), subject({}, { gpc: null }))).toBe('no data');
    expect(tooltipValue(modeById('income'), subject({ i: 'Low income' }))).toBe('Low income');
    expect(tooltipValue(modeById('income'), subject({ i: '' }))).toBe('no data');
  });
});

describe('legends', () => {
  it('population, density and GDP are 11-stop log ramps with legacy tick labels', () => {
    const pop = modeById('population').legend;
    const dens = modeById('density').legend;
    const gdp = modeById('gdp').legend;
    for (const legend of [pop, dens, gdp]) {
      if (legend.kind !== 'bar') throw new Error('expected a bar legend');
      expect(legend.gradient).toMatch(/^linear-gradient\(90deg,(rgb\([^)]*\),){10}rgb\([^)]*\)\)$/);
    }
    expect(pop.kind === 'bar' && pop.ticks).toEqual(['500K', '10M', '100M', '1.4B']);
    expect(dens.kind === 'bar' && dens.ticks).toEqual(['1/km²', '10/km²', '100/km²', '1000/km²']);
    expect(gdp.kind === 'bar' && gdp.ticks).toEqual(['$500', '$5K', '$50K', '$100K']);
  });

  it('continents leave out the open-ocean entry', () => {
    const legend = modeById('continents').legend;
    if (legend.kind !== 'swatches') throw new Error('expected swatches');
    expect(legend.items.map((i) => i.label)).toEqual([
      'Africa',
      'Asia',
      'Europe',
      'North America',
      'South America',
      'Oceania',
      'Antarctica',
    ]);
  });

  it('income uses the short legacy labels', () => {
    const legend = modeById('income').legend;
    if (legend.kind !== 'swatches') throw new Error('expected swatches');
    expect(legend.items.map((i) => i.label)).toEqual([
      'High (OECD)',
      'High (other)',
      'Upper middle',
      'Lower middle',
      'Low',
    ]);
  });
});
