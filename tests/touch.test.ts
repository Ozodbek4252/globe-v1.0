import { describe, expect, it } from 'vitest';
import { deflection, nextWeapon, STICK, stickVector, wantsTouch } from '../src/city/touch';

describe('a virtual stick', () => {
  it('reads zero in the dead zone, points up the screen for a finger moved up, and never past the rim', () => {
    expect(stickVector(3, -3)).toEqual([0, 0]);
    const up = stickVector(0, -STICK.radius);
    expect(up[0]).toBeCloseTo(0, 6);
    expect(up[1]).toBeCloseTo(1, 6);
    const far = stickVector(300, 400);
    expect(deflection(far)).toBeCloseTo(1, 6);
    expect(far[0]).toBeCloseTo(0.6, 6);
    expect(far[1]).toBeCloseTo(-0.8, 6);
    const half = stickVector(STICK.radius / 2, 0);
    expect(half).toEqual([0.5, -0]);
  });
});

describe('who gets the touch controls', () => {
  it('a coarse pointer, or a link that asks, unless the link says no', () => {
    expect(wantsTouch(true, '')).toBe(true);
    expect(wantsTouch(false, '')).toBe(false);
    expect(wantsTouch(false, '?touch=1')).toBe(true);
    expect(wantsTouch(true, '?touch=0')).toBe(false);
  });
});

describe('the gun button', () => {
  it('goes round the guns that have been found', () => {
    expect(nextWeapon('pistol', false, false)).toBe(1);
    expect(nextWeapon('pistol', true, false)).toBe(2);
    expect(nextWeapon('shotgun', true, false)).toBe(1);
    expect(nextWeapon('pistol', false, true)).toBe(3);
    expect(nextWeapon('shotgun', true, true)).toBe(3);
    expect(nextWeapon('rifle', true, true)).toBe(1);
  });
});
