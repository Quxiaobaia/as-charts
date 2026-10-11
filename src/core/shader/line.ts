import {
  type ComposedShader,
  type ShaderEnablement,
  type ShaderSlot,
  ShaderComposer,
  slotMarker,
} from '../ShaderComposer';
import { CLIP_TO_PIXEL_GLSL, PIXEL_TO_CLIP_GLSL } from './projection';
import { SHADING_FRAGMENT_SLOTS } from './shading';

/**
 * The line pipeline: one instanced quad per segment, `TRIANGLE_STRIP`.
 *
 * ## The single seam
 *
 * Contract **C2** requires the `attribute` and `texture` data channels to share
 * one descriptor type, with the difference expressible in exactly one field.
 * This module honours that literally: the vertex template has **one** marker
 * position, `pointFetch`, and both channels emit their entire difference —
 * declarations, texture fetch, accessors — into it. Everything after it, the
 * whole of `main()`, is byte-identical between the channels.
 *
 * That is what makes "the two channels render the same pixels" a *structural*
 * proposition instead of a hope: strip the slot body out of both composed
 * sources and the remainders must be equal. `tests/line-shader.test.ts` asserts
 * exactly that.
 *
 * ## Screen-space normals, and two corrections to the design document
 *
 * The quad is built in screen pixels so line width is independent of zoom: the
 * endpoints go data → clip (via `uTransform`) → pixels, the direction and normal
 * are computed there, and the result is projected back. Two details in the
 * original sketch were wrong and are fixed here.
 *
 * **1. The pixel conversion was off by a factor of two.** The sketch wrote
 * `sA = clip * uViewportPx`, which makes one "unit" worth half a pixel
 * (`clip ∈ [-1,1]` covers the whole viewport, so `clip * W` spans `2W`). With
 * `offset = normal * (corner.y * thickness * 0.5)` the errors compound to a
 * quarter: asking for 4 px draws 1 px. Going through the real, invertible pair
 * in `projection.ts` fixes it and keeps the y flip in one place.
 *
 * **2. A degenerate quad cannot draw a point without an along-axis term.** If
 * only `corner.y` offsets along the normal, then `A == B` collapses all four
 * corners onto one vertical bar of zero width — invisible. Offsetting
 * `corner.x` along the segment direction as well makes the same shader cover
 * both primitives with no branch: a real segment becomes a quad with square caps
 * (which also closes the notch at each joint, where two segments meet at an
 * angle), and a degenerate one becomes a `t × t` square centred on the point.
 * That is the document's stated intent for "one shader covers line and point",
 * and it only holds with both terms.
 *
 * ## What is deliberately not here
 *
 * Analytic edge antialiasing. It needs `gl.enable(BLEND)`, blend is global GL
 * state, and a layer that turns it on is a layer that changes how every later
 * draw composites. The `antiAlias` well and its identity slot exist (see
 * `shading.ts`); the coverage slot lands with the layout owner in M1-c.
 */

/** Vertex attribute locations. Kept in one place so VAO setup cannot drift. */
export const LINE_ATTRIB = {
  /** Per-vertex quad corner: `(-1,-1) (1,-1) (-1,1) (1,1)`. */
  corner: 0,
  /**
   * The point source, location 1 in **both** channels — the one place they
   * differ. Attribute channel: `vec4(a)` and `vec4(b)` endpoint positions.
   * Texture channel: a single `uint` flat index; `b` is the texel after `a`.
   */
  pointSource: 1,
  /** Per-instance RGB colour. Per-instance, not uniform — see C2 rule 6. */
  color: 2,
  /**
   * Per-instance stroke width in device pixels.
   *
   * Per-instance rather than a uniform for the same reason as colour: two series
   * with different widths must still batch into one draw call.
   */
  thickness: 3,
  /** Per-instance pick id of the segment's first endpoint (C2 rule 6). */
  id: 4,
} as const;

/** Which channel supplies point positions. */
export type LinePointSource = 'attribute' | 'texture';

export const LINE_VERTEX_TEMPLATE = `#version 300 es
precision highp float;

layout(location = ${String(LINE_ATTRIB.corner)}) in vec2 aCorner;
layout(location = ${String(LINE_ATTRIB.color)}) in vec3 aColor;
layout(location = ${String(LINE_ATTRIB.thickness)}) in float aThickness;
layout(location = ${String(LINE_ATTRIB.id)}) in uint aId;

uniform mat4 uTransform;
uniform vec2 uViewportPx;

out vec3 vColor;
flat out uint vId;

${slotMarker('pointFetch')}

${PIXEL_TO_CLIP_GLSL}

${CLIP_TO_PIXEL_GLSL}

void main() {
  vec4 clipA = uTransform * vec4(lineEndA(), 0.0, 1.0);
  vec4 clipB = uTransform * vec4(lineEndB(), 0.0, 1.0);
  vec2 pixelA = unprojectPoint(clipA.xy, uViewportPx);
  vec2 pixelB = unprojectPoint(clipB.xy, uViewportPx);

  vec2 direction = normalize(pixelB - pixelA + vec2(1e-6, 0.0));
  vec2 normal = vec2(-direction.y, direction.x);

  float halfThickness = aThickness * 0.5;
  vec2 center = mix(pixelA, pixelB, (aCorner.x + 1.0) * 0.5);
  vec2 offset = direction * (aCorner.x * halfThickness) + normal * (aCorner.y * halfThickness);

  gl_Position = vec4(projectPoint(center + offset, uViewportPx), 0.0, 1.0);
  vColor = aColor;
  vId = aId;
}
`;

