import type { Diagnostics } from '../core/Diagnostics';
import { MutableDrawCall, MutablePointSource, type UniformWriter } from '../core/DrawCall';
import type { DrawList } from '../core/DrawList';
import type { IdSpace } from '../core/IdSpace';
import type { ResourcePool } from '../core/ResourcePool';
import { LINE_ATTRIB, type LinePointSource } from '../core/shader/line';
import type { Vec } from '../data/types';
import type { Program } from '../renderer/Program';

/**
 * Instanced line segments — the M1 geometry pipeline, in two data channels.
 *
 * ## One buffer, one draw call, N series
 *
 * Every series in the layer writes into **one** instance buffer, with colour,
 * stroke width and pick id as per-instance attributes. That is what contract C2
 * rule 6 buys: the layer emits one descriptor *per series* — each carrying its
 * own contiguous instance range and id range — and `DrawList` merges them,
 * because they share a program, a VAO, a uniform writer and a point source.
 * Eight series therefore cost one `drawArraysInstanced`, not eight draws.
 *
 * The price is real and worth stating: because colour lives in the instance
 * stream rather than a uniform, changing one series' colour rewrites instance
 * bytes. `Dirty.Style`'s "a colour change never touches geometry" is not
 * available to a primitive that wants to batch. Restricting the re-upload to the
 * affected span is M1-d's incremental-upload work.
 *
 * ## Segment enumeration, identical in both channels
 *
 * For each series, walking the points in order:
 *
 * - a point pair that is fully finite emits one real segment;
 * - a finite point with no usable neighbour emits one **degenerate** segment
 *   (`A == B`), which the shader turns into a small square — so an isolated
 *   sample is visible rather than invisible;
 * - non-finite values simply emit nothing. They are *dropped*, not clamped: a
 *   clamped sample piles screen-off data onto the edge column and makes an
 *   off-screen spike look like an edge spike.
 *
 * The two channels run this same loop and produce the same segments in the same
 * order with the same ids. Only the per-instance payload differs — a `vec4` of
 * endpoints, or a single flat index into a shared float texture. That identity is
 * the point: it is what makes a pixel-for-pixel comparison between the channels a
 * meaningful test rather than a comparison of two different drawings.
 *
 * ## The texture channel's layout, and why it is not two texels per segment
 *
 * `lineEndB()` reads the texel *after* `aPointIndex`, so each maximal finite run
 * is stored contiguously, once. A run of `L` points costs `L` texels and yields
 * `L − 1` segments; an isolated point is stored twice so that it too has a
 * "next". Points are therefore held once, at 8 bytes each, against 16 bytes per
 * segment in the attribute channel. Measured totals are in `docs/roadmap.md`.
 *
 * ## Ownership of the arrays
 *
 * `addSeries` stores the caller's `x`/`y` **by reference** — copying a hundred
 * million points to hand them over would double peak memory for no benefit, and
 * the Worker handoff in M1-d needs the zero-copy path anyway. Mutating or
 * detaching those arrays after the call is the caller's responsibility; call
 * `setSeriesData` to hand over a new pair.
 */
const CORNER_VERTICES = new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]);
const CORNERS = CORNER_VERTICES.length / 2;

const CAPACITY_GROWTH = 1.5;
const MIN_CAPACITY = 16;

/** Bytes per texel of the `RG32F` point texture. */
const TEXEL_BYTES = 8;
const DEFAULT_TEXELS_PER_ROW = 2048;

/**
 * Interleaved instance layouts, in 32-bit words.
 *
 * The two channels differ here and nowhere else on the CPU side. Both keep the
 * attribute *locations* fixed (`LINE_ATTRIB`), so a single VAO setup routine
 * serves either; only strides and offsets change.
 */
const LAYOUTS = {
  attribute: { strideWords: 9, pointWords: 4, styleOffset: 4, idOffset: 8 },
  texture: { strideWords: 6, pointWords: 1, styleOffset: 1, idOffset: 5 },
} as const;

