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
 * `postgres` is `PgPipelineStore` and `PgCategorySource` over `@the-pit/db`, and
 * `BucketSnapshotSink` over an object store. All three are addressable from any
 * instance, which is the whole property the filesystem lacks — and the category
 * source is on that list because a placement APPENDS a product and bumps
 * `category_snapshot_version`, and a committed `products.json` cannot see either
 * (`brief §1.2`).
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
import { createDatabase, requireDatabaseUrl, type Database } from '@the-pit/db';

import { FileCategorySource, type CategorySource } from './catalog';
import { MemoryPlacementClaims, type PlacementClaims } from './claims';
import { PipelineBindingError, storageMode, workdirOf, type Env } from './mode';
import { assertBindingsConfigured, bindingProblems } from './bindings';
import { PgPlacementClaims } from './pg-claims';
import { PgCategorySource } from './pg-catalog';
import { PgPipelineStore, nextCategorySnapshotVersion, type PaidListing } from './pg-store';
import { createPostgresSubmissionRunSource, type SubmissionRunSource } from './run-lookup';
import { defaultSnapshotSink } from './sink';
import { pendingRunStatus, readRunStatus, type RunStatus } from './status';
import type { SnapshotSink } from './snapshot';
import { FilePipelineStore, PlacementPhaseStore, placementScope, type PipelineStore } from './store';

/**
 * Re-exported from `mode.ts`, which is dependency-free so the board READ path can
 * ask the same question without importing a database driver. One rule, two
 * callers; see that module's header.
 */
export {
  DATABASE_URL_ENV,
  isProductionBuild,
  PipelineBindingError,
  requiresDurableStorage,
  SNAPSHOT_BUCKET_TOKEN_ENV,
  SNAPSHOT_BUCKET_URL_ENV,
  SNAPSHOT_PURGE_URL_ENV,
  STORAGE_MODE_ENV,
  storageMode,
} from './mode';
export type { Env, StorageMode } from './mode';
export { defaultSnapshotSink } from './sink';
export type { PaidListing } from './pg-store';
export type { SubmissionRecord, SubmissionRun, SubmissionRunSource } from './run-lookup';

/**
 * The buyer's submission lookup, over the deployment's own connection.
 *
 * A function rather than a constant, for the same reason `database()` is: an
 * import-time connection would turn a missing `DATABASE_URL` into a build
 * failure, and `next build` imports every server module to trace it.
 */
export function submissionRunSource(env: Env = process.env): SubmissionRunSource {
  return createPostgresSubmissionRunSource(database(env));
}

/**
 * The startup binding check, re-exported from the leaf module that owns it.
 *
 * It moved to `./bindings` because `src/instrumentation.ts` is its only caller
 * and Next compiles instrumentation in a pass where `serverExternalPackages` does
 * not apply — so the `@the-pit/engine` import below (and the `node:crypto` inside
 * it) turned a boot check into a build failure that 500'd every route. The check
 * reads environment variables and needs none of this module's graph; see
 * `./bindings` for the full account. The names stay here because every caller and
 * every test already asks for them here.
 */
export { assertBindingsConfigured, bindingProblems };

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
  /**
   * The payer behind the product being placed, when one paid.
   *
   * Separate from `placement` because they name different things and are needed
   * in different places: `placement` scopes the PHASE envelopes to their own job
   * row, and this marks one row of the CATEGORY's catalogue as bought. A store
   * built with it writes `products.source = 'paid'` and the submitter's address
   * for that engine id; `PgPipelineStore`'s `writeProducts` says why that matters
   * and which four rules die without it.
   *
   * The filesystem store ignores it. `cjr/products.json` has no `source` column,
   * and the rules that read one are Postgres rules.
   */
  paid?: PaidListing;
  /**
   * The `category_snapshot_version` this run's board is published under, when
   * the run MOVES the category's version — which every placement does.
   *
   * `brief §1.2`: appending a product shifts the population mean and std and
   * moves every existing z-score, so a placement does not edit the board it read,
   * it produces a different one. `PgPipelineStore` writes it under this version
   * and moves `categories.category_snapshot_version` to the same value in the
   * same transaction; see `publishAs` there for what each half alone would break.
   *
   * The filesystem store ignores it, as it ignores `paid`, and for the same kind
   * of reason: `cjr/runs/<slug>/ranking.json` is one file that is overwritten,
   * there is no `categories` row to move, and every rule this value serves is a
   * Postgres rule.
   */
  publishAs?: string;
}

