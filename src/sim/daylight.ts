// The day: what time it is in the game, how dark it is, and how many people are out and about. Pure:
// no DOM, no Three.js, no clocks. The sun times come from the caller (the scene works them out from
// the real sun over the place), so this does not need to know where in the world it is.

export const DAY = {
  /** Hours of the in-game day that pass in a minute of play: a whole day takes 24 minutes. */
  hoursPerMinute: 1,
  /** The hour (local) a game begins, unless told otherwise. */
  start: 8,
  /** Hours from broad daylight to full dark (and back), centred a little before sunset / sunrise. */
  twilight: 1.5,
  /** What the sun times are when the caller does not know (a polar day, or none given). */
  sunrise: 6.5,
  sunset: 18,
} as const;

/** The hour on a 24-hour clock, from 0 up to (not including) 24. */
export const wrapHour = (hour: number): number => ((hour % 24) + 24) % 24;

const smooth = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/**
 * How dark it is, from 0 in daylight to 1 at night, with a smooth twilight either side. Night is
 * full a little over an hour after sunset and lasts until a little over an hour before sunrise.
 */
export function nightness(
  hour: number,
  sunrise: number = DAY.sunrise,
  sunset: number = DAY.sunset,
): number {
  const h = wrapHour(hour);
  const noon = (sunrise + sunset) / 2;
  if (h >= noon) {
    // evening: it starts getting dark just before sunset
    return smooth((h - (sunset - 0.25)) / DAY.twilight);
  }
  // morning: full dark until about an hour before sunrise, then the light comes
  return 1 - smooth((h - (sunrise - DAY.twilight + 0.25)) / DAY.twilight);
}

/** Share of the people who are well that are out of doors at each hour: [hour, share], joined by straight lines. */
const OUTDOORS: readonly (readonly [number, number])[] = [
  [0, 0.015],
  [5, 0.015],
  [7, 0.06],
  [8.5, 0.13], // the morning rush: to work, to school, to market
  [10, 0.11],
  [16, 0.11],
  [17.5, 0.14], // the evening: home from work, an hour in the street
  [19, 0.12],
  [21, 0.05],
  [23, 0.02],
  [24, 0.015],
];

/** The most of them that are ever out (the evening): `outdoorShare` against this is "how busy the street is", 0 to 1. */
export const OUTDOOR_PEAK: number = Math.max(...OUTDOORS.map(([, share]) => share));

/** The share of the city's well people who are outdoors at this hour, from about 1.5% in the small hours to 14%. */
export function outdoorShare(hour: number): number {
  const h = wrapHour(hour);
  for (let i = 1; i < OUTDOORS.length; i++) {
    const [h1, s1] = OUTDOORS[i];
    if (h > h1) continue;
    const [h0, s0] = OUTDOORS[i - 1];
    return s0 + ((s1 - s0) * (h - h0)) / (h1 - h0);
  }
  return OUTDOORS[OUTDOORS.length - 1][1];
}

/**
 * How frightened the city is, 0 to 1: people stay home as the dead fill the streets. Full fear when the
 * turned are this share of the city.
 */
export const PANIC_AT = 0.03;

export function fear(turned: number, people: number): number {
  return people > 0 ? Math.min(1, turned / (PANIC_AT * people)) : 0;
}