export interface LineLayerOptions {
  /** Which data channel to use. Default `'attribute'`. */
  readonly pointSource?: LinePointSource;
  /** Initial segment capacity. Avoids a rebuild right after construction. */
  readonly initialSegments?: number;
  /** Debug label used in leak reports. */
  readonly label?: string;
  /** Texture channel: texels per row. Clamped by `MAX_TEXTURE_SIZE`. */
  readonly texelsPerRow?: number;
}

/** Renderer-provided collaborators. Injected, never constructed by the layer. */
export interface LineLayerContext {
  /**
   * The renderer's id space.
   *
   * Required rather than optional, because C1 rule 2 makes the id space a single
   * renderer-wide axis. A layer that quietly invented its own would produce ids
   * that collide with another layer's — and nothing would notice until two
   * layers existed.
   */
  readonly ids: IdSpace;
  readonly diagnostics: Diagnostics;
}

export interface LineSeriesInput {
  readonly x: Vec;
  readonly y: Vec;
  /** Points to read. Defaults to `x.length`. */
  readonly count?: number;
  /** Linear RGB in `[0, 1]`. Default white. */
  readonly color?: readonly [number, number, number];
  /** Stroke width in device pixels. Default 1. */
  readonly thickness?: number;
}

export interface LineSeriesStyle {
  readonly color?: readonly [number, number, number];
  readonly thickness?: number;
}

/**
 * Per-series geometry and id facts.
 *
 * Diagnostic surface: a debug panel wants to know how many segments each series
 * is really drawing, and M1-d's LOD selection needs the same numbers. It
 * allocates, so it is never called from a frame.
 */
export interface LineSeriesStats {
  readonly count: number;
  readonly segmentCount: number;
  readonly firstSegment: number;
  /** First pick id, or 0 when the series could not be granted one. */
  readonly idFirst: number;
  /** Ids granted. `1` means series-level picking. */
  readonly idCount: number;
  /** Texture channel: flat texel index where this series' points start. */
  readonly firstTexel: number;
  readonly texelCount: number;
}

interface SeriesRecord {
  x: Vec;
  y: Vec;
  count: number;
  r: number;
  g: number;
  b: number;
  thickness: number;
  /** Instance range within the shared instance buffer. */
  firstSegment: number;
  segmentCount: number;
  /** Texture channel: flat texel index where this series' points start. */
  firstTexel: number;
  texelCount: number;
  /** First id granted by the id space. */
  idFirst: number;
  /** Ids granted. `1` means series-level picking: every point answers to `idFirst`. */
  idCount: number;
}

/** Writes the uniform values a line draw needs. Owned by the layer, reused. */
class LineUniforms implements UniformWriter {
  readonly #gl: WebGL2RenderingContext;
  transform: Float32Array;
  viewportWidth = 0;
  viewportHeight = 0;
  texture: WebGLTexture | null = null;
  texelsPerRow = 0;

  constructor(gl: WebGL2RenderingContext, transform: Float32Array) {
    this.#gl = gl;
    this.transform = transform;
  }

  write(program: Program): void {
    program.setMat4('uTransform', this.transform);
    program.setVec2('uViewportPx', this.viewportWidth, this.viewportHeight);
    const texture = this.texture;
    if (texture === null) return;
    // Texture unit 0 is claimed directly. A unit allocator is deferred rather
    // than forgotten: the text layer (M1-c) renders into its own 2D canvas and
    // the picking pass will claim a unit of its own. Neither exists yet, and a
    // one-unit allocator now would be the kind of speculative machinery this
    // project keeps having to delete.
    this.#gl.activeTexture(this.#gl.TEXTURE0);
    this.#gl.bindTexture(this.#gl.TEXTURE_2D, texture);
    program.setInt('uPointData', 0);
    program.setInt('uTexelsPerRow', this.texelsPerRow);
  }
}

