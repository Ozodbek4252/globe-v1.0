import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createBorderLod, featureOf, HI_ZOOM, loadWorld, type JsonLoader } from '../src/map/data';

/** Reads straight from public/, the same files the browser fetches. */
const fromDisk: JsonLoader = async (path) =>
  JSON.parse(await readFile(resolve('public', path), 'utf8')) as unknown;

describe('loadWorld', () => {
  it('loads the same counts as the legacy embedded DATA', async () => {
    const world = await loadWorld(fromDisk);
    expect(world.countries).toHaveLength(177);
    expect(world.rivers.features).toHaveLength(13);
    expect(world.lakes.features).toHaveLength(24);
    expect(world.cities).toHaveLength(232);
    expect(world.capitals).toHaveLength(199);
  });

  it('keys countries by unique 3-letter codes', async () => {
    const world = await loadWorld(fromDisk);
    expect(world.byCode.size).toBe(177);
    for (const c of world.countries) expect(c.code).toMatch(/^[A-Z]{3}$/);
    expect(world.byCode.get('UZB')?.props.n).toBe('Uzbekistan');
  });

  it('derives area, density and GDP per person like the legacy page', async () => {
    const world = await loadWorld(fromDisk);
    const uzb = world.byCode.get('UZB');
    if (!uzb) throw new Error('UZB missing');
    // Uzbekistan is about 449,000 km²; the 110m outline is simplified, so allow a margin.
    expect(uzb.area).toBeGreaterThan(420_000);
    expect(uzb.area).toBeLessThan(470_000);
    expect(uzb.dens).toBeCloseTo(uzb.props.p / uzb.area, 10);
    expect(uzb.gpc).toBeCloseTo((uzb.props.g * 1e6) / uzb.props.p, 6);
  });

  it('gives every country a bounding circle with a sane radius', async () => {
    const world = await loadWorld(fromDisk);
    for (const c of world.countries) {
      expect(c.radius).toBeGreaterThan(0.03);
      expect(c.radius).toBeLessThan(Math.PI);
    }
  });

  it('orders labels by rank without reordering ties', async () => {
    const world = await loadWorld(fromDisk);
    const ranks = world.labelOrder.map((c) => c.props.lr);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(world.labelOrder).toHaveLength(177);
  });
});

describe('createBorderLod', () => {
  it('stays on 110m below the zoom threshold and never fetches', async () => {
    const world = await loadWorld(fromDisk);
    const load = vi.fn(fromDisk);
    const lod = createBorderLod(world, { load });
    expect(lod.isDetailed(HI_ZOOM - 0.1)).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it('fetches the 50m borders once when zoomed in, then switches over', async () => {
    const world = await loadWorld(fromDisk);
    const load = vi.fn(fromDisk);
    const onReady = vi.fn();
    const lod = createBorderLod(world, { load, onReady });

    expect(lod.isDetailed(HI_ZOOM)).toBe(false); // starts loading
    expect(lod.isDetailed(HI_ZOOM + 1)).toBe(false); // still loading, no second fetch
    expect(load).toHaveBeenCalledTimes(1);

    // Reading and parsing a 1.6 MB file; give a slow CI runner far more than the 1 s default.
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    expect(lod.isDetailed(HI_ZOOM)).toBe(true);
    expect(lod.isDetailed(1)).toBe(false);

    const uzb = world.byCode.get('UZB');
    if (!uzb) throw new Error('UZB missing');
    expect(uzb.hi).not.toBeNull();
    expect(featureOf(uzb, true)).toBe(uzb.hi);
    expect(featureOf(uzb, false)).toBe(uzb.feature);
  });

  it('does not retry after a failed download', async () => {
    const world = await loadWorld(fromDisk);
    const load = vi.fn<JsonLoader>(() => Promise.reject(new Error('offline')));
    const lod = createBorderLod(world, { load });
    lod.isDetailed(HI_ZOOM);
    await Promise.resolve();
    expect(lod.isDetailed(HI_ZOOM)).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
