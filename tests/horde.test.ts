import { describe, expect, it } from 'vitest';
import { buildColliders, insideBuilding, type ColliderSource } from '../src/sim/colliders';
import { buildNavGrid, createFlowField, reachableFrom, updateFlow } from '../src/sim/flow';
import {
  createHorde,
  createTargets,
  damageZombie,
  hordeChecksum,
  sendHunting,
  shoveZombie,
  spawnZombie,
  stepHorde,
  ZKind,
  ZOMBIE,
  ZState,
  type Horde,
  type HordeContext,
  type Noise,
} from '../src/sim/horde';
import { PLAYER } from '../src/sim/player';

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

/** A small map, and everything a horde needs to know about it. */
function arena(extra: Partial<ColliderSource> = {}) {
  const world = buildColliders({
    halfSize: 150,
    buildings: [],
    areas: [],
    waterways: [],
    roads: [],
    ...extra,
  });
  const nav = buildNavGrid(world);
  const reachable = reachableFrom(nav, 0, 0);
  const flow = createFlowField(nav);
  let tick = 0;
  const context = (px: number, py: number, noises: Noise[] = [], alive = true): HordeContext => {
    updateFlow(flow, px, py);
    return { world, nav, flow, reachable, px, py, playerAlive: alive, noises };
  };
  /** Run for `seconds` with the survivor standing still; returns the damage taken and when each hit landed. */
  const run = (h: Horde, px: number, py: number, seconds: number, noises: Noise[] = []) => {
    const ctx = context(px, py, noises);
    const hits: number[] = [];
    let total = 0;
    const steps = Math.round(seconds / DT);
    for (let s = 0; s < steps; s++) {
      const dmg = stepHorde(h, ctx, DT, tick++);
      if (dmg > 0) {
        total += dmg;
        hits.push((s + 1) * DT);
      }
    }
    return { total, hits };
  };
  return { world, nav, reachable, flow, context, run };
}

/** A zombie standing still, facing a direction. */
function standing(
  h: Horde,
  x: number,
  y: number,
  facing: number,
  kind: number = ZKind.WALKER,
): number {
  const i = spawnZombie(h, x, y, kind, ZState.WANDER);
  h.heading[i] = facing;
  h.timer[i] = 1000; // idle for a very long time
  return i;
}

describe('slots', () => {
  it('counts the living, refuses when full, and reuses the room of the cleared dead', () => {
    const h = createHorde(3, 1);
    const a = spawnZombie(h, 0, 0);
    const b = spawnZombie(h, 5, 0);
    spawnZombie(h, 10, 0);
    expect(h.alive).toBe(3);
    expect(spawnZombie(h, 15, 0)).toBe(-1);

    expect(damageZombie(h, a, 1000, 1, 1)).toBe(true);
    expect(h.alive).toBe(2);
    expect(h.state[a]).toBe(ZState.DEAD);
    expect(spawnZombie(h, 15, 0)).toBe(-1); // the body still takes up its slot

    const { run } = arena();
    run(h, 100, 100, ZOMBIE.linger + 1);
    expect(h.state[a]).toBe(ZState.FREE);
    expect(h.state[b]).toBeLessThan(ZState.DEAD);
    expect(spawnZombie(h, 15, 0)).toBe(a);
    expect(h.alive).toBe(3);
  });

  it('kills a walker in two pistol hits but not one, and a runner in one', () => {
    const h = createHorde(4, 1);
    const w = spawnZombie(h, 0, 0, ZKind.WALKER);
    const r = spawnZombie(h, 5, 0, ZKind.RUNNER);
    expect(damageZombie(h, w, 55, -5, 0)).toBe(false);
    expect(h.state[w]).toBe(ZState.CHASE); // a hit turns it on the shooter
    expect(damageZombie(h, w, 55, -5, 0)).toBe(true);
    expect(damageZombie(h, r, 55, -5, 0)).toBe(true);
    expect(damageZombie(h, r, 55, -5, 0)).toBe(false); // already down
  });
});

