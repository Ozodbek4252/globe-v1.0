// The game's sound, made on the spot with the Web Audio API: no recordings, so nothing to download
// and nothing to license. Guns, the horde's voices, blows on a door, the engine, footsteps, a
// heartbeat when you are hurt, and a little wind. Everything with a place in the city is panned and
// faded by where it is relative to the listener; indoors the world outside is muffled.
//
// Browsers will not make a sound before the user has done something on the page, so nothing here
// starts until `unlock()` is called from a gesture. All of it is a no-op where there is no audio
// (tests, very old browsers), and silent when turned off.

import type { WeaponName } from '../sim/game';

export interface EngineState {
  /** Metres per second (unsigned) and the car's top speed, for the pitch. */
  speed: number;
  top: number;
  /** The pedal is down. */
  running: boolean;
  /** Wrecked or out of fuel: no engine to hear. */
  broken: boolean;
}

/** A zombie near enough to be heard. */
export interface Groaner {
  x: number;
  y: number;
  chasing: boolean;
}

export interface SoundFrame {
  /** Seconds since the last frame. */
  dt: number;
  /** At the wheel; null on foot. */
  engine: EngineState | null;
  /** The zombies within earshot (a sample is enough), and how many are within 40 m. */
  groaners: readonly Groaner[];
  near: number;
  /** On foot: 0 standing, 1 walking, 2 sprinting. */
  walking: number;
  /** 0 to 100. */
  health: number;
  /** How dark it is, 0 to 1. */
  night: number;
  /** How hard it rains, 0 to 1 (absent: not at all). */
  rain?: number;
  /** Behind a shelter's door. */
  inside: boolean;
  /** The game is running (not paused, not over): otherwise everything that goes on goes quiet. */
  playing: boolean;
}

export interface SoundScape {
  /** Call from a user gesture (a key, a tap): the first one starts the audio clock. */
  unlock(): void;
  setEnabled(on: boolean): void;
  enabled(): boolean;
  /**
   * Where the listener is (city metres) and which way is right on the screen (a unit vector in city
   * space): sounds pan and fade from here.
   */
  listen(x: number, y: number, rightX: number, rightY: number): void;
  shot(weapon: WeaponName, x: number, y: number): void;
  empty(): void;
  reload(): void;
  reloaded(): void;
  swing(): void;
  shove(): void;
  /** A zombie was struck (by a shot, a swing or a car), and whether it fell. */
  hit(x: number, y: number, kill: boolean): void;
  hurt(amount: number): void;
  pickup(kind: 'ammo' | 'medkit' | 'food'): void;
  /** A place was searched; `nothing` when it had nothing to give. */
  loot(nothing: boolean): void;
  radar(): void;
  /** A shelter's door, opened to go in or out. */
  door(open: boolean): void;
  /** A blow on the door you are behind; `fraction` of it is left. */
  battering(fraction: number): void;
  breach(): void;
  car(what: 'enter' | 'exit' | 'crash' | 'fuel' | 'wrecked', force: number): void;
  /** Each frame: the engine, the horde's voices, footsteps, the heartbeat and the wind follow the game. */
  update(frame: SoundFrame): void;
  /** Silence everything that goes on (the engine, the wind) at once: the scene is going to sleep. */
  hush(): void;
  /** The levels the continuous layers are at (0 to 1), for tests and tuning. */
  levels(): { engine: number; horde: number; wind: number; rain: number };
  dispose(): void;
}

/** Tuning. Gains are relative to a master of `master`. */
export const SOUND = {
  master: 0.8,
  /** Distance falloff: full volume within `near` metres, inverse with distance past it, nothing past `far`. */
  near: 12,
  far: 150,
  /** The world through a door: a low-pass at this many hertz. */
  muffled: 420,
  /** How often the horde speaks, from one zombie nearby to a crowd (seconds between groans). */
  groanEvery: [2.6, 0.32] as const,
  groanReach: 60,
  /** Footsteps: seconds between steps walking and sprinting. */
  stepEvery: [0.5, 0.34] as const,
  /** The heart is heard below this much health. */
  heartBelow: 35,
} as const;

