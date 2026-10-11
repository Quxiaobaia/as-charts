import { describe, expect, it } from 'vitest';

import { Diagnostics } from '../src/core/Diagnostics';
import { ID_SPACE_CAPACITY, IdSpace } from '../src/core/IdSpace';

/**
 * Contract C1's gate list, made executable.
 *
 * `api-stability.md` names four things this must prove: "0 恒未命中、存活区间不重叠、
 * 销毁后区间可复用、超限必报诊断". Each gets a suite below, plus the guards that
 * make them hold rather than merely be intended.
 *
 * The failure this file is really about is not "ids run out". It is the *silent*
 * variant: an allocator that wraps, or that grants the same ids twice, produces
 * picking that occasionally resolves to a different entity. C1's own words —
 * "偶发且难复现" — and the reason the assertions here are about refusal and
 * reporting rather than about happy paths.
 */

function collect(diagnostics: Diagnostics): string[] {
  const codes: string[] = [];
  diagnostics.on((event) => codes.push(event.code));
  return codes;
}

function fresh(capacity?: number): { ids: IdSpace; codes: string[]; diagnostics: Diagnostics } {
  const diagnostics = new Diagnostics('silent');
  const codes = collect(diagnostics);
  const ids =
    capacity === undefined ? new IdSpace(diagnostics) : new IdSpace(diagnostics, capacity);
  return { ids, codes, diagnostics };
}

describe('IdSpace · rule 1: 0 is never a legal id', () => {
  it('starts the free pool at 1, not 0', () => {
    const { ids } = fresh();
    expect(ids.freeRanges()).toEqual([{ first: 1, count: ID_SPACE_CAPACITY }]);
    expect(ids.capacity).toBe(ID_SPACE_CAPACITY);
  });

  it('never grants 0 even after every id has been recycled', () => {
    const { ids } = fresh(4);
    const grants = [ids.allocate(2), ids.allocate(2)];
    for (const grant of grants) ids.release(grant.first, grant.count);
    for (let round = 0; round < 8; round += 1) {
      const grant = ids.allocate(1);
      expect(grant.first).toBeGreaterThan(0);
      ids.release(grant.first, grant.count);
    }
  });

  it('reports an empty range for a zero-count request without consuming anything', () => {
    const { ids } = fresh(8);
    expect(ids.allocate(0)).toEqual({ first: 0, count: 0, degraded: false });
    expect(ids.free).toBe(8);
    expect(ids.live).toBe(0);
  });
});

