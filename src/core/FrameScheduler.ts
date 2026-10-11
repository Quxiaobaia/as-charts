import { Dirty, type DirtyFlags, propagateDirty, shouldRender } from './dirty';

/**
 * Injection seam for the frame clock.
 *
 * The engine never touches `requestAnimationFrame` directly. Tests drive a
 * deterministic fake clock, which is the only way to assert frame-rate gating
 * behaviour without flaky timing.
 */
export interface SchedulerHost {
  requestFrame(callback: (now: number) => void): number;
  cancelFrame(handle: number): void;
}

export interface SchedulerOptions {
  /**
   * Frame-rate cap.
   *
   * `undefined` (the default) follows the display refresh rate. Do **not**
   * hard-code 60 here: industrial panels ship at different refresh rates, and a
   * hard cap silently throws away smoothness on a 120/144 Hz display.
   *
   * Explicit `undefined` is accepted alongside absence so a caller can forward an
   * optional value without a conditional spread.
   */
  maxFps?: number | undefined;
  /** Skip rendering while the chart is not visible. Default `true`. */
  skipOffscreen?: boolean;
  /** Clock/rAF injection for tests. Defaults to the browser globals. */
  host?: SchedulerHost;
}

export interface SchedulerStats {
  readonly framesRequested: number;
  readonly framesRendered: number;
  readonly skippedByFpsCap: number;
  readonly skippedInvisible: number;
  readonly skippedClean: number;
  readonly lastDelta: number;
  readonly maxDelta: number;
  /**
   * Whether a frame is currently scheduled.
   *
   * Not a counter — it is the one piece of live state worth exposing, because
   * `false` with a clean flag set is exactly "the animation loop has gone idle",
   * which is the whole point of the dirty-flag model.
   */
  readonly pending: boolean;
}

/** Called with the flags consumed by this frame and the time since the last one. */
export type FrameRenderFn = (dirty: DirtyFlags, delta: number) => void;

const CLAMP_THRESHOLD_MS = 50;
const ASSUMED_FRAME_MS = 1000 / 60;

const defaultHost: SchedulerHost = {
  requestFrame(callback) {
    return globalThis.requestAnimationFrame(callback);
  },
  cancelFrame(handle) {
    globalThis.cancelAnimationFrame(handle);
  },
};

/**
 * The single entry point for "something changed, redraw".
 *
 * Four mechanisms are copied from LCJS 9.0's scheduler because they are pure
 * wins — they remove work instead of making work faster:
 *
 * 1. **rAF coalescing.** LCJS funnels 766 call sites through one pending flag;
 *    we do the same, so twenty `appendSamples()` calls in one tick cost one frame.
 * 2. **`maxFps` gate.** While under the minimum interval the frame is rescheduled
 *    without consuming budget. Used for off-focus charts and by degradation L4.
 * 3. **Delta clamping.** A frame longer than 50 ms counts as one 60 Hz frame, so
 *    returning to a backgrounded tab does not jump the whole animation.
 * 4. **Visibility gate.** An offscreen chart keeps its dirty flags but does not
 *    render, and is repainted once it becomes visible again.
 *
 * Two invariants worth stating because violating either produces "stuck" charts:
 *
 * - Dirty flags are cleared **only** when a frame actually renders. A skipped
 *   frame must never lose the work it was supposed to do.
 * - The frame-rate gate measures **accumulated** time since the last render, not
 *   the last tick. Measuring since the last *render* using a timestamp that only
 *   advances on render deadlocks: under a cap the first frame never renders, so
 *   the timestamp never advances, so the cap never opens.
 */
export class FrameScheduler {
  readonly #render: FrameRenderFn;
  readonly #host: SchedulerHost;
  readonly #skipOffscreen: boolean;

  #pending = false;
  #disposed = false;
  #visible = true;
  #dirty: DirtyFlags = Dirty.None;
  #minFrameInterval = 0;
  #lastTickTime = 0;
  #elapsed = 0;
  #handle = 0;

  #framesRequested = 0;
  #framesRendered = 0;
  #skippedByFpsCap = 0;
  #skippedInvisible = 0;
  #skippedClean = 0;
  #lastDelta = 0;
  #maxDelta = 0;

  constructor(options: SchedulerOptions, render: FrameRenderFn) {
    this.#render = render;
    this.#host = options.host ?? defaultHost;
    this.#skipOffscreen = options.skipOffscreen ?? true;
    this.setMaxFps(options.maxFps);
  }

