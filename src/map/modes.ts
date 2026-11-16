import { range } from 'd3-array';
import { interpolateRgbBasis } from 'd3-interpolate';
import { scaleSequentialLog, type ScaleSequential } from 'd3-scale';
import { fmtBig, fmtDensity, fmtTick, fmtUsd } from '../lib/format';
import type { Country } from './types';

/** What a mode needs to know about a country. */
export type ModeSubject = Pick<Country, 'props' | 'dens' | 'gpc'>;

export type ModeId =
  | 'physical'
  | 'natural'
  | 'political'
  | 'continents'
  | 'population'
  | 'density'
  | 'gdp'
  | 'income'
  | 'daynight';

// ---------- legend data (rendered by ui/MapLegend.vue) ----------

export interface Swatch {
  label: string;
  color: string;
  /** draw the swatch as a circle */
  round?: boolean;
  /** draw an inset outline in this colour */
  outline?: string;
}

export type Legend =
  /** a colour bar with tick labels underneath */
  | { kind: 'bar'; gradient: string; ticks: string[]; note?: string }
  /** colour chips with labels */
  | { kind: 'swatches'; items: Swatch[]; note?: string }
  /** text only */
  | { kind: 'note'; note: string };

// ---------- colours ----------

export const NO_DATA = '#3b4456';

export const continentColors: Record<string, string> = {
  Africa: '#d98b4a',
  Asia: '#d9c25a',
  Europe: '#6f9fd8',
  'North America': '#cf6a6a',
  'South America': '#7cbf72',
  Oceania: '#3fb6b0',
  Antarctica: '#e6ecf2',
  'Seven seas (open ocean)': '#9aa6bb',
};

export const politicalColors = [
  '#c98f73',
  '#b9a86a',
  '#8fae7c',
  '#77a3b5',
  '#9a8cc0',
  '#c27f99',
  '#d6b47e',
];

export const incomeColors: Record<string, string> = {
  'High income: OECD': '#3f8fc4',
  'High income: nonOECD': '#78b9de',
  'Upper middle income': '#82b77a',
  'Lower middle income': '#e2a250',
  'Low income': '#c9574d',
};

export const popScale = scaleSequentialLog(
  [5e5, 1.4e9],
  interpolateRgbBasis(['#1e2a4d', '#2d5f8f', '#38a3a5', '#9bd48a', '#f7e67c']),
).clamp(true);
export const densScale = scaleSequentialLog(
  [1, 1000],
  interpolateRgbBasis(['#2a1f3d', '#6a2f5e', '#b8455b', '#ec8b4b', '#f9d77e']),
).clamp(true);
export const gpcScale = scaleSequentialLog(
  [500, 100000],
  interpolateRgbBasis(['#173440', '#1f6c6c', '#4ba57a', '#aad26b', '#f3f1a2']),
).clamp(true);

// ---------- legends ----------

/** A bar legend sampled from a log scale at eleven evenly spaced (in log terms) points. */
function rampLegend(
  scale: ScaleSequential<string>,
  ticks: number[],
  fmt: (n: number) => string,
  note?: string,
): Legend {
  const [lo, hi] = scale.domain();
  const stops = range(0, 1.01, 0.1).map((t) =>
    scale(Math.exp(Math.log(lo) + t * (Math.log(hi) - Math.log(lo)))),
  );
  return {
    kind: 'bar',
    gradient: `linear-gradient(90deg,${stops.join(',')})`,
    ticks: ticks.map(fmt),
    note,
  };
}

const continentSwatches: Swatch[] = Object.entries(continentColors)
  .filter(([name]) => name !== 'Seven seas (open ocean)')
  .map(([label, color]) => ({ label, color }));

// ---------- modes ----------

export interface ModeDef {
  id: ModeId;
  name: string;
  /** one-line description shown under the name */
  sub: string;
  /** ocean gradient: highlight colour, then edge colour */
  ocean: [string, string];
  /** CSS background for the round icon */
  ico: string;
  /** country fill; absent for the modes that paint land themselves (physical, day & night) */
  fill?: (c: ModeSubject) => string;
  /** CSS colour of the border strokes */
  border: string;
  /** border line width, default 0.6 */
  bw?: number;
  /** hover tooltip text; null falls back to the capital */
  value: ((c: ModeSubject) => string) | null;
  legend: Legend;
}

const capitalOf = ({ props }: ModeSubject): string => (props.cap ? 'Capital: ' + props.cap : '');

