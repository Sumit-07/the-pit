import type { NextConfig } from 'next';

/**
 * `PHASE-0.md §3`: Next.js 15 (App Router) on Vercel Pro, holding the app, the
 * API routes and the Inngest handler. This file is the shell only — the boards,
 * the verdict page, checkout and the pipeline are later phases and other agents.
 */
const config: NextConfig = {
  reactStrictMode: true,

  /**
   * The workspace packages and their heavy dependencies stay OUT of the server
   * bundle and are `require`d at runtime instead.
   *
   * `@the-pit/engine` is a Node library, not browser code: it reads the
   * filesystem (`FileRunStore`), uses `node:crypto` for the seeded PRNG and the
   * content digests, and carries `exceljs` for ingest and the Anthropic SDK for
   * the Messages API adapter. Bundling that graph into every route would inline
   * megabytes of parser and SDK into functions that call `MERIT_W`, and would
   * break the dynamic requires inside them. `@the-pit/db` is the same story with
   * the `postgres` driver.
   *
   * This is also what keeps the engine a LIBRARY rather than something the web
   * app reshapes to suit itself — `PHASE-0.md §3`: "`packages/engine` never
   * imports from `apps/web`. The engine is a library the pipeline calls."
   */
  serverExternalPackages: [
    '@the-pit/engine',
    '@the-pit/db',
    // The guarded URL fetcher reaches for `node:dns` and `node:https` to pin a
    // connection to an address it has already checked (`packages/fetch/src/node`).
    // That is server-only by construction, and bundling it would both fail and
    // put a fetch-arbitrary-URL primitive somewhere it must never be.
    '@the-pit/fetch',
    'exceljs',
    '@anthropic-ai/sdk',
    'postgres',
    // The durable `PipelineStore` queries through Drizzle. It is the same story
    // as `postgres` above: a query builder with per-dialect dynamic requires,
    // loaded by the pipeline and by nothing that renders.
    'drizzle-orm',
  ],
};

export default config;
