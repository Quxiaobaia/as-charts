import { ticks as d3Ticks, tickStep as d3TickStep } from 'd3-array';
import { scaleLog, scaleTime } from 'd3-scale';
import { describe, expect, it } from 'vitest';

import {
  categoryTicks,
  linearTicks,
  logTicks,
  tickStep,
  timeTicks,
  type TickSet,
} from '../src/data/ticks';

/**
 * Tick algorithms, checked against d3 rather than against themselves.
 *
 * ## Why the assertions are shaped like this
 *
 * Each suite runs the whole case table and asserts that the *list of
 * disagreements* is empty, instead of one `it` per case. Two reasons:
 *
 * 1. When a port drifts it drifts in a family of cases, not one. A single failure
 *    listing all of them shows the shape of the mistake immediately, whereas
 *    twenty separate failures have to be read one at a time.
 * 2. Equality is exact, including the last bit. d3's tick arithmetic is
 *    `(i1 + i) * inc` and its log helper builds powers of ten from a string
 *    (`1e-3`) to dodge `Math.pow` rounding; both are reproduced deliberately, so
 *    a tolerance here would hide the very thing being tested.
 *
 * d3 is a `devDependency` used only as an oracle. Nothing in `src/` imports it.
 */

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (!Object.is(a[i], b[i])) return false;
  return true;
}

interface Disagreement {
  readonly input: string;
  readonly ours: readonly number[];
  readonly d3: readonly number[];
}

function collect(
  cases: readonly (readonly number[])[],
  ours: (c: readonly number[]) => readonly number[],
  theirs: (c: readonly number[]) => readonly number[],
  label: (c: readonly number[]) => string,
): Disagreement[] {
  const bad: Disagreement[] = [];
  for (const c of cases) {
    const mine = ours(c);
    const reference = theirs(c);
    if (!sameNumbers(mine, reference)) {
      bad.push({ input: label(c), ours: mine, d3: reference });
    }
  }
  return bad;
}

const LINEAR_CASES: readonly (readonly number[])[] = [
  [0, 1, 10],
  [0, 1, 3],
  [0, 10, 5],
  [0, 100, 10],
  [-1, 1, 5],
  [-50, 50, 4],
  [1, 2, 4],
  [0, 0.1, 5],
  [0.0001, 0.0009, 3],
  [1e6, 1e6 + 10, 5],
  [0, 1e9, 8],
  [5, 5, 5],
  [10, 0, 4],
  [-0.5, 0.5, 2],
  [0, 7, 7],
  [123.456, 789.012, 6],
  [0, 1, 0.5],
  [0, 1, 1.5],
  [3, 3.5, 2],
  [-1e-6, 1e-6, 4],
  [1, 100, 2],
  [0, 24, 24],
  [270, 300, 5],
  [0, 0.03, 4],
  [1e-8, 1e-7, 3],
  [0, 1e21, 5],
  [-1e21, 1e21, 6],
];

const LOG_CASES: readonly (readonly number[])[] = [
  [1, 10, 10],
  [1, 100, 10],
  [1, 1000, 10],
  [0.1, 10, 8],
  [2, 8, 5],
  [1, 1e6, 5],
  [0.001, 1, 10],
  [1, 1e-3, 6],
  [5, 500, 10],
  [1, 2, 3],
  [3, 7, 4],
  [10, 20, 5],
  [1, 10000, 20],
  [2, 2, 3],
  [0.5, 0.6, 4],
  [1e-9, 1e-3, 3],
  [1, 9, 20],
  [100, 1, 5],
  [4, 40000, 12],
  [1, 1e12, 4],
  [0.3, 3, 7],
  [1.5, 15, 6],
];

/** Epoch-relative spans, chosen to land on each rung of the interval ladder. */
const TIME_CASES: readonly (readonly number[])[] = [
  [0, 1_000, 10],
  [0, 500, 5],
  [0, 100, 5],
  [0, 30_000, 6],
  [0, 60_000, 6],
  [0, 900_000, 6],
  [0, 1_800_000, 6],
  [0, 3_600_000, 6],
  [0, 43_200_000, 6],
  [0, 86_400_000, 4],
  [0, 172_800_000, 4],
  [0, 604_800_000, 7],
  [0, 2_592_000_000, 6],
  [0, 7_776_000_000, 6],
  [0, 31_536_000_000, 12],
  [0, 315_360_000_000, 10],
  [0, 31_536_000_000 * 100, 5],
  [-432_000_000, 432_000_000, 10],
  [1_728_000_000_000, 1_728_000_000_000 + 86_400_000, 5],
  [1_728_000_000_000, 1_728_000_000_000 + 21_600_000, 7],
  [1_728_000_000_000, 1_728_000_000_000 + 45_000, 6],
  [1_700_000_000_000, 1_700_000_000_000 + 86_400_000 * 400, 8],
];

const fmt = (c: readonly number[]): string => `[${c.join(', ')}]`;