export const MODES: readonly ModeDef[] = [
  {
    id: 'physical',
    name: 'Physical',
    sub: 'Land, rivers, climate belts',
    ocean: ['#1c5585', '#0a2747'],
    ico: 'linear-gradient(160deg,#e9eef0 10%,#5f8550 35%,#d7bd85 55%,#3e7a37 75%)',
    border: 'rgba(30,40,30,.0)',
    value: null,
    legend: {
      kind: 'bar',
      gradient: 'linear-gradient(90deg,#3e7a37,#a39c5a,#d7bd85,#97955d,#4f7348,#c9d1c4,#f6f8fa)',
      ticks: ['Equator', 'Tropics', 'Temperate', 'Polar'],
      note: 'Land is tinted by approximate climate belt (by latitude), with major rivers and lakes. Dashed lines mark the tropics and polar circles.',
    },
  },
  {
    id: 'natural',
    name: 'Natural',
    sub: 'One land colour, clear borders',
    ocean: ['#1f4f7a', '#0b2540'],
    ico: 'linear-gradient(135deg,#1f4f7a 0 45%,#7a6a48 45%)',
    fill: () => '#7a6a48',
    border: 'rgba(22,16,8,.95)',
    bw: 1.2,
    value: capitalOf,
    legend: {
      kind: 'swatches',
      items: [
        { label: 'Land', color: '#7a6a48', outline: '#161008' },
        { label: 'Water', color: '#1f4f7a' },
      ],
      note: 'Every country shares one colour so the borders stand out.',
    },
  },
  {
    id: 'political',
    name: 'Political',
    sub: 'Countries and borders',
    ocean: ['#2a4766', '#132438'],
    ico: 'conic-gradient(#c98f73 0 25%,#77a3b5 0 50%,#8fae7c 0 75%,#9a8cc0 0)',
    fill: ({ props }) => politicalColors[(props.m - 1) % 7],
    border: 'rgba(20,24,34,.75)',
    value: capitalOf,
    legend: {
      kind: 'note',
      note: "Neighbouring countries get different colours (Natural Earth's 7-colour scheme). Turn on Capitals to see capital cities.",
    },
  },
  {
    id: 'continents',
    name: 'Continents',
    sub: 'Seven continents',
    ocean: ['#22384f', '#0f1d2e'],
    ico: 'conic-gradient(#d98b4a 0 20%,#d9c25a 0 40%,#6f9fd8 0 60%,#cf6a6a 0 80%,#7cbf72 0)',
    fill: ({ props }) => continentColors[props.c] ?? NO_DATA,
    border: 'rgba(15,20,30,.35)',
    value: ({ props }) => props.c,
    legend: { kind: 'swatches', items: continentSwatches },
  },
  {
    id: 'population',
    name: 'Population',
    sub: 'People per country',
    ocean: ['#16233a', '#0a1222'],
    ico: 'linear-gradient(90deg,#1e2a4d,#38a3a5,#f7e67c)',
    fill: ({ props }) => (props.p > 0 ? popScale(props.p) : NO_DATA),
    border: 'rgba(8,12,22,.6)',
    value: ({ props }) => (props.p > 0 ? fmtBig(props.p) : 'no data'),
    legend: rampLegend(popScale, [5e5, 1e7, 1e8, 1.4e9], fmtTick, 'Log scale. Grey means no data.'),
  },
  {
    id: 'density',
    name: 'Density',
    sub: 'People per km²',
    ocean: ['#1a1a2e', '#0b0b18'],
    ico: 'linear-gradient(90deg,#2a1f3d,#b8455b,#f9d77e)',
    fill: ({ dens }) => (dens ? densScale(dens) : NO_DATA),
    border: 'rgba(8,8,16,.6)',
    value: ({ dens }) => (dens ? fmtDensity(dens) : 'no data'),
    legend: rampLegend(
      densScale,
      [1, 10, 100, 1000],
      (d) => d + '/km²',
      'Log scale. 1000+ includes city-states like Singapore.',
    ),
  },
  {
    id: 'gdp',
    name: 'GDP per person',
    sub: 'US dollars, 2019',
    ocean: ['#13262c', '#081418'],
    ico: 'linear-gradient(90deg,#173440,#4ba57a,#f3f1a2)',
    fill: ({ gpc }) => (gpc ? gpcScale(gpc) : NO_DATA),
    border: 'rgba(6,14,16,.6)',
    value: ({ gpc }) => (gpc ? fmtUsd(gpc) : 'no data'),
    legend: rampLegend(
      gpcScale,
      [500, 5000, 50000, 100000],
      (d) => '$' + fmtTick(d),
      'Nominal GDP divided by population, log scale.',
    ),
  },
  {
    id: 'income',
    name: 'Income group',
    sub: 'World Bank classes',
    ocean: ['#1d2a3e', '#0d1626'],
    ico: 'conic-gradient(#3f8fc4 0 25%,#82b77a 0 50%,#e2a250 0 75%,#c9574d 0)',
    fill: ({ props }) => incomeColors[props.i] ?? NO_DATA,
    border: 'rgba(10,14,24,.6)',
    value: ({ props }) => props.i || 'no data',
    legend: {
      kind: 'swatches',
      items: [
        { label: 'High (OECD)', color: incomeColors['High income: OECD'] },
        { label: 'High (other)', color: incomeColors['High income: nonOECD'] },
        { label: 'Upper middle', color: incomeColors['Upper middle income'] },
        { label: 'Lower middle', color: incomeColors['Lower middle income'] },
        { label: 'Low', color: incomeColors['Low income'] },
      ],
    },
  },
  {
    id: 'daynight',
    name: 'Day & night',
    sub: 'Live sunlight right now',
    ocean: ['#1c5585', '#0a2747'],
    ico: 'linear-gradient(100deg,#f0b54a 0 48%,#0b1530 52%)',
    border: 'rgba(30,40,30,0)',
    value: null,
    legend: {
      kind: 'swatches',
      items: [
        { label: 'Sun overhead', color: '#f0b54a', round: true },
        { label: 'Night side', color: '#0b1530' },
      ],
      note: 'Sunlight for the current moment, with twilight bands and city lights on the dark side. Updates every minute.',
    },
  },
];

export const DEFAULT_MODE_ID: ModeId = 'natural';

export function isModeId(value: unknown): value is ModeId {
  return MODES.some((m) => m.id === value);
}

export function modeById(id: ModeId): ModeDef {
  const mode = MODES.find((m) => m.id === id);
  if (!mode) throw new Error(`Unknown map mode: ${id}`);
  return mode;
}

/** Hover tooltip text for a country in a mode. Falls back to the capital when the mode has no value. */
export function tooltipValue(mode: ModeDef, subject: ModeSubject): string {
  return mode.value ? mode.value(subject) : capitalOf(subject);
}
