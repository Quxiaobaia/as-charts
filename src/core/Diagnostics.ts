/**
 * Diagnostics plumbing.
 *
 * Two lessons from the reference libraries are baked in here:
 *
 * 1. **Never degrade or drop data silently.** `webgl-plot` v2's `autoScale()`
 *    quietly skips series that contribute less than 10% of the samples, which
 *    users read as "my line disappeared". Every such decision in this engine is
 *    reported through {@link Diagnostics}.
 * 2. **A switch, not a convention.** `'warn'` is deduplicated per code so a
 *    once-per-frame problem cannot flood the console, `'throw'` is available for
 *    tests and CI, and `'silent'` still notifies programmatic listeners so
 *    telemetry keeps working in production.
 */
export type DiagnosticsLevel = 'silent' | 'warn' | 'throw';

/**
 * How serious a report is.
 *
 * `'error'` is the default because most reports exist precisely because the
 * *caller* did something wrong — a leaked buffer, a shader whose slots drifted
 * from its template, a series dropped for being unrepresentable.
 *
 * `'info'` marks a statement of fact about the environment. It must never be
 * escalated to an exception, because `'throw'` is the setting CI uses and a GPU
 * that lacks five optional extensions is not a bug in anyone's code — throwing
 * on it would make the strict setting reject machines that work correctly with
 * the documented fallbacks.
 */
export type DiagnosticSeverity = 'info' | 'error';

/** A single reported condition. */
export interface Diagnostic {
  /** Stable machine-readable identifier, e.g. `shader/slot-unconsumed`. */
  readonly code: string;
  /** Human-readable description. */
  readonly message: string;
  /** Optional structured payload (offsets, counts, offending values). */
  readonly detail?: unknown;
  /** See {@link DiagnosticSeverity}. */
  readonly severity: DiagnosticSeverity;
}

export type DiagnosticListener = (event: Diagnostic) => void;

/** Thrown by {@link Diagnostics.report} when the level is `'throw'`. */
export class DiagnosticError extends Error {
  readonly code: string;
  readonly detail: unknown;

  constructor(event: Diagnostic) {
    super(`[${event.code}] ${event.message}`);
    this.name = 'DiagnosticError';
    this.code = event.code;
    this.detail = event.detail;
  }
}

/**
 * Central reporting hub. Create one per {@link Renderer} and pass it down; the
 * engine never calls `console` directly.
 */
export class Diagnostics {
  level: DiagnosticsLevel;

  private readonly listeners = new Set<DiagnosticListener>();
  private readonly warned = new Set<string>();

  constructor(level: DiagnosticsLevel = 'warn') {
    this.level = level;
  }

  /** Subscribe to every report regardless of level. Returns an unsubscribe fn. */
  on(listener: DiagnosticListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Report a condition.
   *
   * Listeners always fire first, then the level decides what the *user* sees:
   * `'silent'` stops there, `'warn'` prints at most once per code, `'throw'`
   * raises a {@link DiagnosticError} — but only for `severity: 'error'`. An
   * informational report is never allowed to throw, see
   * {@link DiagnosticSeverity}.
   */
  report(
    code: string,
    message: string,
    detail?: unknown,
    severity: DiagnosticSeverity = 'error',
  ): void {
    const event: Diagnostic =
      detail === undefined ? { code, message, severity } : { code, message, detail, severity };

    for (const listener of this.listeners) listener(event);

    if (this.level === 'throw' && severity === 'error') throw new DiagnosticError(event);
    if (this.level === 'silent') return;

    if (!this.warned.has(code)) {
      this.warned.add(code);
      const suffix = detail === undefined ? '' : ` ${safeStringify(detail)}`;
      console.warn(`[as-charts] ${code}: ${message}${suffix}`);
    }
  }

  /** Forget which codes have been warned about. Useful between test cases. */
  clearWarnings(): void {
    this.warned.clear();
  }

  /** Drop all listeners. Called from `Renderer.destroy()`. */
  dispose(): void {
    this.listeners.clear();
    this.warned.clear();
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
