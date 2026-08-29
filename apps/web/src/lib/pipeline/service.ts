/**
 * The deployment's wiring: which store, which catalogue, which snapshot sink —
 * and the one read the status surfaces share.
 *
 * Kept apart from `inngest.ts` on purpose. The status endpoint and the status
 * page are reads; they must not drag the Inngest SDK into their bundle, and more
 * to the point they must not be able to enqueue anything. `02 §4` puts the same
 * rule on the board: "reads never touch a model". Nothing in this module takes or
 * constructs a `ModelClient`.
 *
 * ## Two bindings, and the one that must never be chosen by accident
 *
 * `filesystem` is `cjr/` on disk and a directory of board JSON beside it. It is
 * correct locally, in CI and for `01 §4`'s offline seeding, and it is CORRUPTING
 * in production: Vercel gives each invocation its own filesystem, so a run whose
 * `score` step landed on one instance and whose `persona` step landed on another
 * would find no persisted phase, decide the phase had never run, and RE-BUY it —
 * spending a customer's money twice on one attempt while still reporting the
 * retry as free (`brief §2.3`).
 *
 * `postgres` is `PgPipelineStore` over `@the-pit/db` and `BucketSnapshotSink`
 * over an object store. Both are addressable from any instance, which is the
 * whole property the filesystem lacks.
 *
 * So the binding is chosen by environment and the wrong choice is REFUSED rather
 * than warned about. `assertBindingsConfigured()` runs at server startup
 * (`src/instrumentation.ts`) so a deployment missing `DATABASE_URL` or a bucket
 * fails on boot, in the deployment logs, before it has taken anyone's money — not
 * on the first paid run, forty seconds into a pipeline, having already bought
 * three phases.
 *
 * A silent fallback to local disk in production is the exact bug this module
 * exists to remove, so there is no flag that reinstates it.
 */

import { phaseVersions, type PhaseVersions } from '@the-pit/engine';
import { createDatabase, DATABASE_URL_ENV, requireDatabaseUrl, type Database } from '@the-pit/db';

import { BucketSnapshotSink, HttpObjectStore } from './bucket';
import { FileCategorySource, type CategorySource } from './catalog';
import { PgPipelineStore } from './pg-store';
import { readRunStatus, type RunStatus } from './status';
import { FileSnapshotSink, type SnapshotSink } from './snapshot';
import { FilePipelineStore, placementScope, type PipelineStore } from './store';

/** Which pair of implementations a deployment is bound to. */
export type StorageMode = 'filesystem' | 'postgres';

/** The environment variable that overrides the default choice. */
export const STORAGE_MODE_ENV = 'PIT_STORAGE';

/** The bucket the board snapshots are published to. Required in `postgres` mode. */
export const SNAPSHOT_BUCKET_URL_ENV = 'PIT_SNAPSHOT_BUCKET_URL';
/** Bearer token for writes to that bucket. */
export const SNAPSHOT_BUCKET_TOKEN_ENV = 'PIT_SNAPSHOT_BUCKET_TOKEN';
/** Optional: where a single-key CDN purge is POSTed after a placement. */
export const SNAPSHOT_PURGE_URL_ENV = 'PIT_SNAPSHOT_PURGE_URL';

/** A readable snapshot of the process environment. Injectable so tests never mutate the real one. */
export type Env = Readonly<Record<string, string | undefined>>;

/**
 * The deployment cannot be bound as configured.
 *
 * A named class, for the same reason `@the-pit/db` has `MissingDatabaseUrlError`:
 * "this deployment is not configured" and "the database refused the connection"
 * present identically and are fixed in completely different places.
 */
export class PipelineBindingError extends Error {
  override readonly name = 'PipelineBindingError';
}

/**
 * Which run's phases a store is for, when it is not the category's own.
 *
 * `store.ts` spells out the hazard: a placement's `score` envelope holds ONE
 * product's rows and its `uniqueness` envelope holds a cluster assignment, while
 * a seed run's hold the whole category and the whole roster — and both carry the
 * same four version stamps, so a shared namespace lets the resume gate hand one
 * to the other and be right to. On disk the separation is a directory; in
 * Postgres it is a row. Naming the placement here rather than smuggling it
 * through the category string is what lets each implementation express it in its
 * own terms.
 */
export interface RunScope {
  /** The engine id of the product being placed. */
  placement?: number;
}

/** The four things a deployment binds. */
export interface RunnerBindings {
  categories: CategorySource;
  /**
   * A store for one run.
   *
   * The versions are REQUIRED, not discovered from the first envelope a phase
   * writes. `PgPipelineStore` keys its `jobs` row on all four of them, so a run
   * under a bumped `prompt_version` addresses a different row, starts with no
   * phases and re-runs — the same verdict `resume.ts`'s version gate reaches by
   * comparing stamps, arrived at from the other direction. A store that had to
   * guess which run it was reading would, the day a rubric moves, hand another
   * run's phases to that gate as this run's progress.
   */
  store: (category: string, versions: PhaseVersions, scope?: RunScope) => PipelineStore;
  snapshots: SnapshotSink;
}

