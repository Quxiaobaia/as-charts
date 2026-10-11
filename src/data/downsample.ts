import type { Scale } from './Scale';
import type { Vec } from './types';

/**
 * Viewport decimation, min/max per pixel column.
 *
 * ## Why only min/max, and why that is not negotiable
 *
 * Bucketing a million points into 1200 pixel columns must not lose a spike. A
 * one-sample spike of 10× amplitude is exactly what an alarm dashboard exists to
 * show, and every cheaper scheme eats it: mean-of-bucket averages it away,
 * "one representative point per bucket" drops it, and first-or-last-of-bucket
 * misses it two times out of three. So min/max is the only algorithm here, and
 * `'none' / 'minmax' / 'lttb'` is *not* a downgrade ladder — there is no
 * per-frame lever that reduces the sampling fidelity. That decision was made
 * once, at design time, because the moment frame time gets tight the cheapest
 * lever available is the one that silently loses a spike.
 *
 * ## Invariants this module exists to hold
 *
 * 1. **Every non-empty bucket contributes both of its extremes**, in sample
 *    order. Never just one of them, so the y-envelope of the bucket survives.
 *    The number of output points is therefore exactly `2 × nonEmptyBuckets`.
 * 2. **Every output point carries `srcIndex`**, the index of the sample it came
 *    from. Without it, picking cannot map a decimated point back to a real one,
 *    and the id space would have to be allocated over decimated points — which
 *    change on every zoom.
 * 3. **A point budget shrinks the bucket count, never the per-bucket output.**
 *    Asking for fewer points than `2 × pixelWidth` yields fewer, wider buckets.
 *    The alternative reading — keep the buckets, emit one point each — is the
 *    mean-of-bucket mistake wearing a budget as a disguise.
 */

/** Decimated points plus the real sample each one came from. */
export interface DownsampleResult {
  /** Point x values, length `count`. Backing array may be longer. */
  readonly x: Float64Array;
  /** Point y values, length `count`. Backing array may be longer. */
  readonly y: Float64Array;
  /** Index into the *input* columns for each output point, length `count`. */
  readonly srcIndex: Uint32Array;
  /** How many of the leading entries are live. */
  readonly count: number;
  /** Buckets the estimator ran with. Equals `count / 2` for a fully covered axis. */
  readonly bucketCount: number;
}

export interface MinmaxOptions {
  /** Maps a data value to a pixel column. Pure, and safe to call from a Worker. */
  readonly scale: Scale;
  /** Pixel columns across the viewport. Sets the default bucket count. */
  readonly pixelWidth: number;
  /**
   * Total point budget. Defaults to `2 × pixelWidth`.
   *
   * A budget below that reduces the bucket count; it never reduces the number of
   * points emitted per bucket.
   */
  readonly maxPoints?: number;
}

/**
 * Min/max decimation over the viewport, allocating its own output.
 *
 * Convenient and honest for one-shot use; use {@link MinmaxWorkspace} on a pan
 * path, where the allocation per frame is the thing being avoided.
 */
export function minmaxDownsample(
  x: Vec,
  y: Vec,
  count: number,
  options: MinmaxOptions,
): DownsampleResult {
  return new MinmaxWorkspace().run(x, y, count, options);
}

/**
 * A decimator with reusable buffers.
 *
 * The returned object is **the same object on every call** and is overwritten in
 * place. That is the point — a pan gesture must not allocate — but it means the
 * result is only valid until the next `run()`. Read what you need, or copy it.
 */
