import { describe, expect, it } from 'vitest';

import { orthographicTransform } from '../src/core/transform';

/**
 * The data → clip matrix, and the convention it encodes.
 *
 * This module is four multiplications and a translation, which is exactly why it
 * needs a test: the design document's first line-shader sketch got the pixel
 * conversion wrong by a factor of two, and nothing in the structure of the code
 * would have shown it. The numbers below are the *contract* — `y.min` at the
 * bottom, `y.max` at the top — and `tests/e2e/line.ts` asserts the same thing on
 * a real GPU, where the value has to survive a driver.
 */

/**
 * Read one matrix element.
 *
 * `noUncheckedIndexedAccess` types every `Float32Array` read as
 * `number | undefined`, which is right for a general array and noise for a fixed
 * 16-element matrix. The cast lives here, once, rather than as an assertion in
 * every expression below.
 */
function at(matrix: Float32Array, index: number): number {
  return matrix[index] as number;
}

/** Apply a column-major 4×4 to a 2D point, the way the vertex shader does. */
function apply(matrix: Float32Array, x: number, y: number): { x: number; y: number } {
  return {
    x: at(matrix, 0) * x + at(matrix, 4) * y + at(matrix, 12),
    y: at(matrix, 1) * x + at(matrix, 5) * y + at(matrix, 13),
  };
}

/**
 * The shader's `unprojectPoint`, in JS.
 *
 * Written out here rather than imported, because GLSL cannot be imported. The
 * pair is what the width calculation depends on, so having both sides in one file
 * is the point.
 */
function toPixel(
  clip: { x: number; y: number },
  width: number,
  height: number,
): { x: number; y: number } {
  return { x: (clip.x * 0.5 + 0.5) * width, y: (0.5 - clip.y * 0.5) * height };
}

const DOMAIN = { min: 0, max: 64 };

/**
 * Compare a transformed point, allowing for single precision.
 *
 * The matrix is a `Float32Array`, so a value like `2/10` carries a float32 error
 * and an exact comparison would fail on arithmetic that is entirely correct.
 * Comparing to five decimals still catches a factor or an offset error by orders
 * of magnitude.
 */
function expectPoint(
  point: { readonly x: number; readonly y: number },
  expected: { readonly x: number; readonly y: number },
): void {
  expect(point.x).toBeCloseTo(expected.x, 5);
  expect(point.y).toBeCloseTo(expected.y, 5);
}

describe('orthographicTransform', () => {
  it('maps the domain corners to the clip corners', () => {
    const m = orthographicTransform({ min: -2, max: 6 }, { min: 10, max: 20 });
    expectPoint(apply(m, -2, 10), { x: -1, y: -1 });
    expectPoint(apply(m, 6, 20), { x: 1, y: 1 });
  });

  it('puts y.min at the bottom of the pixel space, which is y-down', () => {
    const m = orthographicTransform(DOMAIN, DOMAIN);
    // y.min is the *bottom*: in the y-down pixel space the shader works in, that
    // is the largest row index. The flip happens here and in `unprojectPoint`,
    // never twice.
    expectPoint(toPixel(apply(m, 0, 0), 64, 64), { x: 0, y: 64 });
    expectPoint(toPixel(apply(m, 0, 64), 64, 64), { x: 0, y: 0 });
  });

  it('maps the domain midpoint to the centre of the pixel space', () => {
    const m = orthographicTransform(DOMAIN, DOMAIN);
    expectPoint(toPixel(apply(m, 32, 32), 64, 64), { x: 32, y: 32 });
  });

  it('keeps x and y independent, so a non-square domain is not distorted', () => {
    const m = orthographicTransform({ min: 0, max: 100 }, { min: 0, max: 10 });
    // A 100-wide by 10-tall domain on a 64x64 canvas: the *shader* decides aspect,
    // and the matrix must not smuggle any in.
    expectPoint(toPixel(apply(m, 50, 5), 64, 64), { x: 32, y: 32 });
  });

  it('collapses a degenerate x domain to clip 0, not to an edge', () => {
    const m = orthographicTransform({ min: 5, max: 5 }, DOMAIN);
    // A flat series belongs in the middle of the axis. Mapping it to an edge
    // would present it as an axis artefact rather than as a line.
    expect(apply(m, 5, 0).x).toBe(0);
    expect(apply(m, 999, 0).x).toBe(0);
    // y is unaffected by x collapsing.
    expect(apply(m, 5, 64).y).toBe(1);
  });

  it('collapses a degenerate y domain to clip 0 as well', () => {
    const m = orthographicTransform(DOMAIN, { min: -3, max: -3 });
    expect(apply(m, 0, -3).y).toBe(0);
    expect(apply(m, 0, 100).y).toBe(0);
    expect(apply(m, 64, -3).x).toBe(1);
  });

  it('collapses a non-finite span rather than producing NaN', () => {
    // A NaN in the domain reaches here from an empty dataset, and a NaN matrix
    // makes every vertex vanish with no diagnostic at all.
    const nan = orthographicTransform({ min: 0, max: Number.NaN }, DOMAIN);
    expect(apply(nan, 0, 0).x).toBe(0);
    expect(Number.isFinite(apply(nan, 12, 3).x)).toBe(true);

    const infinite = orthographicTransform({ min: -Infinity, max: Infinity }, DOMAIN);
    expect(apply(infinite, 0, 0).x).toBe(0);
  });

  it('writes a column-major affine matrix', () => {
    const m = orthographicTransform(DOMAIN, DOMAIN);
    // Columns 0 and 1 hold the scale, column 3 the translation, and the last row
    // is (0, 0, 0, 1) — the transform is required to be affine.
    expect([at(m, 3), at(m, 7), at(m, 11), at(m, 15)]).toEqual([0, 0, 0, 1]);
    expect([at(m, 2), at(m, 6), at(m, 9), at(m, 14)]).toEqual([0, 0, 0, 0]);
    expect(at(m, 10)).toBe(1);
    expect(at(m, 1)).toBe(0);
    expect(at(m, 4)).toBe(0);
  });

  it('reuses the destination, so a per-frame rebuild does not allocate', () => {
    const out = new Float32Array(16);
    const m = orthographicTransform(DOMAIN, DOMAIN, out);
    expect(m).toBe(out);
    // Mutating the caller's array in place is what makes a zoom a uniform write
    // rather than a geometry upload.
    orthographicTransform({ min: 0, max: 8 }, { min: 0, max: 8 }, out);
    expect(at(out, 0)).toBe(0.25);
  });
});
