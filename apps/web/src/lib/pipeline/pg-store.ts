/**
 * The durable `PipelineStore` — the same six writes and two reads, in Postgres.
 *
 * ## Why this file exists at all
 *
 * `FilePipelineStore` writes a run's phases to `cjr/runs/<slug>/` on local disk.
 * That is correct for seeding and for CI, and it is WRONG on Vercel, where the
 * filesystem is per-instance and per-invocation. `brief` Part 7 puts each phase
 * in its own Inngest step, so two steps of one run routinely execute on two
 * different lambdas. On the second of them `readPhase` would find nothing, the
 * engine's resume gate would report "never run", and the step would re-buy a
 * phase the customer has already paid for — silently, with the retry still
 * reported as free. That is the failure this module removes.
 *
 * ## The mapping, and what it deliberately does not do
 *
 *   RunStore.writePhase / readPhase   ->  jobs.phases      (jsonb, one key per phase)
 *   RunStore.writeResults / read      ->  jobs.result
 *   RunStore.writeProducts            ->  products         (engine_id pinned)
 *   RunStore.writeRanking / read      ->  snapshots.document
 *
 * Nothing here writes `score_rows`, `cluster_members`, `demand_votes` or
 * `rankings`. Those are the RAW and DERIVED projections `02 §7` keeps so a board
 * can be recomputed exactly, and they are produced by the recompute/placement
 * worker from `results.json`, not by the run store — a `RunStore` has six methods
 * and none of them is "project the score log". Writing half of `rankings` here
 * (with a null `cluster_id`, because this store never sees a cluster row) would
 * put a partly-populated board table under a query that has no way to tell it
 * from a complete one.
 *
 * ## The version stamp is preserved BYTE FOR BYTE
 *
 * `resume.ts` decides whether a stored phase may be reused, and it decides it by
 * comparing the four versions inside the stored envelope — `category_version`,
 * `prompt_version`, `persona_version`, `engine_version` — against the run in
 * progress. A bumped `prompt_version` means the stored scores came from a rubric
 * that no longer applies, and delivering them would put a board's scores under a
 * rubric that never produced them (`01 §9` rule 5, `brief §1.3`).
 *
 * So `writePhase` stores the envelope VERBATIM and `readPhase` returns it
 * verbatim. This module contains no version comparison of its own: there is one
 * gate, it lives in `resume.ts`, and a second copy here would be a second thing
 * to keep in agreement on the question of whether to spend money.
 *
 * The job row is *keyed* by those same four versions, through a deterministic
 * uuid. That is what makes a run under a bumped rubric a NEW row rather than an
 * overwrite of the old one: the old phases stay readable (`brief` Part 7's
 * integrity record) and the new run starts from an empty `phases` object, so the
 * bumped phase re-runs. The version gate and the row key agree by construction.
 *
 * ## Write-as-it-lands, and why the merge is done in SQL
 *
 * `brief §2.3`'s free retry is only free if a phase that succeeded is durable
 * BEFORE the next phase runs, so every method here is a single statement that
 * commits on its own. There is no batch at the end and no transaction spanning
 * two phases.
 *
 * The phase merge is `jobs.phases || '{"<phase>": ...}'::jsonb` inside
 * `ON CONFLICT DO UPDATE`, not a read-modify-write in TypeScript. `01 §2`'s
 * Round 1 runs the Score and Uniqueness phases CONCURRENTLY, and both land in the
 * same jsonb column: two read-modify-writes would interleave and the loser's
 * phase would vanish, which is the same re-buy this module exists to prevent,
 * reintroduced one layer down. Postgres applies `||` inside the row lock, so the
 * last writer merges rather than clobbers.
 */

import {
  categorySlug,
  digest,
  type PhaseName,
  type PhaseVersions,
  type ProductSet,
  type Ranking,
  type RunResults,
} from '@the-pit/engine';
import {
  categories,
  deterministicUuid,
  jobs,
  normalizeUrl,
  products,
  snapshots,
  submissions,
  type Database,
} from '@the-pit/db';
import { and, desc, eq, ne, or, sql, type SQL } from 'drizzle-orm';

import { SNAPSHOT_VERSION_CONFLICT } from './errors';
import type { PipelineStore } from './store';

/**
 * A run addressed at a category, or under versions, that Postgres does not hold.
 *
 * Named, because "this deployment is not provisioned for that category" and "the
 * database refused the query" are the same symptom and completely different
 * fixes — the same reason `@the-pit/db` has `MissingDatabaseUrlError`.
 */
export class PipelineStoreNotProvisionedError extends Error {
  override readonly name = 'PipelineStoreNotProvisionedError';
}

