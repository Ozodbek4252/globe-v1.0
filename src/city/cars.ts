// Drawing the cars. A few dozen low-poly cars (a body with a cabin, four wheels, two headlamps) as
// three instanced meshes, so the lot costs three draw calls. The car being driven follows the
// survivor's smoothed position; the rest stand where the game put them.

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
import { CAR, type Car } from '../sim/vehicle';

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
const PAINTS = [
  new Color(0xd8d6d0), // white
  new Color(0x8e9196), // silver
  new Color(0x2a2d33), // black
  new Color(0x9a2f2a), // red
  new Color(0x2f4e7a), // blue
  new Color(0x3d5a3a), // green
  new Color(0xc9b48a), // beige
  new Color(0xd4a62a), // yellow
  new Color(0xd8d6d0), // white again: the commonest
  new Color(0x6b4e3a), // brown
];
const LAMP_ON = new Color(1.6, 1.5, 1.2);
const LAMP_OFF = new Color(0.55, 0.55, 0.5);

function buildBody(): BufferGeometry {
  const L = CAR.length;
  const W = CAR.width;
  const lower = new BoxGeometry(L, 0.62, W);
  lower.translate(0, 0.58, 0);
  const cabin = new BoxGeometry(L * 0.46, 0.55, W * 0.88);
  cabin.translate(-L * 0.06, 1.15, 0);
  const merged = mergeGeometries([lower, cabin]);
  lower.dispose();
  cabin.dispose();
  return merged;
}

/** The wheels, and the glass of the cabin (the same dark material), as one piece. */
function buildWheels(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const wheel = new CylinderGeometry(0.33, 0.33, 0.24, 7); // thousands of them: few sides
      wheel.rotateX(Math.PI / 2);
      wheel.translate(sx * CAR.length * 0.31, 0.33, sz * (CAR.width / 2 + 0.02));
      parts.push(wheel);
    }
  }
  const glass = new BoxGeometry(CAR.length * 0.46 + 0.04, 0.26, CAR.width * 0.88 + 0.04);
  glass.translate(-CAR.length * 0.06, 1.22, 0);
  parts.push(glass);
  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return merged;
}

function buildLamps(): BufferGeometry {
  const parts: BufferGeometry[] = [];
  for (const sz of [-1, 1]) {
    const lamp = new BoxGeometry(0.1, 0.18, 0.34);
    lamp.translate(CAR.length / 2 + 0.02, 0.7, sz * (CAR.width / 2 - 0.3));
    parts.push(lamp);
  }
  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  return merged;
}

export function createCarRenderer(max: number): CarRenderer {
  const bodyGeometry = buildBody();
  const wheelGeometry = buildWheels();
  const lampGeometry = buildLamps();
  const paint = new MeshStandardMaterial({ roughness: 0.45, metalness: 0.35, flatShading: true });
  const rubber = new MeshStandardMaterial({ color: 0x1b1b1d, roughness: 0.95, flatShading: true });
  const glass = new MeshBasicMaterial({ toneMapped: false });

  const bodies = new InstancedMesh(bodyGeometry, paint, max);
  const wheels = new InstancedMesh(wheelGeometry, rubber, max);
  const lamps = new InstancedMesh(lampGeometry, glass, max);
  for (const m of [bodies, wheels, lamps]) {
    m.instanceMatrix.setUsage(DynamicDrawUsage);
    m.frustumCulled = false;
    m.count = 0;
  }
  bodies.setColorAt(0, PAINTS[0]);
  lamps.setColorAt(0, LAMP_OFF);
  bodies.castShadow = true;
  bodies.receiveShadow = true;
  wheels.castShadow = true;

  const object = new Object3D();
  object.add(bodies, wheels, lamps);
  const dummy = new Object3D();

  // Thousands of cars stand still: their matrices are written once, when the list changes (a new
  // window, a car summoned), and each frame only the car being driven (and the one just left) is placed.
  let lastCars: readonly Car[] | null = null;
  let lastCount = -1;
  let lastDriving = -1;
  const place = (i: number, px: number, py: number, heading: number, lamp: Color): void => {
    // city (x, y) is Three.js (x, -y); the model points down +X, so the heading is the turn about Y
    dummy.position.set(px, 0, -py);
    dummy.rotation.set(0, heading, 0);
    dummy.updateMatrix();
    bodies.setMatrixAt(i, dummy.matrix);
    wheels.setMatrixAt(i, dummy.matrix);
    lamps.setMatrixAt(i, dummy.matrix);
    bodies.setColorAt(i, PAINTS[i % PAINTS.length]);
    lamps.setColorAt(i, lamp);
  };
  const flush = (): void => {
    bodies.instanceMatrix.needsUpdate = true;
    wheels.instanceMatrix.needsUpdate = true;
    lamps.instanceMatrix.needsUpdate = true;
    if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
    if (lamps.instanceColor) lamps.instanceColor.needsUpdate = true;
  };

  return {
    object,
    update(cars, driving, x, y, heading, lit) {
      const n = Math.min(max, cars.length);
      if (cars !== lastCars || n !== lastCount) {
        for (let i = 0; i < n; i++) place(i, cars[i].x, cars[i].y, cars[i].heading, LAMP_OFF);
        bodies.count = wheels.count = lamps.count = n;
        lastCars = cars;
        lastCount = n;
        lastDriving = -1;
      } else if (lastDriving >= 0 && lastDriving !== driving && lastDriving < n) {
        // just got out: that car stands where the game left it
        const c = cars[lastDriving];
        place(lastDriving, c.x, c.y, c.heading, LAMP_OFF);
      }
      if (driving >= 0 && driving < n) {
        place(driving, x, y, heading, lit ? LAMP_ON : LAMP_OFF);
      }
      lastDriving = driving;
      flush();
    },
    dispose() {
      bodyGeometry.dispose();
      wheelGeometry.dispose();
      lampGeometry.dispose();
      paint.dispose();
      rubber.dispose();
      glass.dispose();
      bodies.dispose();
      wheels.dispose();
      lamps.dispose();
    },
  };
}
