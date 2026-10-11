import { afterEach, describe, expect, it, vi } from 'vitest';

import { DiagnosticError, Diagnostics, type Diagnostic } from '../src/core/Diagnostics';

describe('Diagnostics', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('notifies listeners at every level, including silent', () => {
    // Listeners are the telemetry channel and must keep working in production,
    // where the level is 'silent'. Only the *user-facing* output is suppressed.
    for (const level of ['silent', 'warn', 'throw'] as const) {
      const diagnostics = new Diagnostics(level);
      const seen: Diagnostic[] = [];
      diagnostics.on((event) => seen.push(event));

      if (level === 'throw') {
        expect(() => {
          diagnostics.report('code/a', 'boom');
        }).toThrow(DiagnosticError);
      } else {
        diagnostics.report('code/a', 'boom');
      }
      expect(seen).toHaveLength(1);
      expect(seen[0]?.code).toBe('code/a');
    }
  });

  it('stays quiet at silent level', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    new Diagnostics('silent').report('code/a', 'boom');
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once per code so a per-frame problem cannot flood the console', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const diagnostics = new Diagnostics('warn');

    for (let i = 0; i < 500; i += 1) diagnostics.report('frame/stall', 'slow frame');
    expect(warn).toHaveBeenCalledTimes(1);

    diagnostics.report('frame/other', 'different problem');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('includes the code and message in the warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    new Diagnostics('warn').report('bounds/skipped', 'series skipped', { series: 3 });

    const output = String(warn.mock.calls[0]?.[0] ?? '');
    expect(output).toContain('bounds/skipped');
    expect(output).toContain('series skipped');
    expect(output).toContain('"series":3');
  });

  it('throws a DiagnosticError carrying the code and detail', () => {
    const diagnostics = new Diagnostics('throw');
    try {
      diagnostics.report('resource/leak', 'object still alive', { kind: 'buffer' });
      throw new Error('expected report to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DiagnosticError);
      const typed = error as DiagnosticError;
      expect(typed.code).toBe('resource/leak');
      expect(typed.name).toBe('DiagnosticError');
      expect(typed.message).toContain('resource/leak');
      expect(typed.detail).toEqual({ kind: 'buffer' });
    }
  });

  it('never escalates an informational report to an exception', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const diagnostics = new Diagnostics('throw');
    const seen: Diagnostic[] = [];
    diagnostics.on((event) => seen.push(event));

    // A GPU missing optional extensions is a fact about the environment, not a
    // caller mistake. Escalating it would make `'throw'` — the CI setting —
    // reject machines that render correctly with the documented fallbacks.
    expect(() => {
      diagnostics.report('capability/degraded', 'missing extension', undefined, 'info');
    }).not.toThrow();

    expect(seen[0]?.severity).toBe('info');
    // Still visible: an informational notice must not become silently swallowed.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('defaults to error severity', () => {
    const diagnostics = new Diagnostics('silent');
    const seen: Diagnostic[] = [];
    diagnostics.on((event) => seen.push(event));
    diagnostics.report('resource/leak', 'still alive');

    expect(seen[0]?.severity).toBe('error');
  });

  it('survives a detail payload that cannot be serialised', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;

    expect(() => {
      new Diagnostics('warn').report('code/a', 'circular', circular);
    }).not.toThrow();
    expect(String(warn.mock.calls[0]?.[0] ?? '')).toContain('circular');
  });

  it('allows a listener to unsubscribe', () => {
    const diagnostics = new Diagnostics('silent');
    const listener = vi.fn();
    const off = diagnostics.on(listener);

    diagnostics.report('code/a', 'first');
    off();
    diagnostics.report('code/b', 'second');

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('re-arms warning deduplication on clearWarnings', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const diagnostics = new Diagnostics('warn');
    diagnostics.report('code/a', 'boom');
    diagnostics.report('code/a', 'boom');
    expect(warn).toHaveBeenCalledTimes(1);

    diagnostics.clearWarnings();
    diagnostics.report('code/a', 'boom');
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('drops listeners on dispose', () => {
    const diagnostics = new Diagnostics('silent');
    const listener = vi.fn();
    diagnostics.on(listener);
    diagnostics.dispose();
    diagnostics.report('code/a', 'after dispose');
    expect(listener).not.toHaveBeenCalled();
  });

  it('honours a level change made after construction', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const diagnostics = new Diagnostics('silent');
    diagnostics.report('code/a', 'quiet');
    expect(warn).not.toHaveBeenCalled();

    diagnostics.level = 'warn';
    diagnostics.report('code/a', 'loud');
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
