/**
 * Tick selection — pure functions, zero GL, no dependencies.
 *
 * ## Why these are ports rather than inventions
 *
 * A tick algorithm is judged by how it *feels* ("does the axis end on a round
 * number?"), which makes it a bad thing to invent and a good thing to agree with
 * an incumbent on. So the three algorithms here are direct ports of the reference
 * implementations:
 *
 * | Here            | Ported from                                  |
 * | --------------- | -------------------------------------------- |
 * | `linearTicks`   | `d3-array/src/ticks.js`                      |
 * | `logTicks`      | `d3-scale/src/log.js` (`scale.ticks`)        |
 * | `timeTicks`     | `d3-time/src/ticks.js` + `src/interval.js`   |
 *
 * d3 sits in `devDependencies` and is used **only** as a comparison oracle in the
 * tests; the shipping bundle contains the port, not the dependency. Porting is
 * therefore worth it precisely because the port is verifiable: `data-ticks.test.ts`
 * runs both over the same 60-odd cases and fails on any disagreement.
 *
 * ## Deliberate divergences from d3
 *
 * Stated here so that nobody discovers them as a surprise:
 *
 * 1. **Non-finite domains produce no ticks, by an explicit guard.** d3 reaches
 *    the same outcome for `[0, Infinity]` only because `NaN >= NaN` is false.
 *    Relying on that is a coincidence, not a contract, so the guard is written
 *    out.
 * 2. **A log domain must be positive.** d3 supports negative log domains by
 *    reflecting the transform; this engine does not, because the bounds layer
 *    already decided that a non-positive value on a log axis is a
 *    `nonPositiveLog` *skip*. Supporting both would be two contradictory policies
 *    for the same data, so the second one is refused loudly.
 * 3. **`count` accepts numbers only.** d3 also accepts an interval object
 *    (`ticks(10)`, `ticks(timeDay)`). Nothing in this engine needs intervals at
 *    the tick level, and accepting a value that is silently ignored would be
 *    worse than rejecting it.
 *
 * There are no `...Into` variants yet. Ticks are recomputed when the tick
 * *spacing* would change, not on every pan frame, so an axis caches them and the
 * allocation is rare — see `Scale`. Adding an allocation-free entry point before
 * the axis that would use it exists would be guessing at an interface.
 */

/** Calendar unit a time tick lands on. */
export type TimeUnit =
  'millisecond' | 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';

/** Chosen ticks plus what the choice implies for formatting and grid lines. */
export interface TickSet {
  readonly values: readonly number[];
  /**
   * Gap between the first two ticks, in domain units (milliseconds for time).
   *
   * `0` when fewer than two ticks were produced. On a log axis the gap is not
   * meaningful beyond the first pair, because log ticks are not uniformly spaced.
   */
  readonly step: number;
  /** Time ticks only: the calendar unit the ticks land on. */
  readonly unit?: TimeUnit;
  /** Time ticks only: how many `unit`s apart the ticks are. */
  readonly unitStep?: number;
}

/* ------------------------------------------------------------------ *
 * Linear
 * ------------------------------------------------------------------ */

const e10 = Math.sqrt(50);
const e5 = Math.sqrt(10);
const e2 = Math.sqrt(2);

/**
 * Scratch for {@link tickSpec}, module scope for the same reason d3-time keeps
 * its scratch dates there: the function is synchronous, never calls out to
 * caller-supplied code, and fully writes the scratch before anything reads it.
 */
let specI1 = 0;
let specI2 = 0;
let specInc = 0;

/**
 * The exponent-and-factor triple that `linearTicks` is built from.
 *
 * This is `tickSpec` from d3-array, including its two odd-looking details: the
 * negative-power branch (which returns a *negated* `inc` so the caller knows to
 * divide rather than multiply, avoiding a division per tick) and the recursive
 * retry that kicks in when a fractional `count` yields no ticks at all.
 */
