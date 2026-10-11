/**
 * as-charts — a WebGL2 charting engine for large-scale scientific plotting and
 * industrial real-time monitoring.
 *
 * ## Design commitments
 *
 * - **WebGL2 only.** No GL1 fallback and therefore no dual-source shader paths.
 *   Optional features are probed individually and degrade one at a time.
 * - **Zero runtime dependencies.** Everything in the bundle is intentionally ours.
 * - **Offscreen work is inferred, never guessed.** Every stage of a frame checks a
 *   dirty bit and returns early; the biggest win is the frame that never happens.
 * - **Data fidelity outranks frame rate.** Degradation may reduce visual cost,
 *   never the number of samples or the sampling algorithm. In an alarm dashboard,
 *   dropping a spike is worse than dropping a frame.
 * - **Nothing is dropped silently.** Conditions surface through
 *   {@link Diagnostics}; structural mistakes throw at construction.
 *
 * @packageDocumentation
 */

export {
  Dirty,
  DirtyAll,
  describeDirty,
  hasDirty,
  propagateDirty,
  shouldRender,
} from './core/dirty';
export type { DirtyFlags } from './core/dirty';

export { ID_SPACE_CAPACITY, IdSpace, type IdGrant, type IdRange } from './core/IdSpace';

export {
  MutableDrawCall,
  MutablePointSource,
  isMergeable,
  type DrawCall,
  type PointSource,
  type PointSourceKind,
  type UniformWriter,
} from './core/DrawCall';

export { DrawList, type DrawGroup } from './core/DrawList';

export { orthographicTransform, type Domain } from './core/transform';

export {
  DiagnosticError,
  Diagnostics,
  type Diagnostic,
  type DiagnosticListener,
  type DiagnosticsLevel,
} from './core/Diagnostics';

export {
  ShaderComposer,
  ShaderComposeError,
  formatGlslConstant,
  slotMarker,
  type ComposedShader,
  type ShaderComposeErrorCode,
  type ShaderEnablement,
  type ShaderInput,
  type ShaderParams,
  type ShaderSlot,
} from './core/ShaderComposer';

export { fnv1a32, hashHex } from './core/hash';

export { ResourcePool, type ResourceKind, type ResourceSnapshot } from './core/ResourcePool';

export {
  FrameScheduler,
  type FrameRenderFn,
  type SchedulerHost,
  type SchedulerOptions,
  type SchedulerStats,
} from './core/FrameScheduler';

export {
  auditCapabilities,
  probeCapabilities,
  resolveDevicePixelRatio,
  type Capabilities,
  type CapabilityFeature,
  type CapabilityReport,
} from './core/capabilities';

export { CLIP_SPACE_GLSL, CLIP_TO_PIXEL_GLSL, PIXEL_TO_CLIP_GLSL } from './core/shader/projection';

export {
  LINE_ATTRIB,
  LINE_FRAGMENT_SLOTS,
  LINE_FRAGMENT_TEMPLATE,
  LINE_VERTEX_SLOTS,
  LINE_VERTEX_TEMPLATE,
  buildLineShaders,
  lineFragmentComposer,
  lineVertexComposer,
  type LinePointSource,
  type LineShaderOptions,
  type LineShaders,
} from './core/shader/line';

export { SHADING_FRAGMENT_SLOTS } from './core/shader/shading';

export {
  TRIANGLE_ATTRIB,
  TRIANGLE_FRAGMENT_SLOTS,
  TRIANGLE_FRAGMENT_TEMPLATE,
  TRIANGLE_VERTEX_SLOTS,
  TRIANGLE_VERTEX_TEMPLATE,
  buildTriangleShaders,
  triangleFragmentComposer,
  triangleVertexComposer,
  type TriangleShaderOptions,
  type TriangleShaders,
} from './core/shader/triangle';

export { Program, ProgramCache, ShaderCompileError, type ProgramSpec } from './renderer/Program';

export {
  Renderer,
  type CanvasLike,
  type LineLayerRequest,
  type RendererOptions,
  type RendererStats,
} from './renderer/Renderer';

export { TriangleLayer, type TriangleLayerOptions } from './layers/TriangleLayer';

export {
  LineLayer,
  type LineLayerContext,
  type LineLayerOptions,
  type LineSeriesInput,
  type LineSeriesStyle,
} from './layers/LineLayer';

// The data layer. Kept in the main entry for now; `src/data/index.ts` exists so
// it can be split into an `as-charts/data` subpath without touching import sites.
export {
  DataSet,
  MinmaxWorkspace,
  RingBuffer,
  assertLogDomain,
  categoryScale,
  categoryTicks,
  classify,
  computeBounds,
  createScale,
  describeSkips,
  linearTicks,
  logTicks,
  minmaxDownsample,
  reportSkips,
  scaleOver,
  tickStep,
  timeTicks,
  type Bounds,
  type BoundsOptions,
  type BoundsResult,
  type DownsampleResult,
  type MinmaxOptions,
  type SampleSkipKind,
  type Scale,
  type ScaleKind,
  type ScaleOptions,
  type SkipAxis,
  type SkipDiagnostic,
  type SkipKind,
  type TickSet,
  type TimeUnit,
  type Vec,
} from './data/index';

/** Library version, replaced at build time by the bundler. */
export const VERSION = '0.0.0';
