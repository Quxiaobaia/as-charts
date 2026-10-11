import type { ResourcePool } from '../core/ResourcePool';

/**
 * A GLSL compile or link failure.
 *
 * The payload carries a **line-numbered excerpt** of the offending source. This
 * is the payoff of composing shaders from templates rather than mutating strings
 * at runtime: when a variant fails, the error points at the exact line of the
 * exact variant that failed, instead of at a driver log full of minified code.
 */
export class ShaderCompileError extends Error {
  readonly stage: 'vertex' | 'fragment' | 'link';
  readonly log: string;
  readonly source: string;

  constructor(stage: 'vertex' | 'fragment' | 'link', log: string, source: string, name: string) {
    super(`${name}: ${stage} shader failed to compile\n${log}\n${numberLines(source)}`);
    this.name = 'ShaderCompileError';
    this.stage = stage;
    this.log = log;
    this.source = source;
  }
}

function numberLines(source: string): string {
  const lines = source.split('\n');
  const width = String(lines.length).length;
  const numbered: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    numbered.push(`${String(i + 1).padStart(width, ' ')} | ${lines[i] ?? ''}`);
  }
  return numbered.join('\n');
}

export interface ProgramSpec {
  /** Identifies the variant in errors and cache keys. */
  readonly name: string;
  /** Content hash of the vertex/fragment pair, from the shader composer. */
  readonly key: string;
  readonly vertexSource: string;
  readonly fragmentSource: string;
}

/**
 * One linked GLSL program, with uniform locations resolved once.
 *
 * Two details exist purely to keep the hot path allocation-free:
 *
 * - Uniform locations are enumerated at link time and stored in a `Map`. Calling
 *   `getUniformLocation(name)` per frame would allocate a JS string for the name
 *   on every draw.
 * - Attribute locations come from `layout(location = …)` in the source, so no
 *   `getAttribLocation` lookup is needed at all.
 */
export class Program {
  readonly name: string;
  readonly key: string;
  readonly handle: WebGLProgram;

  readonly #gl: WebGL2RenderingContext;
  readonly #pool: ResourcePool;
  readonly #uniforms = new Map<string, WebGLUniformLocation | null>();

  constructor(gl: WebGL2RenderingContext, pool: ResourcePool, spec: ProgramSpec) {
    this.#gl = gl;
    this.#pool = pool;
    this.name = spec.name;
    this.key = spec.key;

    const vertex = this.#compile(gl.VERTEX_SHADER, spec.vertexSource, 'vertex', spec.name);
    const fragment = this.#compile(gl.FRAGMENT_SHADER, spec.fragmentSource, 'fragment', spec.name);

    const program = pool.track('program', gl.createProgram(), 0, spec.name);
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);

    // Shaders are no longer needed once linked; releasing them immediately keeps
    // the live-object count honest instead of inflating it until destroy().
    gl.detachShader(program, vertex);
    gl.detachShader(program, fragment);
    pool.release(vertex);
    pool.release(fragment);

    const linked = gl.getProgramParameter(program, gl.LINK_STATUS) as unknown;
    if (linked !== true) {
      const log = String(gl.getProgramInfoLog(program) ?? '');
      pool.release(program);
      throw new ShaderCompileError(
        'link',
        log,
        `${spec.vertexSource}\n${spec.fragmentSource}`,
        spec.name,
      );
    }

    this.handle = program;
    this.#collectUniforms(program);
  }

  #compile(type: number, source: string, stage: 'vertex' | 'fragment', name: string): WebGLShader {
    const gl = this.#gl;
    const shader = this.#pool.track('shader', gl.createShader(type) as WebGLShader, 0, name);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    const compiled = gl.getShaderParameter(shader, gl.COMPILE_STATUS) as unknown;
    if (compiled !== true) {
      const log = String(gl.getShaderInfoLog(shader) ?? '');
      this.#pool.release(shader);
      throw new ShaderCompileError(stage, log, source, name);
    }
    return shader;
  }

  #collectUniforms(program: WebGLProgram): void {
    const gl = this.#gl;
    const count = (gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS) as unknown) ?? 0;
    if (typeof count !== 'number') return;
    for (let i = 0; i < count; i += 1) {
      const info = gl.getActiveUniform(program, i);
      if (info === null) continue;
      // Array uniforms report as `name[0]`; the suffix is not part of the API.
      const name = info.name.endsWith('[0]') ? info.name.slice(0, -3) : info.name;
      this.#uniforms.set(name, gl.getUniformLocation(program, name));
    }
  }

  use(): void {
    this.#gl.useProgram(this.handle);
  }

  /** Cached uniform location, or `null` when the uniform was optimised out. */
  uniform(name: string): WebGLUniformLocation | null {
    return this.#uniforms.get(name) ?? null;
  }

  setInt(name: string, value: number): void {
    const location = this.#uniforms.get(name);
    if (location != null) this.#gl.uniform1i(location, value);
  }

  setFloat(name: string, value: number): void {
    const location = this.#uniforms.get(name);
    if (location != null) this.#gl.uniform1f(location, value);
  }

  setVec2(name: string, x: number, y: number): void {
    const location = this.#uniforms.get(name);
    if (location != null) this.#gl.uniform2f(location, x, y);
  }

  setVec3(name: string, x: number, y: number, z: number): void {
    const location = this.#uniforms.get(name);
    if (location != null) this.#gl.uniform3f(location, x, y, z);
  }

  dispose(): void {
    this.#uniforms.clear();
    this.#pool.release(this.handle);
  }
}

/**
 * Reference-counted program cache.
 *
 * Compiling and linking is the single most expensive operation in the engine
 * (tens of milliseconds). Several layers legitimately want the same variant, so
 * the cache hands out the same {@link Program} to all of them and only deletes it
 * when the last holder releases. Without the refcount, disposing one layer would
 * delete a program another layer is still drawing with — a failure that only
 * shows up as a blank chart.
 */
export class ProgramCache {
  readonly #gl: WebGL2RenderingContext;
  readonly #pool: ResourcePool;
  readonly #programs = new Map<string, { program: Program; refs: number }>();

  constructor(gl: WebGL2RenderingContext, pool: ResourcePool) {
    this.#gl = gl;
    this.#pool = pool;
  }

  get size(): number {
    return this.#programs.size;
  }

  /** Get or compile the program for a spec, incrementing its refcount. */
  acquire(spec: ProgramSpec): Program {
    const existing = this.#programs.get(spec.key);
    if (existing !== undefined) {
      existing.refs += 1;
      return existing.program;
    }
    const program = new Program(this.#gl, this.#pool, spec);
    this.#programs.set(spec.key, { program, refs: 1 });
    return program;
  }

  /** Drop one reference. The program is deleted when the count reaches zero. */
  release(program: Program): void {
    const entry = this.#programs.get(program.key);
    if (entry === undefined) return;
    entry.refs -= 1;
    if (entry.refs > 0) return;
    this.#programs.delete(program.key);
    entry.program.dispose();
  }

  dispose(): void {
    for (const entry of this.#programs.values()) entry.program.dispose();
    this.#programs.clear();
  }
}