/**
 * A run produced a board that disagrees with the one already stored under its
 * `category_snapshot_version`.
 *
 * `snapshots_category_version_uk` allows exactly one board per population
 * version, and `snapshots_body_immutable_trg` refuses to edit it — because
 * `brief §1.3` keys the preview cache on that version, so two boards claiming it
 * would give one key two answers, and a verdict card stamped against the first
 * would be a claim about a board that had been rewritten underneath it.
 *
 * The raw failure is a `restrict_violation` from a trigger, three statements deep
 * inside the `rank` step. This says what actually happened and what to do, because
 * the fix — bump `categories.category_snapshot_version` and re-enqueue — is not
 * something anyone will infer from the trigger's own message.
 *
 * `code` is what makes it TERMINAL at the step boundary. The conflict is
 * deterministic — the same run over the same stored rows hits the same unique
 * every time — so retrying it spends `brief §2.3`'s three free retries
 * reproducing a fault only an operator can clear. `inngest.ts` reads this code,
 * through `isTerminalFailure`, exactly as `dispatch` reads
 * `ModelCallError.code` to demote a `max_tokens` truncation. Never by wording:
 * the message below is prose and prose gets reworded.
 */
export class SnapshotVersionConflictError extends Error {
  override readonly name = 'SnapshotVersionConflictError';
  readonly code = SNAPSHOT_VERSION_CONFLICT;
}

/** Which of `job_kind`'s members a run's job row is written under. */
export type RunJobKind = 'preview' | 'placement' | 'full_run' | 'recalibration';

/** What a `PgPipelineStore` needs beyond the category and the connection. */
export interface PgPipelineStoreOptions {
  /**
   * The four versions this run is judged under — `phaseVersions(input)`, the same
   * value the pipeline stamps its envelopes with.
   *
   * Required, and required at CONSTRUCTION rather than discovered from the first
   * envelope, because they are the job row's key. A store that guessed which job
   * row it was reading ("the most recent one for this category") would, on the
   * day a rubric is bumped mid-flight, read another run's phases and hand them to
   * the version gate as this run's progress.
   */
  versions: PhaseVersions;
  /**
   * `jobs.kind`.
   *
   * `full_run` by default, INCLUDING for a placement's scoped phase store, and
   * that is not an oversight. `jobs_placement_has_product_and_account` requires a
   * `placement` row to carry the product's uuid and the payer's email, and a run
   * store holds neither — it is handed a category and four versions. The row that
   * says "someone paid to place product X" belongs to the submission path, which
   * knows both. See `placement` below for how a placement's phases are kept
   * apart without lying about the kind.
   */
  kind?: RunJobKind;
  /**
   * The engine id of the product being PLACED, when this store holds a
   * placement's phase envelopes rather than a whole run's.
   *
   * `store.ts`'s `placementScope` states the hazard: a placement's `score`
   * envelope holds one product's rows and its `uniqueness` envelope holds a
   * cluster ASSIGNMENT, while a full run's hold the category's rows and the whole
   * roster — and both are stamped with the same four versions, so a shared
   * namespace would let the resume gate hand one to the other and be right to.
   * Nothing in the envelope says which kind of run wrote it.
   *
   * On disk that separation is a separate directory. Here it is a separate job
   * row: the id folds this in, so a placement's phases can never be resumed as a
   * seed run's, or the other way round.
   */
  placement?: number;
  /**
   * The listing somebody paid for, when this store is writing a paid placement's
   * catalogue.
   *
   * `writeProducts` receives a whole `ProductSet` and cannot tell which of its
   * rows is the submission — the engine's `Product` has a name, a URL and a
   * description and no notion of a payer, and it must not grow one. So the
   * identity arrives beside the store, from the enqueue site that read it off the
   * settled payment.
   *
   * Without it every row this store writes is `source = 'seeded'` with a null
   * submitter, which `products_source_submitter` accepts and which quietly kills
   * four rules: `brief §2.4`'s one-pitch-per-cycle cap and its
   * materially-changed-description requirement both hang off
   * `ListingSnapshot.lastPitchedAt`, which `createPostgresListingStore` reports as
   * NULL for a seeded row; the ownership rule joins an account through
   * `submitted_by_email`; and `/account` finds a customer's listing by the same
   * column. A paying customer's row labelled "unclaimed" is also `brief` Part 7
   * read backwards — that label is reserved for the cold-start listings nobody
   * has pitched.
   */
  paid?: PaidListing;
  /**
   * The `category_snapshot_version` the board THIS run publishes is stored
   * under — and the value `categories.category_snapshot_version` is moved to,
   * in the same transaction that stores it.
   *
   * Absent on a seed run and on an admin re-run, which republish a category
   * under the version they were enqueued for. Present on every PLACEMENT, and
   * it is the whole of the fix for the defect that made a paid placement
   * unable to publish at all:
   *
   * `brief §1.2` is explicit that appending a product "shifts the population
   * mean and std and therefore moves every existing z-score", so a placement
   * does not edit the board it read — it produces a DIFFERENT one. Written
   * under the version it read, that board collides with the stored snapshot and
   * `snapshots_body_immutable_trg` refuses it (correctly: `01 §9` rule 5 and
   * `brief §1.3` make a version bump the mechanism that invalidates a cached
   * board, so an unchanged version under a changed board means the bump was
   * skipped). The refusal landed inside the `rank` step, AFTER the webhook had
   * granted attempts and the pipeline had spent twelve juror calls, a
   * clustering pass and a persona round — the customer paid and the board never
   * moved.
   *
   * So the version moves WITH the board, and it moves in one transaction with
   * it. The two failures either half alone would produce are the reason:
   * a bumped version with no snapshot behind it is a board that 404s, and a
   * snapshot under a stale version is a board that never invalidates.
   *
   * It replaces `versions.category_version` for everything this store KEYS on —
   * the snapshot row and the `jobs` row that carries `results.json` — and for
   * nothing it STAMPS. The four versions inside a phase envelope are the run's
   * own and are written verbatim (see the module header); this is where the
   * run's output lands, which is a different question.
   *
   * Keying `results.json` on it too is what makes a SECOND placement work. The
   * next submission is enqueued under the bumped version, so it reads the score
   * log the previous placement appended to rather than an empty job row — and
   * the seed run's own `results.json` stays where it was written instead of
   * being overwritten by the first placement.
   */
  publishAs?: string;
}

