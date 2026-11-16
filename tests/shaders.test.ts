import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { UNIFORM_NAMES } from '../src/globe/lightsGL';
import fragmentSource from '../src/globe/shaders/lights.frag.glsl?raw';
import vertexSource from '../src/globe/shaders/lights.vert.glsl?raw';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Names declared as `uniform <type> a, b, c;` in a GLSL source. */
function declaredUniforms(source: string): string[] {
  return [...source.matchAll(/uniform\s+\w+\s+([^;]+);/g)].flatMap((m) =>
    (m[1] ?? '').split(',').map((name) => name.trim()),
  );
}

describe('night-lights shaders', () => {
  it('start with the #version directive, which must be the very first bytes', () => {
    expect(vertexSource.startsWith('#version 300 es\n')).toBe(true);
    expect(fragmentSource.startsWith('#version 300 es\n')).toBe(true);
  });

  it('declare exactly the uniforms the renderer sets', () => {
    expect(declaredUniforms(fragmentSource).sort()).toEqual([...UNIFORM_NAMES].sort());
  });

  it('feeds the vertex shader a vec2 attribute called p', () => {
    expect(vertexSource).toMatch(/in vec2 p;/);
  });

  // The shader was moved out of legacy/index.html unchanged. If you edit it on purpose,
  // update these hashes in the same commit.
  it('are unchanged from the legacy page', () => {
    expect(sha256(vertexSource)).toBe(
      '13325b6d00a060d570d9deeaecded411460b83ebedb51f0593d3b85976cf53f4',
    );
    expect(sha256(fragmentSource)).toBe(
      '37701406dd413b5efbe48ea691f52ced1331c636196af0b7a744a847d02c4adb',
    );
  });
});
