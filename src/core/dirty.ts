/**
 * Invalidation bit flags.
 *
 * The single biggest performance lever in this engine is *not rendering*. Every
 * stage of a frame consults exactly one bit below and returns early when it is
 * clear, so the cost of a no-op frame is a handful of bitwise ANDs.
 *
 * A design constraint worth stating explicitly: {@link Dirty.Style} is
 * deliberately **not** connected to {@link Dirty.Geometry}. Changing a stroke
 * colour or width must never rebuild per-instance attributes for a million-point
 * series — it only touches uniforms.
 */
export const Dirty = {
  /** Nothing changed; the frame is a no-op. */
  None: 0x00,
  /** Series values, counts or ordering changed. */
  Data: 0x01,
  /** Instance geometry must be rebuilt from data (layout / LOD selection). */
  Geometry: 0x02,
  /** CPU-side buffers changed and must be uploaded to the GPU. */
  Upload: 0x04,
  /** Text layer content changed. */
  Text: 0x08,
  /** Axis ranges or their pixel mapping changed. */
  Axis: 0x10,
  /** Canvas size or device pixel ratio changed. */
  Viewport: 0x20,
  /** Uniform-only change (colour, thickness, opacity). */
  Style: 0x40,
  /**
   * The drawing buffer must be repainted even though no state changed.
   *
   * Browsers are free to discard a canvas' back buffer (tab switches, compositor
   * pressure, `preserveDrawingBuffer: false`). Regaining visibility therefore has
   * to force a repaint without lying about which stage is stale.
   */
  Present: 0x80,
} as const;

/** A bitmask of {@link Dirty} flags. */
export type DirtyFlags = number;

/** Every flag set. Used by `requestAll()`. */
export const DirtyAll: DirtyFlags =
  Dirty.Data |
  Dirty.Geometry |
  Dirty.Upload |
  Dirty.Text |
  Dirty.Axis |
  Dirty.Viewport |
  Dirty.Style |
  Dirty.Present;

/**
 * Expand a flag set to include everything it implies downstream.
 *
 * The dependency chain is intentionally shallow and explicit:
 *
 * ```
 * Data ──▶ Geometry ──▶ Upload
 * ```
 *
 * Everything else (`Axis`, `Viewport`, `Style`, `Text`) is independent and is
 * resolved by the stage that owns it. Keeping this function allocation-free
 * matters: it runs once per `request()` call.
 */
export function propagateDirty(flags: DirtyFlags): DirtyFlags {
  let out = flags;
  if ((out & Dirty.Data) !== 0) out |= Dirty.Geometry;
  if ((out & Dirty.Geometry) !== 0) out |= Dirty.Upload;
  return out;
}

/** True when *any* flag in `mask` is set in `flags`. */
export function hasDirty(flags: DirtyFlags, mask: DirtyFlags): boolean {
  return (flags & mask) !== 0;
}

/** True when a redraw is required at all. */
export function shouldRender(flags: DirtyFlags): boolean {
  return flags !== Dirty.None;
}

const DIRTY_NAMES: ReadonlyArray<readonly [DirtyFlags, string]> = [
  [Dirty.Data, 'Data'],
  [Dirty.Geometry, 'Geometry'],
  [Dirty.Upload, 'Upload'],
  [Dirty.Text, 'Text'],
  [Dirty.Axis, 'Axis'],
  [Dirty.Viewport, 'Viewport'],
  [Dirty.Style, 'Style'],
  [Dirty.Present, 'Present'],
];

/**
 * Human-readable flag list, e.g. `"Data|Geometry"`.
 *
 * Allocates on purpose — for diagnostics and test assertions only, never on the
 * hot path.
 */
export function describeDirty(flags: DirtyFlags): string {
  if (flags === Dirty.None) return 'None';
  const parts: string[] = [];
  for (const [bit, name] of DIRTY_NAMES) {
    if ((flags & bit) !== 0) parts.push(name);
  }
  return parts.join('|');
}
