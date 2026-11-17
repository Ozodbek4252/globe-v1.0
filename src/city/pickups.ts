// Supplies lying about: ammunition crates, first-aid kits and cans of food, each with a faint pillar of
// light so you can spot them across a block. Three instanced crate meshes and one instanced pillar mesh:
// a handful of draw calls however many there are. The list changes (zombies drop things), so every mesh
// is made at full capacity and only as many as are lying about are drawn.

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

const PILLAR: Record<Pickup['kind'], Color> = {
  ammo: new Color(0xf0b54a),
  medkit: new Color(0x5ad17a),
  food: new Color(0x6ab8ff),
};

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

/** @param capacity the most pickups that can lie about at once */
export function createPickupMarkers(capacity: number): PickupMarkers {
  const object = new Object3D();

  // an olive ammunition box with a yellow band
  const ammoGeometry = merge([
    coloured(new BoxGeometry(0.62, 0.34, 0.4), new Color(0x56633a)),
    coloured(new BoxGeometry(0.12, 0.36, 0.42), new Color(0xe3b33a)),
  ]);
  // a white first-aid case with a red cross on top
  const crossA = new BoxGeometry(0.3, 0.04, 0.09);
  crossA.translate(0, 0.17, 0);
  const crossB = new BoxGeometry(0.09, 0.04, 0.3);
  crossB.translate(0, 0.17, 0);
  const medkitGeometry = merge([
    coloured(new BoxGeometry(0.52, 0.32, 0.4), new Color(0xe9ecee)),
    coloured(crossA, new Color(0xd0302a)),
    coloured(crossB, new Color(0xd0302a)),
  ]);
  // two blue tins of food, one stacked on the other, with silver lids
  const tin = (x: number, y: number): BufferGeometry[] => {
    const body = new BoxGeometry(0.26, 0.26, 0.26);
    body.translate(x, y, 0);
    const lid = new BoxGeometry(0.28, 0.04, 0.28);
    lid.translate(x, y + 0.14, 0);
    return [coloured(body, new Color(0x3f78c4)), coloured(lid, new Color(0xc9ced3))];
  };
  const foodGeometry = merge([...tin(-0.16, 0.13), ...tin(0.14, 0.13), ...tin(0, 0.4)]);

  const crateMaterial = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.7,
    emissive: new Color(1, 0.9, 0.7),
    emissiveIntensity: 0,
  });
  const kinds: Pickup['kind'][] = ['ammo', 'medkit', 'food'];
  const crates = {
    ammo: new InstancedMesh(ammoGeometry, crateMaterial, capacity),
    medkit: new InstancedMesh(medkitGeometry, crateMaterial, capacity),
    food: new InstancedMesh(foodGeometry, crateMaterial, capacity),
  };
  for (const k of kinds) {
    const m = crates[k];
    m.instanceMatrix.setUsage(DynamicDrawUsage);
    m.castShadow = true;
    m.frustumCulled = false;
    m.count = 0;
    object.add(m);
  }

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
  const pillars = new InstancedMesh(pillarGeometry, pillarMaterial, capacity);
  pillars.setColorAt(0, PILLAR.ammo);
  pillars.instanceMatrix.setUsage(DynamicDrawUsage);
  pillars.frustumCulled = false;
  pillars.renderOrder = 5;
  pillars.count = 0;
  object.add(pillars);

  const dummy = new Object3D();
  const counts = { ammo: 0, medkit: 0, food: 0 };

  return {
    object,
    sync(list, seconds, darkness) {
      crateMaterial.emissiveIntensity = 0.12 + darkness * 0.5;
      pillarMaterial.opacity = 0.18 + darkness * 0.16;
      counts.ammo = counts.medkit = counts.food = 0;
      let drawn = 0;
      for (let i = 0; i < list.length && i < capacity; i++) {
        const p = list[i];
        if (p.taken) continue; // nothing to show: the slot is empty until a drop reuses it
        const bob = Math.sin(seconds * 2 + i * 1.7) * 0.07;
        dummy.position.set(p.x, 0.5 + bob, -p.y);
        dummy.rotation.set(0, seconds * 0.9 + i, 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        crates[p.kind].setMatrixAt(counts[p.kind]++, dummy.matrix);

        // supplies a zombie dropped are small finds: a shorter column
        dummy.position.set(p.x, 0, -p.y);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.set(1, p.amount === undefined ? 1 : 0.4, 1);
        dummy.updateMatrix();
        pillars.setMatrixAt(drawn, dummy.matrix);
        pillars.setColorAt(drawn, PILLAR[p.kind]);
        drawn++;
      }
      for (const k of kinds) {
        crates[k].count = counts[k];
        crates[k].instanceMatrix.needsUpdate = true;
      }
      pillars.count = drawn;
      pillars.instanceMatrix.needsUpdate = true;
      if (pillars.instanceColor) pillars.instanceColor.needsUpdate = true;
    },
    dispose() {
      for (const g of [ammoGeometry, medkitGeometry, foodGeometry, pillarGeometry]) g.dispose();
      crateMaterial.dispose();
      pillarMaterial.dispose();
      for (const k of kinds) crates[k].dispose();
      pillars.dispose();
    },
  };
}