/**
 * Is this a deployment where an ephemeral filesystem is a correctness bug?
 *
 * `VERCEL` is set in every Vercel build and runtime, including previews — a
 * preview deployment has the same ephemeral filesystem and the same real API key
 * as production, so it gets the same rule. `NODE_ENV` catches a self-hosted
 * production server.
 */
export function requiresDurableStorage(env: Env = process.env): boolean {
  return env['VERCEL'] !== undefined || env['NODE_ENV'] === 'production';
}

/**
 * Which mode this environment binds, or a `PipelineBindingError`.
 *
 * `PIT_STORAGE` may only narrow toward durability. Setting it to `filesystem` on
 * a deployment that needs durable storage is refused rather than honoured: it is
 * the one setting that produces the double-charge above, and an environment
 * variable is not a good enough reason to allow it.
 */
export function storageMode(env: Env = process.env): StorageMode {
  const requested = env[STORAGE_MODE_ENV];
  const durable = requiresDurableStorage(env);

  if (requested === undefined || requested === '') {
    return durable ? 'postgres' : 'filesystem';
  }
  if (requested !== 'filesystem' && requested !== 'postgres') {
    throw new PipelineBindingError(
      `${STORAGE_MODE_ENV} must be "filesystem" or "postgres", got ${JSON.stringify(requested)}.`,
    );
  }
  if (requested === 'filesystem' && durable) {
    throw new PipelineBindingError(
      `${STORAGE_MODE_ENV}=filesystem is refused on this deployment.\n\n` +
        'Every invocation here gets its own filesystem, so a run whose phases land on two instances would\n' +
        'find nothing persisted and re-buy a phase the customer has already paid for (brief §2.3).\n' +
        `Unset ${STORAGE_MODE_ENV} and set ${DATABASE_URL_ENV} and ${SNAPSHOT_BUCKET_URL_ENV} instead.`,
    );
  }
  return requested;
}

const HOW_TO_FIX_BUCKET = [
  `Set ${SNAPSHOT_BUCKET_URL_ENV} to the base URL board snapshots are written under, e.g.`,
  '  https://<bucket>.example-store.com/pit',
  `and ${SNAPSHOT_BUCKET_TOKEN_ENV} to a token with write access to it.`,
  '',
  `${SNAPSHOT_PURGE_URL_ENV} is optional: set it when the CDN in front of the bucket has a purge API,`,
  'so a placement invalidates that one category\'s board path (02 §4) instead of waiting out s-maxage.',
].join('\n');

/**
 * Every reason this environment cannot be bound, in one message.
 *
 * All of them at once rather than the first: someone configuring a deployment
 * should not have to redeploy three times to be told about three variables.
 * Returns the empty array when the binding is sound.
 */
