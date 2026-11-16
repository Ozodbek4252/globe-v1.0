import { describe, expect, it } from 'vitest';
import {
  assembleRings,
  boundingBox,
  buildingHeight,
  classifyBuilding,
  clipLine,
  clipRing,
  convertOverpass,
  dedupeRing,
  estimateHeight,
  makeProjector,
  orient,
  overpassQuery,
  parseLevels,
  parseMeters,
  ringCentroid,
  signedArea,
  type OverpassElement,
  type Point,
} from '../src/city/osm';

const CENTER: [number, number] = [69.2849, 41.3433];
const HALF = 500;

// Metres to degrees, derived from the projector itself so the fixture is exact by construction.
const project = makeProjector(CENTER[0], CENTER[1]);
const mPerLon = project(CENTER[0] + 1, CENTER[1])[0];
const mPerLat = project(CENTER[0], CENTER[1] + 1)[1];
const ll = ([x, y]: Point): { lat: number; lon: number } => ({
  lat: CENTER[1] + y / mPerLat,
  lon: CENTER[0] + x / mPerLon,
});

const way = (
  id: number,
  tags: Record<string, string>,
  pts: Point[],
  close = true,
): OverpassElement => ({
  type: 'way',
  id,
  tags,
  geometry: (close ? [...pts, pts[0]] : pts).map(ll),
});

const rect = (x: number, y: number, w: number, h: number): Point[] => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];

const convert = (elements: OverpassElement[]) =>
  convertOverpass(
    { elements },
    { id: 'test', name: 'Test', center: CENTER, halfSize: HALF, generated: '2026-01-01' },
  );

describe('projection', () => {
  it('puts the centre at the origin and measures real distances', () => {
    expect(project(CENTER[0], CENTER[1])).toEqual([0, 0]);
    // one degree of latitude is about 111 km anywhere
    expect(mPerLat).toBeGreaterThan(110_900);
    expect(mPerLat).toBeLessThan(111_300);
    // and a degree of longitude shrinks with latitude (cos 41.3 degrees = 0.751)
    expect(mPerLon / mPerLat).toBeCloseTo(Math.cos((41.3433 * Math.PI) / 180), 2);
    const [x, y] = project(CENTER[0], CENTER[1] + 100 / mPerLat);
    expect(x).toBeCloseTo(0, 6);
    expect(y).toBeCloseTo(100, 6);
  });

  it('builds a query box a little larger than the playable square', () => {
    const [s, w, n, e] = boundingBox(CENTER, 1000, 60);
    expect((n - s) * mPerLat).toBeCloseTo(2120, 0);
    expect((e - w) * mPerLon).toBeCloseTo(2120, 0);
    const q = overpassQuery(CENTER, 1000);
    expect(q).toContain(`[bbox:${s},${w},${n},${e}]`);
    expect(q).toContain('way["building"]');
    expect(q).toContain('node["natural"="tree"]');
    expect(q).toContain('out tags geom;');
  });
});

describe('tag parsing', () => {
  it.each([
    ['12', 12],
    ['12.5', 12.5],
    ['12,5', 12.5],
    ['12 m', 12],
    ['12m', 12],
    ['40 ft', 12.192],
    [`40'`, 12.192],
  ])('parseMeters(%s) = %d', (input, expected) => {
    expect(parseMeters(input)).toBeCloseTo(expected, 3);
  });

  it.each(['', 'tall', '12 stories', '~12', undefined])('parseMeters rejects %s', (input) => {
    expect(parseMeters(input)).toBeNull();
  });

  it('reads levels from the usual messy values', () => {
    expect(parseLevels('5')).toBe(5);
    expect(parseLevels('5;6')).toBe(5);
    expect(parseLevels('4-5')).toBe(4);
    expect(parseLevels('0')).toBeNull();
    expect(parseLevels(undefined)).toBeNull();
    expect(parseLevels('many')).toBeNull();
  });
});