describe('senses', () => {
  it('notices a survivor it can see in front of it', () => {
    const { run } = arena();
    const h = createHorde(4, 1);
    const i = standing(h, 15, 0, Math.PI); // facing west, toward the survivor at the origin
    run(h, 0, 0, 0.6);
    expect(h.state[i]).toBe(ZState.CHASE);
  });

  it('does not notice a survivor behind its back, until close', () => {
    const { run } = arena();
    const h = createHorde(4, 1);
    const i = standing(h, 15, 0, 0); // facing east, away
    run(h, 0, 0, 1);
    expect(h.state[i]).toBe(ZState.WANDER);
    const j = standing(h, 3, 0, 0); // but a nose works from any side
    run(h, 0, 0, 0.5);
    expect(h.state[j]).toBe(ZState.CHASE);
  });

  it('does not see through a building, but smells through a thin wall', () => {
    const { run } = arena({ buildings: [{ outer: sq(5, -10, 1, 20) }] });
    const h = createHorde(4, 1);
    const blind = standing(h, -4, 0, 0); // facing the survivor at (7, 0), 11 m away, a wall between
    run(h, 7, 0, 1);
    expect(h.state[blind]).toBe(ZState.WANDER);
    const nose = standing(h, 4.5, 0, Math.PI); // 2.5 m away on the far side of the wall, facing away
    run(h, 7, 0, 0.5);
    expect(h.state[nose]).toBe(ZState.CHASE);
  });

  it('does not see beyond its range', () => {
    const { run } = arena();
    const h = createHorde(4, 1);
    const i = standing(h, 30, 0, Math.PI);
    run(h, 0, 0, 1);
    expect(h.state[i]).toBe(ZState.WANDER);
  });

  it('hears a loud noise from out of sight and goes to look', () => {
    const { run } = arena();
    const h = createHorde(4, 1);
    const i = standing(h, 40, 0, 0); // far, facing away
    run(h, -60, 0, 0.5, [{ x: 0, y: 0, radius: 50, ttl: 1 }]);
    expect(h.state[i]).toBe(ZState.INVESTIGATE);
    expect(h.tx[i]).toBeCloseTo(0, 5);
    expect(h.ty[i]).toBeCloseTo(0, 5);
  });

  it('ignores a noise that does not reach it, and one that has faded', () => {
    const { run } = arena();
    const h = createHorde(4, 1);
    const i = standing(h, 40, 0, 0);
    run(h, -60, 0, 0.5, [{ x: 0, y: 0, radius: 30, ttl: 1 }]);
    run(h, -60, 0, 0.5, [{ x: 20, y: 0, radius: 50, ttl: 0 }]);
    expect(h.state[i]).toBe(ZState.WANDER);
  });

  it('rouses the neighbours when it spots someone', () => {
    const { run } = arena();
    const h = createHorde(4, 1);
    const a = standing(h, 15, 0, Math.PI); // sees the survivor
    const b = standing(h, 18, 3, 0); // right beside it, facing away: sees nothing itself
    run(h, 0, 0, 0.6);
    expect(h.state[a]).toBe(ZState.CHASE);
    expect([ZState.INVESTIGATE, ZState.CHASE]).toContain(h.state[b]);
  });

  it('gives up the trail after a while without a sign, then goes to where it last saw them', () => {
    const { run } = arena();
    const h = createHorde(4, 1);
    const i = standing(h, 15, 0, Math.PI);
    run(h, 0, 0, 0.6);
    expect(h.state[i]).toBe(ZState.CHASE);
    // the survivor is suddenly very far away
    run(h, -140, 0, 8);
    expect(h.state[i]).not.toBe(ZState.CHASE);
  });
});

describe('losing the trail', () => {
  it('a zombie hit from out of sight goes to where the blow came from, never to nowhere', () => {
    const { run } = arena();
    const h = createHorde(2, 1);
    const i = standing(h, 20, 0, 0);
    damageZombie(h, i, 10, 45, 0); // shot from far off to the east
    expect(h.tx[i]).toBe(45);
    run(h, -140, 0, 12); // the survivor is far to the west and out of mind
    expect(Number.isFinite(h.x[i]) && Number.isFinite(h.y[i])).toBe(true);
    expect(h.state[i]).toBe(ZState.INVESTIGATE);
    run(h, -140, 0, 40);
    expect(Number.isFinite(h.x[i]) && Number.isFinite(h.y[i])).toBe(true);
    expect(h.state[i]).not.toBe(ZState.CHASE);
  });

  it('a zombie sent hunting that never saw anyone drifts off instead of heading for nowhere', () => {
    const { run } = arena();
    const h = createHorde(2, 1);
    const i = spawnZombie(h, 20, 0, ZKind.WALKER, ZState.CHASE);
    sendHunting(h, i, 3); // only 3 seconds of trail
    run(h, -140, 0, 12);
    expect(Number.isFinite(h.x[i]) && Number.isFinite(h.y[i])).toBe(true);
    expect(h.state[i]).toBe(ZState.WANDER);
  });

  it('an investigation with no target ends at once', () => {
    const { run } = arena();
    const h = createHorde(2, 1);
    const i = spawnZombie(h, 20, 0, ZKind.WALKER, ZState.INVESTIGATE); // no target set: NaN
    run(h, -140, 0, 1);
    expect(Number.isFinite(h.x[i]) && Number.isFinite(h.y[i])).toBe(true);
    expect(h.state[i]).toBe(ZState.WANDER);
  });
});

