// Cars: found parked along the city's roads, and driven. Pure functions on plain data, like the rest of
// the simulation: no DOM, no Three.js, no clocks. City space: x east, y north, metres and seconds.
//
// A car is a circle for collisions (a compromise for a body twice as long as it is wide, but a body
// that slides along walls and never crosses one, with the same `moveCircle` everyone else uses). It
// steers like a car: the heading turns with speed, so it cannot spin on the spot, and it is much
// faster on a road than off one. Hitting a wall costs speed, and the car some of its condition; a hard
// crash hurts the driver. Zombies in the way are run over. The engine is loud, and the tank is finite.
// Cars come in kinds (`KINDS`): a hatchback, a sedan, a van, a pickup, a sports car and a police car,
// each with its own speed, pull, toughness, tank, weight and noise; the street is mostly the first two.

import { moveCircleLong, type Colliders } from './colliders';
import { OCC_BRIDGE, OCC_ROAD, occupancyAt } from './grid';
import { nextFloat, nextRange, type Rng } from '../lib/rng';
import { validSpot, type GameWorld } from './world';

/**
 * A kind of car: what is found in the street, and what it can do. The shares are how the parked cars
 * are divided among them (they add up to one).
 */
export interface CarKind {
  name: string;
  share: number;
  /** The body drawn, and the collision circle. */
  length: number;
  width: number;
  radius: number;
  /** Top speed on a road and off it (m/s), and how fast speed builds with the pedal down (m/s²). */
  topRoad: number;
  topOff: number;
  accel: number;
  /** Condition when found; and how long a full tank lasts flat out (seconds). */
  hp: number;
  tankSeconds: number;
  /** Weight against a sedan's: a heavier car hits harder and is worn less by what it hits. */
  mass: number;
  /** How far the engine is heard flat out. */
  noiseTop: number;
}

export const KIND = { HATCHBACK: 0, SEDAN: 1, VAN: 2, PICKUP: 3, SPORTS: 4, POLICE: 5 } as const;

/** The kinds, by `KIND`. The sedan is the measure the rest are set against. */
export const KINDS: readonly CarKind[] = [
  {
    name: 'Hatchback',
    share: 0.34,
    length: 3.8,
    width: 1.68,
    radius: 1.0,
    topRoad: 20,
    topOff: 8,
    accel: 6.5,
    hp: 90,
    tankSeconds: 380,
    mass: 0.85,
    noiseTop: 52,
  },
  {
    name: 'Sedan',
    share: 0.3,
    length: 4.5,
    width: 1.8,
    radius: 1.1,
    topRoad: 22,
    topOff: 8,
    accel: 7.5,
    hp: 100,
    tankSeconds: 420,
    mass: 1,
    noiseTop: 60,
  },
  {
    name: 'Van',
    share: 0.14,
    length: 5.2,
    width: 2.0,
    radius: 1.3,
    topRoad: 18,
    topOff: 7,
    accel: 5,
    hp: 170,
    tankSeconds: 520,
    mass: 1.6,
    noiseTop: 66,
  },
  {
    name: 'Pickup',
    share: 0.14,
    length: 5.0,
    width: 1.9,
    radius: 1.25,
    topRoad: 21,
    topOff: 13,
    accel: 6.5,
    hp: 150,
    tankSeconds: 480,
    mass: 1.4,
    noiseTop: 64,
  },
  {
    name: 'Sports car',
    share: 0.05,
    length: 4.3,
    width: 1.85,
    radius: 1.1,
    topRoad: 42,
    topOff: 6,
    accel: 14,
    hp: 70,
    tankSeconds: 300,
    mass: 0.9,
    noiseTop: 80,
  },
  {
    name: 'Police car',
    share: 0.03,
    length: 4.8,
    width: 1.85,
    radius: 1.15,
    topRoad: 33,
    topOff: 9,
    accel: 10,
    hp: 110,
    tankSeconds: 450,
    mass: 1.05,
    noiseTop: 70,
  },
];

/** The kind of a car (a car from an older save, or one with a kind this build does not know, is a sedan). */
export function kindOf(car: Pick<Car, 'kind'>): CarKind {
  return KINDS[car.kind] ?? KINDS[KIND.SEDAN];
}

