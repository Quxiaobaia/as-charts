import { describe, expect, it } from 'vitest';

import { Renderer } from '../src/renderer/Renderer';
import { ALL_EXTENSIONS, createMockCanvas, createMockGL } from './utils/mock-gl';

/**
 * Zero-per-frame-allocation gate.
 *
 * A single 8 ms GC pause is enough to blow the p99 budget for a 16.7 ms frame, so
 * this is asserted rather than left to code review. Two decisions make the test
 * trustworthy:
 *
 * 1. **Differential measurement.** The loop that renders and the loop that does
 *    nothing are measured the same way, and only the difference is judged. That
 *    cancels out the harness' own bookkeeping, which is otherwise larger than the
 *    effect being measured.
 * 2. **The measurement is itself tested.** A deliberate allocation loop must
 *    exceed the threshold, otherwise a silently broken measurement would make
 *    this gate pass forever.
 *
 * `global.gc` is used when the runtime exposes it (`node --expose-gc`); without it
 * the numbers are noisier, so the threshold is expressed per frame rather than as
 * an absolute and the sensitivity check still applies.
 */

const ITERATIONS = 2000;
/** Bytes of slack per frame. Real zero-allocation measures ~0; one small object
 *  per frame would be ~40-80. */
const BUDGET_BYTES_PER_FRAME = 8;

const forceGc = (globalThis as { gc?: () => void }).gc;

function heapUsed(): number {
  return process.memoryUsage().heapUsed;
}

function growthOver(iterations: number, body: (i: number) => void): number {
  forceGc?.();
  const before = heapUsed();
  for (let i = 0; i < iterations; i += 1) body(i);
  forceGc?.();
  return heapUsed() - before;
}

/** Keeps allocated objects reachable so the measurement cannot be optimised away. */
const sink: unknown[] = [];

describe('per-frame allocation', () => {
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

    const baseline = growthOver(ITERATIONS, () => undefined);
    const rendered = growthOver(ITERATIONS, () => {
      renderer.renderNow();
    });
    const delta = rendered - baseline;
    const perFrame = delta / ITERATIONS;

    expect(
      perFrame,
      `baseline=${String(baseline)}B rendered=${String(rendered)}B over ${String(ITERATIONS)} frames`,
    ).toBeLessThan(BUDGET_BYTES_PER_FRAME);

    renderer.destroy();
  });

  it('detects allocation when it exists', () => {
    // Guards the guard: if this ever stops exceeding the budget, the gate above
    // has become meaningless.
    const baseline = growthOver(ITERATIONS, () => undefined);
    const allocating = growthOver(ITERATIONS, () => {
      sink.push({ a: 1, b: 2, c: [1, 2, 3] });
    });

    const perFrame = (allocating - baseline) / ITERATIONS;
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

    const baseline = growthOver(ITERATIONS, () => undefined);
    const writing = growthOver(ITERATIONS, (i) => {
      // Writes into a pre-allocated Float32Array, indexed by an existing slot.
      layer.setInstance(i % 100, i, i, 1, 1, 1, 1);
      layer.upload();
    });

    const perFrame = (writing - baseline) / ITERATIONS;
    expect(perFrame, `writing=${String(writing)}B baseline=${String(baseline)}B`).toBeLessThan(
      BUDGET_BYTES_PER_FRAME,
    );

    renderer.destroy();
  });
});