/** Finite check that also rejects an out-of-range read. */
function isUsable(x: Vec, y: Vec, index: number): boolean {
  const xi = x[index];
  const yi = y[index];
  return xi !== undefined && yi !== undefined && Number.isFinite(xi) && Number.isFinite(yi);
}

/**
 * Read a component already proven finite by {@link isUsable}.
 *
 * The cast is the price of `noUncheckedIndexedAccess` on a typed array, and it is
 * confined to one line, immediately next to the check that justifies it.
 */
function component(axis: Vec, index: number): number {
  return axis[index] as number;
}

export class LineLayer {
  readonly #gl: WebGL2RenderingContext;
  readonly #pool: ResourcePool;
  readonly #ids: IdSpace;
  readonly #diagnostics: Diagnostics;
  readonly #label: string;
  readonly #channel: LinePointSource;
  readonly #layout: (typeof LAYOUTS)[LinePointSource];

  readonly #cornerBuffer: WebGLBuffer;
  readonly #vao: WebGLVertexArrayObject;
  #instanceBuffer: WebGLBuffer;

  /** Raw storage so float and uint attributes can interleave without copying. */
  #buffer: ArrayBuffer;
  #f32: Float32Array;
  #u32: Uint32Array;
  #capacity: number;
  #segmentCount = 0;

  /** Texture channel only. */
  #texture: WebGLTexture | null = null;
  #texels: Float32Array;
  #texelCapacity: number;
  #texelCount = 0;
  readonly #texelsPerRow: number;
  /** Texels the current texture storage holds, `width × rows`. */
  #textureTexels = 0;
  #maxTextureSize = 0;

  readonly #series: SeriesRecord[] = [];
  /** One descriptor per series, so `DrawList` can merge them. */
  readonly #descriptors: MutableDrawCall[] = [];
  readonly #pointSource: MutablePointSource;

  readonly #transform = new Float32Array(16);
  readonly #uniforms: LineUniforms;

  #geometryDirty = true;
  #uploadDirty = false;

  constructor(
    gl: WebGL2RenderingContext,
    pool: ResourcePool,
    context: LineLayerContext,
    options: LineLayerOptions = {},
  ) {
    this.#gl = gl;
    this.#pool = pool;
    this.#ids = context.ids;
    this.#diagnostics = context.diagnostics;
    this.#label = options.label ?? 'lines';
    this.#channel = options.pointSource ?? 'attribute';
    this.#layout = LAYOUTS[this.#channel];
    this.#texelsPerRow = Math.max(1, Math.floor(options.texelsPerRow ?? DEFAULT_TEXELS_PER_ROW));

    this.#capacity = Math.max(1, Math.floor(options.initialSegments ?? MIN_CAPACITY));
    const strideBytes = this.#layout.strideWords * Float32Array.BYTES_PER_ELEMENT;
    this.#buffer = new ArrayBuffer(this.#capacity * strideBytes);
    this.#f32 = new Float32Array(this.#buffer);
    this.#u32 = new Uint32Array(this.#buffer);

    const label = this.#label;

    this.#cornerBuffer = pool.track(
      'buffer',
      gl.createBuffer(),
      CORNER_VERTICES.byteLength,
      `${label}.corners`,
    );
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#cornerBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, CORNER_VERTICES, gl.STATIC_DRAW);

    this.#vao = pool.track('vertexArray', gl.createVertexArray(), 0, `${label}.vao`);
    this.#instanceBuffer = this.#createInstanceBuffer();

    const pointSource = new MutablePointSource();
    this.#pointSource = pointSource;
    if (this.#channel === 'texture') {
      this.#texelCapacity = Math.max(1, this.#capacity * 2);
      this.#texels = new Float32Array(this.#texelCapacity * 2);
    } else {
      this.#texelCapacity = 0;
      this.#texels = new Float32Array(0);
    }
    this.#uniforms = new LineUniforms(gl, this.#transform);