/** A kind of car drawn by the shares: what the next parked car is. */
export function drawKind(rng: Rng): number {
  let r = nextFloat(rng);
  for (let k = 0; k < KINDS.length; k++) {
    r -= KINDS[k].share;
    if (r < 0) return k;
  }
  return KIND.SEDAN;
}

/** Tuning common to every kind, in metres and seconds; what differs is in `KINDS`. */
export const CAR = {
  /** The collision circle and body of the measure (a sedan), where one size has to do for all. */
  radius: 1.1,
  length: 4.2,
  width: 1.8,
  /** Backing up. */
  reverse: 5,
  /** How fast the brakes take speed, and how it bleeds off coasting (m/s²), with more off the road. */
  brake: 16,
  coast: 2,
  offRoadDrag: 5,
  /** Steering: the yaw rate is speed / wheelbase * tan(steer), as for a real car... */
  wheelbase: 2.6,
  maxSteer: 0.6,
  /** ...but above this speed the wheel turns less for the same press, or a fast car would spin. */
  steerEase: 14,
  /** Tank, 0 to 1: cars are found part full. */
  fuelFound: [0.25, 0.9] as const,
  /** Condition 0 to 100 (the sedan's; each kind has its own): at zero the car is wrecked. */
  hp: 100,
  /** A collision that takes more than this off the speed (m/s) counts as a crash... */
  crashSpeed: 3,
  /** ...and costs this much condition per m/s lost beyond it; beyond `hurtSpeed` the driver is hurt too. */
  crashWear: 1.2,
  hurtSpeed: 9,
  crashHurt: 2.5,
  crashNoise: 45,
  /** Running someone over: slower than this just pushes them; faster, damage per m/s of speed (a walker dies at ~5.5 m/s). */
  hitSpeed: 2.5,
  hitDamage: 18,
  hitShove: 0.7,
  hitStun: 1.2,
  /** What each body struck costs the car: speed (m/s) and condition (a car takes a few hundred). */
  hitSlow: 0.5,
  hitWear: 0.35,
  /** Inside, this share of a zombie's blow lands on the car instead of you (none once it is wrecked)... */
  shield: 0.8,
  /** ...and only this much of what lands on the car wears it (zombies pound a long time before it gives). */
  blowWear: 0.15,
  /** How far the engine is heard idling (flat out is the kind's), and how often the noise is made. */
  noiseIdle: 12,
  noiseEvery: 0.4,
  /** How near the survivor must be to a car's edge to get in. */
  reach: 2.4,
  /** Parking: roads at least this wide carry cars, this far apart, up to this many per window. */
  parkWidth: 3.5,
  /** Kerbside parking: a slot every `parkSlot` metres along each kerb, about `parkFill` of them taken, never two cars closer than `parkApart`. */
  parkSlot: 7,
  parkFill: 0.6,
  parkApart: 5.5,
  /** Roads this wide have cars along both kerbs; narrower ones along one. */
  parkBothFrom: 7,
  parkMost: 12000 as number,
} as const;

export interface Car {
  x: number;
  y: number;
  /** Radians, counter-clockwise from east: the way the bonnet points. */
  heading: number;
  /** Metres per second along the heading; negative backing up. */
  speed: number;
  /** 0 to 1. */
  fuel: number;
  /** 0 to 100: at zero it is wrecked and will not go. */
  hp: number;
  /** Which of `KINDS` it is. */
  kind: number;
}

/** What the survivor asks of the car: a direction to go in (city space, any length, capped at 1). */
export interface DriveInput {
  /** The pedal: 1 flat out forward, -1 the brake (and, once stopped, reverse), 0 coasting. */
  throttle: number;
  /** The wheel: 1 full left, -1 full right. */
  steer: number;
}

/** What happened in a step of driving: the game turns it into damage, noise and events. */
export interface DriveResult {
  /** Speed lost to walls this step, m/s (0 when nothing was hit). */
  crash: number;
  /** Whether the car was moving under power. */
  running: boolean;
}

export function createCar(
  x: number,
  y: number,
  heading: number,
  fuel = 1,
  kind: number = KIND.SEDAN,
  hp = kindOf({ kind }).hp,
): Car {
  return { x, y, heading, speed: 0, fuel, hp, kind };
}

export function wrecked(car: Car): boolean {
  return car.hp <= 0;
}

/** Whether a point is on a road (or a bridge): the car is in its element here. */
export function onRoad(colliders: Colliders, x: number, y: number): boolean {
  return (occupancyAt(colliders.field, x, y) & (OCC_ROAD | OCC_BRIDGE)) !== 0;
}

