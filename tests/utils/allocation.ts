/**
 * Differential heap-growth measurement.
 *
 * A single 8 ms GC pause is enough to blow the p99 budget for a 16.7 ms frame, so
 * "this path does not allocate" is asserted rather than left to code review.
 *
 * Three decisions make the measurement trustworthy:
 *
 * 1. **Differential.** The measuring loop and a do-nothing loop are measured the
 *    same way, and only the difference is judged. That cancels the harness' own
 *    bookkeeping, which is otherwise larger than the effect being measured.
 * 2. **The measurement is itself tested.** `allocation.test.ts` runs a
 *    deliberately allocating body through the same helper and requires it to
 *    exceed the budget. Without that, a silently broken measurement would make
 *    every gate here pass forever.
 * 3. **Exact-zero is not required.** `BUDGET_BYTES_PER_FRAME` is a few bytes of
 *    slack, because the runtime's own timer bookkeeping is not perfectly flat and
 *    a one-object-per-frame leak is 40–80 bytes — an order of magnitude above the
 *    budget, so slack costs nothing in sensitivity.
 *
 * `global.gc` is used when the runtime exposes it (`node --expose-gc`). Without
 * it the numbers are noisier, which is why the budget is expressed per iteration
 * rather than as an absolute.
 */

export const ALLOCATION_ITERATIONS = 2000;

/**
 * Bytes of slack per iteration.
 *
 * The gate's real target is "no object per frame": a single small object is
 * 40–80 bytes, so a handful of bytes of slack cannot hide one.
 */
export const BUDGET_BYTES_PER_FRAME = 8;

const forceGc = (globalThis as { gc?: () => void }).gc;

/** Keeps allocated objects reachable so the measurement cannot be optimised away. */
export const allocationSink: unknown[] = [];

export function growthOver(iterations: number, body: (i: number) => void): number {
  forceGc?.();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < iterations; i += 1) body(i);
  forceGc?.();
  return process.memoryUsage().heapUsed - before;
}

/**
 * Heap growth per call of `body`, with the harness' own cost subtracted.
 *
 * Callers should warm the code path up first (a few hundred iterations): the
 * first passes through a function allocate hidden-class transitions and inline
 * caches, which would otherwise be attributed to the body.
 */
export function bytesPerIteration(
  body: (i: number) => void,
  iterations = ALLOCATION_ITERATIONS,
): number {
  const baseline = growthOver(iterations, () => undefined);
  const measured = growthOver(iterations, body);
  return (measured - baseline) / iterations;
}
