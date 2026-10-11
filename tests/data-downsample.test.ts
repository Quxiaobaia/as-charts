import { describe, expect, it } from 'vitest';

import { createScale, type Scale } from '../src/data/Scale';
import { MinmaxWorkspace, minmaxDownsample } from '../src/data/downsample';

/**
 * Min/max decimation.
 *
 * ## What is really being tested
 *
 * The point of this module is that a **one-sample spike survives**. Everything
 * else — bucket counts, `srcIndex`, the point budget — exists to make that true
 * while keeping the vertex count bounded. So the suite is written around that:
 *
 * - `B7` (`10^6` points, 200 single-sample spikes of 10× amplitude, native to
 *   the performance design) is asserted at **every bucket budget the data layer
 *   exposes**, because the bucket count is the one lever here that can lose a
 *   spike. The full B7 across LOD levels and degradation tiers lands with M1-d;
 *   the tiers themselves cannot change the outcome, since the ladder is not
 *   allowed to touch sampling.
 * - The envelope is then checked against an **independently written** bucketing
 *   loop. A test that reuses the implementation's own bucketing would agree with
 *   the implementation about where the bucket boundaries are, which is precisely
 *   the thing worth checking.
 */

/** Independent bucketing: same intent, different arithmetic. */
function bucketOf(pixel: number, pixelWidth: number, buckets: number): number {
  return Math.min(buckets - 1, Math.floor((pixel * buckets) / pixelWidth));
}

interface Spike {
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly spikes: readonly number[];
}

/**
 * `count` samples of a flat baseline with `spikeCount` single-sample spikes of
 * `amplitude × baseline`. The spike width of exactly one sample is the whole
 * point: it is what a mean-of-bucket or representative-point scheme loses.
 */
function withSpikes(count: number, spikeCount: number, amplitude: number, baseline = 1): Spike {
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  const stride = Math.floor(count / spikeCount);
  const spikes: number[] = [];
  for (let i = 0; i < count; i += 1) {
    x[i] = (i / (count - 1)) * 1000;
    y[i] = baseline;
  }
  for (let s = 0; s < spikeCount; s += 1) {
    const at = s * stride;
    y[at] = baseline * amplitude;
    spikes.push(at);
  }
  return { x, y, spikes };
}

function scaleFor(start: number, stop: number, pixelWidth: number): Scale {
  return createScale('linear', { domain: [start, stop], range: [0, pixelWidth] });
}

