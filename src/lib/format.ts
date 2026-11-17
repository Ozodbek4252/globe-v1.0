import { format } from 'd3-format';

const groupInt = format(',');
const oneDecimal = format(',.1f');

/** Compact count with one more digit as it grows: 890 K, 34.2 M, 1.40 B. */
export function fmtBig(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + ' B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + ' M';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + ' K';
  return String(Math.round(n));
}

/** Short tick label for a legend: 500K, 10M, 1.4B. */
export function fmtTick(n: number): string {
  if (n >= 1e9) return String(n / 1e9) + 'B';
  if (n >= 1e6) return String(n / 1e6) + 'M';
  if (n >= 1e3) return String(n / 1e3) + 'K';
  return String(n);
}

/** Whole US dollars with thousands separators: $12,346. */
export function fmtUsd(n: number): string {
  return '$' + groupInt(Math.round(n));
}

/** GDP given in millions of US dollars: $5.5 B, $21.00 T. */
export function fmtGdp(millions: number): string {
  return millions >= 1e6
    ? '$' + (millions / 1e6).toFixed(2) + ' T'
    : '$' + (millions / 1e3).toFixed(1) + ' B';
}

/** People per km². */
export function fmtDensity(n: number): string {
  return oneDecimal(n) + ' /km²';
}

/** Area rounded to the nearest 1,000 km², since it is measured from simplified borders. */
export function fmtArea(km2: number): string {
  return '≈ ' + groupInt(Math.round(km2 / 1000) * 1000) + ' km²';
}

/** Minutes and seconds, counting up: 4:07. Past an hour, 1:04:07. */
export function fmtClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const s = String(total % 60).padStart(2, '0');
  const m = Math.floor(total / 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** 12.3°N 45.6°W */
export function fmtLatLon(lat: number, lon: number): string {
  return (
    `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'} ` +
    `${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`
  );
}
