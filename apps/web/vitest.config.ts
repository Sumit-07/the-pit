import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  /**
   * `tsconfig.json` sets `"jsx": "preserve"` because Next does its own JSX
   * transform. Vitest's esbuild would honour that and hand Vite raw JSX, so any
   * .tsx a test imports — a page, a board component — would fail to parse. The
   * automatic runtime is set here rather than in `tsconfig.json` so Next's build
   * is untouched: this is a test-runner concern and it stays in the test runner's
   * config.
   */
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  resolve: {
    alias: {
      // Mirrors the `@/*` path in `tsconfig.json`, so a test imports a module by
      // the same specifier the app does.
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
