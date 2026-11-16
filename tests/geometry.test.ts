import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FACADE,
  addRibbon,
  addRevolve,
  buildBuildings,
  buildGround,
  buildRoads,
  buildTowers,
  chunkBuildings,
  createMeshBuilder,
  domeProfile,
  footprintArea,
  triangulate,
  type MeshData,
} from '../src/city/geometry';
import type { CityBuilding, CityData } from '../src/city/types';

const sq = (x: number, y: number, w: number, h = w): number[] => [
  x,
  y,
  x + w,
  y,
  x + w,
  y + h,
  x,
  y + h,
];

const building = (
  id: number,
  outer: number[],
  extra: Partial<CityBuilding> = {},
): CityBuilding => ({
  id,
  outer,
  height: 9,
  estimated: false,
  kind: 'apartments',
  ...extra,
});

/**
 * Every triangle's geometric normal (from its winding) must point the same way as the vertex normals
 * stored for it. A mismatch means the face renders inside-out. Returns the number of bad triangles.
 */
function badWinding(mesh: MeshData): number {
  let bad = 0;
  const { positions: p, normals: n, indices: ix } = mesh;
  for (let t = 0; t < ix.length; t += 3) {
    const a = ix[t] * 3;
    const b = ix[t + 1] * 3;
    const c = ix[t + 2] * 3;
    const ux = p[b] - p[a];
    const uy = p[b + 1] - p[a + 1];
    const uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a];
    const vy = p[c + 1] - p[a + 1];
    const vz = p[c + 2] - p[a + 2];
    const gx = uy * vz - uz * vy;
    const gy = uz * vx - ux * vz;
    const gz = ux * vy - uy * vx;
    if (Math.hypot(gx, gy, gz) < 1e-9) continue; // a degenerate sliver (the tip of a dome)
    const mx = n[a] + n[b] + n[c];
    const my = n[a + 1] + n[b + 1] + n[c + 1];
    const mz = n[a + 2] + n[b + 2] + n[c + 2];
    if (gx * mx + gy * my + gz * mz <= 0) bad++;
  }
  return bad;
}

const finite = (a: Float32Array | Uint32Array): boolean => a.every((v) => Number.isFinite(v));

describe('triangulate', () => {
  it('splits a square into two counter-clockwise triangles', () => {
    const { coords, indices } = triangulate(sq(0, 0, 10));
    expect(indices).toHaveLength(6);
    let area = 0;
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]];
      const cross =
        (coords[b * 2] - coords[a * 2]) * (coords[c * 2 + 1] - coords[a * 2 + 1]) -
        (coords[b * 2 + 1] - coords[a * 2 + 1]) * (coords[c * 2] - coords[a * 2]);
      expect(cross).toBeGreaterThan(0);
      area += cross / 2;
    }
    expect(area).toBeCloseTo(100, 9);
  });

  it('leaves a hole open', () => {
    const { coords, indices } = triangulate(sq(0, 0, 20), [[5, 5, 5, 15, 15, 15, 15, 5]]);
    let area = 0;
    for (let i = 0; i < indices.length; i += 3) {
      const [a, b, c] = [indices[i], indices[i + 1], indices[i + 2]];
      area +=
        ((coords[b * 2] - coords[a * 2]) * (coords[c * 2 + 1] - coords[a * 2 + 1]) -
          (coords[b * 2 + 1] - coords[a * 2 + 1]) * (coords[c * 2] - coords[a * 2])) /
        2;
    }
    expect(area).toBeCloseTo(400 - 100, 9);
  });
});

describe('mesh builder', () => {
  it('writes city space (x east, y north, z up) as Three.js space (x, up, -north)', () => {
    const m = createMeshBuilder();
    m.vertex(3, 5, 7, 0, 0, 1, 0.25, 0.75, [1, 0.5, 0.25]);
    const d = m.finish();
    expect([...d.positions]).toEqual([3, 7, -5]);
    expect([...d.normals]).toEqual([0, 1, -0]);
    expect([...d.uvs]).toEqual([0.25, 0.75]);
    expect([...d.colors]).toEqual([1, 0.5, 0.25]);
  });
});

