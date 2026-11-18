// Touch controls, the part that is plain arithmetic: a virtual stick's reading, which gun comes next,
// and whether a device wants the controls at all. The Vue component draws them; the scene reads
// `TouchInput` each frame beside the keyboard.

import type { WeaponName } from '../sim/game';

/** What the thumbs are doing, in screen terms: x to the right, y up the screen, each -1 to 1. */
export interface TouchInput {
  /** The left stick: walking (or, at the wheel, the pedal and the wheel). */
  move: [number, number];
  /** The right stick's direction while it is pushed, or null: where to aim. */
  aim: [number, number] | null;
  /** The right stick is pushed far enough to fire. */
  fire: boolean;
  sprint: boolean;
}

export const NO_TOUCH: TouchInput = { move: [0, 0], aim: null, fire: false, sprint: false };

/** The buttons: one press each (the camera and pause buttons are handled by the view). */
export type TouchAction =
  'interact' | 'reload' | 'shove' | 'weapon' | 'flashlight' | 'camera' | 'pause';

export const STICK = {
  /** Pixels from the centre to full deflection. */
  radius: 56,
  /** Below this share of the radius the stick reads zero. */
  dead: 0.16,
  /** The right stick fires from this share of the radius. */
  fireFrom: 0.72,
} as const;

/**
 * A finger's offset from the stick's centre, in screen pixels (y down, as pointers give it), as a
 * stick reading: x right, y up, clamped to the unit circle, zero inside the dead zone.
 */
export function stickVector(
  dx: number,
  dy: number,
  radius: number = STICK.radius,
  dead: number = STICK.dead,
): [number, number] {
  const len = Math.hypot(dx, dy);
  if (len < dead * radius) return [0, 0];
  const scale = Math.min(1, len / radius) / len;
  return [dx * scale, -dy * scale];
}

/** How far a stick is pushed, 0 to 1. */
export const deflection = (v: readonly [number, number]): number => Math.hypot(v[0], v[1]);

/** Whether a device wants touch controls: a coarse pointer (a phone, a tablet), or a `touch=1` link. */
export function wantsTouch(coarsePointer: boolean, search: string): boolean {
  const q = new URLSearchParams(search);
  if (q.get('touch') === '0') return false;
  return coarsePointer || q.get('touch') === '1';
}

/** The gun after this one, among those found: the key the game expects (1 pistol, 2 shotgun, 3 rifle). */
export function nextWeapon(current: WeaponName, hasShotgun: boolean, hasRifle: boolean): 1 | 2 | 3 {
  const order: [WeaponName, 1 | 2 | 3, boolean][] = [
    ['pistol', 1, true],
    ['shotgun', 2, hasShotgun],
    ['rifle', 3, hasRifle],
  ];
  const have = order.filter(([, , has]) => has);
  const at = have.findIndex(([name]) => name === current);
  return have[(at + 1) % have.length][1];
}
