import type { Vec } from './types';

/**
 * Fixed-capacity streaming store: appending past the end overwrites the oldest
 * sample.
 *
 * ## Why there is no bridge geometry here
 *
 * webgl-plot carries two extra vertices per line specifically to bridge the seam
 * where a ring buffer wraps (`WebglLineRoll`), because it draws the whole ring as
 * one `LINE_STRIP` over a linear buffer — so the last physical vertex and the
 * first physical vertex end up adjacent in the strip, and the line leaps across
 * the chart unless a bridging pair is stitched in.
 *
 * This engine's geometry is one instanced quad **per segment** (see the M1 design,
 * §6.2), so segments are enumerated from time order, not from storage order. The
 * seam is therefore not a thing that exists, and no bridging geometry is needed.
 * What the geometry code does need is a way to walk samples in time order, which
 * is what {@link orderedIndex} and {@link copyOrdered} provide.
 *
 * ## The sentinel bug this avoids
 *
 * webgl-plot decides whether the bridge needs refreshing by testing
 * `lastDataX !== 0 || lastDataY !== 0`. A series that legitimately sits at the
 * origin therefore gets no bridge and draws a chord across the plot. The fix is
 * not a better sentinel but the absence of one: this class tracks an explicit
 * `count`, so "how many samples are live" is never inferred from a value.
 */
export class RingBuffer {
  #x: Float64Array;
  #y: Float64Array;
  #capacity: number;
  /** Live samples. Saturates at {@link capacity}. */
  #count = 0;
  /** Physical slot the next append writes to. */
  #head = 0;
  /** Samples ever appended, including overwritten ones. */
  #total = 0;

  constructor(capacity: number) {
    const size = Math.floor(capacity);
    if (!(size > 0)) {
      throw new RangeError(`RingBuffer capacity must be at least 1, got ${String(capacity)}.`);
    }
    this.#capacity = size;
    this.#x = new Float64Array(size);
    this.#y = new Float64Array(size);
  }

  get capacity(): number {
    return this.#capacity;
  }

  /** Live samples, `0 … capacity`. */
  get count(): number {
    return this.#count;
  }

  /**
   * Physical slot the next append writes to.
   *
   * Exposed because an incremental GPU upload needs it: the samples between the
   * previous head and this one are exactly the bytes that changed.
   */
  get head(): number {
    return this.#head;
  }

  /** Samples ever appended. Useful for detecting that a wrap happened. */
  get totalAppended(): number {
    return this.#total;
  }

  /**
   * Number of consecutive-sample segments, i.e. `count - 1`.
   *
   * This is the instance count for one line's instanced geometry, which is why it
   * is a named property rather than a subtraction at each call site.
   */
  get segmentCount(): number {
    return this.#count > 1 ? this.#count - 1 : 0;
  }

  /**
   * The live x storage. Mutating it corrupts the buffer; it is exposed for
   * zero-copy reads (and for handing to a Worker as a transferable buffer).
   */
  get x(): Float64Array {
    return this.#x;
  }

  /** The live y storage. See {@link x}. */
  get y(): Float64Array {
    return this.#y;
  }

  /** Append one sample. Allocation-free. */
  append(x: number, y: number): void {
    this.#x[this.#head] = x;
    this.#y[this.#head] = y;
    this.#head = (this.#head + 1) % this.#capacity;
    if (this.#count < this.#capacity) this.#count += 1;
    this.#total += 1;
  }

  /**
   * Append `count` samples from parallel columns. Allocation-free.
   *
   * The batch keeps its internal order; the write is done slot by slot rather
   * than in one `set()` because a batch longer than the capacity would otherwise
   * have to be trimmed in a way that depends on wrap arithmetic for every case,
   * and getting that wrong drops samples silently.
   */
  appendMany(x: Vec, y: Vec, count: number, srcOffset = 0): void {
    for (let i = 0; i < count; i += 1) {
      this.append(x[srcOffset + i] ?? 0, y[srcOffset + i] ?? 0);
    }
  }

  /**
   * Physical index of the `i`-th oldest live sample.
   *
   * O(1), which is what makes walking in time order as cheap as walking in
   * storage order.
   */
  orderedIndex(i: number): number {
    return (this.#head - this.#count + i + this.#capacity) % this.#capacity;
  }

  /** x of the `i`-th oldest live sample. */
  xAt(i: number): number {
    return this.#x[this.orderedIndex(i)] ?? 0;
  }

  /** y of the `i`-th oldest live sample. */
  yAt(i: number): number {
    return this.#y[this.orderedIndex(i)] ?? 0;
  }

  /** x of the newest sample, or `NaN` when empty. */
  get lastX(): number {
    return this.#count === 0
      ? NaN
      : (this.#x[(this.#head - 1 + this.#capacity) % this.#capacity] ?? 0);
  }

  /** y of the newest sample, or `NaN` when empty. */
  get lastY(): number {
    return this.#count === 0
      ? NaN
      : (this.#y[(this.#head - 1 + this.#capacity) % this.#capacity] ?? 0);
  }

  /**
   * Copy the live samples into `outX`/`outY` in time order, oldest first.
   *
   * Writes at most two contiguous runs: the tail of the ring, then its head. No
   * intermediate allocation, which matters because this is called on the resize
   * path.
   *
   * @returns how many samples were copied.
   */
  copyOrdered(outX: Vec, outY: Vec, outOffset = 0): number {
    if (this.#count === 0) return 0;
    const first = this.orderedIndex(0);
    const tail = Math.min(this.#count, this.#capacity - first);
    outX.set(this.#x.subarray(first, first + tail), outOffset);
    outY.set(this.#y.subarray(first, first + tail), outOffset);
    const rest = this.#count - tail;
    if (rest > 0) {
      outX.set(this.#x.subarray(0, rest), outOffset + tail);
      outY.set(this.#y.subarray(0, rest), outOffset + tail);
    }
    return this.#count;
  }

  /**
   * Resize, keeping the newest `min(count, capacity)` samples.
   *
   * Growing preserves everything; shrinking drops the oldest, because the newest
   * samples are the ones a live monitor is watching.
   */
  setCapacity(capacity: number): void {
    const size = Math.floor(capacity);
    if (!(size > 0)) {
      throw new RangeError(`RingBuffer capacity must be at least 1, got ${String(capacity)}.`);
    }
    if (size === this.#capacity) return;

    const kept = Math.min(this.#count, size);
    const nextX = new Float64Array(size);
    const nextY = new Float64Array(size);
    // Only the newest `kept` samples survive, so start that far back from the end.
    for (let i = 0; i < kept; i += 1) {
      const from = this.orderedIndex(this.#count - kept + i);
      nextX[i] = this.#x[from] ?? 0;
      nextY[i] = this.#y[from] ?? 0;
    }

    this.#capacity = size;
    this.#x = nextX;
    this.#y = nextY;
    this.#count = kept;
    // A full ring must keep its head at 0 so that `orderedIndex` reads the oldest
    // sample from slot 0; anything else adds a second wrap case for no benefit.
    this.#head = kept === size ? 0 : kept;
  }

  /**
   * Drop every sample.
   *
   * `totalAppended` resets too: after a clear the buffer is indistinguishable from
   * a new one, which is what a caller rebuilding a chart expects.
   */
  clear(): void {
    this.#count = 0;
    this.#head = 0;
    this.#total = 0;
  }
}
