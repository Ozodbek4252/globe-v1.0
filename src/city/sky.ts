// The sky: a gradient dome with a sun disc and glow, and stars at night. The horizon colour is shared
// with the scene's fog, so distant buildings dissolve into the sky with no visible seam.

import {
  BackSide,
  Color,
  Mesh,
  ShaderMaterial,
  SphereGeometry,
  Vector3,
  type Fog,
  type PerspectiveCamera,
} from 'three';
import type { SkyPalette } from './sunlight';

const VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const FRAGMENT = /* glsl */ `
uniform vec3 zenith;
uniform vec3 horizon;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform float sunGlow;
uniform float stars;
varying vec3 vDir;

float hash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}

void main() {
  vec3 d = normalize(vDir);
  float up = clamp(d.y, 0.0, 1.0);
  vec3 col = mix(horizon, zenith, pow(up, 0.5));
  // below the horizon, darken toward the fog colour so the far edge of the ground blends in
  col = mix(col, horizon * 0.55, smoothstep(0.0, -0.25, d.y));

  float s = max(dot(d, normalize(sunDir)), 0.0);
  float disc = smoothstep(0.9992, 0.9996, s);
  col += sunColor * (disc * 6.0 + pow(s, 14.0) * 0.45 * sunGlow + pow(s, 3.0) * 0.16 * sunGlow);

  // stars: sparse bright cells in the upper sky, fading out near the horizon
  vec3 cell = floor(d * 260.0);
  float h = hash(cell);
  float star = step(0.9965, h) * smoothstep(0.08, 0.4, d.y) * stars;
  col += vec3(0.9, 0.95, 1.0) * star * (0.4 + 0.6 * fract(h * 91.7));

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface Sky {
  mesh: Mesh;
  /** Apply a palette and sun direction (unit vector in Three.js space) and recentre on the camera. */
  update(palette: SkyPalette, sunDirection: Vector3, camera: PerspectiveCamera, fog: Fog): void;
  dispose(): void;
}

export function createSky(): Sky {
  const uniforms = {
    zenith: { value: new Color() },
    horizon: { value: new Color() },
    sunDir: { value: new Vector3(0, 1, 0) },
    sunColor: { value: new Color() },
    sunGlow: { value: 0 },
    stars: { value: 0 },
  };
  const material = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    fog: false,
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
  });
  const geometry = new SphereGeometry(5000, 32, 20);
  const mesh = new Mesh(geometry, material);
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;

  return {
    mesh,
    update(palette, sunDirection, camera, fog) {
      uniforms.zenith.value.setRGB(...palette.zenith);
      uniforms.horizon.value.setRGB(...palette.horizon);
      uniforms.sunColor.value.setRGB(...palette.light);
      uniforms.sunDir.value.copy(sunDirection);
      uniforms.sunGlow.value = palette.sunGlow;
      uniforms.stars.value = Math.max(0, (palette.windowGlow - 0.35) / 0.65);
      fog.color.setRGB(...palette.horizon);
      mesh.position.copy(camera.position);
    },
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
