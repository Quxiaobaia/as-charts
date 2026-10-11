import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    /**
     * `--expose-gc` is not a convenience here, it is what makes the per-frame
     * allocation gate a gate.
     *
     * `tests/utils/allocation.ts` measures heap growth differentially and calls
     * `global.gc()` before and after each phase when the runtime exposes it.
     * Without it, unrelated garbage survives into the "after" reading and the same
     * non-allocating closure measures anywhere from 0 to 70 bytes per iteration
     * across runs — a false-negative machine that passes only by luck.
     */
    pool: 'forks',
    execArgv: ['--expose-gc'],
    // Structural gates from the performance design are cheap to assert and must
    // never be silently skipped, so no test filtering tricks are used here.
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts', 'src/**/index.ts', 'src/**/*.d.ts'],
      thresholds: {
        statements: 75,
        branches: 75,
        functions: 75,
        lines: 75,
      },
    },
  },
});
