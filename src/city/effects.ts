// What you see and feel when things happen: bullet tracers, the muzzle flash, sparks and blood, the
// rings that show how far a sound carries, and the aim reticle. Everything lives in fixed pools made
// up front, so firing a hundred shots allocates nothing. Framework-agnostic: no Vue, no game rules.

import {
  AdditiveBlending,
  BoxGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DynamicDrawUsage,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PointLight,
  RingGeometry,
  SphereGeometry,
  Vector3,
} from 'three';

export type AimMode = 'ready' | 'reloading' | 'empty';

export interface Effects {
  object: Object3D;
  /** A bullet left the muzzle at (x, y) and ended at (endX, endY). */
  shot(x: number, y: number, endX: number, endY: number, hit: 'zombie' | 'wall' | 'none'): void;
  /** A zombie was hit (or died) at this spot. */
  hit(x: number, y: number, kill: boolean): void;
  /** A sound went out from here and reaches this far. */
  noise(x: number, y: number, radius: number): void;
  /** Where the survivor is aiming (null for nowhere), and how big to draw the reticle. */
  setAim(x: number | null, y: number, scale: number, mode: AimMode): void;
  /** Keep the flashes gentle for people who asked for less motion. */
  setReducedMotion(reduced: boolean): void;
  update(dt: number): void;
  /** Clear everything (a new game). */
  clear(): void;
  dispose(): void;
}

const MUZZLE_HEIGHT = 1.15;
const TARGET_HEIGHT = 1.0;
const TRACER_LIFE = 0.09;
const FLASH_LIFE = 0.065;
const MAX_TRACERS = 10;
const MAX_SPARKS = 240;
const MAX_BLOOD = 220;
const MAX_RINGS = 8;

interface Ring {
  mesh: Mesh;
  age: number;
  life: number;
  radius: number;
  strength: number;
}

