// Drawing the survivors you are trying to save: ordinary people in bright clothes (so they stand out
// from the dull, hunched zombies), cowering where they hide, walking behind you once they join. Six
// outfits, each its own instanced mesh; the walk cycle runs in the vertex shader as for the zombies.
// Those still in hiding get a green ring and a faint column of light so they can be found.

import {
  AdditiveBlending,
  BoxGeometry,
  CapsuleGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Euler,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  RingGeometry,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CIVILIAN, CState, type Civilians } from '../sim/civilians';
import { LIMB_ATTRIBUTES, LIMB_SWING, tagLimbs } from './zombies';

export interface PeopleRenderer {
  object: Object3D;
  /**
   * Pose everyone for this frame.
   * @param seconds a steady clock, for trembling and pulsing
   * @param cameraDistance how far the camera is from what it looks at: markers and dots grow with it
   */
  update(c: Civilians, seconds: number, cameraDistance: number): void;
  dispose(): void;
}

const SKIN = new Color(0xd9a98a);
const HAIR = [new Color(0x1d1a18), new Color(0x4a3426), new Color(0xb08a4a), new Color(0x7a2f22)];

/** Jacket and trousers for each outfit. */
const OUTFITS: readonly [number, number][] = [
  [0x3a78c8, 0x2b2f3a],
  [0xd8523a, 0x35383f],
  [0x4aa86a, 0x40362c],
  [0xe0b43a, 0x2d3547],
  [0x8a5ac8, 0x30343c],
  [0x3ab7b0, 0x4a4036],
];

const STRIDE = 1.5;
const MARK = new Color(0x7dff8f);
const DOT_HIDING = new Color(0x6bff7c);
const DOT_FOLLOWING = new Color(0xd6ffdc);

const hash = (i: number): number => ((Math.imul(i + 1, 2654435761) >>> 0) % 4096) / 4096;
const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);

/** An upright person, facing +Z, feet on y = 0, about 1.75 m tall. */
function buildPerson(jacket: Color, trousers: Color, hair: Color): BufferGeometry {
  const parts: BufferGeometry[] = [];
  const torso = new CapsuleGeometry(0.21, 0.42, 4, 8);
  torso.translate(0, 1.12, 0);
  parts.push(tagLimbs(torso, jacket, 0, 0));
  const head = new SphereGeometry(0.15, 10, 8);
  head.translate(0, 1.64, 0.01);
  parts.push(tagLimbs(head, SKIN, 0, 0));
  const hairCap = new SphereGeometry(0.16, 10, 8, 0, Math.PI * 2, 0, Math.PI * 0.55);
  hairCap.translate(0, 1.67, -0.01);
  parts.push(tagLimbs(hairCap, hair, 0, 0));
  const pack = new BoxGeometry(0.26, 0.34, 0.12);
  pack.translate(0, 1.14, -0.24);
  parts.push(tagLimbs(pack, trousers, 0, 0));
  for (const side of [-1, 1]) {
    const leg = new CapsuleGeometry(0.085, 0.5, 3, 6);
    leg.translate(0, -0.335, 0);
    leg.translate(side * 0.11, 0.84, 0);
    parts.push(tagLimbs(leg, trousers, side, 0.84));
    const arm = new CapsuleGeometry(0.068, 0.42, 3, 6);
    arm.translate(0, -0.28, 0);
    arm.translate(side * 0.3, 1.4, 0);
    parts.push(tagLimbs(arm, jacket, -side * 0.9, 1.4));
  }
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged;
}