/** What a deployment binds. */
export interface RunnerBindings {
  categories: CategorySource;
  /**
   * Where a submission's idempotency key is claimed, so one payment buys one
   * placement.
   *
   * Required rather than optional. A second `pit/placement.requested` for one
   * submission is not double-charged — `brief §2.3` consumes an attempt only on
   * delivery — it is double-RUN, twelve juror calls for one $5, and the customer
   * cannot see it so it never becomes a support ticket. A binding that could be
   * left off is a binding that will be.
   */
  claims: PlacementClaims;
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
  const workdir = workdirOf(env);

  if (mode === 'filesystem') {
    return {
      categories: new FileCategorySource(workdir),
      // Per-process, like the filesystem store beside it and for the same reason:
      // correct locally, useless across two lambdas, and unreachable in
      // production because `storageMode` refuses `filesystem` there.
      claims: new MemoryPlacementClaims(),
      store: (category: string, _versions: PhaseVersions, scope?: RunScope) =>
        new FilePipelineStore(
          scope?.placement === undefined ? category : placementScope(category, scope.placement),
          workdir,
        ),
      // `defaultSnapshotSink` and not a `FileSnapshotSink` written out here: the
      // board READ path resolves its sink through the same function, and two
      // constructions is how a placement comes to publish somewhere nobody reads.
      snapshots: defaultSnapshotSink(env),
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

  return {
    // The tables the placement path writes, not the files the last commit froze.
    //
    // A committed `cjr/` ships with the deployment and reads perfectly well,
    // which is why this was the filesystem for one commit longer than the store
    // was. What it cannot do is see a placement: `brief §1.2` appends a product
    // and bumps `category_snapshot_version`, and a committed `products.json` has
    // neither — so the first paid placement would be scored against a population
    // that excludes it, under a version that had already moved. Not a crash. A
    // wrong board.
    //
    // Bound by MODE, with no fallback, for the same reason the store is: the
    // wrong choice here is silent. `DATABASE_URL` is already required in this
    // mode by `bindingProblems`, and `assertBindingsConfigured` checks it at boot
    // — so a deployment that cannot reach the categories table fails in its
    // startup logs rather than forty seconds into someone's paid run.
    categories: new PgCategorySource(db),
    // `jobs.idempotency_key` and its UNIQUE index — the guard `packages/payments`
    // computes a key for and `packages/db` indexes, which nothing was reading.
    claims: new PgPlacementClaims(db),
    store: (category: string, versions: PhaseVersions, scope?: RunScope) =>
      new PgPipelineStore(db, category, {
        versions,
        ...(scope?.placement === undefined ? {} : { placement: scope.placement }),
        ...(scope?.paid === undefined ? {} : { paid: scope.paid }),
        ...(scope?.publishAs === undefined ? {} : { publishAs: scope.publishAs }),
      }),
    // Same factory as the filesystem branch and as the board read path.
    snapshots: defaultSnapshotSink(env),
  };
}

/** A run whose category is not seeded here — a 404, not a failure. */
export type RunStatusLookup = { found: true; status: RunStatus } | { found: false };

/** What `/status/s/<submission>` renders. */
export interface SubmissionStatusView {
  readonly submissionId: string;
  /** The name the buyer typed. Their own page, so their own name, not a designation. */
  readonly name: string;
  readonly categorySlug: string;
  readonly status: RunStatus;
  /** `verdicts.public_slug`, once there is one. The thing they paid for. */
  readonly verdictSlug: string | null;
}

export type SubmissionStatusLookup = { found: true; view: SubmissionStatusView } | { found: false };

/**
 * One buyer's run, resolved from their submission and read at the version
 * stamped on their JOB.
 *
 * The three lines that matter are the three stamps, and every one of them comes
 * off the job row rather than off the category:
 *
 * - the versions the phases are judged against are `phaseVersions` of the
 *   category loaded AT `jobs.category_snapshot_version` — the population this run
 *   read, not the one a later placement moved it to;
 * - the phases themselves live in the placement's own scope, keyed by
 *   `jobs.placement_engine_id`, because a placement's `score` envelope holds one
 *   product and a seed run's holds forty;
 * - the board is compared at `publishAs`, the version this placement produces,
 *   because `brief §1.2` makes the board that comes out a different board from
 *   the one that went in.
 *
 * Get any of the three from `categories.category_snapshot_version` instead and
 * the page reports an empty run the moment somebody else's placement lands.
 */
export async function loadSubmissionStatus(
  submissionId: string,
  runs: SubmissionRunSource,
  bindings: RunnerBindings = defaultBindings(),
): Promise<SubmissionStatusLookup> {
  const record = await runs.find(submissionId);
  if (record === null) return { found: false };

  const base = {
    submissionId: record.submissionId,
    name: record.name,
    categorySlug: record.run?.categorySlug ?? record.categorySlug,
  };

  // Paid, and not yet enqueued. Honest, and better than a 404 — see
  // `pendingRunStatus`.
  if (record.run === null) {
    const category = await bindings.categories.load(record.categorySlug);
    const versions = category === undefined ? UNKNOWN_VERSIONS : phaseVersions(category);
    return {
      found: true,
      view: { ...base, status: pendingRunStatus(record.categorySlug, versions), verdictSlug: null },
    };
  }

  const run = record.run;
  const input = await bindings.categories.load(run.categorySlug, { categoryVersion: run.categoryVersion });
  if (input === undefined) {
    // The category was withdrawn, or its version rolled back, under a run that is
    // still on the books. Nothing further happens to it without a person, which
    // is what `needs_support` means — and the customer is owed that sentence
    // rather than a 404 on a page they paid to reach.
    const stopped = { ...pendingRunStatus(run.categorySlug, UNKNOWN_VERSIONS), state: 'needs_support' as const };
    return { found: true, view: { ...base, status: stopped, verdictSlug: run.verdictSlug } };
  }

  const versions: PhaseVersions = phaseVersions(input);

  // The same pair of handles `executePlacement` runs through: phases in the
  // placement's own scope, board and ranking on the category's. Built here from
  // the same bindings and the same `nextCategorySnapshotVersion`, so a status
  // read and the run it describes cannot disagree about which rows either means.
  const board =
    run.engineId === null
      ? bindings.store(input.category, versions)
      : bindings.store(input.category, versions, {
          publishAs: nextCategorySnapshotVersion(versions.category_version, run.engineId),
        });
  const store =
    run.engineId === null
      ? board
      : new PlacementPhaseStore(board, bindings.store(input.category, versions, { placement: run.engineId }));

  // Read off the store, exactly as `placementDeliverStep` reads it when it stamps
  // the board. A second derivation here is how a status page comes to compare the
  // published snapshot against a version nothing published it under — and the
  // bindings that key no board by version (memory, filesystem) answer `undefined`
  // and fall back to the version the run read, which is what they publish at.
  const boardVersion = store.publishedCategoryVersion ?? versions.category_version;

  const status = await readRunStatus({ store, versions, snapshots: bindings.snapshots, boardVersion });

  return {
    found: true,
    view: {
      ...base,
      // A verdict row is the settled fact of delivery — it is written in the same
      // transaction that consumes the attempt (`brief §2.3`). If one exists the
      // run is done, whatever the board comparison two lines up concluded.
      status: run.verdictSlug === null ? status : { ...status, state: 'delivered' },
      verdictSlug: run.verdictSlug,
    },
  };
}

/**
 * The stamps of a run whose category cannot be loaded.
 *
 * Empty strings and not a guess. Every version comparison downstream is an
 * equality against a stored stamp, and an empty one matches nothing — so a phase
 * is reported `pending` rather than silently reused under versions nobody
 * checked.
 */
const UNKNOWN_VERSIONS: PhaseVersions = {
  category_version: '',
  prompt_version: '',
  persona_version: '',
  engine_version: '',
};

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
