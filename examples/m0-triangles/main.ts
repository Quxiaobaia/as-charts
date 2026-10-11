import { Dirty, Renderer, type CapabilityReport, type RendererStats } from '../../src/index';

/**
 * M0 playground.
 *
 * The point of this page is not that triangles are pretty — it is that every
 * performance claim in the design is *visible* rather than asserted:
 *
 * 1. **One draw call per layer.** No matter whether 500 or 60 000 markers are on
 *    screen, `drawCalls` reads 1. The instance buffer grows; the call count does
 *    not.
 * 2. **The frame that never happens.** Pausing the data feed leaves the scheduler
 *    completely idle: `framesRequested` stops climbing, not just `drawCalls`.
 *    That is the dirty-flag model doing its job.
 * 3. **The frame-rate gate.** Capping at 10 fps makes `skippedByFpsCap` climb while
 *    `framesRendered` settles at ten per second — and the markers keep moving,
 *    because the work is deferred rather than dropped.
 * 4. **The visibility gate.** Scrolling the canvas out of view raises
 *    `skippedInvisible`; the dirty work is retained and rendered on the first
 *    visible frame.
 *
 * Every number below comes straight out of `renderer.stats()`; nothing is
 * estimated in the page.
 */

const MAX_MARKERS = 60_000;
/** Tail debounce for resize, matching the renderer's documented guidance. */
const RESIZE_DEBOUNCE_MS = 12;
const HUD_INTERVAL_MS = 250;

/** Fail loudly rather than silently rendering into a missing element. */
function requireElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`playground markup is missing ${String(selector)}`);
  return element;
}

const canvas = requireElement<HTMLCanvasElement>('#stage');
const renderList = requireElement<HTMLElement>('#render-stats');
const schedList = requireElement<HTMLElement>('#sched-stats');
const resList = requireElement<HTMLElement>('#res-stats');
const capsList = requireElement<HTMLUListElement>('#caps');
const countInput = requireElement<HTMLInputElement>('#count');
const countLabel = requireElement<HTMLElement>('#count-label');
const pauseToggle = requireElement<HTMLButtonElement>('#pause');
const fpsButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('#fps-seg button'));

const format = (value: number): string => Math.round(value).toLocaleString('en-US');

/**
 * The context is created with the documented defaults: no MSAA, no depth, no
 * stencil, and a device-pixel ratio that follows the platform but is capped by a
 * pixel budget so a 4K panel cannot silently cost nine times the rasterisation.
 */
const renderer = new Renderer({ canvas, diagnostics: 'warn' });

/**
 * Pre-allocate the maximum the slider allows. Growing later is correct — the VAO
 * attribute re-capture path is what stops growth from blanking the chart — but
 * allocating once removes it from the measurement.
 */
const layer = renderer.addTriangleLayer({
  initialCapacity: MAX_MARKERS,
  label: 'markers',
});

let markerCount = Number(countInput.value);
let paused = false;

// ---------------------------------------------------------------------------
// Readout
// ---------------------------------------------------------------------------

/** Append a `dt`/`dd` pair once and hand back the value cell to update in place. */
function readout(list: HTMLElement, label: string): HTMLElement {
  const term = document.createElement('dt');
  term.textContent = label;
  const value = document.createElement('dd');
  list.append(term, value);
  return value;
}

const row = {
  fps: readout(renderList, 'FPS（实测）'),
  drawCalls: readout(renderList, 'drawCalls'),
  frames: readout(renderList, 'framesRendered'),
  markers: readout(renderList, '标记数量'),
  buffer: readout(renderList, '绘制缓冲'),
  dpr: readout(renderList, 'devicePixelRatio'),
  frameGap: readout(renderList, 'lastDelta / maxDelta'),

  requested: readout(schedList, 'framesRequested'),
  rendered: readout(schedList, 'framesRendered'),
  byFpsCap: readout(schedList, 'skippedByFpsCap'),
  invisible: readout(schedList, 'skippedInvisible'),
  clean: readout(schedList, 'skippedClean'),
  pending: readout(schedList, 'pending'),

  live: readout(resList, 'live 对象'),
  bytes: readout(resList, '显存占用'),
  programs: readout(resList, '已编译程序'),
  created: readout(resList, '累计创建'),
  destroyed: readout(resList, '累计销毁'),
  labels: readout(resList, '存活标签'),
};

