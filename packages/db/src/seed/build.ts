/**
 * Turn one seeded category's run artifacts into rows.
 *
 * Pure: it takes parsed JSON in and returns row objects out. No filesystem, no
 * database, no clock. `src/cli/seed.ts` reads the files and writes the rows;
 * everything worth testing is here.
 *
 * ## What it reads, and why it needs more than `ranking.json`
 *
 * The board is `cjr/runs/<slug>/ranking.json` (`01 §6.6`), and it is the primary
 * input. Two things it does not carry have to come from beside it:
 *
 * - Product descriptions and URLs — `cjr/runs/<slug>/products.json`, written by
 *   the engine's own `FileRunStore` in the same directory. `ranking.json` carries
 *   a name and a URL per row but never the description text, and
 *   `products.description_hash` and the `SANITIZE_LIMIT` check both need it.
 * - The juror roster — `cjr/references/jurors/<slug>.json`. Needed to reconstruct
 *   the per-juror score rows; see below.
 *
 * ## Reconstructing the raw score rows from a board
 *
 * `02 §7` and `brief` Part 7 make `score_rows` the source of truth, so seeding
 * only the reduced board would produce a category that cannot be recomputed —
 * exactly the failure mode the schema exists to prevent.
 *
 * `ranking.json`'s merged scorecard is enough to recover them exactly, because of
 * an invariant `01 §5.1` states outright: a metric starts at 100 and the
 * deductions for it **sum to exactly `100 - score`**. Each deduction on the
 * merged scorecard is tagged with the `role` that took it (`ScorecardDeduction`),
 * so for every (product, metric, juror):
 *
 *     score = 100 - sum(points of that juror's deductions on that metric)
 *
 * A juror who took nothing scored 100. A juror listed in `substituted_roles`
 * returned nothing at all and gets NO row — storing the `SCORE_CLAMP_DEFAULT`
 * the board published in its place would fabricate an opinion in the integrity
 * record. (`ScoreCoverage` in the engine calls a non-empty `substituted_roles`
 * a degraded verdict; neither seeded board has one.)
 *
 * ## The one thing that cannot be reconstructed
 *
 * A persona's `none` answer — "nothing in this set was worth adopting" — leaves
 * no trace anywhere in `ranking.json`, because it attaches to no product's picks.
 * `reduceDemand` in the engine treats it as load-bearing: a cluster where every
 * persona answered `none` DID convene and reduces to a real demand of 0, while a
 * cluster nobody was asked about is skipped and its members rank merit-only under
 * `DECISIONS.md` S3. Seeded from the board alone, the first becomes the second.
 *
 * So when `results.json` — the engine's own raw record, same directory — is
 * available, it is used instead and the fidelity is exact. When it is not (it is
 * git-ignored; a fresh clone has only the board), the board is reconstructed and
 * `SeedRows.warnings` says so in as many words. `source` records which happened.
 */

import type {
  DemandLogEntry,
  Jury,
  Persona,
  PersonaPanel,
  ProductSet,
  Ranking,
  RunResults,
  ScoreLogEntry,
  UniquenessResult,
} from '@the-pit/engine';
import { categorySlug, digest } from '@the-pit/engine';

import { verdictSlug } from '../identity.js';
import { redactRanking } from '@the-pit/anon';

import { verdictPayload } from '../verdict-payload.js';
import { normalizeUrl } from '../normalized-url.js';
import type {
  accounts,
  attempts,
  categories,
  clusterMembers,
  clusters,
  demandVotes,
  flaggedInjections,
  juryVersions,
  personaVersions,
  products,
  rankings,
  scoreRows,
  snapshots,
  verdicts,
} from '../schema/index.js';
import { deterministicUuid } from './ids.js';

