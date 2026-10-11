import { describe, expect, it } from 'vitest';

import { categoryScale, createScale, scaleOver, type Scale } from '../src/data/Scale';

/**
 * Scale semantics.
 *
 * The cases that matter are the ones a naive `(v - d0) / (d1 - d0)` gets wrong:
 * a reversed range (which is every y axis), a collapsed domain (a constant
 * series), and a value the scale cannot represent (a non-positive value on a log
 * axis). The first two must still produce a usable pixel; the third must produce
 * `NaN` rather than a plausible-looking clamp.
 */

function linear(): Scale {
  return createScale('linear', { domain: [0, 100], range: [0, 200] });
}

describe('linear scale', () => {
  it('maps domain endpoints onto range endpoints', () => {
    const scale = linear();
    expect(scale.valueToPixel(0)).toBe(0);
    expect(scale.valueToPixel(50)).toBe(100);
    expect(scale.valueToPixel(100)).toBe(200);
  });

  it('does not clamp a value outside the domain', () => {
    const scale = linear();
    // Extrapolating is what lets a partially visible line be drawn: a renderer
    // that receives clamped edges draws a flat line along the chart border.
    expect(scale.valueToPixel(-50)).toBe(-100);
    expect(scale.valueToPixel(150)).toBe(300);
  });

  it('inverts exactly', () => {
    const scale = linear();
    for (const value of [-25, 0, 12.5, 50, 99.9, 150]) {
      expect(scale.pixelToValue(scale.valueToPixel(value))).toBeCloseTo(value, 9);
    }
  });

  it('handles a reversed range, which is what every y axis is', () => {
    const scale = createScale('linear', { domain: [0, 100], range: [300, 0] });
    expect(scale.valueToPixel(0)).toBe(300);
    expect(scale.valueToPixel(100)).toBe(0);
    expect(scale.valueToPixel(25)).toBe(225);
    expect(scale.pixelToValue(300)).toBe(0);
    expect(scale.pixelToValue(0)).toBe(100);
  });

  it('centres a collapsed domain instead of dividing by zero', () => {
    const scale = createScale('linear', { domain: [5, 5], range: [0, 200] });
    // A constant series belongs in the middle of the plot. Returning a range
    // endpoint would put it on the axis line, where it reads as an axis artefact.
    expect(scale.valueToPixel(5)).toBe(100);
    expect(scale.valueToPixel(0)).toBe(100);
    expect(Number.isFinite(scale.valueToPixel(1e9))).toBe(true);
  });

  it('collapses a degenerate range to a single pixel', () => {
    const scale = createScale('linear', { domain: [0, 100], range: [42, 42] });
    expect(scale.valueToPixel(0)).toBe(42);
    expect(scale.valueToPixel(100)).toBe(42);
    expect(scale.pixelToValue(42)).toBe(50);
  });

  it('propagates NaN rather than inventing a position', () => {
    expect(Number.isNaN(linear().valueToPixel(NaN))).toBe(true);
  });
});

describe('log scale', () => {
  it('spaces by ratio, not by difference', () => {
    const scale = createScale('log', { domain: [1, 100], range: [0, 100] });
    expect(scale.valueToPixel(1)).toBe(0);
    expect(scale.valueToPixel(10)).toBeCloseTo(50, 9);
    expect(scale.valueToPixel(100)).toBeCloseTo(100, 9);
    // The arithmetic midpoint of the domain is *not* the pixel midpoint.
    expect(scale.valueToPixel(50.5)).toBeGreaterThan(50);
  });

  it('returns NaN for a value a log axis cannot represent', () => {
    const scale = createScale('log', { domain: [1, 100], range: [0, 100] });
    expect(Number.isNaN(scale.valueToPixel(0))).toBe(true);
    expect(Number.isNaN(scale.valueToPixel(-5))).toBe(true);
  });

  it('refuses a non-positive domain at construction', () => {
    expect(() => createScale('log', { domain: [0, 100], range: [0, 100] })).toThrowError(
      /log axis requires a positive domain/,
    );
    expect(() => createScale('log', { domain: [-1, 100], range: [0, 100] })).toThrowError(
      RangeError,
    );
  });

  it('honours a non-decimal base', () => {
    const scale = scaleOver('log', 1, 8, 0, 3, 2);
    expect(scale.valueToPixel(1)).toBe(0);
    expect(scale.valueToPixel(2)).toBeCloseTo(1, 9);
    expect(scale.valueToPixel(8)).toBeCloseTo(3, 9);
    expect(scale.pixelToValue(1)).toBeCloseTo(2, 9);
  });

  it('inverts over several decades', () => {
    const scale = createScale('log', { domain: [1e-3, 1e3], range: [0, 500] });
    for (const value of [1e-3, 0.02, 1, 250, 1e3]) {
      expect(scale.pixelToValue(scale.valueToPixel(value))).toBeCloseTo(value, 6);
    }
  });
});

