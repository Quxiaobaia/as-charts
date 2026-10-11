import type { Diagnostics } from './Diagnostics';

/**
 * The pick-id allocator — contract **C1**, rules 1, 2, 3 and 5.
 *
 * Picking works by writing an entity's id into a colour attachment and reading
 * the integer back at the pointer. That makes the id the *only* channel back
 * from a pixel to an entity, so three things must hold globally rather than
 * per-chart:
 *
 * - **0 is never handed out.** The cleared framebuffer is `(0,0,0,0)`, so 0 means
 *   "nothing here". An entity holding 0 is indistinguishable from empty space,
 *   and the failure shows up as picking that returns a point in the middle of
 *   nowhere.
 * - **One space for the whole renderer.** Not per-chart, not per-layer. "Point 5
 *   of layer 0" has to be unambiguous, because several charts sharing one axis
 *   and multi-chart split views are the core scenario.
 * - **Ranges are contiguous and never overlap while alive.** A readback that
 *   lands in an overlap can resolve to either entity, nondeterministically.
 *
 * ## Why this lands in M1
 *
 * `api-stability.md` schedules the id space for M2 along with the picking pass,
 * but the `DrawCall` descriptor must carry an id range from M1 onwards (C2 rule
 * 4), and a descriptor carrying a *fabricated* range is worse than no range at
 * all — a fabricated one looks correct in every test and is wrong the moment two
 * layers exist. The allocation half is small and is the half C1's own gate list
 * asks to have tested: "0 恒未命中、存活区间不重叠、销毁后区间可复用、超限必报诊断".
 * The readback half still belongs to M2's picker.
 *
 * ## Recycling, not monotonicity
 *
 * Rule 5: released ranges return to a free pool and may be reused, so uniqueness
 * holds *for the current frame*, not for the process lifetime. That is exactly
 * why C1 forbids caching an id across frames — after an entity dies, its ids can
 * name a different entity.
 */
export interface IdRange {
  readonly first: number;
  readonly count: number;
}

export interface IdGrant extends IdRange {
  /**
   * True when the request did not fit and was cut down to series-level picking
   * (`count = 1`). The geometry is still drawn; only per-point readback is lost.
   */
  readonly degraded: boolean;
}

/** `2^32 - 1` usable ids: everything except the reserved 0. */
export const ID_SPACE_CAPACITY = 0xffff_ffff;

interface FreeRange {
  first: number;
  count: number;
}

export class IdSpace {
  readonly #diagnostics: Diagnostics;
  readonly #capacity: number;
  /** Sorted by `first`, always coalesced: no two entries are adjacent. */
  #free: FreeRange[] = [];
  #freeCount = 0;
  #liveCount = 0;

  constructor(diagnostics: Diagnostics, capacity: number = ID_SPACE_CAPACITY) {
    this.#diagnostics = diagnostics;
    const total = Math.max(1, Math.min(ID_SPACE_CAPACITY, Math.floor(capacity)));
    this.#capacity = total;
    // Rule 1 by construction: the pool starts at 1, so 0 can never be granted.
    this.#free = [{ first: 1, count: total }];
    this.#freeCount = total;
  }

  /** Total ids this space can ever hand out. Excludes the reserved 0. */
  get capacity(): number {
    return this.#capacity;
  }

  /** Ids not currently held by any entity. */
  get free(): number {
    return this.#freeCount;
  }

  get live(): number {
    return this.#liveCount;
  }

  /** Number of free runs. A growing count means fragmentation. */
  get freeRangeCount(): number {
    return this.#free.length;
  }

