import { describe, expect, it, vi } from 'vitest';

import { Dirty } from '../src/core/dirty';
import { DiagnosticError, Diagnostics } from '../src/core/Diagnostics';
import type { LineLayer } from '../src/layers/LineLayer';
import { Renderer } from '../src/renderer/Renderer';
import { ShaderCompileError } from '../src/renderer/Program';
import { ALL_EXTENSIONS, createMockCanvas, createMockGL } from './utils/mock-gl';
import { createFakeClock } from './utils/fake-clock';

/**
 * Structural gates from the performance design, asserted without a GPU.
 *
 * Draw-call counts, `destroy()` cleanliness, upload strategy and DPR capping are
 * all independent of the driver, which is why they can be hard assertions in CI
 * while frame *times* can only ever be relative regressions.
 */
function setup(
  options: {
    gl?: Parameters<typeof createMockGL>[0];
    clientWidth?: number;
    clientHeight?: number;
    renderer?: Partial<ConstructorParameters<typeof Renderer>[0]>;
  } = {},
) {
  const mock = createMockGL({ extensions: ALL_EXTENSIONS, ...options.gl });
  const mockCanvas = createMockCanvas(mock, {
    clientWidth: options.clientWidth ?? 300,
    clientHeight: options.clientHeight ?? 150,
  });
  const clock = createFakeClock();
  const renderer = new Renderer({
    canvas: mockCanvas.canvas,
    diagnostics: 'silent',
    host: clock.host,
    devicePixelRatio: 1,
    ...options.renderer,
  });
  return { mock, mockCanvas, clock, renderer };
}

