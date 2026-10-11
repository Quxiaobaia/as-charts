import type { ResourcePool } from '../core/ResourcePool';
import type { Program } from '../renderer/Program';
import { TRIANGLE_ATTRIB } from '../core/shader/triangle';

/** Floats per instance in the interleaved instance buffer. */
const INSTANCE_STRIDE_FLOATS = 6; // offsetX, offsetY, r, g, b, size

/** Unit-space corners of an isoceles triangle, three vertices. */
const CORNER_VERTICES = new Float32Array([-1, -1, 1, -1, 0, 1]);

const CAPACITY_GROWTH = 1.5;

export interface TriangleLayerOptions {
  /** Initial instance capacity. Avoids a rebuild right after construction. */
  readonly initialCapacity?: number;
  /** Debug label used in leak reports. */
  readonly label?: string;
}

/**
 * Instanced triangles — the M0 geometry pipeline.
 *
 * Deliberately a *single* draw call for the whole layer. The shape of this class
 * is the shape every later layer copies:
 *
 * 1. Data arrives through `setInstance`/`setInstances`, which write into a
 *    pre-allocated `Float32Array`. No allocation, ever — the buffer grows by
 *    1.5× and the growth is amortised.
 * 2. `upload()` pushes bytes to the GPU only when something changed, using
 *    `bufferSubData` so the driver can keep the existing allocation.
 * 3. `draw()` sets one uniform and issues one `drawArraysInstanced`.
 *
 * One non-obvious trap is handled explicitly. A VAO captures the *buffer binding*
 * and the attribute pointers, so recreating the instance buffer on growth
 * invalidates the VAO's instance attributes. `#bindInstanceAttributes()` is
 * therefore re-run after every buffer (re)creation — forgetting this produces a
 * chart that renders correctly until it happens to grow, then goes blank.
 */
export class TriangleLayer {
  readonly #gl: WebGL2RenderingContext;
  readonly #pool: ResourcePool;
  readonly #label: string;

  readonly #vertexBuffer: WebGLBuffer;
  readonly #vao: WebGLVertexArrayObject;
  #instanceBuffer: WebGLBuffer;

  #data: Float32Array;
  #capacity: number;
  #count = 0;
  #uploadPending = false;