function tickSpec(start: number, stop: number, count: number): void {
  const step = (stop - start) / Math.max(0, count);
  const power = Math.floor(Math.log10(step));
  const error = step / Math.pow(10, power);
  const factor = error >= e10 ? 10 : error >= e5 ? 5 : error >= e2 ? 2 : 1;

  let i1: number;
  let i2: number;
  let inc: number;
  if (power < 0) {
    inc = Math.pow(10, -power) / factor;
    i1 = Math.round(start * inc);
    i2 = Math.round(stop * inc);
    if (i1 / inc < start) i1 += 1;
    if (i2 / inc > stop) i2 -= 1;
    inc = -inc;
  } else {
    inc = Math.pow(10, power) * factor;
    i1 = Math.round(start / inc);
    i2 = Math.round(stop / inc);
    if (i1 * inc < start) i1 += 1;
    if (i2 * inc > stop) i2 -= 1;
  }

  if (i2 < i1 && count >= 0.5 && count < 2) {
    tickSpec(start, stop, count * 2);
    return;
  }

  specI1 = i1;
  specI2 = i2;
  specInc = inc;
}

/** Spacing between adjacent ticks, as a positive number. See `tickSpec`. */
export function tickStep(start: number, stop: number, count: number): number {
  const reverse = stop < start;
  tickSpec(reverse ? stop : start, reverse ? start : stop, count);
  const inc = specInc;
  return (reverse ? -1 : 1) * (inc < 0 ? 1 / -inc : inc);
}

/**
 * Round-numbered ticks covering `[start, stop]`, aiming for about `count` of them.
 *
 * The count is a target, not a promise: `(0, 1, 10)` yields 11 ticks at 0.1 and
 * `(0, 1, 3)` yields 3 at 0.5, because landing on round numbers wins.
 */
export function linearTicks(start: number, stop: number, count: number): TickSet {
  const values = linearTicksAsArray(start, stop, count);
  const step = values.length < 2 ? 0 : (values[1] ?? 0) - (values[0] ?? 0);
  return { values, step };
}

