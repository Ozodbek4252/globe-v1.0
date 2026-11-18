import { describe, expect, it } from 'vitest';
import { createSoundScape, type SoundFrame, type SoundScape } from '../src/city/sound';

/**
 * A stand-in for the Web Audio API: every node is a proxy that accepts any method and hands out
 * parameters that remember what they were last told. Enough to see what the scape does.
 */
function fakeContext(): { ctx: AudioContext; made: () => number; params: Map<string, number[]> } {
  let made = 0;
  const params = new Map<string, number[]>();
  const param = (name: string): unknown => {
    const history = params.get(name) ?? [];
    params.set(name, history);
    const record = (v: number): void => {
      history.push(v);
    };
    return new Proxy(
      {},
      {
        get: (_, key) => {
          if (key === 'value') return history.at(-1) ?? 0;
          if (key === 'cancelScheduledValues') return () => undefined;
          return (v: number) => record(v);
        },
        set: (_, key, v: number) => {
          if (key === 'value') record(v);
          return true;
        },
      },
    );
  };
  const node = (kind: string): unknown => {
    made++;
    const own: Record<string, unknown> = {};
    const self: unknown = new Proxy(own, {
      get: (target, key) => {
        if (key in target) return target[key as string];
        if (key === 'connect') return (to: unknown) => to;
        if (key === 'disconnect' || key === 'start' || key === 'stop') return () => undefined;
        if (key === 'getChannelData') return () => new Float32Array(16);
        if (typeof key === 'string') return param(`${kind}.${key}`);
        return undefined;
      },
      set: (target, key, v) => {
        target[key as string] = v;
        return true;
      },
    });
    return self;
  };
  const destination = node('destination');
  made = 0; // the speakers are not something the scape made
  const ctx = {
    currentTime: 0,
    sampleRate: 8000,
    state: 'running',
    destination,
    resume: () => Promise.resolve(),
    close: () => Promise.resolve(),
    createGain: () => node('gain'),
    createOscillator: () => node('osc'),
    createBufferSource: () => node('src'),
    createBiquadFilter: () => node('filter'),
    createStereoPanner: () => node('pan'),
    createDynamicsCompressor: () => node('comp'),
    createBuffer: () => node('buffer'),
  } as unknown as AudioContext;
  return { ctx, made: () => made, params };
}

const quiet: SoundFrame = {
  dt: 1 / 60,
  engine: null,
  groaners: [],
  near: 0,
  walking: 0,
  health: 100,
  night: 0,
  inside: false,
  playing: true,
};

/** Everything that makes a one-shot sound. */
function everything(s: SoundScape): void {
  s.shot('pistol', 3, 4);
  s.shot('shotgun', 3, 4);
  s.shot('rifle', 3, 4);
  s.empty();
  s.reload();
  s.reloaded();
  s.swing();
  s.shove();
  s.hit(5, 5, false);
  s.hit(5, 5, true);
  s.hurt(12);
  s.pickup('ammo');
  s.loot(false);
  s.loot(true);
  s.radar();
  s.door(true);
  s.battering(0.3);
  s.breach();
  s.car('crash', 9);
  s.car('wrecked', 0);
}

describe('the sound of the city', () => {
  it('makes nothing before the first gesture, and every sound after it', () => {
    const fake = fakeContext();
    const s = createSoundScape(() => fake.ctx);
    everything(s);
    expect(fake.made()).toBe(0);
    s.unlock();
    const base = fake.made();
    expect(base).toBeGreaterThan(0); // the graph
    everything(s);
    expect(fake.made()).toBeGreaterThan(base + 20);
  });

  it('is silent when turned off, and sounds far away are not made at all', () => {
    const fake = fakeContext();
    const s = createSoundScape(() => fake.ctx);
    s.unlock();
    s.setEnabled(false);
    const base = fake.made();
    everything(s);
    expect(fake.made()).toBe(base);
    expect(fake.params.get('gain.gain')?.at(-1)).toBe(0); // the master went to zero
    s.setEnabled(true);
    s.listen(0, 0, 1, 0);
    const before = fake.made();
    s.shot('pistol', 1000, 0); // across the city
    expect(fake.made()).toBe(before);
  });

  it('runs the engine while driving and lets it die when you get out', () => {
    const fake = fakeContext();
    const s = createSoundScape(() => fake.ctx);
    s.unlock();
    s.update({ ...quiet, engine: { speed: 15, top: 22, running: true, broken: false } });
    expect(s.levels().engine).toBeGreaterThan(0.1);
    s.update({ ...quiet, engine: { speed: 15, top: 22, running: true, broken: true } });
    expect(s.levels().engine).toBe(0);
    s.update({ ...quiet, engine: { speed: 15, top: 22, running: true, broken: false } });
    s.update({ ...quiet, engine: null });
    expect(s.levels().engine).toBe(0);
  });

  it('the horde murmurs with its numbers, and everything that goes on stops with the game', () => {
    const fake = fakeContext();
    const s = createSoundScape(() => fake.ctx);
    s.unlock();
    s.update({ ...quiet, near: 10 });
    expect(s.levels().horde).toBeGreaterThan(0.1);
    expect(s.levels().wind).toBeGreaterThan(0);
    s.update({ ...quiet, near: 10, playing: false });
    expect(s.levels()).toEqual({ engine: 0, horde: 0, wind: 0 });
    s.update({ ...quiet, near: 10 });
    s.hush();
    expect(s.levels()).toEqual({ engine: 0, horde: 0, wind: 0 });
  });

  it('groans come from the zombies near, and steps and the heart from the survivor', () => {
    const fake = fakeContext();
    const s = createSoundScape(() => fake.ctx);
    s.unlock();
    s.listen(0, 0, 1, 0);
    const base = fake.made();
    const groaners = [{ x: 8, y: 0, chasing: false }];
    for (let i = 0; i < 60 * 6; i++) s.update({ ...quiet, groaners, near: 1 });
    const withGroans = fake.made();
    expect(withGroans).toBeGreaterThan(base);
    for (let i = 0; i < 60 * 3; i++) s.update({ ...quiet, walking: 2, health: 10 });
    expect(fake.made()).toBeGreaterThan(withGroans + 10);
  });

  it('is a no-op where there is no audio', () => {
    const s = createSoundScape(() => null);
    s.unlock();
    everything(s);
    s.update(quiet);
    expect(s.levels()).toEqual({ engine: 0, horde: 0, wind: 0 });
    s.dispose();
  });
});