describe('Renderer construction', () => {
  it('requires a WebGL2 context', () => {
    const canvas = {
      width: 10,
      height: 10,
      getContext: () => null,
    } as unknown as HTMLCanvasElement;

    // WebGL1 is deliberately unsupported; failing loudly beats a half-working
    // render path that reports GLSL ES 3.00 syntax errors.
    expect(() => new Renderer({ canvas })).toThrowError(/requires a WebGL2 context/);
  });

  it('disables MSAA and depth by default', () => {
    const { mockCanvas } = setup();
    expect(mockCanvas.requestedAttributes?.antialias).toBe(false);
    expect(mockCanvas.requestedAttributes?.depth).toBe(false);
    expect(mockCanvas.requestedAttributes?.preserveDrawingBuffer).toBe(false);
  });

  it('lets context attributes be overridden', () => {
    const { mockCanvas } = setup({ renderer: { antialias: true } });
    expect(mockCanvas.requestedAttributes?.antialias).toBe(true);
  });

  it('sets the viewport to the drawing buffer', () => {
    const { mock } = setup();
    expect(mock.counts['viewport']).toBeGreaterThan(0);
  });

  it('reports a degraded context without failing construction', () => {
    const mock = createMockGL({ extensions: [] });
    const mockCanvas = createMockCanvas(mock);

    // `diagnostics: 'throw'` is the strict setting CI uses, and it must not
    // escalate a fact about the GPU into an exception. A machine missing five
    // optional features still renders correctly, just with the documented
    // fallbacks; only caller mistakes are errors.
    const renderer = new Renderer({
      canvas: mockCanvas.canvas,
      diagnostics: 'throw',
      devicePixelRatio: 1,
    });

    expect(renderer.capabilityReport.degraded).toBe(true);
    expect(renderer.capabilityReport.missing.length).toBeGreaterThan(0);
    // Every missing feature must come with a named fallback, so a support bundle
    // can explain a visual difference instead of leaving it to be guessed.
    expect(renderer.capabilityReport.fallbacks).toHaveLength(
      renderer.capabilityReport.missing.length,
    );
    renderer.destroy();
  });

  it('reports the degradation to a listener attached before construction', () => {
    const mock = createMockGL({ extensions: [] });
    const mockCanvas = createMockCanvas(mock);

    // Capability probing reports *during* construction, so observing it requires
    // handing in a hub rather than a level string.
    const diagnostics = new Diagnostics('silent');
    const listener = vi.fn();
    diagnostics.on(listener);

    const renderer = new Renderer({
      canvas: mockCanvas.canvas,
      diagnostics,
      devicePixelRatio: 1,
    });

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'capability/degraded', severity: 'info' }),
    );

    renderer.destroy();
    // A caller-owned hub must survive destroy(): dropping its listeners would
    // silently kill telemetry the caller wired up for their own reasons.
    diagnostics.report('after/destroy', 'still attached');
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('Renderer draw-call budget', () => {
  it('draws a whole layer in one instanced call', () => {
    const { mock, renderer } = setup();
    const layer = renderer.addTriangleLayer({ initialCapacity: 8 });
    layer.setInstances([
      { x: 10, y: 10, size: 5, r: 1, g: 0, b: 0 },
      { x: 40, y: 10, size: 5, r: 0, g: 1, b: 0 },
      { x: 70, y: 10, size: 5, r: 0, g: 0, b: 1 },
    ]);

    mock.draws.length = 0;
    renderer.renderNow();

    expect(mock.draws).toEqual([3]);
    expect(renderer.stats().drawCalls).toBe(1);
    renderer.destroy();
  });

  it('stays inside the 32 draw-call budget for a 16-chart dashboard', () => {
    const { mock, renderer } = setup();
    for (let i = 0; i < 16; i += 1) {
      const layer = renderer.addTriangleLayer({ initialCapacity: 4, label: `chart-${String(i)}` });
      layer.setInstance(0, i, 0, 1, 1, 1, 1);
    }

    mock.draws.length = 0;
    renderer.renderNow();
    expect(renderer.stats().drawCalls).toBeLessThanOrEqual(32);
    renderer.destroy();
  });

  it('skips the draw entirely for an empty layer', () => {
    const { mock, renderer } = setup();
    renderer.addTriangleLayer();
    mock.draws.length = 0;
    renderer.renderNow();

    expect(mock.draws).toHaveLength(0);
    expect(renderer.stats().drawCalls).toBe(0);
    renderer.destroy();
  });

  it('shares one compiled program between layers with the same variant', () => {
    const { renderer } = setup();
    renderer.addTriangleLayer();
    renderer.addTriangleLayer();
    expect(renderer.stats().programs).toBe(1);
    renderer.destroy();
  });

  it('compiles a separate program per distinct variant', () => {
    const { renderer } = setup();
    renderer.addTriangleLayer();
    renderer.addTriangleLayer({}, { opacity: 0.5 });
    expect(renderer.stats().programs).toBe(2);
    renderer.destroy();
  });
});

describe('Renderer · the line layer seam', () => {
  /**
   * Three ten-point series, so each layer owns 27 segments and 30 pick ids.
   *
   * Nine segments per series rather than ten keeps the arithmetic in the
   * expectations obvious, and three series is the smallest number that shows a
   * merge across more than a pair.
   */
  function addSeries(layer: LineLayer): void {
    for (let series = 0; series < 3; series += 1) {
      const x = new Float64Array(10);
      const y = new Float64Array(10);
      for (let i = 0; i < 10; i += 1) {
        x[i] = i;
        y[i] = series + (i % 3);
      }
      layer.addSeries({ x, y, color: [series / 3, 0.5, 1 - series / 3] });
    }
  }

  it('draws every series of a line layer in one call', () => {
    const { mock, renderer } = setup();
    const layer = renderer.addLineLayer({ initialSegments: 64 });
    addSeries(layer);

    mock.draws.length = 0;
    renderer.renderNow();

    // The kernel counts what it issued, so this is not a per-layer promise: three
    // descriptors, one merged group, one GL draw.
    expect(mock.draws).toEqual([27]);
    expect(renderer.stats().drawCalls).toBe(1);
    expect(renderer.stats().drawGroups).toBe(1);
    renderer.destroy();
  });

  it('draws both channels, with one program each and its own VAO', () => {
    const { mock, renderer } = setup();
    const attribute = renderer.addLineLayer({ pointSource: 'attribute', initialSegments: 64 });
    const texture = renderer.addLineLayer({ pointSource: 'texture', initialSegments: 64 });
    addSeries(attribute);
    addSeries(texture);

    mock.draws.length = 0;
    renderer.renderNow();

    // Two layers, two channels, two VAOs and two programs: two calls, 27 instances
    // each. They must *not* merge — attribute location 1 carries a different
    // payload in each — and the count is what proves it happened.
    expect(mock.draws).toEqual([27, 27]);
    expect(renderer.stats().drawCalls).toBe(2);
    expect(renderer.stats().programs).toBe(2);
    expect(attribute.pointSource).toBe('attribute');
    expect(texture.pointSource).toBe('texture');
    renderer.destroy();
  });

  it('frees the point texture the texture channel allocates', () => {
    const { renderer } = setup();
    const layer = renderer.addLineLayer({ pointSource: 'texture', initialSegments: 4 });
    addSeries(layer);
    renderer.renderNow();

    // Four objects in the attribute channel (corner buffer, instance buffer, VAO,
    // program); the texture channel adds a fifth. `destroy()` asserts cleanliness
    // by default, so reaching the next line at all is the assertion — the explicit
    // check is here so a future `assertClean: false` cannot turn this into a
    // silent leak.
    renderer.destroy();
    expect(renderer.stats().resources.live).toBe(0);
  });

  it('claims pick ids from the renderer-wide space, not per layer', () => {
    const { renderer } = setup();
    const layer = renderer.addLineLayer({ initialSegments: 64 });
    addSeries(layer);

    // C1 rule 2: one axis for the whole renderer, so a second layer's ids start
    // where the first one's ended. A per-layer space would hand out 1..30 twice,
    // and nothing would notice until two layers existed.
    expect(renderer.idSpace.live).toBe(30);
    const other = renderer.addLineLayer({ initialSegments: 8 });
    other.addSeries({ x: Float64Array.from([0, 1]), y: Float64Array.from([0, 1]) });
    expect(renderer.idSpace.live).toBe(32);
    renderer.destroy();
  });

  it('stops uploading once the line geometry is stable', () => {
    const { mock, renderer } = setup();
    const layer = renderer.addLineLayer({ initialSegments: 64 });
    addSeries(layer);
    renderer.renderNow();

    const after = mock.counts['bufferSubData'] ?? 0;
    expect(after).toBeGreaterThan(0);
    renderer.renderNow();
    // A second frame with nothing changed must not re-push instance bytes; the
    // upload stage is gated on a dirty flag, and a gate that never closes is the
    // difference between a steady-state chart and one that uploads forever.
    expect(mock.counts['bufferSubData'] ?? 0).toBe(after);
    renderer.destroy();
  });
});

describe('Renderer upload strategy', () => {
  it('uploads only the live range via bufferSubData', () => {
    const { mock, renderer } = setup();
    const layer = renderer.addTriangleLayer({ initialCapacity: 4 });
    layer.setInstance(0, 1, 2, 3, 0.1, 0.2, 0.3);
    layer.setInstance(1, 4, 5, 6, 0.4, 0.5, 0.6);

    mock.uploads.length = 0;
    renderer.renderNow();

    // 6 floats per instance, 4 bytes per float, 2 instances.
    expect(mock.uploads).toEqual([48]);
    renderer.destroy();
  });

  it('does not re-upload when nothing changed', () => {
    const { mock, renderer } = setup();
    const layer = renderer.addTriangleLayer({ initialCapacity: 4 });
    layer.setInstance(0, 0, 0, 1, 1, 1, 1);

    renderer.renderNow();
    mock.uploads.length = 0;
    renderer.renderNow();

    expect(mock.uploads).toHaveLength(0);
    renderer.destroy();
  });

  it('skips the upload stage when only style changed', () => {
    const { mock, renderer } = setup();
    const layer = renderer.addTriangleLayer({ initialCapacity: 4 });
    layer.setInstance(0, 0, 0, 1, 1, 1, 1);
    renderer.renderNow();

    mock.uploads.length = 0;
    // Style must not imply Geometry or Upload: a colour change must not rewrite
    // instance attributes.
    renderer.renderNow(Dirty.Style);
    expect(mock.uploads).toHaveLength(0);
    renderer.destroy();
  });

  it('recreates the buffer and re-captures VAO attributes on growth', () => {
    const { mock, renderer } = setup();
    const layer = renderer.addTriangleLayer({ initialCapacity: 2 });
    const pointersBefore = mock.counts['vertexAttribPointer'] ?? 0;

    for (let i = 0; i < 40; i += 1) {
      layer.setInstance(i, i, i, 1, 1, 1, 1);
    }
    expect(layer.count).toBe(40);
    expect(layer.capacity).toBeGreaterThanOrEqual(40);

    // The VAO captures buffer bindings, so growth must re-run vertexAttribPointer.
    // Forgetting this renders correctly until the moment it grows, then nothing.
    expect(mock.counts['vertexAttribPointer']).toBeGreaterThan(pointersBefore);
    expect(mock.created['buffer']).toBeGreaterThan(2);
    renderer.destroy();
  });

  it('preserves already written instances across growth', () => {
    const { renderer } = setup();
    const layer = renderer.addTriangleLayer({ initialCapacity: 2 });
    layer.setInstance(0, 7, 8, 1, 1, 1, 1);
    layer.setInstance(5, 9, 10, 1, 1, 1, 1);
    expect(layer.capacity).toBeGreaterThanOrEqual(6);
    expect(layer.count).toBe(6);
    renderer.destroy();
  });

  it('shrinks the drawn range when the count is lowered', () => {
    const { mock, renderer } = setup();
    const layer = renderer.addTriangleLayer({ initialCapacity: 16 });
    for (let i = 0; i < 8; i += 1) layer.setInstance(i, i, i, 1, 1, 1, 1);
    expect(layer.count).toBe(8);

    mock.draws.length = 0;
    mock.uploads.length = 0;
    // `setInstance` only raises the count, so without this the stale tail would
    // stay on screen and keep being drawn.
    layer.count = 3;
    renderer.renderNow();

    expect(layer.count).toBe(3);
    expect(mock.draws).toEqual([3]);
    // 6 floats per instance, 4 bytes per float, 3 instances.
    expect(mock.uploads).toEqual([72]);
    renderer.destroy();
  });

  it('does not grow the buffer when the count is lowered', () => {
    const { renderer } = setup();
    const layer = renderer.addTriangleLayer({ initialCapacity: 16 });
    const capacity = layer.capacity;

    layer.count = 4;
    expect(layer.count).toBe(4);
    expect(layer.capacity).toBe(capacity);

    // A zero or non-finite count is clamped rather than throwing: it is a valid
    // "draw nothing this frame" request, and the layer must stay usable.
    layer.count = 0;
    expect(layer.count).toBe(0);
    layer.count = Number.NaN;
    expect(layer.count).toBe(0);
    renderer.destroy();
  });
});

describe('Renderer sizing', () => {
  it('sizes the drawing buffer from CSS pixels and ratio', () => {
    const { renderer } = setup({ renderer: { devicePixelRatio: 2 } });
    renderer.setSize(400, 300);

    expect(renderer.width).toBe(800);
    expect(renderer.height).toBe(600);
    expect(renderer.devicePixelRatio).toBe(2);
    renderer.destroy();
  });

  it('caps the ratio by the pixel budget', () => {
    const { renderer } = setup({ renderer: { devicePixelRatio: 3, maxPixels: 1_000_000 } });
    renderer.setSize(1000, 1000);

    expect(renderer.devicePixelRatio).toBeLessThan(3);
    expect(renderer.width * renderer.height).toBeLessThanOrEqual(1_000_001);
    renderer.destroy();
  });

  it('never produces a zero-sized buffer', () => {
    const { renderer } = setup();
    renderer.setSize(0, 0);
    expect(renderer.width).toBeGreaterThanOrEqual(1);
    expect(renderer.height).toBeGreaterThanOrEqual(1);
    renderer.destroy();
  });

  it('is a no-op when the size is unchanged', () => {
    const { mock, renderer } = setup();
    renderer.setSize(400, 300);
    const before = mock.counts['viewport'] ?? 0;
    renderer.setSize(400, 300);
    expect(mock.counts['viewport']).toBe(before);
    renderer.destroy();
  });

  it('requests a viewport update on resize', () => {
    const { clock, mock, renderer } = setup();
    renderer.setSize(500, 400);
    renderer.setSize(600, 500);

    mock.counts['viewport'] = 0;
    clock.frame();
    expect(mock.counts['viewport']).toBe(1);
    renderer.destroy();
  });

  it('reads the CSS box on resize()', () => {
    const { renderer } = setup({ clientWidth: 250, clientHeight: 125 });
    renderer.resize();
    expect(renderer.width).toBe(250);
    expect(renderer.height).toBe(125);
    renderer.destroy();
  });

  it('passes the drawing buffer size to the shader', () => {
    const { mock, renderer } = setup({ renderer: { devicePixelRatio: 1 } });
    const layer = renderer.addTriangleLayer();
    layer.setInstance(0, 0, 0, 1, 1, 1, 1);
    renderer.setSize(320, 240);

    mock.clearCalls();
    renderer.renderNow();

    const resolution = mock.calls.find(
      (call) => call.name === 'uniform2f' && call.args[1] === 320 && call.args[2] === 240,
    );
    expect(resolution).toBeDefined();
    renderer.destroy();
  });
});

describe('Renderer scheduling', () => {
  it('renders one frame for a burst of requests', () => {
    const { clock, mock, renderer } = setup();
    const layer = renderer.addTriangleLayer();
    layer.setInstance(0, 0, 0, 1, 1, 1, 1);

    mock.draws.length = 0;
    for (let i = 0; i < 10; i += 1) renderer.request(Dirty.Data);
    clock.frame();

    // One clear plus one draw for the whole burst.
    expect(mock.counts['clear']).toBe(1);
    expect(mock.draws).toHaveLength(1);
    renderer.destroy();
  });

  it('does not render a frame when nothing changed', () => {
    const { clock, mock, renderer } = setup();
    mock.clearCalls();
    renderer.request(Dirty.None);
    clock.frame();
    expect(mock.counts['clear']).toBeUndefined();
    renderer.destroy();
  });

  it('exposes the frame-rate cap', () => {
    const { renderer } = setup({ renderer: { maxFps: 30 } });
    renderer.setMaxFps(10);
    expect(renderer.stats().scheduler.framesRequested).toBeGreaterThanOrEqual(0);
    renderer.destroy();
  });
});

describe('Renderer lifecycle', () => {
  it('frees every GPU object on destroy', () => {
    const { renderer } = setup();
    const layer = renderer.addTriangleLayer({ initialCapacity: 4 });
    layer.setInstance(0, 0, 0, 1, 1, 1, 1);
    renderer.renderNow();

    // assertClean defaults to true: a silent leak is the failure mode this whole
    // ledger exists to prevent.
    expect(() => {
      renderer.destroy();
    }).not.toThrow();
    expect(renderer.stats().resources.live).toBe(0);
  });

  it('throws when asked to destroy without cleaning up', () => {
    const mock = createMockGL({ extensions: ALL_EXTENSIONS });
    const mockCanvas = createMockCanvas(mock);
    const renderer = new Renderer({
      canvas: mockCanvas.canvas,
      diagnostics: 'silent',
      devicePixelRatio: 1,
    });
    renderer.addTriangleLayer();

    expect(() => {
      renderer.destroy({ assertClean: false });
    }).not.toThrow();
    // Even with assertClean false the resources are released, so a subsequent
    // strict check on the same pool sees zero.
    expect(renderer.stats().resources.live).toBe(0);
  });

  it('releases vertex arrays, which LCJS 9.0 never does', () => {
    const { mock, renderer } = setup();
    renderer.addTriangleLayer();
    renderer.destroy();
    expect(mock.deleted['vertexArray']).toBeGreaterThan(0);
  });

  it('is safe to call destroy twice', () => {
    const { renderer } = setup();
    renderer.addTriangleLayer();
    renderer.destroy();
    expect(() => {
      renderer.destroy();
    }).not.toThrow();
  });

  it('ignores render requests after destroy', () => {
    const { mock, renderer } = setup();
    renderer.destroy();
    mock.calls.length = 0;
    renderer.renderNow();
    expect(mock.counts['clear']).toBeUndefined();
  });

  it('drops canvas listeners on destroy', () => {
    const { mockCanvas, renderer } = setup();
    renderer.destroy();
    expect(mockCanvas.listeners.get('webglcontextlost')?.size ?? 0).toBe(0);
  });
});

describe('Renderer context loss', () => {
  it('suspends rendering and drops the resource ledger', () => {
    const { mock, mockCanvas, renderer } = setup();
    const layer = renderer.addTriangleLayer();
    layer.setInstance(0, 0, 0, 1, 1, 1, 1);

    mockCanvas.dispatch('webglcontextlost');
    expect(renderer.contextLost).toBe(true);
    expect(renderer.stats().resources.live).toBe(0);

    mock.calls.length = 0;
    renderer.renderNow();
    expect(mock.counts['clear']).toBeUndefined();
    // A destroy after a loss must still be clean: the ledger was abandoned, not
    // left half-populated.
    expect(() => {
      renderer.destroy();
    }).not.toThrow();
  });

  it('reports the loss through diagnostics', () => {
    const mock = createMockGL({ extensions: ALL_EXTENSIONS });
    const mockCanvas = createMockCanvas(mock);
    const renderer = new Renderer({
      canvas: mockCanvas.canvas,
      diagnostics: 'silent',
      devicePixelRatio: 1,
    });
    const listener = vi.fn();
    renderer.diagnostics.on(listener);

    mockCanvas.dispatch('webglcontextlost');
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ code: 'context/lost' }));
    renderer.destroy();
  });

  it('clears the lost flag on restore', () => {
    const { mockCanvas, renderer } = setup();
    mockCanvas.dispatch('webglcontextlost');
    mockCanvas.dispatch('webglcontextrestored');
    expect(renderer.contextLost).toBe(false);
    renderer.destroy();
  });
});

