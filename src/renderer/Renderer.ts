import {
  type Capabilities,
  type CapabilityReport,
  auditCapabilities,
  probeCapabilities,
  resolveDevicePixelRatio,
} from '../core/capabilities';
import { Diagnostics, type DiagnosticsLevel } from '../core/Diagnostics';
import { Dirty, type DirtyFlags, DirtyAll } from '../core/dirty';
import { DrawList } from '../core/DrawList';
import { FrameScheduler, type SchedulerHost, type SchedulerStats } from '../core/FrameScheduler';
import { IdSpace } from '../core/IdSpace';
import { type ResourceSnapshot, ResourcePool } from '../core/ResourcePool';
import { type LineShaderOptions, buildLineShaders } from '../core/shader/line';
import { type TriangleShaderOptions, buildTriangleShaders } from '../core/shader/triangle';
import { LineLayer, type LineLayerOptions } from '../layers/LineLayer';
import { TriangleLayer, type TriangleLayerOptions } from '../layers/TriangleLayer';
import { ProgramCache } from './Program';

/**
 * The subset of `HTMLCanvasElement` the renderer needs.
 *
 * Widened to a structural type on purpose: tests drive a plain object instead of
 * a real canvas, and `OffscreenCanvas` (a future worker-rendering path) satisfies
 * the same shape.
 */
export interface CanvasLike {
  width: number;
  height: number;
  getContext(
    contextId: 'webgl2',
    attributes?: WebGLContextAttributes,
  ): WebGL2RenderingContext | null;
  addEventListener?(type: string, listener: (event: Event) => void): void;
  removeEventListener?(type: string, listener: (event: Event) => void): void;
  readonly clientWidth?: number;
  readonly clientHeight?: number;
}

export interface RendererOptions {
  readonly canvas: CanvasLike;
  /**
   * Frame-rate cap in fps. Defaults to `undefined`, meaning "follow the display
   * refresh rate". Set a number only when a chart genuinely does not need every
   * frame; off-focus charts should instead use a low value such as 10.
   */
  readonly maxFps?: number | undefined;
  /**
   * `true`/`undefined` follow `window.devicePixelRatio`, `false` forces 1, a
   * number pins it. Capped by `maxPixels` so a 4K panel cannot silently cost 9×
   * the rasterisation.
   */
  readonly devicePixelRatio?: number | boolean;
  /** Upper bound on `width × height` in device pixels. */
  readonly maxPixels?: number;
  /**
   * Diagnostics verbosity, or a hub to report into.
   *
   * Pass a {@link Diagnostics} instance to attach telemetry *before* the renderer
   * is constructed — capability probing reports during construction, so a level
   * string alone cannot be observed by a listener. A caller-owned hub is not
   * disposed by {@link Renderer.destroy}.
   *
   * Default `'warn'`.
   */
  readonly diagnostics?: DiagnosticsLevel | Diagnostics;
  /** Skip rendering while `setVisible(false)`. Default `true`. */
  readonly skipOffscreen?: boolean;
  /** Enable MSAA on the default framebuffer. Default `false` — see notes. */
  readonly antialias?: boolean;
  /** Extra WebGL context attributes, merged last. */
  readonly contextAttributes?: WebGLContextAttributes;
  /** Clock injection for tests. */
  readonly host?: SchedulerHost;
}

export interface RendererStats {
  readonly frameCount: number;
  /** GL draw calls issued by the last frame — measured, not promised. */
  readonly drawCalls: number;
  /** Merged draw groups in the last frame's list. */
  readonly drawGroups: number;
  readonly scheduler: SchedulerStats;
  readonly resources: ResourceSnapshot;
  readonly programs: number;
  readonly capabilities: Capabilities;
}

/**
 * What a caller may ask for when creating a line layer.
 *
 * A superset of {@link LineLayerOptions}: the shader options are folded in
 * because the data channel must be chosen once. Two separate option bags would
 * let a caller build `attribute` geometry against a `texture` shader, which
 * renders nothing and points at no cause.
 */
export interface LineLayerRequest extends LineLayerOptions {
  /** Uniform alpha multiplier in `[0, 1]`. */
  readonly opacity?: number;
  /** Hover highlight blended over the per-series colour. */
  readonly highlight?: {
    readonly r: number;
    readonly g: number;
    readonly b: number;
    readonly strength: number;
  };
}

