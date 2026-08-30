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

import {
  buildSeedRows,
  createDatabase,
  createPostgresVerdictStore,
  hasDatabaseUrl,
  loadSeedInput,
  SEEDED_SLUGS,
} from '@the-pit/db';

import { resolveWorkdir } from '@/lib/boards/source';
import { STORAGE_MODE_ENV } from '@/lib/pipeline/mode';

import { MemoryVerdictStore, type StoredVerdict, type VerdictStore } from './store';

/**
 * Where the seeded boards live.
 *
 * `resolveWorkdir` and not a relative `'cjr'`, which is the bug this replaced:
 * `next dev` and `next build` both run with `apps/web` as the working directory,
 * so `'cjr'` resolved to `apps/web/cjr`, which does not exist. The `stat` below
 * then failed for every seeded slug, the loop skipped both categories, and the
 * store came up EMPTY — so every one of the 92 cold-start verdict URLs 404'd on a
 * running server while the test suite passed, because the suite sets
 * `PIT_WORKDIR` explicitly. `lib/boards/source.ts` had already hit this and
 * solved it by walking up for the directory that actually holds `runs/`; the
 * boards rendered and the verdicts did not, from one line's difference. Sharing
 * its resolver is what keeps the two surfaces reading the same `cjr/`.
 */
function workdir(): string {
  return resolveWorkdir();
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
  return (await seededIndex()).rows;
}

/** The seeded rows, plus the reverse lookup a board row needs to link to one. */
interface SeededIndex {
  readonly rows: StoredVerdict[];
  /** Category slug -> engine product id -> public verdict slug. */
  readonly slugs: Map<string, Map<number, string>>;
}

let seeded: Promise<SeededIndex> | undefined;

function seededIndex(): Promise<SeededIndex> {
  seeded ??= (async (): Promise<SeededIndex> => {
    const root = workdir();
    const rows: StoredVerdict[] = [];
    const slugs = new Map<string, Map<number, string>>();

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
      const byProduct = new Map<number, string>();
      for (const row of seed.verdicts) {
        rows.push({
          publicSlug: row.publicSlug,
          payload: row.payload,
          productCount: row.productCount,
          attemptNumber: row.attemptNumber ?? null,
          deliveredAt: rankedAt,
        });
        // The engine id is read back off the frozen payload rather than
        // re-derived from the id hash. `verdict-payload.ts` embeds the ranked row
        // whole, so `verdict.id` is the same number `ranking.json` carries and the
        // same number `lib/boards/view.ts` projects a board row from — one join
        // key, taken from the document both sides already read.
        const payload = row.payload as { verdict?: { id?: unknown } };
        const id = payload.verdict?.id;
        if (typeof id === 'number') byProduct.set(id, row.publicSlug);
      }
      slugs.set(slug, byProduct);
    }

    return { rows, slugs };
  })();
  return seeded;
}

/**
 * Every cold-start listing's verdict URL for one category, by engine product id.
 *
 * The board is rendered from `cjr/runs/<slug>/ranking.json` and every verdict on
 * that board is frozen from the same file by `buildSeedRows`, so the two agree by
 * construction — this map is not a second derivation of the slug, it is the
 * freezer's own output read back. Without it a board row has no way to name its
 * verdict: `verdicts.public_slug` is a hash of a deterministic uuid, and a
 * surface that recomputed that hash would be a second definition of a permanent
 * public URL.
 *
 * Empty for a category with no seeded run, and a caller that gets no entry for a
 * row renders no link rather than a link to nothing. A verdict delivered through
 * the money path lives in Postgres under its own slug and is not in here; when
 * `DECISIONS.md` S8 settles what a re-pitch does to the old URL, the board's
 * lookup becomes a store read and this stays the cold-start arm of it.
 */
export async function seededVerdictSlugs(categorySlug: string): Promise<ReadonlyMap<number, string>> {
  try {
    return (await seededIndex()).slugs.get(categorySlug) ?? new Map();
  } catch {
    // Same posture as `verdictStore` below: a missing or malformed `cjr/` costs
    // the board its verdict links, never its render.
    return new Map();
  }
}

