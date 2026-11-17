import { geoOrthographic } from 'd3-geo';
import { describe, expect, it } from 'vitest';
import { facing, markerAt, markerPosition, MARKER_HIT } from '../src/globe/markers';
import type { GlobeMarker } from '../src/globe/types';

/** A globe 600 px across, centred in an 800 x 600 canvas, turned to look at (lon, lat). */
function globeAt(lon: number, lat: number) {
  const rot: [number, number, number] = [-lon, -lat, 0];
  const proj = geoOrthographic().translate([400, 300]).scale(300).rotate(rot).precision(0.1);
  return { proj, rot };
}

const marker = (id: string, lon: number, lat: number, fallen = false): GlobeMarker => ({
  id,
  name: id,
  lat,
  lon,
  fallen,
});

describe('which side of the globe a place is on', () => {
  it('faces us when near the centre of the view, and not on the far side', () => {
    const { rot } = globeAt(10, 40);
    expect(facing(rot, 10, 40)).toBe(true);
    expect(facing(rot, 30, 50)).toBe(true);
    expect(facing(rot, 10 + 180, -40)).toBe(false); // the opposite side
    expect(facing(rot, 10 + 160, 40)).toBe(false); // 160 degrees of longitude is over 90 degrees of arc at 40 N
  });

  it('takes the edge as the far side, so a pin never sits on the rim', () => {
    const { rot } = globeAt(0, 0);
    expect(facing(rot, 89, 0)).toBe(false);
    expect(facing(rot, 85, 0)).toBe(true);
  });
});

describe('where a pin is', () => {
  it('is at the centre of the screen when it is the centre of the view', () => {
    const { proj, rot } = globeAt(69.28, 41.35);
    const at = markerPosition(proj, rot, marker('tashkent', 69.28, 41.35));
    expect(at?.[0]).toBeCloseTo(400, 3);
    expect(at?.[1]).toBeCloseTo(300, 3);
  });

  it('is east of the centre for a place to the east', () => {
    const { proj, rot } = globeAt(0, 0);
    const at = markerPosition(proj, rot, marker('east', 20, 0));
    expect(at?.[0]).toBeGreaterThan(400);
    expect(at?.[1]).toBeCloseTo(300, 3);
  });

  it('is nowhere for a place on the far side', () => {
    const { proj, rot } = globeAt(0, 0);
    expect(markerPosition(proj, rot, marker('far', 170, 0))).toBeNull();
  });
});

describe('clicking a pin', () => {
  const { proj, rot } = globeAt(0, 0);
  const a = marker('a', 0, 0);
  const b = marker('b', 10, 0);
  const far = marker('far', 180, 0);

  it('finds the pin under the pointer, and within the reach, not beyond', () => {
    expect(markerAt(proj, rot, [a, b], 400, 300)?.id).toBe('a');
    expect(markerAt(proj, rot, [a, b], 400 + MARKER_HIT - 1, 300)?.id).toBe('a');
    expect(markerAt(proj, rot, [a], 400 + MARKER_HIT + 4, 300)).toBeNull();
  });

  it('prefers the nearer of two', () => {
    const at = markerPosition(proj, rot, b)!;
    expect(markerAt(proj, rot, [a, b], at[0] - 2, at[1], 100)?.id).toBe('b');
  });

  it('ignores a pin on the far side, even where it would be on the screen', () => {
    expect(markerAt(proj, rot, [far], 400, 300)).toBeNull();
  });

  it('finds nothing when there are no pins', () => {
    expect(markerAt(proj, rot, [], 400, 300)).toBeNull();
  });
});
