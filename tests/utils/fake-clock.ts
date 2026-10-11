import type { SchedulerHost } from '../../src/core/FrameScheduler';

/**
 * Deterministic frame clock.
 *
 * `FrameScheduler` behaviour is entirely about *when* a frame does or does not
 * run — coalescing, rate gating, clamping, visibility. Asserting that against a
 * real `requestAnimationFrame` produces tests that pass or fail depending on
 * machine load. This host makes each tick an explicit, observable step.
 */
export interface FakeClock {
  readonly host: SchedulerHost;
  /** Current virtual time in milliseconds. */
  now: number;
  /** Callbacks scheduled but not yet run. */
  readonly pending: number;
  /** Number of frames actually delivered. */
  readonly delivered: number;
  /** Advance time and deliver every callback scheduled before this call. */
  frame(advanceMs?: number): void;
}

export function createFakeClock(start = 0): FakeClock {
  let now = start + 16.67;
  let nextHandle = 1;
  let delivered = 0;
  const queue = new Map<number, (now: number) => void>();

  const clock: FakeClock = {
    get now() {
      return now;
    },
    get pending() {
      return queue.size;
    },
    get delivered() {
      return delivered;
    },
    host: {
      requestFrame(callback) {
        const handle = nextHandle++;
        queue.set(handle, callback);
        return handle;
      },
      cancelFrame(handle) {
        queue.delete(handle);
      },
    },
    frame(advanceMs = 16.67) {
      now += advanceMs;
      // Snapshot before running: a callback that reschedules must land in the
      // *next* batch, exactly as requestAnimationFrame behaves.
      const batch = [...queue.entries()];
      queue.clear();
      for (const [, callback] of batch) {
        delivered += 1;
        callback(now);
      }
    },
  };

  return clock;
}
