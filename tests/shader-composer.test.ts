import { describe, expect, it } from 'vitest';

import {
  ShaderComposeError,
  ShaderComposer,
  formatGlslConstant,
  slotMarker,
  type ShaderSlot,
} from '../src/core/ShaderComposer';

/**
 * The composer is the piece most likely to fail *silently* if it is wrong — a bad
 * variant compiles and renders nothing. So these tests are mostly about the error
 * paths: every documented failure mode is asserted to throw, with its own code.
 */

const template = `void main() {
${slotMarker('well')}
${slotMarker('optional')}
}
`;

const slots: Record<string, ShaderSlot> = {
  base: { at: 'well', code: 'base();' },
  tint: { at: 'well', requires: ['base'], code: 'tint();' },
  boost: { at: 'well', requires: ['base'], code: 'boost();' },
  extra: { at: 'optional', code: 'extra();' },
};

/** Capture a thrown ShaderComposeError, failing the test if nothing throws. */
function composeError(input: Parameters<ShaderComposer['compose']>[0]): ShaderComposeError {
  const composer = new ShaderComposer(slots);
  try {
    composer.compose(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ShaderComposeError);
    return error as ShaderComposeError;
  }
  throw new Error('expected compose() to throw');
}

describe('ShaderComposer', () => {
  it('substitutes a marker with the slot body', () => {
    const composer = new ShaderComposer(slots);
    const result = composer.compose({
      name: 'test',
      template,
      enabled: ['base'],
    });
    expect(result.code).toContain('base();');
    expect(result.code).not.toContain('@slot:');
    expect(result.applied).toEqual(['base']);
  });

  it('removes the marker of a defined but disabled slot', () => {
    const composer = new ShaderComposer(slots);
    const result = composer.compose({ name: 'test', template, enabled: ['base'] });
    // `optional` is a real position with a real slot, but nothing enabled it.
    expect(result.code).not.toContain('@slot:optional');
    expect(result.code).not.toContain('extra();');
  });

  it('concatenates sibling slots that share one position', () => {
    const composer = new ShaderComposer(slots);
    const result = composer.compose({
      name: 'test',
      template,
      enabled: ['base', 'tint', 'boost'],
    });
    expect(result.code).toContain('base();\ntint();\nboost();');
  });

  it('orders siblings by declared dependency, not by the enabled array', () => {
    const composer = new ShaderComposer(slots);
    const forwards = composer.compose({
      name: 'test',
      template,
      enabled: ['base', 'tint', 'boost'],
    });
    const backwards = composer.compose({
      name: 'test',
      template,
      enabled: ['boost', 'tint', 'base'],
    });
    // Reordering the *call site* must not change the shader. If it did, enabling
    // a feature could silently alter the meaning of an unrelated one.
    expect(backwards.code).toBe(forwards.code);
  });

  it('changes ordering when the registry declaration order changes', () => {
    const reversed = new ShaderComposer({
      base: slots['base'] as ShaderSlot,
      boost: slots['boost'] as ShaderSlot,
      tint: slots['tint'] as ShaderSlot,
      extra: slots['extra'] as ShaderSlot,
    });
    const result = reversed.compose({
      name: 'test',
      template,
      enabled: ['base', 'tint', 'boost'],
    });
    expect(result.code).toContain('base();\nboost();\ntint();');
  });

  it('resolves a dependency chain regardless of declaration order', () => {
    const chained = new ShaderComposer({
      // Declared last, depends on a slot declared before it, which depends on one
      // declared before that: the topo sort must still emit them in order.
      third: { at: 'well', requires: ['second'], code: 'third();' },
      second: { at: 'well', requires: ['first'], code: 'second();' },
      first: { at: 'well', code: 'first();' },
      extra: { at: 'optional', code: 'extra();' },
    });
    const result = chained.compose({
      name: 'test',
      template,
      enabled: ['third', 'second', 'first'],
    });
    expect(result.code).toContain('first();\nsecond();\nthird();');
  });

  it('produces byte-identical output and hash for identical input', () => {
    const composer = new ShaderComposer(slots);
    const a = composer.compose({ name: 'test', template, enabled: ['base', 'tint'] });
    const b = composer.compose({ name: 'test', template, enabled: ['base', 'tint'] });
    expect(b.code).toBe(a.code);
    expect(b.hash).toBe(a.hash);
  });

  it('produces a different hash when a parameter changes', () => {
    const parameterised = new ShaderComposer({
      base: { at: 'well', code: 'set({{value}});' },
      extra: { at: 'optional', code: 'extra();' },
    });
    const a = parameterised.compose({
      name: 'test',
      template,
      enabled: [['base', { value: 1 }]],
    });
    const b = parameterised.compose({
      name: 'test',
      template,
      enabled: [['base', { value: 2 }]],
    });
    expect(a.hash).not.toBe(b.hash);
  });

  it('formats integer parameters as GLSL floats', () => {
    const parameterised = new ShaderComposer({
      base: { at: 'well', code: 'set({{value}});' },
      extra: { at: 'optional', code: 'extra();' },
    });
    const result = parameterised.compose({
      name: 'test',
      template,
      enabled: [['base', { value: 3 }]],
    });
    // `set(3)` is a GLSL type error; `set(3.0)` is not.
    expect(result.code).toContain('set(3.0);');
  });

  it('passes string parameters through verbatim', () => {
    const parameterised = new ShaderComposer({
      base: { at: 'well', code: 'precision {{precision}} float;' },
      extra: { at: 'optional', code: 'extra();' },
    });
    const result = parameterised.compose({
      name: 'test',
      template,
      enabled: [['base', { precision: 'highp' }]],
    });
    expect(result.code).toContain('precision highp float;');
  });

  it('accepts a slot body produced by a function', () => {
    const functional = new ShaderComposer({
      base: {
        at: 'well',
        code: (params) => `#define MODE ${String(params['mode'])}`,
      },
      extra: { at: 'optional', code: 'extra();' },
    });
    const result = functional.compose({
      name: 'test',
      template,
      enabled: [['base', { mode: 2 }]],
    });
    expect(result.code).toContain('#define MODE 2');
  });

  it('exposes registered slot names and positions', () => {
    const composer = new ShaderComposer(slots);
    expect(composer.slotNames).toEqual(['base', 'tint', 'boost', 'extra']);
    expect([...composer.positions].sort()).toEqual(['optional', 'well']);
  });
});