describe('ring helpers', () => {
  const ccw = rect(0, 0, 10, 4);

  it('signs area by winding and orients rings', () => {
    expect(signedArea(ccw)).toBe(40);
    expect(signedArea([...ccw].reverse())).toBe(-40);
    expect(signedArea(orient([...ccw].reverse(), true))).toBe(40);
    expect(signedArea(orient(ccw, false))).toBe(-40);
  });

  it('finds the centroid', () => {
    const [cx, cy] = ringCentroid(ccw);
    expect(cx).toBeCloseTo(5, 9);
    expect(cy).toBeCloseTo(2, 9);
  });

  it('drops a repeated closing point and consecutive duplicates', () => {
    const closed: Point[] = [...ccw, ccw[0]];
    expect(dedupeRing(closed)).toEqual(ccw);
    expect(dedupeRing([ccw[0], ccw[0], ccw[1], ccw[2], ccw[3]])).toEqual(ccw);
  });

  it('joins way fragments, whichever way they point, into one closed ring', () => {
    const a: Point[] = [
      [0, 0],
      [10, 0],
      [10, 10],
    ];
    const b: Point[] = [
      [0, 10],
      [10, 10],
    ]; // pointing the "wrong" way
    const c: Point[] = [
      [0, 10],
      [0, 0],
    ];
    const rings = assembleRings([a, b, c]);
    expect(rings).toHaveLength(1);
    expect(rings[0]).toHaveLength(4);
    expect(Math.abs(signedArea(rings[0]))).toBe(100);
  });

  it('ignores fragments that never close', () => {
    expect(
      assembleRings([
        [
          [0, 0],
          [10, 0],
          [10, 10],
        ],
      ]),
    ).toEqual([]);
  });
});

describe('clipping to the play square', () => {
  it('trims a polygon that overhangs the edge', () => {
    const clipped = clipRing(rect(400, 400, 200, 50), 500);
    expect(Math.max(...clipped.map((p) => p[0]))).toBe(500);
    expect(Math.abs(signedArea(clipped))).toBeCloseTo(100 * 50, 6);
  });

  it('drops a polygon that is entirely outside', () => {
    expect(clipRing(rect(600, 0, 50, 50), 500)).toEqual([]);
  });

  it('keeps a polygon that is entirely inside unchanged', () => {
    expect(clipRing(rect(-10, -10, 20, 20), 500)).toHaveLength(4);
  });

  it('cuts a line at the edge', () => {
    const [line] = clipLine(
      [
        [0, 0],
        [1000, 0],
      ],
      500,
    );
    expect(line).toEqual([
      [0, 0],
      [500, 0],
    ]);
  });

  it('splits a line that leaves and re-enters into two pieces', () => {
    const pieces = clipLine(
      [
        [0, 0],
        [700, 0],
        [700, 100],
        [0, 100],
      ],
      500,
    );
    expect(pieces).toHaveLength(2);
    const exit = pieces[0].at(-1)!;
    const reenter = pieces[1][0];
    expect(exit[0]).toBeCloseTo(500, 9);
    expect(exit[1]).toBeCloseTo(0, 9);
    expect(reenter[0]).toBeCloseTo(500, 9);
    expect(reenter[1]).toBeCloseTo(100, 9);
  });

  it('drops a line that never enters', () => {
    expect(
      clipLine(
        [
          [600, 0],
          [900, 0],
        ],
        500,
      ),
    ).toEqual([]);
  });
});

