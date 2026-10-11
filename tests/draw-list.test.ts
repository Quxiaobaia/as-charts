import { describe, expect, it } from 'vitest';

import { Diagnostics } from '../src/core/Diagnostics';
import { MutableDrawCall, isMergeable } from '../src/core/DrawCall';
import { DrawList } from '../src/core/DrawList';
import type { Program } from '../src/renderer/Program';
import { ALL_EXTENSIONS, createMockGL } from './utils/mock-gl';

/**
 * The draw-call merge gate — contract C2 rules 2 and 6.
 *
 * `api-stability.md` promises: "相同 `(program key, 属性布局, 缓冲)` 的描述符必须能被
 * 合并成一次 draw call"，以及门禁「8 系列合并后仍为 1 次；空图层为 0 次」。This suite
 * asserts the merge itself, the boundaries where merging must *not* happen, and the
 * one platform constraint that shapes the whole design.
 */

interface Harness {
  readonly list: DrawList;
  readonly mock: ReturnType<typeof createMockGL>;
  readonly diagnostics: Diagnostics;
  readonly codes: string[];
  readonly program: Program;
  readonly otherProgram: Program;
  /**
   * One uniform writer shared by every descriptor, which is what a real layer
   * does: C2 puts the persistent state with the producer, and `isMergeable`
   * compares this field by identity. Giving each descriptor its own writer — the
   * obvious mistake in a test — makes merging silently stop happening, which is
   * why the "different uniform writer" case below is asserted separately.
   */
  readonly uniforms: { write: (program: Program) => void };
  readonly pointSource: MutableDrawCall['pointSource'];
}

function harness(capacity = 32): Harness {
  const mock = createMockGL({ extensions: ALL_EXTENSIONS });
  const diagnostics = new Diagnostics('silent');
  const codes: string[] = [];
  diagnostics.on((event) => codes.push(event.code));
  const list = new DrawList(diagnostics, capacity);

  const program = {
    name: 'as-charts/line.vertex.attribute',
    key: 'a',
    use: (): void => undefined,
  } as unknown as Program;
  const otherProgram = {
    name: 'as-charts/line.vertex.texture',
    key: 'b',
    use: (): void => undefined,
  } as unknown as Program;

  const uniforms = { write: (): void => undefined };
  const pointSource = new MutableDrawCall().pointSource;

  return { list, mock, diagnostics, codes, program, otherProgram, uniforms, pointSource };
}

/**
 * Build a descriptor sharing one VAO, one uniform writer and one point source.
 *
 * Sharing is the point: C2 puts the persistent state with the producer, so a
 * series' descriptor is one long-lived object pointed at the layer's buffers.
 */
function descriptor(
  h: Harness,
  vao: WebGLVertexArrayObject,
  first: number,
  count: number,
  overrides: Partial<MutableDrawCall> = {},
): MutableDrawCall {
  const call = new MutableDrawCall();
  call.program = h.program;
  call.vao = vao;
  call.mode = 0x0005;
  call.vertexCount = 4;
  call.instanceFirst = first;
  call.instanceCount = count;
  call.uniforms = h.uniforms;
  call.pointSource = h.pointSource;
  call.idRange = { first: first + 1, count };
  Object.assign(call, overrides);
  return call;
}