  /**
   * Frame-rate cap in fps. `undefined` or `-1` means "follow the display".
   *
   * @throws {RangeError} for zero, negative (other than -1) or non-finite values.
   */
  setMaxFps(maxFps: number | undefined): void {
    if (maxFps === undefined || maxFps === -1) {
      this.#minFrameInterval = 0;
      return;
    }
    if (!Number.isFinite(maxFps) || maxFps <= 0) {
      throw new RangeError(`maxFps must be a positive number, -1, or undefined; got ${maxFps}`);
    }
    this.#minFrameInterval = 1000 / maxFps;
  }

  /** Current cap in fps, or `undefined` when the scheduler follows the display. */
  get maxFps(): number | undefined {
    return this.#minFrameInterval > 0 ? 1000 / this.#minFrameInterval : undefined;
  }

  /** Flags awaiting the next rendered frame. */
  get dirty(): DirtyFlags {
    return this.#dirty;
  }

  get visible(): boolean {
    return this.#visible;
  }

  /** True while a frame is scheduled. */
  get pending(): boolean {
    return this.#pending;
  }

  /**
   * Request a redraw. Coalesces — repeated calls inside one tick are free.
   *
   * This is the only place that touches `requestAnimationFrame`, mirroring LCJS's
   * single-pending-flag design.
   */
  request(dirty: DirtyFlags = Dirty.Present): void {
    if (this.#disposed) return;
    this.#dirty = propagateDirty(this.#dirty | dirty);
    this.#schedule();
  }

  /** Request every stage. Used after a context restore. */
  requestAll(): void {
    this.request(
      Dirty.Data | Dirty.Geometry | Dirty.Upload | Dirty.Text | Dirty.Axis | Dirty.Viewport,
    );
    this.request(Dirty.Style | Dirty.Present);
  }

  /**
   * Update the visibility gate.
   *
   * Becoming visible requests a repaint even when nothing is dirty, because the
   * browser may have discarded the canvas back buffer while it was hidden.
   */
  setVisible(visible: boolean): void {
    if (this.#visible === visible) return;
    this.#visible = visible;
    if (visible) this.request(this.#dirty === Dirty.None ? Dirty.Present : Dirty.None);
  }

  /** Diagnostic snapshot. Allocates; not for hot paths. */
  stats(): SchedulerStats {
    return Object.freeze({
      framesRequested: this.#framesRequested,
      framesRendered: this.#framesRendered,
      skippedByFpsCap: this.#skippedByFpsCap,
      skippedInvisible: this.#skippedInvisible,
      skippedClean: this.#skippedClean,
      lastDelta: this.#lastDelta,
      maxDelta: this.#maxDelta,
      pending: this.#pending,
    });
  }

  /** Cancel any pending frame. The scheduler must not be used afterwards. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#pending) this.#host.cancelFrame(this.#handle);
    this.#pending = false;
    this.#dirty = Dirty.None;
    this.#elapsed = 0;
  }

  #schedule(): void {
    if (this.#pending || this.#disposed) return;
    this.#pending = true;
    this.#framesRequested += 1;
    this.#handle = this.#host.requestFrame(this.#tick);
  }

  #tick = (now: number): void => {
    this.#pending = false;
    if (this.#disposed) return;

    const dt = this.#lastTickTime === 0 ? ASSUMED_FRAME_MS : now - this.#lastTickTime;
    this.#lastTickTime = now;

    if (!shouldRender(this.#dirty)) {
      this.#skippedClean += 1;
      this.#elapsed = 0;
      return;
    }

    if (this.#skipOffscreen && !this.#visible) {
      // Keep the flags: the work is still owed once the chart is visible again.
      // Do not accumulate time either, or the first visible frame would see a
      // delta covering the entire hidden period.
      this.#skippedInvisible += 1;
      this.#elapsed = 0;
      return;
    }

    this.#elapsed += dt;

    if (this.#minFrameInterval > 0 && this.#elapsed < this.#minFrameInterval) {
      this.#skippedByFpsCap += 1;
      this.#schedule();
      return;
    }

    const delta = this.#elapsed > CLAMP_THRESHOLD_MS ? ASSUMED_FRAME_MS : this.#elapsed;
    this.#elapsed = 0;

    const consumed = this.#dirty;
    this.#dirty = Dirty.None;

    this.#framesRendered += 1;
    this.#lastDelta = delta;
    if (delta > this.#maxDelta) this.#maxDelta = delta;

    this.#render(consumed, delta);
  };
}
