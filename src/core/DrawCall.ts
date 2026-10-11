import type { Program } from '../renderer/Program';
import type { IdRange } from './IdSpace';

/**
 * The scene → renderer seam — contract **C2**.
 *
 * A `DrawCall` is the *minimum complete description of one GL draw*: which
 * program, which vertex array (which captures both the attribute layout and the
 * buffer bindings), how many instances, which uniform values, which ids, and how
 * point data is fetched.
 *
 * ## The one field the two data channels may differ in
 *
 * `pointSource` is the whole of it. Everything else — program, layout, mode,
 * uniform writer, id handling — must be identical between the `attribute` and
 * `texture` channels, which is what makes "the two channels render the same
 * pixels" assertable instead of aspirational. See `core/shader/line.ts` for the
 * shader-side half of the same arrangement.
 *
 * ## Descriptors are per-frame objects, owned by the producer
 *
 * Rule 3: a descriptor is short-lived and must not be allocated on the hot path.
 * C2 also puts the persistent state with the `Series`, which settles where the
 * pool lives: **the producer owns and reuses one descriptor** and calls
 * `DrawList.add()` with it. There is deliberately no `DrawList.begin()` handing
 * out pooled slots — two ways to obtain a descriptor is two ways to get the
 * ownership wrong.
 *
 * ## Colour and id must be per-instance attributes
 *
 * Rule 6, and it is the reason this design can hit a 32-call dashboard budget at
 * all. If a series' colour or its id base lives in a uniform, eight series need
 * eight draws, because a uniform cannot vary within one `drawArraysInstanced`.
 * Both are per-instance attributes in the line pipeline, and
 * `tests/line-shader.test.ts` asserts the composed source declares no
 * colour or id uniform.
 *
 * ## The `instanceFirst` constraint, and why it is not a detail
 *
 * Contract rule 5 lets a descriptor reference a `srcIndex` map, and rule 4 gives
 * it an id range, both of which imply descriptors can describe *a slice* of a
 * shared instance buffer. They can — but GL cannot draw an arbitrary slice:
 * **WebGL2 has no `baseInstance`.** `drawArraysInstanced` always starts at
 * instance 0, and `WEBGL_multi_draw` does not help because
 * `multiDrawArraysInstancedWEBGL` has no per-draw instance offset either.
 *
 * So a merged run is only drawable when it starts at instance 0. `DrawList`
 * therefore *verifies* the invariant and reports `draw/instance-offset-unsupported`
 * when a descriptor cannot be placed, rather than issuing a draw that would
 * quietly render somebody else's instances. `instanceFirst` exists so that this
 * is checkable at all; the supported pattern (every VAO's descriptors
 * partitioning `[0, N)` in z-order) never triggers the report.
 */
export type PointSourceKind = 'attribute' | 'texture';

/**
 * How a primitive obtains its point positions.
 *
 * A flat, mutable interface rather than a discriminated union on purpose: C2
 * rule 3 forbids per-frame allocation, and `{ kind: 'texture', … }` is a fresh
 * object every frame. Producers keep one instance of this and mutate it.
 */
export interface PointSource {
  readonly kind: PointSourceKind;
  /**
   * Attribute channel: the instance buffer whose per-instance payload the draw
   * reads. The line pipeline puts segment endpoints there; the triangle pipeline
   * puts triangle placements there. Either way it is "the data the attributes
   * are indexed from", which is what the descriptor has to identify.
   */
  readonly instanceBuffer: WebGLBuffer | null;
  /** Texture channel: the float texture holding the points. */
  readonly texture: WebGLTexture | null;
  /** Texture channel: texels per row, so a flat index decomposes to `(x, y)`. */
  readonly texelsPerRow: number;
}

/**
 * Applies a program's uniform values.
 *
 * A writer object rather than a value bag, because the set of uniforms is
 * program-specific and the values have to reach GL through `Program`'s cached
 * locations. Implementations are owned by the producer and must not allocate
 * inside `write()`.
 */
export interface UniformWriter {
  write(program: Program): void;
}

