import { describe, expect, it } from 'vitest';
import { buildColliders, insideBuilding, type ColliderSource } from '../src/sim/colliders';
import {
  createGame,
  createGameWorld,
  drainEvents,
  GAME,
  NO_INPUT,
  rescueIn,
  stepGame,
  type GameEvent,
  type GameInput,
  type GameOptions,
} from '../src/sim/game';
import { hordeChecksum, spawnZombie, ZKind, ZState } from '../src/sim/horde';

const DT = 1 / 60;

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

/** A small town and a game in it, with no zombies and no waves unless asked for. */
function setup(extra: Partial<ColliderSource> = {}, options: Partial<GameOptions> = {}) {
  const colliders = buildColliders({
    halfSize: 150,
    buildings: [],
    areas: [],
    waterways: [],
    roads: [],
    ...extra,
  });
  const world = createGameWorld(colliders, [0, 0]);
  const g = createGame(world, {
    seed: 1,
    startX: 0,
    startY: 0,
    clumps: 0,
    waves: false,
    rescueAt: 1000,
    ...options,
  });
  const events: GameEvent[] = [];
  /** Run for `seconds` with the given input held (each reload/shove request is sent on the first step only). */
  const run = (input: Partial<GameInput> = {}, seconds = DT): void => {
    const steps = Math.max(1, Math.round(seconds / DT));
    for (let s = 0; s < steps; s++) {
      const now: GameInput = { ...NO_INPUT, ...input };
      if (s > 0) {
        now.reload = false;
        now.shove = false;
      }
      stepGame(g, now, world, DT);
      events.push(...drainEvents(g));
    }
  };
  const count = (type: GameEvent['type']): number => events.filter((e) => e.type === type).length;
  /** A zombie that stays where it is until something disturbs it. */
  const still = (x: number, y: number, kind: number = ZKind.WALKER): number => {
    const i = spawnZombie(g.horde, x, y, kind, ZState.WANDER);
    g.horde.timer[i] = 1000;
    return i;
  };
  return { g, world, colliders, run, events, count, still };
}

const EAST: Partial<GameInput> = { aim: [30, 0] };
const WEST: Partial<GameInput> = { aim: [-30, 0] };

describe('a new game', () => {
  it('starts armed and healthy, with supplies about', () => {
    const { g } = setup();
    expect(g.status).toBe('playing');
    expect(g.health).toBe(GAME.health);
    expect(g.ammo).toBe(GAME.weapon.mag);
    expect(g.reserve).toBe(GAME.weapon.reserve);
    expect(g.pickups).toHaveLength(GAME.pickups.ammo + GAME.pickups.medkit);
    expect(rescueIn(g)).toBe(1000);
  });

  it('puts the first supplies within reach: ammunition near, first aid a bit further', () => {
    const { g } = setup();
    const d = g.pickups.slice(0, 3).map((p) => Math.hypot(p.x, p.y));
    expect(g.pickups.slice(0, 3).map((p) => p.kind)).toEqual(['ammo', 'medkit', 'ammo']);
    expect(d[0]).toBeGreaterThanOrEqual(35);
    expect(d[0]).toBeLessThanOrEqual(60);
    expect(d[1]).toBeGreaterThanOrEqual(60);
    expect(d[1]).toBeLessThanOrEqual(100);
    expect(d[2]).toBeGreaterThanOrEqual(90);
    expect(d[2]).toBeLessThanOrEqual(130);
  });

  it('keeps supplies and zombie groups out of buildings and away from the start', () => {
    const { g, colliders } = setup(
      { buildings: [{ outer: sq(20, -20, 40, 40) }, { outer: sq(-80, 10, 30, 60) }] },
      { clumps: 30 },
    );
    for (const p of g.pickups) expect(insideBuilding(colliders, p.x, p.y)).toBe(false);
    expect(g.horde.alive).toBeGreaterThanOrEqual(30 * 3);
    for (let i = 0; i < g.horde.used; i++) {
      expect(insideBuilding(colliders, g.horde.x[i], g.horde.y[i])).toBe(false);
      expect(Math.hypot(g.horde.x[i], g.horde.y[i])).toBeGreaterThan(60); // groups start >= 70 m out, spread 4 m
    }
  });
});