function linearTicksAsArray(start: number, stop: number, count: number): number[] {
  if (!Number.isFinite(start) || !Number.isFinite(stop)) return [];
  if (!(count > 0) || !Number.isFinite(count)) return [];
  if (start === stop) return [start];

  const reverse = stop < start;
  tickSpec(reverse ? stop : start, reverse ? start : stop, count);

  const i1 = specI1;
  const i2 = specI2;
  const inc = specInc;
  if (!(i2 >= i1)) return [];

  const n = i2 - i1 + 1;
  const out = new Array<number>(n);
  if (reverse) {
    // `inc < 0` means the true step is `1 / -inc`; see `tickSpec`.
    if (inc < 0) for (let i = 0; i < n; i += 1) out[i] = (i2 - i) / -inc;
    else for (let i = 0; i < n; i += 1) out[i] = (i2 - i) * inc;
  } else if (inc < 0) {
    for (let i = 0; i < n; i += 1) out[i] = (i1 + i) / -inc;
  } else {
    for (let i = 0; i < n; i += 1) out[i] = (i1 + i) * inc;
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Log
 * ------------------------------------------------------------------ */

/**
 * Ticks for a log axis.
 *
 * Two regimes, as in d3. When the domain spans fewer than `count` decades, every
 * mantissa (1…9 for base 10) inside the domain is a tick, giving the familiar
 * `1, 2, 5, 10, 20` ladder. When it spans more, the ticks are round numbers *in
 * log space* mapped back, i.e. one per decade. If either regime produces too few
 * ticks, the linear algorithm fills in — the last resort that keeps a
 * nearly-degenerate log domain from rendering an empty axis.
 *
 * @throws RangeError if `start` or `stop` is not positive. See the module note.
 */
export function logTicks(start: number, stop: number, count: number, base = 10): TickSet {
  const values = logTicksAsArray(start, stop, count, base);
  const step = values.length < 2 ? 0 : (values[1] ?? 0) - (values[0] ?? 0);
  return { values, step };
}

/**
 * Reject a domain that a log axis cannot represent.
 *
 * Exported so {@link Scale} enforces the same rule with the same message. The
 * check has exactly one implementation on purpose: a second copy would drift, and
 * a caller who saw two different messages for one mistake would reasonably
 * conclude they were two different mistakes.
 *
 * @throws RangeError
 */
export function assertLogDomain(start: number, stop: number): void {
  if (start > 0 && stop > 0) return;
  throw new RangeError(
    `a log axis requires a positive domain, got [${String(start)}, ${String(stop)}]. ` +
      'Exclude non-positive samples via computeBounds({ logX | logY: true }) before ' +
      'building the scale; d3 reflects the transform for negative domains and this ' +
      'engine deliberately does not, so that the rule has one home.',
  );
}

function logTicksAsArray(start: number, stop: number, count: number, base: number): number[] {
  assertLogDomain(start, stop);
  if (!(count > 0) || !Number.isFinite(count)) return [];
  if (start === stop) return [start];

  const reverse = stop < start;
  const u = reverse ? stop : start;
  const v = reverse ? start : stop;

  const log = base === 10 ? Math.log10 : (x: number) => Math.log(x) / Math.log(base);
  const pow = base === 10 ? pow10 : (x: number) => Math.pow(base, x);

  const i = log(u);
  const j = log(v);
  let out: number[];

  if (j - i < count) {
    out = [];
    let lo = Math.floor(i);
    const hi = Math.ceil(j);
    for (; lo <= hi; lo += 1) {
      for (let k = 1; k < base; k += 1) {
        const t = lo < 0 ? k / pow(-lo) : k * pow(lo);
        if (t < u) continue;
        if (t > v) break;
        out.push(t);
      }
    }
    if (out.length * 2 < count) out = linearTicksAsArray(u, v, count);
  } else {
    const decades = Math.min(j - i, count);
    out = linearTicksAsArray(i, j, decades);
    for (let k = 0; k < out.length; k += 1) out[k] = pow(out[k] ?? 0);
  }

  if (reverse) out.reverse();
  return out;
}

/** `1e-x`, computed as a string like d3 does, to avoid pow() rounding drift. */
function pow10(x: number): number {
  if (!Number.isFinite(x)) return x < 0 ? 0 : x;
  return Number(`1e${String(x)}`);
}

/* ------------------------------------------------------------------ *
 * Time
 * ------------------------------------------------------------------ */

const MS_SECOND = 1000;
const MS_MINUTE = 60 * MS_SECOND;
const MS_HOUR = 60 * MS_MINUTE;
const MS_DAY = 24 * MS_HOUR;
const MS_WEEK = 7 * MS_DAY;
/** Nominal, as in d3: a "month" tick is a calendar month, this is only a weight. */
const MS_MONTH = 30 * MS_DAY;
const MS_YEAR = 365 * MS_DAY;

/**
 * Scratch date for the calendar accessors below.
 *
 * Same reasoning as {@link specI1}: module scope avoids a `Date` per accessor
 * call, which matters because a single tick walk touches it several times per
 * candidate tick. It never escapes — every accessor returns a number.
 */
const scratch = new Date();

type Floor = (t: number) => number;
type Offset = (t: number, step: number) => number;
type Field = (t: number) => number;
type Count = (a: number, b: number) => number;

interface UnitSpec {
  readonly unit: TimeUnit;
  /** Nominal duration of one unit. */
  readonly ms: number;
  readonly floor: Floor;
  readonly offset: Offset;
  /**
   * Value tested by `% step === 0` for `every(step)`.
   *
   * `null` for units whose alignment d3 expresses as a count rather than a field
   * (weeks) or which have a dedicated optimised `every` (years, milliseconds).
   */
  readonly field: Field | null;
  /** See {@link field}. Required when `field` is `null` and align is `'filter'`. */
  readonly count: Count | null;
  readonly align: 'filter' | 'millisecond' | 'year';
}

function floorWith(setter: (date: Date) => void): Floor {
  return (t) => {
    scratch.setTime(t);
    setter(scratch);
    return scratch.getTime();
  };
}

function offsetWith(setter: (date: Date, step: number) => void): Offset {
  return (t, step) => {
    scratch.setTime(t);
    setter(scratch, step);
    return scratch.getTime();
  };
}

function fieldWith(getter: (date: Date) => number): Field {
  return (t) => {
    scratch.setTime(t);
    return getter(scratch);
  };
}

const MILLISECOND: UnitSpec = {
  unit: 'millisecond',
  ms: 1,
  floor: (t) => t,
  offset: (t, step) => t + step,
  field: null,
  count: null,
  align: 'millisecond',
};

const SECOND: UnitSpec = {
  unit: 'second',
  ms: MS_SECOND,
  floor: floorWith((d) => void d.setMilliseconds(0)),
  offset: offsetWith((d, step) => void d.setTime(d.getTime() + step * MS_SECOND)),
  // d3 reads the UTC second here, which equals the local second because every
  // timezone offset is a whole number of minutes. Kept identical so the port
  // cannot drift on a value the oracle disagrees about.
  field: fieldWith((d) => d.getUTCSeconds()),
  count: null,
  align: 'filter',
};

const MINUTE: UnitSpec = {
  unit: 'minute',
  ms: MS_MINUTE,
  floor: floorWith((d) => {
    d.setMilliseconds(0);
    d.setSeconds(0);
  }),
  offset: offsetWith((d, step) => void d.setTime(d.getTime() + step * MS_MINUTE)),
  field: fieldWith((d) => d.getMinutes()),
  count: null,
  align: 'filter',
};

const HOUR: UnitSpec = {
  unit: 'hour',
  ms: MS_HOUR,
  floor: floorWith((d) => d.setMinutes(0, 0, 0)),
  offset: offsetWith((d, step) => void d.setTime(d.getTime() + step * MS_HOUR)),
  field: fieldWith((d) => d.getHours()),
  count: null,
  align: 'filter',
};

const DAY: UnitSpec = {
  unit: 'day',
  ms: MS_DAY,
  floor: floorWith((d) => d.setHours(0, 0, 0, 0)),
  offset: offsetWith((d, step) => void d.setDate(d.getDate() + step)),
  // Day-of-month minus one, so `every(2)` alternates on odd/even dates rather
  // than on a fixed phase of the month.
  field: fieldWith((d) => d.getDate() - 1),
  // Days are not 24 hours across a DST boundary; the count removes the shift.
  count: (a, b) => {
    scratch.setTime(a);
    const aOffset = scratch.getTimezoneOffset();
    scratch.setTime(b);
    const bOffset = scratch.getTimezoneOffset();
    return (b - a - (bOffset - aOffset) * MS_MINUTE) / MS_DAY;
  },
  align: 'filter',
};

const WEEK: UnitSpec = {
  unit: 'week',
  ms: MS_WEEK,
  // Sunday-based, matching `d3-time`'s `timeSunday`. `getDay()` is already 0 for
  // Sunday, so the `(x + 7) % 7` dance d3 writes is an identity here.
  floor: floorWith((d) => {
    d.setDate(d.getDate() - d.getDay());
    d.setHours(0, 0, 0, 0);
  }),
  offset: offsetWith((d, step) => void d.setDate(d.getDate() + step * 7)),
  field: null,
  count: (a, b) => {
    scratch.setTime(a);
    const aOffset = scratch.getTimezoneOffset();
    scratch.setTime(b);
    const bOffset = scratch.getTimezoneOffset();
    return (b - a - (bOffset - aOffset) * MS_MINUTE) / MS_WEEK;
  },
  align: 'filter',
};

const MONTH: UnitSpec = {
  unit: 'month',
  ms: MS_MONTH,
  floor: floorWith((d) => {
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
  }),
  offset: offsetWith((d, step) => void d.setMonth(d.getMonth() + step)),
  field: fieldWith((d) => d.getMonth()),
  count: null,
  align: 'filter',
};

const YEAR: UnitSpec = {
  unit: 'year',
  ms: MS_YEAR,
  floor: floorWith((d) => {
    d.setMonth(0, 1);
    d.setHours(0, 0, 0, 0);
  }),
  offset: offsetWith((d, step) => void d.setFullYear(d.getFullYear() + step)),
  field: fieldWith((d) => d.getFullYear()),
  count: null,
  align: 'year',
};

/**
 * The interval ladder, ordered by nominal duration.
 *
 * The entries above the seconds are the interesting ones: `15m`, `30m`, `6h` and
 * `3mo` exist because those are the increments a monitoring dashboard actually
 * wants, and no amount of arithmetic on powers of ten would produce them.
 */
const LADDER: readonly (readonly [UnitSpec, number])[] = [
  [SECOND, 1],
  [SECOND, 5],
  [SECOND, 15],
  [SECOND, 30],
  [MINUTE, 1],
  [MINUTE, 5],
  [MINUTE, 15],
  [MINUTE, 30],
  [HOUR, 1],
  [HOUR, 3],
  [HOUR, 6],
  [HOUR, 12],
  [DAY, 1],
  [DAY, 2],
  [WEEK, 1],
  [MONTH, 1],
  [MONTH, 3],
  [YEAR, 1],
];

/** Candidate ticks for `[a, b]`, ready to be walked. */
interface TickWalker {
  readonly unit: TimeUnit;
  readonly unitStep: number;
  /** Nominal spacing, for the caller's `TickSet.step`. */
  readonly stepMs: number;
  /** First tick at or after `t`. */
  ceil(t: number): number;
  /** The next tick strictly after `t`, or `t` when the walk cannot continue. */
  next(t: number): number;
}

/**
 * Build the walker for a `(unit, step)` pair.
 *
 * `every(1)` returns the unit's own floor/offset untouched, which is why the
 * common case costs no lambda per call. Above 1 the alignment comes from d3's
 * three distinct strategies — see {@link UnitSpec.align}.
 */
function makeWalker(spec: UnitSpec, step: number): TickWalker | null {
  const k = Math.floor(step);
  if (!Number.isFinite(k) || !(k > 0)) return null;

  if (k === 1) {
    return {
      unit: spec.unit,
      unitStep: 1,
      stepMs: spec.ms,
      ceil: (t) => ceilBase(spec, t),
      next: (t) => spec.floor(spec.offset(t, 1)),
    };
  }

  if (spec.align === 'millisecond') {
    return {
      unit: spec.unit,
      unitStep: k,
      stepMs: k,
      // d3's `ceil` is `floor(floor(t - 1) + k)`, not `floor(t)`. The difference
      // shows up for a `t` that already sits on a tick: `floor(t)` would return
      // that same tick, and any caller relying on "strictly at or after" would
      // then place a duplicate.
      ceil: (t) => Math.floor((t - 1) / k) * k + k,
      next: (t) => Math.floor(t / k) * k + k,
    };
  }

  if (spec.align === 'year') {
    return {
      unit: spec.unit,
      unitStep: k,
      stepMs: k * MS_YEAR,
      // The step passed to `offset` here is `k`, not 1: d3's optimised
      // `year.every(k)` offset advances by `step * k` years, so an "offset by
      // one" already means one *tick*, not one year. Getting this wrong makes a
      // 20-year ladder start in 1960 instead of 1980.
      ceil: (t) => alignYear(spec.offset(alignYear(t - 1, k), k), k),
      next: (t) => alignYear(spec.offset(t, k), k),
    };
  }

  const test =
    spec.field !== null
      ? (t: number) => {
          const f = (spec.field as Field)(t);
          return ((f % k) + k) % k === 0;
        }
      : (t: number) => {
          const c = (spec.count as Count)(0, spec.floor(t));
          return ((Math.floor(c) % k) + k) % k === 0;
        };

  const floorFiltered: Floor = (t) => {
    if (!(t >= t)) return NaN;
    let d = t;
    for (;;) {
      d = spec.floor(d);
      if (test(d)) return d;
      d -= 1;
    }
  };

  const offsetFiltered: Offset = (t, n) => {
    if (!(t >= t)) return NaN;
    let d = t;
    if (n < 0) {
      while ((n += 1) <= 0) {
        do d = spec.offset(d, -1);
        while (!test(d));
      }
    } else {
      while ((n -= 1) >= 0) {
        do d = spec.offset(d, 1);
        while (!test(d));
      }
    }
    return d;
  };

  return {
    unit: spec.unit,
    unitStep: k,
    stepMs: k * spec.ms,
    ceil: (t) => floorFiltered(offsetFiltered(floorFiltered(t - 1), 1)),
    next: (t) => floorFiltered(offsetFiltered(t, 1)),
  };
}

/** d3's `interval.ceil` for a base interval: `floor(t - 1)`, one step, `floor`. */
function ceilBase(spec: UnitSpec, t: number): number {
  return spec.floor(spec.offset(spec.floor(t - 1), 1));
}

function alignYear(t: number, k: number): number {
  scratch.setTime(t);
  scratch.setFullYear(Math.floor(scratch.getFullYear() / k) * k);
  scratch.setMonth(0, 1);
  scratch.setHours(0, 0, 0, 0);
  return scratch.getTime();
}

/**
 * Ladder durations in milliseconds, parallel to {@link LADDER}.
 *
 * The search below bisects on *duration*, not on the multiplier: `[DAY, 2]` and
 * `[HOUR, 1]` have the same multiplier and completely different weights, so
 * bisecting on the multiplier would place a two-day span on an hourly rung.
 */
const LADDER_DURATIONS: readonly number[] = LADDER.map(([spec, step]) => step * spec.ms);

/** Upper bound: the number of ladder entries whose duration is `<= target`. */
function ladderIndex(target: number): number {
  let lo = 0;
  let hi = LADDER.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((LADDER_DURATIONS[mid] ?? 0) <= target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Pick the interval for a span, then build its walker.
 *
 * The comparison `target / previous < next / target` picks whichever of the two
 * bracketing intervals is closer *proportionally*, not arithmetically. That is
 * what makes a dashboard swap 15m ticks for 30m halfway between the two rather
 * than at an arbitrary point.
 */
function timeTickWalker(start: number, stop: number, count: number): TickWalker | null {
  if (!Number.isFinite(start) || !Number.isFinite(stop)) return null;
  if (!(count > 0) || !Number.isFinite(count)) return null;

  const a = Math.min(start, stop);
  const b = Math.max(start, stop);
  const target = Math.abs(b - a) / count;
  const i = ladderIndex(target);

  if (i === LADDER.length) return makeWalker(YEAR, tickStep(a / MS_YEAR, b / MS_YEAR, count));
  if (i === 0) return makeWalker(MILLISECOND, Math.max(tickStep(a, b, count), 1));

  const previous = LADDER_DURATIONS[i - 1] ?? 1;
  const current = LADDER_DURATIONS[i] ?? 1;
  const entry = LADDER[target / previous < current / target ? i - 1 : i];
  return entry === undefined ? null : makeWalker(entry[0], entry[1]);
}

/**
 * Calendar-aligned ticks covering `[start, stop]`, aiming for about `count`.
 *
 * Ticks land on local-time boundaries (`00:00` rather than `23:47`), which is the
 * whole point of the calendar machinery above. There is no UTC variant yet: an
 * industrial timeline is read in local time, and a second timezone story can be
 * added when something actually needs one.
 */
export function timeTicks(start: number, stop: number, count: number): TickSet {
  const walker = timeTickWalker(start, stop, count);
  if (walker === null) return { values: [], step: 0 };

  const reverse = stop < start;
  const a = reverse ? stop : start;
  const b = reverse ? start : stop;

  const values: number[] = [];
  let t = walker.ceil(a);
  // `b + 1` because the walk is inclusive of a tick exactly at `stop`, matching
  // d3's `interval.range(start, +stop + 1)`.
  while (t < b + 1) {
    values.push(t);
    const next = walker.next(t);
    if (!(next > t)) break;
    t = next;
  }
  if (reverse) values.reverse();

  const step = values.length < 2 ? 0 : (values[1] ?? 0) - (values[0] ?? 0);
  return { values, step, unit: walker.unit, unitStep: walker.unitStep };
}

/* ------------------------------------------------------------------ *
 * Category
 * ------------------------------------------------------------------ */

/**
 * Indices worth labelling on a category axis.
 *
 * Deliberately *not* routed through {@link linearTicks}, which is what the first
 * version did. The linear algorithm optimises for round numbers, so on 4
 * categories with room for 10 labels it returned 0, 0.2, 0.4 … 3 — sixteen
 * fractional ticks, and those indices do not exist. Roundness is meaningless
 * here anyway: a category label is a name, so the criterion is even spacing
 * including both ends, capped at the budget.
 *
 * `maxTicks` is therefore honoured exactly, except that duplicates from rounding
 * are collapsed.
 */
export function categoryTicks(count: number, maxTicks: number): TickSet {
  if (!(count > 0)) return { values: [], step: 0 };
  // No room for even a single label.
  if (maxTicks <= 0) return { values: [], step: 0 };
  // Exactly one label: the first category, not the whole axis.
  if (maxTicks === 1) return { values: [0], step: 0 };
  if (maxTicks >= count) {
    const values = new Array<number>(count);
    for (let i = 0; i < count; i += 1) values[i] = i;
    return { values, step: 1 };
  }

  const last = count - 1;
  const values: number[] = [];
  for (let k = 0; k < maxTicks; k += 1) {
    const index = Math.round((k * last) / (maxTicks - 1));
    if (values[values.length - 1] !== index) values.push(index);
  }
  const step = values.length < 2 ? 0 : (values[1] ?? 0) - (values[0] ?? 0);
  return { values, step };
}