export class MinmaxWorkspace {
  #outX = new Float64Array(0);
  #outY = new Float64Array(0);
  #outIndex = new Uint32Array(0);
  /** Index of the sample holding the bucket's minimum y, or -1 when empty. */
  #bucketMin = new Int32Array(0);
  /** Index of the sample holding the bucket's maximum y, or -1 when empty. */
  #bucketMax = new Int32Array(0);
  readonly #result: MutableResult = {
    x: this.#outX,
    y: this.#outY,
    srcIndex: this.#outIndex,
    count: 0,
    bucketCount: 0,
  };

  run(x: Vec, y: Vec, count: number, options: MinmaxOptions): DownsampleResult {
    if (count > 0xffff_ffff) {
      throw new RangeError(
        `minmaxDownsample indexes samples with a Uint32Array, so it accepts at most ` +
          `2^32 - 1 samples; got ${String(count)}.`,
      );
    }

    const pixelWidth = Math.max(1, Math.floor(options.pixelWidth));
    const budget =
      options.maxPoints === undefined ? pixelWidth * 2 : Math.max(0, Math.floor(options.maxPoints));
    // The whole point of invariant 3: clipping the budget changes the divisor,
    // not the number of points emitted per bucket.
    const bucketCount = Math.max(1, Math.min(pixelWidth, Math.floor(budget / 2), count));

    this.#reserve(bucketCount);
    const bucketMin = this.#bucketMin;
    const bucketMax = this.#bucketMax;
    bucketMin.fill(-1, 0, bucketCount);
    bucketMax.fill(-1, 0, bucketCount);

    const scale = options.scale;
    const perBucket = pixelWidth / bucketCount;

    for (let i = 0; i < count; i += 1) {
      // `?? 0` satisfies `noUncheckedIndexedAccess`; the loop bound guarantees it
      // cannot fire.
      const pixel = scale.valueToPixel(x[i] ?? 0);
      // Outside the viewport, or not representable by the scale (a `NaN` from a
      // log axis given a non-positive value). Either way it cannot be drawn.
      if (!(pixel >= 0 && pixel < pixelWidth)) continue;

      let bucket = Math.floor(pixel / perBucket);
      if (bucket < 0) bucket = 0;
      else if (bucket >= bucketCount) bucket = bucketCount - 1;

      const yi = y[i] ?? 0;
      if (!Number.isFinite(yi)) {
        // A single `NaN` would poison the whole bucket's extent and blank out a
        // column of the chart. Reporting it is `computeBounds`' job; ignoring it
        // here is what keeps one bad sample from erasing its neighbours.
        continue;
      }

      const minAt = bucketMin[bucket] ?? -1;
      if (minAt === -1) {
        bucketMin[bucket] = i;
        bucketMax[bucket] = i;
        continue;
      }
      if (yi < (y[bucketMin[bucket] ?? 0] ?? 0)) bucketMin[bucket] = i;
      if (yi > (y[bucketMax[bucket] ?? 0] ?? 0)) bucketMax[bucket] = i;
    }

    const outX = this.#outX;
    const outY = this.#outY;
    const outIndex = this.#outIndex;
    let n = 0;
    for (let bucket = 0; bucket < bucketCount; bucket += 1) {
      const minAt = bucketMin[bucket] ?? -1;
      if (minAt === -1) continue;
      const maxAt = bucketMax[bucket] ?? minAt;
      // Emitted in sample order so x stays monotonic within a bucket; emitting
      // min-then-max unconditionally would draw small zig-zags on every column.
      const first = minAt <= maxAt ? minAt : maxAt;
      const second = minAt <= maxAt ? maxAt : minAt;

      outX[n] = x[first] ?? 0;
      outY[n] = y[first] ?? 0;
      outIndex[n] = first;
      n += 1;

      outX[n] = x[second] ?? 0;
      outY[n] = y[second] ?? 0;
      outIndex[n] = second;
      n += 1;
    }

    this.#result.x = outX;
    this.#result.y = outY;
    this.#result.srcIndex = outIndex;
    this.#result.count = n;
    this.#result.bucketCount = bucketCount;
    return this.#result;
  }

  #reserve(bucketCount: number): void {
    if (this.#bucketMin.length < bucketCount) {
      // Grow in whole powers so a slow zoom does not reallocate per frame; the
      // exact factor does not matter, only that it is amortised.
      let size = Math.max(64, this.#bucketMin.length);
      while (size < bucketCount) size *= 2;
      this.#bucketMin = new Int32Array(size);
      this.#bucketMax = new Int32Array(size);
    }
    const points = bucketCount * 2;
    if (this.#outX.length < points) {
      let size = Math.max(64, this.#outX.length);
      while (size < points) size *= 2;
      this.#outX = new Float64Array(size);
      this.#outY = new Float64Array(size);
      this.#outIndex = new Uint32Array(size);
    }
  }
}

/**
 * The workspace's live result.
 *
 * Mutable by design. `readonly` on the public interface is a promise to callers,
 * not a constraint on the implementation, and TypeScript's structural typing lets
 * the same object be both.
 */
interface MutableResult {
  x: Float64Array;
  y: Float64Array;
  srcIndex: Uint32Array;
  count: number;
  bucketCount: number;
}
