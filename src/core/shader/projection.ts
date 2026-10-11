/**
 * The pixel ↔ clip pair, shared by every 2D primitive.
 *
 * Both directions live here on purpose. Two independent reasons:
 *
 * 1. **The y flip must happen exactly once.** Clip space is y-up, the canvas and
 *    mouse events are y-down. A primitive that flips on the way in *and* on the
 *    way out produces a mirror image that still looks plausible for a symmetric
 *    test case — the classic failure that survives a smoke test. Keeping
 *    `projectPoint` and `unprojectPoint` adjacent, and documented as inverses,
 *    makes "flips once" a property of one file rather than of every shader.
 * 2. **A screen-space computation needs both.** Lines compute a direction from
 *    projected endpoints and then write back a screen-space offset. Splitting
 *    the pair across two modules is how the two halves drift apart and the
 *    offset ends up in the wrong units — see `line.ts` for the factor-of-two
 *    bug that produces.
 */

/**
 * Canvas pixels (y down) → clip space (y up).
 *
 * Written into the `transform` slot position by the primitive templates, so a
 * caller can replace it with {@link CLIP_SPACE_GLSL}.
 */
export const PIXEL_TO_CLIP_GLSL = `vec2 projectPoint(vec2 point, vec2 resolution) {
  vec2 uv = point / resolution;
  return vec2(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
}`;

/** Identity projection, for callers that already work in clip space. */
export const CLIP_SPACE_GLSL = `vec2 projectPoint(vec2 point, vec2 resolution) {
  return point;
}`;

/**
 * Clip space (y up) → canvas pixels (y down). Exact inverse of
 * {@link PIXEL_TO_CLIP_GLSL}.
 *
 * Not a slot: a primitive either needs screen-space arithmetic or it does not,
 * and one that does always needs the inverse as well as the forward map. Making
 * it selectable would only create the option of choosing wrongly.
 */
export const CLIP_TO_PIXEL_GLSL = `vec2 unprojectPoint(vec2 clip, vec2 resolution) {
  return vec2((clip.x * 0.5 + 0.5) * resolution.x, (0.5 - clip.y * 0.5) * resolution.y);
}`;
