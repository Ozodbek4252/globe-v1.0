// Drawing the cars. Thousands of low-poly cars (a body with a cabin, four wheels, two headlamps), one
// shape for each kind of car, as three instanced meshes per kind, so the lot costs a few draw calls.
// The car being driven follows the survivor's smoothed position; the rest stand where the game put them.

import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  InstancedMesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  type BufferGeometry,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { KIND, KINDS, wrecked, type Car, type CarKind } from '../sim/vehicle';

export interface CarRenderer {
  object: Object3D;
  /**
   * Place every car. `driving` is the index of the car the survivor is in (or -1), drawn at
   * (x, y, heading) instead of where the game has it (the smoothed position between steps);
   * `lit` lights its headlamps.
   */
  update(
    cars: readonly Car[],
    driving: number,
    x: number,
    y: number,
    heading: number,
    lit: boolean,
  ): void;
  dispose(): void;
}

/** Paints, picked per car. Dull enough not to glare under the flashlight. */
const WHITE = new Color(0xd8d6d0);
const SILVER = new Color(0x8e9196);
const BLACK = new Color(0x2a2d33);
const RED = new Color(0x9a2f2a);
const BLUE = new Color(0x2f4e7a);
const GREEN = new Color(0x3d5a3a);
const BEIGE = new Color(0xc9b48a);
const YELLOW = new Color(0xd4a62a);
const BROWN = new Color(0x6b4e3a);
const ORANGE = new Color(0xc8641e);
const EVERYDAY = [WHITE, SILVER, BLACK, RED, BLUE, GREEN, BEIGE, YELLOW, WHITE, BROWN];
/** What each kind is painted, by `KIND`: vans white and plain, sports cars loud, police cars white. */
const PAINTS: readonly (readonly Color[])[] = [
  EVERYDAY,
  EVERYDAY,
  [WHITE, SILVER, WHITE, BLUE, BEIGE, WHITE],
  [WHITE, RED, BLUE, BROWN, BLACK, SILVER],
  [RED, YELLOW, ORANGE, BLACK, WHITE, BLUE, RED],
  [WHITE],
];
const WRECK = new Color(0x3a3634);
const LAMP_ON = new Color(1.6, 1.5, 1.2);
const LAMP_OFF = new Color(0.55, 0.55, 0.5);

/** The lines of a kind of car: how tall the body is, and where its cabin sits. */
interface Lines {
  bodyH: number;
  cabinL: number;
  cabinH: number;
  /** The cabin's centre along the car (forward positive) as a share of the length, and its width as a share. */
  cabinX: number;
  cabinW: number;
  wheel: number;
}

function linesOf(k: number): Lines {
  switch (k) {
    case KIND.HATCHBACK:
      return { bodyH: 0.6, cabinL: 0.55, cabinH: 0.6, cabinX: -0.1, cabinW: 0.88, wheel: 0.31 };
    case KIND.VAN:
      return { bodyH: 0.7, cabinL: 0.78, cabinH: 0.95, cabinX: -0.08, cabinW: 0.94, wheel: 0.37 };
    case KIND.PICKUP:
      return { bodyH: 0.66, cabinL: 0.3, cabinH: 0.62, cabinX: 0.14, cabinW: 0.9, wheel: 0.38 };
    case KIND.SPORTS:
      return { bodyH: 0.48, cabinL: 0.4, cabinH: 0.4, cabinX: -0.1, cabinW: 0.8, wheel: 0.32 };
    case KIND.POLICE:
      return { bodyH: 0.6, cabinL: 0.46, cabinH: 0.55, cabinX: -0.06, cabinW: 0.88, wheel: 0.33 };
    default:
      return { bodyH: 0.62, cabinL: 0.46, cabinH: 0.55, cabinX: -0.06, cabinW: 0.88, wheel: 0.33 };
  }
}

const merge = (parts: BufferGeometry[]): BufferGeometry => {
  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return merged;
};