export function bindingProblems(env: Env = process.env): string[] {
  const problems: string[] = [];

  let mode: StorageMode;
  try {
    mode = storageMode(env);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  if (mode === 'filesystem') return problems;

  try {
    requireDatabaseUrl(env);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  const bucket = env[SNAPSHOT_BUCKET_URL_ENV];
  if (bucket === undefined || bucket.trim() === '') {
    problems.push(
      `${SNAPSHOT_BUCKET_URL_ENV} is not set, so a delivered board has nowhere durable to be published.\n\n` +
        HOW_TO_FIX_BUCKET,
    );
  } else if (!/^https?:\/\//.test(bucket.trim())) {
    problems.push(
      `${SNAPSHOT_BUCKET_URL_ENV} must be an http(s) URL, got ${JSON.stringify(bucket)}.\n\n${HOW_TO_FIX_BUCKET}`,
    );
  }

  return problems;
}

/**
 * Throw unless this environment can be bound. Called once, at server startup.
 *
 * The point of the timing: `brief §2.3` makes a failed run a free retry, but a
 * run that cannot PERSIST is not a failed run — it is a run that spends money and
 * then loses the receipt. Discovering that at the first paid submission is
 * discovering it too late, so it is discovered at boot instead.
 */
export function assertBindingsConfigured(env: Env = process.env): void {
  const problems = bindingProblems(env);
  if (problems.length > 0) {
    throw new PipelineBindingError(
      `The run pipeline cannot be bound in this environment (${problems.length} problem(s)):\n\n` +
        problems.join('\n\n---\n\n'),
    );
  }

  if (storageMode(env) === 'postgres' && (env[SNAPSHOT_PURGE_URL_ENV] ?? '') === '') {
    // A warning, not a failure. Some stores' CDNs revalidate on `Cache-Control`
    // alone and have no purge API at all, and `BOARD_CACHE_CONTROL` already
    // carries `stale-while-revalidate`. What it costs is latency on the one
    // property `02 §4` names, so it is said once, loudly, at startup.
    console.warn(
      `[pipeline] ${SNAPSHOT_PURGE_URL_ENV} is not set: a placement rewrites the board object but does not ` +
        `invalidate its CDN path, so the new board can be up to s-maxage (1 day) late at the edge (02 §4).`,
    );
  }
}

/**
 * One connection per process, opened on first use.
 *
 * `createDatabase` is deliberately not called at module scope — `next build`
 * imports server modules to trace them, and a connection opened at import would
 * turn a missing `DATABASE_URL` into a build failure and a present one into an
 * idle connection per cold start. `max: 1` because Neon's pooled endpoint
 * multiplexes and a large per-lambda pool exhausts it.
 */
let handle: { db: Database; close: () => Promise<void> } | undefined;

export function database(env: Env = process.env): Database {
  handle ??= createDatabase(requireDatabaseUrl(env), 1);
  return handle.db;
}

/** Drop the memoized connection. For tests and for a script that wants to exit. */
export async function closeDatabase(): Promise<void> {
  const open = handle;
  handle = undefined;
  await open?.close();
}

/**
 * The bindings for this environment.
 *
 * Throws `PipelineBindingError` when the environment cannot be bound — the same
 * check `assertBindingsConfigured` makes at startup, repeated here so a code path
 * that reaches this function without going through startup still cannot get a
 * filesystem store on Vercel.
 */
export function defaultBindings(env: Env = process.env): RunnerBindings {
  const mode = storageMode(env);
  const workdir = env['PIT_WORKDIR'] ?? 'cjr';

  if (mode === 'filesystem') {
    const snapshotRoot = env['PIT_SNAPSHOT_ROOT'] ?? `${workdir}/public`;
    return {
      categories: new FileCategorySource(workdir),
      store: (category: string, _versions: PhaseVersions, scope?: RunScope) =>
        new FilePipelineStore(
          scope?.placement === undefined ? category : placementScope(category, scope.placement),
          workdir,
        ),
      snapshots: new FileSnapshotSink(snapshotRoot),
    };
  }

  const problems = bindingProblems(env);
  if (problems.length > 0) {
    throw new PipelineBindingError(
      `The run pipeline cannot be bound in this environment (${problems.length} problem(s)):\n\n` +
        problems.join('\n\n---\n\n'),
    );
  }

  const db = database(env);
  const bucket = new HttpObjectStore({
    baseUrl: (env[SNAPSHOT_BUCKET_URL_ENV] ?? '').trim(),
    ...(env[SNAPSHOT_BUCKET_TOKEN_ENV] === undefined ? {} : { token: env[SNAPSHOT_BUCKET_TOKEN_ENV] }),
    ...(env[SNAPSHOT_PURGE_URL_ENV] === undefined || env[SNAPSHOT_PURGE_URL_ENV] === ''
      ? {}
      : { purgeUrl: env[SNAPSHOT_PURGE_URL_ENV] }),
  });

  return {
    // STILL the filesystem, and knowingly so. `cjr/` is committed, so it ships
    // with the deployment and is READ-only there — which is a different thing
    // from the store, whose whole problem was writing. What it cannot do is see a
    // placement: `brief §1.2` appends a product and bumps
    // `category_snapshot_version`, and a committed `products.json` will not have
    // it. A Postgres `CategorySource` over `categories`/`products`/
    // `jury_versions`/`persona_versions` is the fix, and it is required before
    // the first real placement, not before the first seeded run.
    categories: new FileCategorySource(workdir),
    store: (category: string, versions: PhaseVersions, scope?: RunScope) =>
      new PgPipelineStore(db, category, {
        versions,
        ...(scope?.placement === undefined ? {} : { placement: scope.placement }),
      }),
    snapshots: new BucketSnapshotSink(bucket),
  };
}

/** A run whose category is not seeded here — a 404, not a failure. */
export type RunStatusLookup = { found: true; status: RunStatus } | { found: false };

/**
 * The status of one run, reconstructed from its persisted artifacts.
 *
 * The versions come from the installed panels and the requested category version,
 * through the engine's own `phaseVersions` — the same function the pipeline
 * stamps envelopes with. That is what makes "this stored phase is stale" mean the
 * same thing on the page as it does in the next attempt, and it is the value the
 * store is addressed by.
 */
export async function loadRunStatus(
  slug: string,
  bindings: RunnerBindings = defaultBindings(),
  categoryVersion?: string,
): Promise<RunStatusLookup> {
  const input = await bindings.categories.load(
    slug,
    categoryVersion === undefined ? {} : { categoryVersion },
  );
  if (input === undefined) return { found: false };

  const versions: PhaseVersions = phaseVersions(input);
  const status = await readRunStatus({
    store: bindings.store(input.category, versions),
    versions,
    snapshots: bindings.snapshots,
  });
  return { found: true, status };
}
