import { describe, expect, it } from 'vitest';

import {
  LINE_ATTRIB,
  LINE_FRAGMENT_SLOTS,
  LINE_FRAGMENT_TEMPLATE,
  LINE_VERTEX_SLOTS,
  LINE_VERTEX_TEMPLATE,
  buildLineShaders,
  type LinePointSource,
} from '../src/core/shader/line';
import { slotMarker } from '../src/core/ShaderComposer';
import { SHADING_FRAGMENT_SLOTS } from '../src/core/shader/shading';
import { TRIANGLE_FRAGMENT_SLOTS } from '../src/core/shader/triangle';

/**
 * The dual-channel structural gate.
 *
 * `自研图表库_M0_M1实施设计` §1.2 asks for both channels in M1 with one shared
 * descriptor type, and §6.4 item 7 asks for the two channels to be
 * **pixel-identical** on the same dataset. A pixel comparison can only run on a
 * real GPU (see `tests/e2e/line.ts`), so this suite proves the *reason* it can be
 * expected to hold: the two channels differ in exactly one region of one shader,
 * and everything that decides where a pixel lands is outside that region.
 *
 * The strongest assertion here is the strip test. If somebody later moves a
 * channel-specific branch into `main()`, the pixel comparison would still pass
 * for the test data and diverge for real data; the strip test fails immediately.
 */

const CHANNELS: readonly LinePointSource[] = ['attribute', 'texture'];

/**
 * Build one value per channel, as a **tuple**.
 *
 * Not `CHANNELS.map(...)` with destructuring: `map` returns an array, and under
 * `noUncheckedIndexedAccess` destructuring an array gives `T | undefined`, which
 * would force a non-null assertion at every call site in a suite whose whole
 * point is to compare two concrete values.
 */
function perChannel<T>(build: (channel: LinePointSource) => T): [T, T] {
  return [build('attribute'), build('texture')];
}

/** The slot body each channel emits at the `pointFetch` position. */
function slotBody(channel: LinePointSource): string {
  const slot = LINE_VERTEX_SLOTS[`pointFetch.${channel}`];
  const code = slot?.code;
  if (typeof code !== 'string') throw new Error('the pointFetch slot must be a static string');
  return code;
}

/** Remove the channel-specific region, leaving everything the channels share. */
function withoutPointFetch(source: string, channel: LinePointSource): string {
  return source.replace(slotBody(channel), '<pointFetch>');
}

describe('line shaders · one seam, two channels', () => {
  it('declares exactly one pointFetch marker, so there is exactly one seam', () => {
    const marker = slotMarker('pointFetch');
    const occurrences = LINE_VERTEX_TEMPLATE.split(marker).length - 1;
    expect(occurrences).toBe(1);
  });

  it('composes vertex sources that are identical once the seam is removed', () => {
    const [attribute, texture] = perChannel((channel) =>
      withoutPointFetch(buildLineShaders({ pointSource: channel }).vertex.code, channel),
    );
    expect(attribute).toBe(texture);
  });

  it('composes byte-identical fragment stages for both channels', () => {
    const [attribute, texture] = perChannel(
      (channel) => buildLineShaders({ pointSource: channel }).fragment,
    );
    expect(attribute.code).toBe(texture.code);
    expect(attribute.hash).toBe(texture.hash);
    // The channel cannot leak into the fragment stage at all: the fragment
    // template has no seam for it to reach through.
    expect(LINE_FRAGMENT_TEMPLATE).not.toContain('aSegment');
    expect(LINE_FRAGMENT_TEMPLATE).not.toContain('aPointIndex');
    expect(LINE_FRAGMENT_TEMPLATE).not.toContain('uPointData');
  });

  it('differs between channels in the vertex stage, so the variants are real', () => {
    const [attribute, texture] = perChannel(
      (channel) => buildLineShaders({ pointSource: channel }).vertex,
    );
    expect(attribute.hash).not.toBe(texture.hash);
    expect(attribute.code).not.toBe(texture.code);
  });

  it('names the variant after its channel, so a cache key is diagnosable', () => {
    expect(buildLineShaders({ pointSource: 'attribute' }).vertex.name).toContain('attribute');
    expect(buildLineShaders({ pointSource: 'texture' }).vertex.name).toContain('texture');
  });

  it('keeps the two channels on the same point-source attribute location', () => {
    // Both declare `layout(location = LINE_ATTRIB.pointSource)` — differing there
    // would mean the VAO setup had to branch per channel, which is the beginning
    // of the duplicated implementation the contract exists to prevent.
    for (const channel of CHANNELS) {
      expect(slotBody(channel)).toContain(`layout(location = ${String(LINE_ATTRIB.pointSource)})`);
    }
  });

  it('is deterministic', () => {
    for (const channel of CHANNELS) {
      expect(buildLineShaders({ pointSource: channel }).key).toBe(
        buildLineShaders({ pointSource: channel }).key,
      );
    }
  });
});