  /**
   * Claim `count` contiguous ids.
   *
   * First-fit over the free list. On exhaustion this reports
   * `picking/id-space-exhausted` and **degrades the request to a single
   * series-level id** rather than returning an overlapping range — C1 is
   * explicit that degrading readback precision is acceptable and wrapping
   * silently is not, because a wrapped id resolves to a *different* entity.
   *
   * @param count Number of point ids the entity needs. Values below 1 claim
   *   nothing and return an empty range.
   */
  allocate(count: number): IdGrant {
    const wanted = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    if (wanted === 0) return { first: 0, count: 0, degraded: false };

    const direct = this.#take(wanted);
    if (direct !== null) return { first: direct, count: wanted, degraded: false };

    const single = this.#take(1);
    if (single !== null) {
      this.#diagnostics.report(
        'picking/id-space-exhausted',
        `no run of ${String(wanted)} contiguous pick ids is free; the entity was degraded to series-level picking`,
        { requested: wanted, granted: 1, free: this.#freeCount, capacity: this.#capacity },
      );
      return { first: single, count: 1, degraded: true };
    }

    this.#diagnostics.report(
      'picking/id-space-exhausted',
      `the pick id space is exhausted; the entity cannot be picked at all`,
      { requested: wanted, granted: 0, free: 0, capacity: this.#capacity },
    );
    return { first: 0, count: 0, degraded: true };
  }

  /**
   * Return a range to the pool.
   *
   * Refuses a range that overlaps an already-free one and reports
   * `picking/id-range-invalid`. A double release is not a no-op here: it would
   * put the same ids in two free ranges, after which two entities can be granted
   * overlapping ids — the "occasional and hard to reproduce" failure C1 lists as
   * the reason ranges must not be cached across frames.
   *
   * @returns true when the range was live and is now free.
   */
  release(first: number, count: number): boolean {
    const start = Math.floor(first);
    const length = Math.floor(count);
    if (!Number.isFinite(start) || !Number.isFinite(length) || length <= 0) return false;

    if (start < 1 || start - 1 + length > this.#capacity) {
      this.#diagnostics.report(
        'picking/id-range-invalid',
        `range [${String(start)}, ${String(start + length)}) lies outside the id space`,
        { first: start, count: length, capacity: this.#capacity },
      );
      return false;
    }

    if (this.#overlapsFree(start, length)) {
      this.#diagnostics.report(
        'picking/id-range-invalid',
        `range [${String(start)}, ${String(start + length)}) was released twice, or was never allocated`,
        { first: start, count: length },
      );
      return false;
    }

    this.#insert({ first: start, count: length });
    this.#freeCount += length;
    this.#liveCount = Math.max(0, this.#liveCount - length);
    return true;
  }

  /**
   * The free runs, sorted by `first`. Allocates — for diagnostics and test
   * assertions, never for a frame.
   */
  freeRanges(): readonly IdRange[] {
    const out: IdRange[] = [];
    for (const range of this.#free) out.push({ first: range.first, count: range.count });
    return Object.freeze(out);
  }

  /** Return every id to the pool. For `destroy()` and for a lost context. */
  clear(): void {
    this.#free = [{ first: 1, count: this.#capacity }];
    this.#freeCount = this.#capacity;
    this.#liveCount = 0;
  }

  #take(count: number): number | null {
    const free = this.#free;
    for (let i = 0; i < free.length; i += 1) {
      const range = free[i];
      if (range === undefined || range.count < count) continue;
      const first = range.first;
      if (range.count === count) free.splice(i, 1);
      else {
        range.first += count;
        range.count -= count;
      }
      this.#freeCount -= count;
      this.#liveCount += count;
      return first;
    }
    return null;
  }

  #overlapsFree(first: number, count: number): boolean {
    const end = first + count;
    for (const range of this.#free) {
      if (range.first < end && first < range.first + range.count) return true;
    }
    return false;
  }

  /** Sorted insert, coalescing with the neighbours on either side. */
  #insert(entry: FreeRange): void {
    const free = this.#free;
    let index = 0;
    while (index < free.length) {
      const range = free[index];
      if (range === undefined || range.first > entry.first) break;
      index += 1;
    }
    free.splice(index, 0, entry);

    // Merge forward, then backward, so a triple that becomes run-adjacent in one
    // release collapses into one entry rather than two.
    const next = free[index + 1];
    if (next !== undefined && entry.first + entry.count === next.first) {
      entry.count += next.count;
      free.splice(index + 1, 1);
    }
    const previous = index > 0 ? free[index - 1] : undefined;
    if (previous !== undefined && previous.first + previous.count === entry.first) {
      previous.count += entry.count;
      free.splice(index, 1);
    }
  }
}
