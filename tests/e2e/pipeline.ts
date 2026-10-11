import { Renderer } from '../../src/index';

/**
 * Real-GPU pipeline smoke test.
 *
 * Every other test in this repository runs against a recording mock, which is
 * what makes the structural gates cheap and deterministic — but a mock cannot
 * tell you that the composed GLSL actually *compiles*, that the VAO captures the
 * instance attributes, or that the projection puts pixels where the caller asked.
 * A shader assembled from templates is exactly the kind of artefact that can be
 * structurally perfect and still render nothing.
 *
 * So this page runs the whole chain on a real WebGL2 implementation — SwiftShader
 * in CI — and then reads the framebuffer back. It is deliberately synchronous:
 * no animation loop, no awaiting, because a `requestAnimationFrame` loop plus
 * `--virtual-time-budget` is how a headless renderer gets killed.
 *
 * What it proves, and why each check is a *pixel* check:
 *
 * - **The composed shaders compile and link.** A failure throws before we get here.
 * - **Instancing places two markers at two places.** Two instances, one draw call,
 *   two coloured clusters — so the divisor setup is right, not merely present.
 * - **The y flip happens exactly once.** The canvas convention is y-down (matching
 *   mouse events) and GL is y-up, with `readPixels` counting rows from the bottom.
 *   The triangle's area centroid therefore sits *above* its offset in screen terms.
 *   Getting the flip wrong — or applying it twice — moves the cluster below the
 *   offset instead, and the assertion catches it.
 */

/** Fail loudly rather than rendering into nothing. */
function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`smoke markup is incomplete: ${String(selector)}`);
  return element;
}

const canvas = requireElement<HTMLCanvasElement>('#stage');
const result = requireElement<HTMLElement>('#result');

function finish(ok: boolean, checks: Readonly<Record<string, number | string | boolean>>): void {
  document.body.dataset['status'] = ok ? 'ok' : 'fail';
  result.textContent = JSON.stringify({ ok, checks });
}

/**
 * `devicePixelRatio: false` pins the ratio to 1 so the drawing buffer is exactly
 * 64x64 and pixel indices are predictable.
 */
const renderer = new Renderer({ canvas, diagnostics: 'warn', devicePixelRatio: false });
renderer.setSize(64, 64);

const layer = renderer.addTriangleLayer({ initialCapacity: 2, label: 'smoke' });
// Offsets in pixel space, so the red marker covers the left half and the blue one
// the right. `size` is in pixels too.
layer.setInstance(0, 16, 32, 16, 1, 0, 0);
layer.setInstance(1, 48, 32, 16, 0, 0, 1);
layer.count = 2;

const before = renderer.stats().drawCalls;
renderer.renderNow();
const drawCalls = renderer.stats().drawCalls;

const gl = renderer.gl;
const size = 64;
const pixels = new Uint8Array(size * size * 4);
gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

let redCount = 0;
let blueCount = 0;
let redSumX = 0;
let redSumTopY = 0;
let blueSumX = 0;

for (let row = 0; row < size; row += 1) {
  for (let column = 0; column < size; column += 1) {
    const index = (row * size + column) * 4;
    const r = pixels[index] ?? 0;
    const b = pixels[index + 2] ?? 0;
    // `readPixels` counts rows from the bottom, so convert to the y-down
    // convention the engine and mouse events use before reasoning about it.
    const topY = size - 1 - row;

    if (r > 180 && b < 60) {
      redCount += 1;
      redSumX += column;
      redSumTopY += topY;
    } else if (b > 180 && r < 60) {
      blueCount += 1;
      blueSumX += column;
    }
  }
}

const redCentroidX = redCount === 0 ? -1 : redSumX / redCount;
const redCentroidTopY = redCount === 0 ? -1 : redSumTopY / redCount;
const blueCentroidX = blueCount === 0 ? -1 : blueSumX / blueCount;

const liveBeforeDestroy = renderer.stats().resources.live;
const programs = renderer.stats().programs;
const version = String(gl.getParameter(gl.VERSION));

// `assertClean` defaults to true, so a leaked buffer or vertex array throws here
// rather than quietly holding VRAM. This is the one place the ledger is checked
// against a driver that really owns the objects.
renderer.destroy();
const liveAfterDestroy = renderer.stats().resources.live;

const ok =
  // A template mismatch or a bad attribute pointer renders nothing at all, which
  // is the failure this whole page exists to catch.
  redCount > 100 &&
  blueCount > 100 &&
  // Two instances, one context, two clusters: the instancing divisors are right,
  // not merely present.
  redCentroidX < 24 &&
  blueCentroidX > 40 &&
  // Above the offset (y < 32) because the shader flips y exactly once. A missing
  // or doubled flip puts the cluster below it instead.
  redCentroidTopY > 22 &&
  redCentroidTopY < 32 &&
  // One layer, one instanced call — on a real driver, not a counter.
  drawCalls === 1 &&
  liveBeforeDestroy > 0 &&
  liveAfterDestroy === 0;

finish(ok, {
  redPixelsDrawn: redCount,
  bluePixelsDrawn: blueCount,
  redCentroidX,
  blueCentroidX,
  redCentroidTopY,
  drawCalls,
  drawCallsBeforeRender: before,
  programs,
  liveBeforeDestroy,
  liveAfterDestroy,
  glVersion: version,
});