/** Everything one seeded category contributes, in dependency order. */
export interface SeedRows {
  category: typeof categories.$inferInsert;
  juryVersion: typeof juryVersions.$inferInsert;
  personaVersion: typeof personaVersions.$inferInsert;
  products: (typeof products.$inferInsert)[];
  scoreRows: (typeof scoreRows.$inferInsert)[];
  clusters: (typeof clusters.$inferInsert)[];
  clusterMembers: (typeof clusterMembers.$inferInsert)[];
  demandVotes: (typeof demandVotes.$inferInsert)[];
  snapshot: typeof snapshots.$inferInsert;
  rankings: (typeof rankings.$inferInsert)[];
  flaggedInjections: (typeof flaggedInjections.$inferInsert)[];
  /**
   * One frozen verdict page per ranked product — `brief` Part 6's "public
   * permanent URL, shareable, works logged out". See `buildVerdicts`.
   */
  verdicts: (typeof verdicts.$inferInsert)[];
  /**
   * The payers behind this category's listings, derived from
   * `products.submitted_by_email`.
   *
   * EMPTY for the two Phase 1 boards, and that is the schema saying something
   * true rather than a stub: `products_source_submitter` requires a `seeded` row
   * to have a null submitter, and `brief` Part 7 seeds those rows as UNCLAIMED
   * ("mark clearly as unclaimed, offer one-click opt-out"). A seed that invented
   * an account for them would fabricate a payer for money nobody spent, and give
   * `POST /auth/request` a live address to mail.
   *
   * It is derived from the product rows rather than written as a literal `[]` so
   * that the rule is stated once — an account exists because a listing names a
   * payer — instead of being an assumption a later change could silently break.
   */
  accounts: (typeof accounts.$inferInsert)[];
  /** Always empty: a seeded product was never bought. Present so the shape is total. */
  attempts: (typeof attempts.$inferInsert)[];
  /** Where the raw votes came from. See the header. */
  source: SeedSource;
  /** Fidelity losses, if any. Printed by the seed CLI rather than swallowed. */
  warnings: string[];
}

/**
 * - `results` — `results.json` was supplied; the raw logs are verbatim.
 * - `ranking` — reconstructed from the board. `none` votes are absent.
 */
export type SeedSource = 'results' | 'ranking';

/** The artifacts one seeded category is built from. */
export interface SeedInput {
  /** `cjr/runs/<slug>/ranking.json`. */
  ranking: Ranking;
  /** `cjr/runs/<slug>/products.json`. */
  productSet: ProductSet;
  /** `cjr/references/jurors/<slug>.json`. */
  jury: Jury;
  /** `cjr/references/personas/<slug>.json`. */
  panel: PersonaPanel;
  /** `cjr/runs/<slug>/results.json`, when it exists. Raises fidelity to exact. */
  results?: RunResults | undefined;
  /**
   * `brief §1.3`'s `category_snapshot_version` for the seeded population.
   * `RunMeta.category_version` when `results` is present; otherwise the caller's.
   */
  categorySnapshotVersion: string;
  /** Recorded on both approval gates. `02 §8`: an approval with no approver is not one. */
  approvedBy: string;
}

/** Who to credit for the panels a seed installs. */
export const SEED_APPROVER = 'seed:phase-1';

