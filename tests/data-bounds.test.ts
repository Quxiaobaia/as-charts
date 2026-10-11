import { afterEach, describe, expect, it, vi } from 'vitest';

import { Diagnostics } from '../src/core/Diagnostics';
import {
  classify,
  computeBounds,
  describeSkips,
  reportSkips,
  type BoundsResult,
  type SkipDiagnostic,
} from '../src/data/bounds';

/**
 * Bounds and their exclusions.
 *
 * This suite exists because of one specific failure mode borrowed from
 * webgl-plot: `autoScale()` skips a series whose usable values fall below 10%,
 * and reports nothing. A line then disappears and the chart looks healthy.
 * Everything here is about making an exclusion *observable* — counted, attributed
 * to a column, and attached to the first offending sample.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

/** Named columns rather than pairs, because transposing them silently is easy. */
function columns(
  x: readonly number[],
  y: readonly number[],
): {
  x: Float64Array;
  y: Float64Array;
} {
  return { x: Float64Array.from(x), y: Float64Array.from(y) };
}

function skipFor(result: BoundsResult, kind: string, axis?: string): SkipDiagnostic | undefined {
  return result.skipped.find((s) => s.kind === kind && (axis === undefined || s.axis === axis));
}

describe('computeBounds', () => {
  it('returns the extent of both columns', () => {
    const data = columns([0, 10, -4, 7], [1, 5, 3, 2]);
    const result = computeBounds(data.x, data.y, 4);
    expect(result.bounds).toEqual({ xMin: -4, xMax: 10, yMin: 1, yMax: 5 });
    expect(result.skipped).toEqual([]);
  });

  it('reads only the first `count` entries', () => {
    const data = columns([1, 2, 1e9], [1, 2, 1e9]);
    const result = computeBounds(data.x, data.y, 2);
    expect(result.bounds).toEqual({ xMin: 1, xMax: 2, yMin: 1, yMax: 2 });
    expect(result.skipped).toEqual([]);
  });

  it('accepts a Float32Array column', () => {
    const result = computeBounds(Float32Array.from([0, 1, 2]), Float32Array.from([5, -5, 0]), 3);
    expect(result.bounds).toEqual({ xMin: 0, xMax: 2, yMin: -5, yMax: 5 });
  });

  it('counts NaN samples and points at the first one', () => {
    const data = columns([0, NaN, 3, 4], [1, 2, 3, 4]);
    const result = computeBounds(data.x, data.y, 4);
    expect(skipFor(result, 'nan', 'x')).toEqual({
      kind: 'nan',
      count: 1,
      firstIndex: 1,
      axis: 'x',
    });
    // The one bad sample is excluded; the extent still covers the rest.
    expect(result.bounds).toEqual({ xMin: 0, xMax: 4, yMin: 1, yMax: 4 });
  });

  it('counts infinities separately from NaN', () => {
    const data = columns([0, Infinity, -Infinity], [1, 2, 3]);
    const result = computeBounds(data.x, data.y, 3);
    expect(skipFor(result, 'infinite', 'x')).toEqual({
      kind: 'infinite',
      count: 2,
      firstIndex: 1,
      axis: 'x',
    });
    expect(skipFor(result, 'nan')).toBeUndefined();
  });

  it('reports negative infinity as infinite, not as a log problem', () => {
    // Precedence is fixed so the report does not depend on which check ran
    // first: a value that is both negative and infinite is `infinite`.
    const data = columns([0], [-Infinity]);
    const result = computeBounds(data.x, data.y, 1, { logY: true });
    expect(skipFor(result, 'infinite', 'y')?.count).toBe(1);
    expect(skipFor(result, 'nonPositiveLog')).toBeUndefined();
  });

  it('rejects zero and negatives only when the column is a log axis', () => {
    const data = columns([0, 1], [0, -3]);

    const linear = computeBounds(data.x, data.y, 2);
    expect(linear.skipped).toEqual([]);
    expect(linear.bounds).toEqual({ xMin: 0, xMax: 1, yMin: -3, yMax: 0 });

    const log = computeBounds(data.x, data.y, 2, { logY: true });
    expect(skipFor(log, 'nonPositiveLog', 'y')).toEqual({
      kind: 'nonPositiveLog',
      count: 2,
      firstIndex: 0,
      axis: 'y',
    });
    // Nothing usable remains, so there is no extent to report.
    expect(log.bounds).toBeNull();
  });

  it('rejects a non-positive x only when x is the log axis', () => {
    const data = columns([0, 1, -1], [5, 6, 7]);
    const asLog = computeBounds(data.x, data.y, 3, { logX: true });
    expect(skipFor(asLog, 'nonPositiveLog', 'x')?.count).toBe(2);
    // The one positive sample still yields an extent, so the bounds are not
    // abandoned just because some samples were.
    expect(asLog.bounds).toEqual({ xMin: 1, xMax: 1, yMin: 6, yMax: 6 });

    expect(computeBounds(data.x, data.y, 3).bounds).toEqual({
      xMin: -1,
      xMax: 1,
      yMin: 5,
      yMax: 7,
    });
  });

  it('attributes a doubly-unusable sample to x', () => {
    // Fixed order again: the same data must always produce the same report.
    const data = columns([NaN], [NaN]);
    const result = computeBounds(data.x, data.y, 1);
    expect(result.skipped[0]).toEqual({ kind: 'nan', count: 1, firstIndex: 0, axis: 'x' });
    // Nothing usable survived, so the extent is refused as well. Both facts are
    // reported: one says why samples went, the other says there is no result.
    expect(skipFor(result, 'insufficientPoints')).toBeDefined();
  });

  it('keeps one entry per kind and axis, aggregated', () => {
    const data = columns([NaN, 2, NaN, 3, Infinity, 5, 7], [0, NaN, 0, NaN, 0, NaN, 7]);
    const result = computeBounds(data.x, data.y, 7);
    expect(result.skipped).toHaveLength(3);
    expect(skipFor(result, 'nan', 'x')).toEqual({
      kind: 'nan',
      count: 2,
      firstIndex: 0,
      axis: 'x',
    });
    expect(skipFor(result, 'nan', 'y')).toEqual({
      kind: 'nan',
      count: 3,
      firstIndex: 1,
      axis: 'y',
    });
    expect(skipFor(result, 'infinite', 'x')).toEqual({
      kind: 'infinite',
      count: 1,
      firstIndex: 4,
      axis: 'x',
    });
    // The last sample is the only usable one, and it is what the extent is
    // built from — not a fallback, and not a mixture that includes bad values.
    expect(result.bounds).toEqual({ xMin: 7, xMax: 7, yMin: 7, yMax: 7 });
  });

  it('returns null bounds rather than a fabricated zero extent', () => {
    const data = columns([NaN, NaN], [1, 2]);
    const result = computeBounds(data.x, data.y, 2);
    // `{0, 0}` would put an axis at the origin and look like real data.
    expect(result.bounds).toBeNull();
    expect(skipFor(result, 'insufficientPoints')).toEqual({
      kind: 'insufficientPoints',
      count: 0,
      firstIndex: -1,
    });
  });

  it('returns null bounds for an empty column', () => {
    const result = computeBounds(new Float64Array(0), new Float64Array(0), 0);
    expect(result.bounds).toBeNull();
    expect(result.skipped).toEqual([{ kind: 'insufficientPoints', count: 0, firstIndex: -1 }]);
  });

  it('keeps degenerate bounds for a single sample', () => {
    // One sample is plottable — it is a dot. Collapsing it to `null` would hide
    // a real sample; the scale handles the collapsed domain instead.
    const data = columns([3], [4]);
    const result = computeBounds(data.x, data.y, 1);
    expect(result.bounds).toEqual({ xMin: 3, xMax: 3, yMin: 4, yMax: 4 });
    expect(result.skipped).toEqual([]);
  });
});