describe('minmaxDownsample envelope', () => {
  it('emits exactly the bucket extremes, in sample order', () => {
    const count = 400;
    const x = new Float64Array(count);
    const y = new Float64Array(count);
    for (let i = 0; i < count; i += 1) {
      x[i] = i;
      // A deterministic non-monotonic signal, so min and max are rarely adjacent
      // and the ordering rule is actually exercised.
      y[i] = Math.sin(i * 0.7) * 10 + Math.cos(i * 0.13);
    }

    const pixelWidth = 100;
    // Domain `[0, count]` rather than `[0, count - 1]`, so that the last sample
    // lands at pixel 99.75 and no sample sits on the viewport boundary. Samples at
    // pixel `>= pixelWidth` are legitimately dropped, and this test is about the
    // bucketing, not about the clipping (which has its own case below).
    const scale = scaleFor(0, count, pixelWidth);
    for (let i = 0; i < count; i += 1) {
      const pixel = scale.valueToPixel(x[i] ?? 0);
      expect(pixel, `sample ${String(i)} must be inside the viewport`).toBeLessThan(pixelWidth);
    }
    const result = minmaxDownsample(x, y, count, { scale, pixelWidth });

    // Independent reconstruction of what each bucket must have contributed.
    let expectedPoints = 0;
    const expectedMax = new Map<number, number>();
    const expectedMin = new Map<number, number>();
    for (let i = 0; i < count; i += 1) {
      const b = bucketOf(scale.valueToPixel(x[i] ?? 0), pixelWidth, result.bucketCount);
      const yi = y[i] ?? 0;
      const max = expectedMax.get(b);
      const min = expectedMin.get(b);
      if (max === undefined) {
        expectedMax.set(b, yi);
        expectedMin.set(b, yi);
        expectedPoints += 2;
        continue;
      }
      if (yi > max) expectedMax.set(b, yi);
      if (yi < min!) expectedMin.set(b, yi);
    }

    expect(result.count).toBe(expectedPoints);
    expect(result.count).toBeGreaterThan(0);

    // Every emitted point is a real sample, and carries the right value: this is
    // the `srcIndex` contract that picking depends on.
    for (let k = 0; k < result.count; k += 1) {
      const src = result.srcIndex[k] ?? 0;
      expect(result.x[k]).toBe(x[src]);
      expect(result.y[k]).toBe(y[src]);
    }

    // Each bucket's two points are its min and max, in ascending index order.
    let cursor = 0;
    for (let b = 0; b < result.bucketCount; b += 1) {
      if (!expectedMax.has(b)) continue;
      const firstY = result.y[cursor] ?? 0;
      const secondY = result.y[cursor + 1] ?? 0;
      const firstSrc = result.srcIndex[cursor] ?? 0;
      const secondSrc = result.srcIndex[cursor + 1] ?? 0;
      expect(firstSrc, 'points within a bucket must be in sample order').toBeLessThan(secondSrc);
      expect(Math.max(firstY, secondY)).toBe(expectedMax.get(b));
      expect(Math.min(firstY, secondY)).toBe(expectedMin.get(b));
      cursor += 2;
    }
    expect(cursor).toBe(result.count);
  });

  it('keeps x monotonic across the whole output', () => {
    // A zig-zag between min and max per bucket would show up as a torn line, so
    // the output order has to follow the axis even though each bucket held two
    // extremes.
    const count = 5000;
    const x = new Float64Array(count);
    const y = new Float64Array(count);
    for (let i = 0; i < count; i += 1) {
      x[i] = i;
      y[i] = Math.sin(i * 0.01) * 50;
    }
    const result = minmaxDownsample(x, y, count, {
      scale: scaleFor(0, count - 1, 600),
      pixelWidth: 600,
    });
    for (let k = 1; k < result.count; k += 1) {
      expect(result.x[k] ?? 0).toBeGreaterThanOrEqual(result.x[k - 1] ?? 0);
    }
  });

  it('drops samples outside the viewport rather than clamping them', () => {
    // Clamping would pile every off-screen sample onto the edge column and make
    // a spike outside the view look like a spike at the border.
    const count = 100;
    const x = new Float64Array(count);
    const y = new Float64Array(count);
    for (let i = 0; i < count; i += 1) {
      x[i] = i;
      y[i] = 1;
    }
    const pixelWidth = 1000;
    // Domain covers a tenth of the data, so 90% is off-viewport.
    const scale = scaleFor(0, count / 10, pixelWidth);
    const result = minmaxDownsample(x, y, count, { scale, pixelWidth });

    const visible = new Set<number>();
    for (let i = 0; i < count; i += 1) {
      const pixel = scale.valueToPixel(x[i] ?? 0);
      if (pixel >= 0 && pixel < pixelWidth) visible.add(i);
    }
    for (let k = 0; k < result.count; k += 1) {
      expect(visible.has(result.srcIndex[k] ?? -1)).toBe(true);
    }
    expect(result.count).toBeLessThanOrEqual(visible.size * 2);
  });

  it('ignores a NaN sample without blanking its bucket', () => {
    // One bad sample must not erase the column it sits in; reporting it is
    // `computeBounds`' job, not the decimator's.
    const count = 10;
    const x = Float64Array.from(Array.from({ length: count }, (_, i) => i));
    const y = Float64Array.from([1, 2, 3, NaN, 5, 6, 7, 8, 9, 10]);
    const result = minmaxDownsample(x, y, count, {
      scale: scaleFor(0, count - 1, count),
      pixelWidth: count,
    });
    for (let k = 0; k < result.count; k += 1) {
      expect(Number.isFinite(result.y[k] ?? NaN)).toBe(true);
    }
    // The surviving samples are present.
    expect(Array.from(result.y)).toContain(5);
  });
});

