import { describe, expect, it } from 'vitest';

import {
  Dirty,
  DirtyAll,
  describeDirty,
  hasDirty,
  propagateDirty,
  shouldRender,
} from '../src/core/dirty';

describe('dirty flags', () => {
  it('assigns each flag a distinct single bit', () => {
    const values = Object.values(Dirty);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);

    for (const value of values) {
      // A single bit is either zero or a power of two.
      expect(value === 0 || (value & (value - 1)) === 0).toBe(true);
    }
  });

  it('includes every declared flag in DirtyAll', () => {
    for (const [name, value] of Object.entries(Dirty)) {
      if (name === 'None') continue;
      expect(hasDirty(DirtyAll, value), `${name} missing from DirtyAll`).toBe(true);
    }
  });

  it('propagates Data down to Geometry and Upload', () => {
    const propagated = propagateDirty(Dirty.Data);
    expect(hasDirty(propagated, Dirty.Geometry)).toBe(true);
    expect(hasDirty(propagated, Dirty.Upload)).toBe(true);
  });

  it('propagates Geometry to Upload', () => {
    const propagated = propagateDirty(Dirty.Geometry);
    expect(hasDirty(propagated, Dirty.Upload)).toBe(true);
    expect(hasDirty(propagated, Dirty.Data)).toBe(false);
  });

  it('keeps Style decoupled from Geometry', () => {
    // This is the whole point of separating the flags: changing a stroke colour
    // must not rebuild per-instance attributes for a million-point series.
    const propagated = propagateDirty(Dirty.Style);
    expect(propagated).toBe(Dirty.Style);
    expect(hasDirty(propagated, Dirty.Geometry)).toBe(false);
    expect(hasDirty(propagated, Dirty.Upload)).toBe(false);
  });

  it('leaves Present, Text, Axis and Viewport independent', () => {
    for (const flag of [Dirty.Present, Dirty.Text, Dirty.Axis, Dirty.Viewport]) {
      expect(propagateDirty(flag)).toBe(flag);
    }
  });

  it('is idempotent', () => {
    const once = propagateDirty(Dirty.Data);
    expect(propagateDirty(once)).toBe(once);
  });

  it('reports whether any flag in a mask is set', () => {
    const flags = Dirty.Data | Dirty.Text;
    expect(hasDirty(flags, Dirty.Text)).toBe(true);
    expect(hasDirty(flags, Dirty.Geometry)).toBe(false);
    expect(hasDirty(flags, Dirty.Geometry | Dirty.Text)).toBe(true);
  });

  it('treats only None as "nothing to render"', () => {
    expect(shouldRender(Dirty.None)).toBe(false);
    expect(shouldRender(Dirty.Present)).toBe(true);
    expect(shouldRender(Dirty.Style)).toBe(true);
  });

  it('describes flag combinations for diagnostics', () => {
    expect(describeDirty(Dirty.None)).toBe('None');
    expect(describeDirty(Dirty.Data)).toBe('Data');
    expect(describeDirty(Dirty.Data | Dirty.Text)).toBe('Data|Text');
    expect(describeDirty(DirtyAll)).toBe('Data|Geometry|Upload|Text|Axis|Viewport|Style|Present');
  });
});