/** Build every row for one seeded category. */
export function buildSeedRows(input: SeedInput): SeedRows {
  const { ranking, productSet, jury, panel } = input;

  if (ranking.category !== productSet.category) {
    throw new RangeError(
      `buildSeedRows: ranking is for ${JSON.stringify(ranking.category)} but products are for ` +
        `${JSON.stringify(productSet.category)}`,
    );
  }

  const slug = categorySlug(ranking.category);
  if (slug === '') {
    throw new RangeError(`buildSeedRows: category ${JSON.stringify(ranking.category)} has no slug`);
  }

  const categoryId = deterministicUuid('category', slug);
  const warnings: string[] = [];
  const source: SeedSource = input.results === undefined ? 'ranking' : 'results';

  const productId = (engineId: number): string => deterministicUuid('product', slug, String(engineId));
  const clusterId = (key: string): string => deterministicUuid('cluster', slug, ranking.uniqueness_version, key);
  const verdictId = (engineId: number): string =>
    deterministicUuid('verdict', slug, input.categorySnapshotVersion, String(engineId));

  /**
   * One instant for the whole category, rather than `new Date()` per row.
   *
   * `products.placed_at` and `verdicts.delivered_at` describe the same event —
   * this board being published — and `brief` Part 5 stamps that timestamp on
   * every verdict card. A per-row clock would spread one publication over a few
   * milliseconds and make the cards disagree about when the board they cite was
   * taken.
   */
  const seededAt = new Date();

  // --- categories, and the two frozen panels ---------------------------------

  const category: typeof categories.$inferInsert = {
    id: categoryId,
    slug,
    name: ranking.category,
    type: ranking.type,
    promptVersion: ranking.prompt_version,
    personaVersion: panel.persona_version,
    categorySnapshotVersion: input.categorySnapshotVersion,
    snapshotUrl: null,
  };

  const juryVersion: typeof juryVersions.$inferInsert = {
    categoryId,
    version: jury.prompt_version,
    metrics: jury.metrics,
    jurors: jury.jurors,
    approvedBy: input.approvedBy,
  };

  const personaVersion: typeof personaVersions.$inferInsert = {
    categoryId,
    version: panel.persona_version,
    personas: panel.personas,
    approvedBy: input.approvedBy,
  };

  // --- products --------------------------------------------------------------
  //
  // `normalized_url` is RECOMPUTED with the engine's `normalizeUrl` rather than
  // copied from `products.json`, even though the file already carries the field.
  // The column's whole job is to be the one identity the per-product cap keys on
  // (`brief §2.5`), and a seed that trusted a stored value could quietly load
  // rows normalized by an older revision of the rules.

  const productRows: (typeof products.$inferInsert)[] = productSet.products.map((product) => ({
    id: productId(product.id),
    categoryId,
    engineId: product.id,
    name: product.name,
    url: product.url,
    normalizedUrl: normalizeUrl(product.url),
    description: product.description,
    descriptionHash: digest(product.description),
    // `brief` Part 7: seeded listings are marked clearly as unclaimed.
    source: 'seeded',
    status: 'placed',
    submittedByEmail: null,
    /**
     * And published without a name or a URL, per `DECISIONS.md`'s resolution of
     * S4-source. 913 of the 1028 seeded descriptions were scraped from a
     * third-party directory rather than written by the companies they describe,
     * so a named seeded row is AI criticism of copy the named company never
     * wrote. `products_seeded_is_anonymous` refuses the alternative outright, so
     * this is not a policy this builder is choosing — it is the only insert the
     * table accepts for an unclaimed seeded listing.
     *
     * The board loses nothing a reader uses: every cut, every reason, the juror
     * who took it, the cluster and the demand picture are all still published.
     */
    anonymous: true,
    placedAt: seededAt,
  }));

  const knownEngineIds = new Set(productSet.products.map((p) => p.id));

  // --- raw panel output ------------------------------------------------------

  const scoreRowsOut =
    input.results === undefined
      ? scoreRowsFromRanking(ranking, jury, categoryId, productId, knownEngineIds)
      : scoreRowsFromLog(input.results.scoreLog, categoryId, productId, knownEngineIds);

  const uniqueness = input.results?.uniqueness ?? null;
  const { clusterRows, memberRows } = uniqueness === null
    ? clustersFromRanking(ranking, categoryId, clusterId, productId)
    : clustersFromUniqueness(uniqueness, ranking.uniqueness_version, categoryId, clusterId, productId, knownEngineIds);

  const knownClusterKeys = new Set(clusterRows.map((c) => c.clusterKey));

  const demandLog = input.results?.demand?.demandLog;
  const demandRows =
    demandLog === undefined
      ? demandVotesFromRanking(ranking, panel, categoryId, clusterId, productId)
      : demandVotesFromLog(demandLog, ranking, panel, categoryId, clusterId, productId, knownEngineIds, knownClusterKeys);

  if (source === 'ranking') {
    warnings.push(
      `${slug}: seeded from ranking.json only. A persona's "none" answer leaves no trace on the board, so any ` +
        'cluster the Floor declined outright is missing from demand_votes and would recompute as solo_cluster ' +
        '(DECISIONS.md S3) rather than as demand 0. Supply results.json for an exact raw record.',
    );
  }

  // --- the derived board -----------------------------------------------------

  const snapshotId = deterministicUuid('snapshot', slug, input.categorySnapshotVersion);

  const snapshot: typeof snapshots.$inferInsert = {
    id: snapshotId,
    categoryId,
    categorySnapshotVersion: input.categorySnapshotVersion,
    promptVersion: ranking.prompt_version,
    personaVersion: panel.persona_version,
    uniquenessVersion: ranking.uniqueness_version,
    productCount: ranking.ranking.length,
    document: ranking,
    health: ranking.health,
    url: null,
    publishedAt: null,
  };

  const clusterIdByKey = new Map(clusterRows.map((c) => [c.clusterKey, c.id as string]));

  const rankingRows: (typeof rankings.$inferInsert)[] = ranking.ranking.map((row) => ({
    snapshotId,
    categoryId,
    productId: productId(row.id),
    rank: row.rank,
    composite: row.composite,
    demand: row.demand ?? null,
    demandStatus: row.demand_status,
    core: row.core,
    tiebroken: row.tiebroken,
    clusterId: clusterIdByKey.get(row.cluster.id) ?? null,
  }));

  // --- the injection alarm ---------------------------------------------------
  //
  // Every flag on a seeded board is an OUTPUT alarm: `DECISIONS.md` S9's input
  // gate runs on submitted text, and a seed submits nothing.

  const flagged: (typeof flaggedInjections.$inferInsert)[] = ranking.flaggedInjections.map((flag) => ({
    stage: 'output',
    source: flag.source,
    reason: flag.reason,
    matched: flag.matched,
    categoryId,
    productId: flag.product_id !== undefined && knownEngineIds.has(flag.product_id) ? productId(flag.product_id) : null,
    clusterId: null,
    jobId: null,
  }));

  // --- the identities behind the listings ------------------------------------
  //
  // Derived from the product rows rather than declared, so this stays correct if
  // a seed input ever carries a paid listing. For the two Phase 1 boards it is
  // empty: `brief` Part 7 seeds unclaimed rows, and `products_source_submitter`
  // refuses a `seeded` product with a submitter, so there is nobody to create.
  // Inventing a placeholder account here would fabricate a payer and hand
  // `POST /auth/request` a live address to mail.

  const accountRows: (typeof accounts.$inferInsert)[] = [...new Set(
    productRows
      .map((product) => product.submittedByEmail)
      .filter((email): email is string => typeof email === 'string' && email !== ''),
  )].map((email) => ({ id: deterministicUuid('account', email), email }));

  const accountIdByEmail = new Map(accountRows.map((account) => [account.email, account.id as string]));
  const submitterByEngineId = new Map(
    productRows.map((product) => [product.engineId, product.submittedByEmail ?? null]),
  );

  // --- the frozen verdict pages ----------------------------------------------

  /**
   * The board with every listing's identity taken out of it.
   *
   * EVERY seeded listing is anonymous — `DECISIONS.md`'s resolution of S4-source:
   * 913 of the 1028 seeded descriptions were scraped from a third-party directory
   * rather than written by the companies they describe, so a NAMED seeded row is
   * AI criticism of copy that company never wrote. `products_seeded_is_anonymous`
   * refuses to store one; this is the same rule applied to the frozen page.
   *
   * It is applied HERE and not to `ranking` as a whole, deliberately. The two
   * kinds of row this builder writes want different documents:
   *
   * - `verdicts.payload` is the PUBLIC, PERMANENT artifact. `brief` Part 6 makes
   *   it a shareable URL that works logged out, and `verdicts` is append-only, so
   *   a name frozen into it is a name published forever — and one that a later
   *   claim could not retract, because the whole point of freezing is that the
   *   page keeps showing what it showed. This is the one place where getting it
   *   wrong is unfixable, so this is where the redaction goes.
   * - `score_rows`, `cluster_members` and `demand_votes` are the INTEGRITY
   *   RECORD (`brief` Part 7: "the score log is the integrity record if anyone
   *   disputes a ranking"). They are internal, no route serves them, and a
   *   dispute is argued from what the panel actually saw. Redacting them would
   *   destroy evidence to protect an identity that is not in them anyway — they
   *   key on `product_id`, not on a name.
   *
   * `products.name` and `products.url` keep the real values for the same reason:
   * they are what a founder claims, and claiming is what turns anonymity back
   * into a name.
   */
  const publicRanking = redactRanking(
    ranking,
    ranking.ranking.map((row) => row.id),
    slug,
  );

  const verdictRows: (typeof verdicts.$inferInsert)[] = publicRanking.ranking.map((row) => {
    const id = verdictId(row.id);
    const email = submitterByEngineId.get(row.id) ?? null;
    const accountId = email === null ? null : (accountIdByEmail.get(email) ?? null);
    return {
      id,
      publicSlug: verdictSlug(id),
      productId: productId(row.id),
      // A seeded board was produced by the engine's CLI before any job row
      // existed, and its listings are unclaimed (`brief` Part 7), so there is
      // neither a run nor a payer nor a pitch ordinal to record.
      jobId: null,
      accountId,
      attemptNumber: null,
      payload: verdictPayload(publicRanking, row, input.categorySnapshotVersion, seededAt),
      productCount: publicRanking.ranking.length,
      deliveredAt: seededAt,
    };
  });

  return {
    category,
    juryVersion,
    personaVersion,
    products: productRows,
    scoreRows: scoreRowsOut,
    clusters: clusterRows,
    clusterMembers: memberRows,
    demandVotes: demandRows,
    snapshot,
    rankings: rankingRows,
    flaggedInjections: flagged,
    verdicts: verdictRows,
    accounts: accountRows,
    attempts: [],
    source,
    warnings,
  };
}