describe('building classification and height', () => {
  it('groups OSM values into game kinds', () => {
    expect(classifyBuilding({ building: 'apartments' }, 800)).toBe('apartments');
    expect(classifyBuilding({ building: 'detached' }, 120)).toBe('house');
    expect(classifyBuilding({ building: 'warehouse' }, 900)).toBe('industrial');
    expect(classifyBuilding({ building: 'yes', amenity: 'school' }, 900)).toBe('civic');
    expect(classifyBuilding({ building: 'yes', shop: 'supermarket' }, 900)).toBe('commercial');
    expect(classifyBuilding({ building: 'mosque' }, 300)).toBe('religious');
    expect(classifyBuilding({ building: 'garages' }, 40)).toBe('garage');
    expect(classifyBuilding({ building: 'yes' }, 100)).toBe('other');
  });

  it('treats a big "residential" block as apartments and a small one as a house', () => {
    expect(classifyBuilding({ building: 'residential' }, 900)).toBe('apartments');
    expect(classifyBuilding({ building: 'residential' }, 150)).toBe('house');
    expect(classifyBuilding({ building: 'yes', 'building:levels': '9' }, 150)).toBe('apartments');
  });

  it('prefers a height tag, then levels, then an estimate', () => {
    expect(buildingHeight({ height: '30', 'building:levels': '5' }, 'apartments', 800, 1)).toEqual({
      height: 30,
      estimated: false,
    });
    expect(buildingHeight({ 'building:levels': '5' }, 'apartments', 800, 1)).toEqual({
      height: 15.5,
      estimated: false,
    });
    const guess = buildingHeight({}, 'apartments', 800, 1);
    expect(guess.estimated).toBe(true);
    expect(guess.height).toBeGreaterThanOrEqual(12);
  });

  it('keeps heights within sane limits', () => {
    expect(buildingHeight({ height: '0.5' }, 'house', 100, 1).height).toBeGreaterThanOrEqual(2.4);
    expect(buildingHeight({ height: '9000' }, 'house', 100, 1).height).toBe(500);
  });

  it('estimates the same height for the same building every time', () => {
    expect(estimateHeight('apartments', 800, 123456789)).toBe(
      estimateHeight('apartments', 800, 123456789),
    );
  });

  it('gives each kind a plausible range and mixes heights across buildings', () => {
    const range = (kind: Parameters<typeof estimateHeight>[0], area: number) => {
      const hs = Array.from({ length: 400 }, (_, i) => estimateHeight(kind, area, i + 1));
      return [Math.min(...hs), Math.max(...hs), new Set(hs).size] as const;
    };
    const [houseMin, houseMax] = range('house', 120);
    expect(houseMin).toBeGreaterThanOrEqual(3);
    expect(houseMax).toBeLessThanOrEqual(7);
    const [aptMin, aptMax, aptVariety] = range('apartments', 800);
    expect(aptMin).toBeGreaterThanOrEqual(12);
    expect(aptMax).toBeLessThanOrEqual(50);
    expect(aptVariety).toBeGreaterThan(3);
    const [gMin, gMax] = range('garage', 30);
    expect(gMin).toBeGreaterThanOrEqual(2.5);
    expect(gMax).toBeLessThanOrEqual(3.5);
  });
});