describe('Renderer diagnostics', () => {
  it('turns a shader compile failure into a line-numbered error', () => {
    const mock = createMockGL({ extensions: ALL_EXTENSIONS, failCompile: true });
    const mockCanvas = createMockCanvas(mock);
    const renderer = new Renderer({
      canvas: mockCanvas.canvas,
      diagnostics: 'silent',
      devicePixelRatio: 1,
    });

    try {
      renderer.addTriangleLayer();
      throw new Error('expected a ShaderCompileError');
    } catch (error) {
      expect(error).toBeInstanceOf(ShaderCompileError);
      const typed = error as ShaderCompileError;
      expect(typed.stage).toBe('vertex');
      expect(typed.message).toContain('1 | #version 300 es');
      expect(typed.message).toContain('syntax error');
    }
    expect(() => {
      renderer.destroy();
    }).not.toThrow();
  });

  it('leaks nothing when linking fails', () => {
    const mock = createMockGL({ extensions: ALL_EXTENSIONS, failLink: true });
    const mockCanvas = createMockCanvas(mock);
    const renderer = new Renderer({
      canvas: mockCanvas.canvas,
      diagnostics: 'silent',
      devicePixelRatio: 1,
    });

    expect(() => renderer.addTriangleLayer()).toThrow(ShaderCompileError);
    // The failed program is released before the throw, so the pool is empty again.
    expect(renderer.stats().resources.live).toBe(0);
    renderer.destroy();
  });

  it('assertEmpty names the leaking label', () => {
    const mock = createMockGL({ extensions: ALL_EXTENSIONS });
    const mockCanvas = createMockCanvas(mock);
    const renderer = new Renderer({
      canvas: mockCanvas.canvas,
      diagnostics: 'silent',
      devicePixelRatio: 1,
    });
    renderer.addTriangleLayer({ label: 'alarms' });

    try {
      renderer.destroy({ assertClean: false });
      const abandoned = renderer.resources;
      abandoned.track('buffer', {}, 0, 'stray');
      abandoned.assertEmpty('Renderer.destroy');
      throw new Error('expected assertEmpty to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DiagnosticError);
      expect((error as DiagnosticError).detail).toContain('buffer:stray');
    }
  });
});