describe('the pistol', () => {
  it('kills a walker in two hits and shows where the bullet went', () => {
    const { g, run, events, still } = setup();
    const z = still(10, 0);
    run({ ...EAST, fire: true }, 0.5);
    expect(g.stats.hits).toBe(2);
    expect(g.stats.kills).toBe(1);
    expect(g.horde.state[z]).toBe(ZState.DEAD);
    const shot = events.find((e) => e.type === 'shot');
    expect(shot).toMatchObject({ type: 'shot', hit: 'zombie' });
    expect(events.filter((e) => e.type === 'hit' && e.kill)).toHaveLength(1);
  });

  it('is stopped by a wall, and the zombie behind it is untouched', () => {
    const { g, run, events, still } = setup({ buildings: [{ outer: sq(5, -5, 2, 10) }] });
    const z = still(10, 0);
    run({ ...EAST, fire: true }, 0.3);
    expect(g.horde.health[z]).toBe(100);
    expect(g.stats.hits).toBe(0);
    expect(events.find((e) => e.type === 'shot')).toMatchObject({ hit: 'wall' });
  });

  it('misses a zombie off to the side and one beyond its range', () => {
    const { g, run, still } = setup();
    const side = still(10, 3);
    const far = still(45, 0);
    run({ ...EAST, fire: true }, 0.3);
    expect(g.horde.health[side]).toBe(100);
    expect(g.horde.health[far]).toBe(100);
  });

  it('shoots only one zombie when two stand in line', () => {
    const { g, run, still } = setup();
    const near = still(8, 0);
    const behind = still(12, 0);
    run({ ...EAST, fire: true }, 0.1); // one shot
    expect(g.stats.shots).toBe(1);
    expect(g.horde.health[near]).toBeLessThan(100);
    expect(g.horde.health[behind]).toBe(100);
  });

  it('fires at a steady pace while the trigger is held, and not at all when it is not', () => {
    const { g, run } = setup();
    run({ ...EAST }, 1);
    expect(g.stats.shots).toBe(0);
    run({ ...EAST, fire: true }, 1);
    expect(g.stats.shots).toBe(Math.ceil(1 / GAME.weapon.interval)); // 4: at 0, 0.28, 0.56 and 0.84 s
  });

  it('empties the magazine, reloads by itself, and takes the rounds from the reserve', () => {
    const { g, run, count } = setup();
    run({ ...EAST, fire: true }, 4.3);
    expect(g.stats.shots).toBe(15);
    expect(g.ammo).toBe(0);
    expect(g.reloading).toBeGreaterThan(0);
    run({}, 1.7);
    expect(g.ammo).toBe(15);
    expect(g.reserve).toBe(30);
    expect(g.reloading).toBe(0);
    expect(count('reload')).toBe(1);
    expect(count('reloaded')).toBe(1);
  });

  it('cannot fire while reloading', () => {
    const { g, run } = setup();
    run({ ...EAST, fire: true }, 0.1);
    run({ ...EAST, reload: true }, DT);
    expect(g.reloading).toBeGreaterThan(0);
    const before = g.stats.shots;
    run({ ...EAST, fire: true }, 1);
    expect(g.stats.shots).toBe(before);
  });

  it('reloads on request, topping up only what was used, and ignores a pointless request', () => {
    const { g, run } = setup();
    run({ reload: true }, 0.2); // full magazine: nothing to do
    expect(g.reloading).toBe(0);
    run({ ...EAST, fire: true }, 0.7); // three shots
    run({}, 0.1);
    expect(g.ammo).toBe(12);
    run({ reload: true }, 2);
    expect(g.ammo).toBe(15);
    expect(g.reserve).toBe(45 - 3);
    g.ammo = 5;
    g.reserve = 0;
    run({ reload: true }, 0.2); // nothing in reserve
    expect(g.reloading).toBe(0);
  });

  it('clicks when there is nothing left to fire', () => {
    const { g, run, count } = setup();
    g.ammo = 0;
    g.reserve = 0;
    run({ ...EAST, fire: true }, 0.5);
    expect(g.stats.shots).toBe(0);
    expect(count('empty')).toBeGreaterThan(0);
  });

  it('is less accurate on the run', () => {
    const spread = (input: Partial<GameInput>): number => {
      const { g, run, events } = setup();
      g.ammo = 1000;
      run({ ...input, fire: true, aim: [30, 0] }, 10);
      let worst = 0;
      for (const e of events) {
        if (e.type !== 'shot') continue;
        worst = Math.max(worst, Math.abs(Math.atan2(e.endY - e.y, e.endX - e.x) - 0));
      }
      return worst;
    };
    expect(spread({ sprint: true, moveX: 0, moveY: 1 })).toBeGreaterThan(spread({}) * 2);
  });
});

