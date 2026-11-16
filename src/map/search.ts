import type { Country } from './types';

/** Country names for the search box suggestions, in plain code-unit order like the legacy list. */
export function countryNames(countries: readonly Country[]): string[] {
  return countries.map((c) => c.props.n).sort();
}

/**
 * Find a country from what was typed: an exact name, else a name that starts with it,
 * else a formal name that contains it. Case-insensitive. Returns undefined for no match.
 */
export function findCountry(countries: readonly Country[], query: string): Country | undefined {
  const v = query.trim().toLowerCase();
  if (!v) return undefined;
  return (
    countries.find((c) => c.props.n.toLowerCase() === v) ??
    countries.find((c) => c.props.n.toLowerCase().startsWith(v)) ??
    countries.find((c) => c.props.f.toLowerCase().includes(v))
  );
}
