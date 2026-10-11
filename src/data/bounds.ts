import type { Diagnostics } from '../core/Diagnostics';
import type { Bounds, Vec } from './types';

/**
 * Data bounds, and the reasons samples were left out of them.
 *
 * ## Why this module exists
 *
 * webgl-plot's `autoScale()` skips a series entirely when it finds fewer than 10%
 * usable values, and says nothing when it does. In practice that means a line
 * silently vanishes and the only diagnostic is a blank chart — the worst possible
 * failure mode in an alarm dashboard, where a missing line looks exactly like
 * "everything is fine".
 *
 * So bounds here are never a bare `{min, max}`. Every sample that cannot be used
 * is *counted and attributed*, and the caller decides what to do with that. The
 * counting is deliberately cheap (integer tallies, no per-sample objects) because
 * it runs over a million points at a time.
 */

/** Why a sample cannot contribute to the bounds. */
export type SkipKind =
  /** A log axis cannot represent zero or a negative value. */
  | 'nonPositiveLog'
  /** Not a number — a parse failure, a gap marker, or arithmetic on `undefined`. */
  | 'nan'
  /** `±Infinity`, usually a divide-by-zero upstream. */
  | 'infinite'
  /** Not one specific sample: too few usable samples exist to form any extent. */
  | 'insufficientPoints';

/** Which column a skip was found in. */
export type SkipAxis = 'x' | 'y';

/**
 * The skip kinds that describe an individual sample.
 *
 * `insufficientPoints` is excluded by construction rather than by convention:
 * {@link classify} inspects one value and can never conclude "there are too few
 * of you", so making that unrepresentable removes a cast and a class of bug.
 */
export type SampleSkipKind = Exclude<SkipKind, 'insufficientPoints'>;

/**
 * One aggregated reason samples were excluded.
 *
 * Samples are aggregated by `(kind, axis)` rather than reported one by one: a
 * million-point column with a broken logger usually has a million identical
 * problems, and one line of output is more useful than a million.
 *
 * `kind` is checked in the order `nan` → `infinite` → `nonPositiveLog`, so a
 * value that is both negative and infinite is reported as `infinite`. The order
 * is fixed so that the reported kind does not depend on which axis was inspected
 * first.
 */
export interface SkipDiagnostic {
  readonly kind: SkipKind;
  /**
   * Index of the first sample that triggered this diagnostic.
   *
   * `-1` for `insufficientPoints`, which describes the column as a whole rather
   * than one sample.
   */
  readonly firstIndex: number;
  /** How many samples this entry accounts for. */
  readonly count: number;
  /** Which column the samples came from. Absent for `insufficientPoints`. */
  readonly axis?: SkipAxis;
}

export interface BoundsResult {
  /** `null` when no sample was usable. Never a fabricated `{0, 0}` extent. */
  readonly bounds: Bounds | null;
  readonly skipped: readonly SkipDiagnostic[];
}

export interface BoundsOptions {
  /** Treat the x column as a log axis, where a non-positive value is unusable. */
  readonly logX?: boolean;
  /** Treat the y column as a log axis, where a non-positive value is unusable. */
  readonly logY?: boolean;
}

/**
 * Tallies for `(kind, axis)` slots.
 *
 * Module scope on purpose: the arrays are fully reset before use and read only
 * after the loop finishes, and the function never invokes caller-supplied code,
 * so nothing can observe them. This keeps a call over a million points free of
 * any allocation beyond the result itself — d3-time uses the same trick for its
 * scratch dates.
 *
 * Slots: `nan.x`, `nan.y`, `infinite.x`, `infinite.y`, `nonPositiveLog.x`,
 * `nonPositiveLog.y`.
 */
const SKIP_SLOT_COUNT = 6;
const skipCounts = new Int32Array(SKIP_SLOT_COUNT);
const skipFirsts = new Int32Array(SKIP_SLOT_COUNT);
const SKIP_KINDS: readonly SampleSkipKind[] = ['nan', 'infinite', 'nonPositiveLog'];
const SKIP_AXES: readonly SkipAxis[] = ['x', 'y'];

/**
 * Minimum and maximum of `x` and `y`, plus every reason a sample was excluded.
 *
 * Only the first `count` entries are read; the arrays may be longer, which is how
 * a `DataSet` can pass its whole backing store without slicing it first.
 *
 * A sample is excluded as a *whole* — if the x value is unusable, the pair cannot
 * be placed no matter how good `y` is, so one skip is recorded rather than two.
 */
