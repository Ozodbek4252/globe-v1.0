import { RAD, unitVector, type LonLat } from '../lib/geo';
import { publicUrl } from '../lib/url';
import type { Rotation } from './projection';
import fragmentSource from './shaders/lights.frag.glsl?raw';
import vertexSource from './shaders/lights.vert.glsl?raw';

/** Every uniform the render function sets; the shader must declare each one. */
export const UNIFORM_NAMES = [
  'tex',
  'texSize',
  'center',
  'scale',
  'cphi',
  'sphi',
  'lam',
  'gain',
  'sun',
  'useSun',
  'H',
] as const;
type UniformName = (typeof UNIFORM_NAMES)[number];

/** NASA Black Marble 2016. The full-size image is used where the GPU can hold it. */
const FULL_IMAGE = { file: 'img/earth-night-full.jpg', minTextureSize: 13500 };
const SMALL_IMAGE = 'img/earth-night.jpg';

export interface LightsParams {
  /** draw the lights at all */
  on: boolean;
  /** sub-solar point in Day & night mode (lights then show on the night side only), else null */
  sun: LonLat | null;
  /** size of the map canvas in device pixels; the lights canvas is kept the same size */
  width: number;
  height: number;
  /** globe radius in device pixels */
  scale: number;
  rot: Readonly<Rotation>;
}

export interface LightsRenderer {
  render(params: LightsParams): void;
  dispose(): void;
}

export interface LightsHooks {
  /** loading status text: "Loading…", an error, or "" when there is nothing to say */
  onStatus(message: string): void;
  /** the texture finished loading, so the next frame can draw lights */
  onReady(): void;
}

/**
 * WebGL2 night-lights layer: inverts the orthographic projection per pixel in a fragment shader,
 * samples the NASA texture (bicubic when zoomed in) and adds bloom from blurred mip levels.
 * Returns null where WebGL2 is unavailable; the Lights toggle then simply does nothing.
 */
export function createLightsGL(
  canvas: HTMLCanvasElement,
  hooks: LightsHooks,
): LightsRenderer | null {
  const context = canvas.getContext('webgl2', { premultipliedAlpha: false, antialias: false });
  if (!context) return null;
  const gl: WebGL2RenderingContext = context;

  const compile = (type: number, source: string): WebGLShader => {
    const shader = gl.createShader(type);
    if (!shader) throw new Error('Could not create a shader');
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(shader));
    }
    return shader;
  };

  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertexSource));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragmentSource));
  gl.linkProgram(program);
  gl.useProgram(program);

  // one full-screen quad
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'p');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const uniform = {} as Record<UniformName, WebGLUniformLocation | null>;
  for (const name of UNIFORM_NAMES) uniform[name] = gl.getUniformLocation(program, name);

  const texture = { ready: false, loading: false, width: 0, height: 0 };
  let disposed = false;

  function load(): void {
    if (texture.loading) return;
    texture.loading = true;
    const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const image = new Image();
    image.onload = () => {
      if (disposed) return;
      // Downscale on the way in if the GPU cannot hold the full image.
      let source: HTMLImageElement | HTMLCanvasElement = image;
      if (image.width > maxSize) {
        const scaled = document.createElement('canvas');
        scaled.width = maxSize;
        scaled.height = maxSize / 2;
        scaled.getContext('2d')?.drawImage(image, 0, 0, maxSize, maxSize / 2);
        source = scaled;
      }
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, source);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
      if (aniso) {
        const maxAniso = gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number;
        gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, maxAniso));
      }
      texture.width = source.width;
      texture.height = source.height;
      texture.ready = true;
      hooks.onStatus('');
      hooks.onReady();
    };
    image.onerror = () => {
      if (!disposed) hooks.onStatus('Night-lights image could not load.');
    };
    hooks.onStatus('Loading NASA night lights…');
    image.src = publicUrl(maxSize >= FULL_IMAGE.minTextureSize ? FULL_IMAGE.file : SMALL_IMAGE);
  }

  return {
    render({ on, sun, width, height, scale, rot }) {
      canvas.style.display = on && texture.ready ? 'block' : 'none';
      if (!on) return;
      if (!texture.ready) {
        load();
        return;
      }
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.uniform1i(uniform.tex, 0);
      gl.uniform2f(uniform.texSize, texture.width, texture.height);
      gl.uniform2f(uniform.center, canvas.width / 2, canvas.height / 2);
      gl.uniform1f(uniform.scale, scale);
      gl.uniform1f(uniform.H, canvas.height);
      gl.uniform1f(uniform.cphi, Math.cos(rot[1] * RAD));
      gl.uniform1f(uniform.sphi, Math.sin(rot[1] * RAD));
      gl.uniform1f(uniform.lam, rot[0] * RAD);
      gl.uniform1f(uniform.gain, sun ? 1.05 : 1.0);
      if (sun) {
        const [x, y, z] = unitVector(sun);
        gl.uniform3f(uniform.sun, x, y, z);
        gl.uniform1f(uniform.useSun, 1);
      } else {
        gl.uniform1f(uniform.useSun, 0);
      }
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    },

    dispose() {
      disposed = true;
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
}
