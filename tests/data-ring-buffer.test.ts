import { describe, expect, it } from 'vitest';

import { RingBuffer } from '../src/data/RingBuffer';

/**
 * Ring buffer order and resize semantics.
 *
 * The interesting cases are all about the wrap: which sample is "oldest", that
 * walking in time order costs the same as walking in storage order, and that a
 * resize keeps the *newest* samples. There is deliberately no bridging geometry
 * to test — see the class doc: instanced per-segment geometry enumerates time
 * order, so the seam webgl-plot has to stitch up does not exist here.
 */

/** Read the live samples in time order, via the public accessors only. */
function ordered(ring: RingBuffer): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < ring.count; i += 1) out.push([ring.xAt(i), ring.yAt(i)]);
  return out;
}

describe('sequential use', () => {
  it('keeps insertion order before the wrap', () => {
    const ring = new RingBuffer(8);
    for (let i = 0; i < 5; i += 1) ring.append(i, i * 10);
    expect(ring.count).toBe(5);
    expect(ring.head).toBe(5);
    expect(ring.totalAppended).toBe(5);
    expect(ordered(ring)).toEqual([
      [0, 0],
      [1, 10],
      [2, 20],
      [3, 30],
      [4, 40],
    ]);
  });

  it('reports segments, not samples', () => {
    const ring = new RingBuffer(8);
    expect(ring.segmentCount).toBe(0);
    ring.append(1, 1);
    // One sample is a dot, not a segment: the count would otherwise produce a
    // degenerate instance.
    expect(ring.segmentCount).toBe(0);
    ring.append(2, 2);
    expect(ring.segmentCount).toBe(1);
  });

  it('exposes the newest sample', () => {
    const ring = new RingBuffer(4);
    expect(Number.isNaN(ring.lastX)).toBe(true);
    expect(Number.isNaN(ring.lastY)).toBe(true);
    ring.append(3, 4);
    expect(ring.lastX).toBe(3);
    expect(ring.lastY).toBe(4);
  });
});

describe('wrapping', () => {
  it('evicts the oldest and keeps time order', () => {
    const ring = new RingBuffer(4);
    for (let i = 0; i < 10; i += 1) ring.append(i, i);
    expect(ring.count).toBe(4);
    expect(ring.totalAppended).toBe(10);
    expect(ordered(ring)).toEqual([
      [6, 6],
      [7, 7],
      [8, 8],
      [9, 9],
    ]);
  });

  it('stays correct when every value is zero', () => {
    // webgl-plot decides whether its wrap bridge needs refreshing by testing
    // `lastDataX !== 0 || lastDataY !== 0`, so a series that legitimately sits at
    // the origin loses its bridge and draws a chord across the plot. This class
    // tracks an explicit count instead, so all-zero data has to behave like any
    // other data.
    const ring = new RingBuffer(3);
    for (let i = 0; i < 7; i += 1) ring.append(0, 0);
    expect(ring.count).toBe(3);
    expect(ordered(ring)).toEqual([
      [0, 0],
      [0, 0],
      [0, 0],
    ]);
    // Order is still knowable, which is what the explicit head provides.
    expect(ring.orderedIndex(0)).toBe(ring.head);
  });

  it('is unmoved by the physical layout of the wrap', () => {
    const ring = new RingBuffer(5);
    for (let i = 0; i < 13; i += 1) ring.append(i, -i);
    const values = ordered(ring);
    expect(values).toHaveLength(5);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]?.[0] ?? 0).toBeGreaterThan(values[i - 1]?.[0] ?? 0);
    }
    expect(values[0]).toEqual([8, -8]);
    expect(values[4]).toEqual([12, -12]);
  });
});

describe('copyOrdered', () => {
  it('copies the whole ring in time order, accounting for the wrap', () => {
    const ring = new RingBuffer(5);
    for (let i = 0; i < 8; i += 1) ring.append(i, i * 2);
    const x = new Float64Array(5);
    const y = new Float64Array(5);
    expect(ring.copyOrdered(x, y)).toBe(5);
    expect(Array.from(x)).toEqual([3, 4, 5, 6, 7]);
    expect(Array.from(y)).toEqual([6, 8, 10, 12, 14]);
  });

  it('copies a partially filled ring', () => {
    const ring = new RingBuffer(10);
    for (let i = 0; i < 3; i += 1) ring.append(i, i);
    const x = new Float64Array(10);
    const y = new Float64Array(10);
    expect(ring.copyOrdered(x, y)).toBe(3);
    expect(Array.from(x.subarray(0, 3))).toEqual([0, 1, 2]);
  });

  it('does nothing for an empty ring', () => {
    const ring = new RingBuffer(4);
    expect(ring.copyOrdered(new Float64Array(4), new Float64Array(4))).toBe(0);
  });

  it('honours an output offset', () => {
    const ring = new RingBuffer(3);
    ring.append(1, 1);
    ring.append(2, 2);
    const x = new Float64Array(5);
    const y = new Float64Array(5);
    expect(ring.copyOrdered(x, y, 2)).toBe(2);
    expect(Array.from(x)).toEqual([0, 0, 1, 2, 0]);
  });
});

