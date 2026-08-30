/**
 * Where `POST /api/site-metadata` gets its dependencies at runtime.
 *
 * Same seam and the same precedence as every other config module in this app:
 * an explicit `registerSiteMetadataDeps()` wins, so a test installs a fake
 * reader and a fixture limiter and opens no socket; otherwise the real guarded
 * reader and a process-local limiter are resolved here.
 *
 * ## The limiter is in-memory, and that is a known ceiling
 *
 * `MemoryRateLimiter` counts inside one process. On Vercel every invocation may
 * be a fresh instance, so the real budget an attacker meets is "20 per warm
 * lambda" rather than "20 per address" — `packages/auth/src/rate-limit.ts` says
 * the same thing about the auth budgets, for the same deployment, and names the
 * same fix (shared state: Upstash, or a counter in Postgres). It is written down
 * here rather than assumed away because a limiter that is weaker than it looks
 * is worse than one that is honestly absent.
 *
 * It still buys the thing that matters most: nothing here can be turned into a
 * sustained scanner from a single connection, and the `@the-pit/fetch` guards —
 * which are NOT rate-dependent — are what actually keep the outbound requests
 * off anything private.
 */

import { MemoryRateLimiter, type RateLimiter } from '@the-pit/auth';

import type { SiteMetadataDeps } from '@/lib/ingest/site-metadata';

let registered: SiteMetadataDeps | null = null;
let limiter: RateLimiter | null = null;

/** Install dependencies directly. Tests use this; production uses the defaults. */
export function registerSiteMetadataDeps(deps: SiteMetadataDeps): void {
  registered = deps;
}

/** Drop what this module memoized. Tests only. */
export function resetSiteMetadataWiring(): void {
  registered = null;
  limiter = null;
}

/**
 * Resolved from NOTHING — no `DATABASE_URL`, no keyring, no Dodo.
 *
 * The autofill sits on `/submit`, and `/submit` renders on a deployment whose
 * write path is not yet wired (`lib/checkout/config.ts` says why at length). An
 * autofill that needed configuration the form itself does not need would put the
 * form's newest feature back behind the wiring the form was deliberately taken
 * out from behind.
 */
export function siteMetadataDeps(): SiteMetadataDeps {
  if (registered !== null) return registered;
  limiter ??= new MemoryRateLimiter();
  return { limiter };
}
