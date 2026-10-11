import { type LineLayer, Renderer, orthographicTransform } from '../../src/index';

/**
 * Real-GPU line-pipeline checks.
 *
 * `tests/line-layer.test.ts` proves the *structure* of the line pipeline against
 * a recording mock: six segments enumerated, one descriptor per series, one
 * merged draw call, a zoom that writes only a uniform. None of that can tell you
 * whether the composed GLSL compiles, whether the screen-space normal produces
 * the width the caller asked for, or whether the two data channels agree.
 *
 * So this page draws the same scene twice — once per channel, in two contexts —
 * and reads both framebuffers back. Four claims, each of which is a *pixel* claim
 * and none of which the mock can make:
 *
 * 1. **The line shader compiles and draws.** A template that assembles but
 *    mis-declares an attribute renders nothing at all; `litPixels` catches it.
 * 2. **The two channels are pixel-identical.** The scene deliberately contains
 *    the three shapes whose endpoint bookkeeping differs between channels if it
 *    is going to differ at all: a diagonal run, a run broken by a genuine gap,
 *    and an isolated point (which the texture channel stores as a duplicated
 *    texel and the attribute channel as `A == B`). The comparison is of raw
 *    framebuffer bytes, not of a summary statistic.
 * 3. **The y flip happens exactly once, in this shader too.** The line shader
 *    does its own clip → pixel conversion, so the triangle page's flip assertion
 *    does not cover it. Data `y = 56` must land near the top and data `y = 8`
 *    near the bottom, and this asserts both directions.
 * 4. **Stroke width is in pixels and does not scale with zoom.** The same
 *    two-point series is drawn in a 64-unit window and in an 8-unit window; the
 *    rendered band height must be equal *and* close to the requested 5 px. The
 *    equality alone would not catch the factor-of-two error the design document's
 *    sketch contained, because that error is uniform — the absolute bound does.
 *
 * Synchronous by construction: the runner uses `--dump-dom`, so no
 * `requestAnimationFrame` loop and no awaiting. A page that schedules frames plus
 * `--virtual-time-budget` is how a headless renderer gets killed.
 */

function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`line smoke markup is incomplete: ${String(selector)}`);
  return element;
}

const result = requireElement<HTMLElement>('#result');

function finish(ok: boolean, checks: Readonly<Record<string, number | string | boolean>>): void {
  document.body.dataset['status'] = ok ? 'ok' : 'fail';
  result.textContent = JSON.stringify({ ok, checks });
}

const SIZE = 64;
/** Requested stroke width, in device pixels. */
const THICKNESS = 5;
/** Full-canvas domain, so a data coordinate is also a y-down pixel coordinate. */
const FULL = { min: 0, max: SIZE };

function makeRenderer(selector: string): Renderer {
  // `devicePixelRatio: false` pins the ratio to 1, so the drawing buffer is
  // exactly 64x64 and a pixel index is predictable.
  const renderer = new Renderer({
    canvas: requireElement<HTMLCanvasElement>(selector),
    diagnostics: 'silent',
    devicePixelRatio: false,
  });
  renderer.setSize(SIZE, SIZE);
  return renderer;
}

const attribute = makeRenderer('#stage-attribute');
const texture = makeRenderer('#stage-texture');

const attributeLayer = attribute.addLineLayer({ pointSource: 'attribute', label: 'e2e.attribute' });
const textureLayer = texture.addLineLayer({ pointSource: 'texture', label: 'e2e.texture' });

interface SeriesSpec {
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly color: readonly [number, number, number];
}

/**
 * The comparison scene. Chosen so that every shape whose per-channel endpoint
 * bookkeeping could diverge is present:
 *
 * - `zig` — two diagonal segments. A transposed or mis-scaled projection moves
 *   them, and a diagonal is where a wrong screen-space normal shows up first.
 * - `broken` — a two-point run, a genuine NaN gap, another two-point run, a
 *   second NaN gap, then a lone point. That exercises the run start, the run
 *   continuation, the gap, and the isolated point where the texture channel
 *   duplicates a texel to give `lineEndB()` something to read.
 * - `flat` — horizontal and long: the stroke-width reference, and the only
 *   series that reaches the right-hand side of the canvas.
 */
const SCENE: readonly SeriesSpec[] = [
  {
    x: Float64Array.from([12, 24, 36]),
    y: Float64Array.from([32, 40, 24]),
    color: [1, 0.25, 0.25],
  },
  {
    x: Float64Array.from([8, 16, NaN, 28, 36, NaN, 48]),
    y: Float64Array.from([12, 20, NaN, 48, 48, NaN, 8]),
    color: [0.25, 1, 0.25],
  },
  {
    x: Float64Array.from([8, 56]),
    y: Float64Array.from([56, 56]),
    color: [0.35, 0.55, 1],
  },
];

