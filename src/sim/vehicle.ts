// Cars: found parked along the city's roads, and driven. Pure functions on plain data, like the rest of
// the simulation: no DOM, no Three.js, no clocks. City space: x east, y north, metres and seconds.
//
// A car is a circle for collisions (a compromise for a body twice as long as it is wide, but a body
// that slides along walls and never crosses one, with the same `moveCircle` everyone else uses). It
// steers like a car: the heading turns with speed, so it cannot spin on the spot, and it is much
// faster on a road than off one. Hitting a wall costs speed, and the car some of its condition; a hard
// crash hurts the driver. Zombies in the way are run over. The engine is loud, and the tank is finite.

import { moveCircleLong, type Colliders } from './colliders';
import { OCC_BRIDGE, OCC_ROAD, occupancyAt } from './grid';
import { angleDelta } from './player';
import { nextFloat, nextRange, type Rng } from '../lib/rng';
import { validSpot, type GameWorld } from './world';

/** Tuning, in metres and seconds. */
export const CAR = {
  /** Collision circle. The body drawn is about 4.2 by 1.8. */
  radius: 1.1,
  length: 4.2,
  width: 1.8,
  /** Top speed on a road (22 m/s is 79 km/h) and off it (kerbs, yards, grass), and backing up. */
  topRoad: 22,
  topOff: 8,
  reverse: 5,
  /** How speed builds with the pedal down, how fast the brakes take it, and how it bleeds off coasting (m/s²), with more off the road. */
  accel: 7.5,
  brake: 16,
  coast: 2,
  offRoadDrag: 5,
  /** Steering: the yaw rate is speed / wheelbase * tan(steer), as for a real car. */
  wheelbase: 2.6,
  maxSteer: 0.6,
  /** Steering sideways with no forward pressure still rolls the car on, at this share of the pedal. */
  crawl: 0.3,
  /** Tank, 0 to 1: full and flat out it lasts this many seconds. Cars are found part full. */
  tankSeconds: 420,
  fuelFound: [0.25, 0.9] as const,
  /** Condition 0 to 100: at zero the car is wrecked. */
  hp: 100,
  /** A collision that takes more than this off the speed (m/s) counts as a crash... */
  crashSpeed: 3,
  /** ...and costs this much condition per m/s lost beyond it; beyond `hurtSpeed` the driver is hurt too. */
  crashWear: 4,
  hurtSpeed: 9,
  crashHurt: 2.5,
  crashNoise: 45,
  /** Running someone over: slower than this just pushes them; faster, damage per m/s of speed (a walker dies at ~5.5 m/s). */
  hitSpeed: 2.5,
  hitDamage: 18,
  hitShove: 0.7,
  hitStun: 1.2,
  /** What each body struck costs the car: speed (m/s) and condition. */
  hitSlow: 0.5,
  hitWear: 1.5,
  /** Inside, this share of a zombie's blow lands on the car instead of you (none once it is wrecked). */
  shield: 0.8,
  /** How far the engine is heard, idling and flat out, and how often the noise is made. */
  noiseIdle: 12,
  noiseTop: 60,
  noiseEvery: 0.4,
  /** How near the survivor must be to a car's edge to get in. */
  reach: 2.4,
  /** Parking: roads at least this wide carry cars, this far apart, up to this many per window. */
  parkWidth: 5.5,
  parkGap: 110,
  parkMost: 60 as number,
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
}

/** What the survivor asks of the car: a direction to go in (city space, any length, capped at 1). */
export interface DriveInput {
  moveX: number;
  moveY: number;
}

/** What happened in a step of driving: the game turns it into damage, noise and events. */
export interface DriveResult {
  /** Speed lost to walls this step, m/s (0 when nothing was hit). */
  crash: number;
  /** Whether the car was moving under power. */
  running: boolean;
}

export function createCar(x: number, y: number, heading: number, fuel = 1, hp = CAR.hp): Car {
  return { x, y, heading, speed: 0, fuel, hp };
}

export function wrecked(car: Car): boolean {
  return car.hp <= 0;
}

/** Whether a point is on a road (or a bridge): the car is in its element here. */
export function onRoad(colliders: Colliders, x: number, y: number): boolean {
  return (occupancyAt(colliders.field, x, y) & (OCC_ROAD | OCC_BRIDGE)) !== 0;
}

/**
 * Drive the car by `dt` seconds (keep it small, ideally 1/60), in place. Steering is "go that way":
 * the car turns toward the direction asked for and rolls on; a direction behind it brakes, then backs
 * up. Returns what the walls did.
 */
