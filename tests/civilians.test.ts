import { describe, expect, it } from 'vitest';
import { createRng } from '../src/lib/rng';
import { buildColliders, insideBuilding, type ColliderSource } from '../src/sim/colliders';
import {
  CIVILIAN,
  CState,
  countIn,
  createCivilians,
  evacuate,
  hideCivilians,
  hurtCivilian,
  loseShelter,
  occupants,
  stepCivilians,
  takeShelter,
  type CivilianContext,
} from '../src/sim/civilians';
import { buildNavGrid, createFlowField, reachableFrom, updateFlow } from '../src/sim/flow';
import { PLAYER } from '../src/sim/player';
import type { GameWorld } from '../src/sim/world';
import { loadTashkent } from './helpers/tashkent';

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

function town(extra: Partial<ColliderSource> = {}) {
  const colliders = buildColliders({
    halfSize: 400,
    buildings: [],
    areas: [],
    waterways: [],
    roads: [],
    ...extra,
  });
  const nav = buildNavGrid(colliders);
  const world: GameWorld = { colliders, nav, reachable: reachableFrom(nav, 0, 0), places: [] };
  const flow = createFlowField(nav);
  const context = (
    px: number,
    py: number,
    over: Partial<CivilianContext> = {},
  ): CivilianContext => {
    updateFlow(flow, px, py);
    return { colliders, flow, px, py, hidden: false, playing: true, ...over };
  };
  return { colliders, world, flow, context };
}

/** One civilian standing somewhere. */
function one(x: number, y: number, state: number = CState.HIDING) {
  const c = createCivilians(1);
  c.x[0] = x;
  c.y[0] = y;
  c.state[0] = state;
  return c;
}

const run = (
  c: ReturnType<typeof createCivilians>,
  ctx: CivilianContext,
  seconds: number,
): number => {
  let recruited = 0;
  for (let s = 0; s < Math.round(seconds / DT); s++) recruited += stepCivilians(c, ctx, DT);
  return recruited;
};

describe('hiding and joining', () => {
  it('waits where it is until the survivor comes near, then joins', () => {
    const { context } = town();
    const c = one(10, 0);
    run(c, context(0, 0), 3); // 10 m away: stays put
    expect(c.state[0]).toBe(CState.HIDING);
    expect(c.x[0]).toBe(10);
    expect(run(c, context(8, 0), 0.2)).toBe(1); // 2 m away
    expect(c.state[0]).toBe(CState.FOLLOWING);
  });

  it('does not join across a wall, or with the survivor indoors, or when the game is over', () => {
    const wall = town({ buildings: [{ outer: sq(4, -10, 1, 20) }] });
    const a = one(6, 0);
    run(a, wall.context(2, 0), 1); // 4 m, wall between
    expect(a.state[0]).toBe(CState.HIDING);

    const open = town();
    const b = one(2, 0);
    run(b, open.context(0, 0, { hidden: true }), 1);
    expect(b.state[0]).toBe(CState.HIDING);
    run(b, open.context(0, 0, { playing: false }), 1);
    expect(b.state[0]).toBe(CState.HIDING);
  });
});

describe('following', () => {
  it('keeps up with a walking survivor, staying a few metres behind', () => {
    const { context } = town();
    const c = one(0, 0, CState.FOLLOWING);
    let px = 10;
    for (let s = 0; s < 60 * 20; s++) {
      px += PLAYER.walkSpeed * DT;
      stepCivilians(c, context(px, 0), DT);
    }
    const gap = px - c.x[0];
    expect(gap).toBeGreaterThan(CIVILIAN.followGap - 0.8);
    expect(gap).toBeLessThan(9);
  });

  it('falls behind a sprinting survivor, and catches up when they stop', () => {
    const { context } = town();
    const c = one(0, 0, CState.FOLLOWING);
    let px = 5;
    for (let s = 0; s < 60 * 10; s++) {
      px += PLAYER.sprintSpeed * DT;
      stepCivilians(c, context(px, 0), DT);
    }
    expect(px - c.x[0]).toBeGreaterThan(20); // left well behind
    const far = px - c.x[0];
    run(c, context(px, 0), 15);
    expect(px - c.x[0]).toBeLessThan(far);
    expect(px - c.x[0]).toBeLessThan(CIVILIAN.followGap + 1);
  });

  it('finds its way round a building to reach the survivor', () => {
    const { context, colliders } = town({ buildings: [{ outer: sq(-1, -30, 2, 60) }] });
    const c = one(-12, 0, CState.FOLLOWING);
    const ctx = context(12, 0);
    for (let s = 0; s < 60 * 60; s++) {
      stepCivilians(c, ctx, DT);
      expect(insideBuilding(colliders, c.x[0], c.y[0])).toBe(false);
    }
    expect(Math.hypot(12 - c.x[0], c.y[0])).toBeLessThan(CIVILIAN.followGap + 1.5);
  });

  it('waits where it stands while the survivor is indoors', () => {
    const { context } = town();
    const c = one(10, 0, CState.FOLLOWING);
    run(c, context(0, 0, { hidden: true }), 3);
    expect(c.x[0]).toBe(10);
  });

  it('stays out from under the survivor, and from other followers', () => {
    const { context } = town();
    const c = createCivilians(6);
    for (let i = 0; i < 6; i++) {
      c.x[i] = 0.2 * (i % 2);
      c.y[i] = 0.1 * i;
      c.state[i] = CState.FOLLOWING;
    }
    run(c, context(0, 0), 5);
    for (let i = 0; i < 6; i++) {
      expect(Math.hypot(c.x[i], c.y[i])).toBeGreaterThan(1);
      for (let j = i + 1; j < 6; j++) {
        expect(Math.hypot(c.x[i] - c.x[j], c.y[i] - c.y[j])).toBeGreaterThan(0.5);
      }
    }
  });
});

