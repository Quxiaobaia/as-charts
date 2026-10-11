/**
 * Node has no `requestAnimationFrame`, but `Renderer`'s default clock host is
 * built on it. A test that drives the scheduler injects its own
 * `SchedulerHost`; the rest still need *a* host so that constructing a renderer
 * and registering a layer cannot crash on a missing global.
 *
 * The stub deliberately never fires. That matters: a test which wants a frame
 * must either inject a host and tick it, or call `renderNow()`. If this stub
 * silently ran callbacks, "did a frame happen?" would stop being an explicit
 * question and a class of missed-frame bugs would go unnoticed.
 */
const scope = globalThis as unknown as {
  requestAnimationFrame?: (callback: (now: number) => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
};

if (typeof scope.requestAnimationFrame !== 'function') {
  scope.requestAnimationFrame = () => 0;
}

if (typeof scope.cancelAnimationFrame !== 'function') {
  scope.cancelAnimationFrame = () => undefined;
}
