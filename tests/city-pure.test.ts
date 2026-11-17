import { describe, expect, it } from 'vitest';
import {
  MAX_DISTANCE,
  MAX_PITCH,
  MIN_DISTANCE,
  MIN_PITCH,
  cameraPosition,
  ease,
  groundAxes,
  keepInside,
  metresPerPixel,
  pan,
  rotate,
  zoom,
  type Rig,
} from '../src/city/cameraRig';
import { LAMP_STRIDE, MAX_LAMPS, placeLamps } from '../src/city/lamps';
import { buildOccupancy } from '../src/city/occupancy';
import { footprintArea } from '../src/city/geometry';
import { localSun, skyPalette, sunDirection } from '../src/city/sunlight';
import { MAX_TREES, TREE_STRIDE, placeTrees } from '../src/city/trees';
import { loadTashkent } from './helpers/tashkent';
import {
  OCC_BUILDING,
  OCC_ROAD,
  OCC_WATER,
  cellCoord,
  countCells,
  occupancyAt,
} from '../src/sim/grid';

const city = loadTashkent().city;
const [LON, LAT] = city.center;

describe('sun over Tashkent', () => {
  it('stands at about 72 degrees, due south, at local noon on the June solstice', () => {
    const { elevation, azimuth } = localSun(Date.UTC(2024, 5, 21, 7, 24), LON, LAT);
    expect(elevation).toBeGreaterThan(71.5);
    expect(elevation).toBeLessThan(72.8);
    expect(azimuth).toBeGreaterThan(176);
    expect(azimuth).toBeLessThan(184);
  });

  it('stands at about 25 degrees at local noon on the December solstice', () => {
    const { elevation, azimuth } = localSun(Date.UTC(2024, 11, 21, 7, 21), LON, LAT);
    expect(elevation).toBeGreaterThan(24.5);
    expect(elevation).toBeLessThan(26);
    expect(azimuth).toBeGreaterThan(176);
    expect(azimuth).toBeLessThan(184);
  });

  it('rises in the east and sets in the west at the equinox', () => {
    const sunrise = localSun(Date.UTC(2024, 2, 20, 1, 30), LON, LAT);
    expect(Math.abs(sunrise.elevation)).toBeLessThan(1.5);
    expect(sunrise.azimuth).toBeGreaterThan(86);
    expect(sunrise.azimuth).toBeLessThan(94);
    const sunset = localSun(Date.UTC(2024, 2, 20, 13, 30), LON, LAT);
    expect(Math.abs(sunset.elevation)).toBeLessThan(1.5);
    expect(sunset.azimuth).toBeGreaterThan(266);
    expect(sunset.azimuth).toBeLessThan(274);
  });

  it('is below the horizon in the middle of the night', () => {
    expect(localSun(Date.UTC(2024, 5, 21, 21, 0), LON, LAT).elevation).toBeLessThan(-10);
  });

  it('gives a unit direction in Three.js space: up is +y, south is +z', () => {
    const noon = sunDirection({ elevation: 45, azimuth: 180 });
    expect(Math.hypot(...noon)).toBeCloseTo(1, 12);
    expect(noon[1]).toBeCloseTo(Math.sin(Math.PI / 4), 12);
    expect(noon[2]).toBeGreaterThan(0); // the sun is to the south, which is +z
    expect(noon[0]).toBeCloseTo(0, 12);
    const east = sunDirection({ elevation: 0, azimuth: 90 });
    expect(east[0]).toBeCloseTo(1, 12);
  });
});

describe('sky palette', () => {
  it('glows the windows at night and not by day', () => {
    expect(skyPalette(-20).windowGlow).toBe(1);
    expect(skyPalette(30).windowGlow).toBe(0);
    expect(skyPalette(-2).windowGlow).toBeGreaterThan(0.3);
  });

  it('compensates for a low sun, so dusk and night stay readable', () => {
    // A low sun is boosted and the exposure raised; noon needs neither.
    expect(skyPalette(4).lightIntensity).toBeGreaterThan(skyPalette(65).lightIntensity);
    const exposures = [-18, -8, -2, 4, 12, 30, 65].map((e) => skyPalette(e).exposure);
    for (let i = 1; i < exposures.length; i++)
      expect(exposures[i]).toBeLessThanOrEqual(exposures[i - 1]);
    expect(skyPalette(-18).exposure).toBeGreaterThan(1.5);
    expect(skyPalette(65).exposure).toBe(1);
    // and even the middle of the night has real ambient light
    expect(skyPalette(-18).hemiIntensity).toBeGreaterThan(1.5);
  });

  it('changes smoothly and keeps every colour in range', () => {
    let previous = skyPalette(-25);
    for (let e = -24.9; e <= 80; e += 0.1) {
      const p = skyPalette(e);
      expect(Math.abs(p.lightIntensity - previous.lightIntensity)).toBeLessThan(0.15);
      expect(Math.abs(p.windowGlow - previous.windowGlow)).toBeLessThan(0.1);
      for (const c of [p.zenith, p.horizon, p.light, p.hemiSky, p.hemiGround]) {
        for (const channel of c) {
          expect(channel).toBeGreaterThanOrEqual(0);
          expect(channel).toBeLessThanOrEqual(1);
        }
      }
      previous = p;
    }
  });

  it('turns the horizon orange at sunset', () => {
    const [r, , b] = skyPalette(0).horizon;
    expect(r).toBeGreaterThan(b * 1.5);
  });
});

