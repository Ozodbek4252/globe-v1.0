import { describe, expect, it } from 'vitest';
import { compassName, screenAngle, screenOffset } from '../src/city/bearings';

const deg = (d: number): number => (d * Math.PI) / 180;

describe('compass words', () => {
  it('names the eight directions', () => {
    // angles run counter-clockwise from east
    expect(compassName(deg(0))).toBe('east');
    expect(compassName(deg(45))).toBe('north-east');
    expect(compassName(deg(90))).toBe('north');
    expect(compassName(deg(135))).toBe('north-west');
    expect(compassName(deg(180))).toBe('west');
    expect(compassName(deg(-135))).toBe('south-west');
    expect(compassName(deg(-90))).toBe('south');
    expect(compassName(deg(-45))).toBe('south-east');
  });

  it('rounds to the nearest and wraps around', () => {
    expect(compassName(deg(100))).toBe('north');
    expect(compassName(deg(70))).toBe('north');
    expect(compassName(deg(60))).toBe('north-east');
    expect(compassName(deg(90 + 360))).toBe('north');
    expect(compassName(deg(90 - 720))).toBe('north');
    expect(compassName(deg(-270))).toBe('north');
  });
});

describe('directions on the screen', () => {
  it('with the camera looking north, north is up and east is to the right', () => {
    expect(screenAngle(0, 0, 1)).toBeCloseTo(0, 9); // north: up
    expect(screenAngle(0, 1, 0)).toBeCloseTo(deg(90), 9); // east: right
    expect(Math.abs(screenAngle(0, 0, -1))).toBeCloseTo(deg(180), 9); // south: down
    expect(screenAngle(0, -1, 0)).toBeCloseTo(deg(-90), 9); // west: left
  });

  it('turns with the camera', () => {
    // at a yaw of a quarter turn the camera looks west, so west is up and north is to the right
    expect(screenAngle(deg(90), -1, 0)).toBeCloseTo(0, 9);
    expect(screenAngle(deg(90), 0, 1)).toBeCloseTo(deg(90), 9);
    // at a half turn it looks south, so south is up and north is down
    expect(screenAngle(deg(180), 0, -1)).toBeCloseTo(0, 9);
    expect(Math.abs(screenAngle(deg(180), 0, 1))).toBeCloseTo(deg(180), 9);
  });

  it('does not depend on how long the direction is', () => {
    expect(screenAngle(0.4, 3, 4)).toBeCloseTo(screenAngle(0.4, 300, 400), 9);
  });

  it('puts a diagonal halfway between', () => {
    expect(screenAngle(0, 1, 1)).toBeCloseTo(deg(45), 9);
    expect(screenAngle(0, -1, 1)).toBeCloseTo(deg(-45), 9);
  });
});

describe('offsets on the screen', () => {
  it('maps a city offset to [right, up] metres', () => {
    // looking north: 10 m north is 10 m up, 5 m east is 5 m right
    const [r, u] = screenOffset(0, 5, 10);
    expect(r).toBeCloseTo(5, 9);
    expect(u).toBeCloseTo(10, 9);
    // looking west (a quarter turn): west is up, north is right
    const [r2, u2] = screenOffset(deg(90), -7, 3);
    expect(u2).toBeCloseTo(7, 9);
    expect(r2).toBeCloseTo(3, 9);
  });

  it('keeps distances, whatever the camera', () => {
    for (const yaw of [0, 0.7, 2.1, -1.3, 4]) {
      const [r, u] = screenOffset(yaw, 30, -40);
      expect(Math.hypot(r, u)).toBeCloseTo(50, 9);
    }
  });

  it('agrees with the angle', () => {
    const [r, u] = screenOffset(0.9, 12, 5);
    expect(Math.atan2(r, u)).toBeCloseTo(screenAngle(0.9, 12, 5), 12);
  });
});