describe('linearTicks', () => {
  it(`agrees with d3-array over ${String(LINEAR_CASES.length)} cases`, () => {
    const bad = collect(
      LINEAR_CASES,
      ([start, stop, count]) => linearTicks(start ?? 0, stop ?? 0, count ?? 1).values,
      ([start, stop, count]) => d3Ticks(start ?? 0, stop ?? 0, count ?? 1),
      fmt,
    );
    expect(bad, `${String(bad.length)} disagreement(s)`).toEqual([]);
  });

  it('reports the same step as d3', () => {
    const bad: string[] = [];
    for (const c of LINEAR_CASES) {
      const [start = 0, stop = 0, count = 1] = c;
      if (stop < start) continue;
      const mine = tickStep(start, stop, count);
      const reference = d3TickStep(start, stop, count);
      if (!Object.is(mine, reference))
        bad.push(`${fmt(c)}: ${String(mine)} vs ${String(reference)}`);
    }
    expect(bad, `${String(bad.length)} disagreement(s)`).toEqual([]);
  });

  it('produces ascending round numbers inside the domain', () => {
    for (const [start = 0, stop = 0, count = 1] of LINEAR_CASES) {
      // A reversed domain is checked separately, and legitimately descends.
      if (stop < start) continue;
      const { values } = linearTicks(start, stop, count);
      expect(values.length, `no ticks for ${fmt([start, stop, count])}`).toBeGreaterThan(0);
      for (let i = 0; i < values.length; i += 1) {
        const v = values[i] ?? 0;
        expect(v >= Math.min(start, stop) - 1e-9, `below domain: ${String(v)}`).toBe(true);
        expect(v <= Math.max(start, stop) + 1e-9, `above domain: ${String(v)}`).toBe(true);
        if (i > 0) expect(v > (values[i - 1] ?? 0), 'not ascending').toBe(true);
      }
    }
  });

  it('spaces ticks uniformly, which is what makes a linear axis readable', () => {
    const { values, step } = linearTicks(-50, 50, 4);
    expect(values.length).toBeGreaterThan(2);
    expect(step).toBe(20);
    for (let i = 1; i < values.length; i += 1) {
      const gap = (values[i] ?? 0) - (values[i - 1] ?? 0);
      expect(Math.abs(gap - step)).toBeLessThan(1e-9);
    }
  });

  it('returns a single tick for a collapsed domain', () => {
    expect(linearTicks(5, 5, 5).values).toEqual([5]);
  });

  it('descends when the domain is reversed', () => {
    const { values } = linearTicks(10, 0, 4);
    expect(values.length).toBeGreaterThan(0);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i] ?? 0).toBeLessThan(values[i - 1] ?? 0);
    }
  });

  // Divergence #1 in the module docs: d3 only reaches this by accident of
  // `NaN >= NaN` being false, so the guard is explicit here.
  it('returns nothing for a non-finite domain or count', () => {
    expect(linearTicks(0, Infinity, 5).values).toEqual([]);
    expect(linearTicks(-Infinity, 0, 5).values).toEqual([]);
    expect(linearTicks(0, NaN, 5).values).toEqual([]);
    expect(linearTicks(0, 10, 0).values).toEqual([]);
    expect(linearTicks(0, 10, -3).values).toEqual([]);
    expect(linearTicks(0, 10, Infinity).values).toEqual([]);
  });
});