describe('DrawList · merging', () => {
  it('merges eight adjacent descriptors into one instanced call', () => {
    const h = harness();
    const vao = h.mock.gl.createVertexArray();
    // Eight series, 40 segments each, laid out back to back in one buffer.
    for (let series = 0; series < 8; series += 1) {
      h.list.add(descriptor(h, vao, series * 40, 40));
    }

    h.mock.draws.length = 0;
    const calls = h.list.flush(h.mock.gl);

    expect(calls).toBe(1);
    expect(h.mock.draws).toEqual([320]);
    expect(h.list.groupCount).toBe(1);
    expect(h.list.groupAt(0)?.descriptors).toBe(8);
  });

  it('treats an empty layer as zero calls and still merges across it', () => {
    const h = harness();
    const vao = h.mock.gl.createVertexArray();
    h.list.add(descriptor(h, vao, 0, 0));
    h.list.add(descriptor(h, vao, 0, 4));

    h.mock.draws.length = 0;
    const calls = h.list.flush(h.mock.gl);

    // The empty descriptor contributes no instances and does not break the run,
    // because its range still starts where the next one does.
    expect(calls).toBe(1);
    expect(h.mock.draws).toEqual([4]);
    expect(h.list.groupAt(0)?.descriptors).toBe(2);
  });

  it('draws nothing at all for a list of empty descriptors', () => {
    const h = harness();
    const vao = h.mock.gl.createVertexArray();
    h.list.add(descriptor(h, vao, 0, 0));
    h.mock.draws.length = 0;
    expect(h.list.flush(h.mock.gl)).toBe(0);
    expect(h.mock.draws).toEqual([]);
    expect(h.list.groupCount).toBe(1);
    expect(h.list.groupAt(0)?.glCalls).toBe(0);
  });

  it('refuses to merge across a different program', () => {
    const h = harness();
    const vao = h.mock.gl.createVertexArray();
    h.list.add(descriptor(h, vao, 0, 10));
    h.list.add(descriptor(h, vao, 10, 10, { program: h.otherProgram }));

    h.mock.draws.length = 0;
    const calls = h.list.flush(h.mock.gl);

    // Two groups, but the second starts at instance 10 and WebGL2 cannot offset
    // instances — so it is skipped with a diagnostic rather than drawn wrongly.
    expect(calls).toBe(1);
    expect(h.mock.draws).toEqual([10]);
    expect(h.list.groupCount).toBe(2);
    expect(h.codes).toContain('draw/instance-offset-unsupported');
  });

  it('refuses to merge across a different VAO, and reports the second as unplaceable', () => {
    const h = harness();
    const a = h.mock.gl.createVertexArray();
    const b = h.mock.gl.createVertexArray();
    h.list.add(descriptor(h, a, 0, 4));
    h.list.add(descriptor(h, b, 4, 4));

    expect(h.list.flush(h.mock.gl)).toBe(1);
    expect(h.codes).toContain('draw/instance-offset-unsupported');
  });

  it('refuses to merge across a different uniform writer', () => {
    const h = harness();
    const vao = h.mock.gl.createVertexArray();
    h.list.add(descriptor(h, vao, 0, 4));
    h.list.add(descriptor(h, vao, 4, 4, { uniforms: { write: (): void => undefined } }));
    expect(
      isMergeable(
        // Two equal descriptors with distinct writers are not mergeable by identity.
        descriptor(h, vao, 0, 4),
        descriptor(h, vao, 4, 4, { uniforms: { write: (): void => undefined } }),
      ),
    ).toBe(false);
    expect(h.list.flush(h.mock.gl)).toBe(1);
  });

  it('refuses to merge across a different point source, even of the same kind', () => {
    const h = harness();
    const vao = h.mock.gl.createVertexArray();
    // The documented split is `attribute` versus `texture`. The comparison is by
    // identity, so two `attribute` sources holding *different* buffers also split
    // the draw — which is required, not incidental: attribute location 1 reads
    // whichever buffer the VAO captured, and a merged run cannot switch buffers
    // partway through.
    const other = new MutableDrawCall().pointSource;
    other.setAttribute(h.mock.gl.createBuffer());
    expect(other.kind).toBe(h.pointSource.kind);
    expect(
      isMergeable(descriptor(h, vao, 0, 4), descriptor(h, vao, 4, 4, { pointSource: other })),
    ).toBe(false);

    h.list.add(descriptor(h, vao, 0, 4));
    h.list.add(descriptor(h, vao, 4, 4, { pointSource: other }));
    expect(h.list.flush(h.mock.gl)).toBe(1);
    expect(h.codes).toContain('draw/instance-offset-unsupported');
  });

  it('does not merge non-adjacent descriptors, because z-order would change', () => {
    const h = harness();
    const vao = h.mock.gl.createVertexArray();
    h.list.add(descriptor(h, vao, 0, 10));
    h.list.add(descriptor(h, vao, 10, 10, { program: h.otherProgram }));
    h.list.add(descriptor(h, vao, 20, 10));

    h.mock.draws.length = 0;
    h.list.flush(h.mock.gl);

    // The first and third descriptors are mergeable with each other but are not
    // adjacent, so merging them would draw the third one underneath the second.
    expect(h.list.groupCount).toBe(3);
    expect(h.list.groupAt(0)?.descriptors).toBe(1);
    expect(h.list.groupAt(2)?.descriptors).toBe(1);
  });

  it('will not merge a gap in the instance ranges', () => {
    const h = harness();
    const vao = h.mock.gl.createVertexArray();
    h.list.add(descriptor(h, vao, 0, 10));
    h.list.add(descriptor(h, vao, 20, 10));

    h.list.flush(h.mock.gl);
    expect(h.list.groupCount).toBe(2);
    expect(h.list.groupAt(0)?.instanceCount).toBe(10);
    expect(h.codes).toContain('draw/instance-offset-unsupported');
  });
});

