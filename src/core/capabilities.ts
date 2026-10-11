/**
 * GPU capability probing.
 *
 * This is a deliberate departure from LCJS. LCJS ships a **full WebGL1
 * fallback**: it authors shaders in GLSL ES 1.0 and mechanically transpiles them
 * to 3.00 ES at runtime, keeps `ANGLE_instanced_arrays` and `OES_texture_float`
 * code paths alive, and mimics `texelFetch` with half-texel `texture2D` offsets.
 * That is a large, permanent maintenance surface.
 *
 * WebGL2 is now available essentially everywhere, so the fallback is not worth
 * its cost here. What *is* worth keeping is the discipline of probing individual
 * extensions and degrading **one feature at a time**, instead of assuming a
 * monolithic "WebGL1 or WebGL2" world. Each absent feature below has a named,
 * documented fallback rather than a silent behaviour change.
 */
export interface Capabilities {
  /** Always true for a successful construction; kept for reporting. */
  readonly webgl2: boolean;
  readonly maxTextureSize: number;
  readonly maxTextureUnits: number;
  readonly maxVertexAttribs: number;
  /** `MAX_SAMPLES`, 0 when multisampled renderbuffers are unavailable. */
  readonly maxSamples: number;
  /** `EXT_color_buffer_float` — float colour attachments. */
  readonly colorBufferFloat: boolean;
  /** `OES_texture_float_linear` — linear filtering of float textures. */
  readonly textureFloatLinear: boolean;
  /** `WEBGL_multi_draw` — one call for several ranges of the same buffer. */
  readonly multiDraw: boolean;
  /** `EXT_disjoint_timer_query_webgl2` — real GPU timings. */
  readonly timerQuery: boolean;
  /** `EXT_texture_filter_anisotropic`. */
  readonly anisotropicFilter: boolean;
  readonly maxAnisotropy: number;
}

export type CapabilityFeature =
  | 'texture-float-linear'
  | 'color-buffer-float'
  | 'max-samples'
  | 'multi-draw'
  | 'timer-query'
  | 'anisotropic-filter';

export interface CapabilityReport {
  readonly capabilities: Capabilities;
  readonly missing: readonly CapabilityFeature[];
  /** One line per missing feature describing the fallback that will be used. */
  readonly fallbacks: readonly string[];
  readonly degraded: boolean;
}

const FALLBACKS: Readonly<Record<CapabilityFeature, string>> = {
  'texture-float-linear':
    'float data textures fall back to NEAREST filtering, so a data texture cannot be sampled as if it were smooth',
  'color-buffer-float':
    'float render targets unavailable; the picking pass stays on RGBA8, which is the default anyway',
  'max-samples':
    'multisampled renderbuffers unavailable; antialiasing is resolve-only (analytic AA on line edges)',
  'multi-draw':
    'ring-buffer updates issue one draw per contiguous range instead of a single WEBGL_multi_draw call',
  'timer-query':
    'GPU timings unavailable; benchmarks must fall back to gl.finish() and must not run in production',
  'anisotropic-filter': 'texture anisotropy locked to 1; oblique text-atlas sampling gets blurrier',
};

/** Read one extension object, tolerating both array and object forms. */
function extension(gl: WebGL2RenderingContext, name: string): unknown {
  try {
    return gl.getExtension(name);
  } catch {
    return null;
  }
}

/**
 * Probe the context once, at construction.
 *
 * Parameter reads (`MAX_TEXTURE_SIZE` and friends) are cached deliberately:
 * `getParameter` is a synchronous round trip to the GPU process.
 */
