import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const entry = fileURLToPath(new URL('./src/index.ts', import.meta.url));

export default defineConfig({
  // Dev server / playground root. `vite build` runs in library mode and ignores the HTML entry.
  root: '.',
  server: {
    port: 5178,
    open: false,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // The library ships unminified: consumers bundle it themselves, and readable
    // output keeps stack traces and shader diagnostics useful.
    minify: false,
    emptyOutDir: true,
    reportCompressedSize: true,
    lib: {
      entry,
      name: 'AsCharts',
      formats: ['es', 'cjs'],
      fileName: (format) => (format === 'es' ? 'index.mjs' : 'index.cjs'),
    },
    rollupOptions: {
      // Zero runtime dependencies — nothing is external by omission, everything
      // that ends up in the bundle is intentionally ours.
      external: [],
      output: {
        exports: 'named',
        preserveModules: false,
      },
    },
  },
});