// --- score rows ---------------------------------------------------------------

/** The starting score of every metric before deductions. `01 §5.1`. */
const METRIC_START = 100;

/**
 * Recover per-juror score rows from the merged scorecard, using `01 §5.1`'s
 * "deductions sum to exactly `100 - score`".
 */
function scoreRowsFromRanking(
  ranking: Ranking,
  jury: Jury,
  categoryId: string,
  productId: (engineId: number) => string,
  knownEngineIds: ReadonlySet<number>,
): (typeof scoreRows.$inferInsert)[] {
  const rows: (typeof scoreRows.$inferInsert)[] = [];

  for (const product of ranking.ranking) {
    if (!knownEngineIds.has(product.id)) {
      throw new RangeError(`buildSeedRows: ranking row ${product.id} is not in products.json`);
    }

    for (const entry of product.scorecard) {
      const substituted = new Set(entry.substituted_roles);

      for (const juror of jury.jurors) {
        // A juror that returned nothing has no opinion to record. The board
        // published `SCORE_CLAMP_DEFAULT` in its place and said so; the integrity
        // record must not repeat it as if it were a score.
        if (substituted.has(juror.role)) continue;

        const deductions = entry.deductions
          .filter((d) => d.role === juror.role)
          .map((d) => ({ points: d.points, reason: d.reason }));

        const taken = deductions.reduce((sum, d) => sum + d.points, 0);
        const score = METRIC_START - taken;

        if (score < 0 || score > METRIC_START) {
          throw new RangeError(
            `buildSeedRows: ${juror.role} on product ${product.id} / ${entry.metric} reconstructs to ${score}, ` +
              'which is outside 0-100 — the scorecard deductions do not satisfy 01 §5.1',
          );
        }

        rows.push({
          productId: productId(product.id),
          categoryId,
          jurorRole: juror.role,
          metric: entry.metric,
          score,
          deductions,
          promptVersion: ranking.prompt_version,
          jobId: null,
        });
      }
    }
  }

  return rows;
}