describe('buildings', () => {
  it('extrudes a box into four walls and a roof, all facing outward', () => {
    const { walls, roofs } = buildBuildings([
      building(1, sq(0, 0, 10), { kind: 'house', height: 4 }),
    ]);
    expect(walls.indices).toHaveLength(4 * 6);
    expect(walls.positions).toHaveLength(4 * 4 * 3);
    expect(roofs.indices.length).toBeGreaterThanOrEqual(6);
    expect(badWinding(walls)).toBe(0);
    expect(badWinding(roofs)).toBe(0);
    // roof sits at wall height, which is Three.js y
    expect(
      Math.max(
        ...Array.from({ length: roofs.positions.length / 3 }, (_, i) => roofs.positions[i * 3 + 1]),
      ),
    ).toBeCloseTo(4, 6);
  });

  it('points hole walls into the hole, away from the solid', () => {
    const b = building(2, sq(0, 0, 40), { holes: [[15, 15, 15, 25, 25, 25, 25, 15]] }); // clockwise hole
    const { walls } = buildBuildings([b]);
    expect(badWinding(walls)).toBe(0);
    // find a hole wall (its vertices lie inside 15..25) and confirm its normal points to the hole centre (20, 20)
    const p = walls.positions;
    const n = walls.normals;
    let checked = 0;
    for (let v = 0; v < p.length / 3; v++) {
      const x = p[v * 3];
      const y = -p[v * 3 + 2]; // back to city y
      if (x >= 15 && x <= 25 && y >= 15 && y <= 25) {
        const toCentre = (20 - x) * n[v * 3] + (20 - y) * -n[v * 3 + 2];
        expect(toCentre).toBeGreaterThanOrEqual(-1e-6);
        checked++;
      }
    }
    expect(checked).toBe(16);
  });

  it('maps one window bay to one texture cell and starts each building at a random row', () => {
    const { walls } = buildBuildings([building(3, sq(0, 0, 33), { height: 31 })]);
    const v = Array.from({ length: walls.uvs.length / 2 }, (_, i) => walls.uvs[i * 2 + 1]);
    const span = Math.max(...v) - Math.min(...v);
    expect(span).toBeCloseTo(31 / FACADE.tileH / FACADE.rows, 6);
    const u = Array.from({ length: walls.uvs.length / 2 }, (_, i) => walls.uvs[i * 2]);
    // one side is 33 m = 10 bays; the whole ring is 132 m
    expect(Math.max(...u) - Math.min(...u)).toBeCloseTo(132 / (FACADE.tileW * FACADE.cols), 6);
  });

  it('is deterministic', () => {
    const list = [
      building(10, sq(0, 0, 30), { height: 20 }),
      building(11, sq(50, 0, 25), { height: 14 }),
    ];
    const a = buildBuildings(list);
    const b = buildBuildings(list);
    expect([...a.walls.colors]).toEqual([...b.walls.colors]);
    expect([...a.roofs.positions]).toEqual([...b.roofs.positions]);
  });

  it('adds rooftop clutter to big flat roofs, but not to small houses', () => {
    const big = Array.from({ length: 30 }, (_, i) =>
      building(100 + i, sq(0, 0, 40), { height: 15 }),
    );
    const houses = big.map((b) => ({ ...b, kind: 'house' as const }));
    const withProps = buildBuildings(big).roofs.positions.length;
    const without = buildBuildings(houses).roofs.positions.length;
    expect(withProps).toBeGreaterThan(without);
  });

  it('puts a dome on a mosque', () => {
    const plain = buildBuildings([building(7, sq(0, 0, 20), { kind: 'civic', height: 10 })]);
    const mosque = buildBuildings([building(7, sq(0, 0, 20), { kind: 'religious', height: 10 })]);
    expect(mosque.roofs.positions.length).toBeGreaterThan(plain.roofs.positions.length);
    expect(badWinding(mosque.roofs)).toBe(0);
    const top = Math.max(
      ...Array.from(
        { length: mosque.roofs.positions.length / 3 },
        (_, i) => mosque.roofs.positions[i * 3 + 1],
      ),
    );
    expect(top).toBeGreaterThan(10 + 1.4); // above the drum
  });

  it('groups buildings into tiles', () => {
    const list = [
      building(1, sq(0, 0, 10)),
      building(2, sq(20, 0, 10)),
      building(3, sq(300, 0, 10)),
      building(4, sq(0, -300, 10)),
    ];
    const tiles = chunkBuildings(list, 250);
    expect(tiles).toHaveLength(3);
    expect(tiles.flat()).toHaveLength(4);
  });

  it('measures footprint area', () => {
    expect(footprintArea(sq(0, 0, 10, 4))).toBe(40);
    expect(footprintArea([...sq(0, 0, 10, 4)].reverse())).toBeGreaterThan(0);
  });
});

