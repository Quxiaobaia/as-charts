import {
  type ComposedShader,
  type ShaderEnablement,
  type ShaderSlot,
  ShaderComposer,
  slotMarker,
} from '../ShaderComposer';

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
 * Pixel-space → clip-space helper, written into the `transform` position.
 *
 * Input coordinates follow the canvas convention (origin top-left, **y down**),
 * which is also the convention of mouse events, so picking and hit-testing need
 * no flip. The projection flips y once, here, and nowhere else.
 */
export const PIXEL_TO_CLIP_GLSL = `vec2 projectPoint(vec2 point, vec2 resolution) {
  vec2 uv = point / resolution;
  return vec2(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
}`;

/** Identity projection, for callers that already work in clip space. */
export const CLIP_SPACE_GLSL = `vec2 projectPoint(vec2 point, vec2 resolution) {
  return point;
}`;

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

export const TRIANGLE_FRAGMENT_SLOTS: Readonly<Record<string, ShaderSlot>> = {
  'color.base': {
    at: 'colorFragment',
    code: '  colorFragment = vec4(vColor, 1.0);',
  },
  /**
   * Blend the base colour toward a highlight colour.
   *
   * `requires: ['color.base']` is load-bearing: it is what guarantees the base
   * assignment is emitted before this mix, so enabling highlight cannot produce a
   * blend against a zero-initialised colour.
   */
  'color.highlight': {
    at: 'colorFragment',
    requires: ['color.base'],
    code: '  colorFragment.rgb = mix(colorFragment.rgb, vec3({{r}}, {{g}}, {{b}}), {{strength}});',
  },
  /** Multiplies alpha, so it must also run after the base assignment. */
  'color.opacity': {
    at: 'colorFragment',
    requires: ['color.base'],
    code: '  colorFragment.a *= {{opacity}};',
  },
  /**
   * The default for the `antiAlias` well: no coverage falloff.
   *
   * M0 geometry is axis-aligned triangles, which need no analytic AA. The
   * position exists now so that line rendering (M1) can add `antiAlias.edge`
   * using screen-space derivatives **without editing the fragment template** —
   * the reason a public well is worth reserving before it has two occupants.
   */
  'antiAlias.off': {
    at: 'antiAlias',
    code: '  antiAliasFactor = 1.0;',
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