export interface DrawCall {
  /**
   * The program to bind.
   *
   * Rule 1 calls this the "program key". The object is carried instead, because
   * the draw needs `use()` and the uniform setters anyway, and `program.key`
   * remains available as the canonical identity. `ProgramCache` hands out one
   * `Program` per key, so reference equality is exactly key equality — which is
   * what both {@link isMergeable} and the cache's own refcounting rely on.
   */
  readonly program: Program;
  /**
   * Vertex array object.
   *
   * A VAO captures the attribute layout *and* the buffer bindings, so comparing
   * VAO identity is comparing precisely what C2 rule 6 names as the merge
   * condition. There is no separate "attribute layout" field because a second
   * copy of the same information is a second thing that can disagree.
   */
  readonly vao: WebGLVertexArrayObject;
  /** GL primitive, e.g. `gl.TRIANGLE_STRIP`. */
  readonly mode: number;
  /** Vertices per instance, e.g. 4 for the segment quad. */
  readonly vertexCount: number;
  /** First instance covered by this descriptor. Must be 0 to be drawable — see above. */
  readonly instanceFirst: number;
  readonly instanceCount: number;
  readonly pointSource: PointSource;
  readonly uniforms: UniformWriter;
  /** The ids this descriptor's instances answer to (C1). */
  readonly idRange: IdRange;
  /**
   * Maps a decimated point back to its source sample (rule 5), or `null` when
   * the geometry is undecimated.
   *
   * Without it, picking on decimated geometry returns the wrong point — and the
   * bug is invisible in development, because small datasets are never decimated.
   */
  readonly srcIndex: Uint32Array | null;
}

/** A mutable {@link PointSource}. Producers keep one and reuse it. */
export class MutablePointSource implements PointSource {
  kind: PointSourceKind = 'attribute';
  instanceBuffer: WebGLBuffer | null = null;
  texture: WebGLTexture | null = null;
  texelsPerRow = 0;

  setAttribute(instanceBuffer: WebGLBuffer | null): void {
    this.kind = 'attribute';
    this.instanceBuffer = instanceBuffer;
    this.texture = null;
    this.texelsPerRow = 0;
  }

  setTexture(texture: WebGLTexture | null, texelsPerRow: number): void {
    this.kind = 'texture';
    this.texture = texture;
    this.instanceBuffer = null;
    this.texelsPerRow = Math.max(1, Math.floor(texelsPerRow));
  }
}

/**
 * A mutable {@link DrawCall}, reused across frames by its producer.
 *
 * `pointSource` is settable so that every descriptor a producer emits can point
 * at **one shared** instance. That sharing is not an optimisation: {@link
 * isMergeable} compares the field by identity, so descriptors that each owned a
 * private copy would never merge and the batching this whole contract exists for
 * would silently stop happening.
 *
 * `idRange` is the one nested object that cannot be flattened without making the
 * C1 type meaningless; producers assign it when the range is claimed and not per
 * frame, so it is not a per-frame allocation either.
 */
export class MutableDrawCall implements DrawCall {
  program!: Program;
  vao!: WebGLVertexArrayObject;
  mode = 0;
  vertexCount = 0;
  instanceFirst = 0;
  instanceCount = 0;
  pointSource: MutablePointSource = new MutablePointSource();
  uniforms!: UniformWriter;
  idRange: IdRange = { first: 0, count: 0 };
  srcIndex: Uint32Array | null = null;
}

/**
 * Whether two descriptors may become one GL draw.
 *
 * The fields compared here *are* the mergeability information C2 rule 6 asks the
 * descriptor to carry, compared structurally instead of through an opaque
 * producer-supplied key: a key is a claim, and a claim can be wrong. Everything
 * a merged draw loses the ability to vary has to be in this list —
 * `instanceFirst` is not, because merging only ever extends a run whose start
 * was already fixed by the first descriptor.
 */
export function isMergeable(a: DrawCall, b: DrawCall): boolean {
  return (
    a.program === b.program &&
    a.vao === b.vao &&
    a.mode === b.mode &&
    a.vertexCount === b.vertexCount &&
    a.uniforms === b.uniforms &&
    a.pointSource === b.pointSource
  );
}
