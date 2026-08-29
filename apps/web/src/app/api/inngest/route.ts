import { serve } from 'inngest/next';

import {
  inngest,
  placeProductFunction,
  runCategoryFunction,
  settleDeliveryFunction,
} from '@/lib/pipeline/inngest';

/**
 * The Inngest handler — `PHASE-0.md §3`'s "the app, the API routes and the
 * Inngest handler".
 *
 * `serve` exports GET, PUT and POST: GET is the introspection Inngest uses to
 * discover the registered functions, PUT is the sync, POST is an actual
 * invocation. All three have to be exported from an App Router route or the
 * function registers but never runs.
 *
 * `force-dynamic` because this endpoint is a webhook target. Without it Next
 * would try to evaluate it at build time, and the build machine has neither the
 * signing key nor a reason to be talking to Inngest.
 */
export const dynamic = 'force-dynamic';

/**
 * Every function the app registers. A function missing from this array is a
 * function that never runs, silently: `settleDeliveryFunction` was absent for the
 * whole of Phase 1 and `pit/run.delivered` went nowhere, so no attempt was ever
 * consumed and no verdict was ever written.
 *
 * Exported so a test can assert the set — the only assertion that catches an
 * event with no consumer, because everything upstream of the missing function
 * keeps working perfectly.
 */
export const INNGEST_FUNCTIONS = [
  runCategoryFunction,
  placeProductFunction,
  settleDeliveryFunction,
] as const;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [...INNGEST_FUNCTIONS],
});