describe('point budget', () => {
  const count = 20_000;
  const x = Float64Array.from(Array.from({ length: count }, (_, i) => i));
  const y = Float64Array.from(Array.from({ length: count }, (_, i) => Math.sin(i * 0.001) * 100));
  const pixelWidth = 1000;

  it('uses one bucket per pixel column by default', () => {
    const result = minmaxDownsample(x, y, count, {
      scale: scaleFor(0, count - 1, pixelWidth),
      pixelWidth,
    });
    expect(result.bucketCount).toBe(pixelWidth);
    expect(result.count).toBeLessThanOrEqual(pixelWidth * 2);
  });

  it('shrinks the bucket count when the budget is smaller', () => {
    // The alternative reading — keep the buckets, emit one point each — is the
    // mean-of-bucket mistake wearing a budget as a disguise, so the per-bucket
    // output of two is asserted at every budget.
    const scale = scaleFor(0, count - 1, pixelWidth);
    for (const maxPoints of [2000, 400, 40, 8]) {
      const result = minmaxDownsample(x, y, count, { scale, pixelWidth, maxPoints });
      expect(result.bucketCount, `budget ${String(maxPoints)}`).toBe(maxPoints / 2);
      expect(result.count).toBeLessThanOrEqual(maxPoints);
      if (result.count > 2) {
        // Densely sampled data fills every bucket, so the output is exactly two
        // per bucket.
        expect(result.count).toBe(result.bucketCount * 2);
      }
    }
  });

  it('refuses an index space larger than a Uint32Array can address', () => {
    expect(() =>
      minmaxDownsample(x, y, 0x1_0000_0000, {
        scale: scaleFor(0, 1, 10),
        pixelWidth: 10,
      }),
    ).toThrowError(/Uint32Array/);
  });
});

describe('B7 · spike fidelity', () => {
  const COUNT = 1_000_000;
  const SPIKES = 200;
  const AMPLITUDE = 10;
  const PIXEL_WIDTH = 1200;

  const { x, y, spikes } = withSpikes(COUNT, SPIKES, AMPLITUDE);
  const scale = scaleFor(0, 1000, PIXEL_WIDTH);

  it('carries every spike value into the envelope at every budget', () => {
    // The budgets here are the only data-layer lever that exists, and the one
    // that can lose a spike. `Infinity` stands for "no budget" (one bucket per
    // pixel column).
    for (const maxPoints of [undefined, 2400, 1200, 600, 120, 40]) {
      const options =
        maxPoints === undefined
          ? { scale, pixelWidth: PIXEL_WIDTH }
          : { scale, pixelWidth: PIXEL_WIDTH, maxPoints };
      const result = minmaxDownsample(x, y, COUNT, options);

      // The envelope of every bucket that contains a spike must reach the spike.
      const envelope = new Map<number, number>();
      for (let k = 0; k < result.count; k += 1) {
        const src = result.srcIndex[k] ?? 0;
        const b = bucketOf(scale.valueToPixel(x[src] ?? 0), PIXEL_WIDTH, result.bucketCount);
        const seen = envelope.get(b) ?? -Infinity;
        envelope.set(b, Math.max(seen, result.y[k] ?? -Infinity));
      }

      let covered = 0;
      for (const at of spikes) {
        const b = bucketOf(scale.valueToPixel(x[at] ?? 0), PIXEL_WIDTH, result.bucketCount);
        if ((envelope.get(b) ?? -Infinity) >= AMPLITUDE) covered += 1;
      }
      expect(covered, `budget ${String(maxPoints)}: ${String(covered)}/${String(SPIKES)}`).toBe(
        SPIKES,
      );
    }
  });

  it('keeps each spike as its own point when each gets its own bucket', () => {
    const result = minmaxDownsample(x, y, COUNT, { scale, pixelWidth: PIXEL_WIDTH });
    const emitted = new Set<number>();
    for (let k = 0; k < result.count; k += 1) {
      if (result.y[k] === AMPLITUDE) emitted.add(result.srcIndex[k] ?? -1);
    }
    for (const at of spikes) {
      // The spike survives as itself, at its own x — not merely as the top edge
      // of a bucket. This is what picking relies on.
      expect(emitted.has(at), `spike #${String(at)} missing`).toBe(true);
    }
  });

  it('is the reason mean-of-bucket is banned, not a preference', () => {
    // Same data, same budget, the algorithm nobody is allowed to ship: at a
    // coarse budget a mean flattens 200 spikes into the baseline. This is the
    // concrete harm the design refused to leave available as a "emergency"
    // lever, so it is asserted rather than described.
    const buckets = 10;
    const width = COUNT / buckets;
    const means = new Float64Array(buckets);
    for (let i = 0; i < COUNT; i += 1) {
      const b = Math.min(buckets - 1, Math.floor(i / width));
      means[b] = (means[b] ?? 0) + (y[i] ?? 0) / width;
    }
    for (let b = 0; b < buckets; b += 1) {
      expect(means[b] ?? 0, 'a mean must not reach the spike amplitude').toBeLessThan(
        AMPLITUDE / 2,
      );
    }

    const result = minmaxDownsample(x, y, COUNT, {
      scale,
      pixelWidth: PIXEL_WIDTH,
      maxPoints: buckets * 2,
    });
    // The same data, the same budget, minmax: the envelope still reaches 10.
    expect(Math.max(...Array.from(result.y.subarray(0, result.count)))).toBe(AMPLITUDE);
  });
});

