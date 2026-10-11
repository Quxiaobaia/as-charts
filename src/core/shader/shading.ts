import type { ShaderSlot } from '../ShaderComposer';

/**
 * The fragment-stage wells every 2D primitive writes into.
 *
 * ## Why this is shared rather than duplicated per primitive
 *
 * The triangle pipeline (M0) and the line pipeline (M1) want the same three
 * things — a base colour, an optional highlight blend, an opacity multiplier —
 * applied in an order that is load-bearing: a highlight emitted before the base
 * assignment blends against a zero-initialised colour and silently produces a
 * black outline instead of a tinted one.
 *
 * That ordering is expressed by `requires`, and `requires` is exactly the kind
 * of thing that gets copied once and then diverges. Two copies of the same three
 * slots is how "the two primitives render the same colour" stops being true.
 *
 * ## Contract with the vertex stage
 *
 * Every primitive that uses these slots must declare
 *
 * ```glsl
 * out vec3 vColor;
 * ```
 *
 * and its fragment template must provide both the `colorFragment` and
 * `antiAlias` marker positions plus the declarations those bodies assign to:
 *
 * ```glsl
 * vec4 colorFragment = vec4(0.0);
 * float antiAliasFactor = 1.0;
 * ```
 *
 * The template owns the declarations, the slots own the assignments. Keeping it
 * that way means a slot can be added without touching any template, which is the
 * whole reason a public well is reserved before it has two occupants.
 *
 * `antiAlias.off` is currently the only occupant of its well. Analytic edge
 * coverage (`antiAlias.edge`, via `fwidth`) needs `gl.enable(BLEND)`, and blend
 * is global GL state that no layer may own — it lands with the layout owner in
 * M1-c. The position and the identity slot exist now so that adding it is a slot
 * registration, not a template edit.
 */
export const SHADING_FRAGMENT_SLOTS: Readonly<Record<string, ShaderSlot>> = {
  'color.base': {
    at: 'colorFragment',
    code: '  colorFragment = vec4(vColor, 1.0);',
  },
  /**
   * Blend the base colour toward a highlight colour.
   *
   * `requires: ['color.base']` is load-bearing: it is what guarantees the base
   * assignment is emitted before this mix, so enabling highlight cannot produce a
   * blend against a zero-initialised colour.
   */
  'color.highlight': {
    at: 'colorFragment',
    requires: ['color.base'],
    code: '  colorFragment.rgb = mix(colorFragment.rgb, vec3({{r}}, {{g}}, {{b}}), {{strength}});',
  },
  /** Multiplies alpha, so it must also run after the base assignment. */
  'color.opacity': {
    at: 'colorFragment',
    requires: ['color.base'],
    code: '  colorFragment.a *= {{opacity}};',
  },
  /** No coverage falloff. See the note above on where analytic AA lands. */
  'antiAlias.off': {
    at: 'antiAlias',
    code: '  antiAliasFactor = 1.0;',
  },
};