describe('moving and fighting', () => {
  it('wanders slowly and stays on the map', () => {
    const { run, world } = arena();
    const h = createHorde(8, 1);
    for (let k = 0; k < 6; k++) spawnZombie(h, k * 3, 0, ZKind.WALKER, ZState.WANDER);
    const start = Array.from({ length: 6 }, (_, i) => [h.x[i], h.y[i]]);
    run(h, -140, 140, 30);
    for (let i = 0; i < 6; i++) {
      expect(Math.hypot(h.x[i] - start[i][0], h.y[i] - start[i][1])).toBeLessThan(
        ZOMBIE.wanderSpeed * 1.2 * 30,
      );
      expect(Math.abs(h.x[i])).toBeLessThan(world.half);
      expect(Math.abs(h.y[i])).toBeLessThan(world.half);
    }
    expect(Math.hypot(h.x[0] - start[0][0], h.y[0] - start[0][1])).toBeGreaterThan(0); // they do move
  });

  it('is slower than a walking survivor; runners are faster than a walk but slower than a sprint', () => {
    const fastestWalker = ZOMBIE.kinds[ZKind.WALKER].chase * 1.12;
    const slowestRunner = ZOMBIE.kinds[ZKind.RUNNER].chase * 0.88;
    const fastestRunner = ZOMBIE.kinds[ZKind.RUNNER].chase * 1.12;
    expect(fastestWalker).toBeLessThan(PLAYER.walkSpeed);
    expect(slowestRunner).toBeGreaterThan(PLAYER.walkSpeed);
    expect(fastestRunner).toBeLessThan(PLAYER.sprintSpeed);
  });

  it('closes on a still survivor, winds up, then strikes, and not faster than its cooldown', () => {
    const { run } = arena();
    const h = createHorde(2, 1);
    const i = standing(h, 12, 0, Math.PI);
    const { total, hits } = run(h, 0, 0, 9);
    const dmg = ZOMBIE.kinds[ZKind.WALKER].damage;
    expect(total).toBeGreaterThanOrEqual(dmg * 2);
    expect(total % dmg).toBe(0);
    // it needs time to cross 11 m and a windup before the first blow
    expect(hits[0]).toBeGreaterThan(11 / (ZOMBIE.kinds[ZKind.WALKER].chase * 1.12));
    const kind = ZOMBIE.kinds[ZKind.WALKER];
    for (let k = 1; k < hits.length; k++) {
      expect(hits[k] - hits[k - 1]).toBeGreaterThanOrEqual(kind.windup + kind.cooldown - 0.05);
    }
    expect(h.state[i]).toBeGreaterThanOrEqual(ZState.CHASE);
  });

  it('a runner hits faster but lighter than a walker', () => {
    const { run } = arena();
    const h = createHorde(2, 1);
    standing(h, 5, 0, Math.PI, ZKind.RUNNER);
    const { total, hits } = run(h, 0, 0, 6);
    expect(total % ZOMBIE.kinds[ZKind.RUNNER].damage).toBe(0);
    expect(hits.length).toBeGreaterThanOrEqual(3);
  });

  it('does not strike through a thin wall even when close enough to touch', () => {
    const { run } = arena({ buildings: [{ outer: sq(0, -20, 0.1, 40) }] });
    const h = createHorde(2, 1);
    const i = spawnZombie(h, 0.5, 0, ZKind.WALKER, ZState.CHASE);
    sendHunting(h, i, 100);
    const { total } = run(h, -0.45, 0, 3); // 0.95 m apart: inside striking distance, with a wall between
    expect(total).toBe(0);
    expect(h.state[i]).toBe(ZState.CHASE);
  });

  it('goes around a long wall to reach the survivor', () => {
    const { run, world } = arena({ buildings: [{ outer: sq(-1, -30, 2, 60) }] });
    const h = createHorde(2, 1);
    const i = spawnZombie(h, -15, 0, ZKind.WALKER, ZState.CHASE);
    sendHunting(h, i, 200);
    const { total } = run(h, 15, 0, 60);
    expect(total).toBeGreaterThan(0); // it got there and struck
    expect(insideBuilding(world, h.x[i], h.y[i])).toBe(false);
  });

  it('stops hunting when the survivor is down', () => {
    const { context } = arena();
    const h = createHorde(2, 1);
    const i = spawnZombie(h, 3, 0, ZKind.WALKER, ZState.CHASE);
    const ctx = context(0, 0, [], false);
    let dmg = 0;
    for (let s = 0; s < 300; s++) dmg += stepHorde(h, ctx, DT, s);
    expect(dmg).toBe(0);
    expect(h.state[i]).toBe(ZState.WANDER);
  });

  it('spreads out instead of stacking up', () => {
    const { run } = arena();
    const h = createHorde(60, 3);
    for (let k = 0; k < 40; k++)
      spawnZombie(h, 30 + (k % 3) * 0.05, 5, ZKind.WALKER, ZState.WANDER);
    run(h, 0, 0, 12);
    let closest = Infinity;
    for (let i = 0; i < 40; i++) {
      for (let j = i + 1; j < 40; j++) {
        closest = Math.min(closest, Math.hypot(h.x[i] - h.x[j], h.y[i] - h.y[j]));
      }
    }
    expect(closest).toBeGreaterThan(0.45);
  });

  it('knocks a zombie back and leaves it stunned', () => {
    const { run } = arena();
    const h = createHorde(2, 1);
    const i = standing(h, 3, 0, Math.PI);
    shoveZombie(h, i, 1, 0, 9, 1.1);
    run(h, -100, 0, 0.5);
    const moved = h.x[i] - 3;
    expect(moved).toBeGreaterThan(0.8);
    expect(moved).toBeLessThan(2.2);
    expect(h.stun[i]).toBeGreaterThan(0.3);
  });

  it('is never pushed into a wall by a crowd', () => {
    const { run, world } = arena({ buildings: [{ outer: sq(10, -10, 1, 20) }] });
    const h = createHorde(80, 5);
    for (let k = 0; k < 50; k++) {
      const i = spawnZombie(
        h,
        6 + (k % 7) * 0.3,
        -5 + Math.floor(k / 7) * 1.2,
        ZKind.WALKER,
        ZState.CHASE,
      );
      sendHunting(h, i, 100);
    }
    run(h, 30, 0, 20);
    for (let i = 0; i < h.used; i++) expect(insideBuilding(world, h.x[i], h.y[i])).toBe(false);
  });
});

