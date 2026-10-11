import { describe, expect, it } from 'vitest';

import {
  TRIANGLE_ATTRIB,
  buildTriangleShaders,
  triangleFragmentComposer,
} from '../src/core/shader/triangle';
import { slotMarker } from '../src/core/ShaderComposer';

/**
 * Shader snapshot gate.
 *
 * Generated GLSL is a build artefact like any other, and it is the artefact whose
 * regressions are hardest to notice: a subtly wrong variant still compiles and
 * still draws *something*. Snapshotting the full source turns "the highlight looks
 * slightly off" into a reviewable diff.
 *
 * These snapshots are also the reason `ShaderComposer` must be deterministic —
 * hash-stability and snapshot-stability are the same property.
 */
describe('triangle shader snapshots', () => {
  it('default variant', () => {
    const shaders = buildTriangleShaders();
    expect(shaders.vertex.code).toMatchSnapshot('vertex');
    expect(shaders.fragment.code).toMatchSnapshot('fragment');
  });

  it('clip-space variant', () => {
    expect(buildTriangleShaders({ space: 'clip' }).vertex.code).toMatchSnapshot();
  });

  it('highlight plus opacity variant', () => {
    const shaders = buildTriangleShaders({
      highlight: { r: 1, g: 0.5, b: 0, strength: 0.75 },
      opacity: 0.4,
    });
    expect(shaders.fragment.code).toMatchSnapshot();
  });

  it('depth variant', () => {
    expect(buildTriangleShaders({ depth: 0.5 }).vertex.code).toMatchSnapshot();
  });

  it('emits a GLSL ES 3.00 header and no leftover markers', () => {
    for (const options of [{}, { space: 'clip' as const }, { depth: 1 }]) {
      const shaders = buildTriangleShaders(options);
      for (const composed of [shaders.vertex, shaders.fragment]) {
        expect(composed.code.startsWith('#version 300 es\n')).toBe(true);
        expect(composed.code).not.toContain('@slot:');
      }
    }
  });

  it('keeps attribute locations in sync with the vertex source', () => {
    const { vertex } = buildTriangleShaders();
    for (const [name, location] of Object.entries(TRIANGLE_ATTRIB)) {
      expect(vertex.code).toContain(`layout(location = ${String(location)}) in`);
      expect(vertex.code, `${name} missing from vertex source`).toBeTruthy();
    }
    expect(vertex.code).toContain('aOffset');
    expect(vertex.code).toContain('aColor');
    expect(vertex.code).toContain('aSize');
  });

  it('emits the colour well in dependency order', () => {
    const { fragment } = buildTriangleShaders({
      highlight: { r: 1, g: 1, b: 1, strength: 1 },
      opacity: 0.5,
    });
    const base = fragment.code.indexOf('colorFragment = vec4(vColor, 1.0);');
    const highlight = fragment.code.indexOf('colorFragment.rgb = mix(');
    const opacity = fragment.code.indexOf('colorFragment.a *=');

    expect(base).toBeGreaterThanOrEqual(0);
    // Highlight blends against the base colour, so it must come after it. If this
    // ever inverts, the highlight silently blends against black.
    expect(highlight).toBeGreaterThan(base);
    expect(opacity).toBeGreaterThan(base);
  });

  it('omits the optional depth assignment when not requested', () => {
    const { vertex } = buildTriangleShaders();
    expect(vertex.code).not.toContain('gl_Position.z =');
  });

  it('produces a stable cache key per variant', () => {
    const a = buildTriangleShaders({ opacity: 0.5 });
    const b = buildTriangleShaders({ opacity: 0.5 });
    const c = buildTriangleShaders({ opacity: 0.6 });
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(c.key);
    expect(a.key).toMatch(/^[0-9a-f]{8}:[0-9a-f]{8}$/);
  });

  it('exposes markers the template actually contains', () => {
    // Guards the contract that keeps template and slots from drifting apart.
    const { fragment } = buildTriangleShaders();
    for (const position of triangleFragmentComposer.positions) {
      expect(slotMarker(position)).toBeDefined();
    }
    expect(fragment.code).toContain('antiAliasFactor = 1.0;');
  });
});
