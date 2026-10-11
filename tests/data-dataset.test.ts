import { describe, expect, it } from 'vitest';

import { DataSet } from '../src/data/DataSet';

/**
 * Columnar storage.
 *
 * Two properties are worth more than the rest and both are about *ownership*:
 * `replace` must copy (so a caller can reuse its buffers) and `adopt` must not
 * (so a Worker can hand over a buffer instead of copying a million points). Those
 * two are asserted by mutating the source afterwards and checking whether the
 * dataset changed — the only way to tell them apart from the outside.
 */

describe('growth', () => {
  it('starts empty', () => {
    const set = new DataSet();
    expect(set.count).toBe(0);
    expect(set.capacity).toBe(0);
  });

  it('grows without losing samples', () => {
    const set = new DataSet(4);
    for (let i = 0; i < 100; i += 1) set.push(i, i * 2);
    expect(set.count).toBe(100);
    expect(set.capacity).toBeGreaterThanOrEqual(100);
    for (let i = 0; i < 100; i += 1) {
      expect(set.x[i]).toBe(i);
      expect(set.y[i]).toBe(i * 2);
    }
  });

  it('only reallocates when it has to', () => {
    const set = new DataSet(64);
    const before = set.x;
    set.push(1, 1);
    // Same backing store: a resize per push is the kind of thing that looks fine
    // in a test of 10 samples and is a disaster at 10^6.
    expect(set.x).toBe(before);
    for (let i = 0; i < 1000; i += 1) set.push(i, i);
    expect(set.capacity).toBeGreaterThanOrEqual(1001);
  });

  it('reserves without changing the count', () => {
    const set = new DataSet();
    set.reserve(1000);
    expect(set.capacity).toBeGreaterThanOrEqual(1000);
    expect(set.count).toBe(0);
  });

  it('keeps data across a reserve', () => {
    const set = new DataSet(2);
    set.push(1, 10);
    set.push(2, 20);
    set.reserve(500);
    expect(set.count).toBe(2);
    expect(Array.from(set.x.subarray(0, 2))).toEqual([1, 2]);
    expect(Array.from(set.y.subarray(0, 2))).toEqual([10, 20]);
  });
});

describe('pushMany', () => {
  it('appends a batch', () => {
    const set = new DataSet();
    set.pushMany(Float64Array.from([1, 2, 3]), Float64Array.from([4, 5, 6]), 3);
    expect(set.count).toBe(3);
    expect(Array.from(set.x.subarray(0, 3))).toEqual([1, 2, 3]);
  });

  it('appends after existing samples', () => {
    const set = new DataSet();
    set.push(0, 0);
    set.pushMany(Float64Array.from([1, 2]), Float64Array.from([3, 4]), 2);
    expect(Array.from(set.x.subarray(0, 3))).toEqual([0, 1, 2]);
  });

  it('reads from a source offset', () => {
    const set = new DataSet();
    set.pushMany(Float64Array.from([9, 9, 7]), Float64Array.from([9, 9, 8]), 1, 2);
    expect(Array.from(set.x.subarray(0, 1))).toEqual([7]);
    expect(Array.from(set.y.subarray(0, 1))).toEqual([8]);
  });

  it('ignores a non-positive batch size', () => {
    const set = new DataSet();
    set.pushMany(new Float64Array(0), new Float64Array(0), 0);
    expect(set.count).toBe(0);
  });
});

describe('replace copies', () => {
  it('is unaffected by later changes to the source', () => {
    const set = new DataSet();
    const x = Float64Array.from([1, 2, 3]);
    const y = Float64Array.from([4, 5, 6]);
    set.replace(x, y, 3);
    x[0] = 999;
    y[0] = 999;
    // Copying is the safe default: the caller keeps ownership of its buffers.
    expect(set.x[0]).toBe(1);
    expect(set.y[0]).toBe(4);
  });

  it('shrinks the count when given fewer samples', () => {
    const set = new DataSet();
    set.pushMany(Float64Array.from([1, 2, 3, 4]), Float64Array.from([1, 2, 3, 4]), 4);
    set.replace(Float64Array.from([9]), Float64Array.from([8]), 1);
    expect(set.count).toBe(1);
    expect(set.x[0]).toBe(9);
  });

  it('accepts a Float32Array source', () => {
    const set = new DataSet();
    set.replace(Float32Array.from([1.5, 2.5]), Float32Array.from([3.5, 4.5]), 2);
    expect(set.count).toBe(2);
    expect(set.x[1]).toBe(2.5);
  });
});

describe('adopt takes ownership', () => {
  it('does not copy', () => {
    const set = new DataSet();
    const x = Float64Array.from([1, 2, 3]);
    const y = Float64Array.from([4, 5, 6]);
    set.adopt(x, y, 3);
    expect(set.x).toBe(x);
    expect(set.y).toBe(y);
    // No copy means a later change to the same buffer is visible. That is the
    // point: a Worker's transferred buffer must not be duplicated.
    x[0] = 999;
    expect(set.x[0]).toBe(999);
  });

  it('allows a slackful buffer', () => {
    const set = new DataSet();
    set.adopt(Float64Array.from([1, 2, 3, 4]), Float64Array.from([1, 2, 3, 4]), 2);
    expect(set.count).toBe(2);
    expect(set.capacity).toBe(4);
    expect(set.x.length).toBe(4);
  });

  it('refuses a count the columns cannot hold', () => {
    const set = new DataSet();
    expect(() => set.adopt(Float64Array.from([1]), Float64Array.from([1, 2]), 2)).toThrowError(
      /exceeds the columns/,
    );
    expect(() => set.adopt(Float64Array.from([1]), Float64Array.from([1]), -1)).toThrowError(
      RangeError,
    );
  });
});

describe('clear', () => {
  it('drops the samples and keeps the allocation', () => {
    const set = new DataSet();
    set.pushMany(Float64Array.from([1, 2, 3]), Float64Array.from([1, 2, 3]), 3);
    const before = set.x;
    set.clear();
    expect(set.count).toBe(0);
    expect(set.x).toBe(before);
  });
});

describe('bounds', () => {
  it('delegates to computeBounds', () => {
    const set = new DataSet();
    set.pushMany(Float64Array.from([0, 5, 10]), Float64Array.from([-1, 4, 2]), 3);
    const result = set.bounds();
    expect(result.bounds).toEqual({ xMin: 0, xMax: 10, yMin: -1, yMax: 4 });
    expect(result.skipped).toEqual([]);
  });

  it('passes the log flags through and reports the exclusions', () => {
    const set = new DataSet();
    set.pushMany(Float64Array.from([1, 2, 3]), Float64Array.from([0, -1, 5]), 3);
    const result = set.bounds({ logY: true });
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.kind).toBe('nonPositiveLog');
    // One usable sample survived, so the extent is built from it alone.
    expect(result.bounds).toEqual({ xMin: 3, xMax: 3, yMin: 5, yMax: 5 });
  });

  it('reads only the live samples, not the slack', () => {
    const set = new DataSet(100);
    set.push(1, 1);
    // Slots 1..99 are zero-filled slack and must not widen the extent.
    expect(set.bounds().bounds).toEqual({ xMin: 1, xMax: 1, yMin: 1, yMax: 1 });
  });
});