describe('ShaderComposer error paths', () => {
  it('rejects a marker that no slot writes to', () => {
    const error = composeError({
      name: 'test',
      template: `void main() { ${slotMarker('typo')} }`,
      enabled: ['base'],
    });
    expect(error.code).toBe('shader/template-marker-unmatched');
  });

  it('rejects enabling a slot whose position the template lacks', () => {
    const error = composeError({
      name: 'test',
      template: `void main() { ${slotMarker('well')} }`,
      enabled: ['base', 'extra'],
    });
    expect(error.code).toBe('shader/slot-unconsumed');
  });

  it('rejects an unknown slot name', () => {
    const error = composeError({ name: 'test', template, enabled: ['nope'] });
    expect(error.code).toBe('shader/unknown-slot');
  });

  it('rejects enabling the same slot twice', () => {
    const error = composeError({ name: 'test', template, enabled: ['base', 'base'] });
    expect(error.code).toBe('shader/unknown-slot');
  });

  it('rejects a missing dependency', () => {
    // `tint` requires `base`; enabling it alone would blend against an
    // uninitialised value.
    const error = composeError({ name: 'test', template, enabled: ['tint'] });
    expect(error.code).toBe('shader/missing-dependency');
    expect(error.detail).toMatchObject({ missing: 'base' });
  });

  it('rejects a dependency cycle', () => {
    const cyclic = new ShaderComposer({
      a: { at: 'well', requires: ['b'], code: 'a();' },
      b: { at: 'well', requires: ['a'], code: 'b();' },
      extra: { at: 'optional', code: 'extra();' },
    });
    expect(() => cyclic.compose({ name: 'test', template, enabled: ['a', 'b'] })).toThrowError(
      /shader\/dependency-cycle/,
    );
  });

  it('rejects an unresolved parameter placeholder', () => {
    const parameterised = new ShaderComposer({
      base: { at: 'well', code: 'set({{value}});' },
      extra: { at: 'optional', code: 'extra();' },
    });
    expect(() => parameterised.compose({ name: 'test', template, enabled: ['base'] })).toThrowError(
      /shader\/unresolved-param/,
    );
  });

  it('rejects a non-finite shader constant', () => {
    expect(() => formatGlslConstant(Number.NaN)).toThrowError(/must be finite/);
    expect(() => formatGlslConstant(Number.POSITIVE_INFINITY)).toThrowError(/must be finite/);
  });

  it('accepts dotted and hyphenated names', () => {
    // These names only ever appear inside `/* @slot:name *\/` marker comments,
    // never in GLSL itself, so GLSL's identifier rules do not bind them and
    // namespacing is free.
    expect(
      () =>
        new ShaderComposer({
          'color.base': { at: 'color.well', code: 'base();' },
          'anti-alias.off': { at: 'color.well', code: 'aa();' },
        }),
    ).not.toThrow();
  });

  it('rejects a name that could not survive a marker scan', () => {
    const rejects = (slots: Record<string, ShaderSlot>, pattern: RegExp): void => {
      try {
        new ShaderComposer(slots);
      } catch (error) {
        expect(error).toBeInstanceOf(ShaderComposeError);
        expect((error as ShaderComposeError).message).toMatch(pattern);
        return;
      }
      throw new Error('expected the composer to reject the definition');
    };

    rejects({ 'bad name': { at: 'well', code: '' } }, /slot name "bad name" is invalid/);
    rejects({ '1st': { at: 'well', code: '' } }, /slot name "1st" is invalid/);
    rejects({ ok: { at: 'bad/name', code: '' } }, /targets invalid position "bad\/name"/);
  });

  it('never returns partially composed source', () => {
    const composer = new ShaderComposer(slots);
    // `tint` is listed second: if composition were incremental and returned on
    // failure, a caller could still observe a half-built string.
    expect(() =>
      composer.compose({ name: 'test', template, enabled: ['base', 'tint'] }),
    ).not.toThrow();
    expect(() => composer.compose({ name: 'test', template, enabled: ['tint'] })).toThrow(
      ShaderComposeError,
    );
  });
});

describe('ShaderComposer.validate', () => {
  it('accepts a consistent template without producing source', () => {
    const composer = new ShaderComposer(slots);
    expect(() => {
      composer.validate({ name: 'test', template, enabled: ['base'] });
    }).not.toThrow();
  });

  it('reports the same failures as compose', () => {
    const composer = new ShaderComposer(slots);
    expect(() => {
      composer.validate({ name: 'test', template, enabled: ['tint'] });
    }).toThrowError(/shader\/missing-dependency/);
    expect(() => {
      composer.validate({ name: 'test', template: slotMarker('nope'), enabled: ['base'] });
    }).toThrowError(/shader\/template-marker-unmatched/);
  });
});

describe('formatGlslConstant', () => {
  it('emits floats for integers and passes strings through', () => {
    expect(formatGlslConstant(0)).toBe('0.0');
    expect(formatGlslConstant(-2)).toBe('-2.0');
    expect(formatGlslConstant(0.5)).toBe('0.5');
    expect(formatGlslConstant('highp')).toBe('highp');
  });
});