export function computeBounds(
  x: Vec,
  y: Vec,
  count: number,
  options: BoundsOptions = {},
): BoundsResult {
  const logX = options.logX ?? false;
  const logY = options.logY ?? false;

  skipCounts.fill(0);
  skipFirsts.fill(-1);

  let xMin = Infinity;
  let xMax = -Infinity;
  let yMin = Infinity;
  let yMax = -Infinity;
  let usable = 0;

  for (let i = 0; i < count; i += 1) {
    // `?? 0` satisfies `noUncheckedIndexedAccess`; it cannot fire because
    // `i < count <= length` is the caller's contract.
    const xi = x[i] ?? 0;
    const yi = y[i] ?? 0;

    // x is inspected first, so a sample whose *both* columns are unusable is
    // attributed to x. Fixed order again: the same data must always produce the
    // same report.
    const badX = classify(xi, logX);
    if (badX !== null) {
      record(badX, 'x', i);
      continue;
    }
    const badY = classify(yi, logY);
    if (badY !== null) {
      record(badY, 'y', i);
      continue;
    }

    usable += 1;
    if (xi < xMin) xMin = xi;
    if (xi > xMax) xMax = xi;
    if (yi < yMin) yMin = yi;
    if (yi > yMax) yMax = yi;
  }

  const skipped = collectSkips();
  if (usable === 0) {
    skipped.push({ kind: 'insufficientPoints', count: 0, firstIndex: -1 });
    return { bounds: null, skipped };
  }

  return { bounds: { xMin, xMax, yMin, yMax }, skipped };
}

/**
 * Which reason makes `value` unusable, or `null` when it is fine.
 *
 * Exported because the renderer has to make the same decision when it decides
 * whether a sample can become geometry, and two copies of this rule would drift.
 * Precedence is `nan` → `infinite` → `nonPositiveLog`: a value that is both
 * negative and infinite is reported as `infinite`.
 */
export function classify(value: number, log: boolean): SampleSkipKind | null {
  if (Number.isNaN(value)) return 'nan';
  if (!Number.isFinite(value)) return 'infinite';
  if (log && value <= 0) return 'nonPositiveLog';
  return null;
}

function record(kind: SampleSkipKind, axis: SkipAxis, index: number): void {
  const slot = SKIP_KINDS.indexOf(kind) * 2 + SKIP_AXES.indexOf(axis);
  skipCounts[slot] = (skipCounts[slot] ?? 0) + 1;
  if (skipFirsts[slot] === -1) skipFirsts[slot] = index;
}

function collectSkips(): SkipDiagnostic[] {
  const out: SkipDiagnostic[] = [];
  for (let slot = 0; slot < SKIP_SLOT_COUNT; slot += 1) {
    const count = skipCounts[slot] ?? 0;
    if (count === 0) continue;
    out.push({
      kind: SKIP_KINDS[Math.floor(slot / 2)] ?? 'nan',
      count,
      firstIndex: skipFirsts[slot] ?? -1,
      axis: SKIP_AXES[slot % 2] ?? 'x',
    });
  }
  return out;
}

/** One-line summary of what was excluded, e.g. `y: 12 non-positive (log), first #3`. */
export function describeSkips(skipped: readonly SkipDiagnostic[]): string {
  const parts: string[] = [];
  for (const skip of skipped) {
    const where = skip.axis === undefined ? 'column' : skip.axis;
    const at = skip.firstIndex === -1 ? '' : `, first #${String(skip.firstIndex)}`;
    parts.push(`${where}: ${String(skip.count)} ${skip.kind}${at}`);
  }
  return parts.join('; ');
}

/**
 * Report excluded samples through {@link Diagnostics}.
 *
 * Two details are deliberate:
 *
 * - The series id is part of the diagnostic **code**, not just the message.
 *   `Diagnostics` prints at most once per code, and a dashboard with eight
 *   series must not have seven of them fall silent behind the first — that
 *   would reproduce exactly the "silent line" problem this module exists to fix.
 * - Severity is left at the default so a `'throw'` build fails loudly. Excluding
 *   samples is a data defect, not an environment fact, so unlike a missing GPU
 *   extension it *should* be able to stop a caller that asked for strictness.
 */
export function reportSkips(
  diagnostics: Diagnostics,
  seriesId: string,
  skipped: readonly SkipDiagnostic[],
): void {
  if (skipped.length === 0) return;
  let total = 0;
  for (const skip of skipped) total += skip.count;
  diagnostics.report(
    `data/skipped-points:${seriesId}`,
    `series "${seriesId}" excluded ${String(total)} sample(s) from its bounds: ${describeSkips(skipped)}`,
    { seriesId, skipped },
  );
}
