import { describe, expect, it, vi } from 'vitest';

import { FrameScheduler } from '../src/core/FrameScheduler';
import { Dirty, DirtyAll, hasDirty, type DirtyFlags } from '../src/core/dirty';
import { createFakeClock } from './utils/fake-clock';

/**
 * The scheduler is where "能不画就不画" is actually implemented. Every test here
 * asserts that a frame *does not* happen, or that its cost is bounded — the
 * positive case (a frame renders) is the trivial one.
 */
describe('FrameScheduler', () => {
  function setup(options: { maxFps?: number; skipOffscreen?: boolean } = {}) {
    const clock = createFakeClock();
    const frames: { dirty: DirtyFlags; delta: number }[] = [];
    const onFrame = vi.fn((dirty: DirtyFlags, delta: number) => {
      frames.push({ dirty, delta });
    });
    const scheduler = new FrameScheduler({ ...options, host: clock.host }, onFrame);
    return { clock, scheduler, frames, onFrame };
  }

  it('coalesces many requests into a single frame', () => {
    const { clock, scheduler, frames } = setup();

    for (let i = 0; i < 20; i += 1) scheduler.request(Dirty.Data);
    expect(scheduler.pending).toBe(true);

    clock.frame();
    // LCJS funnels 766 call sites through one flag for exactly this reason.
    expect(frames).toHaveLength(1);
    expect(clock.delivered).toBe(1);
  });

  it('accumulates flags from every request', () => {
    const { clock, scheduler, frames } = setup();
    scheduler.request(Dirty.Style);
    scheduler.request(Dirty.Text);
    clock.frame();

    expect(frames[0]?.dirty).toBe(Dirty.Style | Dirty.Text);
  });

  it('propagates Data down to Geometry and Upload before rendering', () => {
    const { clock, scheduler, frames } = setup();
    scheduler.request(Dirty.Data);
    clock.frame();

    const dirty = frames[0]?.dirty ?? Dirty.None;
    expect(hasDirty(dirty, Dirty.Geometry)).toBe(true);
    expect(hasDirty(dirty, Dirty.Upload)).toBe(true);
  });

  it('clears the flags it consumed', () => {
    const { clock, scheduler } = setup();
    scheduler.request(Dirty.Data);
    clock.frame();
    expect(scheduler.dirty).toBe(Dirty.None);
  });

  it('does not render, and does not reschedule, when nothing is dirty', () => {
    const { clock, scheduler, frames } = setup();
    scheduler.request(Dirty.None);
    clock.frame();

    expect(frames).toHaveLength(0);
    expect(scheduler.stats().skippedClean).toBe(1);
    // No reschedule: a clean scheduler must not spin the animation loop.
    expect(scheduler.pending).toBe(false);
  });

  it('skips frames under the rate cap but always renders eventually', () => {
    const clock = createFakeClock();
    const frames: { dirty: DirtyFlags; delta: number }[] = [];
    // A live chart re-requests from its own render callback, so the continuous
    // case — not a one-shot request — is the one the rate gate must keep making
    // progress on.
    const scheduler = new FrameScheduler({ maxFps: 30, host: clock.host }, (dirty, delta) => {
      frames.push({ dirty, delta });
      scheduler.request(Dirty.Data);
    });

    scheduler.request(Dirty.Data);
    for (let i = 0; i < 4; i += 1) clock.frame();

    // 30 fps needs a 33.3 ms interval and each tick advances 16.67 ms, so every
    // other tick renders and the odd one out is gated.
    expect(scheduler.stats().skippedByFpsCap).toBe(2);
    // Regression guard: an implementation that measures the interval from the last
    // *rendered* frame while only advancing that timestamp on render deadlocks at
    // a cap — the first frame never renders, so the timestamp never moves, so the
    // cap never opens and `framesRendered` stays at zero forever.
    expect(scheduler.stats().framesRendered).toBe(2);
    expect(frames).toHaveLength(2);
  });

  it('reports the accumulated interval as the frame delta under a cap', () => {
    const { clock, scheduler, frames } = setup({ maxFps: 30 });
    scheduler.request(Dirty.Data);
    clock.frame();
    clock.frame();

    // Two 16.67 ms ticks are needed to clear a 33.3 ms interval, so the rendered
    // frame must see the sum, not one tick.
    expect(frames[0]?.delta).toBeCloseTo(33.34, 1);
  });

  it('follows the display refresh rate when no cap is set', () => {
    const { scheduler } = setup();
    expect(scheduler.maxFps).toBeUndefined();
  });

  it('treats -1 as uncapped', () => {
    const { scheduler } = setup({ maxFps: -1 });
    expect(scheduler.maxFps).toBeUndefined();
  });

  it('reports the configured cap', () => {
    const { scheduler } = setup({ maxFps: 30 });
    expect(scheduler.maxFps).toBeCloseTo(30, 5);
  });

  it('rejects an invalid frame-rate cap', () => {
    expect(() => new FrameScheduler({ maxFps: 0 }, () => undefined)).toThrow(RangeError);
    expect(() => new FrameScheduler({ maxFps: -5 }, () => undefined)).toThrow(RangeError);
    expect(() => new FrameScheduler({ maxFps: Number.NaN }, () => undefined)).toThrow(RangeError);
  });

  it('allows changing the cap at runtime', () => {
    const { clock, scheduler, frames } = setup();
    scheduler.request(Dirty.Data);
    clock.frame();
    expect(frames).toHaveLength(1);

    scheduler.setMaxFps(10);
    expect(scheduler.maxFps).toBeCloseTo(10, 5);
  });

  it('clamps a long gap to one 60 Hz frame', () => {
    const { clock, scheduler, frames } = setup();
    scheduler.request(Dirty.Data);
    clock.frame(16.67);

    scheduler.request(Dirty.Data);
    clock.frame(5000);

    // Returning to a backgrounded tab must not jump the whole animation.
    expect(frames[1]?.delta).toBeCloseTo(1000 / 60, 5);
  });

  it('keeps dirty work while invisible and renders it on becoming visible', () => {
    const { clock, scheduler, frames } = setup();

    scheduler.request(Dirty.Data);
    scheduler.setVisible(false);
    clock.frame();

    expect(frames).toHaveLength(0);
    expect(scheduler.stats().skippedInvisible).toBe(1);
    // The work is still owed: dropping the flags here is what makes charts "stick"
    // after a tab switch.
    expect(hasDirty(scheduler.dirty, Dirty.Data)).toBe(true);
    expect(scheduler.pending).toBe(false);

    scheduler.setVisible(true);
    clock.frame();
    expect(frames).toHaveLength(1);
    // `request(Dirty.Data)` expands to Data|Geometry|Upload through the
    // propagation chain, so assert containment rather than equality.
    expect(hasDirty(frames[0]?.dirty ?? Dirty.None, Dirty.Data)).toBe(true);
  });

  it('repaints without new dirty flags when visibility returns', () => {
    const { clock, scheduler, frames } = setup();
    scheduler.setVisible(false);
    scheduler.setVisible(true);

    clock.frame();
    // The browser may have discarded the back buffer, so a repaint is required
    // even though no state is stale.
    expect(frames).toHaveLength(1);
    expect(hasDirty(frames[0]?.dirty ?? Dirty.None, Dirty.Present)).toBe(true);
  });

  it('does not accumulate time while invisible', () => {
    const { clock, scheduler, frames } = setup();
    scheduler.setVisible(false);
    scheduler.request(Dirty.Data);
    clock.frame();

    clock.frame(10_000);
    expect(frames).toHaveLength(0);

    scheduler.setVisible(true);
    clock.frame();

    // The first visible frame must not be told that ten seconds passed.
    expect(frames[0]?.delta).toBeCloseTo(1000 / 60, 5);
  });

  it('does not render when visibility changes to the same value', () => {
    const { clock, scheduler, frames } = setup();
    scheduler.setVisible(true);
    scheduler.setVisible(true);
    clock.frame();
    expect(frames).toHaveLength(0);
  });

  it('lets a render callback request the next frame', () => {
    const clock = createFakeClock();
    const dirtyHistory: DirtyFlags[] = [];
    const scheduler = new FrameScheduler({ host: clock.host }, (dirty) => {
      dirtyHistory.push(dirty);
      if (dirtyHistory.length === 1) scheduler.request(Dirty.Text);
    });

    scheduler.request(Dirty.Data);
    clock.frame();
    expect(scheduler.pending).toBe(true);

    clock.frame();
    expect(dirtyHistory).toHaveLength(2);
    expect(dirtyHistory[1]).toBe(Dirty.Text);
  });

  it('requestAll marks every stage dirty', () => {
    const { clock, scheduler, frames } = setup();
    scheduler.requestAll();
    clock.frame();
    expect(frames[0]?.dirty).toBe(DirtyAll);
  });

  it('cancels a pending frame on dispose', () => {
    const { clock, scheduler, frames } = setup();
    scheduler.request(Dirty.Data);
    scheduler.dispose();

    expect(clock.pending).toBe(0);
    clock.frame();
    expect(frames).toHaveLength(0);
  });

  it('ignores requests after dispose', () => {
    const { clock, scheduler } = setup();
    scheduler.dispose();
    scheduler.request(Dirty.Data);
    expect(scheduler.pending).toBe(false);
    clock.frame();
    expect(scheduler.stats().framesRendered).toBe(0);
  });

  it('is idempotent on dispose', () => {
    const { scheduler } = setup();
    scheduler.dispose();
    expect(() => {
      scheduler.dispose();
    }).not.toThrow();
  });

  it('tracks a high-water mark for the frame delta', () => {
    const { clock, scheduler } = setup();
    scheduler.request(Dirty.Data);
    clock.frame(20);
    expect(scheduler.stats().maxDelta).toBeGreaterThan(0);
    expect(scheduler.stats().lastDelta).toBe(scheduler.stats().maxDelta);
  });
});