function buildBody(k: number, kind: CarKind, s: Lines): BufferGeometry {
  const L = kind.length;
  const W = kind.width;
  const bodyY = 0.27 + s.bodyH / 2; // the body sits on the wheels
  const top = bodyY + s.bodyH / 2;
  const parts: BufferGeometry[] = [];
  const lower = new BoxGeometry(L, s.bodyH, W);
  lower.translate(0, bodyY, 0);
  parts.push(lower);
  const cabin = new BoxGeometry(L * s.cabinL, s.cabinH, W * s.cabinW);
  cabin.translate(L * s.cabinX, top + s.cabinH / 2, 0);
  parts.push(cabin);
  if (k === KIND.PICKUP) {
    // the bed: two low sides and a tailgate behind the cab
    for (const sz of [-1, 1]) {
      const side = new BoxGeometry(L * 0.44, 0.28, 0.08);
      side.translate(-L * 0.27, top + 0.14, sz * (W / 2 - 0.04));
      parts.push(side);
    }
    const gate = new BoxGeometry(0.08, 0.28, W - 0.1);
    gate.translate(-L / 2 + 0.04, top + 0.14, 0);
    parts.push(gate);
  }
  if (k === KIND.SPORTS) {
    const wing = new BoxGeometry(0.26, 0.06, W * 0.82);
    wing.translate(-L / 2 + 0.22, top + 0.3, 0);
    parts.push(wing);
  }
  return merge(parts);
}

/** The wheels, and the glass of the cabin (the same dark material), as one piece. */
function buildWheels(kind: CarKind, s: Lines): BufferGeometry {
  const L = kind.length;
  const W = kind.width;
  const parts: BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const wheel = new CylinderGeometry(s.wheel, s.wheel, 0.24, 7); // thousands of them: few sides
      wheel.rotateX(Math.PI / 2);
      wheel.translate(sx * L * 0.31, s.wheel, sz * (W / 2 + 0.02));
      parts.push(wheel);
    }
  }
  const top = 0.27 + s.bodyH;
  const glassH = Math.min(0.4, s.cabinH * 0.5);
  const glass = new BoxGeometry(L * s.cabinL + 0.04, glassH, W * s.cabinW + 0.04);
  glass.translate(L * s.cabinX, top + s.cabinH * 0.62, 0);
  parts.push(glass);
  return merge(parts);
}

function buildLamps(k: number, kind: CarKind, s: Lines): BufferGeometry {
  const L = kind.length;
  const W = kind.width;
  const parts: BufferGeometry[] = [];
  for (const sz of [-1, 1]) {
    const lamp = new BoxGeometry(0.1, 0.18, 0.34);
    lamp.translate(L / 2 + 0.02, 0.27 + s.bodyH * 0.7, sz * (W / 2 - 0.3));
    parts.push(lamp);
  }
  if (k === KIND.POLICE) {
    const bar = new BoxGeometry(0.3, 0.12, W * 0.7);
    bar.translate(L * s.cabinX, 0.27 + s.bodyH + s.cabinH + 0.06, 0);
    parts.push(bar);
  }
  return merge(parts);
}

/** The three meshes of one kind, and room for how many. */
interface KindSet {
  bodies: InstancedMesh;
  wheels: InstancedMesh;
  lamps: InstancedMesh;
  geometries: BufferGeometry[];
  cap: number;
}