/**
 * The `category_snapshot_version` a placement's board is published under.
 *
 * Derived rather than counted, and derived from two values that do not move
 * across a replay: the version the category was seeded or last rebuilt at, and
 * the engine id of the product being placed. `seed-1` becomes `seed-1+p8`, and
 * the NEXT placement — reading a category that now says `seed-1+p8` — becomes
 * `seed-1+p9` rather than `seed-1+p8+p9`, because the trailing `+p<id>` is
 * replaced and not appended.
 *
 * Both properties are load-bearing:
 *
 * - **Replay-stable.** Inngest re-executes a function body from the top, and on
 *   a replay `PgCategorySource` reports the version this placement has already
 *   moved the category to. Stripping the suffix means the replay computes the
 *   SAME target and lands on the snapshot it already wrote (an identical
 *   document, which `snapshots_body_immutable_trg` permits) rather than on a
 *   third version with nothing behind it.
 * - **Bounded.** A chain that appended would grow a segment per placement
 *   forever, and this string is a CDN key segment (`snapshot.ts`), a cache key
 *   (`brief §1.3`) and a column on every verdict payload.
 *
 * Engine ids are unique within a category — `products_category_engine_uk` and
 * the engine's own `assertPlaceable` both refuse a collision — so two different
 * placements can never target the same version. Two runs that DO, placing one
 * engine id twice under one root and producing different boards, are the
 * genuine conflict `SnapshotVersionConflictError` exists to report, and it still
 * reports it.
 */
export function nextCategorySnapshotVersion(current: string, engineId: number): string {
  return `${current.replace(/\+p\d+$/, '')}+p${engineId}`;
}

/** The payer behind one row of a placement's catalogue. */
export interface PaidListing {
  /** The engine id of the product that was bought. */
  readonly engineId: number;
  /** The address Dodo verified, lowercased. `products.submitted_by_email`. */
  readonly email: string;
  /**
   * The buyer asked to be published without their name or URL.
   *
   * Chosen at submission and frozen there — see `PaidPlacement.anonymous` in
   * `types.ts` and `products_anonymity_immutable`. Absent means named.
   */
  readonly anonymous?: boolean;
  /**
   * `submissions.id` — where the listing's REAL name and address are read from,
   * when the run was shown a designation instead.
   *
   * `lib/payments/enqueue.ts` redacts an anonymous submission before the event
   * is sent, so by the time a `ProductSet` reaches `writeProducts` the bought
   * row carries `Unit Kilo-427` and a blank URL. Storing that would be storing
   * the mask: `products` holds the truth and every read path redacts on the way
   * out (`pg-catalog.ts`), which is what lets a verified owner later choose to
   * be named — the one transition `products_anonymity_immutable` allows. A row
   * that had forgotten who it was would have nothing to reveal, and would also
   * lose `normalized_url`, which `brief §2.5`'s per-product cap keys on.
   *
   * **An ID, and not the name and URL themselves.** They used to ride on the
   * placement event, beside the payer's address, and that put the real identity
   * of a listing the customer asked us to withhold into an Inngest event body —
   * which is a log, a replay, and whatever observability is attached to the
   * queue. The board redacts, the payload redacts, the prompts never see it;
   * the event was the one surface that did not. So the event carries the id of
   * the row the buyer typed into, and the identity is read back here, once,
   * inside the deployment that owns the table.
   *
   * One primary-key lookup, on the `deliver` step, on the write that creates the
   * paid row. It is not on the read path and it is not on any juror prompt.
   */
  readonly submissionId?: string;
}

