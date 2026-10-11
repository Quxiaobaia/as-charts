import { describe, expect, it } from 'vitest';

import { MinmaxWorkspace, createScale } from '../src/data/index';
import { RingBuffer } from '../src/data/RingBuffer';
import { Renderer } from '../src/renderer/Renderer';
import { BUDGET_BYTES_PER_FRAME, allocationSink, bytesPerIteration } from './utils/allocation';
import { ALL_EXTENSIONS, createMockCanvas, createMockGL } from './utils/mock-gl';

/**
 * Zero-per-frame-allocation gate.
 *
 * Two families are asserted here. The GPU-facing ones (rendering a frame, writing
 * instance attributes) were the M0 baseline. The data-layer ones (decimating for
 * a pan, appending to a ring buffer) are the M1 addition, and they matter for the
 * same reason: a pan gesture runs them on every frame, so an allocation there is
 * a GC pause in the middle of a drag.
 *
 * See `utils/allocation.ts` for why the measurement is differential and why the
 * measurement is itself tested.
 */

describe('per-frame allocation', () => {
  it('measures with forced collection available', () => {
    // Guards the guard, twice over. `allocation.test.ts` already proves the
    // measurement can *detect* allocation; this proves it is running in the mode
    // where its readings mean anything at all.
    //
    // Without `--expose-gc` the differential measurement is dominated by garbage
    // that happens to survive into the "after" reading, and the very same
    // non-allocating closure was observed reading 0, 33, 63 and 74 bytes per
    // iteration across runs. A silent fallback to that mode is worse than a loud
    // failure: it does not merely lose sensitivity, it inverts it.
    expect(typeof (globalThis as { gc?: unknown }).gc).toBe('function');
  });

  it('allocates nothing measurable across a rendered frame', () => {
    const mock = createMockGL({ extensions: ALL_EXTENSIONS, record: false });
    const mockCanvas = createMockCanvas(mock);
    const renderer = new Renderer({
      canvas: mockCanvas.canvas,
      diagnostics: 'silent',
      devicePixelRatio: 1,
      maxFps: undefined,
    });

    const layer = renderer.addTriangleLayer({ initialCapacity: 64 });
    for (let i = 0; i < 64; i += 1) layer.setInstance(i, i, i, 1, 0.5, 0.5, 0.5);
    renderer.renderNow();

    // Warm up: JIT, inline caches and lazy property maps settle in the first few
    // hundred iterations and would otherwise dominate the measurement.
    for (let i = 0; i < 200; i += 1) renderer.renderNow();

    const perFrame = bytesPerIteration(() => {
      renderer.renderNow();
    });

    expect(perFrame, `${String(perFrame)} B/frame`).toBeLessThan(BUDGET_BYTES_PER_FRAME);

    renderer.destroy();
  });

  it('detects allocation when it exists', () => {
    // Guards the guard: if this ever stops exceeding the budget, every gate in
    // this file has become meaningless.
    const perFrame = bytesPerIteration(() => {
      allocationSink.push({ a: 1, b: 2, c: [1, 2, 3] });
    });
    expect(perFrame).toBeGreaterThan(BUDGET_BYTES_PER_FRAME);
  });

  it('allocates nothing measurable while writing instances', () => {
    const mock = createMockGL({ extensions: ALL_EXTENSIONS, record: false });
    const mockCanvas = createMockCanvas(mock);
    const renderer = new Renderer({
      canvas: mockCanvas.canvas,
      diagnostics: 'silent',
      devicePixelRatio: 1,
    });
    const layer = renderer.addTriangleLayer({ initialCapacity: 256 });

    for (let i = 0; i < 100; i += 1) layer.setInstance(i, i, i, 1, 1, 1, 1);
    for (let i = 0; i < 200; i += 1) layer.upload();

    const perFrame = bytesPerIteration((i) => {
      // Writes into a pre-allocated Float32Array, indexed by an existing slot.
      layer.setInstance(i % 100, i, i, 1, 1, 1, 1);
      layer.upload();
    });

    expect(perFrame, `${String(perFrame)} B/iteration`).toBeLessThan(BUDGET_BYTES_PER_FRAME);

    renderer.destroy();
  });
});

describe('data-layer allocation', () => {
  it('decimates a viewport without allocating', () => {
    const scale = createScale('linear', { domain: [0, 1000], range: [0, 1200] });
    const samples = 10_000;
    const x = new Float64Array(samples);
    const y = new Float64Array(samples);
    for (let i = 0; i < samples; i += 1) {
      x[i] = i;
      y[i] = Math.sin(i / 100);
    }

    const workspace = new MinmaxWorkspace();
    const options = { scale, pixelWidth: 1200 };
    // First run sizes the internal buffers; without this their growth would be
    // counted as per-frame allocation.
    workspace.run(x, y, samples, options);
    for (let i = 0; i < 100; i += 1) workspace.run(x, y, samples, options);

    // Reading the result keeps it live without allocating, and is also how a
    // renderer consumes it: counts and columns, never a copy.
    let observed = 0;
    const perFrame = bytesPerIteration(() => {
      const result = workspace.run(x, y, samples, options);
      observed = result.count;
    });

    expect(observed, 'the workspace must actually produce points').toBeGreaterThan(0);
    expect(perFrame, `${String(perFrame)} B/frame`).toBeLessThan(BUDGET_BYTES_PER_FRAME);
  });

  it('allocates nothing measurable while appending to a ring buffer', () => {
    const ring = new RingBuffer(1024);
    for (let i = 0; i < 4096; i += 1) ring.append(i, i);

    const perCall = bytesPerIteration((i) => {
      ring.append(i, i);
    });

    // Saturated, so every append overwrites the oldest sample — the wrap path is
    // the one a live monitor is on for its whole uptime.
    expect(ring.count).toBe(1024);
    expect(perCall, `${String(perCall)} B/append`).toBeLessThan(BUDGET_BYTES_PER_FRAME);
  });
});
