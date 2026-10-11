/**
 * A recording WebGL2 context.
 *
 * The performance design puts draw-call counts, leak-free `destroy()` and
 * zero-per-frame-allocation into CI as **hard assertions**, and that is only
 * possible because none of them need a GPU. SwiftShader and a real GPU differ by
 * orders of magnitude in wall-clock time, but they agree exactly on how many
 * times `drawArraysInstanced` was called.
 *
 * The mock is deliberately strict about the two things the engine relies on:
 *
 * - `getUniformLocation` returns `null` for names that are not "active", so the
 *   "uniform was optimised out" path is exercised.
 * - Every create/delete is counted per kind, so a leak shows up as a number,
 *   not as a mysterious slowdown after twenty minutes.
 */

const GL = {
  ARRAY_BUFFER: 0x8892,
  STATIC_DRAW: 0x88e4,
  DYNAMIC_DRAW: 0x88e8,
  FLOAT: 0x1406,
  UNSIGNED_INT: 0x1405,
  TRIANGLES: 0x0004,
  TRIANGLE_STRIP: 0x0005,
  COLOR_BUFFER_BIT: 0x4000,
  COMPILE_STATUS: 0x8b81,
  LINK_STATUS: 0x8b82,
  ACTIVE_UNIFORMS: 0x8b86,
  VERTEX_SHADER: 0x8b31,
  FRAGMENT_SHADER: 0x8b30,
  MAX_TEXTURE_SIZE: 0x0d33,
  MAX_TEXTURE_IMAGE_UNITS: 0x8872,
  MAX_VERTEX_ATTRIBS: 0x8869,
  MAX_SAMPLES: 0x8d57,
  TEXTURE_MAX_ANISOTROPY_EXT: 0x84ff,
  TEXTURE_2D: 0x0de1,
  TEXTURE0: 0x84c0,
  TEXTURE_MIN_FILTER: 0x2801,
  TEXTURE_MAG_FILTER: 0x2800,
  TEXTURE_WRAP_S: 0x2802,
  TEXTURE_WRAP_T: 0x2803,
  NEAREST: 0x2600,
  CLAMP_TO_EDGE: 0x812f,
  RG32F: 0x8230,
  RG: 0x8227,
} as const;

export interface MockGLOptions {
  /**
   * Record every call with its arguments.
   *
   * Disable for the allocation gate, where the recording arrays themselves would
   * dominate the measurement. With `false` the mock only counts, and `calls`,
   * `draws` and `uploads` stay empty — see `bump`.
   */
  readonly record?: boolean;
  /** Extensions `getExtension` should report as available. */
  readonly extensions?: readonly string[];
  /** Values `getParameter` should return for the probed constants. */
  readonly parameters?: Readonly<Record<number, number>>;
  /** Uniform names reported as active. Others resolve to `null`. */
  readonly uniforms?: readonly string[];
  /** Force `COMPILE_STATUS` to false, to exercise the shader error path. */
  readonly failCompile?: boolean;
  /** Force `LINK_STATUS` to false. */
  readonly failLink?: boolean;
}

export interface MockCall {
  readonly name: string;
  readonly args: readonly unknown[];
}

export interface TextureAllocation {
  readonly width: number;
  readonly height: number;
  readonly texels: number;
}

export interface MockGL {
  readonly gl: WebGL2RenderingContext;
  readonly calls: MockCall[];
  readonly counts: Record<string, number>;
  readonly created: Record<string, number>;
  readonly deleted: Record<string, number>;
  /** Instance counts from every `drawArraysInstanced`, in call order. */
  readonly draws: number[];
  /** Upload sizes in bytes, in call order. */
  readonly uploads: number[];
  /** Every `texImage2D` allocation, so a channel's storage can be asserted on. */
  readonly textures: TextureAllocation[];
  /** Every `texSubImage2D` region, in call order. */
  readonly subImages: readonly { readonly width: number; readonly height: number }[];
  clearCalls(): void;
  /** Reset the texture logs, e.g. after construction. */
  clearTextureLog(): void;
}

