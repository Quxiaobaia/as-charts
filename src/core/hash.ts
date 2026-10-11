/**
 * FNV-1a 32-bit hash.
 *
 * Used as the shader program cache key. It must be *stable* across runs and
 * platforms — a random or time-based id would defeat the cache and silently
 * recompile every shader on every page load.
 */
export function fnv1a32(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 8-character lowercase hex digest of {@link fnv1a32}. */
export function hashHex(input: string): string {
  return fnv1a32(input).toString(16).padStart(8, '0');
}
