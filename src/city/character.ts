// The survivor's body: a small low-poly person built from primitives, with a walk cycle that follows
// how far the survivor has actually travelled (so feet never slide) and a lean when sprinting.
// City space heading: radians counter-clockwise from east. The model faces +Z in its own space.

import {
  CapsuleGeometry,
  Color,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  RingGeometry,
  SphereGeometry,
  BoxGeometry,
  DoubleSide,
  CircleGeometry,
  AdditiveBlending,
  type BufferGeometry,
  type Material,
} from 'three';

export interface Survivor {
  /** Add this to the scene. Move it with place(). */
  object: Object3D;
  /**
   * Put the survivor at a city position and pose it.
   * @param travelled total metres walked, which sets the stride
   * @param speed metres per second
   * @param sprinting leans into a run
   */
  place(
    x: number,
    y: number,
    heading: number,
    travelled: number,
    speed: number,
    sprinting: boolean,
  ): void;
  /** Scale the ground ring so it stays easy to spot when the camera is far away. */
  setRingScale(scale: number): void;
  /** 0 standing, 1 lying on the ground. Take effect on the next place(). */
  setDown(amount: number): void;
  dispose(): void;
}

/** Metres of travel per full stride (left foot down to left foot down). */
const STRIDE = 1.7;

export function createSurvivor(): Survivor {
  const disposables: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(thing: T): T => {
    disposables.push(thing);
    return thing;
  };
  const geo = <T extends BufferGeometry>(g: T): T => own(g);

  const jacket = own(
    new MeshStandardMaterial({ color: new Color(0xe0a83a), roughness: 0.85, flatShading: true }),
  );
  const trousers = own(
    new MeshStandardMaterial({ color: new Color(0x2f3a4a), roughness: 0.9, flatShading: true }),
  );
  const skin = own(
    new MeshStandardMaterial({ color: new Color(0xd9a98a), roughness: 0.8, flatShading: true }),
  );
  const pack = own(
    new MeshStandardMaterial({ color: new Color(0x4a5a3a), roughness: 0.95, flatShading: true }),
  );
  const hair = own(
    new MeshStandardMaterial({ color: new Color(0x1d1a18), roughness: 0.9, flatShading: true }),
  );

  const root = new Object3D(); // positioned in the world, turned to the heading
  const body = new Object3D(); // leans and bobs
  root.add(body);

  const part = (
    g: BufferGeometry,
    m: Material,
    x: number,
    y: number,
    z: number,
    parent: Object3D = body,
  ): Mesh => {
    const mesh = new Mesh(g, m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    parent.add(mesh);
    return mesh;
  };

  // torso, head, hair, backpack
  part(geo(new CapsuleGeometry(0.22, 0.42, 4, 8)), jacket, 0, 1.12, 0);
  part(geo(new SphereGeometry(0.16, 12, 8)), skin, 0, 1.68, 0.01);
  part(
    geo(new SphereGeometry(0.17, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55)),
    hair,
    0,
    1.7,
    -0.01,
  );
  part(geo(new BoxGeometry(0.3, 0.4, 0.17)), pack, 0, 1.15, -0.24);

  // limbs hang from pivots at the hips and shoulders so they can swing
  const limb = (m: Material, x: number, y: number, length: number, radius: number): Object3D => {
    const pivot = new Object3D();
    pivot.position.set(x, y, 0);
    const g = geo(new CapsuleGeometry(radius, length, 3, 6));
    const mesh = new Mesh(g, m);
    mesh.position.y = -(length / 2 + radius);
    mesh.castShadow = true;
    pivot.add(mesh);
    body.add(pivot);
    return pivot;
  };
  const legL = limb(trousers, -0.11, 0.82, 0.5, 0.085);
  const legR = limb(trousers, 0.11, 0.82, 0.5, 0.085);
  const armL = limb(jacket, -0.3, 1.38, 0.42, 0.07);
  const armR = limb(jacket, 0.3, 1.38, 0.42, 0.07);

  // a ring on the ground so the survivor is easy to find from high up, and a soft glow inside it
  const ringMaterial = own(
    new MeshBasicMaterial({
      color: 0xf0b54a,
      transparent: true,
      opacity: 0.85,
      side: DoubleSide,
      depthWrite: false,
    }),
  );
  const ring = new Mesh(geo(new RingGeometry(0.62, 0.74, 40)), ringMaterial);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.09;
  ring.renderOrder = 6;
  const glowMaterial = own(
    new MeshBasicMaterial({
      color: 0xf0b54a,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      blending: AdditiveBlending,
    }),
  );
  const glow = new Mesh(geo(new CircleGeometry(0.62, 32)), glowMaterial);
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.085;
  glow.renderOrder = 6;
  const ringGroup = new Object3D();
  ringGroup.add(ring, glow);
  // `parent` is moved to the survivor; only `root` turns with the heading, so the ring never spins
  const parent = new Object3D();
  parent.add(root, ringGroup);
  let down = 0;

  return {
    object: parent,
    place(x, y, heading, travelled, speed, sprinting) {
      // city (x, y) is Three.js (x, -y); the model faces +Z, so turn it by heading + 90 degrees
      parent.position.set(x, 0, -y);
      root.rotation.y = heading + Math.PI / 2;
      const pace = Math.min(1, speed / 3.4); // 0 standing, 1 walking, above that running
      const phase = (travelled / STRIDE) * Math.PI * 2;
      const swing = 0.75 * Math.min(1.35, pace) * (sprinting ? 1.25 : 1) * (1 - down);
      legL.rotation.x = Math.sin(phase) * swing;
      legR.rotation.x = -Math.sin(phase) * swing;
      armL.rotation.x = -Math.sin(phase) * swing * 0.9;
      armR.rotation.x = Math.sin(phase) * swing * 0.9;
      // two bobs per stride, and a forward lean that grows with speed; a fallen survivor lies on their back
      body.position.y = Math.abs(Math.sin(phase)) * 0.045 * pace * (1 - down) + 0.2 * down;
      body.rotation.x = (sprinting ? 0.28 : 0.1) * pace * (1 - down) - down * (Math.PI / 2 - 0.05);
    },
    setRingScale(scale) {
      ringGroup.scale.setScalar(scale);
    },
    setDown(amount) {
      down = Math.min(1, Math.max(0, amount));
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
