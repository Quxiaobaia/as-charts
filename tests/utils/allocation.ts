/**
 * Differential heap-growth measurement.
 *
 * A single 8 ms GC pause is enough to blow the p99 budget for a 16.7 ms frame, so
 * "this path does not allocate" is asserted rather than left to code review.
 *
 * Four decisions make the measurement trustworthy:
 *
 * 1. **Differential.** The measuring loop and a do-nothing loop are measured the
 *    same way, and only the difference is judged. That cancels the harness' own
 *    bookkeeping, which is otherwise larger than the effect being measured.
 * 2. **Forced collection.** `vitest.config.ts` passes `--expose-gc`, without which
 *    this file is a false-negative machine: unrelated garbage survives into the
 *    "after" reading, and the *same* non-allocating closure measured anywhere from
 *    0 to 74 bytes per iteration across runs. That is not a small error — it is
 *    larger than the object-per-frame leak the gate exists to catch.
 * 3. **Minimum of several trials.** Noise on a flat path is one-sided: extra
 *    garbage can only inflate a reading, never deflate it below the truth. The
 *    smallest of several trials is therefore a far better estimator of "does this
 *    allocate at all" than any single trial, and it keeps a genuinely leaking body
 *    detectable, because garbage it *retains* shows up in every trial.
 * 4. **The measurement is itself tested.** `allocation.test.ts` runs a
 *    deliberately allocating body through the same helper and requires it to
 *    exceed the budget. Without that, a silently broken measurement would make
 *    every gate here pass forever.
 *
 * `BUDGET_BYTES_PER_FRAME` is a few bytes of slack rather than exactly zero,
 * because the runtime's own bookkeeping is not perfectly flat. A single
 * object-per-frame leak is 40–80 bytes, an order of magnitude above the budget,
 * so the slack costs nothing in sensitivity.
 */

export const ALLOCATION_ITERATIONS = 2000;

/**
 * Bytes of slack per iteration.
 *
 * The gate's real target is "no object per frame": a single small object is
 * 40–80 bytes, so a handful of bytes of slack cannot hide one.
 */
export const BUDGET_BYTES_PER_FRAME = 8;

/** Trials per measurement. See point 3 above for why the minimum is taken. */
export const ALLOCATION_TRIALS = 3;

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
 * Heap growth per call of `body`, with the harness' own cost subtracted and the
 * result taken as the smallest of `trials` runs.
 *
 * Callers should warm the code path up first (a few hundred iterations): the
 * first passes through a function allocate hidden-class transitions and inline
 * caches, which would otherwise be attributed to the body.
 */
export function bytesPerIteration(
  body: (i: number) => void,
  iterations = ALLOCATION_ITERATIONS,
  trials = ALLOCATION_TRIALS,
): number {
  let best = Number.POSITIVE_INFINITY;
  for (let trial = 0; trial < trials; trial += 1) {
    // The baseline is re-measured per trial rather than shared, so drift in the
    // runtime's own bookkeeping cancels within a trial instead of between two.
    const baseline = growthOver(iterations, () => undefined);
    const measured = growthOver(iterations, body);
    const value = (measured - baseline) / iterations;
    if (value < best) best = value;
  }
  return best;
}