/** The exact path: `results.json`'s `scoreLog` maps one-to-one onto rows. */
function scoreRowsFromLog(
  scoreLog: readonly ScoreLogEntry[],
  categoryId: string,
  productId: (engineId: number) => string,
  knownEngineIds: ReadonlySet<number>,
): (typeof scoreRows.$inferInsert)[] {
  const rows: (typeof scoreRows.$inferInsert)[] = [];

  for (const entry of scoreLog) {
    for (const scored of entry.scores) {
      if (!knownEngineIds.has(scored.id)) {
        throw new RangeError(`buildSeedRows: scoreLog names product ${scored.id}, which is not in products.json`);
      }
      for (const metric of scored.metrics) {
        rows.push({
          productId: productId(scored.id),
          categoryId,
          jurorRole: entry.juror_role,
          metric: metric.name,
          score: metric.score,
          deductions: metric.deductions,
          promptVersion: entry.prompt_version,
          jobId: null,
        });
      }
    }
  }

  return rows;
}

// --- clusters -----------------------------------------------------------------

interface ClusterBuild {
  clusterRows: (typeof clusters.$inferInsert)[];
  memberRows: (typeof clusterMembers.$inferInsert)[];
}

/**
 * From the board: `ranking.clusters` is the roster, and each row's
 * `cluster` object carries that product's own membership, scarcity and reason.
 */