describe('logTicks', () => {
  it(`agrees with d3-scale over ${String(LOG_CASES.length)} cases`, () => {
    const bad = collect(
      LOG_CASES,
      ([start, stop, count]) => logTicks(start ?? 1, stop ?? 1, count ?? 1).values,
      ([start, stop, count]) =>
        scaleLog()
          .domain([start ?? 1, stop ?? 1])
          .ticks(count ?? 1),
      fmt,
    );
    expect(bad, `${String(bad.length)} disagreement(s)`).toEqual([]);
  });

  it('walks every mantissa when the domain is narrower than the tick budget', () => {
    // The regime that gives a log axis its familiar 1, 2, 5, 10, 20 shape.
    const { values } = logTicks(1, 10, 10);
    expect(Array.from(values)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('falls back to decade steps when the domain spans more than the budget', () => {
    const { values } = logTicks(1, 1e6, 5);
    expect(Array.from(values)).toEqual([1, 10, 100, 1e3, 1e4, 1e5, 1e6]);
  });

  // Divergence #2 in the module docs.
  it('refuses a non-positive domain instead of reflecting the transform', () => {
    expect(() => logTicks(0, 10, 5)).toThrowError(RangeError);
    expect(() => logTicks(-1, 10, 5)).toThrowError(/log axis requires a positive domain/);
  });

  it('returns nothing for a non-positive count', () => {
    expect(logTicks(1, 10, 0).values).toEqual([]);
  });

  it('honours a non-decimal base', () => {
    const { values } = logTicks(1, 8, 8, 2);
    expect(values.length).toBeGreaterThan(0);
    expect(values[0]).toBe(1);
    expect(values[values.length - 1]).toBe(8);
  });
});

describe('timeTicks', () => {
  it(`agrees with d3-scale over ${String(TIME_CASES.length)} cases`, () => {
    // d3's `scaleTime().ticks()` returns `Date` objects; the engine deals in
    // epoch milliseconds throughout, so the oracle is coerced rather than the
    // engine being given a `Date` path it does not need.
    const bad = collect(
      TIME_CASES,
      ([start, stop, count]) => timeTicks(start ?? 0, stop ?? 0, count ?? 1).values,
      ([start, stop, count]) =>
        scaleTime()
          .domain([new Date(start ?? 0), new Date(stop ?? 0)])
          .ticks(count ?? 1)
          .map(Number),
      fmt,
    );
    expect(bad, `${String(bad.length)} disagreement(s)`).toEqual([]);
  });

  it('lands on calendar boundaries rather than on arbitrary instants', () => {
    // 2024-06-15T00:00Z-ish; the assertion is timezone-independent because it
    // checks the local wall clock, which is what a time axis displays.
    const day = 86_400_000;
    const start = 1_718_000_000_000;
    const { values, unit, unitStep } = timeTicks(start, start + day * 10, 6);
    expect(unit).not.toBe('millisecond');
    expect(unitStep).toBeGreaterThan(0);
    for (const v of values) {
      const d = new Date(v);
      // A day-aligned step means midnight; an hour-aligned step means :00:00.
      if (unit === 'day' || unit === 'month' || unit === 'year') {
        expect(d.getHours(), `not midnight: ${d.toISOString()}`).toBe(0);
        expect(d.getMinutes()).toBe(0);
        expect(d.getSeconds()).toBe(0);
      }
    }
  });

  it('picks a coarser unit as the span grows', () => {
    const second = 1_000;
    const seen = new Set<string>();
    for (const span of [second * 10, second * 600, 86_400_000 * 2, 86_400_000 * 400]) {
      const { unit } = timeTicks(1_700_000_000_000, 1_700_000_000_000 + span, 6);
      if (unit !== undefined) seen.add(unit);
    }
    expect(seen.size).toBeGreaterThanOrEqual(4);
    expect(seen.has('second')).toBe(true);
    expect(seen.has('minute')).toBe(true);
  });

  it('reports the unit and its multiple so a formatter can pick a precision', () => {
    const fiveMinutes = timeTicks(0, 3_600_000, 12);
    expect(fiveMinutes.unit).toBe('minute');
    expect(fiveMinutes.unitStep).toBeGreaterThanOrEqual(1);
  });

  it('descends when the range is reversed', () => {
    const { values } = timeTicks(86_400_000, 0, 5);
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i] ?? 0).toBeLessThan(values[i - 1] ?? 0);
    }
  });

  it('returns nothing for a non-finite range or count', () => {
    expect(timeTicks(0, Infinity, 5).values).toEqual([]);
    expect(timeTicks(0, 1000, 0).values).toEqual([]);
  });
});

describe('categoryTicks', () => {
  it('spreads labels evenly across the range, endpoints included', () => {
    // 10 categories with room for 3 labels. Even spacing including both ends is
    // the readable choice; "round indices" has no meaning for a category, its
    // labels are names.
    const { values, step } = categoryTicks(10, 3);
    expect(Array.from(values)).toEqual([0, 5, 9]);
    expect(step).toBe(5);
  });

  it('never exceeds the budget', () => {
    for (const [count, maxTicks] of [
      [10, 3],
      [100, 10],
      [1000, 7],
      [37, 4],
    ] as const) {
      const { values } = categoryTicks(count, maxTicks);
      expect(values.length, `${String(count)}/${String(maxTicks)}`).toBeLessThanOrEqual(maxTicks);
      expect(
        values.every((v) => Number.isInteger(v)),
        'indices must be integers',
      ).toBe(true);
      expect(values[0]).toBe(0);
      expect(values[values.length - 1]).toBe(count - 1);
    }
  });

  it('returns every index when there is room for all of them', () => {
    const { values, step } = categoryTicks(4, 10);
    expect(Array.from(values)).toEqual([0, 1, 2, 3]);
    expect(step).toBe(1);
  });

  it('handles a degenerate count or budget', () => {
    expect(categoryTicks(1, 5).values).toEqual([0]);
    expect(categoryTicks(0, 5).values).toEqual([]);
    // A single-label budget still yields one label rather than nothing.
    expect(categoryTicks(10, 1).values).toEqual([0]);
  });

  it('collapses duplicates when rounding would repeat an index', () => {
    // 3 categories with room for 3 labels: rounding 0, 1, 2 is fine, but 2
    // categories with room for 3 would round to 0, 0, 1 and must not emit 0 twice.
    expect(Array.from(categoryTicks(2, 3).values)).toEqual([0, 1]);
  });
});

describe('TickSet shape', () => {
  it('always reports a step of 0 when fewer than two ticks exist', () => {
    const single: TickSet = linearTicks(3, 3, 5);
    expect(single.values.length).toBe(1);
    expect(single.step).toBe(0);
  });
});