/**
 * `jobs` + `products` + `snapshots`, behind the engine's `RunStore`.
 *
 * One instance is one run. Two instances constructed over the same database with
 * the same category and the same versions address the SAME rows — which is the
 * whole point: that is a run whose steps landed on two Vercel instances, and it
 * has to resume.
 */
export class PgPipelineStore implements PipelineStore {
  readonly slug: string;

  private readonly db: Database;
  private readonly versions: PhaseVersions;
  private readonly kind: RunJobKind;
  private readonly jobId: string;
  private readonly paid: PaidListing | undefined;
  /**
   * The population version this run's OUTPUT is addressed by — `publishAs` when
   * the run publishes a new board, and the version it ran under otherwise.
   *
   * Read by `writeRanking`, `readRanking` and the `jobs` row key. Never by
   * `writePhase`: an envelope is stamped with `this.versions`, verbatim, and the
   * module header explains why that stamp has exactly one owner.
   */
  private readonly boardVersion: string;
  /** Set only when this run MOVES the category's version. See `publishAs`. */
  private readonly publishAs: string | undefined;
  /** Memoized so a run does not re-resolve the category on every phase. */
  private categoryIdPromise: Promise<string> | undefined;
  /** Memoized so a replayed `writeProducts` does not re-read the submission. */
  private listingPromise: Promise<{ name: string; url: string } | undefined> | undefined;

  constructor(db: Database, category: string, options: PgPipelineStoreOptions) {
    this.slug = categorySlug(category);
    if (this.slug === '') {
      throw new RangeError(`PgPipelineStore: category ${JSON.stringify(category)} has no slug`);
    }
    this.db = db;
    this.versions = options.versions;
    this.kind = options.kind ?? 'full_run';
    this.publishAs = options.publishAs;
    this.boardVersion = options.publishAs ?? options.versions.category_version;
    this.jobId = runJobId(
      this.slug,
      { ...options.versions, category_version: this.boardVersion },
      this.kind,
      options.placement,
    );
    this.paid = options.paid;
  }

  /**
   * The version the board this run publishes is stored under.
   *
   * `deliverStep` stamps the published snapshot, its CDN key and the frozen
   * verdict payload with it, so the document a reader receives names the same
   * version the `snapshots` row and `categories` do. Reading it off the store —
   * rather than passing it a second time — is what stops those two from being
   * able to disagree.
   */
  get publishedCategoryVersion(): string {
    return this.boardVersion;
  }

  /**
   * The `jobs` row this run writes into.
   *
   * Deterministic, so a resumed step in a fresh process computes the same id
   * without having to look one up, and so a second attempt under the same
   * versions lands on the same row instead of forking the run.
   */
  get runId(): string {
    return this.jobId;
  }

  // --- phases -----------------------------------------------------------------

  /**
   * Merge one phase's envelope into `jobs.phases`, creating the job row if this
   * is the first phase to land.
   *
   * One statement, committed on its own: `brief §2.3`'s retry reads this back
   * before the next phase runs.
   */
  async writePhase(phase: PhaseName, envelope: unknown): Promise<void> {
    const patch = JSON.stringify({ [phase]: envelope });
    await this.db
      .insert(jobs)
      .values({ ...(await this.jobRow()), phases: JSON.parse(patch) as Record<string, unknown> })
      .onConflictDoUpdate({
        target: jobs.id,
        // `||` on the SERVER, inside the row lock. See the module header: Round 1
        // writes two phases at once and a client-side merge would lose one.
        set: { phases: sql`${jobs.phases} || ${patch}::jsonb` },
      });
  }

