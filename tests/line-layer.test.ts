import { describe, expect, it } from 'vitest';

import { Diagnostics } from '../src/core/Diagnostics';
import { DrawList } from '../src/core/DrawList';
import { IdSpace } from '../src/core/IdSpace';
import { ResourcePool } from '../src/core/ResourcePool';
import { orthographicTransform } from '../src/core/transform';
import { LineLayer, type LineLayerOptions } from '../src/layers/LineLayer';
import type { Program } from '../src/renderer/Program';
import { ALL_EXTENSIONS, createMockGL, MOCK_GL_CONSTANTS, type MockGL } from './utils/mock-gl';

/**
 * The line pipeline's behaviour, in both data channels.
 *
 * Three acceptance criteria from `自研图表库_M0_M1实施设计` §6.4 live here in their
 * structural half: one draw call for a single series (item 3's mechanism), one
 * draw call for eight merged series (the M1-b gate), and a zoom that changes only
 * a uniform (item 3). The *pixel* halves — constant stroke width under zoom, and
 * the two channels being pixel-identical — need a real GPU and are in
 * `tests/e2e/line.ts`.
 */

/**
 * Instance bytes per segment, from the interleaved layouts in `LineLayer`.
 *
 * `attribute`: vec4 endpoints (16) + vec3 colour (12) + float width (4) + uint id (4).
 * `texture`:   uint index (4) + vec3 colour (12) + float width (4) + uint id (4).
 *
 * Asserting the totals rather than the field offsets keeps a layout change visible
 * without making the test a second copy of the layout.
 */
const SEGMENT_BYTES = { attribute: 36, texture: 24 } as const;

interface Harness {
  readonly layer: LineLayer;
  readonly mock: MockGL;
  readonly list: DrawList;
  readonly program: Program;
  readonly codes: string[];
  readonly pool: ResourcePool;
  readonly ids: IdSpace;
}

interface HarnessConfig {
  readonly idCapacity?: number;
  /** Overrides `MAX_TEXTURE_SIZE`, to drive the texture-capacity path. */
  readonly maxTextureSize?: number;
}

function harness(options: LineLayerOptions = {}, config: HarnessConfig = {}): Harness {
  const mock = createMockGL({
    extensions: ALL_EXTENSIONS,
    parameters:
      config.maxTextureSize === undefined
        ? {}
        : { [MOCK_GL_CONSTANTS.MAX_TEXTURE_SIZE]: config.maxTextureSize },
  });
  const pool = new ResourcePool(mock.gl);
  const diagnostics = new Diagnostics('silent');
  const codes: string[] = [];
  diagnostics.on((event) => codes.push(event.code));
  const ids =
    config.idCapacity === undefined
      ? new IdSpace(diagnostics)
      : new IdSpace(diagnostics, config.idCapacity);
  const layer = new LineLayer(mock.gl, pool, { ids, diagnostics }, options);
  const list = new DrawList(diagnostics, 64);

  // A `Program` stand-in that forwards the uniform writes the line pipeline makes
  // into the mock, so "a zoom moved a uniform" is observable. Compiling real GLSL
  // here would test `Program` instead of the layer.
  const program = {
    name: 'as-charts/line.test',
    key: 'test',
    use: (): void => undefined,
    setMat4: (_name: string, value: Float32Array | number[]): void => {
      mock.gl.uniformMatrix4fv(null, false, value);
    },
    setVec2: (_name: string, x: number, y: number): void => {
      mock.gl.uniform2f(null, x, y);
    },
    setInt: (_name: string, _value: number): void => undefined,
  } as unknown as Program;

  return { layer, mock, list, program, codes, pool, ids };
}

/** Upload, collect and flush — one frame, without the renderer. */
function frame(h: Harness, width = 256, height = 128): number {
  h.list.clear();
  h.layer.upload();
  h.layer.collect(h.list, h.program, width, height);
  return h.list.flush(h.mock.gl);
}

/** Build a straight ramp of `count` finite points. */
function ramp(count: number): { x: Float64Array; y: Float64Array } {
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    x[i] = i;
    y[i] = i % 7;
  }
  return { x, y };
}