/**
 * Drive the car by `dt` seconds (keep it small, ideally 1/60), in place: the pedal and the wheel as
 * in any driving game. The brake pressed on a standing car backs it up. Returns what the walls did.
 */
export function stepCar(
  car: Car,
  input: DriveInput,
  colliders: Colliders,
  dt: number,
): DriveResult {
  const clamp1 = (v: number): number => Math.max(-1, Math.min(1, v));
  const able = !wrecked(car) && car.fuel > 0;
  // the pedal and the wheel: a wrecked or empty car answers to neither
  const throttle = able && Math.abs(input.throttle) > 0.05 ? clamp1(input.throttle) : 0;
  const steer = Math.abs(input.steer) > 0.05 ? clamp1(input.steer) : 0;
  const pressing = throttle !== 0;
  const kind = kindOf(car);
  const road = onRoad(colliders, car.x, car.y);
  const top = road ? kind.topRoad : kind.topOff;

  // speed: the pedal asks for a share of the top speed here, and the car works toward it
  let v = car.speed;
  const drag = CAR.coast + (road ? 0 : CAR.offRoadDrag);
  if (throttle > 0) {
    const target = top * throttle;
    if (v < -0.1)
      v = Math.min(0, v + CAR.brake * dt); // rolling back: brake first
    else if (v < target) v = Math.min(target, v + kind.accel * dt);
    // over what the pedal asks for (easing off, or leaving the road at speed): bleed it off
    else v = Math.max(target, v - (v > top ? CAR.brake * 0.6 : drag) * dt);
  } else if (throttle < 0) {
    if (v > 0.1) v = Math.max(0, v - CAR.brake * dt);
    else v = Math.max(-CAR.reverse, v - kind.accel * 0.7 * dt);
  } else {
    // coasting: rolling resistance, a lot of it off the road
    const slowBy = drag * dt;
    v = Math.abs(v) <= slowBy ? 0 : v - Math.sign(v) * slowBy;
  }

  // the heading turns with the wheels: at a standstill it does not turn at all, and at speed the
  // wheel is gentler, so a fast car holds the road
  const ease = Math.min(1, CAR.steerEase / Math.max(CAR.steerEase, Math.abs(v)));
  const yaw = (v / CAR.wheelbase) * Math.tan(CAR.maxSteer * steer * ease) * dt;
  const heading = car.heading + yaw;

  // move, sliding along walls; what the walls take off the move they take off the speed
  const dx = Math.cos(heading) * v * dt;
  const dy = Math.sin(heading) * v * dt;
  const [x, y] = moveCircleLong(colliders, car.x, car.y, car.x + dx, car.y + dy, kind.radius);
  let crash = 0;
  const meant = Math.hypot(dx, dy);
  if (meant > 1e-6) {
    const got = Math.hypot(x - car.x, y - car.y);
    const kept = Math.max(0, Math.min(1, got / meant));
    if (kept < 0.999) {
      crash = Math.abs(v) * (1 - kept);
      v *= kept;
    }
  }

  // fuel goes with the engine's work
  if (pressing)
    car.fuel = Math.max(0, car.fuel - ((0.2 + 0.8 * Math.abs(throttle)) * dt) / kind.tankSeconds);
  car.x = x;
  car.y = y;
  car.heading = heading;
  car.speed = v;
  return { crash, running: pressing };
}

/** The car's velocity, for whoever rides in it. */
export function carVelocity(car: Car): [number, number] {
  return [Math.cos(car.heading) * car.speed, Math.sin(car.heading) * car.speed];
}

/** How far the engine is heard now. */
export function engineNoise(car: Car): number {
  const kind = kindOf(car);
  const share = Math.min(1, Math.abs(car.speed) / kind.topRoad);
  return CAR.noiseIdle + (kind.noiseTop - CAR.noiseIdle) * share;
}