  /**
   * The stored envelope, verbatim, or `undefined`. The version gate is
   * `resume.ts`'s and there is no copy of it here.
   *
   * This run's own job row first. If the phase is not on it, the most recent
   * SUPERSEDED run of the same category and kind is consulted — and that fallback
   * is the whole reason the status page can still explain itself after a version
   * bump.
   *
   * Without it, a bumped `prompt_version` would address an empty row, the phase
   * would classify `absent`, and the page would say "not started" about work that
   * is being deliberately re-bought. `readStoredPhase` has a `stale` arm that
   * names which version moved (`brief §1.3`) precisely so a customer watching the
   * clock is told why. Handing it the superseded envelope is what keeps that arm
   * alive on Postgres as well as on disk.
   *
   * It cannot cause a stale phase to be REUSED, because the fallback only ever
   * looks at rows that differ in at least one version — that predicate is in the
   * WHERE clause rather than in an argument about row keys. A row differing in a
   * version holds envelopes stamped with that version (this store writes the row's
   * columns and the envelope's stamp from the same value, in the same statement),
   * and a differing stamp is exactly what `resume.ts` refuses.
   *
   * The narrower filter matters more than it looks. A placement's phase store and
   * its category's seed run share a category, a kind and all four versions and
   * differ only in scope — so a fallback keyed on "any other job" would hand a
   * seed run's cluster ROSTER to a placement expecting a cluster ASSIGNMENT, with
   * every version matching and the resume gate right to accept it. That is the
   * hazard `store.ts`'s `placementScope` exists to prevent, and the version
   * predicate is what keeps it prevented here.
   */
  async readPhase(phase: PhaseName): Promise<unknown> {
    const own = (await this.phases(eq(jobs.id, this.jobId)))?.[phase];
    if (own !== undefined && own !== null) return own;

    const superseded = (await this.phases(await this.supersededRuns()))?.[phase];
    return superseded === null ? undefined : superseded;
  }

  // --- products ---------------------------------------------------------------

  /**
   * Pin `Product.id` for every later run and every resume.
   *
   * `products.engine_id` is unique inside a category, and that unique is what
   * `writeProducts` is FOR: `packages/engine/src/run/store.ts` spells out that
   * re-deriving the id from a sheet that has gained or lost a row renumbers every
   * product, and ids are how every stored score, cluster and vote attaches to a
   * product.
   *
   * `onConflictDoNothing` on `(category_id, engine_id)`, deliberately:
   *
   * - A product row that already exists was written by whoever owns it. For a
   *   PAID listing that is the submission path, which knows the payer's email and
   *   wrote `source = 'paid'`; overwriting it here would relabel a customer's
   *   listing as unclaimed scaffolding.
   * - `migrations/0002_append_only_guards.sql` freezes a scored product's text,
   *   URL, name and engine id anyway. An UPDATE that touched them would be
   *   refused by the trigger, and it should be — the score log is the integrity
   *   record and it has to keep naming the sentence the juror deducted from.
   *
   * Rows this store DOES create are `seeded`/`pending` — a category being run has
   * a population, and nothing in it is placed until the board is published — with
   * ONE exception. When the store was built for a paid placement (`paid` in
   * `PgPipelineStoreOptions`), the row for that engine id is written
   * `source = 'paid'` with the payer's address, because that is the submission
   * path and this is where it writes. `products_source_submitter` enforces the
   * pairing in the database: paid implies an address, seeded implies none, and
   * there is no third state for a row to drift into.
   *
   * `normalized_url` is recomputed with the engine's `normalizeUrl` rather than
   * copied from the product, for the reason `packages/db/src/seed/build.ts`
   * states: the column's whole job is to be the one identity `brief §2.5`'s
   * per-product cap keys on, and a stored value could have been normalized by an
   * older revision of the rules.
   */
  async writeProducts(set: ProductSet): Promise<void> {
    if (set.products.length === 0) return;
    const categoryId = await this.categoryId();
    const listing = await this.boughtListing();

    /**
     * A redacted row with nothing to un-redact it is refused, loudly.
     *
     * A blank `url` is the sentinel `lib/payments/enqueue.ts` sets on an
     * anonymous submission and the one `deliverStep` and `verdictPayload` both
     * read. Writing that row as it stands would store the DESIGNATION as the
     * listing's name and an empty string as its address — a `products` row that
     * has forgotten who it is, with nothing for the one legal reveal to reveal
     * and no `normalized_url` for `brief §2.5`'s per-product cap to key on. Both
     * are frozen by `products_scored_identity_immutable` the moment the row is
     * scored, so there is no later correction.
     *
     * Failing here costs a support conversation on a board that is already
     * published; writing it costs a listing that can never be claimed.
     */
    const boughtProduct = set.products.find((product) => product.id === this.paid?.engineId);
    if (this.paid !== undefined && boughtProduct?.url === '' && listing === undefined) {
      throw new PipelineStoreNotProvisionedError(
        `the paid listing at engine id ${this.paid.engineId} in ${JSON.stringify(this.slug)} reached the ` +
          'catalogue write wearing its designation, and the submission row that holds its real name and ' +
          `address could not be read (submissions.id ${JSON.stringify(this.paid.submissionId ?? '(none)')}). ` +
          'products stores the truth and every read path redacts on the way out (pg-catalog.ts); a row ' +
          'written from the mask would be unclaimable and would lose the normalized_url brief §2.5 keys ' +
          'its per-product cap on.',
      );
    }

    await this.db
      .insert(products)
      .values(
        set.products.map((product) => {
          const bought = this.paid !== undefined && this.paid.engineId === product.id;
          /**
           * The bought row is written under its REAL identity even when the run
           * was shown a designation. See `PaidListing.submissionId`: `products`
           * stores the truth and the read paths redact, which is the only
           * arrangement in which a verified owner can later choose to be named —
           * and the only one that keeps `normalized_url` pointing at the address
           * the cap keys on.
           */
          const name = bought ? listing?.name ?? product.name : product.name;
          const url = bought ? listing?.url ?? product.url : product.url;
          return {
            id: deterministicUuid('product', this.slug, String(product.id)),
            categoryId,
            engineId: product.id,
            name,
            url,
            normalizedUrl: normalizeUrl(url),
            description: product.description,
            descriptionHash: digest(product.description),
            source: bought ? ('paid' as const) : ('seeded' as const),
            /**
             * Scaffolding rows are seeded, and a seeded row is anonymous —
             * `products_seeded_is_anonymous` accepts nothing else for an
             * unclaimed one (`DECISIONS.md`, S4-source: 913 of the 1028 seeded
             * descriptions were scraped rather than written by the companies).
             *
             * The PAID row takes the choice the buyer made at submission, which
             * arrives on `this.paid`. It is written here and never revisited: the
             * `onConflictDoNothing` above means a listing whose row already
             * exists keeps the choice it was created with, and
             * `products_anonymity_immutable` would refuse an UPDATE anyway.
             */
            anonymous: bought ? this.paid?.anonymous ?? false : true,
            status: 'pending' as const,
            // `products_email_lowercase` and `accounts_email_lowercase` are the
            // same rule on two tables: one address is one person. Lowercased here
            // rather than trusted, because the value crosses a queue.
            submittedByEmail: bought ? this.paid?.email.toLowerCase() ?? null : null,
          };
        }),
      )
      .onConflictDoNothing({ target: [products.categoryId, products.engineId] });
  }

