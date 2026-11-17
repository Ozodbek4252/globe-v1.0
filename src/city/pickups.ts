// Supplies lying about: ammunition crates and first-aid kits, each with a faint pillar of light so you
// can spot them across a block. Two instanced crates and one instanced pillar mesh: a handful of draw
// calls however many there are.

import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
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
import type { Pickup } from '../sim/game';

export interface PickupMarkers {
  object: Object3D;
  /** Pose the crates for this frame. `darkness` is 0 in daylight and 1 at night (crates glow a little). */
  sync(pickups: readonly Pickup[], seconds: number, darkness: number): void;
  dispose(): void;
}

const AMMO_PILLAR = new Color(0xf0b54a);
const MEDKIT_PILLAR = new Color(0x5ad17a);

function coloured(g: BufferGeometry, colour: Color): BufferGeometry {
  const n = g.getAttribute('position').count;
  const colours = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colours[i * 3] = colour.r;
    colours[i * 3 + 1] = colour.g;
    colours[i * 3 + 2] = colour.b;
  }
  g.setAttribute('color', new BufferAttribute(colours, 3));
  return g;
}

const merge = (parts: BufferGeometry[]): BufferGeometry => {
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged;
};

export function createPickupMarkers(pickups: readonly Pickup[]): PickupMarkers {
  const object = new Object3D();
  const ammoIndices: number[] = [];
  const medkitIndices: number[] = [];
  pickups.forEach((p, i) => (p.kind === 'ammo' ? ammoIndices : medkitIndices).push(i));

  // an olive ammunition box with a yellow band
  const ammoBox = new BoxGeometry(0.62, 0.34, 0.4);
  const ammoBand = new BoxGeometry(0.12, 0.36, 0.42);
  const ammoGeometry = merge([
    coloured(ammoBox, new Color(0x56633a)),
    coloured(ammoBand, new Color(0xe3b33a)),
  ]);
  // a white first-aid case with a red cross on top
  const caseBox = new BoxGeometry(0.52, 0.32, 0.4);
  const crossA = new BoxGeometry(0.3, 0.04, 0.09);
  crossA.translate(0, 0.17, 0);
  const crossB = new BoxGeometry(0.09, 0.04, 0.3);
  crossB.translate(0, 0.17, 0);
  const medkitGeometry = merge([
    coloured(caseBox, new Color(0xe9ecee)),
    coloured(crossA, new Color(0xd0302a)),
    coloured(crossB, new Color(0xd0302a)),
  ]);

  const crateMaterial = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.7,
    emissive: new Color(1, 0.9, 0.7),
    emissiveIntensity: 0,
  });
  const ammo = new InstancedMesh(ammoGeometry, crateMaterial, Math.max(1, ammoIndices.length));
  const medkits = new InstancedMesh(
    medkitGeometry,
    crateMaterial,
    Math.max(1, medkitIndices.length),
  );
  for (const m of [ammo, medkits]) {
    m.instanceMatrix.setUsage(DynamicDrawUsage);
    m.castShadow = true;
    m.frustumCulled = false;
    object.add(m);
  }
  ammo.count = ammoIndices.length;
  medkits.count = medkitIndices.length;

  // a tall, faint column of light on each
  const pillarGeometry = new CylinderGeometry(0.3, 0.3, 16, 14, 1, true);
  pillarGeometry.translate(0, 8, 0);
  const pillarMaterial = new MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.22,
    blending: AdditiveBlending,
    depthWrite: false,
    fog: false,
  });
  const pillars = new InstancedMesh(pillarGeometry, pillarMaterial, Math.max(1, pickups.length));
  pillars.setColorAt(0, AMMO_PILLAR);
  pillars.instanceMatrix.setUsage(DynamicDrawUsage);
  pillars.frustumCulled = false;
  pillars.renderOrder = 5;
  pillars.count = pickups.length;
  object.add(pillars);

  const dummy = new Object3D();

  return {
    object,
    sync(list, seconds, darkness) {
      crateMaterial.emissiveIntensity = 0.12 + darkness * 0.5;
      pillarMaterial.opacity = 0.18 + darkness * 0.16;
      let a = 0;
      let m = 0;
      list.forEach((p, i) => {
        const taken = p.taken;
        const bob = Math.sin(seconds * 2 + i * 1.7) * 0.07;
        dummy.position.set(p.x, 0.5 + bob, -p.y);
        dummy.rotation.set(0, seconds * 0.9 + i, 0);
        dummy.scale.setScalar(taken ? 0 : 1);
        dummy.updateMatrix();
        if (p.kind === 'ammo') ammo.setMatrixAt(a++, dummy.matrix);
        else medkits.setMatrixAt(m++, dummy.matrix);

        dummy.position.set(p.x, 0, -p.y);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, taken ? 0 : 1, 1);
        dummy.updateMatrix();
        pillars.setMatrixAt(i, dummy.matrix);
        pillars.setColorAt(i, p.kind === 'ammo' ? AMMO_PILLAR : MEDKIT_PILLAR);
      });
      ammo.instanceMatrix.needsUpdate = true;
      medkits.instanceMatrix.needsUpdate = true;
      pillars.instanceMatrix.needsUpdate = true;
      if (pillars.instanceColor) pillars.instanceColor.needsUpdate = true;
    },
    dispose() {
      for (const g of [ammoGeometry, medkitGeometry, pillarGeometry]) g.dispose();
      crateMaterial.dispose();
      pillarMaterial.dispose();
      ammo.dispose();
      medkits.dispose();
      pillars.dispose();
    },
  };
}
