/**
 * The data-space → clip-space mapping, as a matrix.
 *
 * Trivial arithmetic, but it lives in one place for a specific reason: the line
 * shader converts clip → device pixels *inside* the vertex shader to compute a
 * screen-space normal. If the forward mapping and that conversion disagree by a
 * factor or an offset, the line width comes out wrong by the same factor — and a
 * wrong-but-uniform width is very hard to notice by eye. One builder, one
 * inverse (`unprojectPoint`), exercised together in the e2e line check.
 *
 * A `Float32Array` in column-major order, matching what `uniformMatrix4fv`
 * expects. The last row is `(0, 0, 0, 1)`: the transform is required to be
 * affine, because the shader divides by `w` once on the way in and works in 2D
 * from there. A perspective matrix would need the `w` restored on the way out
 * (the original sketch did so) and buys nothing a chart wants.
 */
export interface Domain {
  readonly min: number;
  readonly max: number;
}

/**
 * Build the canonical data → clip matrix.
 *
 * `x.min` maps to clip `-1` (left) and `x.max` to `+1` (right); `y.min` maps to
 * `-1` (bottom) and `y.max` to `+1` (top), which is the GL convention. The y flip
 * relative to screen coordinates happens later, in the shader's
 * `unprojectPoint`, exactly once.
 *
 * A degenerate domain (a flat series, or a `count` of 1) collapses to clip 0 —
 * the centre of the axis. Mapping it to an edge instead would present a flat line
 * as an axis artefact at the boundary rather than as a line in the middle, which
 * is the same choice `Scale` makes for a folded domain.
 *
 * @param out Optional destination, so a caller can rebuild every frame without
 *   allocating. Must hold at least 16 elements.
 */
export function orthographicTransform(
  x: Domain,
  y: Domain,
  out: Float32Array = new Float32Array(16),
): Float32Array {
  const xSpan = x.max - x.min;
  const ySpan = y.max - y.min;

  const sx = xSpan === 0 || !Number.isFinite(xSpan) ? 0 : 2 / xSpan;
  const sy = ySpan === 0 || !Number.isFinite(ySpan) ? 0 : 2 / ySpan;
  const tx = xSpan === 0 || !Number.isFinite(xSpan) ? 0 : -(x.max + x.min) / xSpan;
  const ty = ySpan === 0 || !Number.isFinite(ySpan) ? 0 : -(y.max + y.min) / ySpan;

  out[0] = sx;
  out[1] = 0;
  out[2] = 0;
  out[3] = 0;

  out[4] = 0;
  out[5] = sy;
  out[6] = 0;
  out[7] = 0;

  out[8] = 0;
  out[9] = 0;
  out[10] = 1;
  out[11] = 0;

  out[12] = tx;
  out[13] = ty;
  out[14] = 0;
  out[15] = 1;

  return out;
}
