import type { Program } from '../renderer/Program';
import type { Diagnostics } from './Diagnostics';
import { type DrawCall, isMergeable } from './DrawCall';
import type { IdRange } from './IdSpace';

/** One GL draw, and what went into it. */
export interface DrawGroup {
  readonly program: Program;
  readonly vao: WebGLVertexArrayObject;
  readonly mode: number;
  readonly vertexCount: number;
  readonly instanceCount: number;
  /** How many descriptors merged into this group. `1` means no merging happened. */
  readonly descriptors: number;
  /**
   * Span of the ids drawn, as a **bound** rather than a claim.
   *
   * It is the union of the merged descriptors' ranges. Because ids are handed out
   * in allocation order and instances are laid out in draw order, the two orders
   * are unrelated (C1 rule 6), so the union can contain ids that this group does
   * not actually draw. It is sized for allocating a readback window; the
   * per-point truth is the per-instance `aId` attribute.
   */
  readonly idRange: IdRange;
  /** GL calls this group cost. `0` when the group could not be placed at all. */
  readonly glCalls: number;
}

interface MutableDrawGroup extends DrawGroup {
  program: Program;
  vao: WebGLVertexArrayObject;
  mode: number;
  vertexCount: number;
  instanceCount: number;
  descriptors: number;
  idRange: { first: number; count: number };
  glCalls: number;
}

const CAPACITY_GROWTH = 1.5;

/**
 * Collects a frame's {@link DrawCall}s and issues as few GL draws as possible.
 *
 * ## Merging is adjacency-only, on purpose
 *
 * Descriptors merge when {@link isMergeable} says they may **and** their instance
 * ranges abut. Adjacency is not an optimisation shortcut, it is a correctness
 * requirement: merging preserves painter's order only when nothing was drawn in
 * between. Two equal-key groups separated by a different program must stay two
 * calls, or the separated primitives lose their z-order.
 *
 * ## One region per flush
 *
 * C2 rule 7 is explicit that a descriptor does not say *where* to draw — viewport
 * and scissor belong to the layout layer. The invariant that makes this safe is
 * that a `DrawList` is flushed within a single layout region. M1-c's `Layout`
 * will hold one list per region, or flush between regions; a list that spans a
 * scissor change would merge across it and draw the second chart's geometry into
 * the first chart's viewport.
 *
 * ## Allocation
 *
 * `add` and `flush` are allocation-free after warm-up: the descriptor array
 * grows by 1.5× like every other buffer here, and group records are pooled and
 * mutated in place. Both are on the frame path, so both are covered by the
 * per-frame allocation gate.
 */
export class DrawList {
  readonly #diagnostics: Diagnostics;
  #calls: DrawCall[];
  #size = 0;
  #groups: MutableDrawGroup[] = [];
  #groupCount = 0;
  #glCalls = 0;

  constructor(diagnostics: Diagnostics, capacity = 32) {
    this.#diagnostics = diagnostics;
    this.#calls = new Array<DrawCall>(Math.max(1, Math.floor(capacity)));
  }

  /** Descriptors currently queued. */
  get size(): number {
    return this.#size;
  }

  /** Descriptors the queue can hold before it reallocates. */
  get capacity(): number {
    return this.#calls.length;
  }

  /** GL calls issued by the last `flush`. */
  get glCalls(): number {
    return this.#glCalls;
  }

  /** Groups produced by the last `flush`. */
  get groupCount(): number {
    return this.#groupCount;
  }

  /** Group `index` from the last `flush`. Allocation-free. */
  groupAt(index: number): DrawGroup | undefined {
    return this.#groups[index];
  }