describe('noise', () => {
  it('a gunshot calls zombies from far out of sight', () => {
    const { g, run, still } = setup();
    const z = still(40, 0);
    g.horde.heading[z] = 0; // facing away
    run({ ...WEST, fire: true }, 0.5);
    expect(g.horde.state[z]).toBe(ZState.INVESTIGATE);
  });

  it('walking is nearly silent and sprinting carries', () => {
    const quiet = setup();
    const z1 = quiet.still(12, 0);
    quiet.g.horde.heading[z1] = 0;
    quiet.run({ moveX: 0, moveY: 1 }, 3);
    expect(quiet.g.horde.state[z1]).toBe(ZState.WANDER);

    const loud = setup();
    const z2 = loud.still(12, 0);
    loud.g.horde.heading[z2] = 0;
    loud.run({ moveX: 0, moveY: 1, sprint: true }, 3);
    expect([ZState.INVESTIGATE, ZState.CHASE]).toContain(loud.g.horde.state[z2]);
  });

  it('standing still makes no sound at all', () => {
    const { g, run, still } = setup();
    const z = still(3.8, 0); // past smell range, out of sight behind
    g.horde.heading[z] = 0;
    run({}, 3);
    expect(g.noises).toHaveLength(0);
    expect(g.horde.state[z]).toBe(ZState.WANDER);
  });
});

describe('the shove', () => {
  it('throws back what is in front, leaves what is behind, and has a cooldown', () => {
    const { g, run, still } = setup();
    run({ ...EAST }, 0.3); // turn to face east
    const front = still(1.6, 0);
    const back = still(-1.6, 0);
    run({ ...EAST, shove: true }, DT);
    expect(g.stats.shoves).toBe(1);
    expect(g.horde.stun[front]).toBeGreaterThan(0.5);
    expect(g.horde.vx[front]).toBeGreaterThan(4);
    expect(g.horde.stun[back]).toBe(0);
    run({ ...EAST }, 0.3);
    expect(g.horde.x[front]).toBeGreaterThan(2.4);
    run({ ...EAST, shove: true }, DT); // too soon
    expect(g.stats.shoves).toBe(1);
    run({ ...EAST }, GAME.shove.cooldown);
    run({ ...EAST, shove: true }, DT);
    expect(g.stats.shoves).toBe(2);
  });

  it('can finish off a hurt zombie', () => {
    const { g, run, still } = setup();
    run({ ...EAST }, 0.3);
    const z = still(1.5, 0);
    g.horde.health[z] = 5;
    run({ ...EAST, shove: true }, DT);
    expect(g.horde.state[z]).toBe(ZState.DEAD);
    expect(g.stats.kills).toBe(1);
  });
});

describe('supplies and health', () => {
  it('picks up ammunition by walking over it, unless the pack is full', () => {
    const { g, run } = setup();
    g.pickups = [
      { x: 1, y: 0, kind: 'ammo', taken: false },
      { x: -1, y: 0, kind: 'ammo', taken: false },
    ];
    run({}, 0.1);
    expect(g.pickups[0].taken).toBe(true);
    expect(g.pickups[1].taken).toBe(true);
    expect(g.reserve).toBe(45 + 2 * GAME.pickups.ammoAmount);

    g.pickups = [{ x: 0, y: 0.5, kind: 'ammo', taken: false }];
    g.reserve = GAME.weapon.reserveCap;
    run({}, 0.1);
    expect(g.pickups[0].taken).toBe(false);
  });

  it('uses a first-aid kit only when hurt', () => {
    const { g, run } = setup();
    g.pickups = [{ x: 0.5, y: 0, kind: 'medkit', taken: false }];
    run({}, 0.1);
    expect(g.pickups[0].taken).toBe(false);
    g.health = 50;
    run({}, 0.1);
    expect(g.pickups[0].taken).toBe(true);
    expect(g.health).toBe(50 + GAME.pickups.medkitAmount);
  });

  it('heals a little after a quiet spell, but only up to a point', () => {
    const { g, run } = setup();
    g.health = 30;
    g.sinceHurt = 0;
    run({}, GAME.regenDelay - 1);
    expect(g.health).toBe(30);
    run({}, 5);
    expect(g.health).toBeGreaterThan(30);
    run({}, 60);
    expect(g.health).toBeCloseTo(GAME.regenCap, 3);
    g.health = 80;
    run({}, 5);
    expect(g.health).toBe(80);
  });
});

