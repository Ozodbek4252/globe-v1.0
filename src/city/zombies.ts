// Drawing the horde. Every zombie is one instance of a low-poly body; a few hundred cost one draw call.
// The walk cycle runs in the vertex shader (each vertex knows which limb it belongs to), so animating
// a crowd costs the CPU nothing beyond writing a matrix and two numbers per zombie.
//
// Seen from far away, bodies shrink to nothing, so each zombie also gets a "dot" on the ground that
// grows with camera distance: the horde stays readable from the overview camera.

import {
  BoxGeometry,
  BufferAttribute,
  CapsuleGeometry,
  CircleGeometry,
  Color,
  DynamicDrawUsage,
  Euler,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Quaternion,
  SphereGeometry,
  Vector3,
  type BufferGeometry,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { ZKind, ZOMBIE, ZState, type Horde } from '../sim/horde';

// deliberately dull and dark: bright flashlight beams would otherwise wash them out to white
const SKIN = new Color(0x667758);
const SHIRT = new Color(0x625c52);
const TROUSERS = new Color(0x2c2f36);

/** Metres of travel per full stride for a shambling gait. */
const STRIDE = 1.3;
/** Zombies further than this from the camera's focus are not drawn at all. */
const DRAW_RANGE = 420;

/** A set of tints, applied per zombie, so a crowd is not a row of clones. */
const TINTS = [
  new Color(1, 1, 1),
  new Color(1.18, 0.96, 0.84),
  new Color(0.84, 1.0, 1.12),
  new Color(1.08, 1.1, 0.8),
  new Color(0.8, 0.84, 0.82),
  new Color(1.22, 0.9, 0.9),
];

/** A slot's own number from 0 to 1, always the same for the same slot. */
const hash = (i: number): number => ((Math.imul(i + 1, 2654435761) >>> 0) % 4096) / 4096;

export interface ZombieRenderer {
  object: Object3D;
  /**
   * Pose every zombie for this frame.
   * @param focusX where the camera is looking (city metres); zombies far from it are skipped
   * @param cameraDistance how far the camera is from its focus, which sizes the dots
   */
  update(horde: Horde, dt: number, focusX: number, focusY: number, cameraDistance: number): void;
  /** How many bodies were drawn in the latest frame. */
  drawn(): number;
  dispose(): void;
}

function tag(g: BufferGeometry, colour: Color, limb: number, pivot: number): BufferGeometry {
  const n = g.getAttribute('position').count;
  const colours = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colours[i * 3] = colour.r;
    colours[i * 3 + 1] = colour.g;
    colours[i * 3 + 2] = colour.b;
  }
  g.setAttribute('color', new BufferAttribute(colours, 3));
  g.setAttribute('aLimb', new BufferAttribute(new Float32Array(n).fill(limb), 1));
  g.setAttribute('aPivot', new BufferAttribute(new Float32Array(n).fill(pivot), 1));
  return g;
}

/**
 * One zombie, facing +Z, feet on y = 0, about 1.7 m tall: hunched, head forward, arms reaching.
 * Legs and arms carry their swing weight (aLimb) and the height they swing from (aPivot).
 */
function buildBody(): BufferGeometry {
  const parts: BufferGeometry[] = [];

  const torso = new CapsuleGeometry(0.2, 0.4, 4, 8);
  torso.rotateX(0.3);
  torso.translate(0, 1.08, 0.05);
  parts.push(tag(torso, SHIRT, 0, 0));

  const head = new SphereGeometry(0.14, 10, 8);
  head.translate(0, 1.55, 0.2);
  parts.push(tag(head, SKIN, 0, 0));

  const jaw = new BoxGeometry(0.16, 0.07, 0.1);
  jaw.translate(0, 1.44, 0.27);
  parts.push(tag(jaw, SKIN, 0, 0));

  for (const side of [-1, 1]) {
    // legs hang from the hips
    const leg = new CapsuleGeometry(0.085, 0.5, 3, 6);
    leg.translate(0, -0.335, 0);
    leg.translate(side * 0.11, 0.84, 0);
    parts.push(tag(leg, TROUSERS, side, 0.84));

    // arms reach out in front, hanging from the shoulders
    const arm = new CapsuleGeometry(0.065, 0.42, 3, 6);
    arm.translate(0, -0.275, 0);
    arm.rotateX(-1.25);
    arm.translate(side * 0.27, 1.36, 0.06);
    parts.push(tag(arm, SKIN, -side * 0.3, 1.36));
  }
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged;
}

