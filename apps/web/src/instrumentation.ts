/**
 * The one thing that has to be true before this server accepts a paid run.
 *
 * Next calls `register()` once per server process, before the first request is
 * served. That is the right moment for the storage binding check, and it is the
 * ONLY moment that helps: a deployment whose `DATABASE_URL` or snapshot bucket is
 * missing would otherwise look healthy, accept a submission, buy the Score phase,
 * buy the Uniqueness phase, land the Persona step on a second instance, find an
 * empty filesystem and buy the first two again — spending a customer's money
 * twice for one attempt, silently (`brief §2.3`).
 *
 * So the failure is moved from the first paid run to the boot log, where it is
 * one line, costs nothing and is attached to the deploy that caused it.
 *
 * Two guards on when it runs:
 *
 * - `NEXT_RUNTIME !== 'nodejs'` skips the edge runtime, which has neither the
 *   Postgres driver nor a reason to run a pipeline.
 * - `NEXT_PHASE === 'phase-production-build'` skips the build. `next build` sets
 *   `NODE_ENV=production`, so without this a developer running `pnpm build`
 *   locally would be told their laptop is an unconfigured production deployment.
 *   The check still runs on the deployed server's first cold start, which is
 *   before any request and therefore before any spend.
 */

import { assertBindingsConfigured } from '@/lib/pipeline/service';

export function register(): void {
  if (process.env['NEXT_RUNTIME'] !== 'nodejs') return;
  if (process.env['NEXT_PHASE'] === 'phase-production-build') return;
  assertBindingsConfigured();
}