describe('MinmaxWorkspace', () => {
  const count = 5000;
  const x = Float64Array.from(Array.from({ length: count }, (_, i) => i));
  const y = Float64Array.from(Array.from({ length: count }, (_, i) => Math.sin(i * 0.01)));
  const options = { scale: scaleFor(0, count - 1, 800), pixelWidth: 800 };

  it('matches the allocating entry point', () => {
    const oneShot = minmaxDownsample(x, y, count, options);
    const workspace = new MinmaxWorkspace();
    const reused = workspace.run(x, y, count, options);
    expect(reused.count).toBe(oneShot.count);
    expect(reused.bucketCount).toBe(oneShot.bucketCount);
    expect(Array.from(reused.y.subarray(0, reused.count))).toEqual(
      Array.from(oneShot.y.subarray(0, oneShot.count)),
    );
    expect(Array.from(reused.srcIndex.subarray(0, reused.count))).toEqual(
      Array.from(oneShot.srcIndex.subarray(0, oneShot.count)),
    );
  });

  it('hands back the same object every time, which is the point', () => {
    const workspace = new MinmaxWorkspace();
    expect(workspace.run(x, y, count, options)).toBe(workspace.run(x, y, count, options));
  });

  it('grows its buffers instead of truncating a wider viewport', () => {
    const workspace = new MinmaxWorkspace();
    const narrow = workspace.run(x, y, count, {
      scale: scaleFor(0, count - 1, 10),
      pixelWidth: 10,
    });
    const narrowPoints = narrow.count;
    const wide = workspace.run(x, y, count, {
      scale: scaleFor(0, count - 1, 4000),
      pixelWidth: 4000,
    });
    expect(wide.bucketCount).toBe(4000);
    expect(wide.count).toBeGreaterThan(narrowPoints);
    // The buffers are still consistent after growing.
    for (let k = 0; k < wide.count; k += 1) {
      expect(wide.x[k]).toBe(x[wide.srcIndex[k] ?? 0]);
    }
  });

  it('handles an empty column', () => {
    const workspace = new MinmaxWorkspace();
    const result = workspace.run(new Float64Array(0), new Float64Array(0), 0, options);
    expect(result.count).toBe(0);
  });

  it('handles a single sample by emitting it twice', () => {
    const workspace = new MinmaxWorkspace();
    const result = workspace.run(Float64Array.from([5]), Float64Array.from([7]), 1, {
      scale: scaleFor(0, 10, 100),
      pixelWidth: 100,
    });
    expect(result.count).toBe(2);
    expect(result.srcIndex[0]).toBe(0);
    expect(result.srcIndex[1]).toBe(0);
    // Emitting it twice is what keeps "two points per non-empty bucket" true
    // without a special case; the degenerate segment draws as a point.
    expect(result.y[0]).toBe(7);
    expect(result.y[1]).toBe(7);
  });
});
