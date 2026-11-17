// The rescue helicopter. It comes in from far off over the last seconds of the game, slows, and lands in
// the open ground near the survivor, lighting them with a searchlight on the way down. (A hover would be
// out of sight: the camera looks down on the street from only a couple of storeys up.) Pure scenery:
// when it arrives the game ends, whatever the helicopter is doing.

import {
  BoxGeometry,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SpotLight,
  SphereGeometry,
  type BufferGeometry,
  type Material,
} from 'three';

export interface Helicopter {
  object: Object3D;
  /**
   * Place it.
   * @param progress 0 when it first appears, 1 when it has landed
   * @param angle the direction (radians, counter-clockwise from east) it flies in from
   * @param landX,landY where it lands, in city metres
   * @param aimX,aimY the survivor, whom it faces and lights up
   * @param darkness 0 by day, 1 at night: the searchlight brightens with it
   */
  update(
    progress: number,
    angle: number,
    landX: number,
    landY: number,
    aimX: number,
    aimY: number,
    darkness: number,
    dt: number,
  ): void;
  hide(): void;
  dispose(): void;
}

const smooth = (t: number): number => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};
/** The shortest signed turn from one angle to another. */
const turnBetween = (from: number, to: number): number =>
  Math.atan2(Math.sin(to - from), Math.cos(to - from));
const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);

/** How far away it starts, how high it flies in, and the height of its body when its skids touch down (metres). */
const START_DISTANCE = 340;
const CRUISE_ALTITUDE = 85;
const LANDED_ALTITUDE = 1.6;

