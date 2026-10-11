import { hashHex } from './hash';

/**
 * Shader assembly by **slot positions**, not by string surgery.
 *
 * `LightningChart JS` ships a full runtime GLSL rewriter: 25 shader "features"
 * each emit string-surgery instructions (insert before `main`, insert at end of
 * `main`, delete a line…) that mutate a source string in a fixed order. Its
 * colour features all resolve by repeatedly `lastIndexOf`-ing the text
 * `"colorFragment ="` and appending, so the *final* colour depends on the order
 * features happen to be applied — a real ordering dependency expressed as an
 * accident of string searching.
 *
 * That machinery earns its keep only because LCJS must cover
 * `features × primitives × GL versions × precisions`. Below roughly 20 features
 * it is a net loss: the surgery has no grammar, so a typo fails silently and
 * produces a shader that compiles and then renders nothing.
 *
 * This composer keeps the valuable idea — assemble shaders from small declarative
 * pieces, including chained writes into one "public well" — and makes the
 * ordering explicit instead of incidental:
 *
 * - A template declares **positions** via `{@link slotMarker}` comments.
 * - A slot declares the position it writes into (`at`). Several slots may share
 *   one position; their code is concatenated in **declared dependency order**.
 * - `requires` fixes that order, so "highlight must run after colour" is stated
 *   rather than inferred.
 * - The result is content-hashable, so programs can be cached and snapshotted.
 *
 * | Situation | Result |
 * |---|---|
 * | Marker names a position some slot writes to | position filled by enabled slots |
 * | Marker names no known position | `shader/template-marker-unmatched` |
 * | Position has no enabled slot | marker removed — this is how optional slots work |
 * | Slot enabled, template has no marker for its position | `shader/slot-unconsumed` |
 * | Enabled slot requires a disabled slot | `shader/missing-dependency` |
 * | Requirement cycle | `shader/dependency-cycle` |
 * | Slot code references `{{param}}` with no value | `shader/unresolved-param` |
 */

/** Parameters substituted into `{{name}}` placeholders inside slot code. */
export type ShaderParams = Readonly<Record<string, string | number>>;

/** One composable piece of GLSL, targeting a marker position. */
export interface ShaderSlot {
  /**
   * Marker position this slot writes into.
   *
   * Multiple slots may share a position; their bodies are emitted in dependency
   * order. This is how a "public well" such as `colorFragment` gets several
   * contributors without anyone doing string surgery.
   */
  readonly at: string;
  /** Emitted in place of the marker. A function form may vary by parameter. */
  readonly code: string | ((params: ShaderParams) => string);
  /** Slots that must be applied before this one. */
  readonly requires?: readonly string[];
}

/** `'name'` or `['name', { strength: 0.5 }]`. */
export type ShaderEnablement = string | readonly [string, ShaderParams];

export interface ShaderInput {
  /** Identifies the shader in error messages and snapshots. */
  readonly name: string;
  /** GLSL source containing slot markers built by {@link slotMarker}. */
  readonly template: string;
  /**
   * Slots to apply.
   *
   * Sibling slots that share a position are ordered by `requires` first, then by
   * the registry's declaration order — never by this array, so reordering the
   * list of enabled features cannot silently change shader output.
   */
  readonly enabled: readonly ShaderEnablement[];
}

export interface ComposedShader {
  readonly name: string;
  readonly code: string;
  /** Slots applied, in application order. */
  readonly applied: readonly string[];
  /** Content hash of `code`, used as the program cache key. */
  readonly hash: string;
}

export type ShaderComposeErrorCode =
  | 'shader/unknown-slot'
  | 'shader/missing-dependency'
  | 'shader/dependency-cycle'
  | 'shader/slot-unconsumed'
  | 'shader/template-marker-unmatched'
  | 'shader/unresolved-param';

/**
 * Structural shader assembly failures.
 *
 * These are *developer* errors — a typo in a slot name, a template that drifted
 * from its slots — so they always throw, even when diagnostics are configured as
 * `'silent'`. A wrong shader that compiles is strictly worse than a loud crash at
 * startup, because the symptom (nothing renders) points nowhere near the cause.
 */
export class ShaderComposeError extends Error {
  readonly code: ShaderComposeErrorCode;
  readonly detail: unknown;