describe('line shaders · contract C2 rule 6', () => {
  it('takes colour and id from per-instance attributes, never from a uniform', () => {
    const { vertex } = buildLineShaders({ pointSource: 'attribute' });
    expect(vertex.code).toContain(`layout(location = ${String(LINE_ATTRIB.color)}) in vec3 aColor`);
    expect(vertex.code).toContain(`layout(location = ${String(LINE_ATTRIB.id)}) in uint aId`);
    // The uniforms a merge-hostile implementation would have used. Their absence
    // is what lets eight differently-coloured series draw in one call.
    expect(vertex.code).not.toContain('uColor');
    expect(vertex.code).not.toContain('uFirstId');
    expect(vertex.code).not.toContain('uniform vec3 aColor');
  });

  it('takes stroke width per instance too, so widths can differ within a batch', () => {
    const { vertex } = buildLineShaders({ pointSource: 'attribute' });
    expect(vertex.code).toContain(
      `layout(location = ${String(LINE_ATTRIB.thickness)}) in float aThickness`,
    );
    expect(vertex.code).not.toContain('uThicknessPx');
  });

  it('carries the pick id through a flat integer varying', () => {
    const { vertex } = buildLineShaders({ pointSource: 'attribute' });
    // `flat`, because an interpolated uint would resolve to a blend of two
    // entities' ids — the exact failure C1 exists to prevent.
    expect(vertex.code).toContain('flat out uint vId');
    expect(vertex.code).toContain('vId = aId;');
  });
});

describe('line shaders · the screen-space construction', () => {
  it('converts through the invertible pixel pair, not a bare viewport multiply', () => {
    const { vertex } = buildLineShaders({ pointSource: 'attribute' });
    expect(vertex.code).toContain('unprojectPoint(clipA.xy, uViewportPx)');
    expect(vertex.code).toContain('unprojectPoint(clipB.xy, uViewportPx)');
    expect(vertex.code).toContain('projectPoint(center + offset, uViewportPx)');
    // The document's original sketch multiplied by the viewport directly, which
    // makes one unit worth half a pixel and quarters the stroke width once the
    // half-thickness factor is applied. This is the guard against reintroducing it.
    expect(vertex.code).not.toContain('clipA.xy / clipA.w * uViewportPx');
  });

  it('offsets along the segment as well as across it', () => {
    const { vertex } = buildLineShaders({ pointSource: 'attribute' });
    // `direction` gives the square caps that close the notch at a joint, and it
    // is the only reason a degenerate segment (A == B) renders as a square
    // instead of a zero-width bar. Dropping this line silently deletes the
    // "one shader covers line and point" property.
    expect(vertex.code).toContain('direction * (aCorner.x * halfThickness)');
    expect(vertex.code).toContain('normal * (aCorner.y * halfThickness)');
  });

  it('counts four strip vertices per instance', () => {
    const { vertex } = buildLineShaders({ pointSource: 'attribute' });
    expect(vertex.code).toContain('aCorner');
    // Three vertices would draw one triangle per segment; the corner set is four
    // and the draw mode is TRIANGLE_STRIP, which is asserted in the layer tests.
    expect(LINE_VERTEX_TEMPLATE).toContain('in vec2 aCorner');
  });
});

describe('line shaders · the fragment wells are shared, not copied', () => {
  it('uses the same slot objects as the triangle pipeline', () => {
    // Two copies of `color.*` is how "the two primitives render the same colour"
    // quietly stops being true — the `requires: ['color.base']` ordering is the
    // part that gets lost in a copy.
    expect(LINE_FRAGMENT_SLOTS).toBe(SHADING_FRAGMENT_SLOTS);
    expect(TRIANGLE_FRAGMENT_SLOTS).toBe(SHADING_FRAGMENT_SLOTS);
  });

  it('reserves the antiAlias well without filling it with coverage', () => {
    const { fragment } = buildLineShaders({ pointSource: 'attribute' });
    expect(fragment.code).toContain('antiAliasFactor = 1.0;');
    // Analytic edge coverage needs `gl.enable(BLEND)`, which is global GL state and
    // belongs to the layout owner in M1-c. Asserting its absence keeps a later
    // half-landed version from arriving without its blend-state owner.
    expect(fragment.code).not.toContain('fwidth');
  });

  it('applies opacity and highlight into the same well, in dependency order', () => {
    const { fragment } = buildLineShaders({
      pointSource: 'attribute',
      opacity: 0.5,
      highlight: { r: 1, g: 0, b: 0, strength: 0.25 },
    });
    const base = fragment.code.indexOf('colorFragment = vec4(vColor, 1.0);');
    const highlight = fragment.code.indexOf('mix(colorFragment.rgb');
    const opacity = fragment.code.indexOf('colorFragment.a *=');
    expect(base).toBeGreaterThanOrEqual(0);
    expect(highlight).toBeGreaterThan(base);
    expect(opacity).toBeGreaterThan(base);
  });
});