function clustersFromRanking(
  ranking: Ranking,
  categoryId: string,
  clusterId: (key: string) => string,
  productId: (engineId: number) => string,
): ClusterBuild {
  const clusterRows: (typeof clusters.$inferInsert)[] = ranking.clusters.map((cluster) => ({
    id: clusterId(cluster.cluster_id),
    categoryId,
    clusterKey: cluster.cluster_id,
    label: cluster.label,
    uniquenessVersion: ranking.uniqueness_version,
    retiredAt: null,
  }));

  const known = new Set(clusterRows.map((c) => c.clusterKey));

  const memberRows: (typeof clusterMembers.$inferInsert)[] = ranking.ranking.map((row) => {
    if (!known.has(row.cluster.id)) {
      // `01 §6.6` embeds the row's cluster and lists it in `ranking.clusters`; a
      // row naming a cluster the roster does not have is a malformed board, and
      // silently inventing the cluster would hide it.
      throw new RangeError(
        `buildSeedRows: product ${row.id} is in cluster ${JSON.stringify(row.cluster.id)}, ` +
          'which is not in ranking.clusters',
      );
    }
    return {
      clusterId: clusterId(row.cluster.id),
      productId: productId(row.id),
      categoryId,
      uniquenessScore: row.cluster.uniqueness,
      reason: row.cluster.reason,
      uniquenessVersion: ranking.uniqueness_version,
    };
  });

  return { clusterRows, memberRows };
}

/** The exact path: the uniqueness pass's own output. */
function clustersFromUniqueness(
  uniqueness: UniquenessResult,
  uniquenessVersion: string,
  categoryId: string,
  clusterId: (key: string) => string,
  productId: (engineId: number) => string,
  knownEngineIds: ReadonlySet<number>,
): ClusterBuild {
  const clusterRows: (typeof clusters.$inferInsert)[] = uniqueness.clusters.map((cluster) => ({
    id: clusterId(cluster.cluster_id),
    categoryId,
    clusterKey: cluster.cluster_id,
    label: cluster.label,
    uniquenessVersion,
    retiredAt: null,
  }));

  const known = new Set(clusterRows.map((c) => c.clusterKey));
  const memberRows: (typeof clusterMembers.$inferInsert)[] = [];

  for (const product of uniqueness.products) {
    if (!knownEngineIds.has(product.id)) continue;
    if (!known.has(product.cluster_id)) {
      throw new RangeError(
        `buildSeedRows: product ${product.id} is in cluster ${JSON.stringify(product.cluster_id)}, ` +
          'which the uniqueness pass did not declare',
      );
    }
    memberRows.push({
      clusterId: clusterId(product.cluster_id),
      productId: productId(product.id),
      categoryId,
      uniquenessScore: product.uniqueness_score,
      reason: product.reason,
      uniquenessVersion,
    });
  }

  return { clusterRows, memberRows };
}

