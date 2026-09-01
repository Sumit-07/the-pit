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
    /*
     * Vitest's default is 5s, and several tests here legitimately need more than
     * that: they render a whole board — 48 products with their full ledgers and
     * their favicons — or replay a seeded category through the anonymity checks.
     * Alone each finishes in about four seconds, which means the default turned
     * them into timeouts as soon as the suite ran hot enough for the workers to
     * contend. A timeout that fires on CPU contention rather than on a hang is a
     * flake, and a flake in a suite this size is worse than a slow test: it
     * teaches everyone to re-run. Nothing in this suite waits on a network or a
     * real database, so a genuine hang still fails here — it just fails at 20s.
     */
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