type Ctx = AudioContext;

/** A new scape. `make` builds the context (the default is the browser's); it returns null where there is none. */
export function createSoundScape(make: () => Ctx | null = defaultContext): SoundScape {
  let ctx: Ctx | null = null;
  let on = true;
  let disposed = false;
  // the graph: one-shots -> (world filter) -> master -> compressor -> out; UI sounds skip the filter
  let master: GainNode | null = null;
  let world: BiquadFilterNode | null = null;
  let noiseBuffer: AudioBuffer | null = null;
  // the listener
  let lx = 0;
  let ly = 0;
  let rx = 1;
  let ry = 0;
  // the layers that go on
  interface Engine {
    low: OscillatorNode;
    high: OscillatorNode;
    filter: BiquadFilterNode;
    gain: GainNode;
    road: GainNode;
  }
  let engine: Engine | null = null;
  let horde: GainNode | null = null;
  let wind: GainNode | null = null;
  let rain: GainNode | null = null;
  const level = { engine: 0, horde: 0, wind: 0, rain: 0 };
  let groanIn = 0.6;
  let stepIn = 0;
  let beatIn = 0;
  let stepSide = 1;

  const rnd = (a: number, b: number): number => a + Math.random() * (b - a);

  function start(): void {
    if (ctx || disposed) return;
    const c = make();
    if (!c) return;
    ctx = c;
    const compressor = c.createDynamicsCompressor();
    compressor.threshold.value = -14;
    compressor.ratio.value = 6;
    compressor.connect(c.destination);
    master = c.createGain();
    master.gain.value = on ? SOUND.master : 0;
    master.connect(compressor);
    world = c.createBiquadFilter();
    world.type = 'lowpass';
    world.frequency.value = 20000;
    world.connect(master);
    // two seconds of white noise, looped or cut as needed
    const n = Math.floor(c.sampleRate * 2);
    noiseBuffer = c.createBuffer(1, n, c.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
    // the wind: looped noise, low, with a slow swell
    wind = c.createGain();
    wind.gain.value = 0;
    const windSrc = c.createBufferSource();
    windSrc.buffer = noiseBuffer;
    windSrc.loop = true;
    const windFilter = c.createBiquadFilter();
    windFilter.type = 'lowpass';
    windFilter.frequency.value = 240;
    windSrc.connect(windFilter).connect(wind).connect(master);
    const swell = c.createOscillator();
    swell.frequency.value = 0.09;
    const swellDepth = c.createGain();
    swellDepth.gain.value = 0.02;
    swell.connect(swellDepth).connect(wind.gain);
    swell.start();
    windSrc.start();
    // the horde's murmur: looped noise, very low
    horde = c.createGain();
    horde.gain.value = 0;
    const hordeSrc = c.createBufferSource();
    hordeSrc.buffer = noiseBuffer;
    hordeSrc.loop = true;
    hordeSrc.playbackRate.value = 0.5;
    const hordeFilter = c.createBiquadFilter();
    hordeFilter.type = 'lowpass';
    hordeFilter.frequency.value = 160;
    hordeSrc.connect(hordeFilter).connect(horde).connect(world);
    hordeSrc.start();
    // rain: looped noise, brighter than the wind, through the world (a door muffles it)
    rain = c.createGain();
    rain.gain.value = 0;
    const rainSrc = c.createBufferSource();
    rainSrc.buffer = noiseBuffer;
    rainSrc.loop = true;
    rainSrc.playbackRate.value = 0.9;
    const rainFilter = c.createBiquadFilter();
    rainFilter.type = 'lowpass';
    rainFilter.frequency.value = 1800;
    rainSrc.connect(rainFilter).connect(rain).connect(world);
    rainSrc.start();
  }

  const ready = (): boolean => ctx !== null && on && !disposed;
  const now = (): number => ctx?.currentTime ?? 0;

  /** Pan (-1 to 1) and gain (0 to 1) for a sound at (x, y). */
  function place(x: number, y: number): { pan: number; gain: number } {
    const dx = x - lx;
    const dy = y - ly;
    const d = Math.hypot(dx, dy);
    if (d >= SOUND.far) return { pan: 0, gain: 0 };
    const gain = d <= SOUND.near ? 1 : SOUND.near / d;
    const pan = d < 0.5 ? 0 : Math.max(-1, Math.min(1, ((dx * rx + dy * ry) / d) * 0.8));
    return { pan, gain: gain * (1 - d / SOUND.far) };
  }

  /** A gain (and a panner, when the sound has a place) into the world or straight to the master. */
  function bus(
    gain: number,
    at?: { x: number; y: number },
    ui = false,
    pan: number | null = null,
  ): GainNode | null {
    if (!ctx || !master || !world) return null;
    let level = gain;
    if (at) {
      const p = place(at.x, at.y);
      if (p.gain <= 0.002) return null; // too far to hear: nothing is made
      level *= p.gain;
      pan = p.pan;
    }
    let into: AudioNode = ui ? master : world;
    if (pan !== null) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      panner.connect(into);
      into = panner;
    }
    const g = ctx.createGain();
    g.gain.value = level;
    g.connect(into);
    return g;
  }

  interface Burst {
    /** Seconds. */
    length: number;
    gain: number;
    type?: BiquadFilterType;
    /** Filter frequency at the start and the end (sweeps). */
    freq?: number;
    freqEnd?: number;
    q?: number;
    /** Seconds before it starts. */
    delay?: number;
    /** Attack, seconds (default: at once). */
    attack?: number;
  }

  /** A burst of filtered noise, shaped by a gain envelope. */
  function noise(b: Burst, into: GainNode | null): void {
    if (!ctx || !into || !noiseBuffer) return;
    const t0 = now() + (b.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer;
    src.loop = true;
    src.playbackRate.value = rnd(0.92, 1.08);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(b.gain, t0 + (b.attack ?? 0.004));
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + b.length);
    let head: AudioNode = src;
    if (b.type) {
      const f = ctx.createBiquadFilter();
      f.type = b.type;
      f.frequency.setValueAtTime(b.freq ?? 1000, t0);
      if (b.freqEnd !== undefined)
        f.frequency.exponentialRampToValueAtTime(Math.max(20, b.freqEnd), t0 + b.length);
      f.Q.value = b.q ?? 0.8;
      src.connect(f);
      head = f;
    }
    head.connect(env).connect(into);
    src.start(t0);
    src.stop(t0 + b.length + 0.02);
  }

  interface Tone {
    type: OscillatorType;
    /** Hertz at the start and the end (a slide). */
    freq: number;
    freqEnd?: number;
    length: number;
    gain: number;
    delay?: number;
    attack?: number;
    /** Low-pass the tone at this frequency. */
    lowpass?: number;
    /** Vibrato: hertz of wobble, and its depth in hertz. */
    wobble?: number;
    wobbleDepth?: number;
  }

  function tone(t: Tone, into: GainNode | null): void {
    if (!ctx || !into) return;
    const t0 = now() + (t.delay ?? 0);
    const osc = ctx.createOscillator();
    osc.type = t.type;
    osc.frequency.setValueAtTime(t.freq, t0);
    if (t.freqEnd !== undefined)
      osc.frequency.exponentialRampToValueAtTime(Math.max(10, t.freqEnd), t0 + t.length);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(t.gain, t0 + (t.attack ?? 0.006));
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + t.length);
    let head: AudioNode = osc;
    if (t.lowpass) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = t.lowpass;
      osc.connect(f);
      head = f;
    }
    head.connect(env).connect(into);
    if (t.wobble) {
      const lfo = ctx.createOscillator();
      lfo.frequency.value = t.wobble;
      const depth = ctx.createGain();
      depth.gain.value = t.wobbleDepth ?? 5;
      lfo.connect(depth).connect(osc.frequency);
      lfo.start(t0);
      lfo.stop(t0 + t.length + 0.02);
    }
    osc.start(t0);
    osc.stop(t0 + t.length + 0.02);
  }

  /** A groan from a zombie at (x, y): low and slow, or a snarl when it is after you. */
  function groan(z: Groaner): void {
    const into = bus(z.chasing ? 0.5 : 0.4, z);
    if (!into) return;
    if (z.chasing) {
      const f = rnd(120, 180);
      tone(
        {
          type: 'sawtooth',
          freq: f,
          freqEnd: f * 0.7,
          length: rnd(0.35, 0.55),
          gain: 1,
          attack: 0.03,
          lowpass: 900,
          wobble: 9,
          wobbleDepth: 12,
        },
        into,
      );
      noise({ length: 0.3, gain: 0.35, type: 'bandpass', freq: 1100, q: 1.2, attack: 0.02 }, into);
    } else {
      const f = rnd(58, 105);
      tone(
        {
          type: 'sawtooth',
          freq: f,
          freqEnd: f * 0.8,
          length: rnd(0.7, 1.5),
          gain: 1,
          attack: 0.15,
          lowpass: 420,
          wobble: rnd(4.5, 6.5),
          wobbleDepth: 6,
        },
        into,
      );
    }
  }

  function setTarget(param: AudioParam, value: number, tau = 0.08): void {
    param.setTargetAtTime(value, now(), tau);
  }

  function ensureEngine(): Engine | null {
    if (engine || !ctx || !world) return engine;
    const low = ctx.createOscillator();
    low.type = 'sawtooth';
    const high = ctx.createOscillator();
    high.type = 'square';
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 400;
    filter.Q.value = 1.2;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const highGain = ctx.createGain();
    highGain.gain.value = 0.35;
    low.connect(filter);
    high.connect(highGain).connect(filter);
    filter.connect(gain).connect(master!);
    // road noise with speed
    const road = ctx.createGain();
    road.gain.value = 0;
    const roadSrc = ctx.createBufferSource();
    roadSrc.buffer = noiseBuffer;
    roadSrc.loop = true;
    const roadFilter = ctx.createBiquadFilter();
    roadFilter.type = 'lowpass';
    roadFilter.frequency.value = 700;
    roadSrc.connect(roadFilter).connect(road).connect(master!);
    roadSrc.start();
    low.start();
    high.start();
    engine = { low, high, filter, gain, road };
    return engine;
  }

  function driveEngine(e: EngineState | null, playing: boolean): void {
    const want = e && !e.broken && playing;
    if (!want && !engine) {
      level.engine = 0;
      return;
    }
    const eng = ensureEngine();
    if (!eng) return;
    if (!want) {
      setTarget(eng.gain.gain, 0, 0.12);
      setTarget(eng.road.gain, 0, 0.12);
      level.engine = 0;
      return;
    }
    const share = Math.min(1, e.speed / Math.max(1, e.top));
    const rpm = 26 + 95 * share + (e.running ? 8 : 0);
    setTarget(eng.low.frequency, rpm, 0.1);
    setTarget(eng.high.frequency, rpm * 2, 0.1);
    setTarget(
      eng.filter.frequency,
      320 + 1900 * (e.running ? 0.35 + 0.65 * share : share * 0.5),
      0.1,
    );
    const g = e.running ? 0.16 + 0.1 * share : 0.07 + 0.05 * share;
    setTarget(eng.gain.gain, g);
    setTarget(eng.road.gain, 0.09 * share);
    level.engine = g;
  }

  return {
    unlock() {
      start();
      if (ctx && ctx.state === 'suspended') void ctx.resume();
    },
    setEnabled(next) {
      on = next;
      if (master) setTarget(master.gain, on ? SOUND.master : 0, 0.05);
    },
    enabled: () => on,
    listen(x, y, rightX, rightY) {
      lx = x;
      ly = y;
      const len = Math.hypot(rightX, rightY) || 1;
      rx = rightX / len;
      ry = rightY / len;
    },
    shot(weapon, x, y) {
      if (!ready()) return;
      const at = { x, y };
      if (weapon === 'shotgun') {
        const into = bus(1.1, at);
        noise({ length: 0.3, gain: 1, type: 'lowpass', freq: 1400, freqEnd: 300 }, into);
        tone({ type: 'sine', freq: 95, freqEnd: 38, length: 0.22, gain: 0.9 }, into);
      } else if (weapon === 'rifle') {
        const into = bus(1.0, at);
        noise({ length: 0.06, gain: 1, type: 'highpass', freq: 900 }, into);
        noise(
          { length: 0.5, gain: 0.25, type: 'lowpass', freq: 1800, freqEnd: 200, delay: 0.04 },
          into,
        );
        tone({ type: 'sine', freq: 130, freqEnd: 45, length: 0.14, gain: 0.7 }, into);
      } else {
        const into = bus(0.85, at);
        noise({ length: 0.1, gain: 1, type: 'bandpass', freq: 1700, q: 0.7 }, into);
        tone({ type: 'sine', freq: 160, freqEnd: 60, length: 0.09, gain: 0.6 }, into);
      }
    },
    empty() {
      if (!ready()) return;
      noise({ length: 0.02, gain: 0.35, type: 'highpass', freq: 2500 }, bus(1, undefined, true));
    },
    reload() {
      if (!ready()) return;
      const into = bus(0.6, undefined, true);
      noise({ length: 0.025, gain: 1, type: 'bandpass', freq: 2200, q: 2 }, into);
      noise({ length: 0.04, gain: 0.7, type: 'bandpass', freq: 1400, q: 2, delay: 0.13 }, into);
    },
    reloaded() {
      if (!ready()) return;
      const into = bus(0.6, undefined, true);
      tone({ type: 'square', freq: 900, freqEnd: 500, length: 0.035, gain: 0.5 }, into);
      noise({ length: 0.03, gain: 0.8, type: 'bandpass', freq: 3000, q: 1.5 }, into);
    },
    swing() {
      if (!ready()) return;
      noise(
        { length: 0.22, gain: 0.5, type: 'bandpass', freq: 450, freqEnd: 1600, q: 2, attack: 0.08 },
        bus(1, undefined, true),
      );
    },
    shove() {
      if (!ready()) return;
      const into = bus(0.8, undefined, true);
      tone({ type: 'sine', freq: 110, freqEnd: 50, length: 0.12, gain: 0.7 }, into);
      noise({ length: 0.08, gain: 0.6, type: 'lowpass', freq: 400 }, into);
    },
    hit(x, y, kill) {
      if (!ready()) return;
      const into = bus(0.7, { x, y });
      noise({ length: 0.08, gain: 0.8, type: 'lowpass', freq: 700 }, into);
      if (kill) {
        const f = rnd(90, 130);
        tone(
          {
            type: 'sawtooth',
            freq: f,
            freqEnd: f * 0.45,
            length: 0.4,
            gain: 0.5,
            lowpass: 500,
            attack: 0.02,
          },
          into,
        );
      }
    },
    hurt(amount) {
      if (!ready()) return;
      const into = bus(Math.min(1, 0.5 + amount / 20), undefined, true);
      noise({ length: 0.14, gain: 0.9, type: 'lowpass', freq: 520 }, into);
      tone({ type: 'sine', freq: 70, freqEnd: 40, length: 0.18, gain: 0.8 }, into);
    },
    pickup(kind) {
      if (!ready()) return;
      const into = bus(0.25, undefined, true);
      const base = kind === 'ammo' ? 520 : kind === 'medkit' ? 660 : 440;
      tone({ type: 'sine', freq: base, length: 0.09, gain: 1 }, into);
      tone({ type: 'sine', freq: base * 1.5, length: 0.14, gain: 1, delay: 0.08 }, into);
    },
    loot(nothing) {
      if (!ready()) return;
      const into = bus(0.25, undefined, true);
      if (nothing) {
        tone({ type: 'sine', freq: 330, freqEnd: 250, length: 0.25, gain: 1 }, into);
        return;
      }
      [523, 659, 784].forEach((f, i) =>
        tone({ type: 'sine', freq: f, length: 0.12, gain: 1, delay: i * 0.1 }, into),
      );
    },
    radar() {
      if (!ready()) return;
      const into = bus(0.3, undefined, true);
      tone({ type: 'sine', freq: 400, freqEnd: 1600, length: 0.5, gain: 1, attack: 0.05 }, into);
      tone({ type: 'sine', freq: 1200, length: 0.1, gain: 0.8, delay: 0.55 }, into);
      tone({ type: 'sine', freq: 1200, length: 0.1, gain: 0.8, delay: 0.75 }, into);
    },
    door(open) {
      if (!ready()) return;
      const into = bus(0.5, undefined, true);
      const creakAt = open ? 0 : 0.05;
      tone(
        {
          type: 'sawtooth',
          freq: 72,
          freqEnd: 56,
          length: 0.45,
          gain: 0.6,
          lowpass: 320,
          delay: creakAt,
          attack: 0.05,
        },
        into,
      );
      noise(
        { length: 0.03, gain: 0.8, type: 'bandpass', freq: 1800, q: 2, delay: open ? 0.4 : 0 },
        into,
      );
    },
    battering(fraction) {
      if (!ready()) return;
      const into = bus(0.9, undefined, true);
      tone({ type: 'sine', freq: 58, freqEnd: 40, length: 0.25, gain: 1 }, into);
      noise({ length: 0.1, gain: 0.7, type: 'lowpass', freq: 260 }, into);
      if (fraction < 0.4)
        noise({ length: 0.035, gain: 0.6, type: 'bandpass', freq: 1400, q: 1.5 }, into);
    },
    breach() {
      if (!ready()) return;
      const into = bus(1.2, undefined, true);
      noise({ length: 0.7, gain: 1, type: 'lowpass', freq: 1300, freqEnd: 180 }, into);
      tone({ type: 'sine', freq: 50, freqEnd: 30, length: 0.5, gain: 0.9 }, into);
    },
    car(what, force) {
      if (!ready()) return;
      const into = bus(0.8, undefined, true);
      switch (what) {
        case 'enter':
        case 'exit':
          noise({ length: 0.07, gain: 0.8, type: 'lowpass', freq: 600 }, into);
          tone({ type: 'sine', freq: 120, freqEnd: 70, length: 0.09, gain: 0.6 }, into);
          break;
        case 'crash': {
          const g = Math.min(1.4, 0.3 + force * 0.1);
          noise(
            {
              length: 0.15 + Math.min(0.4, force * 0.03),
              gain: g,
              type: 'lowpass',
              freq: 1000,
              freqEnd: 150,
            },
            into,
          );
          tone({ type: 'sine', freq: 55, freqEnd: 32, length: 0.3, gain: g * 0.8 }, into);
          break;
        }
        case 'fuel':
          for (let i = 0; i < 3; i++)
            noise({ length: 0.05, gain: 0.5, type: 'lowpass', freq: 350, delay: i * 0.18 }, into);
          break;
        case 'wrecked':
          tone(
            { type: 'square', freq: 320, freqEnd: 110, length: 0.45, gain: 0.35, lowpass: 900 },
            into,
          );
          noise({ length: 0.3, gain: 0.7, type: 'lowpass', freq: 900, freqEnd: 200 }, into);
          break;
        default:
          break;
      }
    },
    update(f) {
      if (!ctx || disposed) return;
      // the world is muffled indoors
      if (world) setTarget(world.frequency, f.inside ? SOUND.muffled : 20000, 0.15);
      driveEngine(f.engine, f.playing);
      const quiet = !f.playing || !on;
      // the horde's murmur
      const hordeLevel = quiet ? 0 : Math.min(0.28, f.near * 0.014);
      if (horde) setTarget(horde.gain, hordeLevel, 0.3);
      level.horde = hordeLevel;
      // the wind
      const windLevel = quiet ? 0 : f.inside ? 0.015 : 0.045 + 0.025 * f.night;
      if (wind) setTarget(wind.gain, windLevel, 0.5);
      level.wind = windLevel;
      const rainLevel = quiet ? 0 : 0.12 * (f.rain ?? 0);
      if (rain) setTarget(rain.gain, rainLevel, 0.6);
      level.rain = rainLevel;
      if (quiet) return;
      // voices
      if (f.groaners.length > 0) {
        groanIn -= f.dt;
        if (groanIn <= 0) {
          const crowd = Math.min(1, f.near / 12);
          groanIn = SOUND.groanEvery[0] + (SOUND.groanEvery[1] - SOUND.groanEvery[0]) * crowd;
          groanIn *= rnd(0.7, 1.3);
          const chasing = f.groaners.filter((z) => z.chasing);
          const pool = chasing.length > 0 && Math.random() < 0.6 ? chasing : f.groaners;
          groan(pool[Math.floor(Math.random() * pool.length)]);
        }
      } else groanIn = Math.min(groanIn, 0.6);
      // footsteps
      if (f.walking > 0 && !f.engine) {
        stepIn -= f.dt;
        if (stepIn <= 0) {
          stepIn = SOUND.stepEvery[f.walking >= 2 ? 1 : 0];
          stepSide = -stepSide;
          // left, right: a little to each side in turn
          const into = bus(f.walking >= 2 ? 0.28 : 0.13, undefined, true, stepSide * 0.15);
          noise({ length: 0.07, gain: 1, type: 'lowpass', freq: f.walking >= 2 ? 650 : 450 }, into);
        }
      } else stepIn = 0;
      // the heart
      if (f.health < SOUND.heartBelow && f.health > 0) {
        beatIn -= f.dt;
        if (beatIn <= 0) {
          const low = (SOUND.heartBelow - f.health) / SOUND.heartBelow;
          beatIn = 1.1 - 0.55 * low;
          const into = bus(0.3 + 0.4 * low, undefined, true);
          tone({ type: 'sine', freq: 48, freqEnd: 40, length: 0.14, gain: 1 }, into);
          tone({ type: 'sine', freq: 44, freqEnd: 36, length: 0.12, gain: 0.7, delay: 0.17 }, into);
        }
      } else beatIn = 0;
    },
    hush() {
      if (!ctx) return;
      if (engine) {
        engine.gain.gain.cancelScheduledValues(now());
        engine.gain.gain.value = 0;
        engine.road.gain.cancelScheduledValues(now());
        engine.road.gain.value = 0;
      }
      for (const g of [horde, wind, rain]) {
        if (!g) continue;
        g.gain.cancelScheduledValues(now());
        g.gain.value = 0;
      }
      level.engine = level.horde = level.wind = level.rain = 0;
    },
    levels: () => ({ ...level }),
    dispose() {
      disposed = true;
      if (ctx) void ctx.close();
      ctx = null;
      engine = null;
    },
  };
}

function defaultContext(): Ctx | null {
  try {
    if (typeof AudioContext === 'undefined') return null;
    return new AudioContext();
  } catch {
    return null;
  }
}
