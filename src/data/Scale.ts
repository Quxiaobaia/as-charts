import {
  assertLogDomain,
  categoryTicks,
  linearTicks,
  logTicks,
  timeTicks,
  type TickSet,
} from './ticks';

/**
 * Value ↔ pixel mapping.
 *
 * ## The split that matters
 *
 * `C3` in the API-stability contract requires `valueToPixel` to be pure, and this
 * module is what makes that structural rather than aspirational: a `Scale` is a
 * value object with no mutation, so a new domain produces a new scale. Nothing
 * below reads a clock, a canvas or a renderer, which is also what lets the
 * viewport bucketing in `downsample.ts` run inside a Worker — a worker cannot
 * receive a class instance, but it can rebuild one from six numbers.
 *
 * ## Never silently clamp
 *
 * A value a scale cannot represent maps to `NaN`, not to a clamped edge. Clamping
 * would draw a line at the top of the chart that looks like data, and the whole
 * point of `computeBounds` reporting `nonPositiveLog` is that unusable samples are
 * *visible* rather than plausible.
 */

export type ScaleKind = 'linear' | 'log' | 'time' | 'category';

export interface Scale {
  readonly kind: ScaleKind;
  readonly domainMin: number;
  readonly domainMax: number;
  readonly rangeMin: number;
  readonly rangeMax: number;
  /** Data value → pixel. `NaN` when the value is outside what the scale supports. */
  valueToPixel(value: number): number;
  /** Pixel → data value. The inverse of {@link valueToPixel} where it is defined. */
  pixelToValue(pixel: number): number;
  /** Round ticks for this domain, aiming for about `count` of them. */
  ticks(count: number): TickSet;
  /** A new scale with a different domain. The receiver is unchanged. */
  withDomain(min: number, max: number): Scale;
  /** A new scale with a different range. The receiver is unchanged. */
  withRange(min: number, max: number): Scale;
}

export interface ScaleOptions {
  readonly domain: readonly [number, number];
  readonly range: readonly [number, number];
  /** Log base. Ignored by every other kind. */
  readonly base?: number;
}

interface ScaleOps {
  readonly kind: ScaleKind;
  /** Domain value → linear working space. */
  readonly forward: (value: number) => number;
  /** Inverse of {@link forward}. */
  readonly inverse: (mapped: number) => number;
  /** `base` is only meaningful for a log scale; the others ignore it. */
  readonly ticks: (min: number, max: number, count: number, base: number) => TickSet;
  /** Validates a domain before it is accepted. Throws for an unusable domain. */
  readonly guard: (min: number, max: number) => void;
  /**
   * Whether this scale can place `value` at all.
   *
   * Needed because `forward` alone is not enough to detect the failure. A log
   * axis put through `Math.log` turns `0` into `-Infinity`, which is a perfectly
   * finite-looking arithmetic result and a perfectly useless vertex: the line
   * disappears into a degenerate clip coordinate instead of the value being
   * reported as unplaceable. `-Infinity` is not a position, so the scale says so.
   */
  readonly usable: (value: number) => boolean;
}

const IDENTITY = (value: number): number => value;
const NO_GUARD = (): void => undefined;
const ANY_VALUE = (): boolean => true;

const LINEAR_OPS: ScaleOps = {
  kind: 'linear',
  forward: IDENTITY,
  inverse: IDENTITY,
  ticks: (min, max, count, _base) => linearTicks(min, max, count),
  guard: NO_GUARD,
  usable: ANY_VALUE,
};

const LOG_OPS: ScaleOps = {
  kind: 'log',
  forward: Math.log,
  inverse: Math.exp,
  ticks: (min, max, count, base) => logTicks(min, max, count, base),
  guard: assertLogDomain,
  usable: (value) => value > 0,
};

/**
 * Time is a linear mapping with a calendar tick policy.
 *
 * Keeping the mapping shared is not a shortcut: epoch milliseconds really are a
 * linear space, and giving time its own arithmetic is how calendar bugs get in.
 */
const TIME_OPS: ScaleOps = {
  kind: 'time',
  forward: IDENTITY,
  inverse: IDENTITY,
  ticks: (min, max, count, _base) => timeTicks(min, max, count),
  guard: NO_GUARD,
  usable: ANY_VALUE,
};

const CATEGORY_OPS: ScaleOps = {
  kind: 'category',
  forward: IDENTITY,
  inverse: IDENTITY,
  // A category domain is conventionally `[0, count - 1]`, so the count is
  // recovered from the upper bound rather than from the span.
  ticks: (_min, max, count, _base) => categoryTicks(Math.max(0, Math.floor(max) + 1), count),
  guard: NO_GUARD,
  usable: ANY_VALUE,
};

