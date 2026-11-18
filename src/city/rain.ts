// Rain: a few thousand short streaks falling through a box that follows the camera's target, wrapping
// round as they leave it. How many are drawn follows the weather's intensity.

import { BufferAttribute, BufferGeometry, LineBasicMaterial, LineSegments } from 'three';

export interface Rain {
  object: LineSegments;
  /** Centre the box on (x, z) in Three.js space, let the drops fall by `dt`, and draw `intensity` of them (0 to 1). */
  update(x: number, z: number, dt: number, intensity: number): void;
  dispose(): void;
}

const BOX = 36; // half-width of the box, metres
const HEIGHT = 44;
const FALL = 15; // m/s
const DRIFT = 2.2; // sideways, m/s
const STREAK = 0.75; // the length of a drop's trail, metres

export function createRain(count = 2400): Rain {
  const positions = new Float32Array(count * 6);
  const geometry = new BufferGeometry();
  const attribute = new BufferAttribute(positions, 3);
  geometry.setAttribute('position', attribute);
  attribute.setUsage(35048); // DynamicDrawUsage
  const material = new LineBasicMaterial({
    color: 0xc9d2dd,
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
  });
  const object = new LineSegments(geometry, material);
  object.frustumCulled = false;
  object.renderOrder = 5;
  // each drop: where it is in the box, relative to the centre
  const dx = new Float32Array(count);
  const dy = new Float32Array(count);
  const dz = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    dx[i] = (Math.random() * 2 - 1) * BOX;
    dy[i] = Math.random() * HEIGHT;
    dz[i] = (Math.random() * 2 - 1) * BOX;
  }
  const slantX = (DRIFT / FALL) * STREAK;
  let shown = 0;
  return {
    object,
    update(x, z, dt, intensity) {
      const want = Math.round(count * Math.max(0, Math.min(1, intensity)));
      if (want === 0 && shown === 0) {
        object.visible = false;
        return;
      }
      object.visible = true;
      shown = want;
      geometry.setDrawRange(0, want * 2);
      const fall = FALL * dt;
      const drift = DRIFT * dt;
      for (let i = 0; i < want; i++) {
        dy[i] -= fall;
        dx[i] += drift;
        if (dy[i] < 0) {
          dy[i] += HEIGHT;
          dx[i] = (Math.random() * 2 - 1) * BOX;
          dz[i] = (Math.random() * 2 - 1) * BOX;
        }
        if (dx[i] > BOX) dx[i] -= BOX * 2;
        const px = x + dx[i];
        const pz = z + dz[i];
        const k = i * 6;
        positions[k] = px;
        positions[k + 1] = dy[i];
        positions[k + 2] = pz;
        positions[k + 3] = px - slantX;
        positions[k + 4] = dy[i] + STREAK;
        positions[k + 5] = pz;
      }
      attribute.needsUpdate = true;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