let lastHudAt = 0;
let lastFramesRendered = 0;
let measuredFps = 0;

function paint(stats: RendererStats, fps: number): void {
  const scheduler = stats.scheduler;
  const resources = stats.resources;

  row.fps.textContent = fps.toFixed(1);
  row.drawCalls.textContent = format(stats.drawCalls);
  row.frames.textContent = format(stats.frameCount);
  row.markers.textContent = format(layer.count);
  row.buffer.textContent = `${format(renderer.width)} × ${format(renderer.height)}`;
  row.dpr.textContent = renderer.devicePixelRatio.toFixed(2);
  row.frameGap.textContent = `${scheduler.lastDelta.toFixed(2)} / ${scheduler.maxDelta.toFixed(2)} ms`;

  row.requested.textContent = format(scheduler.framesRequested);
  row.rendered.textContent = format(scheduler.framesRendered);
  row.byFpsCap.textContent = format(scheduler.skippedByFpsCap);
  row.invisible.textContent = format(scheduler.skippedInvisible);
  row.clean.textContent = format(scheduler.skippedClean);
  row.pending.textContent = scheduler.pending ? '是' : '否';

  row.live.textContent = format(resources.live);
  row.bytes.textContent = `${format(resources.bytes / 1024)} KiB`;
  row.programs.textContent = format(stats.programs);
  row.created.textContent = format(resources.created);
  row.destroyed.textContent = format(resources.destroyed);
  row.labels.textContent = format(resources.labels.length);

  // Highlight a counter only once it has actually moved: a draw-call budget of
  // more than one, or any skipped frame, is the interesting case.
  row.drawCalls.className = stats.drawCalls <= 1 ? 'zero' : 'hot';
  row.byFpsCap.className = scheduler.skippedByFpsCap > 0 ? 'hot' : 'zero';
  row.invisible.className = scheduler.skippedInvisible > 0 ? 'hot' : 'zero';
  row.clean.className = scheduler.skippedClean > 0 ? 'hot' : 'zero';
  row.live.className = resources.live === 0 ? 'zero' : '';
}

function describeCapabilities(report: CapabilityReport): void {
  const capabilities = report.capabilities;
  const summary = [
    `MAX_TEXTURE_SIZE ${format(capabilities.maxTextureSize)}`,
    `MAX_VERTEX_ATTRIBS ${format(capabilities.maxVertexAttribs)}`,
    `MAX_SAMPLES ${format(capabilities.maxSamples)}`,
  ];
  for (const line of summary) {
    const item = document.createElement('li');
    item.textContent = line;
    capsList.append(item);
  }

  // A missing optional feature is a fact about the machine, not a bug, so the
  // page lists the fallback instead of hiding the difference.
  const notes = report.degraded ? report.fallbacks : ['全部可选扩展可用，没有任何降级。'];
  for (const note of notes) {
    const item = document.createElement('li');
    item.textContent = note;
    capsList.append(item);
  }
}

describeCapabilities(renderer.capabilityReport);
countLabel.textContent = format(markerCount);

// ---------------------------------------------------------------------------
// Sizing
// ---------------------------------------------------------------------------

let resizeTimer = 0;
function scheduleResize(): void {
  // `resize()` reads clientWidth/clientHeight, which forces layout — so it is
  // debounced rather than run per frame.
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    renderer.resize();
  }, RESIZE_DEBOUNCE_MS);
}