describe('determinism', () => {
  const play = (seed: number): number => {
    const { context } = arena({ buildings: [{ outer: sq(-1, -30, 2, 60) }] });
    const h = createHorde(100, seed);
    for (let k = 0; k < 60; k++) spawnZombie(h, -60 + (k % 10) * 6, -30 + Math.floor(k / 10) * 9);
    const ctx = context(20, 0, [{ x: 0, y: 0, radius: 40, ttl: 5 }]);
    for (let s = 0; s < 900; s++) stepHorde(h, ctx, DT, s);
    return hordeChecksum(h);
  };

  it('replays exactly for the same seed', () => {
    expect(play(7)).toBe(play(7));
  });

  it('plays differently for another seed', () => {
    expect(play(7)).not.toBe(play(8));
  });
});

describe('going for other targets', () => {
  /** A map, a few target slots, and a way to run the horde with them. */
  function withTargets(extra: Partial<ColliderSource> = {}) {
    const a = arena(extra);
    const targets = createTargets(4);
    let tick = 0;
    const run = (h: Horde, px: number, py: number, seconds: number): void => {
      const ctx: HordeContext = { ...a.context(px, py), targets };
      for (let s = 0; s < Math.round(seconds / DT); s++) stepHorde(h, ctx, DT, tick++);
    };
    const put = (slot: number, x: number, y: number): void => {
      targets.x[slot] = x;
      targets.y[slot] = y;
      targets.active[slot] = 1;
    };
    return { ...a, targets, run, put };
  }

  it('walks up to someone in the open and hurts them, though the survivor is far away', () => {
    const { run, put, targets } = withTargets();
    const h = createHorde(2, 1);
    const i = standing(h, 10, 0, Math.PI); // facing the target at the origin
    put(0, 0, 0);
    run(h, 120, 120, 8);
    expect(h.victim[i]).toBe(0);
    expect(targets.damage[0]).toBeGreaterThanOrEqual(ZOMBIE.kinds[ZKind.WALKER].damage);
    expect(targets.damage[0] % ZOMBIE.kinds[ZKind.WALKER].damage).toBe(0);
  });

  it('does not strike before its windup, and keeps to its cooldown', () => {
    const { run, put, targets } = withTargets();
    const h = createHorde(2, 1);
    const i = spawnZombie(h, 1, 0, ZKind.WALKER, ZState.WANDER);
    h.timer[i] = 1000;
    put(0, 0, 0);
    run(h, 120, 120, 0.4); // notices them (smell), starts to strike, 0.5 s windup
    expect(targets.damage[0]).toBe(0);
    run(h, 120, 120, 3);
    const kind = ZOMBIE.kinds[ZKind.WALKER];
    expect(targets.damage[0]).toBeLessThanOrEqual(kind.damage * 2); // not a blow per step
    expect(targets.damage[0]).toBeGreaterThan(0);
  });

  it('ignores an empty slot, a target out of range, and one behind a wall', () => {
    const { run, put, targets } = withTargets({ buildings: [{ outer: sq(5, -10, 1, 20) }] });
    const h = createHorde(4, 1);
    const empty = standing(h, 10, 40, Math.PI);
    targets.x[1] = 10;
    targets.y[1] = 40; // slot 1 is inactive
    const far = standing(h, 60, -60, Math.PI);
    put(0, 60 - 30, -60); // 30 m from `far`
    const blocked = standing(h, 12, 0, Math.PI);
    put(2, -2, 0); // on the other side of the wall
    run(h, 120, 120, 4);
    expect(h.victim[empty]).toBe(-1);
    expect(h.victim[far]).toBe(-1);
    expect(h.victim[blocked]).toBe(-1);
    expect(targets.damage[2]).toBe(0);
  });

  it('smells someone close by even from behind', () => {
    const { run, put } = withTargets();
    const h = createHorde(2, 1);
    const i = standing(h, 3, 0, 0); // facing away, 3 m off
    put(0, 0, 0);
    run(h, 120, 120, 0.6);
    expect(h.victim[i]).toBe(0);
  });

  it('lets go when the target is gone', () => {
    const { run, put, targets } = withTargets();
    const h = createHorde(2, 1);
    const i = standing(h, 8, 0, Math.PI);
    put(0, 0, 0);
    run(h, 120, 120, 1.5);
    expect(h.victim[i]).toBe(0);
    targets.active[0] = 0;
    run(h, 120, 120, 2);
    expect(h.victim[i]).toBe(-1);
    expect(h.state[i]).not.toBe(ZState.ATTACK);
  });

  it('prefers the survivor when the survivor is close', () => {
    const { run, put } = withTargets();
    const h = createHorde(2, 1);
    const i = standing(h, 12, 0, Math.PI);
    put(0, 0, 8); // a target 14 m away to one side
    run(h, 8, 0, 1); // the survivor is 4 m off, straight ahead
    expect(h.victim[i]).toBe(-1);
    expect(h.state[i]).toBe(ZState.CHASE);
  });

  it('is turned from the trail by someone right in its path', () => {
    const { run, put } = withTargets();
    const h = createHorde(2, 1);
    const i = spawnZombie(h, 30, 0, ZKind.WALKER, ZState.CHASE);
    sendHunting(h, i, 300); // on the survivor's trail, far away at (-100, 0)
    put(0, 20, 0); // right on its way
    run(h, -100, 0, 6);
    expect(h.victim[i]).toBe(0);
  });

  it('turns on whoever shoots it, not on whoever it was after', () => {
    const { run, put } = withTargets();
    const h = createHorde(2, 1);
    const i = standing(h, 6, 0, Math.PI);
    put(0, 0, 0);
    run(h, 120, 120, 1);
    expect(h.victim[i]).toBe(0);
    damageZombie(h, i, 10, 50, 0);
    expect(h.victim[i]).toBe(-1);
  });

  it('never leaves a stale victim behind when its mind changes', () => {
    const { run, put } = withTargets();
    const h = createHorde(8, 3);
    for (let k = 0; k < 6; k++) standing(h, 10 + k, k, Math.PI);
    put(0, 0, 0);
    put(1, 4, 8);
    for (let step = 0; step < 6; step++) {
      run(h, 120, 120, 1);
      for (let k = 0; k < 6; k++) {
        const v = h.victim[k];
        if (v >= 0) expect([ZState.CHASE, ZState.ATTACK]).toContain(h.state[k]);
      }
    }
  });
});
