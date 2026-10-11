import { computeBounds, type BoundsOptions, type BoundsResult } from './bounds';
import type { Vec } from './types';

/** Growth factor for the backing columns. Matches `TriangleLayer`'s instance buffer. */
const CAPACITY_GROWTH = 1.5;
const MIN_CAPACITY = 16;

/**
 * Columnar sample storage, structure-of-arrays.
 *
 * ## Why columns rather than an array of points
 *
 * Every consumer wants one column at a time and wants it contiguous. `computeBounds`
 * walks x and y separately, `minmaxDownsample` reads y per bucket, the vertex
 * builder subtracts a local origin from whole x and y columns, and the GPU upload
 * is two `bufferSubData` calls. An array of `{x, y}` objects would force a gather
 * copy in front of each of those, and the gather is the expensive part.
 *
 * It also makes the Worker path free: a `Float64Array`'s buffer is transferable,
 * so the parse worker can hand its result over without copying, which
 * {@link adopt} is the receiving end of.
 *
 * ## What is deliberately absent
 *
 * CSV and binary parsing, and the worker that runs them. Those land with the
 * upload path in M1-d, together with the transferable handoff; writing the
 * parser before the transport exists would fix an interface that has not been
 * constrained by anything yet.
 */
export class DataSet {
  #x: Float64Array;
  #y: Float64Array;
  #count = 0;

  constructor(capacity = 0) {
    const size = Math.max(0, Math.floor(capacity));
    this.#x = new Float64Array(size);
    this.#y = new Float64Array(size);
  }

  /** Live samples, not the backing array length. */
  get count(): number {
    return this.#count;
  }

  /** Backing array length. */
  get capacity(): number {
    return this.#x.length;
  }

  /**
   * The x column. Read the first {@link count} entries; the rest is slack.
   *
   * Exposed rather than copied because the whole design is that callers read
   * columns directly — the renderer hands these to `bufferSubData`, and the
   * downsample step indexes them in place.
   */
  get x(): Float64Array {
    return this.#x;
  }

  /** The y column. See {@link x}. */
  get y(): Float64Array {
    return this.#y;
  }

  /** Ensure room for `capacity` samples without changing {@link count}. */
  reserve(capacity: number): void {
    const needed = Math.max(0, Math.floor(capacity));
    if (needed <= this.#x.length) return;
    let size = Math.max(MIN_CAPACITY, this.#x.length);
    while (size < needed) size = Math.ceil(size * CAPACITY_GROWTH);
    const nextX = new Float64Array(size);
    const nextY = new Float64Array(size);
    nextX.set(this.#x.subarray(0, this.#count));
    nextY.set(this.#y.subarray(0, this.#count));
    this.#x = nextX;
    this.#y = nextY;
  }

  /** Append one sample, growing if needed. */
  push(x: number, y: number): void {
    this.reserve(this.#count + 1);
    this.#x[this.#count] = x;
    this.#y[this.#count] = y;
    this.#count += 1;
  }

  /** Append `count` samples from parallel columns. */
  pushMany(x: Vec, y: Vec, count: number, srcOffset = 0): void {
    if (count <= 0) return;
    this.reserve(this.#count + count);
    const at = this.#count;
    for (let i = 0; i < count; i += 1) {
      this.#x[at + i] = x[srcOffset + i] ?? 0;
      this.#y[at + i] = y[srcOffset + i] ?? 0;
    }
    this.#count += count;
  }

  /**
   * Replace the contents by **copying** from `x`/`y`.
   *
   * The safe default: the caller keeps ownership and may reuse its buffers.
   * {@link adopt} is the zero-copy alternative.
   */
  replace(x: Vec, y: Vec, count: number): void {
    this.reserve(count);
    for (let i = 0; i < count; i += 1) {
      this.#x[i] = x[i] ?? 0;
      this.#y[i] = y[i] ?? 0;
    }
    this.#count = Math.max(0, count);
  }

  /**
   * Replace the contents by **taking over** `x` and `y`.
   *
   * No copy: the dataset's columns become the arrays passed in. Intended for a
   * transferred `ArrayBuffer` from the parse worker, and for tests that need to
   * assert a dataset is genuinely zero-copy.
   *
   * The columns must be `Float64Array` — accepting a `Float32Array` here would
   * silently change the precision of every downstream computation, and accepting
   * a *view* would make "the buffer is transferable" false in a way that only
   * shows up as a detached-array error much later.
   */
  adopt(x: Float64Array, y: Float64Array, count: number): void {
    if (count < 0 || count > x.length || count > y.length) {
      throw new RangeError(
        `adopt(${String(count)}) exceeds the columns: x.length=${String(x.length)}, ` +
          `y.length=${String(y.length)}.`,
      );
    }
    this.#x = x;
    this.#y = y;
    this.#count = count;
  }

  /** Drop every sample. Keeps the allocation. */
  clear(): void {
    this.#count = 0;
  }

  /**
   * Min/max of both columns, with every exclusion accounted for.
   *
   * Delegates rather than inlining so the rule about what counts as unusable
   * lives in exactly one place — including for the renderer, which has to make
   * the same judgement when building geometry.
   */
  bounds(options?: BoundsOptions): BoundsResult {
    return options === undefined
      ? computeBounds(this.#x, this.#y, this.#count)
      : computeBounds(this.#x, this.#y, this.#count, options);
  }
}
