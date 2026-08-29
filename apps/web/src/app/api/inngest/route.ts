import { serve } from 'inngest/next';

import { inngest, placeProductFunction, runCategoryFunction } from '@/lib/pipeline/inngest';

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

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [runCategoryFunction, placeProductFunction],
});