renderer.resize();
const resizeObserver = new ResizeObserver(scheduleResize);
resizeObserver.observe(canvas);
scheduleResize();

// The fourth scheduling mechanism: an offscreen chart keeps its dirty flags but
// does not render. Deferring the work is what stops a backgrounded alarm panel
// from "sticking" when it scrolls back into view.
const visibilityObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) renderer.setVisible(entry.isIntersecting);
  },
  { threshold: 0 },
);
visibilityObserver.observe(canvas);

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

countInput.addEventListener('input', () => {
  markerCount = Number(countInput.value);
  countLabel.textContent = format(markerCount);
  renderer.request(Dirty.Data);
});

for (const button of fpsButtons) {
  button.addEventListener('click', () => {
    const requested = button.dataset['fps'] ?? 'auto';
    renderer.setMaxFps(requested === 'auto' ? undefined : Number(requested));
    for (const other of fpsButtons) {
      other.setAttribute('aria-pressed', String(other === button));
    }
  });
}

pauseToggle.addEventListener('click', () => {
  paused = !paused;
  pauseToggle.setAttribute('aria-pressed', String(paused));
  // Resuming must ask for a frame explicitly: while paused nothing is dirty, so
  // the scheduler has correctly gone completely idle.
  if (!paused) renderer.request(Dirty.Data);
});

// ---------------------------------------------------------------------------
// Data feed
// ---------------------------------------------------------------------------

function writeMarkers(seconds: number): void {
  const width = renderer.width;
  const height = renderer.height;
  const count = markerCount;

  // The grid is derived from the marker count rather than fixed, and it is as
  // square as the drawing buffer allows. Two things follow:
  //
  // - The field always tiles the canvas exactly once. A fixed cell size would
  //   make the columns overlap as the count rises, producing a moiré pattern that
  //   says nothing about the renderer.
  // - Growing the count reads as *finer sampling of the same picture*, which is
  //   the actual claim: twenty times the data, still one draw call.
  const cell = Math.max(2, Math.sqrt((width * height) / count));
  const columns = Math.max(1, Math.floor(width / cell));
  const rows = Math.max(1, Math.ceil(count / columns));
  const columnPitch = width / columns;
  const rowPitch = height / rows;
  const unit = Math.min(columnPitch, rowPitch) * 0.45;

  // Setting the count first is what lets the field *shrink*: `setInstance` only
  // ever raises the count, which suits append-style updates but would leave stale
  // markers on screen when a dataset gets smaller.
  layer.count = count;

  for (let i = 0; i < count; i += 1) {
    const columnIndex = i % columns;
    const rowIndex = Math.floor(i / columns);

    // Deterministic pseudo-scatter: no per-frame randomness, so the only thing
    // changing between frames is the animation itself.
    const phase = seconds * 1.6 + columnIndex * 0.35 + rowIndex * 0.13;
    const level = (Math.sin(phase) + 1) / 2;

    const x = columnPitch * (columnIndex + 0.5);
    const y = rowPitch * (rowIndex + 0.5);
    const size = unit * (0.4 + level * 1.2);

    // Thermal ramp: hot is red-dominant, cool is blue-dominant.
    layer.setInstance(i, x, y, size, level, 0.2 + (1 - level) * 0.35, 1 - level);
  }
}

function tick(now: number): void {
  if (!paused) {
    writeMarkers(now / 1000);
    // One request for the whole batch: 60 000 writes still cost one frame.
    renderer.request(Dirty.Data);
  }

  if (now - lastHudAt >= HUD_INTERVAL_MS) {
    const stats = renderer.stats();
    if (lastHudAt !== 0) {
      const elapsed = (now - lastHudAt) / 1000;
      if (elapsed > 0)
        measuredFps = (stats.scheduler.framesRendered - lastFramesRendered) / elapsed;
    }
    lastHudAt = now;
    lastFramesRendered = stats.scheduler.framesRendered;
    paint(stats, measuredFps);
  }

  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);
