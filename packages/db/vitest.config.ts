import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // PGlite boots a WASM Postgres per suite file. That is a few seconds on a
    // cold start, well past vitest's 5s default.
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
