/**
 * Shared value types for the data layer.
 *
 * The data layer carries one hard rule: **no GL dependency**. Every module under
 * `src/data/` is either a pure function or a plain container, so the whole layer
 * runs under Node in Vitest and, later, inside a Worker. That is what lets the
 * gates that matter most here — envelope fidelity, tick agreement, allocation
 * budgets — be hard assertions rather than measurements that need a GPU.
 *
 * An axis of a chart is drawn from two separate concerns that happen to share a
 * domain: *where a value lands* (a {@link Scale}) and *which values deserve a
 * tick* (the algorithms in `ticks.ts`). Keeping them apart is what makes it
 * possible to run the tick algorithms against d3 without dragging a renderer in.
 */

/**
 * A column of samples.
 *
 * Both widths are accepted because the two target scenarios disagree. Scientific
 * plotting wants `Float64Array` so that large values keep their exactness;
 * industrial monitoring wants `Float32Array` because halving the upload is worth
 * more than the last digit.
 */
export type Vec = Float32Array | Float64Array;

/** An axis-aligned extent in data space. */
export interface Bounds {
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
}