describe('setCapacity', () => {
  it('preserves everything when growing', () => {
    const ring = new RingBuffer(4);
    for (let i = 0; i < 4; i += 1) ring.append(i, i);
    ring.setCapacity(10);
    expect(ring.capacity).toBe(10);
    expect(ring.count).toBe(4);
    expect(ordered(ring)).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
  });

  it('keeps the newest samples when shrinking', () => {
    // The newest samples are the ones a live monitor is watching, so a shrink
    // that dropped them would be exactly backwards.
    const ring = new RingBuffer(10);
    for (let i = 0; i < 10; i += 1) ring.append(i, i);
    ring.setCapacity(3);
    expect(ring.capacity).toBe(3);
    expect(ring.count).toBe(3);
    expect(ordered(ring)).toEqual([
      [7, 7],
      [8, 8],
      [9, 9],
    ]);
  });

  it('keeps the newest samples when the ring has wrapped', () => {
    const ring = new RingBuffer(4);
    for (let i = 0; i < 9; i += 1) ring.append(i, i);
    expect(ordered(ring)).toEqual([
      [5, 5],
      [6, 6],
      [7, 7],
      [8, 8],
    ]);
    ring.setCapacity(2);
    expect(ordered(ring)).toEqual([
      [7, 7],
      [8, 8],
    ]);
  });

  it('can grow after a wrap without losing time order', () => {
    const ring = new RingBuffer(3);
    for (let i = 0; i < 7; i += 1) ring.append(i, i);
    ring.setCapacity(6);
    expect(ring.count).toBe(3);
    expect(ordered(ring)).toEqual([
      [4, 4],
      [5, 5],
      [6, 6],
    ]);
    // Still writable and still ordered after the growth.
    ring.append(7, 7);
    expect(ring.count).toBe(4);
    expect(ring.lastX).toBe(7);
  });

  it('is a no-op for the same capacity', () => {
    const ring = new RingBuffer(4);
    ring.append(1, 1);
    ring.setCapacity(4);
    expect(ring.count).toBe(1);
    expect(ring.capacity).toBe(4);
  });

  it('rejects a capacity below one', () => {
    const ring = new RingBuffer(4);
    expect(() => ring.setCapacity(0)).toThrowError(/at least 1/);
    expect(() => new RingBuffer(0)).toThrowError(/at least 1/);
  });
});

describe('appendMany', () => {
  it('appends a batch in order', () => {
    const ring = new RingBuffer(5);
    ring.appendMany(Float64Array.from([1, 2, 3]), Float64Array.from([10, 20, 30]), 3);
    expect(ordered(ring)).toEqual([
      [1, 10],
      [2, 20],
      [3, 30],
    ]);
  });

  it('evicts correctly when a batch wraps more than once', () => {
    // A batch longer than the capacity must keep the *last* `capacity` samples,
    // which is where slot-by-slot appends differ from one bulk `set()`.
    const ring = new RingBuffer(3);
    ring.appendMany(
      Float64Array.from([0, 1, 2, 3, 4, 5, 6]),
      Float64Array.from([0, 1, 2, 3, 4, 5, 6]),
      7,
    );
    expect(ordered(ring)).toEqual([
      [4, 4],
      [5, 5],
      [6, 6],
    ]);
  });

  it('reads from a source offset', () => {
    const ring = new RingBuffer(4);
    ring.appendMany(Float64Array.from([9, 9, 1, 2]), Float64Array.from([9, 9, 3, 4]), 2, 2);
    expect(ordered(ring)).toEqual([
      [1, 3],
      [2, 4],
    ]);
  });

  it('ignores an empty batch', () => {
    const ring = new RingBuffer(4);
    ring.appendMany(new Float64Array(0), new Float64Array(0), 0);
    expect(ring.count).toBe(0);
  });
});

describe('clear', () => {
  it('drops the samples and keeps the allocation', () => {
    const ring = new RingBuffer(8);
    for (let i = 0; i < 20; i += 1) ring.append(i, i);
    const before = ring.x;
    ring.clear();
    expect(ring.count).toBe(0);
    expect(ring.head).toBe(0);
    expect(ring.totalAppended).toBe(0);
    expect(ring.capacity).toBe(8);
    // Same buffer, so a caller rebuilding a chart does not thrash the allocator.
    expect(ring.x).toBe(before);
    expect(ordered(ring)).toEqual([]);
  });

  it('appends in order again after a clear', () => {
    const ring = new RingBuffer(3);
    for (let i = 0; i < 7; i += 1) ring.append(i, i);
    ring.clear();
    ring.append(100, 100);
    ring.append(101, 101);
    expect(ordered(ring)).toEqual([
      [100, 100],
      [101, 101],
    ]);
  });
});