describe('ribbons, roads and ground', () => {
  it('lays a straight strip of the right width, facing up', () => {
    const m = createMeshBuilder();
    addRibbon(m, [0, 0, 10, 0], 4, 0.05, [1, 1, 1], 0.5);
    const d = m.finish();
    expect(d.positions).toHaveLength(4 * 3);
    expect(badWinding(d)).toBe(0);
    const ys = Array.from({ length: 4 }, (_, i) => -d.positions[i * 3 + 2]);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(4, 9);
    const us = Array.from({ length: 4 }, (_, i) => d.uvs[i * 2]);
    expect(Math.max(...us)).toBeCloseTo(5, 9);
  });

  it('covers a hairpin or a too-short segment with a disc instead of folding the strip', () => {
    const m = createMeshBuilder();
    // a sharp zig-zag with segments shorter than the road is wide
    addRibbon(m, [0, 0, 3, 0.5, 0, 1, 3, 1.5, 0, 2], 8, 0.05, [1, 1, 1], 0.1);
    const d = m.finish();
    expect(badWinding(d)).toBe(0);
    expect(finite(d.positions)).toBe(true);
  });

  it('keeps a mitred corner from spiking and faces every quad up', () => {
    const m = createMeshBuilder();
    addRibbon(m, [0, 0, 50, 0, 50, 50, 0, 50, 0, 0], 6, 0.05, [1, 1, 1], 0.1);
    const d = m.finish();
    expect(badWinding(d)).toBe(0);
    expect(finite(d.positions)).toBe(true);
    // 3 m half width: even sharp corners stay within 2x of that
    const reach = Math.max(
      ...Array.from({ length: d.positions.length / 3 }, (_, i) =>
        Math.max(Math.abs(d.positions[i * 3]), Math.abs(d.positions[i * 3 + 2])),
      ),
    );
    expect(reach).toBeLessThanOrEqual(50 + 6 + 1e-6);
  });

  it('sorts roads into major, minor and path meshes', () => {
    const line = [0, 0, 100, 0];
    const meshes = buildRoads([
      { kind: 'primary', points: line, width: 12 },
      { kind: 'secondary', points: line, width: 10 },
      { kind: 'residential', points: line, width: 6 },
      { kind: 'path', points: line, width: 1.8 },
    ]);
    // each straight road is one ribbon of 4 vertices
    expect(meshes.major.positions.length / 3).toBe(8); // primary + secondary
    expect(meshes.minor.positions.length / 3).toBe(4); // residential
    expect(meshes.paths.positions.length / 3).toBe(4); // path
  });

  it('splits land from water', () => {
    const { land, water } = buildGround(
      [
        { kind: 'park', outer: sq(0, 0, 50) },
        { kind: 'water', outer: sq(100, 0, 50) },
        { kind: 'plaza', outer: sq(0, 100, 30) },
      ],
      [{ kind: 'canal', points: [0, 200, 100, 200], width: 8 }],
    );
    expect(land.positions.length / 3).toBe(8);
    expect(water.positions.length / 3).toBe(4 + 4);
    expect(badWinding(land)).toBe(0);
    expect(badWinding(water)).toBe(0);
  });
});

describe('revolved shapes and towers', () => {
  it('builds a dome that faces outward everywhere', () => {
    const m = createMeshBuilder();
    addRevolve(m, 0, 0, 0, domeProfile(6), 14, [1, 1, 1]);
    const d = m.finish();
    expect(badWinding(d)).toBe(0);
    const top = Math.max(
      ...Array.from({ length: d.positions.length / 3 }, (_, i) => d.positions[i * 3 + 1]),
    );
    expect(top).toBeCloseTo(1.4 + 6 * 0.95, 6);
  });

  it('builds a tall TV tower to its full height', () => {
    const d = buildTowers([{ x: 0, y: 0, height: 375, kind: 'tower', name: 'TV' }]);
    expect(badWinding(d)).toBe(0);
    expect(finite(d.positions)).toBe(true);
    const top = Math.max(
      ...Array.from({ length: d.positions.length / 3 }, (_, i) => d.positions[i * 3 + 1]),
    );
    expect(top).toBeCloseTo(375, 6);
  });

  it('builds every tower kind without bad faces', () => {
    for (const kind of ['tower', 'mast', 'chimney', 'water_tower'] as const) {
      const d = buildTowers([{ x: 5, y: 5, height: 40, kind }]);
      expect(d.indices.length).toBeGreaterThan(0);
      expect(badWinding(d)).toBe(0);
    }
  });
});

describe('the real Tashkent file', () => {
  const city = JSON.parse(readFileSync(resolve('public/cities/tashkent.json'), 'utf8')) as CityData;

  it('builds into well-formed meshes with every face the right way round', () => {
    const tiles = chunkBuildings(city.buildings, 250);
    let triangles = 0;
    for (const tile of tiles) {
      const { walls, roofs } = buildBuildings(tile);
      for (const mesh of [walls, roofs]) {
        expect(
          finite(mesh.positions) && finite(mesh.normals) && finite(mesh.colors) && finite(mesh.uvs),
        ).toBe(true);
        expect(badWinding(mesh)).toBe(0);
        triangles += mesh.indices.length / 3;
      }
    }
    expect(tiles.length).toBeGreaterThan(10);
    expect(triangles).toBeGreaterThan(50_000);
  });

  it('builds the roads, ground and towers too', () => {
    const roads = buildRoads(city.roads);
    const ground = buildGround(city.areas, city.waterways);
    const towers = buildTowers(city.towers);
    const meshes = {
      major: roads.major,
      minor: roads.minor,
      paths: roads.paths,
      land: ground.land,
      water: ground.water,
      towers,
    };
    for (const [name, mesh] of Object.entries(meshes)) {
      expect(finite(mesh.positions), `${name} has finite positions`).toBe(true);
      expect(badWinding(mesh), `${name} has faces the wrong way round`).toBe(0);
    }
    expect(roads.major.indices.length).toBeGreaterThan(0);
    expect(towers.indices.length).toBeGreaterThan(0);
  });
});