/**
 * Build a scale.
 *
 * @throws RangeError if a log domain is not strictly positive.
 */
export function createScale(kind: ScaleKind, options: ScaleOptions): Scale {
  const ops = opsFor(kind);
  return new MappedScale(
    ops,
    options.domain[0],
    options.domain[1],
    options.range[0],
    options.range[1],
  );
}

/** Convenience for the common case of a scale whose range is already pixels. */
export function scaleOver(
  kind: ScaleKind,
  domainMin: number,
  domainMax: number,
  rangeMin: number,
  rangeMax: number,
  base = 10,
): Scale {
  return new MappedScale(opsFor(kind), domainMin, domainMax, rangeMin, rangeMax, base);
}

/**
 * A category scale for `count` categories.
 *
 * Its own entry point because callers think in categories, not in the index range
 * that represents them, and `[0, count - 1]` is the kind of off-by-one that is
 * better to write once.
 */
export function categoryScale(count: number, rangeMin: number, rangeMax: number): Scale {
  const span = Math.max(0, Math.floor(count) - 1);
  return new MappedScale(CATEGORY_OPS, 0, span, rangeMin, rangeMax);
}

function opsFor(kind: ScaleKind): ScaleOps {
  switch (kind) {
    case 'linear':
      return LINEAR_OPS;
    case 'log':
      return LOG_OPS;
    case 'time':
      return TIME_OPS;
    case 'category':
      return CATEGORY_OPS;
  }
}

class MappedScale implements Scale {
  readonly #ops: ScaleOps;
  readonly #domainMin: number;
  readonly #domainMax: number;
  readonly #rangeMin: number;
  readonly #rangeMax: number;
  /** Forward-space endpoints, precomputed once per scale. */
  readonly #forwardMin: number;
  readonly #forwardMax: number;
  readonly #base: number;

  constructor(
    ops: ScaleOps,
    domainMin: number,
    domainMax: number,
    rangeMin: number,
    rangeMax: number,
    base = 10,
  ) {
    ops.guard(domainMin, domainMax);
    this.#ops = ops;
    this.#domainMin = domainMin;
    this.#domainMax = domainMax;
    this.#rangeMin = rangeMin;
    this.#rangeMax = rangeMax;
    this.#forwardMin = ops.forward(domainMin);
    this.#forwardMax = ops.forward(domainMax);
    this.#base = base;
  }

  get kind(): ScaleKind {
    return this.#ops.kind;
  }

  get domainMin(): number {
    return this.#domainMin;
  }

  get domainMax(): number {
    return this.#domainMax;
  }

  get rangeMin(): number {
    return this.#rangeMin;
  }

  get rangeMax(): number {
    return this.#rangeMax;
  }

  valueToPixel(value: number): number {
    if (!this.#ops.usable(value)) return NaN;
    const mapped = this.#ops.forward(value);
    const span = this.#forwardMax - this.#forwardMin;
    // A collapsed domain has no scale to offer, so everything lands mid-range.
    // Returning a range endpoint instead would put a single-valued series on the
    // axis line, where it reads as an axis artefact rather than as data.
    if (span === 0) return (this.#rangeMin + this.#rangeMax) / 2;
    return (
      this.#rangeMin + ((mapped - this.#forwardMin) / span) * (this.#rangeMax - this.#rangeMin)
    );
  }

  pixelToValue(pixel: number): number {
    const rangeSpan = this.#rangeMax - this.#rangeMin;
    const domainSpan = this.#forwardMax - this.#forwardMin;
    if (rangeSpan === 0) return (this.#domainMin + this.#domainMax) / 2;
    if (domainSpan === 0) return this.#domainMin;
    const mapped = this.#forwardMin + ((pixel - this.#rangeMin) / rangeSpan) * domainSpan;
    return this.#ops.inverse(mapped);
  }

  ticks(count: number): TickSet {
    return this.#ops.ticks(this.#domainMin, this.#domainMax, count, this.#base);
  }

  withDomain(min: number, max: number): Scale {
    return new MappedScale(this.#ops, min, max, this.#rangeMin, this.#rangeMax, this.#base);
  }

  withRange(min: number, max: number): Scale {
    return new MappedScale(this.#ops, this.#domainMin, this.#domainMax, min, max, this.#base);
  }
}