describe('harm and rescue', () => {
  it('dies when hurt enough, and only the living can be hurt', () => {
    const c = one(0, 0, CState.FOLLOWING);
    expect(hurtCivilian(c, 0, 20)).toBe(false);
    expect(c.health[0]).toBe(CIVILIAN.health - 20);
    expect(hurtCivilian(c, 0, 25)).toBe(true);
    expect(c.state[0]).toBe(CState.DEAD);
    expect(hurtCivilian(c, 0, 25)).toBe(false);
    const sheltered = one(0, 0, CState.SHELTERED);
    expect(hurtCivilian(sheltered, 0, 100)).toBe(false);
  });

  it('takes the nearby followers into a shelter with you, and leaves the far ones', () => {
    const c = createCivilians(3);
    c.state.fill(CState.FOLLOWING);
    c.x.set([3, 8, 40]);
    c.y.set([0, 0, 0]);
    expect(takeShelter(c, 2, 0, 0)).toBe(2);
    expect(c.state[0]).toBe(CState.SHELTERED);
    expect(c.shelter[1]).toBe(2);
    expect(c.state[2]).toBe(CState.FOLLOWING);
    expect(occupants(c, 2)).toBe(2);
    expect(occupants(c, 1)).toBe(0);
  });

  it('loses everyone behind a door that gives way', () => {
    const c = createCivilians(3);
    c.state.set([CState.SHELTERED, CState.SHELTERED, CState.SHELTERED]);
    c.shelter.set([1, 1, 2]);
    expect(loseShelter(c, 1)).toBe(2);
    expect(c.state[0]).toBe(CState.DEAD);
    expect(c.state[2]).toBe(CState.SHELTERED);
  });

  it('saves the sheltered and the followers near the helicopter, but not those left behind', () => {
    const c = createCivilians(5);
    c.state.set([CState.FOLLOWING, CState.FOLLOWING, CState.SHELTERED, CState.HIDING, CState.DEAD]);
    c.x.set([5, 90, 0, 3, 2]);
    c.y.set([0, 0, 0, 0, 0]);
    expect(evacuate(c, 0, 0)).toBe(2); // the near follower and the sheltered one
    expect(c.state[0]).toBe(CState.SAVED);
    expect(c.state[1]).toBe(CState.FOLLOWING);
    expect(c.state[2]).toBe(CState.SAVED);
    expect(c.state[3]).toBe(CState.HIDING);
    expect(c.state[4]).toBe(CState.DEAD);
    expect(countIn(c, CState.SAVED)).toBe(2);
  });
});

describe('where they hide', () => {
  it('puts them on open ground, apart, and the same way every time', () => {
    const { world, colliders } = town({
      buildings: [
        { outer: sq(40, 40, 30) },
        { outer: sq(-120, 60, 40) },
        { outer: sq(100, -90, 30) },
      ],
    });
    const hide = () => {
      const c = createCivilians(8);
      const placed = hideCivilians(c, world, createRng(7), [0, 0]);
      return { c, placed };
    };
    const { c, placed } = hide();
    expect(placed).toBe(8);
    for (let i = 0; i < 8; i++) {
      expect(c.state[i]).toBe(CState.HIDING);
      expect(insideBuilding(colliders, c.x[i], c.y[i])).toBe(false);
      expect(Math.hypot(c.x[i], c.y[i])).toBeGreaterThan(55);
      for (let j = i + 1; j < 8; j++) {
        expect(Math.hypot(c.x[i] - c.x[j], c.y[i] - c.y[j])).toBeGreaterThan(11);
      }
    }
    expect(Array.from(hide().c.x)).toEqual(Array.from(c.x));
  });

  it('leaves out the ones it cannot place, rather than putting them somewhere bad', () => {
    const { world } = town();
    world.reachable.fill(0); // nowhere to stand at all
    const c = createCivilians(3);
    expect(hideCivilians(c, world, createRng(1), [0, 0])).toBe(0);
    expect(countIn(c, CState.HIDING)).toBe(0);
    expect(countIn(c, CState.DEAD)).toBe(3);
  });

  it('hides them within a walk of the start on the real map', () => {
    const t = loadTashkent();
    const nav = buildNavGrid(t.colliders);
    const world: GameWorld = {
      colliders: t.colliders,
      nav,
      reachable: reachableFrom(nav, t.spawn[0], t.spawn[1]),
      places: [],
    };
    const c = createCivilians(10);
    expect(hideCivilians(c, world, createRng(3), t.spawn)).toBe(10);
    for (let i = 0; i < 10; i++) {
      expect(t.insideBuilding(c.x[i], c.y[i])).toBe(false);
      expect(Math.hypot(c.x[i] - t.spawn[0], c.y[i] - t.spawn[1])).toBeLessThan(530);
    }
  });
});