export const LINE_FRAGMENT_TEMPLATE = `#version 300 es
precision highp float;

in vec3 vColor;
out vec4 fragColor;

void main() {
  vec4 colorFragment = vec4(0.0);
  float antiAliasFactor = 1.0;

${slotMarker('colorFragment')}
${slotMarker('antiAlias')}

  if (antiAliasFactor <= 0.0) discard;
  fragColor = vec4(colorFragment.rgb, colorFragment.a * antiAliasFactor);
}
`;

/**
 * The two channels, and nothing else.
 *
 * `uTexelsPerRow` is an `int` rather than a `vec2` size because the only thing
 * the shader needs is the divisor that turns a flat index into `(x, y)`. A row
 * count would be dead information.
 */
export const LINE_VERTEX_SLOTS: Readonly<Record<string, ShaderSlot>> = {
  'pointFetch.attribute': {
    at: 'pointFetch',
    code: `layout(location = ${String(LINE_ATTRIB.pointSource)}) in vec4 aSegment;

vec2 lineEndA() { return aSegment.xy; }
vec2 lineEndB() { return aSegment.zw; }`,
  },
  'pointFetch.texture': {
    at: 'pointFetch',
    code: `layout(location = ${String(LINE_ATTRIB.pointSource)}) in uint aPointIndex;

uniform sampler2D uPointData;
uniform int uTexelsPerRow;

vec2 fetchPoint(uint index) {
  int flatIndex = int(index);
  return texelFetch(
    uPointData,
    ivec2(flatIndex % uTexelsPerRow, flatIndex / uTexelsPerRow),
    0
  ).xy;
}

vec2 lineEndA() { return fetchPoint(aPointIndex); }
vec2 lineEndB() { return fetchPoint(aPointIndex + 1u); }`,
  },
};

/** Same wells as every other 2D primitive — see `shading.ts`. */
export const LINE_FRAGMENT_SLOTS = SHADING_FRAGMENT_SLOTS;

export const lineVertexComposer = new ShaderComposer(LINE_VERTEX_SLOTS);
export const lineFragmentComposer = new ShaderComposer(LINE_FRAGMENT_SLOTS);

export interface LineShaderOptions {
  /** Which data channel supplies point positions. No default: the choice is the point. */
  readonly pointSource: LinePointSource;
  /**
   * Uniform alpha multiplier in `[0, 1]`.
   *
   * `| undefined` is explicit because `exactOptionalPropertyTypes` is on and the
   * renderer forwards a caller's optional field straight through. Spelling out the
   * union is the sanctioned way to say "absent and undefined mean the same thing
   * here", and it is true of all three optional fields.
   */
  readonly opacity?: number | undefined;
  /** Hover highlight blended over the per-instance colour. */
  readonly highlight?:
    | {
        readonly r: number;
        readonly g: number;
        readonly b: number;
        readonly strength: number;
      }
    | undefined;
}

/** The full shader set for one line-pipeline variant. */
export interface LineShaders {
  readonly vertex: ComposedShader;
  readonly fragment: ComposedShader;
  /** Combined cache key for the pair. */
  readonly key: string;
  readonly pointSource: LinePointSource;
}

/**
 * Assemble both stages for one channel.
 *
 * Pure and deterministic, like the triangle builder: the same options always
 * yield the same source and the same hash. Note that the *fragment* stage is
 * identical for both channels — the channel only ever reaches the vertex stage.
 */
export function buildLineShaders(options: LineShaderOptions): LineShaders {
  const vertexEnabled: ShaderEnablement[] = [
    options.pointSource === 'texture' ? 'pointFetch.texture' : 'pointFetch.attribute',
  ];

  const fragmentEnabled: ShaderEnablement[] = ['color.base'];
  if (options.highlight !== undefined) {
    const { r, g, b, strength } = options.highlight;
    fragmentEnabled.push(['color.highlight', { r, g, b, strength }]);
  }
  if (options.opacity !== undefined) {
    fragmentEnabled.push(['color.opacity', { opacity: options.opacity }]);
  }
  fragmentEnabled.push('antiAlias.off');

  const vertex = lineVertexComposer.compose({
    name: `as-charts/line.vertex.${options.pointSource}`,
    template: LINE_VERTEX_TEMPLATE,
    enabled: vertexEnabled,
  });
  const fragment = lineFragmentComposer.compose({
    name: 'as-charts/line.fragment',
    template: LINE_FRAGMENT_TEMPLATE,
    enabled: fragmentEnabled,
  });

  return Object.freeze({
    vertex,
    fragment,
    key: `${vertex.hash}:${fragment.hash}`,
    pointSource: options.pointSource,
  });
}
