import { describe, expect, it } from 'vitest';

import { DiagnosticError } from '../src/core/Diagnostics';
import { ResourcePool, type ResourceKind } from '../src/core/ResourcePool';
import { createMockGL } from './utils/mock-gl';

/**
 * The resource ledger is what turns "does destroy() free everything?" from a code
 * review into an assertion. Two real leaks from the reference libraries are the
 * reason it exists: `webgl-plot` v2 recreates its stroke buffer without deleting
 * the old one, and LCJS 9.0 never calls `deleteVertexArray` at all.
 */
describe('ResourcePool', () => {
  function setup(): { mock: ReturnType<typeof createMockGL>; pool: ResourcePool } {
    const mock = createMockGL();
    return { mock, pool: new ResourcePool(mock.gl) };
  }

  it('tracks live counts and bytes per kind', () => {
    const { pool } = setup();
    pool.track('buffer', {}, 256, 'a');
    pool.track('buffer', {}, 512, 'b');
    pool.track('texture', {}, 1024, 'c');

    const snapshot = pool.snapshot();
    expect(snapshot.counts.buffer).toBe(2);
    expect(snapshot.counts.texture).toBe(1);
    expect(snapshot.bytes).toBe(256 + 512 + 1024);
    expect(pool.liveCount).toBe(3);
  });

  it('is idempotent when the same handle is tracked twice', () => {
    const { pool } = setup();
    const handle = {};
    pool.track('buffer', handle, 100, 'a');
    pool.track('buffer', handle, 100, 'a');
    expect(pool.liveCount).toBe(1);
    expect(pool.bytes).toBe(100);
  });

  it('calls the deleter matching the resource kind', () => {
    const { mock, pool } = setup();
    const buffer = pool.track('buffer', {}, 0, 'b');
    const vao = pool.track('vertexArray', {}, 0, 'v');
    const texture = pool.track('texture', {}, 0, 't');

    pool.release(buffer);
    pool.release(vao);
    pool.release(texture);

    expect(mock.deleted['buffer']).toBe(1);
    expect(mock.deleted['vertexArray']).toBe(1);
    expect(mock.deleted['texture']).toBe(1);
  });

  it('releases every kind the engine is allowed to allocate', () => {
    const kinds: ResourceKind[] = [
      'shader',
      'program',
      'buffer',
      'texture',
      'framebuffer',
      'renderbuffer',
      'vertexArray',
    ];
    const { mock, pool } = setup();
    for (const kind of kinds) pool.track(kind, {}, 0, kind);
    pool.releaseAll();

    // A kind without a deleter would be silently unfreeable — exactly the
    // WebglScatterAcc "no cleanup() at all" failure.
    for (const kind of kinds) expect(mock.deleted[kind]).toBe(1);
    expect(pool.liveCount).toBe(0);
  });

  it('returns false for unknown or nullish handles', () => {
    const { pool } = setup();
    expect(pool.release(null)).toBe(false);
    expect(pool.release(undefined)).toBe(false);
    expect(pool.release({})).toBe(false);
  });

  it('is a no-op when the same handle is released twice', () => {
    const { mock, pool } = setup();
    const handle = pool.track('buffer', {}, 0, 'b');
    expect(pool.release(handle)).toBe(true);
    expect(pool.release(handle)).toBe(false);
    expect(mock.deleted['buffer']).toBe(1);
  });

  it('restores the byte total after release', () => {
    const { pool } = setup();
    const handle = pool.track('buffer', {}, 4096, 'big');
    expect(pool.bytes).toBe(4096);
    pool.release(handle);
    expect(pool.bytes).toBe(0);
  });

  it('remembers the high-water mark', () => {
    const { pool } = setup();
    const a = pool.track('buffer', {}, 1000, 'a');
    const b = pool.track('buffer', {}, 2000, 'b');
    pool.release(b);
    pool.release(a);
    expect(pool.peakBytes).toBe(3000);
    expect(pool.bytes).toBe(0);
  });

  it('counts created and destroyed totals', () => {
    const { pool } = setup();
    const a = pool.track('buffer', {}, 0, 'a');
    pool.track('buffer', {}, 0, 'b');
    pool.release(a);
    expect(pool.createdCount).toBe(2);
    expect(pool.destroyedCount).toBe(1);
  });

  it('passes assertEmpty after a full release', () => {
    const { pool } = setup();
    pool.track('buffer', {}, 0, 'a');
    pool.releaseAll();
    expect(() => {
      pool.assertEmpty();
    }).not.toThrow();
  });

  it('assertEmpty reports leaking objects by kind and label', () => {
    const { pool } = setup();
    pool.track('buffer', {}, 0, 'instances');
    pool.track('vertexArray', {}, 0, 'vao');

    try {
      pool.assertEmpty('Renderer.destroy');
      throw new Error('expected assertEmpty to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DiagnosticError);
      const diagnostic = error as DiagnosticError;
      expect(diagnostic.code).toBe('resource/leak');
      expect(diagnostic.message).toContain('Renderer.destroy');
      expect(diagnostic.message).toContain('2 GPU object(s)');
      expect(diagnostic.detail).toContain('buffer:instances');
      expect(diagnostic.detail).toContain('vertexArray:vao');
    }
  });

  it('falls back to per-kind counts when objects are unlabelled', () => {
    const { pool } = setup();
    pool.track('buffer', {}, 0);
    try {
      pool.assertEmpty();
      throw new Error('expected assertEmpty to throw');
    } catch (error) {
      const diagnostic = error as DiagnosticError;
      expect(diagnostic.detail).toMatchObject({ buffer: 1 });
    }
  });

  it('abandon drops the ledger without issuing GL calls', () => {
    const { mock, pool } = setup();
    pool.track('buffer', {}, 4096, 'a');
    pool.track('vertexArray', {}, 0, 'v');

    pool.abandon();

    // After context loss the objects are already gone; calling the deleters would
    // be noise, and a restore must start from a clean ledger.
    expect(pool.liveCount).toBe(0);
    expect(pool.bytes).toBe(0);
    expect(pool.snapshot().counts.buffer).toBe(0);
    expect(mock.deleted['buffer']).toBeUndefined();
    expect(mock.calls.some((call) => call.name.startsWith('delete'))).toBe(false);
  });
});