describe('IdSpace · rule 3 and 5: contiguous, non-overlapping, recyclable', () => {
  it('hands out contiguous ranges', () => {
    const { ids } = fresh(32);
    const a = ids.allocate(3);
    expect(a).toMatchObject({ first: 1, count: 3, degraded: false });
    const b = ids.allocate(4);
    expect(b.first).toBe(4);
    expect(ids.free).toBe(25);
    expect(ids.live).toBe(7);
  });

  it('keeps live ranges disjoint, checked exhaustively', () => {
    const { ids } = fresh(64);
    const live: { first: number; count: number }[] = [];
    const sizes = [1, 5, 2, 9, 3];
    for (const size of sizes) live.push(ids.allocate(size));

    for (let i = 0; i < live.length; i += 1) {
      for (let j = i + 1; j < live.length; j += 1) {
        const a = live[i] as { first: number; count: number };
        const b = live[j] as { first: number; count: number };
        const overlap = a.first < b.first + b.count && b.first < a.first + a.count;
        expect(overlap, `ranges ${String(i)} and ${String(j)} overlap`).toBe(false);
      }
    }
  });

  it('coalesces a released range with both neighbours', () => {
    const { ids } = fresh(16);
    const a = ids.allocate(4);
    const b = ids.allocate(4);
    const c = ids.allocate(4);
    expect(ids.freeRanges()).toEqual([{ first: 13, count: 4 }]);

    ids.release(b.first, b.count);
    expect(ids.freeRanges()).toEqual([
      { first: 5, count: 4 },
      { first: 13, count: 4 },
    ]);

    ids.release(a.first, a.count);
    ids.release(c.first, c.count);
    // All three adjacent runs collapse into the original single run.
    expect(ids.freeRanges()).toEqual([{ first: 1, count: 16 }]);
    expect(ids.freeRangeCount).toBe(1);
  });

  it('reuses a released range rather than only extending (rule 5)', () => {
    const { ids } = fresh(16);
    const first = ids.allocate(4);
    const second = ids.allocate(4);
    ids.release(first.first, first.count);

    const reused = ids.allocate(2);
    expect(reused.first).toBe(first.first);
    expect(reused.first).not.toBe(second.first);
    // 16 total, 8 live after the first two grants, 12 free once the first is
    // returned, 10 free once 2 of those are taken again.
    expect(ids.free).toBe(10);
    expect(ids.live).toBe(6);
  });

  it('refuses a double release instead of creating an overlap', () => {
    const { ids, codes } = fresh(16);
    const grant = ids.allocate(4);
    expect(ids.release(grant.first, grant.count)).toBe(true);
    expect(ids.release(grant.first, grant.count)).toBe(false);
    expect(codes).toEqual(['picking/id-range-invalid']);
    // The pool is unchanged by the refused second release.
    expect(ids.free).toBe(16);
  });

  it('refuses a release that only partially overlaps a free run', () => {
    const { ids, codes } = fresh(16);
    const grant = ids.allocate(4);
    ids.release(grant.first, grant.count);
    expect(ids.release(grant.first + 2, 4)).toBe(false);
    expect(codes).toEqual(['picking/id-range-invalid']);
  });

  it('refuses a range outside the space, including one starting at 0', () => {
    const { ids, codes } = fresh(16);
    expect(ids.release(0, 2)).toBe(false);
    expect(ids.release(15, 4)).toBe(false);
    expect(codes).toEqual(['picking/id-range-invalid', 'picking/id-range-invalid']);
  });

  it('returns everything to the pool on clear', () => {
    const { ids } = fresh(16);
    ids.allocate(4);
    ids.allocate(4);
    ids.clear();
    expect(ids.live).toBe(0);
    expect(ids.free).toBe(16);
    expect(ids.freeRanges()).toEqual([{ first: 1, count: 16 }]);
  });
});

describe('IdSpace · exhaustion is reported and degrades, never wraps', () => {
  it('degrades a request that cannot fit to series-level picking', () => {
    const { ids, codes } = fresh(8);
    const big = ids.allocate(6);
    expect(big.degraded).toBe(false);

    const overflow = ids.allocate(4);
    // Two ids are left, so a 4-id request cannot be met; one is granted instead.
    expect(overflow).toEqual({ first: 7, count: 1, degraded: true });
    expect(codes).toEqual(['picking/id-space-exhausted']);
  });

  it('never satisfies a degraded request by overlapping a live range', () => {
    const { ids } = fresh(8);
    const taken = ids.allocate(6);
    const overflow = ids.allocate(4);
    expect(overflow.first + overflow.count).toBeLessThanOrEqual(taken.first + 8);
    expect(overflow.first).toBeGreaterThanOrEqual(taken.first + taken.count);
  });

  it('reports an unpickable entity when nothing at all is free', () => {
    const { ids, codes } = fresh(4);
    ids.allocate(4);
    const overflow = ids.allocate(2);
    expect(overflow).toEqual({ first: 0, count: 0, degraded: true });
    expect(codes).toEqual(['picking/id-space-exhausted']);
  });

  it('escalates to a throw when diagnostics are configured that way', () => {
    const ids = new IdSpace(new Diagnostics('throw'), 4);
    ids.allocate(4);
    expect(() => ids.allocate(1)).toThrow(/id space is exhausted/);
  });

  it('does not report when a request fits exactly', () => {
    const { ids, codes } = fresh(4);
    expect(ids.allocate(4)).toEqual({ first: 1, count: 4, degraded: false });
    expect(codes).toEqual([]);
  });
});