  // --- results ----------------------------------------------------------------

  /** `results.json`, on the job row. Creates the row if no phase reached it first. */
  async writeResults(results: RunResults): Promise<void> {
    await this.db
      .insert(jobs)
      .values({ ...(await this.jobRow()), result: results })
      .onConflictDoUpdate({ target: jobs.id, set: { result: sql`excluded.result` } });
  }

  async readResults(): Promise<RunResults | undefined> {
    const [row] = await this.db
      .select({ result: jobs.result })
      .from(jobs)
      .where(eq(jobs.id, this.jobId))
      .limit(1);
    const result = row?.result;
    return result === null || result === undefined ? undefined : (result as RunResults);
  }

  // --- the board --------------------------------------------------------------

  /**
   * `ranking.json`, as a `snapshots` row.
   *
   * The document is stored verbatim, which is what makes `readRanking` able to
   * return the engine's own artifact rather than a reassembly of it. `02 §9`:
   * the ranking is "a derived artifact ... always reproducible by running the
   * ported `rank_final` over the rows", and `brief` Part 7 wants the stored copy
   * anyway, because a verdict card is a claim about a board at an instant and a
   * CDN object can be purged.
   *
   * The conflict target is `(category_id, category_snapshot_version)` — the
   * schema's own unique — and the conflict action is DO UPDATE rather than DO
   * NOTHING, which is the interesting choice:
   *
   * - A retried `rank` step recomputes the same arithmetic over the same stored
   *   rows and writes a byte-identical document. `snapshots_body_immutable_trg`
   *   compares `IS DISTINCT FROM`, so an identical rewrite passes and the retry is
   *   idempotent.
   * - A run that produced a DIFFERENT board under the same
   *   `category_snapshot_version` hits the trigger and fails loudly, naming the
   *   snapshot. That is the case worth failing on: `brief §1.2` moves every
   *   z-score on a placement, so a changed board under an unchanged population
   *   version means somebody forgot to bump it — and `DO NOTHING` would swallow
   *   that, leave the OLD board in place, and let `readRanking` hand the delivered
   *   run a ranking of a population it was not computed over.
   *
   * ## The version moves with the board, in this transaction and no other
   *
   * When the run is a PLACEMENT (`publishAs`), the board being written is a new
   * board — `brief §1.2` moves every z-score the moment a product is appended —
   * so it is written under a new version, and `categories.category_snapshot_version`
   * is moved to that same value here, in the same transaction.
   *
   * One transaction rather than two statements, because the two halves fail in
   * opposite and equally bad directions. A version bumped with no snapshot behind
   * it is a board that 404s for everyone holding a link to it. A snapshot stored
   * under a version the category never moved to is a board nothing invalidates:
   * `brief §1.3` keys the preview cache on this column, so the next reader is
   * served the ranks of a population the board no longer describes. Rolled back
   * together, neither state exists — the placement either published or it did
   * not.
   *
   * The conflict is still a conflict. It simply is not one a legitimate placement
   * can reach any more, which is what it was before: the placement wrote under
   * the version it had read, the trigger refused it, and `SnapshotVersionConflictError`
   * came out of the `rank` step after the customer had been charged.
   */
  async writeRanking(ranking: Ranking): Promise<void> {
    const categoryId = await this.categoryId();
    const version = this.boardVersion;
    const row = {
        id: deterministicUuid('snapshot', this.slug, version),
        categoryId,
        categorySnapshotVersion: version,
        promptVersion: ranking.prompt_version,
        personaVersion: ranking.demand_version,
        uniquenessVersion: ranking.uniqueness_version,
        productCount: ranking.ranking.length,
      document: ranking,
      health: ranking.health,
      url: null,
      publishedAt: null,
    } satisfies typeof snapshots.$inferInsert;

    const publishAs = this.publishAs;

    try {
      await this.db.transaction(async (tx) => {
        await tx
          .insert(snapshots)
          .values(row)
          .onConflictDoUpdate({
            target: [snapshots.categoryId, snapshots.categorySnapshotVersion],
            set: { document: row.document, health: row.health, productCount: row.productCount },
          });

        if (publishAs === undefined) return;

        // The bump, inside the same transaction as the board it belongs to.
        // Unconditional on the CURRENT value rather than compare-and-set: this
        // run has already produced the board that version names, and a placement
        // that found the column somewhere else would be one that had raced with
        // another placement — which `placeProductFunction`'s per-slug concurrency
        // of 1 does not permit, and which a silent no-op here would hide.
        await tx
          .update(categories)
          .set({ categorySnapshotVersion: publishAs, updatedAt: new Date() })
          .where(eq(categories.id, categoryId));
      });
    } catch (cause) {
      throw new SnapshotVersionConflictError(
        `the board for ${JSON.stringify(this.slug)} at category_snapshot_version ` +
          `${JSON.stringify(version)} already exists and is different from the one this run ` +
          'produced. A published board is immutable, because a verdict card is stamped against it at an instant ' +
          '(brief Part 3, Part 5).\n\n' +
          'A board changes when the population changes, when the jury is re-approved, or when the customer panel ' +
          'is — and every one of those has to arrive with a new category_snapshot_version, which is also what ' +
          "invalidates brief §1.3's preview cache. Bump categories.category_snapshot_version and enqueue the run " +
          'under the new value.',
        { cause },
      );
    }
  }