export function createEffects(): Effects {
  const disposables: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(thing: T): T => {
    disposables.push(thing);
    return thing;
  };
  const object = new Object3D();
  let reduced = false;

  // ---- tracers
  const tracerGeometry = own(new CylinderGeometry(0.035, 0.035, 1, 5));
  tracerGeometry.translate(0, 0.5, 0);
  const tracerMaterial = own(
    new MeshBasicMaterial({
      color: 0xffe9b0,
      transparent: true,
      opacity: 0.95,
      blending: AdditiveBlending,
      depthWrite: false,
      fog: false,
    }),
  );
  const tracers: { mesh: Mesh; life: number }[] = [];
  for (let i = 0; i < MAX_TRACERS; i++) {
    const mesh = new Mesh(tracerGeometry, tracerMaterial);
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 8;
    object.add(mesh);
    tracers.push({ mesh, life: 0 });
  }
  let nextTracer = 0;
  const up = new Vector3(0, 1, 0);
  const dir = new Vector3();

  // ---- muzzle flash: a light and a small bright blob
  const flashLight = new PointLight(0xffb868, 0, 18, 2);
  flashLight.castShadow = false;
  object.add(flashLight);
  const flashMaterial = own(
    new MeshBasicMaterial({
      color: 0xffc27a,
      transparent: true,
      opacity: 0.9,
      blending: AdditiveBlending,
      depthWrite: false,
      fog: false,
    }),
  );
  const flashBlob = new Mesh(own(new SphereGeometry(0.22, 8, 6)), flashMaterial);
  flashBlob.visible = false;
  flashBlob.renderOrder = 9;
  object.add(flashBlob);
  let flashLeft = 0;

  // ---- sparks and blood spray: one instanced mesh of tiny cubes
  const sparkGeometry = own(new BoxGeometry(0.07, 0.07, 0.07));
  const sparkMaterial = own(new MeshBasicMaterial({ fog: false }));
  const sparks = new InstancedMesh(sparkGeometry, sparkMaterial, MAX_SPARKS);
  sparks.instanceMatrix.setUsage(DynamicDrawUsage);
  sparks.setColorAt(0, new Color(1, 1, 1));
  sparks.frustumCulled = false;
  sparks.count = 0;
  object.add(sparks);
  const sp = {
    x: new Float32Array(MAX_SPARKS),
    y: new Float32Array(MAX_SPARKS),
    z: new Float32Array(MAX_SPARKS),
    vx: new Float32Array(MAX_SPARKS),
    vy: new Float32Array(MAX_SPARKS),
    vz: new Float32Array(MAX_SPARKS),
    life: new Float32Array(MAX_SPARKS),
    full: new Float32Array(MAX_SPARKS),
    colour: Array.from({ length: MAX_SPARKS }, () => new Color()),
  };
  let nextSpark = 0;
  const burst = (
    x: number,
    y: number,
    height: number,
    count: number,
    colours: readonly Color[],
    speed: number,
    lift: number,
  ): void => {
    for (let k = 0; k < count; k++) {
      const i = nextSpark;
      nextSpark = (nextSpark + 1) % MAX_SPARKS;
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.35 + Math.random() * 0.65);
      sp.x[i] = x;
      sp.y[i] = height;
      sp.z[i] = -y;
      sp.vx[i] = Math.cos(a) * s;
      sp.vz[i] = -Math.sin(a) * s;
      sp.vy[i] = lift * (0.4 + Math.random() * 0.8);
      sp.full[i] = sp.life[i] = 0.3 + Math.random() * 0.35;
      sp.colour[i].copy(colours[Math.floor(Math.random() * colours.length)]);
    }
  };
  const BLOOD_COLOURS = [new Color(0x8a0f12), new Color(0x5a0a0c), new Color(0xa31a14)];
  const DUST_COLOURS = [new Color(0xffe6b0), new Color(0xd9c7a0), new Color(0xfff6dc)];

  // ---- blood stains on the ground
  const bloodMaterial = own(
    new MeshStandardMaterial({
      color: 0x7a0d11,
      roughness: 0.5,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -5,
      polygonOffsetUnits: -5,
    }),
  );
  const bloodGeometry = own(new CircleGeometry(1, 10));
  bloodGeometry.rotateX(-Math.PI / 2);
  const blood = new InstancedMesh(bloodGeometry, bloodMaterial, MAX_BLOOD);
  blood.frustumCulled = false;
  blood.count = 0;
  blood.receiveShadow = true;
  object.add(blood);
  let bloodCount = 0;
  let nextBlood = 0;
  const bloodDummy = new Object3D();

  // ---- noise rings
  const ringGeometry = own(new RingGeometry(0.982, 1, 96));
  ringGeometry.rotateX(-Math.PI / 2);
  const rings: Ring[] = [];
  for (let i = 0; i < MAX_RINGS; i++) {
    const material = new MeshBasicMaterial({
      color: 0xffe0b0,
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
      fog: false,
    });
    own(material);
    const mesh = new Mesh(ringGeometry, material);
    mesh.visible = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 6;
    object.add(mesh);
    rings.push({ mesh, age: 0, life: 1, radius: 1, strength: 1 });
  }
  let nextRing = 0;

  // ---- the aim reticle
  const reticleMaterial = own(
    new MeshBasicMaterial({
      color: 0xfff2c0,
      transparent: true,
      opacity: 0.9,
      depthTest: false,
      depthWrite: false,
      fog: false,
    }),
  );
  const reticle = new Object3D();
  const reticleRing = new Mesh(own(new RingGeometry(0.2, 0.28, 28)), reticleMaterial);
  const reticleDot = new Mesh(own(new CircleGeometry(0.035, 10)), reticleMaterial);
  reticleRing.rotation.x = reticleDot.rotation.x = -Math.PI / 2;
  reticleRing.renderOrder = reticleDot.renderOrder = 10;
  reticle.add(reticleRing, reticleDot);
  reticle.visible = false;
  object.add(reticle);
  const AIM_COLOURS: Record<AimMode, Color> = {
    ready: new Color(0xfff2c0),
    reloading: new Color(0x8f98a8),
    empty: new Color(0xff5a4a),
  };

  return {
    object,
    shot(x, y, endX, endY, hit) {
      const dx = endX - x;
      const dy = endY - y;
      const length = Math.hypot(dx, dy) || 1;
      const ux = dx / length;
      const uy = dy / length;
      const reach = Math.min(0.6, length);
      const mx = x + ux * reach;
      const my = y + uy * reach;

      const t = tracers[nextTracer];
      nextTracer = (nextTracer + 1) % MAX_TRACERS;
      dir.set(endX - mx, TARGET_HEIGHT - MUZZLE_HEIGHT, -(endY - my));
      const span = dir.length();
      t.mesh.position.set(mx, MUZZLE_HEIGHT, -my);
      t.mesh.quaternion.setFromUnitVectors(up, dir.normalize());
      t.mesh.scale.set(1, span, 1);
      t.mesh.visible = true;
      t.life = TRACER_LIFE;

      flashLight.position.set(mx, MUZZLE_HEIGHT, -my);
      flashBlob.position.copy(flashLight.position);
      flashLeft = FLASH_LIFE;
      flashLight.intensity = reduced ? 120 : 420;
      flashBlob.visible = !reduced;

      if (hit === 'wall') burst(endX, endY, 1.1, 8, DUST_COLOURS, 3.5, 2.2);
    },
    hit(x, y, kill) {
      burst(x, y, TARGET_HEIGHT, kill ? 22 : 9, BLOOD_COLOURS, kill ? 4.5 : 3, kill ? 3.4 : 2.2);
      const i = nextBlood;
      nextBlood = (nextBlood + 1) % MAX_BLOOD;
      bloodCount = Math.min(MAX_BLOOD, bloodCount + 1);
      const size = (kill ? 0.5 : 0.22) * (0.7 + Math.random() * 0.7);
      bloodDummy.position.set(
        x + (Math.random() - 0.5) * 0.4,
        0.04,
        -(y + (Math.random() - 0.5) * 0.4),
      );
      bloodDummy.rotation.set(0, Math.random() * Math.PI, 0);
      bloodDummy.scale.set(size * (1 + Math.random() * 0.6), 1, size);
      bloodDummy.updateMatrix();
      blood.setMatrixAt(i, bloodDummy.matrix);
      blood.instanceMatrix.needsUpdate = true;
      blood.count = bloodCount;
    },
    noise(x, y, radius) {
      const r = rings[nextRing];
      nextRing = (nextRing + 1) % MAX_RINGS;
      r.mesh.position.set(x, 0.22, -y);
      r.age = 0;
      r.life = radius >= 40 ? 0.95 : 0.6;
      r.radius = radius;
      r.strength = Math.min(1, 0.25 + radius / 70);
      r.mesh.visible = true;
    },
    setAim(x, y, scale, mode) {
      if (x === null) {
        reticle.visible = false;
        return;
      }
      reticle.visible = true;
      reticle.position.set(x, 0.25, -y);
      reticle.scale.setScalar(scale);
      reticleMaterial.color.copy(AIM_COLOURS[mode]);
    },
    setReducedMotion(r) {
      reduced = r;
    },
    update(dt) {
      for (const t of tracers) {
        if (t.life <= 0) continue;
        t.life -= dt;
        if (t.life <= 0) t.mesh.visible = false;
        else {
          const f = t.life / TRACER_LIFE;
          t.mesh.scale.x = t.mesh.scale.z = f;
        }
      }
      if (flashLeft > 0) {
        flashLeft -= dt;
        if (flashLeft <= 0) {
          flashLight.intensity = 0;
          flashBlob.visible = false;
        } else {
          const f = flashLeft / FLASH_LIFE;
          flashLight.intensity *= 0.55 + 0.45 * f;
          flashBlob.scale.setScalar(0.6 + f);
        }
      }

      // sparks
      let n = 0;
      for (let i = 0; i < MAX_SPARKS; i++) {
        if (sp.life[i] <= 0) continue;
        sp.life[i] -= dt;
        if (sp.life[i] <= 0) continue;
        sp.vy[i] -= 11 * dt;
        sp.x[i] += sp.vx[i] * dt;
        sp.y[i] += sp.vy[i] * dt;
        sp.z[i] += sp.vz[i] * dt;
        if (sp.y[i] < 0.04) {
          sp.y[i] = 0.04;
          sp.vy[i] = 0;
          sp.vx[i] *= 0.6;
          sp.vz[i] *= 0.6;
        }
        const f = Math.min(1, sp.life[i] / (sp.full[i] * 0.5));
        bloodDummy.position.set(sp.x[i], sp.y[i], sp.z[i]);
        bloodDummy.rotation.set(0, 0, 0);
        bloodDummy.scale.setScalar(f);
        bloodDummy.updateMatrix();
        sparks.setMatrixAt(n, bloodDummy.matrix);
        sparks.setColorAt(n, sp.colour[i]);
        n++;
      }
      sparks.count = n;
      sparks.instanceMatrix.needsUpdate = true;
      if (sparks.instanceColor) sparks.instanceColor.needsUpdate = true;

      // noise rings widen and fade
      for (const r of rings) {
        if (!r.mesh.visible) continue;
        r.age += dt;
        const t = r.age / r.life;
        if (t >= 1) {
          r.mesh.visible = false;
          continue;
        }
        const grow = 1 - (1 - t) * (1 - t);
        r.mesh.scale.setScalar(Math.max(0.5, r.radius * grow));
        (r.mesh.material as MeshBasicMaterial).opacity = 0.32 * r.strength * (1 - t) * (1 - t);
      }
    },
    clear() {
      for (const t of tracers) {
        t.life = 0;
        t.mesh.visible = false;
      }
      sp.life.fill(0);
      sparks.count = 0;
      bloodCount = 0;
      nextBlood = 0;
      blood.count = 0;
      for (const r of rings) r.mesh.visible = false;
      flashLeft = 0;
      flashLight.intensity = 0;
      flashBlob.visible = false;
      reticle.visible = false;
    },
    dispose() {
      sparks.dispose();
      blood.dispose();
      for (const d of disposables) d.dispose();
    },
  };
}