describe('time scale', () => {
  const DAY = 86_400_000;

  it('maps epoch milliseconds linearly', () => {
    const start = 1_700_000_000_000;
    const scale = createScale('time', { domain: [start, start + DAY], range: [0, 240] });
    expect(scale.valueToPixel(start)).toBe(0);
    expect(scale.valueToPixel(start + DAY / 2)).toBe(120);
    expect(scale.valueToPixel(start + DAY)).toBe(240);
  });

  it('produces calendar ticks, not linear ones', () => {
    const start = 1_700_000_000_000;
    const ticks = createScale('time', {
      domain: [start, start + DAY * 7],
      range: [0, 700],
    }).ticks(7);
    expect(ticks.unit).toBeDefined();
    expect(ticks.values.length).toBeGreaterThan(1);
    for (const v of ticks.values) {
      // Every tick on a daily/weekly ladder starts at local midnight.
      expect(new Date(v).getMinutes()).toBe(0);
      expect(new Date(v).getSeconds()).toBe(0);
    }
  });

  it('inverts a pixel back to a timestamp', () => {
    const start = 1_700_000_000_000;
    const scale = createScale('time', { domain: [start, start + DAY], range: [0, 240] });
    expect(scale.pixelToValue(120)).toBe(start + DAY / 2);
  });
});

describe('category scale', () => {
  it('spreads a category index across the range', () => {
    const scale = categoryScale(5, 0, 400);
    expect(scale.kind).toBe('category');
    expect(scale.valueToPixel(0)).toBe(0);
    expect(scale.valueToPixel(2)).toBe(200);
    expect(scale.valueToPixel(4)).toBe(400);
  });

  it('derives its tick count from the domain, not from the span', () => {
    const ticks = categoryScale(5, 0, 400).ticks(3);
    expect(Array.from(ticks.values)).toEqual([0, 2, 4]);
  });

  it('handles a single category', () => {
    const scale = categoryScale(1, 0, 100);
    // One category has a collapsed domain, so the general "collapse to the
    // middle" rule applies and the lone category sits in the middle of its band
    // rather than on the axis edge.
    expect(scale.valueToPixel(0)).toBe(50);
    expect(scale.ticks(5).values).toEqual([0]);
  });
});

describe('immutability', () => {
  it('returns a new scale from withDomain and leaves the receiver alone', () => {
    const original = linear();
    const widened = original.withDomain(-100, 200);
    expect(original.domainMin).toBe(0);
    expect(original.domainMax).toBe(100);
    expect(widened.domainMin).toBe(-100);
    expect(widened.valueToPixel(-100)).toBe(0);
    expect(widened).not.toBe(original);
  });

  it('returns a new scale from withRange and leaves the receiver alone', () => {
    const original = linear();
    const moved = original.withRange(100, 300);
    expect(original.rangeMin).toBe(0);
    expect(moved.rangeMin).toBe(100);
    expect(moved.valueToPixel(0)).toBe(100);
    expect(original.valueToPixel(0)).toBe(0);
  });

  it('keeps the log guard active through withDomain', () => {
    const scale = createScale('log', { domain: [1, 100], range: [0, 100] });
    expect(() => scale.withDomain(0, 100)).toThrowError(/log axis requires a positive domain/);
  });

  it('preserves the log base through withDomain and withRange', () => {
    const scale = scaleOver('log', 1, 8, 0, 3, 2);
    expect(scale.withDomain(1, 4).valueToPixel(4)).toBeCloseTo(3, 9);
    expect(scale.withRange(0, 6).valueToPixel(2)).toBeCloseTo(2, 9);
  });
});

describe('tick delegation', () => {
  it('routes each kind to its own algorithm', () => {
    // Over [1, 100] with a budget of five: a linear axis rounds to a step of 20,
    // while a log axis walks the mantissas. The two only coincide when the
    // domain happens to be a decade covered by a step of 1, which is why this
    // case is deliberately not [1, 10].
    const linearValues = createScale('linear', { domain: [1, 100], range: [0, 100] }).ticks(
      5,
    ).values;
    const logValues = createScale('log', { domain: [1, 100], range: [0, 100] }).ticks(5).values;

    expect(Array.from(linearValues)).toEqual([20, 40, 60, 80, 100]);
    expect(logValues.length).toBeGreaterThan(linearValues.length);
    // 2 is a mantissa a linear axis in this domain never produces.
    expect(logValues.includes(2)).toBe(true);
  });

  it('carries the time unit through so a formatter can choose a precision', () => {
    const scale = createScale('time', {
      domain: [0, 3_600_000],
      range: [0, 600],
    });
    const ticks = scale.ticks(6);
    expect(ticks.unit).toBe('minute');
    expect(ticks.unitStep).toBeDefined();
  });
});