interface LayerBinding {
  readonly upload: () => void;
  /**
   * Append this layer's draw calls to the frame's list.
   *
   * Layers describe *what* to draw; the `DrawList` decides how many GL calls that
   * costs. Reporting a count from each layer, as M0 did, made the draw-call budget
   * a per-layer promise that nobody could verify — the kernel now counts what it
   * actually issued, which is the only number the 32-call dashboard budget can be
   * asserted against.
   */
  readonly collect: (list: DrawList, width: number, height: number) => void;
  readonly dispose: () => void;
}

/**
 * Owns one WebGL2 context and everything drawn with it.
 *
 * ## Scope of M0
 *
 * This is the kernel milestone: context ownership, capability probing, resource
 * accounting, frame scheduling, the shader composer wired to a real program cache,
 * and one instanced geometry pipeline. It exists to make four structural gates
 * assertable — draw-call count, leak-free `destroy()`, zero per-frame allocation,
 * and deterministic shader output — without needing a GPU. Axis, text, picking
 * and the line pipeline land in M1/M2.
 *
 * ## One context per canvas
 *
 * LCJS multiplexes every chart onto a single shared canvas by default and renders
 * each chart into its own offscreen framebuffer, then composites. That buys
 * overlap-friendly layouts and single-image export at the cost of an extra
 * full-screen pass and a framebuffer per chart. We take the other branch: a
 * renderer per canvas, and `viewport` + `scissor` partitioning when several plots
 * share a surface. No FBO, no composite pass.
 */
export class Renderer {
  readonly diagnostics: Diagnostics;
  readonly capabilities: Capabilities;
  readonly capabilityReport: CapabilityReport;

  readonly #gl: WebGL2RenderingContext;
  readonly #canvas: CanvasLike;
  readonly #pool: ResourcePool;
  readonly #programCache: ProgramCache;
  readonly #scheduler: FrameScheduler;
  readonly #drawList: DrawList;
  /**
   * The renderer-wide pick-id axis (C1 rule 2).
   *
   * Owned here rather than per layer because "point 5 of layer 0" has to be
   * unambiguous across a canvas that may hold several charts sharing one axis.
   */
  readonly #ids: IdSpace;
  readonly #devicePixelRatioOption: number | boolean | undefined;
  readonly #maxPixels: number;
  /** False when the caller supplied the hub, which they also own. */
  readonly #ownsDiagnostics: boolean;

  readonly #bindings: LayerBinding[] = [];
  #contextLost = false;
  #destroyed = false;
  #width = 1;
  #height = 1;
  #dpr = 1;
  #drawCalls = 0;
  #frameCount = 0;

  constructor(options: RendererOptions) {
    this.#canvas = options.canvas;
    this.#devicePixelRatioOption = options.devicePixelRatio;
    this.#maxPixels = options.maxPixels ?? 8_000_000;
    this.#ownsDiagnostics = !(options.diagnostics instanceof Diagnostics);
    this.diagnostics =
      options.diagnostics instanceof Diagnostics
        ? options.diagnostics
        : new Diagnostics(options.diagnostics ?? 'warn');

    const attributes: WebGLContextAttributes = {
      // MSAA on the default framebuffer is off by default: the engine's AA story
      // is analytic edge coverage, which costs fragments only where an edge is.
      // Callers that want multisampling can opt in.
      antialias: options.antialias ?? false,
      alpha: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      ...options.contextAttributes,
    };

    const gl = options.canvas.getContext('webgl2', attributes);
    if (gl === null) {
      throw new Error(
        'as-charts requires a WebGL2 context. WebGL1 is deliberately unsupported: ' +
          'shaders are authored for GLSL ES 3.00 and float data textures are used ' +
          'without a half-texel fallback path.',
      );
    }

    this.#gl = gl;
    this.capabilities = probeCapabilities(gl);
    this.capabilityReport = auditCapabilities(this.capabilities);

    if (this.capabilityReport.degraded) {
      // Informational, never an error: see `DiagnosticSeverity`. The fallbacks
      // are listed so a support bundle can explain a visual difference without
      // anyone having to guess which extension went missing.
      this.diagnostics.report(
        'capability/degraded',
        `context is missing ${String(this.capabilityReport.missing.length)} optional feature(s)`,
        { missing: this.capabilityReport.missing, fallbacks: this.capabilityReport.fallbacks },
        'info',
      );
    }

    this.#pool = new ResourcePool(gl);
    this.#programCache = new ProgramCache(gl, this.#pool);
    this.#drawList = new DrawList(this.diagnostics);
    this.#ids = new IdSpace(this.diagnostics);
    this.#scheduler = new FrameScheduler(
      {
        maxFps: options.maxFps,
        skipOffscreen: options.skipOffscreen ?? true,
        host: options.host ?? {
          requestFrame: (callback) => globalThis.requestAnimationFrame(callback),
          cancelFrame: (handle) => {
            globalThis.cancelAnimationFrame(handle);
          },
        },
      },
      (dirty, delta) => {
        this.#renderFrame(dirty, delta);
      },
    );

