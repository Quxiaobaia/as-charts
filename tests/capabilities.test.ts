import { describe, expect, it } from 'vitest';

import {
  auditCapabilities,
  probeCapabilities,
  resolveDevicePixelRatio,
} from '../src/core/capabilities';
import { ALL_EXTENSIONS, createMockGL } from './utils/mock-gl';

describe('probeCapabilities', () => {
  it('reports every optional feature present on a fully capable context', () => {
    const mock = createMockGL({ extensions: ALL_EXTENSIONS });
    const capabilities = probeCapabilities(mock.gl);

    expect(capabilities.webgl2).toBe(true);
    expect(capabilities.colorBufferFloat).toBe(true);
    expect(capabilities.textureFloatLinear).toBe(true);
    expect(capabilities.multiDraw).toBe(true);
    expect(capabilities.timerQuery).toBe(true);
    expect(capabilities.anisotropicFilter).toBe(true);
    expect(auditCapabilities(capabilities).degraded).toBe(false);
  });

  it('reads the context limits once', () => {
    const mock = createMockGL({ parameters: { [0x0d33]: 16384, [0x8d57]: 8 } });
    const capabilities = probeCapabilities(mock.gl);

    expect(capabilities.maxTextureSize).toBe(16384);
    expect(capabilities.maxSamples).toBe(8);
    expect(capabilities.maxVertexAttribs).toBe(16);
  });

  it('reads MAX_TEXTURE_MAX_ANISOTROPY_EXT when the extension is present', () => {
    const mock = createMockGL({
      extensions: ['EXT_texture_filter_anisotropic'],
      parameters: { [0x84ff]: 16 },
    });
    const capabilities = probeCapabilities(mock.gl);

    expect(capabilities.anisotropicFilter).toBe(true);
    expect(capabilities.maxAnisotropy).toBe(16);
  });

  it('falls back to sane defaults when getParameter returns nonsense', () => {
    const mock = createMockGL({ parameters: { [0x0d33]: Number.NaN } });
    const capabilities = probeCapabilities(mock.gl);

    expect(capabilities.maxTextureSize).toBe(2048);
    expect(capabilities.maxSamples).toBe(4);
  });

  it('survives a context that throws from getExtension', () => {
    const mock = createMockGL();
    const throwing = mock.gl as unknown as { getExtension: () => never };
    throwing.getExtension = () => {
      throw new Error('context lost');
    };

    // Capability probing runs during construction; it must not be the thing that
    // makes a renderer impossible to create on an unusual driver.
    expect(() => probeCapabilities(mock.gl)).not.toThrow();
    expect(probeCapabilities(mock.gl).multiDraw).toBe(false);
  });
});

describe('auditCapabilities', () => {
  it('names every missing feature and its fallback', () => {
    const mock = createMockGL({ extensions: [], parameters: { [0x8d57]: 0 } });
    const report = auditCapabilities(probeCapabilities(mock.gl));

    expect(report.degraded).toBe(true);
    expect(report.missing).toEqual([
      'texture-float-linear',
      'color-buffer-float',
      'max-samples',
      'multi-draw',
      'timer-query',
      'anisotropic-filter',
    ]);
    // One documented fallback per missing feature: a gap without a stated
    // fallback is a bug in the report, not an acceptable difference.
    expect(report.fallbacks).toHaveLength(report.missing.length);
    for (const fallback of report.fallbacks) expect(fallback.length).toBeGreaterThan(10);
  });
});

describe('resolveDevicePixelRatio', () => {
  it('forces 1 when explicitly disabled', () => {
    expect(resolveDevicePixelRatio(false, 400, 300)).toBe(1);
  });

  it('honours an explicit number', () => {
    expect(resolveDevicePixelRatio(2, 400, 300)).toBe(2);
  });

  it('ignores a non-positive or non-finite explicit value', () => {
    // Falls back to the ambient ratio rather than to a broken 0/NaN.
    expect(resolveDevicePixelRatio(0, 400, 300)).toBeGreaterThan(0);
    expect(resolveDevicePixelRatio(Number.NaN, 400, 300)).toBeGreaterThan(0);
  });

  it('clamps a high ratio so a 4K panel cannot cost 9x the rasterisation', () => {
    // 3000x2000 at ratio 3 would be 54M pixels; the budget is 8M.
    const ratio = resolveDevicePixelRatio(3, 3000, 2000, 8_000_000);
    expect(ratio).toBeLessThan(3);
    expect(3000 * 2000 * ratio * ratio).toBeLessThanOrEqual(8_000_000 + 1);
  });

  it('never drops below 1 when the element already exceeds the budget', () => {
    // A huge element still has to render at 1x; downscaling below native would
    // blur the whole chart to save memory the caller already committed to.
    expect(resolveDevicePixelRatio(3, 5000, 5000, 1_000_000)).toBe(3);
  });

  it('leaves the ratio alone for degenerate geometry', () => {
    expect(resolveDevicePixelRatio(2, 0, 0)).toBe(2);
    expect(resolveDevicePixelRatio(2, Number.NaN, 300)).toBe(2);
  });
});