    gl.bindVertexArray(this.#vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#cornerBuffer);
    gl.enableVertexAttribArray(LINE_ATTRIB.corner);
    gl.vertexAttribPointer(LINE_ATTRIB.corner, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(LINE_ATTRIB.corner, 0);
    this.#bindInstanceAttributes();
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    this.#syncPointSource();
  }

  /** Which data channel this layer uses. */
  get pointSource(): LinePointSource {
    return this.#channel;
  }

  /** Number of series. */
  get seriesCount(): number {
    return this.#series.length;
  }

  /** Segments currently drawn, summed over series. */
  get segmentCount(): number {
    return this.#segmentCount;
  }

  /** Segment capacity before the next reallocation. */
  get capacity(): number {
    return this.#capacity;
  }

  /** Instance bytes held on the CPU, `stride × capacity`. */
  get instanceBytes(): number {
    return this.#buffer.byteLength;
  }

  /** Texels held in the point texture. Always 0 in the attribute channel. */
  get texelCount(): number {
    return this.#texelCount;
  }

  /** True when written-but-not-uploaded data is waiting. */
  get uploadPending(): boolean {
    return this.#geometryDirty || this.#uploadDirty;
  }

  /** Points held across all series, for capacity and memory reporting. */
  get pointCount(): number {
    let total = 0;
    for (const series of this.#series) total += series.count;
    return total;
  }

  /**
   * Geometry and id facts for one series.
   *
   * Reflects the last rebuild, so it is only meaningful after `upload()` has run
   * — which is also when the renderer calls it. Allocates; diagnostics only.
   */
  seriesStats(index: number): LineSeriesStats | undefined {
    const series = this.#series[index];
    if (series === undefined) return undefined;
    return Object.freeze({
      count: series.count,
      segmentCount: series.segmentCount,
      firstSegment: series.firstSegment,
      idFirst: series.idFirst,
      idCount: series.idCount,
      firstTexel: series.firstTexel,
      texelCount: series.texelCount,
    });
  }

  /**
   * Add a series, claiming a contiguous id range for its points.
   *
   * @returns the series index, stable until `removeSeries` shifts the ones after it.
   */
  addSeries(input: LineSeriesInput): number {
    const count = Math.max(0, Math.floor(input.count ?? input.x.length));
    const color = input.color ?? [1, 1, 1];
    const grant = this.#ids.allocate(count);

    const series: SeriesRecord = {
      x: input.x,
      y: input.y,
      count,
      r: color[0] ?? 1,
      g: color[1] ?? 1,
      b: color[2] ?? 1,
      thickness: Math.max(0, input.thickness ?? 1),
      firstSegment: 0,
      segmentCount: 0,
      firstTexel: 0,
      texelCount: 0,
      idFirst: grant.first,
      idCount: grant.count,
    };

    this.#series.push(series);
    const descriptor = new MutableDrawCall();
    descriptor.idRange = { first: grant.first, count: grant.count };
    descriptor.mode = this.#gl.TRIANGLE_STRIP;
    descriptor.vertexCount = CORNERS;
    descriptor.vao = this.#vao;
    descriptor.pointSource = this.#pointSource;
    descriptor.uniforms = this.#uniforms;
    descriptor.instanceFirst = 0;
    this.#descriptors.push(descriptor);

    this.#geometryDirty = true;
    return this.#series.length - 1;
  }

  /**
   * Replace a series' points.
   *
   * The id range is re-claimed, because C1 rule 4 ties `idCount` to the point
   * count: keeping an old grant would leave ids either unused or short.
   */
  setSeriesData(index: number, input: Omit<LineSeriesInput, 'color' | 'thickness'>): boolean {
    const series = this.#series[index];
    if (series === undefined) return false;
    const count = Math.max(0, Math.floor(input.count ?? input.x.length));

    this.#ids.release(series.idFirst, series.idCount);
    const grant = this.#ids.allocate(count);
    series.x = input.x;
    series.y = input.y;
    series.count = count;
    series.idFirst = grant.first;
    series.idCount = grant.count;

    const descriptor = this.#descriptors[index];
    if (descriptor !== undefined) descriptor.idRange = { first: grant.first, count: grant.count };

    this.#geometryDirty = true;
    return true;
  }

  /**
   * Change a series' colour or width.
   *
   * Marks geometry dirty: colour and width are per-instance attributes (C2 rule
   * 6), so there is no uniform to poke. See the class note for why that trade is
   * accepted, and M1-d for the span-restricted re-upload that makes it cheap.
   */
  setSeriesStyle(index: number, style: LineSeriesStyle): boolean {
    const series = this.#series[index];
    if (series === undefined) return false;
    if (style.color !== undefined) {
      series.r = style.color[0] ?? series.r;
      series.g = style.color[1] ?? series.g;
      series.b = style.color[2] ?? series.b;
    }
    if (style.thickness !== undefined) series.thickness = Math.max(0, style.thickness);
    this.#geometryDirty = true;
    return true;
  }

  /** Remove a series and return its ids to the pool (C1 rule 5). */
  removeSeries(index: number): boolean {
    const series = this.#series[index];
    if (series === undefined) return false;

    this.#ids.release(series.idFirst, series.idCount);
    this.#series.splice(index, 1);
    this.#descriptors.splice(index, 1);
    this.#geometryDirty = true;
    return true;
  }

  /** Drop every series and release every id range. */
  clear(): void {
    for (const series of this.#series) this.#ids.release(series.idFirst, series.idCount);
    this.#series.length = 0;
    this.#descriptors.length = 0;
    this.#segmentCount = 0;
    this.#texelCount = 0;
    this.#uploadDirty = true;
  }

  /**
   * Set the data → clip transform.
   *
   * Copying into a preallocated matrix means a zoom is **not** a geometry change:
   * endpoints stay in data space, so the instance buffer is untouched and only a
   * uniform moves. That is what keeps a stroke's width independent of zoom, and
   * it is asserted directly in `tests/line-layer.test.ts`.
   */
  setTransform(matrix: Float32Array | readonly number[]): void {
    const target = this.#transform;
    for (let i = 0; i < 16; i += 1) target[i] = matrix[i] ?? 0;
  }

  /** The live transform. Read-only view: mutate through `setTransform`. */
  get transform(): Float32Array {
    return this.#transform;
  }

  /**
   * Rebuild written instances and push them to the GPU.
   *
   * Called from the renderer's upload stage. Rebuilding is incremental in space
   * only: the instance buffer grows by 1.5× while being written, so a hundred
   * million points are numbered once rather than twice. Counting first would
   * double the first-frame cost the design budget is spent on.
   */
  upload(): void {
    if (this.#geometryDirty) {
      this.#rebuild();
      this.#geometryDirty = false;
      this.#uploadDirty = true;
    }
    if (!this.#uploadDirty) return;

    const gl = this.#gl;
    const words = this.#segmentCount * this.#layout.strideWords;
    if (words > 0) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.#instanceBuffer);
      // The five-argument form: `subarray` would allocate a view per frame, which
      // is exactly what the allocation gate exists to catch.
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.#f32, 0, words);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);
    }
    if (this.#channel === 'texture') this.#uploadTexture();
    this.#uploadDirty = false;
  }

  /**
   * Queue this layer's descriptors.
   *
   * One per non-empty series, so `DrawList` merges them into a single draw. An
   * empty layer queues nothing and therefore costs zero draw calls.
   */
  collect(list: DrawList, program: Program, width: number, height: number): void {
    if (this.#segmentCount === 0) return;
    this.#uniforms.viewportWidth = width;
    this.#uniforms.viewportHeight = height;

    for (let i = 0; i < this.#series.length; i += 1) {
      const series = this.#series[i];
      const descriptor = this.#descriptors[i];
      if (series === undefined || descriptor === undefined || series.segmentCount === 0) continue;
      descriptor.program = program;
      descriptor.instanceFirst = series.firstSegment;
      descriptor.instanceCount = series.segmentCount;
      list.add(descriptor);
    }
  }

  dispose(): void {
    this.clear();
    this.#pool.release(this.#vao);
    this.#pool.release(this.#instanceBuffer);
    this.#pool.release(this.#cornerBuffer);
    if (this.#texture !== null) {
      this.#pool.release(this.#texture);
      this.#texture = null;
    }
    this.#segmentCount = 0;
    this.#uploadDirty = false;
  }

  // ---- geometry -----------------------------------------------------------

  #rebuild(): void {
    this.#segmentCount = 0;
    this.#texelCount = 0;

    for (let s = 0; s < this.#series.length; s += 1) {
      const series = this.#series[s];
      if (series === undefined) continue;
      series.firstSegment = this.#segmentCount;
      series.firstTexel = this.#texelCount;
      this.#buildSeries(series);
      series.segmentCount = this.#segmentCount - series.firstSegment;
      series.texelCount = this.#texelCount - series.firstTexel;
    }

    this.#syncPointSource();
  }

  #buildSeries(series: SeriesRecord): void {
    const x = series.x;
    const y = series.y;
    const count = series.count;
    // Series-level picking (the id space degraded this entity) means every point
    // answers to the same id. Deriving it once keeps the hot loop free of the
    // branch, and getting this wrong is how a degraded series silently steals
    // another entity's ids.
    const perPoint = series.idCount > 1;
    const idBase = series.idFirst;

    for (let i = 0; i < count; i += 1) {
      if (!isUsable(x, y, i)) continue;
      const previous = i > 0 && isUsable(x, y, i - 1);
      const next = i + 1 < count && isUsable(x, y, i + 1);
      const id = perPoint ? idBase + i : idBase;

      if (!previous && !next) {
        const px = component(x, i);
        const py = component(y, i);
        this.#emit(px, py, px, py, series, id, !previous);
      }
      if (next) {
        this.#emit(
          component(x, i),
          component(y, i),
          component(x, i + 1),
          component(y, i + 1),
          series,
          id,
          !previous,
        );
      }
    }
  }

  /**
   * Write one segment.
   *
   * @param startsRun True when this segment's first endpoint is not already in
   *   the texture, so the point payload must be appended rather than reused.
   */
  #emit(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    series: SeriesRecord,
    id: number,
    startsRun: boolean,
  ): void {
    let texelIndex = 0;
    if (this.#channel === 'texture') {
      texelIndex = this.#appendTexels(ax, ay, bx, by, startsRun);
      if (texelIndex < 0) return;
    }

    this.#ensureSegmentCapacity(this.#segmentCount + 1);

    const layout = this.#layout;
    const base = this.#segmentCount * layout.strideWords;
    const words = this.#u32;
    const floats = this.#f32;

    if (this.#channel === 'attribute') {
      floats[base] = ax;
      floats[base + 1] = ay;
      floats[base + 2] = bx;
      floats[base + 3] = by;
    } else {
      words[base] = texelIndex >>> 0;
    }

    const style = base + layout.styleOffset;
    floats[style] = series.r;
    floats[style + 1] = series.g;
    floats[style + 2] = series.b;
    floats[style + 3] = series.thickness;
    words[style + 4] = id >>> 0;

    this.#segmentCount += 1;
  }

  /**
   * Append a segment's endpoints to the point texture.
   *
   * `next` reuses the previous segment's endpoint B as this segment's A, which is
   * what makes a run of `L` points cost `L` texels rather than `2L` stores.
   *
   * @returns the flat index of endpoint A, or `-1` when the texture is full.
   */
  #appendTexels(ax: number, ay: number, bx: number, by: number, startsRun: boolean): number {
    const needed = startsRun ? 2 : 1;
    if (!this.#ensureTexelCapacity(this.#texelCount + needed)) return -1;

    let index: number;
    const texels = this.#texels;
    if (startsRun) {
      index = this.#texelCount;
      texels[index * 2] = ax;
      texels[index * 2 + 1] = ay;
      this.#texelCount += 1;
    } else {
      index = this.#texelCount - 1;
    }
    texels[this.#texelCount * 2] = bx;
    texels[this.#texelCount * 2 + 1] = by;
    this.#texelCount += 1;
    return index;
  }

  #ensureSegmentCapacity(required: number): void {
    if (required <= this.#capacity) return;

    let capacity = this.#capacity;
    while (capacity < required) capacity = Math.ceil(capacity * CAPACITY_GROWTH) + 1;

    const strideBytes = this.#layout.strideWords * Float32Array.BYTES_PER_ELEMENT;
    const next = new ArrayBuffer(capacity * strideBytes);
    new Uint8Array(next).set(new Uint8Array(this.#buffer));
    this.#buffer = next;
    this.#f32 = new Float32Array(next);
    this.#u32 = new Uint32Array(next);
    this.#capacity = capacity;

    // A VAO captures the buffer *binding* and the attribute pointers, so a new
    // instance buffer invalidates its instance attributes. Forgetting this
    // re-run produces a chart that renders correctly right up until it grows,
    // then goes blank — the M0 note this repeats on purpose.
    const gl = this.#gl;
    this.#pool.release(this.#instanceBuffer);
    this.#instanceBuffer = this.#createInstanceBuffer();
    gl.bindVertexArray(this.#vao);
    this.#bindInstanceAttributes();
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  #ensureTexelCapacity(required: number): boolean {
    const maxSize = this.#maxTextureSizePx();
    const maxTexels = maxSize * maxSize;
    if (required > maxTexels) {
      this.#diagnostics.report(
        'line/texture-capacity-exceeded',
        `the texture channel needs ${String(required)} texels but this context allows ${String(maxTexels)}; the tail of the data is not drawn`,
        { required, maxTexels, maxTextureSize: maxSize, label: this.#label },
      );
      return false;
    }
    this.#ensureTexelStorage(required);
    return true;
  }

  /**
   * Grow the CPU-side texel array.
   *
   * Separate from the capacity check because a texture's storage is
   * `width × rows`, which is usually larger than the number of live texels: the
   * last row is padded. `texImage2D` needs that padding to exist as real bytes,
   * so the array is grown to the padded size, not the live size.
   */
  #ensureTexelStorage(texels: number): void {
    if (this.#texels.length >= texels * 2) return;
    let capacity = this.#texelCapacity;
    while (capacity < texels) capacity = Math.ceil(capacity * CAPACITY_GROWTH) + 1;
    const next = new Float32Array(capacity * 2);
    next.set(this.#texels.subarray(0, this.#texelCount * 2));
    this.#texels = next;
    this.#texelCapacity = capacity;
  }

  #maxTextureSizePx(): number {
    if (this.#maxTextureSize === 0) {
      const value = this.#gl.getParameter(this.#gl.MAX_TEXTURE_SIZE) as unknown;
      this.#maxTextureSize =
        typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 2048;
    }
    return this.#maxTextureSize;
  }

  #syncPointSource(): void {
    if (this.#channel === 'texture') {
      this.#pointSource.setTexture(this.#texture, this.#texelsPerRow);
      this.#uniforms.texture = this.#texture;
      this.#uniforms.texelsPerRow = this.#texelsPerRow;
    } else {
      this.#pointSource.setAttribute(this.#instanceBuffer);
    }
  }

  #uploadTexture(): void {
    const gl = this.#gl;
    const width = Math.max(1, Math.min(this.#texelsPerRow, this.#maxTextureSizePx()));
    const rows = Math.max(1, Math.ceil(this.#texelCount / width));
    const texels = width * rows;
    this.#ensureTexelStorage(texels);

    if (this.#texture === null || texels > this.#textureTexels) {
      if (this.#texture !== null) this.#pool.release(this.#texture);
      const texture = this.#pool.track(
        'texture',
        gl.createTexture(),
        texels * TEXEL_BYTES,
        `${this.#label}.points`,
      );
      gl.bindTexture(gl.TEXTURE_2D, texture);
      // RG32F with NEAREST: sampling is `texelFetch`, which ignores filtering
      // entirely, so no float-linear extension is required and the capability is
      // never consulted. NEAREST also keeps the texture complete on drivers that
      // would otherwise flag a float texture with linear filtering.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, width, rows, 0, gl.RG, gl.FLOAT, this.#texels, 0);
      this.#texture = texture;
      this.#textureTexels = texels;
      this.#syncPointSource();
      return;
    }

    gl.bindTexture(gl.TEXTURE_2D, this.#texture);
    // `texSubImage2D` over the live rows only. Re-specifying the whole texture
    // would reallocate its storage on every rebuild, and both calls take a
    // `srcOffset` so neither has to materialise a `subarray` view per frame.
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, rows, gl.RG, gl.FLOAT, this.#texels, 0);
  }

  #createInstanceBuffer(): WebGLBuffer {
    const gl = this.#gl;
    const bytes = this.#capacity * this.#layout.strideWords * Float32Array.BYTES_PER_ELEMENT;
    const buffer = this.#pool.track('buffer', gl.createBuffer(), bytes, `${this.#label}.instances`);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.DYNAMIC_DRAW);
    return buffer;
  }

  #bindInstanceAttributes(): void {
    const gl = this.#gl;
    const layout = this.#layout;
    const stride = layout.strideWords * Float32Array.BYTES_PER_ELEMENT;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#instanceBuffer);

    if (this.#channel === 'attribute') {
      gl.enableVertexAttribArray(LINE_ATTRIB.pointSource);
      gl.vertexAttribPointer(LINE_ATTRIB.pointSource, 4, gl.FLOAT, false, stride, 0);
      gl.vertexAttribDivisor(LINE_ATTRIB.pointSource, 1);
    } else {
      // An integer attribute needs `vertexAttribIPointer`: `vertexAttribPointer`
      // converts to float, and a float32 cannot hold an id above 2^24 exactly.
      // This is why `aId` below is a `uint` attribute too.
      gl.enableVertexAttribArray(LINE_ATTRIB.pointSource);
      gl.vertexAttribIPointer(LINE_ATTRIB.pointSource, 1, gl.UNSIGNED_INT, stride, 0);
      gl.vertexAttribDivisor(LINE_ATTRIB.pointSource, 1);
    }

    gl.enableVertexAttribArray(LINE_ATTRIB.color);
    gl.vertexAttribPointer(
      LINE_ATTRIB.color,
      3,
      gl.FLOAT,
      false,
      stride,
      layout.styleOffset * Float32Array.BYTES_PER_ELEMENT,
    );
    gl.vertexAttribDivisor(LINE_ATTRIB.color, 1);

    gl.enableVertexAttribArray(LINE_ATTRIB.thickness);
    gl.vertexAttribPointer(
      LINE_ATTRIB.thickness,
      1,
      gl.FLOAT,
      false,
      stride,
      (layout.styleOffset + 3) * Float32Array.BYTES_PER_ELEMENT,
    );
    gl.vertexAttribDivisor(LINE_ATTRIB.thickness, 1);

    gl.enableVertexAttribArray(LINE_ATTRIB.id);
    gl.vertexAttribIPointer(
      LINE_ATTRIB.id,
      1,
      gl.UNSIGNED_INT,
      stride,
      layout.idOffset * Float32Array.BYTES_PER_ELEMENT,
    );
    gl.vertexAttribDivisor(LINE_ATTRIB.id, 1);
  }
}
