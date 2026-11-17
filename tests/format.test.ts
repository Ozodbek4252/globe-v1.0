import { describe, expect, it } from 'vitest';
import {
  fmtArea,
  fmtBig,
  fmtClock,
  fmtDensity,
  fmtGdp,
  fmtLatLon,
  fmtTick,
  fmtUsd,
} from '../src/lib/format';

describe('fmtBig', () => {
  it.each([
    [0, '0'],
    [0.4, '0'],
    [999, '999'],
    [1000, '1 K'],
    [889953, '890 K'],
    [999_999, '1000 K'], // existing rounding behaviour, kept as is
    [1e6, '1.0 M'],
    [34_232_050, '34.2 M'],
    [999_999_999, '1000.0 M'],
    [1e9, '1.00 B'],
    [1.4e9, '1.40 B'],
  ])('%d -> %s', (n, expected) => {
    expect(fmtBig(n)).toBe(expected);
  });
});

describe('fmtTick', () => {
  it.each([
    [1, '1'],
    [500, '500'],
    [5e5, '500K'],
    [1e6, '1M'],
    [1e7, '10M'],
    [1e8, '100M'],
    [1e9, '1B'],
    [1.4e9, '1.4B'],
  ])('%d -> %s', (n, expected) => {
    expect(fmtTick(n)).toBe(expected);
  });
});

describe('fmtUsd', () => {
  it.each([
    [0, '$0'],
    [500, '$500'],
    [12345.6, '$12,346'],
    [100000, '$100,000'],
    [1234567.5, '$1,234,568'],
  ])('%d -> %s', (n, expected) => {
    expect(fmtUsd(n)).toBe(expected);
  });
});

describe('fmtGdp (input in millions of USD)', () => {
  it.each([
    [5496, '$5.5 B'],
    [999_999, '$1000.0 B'],
    [1e6, '$1.00 T'],
    [21_433_226, '$21.43 T'],
  ])('%d -> %s', (n, expected) => {
    expect(fmtGdp(n)).toBe(expected);
  });
});

describe('fmtDensity', () => {
  it.each([
    [1, '1.0 /km²'],
    [23.456, '23.5 /km²'],
    [8358, '8,358.0 /km²'],
  ])('%d -> %s', (n, expected) => {
    expect(fmtDensity(n)).toBe(expected);
  });
});

describe('fmtArea', () => {
  it('rounds to the nearest 1,000 km²', () => {
    expect(fmtArea(448_978)).toBe('≈ 449,000 km²');
    expect(fmtArea(499)).toBe('≈ 0 km²');
    expect(fmtArea(17_098_242)).toBe('≈ 17,098,000 km²');
  });
});

describe('fmtLatLon', () => {
  it('uses N/S and E/W with one decimal', () => {
    expect(fmtLatLon(41.3, 69.2)).toBe('41.3°N 69.2°E');
    expect(fmtLatLon(-22.04, -30.26)).toBe('22.0°S 30.3°W');
  });
  it('treats zero as north and east, as the legacy readout did', () => {
    expect(fmtLatLon(0, 0)).toBe('0.0°N 0.0°E');
  });
});

describe('fmtClock', () => {
  it.each([
    [0, '0:00'],
    [7.9, '0:07'],
    [59, '0:59'],
    [60, '1:00'],
    [247, '4:07'],
    [3599, '59:59'],
    [3600, '1:00:00'],
    [3847, '1:04:07'],
    [-5, '0:00'],
  ])('%d s -> %s', (seconds, expected) => {
    expect(fmtClock(seconds)).toBe(expected);
  });
});