export function probeCapabilities(gl: WebGL2RenderingContext): Capabilities {
  // `WebGL2RenderingContext` does not exist outside a browser (Node, workers
  // without the DOM lib). Absence of the global is not evidence of a WebGL1
  // context — the only way to obtain the argument to this function is
  // `getContext('webgl2')` — so the check defaults to true when it cannot run.
  const isWebgl2 =
    typeof WebGL2RenderingContext === 'undefined' || gl instanceof WebGL2RenderingContext;

  const colorBufferFloat = extension(gl, 'EXT_color_buffer_float') !== null;
  const textureFloatLinear = extension(gl, 'OES_texture_float_linear') !== null;
  const multiDraw = extension(gl, 'WEBGL_multi_draw') !== null;
  const timerQuery = extension(gl, 'EXT_disjoint_timer_query_webgl2') !== null;
  const anisotropic = extension(gl, 'EXT_texture_filter_anisotropic') as {
    MAX_TEXTURE_MAX_ANISOTROPY_EXT?: number;
  } | null;

  let maxAnisotropy = 1;
  if (anisotropic !== null && anisotropic.MAX_TEXTURE_MAX_ANISOTROPY_EXT !== undefined) {
    const value = gl.getParameter(anisotropic.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as unknown;
    if (typeof value === 'number' && Number.isFinite(value)) maxAnisotropy = value;
  }

  return Object.freeze({
    webgl2: isWebgl2,
    maxTextureSize: readNumber(gl, gl.MAX_TEXTURE_SIZE, 2048),
    maxTextureUnits: readNumber(gl, gl.MAX_TEXTURE_IMAGE_UNITS, 8),
    maxVertexAttribs: readNumber(gl, gl.MAX_VERTEX_ATTRIBS, 16),
    maxSamples: readNumber(gl, gl.MAX_SAMPLES, 0),
    colorBufferFloat,
    textureFloatLinear,
    multiDraw,
    timerQuery,
    anisotropicFilter: anisotropic !== null,
    maxAnisotropy,
  });
}

function readNumber(gl: WebGL2RenderingContext, pname: number, fallback: number): number {
  try {
    const value = gl.getParameter(pname) as unknown;
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Turn a {@link Capabilities} reading into an explicit list of what will not
 * work, so a caller can log it, assert on it, or surface it in a support bundle.
 *
 * Never silent: a feature that is missing and *not* listed here is a bug in this
 * function, not a tolerable difference.
 */
export function auditCapabilities(capabilities: Capabilities): CapabilityReport {
  const missing: CapabilityFeature[] = [];
  if (!capabilities.textureFloatLinear) missing.push('texture-float-linear');
  if (!capabilities.colorBufferFloat) missing.push('color-buffer-float');
  if (capabilities.maxSamples <= 0) missing.push('max-samples');
  if (!capabilities.multiDraw) missing.push('multi-draw');
  if (!capabilities.timerQuery) missing.push('timer-query');
  if (!capabilities.anisotropicFilter) missing.push('anisotropic-filter');

  return Object.freeze({
    capabilities,
    missing: Object.freeze(missing),
    fallbacks: Object.freeze(missing.map((feature) => FALLBACKS[feature])),
    degraded: missing.length > 0,
  });
}

/**
 * Resolve the device pixel ratio to actually render at.
 *
 * `LightningChart JS` exposes `devicePixelRatio: boolean | number` for the same
 * reason: on a 4K panel the ambient ratio of 3 means nine times the
 * rasterisation cost for detail nobody can resolve. A pixel budget makes that
 * safety automatic instead of leaving it to the caller.
 *
 * @param requested `true`/`undefined` follow the platform, `false` forces 1, a
 *   number pins it.
 * @param maxPixels Upper bound on `cssWidth * cssHeight * ratio²`.
 * @returns A ratio in `(0, requested]`, never below the value that fits the budget
 *   at ratio 1 (a chart too large for the budget still has to render).
 */
export function resolveDevicePixelRatio(
  requested: number | boolean | undefined,
  cssWidth: number,
  cssHeight: number,
  maxPixels = 8_000_000,
): number {
  let ratio: number;
  if (requested === false) {
    ratio = 1;
  } else if (typeof requested === 'number' && Number.isFinite(requested) && requested > 0) {
    ratio = requested;
  } else {
    const ambient = globalThis.devicePixelRatio;
    ratio = typeof ambient === 'number' && Number.isFinite(ambient) && ambient > 0 ? ambient : 1;
  }

  const area = cssWidth * cssHeight;
  if (!Number.isFinite(area) || area <= 0 || !Number.isFinite(maxPixels) || maxPixels <= 0) {
    return ratio;
  }
  if (area <= maxPixels) {
    // area <= maxPixels guarantees ceiling >= 1, so the result never drops below 1.
    const ceiling = Math.sqrt(maxPixels / area);
    if (ratio > ceiling) ratio = ceiling;
  }
  return ratio;
}
