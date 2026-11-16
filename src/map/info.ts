import { fmtArea, fmtBig, fmtDensity, fmtGdp, fmtUsd } from '../lib/format';
import type { Country } from './types';

export interface CardInfo {
  title: string;
  /** formal name when it differs from the short name, otherwise the subregion */
  subtitle: string;
  rows: [label: string, value: string][];
}

/** Text for the country info card. */
export function cardInfo({ props: p, area, dens, gpc }: Country): CardInfo {
  return {
    title: p.n,
    subtitle: p.f && p.f !== p.n ? p.f : p.s,
    rows: [
      ['Capital', p.cap || '—'],
      ['Continent', p.c],
      ['Region', p.s],
      ['Population', p.p > 0 ? fmtBig(p.p) : '—'],
      ['Area', fmtArea(area)],
      ['Density', dens ? fmtDensity(dens) : '—'],
      ['GDP', p.g > 0 ? fmtGdp(p.g) : '—'],
      ['GDP / person', gpc ? fmtUsd(gpc) : '—'],
      ['Income', p.i || '—'],
    ],
  };
}