describe('camera rig', () => {
  const rig: Rig = { x: 0, z: 0, yaw: 0, pitch: Math.PI / 4, distance: 100 };

  it('looks north from the south at yaw 0, and its right-hand side is east', () => {
    const axes = groundAxes(0);
    expect(axes.forward[0]).toBeCloseTo(0, 12);
    expect(axes.forward[1]).toBeCloseTo(-1, 12);
    expect(axes.right[0]).toBeCloseTo(1, 12);
    const [px, py, pz] = cameraPosition(rig);
    expect(px).toBeCloseTo(0, 9);
    expect(pz).toBeGreaterThan(0); // south of the target
    expect(py).toBeCloseTo(Math.sin(Math.PI / 4) * 100, 9);
  });

  it('keeps the camera at its distance from the target for any yaw and pitch', () => {
    for (const yaw of [0, 1, 2.5, -3]) {
      for (const pitch of [0.4, 0.9, 1.3]) {
        const [x, y, z] = cameraPosition({ ...rig, yaw, pitch, x: 30, z: -20 });
        expect(Math.hypot(x - 30, y, z + 20)).toBeCloseTo(100, 9);
      }
    }
  });

  it('pans along the view direction, whichever way the camera is turned', () => {
    const north = pan(rig, 10, 0);
    expect(north.z).toBeCloseTo(-10, 9);
    const turned = pan({ ...rig, yaw: Math.PI / 2 }, 10, 0); // camera east of the target, looking west
    expect(turned.x).toBeCloseTo(-10, 9);
    expect(turned.z).toBeCloseTo(0, 9);
    const right = pan(rig, 0, 5);
    expect(right.x).toBeCloseTo(5, 9);
  });

  it('limits pitch, distance and how far the target can wander', () => {
    expect(rotate(rig, 0, 10).pitch).toBe(MAX_PITCH);
    expect(rotate(rig, 0, -10).pitch).toBe(MIN_PITCH);
    expect(zoom(rig, 0.0001).distance).toBe(MIN_DISTANCE);
    expect(zoom(rig, 1e6).distance).toBe(MAX_DISTANCE);
    expect(keepInside({ ...rig, x: 5000, z: -5000 }, 1000, 40)).toMatchObject({
      x: 1040,
      z: -1040,
    });
  });

  it('eases to the goal without overshooting, at any frame rate', () => {
    const goal: Rig = { x: 100, z: -50, yaw: 1, pitch: 1, distance: 400 };
    const run = (dt: number): Rig => {
      let r = rig;
      for (let t = 0; t < 1; t += dt) r = ease(r, goal, dt);
      return r;
    };
    const slow = run(1 / 20);
    const fast = run(1 / 144);
    expect(fast.x).toBeCloseTo(slow.x, 0);
    expect(fast.x).toBeLessThan(100);
    expect(fast.x).toBeGreaterThan(90);
    expect(ease(rig, goal, 100).x).toBeCloseTo(100, 6); // a long frame lands on the goal
  });

  it('turns the short way round', () => {
    const near = ease({ ...rig, yaw: 3.0 }, { ...rig, yaw: -3.0 }, 0.05);
    expect(near.yaw).toBeGreaterThan(3.0); // 3.0 -> -3.0 is a short hop through pi, not a long way back
  });

  it('measures ground per pixel for dragging the map', () => {
    expect(metresPerPixel({ ...rig, distance: 100 }, 45, 1000)).toBeCloseTo(
      (2 * 100 * Math.tan((45 * Math.PI) / 360)) / 1000,
      12,
    );
  });
});

