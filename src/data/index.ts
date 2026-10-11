/**
 * The data layer: mapping, ticks, decimation and storage.
 *
 * No module under `src/data/` may import from `src/renderer/` or `src/layers/`.
 * The rule buys two things that are otherwise expensive to get: the whole layer
 * can be tested in Node without a WebGL mock (which is how the tick algorithms
 * are checked against d3 bit for bit), and the same code can run inside a Worker
 * when a parse or a decimation would otherwise block the frame.
 *
 * This barrel exists so the layer can later be published as its own subpath
 * (`as-charts/data`) without touching a single import site. The subpath is not
 * declared in `package.json` yet: `exports` is the published surface, and it
 * should be shaped once, before the first release, rather than grown afterwards.
 */

export { DataSet } from './DataSet';
export { RingBuffer } from './RingBuffer';
export {
  createScale,
  categoryScale,
  scaleOver,
  type Scale,
  type ScaleKind,
  type ScaleOptions,
} from './Scale';
export {
  categoryTicks,
  linearTicks,
  logTicks,
  tickStep,
  timeTicks,
  assertLogDomain,
  type TickSet,
  type TimeUnit,
} from './ticks';
export {
  MinmaxWorkspace,
  minmaxDownsample,
  type DownsampleResult,
  type MinmaxOptions,
} from './downsample';
export {
  classify,
  computeBounds,
  describeSkips,
  reportSkips,
  type BoundsOptions,
  type BoundsResult,
  type SampleSkipKind,
  type SkipAxis,
  type SkipDiagnostic,
  type SkipKind,
} from './bounds';
export type { Bounds, Vec } from './types';