  constructor(gl: WebGL2RenderingContext, pool: ResourcePool, options: TriangleLayerOptions = {}) {
    this.#gl = gl;
    this.#pool = pool;
    this.#label = options.label ?? 'triangles';

    this.#capacity = Math.max(1, options.initialCapacity ?? 16);
    this.#data = new Float32Array(this.#capacity * INSTANCE_STRIDE_FLOATS);

    const label = this.#label;

    this.#vertexBuffer = pool.track(
      'buffer',
      gl.createBuffer(),
      CORNER_VERTICES.byteLength,
      `${label}.corners`,
    );
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, CORNER_VERTICES, gl.STATIC_DRAW);

    this.#vao = pool.track('vertexArray', gl.createVertexArray(), 0, `${label}.vao`);
    this.#instanceBuffer = this.#createInstanceBuffer();

    gl.bindVertexArray(this.#vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.#vertexBuffer);
    gl.enableVertexAttribArray(TRIANGLE_ATTRIB.position);
    gl.vertexAttribPointer(TRIANGLE_ATTRIB.position, 2, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(TRIANGLE_ATTRIB.position, 0);

    this.#bindInstanceAttributes();

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  /** Number of instances currently drawn. */
  get count(): number {
    return this.#count;
  }

  /**
   * Shrink (or grow) the drawn range without rewriting the tail.
   *
   * `setInstance` only ever *raises* the count, which is right for append-style
   * updates but leaves stale markers on screen the moment a dataset gets smaller
   * — the buffer still holds the old values and the draw call still covers them.
   * This is the one knob that makes "the last N of these" expressible.
   */
  set count(value: number) {
    const next = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    this.#ensureCapacity(next);
    if (next === this.#count) return;
    this.#count = next;
    this.#uploadPending = true;
  }

  /** Instance capacity before the next reallocation. */
  get capacity(): number {
    return this.#capacity;
  }

  /**
   * Write one instance. Allocation-free — safe to call from a frame loop.
   *
   * @param index Target slot; `count` is raised to `index + 1`.
   */
  setInstance(
    index: number,
    x: number,
    y: number,
    size: number,
    r: number,
    g: number,
    b: number,
  ): void {
    if (index < 0) return;
    this.#ensureCapacity(index + 1);
    const base = index * INSTANCE_STRIDE_FLOATS;
    const data = this.#data;
    data[base] = x;
    data[base + 1] = y;
    data[base + 2] = r;
    data[base + 3] = g;
    data[base + 4] = b;
    data[base + 5] = size;
    if (index + 1 > this.#count) this.#count = index + 1;
    this.#uploadPending = true;
  }

  /**
   * Write a whole list.
   *
   * The instances themselves may be pre-allocated by the caller; this method only
   * writes numbers into the buffer.
   */
  setInstances(
    instances: readonly {
      readonly x: number;
      readonly y: number;
      readonly size: number;
      readonly r: number;
      readonly g: number;
      readonly b: number;
    }[],
  ): void {
    const n = instances.length;
    this.#ensureCapacity(n);
    const data = this.#data;
    for (let i = 0; i < n; i += 1) {
      const instance = instances[i];
      if (instance === undefined) continue;
      const base = i * INSTANCE_STRIDE_FLOATS;
      data[base] = instance.x;
      data[base + 1] = instance.y;
      data[base + 2] = instance.r;
      data[base + 3] = instance.g;
      data[base + 4] = instance.b;
      data[base + 5] = instance.size;
    }
    this.#count = n;
    this.#uploadPending = true;
  }

  /** True when data has been written since the last upload. */
  get uploadPending(): boolean {
    return this.#uploadPending;
  }

  /**
   * Push written instances to the GPU.
   *
   * Uses `bufferSubData` over exactly the live range: an orphan-and-reallocate is
   * what causes the implicit synchronisation stall this design avoids.
   *
   * Note the five-argument overload. The obvious `bufferSubData(target, 0,
   * this.#data.subarray(0, n))` is a per-frame allocation — `subarray` returns a
   * *new view object* rather than a slice — which is exactly the kind of cost the
   * allocation gate exists to catch. Passing `srcOffset`/`length` keeps a single
   * `Float32Array` alive for the lifetime of the layer.
   */
  upload(): void {
    if (!this.#uploadPending) return;
    const gl = this.#gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#instanceBuffer);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.#data, 0, this.#count * INSTANCE_STRIDE_FLOATS);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.#uploadPending = false;
  }

  /**
   * Issue the single instanced draw call for this layer.
   *
   * @returns the number of GL draw calls issued — `1`, or `0` for an empty layer.
   *   Reporting the count instead of `void` is what lets the renderer's draw-call
   *   budget measure GPU work rather than registered layers, so an empty chart
   *   costs zero calls and the 32-call dashboard budget stays meaningful.
   */
  draw(program: Program, width: number, height: number): number {
    if (this.#count === 0) return 0;
    const gl = this.#gl;
    program.use();
    program.setVec2('uResolution', width, height);
    gl.bindVertexArray(this.#vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, CORNER_VERTICES.length / 2, this.#count);
    gl.bindVertexArray(null);
    return 1;
  }

  dispose(): void {
    this.#pool.release(this.#vao);
    this.#pool.release(this.#instanceBuffer);
    this.#pool.release(this.#vertexBuffer);
    this.#count = 0;
    this.#uploadPending = false;
  }

  #createInstanceBuffer(): WebGLBuffer {
    const gl = this.#gl;
    const bytes = this.#capacity * INSTANCE_STRIDE_FLOATS * Float32Array.BYTES_PER_ELEMENT;
    const buffer = this.#pool.track('buffer', gl.createBuffer(), bytes, `${this.#label}.instances`);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, bytes, gl.DYNAMIC_DRAW);
    return buffer;
  }

  #bindInstanceAttributes(): void {
    const gl = this.#gl;
    const stride = INSTANCE_STRIDE_FLOATS * Float32Array.BYTES_PER_ELEMENT;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#instanceBuffer);

    gl.enableVertexAttribArray(TRIANGLE_ATTRIB.offset);
    gl.vertexAttribPointer(TRIANGLE_ATTRIB.offset, 2, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(TRIANGLE_ATTRIB.offset, 1);

    gl.enableVertexAttribArray(TRIANGLE_ATTRIB.color);
    gl.vertexAttribPointer(
      TRIANGLE_ATTRIB.color,
      3,
      gl.FLOAT,
      false,
      stride,
      2 * Float32Array.BYTES_PER_ELEMENT,
    );
    gl.vertexAttribDivisor(TRIANGLE_ATTRIB.color, 1);

    gl.enableVertexAttribArray(TRIANGLE_ATTRIB.size);
    gl.vertexAttribPointer(
      TRIANGLE_ATTRIB.size,
      1,
      gl.FLOAT,
      false,
      stride,
      5 * Float32Array.BYTES_PER_ELEMENT,
    );
    gl.vertexAttribDivisor(TRIANGLE_ATTRIB.size, 1);
  }

  #ensureCapacity(required: number): void {
    if (required <= this.#capacity) return;

    let capacity = this.#capacity;
    while (capacity < required) capacity = Math.ceil(capacity * CAPACITY_GROWTH) + 1;

    const next = new Float32Array(capacity * INSTANCE_STRIDE_FLOATS);
    next.set(this.#data.subarray(0, this.#count * INSTANCE_STRIDE_FLOATS));
    this.#data = next;
    this.#capacity = capacity;

    // Recreate the GPU buffer at the new size and re-capture the VAO attributes.
    const gl = this.#gl;
    this.#pool.release(this.#instanceBuffer);
    this.#instanceBuffer = this.#createInstanceBuffer();
    gl.bindVertexArray(this.#vao);
    this.#bindInstanceAttributes();
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    this.#uploadPending = true;
  }
}