describe('occupancy of the real city', () => {
  const grid = buildOccupancy(city, 2);

  it('covers the building footprints', () => {
    const area = city.buildings.reduce((s, b) => s + footprintArea(b.outer), 0);
    const covered = countCells(grid, OCC_BUILDING) * 4;
    expect(covered).toBeGreaterThan(area * 0.7);
    expect(covered).toBeLessThan(area * 1.3);
  });

  it('marks roads and water', () => {
    expect(countCells(grid, OCC_ROAD)).toBeGreaterThan(2000);
    expect(countCells(grid, OCC_WATER)).toBeGreaterThan(0);
  });

  it('marks the cell under a building and not under open ground far from any', () => {
    const b = city.buildings[0];
    const cx = (b.outer[0] + b.outer[2] + b.outer[4]) / 3;
    const cy = (b.outer[1] + b.outer[3] + b.outer[5]) / 3;
    expect(occupancyAt(grid, cx, cy) & OCC_BUILDING).toBeGreaterThanOrEqual(0);
    expect(occupancyAt(grid, city.halfSize + 50, 0)).toBe(0); // outside the grid reads as empty
  });
});

describe('street lamps', () => {
  const lamps = placeLamps(city, buildOccupancy(city, 2));

  it('lines the main streets with a sensible number of lamps', () => {
    expect(lamps.count).toBeGreaterThan(300);
    expect(lamps.count).toBeLessThanOrEqual(MAX_LAMPS);
    expect(lamps.data).toHaveLength(lamps.count * LAMP_STRIDE);
  });

  it('keeps every lamp off buildings, roads and water and inside the play area', () => {
    const grid = buildOccupancy(city, 2);
    for (let i = 0; i < lamps.count; i++) {
      const x = lamps.data[i * LAMP_STRIDE];
      const y = lamps.data[i * LAMP_STRIDE + 1];
      expect(Math.abs(x)).toBeLessThan(city.halfSize);
      expect(Math.abs(y)).toBeLessThan(city.halfSize);
      expect(occupancyAt(grid, x, y) & (OCC_BUILDING | OCC_ROAD | OCC_WATER)).toBe(0);
      expect(lamps.data[i * LAMP_STRIDE + 2]).toBeGreaterThan(4);
    }
  });

  it('is deterministic, and trees placed afterwards stay clear of the lamps', () => {
    const grid = buildOccupancy(city, 2);
    const first = placeLamps(city, grid);
    expect([...first.data.slice(0, 300)]).toEqual([...lamps.data.slice(0, 300)]);
    const trees = placeTrees(city, grid);
    const lampCells = new Set<number>();
    for (let i = 0; i < first.count; i++) {
      lampCells.add(
        cellCoord(grid, first.data[i * LAMP_STRIDE + 1]) * grid.size +
          cellCoord(grid, first.data[i * LAMP_STRIDE]),
      );
    }
    let overlap = 0;
    for (let i = 0; i < trees.count; i++) {
      const cell =
        cellCoord(grid, trees.data[i * TREE_STRIDE + 1]) * grid.size +
        cellCoord(grid, trees.data[i * TREE_STRIDE]);
      if (lampCells.has(cell)) overlap++;
    }
    expect(overlap).toBe(0);
  });
});

describe('tree placement', () => {
  const trees = placeTrees(city, buildOccupancy(city, 2));

  it('places a good number of trees but never more than the cap', () => {
    expect(trees.count).toBeGreaterThan(1500);
    expect(trees.count).toBeLessThanOrEqual(MAX_TREES);
    expect(trees.data).toHaveLength(trees.count * TREE_STRIDE);
  });

  it('keeps every tree inside the play area and out of buildings, roads and water', () => {
    const grid = buildOccupancy(city, 2);
    for (let i = 0; i < trees.count; i++) {
      const x = trees.data[i * TREE_STRIDE];
      const y = trees.data[i * TREE_STRIDE + 1];
      expect(Math.abs(x)).toBeLessThan(city.halfSize);
      expect(Math.abs(y)).toBeLessThan(city.halfSize);
      expect(occupancyAt(grid, x, y) & (OCC_BUILDING | OCC_ROAD | OCC_WATER)).toBe(0);
    }
  });

  it('gives believable sizes and a mix of shapes', () => {
    let tall = 0;
    for (let i = 0; i < trees.count; i++) {
      const h = trees.data[i * TREE_STRIDE + 2];
      const r = trees.data[i * TREE_STRIDE + 3];
      expect(h).toBeGreaterThanOrEqual(6);
      expect(h).toBeLessThanOrEqual(17.1);
      expect(r).toBeGreaterThan(1);
      expect(r).toBeLessThan(5.5);
      if (trees.data[i * TREE_STRIDE + 5] === 1) tall++;
    }
    expect(tall / trees.count).toBeGreaterThan(0.1);
    expect(tall / trees.count).toBeLessThan(0.3);
  });

  it('plants the same trees every time', () => {
    const again = placeTrees(city, buildOccupancy(city, 2));
    expect(again.count).toBe(trees.count);
    expect([...again.data.slice(0, 600)]).toEqual([...trees.data.slice(0, 600)]);
  });
});
