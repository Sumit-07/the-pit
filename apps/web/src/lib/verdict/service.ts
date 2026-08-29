/**
 * Which store the verdict route reads, per deployment.
 *
 * Same shape as `lib/pipeline/service.ts`: one function that says what this
 * environment binds, so the route itself names no store and can be pointed at a
 * different one without editing it.
 *
 * ## Two bindings, and why the cold-start one exists
 *
 * A deployment with a database binds a `VerdictStore` over the `verdicts` table
 * — one select on `public_slug`, described in `store.ts`. That store is not
 * written here, because `apps/web` does not depend on `drizzle-orm` directly and
 * because the table is another agent's; `store.ts` states the read it needs and
 * this module is where the adapter is plugged in.
 *
 * What is written here is the binding for the state this repository is actually
 * in: no database provisioned, two seeded boards on disk (`DECISIONS.md` S4), and
 * `brief` Part 7's cold-start listings "marked clearly as unclaimed". Those
 * listings have public verdict pages — `packages/db/src/seed/build.ts` already
 * builds a frozen `verdicts` row for every one of them — so the seeded binding
 * materialises exactly those rows, through the seed's own freezing code, and
 * hands them to the same `StoredVerdict` interface the database would.
 *
 * That is the important property: the page never learns which binding it got.
 * Everything above `VerdictStore` sees a frozen payload and a frozen stamp, and
 * has no way to reach a live ranking whichever store is underneath.
 */

import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import { buildSeedRows, loadSeedInput, SEEDED_SLUGS } from '@the-pit/db';

import { MemoryVerdictStore, type StoredVerdict, type VerdictStore } from './store';

/** Where the seeded boards live. `PIT_WORKDIR` matches `lib/pipeline/service.ts`. */
function workdir(): string {
  return process.env['PIT_WORKDIR'] ?? 'cjr';
}

/**
 * The frozen verdict rows for the seeded boards, built once per process.
 *
 * `buildSeedRows` is `@the-pit/db`'s, so the payload here is byte-identical to
 * the one a seed run would insert — this is not a second freezer, it is the same
 * one called earlier.
 *
 * `deliveredAt` is overridden with `ranking.json`'s mtime rather than kept as
 * `buildSeedRows`' `new Date()`. The stamp on a permanent public URL must not
 * change when the server restarts, and for an unclaimed cold-start listing the
 * honest instant is when its board was last ranked — which is what the mtime is.
 * A paid verdict gets its stamp from `verdicts.delivered_at`, written inside the
 * delivery transaction, and never comes through here.
 */
async function seededVerdicts(): Promise<StoredVerdict[]> {
  const root = workdir();
  const rows: StoredVerdict[] = [];

  for (const slug of SEEDED_SLUGS) {
    let rankedAt: Date;
    try {
      rankedAt = (await stat(join(root, 'runs', slug, 'ranking.json'))).mtime;
    } catch {
      // A category that has not been seeded in this checkout is not an error:
      // its verdict URLs simply do not resolve.
      continue;
    }

    const seed = buildSeedRows(await loadSeedInput(slug, root));
    for (const row of seed.verdicts) {
      rows.push({
        publicSlug: row.publicSlug,
        payload: row.payload,
        productCount: row.productCount,
        attemptNumber: row.attemptNumber ?? null,
        deliveredAt: rankedAt,
      });
    }
  }

  return rows;
}

let cached: Promise<VerdictStore> | undefined;

/**
 * The store this deployment reads.
 *
 * Cached per process: the seeded rows are derived from files that only a
 * placement rewrites, and rebuilding 92 frozen payloads on every page view would
 * be work done on the one surface `brief` Part 6 wants served from a CDN.
 */
export function verdictStore(): Promise<VerdictStore> {
  cached ??= seededVerdicts()
    .then((rows) => new MemoryVerdictStore(rows) as VerdictStore)
    // A missing or malformed `cjr/` must not take down a route whose only job is
    // to resolve a slug. Nothing resolves; the page 404s and says so.
    .catch(() => new MemoryVerdictStore());
  return cached;
}

/** Drop the cached store. Tests only. */
export function resetVerdictStore(): void {
  cached = undefined;
}