export function stepCar(
  car: Car,
  input: DriveInput,
  colliders: Colliders,
  dt: number,
): DriveResult {
  const mag = Math.hypot(input.moveX, input.moveY);
  const pressing = mag > 0.05 && !wrecked(car) && car.fuel > 0;
  const road = onRoad(colliders, car.x, car.y);
  const top = road ? CAR.topRoad : CAR.topOff;

  // the pedal and the wheel, from where the survivor wants to go
  let throttle = 0; // -1 (backing up) to 1
  let steer = 0; // -1 (right) to 1 (left)
  if (pressing) {
    const want = Math.atan2(input.moveY, input.moveX);
    const ahead = angleDelta(car.heading, want); // how far round the wanted direction is
    const behind = Math.abs(ahead) > Math.PI * 0.68; // more than about 120 degrees round: back up
    const push = Math.min(1, mag);
    if (!behind) {
      throttle = push * Math.max(CAR.crawl, Math.cos(ahead));
      steer = Math.max(-1, Math.min(1, ahead * 2.5));
    } else {
      throttle = -push;
      // in reverse the back swings the other way, so turn the wheel against the wanted direction
      const back = angleDelta(car.heading, want + Math.PI);
      steer = -Math.max(-1, Math.min(1, back * 2.5));
    }
  }

  // speed: the pedal asks for a share of the top speed here, and the car works toward it
  let v = car.speed;
  const drag = CAR.coast + (road ? 0 : CAR.offRoadDrag);
  if (throttle > 0) {
    const target = top * throttle;
    if (v < -0.1)
      v = Math.min(0, v + CAR.brake * dt); // rolling back: brake first
    else if (v < target) v = Math.min(target, v + CAR.accel * dt);
    // over what the pedal asks for (easing off, or leaving the road at speed): bleed it off
    else v = Math.max(target, v - (v > top ? CAR.brake * 0.6 : drag) * dt);
  } else if (throttle < 0) {
    if (v > 0.1) v = Math.max(0, v - CAR.brake * dt);
    else v = Math.max(-CAR.reverse, v - CAR.accel * 0.7 * dt);
  } else {
    // coasting: rolling resistance, a lot of it off the road
    const slowBy = drag * dt;
    v = Math.abs(v) <= slowBy ? 0 : v - Math.sign(v) * slowBy;
  }

  // the heading turns with the wheels: at a standstill it does not turn at all
  const yaw = (v / CAR.wheelbase) * Math.tan(CAR.maxSteer * steer) * dt;
  const heading = car.heading + yaw;

  // move, sliding along walls; what the walls take off the move they take off the speed
  const dx = Math.cos(heading) * v * dt;
  const dy = Math.sin(heading) * v * dt;
  const [x, y] = moveCircleLong(colliders, car.x, car.y, car.x + dx, car.y + dy, CAR.radius);
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
    car.fuel = Math.max(0, car.fuel - ((0.2 + 0.8 * Math.abs(throttle)) * dt) / CAR.tankSeconds);
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
  const share = Math.min(1, Math.abs(car.speed) / CAR.topRoad);
  return CAR.noiseIdle + (CAR.noiseTop - CAR.noiseIdle) * share;
}

/** The car nearest (x, y) that is near enough to get into, or -1. */
export function carInReach(cars: readonly Car[], x: number, y: number): number {
  let best = -1;
  let bestD = CAR.radius + CAR.reach;
  for (let i = 0; i < cars.length; i++) {
    const d = Math.hypot(cars[i].x - x, cars[i].y - y);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** Somewhere to stand on getting out: beside the car, on open ground, or else where the car is. */
export function stepOutSpot(car: Car, world: GameWorld, radius: number): [number, number] {
  const side = CAR.width / 2 + radius + 0.3;
  const back = CAR.length / 2 + radius + 0.3;
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
 * Cars parked along the map's roads: every so often along each road wide enough, on its right-hand
 * side, pointing along it, with room to stand round them, far from each other, and never more than
 * `most`. Seeded, so the same map and seed give the same cars. `keepOff` marks ground not to park on
 * (the part of a bigger city already seen, when a window moves).
 */
export function parkCars(
  world: GameWorld,
  rng: Rng,
  most = CAR.parkMost,
  keepOff?: (x: number, y: number) => boolean,
): Car[] {
  const cars: Car[] = [];
  const half = world.colliders.half;
  const gap2 = CAR.parkGap * CAR.parkGap;
  const spaced = (x: number, y: number): boolean =>
    cars.every((c) => (c.x - x) ** 2 + (c.y - y) ** 2 >= gap2);
  const roads = world.roads.filter((r) => r.width >= CAR.parkWidth && r.points.length >= 4);
  // a spot about every `parkGap` metres of road, in a seeded order, so no part of the map is favoured
  const spots: [number, number, number][] = [];
  for (const r of roads) {
    let along = nextFloat(rng) * CAR.parkGap; // start at a random point on the first stretch
    for (let i = 0; i + 3 < r.points.length; i += 2) {
      const ax = r.points[i];
      const ay = r.points[i + 1];
      const bx = r.points[i + 2];
      const by = r.points[i + 3];
      const len = Math.hypot(bx - ax, by - ay);
      if (len < 1e-3) continue;
      const ux = (bx - ax) / len;
      const uy = (by - ay) / len;
      while (along < len) {
        // the right-hand verge: a lane in from the edge, or the middle of a narrow road
        const offset = Math.max(0, r.width / 2 - 1.5);
        const x = ax + ux * along + uy * offset;
        const y = ay + uy * along - ux * offset;
        spots.push([x, y, Math.atan2(uy, ux)]);
        along += CAR.parkGap;
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
    if (!spaced(x, y) || !validSpot(world, x, y, CAR.radius + 0.4)) continue;
    cars.push(createCar(x, y, heading, nextRange(rng, CAR.fuelFound[0], CAR.fuelFound[1])));
  }
  return cars;
}