/** Bytes the layer last pushed to the instance buffer. */
function uploadedBytes(h: Harness): number {
  const upload = [...h.mock.calls].reverse().find((call) => call.name === 'bufferSubData');
  return typeof upload?.args[2] === 'number' ? upload.args[2] : 0;
}

/** The instance payload the layer last pushed, as a raw view. */
function uploadedPayload(h: Harness): Uint8Array {
  const upload = [...h.mock.calls].reverse().find((call) => call.name === 'bufferSubData');
  const view = upload?.args[3] as ArrayBufferView | undefined;
  if (view === undefined) throw new Error('no instance upload was recorded');
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/**
 * The uploaded instance payload, read as 32-bit words.
 *
 * Both layouts interleave `float` and `uint` fields in one 32-bit stream, so the
 * same bytes have to be viewed two ways: {@link uploadedFloats} for endpoints and
 * style, {@link uploadedWords} for the fields that are genuinely integers (the
 * pick id and, in the texture channel, the flat texel index).
 */
function uploadedWords(h: Harness): Uint32Array {
  const payload = uploadedPayload(h);
  return new Uint32Array(payload.buffer, payload.byteOffset, payload.byteLength / 4);
}

/** The same bytes as floats. Reading an id through this view reinterprets bits. */
function uploadedFloats(h: Harness): Float32Array {
  const payload = uploadedPayload(h);
  return new Float32Array(payload.buffer, payload.byteOffset, payload.byteLength / 4);
}

describe('LineLayer · segments', () => {
  it('draws one segment per adjacent finite pair, in one strip draw', () => {
    const h = harness({ initialSegments: 128 });
    h.layer.addSeries(ramp(100));
    expect(frame(h)).toBe(1);

    const stats = h.layer.seriesStats(0);
    expect(stats?.count).toBe(100);
    expect(stats?.segmentCount).toBe(99);

    const draw = h.mock.calls.find((call) => call.name === 'drawArraysInstanced');
    expect(draw?.args).toEqual([h.mock.gl.TRIANGLE_STRIP, 0, 4, 99]);
  });

  it('does not span a non-finite gap, and drops the samples rather than clamping them', () => {
    const h = harness();
    const x = Float64Array.from([0, 1, 2, 3, 4, 5]);
    const y = Float64Array.from([1, 2, NaN, 4, Infinity, 6]);
    h.layer.addSeries({ x, y });
    frame(h);

    // Usable pairs: (0,1) only — (1,2) has a NaN, (3,4) has an infinity, (4,5) too.
    // Points 3 and 5 have no usable neighbour on either side, so each becomes its
    // own degenerate segment rather than disappearing. A clamped sample would have
    // piled screen-off data onto the edge column instead.
    expect(h.layer.seriesStats(0)?.segmentCount).toBe(3);

    // Endpoints live at `segment * 9` as `[ax, ay, bx, by]`. Segment 0 is the real
    // pair; segments 1 and 2 are the isolated points, where `A == B` is exactly
    // what the shader's along-axis term turns into a square.
    const floats = uploadedFloats(h);
    expect(Array.from(floats.subarray(0, 4))).toEqual([0, 1, 1, 2]);
    expect(Array.from(floats.subarray(9, 13))).toEqual([3, 4, 3, 4]);
    expect(Array.from(floats.subarray(18, 22))).toEqual([5, 6, 5, 6]);
  });

  it('renders an isolated finite point as a degenerate segment so it stays visible', () => {
    const h = harness();
    h.layer.addSeries({ x: Float64Array.from([5]), y: Float64Array.from([5]) });
    frame(h);

    expect(h.layer.seriesStats(0)?.segmentCount).toBe(1);
    const floats = uploadedFloats(h);
    // A == B is what makes the shader's along-axis term produce a square instead
    // of a zero-width bar. Both endpoints identical is the whole trigger.
    expect(Array.from(floats.subarray(0, 4))).toEqual([5, 5, 5, 5]);
  });

  it('produces exactly one segment for a two-point series', () => {
    const h = harness();
    h.layer.addSeries({ x: Float64Array.from([0, 1]), y: Float64Array.from([0, 1]) });
    frame(h);
    expect(h.layer.seriesStats(0)?.segmentCount).toBe(1);
  });

  it('draws nothing for an empty or single-undefined series', () => {
    const h = harness();
    h.layer.addSeries({ x: Float64Array.from([]), y: Float64Array.from([]) });
    h.layer.addSeries({ x: Float64Array.from([NaN]), y: Float64Array.from([NaN]) });
    expect(h.layer.seriesCount).toBe(2);
    expect(frame(h)).toBe(0);
    expect(h.mock.draws).toEqual([]);
  });

  it('honours an explicit count shorter than the arrays', () => {
    const h = harness();
    const { x, y } = ramp(100);
    h.layer.addSeries({ x, y, count: 10 });
    frame(h);
    expect(h.layer.seriesStats(0)?.count).toBe(10);
    expect(h.layer.seriesStats(0)?.segmentCount).toBe(9);
  });

  it('reports the instance layout in the bytes it uploads', () => {
    const attribute = harness();
    attribute.layer.addSeries(ramp(100));
    frame(attribute);
    expect(uploadedBytes(attribute)).toBe(99 * SEGMENT_BYTES.attribute);

    const texture = harness({ pointSource: 'texture' });
    texture.layer.addSeries(ramp(100));
    frame(texture);
    // The honest number: ~30 % less per frame, not the 50 % a naive
    // "two endpoints versus one index" count suggests, because colour, width and
    // id are per-instance in both channels.
    expect(uploadedBytes(texture)).toBe(99 * SEGMENT_BYTES.texture);
  });

  it('grows the instance buffer while writing, without losing the prefix', () => {
    const h = harness({ initialSegments: 4 });
    h.layer.addSeries(ramp(500));
    frame(h);
    expect(h.layer.capacity).toBeGreaterThanOrEqual(499);
    expect(h.layer.segmentCount).toBe(499);
    expect(h.layer.pointCount).toBe(500);
  });
});

describe('LineLayer · eight series, one draw call', () => {
  it('merges every series into a single instanced draw', () => {
    const h = harness({ initialSegments: 512 });
    for (let series = 0; series < 8; series += 1) {
      h.layer.addSeries({ ...ramp(64), color: [series / 8, 0.5, 1 - series / 8] });
    }
    expect(h.layer.seriesCount).toBe(8);

    const calls = frame(h);
    // Eight descriptors — one per series, each with its own id range — merged by
    // the DrawList because they share program, VAO, uniform writer and channel.
    expect(h.list.size).toBe(8);
    expect(calls).toBe(1);
    expect(h.mock.draws).toEqual([8 * 63]);
    expect(h.list.groupAt(0)?.descriptors).toBe(8);
  });

  it('merges three series that share one point source but not the same colour', () => {
    // The whole point of C2 rule 6: colour varies per instance, so three series
    // with three different colours are still one draw. The negative half — that a
    // differing channel or uniform writer *does* split the draw — belongs to
    // `tests/draw-list.test.ts`, because a real layer never emits one.
    const h = harness({ initialSegments: 64 });
    h.layer.addSeries({ ...ramp(4), color: [1, 0, 0] });
    h.layer.addSeries({ ...ramp(4), color: [0, 1, 0] });
    h.layer.addSeries({ ...ramp(4), color: [0, 0, 1] });

    expect(h.layer.pointSource).toBe('attribute');
    expect(frame(h)).toBe(1);
    expect(h.list.groupAt(0)?.descriptors).toBe(3);
    expect(h.mock.draws).toEqual([9]);
  });

  it('gives each series a disjoint contiguous id range', () => {
    const h = harness();
    for (let series = 0; series < 3; series += 1) h.layer.addSeries(ramp(10));
    frame(h);

    const ranges = [0, 1, 2].map((index) => h.layer.seriesStats(index));
    expect(ranges.map((stats) => stats?.idFirst)).toEqual([1, 11, 21]);
    expect(ranges.map((stats) => stats?.idCount)).toEqual([10, 10, 10]);
    // The merged group spans all of them, which is the bound the picker will size
    // its readback window against.
    expect(h.list.groupAt(0)?.idRange).toEqual({ first: 1, count: 30 });
  });

  it('degrades a series the id space cannot fit to series-level picking', () => {
    // Twelve ids: the first series claims ten, leaving a two-id run that the
    // second cannot fit into.
    const h = harness({}, { idCapacity: 12 });
    h.layer.addSeries(ramp(10));
    h.layer.addSeries(ramp(10));
    frame(h);

    expect(h.codes).toContain('picking/id-space-exhausted');
    const first = h.layer.seriesStats(0);
    const second = h.layer.seriesStats(1);
    expect(first?.idFirst).toBe(1);
    expect(first?.idCount).toBe(10);
    // Degraded, not wrapped: one id, and it is a real id — 0 would mean
    // "nothing here" and the series would become unpickable.
    expect(second?.idFirst).toBe(11);
    expect(second?.idCount).toBe(1);

    const words = uploadedWords(h);
    const ids: number[] = [];
    for (let segment = 0; segment < 18; segment += 1) ids.push(words[segment * 9 + 8] as number);

    // The series that got a real range picks per point…
    expect(ids.slice(0, 9)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    // …and the degraded one answers to a single id for every instance, which is
    // what keeps it from claiming ids the allocator never granted.
    expect(ids.slice(9)).toEqual(new Array<number>(9).fill(11));
  });

  it('returns a removed series id range to the pool', () => {
    const h = harness();
    h.layer.addSeries(ramp(10));
    h.layer.addSeries(ramp(10));
    expect(h.ids.live).toBe(20);
    expect(h.ids.free).toBe(h.ids.capacity - 20);

    expect(h.layer.removeSeries(0)).toBe(true);
    expect(h.ids.live).toBe(10);
    expect(h.layer.seriesCount).toBe(1);
    // The surviving series still draws, and still merges into one call.
    expect(frame(h)).toBe(1);
  });

  it('releases every id range on clear', () => {
    const h = harness();
    h.layer.addSeries(ramp(10));
    h.layer.addSeries(ramp(10));
    h.layer.clear();
    expect(h.ids.live).toBe(0);
    expect(frame(h)).toBe(0);
    expect(h.mock.draws).toEqual([]);
  });
});

describe('LineLayer · zoom is a uniform, never a rebuild', () => {
  it('does not touch geometry when the transform changes', () => {
    const h = harness();
    h.layer.addSeries(ramp(100));
    frame(h);
    expect(h.layer.uploadPending).toBe(false);

    const before = h.mock.counts['bufferSubData'] ?? 0;
    const matrix = orthographicTransform({ min: 0, max: 10 }, { min: -5, max: 5 });
    h.layer.setTransform(matrix);

    // This is the mechanism behind "stroke width is constant under zoom": the
    // endpoints stay in data space, so zooming moves a uniform and nothing else.
    expect(h.layer.uploadPending).toBe(false);
    frame(h);
    expect(h.mock.counts['bufferSubData']).toBe(before);

    const matrices = h.mock.calls.filter((call) => call.name === 'uniformMatrix4fv');
    expect(matrices.length).toBeGreaterThan(0);
    expect(matrices[matrices.length - 1]?.args[2]).toEqual(Array.from(matrix));
  });

  it('marks geometry dirty when a style changes, because colour is per-instance', () => {
    const h = harness();
    h.layer.addSeries(ramp(100));
    frame(h);
    const before = h.mock.counts['bufferSubData'] ?? 0;

    h.layer.setSeriesStyle(0, { color: [1, 0, 0], thickness: 3 });
    // The cost of batching (C2 rule 6): a colour change rewrites instance bytes
    // rather than poking a uniform. Restricting this to the affected span is
    // M1-d's incremental-upload work.
    expect(h.layer.uploadPending).toBe(true);
    frame(h);
    expect(h.mock.counts['bufferSubData'] ?? 0).toBeGreaterThan(before);

    const floats = uploadedFloats(h);
    expect(Array.from(floats.subarray(4, 8))).toEqual([1, 0, 0, 3]);
  });

  it('re-claims ids when a series is replaced', () => {
    const h = harness();
    h.layer.addSeries(ramp(10));
    expect(h.ids.live).toBe(10);
    h.layer.setSeriesData(0, ramp(30));
    // C1 rule 4 ties `idCount` to the point count, so the old grant is released
    // before the new one is claimed — never held alongside it.
    expect(h.ids.live).toBe(30);
    expect(h.ids.freeRangeCount).toBe(1);
    expect(h.layer.seriesStats(0)?.count).toBe(30);
  });

  it('stamps the viewport uniform from the frame, not from construction', () => {
    const h = harness();
    h.layer.addSeries(ramp(4));
    frame(h, 640, 480);
    const viewport = h.mock.calls.filter((call) => call.name === 'uniform2f').pop();
    expect(viewport?.args.slice(1)).toEqual([640, 480]);
  });
});

describe('LineLayer · the texture channel', () => {
  it('stores each point once, with the run start duplicated only for isolated points', () => {
    const h = harness({ pointSource: 'texture' });
    h.layer.addSeries(ramp(100));
    frame(h);

    // A clean 100-point run costs 100 texels and yields 99 segments: endpoint B of
    // one segment is endpoint A of the next, so no point is stored twice.
    expect(h.layer.texelCount).toBe(100);
    expect(h.layer.seriesStats(0)?.texelCount).toBe(100);
    expect(h.layer.seriesStats(0)?.segmentCount).toBe(99);
  });

  it('duplicates an isolated point so that it has a next texel', () => {
    const h = harness({ pointSource: 'texture' });
    h.layer.addSeries({ x: Float64Array.from([5]), y: Float64Array.from([5]) });
    frame(h);
    // `lineEndB()` reads `aPointIndex + 1`, so an isolated point must be followed
    // by a copy of itself or it would read a neighbouring run's first point.
    expect(h.layer.texelCount).toBe(2);
    expect(h.layer.seriesStats(0)?.segmentCount).toBe(1);
  });

  it('allocates a float texture and writes only the live region afterwards', () => {
    const h = harness({ pointSource: 'texture' });
    h.layer.addSeries(ramp(100));
    frame(h);

    const allocation = h.mock.textures[0];
    expect(allocation?.texels).toBeGreaterThanOrEqual(100);
    expect(allocation?.height).toBe(1);
    const image = h.mock.calls.find((call) => call.name === 'texImage2D');
    // `texImage2D(target, level, internalformat, width, height, border, format,
    // type, data, srcOffset)`: `RG32F` internal format with an `RG`/`FLOAT` source,
    // so two 32-bit floats per texel and no channel-packing arithmetic.
    expect(image?.args[2]).toBe(h.mock.gl.RG32F);
    expect(image?.args[6]).toBe(h.mock.gl.RG);
    expect(image?.args[7]).toBe(h.mock.gl.FLOAT);
    expect(image?.args[9]).toBe(0);

    // A rebuild after the storage exists must not re-specify the texture, or the
    // driver reallocates it on every frame the data changes.
    const allocations = h.mock.textures.length;
    h.layer.setSeriesStyle(0, { thickness: 2 });
    frame(h);
    expect(h.mock.textures.length).toBe(allocations);
    expect(h.mock.subImages.length).toBeGreaterThan(0);
    // The padded row is real bytes, so the upload carries the whole array rather
    // than a `subarray` — neither call may materialise a view per frame.
    expect(h.mock.calls.filter((call) => call.name === 'texSubImage2D')).toHaveLength(1);
  });

  it('carries the flat point index per instance', () => {
    const h = harness({ pointSource: 'texture' });
    h.layer.addSeries(ramp(4));
    h.layer.addSeries(ramp(4));
    frame(h);

    const words = uploadedWords(h);
    const indices: number[] = [];
    // Two 4-point series: six segments, indices 0,1,2 in the first series' run and
    // 0,1,2 offset by the second series' run start, which is 4 in the shared
    // texture. The flat index is what `lineEndA()`/`lineEndB()` decompose.
    for (let segment = 0; segment < 6; segment += 1) indices.push(words[segment * 6] as number);
    expect(indices).toEqual([0, 1, 2, 4, 5, 6]);
  });

  it('reports when the point texture cannot hold the data', () => {
    // A context that advertises a 4×4 texture: 16 texels, so a 100-point series
    // cannot fit.
    const h = harness({ pointSource: 'texture' }, { maxTextureSize: 4 });
    h.layer.addSeries(ramp(100));
    frame(h);

    expect(h.codes).toContain('line/texture-capacity-exceeded');
    // The tail is dropped and said so, rather than the whole layer going blank.
    expect(h.layer.texelCount).toBeLessThanOrEqual(16);
    expect(h.layer.texelCount).toBeGreaterThan(0);
  });
});

describe('LineLayer · GL state', () => {
  it('binds the point payload per instance and the quad corner per vertex', () => {
    const h = harness({ pointSource: 'attribute' });
    h.layer.addSeries(ramp(4));

    const divisors = new Map<number, number>();
    for (const call of h.mock.calls) {
      if (call.name === 'vertexAttribDivisor') {
        divisors.set(call.args[0] as number, call.args[1] as number);
      }
    }
    // Corner 0 is the only per-vertex attribute; everything else varies per
    // instance, which is what lets one draw cover every series.
    expect(divisors.get(0)).toBe(0);
    expect(divisors.get(1)).toBe(1);
    expect(divisors.get(2)).toBe(1);
    expect(divisors.get(3)).toBe(1);
    expect(divisors.get(4)).toBe(1);
  });

  it('uses integer attribute pointers for the uint payloads', () => {
    const attribute = harness({ pointSource: 'attribute' });
    attribute.layer.addSeries(ramp(4));
    // The id is a uint attribute in both channels. `vertexAttribPointer` converts
    // to float, and a float32 cannot hold an id above 2^24 exactly, so the mock's
    // `vertexAttribIPointer` log is the assertion that this was not got wrong.
    expect(attribute.mock.counts['vertexAttribIPointer']).toBe(1);
    expect(attribute.mock.counts['vertexAttribPointer']).toBeGreaterThan(1);

    const texture = harness({ pointSource: 'texture' });
    texture.layer.addSeries(ramp(4));
    // Flat texture index and id.
    expect(texture.mock.counts['vertexAttribIPointer']).toBe(2);
  });

  it('re-points the instance attributes after the buffer grows', () => {
    const h = harness({ pointSource: 'attribute', initialSegments: 2 });
    h.layer.addSeries(ramp(200));
    const before = h.mock.counts['vertexAttribPointer'] ?? 0;
    const beforeInteger = h.mock.counts['vertexAttribIPointer'] ?? 0;

    frame(h);
    // A VAO captures the buffer binding, so a recreated buffer leaves the VAO's
    // instance attributes pointing at a deleted buffer: a chart that renders
    // perfectly until it happens to grow, then goes blank.
    expect(h.mock.counts['vertexAttribPointer'] ?? 0).toBeGreaterThan(before);
    expect(h.mock.counts['vertexAttribIPointer'] ?? 0).toBeGreaterThan(beforeInteger);
    // And the draw still covers every segment.
    expect(h.mock.draws).toEqual([199]);
  });

  it('releases every GPU object on dispose', () => {
    const h = harness({ pointSource: 'texture' });
    h.layer.addSeries(ramp(100));
    frame(h);
    expect(h.pool.liveCount).toBeGreaterThan(0);

    h.layer.dispose();
    expect(h.pool.liveCount).toBe(0);
    // The pass condition is that nothing is left to leak, so `assertEmpty` — which
    // names every surviving object — must not throw.
    expect(() => h.pool.assertEmpty('test')).not.toThrow();
  });

  it('releases every id range on dispose, even without a clear', () => {
    const h = harness();
    h.layer.addSeries(ramp(10));
    h.layer.dispose();
    expect(h.ids.live).toBe(0);
    expect(h.ids.free).toBe(h.ids.capacity);
  });
});