let cached: Promise<VerdictStore> | undefined;
let registered: VerdictStore | undefined;

/**
 * The `verdicts` table, behind the same one-method interface.
 *
 * This is the binding a paying customer needs and did not have. The seeded store
 * below is built from `cjr/` and holds exactly the cold-start rows; a verdict
 * delivered by the money path is a row in Postgres and is invisible to it, so
 * until this existed `/v/<slug>` 404'd forever for the one person who paid.
 *
 * `deliveredAt` comes off the column, not off a file's mtime. It was written
 * inside the delivery transaction, which is the same instant `brief` Part 5
 * stamps on the card, and it must never move — the seeded arm's mtime trick is a
 * substitute for a column that does not exist for unclaimed listings, not a
 * policy.
 */
function postgresVerdicts(): VerdictStore {
  const store = createPostgresVerdictStore(createDatabase(undefined, 1).db);
  return {
    async bySlug(slug: string): Promise<StoredVerdict | undefined> {
      const row = await store.bySlug(slug);
      return row === null ? undefined : row;
    },
  };
}

/**
 * The store this deployment reads.
 *
 * ## Bound by the deployment's storage mode, not by one environment variable
 *
 * In `postgres` mode `/v/<slug>` reads the table — every delivered verdict,
 * including the seeded rows, which `db:seed` inserts. In `filesystem` mode the
 * seeded rows are materialised from `cjr/` through the seed's own freezing code,
 * which is what makes local development and CI resolve a verdict URL with no
 * database in existence.
 *
 * `PIT_STORAGE=filesystem` narrows it, and that was a live bug rather than a
 * tidy-up. The repository's local `.env` sets both `DATABASE_URL` — so a reader
 * can point at a database if they start one — and `PIT_STORAGE=filesystem`,
 * declaring that this deployment does not. Every other surface honoured the
 * second; this one read only the first, opened a client against a Postgres
 * nobody was running, and threw. `/v/<slug>` 500'd on all 92 seeded verdicts
 * while the boards beside them rendered from the same files, and the one page
 * `brief` Part 6 calls the paid deliverable was unreachable by any route on a
 * running server. `mode.ts`'s own docblock names this failure: two copies of the
 * binding rule, and the day they disagree a surface reads somewhere nothing
 * writes.
 *
 * It is still not a fallback, in either direction. Nothing here reacts to a
 * database being DOWN — an unreachable database throws, as it should, rather than
 * quietly serving 92 cold-start pages while a customer's paid verdict is missing.
 * The seeded arm is reached only by an operator declaring the mode, and
 * `storageMode` refuses that declaration where durable storage is required, with
 * `assertBindingsConfigured` enforcing it at boot before any request.
 *
 * Cached per process: the seeded rows are derived from files that only a
 * placement rewrites, and rebuilding 92 frozen payloads on every page view would
 * be work done on the one surface `brief` Part 6 wants served from a CDN. The
 * Postgres arm is cached too, because what it caches is a connection.
 */
export function verdictStore(): Promise<VerdictStore> {
  if (registered !== undefined) return Promise.resolve(registered);
  const declaredFilesystem = process.env[STORAGE_MODE_ENV] === 'filesystem';
  cached ??= !declaredFilesystem && hasDatabaseUrl()
    ? Promise.resolve(postgresVerdicts())
    : seededVerdicts()
        .then((rows) => new MemoryVerdictStore(rows) as VerdictStore)
        // A missing or malformed `cjr/` must not take down a route whose only job
        // is to resolve a slug. Nothing resolves; the page 404s and says so.
        .catch(() => new MemoryVerdictStore());
  return cached;
}

/** Install a store directly. Tests use this; production uses the environment. */
export function registerVerdictStore(store: VerdictStore): void {
  registered = store;
}

/** Drop the cached store. Tests only. */
export function resetVerdictStore(): void {
  cached = undefined;
  registered = undefined;
  seeded = undefined;
}