describe('classify', () => {
  it('applies the documented precedence', () => {
    expect(classify(NaN, false)).toBe('nan');
    expect(classify(Infinity, false)).toBe('infinite');
    expect(classify(-Infinity, true)).toBe('infinite');
    expect(classify(0, true)).toBe('nonPositiveLog');
    expect(classify(-1, true)).toBe('nonPositiveLog');
    expect(classify(0, false)).toBeNull();
    expect(classify(1, true)).toBeNull();
  });
});

describe('describeSkips', () => {
  it('names the column, the count and the first offender', () => {
    const text = describeSkips([
      { kind: 'nonPositiveLog', count: 12, firstIndex: 3, axis: 'y' },
      { kind: 'insufficientPoints', count: 0, firstIndex: -1 },
    ]);
    expect(text).toBe('y: 12 nonPositiveLog, first #3; column: 0 insufficientPoints');
  });
});

describe('reportSkips', () => {
  function warnSpy(): string[] {
    const warnings: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    });
    return warnings;
  }

  const oneSkip: readonly SkipDiagnostic[] = [{ kind: 'nan', count: 1, firstIndex: 0, axis: 'x' }];

  it('says nothing when nothing was excluded', () => {
    const warnings = warnSpy();
    const diagnostics = new Diagnostics('warn');
    const listener = vi.fn();
    diagnostics.on(listener);
    reportSkips(diagnostics, 'series-1', []);
    expect(listener).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
    diagnostics.dispose();
  });

  it('names the series and the reason', () => {
    const warnings = warnSpy();
    const diagnostics = new Diagnostics('warn');
    reportSkips(diagnostics, 'temperature', [
      { kind: 'nonPositiveLog', count: 4, firstIndex: 7, axis: 'y' },
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('temperature');
    expect(warnings[0]).toContain('nonPositiveLog');
    expect(warnings[0]).toContain('first #7');
    diagnostics.dispose();
  });

  it('warns once per series, not once per library', () => {
    const warnings = warnSpy();
    const diagnostics = new Diagnostics('warn');
    reportSkips(diagnostics, 'series-a', oneSkip);
    reportSkips(diagnostics, 'series-a', oneSkip);
    // A dashboard with eight series must not have seven of them fall silent
    // behind the first — that is the "silent line" bug in a different costume.
    reportSkips(diagnostics, 'series-b', oneSkip);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('series-a');
    expect(warnings[1]).toContain('series-b');
    diagnostics.dispose();
  });

  it('throws in a strict build, because excluded data is a defect', () => {
    // Unlike a missing GPU extension, unusable samples are the caller's data, so
    // a `'throw'` build is allowed to stop them.
    const diagnostics = new Diagnostics('throw');
    expect(() =>
      reportSkips(diagnostics, 'series-1', [{ kind: 'nan', count: 2, firstIndex: 5, axis: 'x' }]),
    ).toThrowError(/excluded 2 sample/);
    diagnostics.dispose();
  });

  it('reaches a listener even when the level is silent', () => {
    // Telemetry is how a support bundle explains a missing line in production,
    // where no one is reading the console.
    const diagnostics = new Diagnostics('silent');
    const listener = vi.fn();
    diagnostics.on(listener);
    reportSkips(diagnostics, 'series-1', [{ kind: 'nan', count: 1, firstIndex: 0, axis: 'y' }]);
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'data/skipped-points:series-1' }),
    );
    diagnostics.dispose();
  });
});