  /**
   * Queue a descriptor.
   *
   * The reference is stored as-is: the producer owns the descriptor and may be
   * mutating it right up until this call, but must not touch it again until the
   * list is cleared. That is what lets a producer hold exactly one descriptor
   * for its whole lifetime.
   */
  add(call: DrawCall): void {
    if (this.#size === this.#calls.length) this.#grow(this.#size + 1);
    this.#calls[this.#size] = call;
    this.#size += 1;
  }

  /** Drop every queued descriptor. Called once per frame, before collecting. */
  clear(): void {
    // Only the reference count is reset; the slots are overwritten on the next
    // `add`. Clearing the array itself would be an O(n) write per frame for no
    // observable difference.
    this.#size = 0;
    this.#groupCount = 0;
    this.#glCalls = 0;
  }

  /**
   * Issue the merged draws.
   *
   * @returns the number of GL draw calls actually made. Returning a count rather
   *   than `void` is what keeps `stats().drawCalls` a measurement of GPU work
   *   instead of a count of registered layers, so an empty chart costs zero.
   */
  flush(gl: WebGL2RenderingContext): number {
    const calls = this.#calls;
    const count = this.#size;
    this.#groupCount = 0;
    this.#glCalls = 0;

    let bound: WebGLVertexArrayObject | null = null;
    let index = 0;

    while (index < count) {
      const first = calls[index];
      if (first === undefined) {
        index += 1;
        continue;
      }

      let instances = first.instanceCount;
      let expected = first.instanceFirst + instances;
      let merged = 1;

      // Fold the id span as we go. Ranges of length 0 (an entity that was
      // degraded out of the id space entirely) must not drag the span to 0.
      let idFirst = first.idRange.count > 0 ? first.idRange.first : Number.POSITIVE_INFINITY;
      let idEnd = first.idRange.count > 0 ? first.idRange.first + first.idRange.count : 0;

      while (index + merged < count) {
        const next = calls[index + merged];
        if (next === undefined || next.instanceFirst !== expected || !isMergeable(first, next)) {
          break;
        }
        instances += next.instanceCount;
        expected += next.instanceCount;
        if (next.idRange.count > 0) {
          if (next.idRange.first < idFirst) idFirst = next.idRange.first;
          const end = next.idRange.first + next.idRange.count;
          if (end > idEnd) idEnd = end;
        }
        merged += 1;
      }

      if (instances > 0 && first.instanceFirst === 0) {
        if (bound !== first.vao) {
          gl.bindVertexArray(first.vao);
          bound = first.vao;
        }
        // The program must be current *before* the uniforms are written: a
        // uniform's value lives in the program object currently in use, so
        // setting it earlier writes to whatever was current.
        first.program.use();
        first.uniforms.write(first.program);
        gl.drawArraysInstanced(first.mode, 0, first.vertexCount, instances);
        this.#glCalls += 1;
        this.#record(first, instances, merged, 1, idFirst, idEnd);
      } else if (instances > 0) {
        // WebGL2 has no `baseInstance`, so a run that does not start at instance
        // 0 cannot be drawn. Drawing it anyway would render another entity's
        // instances — wrong pixels, silently. Skipping it loses a line and says
        // so. Losing a line is the recoverable failure of the two.
        this.#diagnostics.report(
          'draw/instance-offset-unsupported',
          `a draw call covering instances [${String(first.instanceFirst)}, ${String(expected)}) was skipped: WebGL2 cannot draw an instance range that does not start at 0`,
          {
            instanceFirst: first.instanceFirst,
            instanceCount: instances,
            mergedDescriptors: merged,
            program: first.program.name,
          },
        );
        this.#record(first, instances, merged, 0, idFirst, idEnd);
      } else {
        this.#record(first, 0, merged, 0, idFirst, idEnd);
      }

      index += merged;
    }

    gl.bindVertexArray(null);
    return this.#glCalls;
  }

  #record(
    first: DrawCall,
    instances: number,
    descriptors: number,
    glCalls: number,
    idFirst: number,
    idEnd: number,
  ): void {
    let group = this.#groups[this.#groupCount];
    if (group === undefined) {
      group = {
        program: first.program,
        vao: first.vao,
        mode: first.mode,
        vertexCount: first.vertexCount,
        instanceCount: 0,
        descriptors: 0,
        glCalls: 0,
        idRange: { first: 0, count: 0 },
      };
      this.#groups[this.#groupCount] = group;
    }
    group.program = first.program;
    group.vao = first.vao;
    group.mode = first.mode;
    group.vertexCount = first.vertexCount;
    group.instanceCount = instances;
    group.descriptors = descriptors;
    group.glCalls = glCalls;
    const empty = idFirst === Number.POSITIVE_INFINITY;
    group.idRange.first = empty ? 0 : idFirst;
    group.idRange.count = empty ? 0 : idEnd - idFirst;
    this.#groupCount += 1;
  }

  #grow(required: number): void {
    let capacity = this.#calls.length;
    while (capacity < required) capacity = Math.ceil(capacity * CAPACITY_GROWTH) + 1;
    const next = new Array<DrawCall>(capacity);
    for (let i = 0; i < this.#size; i += 1) next[i] = this.#calls[i] as DrawCall;
    this.#calls = next;
  }
}