/** The car nearest (x, y) that is near enough to get into, or -1. */
export function carInReach(cars: readonly Car[], x: number, y: number): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < cars.length; i++) {
    const d = Math.hypot(cars[i].x - x, cars[i].y - y) - kindOf(cars[i]).radius;
    if (d <= CAR.reach && d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Somewhere to stand on getting out: beside the car, on open ground, or else where the car is. */
export function stepOutSpot(car: Car, world: GameWorld, radius: number): [number, number] {
  const kind = kindOf(car);
  const side = kind.width / 2 + radius + 0.3;
  const back = kind.length / 2 + radius + 0.3;
  const c = Math.cos(car.heading);
  const s = Math.sin(car.heading);
  const tries: [number, number][] = [
    [-s * side, c * side], // left door
    [s * side, -c * side], // right door
    [-c * back, -s * back], // behind
    [c * back, s * back], // in front
  ];
  for (const [ox, oy] of tries) {
    const x = car.x + ox;
    const y = car.y + oy;
    if (validSpot(world, x, y, radius)) return [x, y];
  }
  return [car.x, car.y];
}

/**
 * Cars parked along the map's roads, as in a city: along the kerbs of every road wide enough (both
 * kerbs of a wide one), about every other slot, pointing along the kerb they are on, with room to stand
 * round them, never on top of each other, and never more than `most`. Seeded, so the same map and seed
 * give the same cars. `keepOff` marks ground not to park on (the part of a bigger city already seen,
 * when a window moves).
 */
export function parkCars(
  world: GameWorld,
  rng: Rng,
  most = CAR.parkMost,
  keepOff?: (x: number, y: number) => boolean,
): Car[] {
  const cars: Car[] = [];
  const half = world.colliders.half;
  // cars already parked, by cell of `parkApart` metres, so "is anything too near?" looks at nine cells
  const cell = CAR.parkApart;
  const apart2 = cell * cell;
  const taken = new Map<number, Car[]>();
  const keyOf = (x: number, y: number): number =>
    Math.floor((x + half) / cell) * 65536 + Math.floor((y + half) / cell);
  const spaced = (x: number, y: number): boolean => {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const near = taken.get(keyOf(x + dx * cell, y + dy * cell));
        if (!near) continue;
        for (const c of near) if ((c.x - x) ** 2 + (c.y - y) ** 2 < apart2) return false;
      }
    }
    return true;
  };
  const roads = world.roads.filter((r) => r.width >= CAR.parkWidth && r.points.length >= 4);
  // a slot every `parkSlot` metres along each kerb (both kerbs of a wide road), about half of them
  // taken, in a seeded order, so no part of the map is favoured
  const spots: [number, number, number][] = [];
  for (const r of roads) {
    const offset = Math.max(0, r.width / 2 - 1.5); // a lane in from the edge, or the middle of a narrow road
    const sides = r.width >= CAR.parkBothFrom ? [1, -1] : [1];
    let along = nextFloat(rng) * CAR.parkSlot; // start at a random point on the first stretch
    for (let i = 0; i + 3 < r.points.length; i += 2) {
      const ax = r.points[i];
      const ay = r.points[i + 1];
      const bx = r.points[i + 2];
      const by = r.points[i + 3];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1e-3) continue;
      const ux = (bx - ax) / len;
      const uy = (by - ay) / len;
      const heading = Math.atan2(uy, ux);
      while (along < len) {
        for (const side of sides) {
          if (nextFloat(rng) >= CAR.parkFill) continue; // an empty slot
          // the right-hand kerb of this way, or the left one (a car there faces the other way)
          const x = ax + ux * along + uy * offset * side;
          const y = ay + uy * along - ux * offset * side;
          spots.push([x, y, side > 0 ? heading : heading + Math.PI]);
        }
        along += CAR.parkSlot;
      }
      along -= len;
    }
  }
  // shuffle (seeded), then take what fits
  for (let i = spots.length - 1; i > 0; i--) {
    const j = Math.floor(nextFloat(rng) * (i + 1));
    const t = spots[i];
    spots[i] = spots[j];
    spots[j] = t;
  }
  for (const [x, y, heading] of spots) {
    if (cars.length >= most) break;
    if (Math.abs(x) > half - 12 || Math.abs(y) > half - 12) continue;
    if (keepOff?.(x, y)) continue;
    const kind = drawKind(rng);
    if (!spaced(x, y) || !validSpot(world, x, y, KINDS[kind].radius + 0.4)) continue;
    const car = createCar(x, y, heading, nextRange(rng, CAR.fuelFound[0], CAR.fuelFound[1]), kind);
    cars.push(car);
    const k = keyOf(x, y);
    const bucket = taken.get(k);
    if (bucket) bucket.push(car);
    else taken.set(k, [car]);
  }
  return cars;
}