    this.#canvas.addEventListener?.('webglcontextlost', this.#onContextLost);
    this.#canvas.addEventListener?.('webglcontextrestored', this.#onContextRestored);

    this.#applyViewport();
  }

  get gl(): WebGL2RenderingContext {
    return this.#gl;
  }

  get canvas(): CanvasLike {
    return this.#canvas;
  }

  /** Drawing-buffer width in device pixels. */
  get width(): number {
    return this.#width;
  }

  /** Drawing-buffer height in device pixels. */
  get height(): number {
    return this.#height;
  }

  get devicePixelRatio(): number {
    return this.#dpr;
  }

  /** True after `webglcontextlost` until the context is restored. */
  get contextLost(): boolean {
    return this.#contextLost;
  }

  get resources(): ResourcePool {
    return this.#pool;
  }

  /** The renderer-wide pick-id axis. Layers claim from it; the picker will read it. */
  get idSpace(): IdSpace {
    return this.#ids;
  }

  /** This frame's draw list, for diagnostics. Content is valid until the next frame. */
  get drawList(): DrawList {
    return this.#drawList;
  }

  /**
   * Resize the drawing buffer from CSS pixel dimensions.
   *
   * The CSS size stays under the caller's control; only `canvas.width/height` are
   * touched, so layout is never fought over.
   */
  setSize(cssWidth: number, cssHeight: number, dpr = this.#devicePixelRatioOption): void {
    const ratio = resolveDevicePixelRatio(dpr, cssWidth, cssHeight, this.#maxPixels);
    const width = Math.max(1, Math.round(cssWidth * ratio));
    const height = Math.max(1, Math.round(cssHeight * ratio));
    this.#dpr = ratio;
    if (width === this.#width && height === this.#height) return;
    this.#width = width;
    this.#height = height;
    this.#canvas.width = width;
    this.#canvas.height = height;
    this.request(Dirty.Viewport);
  }

  /**
   * Resize from the element's current CSS box.
   *
   * Reads `clientWidth/clientHeight`, which forces layout — call it from a
   * debounced resize handler, never per frame.
   */
  resize(): void {
    const width = this.#canvas.clientWidth ?? this.#canvas.width;
    const height = this.#canvas.clientHeight ?? this.#canvas.height;
    this.setSize(width, height);
  }

  /**
   * Create an instanced triangle layer sharing this context.
   *
   * Shader variants are cached and reference-counted, so two layers asking for the
   * same feature set share one compiled program.
   */
  addTriangleLayer(
    layerOptions: TriangleLayerOptions = {},
    shaderOptions: TriangleShaderOptions = {},
  ): TriangleLayer {
    const shaders = buildTriangleShaders(shaderOptions);
    const program = this.#programCache.acquire({
      name: shaders.vertex.name,
      key: shaders.key,
      vertexSource: shaders.vertex.code,
      fragmentSource: shaders.fragment.code,
    });
    const layer = new TriangleLayer(this.#gl, this.#pool, layerOptions);

    this.#bindings.push({
      upload: () => {
        layer.upload();
      },
      collect: (list, width, height) => {
        layer.collect(list, program, width, height);
      },
      dispose: () => {
        layer.dispose();
        this.#programCache.release(program);
      },
    });

    this.request(Dirty.Geometry | Dirty.Viewport);
    return layer;
  }

  /**
   * Create an instanced line layer sharing this context.
   *
   * The data channel is chosen once, here, and it selects the shader variant as
   * well: passing `pointSource` anywhere else would let the geometry and the
   * shader disagree about where points live, which renders nothing at all.
   */
  addLineLayer(options: LineLayerRequest = {}): LineLayer {
    const pointSource = options.pointSource ?? 'attribute';
    const shaderOptions: LineShaderOptions = {
      pointSource,
      opacity: options.opacity,
      highlight: options.highlight,
    };
    const shaders = buildLineShaders(shaderOptions);
    const program = this.#programCache.acquire({
      name: shaders.vertex.name,
      key: shaders.key,
      vertexSource: shaders.vertex.code,
      fragmentSource: shaders.fragment.code,
    });
    const layer = new LineLayer(
      this.#gl,
      this.#pool,
      { ids: this.#ids, diagnostics: this.diagnostics },
      options,
    );

    this.#bindings.push({
      upload: () => {
        layer.upload();
      },
      collect: (list, width, height) => {
        layer.collect(list, program, width, height);
      },
      dispose: () => {
        layer.dispose();
        this.#programCache.release(program);
      },
    });

    this.request(Dirty.Geometry | Dirty.Viewport);
    return layer;
  }

  /** Request a redraw. Coalesces with any frame already scheduled. */
  request(dirty: DirtyFlags = Dirty.Present): void {
    this.#scheduler.request(dirty);
  }

  /** Update the visibility gate. */
  setVisible(visible: boolean): void {
    this.#scheduler.setVisible(visible);
  }

  /** Change the frame-rate cap at runtime. */
  setMaxFps(maxFps: number | undefined): void {
    this.#scheduler.setMaxFps(maxFps);
  }

  /**
   * Render synchronously, bypassing the scheduler.
   *
   * For tests, image export, and environments where the caller drives the clock.
   * Defaults to a full redraw so nothing can be skipped by accident.
   */
  renderNow(dirty: DirtyFlags = DirtyAll): void {
    this.#renderFrame(dirty, 0);
  }

  stats(): RendererStats {
    return Object.freeze({
      frameCount: this.#frameCount,
      drawCalls: this.#drawCalls,
      drawGroups: this.#drawList.groupCount,
      scheduler: this.#scheduler.stats(),
      resources: this.#pool.snapshot(),
      programs: this.#programCache.size,
      capabilities: this.capabilities,
    });
  }

  /**
   * Release every GPU object and detach listeners.
   *
   * @param options.assertClean When true (default), throws if anything leaked.
   *   `destroy()` returning silently while leaking VRAM is the failure mode this
   *   whole design exists to prevent.
   */
  destroy(options: { assertClean?: boolean } = {}): void {
    if (this.#destroyed) return;
    this.#destroyed = true;

    this.#scheduler.dispose();
    this.#canvas.removeEventListener?.('webglcontextlost', this.#onContextLost);
    this.#canvas.removeEventListener?.('webglcontextrestored', this.#onContextRestored);

    for (const binding of this.#bindings) binding.dispose();
    this.#bindings.length = 0;
    this.#drawList.clear();
    this.#ids.clear();
    this.#programCache.dispose();
    this.#pool.releaseAll();

    if (options.assertClean ?? true) this.#pool.assertEmpty('Renderer.destroy');
    // Only tear down a hub we created; a caller-owned one may be shared with
    // other renderers and its listeners are not ours to drop.
    if (this.#ownsDiagnostics) this.diagnostics.dispose();
  }

  #renderFrame(dirty: DirtyFlags, _delta: number): void {
    if (this.#destroyed) return;
    if (this.#contextLost) {
      this.diagnostics.report(
        'context/lost',
        'render requested while the WebGL context is lost; the frame is skipped',
      );
      return;
    }

    const gl = this.#gl;

    if ((dirty & Dirty.Viewport) !== 0) this.#applyViewport();

    // Indexed loops, not `for…of`: iterating an array with an iterator protocol
    // allocates an iterator object per loop per frame, which the allocation gate
    // measures. The binds are read once into locals for the same reason.
    const bindings = this.#bindings;

    if ((dirty & (Dirty.Data | Dirty.Geometry | Dirty.Upload)) !== 0) {
      for (let i = 0; i < bindings.length; i += 1) bindings[i]?.upload();
    }

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.#drawList.clear();
    for (let i = 0; i < bindings.length; i += 1) {
      bindings[i]?.collect(this.#drawList, this.#width, this.#height);
    }
    this.#drawCalls = this.#drawList.flush(gl);

    this.#frameCount += 1;
  }

  #applyViewport(): void {
    this.#gl.viewport(0, 0, this.#width, this.#height);
  }

  #onContextLost = (event: Event): void => {
    event.preventDefault();
    this.#contextLost = true;
    // The GL objects died with the context; dropping the ledger avoids pretending
    // we still hold valid handles, and a restore must start from zero.
    this.#pool.abandon();
    this.diagnostics.report(
      'context/lost',
      'WebGL context lost. Rendering is suspended; layers must be re-created after restore.',
    );
  };

  #onContextRestored = (): void => {
    this.#contextLost = false;
    this.diagnostics.report(
      'context/restored',
      'WebGL context restored. Existing layers hold stale handles and must be re-created.',
    );
  };
}