const LIMB_ATTRIBUTES = /* glsl */ `
attribute float aLimb;
attribute float aPivot;
attribute float aPhase;
attribute float aAmp;
`;

const LIMB_SWING = /* glsl */ `
{
  float swing = sin(aPhase) * aAmp * aLimb;
  float c = cos(swing);
  float s = sin(swing);
  float dy = transformed.y - aPivot;
  float ny = aPivot + dy * c - transformed.z * s;
  float nz = dy * s + transformed.z * c;
  transformed.y = ny;
  transformed.z = nz;
}
`;

const easeOut = (t: number): number => 1 - (1 - t) * (1 - t);

export function createZombieRenderer(capacity: number): ZombieRenderer {
  const geometry = buildBody();
  const phase = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  const amp = new InstancedBufferAttribute(new Float32Array(capacity), 1);
  phase.setUsage(DynamicDrawUsage);
  amp.setUsage(DynamicDrawUsage);
  geometry.setAttribute('aPhase', phase);
  geometry.setAttribute('aAmp', amp);

  const material = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.92,
    metalness: 0,
    flatShading: true,
  });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${LIMB_ATTRIBUTES}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${LIMB_SWING}`);
  };
  material.customProgramCacheKey = () => 'zombie-limbs-v1';

  const bodies = new InstancedMesh(geometry, material, capacity);
  bodies.instanceMatrix.setUsage(DynamicDrawUsage);
  bodies.setColorAt(0, TINTS[0]); // makes the colour buffer, so the shader is built with tints
  bodies.castShadow = true;
  bodies.receiveShadow = false;
  bodies.frustumCulled = false;
  bodies.count = 0;

  // the dots
  const dotGeometry = new CircleGeometry(1, 14);
  dotGeometry.rotateX(-Math.PI / 2);
  const dotMaterial = new MeshBasicMaterial({
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    fog: false,
    toneMapped: false, // keep the reds as saturated as they are written
    polygonOffset: true,
    polygonOffsetFactor: -6,
    polygonOffsetUnits: -6,
  });
  const dots = new InstancedMesh(dotGeometry, dotMaterial, capacity);
  dots.instanceMatrix.setUsage(DynamicDrawUsage);
  dots.setColorAt(0, new Color(1, 1, 1));
  dots.frustumCulled = false;
  dots.renderOrder = 7;
  dots.count = 0;

  const object = new Object3D();
  object.add(bodies, dots);

  const walked = new Float32Array(capacity);
  const dummy = new Object3D();
  const euler = new Euler();
  const quaternion = new Quaternion();
  const position = new Vector3();
  const scale = new Vector3();
  const matrix = new Matrix4();
  const colour = new Color();
  const DOT_CALM = new Color(0xb3261e);
  const DOT_HUNTING = new Color(0xff3b2a);
  const DOT_STRIKING = new Color(0xffe3d6);
  const DOT_DEAD = new Color(0x4a2a28);
  let drawnNow = 0;

  return {
    object,
    update(horde, dt, focusX, focusY, cameraDistance) {
      const range2 = DRAW_RANGE * DRAW_RANGE;
      // dots fade in as the camera pulls back; up close the bodies are enough
      const dotAmount = Math.min(1, Math.max(0, (cameraDistance - 55) / 70));
      // a dot is a couple of metres wide at most: big enough to spot, small enough to count them
      const dotSize = Math.min(4, Math.max(0.8, cameraDistance / 230));
      dotMaterial.opacity = 0.92 * dotAmount;
      dots.visible = dotAmount > 0.01;

      let n = 0;
      let d = 0;
      for (let i = 0; i < horde.used; i++) {
        const state = horde.state[i];
        if (state === ZState.FREE) continue;
        const x = horde.x[i];
        const y = horde.y[i];
        const dx = x - focusX;
        const dy = y - focusY;
        if (dx * dx + dy * dy > range2) continue;

        const speed = Math.hypot(horde.vx[i], horde.vy[i]);
        walked[i] += (speed * dt) / STRIDE;
        const kind = ZOMBIE.kinds[horde.kind[i]];
        const dead = state === ZState.DEAD;

        let lean = 0.12;
        let swing = Math.min(1.3, speed / 2.3) * 0.75;
        let lift = 0;
        let fall = 0;
        if (dead) {
          const t = Math.min(1, horde.deadT[i] / 0.5);
          fall = easeOut(t);
          swing = 0;
          lift = 0.17 * fall;
          // bodies sink out of sight before the slot is reused
          const sinkStart = ZOMBIE.linger - 1.5;
          if (horde.deadT[i] > sinkStart)
            lift -= Math.min(1, (horde.deadT[i] - sinkStart) / 1.5) * 0.5;
        } else if (horde.stun[i] > 0) {
          lean = -0.28; // reeling
          swing = 0.8;
        } else if (state === ZState.ATTACK) {
          swing = 0;
          const w = Math.min(1, horde.attackT[i] / (horde.phase[i] === 0 ? kind.windup : 0.4));
          // rear back, then lunge, then recover
          lean = horde.phase[i] === 0 ? -0.1 + 0.75 * w * w : 0.65 * (1 - w);
        } else if (state === ZState.CHASE) {
          lean = horde.kind[i] === ZKind.RUNNER ? 0.38 : 0.24;
        }

        const size = 0.94 + hash(i) * 0.14;
        position.set(x, lift, -y);
        euler.set(
          dead ? (i % 2 === 0 ? 1 : -1) * fall * (Math.PI / 2 - 0.05) : lean,
          horde.heading[i] + Math.PI / 2,
          0,
          'YXZ',
        );
        quaternion.setFromEuler(euler);
        scale.setScalar(size);
        matrix.compose(position, quaternion, scale);
        bodies.setMatrixAt(n, matrix);
        phase.setX(n, walked[i] * Math.PI * 2 + hash(i) * 6.28);
        amp.setX(n, swing);
        bodies.setColorAt(n, TINTS[Math.floor(hash(i + 7) * TINTS.length)]);
        n++;

        if (dotAmount > 0.01) {
          dummy.position.set(x, 0.16, -y);
          dummy.scale.setScalar(dead ? dotSize * 0.45 : dotSize);
          dummy.updateMatrix();
          dots.setMatrixAt(d, dummy.matrix);
          colour.copy(
            dead
              ? DOT_DEAD
              : state === ZState.ATTACK
                ? DOT_STRIKING
                : state === ZState.CHASE || state === ZState.INVESTIGATE
                  ? DOT_HUNTING
                  : DOT_CALM,
          );
          dots.setColorAt(d, colour);
          d++;
        }
      }
      drawnNow = n;
      bodies.count = n;
      bodies.instanceMatrix.needsUpdate = true;
      if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
      phase.needsUpdate = true;
      amp.needsUpdate = true;
      dots.count = d;
      dots.instanceMatrix.needsUpdate = true;
      if (dots.instanceColor) dots.instanceColor.needsUpdate = true;
    },
    drawn: () => drawnNow,
    dispose() {
      geometry.dispose();
      material.dispose();
      dotGeometry.dispose();
      dotMaterial.dispose();
      bodies.dispose();
      dots.dispose();
    },
  };
}