// --- demand votes -------------------------------------------------------------

/**
 * From the board: every product's `demand_detail.picks` is the list of personas
 * that chose it and how. `none` answers are not representable here — see the
 * module header.
 */
function demandVotesFromRanking(
  ranking: Ranking,
  panel: PersonaPanel,
  categoryId: string,
  clusterId: (key: string) => string,
  productId: (engineId: number) => string,
): (typeof demandVotes.$inferInsert)[] {
  const personaNames = new Set(panel.personas.map((p: Persona) => p.name));
  const rows: (typeof demandVotes.$inferInsert)[] = [];

  for (const row of ranking.ranking) {
    for (const pick of row.demand_detail?.picks ?? []) {
      if (!personaNames.has(pick.persona)) {
        throw new RangeError(
          `buildSeedRows: product ${row.id} was picked by ${JSON.stringify(pick.persona)}, ` +
            'who is not on the installed panel',
        );
      }
      rows.push({
        categoryId,
        clusterId: clusterId(row.cluster.id),
        productId: productId(row.id),
        personaName: pick.persona,
        pick: pick.pick,
        // `01 §6.2` records conviction on the first pick only, and the
        // `demand_votes_strength_only_on_first` check refuses it anywhere else.
        strength: pick.pick === 'first' ? (pick.strength ?? null) : null,
        reason: pick.reason,
        flagged: false,
        personaVersion: panel.persona_version,
        uniquenessVersion: ranking.uniqueness_version,
        jobId: null,
      });
    }
  }

  return rows;
}

/** The exact path: `demandLog` carries the refusals as well as the picks. */
function demandVotesFromLog(
  demandLog: readonly DemandLogEntry[],
  ranking: Ranking,
  panel: PersonaPanel,
  categoryId: string,
  clusterId: (key: string) => string,
  productId: (engineId: number) => string,
  knownEngineIds: ReadonlySet<number>,
  knownClusterKeys: ReadonlySet<string>,
): (typeof demandVotes.$inferInsert)[] {
  const rows: (typeof demandVotes.$inferInsert)[] = [];

  for (const entry of demandLog) {
    for (const choice of entry.choices) {
      if (!knownClusterKeys.has(choice.cluster_id)) {
        throw new RangeError(
          `buildSeedRows: ${JSON.stringify(entry.persona)} answered about cluster ` +
            `${JSON.stringify(choice.cluster_id)}, which the uniqueness pass did not declare`,
        );
      }

      const base = {
        categoryId,
        clusterId: clusterId(choice.cluster_id),
        personaName: entry.persona,
        reason: choice.reason,
        flagged: false,
        personaVersion: panel.persona_version,
        uniquenessVersion: ranking.uniqueness_version,
        jobId: null,
      } as const;

      if (choice.none === true) {
        rows.push({ ...base, productId: null, pick: 'none', strength: null });
        continue;
      }

      const first = choice.first_pick;
      if (typeof first === 'number' && knownEngineIds.has(first)) {
        rows.push({ ...base, productId: productId(first), pick: 'first', strength: choice.strength ?? null });
      }

      const second = choice.second_pick;
      // `reduceDemand` discards a runner-up equal to the first pick as a
      // malformed answer; storing it would let a re-run disagree with the board.
      if (typeof second === 'number' && second !== first && knownEngineIds.has(second)) {
        rows.push({ ...base, productId: productId(second), pick: 'second', strength: null });
      }
    }
  }

  return rows;
}