function populate(layer: LineLayer): void {
  layer.setTransform(orthographicTransform(FULL, FULL));
  for (const series of SCENE) layer.addSeries({ ...series, thickness: THICKNESS });
}

populate(attributeLayer);
populate(textureLayer);
attribute.renderNow();
texture.renderNow();

function readback(renderer: Renderer): Uint8Array {
  const gl = renderer.gl;
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  gl.readPixels(0, 0, SIZE, SIZE, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  return pixels;
}

/** Mean of the three colour channels, ignoring alpha (the context is opaque). */
function brightness(pixels: Uint8Array, index: number): number {
  return ((pixels[index] ?? 0) + (pixels[index + 1] ?? 0) + (pixels[index + 2] ?? 0)) / 3;
}

/**
 * Rows that contain a lit pixel in one column, in **y-down** pixel rows.
 *
 * `readPixels` counts rows from the bottom of the framebuffer while the engine
 * and mouse events use y-down, so the conversion happens here, once, before any
 * reasoning about the result.
 */
function litRows(pixels: Uint8Array, column: number, threshold = 12): number[] {
  const rows: number[] = [];
  for (let row = 0; row < SIZE; row += 1) {
    if (brightness(pixels, (row * SIZE + column) * 4) > threshold) rows.push(SIZE - 1 - row);
  }
  return rows;
}

function litPixelCount(pixels: Uint8Array, threshold = 12): number {
  let count = 0;
  for (let index = 0; index < pixels.length; index += 4) {
    if (brightness(pixels, index) > threshold) count += 1;
  }
  return count;
}

const attributePixels = readback(attribute);
const texturePixels = readback(texture);

/** Whole-pixel comparison: any channel differing makes the pixel differ. */
let differingPixels = 0;
let maxChannelDelta = 0;
for (let index = 0; index < attributePixels.length; index += 4) {
  let differs = false;
  for (let channel = 0; channel < 4; channel += 1) {
    const delta = Math.abs(
      (attributePixels[index + channel] ?? 0) - (texturePixels[index + channel] ?? 0),
    );
    if (delta !== 0) differs = true;
    if (delta > maxChannelDelta) maxChannelDelta = delta;
  }
  if (differs) differingPixels += 1;
}

const attributeLit = litPixelCount(attributePixels);
const textureLit = litPixelCount(texturePixels);

// Column 48 carries exactly two clusters: the `flat` series near the top and the
// `broken` series' isolated point near the bottom. Neither `zig` nor either of
// `broken`'s runs reaches this far right, so both extremes are unambiguous.
const flipColumn = 48;
const flipRows = litRows(attributePixels, flipColumn);
const flipTop = flipRows.length === 0 ? -1 : Math.min(...flipRows);
const flipBottom = flipRows.length === 0 ? -1 : Math.max(...flipRows);

// Column 52 is reachable only by the `flat` series, whose square caps carry it
// out to x = 58.5 while nothing else passes x = 50.5. So the number of lit rows
// in this column is the stroke's height, with nothing else in the column.
const widthColumn = 52;
const strokeRows = litRows(attributePixels, widthColumn).length;

const mergedDrawCalls = attribute.stats().drawCalls;
const mergedDrawGroups = attribute.stats().drawGroups;

// ---- eight series, one call, on a real driver ----------------------------
//
// The M1-b gate is a *count*, and counts are exactly what a real context is worth
// checking on: the mock proves the merge logic, this proves the merge survives a
// driver that is free to ignore a VAO the engine thought it had set up.

attributeLayer.clear();
textureLayer.clear();

function zigzag(offset: number): { x: Float64Array; y: Float64Array } {
  const x = new Float64Array(33);
  const y = new Float64Array(33);
  for (let i = 0; i < 33; i += 1) {
    x[i] = i * 1.8 + 2;
    y[i] = 6 + offset + (i % 2) * 4;
  }
  return { x, y };
}

for (let series = 0; series < 8; series += 1) {
  const points = zigzag(series * 6);
  attributeLayer.addSeries({ ...points, thickness: 2, color: [series / 8, 0.5, 1 - series / 8] });
}
attribute.renderNow();
const eightSeriesDrawCalls = attribute.stats().drawCalls;
const eightSeriesDrawGroups = attribute.stats().drawGroups;
const eightSeriesStats = [0, 1, 2, 3, 4, 5, 6, 7].map((index) => attributeLayer.seriesStats(index));
const eightSeriesSegments = eightSeriesStats.reduce(
  (total, stats) => total + (stats?.segmentCount ?? 0),
  0,
);
// Every series must have been granted a disjoint per-point range: a merge that
// silently dropped a series would still report one draw call.
const zigzagRangesDisjoint = (() => {
  const ranges = eightSeriesStats
    .map((stats) => (stats === undefined ? null : { first: stats.idFirst, count: stats.idCount }))
    .filter((range): range is { first: number; count: number } => range !== null);
  for (let i = 1; i < ranges.length; i += 1) {
    const previous = ranges[i - 1];
    const current = ranges[i];
    if (previous === undefined || current === undefined) return false;
    if (previous.first + previous.count !== current.first) return false;
  }
  return ranges.length === 8;
})();

// ---- stroke width is a pixel quantity, not a data quantity ---------------
//
// The same two-point series, first in a 64-unit window (2 px long on screen) and
// then in an 8-unit window (16 px long). The band height must not change.

attributeLayer.clear();
attributeLayer.addSeries({
  x: Float64Array.from([29, 31]),
  y: Float64Array.from([32, 32]),
  thickness: THICKNESS,
  color: [1, 1, 1],
});

// 29 and 31 land on pixel columns 29 and 31; the caps reach 26.5 .. 33.5.
attributeLayer.setTransform(orthographicTransform(FULL, FULL));
attribute.renderNow();
const widthAtZoom1 = litRows(readback(attribute), 30).length;

// x.min = 24 maps to clip -1 and x.max = 32 to clip +1, a 4x magnification, which
// puts the series on columns 40 .. 56 — so the same claim is measured at column
// 44. y spans 28 .. 36, so the line stays on row 32.
attributeLayer.setTransform(orthographicTransform({ min: 24, max: 32 }, { min: 28, max: 36 }));
attribute.renderNow();
const widthAtZoom4 = litRows(readback(attribute), 44).length;

// ---- teardown ------------------------------------------------------------

const liveBeforeDestroy = attribute.stats().resources.live + texture.stats().resources.live;
let destroyedCleanly = true;
let destroyError = '';
try {
  attribute.destroy();
  texture.destroy();
} catch (error) {
  destroyedCleanly = false;
  destroyError = error instanceof Error ? error.message : String(error);
}
const liveAfterDestroy = attribute.stats().resources.live + texture.stats().resources.live;

const capabilities = attribute.capabilities;

const ok =
  // 1. The shader compiled, the quad covered its instances, and something landed.
  attributeLit > 200 &&
  textureLit > 200 &&
  // 2. The two channels are the same picture, byte for byte.
  differingPixels === 0 &&
  // 3. The flip happens once, and only once, in both directions.
  flipTop >= 0 &&
  flipTop < 24 &&
  flipBottom > 40 &&
  // 4. Width is in pixels: independent of zoom, and equal to what was asked for.
  //    The loose absolute bound is deliberate — a pixel centre landing exactly on
  //    the quad's edge makes 5 or 6 equally correct — while the factor-of-two error
  //    the design sketch contained would show up as 2 or 3.
  widthAtZoom1 === widthAtZoom4 &&
  widthAtZoom1 >= 4 &&
  widthAtZoom1 <= 7 &&
  strokeRows >= 4 &&
  strokeRows <= 7 &&
  // 5. Three series, six segments, one call — then eight series, one call.
  mergedDrawCalls === 1 &&
  mergedDrawGroups === 1 &&
  eightSeriesDrawCalls === 1 &&
  eightSeriesDrawGroups === 1 &&
  eightSeriesSegments === 8 * 32 &&
  zigzagRangesDisjoint &&
  // 6. Nothing leaked, on a driver that really owns the objects.
  destroyedCleanly &&
  liveBeforeDestroy > 0 &&
  liveAfterDestroy === 0;

finish(ok, {
  attributeLitPixels: attributeLit,
  textureLitPixels: textureLit,
  differingPixels,
  maxChannelDelta,
  flipColumn,
  flipTop,
  flipBottom,
  strokeRowsAtWidthColumn: strokeRows,
  widthAtZoom1,
  widthAtZoom4,
  requestedThickness: THICKNESS,
  mergedDrawCalls,
  mergedDrawGroups,
  eightSeriesDrawCalls,
  eightSeriesDrawGroups,
  eightSeriesSegments,
  zigzagRangesDisjoint,
  liveBeforeDestroy,
  liveAfterDestroy,
  destroyedCleanly,
  destroyError,
  textureFloatLinear: capabilities.textureFloatLinear,
  colorBufferFloat: capabilities.colorBufferFloat,
  maxTextureSize: capabilities.maxTextureSize,
  glVersion: String(attribute.gl.getParameter(attribute.gl.VERSION)),
});
