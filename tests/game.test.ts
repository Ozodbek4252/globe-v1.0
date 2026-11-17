import { describe, expect, it } from 'vitest';
import { buildColliders, insideBuilding, type ColliderSource } from '../src/sim/colliders';
import {
  createGame,
  createGameWorld,
  drainEvents,
  GAME,
  interactionAt,
  NO_INPUT,
  stepGame,
  type GameEvent,
  type GameInput,
  type GameOptions,
} from '../src/sim/game';
import { hordeChecksum, sendHunting, spawnZombie, ZKind, ZState } from '../src/sim/horde';
import { PLACES, type PlaceBuilding } from '../src/sim/places';

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

/**
 * A small town and a game in it, with no zombies, no crowd and no outbreak unless asked for (see
 * outbreak.test.ts for those). `places` are the buildings the radar, shelters and shops are chosen from
 * (they should also be in `extra.buildings`).
 */
function setup(
  extra: Partial<ColliderSource> = {},
  options: Partial<GameOptions> = {},
  places: PlaceBuilding[] = [],
) {
  const colliders = buildColliders({
    halfSize: 150,
    buildings: [],
    areas: [],
    waterways: [],
    roads: [],
    ...extra,
  });
  const world = createGameWorld(colliders, [0, 0], places);
  const g = createGame(world, {
    seed: 1,
    startX: 0,
    startY: 0,
    clumps: 0,
    population: false,
    patients: 0,
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
        now.interact = false;
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
    expect(g.pickups).toHaveLength(GAME.pickups.ammo + GAME.pickups.medkit + GAME.pickups.food);
    expect(g.food).toBe(GAME.food.max);
    expect(g.time).toBe(0);
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

describe('replays', () => {
  const play = (seed: number): string => {
    const { g, run } = setup({}, { seed, clumps: 25 });
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

/** A district with one of each kind of place, far enough apart that each building has one job. */
const DISTRICT: PlaceBuilding[] = [
  { id: 1, outer: sq(250, 0, 40), height: 30, kind: 'apartments' }, // the radar
  { id: 2, outer: sq(60, 0, 40), height: 8, kind: 'other', name: 'Hall' }, // the first shelter
  { id: 3, outer: sq(0, 110, 30), height: 5, kind: 'commercial' }, // supplies near the start
  { id: 4, outer: sq(-300, 0, 30), height: 5, kind: 'commercial' }, // the armory
];

function district(options: Partial<GameOptions> = {}) {
  const t = setup(
    { halfSize: 400, buildings: DISTRICT.map((b) => ({ outer: b.outer })) },
    options,
    DISTRICT,
  );
  const place = (kind: string) => t.world.places.find((p) => p.kind === kind)!;
  /** Stand at a place's door. */
  const goTo = (kind: string): void => {
    const p = place(kind);
    t.g.player = { ...t.g.player, x: p.x, y: p.y };
  };
  return { ...t, place, goTo };
}

describe('places', () => {
  it('picks a radar, a shelter, supplies and an armory out of the district', () => {
    const { world } = district();
    expect(world.places.map((p) => p.kind).sort()).toEqual([
      'armory',
      'radar',
      'shelter',
      'supplies',
    ]);
  });

  it('offers nothing away from a door, and the right thing at each', () => {
    const { g, world, goTo } = district();
    expect(interactionAt(g, world)).toBeNull();
    goTo('radar');
    expect(interactionAt(g, world)?.label).toBe('Power up the radar');
    goTo('supplies');
    expect(interactionAt(g, world)?.label).toMatch(/^Search /);
    goTo('armory');
    expect(interactionAt(g, world)?.place.kind).toBe('armory');
  });

  it('needs you to be at the door, not just near the building', () => {
    const { g, world, place, goTo } = district();
    goTo('radar');
    const p = place('radar');
    g.player = {
      ...g.player,
      x: p.x + p.nx * (PLACES.reach + 0.5),
      y: p.y + p.ny * (PLACES.reach + 0.5),
    };
    expect(interactionAt(g, world)).toBeNull();
  });

  it('powers up the radar, once', () => {
    const { g, run, goTo, count, place } = district();
    expect(g.radarOn).toBe(false);
    goTo('radar');
    run({ interact: true }, DT);
    expect(g.radarOn).toBe(true);
    expect(g.used[place('radar').id]).toBe(true);
    expect(count('radar')).toBe(1);
    run({ interact: true }, 0.5);
    expect(count('radar')).toBe(1);
  });

  it('does nothing when nothing is at the door', () => {
    const { g, run, count } = district();
    run({ interact: true }, 0.2);
    expect(g.radarOn).toBe(false);
    expect(count('loot')).toBe(0);
  });

  it('gives supplies when searched, once, and never more than you can carry', () => {
    const { g, run, goTo, count, events, place } = district();
    g.reserve = 0;
    g.health = 40;
    goTo('supplies');
    run({ interact: true }, DT);
    const loot = events.find((e) => e.type === 'loot');
    expect(loot).toBeDefined();
    expect(g.reserve + g.health).toBeGreaterThan(40); // took something
    expect(g.used[place('supplies').id]).toBe(true);
    expect(interactionAt(g, district().world)).toBeNull(); // (a different world: just checks no throw)
    g.sinceHurt = 0; // no regeneration to muddy the comparison, whatever the roll gave
    const before = [g.reserve, g.health];
    run({ interact: true }, DT);
    expect([g.reserve, g.health]).toEqual(before);
    expect(count('loot')).toBe(1);
    expect(g.reserve).toBeLessThanOrEqual(GAME.weapon.reserveCap);
    expect(g.health).toBeLessThanOrEqual(GAME.health);
  });

  it('leaves a shop for later when you have no use for what is in it', () => {
    const { g, run, goTo, place, events } = district();
    g.reserve = GAME.weapon.reserveCap;
    g.health = GAME.health;
    g.food = GAME.food.max;
    goTo('supplies');
    run({ interact: true }, DT);
    expect(g.used[place('supplies').id]).toBe(false);
    const loot = events.find((e) => e.type === 'loot');
    expect(loot).toMatchObject({ ammo: 0, health: 0, food: 0 });
    // starving, hurt and short of ammunition: it is worth searching after all, whatever the roll gives
    g.health = 30;
    g.food = 10;
    g.reserve = 0;
    run({ interact: true }, DT);
    expect(g.used[place('supplies').id]).toBe(true);
  });

  it('the armory gives a shotgun and shells, and some pistol rounds, once', () => {
    const { g, run, goTo, events, place } = district();
    g.reserve = 0;
    expect(g.hasShotgun).toBe(false);
    goTo('armory');
    run({ interact: true }, DT);
    expect(g.hasShotgun).toBe(true);
    expect(g.reserve).toBe(GAME.loot.ammo); // pistol rounds
    expect(g.stash).toEqual({ ammo: GAME.shotgun.mag, reserve: GAME.shotgun.reserve });
    expect(events.find((e) => e.type === 'loot')).toMatchObject({ armory: true, shotgun: true });
    expect(g.used[place('armory').id]).toBe(true);
    run({ interact: true }, DT);
    expect(g.stash.reserve).toBe(GAME.shotgun.reserve); // not a second helping
  });

  it('is shut to the dead', () => {
    const { g, world, goTo } = district();
    goTo('radar');
    g.status = 'lost';
    expect(interactionAt(g, world)).toBeNull();
  });
});

describe('shelters', () => {
  /** A game with the survivor at the shelter's door. */
  const atDoor = (options: Partial<GameOptions> = {}) => {
    const t = district(options);
    t.goTo('shelter');
    return { ...t, shelter: t.place('shelter') };
  };
  /** A zombie on the survivor's trail, right at the door (or `away` metres out along the door's normal). */
  const hunter = (t: ReturnType<typeof atDoor>, away = 1.2) => {
    const i = spawnZombie(
      t.g.horde,
      t.shelter.x + t.shelter.nx * away,
      t.shelter.y + t.shelter.ny * away,
      ZKind.WALKER,
      ZState.CHASE,
    );
    sendHunting(t.g.horde, i, 400);
    return i;
  };

  it('goes in and comes out again', () => {
    const t = atDoor();
    expect(interactionAt(t.g, t.world)?.label).toBe('Go inside');
    t.run({ interact: true }, DT);
    expect(t.g.inside).toBe(t.shelter.id);
    expect(t.count('enter')).toBe(1);
    expect(interactionAt(t.g, t.world)?.label).toBe('Leave the shelter');
    t.run({ interact: true }, DT);
    expect(t.g.inside).toBe(-1);
    expect(t.count('leave')).toBe(1);
  });

  it('can only be left from the inside, at any distance from the door (you cannot walk off)', () => {
    const t = atDoor();
    t.run({ interact: true }, DT);
    t.run({ moveX: 1, moveY: 0, sprint: true }, 1);
    expect(Math.hypot(t.g.player.x - t.shelter.x, t.g.player.y - t.shelter.y)).toBeLessThan(0.01);
  });

  it('does not let you shoot, shove or aim from indoors, but lets you reload', () => {
    const t = atDoor();
    t.run({ interact: true }, DT);
    const heading = t.g.player.heading;
    t.run({ ...EAST, fire: true, shove: true }, 1);
    expect(t.g.stats.shots).toBe(0);
    expect(t.g.stats.shoves).toBe(0);
    expect(t.g.player.heading).toBe(heading);
    t.g.ammo = 4;
    t.run({ reload: true }, 2);
    expect(t.g.ammo).toBe(GAME.weapon.mag);
  });

  it('heals you to full, much faster than outdoors', () => {
    const t = atDoor();
    t.g.health = 30;
    t.g.sinceHurt = 0; // just hurt: outdoors you would wait eight seconds to start healing, and stop at 60
    t.run({ interact: true }, DT);
    t.run({}, 10);
    expect(t.g.health).toBeGreaterThan(60);
    t.run({}, 12);
    expect(t.g.health).toBe(GAME.health);
  });

  it('is silent to go in, and out of sight once there', () => {
    const t = atDoor();
    const watcher = t.still(t.shelter.x + t.shelter.nx * 12, t.shelter.y + t.shelter.ny * 12);
    t.g.horde.heading[watcher] = Math.atan2(-t.shelter.ny, -t.shelter.nx); // facing the door, 12 m off
    t.run({ interact: true }, DT);
    t.run({}, 2);
    expect(t.g.noises).toHaveLength(0);
    expect(t.g.horde.state[watcher]).toBe(ZState.WANDER); // it does not see anyone

    // the same zombie notices a survivor standing out in the street
    const open = district();
    open.goTo('shelter');
    const w2 = open.still(
      open.place('shelter').x + open.place('shelter').nx * 12,
      open.place('shelter').y + open.place('shelter').ny * 12,
    );
    open.g.horde.heading[w2] = Math.atan2(-open.place('shelter').ny, -open.place('shelter').nx);
    open.run({}, 2);
    expect(open.g.horde.state[w2]).toBe(ZState.CHASE);
  });

  it('shakes off ordinary pursuers, who give up after a few seconds', () => {
    const t = atDoor();
    const chaser = spawnZombie(
      t.g.horde,
      t.shelter.x + t.shelter.nx * 1.2,
      t.shelter.y + t.shelter.ny * 1.2,
      ZKind.WALKER,
      ZState.CHASE,
    );
    t.run({ interact: true }, DT);
    t.run({}, 12);
    expect(t.g.horde.state[chaser]).not.toBe(ZState.CHASE);
    expect(t.g.horde.state[chaser]).not.toBe(ZState.ATTACK);
    const door = t.g.doors[t.shelter.id];
    t.run({}, 10);
    expect(t.g.doors[t.shelter.id]).toBe(door); // nothing is hitting it any more
  });

  it('is battered by zombies on the trail, not the survivor: no health is lost while the door holds', () => {
    const t = atDoor();
    for (let k = 0; k < 4; k++) hunter(t, 1.2 + k * 0.5);
    t.g.health = 80;
    t.run({ interact: true }, DT);
    t.run({}, 12);
    expect(t.g.doors[t.shelter.id]).toBeLessThan(GAME.shelter.door);
    expect(t.g.doors[t.shelter.id]).toBeGreaterThan(0);
    expect(t.g.stats.damageTaken).toBe(0);
    expect(t.g.health).toBeGreaterThanOrEqual(80);
    const doorEvents = t.events.filter((e) => e.type === 'door');
    expect(doorEvents.length).toBeGreaterThan(2);
    expect(doorEvents.length).toBeLessThan(60); // throttled, not one per step
    const fractions = doorEvents.map((e) => (e.type === 'door' ? e.fraction : 1));
    expect(fractions[fractions.length - 1]).toBeLessThan(fractions[0]);
  });

  it('gives way in the end: you are thrown out hurt and the shelter is lost for good', () => {
    const t = atDoor();
    t.g.doors[t.shelter.id] = 20;
    for (let k = 0; k < 3; k++) hunter(t, 1.2 + k * 0.4);
    t.run({ interact: true }, DT);
    t.run({}, 20);
    expect(t.count('breach')).toBe(1);
    expect(t.g.inside).toBe(-1);
    expect(t.g.breached[t.shelter.id]).toBe(true);
    expect(t.g.stats.damageTaken).toBeGreaterThanOrEqual(GAME.shelter.breachDamage);
    expect(interactionAt(t.g, t.world)).toBeNull(); // "Go inside" is no longer offered
    t.run({ interact: true }, DT);
    expect(t.g.inside).toBe(-1);
  });

  it('throws the horde back from a bursting door, so there is a moment to act', () => {
    const t = atDoor();
    t.g.doors[t.shelter.id] = 5;
    const near = hunter(t, 1.2);
    const far = hunter(t, 30); // well outside the blast
    t.run({ interact: true }, DT);
    // step to the very moment the door gives way, and look then
    for (let s = 0; s < 600 && t.count('breach') === 0; s++) t.run({}, DT);
    expect(t.count('breach')).toBe(1);
    expect(t.g.horde.stun[near]).toBeGreaterThan(1); // thrown back and reeling
    expect(Math.hypot(t.g.horde.vx[near], t.g.horde.vy[near])).toBeGreaterThan(3);
    expect(t.g.horde.stun[far]).toBe(0); // the one well outside the blast is untouched
    expect(t.g.status).toBe('playing'); // not dead on the spot
  });

  it('keeps doors only for shelters, and a fresh game starts with them whole', () => {
    const t = district();
    t.world.places.forEach((p) => {
      expect(t.g.doors[p.id]).toBe(p.kind === 'shelter' ? GAME.shelter.door : 0);
    });
  });
});

describe('the shotgun', () => {
  /** A district game with the shotgun already found and in hand. */
  const armed = (options: Partial<GameOptions> = {}) => {
    const t = district(options);
    t.goTo('armory');
    t.run({ interact: true }, DT);
    t.g.player = { ...t.g.player, x: 0, y: 0 };
    t.run({ weapon: 2 }, 0.6); // take it out, and wait out the moment it takes to bring up
    return t;
  };

  it('stays in the armory until you find it', () => {
    const { g, run, count } = district();
    run({ weapon: 2 }, 0.5);
    expect(g.weapon).toBe('pistol');
    expect(count('weapon')).toBe(0);
  });

  it('can be taken out and put away, each gun keeping its own magazine and spare rounds', () => {
    const { g, run, count } = armed();
    expect(g.weapon).toBe('shotgun');
    expect(g.ammo).toBe(GAME.shotgun.mag);
    expect(g.reserve).toBe(GAME.shotgun.reserve);
    expect(g.stash.ammo).toBe(GAME.weapon.mag); // the pistol, as it was
    expect(count('weapon')).toBe(1);
    g.ammo = 3;
    g.stash.ammo = 9;
    g.stash.reserve = 77;
    run({ weapon: 1 }, 0.6);
    expect(g.weapon).toBe('pistol');
    expect([g.ammo, g.reserve]).toEqual([9, 77]);
    expect(g.stash.ammo).toBe(3);
    run({ weapon: 1 }, 0.1); // already in hand: nothing happens
    expect(count('weapon')).toBe(2);
  });

  it('takes a moment to bring up, and drops a half-done reload', () => {
    const { g, run } = armed();
    g.ammo = 2;
    run({ reload: true }, 0.5);
    expect(g.reloading).toBeGreaterThan(0);
    run({ weapon: 1 }, DT);
    expect(g.reloading).toBe(0);
    const shots = g.stats.shots;
    run({ fire: true, aim: [30, 0] }, 0.2); // too soon after switching
    expect(g.stats.shots).toBe(shots);
    run({ fire: true, aim: [30, 0] }, 0.5);
    expect(g.stats.shots).toBeGreaterThan(shots);
  });

  it('fires a spread of pellets in one pull, and kills a walker close up in one blast', () => {
    const { g, run, still, events } = armed();
    const z = still(3, 0);
    run({ fire: true, aim: [30, 0] }, DT);
    expect(events.filter((e) => e.type === 'shot')).toHaveLength(GAME.shotgun.pellets);
    expect(g.stats.shots).toBe(1);
    expect(g.ammo).toBe(GAME.shotgun.mag - 1);
    expect(g.horde.state[z]).toBe(ZState.DEAD);
    expect(g.stats.kills).toBe(1);
  });

  it('is weak at long range, and useless beyond it', () => {
    // tough targets, so a blast cannot kill them and the damage can be compared
    const near = armed();
    const a = near.still(3, 0);
    near.g.horde.health[a] = 10000;
    near.run({ fire: true, aim: [30, 0] }, DT);
    const far = armed();
    const b = far.still(14, 0);
    far.g.horde.health[b] = 10000;
    far.run({ fire: true, aim: [30, 0] }, DT);
    expect(far.g.horde.health[b]).toBeGreaterThan(near.g.horde.health[a]); // hurt far less than at 3 m
    const out = armed();
    const c = out.still(20, 0);
    out.run({ fire: true, aim: [30, 0] }, DT);
    expect(out.g.horde.health[c]).toBe(100);
  });

  it('is stopped by a wall like any bullet', () => {
    const walled = setup({ buildings: [{ outer: sq(4, -5, 1, 10) }] });
    walled.g.weapon = 'shotgun';
    walled.g.ammo = 6;
    const z = walled.still(8, 0);
    walled.run({ fire: true, aim: [30, 0] }, DT);
    expect(walled.g.horde.health[z]).toBe(100);
  });

  it('is slow: under one shot a second', () => {
    const { g, run } = armed();
    const before = g.stats.shots;
    run({ fire: true, aim: [30, 0] }, 3);
    expect(g.stats.shots - before).toBe(Math.ceil(3 / GAME.shotgun.interval)); // 4: at 0, 0.85, 1.7, 2.55 s
  });

  it('is louder than the pistol: it carries past where a pistol shot would stop', () => {
    const shotgun = armed();
    const z1 = shotgun.still(70, 0);
    shotgun.g.horde.heading[z1] = 0;
    shotgun.run({ fire: true, aim: [-30, 0] }, 0.5);
    expect(shotgun.g.horde.state[z1]).toBe(ZState.INVESTIGATE);

    const pistol = district();
    pistol.g.player = { ...pistol.g.player, x: 0, y: 0 };
    const z2 = pistol.still(70, 0);
    pistol.g.horde.heading[z2] = 0;
    pistol.run({ fire: true, aim: [-30, 0] }, 0.5);
    expect(pistol.g.horde.state[z2]).toBe(ZState.WANDER);
  });

  it('reloads slowly, taking shells from its own reserve', () => {
    const { g, run } = armed();
    g.ammo = 1;
    run({ reload: true }, 2);
    expect(g.ammo).toBe(1);
    run({}, 0.8);
    expect(g.ammo).toBe(GAME.shotgun.mag);
    expect(g.reserve).toBe(GAME.shotgun.reserve - (GAME.shotgun.mag - 1));
  });

  it('does not use up pistol rounds, and ground ammunition still goes to the pistol', () => {
    const { g, run } = armed();
    const stash = g.stash.reserve;
    g.pickups = [{ x: 0.5, y: 0, kind: 'ammo', taken: false }];
    run({}, 0.2);
    expect(g.pickups[0].taken).toBe(true);
    expect(g.stash.reserve).toBe(stash + GAME.pickups.ammoAmount); // the pistol's, in the stash
    expect(g.reserve).toBeLessThanOrEqual(GAME.shotgun.reserve); // the shotgun's, untouched
  });
});

describe('surviving without a rescue: food, drops and fists', () => {
  it('gets hungry steadily, and starves without food', () => {
    const { g, run } = setup();
    run({}, 10);
    expect(g.food).toBeCloseTo(GAME.food.max - GAME.food.drain * 10, 1);
    g.food = 0;
    g.health = 50;
    run({}, 5);
    expect(g.health).toBeLessThan(50 - GAME.food.starve * 4);
    expect(g.food).toBe(0);
  });

  it('heals nothing while starving, even in a shelter', () => {
    const t = district();
    t.goTo('shelter');
    t.run({ interact: true }, DT);
    t.g.food = 0;
    t.g.health = 60;
    t.run({}, 5);
    expect(t.g.health).toBeLessThan(60);
  });

  it('eats a food pickup, and leaves it when full', () => {
    const { g, run } = setup();
    g.food = 20;
    g.pickups = [{ x: 0.5, y: 0, kind: 'food', taken: false }];
    run({}, 0.1);
    expect(g.pickups[0].taken).toBe(true);
    expect(g.food).toBeCloseTo(20 + GAME.pickups.foodAmount, 0);
    g.food = GAME.food.max;
    g.pickups = [{ x: 0.5, y: 0, kind: 'food', taken: false }];
    run({}, 0.1);
    expect(g.pickups[0].taken).toBe(false);
  });

  it('leaves what a zombie was carrying where it fell, sometimes', () => {
    let dropped = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const t = setup({}, { seed });
      t.g.pickups = [];
      const z = t.still(4, 0);
      t.g.horde.health[z] = 1;
      t.run({ ...EAST, fire: true }, 0.3);
      expect(t.g.horde.state[z]).toBe(ZState.DEAD);
      dropped += t.g.pickups.length;
      for (const p of t.g.pickups) {
        expect(Math.hypot(p.x - t.g.horde.x[z], p.y - t.g.horde.y[z])).toBeLessThan(0.01);
      }
    }
    // about a quarter of kills drop something: 40 kills is nowhere near none or all
    expect(dropped).toBeGreaterThan(2);
    expect(dropped).toBeLessThan(30);
  });

  it('never has more pickups on the ground than the limit', () => {
    const { g, run, still } = setup();
    g.pickups = Array.from({ length: GAME.pickups.max }, (_, i) => ({
      x: 100 + i,
      y: 100,
      kind: 'ammo' as const,
      taken: i === 3,
    }));
    for (let k = 0; k < 30; k++) {
      const z = still(4, 0);
      g.horde.health[z] = 1;
      g.fireCooldown = 0;
      run({ ...EAST, fire: true }, 0.3);
    }
    expect(g.pickups.length).toBeLessThanOrEqual(GAME.pickups.max);
  });

  it('swings a melee weapon when the gun is dry: three blows fell a walker', () => {
    const { g, run, still, events } = setup();
    g.ammo = 0;
    g.reserve = 0;
    const z = still(1.4, 0);
    run({ ...EAST, fire: true }, 0.2);
    expect(events.some((e) => e.type === 'swing')).toBe(true);
    expect(g.stats.shots).toBe(0);
    expect(g.horde.health[z]).toBeCloseTo(100 - GAME.melee.damage, 3);
    run({ ...EAST, fire: true }, 3);
    expect(g.horde.state[z]).toBe(ZState.DEAD);
    expect(g.stats.kills).toBe(1);
  });

  it('does not reach far, and is slower than a gun', () => {
    const { g, run, still } = setup();
    g.ammo = 0;
    g.reserve = 0;
    const far = still(4, 0);
    run({ ...EAST, fire: true }, 0.2);
    expect(g.horde.health[far]).toBe(100);
    const swings = (): number => {
      const t = setup();
      t.g.ammo = 0;
      t.g.reserve = 0;
      t.run({ ...EAST, fire: true }, 4);
      return t.events.filter((e) => e.type === 'swing').length;
    };
    expect(swings()).toBe(Math.ceil(4 / GAME.melee.cooldown)); // five swings in four seconds
  });

  it('does not swing while a gun still has rounds, or when the gun is only reloading', () => {
    const { g, run, events } = setup();
    run({ ...EAST, fire: true }, 0.3);
    expect(events.some((e) => e.type === 'swing')).toBe(false);
    expect(g.stats.shots).toBeGreaterThan(0);
  });
});