describe('convertOverpass', () => {
  it('stamps the metadata', () => {
    const city = convert([]);
    expect(city).toMatchObject({
      version: 1,
      id: 'test',
      name: 'Test',
      center: CENTER,
      halfSize: HALF,
      generated: '2026-01-01',
      attribution: '© OpenStreetMap contributors (ODbL)',
    });
  });

  it('reads a tagged building as a counter-clockwise outline with its tagged height', () => {
    const cw = [...rect(10, 10, 20, 10)].reverse(); // drawn clockwise in the source
    const [b] = convert([
      way(1, { building: 'apartments', 'building:levels': '5', name: 'Block 7' }, cw),
    ]).buildings;
    expect(b).toMatchObject({
      id: 1,
      kind: 'apartments',
      height: 15.5,
      estimated: false,
      name: 'Block 7',
    });
    const ring: Point[] = [];
    for (let i = 0; i < b.outer.length; i += 2) ring.push([b.outer[i], b.outer[i + 1]]);
    expect(ring).toHaveLength(4);
    expect(signedArea(ring)).toBeCloseTo(200, 0);
  });

  it('marks guessed heights, keeps the roof shape, and rounds to 0.1 m', () => {
    const [b] = convert([
      way(2, { building: 'yes', 'roof:shape': 'dome' }, rect(0, 0, 12, 12)),
    ]).buildings;
    expect(b.estimated).toBe(true);
    expect(b.roof).toBe('dome');
    for (const n of b.outer) expect(Math.round(n * 10)).toBeCloseTo(n * 10, 6);
  });

  it('drops buildings whose centre is outside the play square, and tiny ones', () => {
    const city = convert([
      way(3, { building: 'yes' }, rect(700, 0, 20, 20)),
      way(4, { building: 'yes' }, rect(0, 0, 1, 1)),
      way(5, { building: 'yes' }, rect(0, 0, 10, 10)),
    ]);
    expect(city.buildings.map((b) => b.id)).toEqual([5]);
  });

  it('reads a multipolygon building with a courtyard hole', () => {
    const outer = rect(0, 0, 40, 40);
    const inner = rect(15, 15, 10, 10);
    const city = convert([
      {
        type: 'relation',
        id: 6,
        tags: { type: 'multipolygon', building: 'yes', 'building:levels': '4' },
        members: [
          { type: 'way', ref: 61, role: 'outer', geometry: [...outer, outer[0]].map(ll) },
          { type: 'way', ref: 62, role: 'inner', geometry: [...inner, inner[0]].map(ll) },
        ],
      },
    ]);
    const [b] = city.buildings;
    expect(b.holes).toHaveLength(1);
    const holeRing: Point[] = [];
    for (let i = 0; i < b.holes![0].length; i += 2)
      holeRing.push([b.holes![0][i], b.holes![0][i + 1]]);
    expect(signedArea(holeRing)).toBeLessThan(0); // holes run clockwise
  });

  it('classes roads, keeps widths, flags bridges and skips tunnels', () => {
    const city = convert([
      way(
        10,
        { highway: 'primary', lanes: '4', name: 'Main Street' },
        [
          [-100, 0],
          [100, 0],
        ],
        false,
      ),
      way(
        11,
        { highway: 'footway' },
        [
          [0, -50],
          [0, 50],
        ],
        false,
      ),
      way(
        12,
        { highway: 'residential', bridge: 'yes' },
        [
          [-50, 20],
          [50, 20],
        ],
        false,
      ),
      way(
        13,
        { highway: 'secondary', tunnel: 'yes' },
        [
          [-50, 40],
          [50, 40],
        ],
        false,
      ),
      way(
        14,
        { highway: 'construction' },
        [
          [-50, 60],
          [50, 60],
        ],
        false,
      ),
    ]);
    expect(city.roads.map((r) => r.kind)).toEqual(['primary', 'path', 'residential']);
    expect(city.roads[0]).toMatchObject({ width: 14.2, name: 'Main Street' });
    expect(city.roads[1].width).toBe(1.8);
    expect(city.roads[2].bridge).toBe(true);
  });

  it('clips roads that run past the edge of the play area', () => {
    const [road] = convert([
      way(
        15,
        { highway: 'residential' },
        [
          [0, 0],
          [2000, 0],
        ],
        false,
      ),
    ]).roads;
    expect(road.points.slice(-2)).toEqual([HALF, 0]);
  });

  it('reads water, parks and plazas as areas and canals as waterways', () => {
    const city = convert([
      way(20, { natural: 'water' }, rect(-100, -100, 60, 40)),
      way(21, { leisure: 'park' }, rect(0, 100, 80, 80)),
      way(22, { place: 'square' }, rect(100, 100, 40, 40)),
      way(23, { landuse: 'residential' }, rect(0, 0, 40, 40)), // not something the game draws
      way(
        24,
        { waterway: 'canal' },
        [
          [-200, 0],
          [200, 0],
        ],
        false,
      ),
    ]);
    expect(city.areas.map((a) => a.kind)).toEqual(['water', 'park', 'plaza']);
    expect(city.waterways).toHaveLength(1);
    expect(city.waterways[0]).toMatchObject({ kind: 'canal', width: 10 });
  });

  it('reads trees and towers, and uses the middle of a tower drawn as an outline', () => {
    const city = convert([
      { type: 'node', id: 30, tags: { natural: 'tree' }, ...ll([12.34, 56.78]) },
      { type: 'node', id: 31, tags: { natural: 'tree' }, ...ll([900, 0]) }, // outside
      way(32, { man_made: 'tower', name: 'TV Tower', height: '375' }, rect(100, 100, 20, 20)),
    ]);
    expect(city.trees).toEqual([12.3, 56.8]);
    expect(city.towers).toHaveLength(1);
    expect(city.towers[0]).toMatchObject({
      kind: 'tower',
      height: 375,
      name: 'TV Tower',
      x: 110,
      y: 110,
    });
  });

  it('produces the same output regardless of the order Overpass returned things in', () => {
    const elements = [
      way(41, { building: 'yes', 'building:levels': '3' }, rect(0, 0, 10, 10)),
      way(40, { building: 'yes', 'building:levels': '2' }, rect(30, 0, 10, 10)),
      way(
        42,
        { highway: 'service' },
        [
          [0, 50],
          [80, 50],
        ],
        false,
      ),
    ];
    const a = convert(elements);
    const b = convert([...elements].reverse());
    expect(a).toEqual(b);
    expect(a.buildings.map((x) => x.id)).toEqual([40, 41]);
  });
});
