import {
  type ComposedShader,
  type ShaderEnablement,
  type ShaderSlot,
  ShaderComposer,
  slotMarker,
} from '../ShaderComposer';
import { CLIP_SPACE_GLSL, PIXEL_TO_CLIP_GLSL } from './projection';
import { SHADING_FRAGMENT_SLOTS } from './shading';

/**
 * The M0 triangle pipeline's shader definition.
 *
 * It is deliberately tiny — three instanced triangles — because the point of M0
 * is to prove the *mechanism*, not to draw anything interesting. Three things
 * worth reading here:
 *
 * 1. **Positions, not string editing.** The templates declare where code may go;
 *    slot bodies are plain GLSL functions of their parameters.
 * 2. **Chained writes into one well.** `color.base`, `color.highlight` and
 *    `color.opacity` all target the same `colorFragment` position. LCJS achieves
 *    the same by repeatedly `lastIndexOf`-ing `"colorFragment ="`; here the order
 *    is declared with `requires` and verified.
 * 3. **Optional positions.** `depth` is a no-op for 2D but becomes meaningful the
 *    moment geometry needs sorting, and costs nothing while disabled — its marker
 *    is removed rather than left as dead code.
 */

/** Vertex attribute locations. Kept in one place so VAO setup cannot drift. */
export const TRIANGLE_ATTRIB = {
  /** Per-vertex triangle corner in unit space (3 vertices per instance). */
  position: 0,
  /** Per-instance placement offset, in pixels. */
  offset: 1,
  /** Per-instance RGB colour. */
  color: 2,
  /** Per-instance scale applied to `aPosition`. */
  size: 3,
} as const;

/**
 * The projection pair is shared with the line pipeline — see
 * `./projection.ts`, which owns both directions and the "flip y exactly once"
 * invariant. Re-exported here because this module's public surface predates the
 * extraction and callers import it from here.
 */
export { CLIP_SPACE_GLSL, PIXEL_TO_CLIP_GLSL };

/**
 * The fragment wells are shared with the line pipeline — see `./shading.ts` for
 * why the ordering-critical `color.*` slots live in one place. Re-exported under
 * this module's historical name.
 */
export const TRIANGLE_FRAGMENT_SLOTS = SHADING_FRAGMENT_SLOTS;

export const TRIANGLE_VERTEX_TEMPLATE = `#version 300 es
precision highp float;

layout(location = ${String(TRIANGLE_ATTRIB.position)}) in vec2 aPosition;
layout(location = ${String(TRIANGLE_ATTRIB.offset)}) in vec2 aOffset;
layout(location = ${String(TRIANGLE_ATTRIB.color)}) in vec3 aColor;
layout(location = ${String(TRIANGLE_ATTRIB.size)}) in float aSize;

uniform vec2 uResolution;

out vec3 vColor;

${slotMarker('transform')}

void main() {
  vec2 position = aPosition * aSize + aOffset;
  gl_Position = vec4(projectPoint(position, uResolution), 0.0, 1.0);
  vColor = aColor;
${slotMarker('depth')}
}
`;

export const TRIANGLE_FRAGMENT_TEMPLATE = `#version 300 es
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

export const TRIANGLE_VERTEX_SLOTS: Readonly<Record<string, ShaderSlot>> = {
  'transform.pixel': {
    at: 'transform',
    code: PIXEL_TO_CLIP_GLSL,
  },
  'transform.clip': {
    at: 'transform',
    code: CLIP_SPACE_GLSL,
  },
  depth: {
    at: 'depth',
    code: '  gl_Position.z = {{depth}};',
  },
};

export const triangleVertexComposer = new ShaderComposer(TRIANGLE_VERTEX_SLOTS);
export const triangleFragmentComposer = new ShaderComposer(TRIANGLE_FRAGMENT_SLOTS);

export interface TriangleShaderOptions {
  /**
   * Input coordinate space of `aPosition + aOffset`.
   * `'pixel'` (default) is y-down canvas pixels; `'clip'` is already NDC.
   */
  readonly space?: 'pixel' | 'clip';
  /** Uniform alpha multiplier in `[0, 1]`. */
  readonly opacity?: number;
  /** Hover highlight blended over the per-instance colour. */
  readonly highlight?: {
    readonly r: number;
    readonly g: number;
    readonly b: number;
    readonly strength: number;
  };
  /** Clip-space depth. Only emitted when explicitly requested. */
  readonly depth?: number;
}

/** The full shader set for one triangle-pipeline variant. */
export interface TriangleShaders {
  readonly vertex: ComposedShader;
  readonly fragment: ComposedShader;
  /** Combined cache key for the pair. */
  readonly key: string;
}

/**
 * Assemble both stages for a feature set.
 *
 * Pure and deterministic: the same options always yield the same source and the
 * same hash, which is what lets the program cache and the shader snapshot test
 * do their jobs.
 */
export function buildTriangleShaders(options: TriangleShaderOptions = {}): TriangleShaders {
  const vertexEnabled: ShaderEnablement[] = [
    options.space === 'clip' ? 'transform.clip' : 'transform.pixel',
  ];
  if (options.depth !== undefined) {
    vertexEnabled.push(['depth', { depth: options.depth }]);
  }

  const fragmentEnabled: ShaderEnablement[] = ['color.base'];
  if (options.highlight !== undefined) {
    const { r, g, b, strength } = options.highlight;
    fragmentEnabled.push(['color.highlight', { r, g, b, strength }]);
  }
  if (options.opacity !== undefined) {
    fragmentEnabled.push(['color.opacity', { opacity: options.opacity }]);
  }
  fragmentEnabled.push('antiAlias.off');

  const vertex = triangleVertexComposer.compose({
    name: 'as-charts/triangle.vertex',
    template: TRIANGLE_VERTEX_TEMPLATE,
    enabled: vertexEnabled,
  });
  const fragment = triangleFragmentComposer.compose({
    name: 'as-charts/triangle.fragment',
    template: TRIANGLE_FRAGMENT_TEMPLATE,
    enabled: fragmentEnabled,
  });

  return Object.freeze({ vertex, fragment, key: `${vertex.hash}:${fragment.hash}` });
}
