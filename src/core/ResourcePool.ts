import { DiagnosticError } from './Diagnostics';

/** Every GPU-side object type the engine allocates. */
export type ResourceKind =
  'shader' | 'program' | 'buffer' | 'texture' | 'framebuffer' | 'renderbuffer' | 'vertexArray';

export interface ResourceSnapshot {
  readonly counts: Readonly<Record<ResourceKind, number>>;
  /** Live bytes accounted for by buffers and textures. */
  readonly bytes: number;
  readonly live: number;
  readonly created: number;
  readonly destroyed: number;
  readonly labels: readonly string[];
}

type GL = WebGL2RenderingContext;
type Deleter = (gl: GL, handle: object) => void;

const DELETERS: Readonly<Record<ResourceKind, Deleter>> = {
  shader: (gl, handle) => {
    gl.deleteShader(handle);
  },
  program: (gl, handle) => {
    gl.deleteProgram(handle);
  },
  buffer: (gl, handle) => {
    gl.deleteBuffer(handle);
  },
  texture: (gl, handle) => {
    gl.deleteTexture(handle);
  },
  framebuffer: (gl, handle) => {
    gl.deleteFramebuffer(handle);
  },
  renderbuffer: (gl, handle) => {
    gl.deleteRenderbuffer(handle);
  },
  vertexArray: (gl, handle) => {
    gl.deleteVertexArray(handle);
  },
};

/**
 * The single owner of GPU objects.
 *
 * Three real failures from the reference implementations motivate this class:
 *
 * - `webgl-plot` v2's `WebglPolygonPlot._generateStrokeGeometry()` creates a new
 *   stroke buffer on every geometry rebuild and never deletes the old one, so
 *   VRAM grows without bound.
 * - `WebglScatterAcc` in the same library has no `cleanup()` at all, so its
 *   resources cannot be released even in principle.
 * - LCJS 9.0 contains **zero** `deleteVertexArray` calls (against 5
 *   `deleteBuffer`), so VAOs leak.
 *
 * Centralising allocation makes "does `destroy()` really free everything?" a
 * one-line assertion instead of a code review.
 */
export class ResourcePool {
  private readonly gl: GL;
  private readonly live = new Map<object, { kind: ResourceKind; bytes: number; label: string }>();
  private readonly counts: Record<ResourceKind, number> = {
    shader: 0,
    program: 0,
    buffer: 0,
    texture: 0,
    framebuffer: 0,
    renderbuffer: 0,
    vertexArray: 0,
  };
  private liveBytes = 0;
  private peakBytesTotal = 0;
  private createdTotal = 0;
  private destroyedTotal = 0;

  constructor(gl: GL) {
    this.gl = gl;
  }

  /**
   * Register a freshly created GPU object.
   *
   * @param bytes Byte size for accounting (buffers: capacity; textures:
   *   `w * h * bpp`). Ignored for non-memory objects.
   */
  track<T extends object>(kind: ResourceKind, handle: T, bytes = 0, label = ''): T {
    if (this.live.has(handle)) return handle;
    this.live.set(handle, { kind, bytes, label });
    this.counts[kind] += 1;
    this.liveBytes += bytes;
    if (this.liveBytes > this.peakBytesTotal) this.peakBytesTotal = this.liveBytes;
    this.createdTotal += 1;
    return handle;
  }

  /** Delete a GPU object and stop accounting for it. Returns false if unknown. */
  release(handle: object | null | undefined): boolean {
    if (handle == null) return false;
    const entry = this.live.get(handle);
    if (entry === undefined) return false;
    DELETERS[entry.kind](this.gl, handle);
    this.live.delete(handle);
    this.counts[entry.kind] -= 1;
    this.liveBytes -= entry.bytes;
    this.destroyedTotal += 1;
    return true;
  }

  /** Delete everything. Safe to call from `destroy()` and from a lost context. */
  releaseAll(): void {
    for (const handle of [...this.live.keys()]) this.release(handle);
  }

  /**
   * Stop tracking everything **without** issuing GL calls.
   *
   * Used after `webglcontextlost`: the objects are already gone with the context,
   * so the deleter calls would be no-ops that only add noise, and a restore must
   * start from a clean ledger.
   */
  abandon(): void {
    this.live.clear();
    this.liveBytes = 0;
    for (const kind of Object.keys(this.counts) as ResourceKind[]) this.counts[kind] = 0;
  }

  /** Number of live GPU objects. Allocation-free — safe on a hot path. */
  get liveCount(): number {
    return this.live.size;
  }

  /** Live bytes accounted for. Allocation-free. */
  get bytes(): number {
    return this.liveBytes;
  }

  /** High-water mark since construction. */
  get peakBytes(): number {
    return this.peakBytesTotal;
  }

  get createdCount(): number {
    return this.createdTotal;
  }

  get destroyedCount(): number {
    return this.destroyedTotal;
  }

  /** Diagnostic snapshot. Allocates; never call it per frame. */
  snapshot(): ResourceSnapshot {
    const labels: string[] = [];
    for (const entry of this.live.values()) {
      if (entry.label !== '') labels.push(`${entry.kind}:${entry.label}`);
    }
    return Object.freeze({
      counts: Object.freeze({ ...this.counts }),
      bytes: this.liveBytes,
      live: this.live.size,
      created: this.createdTotal,
      destroyed: this.destroyedTotal,
      labels: Object.freeze(labels),
    });
  }

  /**
   * Structural gate: no GPU object may outlive the renderer.
   *
   * @throws {DiagnosticError} listing every leaking object by kind and label.
   */
  assertEmpty(context = 'ResourcePool.assertEmpty'): void {
    if (this.live.size === 0) return;
    const snapshot = this.snapshot();
    const detail = snapshot.labels.length > 0 ? snapshot.labels : snapshot.counts;
    throw new DiagnosticError({
      code: 'resource/leak',
      message: `${context}: ${this.live.size} GPU object(s) still alive after destroy()`,
      detail,
      // A caller mistake, so it is an error and may be escalated by `'throw'`.
      severity: 'error',
    });
  }
}