export function createHelicopter(): Helicopter {
  const disposables: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(thing: T): T => {
    disposables.push(thing);
    return thing;
  };
  const geo = <T extends BufferGeometry>(g: T): T => own(g);
  const white = own(new MeshStandardMaterial({ color: 0xe9ecef, roughness: 0.5, metalness: 0.2 }));
  const orange = own(
    new MeshStandardMaterial({ color: 0xe8731a, roughness: 0.55, metalness: 0.1 }),
  );
  const dark = own(new MeshStandardMaterial({ color: 0x23272d, roughness: 0.6, metalness: 0.3 }));
  const glass = own(
    new MeshStandardMaterial({
      color: 0x6f9bb8,
      roughness: 0.15,
      metalness: 0.4,
      emissive: new Color(0x9ac8e8),
      emissiveIntensity: 0.25,
    }),
  );

  const root = new Object3D(); // moved; carries the searchlight, which must not turn with the fuselage
  const turner = new Object3D(); // turned to the heading
  const body = new Object3D(); // tilts with speed
  root.add(turner);
  turner.add(body);
  const add = (
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

  // The helicopter faces +Z. Metres: about 9 long, with a 10 m rotor.
  const cabin = add(geo(new CapsuleGeometry(1.2, 2.2, 4, 10)), white, 0, 0, 0.4);
  cabin.rotation.x = Math.PI / 2;
  cabin.scale.set(1, 1, 1.15);
  add(geo(new SphereGeometry(1.0, 10, 8)), glass, 0, 0.35, 2.3).scale.set(1, 0.85, 0.9);
  const stripe = add(geo(new BoxGeometry(2.46, 0.3, 4.2)), orange, 0, -0.15, 0.4);
  stripe.scale.set(1, 1, 1);
  const boom = add(geo(new CylinderGeometry(0.28, 0.14, 4.6, 8)), white, 0, 0.35, -3.9);
  boom.rotation.x = Math.PI / 2;
  add(geo(new BoxGeometry(0.12, 1.5, 0.9)), orange, 0, 1.0, -6.0);
  add(geo(new BoxGeometry(0.1, 0.7, 0.5)), white, 0, 0.35, -5.9).scale.set(1, 1, 1);
  add(geo(new CylinderGeometry(0.2, 0.2, 0.5, 8)), dark, 0, 1.3, 0.2); // rotor mast
  // skids
  for (const side of [-1, 1]) {
    const skid = add(geo(new CylinderGeometry(0.07, 0.07, 4.2, 6)), dark, side * 1.2, -1.45, 0.5);
    skid.rotation.x = Math.PI / 2;
    for (const z of [-0.6, 1.6]) {
      add(geo(new CylinderGeometry(0.05, 0.05, 1.3, 5)), dark, side * 1.1, -0.85, z).rotation.z =
        side * 0.18;
    }
  }
  // rotors
  const rotor = new Object3D();
  rotor.position.set(0, 1.62, 0.2);
  body.add(rotor);
  for (const angle of [0, Math.PI / 2]) {
    const blade = new Mesh(geo(new BoxGeometry(10.2, 0.05, 0.28)), dark);
    blade.rotation.y = angle;
    blade.castShadow = true;
    rotor.add(blade);
  }
  const tailRotor = new Object3D();
  tailRotor.position.set(0.25, 1.0, -6.0);
  body.add(tailRotor);
  tailRotor.add(new Mesh(geo(new BoxGeometry(0.04, 1.7, 0.16)), dark));

  // a searchlight on the survivor
  const light = new SpotLight(0xe6f1ff, 0, 140, 0.42, 0.55, 1.1);
  light.castShadow = false;
  root.add(light, light.target);
  root.visible = false;

  let lastX = 0;
  let lastZ = 0;
  let yaw = 0;
  let spin = 0;
  /** False until the first update after being hidden, so the first frame does not see a huge jump. */
  let primed = false;

  return {
    object: root,
    update(progress, angle, landX, landY, aimX, aimY, darkness, dt) {
      root.visible = true;
      // fast at first, slowing to a stop; the last of the height is lost right at the end
      const along = easeOutCubic(progress);
      const px = landX + Math.cos(angle) * START_DISTANCE * (1 - along);
      const py = landY + Math.sin(angle) * START_DISTANCE * (1 - along);
      const altitude =
        LANDED_ALTITUDE +
        (CRUISE_ALTITUDE - LANDED_ALTITUDE) * (1 - smooth((progress - 0.25) / 0.75));
      root.position.set(px, altitude, -py);

      // Face where it is going, then turn to face the survivor as it settles. The model faces +Z, so a
      // direction (dx, dz) in scene space is the yaw atan2(dx, dz).
      const dx = px - lastX;
      const dz = -py - lastZ;
      const moving = primed && dt > 0 && Math.hypot(dx, dz) > 1e-4;
      const travelling = moving ? Math.atan2(dx, dz) : yaw;
      const toSurvivor = Math.atan2(aimX - px, py - aimY);
      const settle = smooth((progress - 0.7) / 0.3);
      const wanted = travelling + turnBetween(travelling, toSurvivor) * settle;
      yaw = primed ? yaw + turnBetween(yaw, wanted) * Math.min(1, dt * 2.5) : wanted;
      turner.rotation.y = yaw;

      const speed = moving ? Math.hypot(dx, dz) / dt : 0;
      body.rotation.x = Math.min(0.24, speed / 120); // nose down when going fast
      body.position.y = Math.sin(progress * 40) * 0.04 * (1 - smooth((progress - 0.9) / 0.1));
      lastX = px;
      lastZ = -py;
      primed = true;

      // the rotors spin up as it comes in and keep going once it is down
      spin += dt * 34;
      rotor.rotation.y = spin;
      tailRotor.rotation.x = spin * 1.4;

      // the searchlight picks out the survivor
      light.position.set(0, -1, 0);
      light.target.position.set(aimX - px, -altitude, -(aimY - py));
      // about as bright as the survivor's flashlight on the ground it lights (night exposure is high)
      light.intensity = 330 * (0.3 + 0.7 * darkness) * smooth(progress / 0.5);
    },
    hide() {
      root.visible = false;
      light.intensity = 0;
      primed = false;
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