export function createPeopleRenderer(capacity: number): PeopleRenderer {
  const material = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.85,
    metalness: 0,
    flatShading: true,
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${LIMB_ATTRIBUTES}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${LIMB_SWING}`);
  };
  material.customProgramCacheKey = () => 'zombie-limbs-v1'; // the same program as the zombies use

  const object = new Object3D();
  const outfits = OUTFITS.map(([jacket, trousers], k) => {
    const geometry = buildPerson(new Color(jacket), new Color(trousers), HAIR[k % HAIR.length]);
    const phase = new InstancedBufferAttribute(new Float32Array(capacity), 1);
    const amp = new InstancedBufferAttribute(new Float32Array(capacity), 1);
    phase.setUsage(DynamicDrawUsage);
    amp.setUsage(DynamicDrawUsage);
    geometry.setAttribute('aPhase', phase);
    geometry.setAttribute('aAmp', amp);
    const mesh = new InstancedMesh(geometry, material, capacity);
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.castShadow = true;
    mesh.frustumCulled = false;
    mesh.count = 0;
    object.add(mesh);
    return { geometry, phase, amp, mesh };
  });

  // marks for those in hiding: a ring on the ground and a faint column of light
  const ringGeometry = new RingGeometry(0.8, 1.1, 32);
  ringGeometry.rotateX(-Math.PI / 2);
  const columnGeometry = new CylinderGeometry(0.55, 0.55, 1, 16, 1, true);
  columnGeometry.translate(0, 0.5, 0);
  const markMaterial = (opacity: number): MeshBasicMaterial =>
    new MeshBasicMaterial({
      color: MARK,
      transparent: true,
      opacity,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
      fog: false,
    });
  const ringMaterial = markMaterial(0.7);
  const columnMaterial = markMaterial(0.18);
  const rings = new InstancedMesh(ringGeometry, ringMaterial, capacity);
  const columns = new InstancedMesh(columnGeometry, columnMaterial, capacity);
  for (const m of [rings, columns]) {
    m.instanceMatrix.setUsage(DynamicDrawUsage);
    m.frustumCulled = false;
    m.renderOrder = 6;
    m.count = 0;
    object.add(m);
  }

  // dots, for seeing them from far away
  const dotGeometry = new CircleGeometry(1, 12);
  dotGeometry.rotateX(-Math.PI / 2);
  const dotMaterial = new MeshBasicMaterial({
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  const dots = new InstancedMesh(dotGeometry, dotMaterial, capacity);
  dots.instanceMatrix.setUsage(DynamicDrawUsage);
  dots.setColorAt(0, DOT_HIDING);
  dots.frustumCulled = false;
  dots.renderOrder = 7;
  dots.count = 0;
  object.add(dots);

  const dummy = new Object3D();
  const euler = new Euler();
  const quaternion = new Quaternion();
  const position = new Vector3();
  const scale = new Vector3();
  const matrix = new Matrix4();
  const counts = new Array<number>(OUTFITS.length).fill(0);

  return {
    object,
    update(c, seconds, cameraDistance) {
      counts.fill(0);
      const grow = Math.min(12, Math.max(1, cameraDistance / 45));
      let marks = 0;
      let dotCount = 0;
      const dotAmount = Math.min(1, Math.max(0, (cameraDistance - 55) / 70));
      dotMaterial.opacity = 0.95 * dotAmount;
      dots.visible = dotAmount > 0.01;
      const dotSize = Math.min(3.5, Math.max(0.8, cameraDistance / 240));

      for (let i = 0; i < c.count; i++) {
        const state = c.state[i];
        if (state === CState.SHELTERED || state === CState.SAVED) continue;
        const dead = state === CState.DEAD;
        if (dead && c.deadT[i] > CIVILIAN.linger) continue;
        const x = c.x[i];
        const y = c.y[i];
        const k = i % OUTFITS.length;
        const o = outfits[k];
        const n = counts[k]++;

        let lean = 0.05;
        let swing = Math.min(1.2, Math.hypot(c.vx[i], c.vy[i]) / 3) * 0.7;
        let lift = 0;
        let fall = 0;
        let height = 1;
        let heading = c.heading[i];
        if (state === CState.HIDING) {
          // cowering: crouched, hunched over, trembling a little
          lean = 0.45;
          height = 0.82;
          swing = 0;
          heading += Math.sin(seconds * 1.3 + i) * 0.35;
        } else if (dead) {
          fall = easeOut(Math.min(1, c.deadT[i] / 0.5));
          swing = 0;
          lift = 0.17 * fall;
          const sink = CIVILIAN.linger - 1.5;
          if (c.deadT[i] > sink) lift -= Math.min(1, (c.deadT[i] - sink) / 1.5) * 0.5;
        } else {
          lean = 0.1;
        }

        position.set(x, lift, -y);
        euler.set(
          dead ? (i % 2 === 0 ? 1 : -1) * fall * (Math.PI / 2 - 0.05) : lean,
          heading + Math.PI / 2,
          0,
          'YXZ',
        );
        quaternion.setFromEuler(euler);
        const size = 0.95 + hash(i) * 0.1;
        scale.set(size, size * height, size);
        matrix.compose(position, quaternion, scale);
        o.mesh.setMatrixAt(n, matrix);
        o.phase.setX(n, (c.travelled[i] / STRIDE) * Math.PI * 2 + hash(i) * 6.28);
        o.amp.setX(n, swing);

        if (state === CState.HIDING) {
          dummy.rotation.set(0, 0, 0);
          dummy.position.set(x, 0.3, -y);
          dummy.scale.setScalar(grow * (1 + 0.06 * Math.sin(seconds * 2.6 + i)));
          dummy.updateMatrix();
          rings.setMatrixAt(marks, dummy.matrix);
          dummy.position.set(x, 0, -y);
          dummy.scale.set(grow, 16, grow);
          dummy.updateMatrix();
          columns.setMatrixAt(marks, dummy.matrix);
          marks++;
        }
        if (dotAmount > 0.01 && !dead) {
          dummy.rotation.set(0, 0, 0);
          dummy.position.set(x, 0.2, -y);
          dummy.scale.setScalar(dotSize);
          dummy.updateMatrix();
          dots.setMatrixAt(dotCount, dummy.matrix);
          dots.setColorAt(dotCount, state === CState.HIDING ? DOT_HIDING : DOT_FOLLOWING);
          dotCount++;
        }
      }

      outfits.forEach((o, k) => {
        o.mesh.count = counts[k];
        o.mesh.instanceMatrix.needsUpdate = true;
        o.phase.needsUpdate = true;
        o.amp.needsUpdate = true;
      });
      rings.count = columns.count = marks;
      rings.instanceMatrix.needsUpdate = true;
      columns.instanceMatrix.needsUpdate = true;
      dots.count = dotCount;
      dots.instanceMatrix.needsUpdate = true;
      if (dots.instanceColor) dots.instanceColor.needsUpdate = true;
    },
    dispose() {
      for (const o of outfits) {
        o.geometry.dispose();
        o.mesh.dispose();
      }
      material.dispose();
      for (const g of [ringGeometry, columnGeometry, dotGeometry]) g.dispose();
      for (const m of [ringMaterial, columnMaterial, dotMaterial]) m.dispose();
      for (const m of [rings, columns, dots]) m.dispose();
    },
  };
}
