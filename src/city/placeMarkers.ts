// Marking the buildings that do something: a glowing outline around the footprint, a column of light
// at the door and a ring on the ground where you stand to use it. Each kind has its own colour, and a
// used-up place fades. Framework-agnostic: no Vue, no game rules.

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  RingGeometry,
} from 'three';
import type { Place } from '../sim/places';
import { PLACE_COLOURS } from './placeStyle';

export interface PlaceMarkers {
  object: Object3D;
  /**
   * Update for this frame.
   * @param used which places are used up (they fade)
   * @param darkness 0 by day, 1 at night: the glow is stronger in the dark
   * @param cameraDistance how far the camera is from what it looks at: markers grow with it
   */
  sync(used: readonly boolean[], seconds: number, darkness: number, cameraDistance: number): void;
  dispose(): void;
}

/** A flat ribbon of the given width along a closed outline, lying on the ground. */
function outlineRibbon(ring: readonly number[], width: number, height: number): BufferGeometry {
  const n = ring.length / 2;
  const positions = new Float32Array(n * 4 * 3);
  const index: number[] = [];
  const half = width / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = ring[i * 2];
    const y0 = ring[i * 2 + 1];
    const x1 = ring[j * 2];
    const y1 = ring[j * 2 + 1];
    const len = Math.hypot(x1 - x0, y1 - y0) || 1;
    // the wall's own direction, and its outward normal (outlines run counter-clockwise)
    const ux = (x1 - x0) / len;
    const uy = (y1 - y0) / len;
    const nx = uy;
    const ny = -ux;
    const o = i * 4 * 3;
    const corner = (k: number, x: number, y: number): void => {
      positions[o + k * 3] = x;
      positions[o + k * 3 + 1] = height;
      positions[o + k * 3 + 2] = -y;
    };
    corner(0, x0 - nx * half, y0 - ny * half);
    corner(1, x1 - nx * half, y1 - ny * half);
    corner(2, x1 + nx * half, y1 + ny * half);
    corner(3, x0 + nx * half, y0 + ny * half);
    const b = i * 4;
    index.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(positions, 3));
  g.setIndex(index);
  return g;
}

export function createPlaceMarkers(
  places: readonly Place[],
  outlines: readonly (readonly number[])[],
): PlaceMarkers {
  const object = new Object3D();
  const disposables: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(thing: T): T => {
    disposables.push(thing);
    return thing;
  };

  const columnGeometry = own(new CylinderGeometry(1.2, 1.2, 1, 20, 1, true));
  columnGeometry.translate(0, 0.5, 0);
  const ringGeometry = own(new RingGeometry(1.15, 1.5, 40));
  ringGeometry.rotateX(-Math.PI / 2);

  // outlines[i] is the footprint of places[i]
  const parts = places.map((place, i) => {
    const colour = new Color(PLACE_COLOURS[place.kind]);
    const material = (opacity: number): MeshBasicMaterial =>
      own(
        new MeshBasicMaterial({
          color: colour,
          transparent: true,
          opacity,
          blending: AdditiveBlending,
          depthWrite: false,
          side: DoubleSide,
          fog: false,
        }),
      );
    // the ribbon is rebuilt as the camera pulls back (not owned: replaced and disposed by sync)
    const outline = new Mesh(outlineRibbon(outlines[i], 0.9, 0.32), material(0.55));
    outline.frustumCulled = false;
    outline.renderOrder = 5;
    const column = new Mesh(columnGeometry, material(0.2));
    column.position.set(place.x, 0, -place.y);
    column.scale.set(1, place.kind === 'radar' ? 46 : 26, 1);
    column.frustumCulled = false;
    column.renderOrder = 5;
    const ring = new Mesh(ringGeometry, material(0.7));
    ring.position.set(place.x, 0.3, -place.y);
    ring.renderOrder = 6;
    object.add(outline, column, ring);
    return { outline, column, ring };
  });

  let bucket = Number.NaN;
  return {
    object,
    sync(used, seconds, darkness, cameraDistance) {
      // Markers grow as the camera pulls back, so they can still be found from far away: the outline's
      // width, the column's girth and the door ring all follow the distance (in steps, for the outline).
      const grow = Math.min(14, Math.max(1, cameraDistance / 40));
      const step = Math.round(Math.log2(grow) * 3);
      if (step !== bucket) {
        bucket = step;
        const width = 0.9 * 2 ** (step / 3);
        parts.forEach((p, i) => {
          p.outline.geometry.dispose();
          p.outline.geometry = outlineRibbon(outlines[i], width, 0.32);
        });
      }
      parts.forEach((p, i) => {
        const spent = used[i] === true;
        const fade = spent ? 0.18 : 1;
        const pulse = 0.85 + 0.15 * Math.sin(seconds * 2.4 + i);
        p.outline.material.opacity = (0.4 + 0.25 * darkness) * fade * pulse;
        p.column.material.opacity = (0.12 + 0.12 * darkness) * fade;
        p.column.scale.set(grow, places[i].kind === 'radar' ? 46 : 26, grow);
        p.ring.material.opacity = 0.7 * fade * pulse;
        p.ring.scale.setScalar(grow * (1 + 0.08 * Math.sin(seconds * 3 + i)));
      });
    },
    dispose() {
      for (const p of parts) p.outline.geometry.dispose();
      for (const d of disposables) d.dispose();
    },
  };
}