describe('being attacked', () => {
  it('loses health to a zombie that reaches you, with a warning of where it came from', () => {
    const { g, run, events } = setup();
    const z = spawnZombie(g.horde, 6, 0, ZKind.WALKER, ZState.CHASE);
    g.horde.timer[z] = -100;
    run({}, 8);
    expect(g.health).toBeLessThan(100);
    const hurt = events.find((e) => e.type === 'hurt');
    expect(hurt).toMatchObject({ type: 'hurt', amount: 14 });
    if (hurt?.type === 'hurt') expect(hurt.fromX).toBeGreaterThan(0);
  });

  it('is slowed by zombies hanging on', () => {
    const walked = (grabbed: number): number => {
      const { g, run } = setup();
      for (let s = 0; s < 60; s++) {
        g.horde.engaged = grabbed;
        run({ moveX: 1, moveY: 0 }, DT);
      }
      return g.player.x;
    };
    expect(walked(3)).toBeLessThan(walked(0) * 0.6);
  });

  it('ends the game at zero health and stops everything', () => {
    const { g, run, events } = setup();
    const z = spawnZombie(g.horde, 1.2, 0, ZKind.WALKER, ZState.CHASE);
    g.horde.timer[z] = -100;
    g.health = 10;
    run({}, 4);
    expect(g.status).toBe('lost');
    expect(g.health).toBe(0);
    expect(events.filter((e) => e.type === 'lost')).toHaveLength(1);
    const taken = g.stats.damageTaken;
    const x = g.player.x;
    run({ moveX: 1, fire: true, aim: [30, 0] }, 3);
    expect(g.player.x).toBe(x); // cannot move
    expect(g.stats.shots).toBe(0); // cannot shoot
    expect(g.stats.damageTaken).toBe(taken); // the zombies lose interest
    expect(g.status).toBe('lost');
  });
});

describe('the rescue', () => {
  it('arrives when the clock runs out, once', () => {
    const { g, run, events } = setup({}, { rescueAt: 5 });
    run({}, 4.9);
    expect(g.status).toBe('playing');
    expect(rescueIn(g)).toBeLessThan(0.2);
    run({}, 0.3);
    expect(g.status).toBe('won');
    run({}, 2);
    expect(g.status).toBe('won');
    expect(events.filter((e) => e.type === 'won')).toHaveLength(1);
  });

  it('does not arrive if the survivor died first', () => {
    const { g, run } = setup({}, { rescueAt: 5 });
    g.health = 0.001;
    const z = spawnZombie(g.horde, 1, 0, ZKind.WALKER, ZState.ATTACK);
    g.horde.attackT[z] = 0.49;
    run({}, 6);
    expect(g.status).toBe('lost');
  });
});

describe('waves', () => {
  it('bring more each time, from far away, already on the trail', () => {
    const { g, run, events } = setup({}, { waves: true });
    run({}, GAME.waves.first + 0.2);
    const first = events.find((e) => e.type === 'wave');
    expect(first).toMatchObject({ type: 'wave', number: 1, size: 9 });
    expect(g.horde.alive).toBe(9);
    for (let i = 0; i < g.horde.used; i++) {
      expect(Math.hypot(g.horde.x[i] - g.player.x, g.horde.y[i] - g.player.y)).toBeGreaterThan(80);
      expect(g.horde.state[i]).toBe(ZState.CHASE);
    }
    run({}, GAME.waves.every);
    const waves = events.filter((e) => e.type === 'wave');
    expect(waves.map((e) => (e.type === 'wave' ? e.size : 0))).toEqual([9, 12]);
  });

  it('never overfill the horde', () => {
    const { g, run } = setup({}, { waves: true, capacity: 5 });
    run({}, 70);
    expect(g.horde.alive).toBeLessThanOrEqual(5);
  });
});

describe('replays', () => {
  const play = (seed: number): string => {
    const { g, run } = setup({}, { seed, clumps: 25, waves: true });
    for (let k = 0; k < 40; k++) {
      run(
        {
          moveX: Math.cos(k),
          moveY: Math.sin(k),
          sprint: k % 3 === 0,
          aim: [20, 10],
          fire: k % 2 === 0,
        },
        0.5,
      );
    }
    return [
      hordeChecksum(g.horde),
      g.health,
      g.ammo,
      g.reserve,
      g.time,
      g.stats.kills,
      g.player.x,
    ].join('|');
  };

  it('the same seed and the same moves give the same game', () => {
    expect(play(11)).toBe(play(11));
  });

  it('another seed gives another game', () => {
    expect(play(11)).not.toBe(play(12));
  });
});