  constructor(code: ShaderComposeErrorCode, message: string, detail?: unknown) {
    super(`[${code}] ${message}`);
    this.name = 'ShaderComposeError';
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Slot and position names.
 *
 * Dots and hyphens are allowed because namespacing reads better (`color.base`,
 * `antiAlias.off`, `anti-alias.off`) and these names only ever appear inside
 * `/* @slot:name *\/` marker comments — never in GLSL itself, so they are not
 * bound by GLSL's identifier rules. Restricting them to identifier syntax would
 * be a constraint with nothing behind it.
 */
const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const MARKER_SCAN = /\/\* @slot:([A-Za-z_][A-Za-z0-9_.-]*)\s*\*\//g;
const PARAM_PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

/** Build the marker for a position. Use this instead of hand-writing syntax. */
export function slotMarker(position: string): string {
  return `/* @slot:${position} */`;
}

export class ShaderComposer {
  readonly #slots: Readonly<Record<string, ShaderSlot>>;
  readonly #names: readonly string[];
  readonly #positions: ReadonlySet<string>;

  constructor(slots: Readonly<Record<string, ShaderSlot>>) {
    this.#slots = slots;
    this.#names = Object.freeze(Object.keys(slots));

    const positions = new Set<string>();
    for (const name of this.#names) {
      if (!NAME.test(name)) {
        throw new ShaderComposeError(
          'shader/unknown-slot',
          `slot name "${name}" is invalid; use letters, digits, "_", "." or "-"`,
          { name },
        );
      }
      const slot = slots[name];
      if (slot === undefined) continue;
      if (!NAME.test(slot.at)) {
        throw new ShaderComposeError(
          'shader/unknown-slot',
          `slot "${name}" targets invalid position "${slot.at}"`,
          { name, at: slot.at },
        );
      }
      positions.add(slot.at);
    }
    this.#positions = positions;
  }

  /** Slot names known to this composer, in declaration order. */
  get slotNames(): readonly string[] {
    return this.#names;
  }

  /** Marker positions any registered slot can write to. */
  get positions(): readonly string[] {
    return [...this.#positions];
  }

  /**
   * Assemble a shader.
   *
   * @throws {ShaderComposeError} on any structural mismatch. Never returns
   *   partially composed source.
   */
  compose(input: ShaderInput): ComposedShader {
    const enabled = this.#normalise(input);
    const markers = this.#findMarkers(input.template);

    // A marker for a position nothing writes to can never be filled — a typo in
    // either the template or the registry. Catch it before touching the source.
    for (const position of markers) {
      if (!this.#positions.has(position)) {
        throw new ShaderComposeError(
          'shader/template-marker-unmatched',
          `"${input.name}" declares ${slotMarker(position)} but no slot writes to that position`,
          { shader: input.name, position, known: this.positions },
        );
      }
    }

    // Enabling a slot whose position the template lacks means the template drifted
    // from its slots. Silent success here is precisely the string-surgery failure
    // mode this design exists to avoid.
    for (const name of enabled.keys()) {
      const slot = this.#slots[name];
      if (slot === undefined) continue;
      if (!markers.includes(slot.at)) {
        throw new ShaderComposeError(
          'shader/slot-unconsumed',
          `slot "${name}" writes to position "${slot.at}", but "${input.name}" has no ${slotMarker(slot.at)} marker`,
          { shader: input.name, slot: name, at: slot.at },
        );
      }
    }

    const order = this.#resolveOrder(enabled, input.name);

    let code = input.template;
    const applied: string[] = [];
    for (const position of markers) {
      const pieces: string[] = [];
      for (const name of order) {
        const slot = this.#slots[name];
        if (slot === undefined || slot.at !== position) continue;
        pieces.push(this.#renderSlot(name, enabled.get(name) ?? {}));
        applied.push(name);
      }
      code = code.replace(slotMarker(position), pieces.join('\n'));
    }

    const leftovers = this.#findMarkers(code);
    if (leftovers.length > 0) {
      throw new ShaderComposeError(
        'shader/template-marker-unmatched',
        `internal: markers survived composition of "${input.name}": ${leftovers.join(', ')}`,
        { shader: input.name, markers: leftovers },
      );
    }

    return Object.freeze({
      name: input.name,
      code,
      applied: Object.freeze(applied),
      hash: hashHex(code),
    });
  }

  /** Validate without producing source. Useful in tests and capability checks. */
  validate(input: ShaderInput): void {
    const enabled = this.#normalise(input);
    const markers = this.#findMarkers(input.template);
    for (const position of markers) {
      if (!this.#positions.has(position)) {
        throw new ShaderComposeError(
          'shader/template-marker-unmatched',
          `"${input.name}" declares ${slotMarker(position)} but no slot writes to that position`,
          { shader: input.name, position },
        );
      }
    }
    for (const name of enabled.keys()) {
      const slot = this.#slots[name];
      if (slot === undefined) continue;
      if (!markers.includes(slot.at)) {
        throw new ShaderComposeError(
          'shader/slot-unconsumed',
          `slot "${name}" writes to position "${slot.at}", but "${input.name}" has no ${slotMarker(slot.at)} marker`,
          { shader: input.name, slot: name, at: slot.at },
        );
      }
    }
    this.#resolveOrder(enabled, input.name);
  }

  #normalise(input: ShaderInput): Map<string, ShaderParams> {
    const map = new Map<string, ShaderParams>();
    for (let i = 0; i < input.enabled.length; i += 1) {
      const raw = input.enabled[i];
      if (raw === undefined) continue;
      const name = typeof raw === 'string' ? raw : raw[0];
      const params: ShaderParams = typeof raw === 'string' ? {} : raw[1];

      if (!(name in this.#slots)) {
        throw new ShaderComposeError(
          'shader/unknown-slot',
          `"${input.name}" enables unknown slot "${name}"`,
          { shader: input.name, slot: name, known: this.#names },
        );
      }
      if (map.has(name)) {
        throw new ShaderComposeError(
          'shader/unknown-slot',
          `"${input.name}" enables slot "${name}" twice`,
          { shader: input.name, slot: name },
        );
      }
      map.set(name, params);
    }
    return map;
  }

  /**
   * Depth-first topological sort over `requires`.
   *
   * Deterministic: roots are visited in registry declaration order, so the same
   * input always produces byte-identical output. That is what makes shader
   * snapshot tests meaningful rather than decorative.
   */
  #resolveOrder(enabled: Map<string, ShaderParams>, shader: string): readonly string[] {
    const order: string[] = [];
    const done = new Set<string>();
    const onStack = new Set<string>();

    const visit = (name: string, chain: string[]): void => {
      if (done.has(name)) return;
      if (onStack.has(name)) {
        throw new ShaderComposeError(
          'shader/dependency-cycle',
          `slot dependency cycle: ${[...chain, name].join(' -> ')}`,
          { shader, chain: [...chain, name] },
        );
      }
      const requirements = this.#slots[name]?.requires;
      if (requirements !== undefined) {
        onStack.add(name);
        for (const requirement of requirements) {
          if (!enabled.has(requirement)) {
            throw new ShaderComposeError(
              'shader/missing-dependency',
              `slot "${name}" requires "${requirement}", which is not enabled in "${shader}"`,
              { shader, slot: name, missing: requirement },
            );
          }
          visit(requirement, [...chain, name]);
        }
        onStack.delete(name);
      }
      done.add(name);
      order.push(name);
    };

    for (const name of this.#names) {
      if (enabled.has(name)) visit(name, []);
    }
    return order;
  }

  #renderSlot(name: string, params: ShaderParams): string {
    const slot = this.#slots[name];
    if (slot === undefined) throw new ShaderComposeError('shader/unknown-slot', name);
    const body = typeof slot.code === 'function' ? slot.code(params) : slot.code;
    return body.replace(PARAM_PLACEHOLDER, (_match: string, key: string) => {
      const value = params[key];
      if (value === undefined) {
        throw new ShaderComposeError(
          'shader/unresolved-param',
          `slot "${name}" references {{${key}}} but no value was provided`,
          { slot: name, param: key, provided: Object.keys(params) },
        );
      }
      return formatGlslConstant(value);
    });
  }

  #findMarkers(source: string): readonly string[] {
    const found: string[] = [];
    MARKER_SCAN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = MARKER_SCAN.exec(source)) !== null) {
      const position = match[1];
      if (position !== undefined && !found.includes(position)) found.push(position);
    }
    return found;
  }
}

/**
 * Emit a GLSL constant.
 *
 * Non-finite numbers are rejected here rather than in the driver: a `NaN` seeded
 * into a shader constant usually still compiles, and then makes the whole pass
 * render nothing — a far worse debugging experience than a startup error.
 */
export function formatGlslConstant(value: string | number): string {
  if (typeof value === 'string') return value;
  if (!Number.isFinite(value)) {
    throw new ShaderComposeError(
      'shader/unresolved-param',
      `shader constant must be finite, received ${String(value)}`,
      { value },
    );
  }
  return Number.isInteger(value) ? `${value}.0` : String(value);
}
