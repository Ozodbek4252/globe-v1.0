// "Cutaway": buildings and trees that stand between the camera and the survivor dissolve in a dithered
// hole, so you can always see who you are playing. It patches Three.js standard materials with a few
// lines of shader and shares one set of uniforms, so a single update per frame drives all of them.
// Shadows are unaffected (they use a different material), so the world keeps its shadows.

import { Vector3, type MeshStandardMaterial } from 'three';

export interface Cutaway {
  /** Patch a material so it takes part in the cutaway. */
  apply(material: MeshStandardMaterial): void;
  /** Where the survivor and the camera are, and how wide the hole is (0 switches it off). */
  update(player: Vector3, camera: Vector3, radius: number): void;
}

const VERTEX_DECLARE = /* glsl */ `
varying vec3 vCutWorld;
`;

const VERTEX_COMPUTE = /* glsl */ `
vec4 cutLocal = vec4(transformed, 1.0);
#ifdef USE_INSTANCING
  cutLocal = instanceMatrix * cutLocal;
#endif
vCutWorld = (modelMatrix * cutLocal).xyz;
`;

const FRAGMENT_DECLARE = /* glsl */ `
varying vec3 vCutWorld;
uniform vec3 uCutPlayer;
uniform vec3 uCutCamera;
uniform float uCutRadius;
`;

const FRAGMENT_TEST = /* glsl */ `
if (uCutRadius > 0.0) {
  vec3 toPlayer = uCutPlayer - uCutCamera;
  float span = length(toPlayer);
  vec3 dir = toPlayer / span;
  vec3 rel = vCutWorld - uCutCamera;
  float along = dot(rel, dir);
  // only things in front of the survivor (between the camera and them), not beyond or beside
  if (along > 0.0 && along < span - 1.2) {
    float off = length(rel - dir * along);
    if (off < uCutRadius) {
      // a hole that is solid in the middle and breaks up into dither toward its edge
      float strength = smoothstep(uCutRadius, uCutRadius * 0.45, off);
      float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
      if (noise < strength) discard;
    }
  }
}
`;

export function createCutaway(): Cutaway {
  const uniforms = {
    uCutPlayer: { value: new Vector3() },
    uCutCamera: { value: new Vector3() },
    uCutRadius: { value: 0 },
  };
  return {
    apply(material) {
      material.onBeforeCompile = (shader) => {
        shader.uniforms.uCutPlayer = uniforms.uCutPlayer;
        shader.uniforms.uCutCamera = uniforms.uCutCamera;
        shader.uniforms.uCutRadius = uniforms.uCutRadius;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', `#include <common>\n${VERTEX_DECLARE}`)
          .replace('#include <project_vertex>', `#include <project_vertex>\n${VERTEX_COMPUTE}`);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>\n${FRAGMENT_DECLARE}`)
          .replace('void main() {', `void main() {\n${FRAGMENT_TEST}`);
      };
      material.customProgramCacheKey = () => 'cutaway-v1';
      material.needsUpdate = true;
    },
    update(player, camera, radius) {
      uniforms.uCutPlayer.value.copy(player);
      uniforms.uCutCamera.value.copy(camera);
      uniforms.uCutRadius.value = radius;
    },
  };
}