export function createCarRenderer(max: number): CarRenderer {
  const paint = new MeshStandardMaterial({ roughness: 0.45, metalness: 0.35, flatShading: true });
  const rubber = new MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.95, flatShading: true });
  const glass = new MeshBasicMaterial({ toneMapped: false });
  const object = new Object3D();

  // Room for each kind by its share of the street, with a wide margin: a kind over its room is not
  // drawn, which the shares make a rare thing.
  const sets: KindSet[] = KINDS.map((kind, k) => {
    const s = linesOf(k);
    const cap = Math.ceil(max * Math.min(1, kind.share * 2.5)) + 32;
    const geometries = [buildBody(k, kind, s), buildWheels(kind, s), buildLamps(k, kind, s)];
    const bodies = new InstancedMesh(geometries[0], paint, cap);
    const wheels = new InstancedMesh(geometries[1], rubber, cap);
    const lamps = new InstancedMesh(geometries[2], glass, cap);
    for (const m of [bodies, wheels, lamps]) {
      m.instanceMatrix.setUsage(DynamicDrawUsage);
      m.frustumCulled = false;
      m.count = 0;
    }
    bodies.setColorAt(0, PAINTS[k][0]);
    lamps.setColorAt(0, LAMP_OFF);
    bodies.castShadow = true;
    bodies.receiveShadow = true;
    wheels.castShadow = true;
    object.add(bodies, wheels, lamps);
    return { bodies, wheels, lamps, geometries, cap };
  });
  const dummy = new Object3D();
  const kindIndex = (car: Car): number => (KINDS[car.kind] ? car.kind : KIND.SEDAN);

  // Thousands of cars stand still: their matrices are written once, when the list changes (a new
  // window, a car summoned), and each frame only the car being driven (and the one just left) is placed.
  let lastCars: readonly Car[] | null = null;
  let lastCount = -1;
  let lastDriving = -1;
  /** Each car's slot in its kind's meshes (-1 when there was no room). */
  let slotOf = new Int32Array(0);
  const counts = new Int32Array(KINDS.length);
  const place = (
    i: number,
    car: Car,
    px: number,
    py: number,
    heading: number,
    lamp: Color,
  ): void => {
    const slot = slotOf[i];
    if (slot < 0) return;
    const k = kindIndex(car);
    const set = sets[k];
    // city (x, y) is Three.js (x, -y); the model points down +X, so the heading is the turn about Y
    dummy.position.set(px, 0, -py);
    dummy.rotation.set(0, heading, 0);
    dummy.updateMatrix();
    set.bodies.setMatrixAt(slot, dummy.matrix);
    set.wheels.setMatrixAt(slot, dummy.matrix);
    set.lamps.setMatrixAt(slot, dummy.matrix);
    const paints = PAINTS[k];
    set.bodies.setColorAt(slot, wrecked(car) ? WRECK : paints[slot % paints.length]);
    set.lamps.setColorAt(slot, lamp);
  };
  const flush = (): void => {
    for (const set of sets) {
      set.bodies.instanceMatrix.needsUpdate = true;
      set.wheels.instanceMatrix.needsUpdate = true;
      set.lamps.instanceMatrix.needsUpdate = true;
      if (set.bodies.instanceColor) set.bodies.instanceColor.needsUpdate = true;
      if (set.lamps.instanceColor) set.lamps.instanceColor.needsUpdate = true;
    }
  };

  return {
    object,
    update(cars, driving, x, y, heading, lit) {
      const n = Math.min(max, cars.length);
      if (cars !== lastCars || n !== lastCount) {
        counts.fill(0);
        slotOf = new Int32Array(n);
        for (let i = 0; i < n; i++) {
          const k = kindIndex(cars[i]);
          if (counts[k] >= sets[k].cap) {
            slotOf[i] = -1;
            continue;
          }
          slotOf[i] = counts[k]++;
          place(i, cars[i], cars[i].x, cars[i].y, cars[i].heading, LAMP_OFF);
        }
        sets.forEach((set, k) => {
          set.bodies.count = set.wheels.count = set.lamps.count = counts[k];
        });
        lastCars = cars;
        lastCount = n;
        lastDriving = -1;
      } else if (lastDriving >= 0 && lastDriving !== driving && lastDriving < n) {
        // just got out: that car stands where the game left it
        const c = cars[lastDriving];
        place(lastDriving, c, c.x, c.y, c.heading, LAMP_OFF);
      }
      if (driving >= 0 && driving < n) {
        const c = cars[driving];
        place(driving, c, x, y, heading, lit && !wrecked(c) ? LAMP_ON : LAMP_OFF);
      }
      lastDriving = driving;
      flush();
    },
    dispose() {
      for (const set of sets) {
        for (const g of set.geometries) g.dispose();
        set.bodies.dispose();
        set.wheels.dispose();
        set.lamps.dispose();
      }
      paint.dispose();
      rubber.dispose();
      glass.dispose();
    },
  };
}