describe('DrawList · ids and spans', () => {
  it('reports the union of the merged id ranges as a bound', () => {
    const h = harness();
    const vao = h.mock.gl.createVertexArray();
    // Ids are allocated in draw order here, but C1 rule 6 says the two orders are
    // unrelated — this asserts the span, not a claim about every id inside it.
    h.list.add(descriptor(h, vao, 0, 30, { idRange: { first: 100, count: 30 } }));
    h.list.add(descriptor(h, vao, 30, 30, { idRange: { first: 130, count: 30 } }));
    h.list.flush(h.mock.gl);

    expect(h.list.groupAt(0)?.idRange).toEqual({ first: 100, count: 60 });
  });

  it('ignores a zero-count id range when computing the span', () => {
    const h = harness();
    const vao = h.mock.gl.createVertexArray();
    h.list.add(descriptor(h, vao, 0, 0, { idRange: { first: 0, count: 0 } }));
    h.list.add(descriptor(h, vao, 0, 4, { idRange: { first: 7, count: 4 } }));
    h.list.flush(h.mock.gl);
    expect(h.list.groupAt(0)?.idRange).toEqual({ first: 7, count: 4 });
  });

  it('reports an empty span when nothing drawn claimed any ids', () => {
    const h = harness();
    const vao = h.mock.gl.createVertexArray();
    h.list.add(descriptor(h, vao, 0, 4, { idRange: { first: 0, count: 0 } }));
    h.list.flush(h.mock.gl);
    expect(h.list.groupAt(0)?.idRange).toEqual({ first: 0, count: 0 });
  });
});

describe('DrawList · lifecycle', () => {
  it('clears queued descriptors without reallocating them', () => {
    const h = harness();
    const vao = h.mock.gl.createVertexArray();
    const call = descriptor(h, vao, 0, 4);
    h.list.add(call);
    expect(h.list.size).toBe(1);

    h.list.clear();
    expect(h.list.size).toBe(0);
    expect(h.list.groupCount).toBe(0);
    expect(h.list.glCalls).toBe(0);
    expect(h.list.capacity).toBe(32);
  });

  it('grows past its initial capacity instead of dropping descriptors', () => {
    const h = harness(2);
    const vao = h.mock.gl.createVertexArray();
    for (let i = 0; i < 40; i += 1) h.list.add(descriptor(h, vao, i, 1));

    expect(h.list.size).toBe(40);
    expect(h.list.capacity).toBeGreaterThanOrEqual(40);
    expect(h.list.flush(h.mock.gl)).toBe(1);
    expect(h.mock.draws).toEqual([40]);
  });

  it('binds one VAO per group and unbinds at the end', () => {
    const h = harness();
    const vao = h.mock.gl.createVertexArray();
    h.list.add(descriptor(h, vao, 0, 4));
    h.mock.calls.length = 0;
    h.list.flush(h.mock.gl);

    const binds = h.mock.calls.filter((call) => call.name === 'bindVertexArray');
    expect(binds).toHaveLength(2);
    expect(binds[1]?.args[0]).toBeNull();
  });

  it('uses the program before writing its uniforms', () => {
    const h = harness();
    const vao = h.mock.gl.createVertexArray();
    const order: string[] = [];
    const call = descriptor(h, vao, 0, 4);
    call.program = {
      name: 'ordered',
      key: 'o',
      use: (): void => {
        order.push('use');
      },
    } as unknown as Program;
    call.uniforms = {
      write: (): void => {
        order.push('write');
      },
    };
    h.list.add(call);
    h.list.flush(h.mock.gl);

    // A uniform's value lives in the program currently in use, so writing before
    // `use()` would set the value on whatever program happened to be current.
    expect(order).toEqual(['use', 'write']);
  });
});