  /**
   * The board for THIS run's population version.
   *
   * Addressed by `(category_id, category_snapshot_version)` — the schema's own
   * unique — rather than by "the latest snapshot". `brief §1.2` moves every
   * z-score on every placement, so the newest board is a different board, and
   * `status.ts` reports a ranking from a superseded version as `pending` for
   * exactly that reason.
   */
  async readRanking(): Promise<Ranking | undefined> {
    const categoryId = await this.categoryId();
    const [row] = await this.db
      .select({ document: snapshots.document })
      .from(snapshots)
      .where(
        and(
          eq(snapshots.categoryId, categoryId),
          eq(snapshots.categorySnapshotVersion, this.boardVersion),
        ),
      )
      .limit(1);
    return row === undefined ? undefined : (row.document as Ranking);
  }

  // --- internals ---------------------------------------------------------------

  /**
   * Runs of this category and kind that were judged under DIFFERENT versions.
   *
   * The only rows `readPhase` is allowed to fall back to. See `readPhase`.
   */
  private async supersededRuns(): Promise<SQL | undefined> {
    return and(
      eq(jobs.categoryId, await this.categoryId()),
      eq(jobs.kind, this.kind),
      ne(jobs.id, this.jobId),
      or(
        ne(jobs.categorySnapshotVersion, this.boardVersion),
        ne(jobs.promptVersion, this.versions.prompt_version),
        ne(jobs.personaVersion, this.versions.persona_version),
        ne(jobs.engineVersion, this.versions.engine_version),
      ),
    );
  }

  /** The `phases` object of the newest job matching `where`, if there is one. */
  private async phases(where: SQL | undefined): Promise<Record<string, unknown> | undefined> {
    const [row] = await this.db
      .select({ phases: jobs.phases })
      .from(jobs)
      .where(where)
      .orderBy(desc(jobs.createdAt))
      .limit(1);
    const stored = row?.phases;
    if (stored === null || stored === undefined || typeof stored !== 'object') return undefined;
    return stored as Record<string, unknown>;
  }