export function createMockGL(options: MockGLOptions = {}): MockGL {
  const record = options.record ?? true;
  const calls: MockCall[] = [];
  const counts: Record<string, number> = {};
  const created: Record<string, number> = {};
  const deleted: Record<string, number> = {};
  const draws: number[] = [];
  const uploads: number[] = [];
  const textures: TextureAllocation[] = [];
  const subImages: { width: number; height: number }[] = [];

  const extensions = new Set(options.extensions ?? []);
  const parameters: Record<number, number> = {
    [GL.MAX_TEXTURE_SIZE]: 8192,
    [GL.MAX_TEXTURE_IMAGE_UNITS]: 16,
    [GL.MAX_VERTEX_ATTRIBS]: 16,
    [GL.MAX_SAMPLES]: 4,
    ...options.parameters,
  };
  const uniforms = new Set(options.uniforms ?? ['uResolution']);
  const uniformLocations = new Map<string, object>();

  let nextHandle = 1;
  const handle = (kind: string): object => {
    created[kind] = (created[kind] ?? 0) + 1;
    return { kind, id: nextHandle++ };
  };

  const note = (name: string, args: unknown[]): void => {
    counts[name] = (counts[name] ?? 0) + 1;
    if (record) calls.push({ name, args });
  };

  /**
   * Count-only path, for the methods a render loop actually calls.
   *
   * The per-frame allocation gate measures the **engine**, and every engine loop
   * runs through this mock. `note()` builds an argument array per call, which is
   * larger than the effect being measured — so with `record: false` it would make
   * the gate report the harness rather than the engine.
   *
   * The discipline is therefore: the handful of methods on the hot path bump a
   * numeric counter and build a `MockCall` only when recording. `draws` and
   * `uploads` obey the same rule, because an array growing by one entry per frame
   * is itself a per-frame cost. Everything off the hot path keeps using `note()`,
   * which reads better.
   */
  const bump = (name: string): void => {
    counts[name] = (counts[name] ?? 0) + 1;
  };

  const context = {
    // ---- constants ----
    ...GL,

    // ---- shaders / programs ----
    createShader(type: number) {
      note('createShader', [type]);
      return handle('shader');
    },
    shaderSource(_shader: unknown, source: string) {
      note('shaderSource', [source]);
    },
    compileShader(shader: unknown) {
      note('compileShader', [shader]);
    },
    getShaderParameter(_shader: unknown, pname: number) {
      note('getShaderParameter', [pname]);
      if (pname === GL.COMPILE_STATUS) return options.failCompile !== true;
      return null;
    },
    getShaderInfoLog() {
      note('getShaderInfoLog', []);
      return options.failCompile === true ? 'ERROR: 0:12: syntax error' : '';
    },
    deleteShader(shader: unknown) {
      note('deleteShader', [shader]);
      deleted.shader = (deleted.shader ?? 0) + 1;
    },
    createProgram() {
      note('createProgram', []);
      return handle('program');
    },
    attachShader(program: unknown, shader: unknown) {
      note('attachShader', [program, shader]);
    },
    detachShader(program: unknown, shader: unknown) {
      note('detachShader', [program, shader]);
    },
    linkProgram(program: unknown) {
      note('linkProgram', [program]);
    },
    getProgramParameter(_program: unknown, pname: number) {
      note('getProgramParameter', [pname]);
      if (pname === GL.LINK_STATUS) return options.failLink !== true;
      if (pname === GL.ACTIVE_UNIFORMS) return uniforms.size;
      return null;
    },
    getProgramInfoLog() {
      note('getProgramInfoLog', []);
      return options.failLink === true ? 'error: varying count' : '';
    },
    deleteProgram(program: unknown) {
      note('deleteProgram', [program]);
      deleted.program = (deleted.program ?? 0) + 1;
    },
    useProgram(program: unknown) {
      bump('useProgram');
      if (record) calls.push({ name: 'useProgram', args: [program] });
    },
    getActiveUniform(_program: unknown, index: number) {
      note('getActiveUniform', [index]);
      const name = [...uniforms][index];
      return name === undefined ? null : { name, size: 1, type: GL.FLOAT };
    },
    getUniformLocation(_program: unknown, name: string) {
      note('getUniformLocation', [name]);
      if (!uniforms.has(name)) return null;
      let location = uniformLocations.get(name);
      if (location === undefined) {
        location = { uniform: name };
        uniformLocations.set(name, location);
      }
      return location;
    },
    uniform1i(location: unknown, value: number) {
      bump('uniform1i');
      if (record) calls.push({ name: 'uniform1i', args: [location, value] });
    },
    uniform1f(location: unknown, value: number) {
      bump('uniform1f');
      if (record) calls.push({ name: 'uniform1f', args: [location, value] });
    },
    uniform2f(location: unknown, x: number, y: number) {
      bump('uniform2f');
      if (record) calls.push({ name: 'uniform2f', args: [location, x, y] });
    },
    uniform3f(location: unknown, x: number, y: number, z: number) {
      bump('uniform3f');
      if (record) calls.push({ name: 'uniform3f', args: [location, x, y, z] });
    },
    uniformMatrix4fv(location: unknown, transpose: boolean, value: ArrayLike<number>) {
      bump('uniformMatrix4fv');
      if (record) {
        calls.push({ name: 'uniformMatrix4fv', args: [location, transpose, Array.from(value)] });
      }
    },

    // ---- buffers ----
    createBuffer() {
      note('createBuffer', []);
      return handle('buffer');
    },
    bindBuffer(target: number, buffer: unknown) {
      bump('bindBuffer');
      if (record) calls.push({ name: 'bindBuffer', args: [target, buffer] });
    },
    bufferData(target: number, dataOrSize: unknown, usage: number) {
      const bytes =
        typeof dataOrSize === 'number'
          ? dataOrSize
          : ((dataOrSize as ArrayBufferView).byteLength ?? 0);
      note('bufferData', [target, bytes, usage]);
    },
    /**
     * Both overloads.
     *
     * `bufferSubData(target, dstByteOffset, srcData, srcOffset, length)` is how
     * the engine uploads a live range without materialising a `subarray` view, so
     * the recorded size has to honour `srcOffset`/`length` — those are element
     * counts, not bytes.
     */
    bufferSubData(
      target: number,
      offset: number,
      data: ArrayBufferView,
      srcOffset?: number,
      length?: number,
    ) {
      const bytes =
        srcOffset === undefined || length === undefined
          ? data.byteLength
          : length * ((data as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1);
      bump('bufferSubData');
      if (record) {
        // The source view is recorded as `args[3]` so a test can read the bytes
        // that went to the GPU. `args[0..2]` keep their original meaning, so
        // existing assertions on size and destination are unaffected.
        calls.push({
          name: 'bufferSubData',
          args: [target, offset, bytes, data, srcOffset, length],
        });
        uploads.push(bytes);
      }
    },
    deleteBuffer(buffer: unknown) {
      note('deleteBuffer', [buffer]);
      deleted.buffer = (deleted.buffer ?? 0) + 1;
    },

    // ---- vertex arrays / attributes ----
    createVertexArray() {
      note('createVertexArray', []);
      return handle('vertexArray');
    },
    bindVertexArray(vao: unknown) {
      bump('bindVertexArray');
      if (record) calls.push({ name: 'bindVertexArray', args: [vao] });
    },
    deleteVertexArray(vao: unknown) {
      note('deleteVertexArray', [vao]);
      deleted.vertexArray = (deleted.vertexArray ?? 0) + 1;
    },
    enableVertexAttribArray(index: number) {
      note('enableVertexAttribArray', [index]);
    },
    vertexAttribPointer(
      index: number,
      size: number,
      type: number,
      normalized: boolean,
      stride: number,
      offset: number,
    ) {
      note('vertexAttribPointer', [index, size, type, normalized, stride, offset]);
    },
    /**
     * Integer attributes take a separate entry point.
     *
     * `vertexAttribPointer` converts to float, which cannot hold an id above
     * 2^24 exactly — so the line pipeline uses `uint` attributes for ids and flat
     * texture indices, and the mock must record that it did.
     */
    vertexAttribIPointer(
      index: number,
      size: number,
      type: number,
      stride: number,
      offset: number,
    ) {
      note('vertexAttribIPointer', [index, size, type, stride, offset]);
    },
    vertexAttribDivisor(index: number, divisor: number) {
      note('vertexAttribDivisor', [index, divisor]);
    },

    // ---- draws / state ----
    drawArraysInstanced(mode: number, first: number, count: number, instanceCount: number) {
      bump('drawArraysInstanced');
      if (record) {
        calls.push({ name: 'drawArraysInstanced', args: [mode, first, count, instanceCount] });
        draws.push(instanceCount);
      }
    },
    viewport(x: number, y: number, width: number, height: number) {
      bump('viewport');
      if (record) calls.push({ name: 'viewport', args: [x, y, width, height] });
    },
    clearColor(r: number, g: number, b: number, a: number) {
      bump('clearColor');
      if (record) calls.push({ name: 'clearColor', args: [r, g, b, a] });
    },
    clear(mask: number) {
      bump('clear');
      if (record) calls.push({ name: 'clear', args: [mask] });
    },

    // ---- capabilities ----
    getExtension(name: string) {
      note('getExtension', [name]);
      if (name === 'EXT_texture_filter_anisotropic') {
        return extensions.has(name)
          ? { MAX_TEXTURE_MAX_ANISOTROPY_EXT: GL.TEXTURE_MAX_ANISOTROPY_EXT }
          : null;
      }
      return extensions.has(name) ? {} : null;
    },
    getParameter(pname: number) {
      note('getParameter', [pname]);
      return parameters[pname] ?? null;
    },

    // ---- textures ----
    createTexture() {
      note('createTexture', []);
      return handle('texture');
    },
    deleteTexture(texture: unknown) {
      note('deleteTexture', [texture]);
      deleted.texture = (deleted.texture ?? 0) + 1;
    },
    activeTexture(unit: number) {
      bump('activeTexture');
      if (record) calls.push({ name: 'activeTexture', args: [unit] });
    },
    bindTexture(target: number, texture: unknown) {
      bump('bindTexture');
      if (record) calls.push({ name: 'bindTexture', args: [target, texture] });
    },
    texParameteri(target: number, pname: number, param: number) {
      note('texParameteri', [target, pname, param]);
    },
    /**
     * Allocation, so off the hot path — except that the data channel's upload
     * path reaches it whenever the texture has to grow, which is why the args are
     * recorded as a structured entry rather than a raw argument list.
     *
     * Both overloads are accepted; the nine-argument form carries `srcOffset`, so
     * the engine can hand over a full-size array without materialising a
     * `subarray` view per frame.
     */
    texImage2D(...args: unknown[]) {
      bump('texImage2D');
      const width = typeof args[3] === 'number' ? args[3] : 0;
      const height = typeof args[4] === 'number' ? args[4] : 0;
      textures.push({ width, height, texels: width * height });
      if (record) calls.push({ name: 'texImage2D', args });
    },
    texSubImage2D(...args: unknown[]) {
      bump('texSubImage2D');
      const width = typeof args[4] === 'number' ? args[4] : 0;
      const height = typeof args[5] === 'number' ? args[5] : 0;
      subImages.push({ width, height });
      if (record) calls.push({ name: 'texSubImage2D', args });
    },
    createFramebuffer() {
      note('createFramebuffer', []);
      return handle('framebuffer');
    },
    deleteFramebuffer(framebuffer: unknown) {
      note('deleteFramebuffer', [framebuffer]);
      deleted.framebuffer = (deleted.framebuffer ?? 0) + 1;
    },
    createRenderbuffer() {
      note('createRenderbuffer', []);
      return handle('renderbuffer');
    },
    deleteRenderbuffer(renderbuffer: unknown) {
      note('deleteRenderbuffer', [renderbuffer]);
      deleted.renderbuffer = (deleted.renderbuffer ?? 0) + 1;
    },
  };

  return {
    gl: context as unknown as WebGL2RenderingContext,
    calls,
    counts,
    created,
    deleted,
    draws,
    uploads,
    textures,
    subImages,
    clearCalls() {
      calls.length = 0;
    },
    clearTextureLog() {
      textures.length = 0;
      subImages.length = 0;
    },
  };
}

/** Which optional extensions a "fully capable" context reports. */
export const ALL_EXTENSIONS = [
  'EXT_color_buffer_float',
  'OES_texture_float_linear',
  'WEBGL_multi_draw',
  'EXT_disjoint_timer_query_webgl2',
  'EXT_texture_filter_anisotropic',
] as const;

/** The GL constants the mock answers on. Exported so tests can preset parameters. */
export const MOCK_GL_CONSTANTS = GL;

export interface MockCanvas {
  readonly canvas: HTMLCanvasElement;
  /** Simulate a context-loss event. */
  dispatch(type: string): void;
  readonly listeners: Map<string, Set<(event: Event) => void>>;
  /** Attributes the renderer requested, captured from `getContext`. */
  readonly requestedAttributes: WebGLContextAttributes | undefined;
}

export function createMockCanvas(
  mock: MockGL,
  options: { clientWidth?: number; clientHeight?: number; clientPixelRatio?: number } = {},
): MockCanvas {
  const listeners = new Map<string, Set<(event: Event) => void>>();
  let requestedAttributes: WebGLContextAttributes | undefined;

  const canvas = {
    width: 300,
    height: 150,
    clientWidth: options.clientWidth ?? 300,
    clientHeight: options.clientHeight ?? 150,
    getContext(id: string, attributes?: WebGLContextAttributes) {
      if (id !== 'webgl2') return null;
      requestedAttributes = attributes;
      return mock.gl;
    },
    addEventListener(type: string, listener: (event: Event) => void) {
      let set = listeners.get(type);
      if (set === undefined) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener);
    },
    removeEventListener(type: string, listener: (event: Event) => void) {
      listeners.get(type)?.delete(listener);
    },
  };

  return {
    canvas: canvas as unknown as HTMLCanvasElement,
    listeners,
    /** A getter, not a snapshot: `getContext` runs after this object is built. */
    get requestedAttributes() {
      return requestedAttributes;
    },
    dispatch(type: string) {
      const event = { type, defaultPrevented: false, preventDefault() {} } as unknown as Event;
      for (const listener of listeners.get(type) ?? []) listener(event);
    },
  };
}