  /** The insert side of every upsert: the columns a `jobs` row cannot be without. */
  private async jobRow(): Promise<typeof jobs.$inferInsert> {
    return {
      id: this.jobId,
      kind: this.kind,
      // Never `succeeded`, and never `delivered_at`. `brief §2.3` makes delivery
      // the money event — it is the precondition the attempt ledger checks before
      // it will accept a decrement — and it is consumed by `PipelineDeps.onDelivered`
      // in the transaction that writes the verdict, not by the store that
      // persisted the phases.
      status: 'running',
      categoryId: await this.categoryId(),
      promptVersion: this.versions.prompt_version,
      personaVersion: this.versions.persona_version,
      categorySnapshotVersion: this.boardVersion,
      engineVersion: this.versions.engine_version,
    };
  }

  /**
   * The category's uuid, or a loud failure.
   *
   * A run cannot be enqueued for a category whose panels have not been approved
   * and installed (`01 §4` Steps 2 and 3 are human gates), so a slug with no row
   * is a misconfigured deployment rather than an empty one. Failing here, by
   * name, beats a foreign-key violation from three statements further on.
   */
  /**
   * The real name and address of the listing somebody paid to place.
   *
   * Read from `submissions` — the row the buyer typed into, before checkout
   * opened — rather than carried on the placement event, because an event body
   * is a log and a replay and the whole point of an anonymous listing is that
   * its name is not in one. See `PaidListing.submissionId`.
   *
   * `undefined` when there is no payer, no submission id (an admin placement, or
   * an event written before the id was carried), or no such row. Two of those
   * three are ordinary; `writeProducts` decides which of them is fatal, because
   * it is the only one that can see whether the row it is about to write arrived
   * redacted.
   *
   * Memoized, so a replayed `deliver` step re-reads nothing.
   */
  private boughtListing(): Promise<{ name: string; url: string } | undefined> {
    this.listingPromise ??= (async () => {
      const submissionId = this.paid?.submissionId;
      if (submissionId === undefined || submissionId === '') return undefined;
      const [row] = await this.db
        .select({ name: submissions.name, url: submissions.url })
        .from(submissions)
        .where(eq(submissions.id, submissionId))
        .limit(1);
      return row;
    })();
    return this.listingPromise;
  }

  private categoryId(): Promise<string> {
    this.categoryIdPromise ??= (async () => {
      const [row] = await this.db
        .select({ id: categories.id })
        .from(categories)
        .where(eq(categories.slug, this.slug))
        .limit(1);
      if (row === undefined) {
        throw new PipelineStoreNotProvisionedError(
          `no category is installed under the slug ${JSON.stringify(this.slug)}. ` +
            'A run writes into `jobs`, `products` and `snapshots`, all of which hang off `categories.id`; ' +
            'seed the category (pnpm --filter @the-pit/db db:seed) or install its jury and persona panel ' +
            'before enqueuing a run against it.',
        );
      }
      return row.id;
    })();
    return this.categoryIdPromise;
  }
}

/**
 * The job row a run under these versions writes into.
 *
 * Derived from the slug and all four versions, so:
 *
 * - a retry of the same run finds the same row and the phases already on it;
 * - a run under a BUMPED version gets a different row, starts with no phases, and
 *   therefore re-runs every phase — the same answer `resume.ts`'s version gate
 *   gives, arrived at from the other direction;
 * - the superseded run's phases stay readable, which is what `brief` Part 7 asks
 *   of the integrity record.
 *
 * `kind` is in the key because a `preview` and a `full_run` can carry identical
 * version stamps and are not the same work — `brief §2.6`'s preview asks one
 * juror about one metric. Sharing a row would let one be resumed as the other,
 * and the version gate could not tell, because every version it compares matches.
 */
export function runJobId(
  slug: string,
  versions: PhaseVersions,
  kind: RunJobKind = 'full_run',
  placement?: number,
): string {
  return deterministicUuid(
    'job',
    slug,
    kind,
    placement === undefined ? 'run' : `placement:${placement}`,
    versions.category_version,
    versions.prompt_version,
    versions.persona_version,
    versions.engine_version,
  );
}

/**
 * The most recent run recorded for a category, whatever versions it ran under.
 *
 * Not used by the store — a store always knows its own versions — but the
 * admin-facing question "what happened here last?" has no other answer, and
 * putting it beside the id derivation keeps the two consistent.
 */
export async function latestRunVersions(db: Database, slug: string): Promise<PhaseVersions | undefined> {
  const [row] = await db
    .select({
      category_version: jobs.categorySnapshotVersion,
      prompt_version: jobs.promptVersion,
      persona_version: jobs.personaVersion,
      engine_version: jobs.engineVersion,
    })
    .from(jobs)
    .innerJoin(categories, eq(categories.id, jobs.categoryId))
    .where(eq(categories.slug, slug))
    .orderBy(desc(jobs.createdAt))
    .limit(1);
  return row;
}
