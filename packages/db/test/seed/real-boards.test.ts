/**
 * The seed against the two boards that actually exist.
 *
 * `DECISIONS.md` S4 chose them: Developer Tools (48 usable, b2b) and Health,
 * Fitness & Wellness (44 usable, consumer). Both were seeded and ranked at commit
 * `c374443`, and their `ranking.json` is committed.
 *
 * Counts here are arithmetic over documented facts, not readings taken from the
 * implementation:
 *
 *   score rows = products x metrics x jurors
 *
 * with `products` from S4, `jurors` = 6 (`DECISIONS.md` S1 — "The Six"), and
 * `metrics` read off the installed jury file, which `01 §4` Step 2 bounds at 3-6.
 *
 * The last test in this file is the one that matters most: it takes the rows the
 * seed would write, converts them back with `rehydrate`, re-ranks them with the
 * engine, and asserts the result is the published board. That is the claim
 * `02 §7` makes about this schema — "incremental placement and exact
 * recomputation both require the raw inputs" — checked rather than asserted.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { redactRanking } from '@the-pit/anon';
import type { Metric, Ranking } from '@the-pit/engine';
import { rankCategory } from '@the-pit/engine';
import { describe, expect, it } from 'vitest';

import { buildSeedRows } from '../../src/seed/build.js';
import { loadSeedInput } from '../../src/seed/load.js';
import { rehydrate } from '../../src/seed/rehydrate.js';

/** `cjr/` at the repository root; the suite's cwd is `packages/db`. */
const WORKDIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'cjr');

/** From `DECISIONS.md` S4. `metrics` is read off the installed jury in the test. */
const BOARDS = [
  { slug: 'developer-tools', type: 'b2b', products: 48 },
  { slug: 'health-fitness-wellness', type: 'consumer', products: 44 },
] as const;

/** `DECISIONS.md` S1: the panel is six, not `01 §4`'s five. */
const JURORS = 6;

describe.each(BOARDS)('$slug', ({ slug, type, products }) => {
  it(`loads ${products} products and builds one row each`, async () => {
    const input = await loadSeedInput(slug, WORKDIR);
    const rows = buildSeedRows(input);

    expect(rows.products).toHaveLength(products);
    expect(rows.category.type).toBe(type);
    expect(rows.category.slug).toBe(slug);
  });

  it('installs six jurors and a 4-8 persona panel', async () => {
    const input = await loadSeedInput(slug, WORKDIR);

    expect(input.jury.jurors).toHaveLength(JURORS);
    expect(input.panel.personas.length).toBeGreaterThanOrEqual(4);
    expect(input.panel.personas.length).toBeLessThanOrEqual(8);
  });

  it('writes products x metrics x jurors score rows', async () => {
    const input = await loadSeedInput(slug, WORKDIR);
    const rows = buildSeedRows(input);

    expect(rows.scoreRows).toHaveLength(products * input.jury.metrics.length * JURORS);
  });

  it('gives every product exactly one cluster membership', async () => {
    // `01 §5.2` partitions the category. Anything else and some product is
    // either judged twice or never put to the Floor.
    const input = await loadSeedInput(slug, WORKDIR);
    const rows = buildSeedRows(input);

    expect(rows.clusterMembers).toHaveLength(products);
    expect(new Set(rows.clusterMembers.map((m) => m.productId)).size).toBe(products);
  });

  it('ranks every product exactly once, over a dense 1..n', async () => {
    const input = await loadSeedInput(slug, WORKDIR);
    const rows = buildSeedRows(input);

    const ranks = rows.rankings.map((r) => r.rank).sort((a, b) => a - b);
    expect(ranks).toEqual(Array.from({ length: products }, (_, index) => index + 1));
  });

  it('normalizes every URL through the engine rules', async () => {
    // `brief §2.5`: the normalized form carries no scheme and no upper case, and
    // it is what the per-product cap keys on.
    const input = await loadSeedInput(slug, WORKDIR);
    const rows = buildSeedRows(input);

    for (const product of rows.products) {
      expect(product.normalizedUrl).toBe(product.normalizedUrl.toLowerCase());
      expect(product.normalizedUrl).not.toMatch(/^[a-z][a-z0-9+.-]*:/);
      expect(product.normalizedUrl).not.toContain('?');
    }
  });

  it('records every flag as an output alarm (DECISIONS.md S9)', async () => {
    const input = await loadSeedInput(slug, WORKDIR);
    const rows = buildSeedRows(input);

    for (const flag of rows.flaggedInjections) expect(flag.stage).toBe('output');
  });

  it('grants no attempts — a seeded product was never bought', async () => {
    const input = await loadSeedInput(slug, WORKDIR);
    const rows = buildSeedRows(input);

    expect(rows.attempts).toEqual([]);
    for (const product of rows.products) expect(product.source).toBe('seeded');
  });

  it(`writes ${products} frozen verdict pages, one per ranked product`, async () => {
    // `brief` Part 6 gives every listing on the board a public permanent URL.
    // The count is the board's own size, which is `DECISIONS.md` S4's figure and
    // is also what each card is stamped with (`brief` Part 5).
    const input = await loadSeedInput(slug, WORKDIR);
    const rows = buildSeedRows(input);

    expect(rows.verdicts).toHaveLength(products);
    expect(new Set(rows.verdicts.map((v) => v.publicSlug)).size).toBe(products);
    expect(new Set(rows.verdicts.map((v) => v.productId)).size).toBe(products);
    for (const verdict of rows.verdicts) expect(verdict.productCount).toBe(products);
  });

  it('freezes each verdict against the exact board row it was issued from, less the identity', async () => {
    // Not a projection: the whole `RankedProduct` is embedded, so every deduction
    // with its reason and juror, the cluster judged inside, and the Floor's picks
    // survive verbatim. `DECISIONS.md` §1.2 means re-deriving them later gives
    // different numbers, which is why the page cannot be rendered live.
    //
    // TWO fields do not survive verbatim, and only two: `name` and `url`. Every
    // seeded listing is anonymous (`DECISIONS.md`, S4-source — 913 of the 1028
    // seeded descriptions were scraped rather than written by the companies they
    // describe), so the frozen page carries a designation and no address. This
    // assertion is written as "everything else is identical" rather than as a
    // list of the fields that are, so a field the engine adds later is covered by
    // it automatically.
    const input = await loadSeedInput(slug, WORKDIR);
    const rows = buildSeedRows(input);

    // Compared against `redactRanking`'s own output rather than against the raw
    // board, because the redaction is document-wide: a juror or cluster reason
    // that named a withheld product has that name replaced too, and on
    // `developer-tools` exactly one does. Restoring `name` and `url` and
    // demanding the rest be byte-identical would therefore fail on the one row
    // the scrub exists for.
    //
    // What this pins is the property that matters at this seam: the seed builder
    // freezes THE canonical redaction, not a second one of its own. That there is
    // nothing but identity in the difference is proved next door, in
    // `packages/anon`, over every number, reason, role and cluster on the row.
    const expected = redactRanking(
      input.ranking,
      input.ranking.ranking.map((row) => row.id),
      slug,
    );
    const byProduct = new Map(rows.verdicts.map((v) => [v.productId, v.payload as { verdict: unknown }]));

    for (const row of expected.ranking) {
      const productId = rows.products.find((p) => p.engineId === row.id)?.id;
      const frozen = byProduct.get(productId as string)?.verdict as Record<string, unknown>;

      expect(frozen['name']).toMatch(/^Unit [A-Za-z]+-\d{3}$/);
      expect(frozen['url']).toBe('');
      expect(frozen).toEqual(row);
    }
  });

  it('publishes no seeded listing’s name or address in any frozen verdict', async () => {
    // The promise, asserted as an absence over the whole permanent record rather
    // than field by field: `verdicts` is append-only, so a name frozen into a
    // payload here is a name published forever and one that no later claim could
    // retract. Free text is included — a juror reason or a cluster reason can
    // mention another product by name, and on this board exactly one does.
    const input = await loadSeedInput(slug, WORKDIR);
    const rows = buildSeedRows(input);
    const frozen = JSON.stringify(rows.verdicts.map((v) => v.payload));

    for (const row of input.ranking.ranking) {
      if (row.name.length >= 4) expect(frozen).not.toContain(row.name);
      expect(frozen).not.toContain(row.url);
    }
  });

  it('keeps the real name and address on the products row, which is what a claim reveals', async () => {
    // Anonymity is a publishing decision, not amnesia. `products.name` and
    // `products.url` stay real because they are what a founder proves ownership
    // of, and `products_anonymity_immutable` lets a CLAIMED listing choose to be
    // named. A seed that forgot them could never be claimed.
    const input = await loadSeedInput(slug, WORKDIR);
    const rows = buildSeedRows(input);

    for (const product of input.productSet.products) {
      const stored = rows.products.find((p) => p.engineId === product.id);
      expect(stored?.name).toBe(product.name);
      expect(stored?.url).toBe(product.url);
      expect(stored?.anonymous).toBe(true);
    }
  });

  it('marks every seeded verdict unclaimed, and creates no accounts', async () => {
    // `brief` Part 7: cold-start listings are "marked clearly as unclaimed".
    // Nobody paid, nobody pitched, and there is no address to create an account
    // from — `products_source_submitter` forbids a seeded row from having one.
    const input = await loadSeedInput(slug, WORKDIR);
    const rows = buildSeedRows(input);

    expect(rows.accounts).toEqual([]);
    for (const verdict of rows.verdicts) {
      expect(verdict.accountId).toBeNull();
      expect(verdict.jobId).toBeNull();
      expect(verdict.attemptNumber).toBeNull();
    }
  });
});

/**
 * The round trip.
 *
 * `results.json` is git-ignored (it is regenerable and large), so this runs only
 * on a machine that has the raw record. That is the seed path with exact
 * fidelity; the board-only path is exercised above and warns about what it
 * cannot recover.
 */
const hasRawRecords = BOARDS.every(({ slug }) => existsSync(join(WORKDIR, 'runs', slug, 'results.json')));

describe.skipIf(!hasRawRecords).each(BOARDS)('$slug recomputes from its raw rows alone', ({ slug }) => {
  it('reproduces the published board exactly', async () => {
    const input = await loadSeedInput(slug, WORKDIR);
    expect(input.results).toBeDefined();

    const rows = buildSeedRows(input);
    const order = {
      jurorRoles: input.jury.jurors.map((juror) => juror.role),
      metricNames: input.jury.metrics.map((metric) => metric.name),
    };

    const raw = rehydrate(
      {
        products: rows.products,
        scoreRows: rows.scoreRows,
        clusters: rows.clusters,
        clusterMembers: rows.clusterMembers,
        demandVotes: rows.demandVotes,
      },
      order,
    );

    // `Ranking.metrics` is `{name, description}`; the jury file's rubric carries
    // the four anchors as well and would show up as extra keys.
    const metrics: Metric[] = input.jury.metrics.map((metric) => ({
      name: metric.name,
      description: metric.description,
    }));

    const recomputed: Ranking = rankCategory({
      category: input.ranking.category,
      type: input.ranking.type,
      prompt_version: input.ranking.prompt_version,
      uniqueness_version: input.ranking.uniqueness_version,
      demand_version: input.ranking.demand_version,
      products: raw.products,
      metrics,
      jury: input.jury.jurors,
      personas: input.panel.personas,
      scoreLog: raw.scoreLog,
      uniqueness: raw.uniqueness,
      demandLog: raw.demandLog,
      flaggedInjections: input.ranking.flaggedInjections,
    });

    // Every number on the board, re-derived from `score_rows`, `cluster_members`
    // and `demand_votes` with no model, no key and no network.
    expect(recomputed.ranking.map((row) => [row.rank, row.id])).toEqual(
      input.ranking.ranking.map((row) => [row.rank, row.id]),
    );
    expect(recomputed.ranking.map((row) => row.core)).toEqual(input.ranking.ranking.map((row) => row.core));
    expect(recomputed.ranking.map((row) => row.composite)).toEqual(input.ranking.ranking.map((row) => row.composite));
    expect(recomputed.ranking.map((row) => row.demand ?? null)).toEqual(
      input.ranking.ranking.map((row) => row.demand ?? null),
    );
    expect(recomputed.ranking.map((row) => row.demand_status)).toEqual(
      input.ranking.ranking.map((row) => row.demand_status),
    );
    expect(recomputed.health).toEqual(input.ranking.health);
    expect(recomputed.clusters).toEqual(input.ranking.clusters);
  });

  it('reproduces the whole document, deductions and picks included', async () => {
    // The strongest form: a byte-for-byte equal `ranking.json`. It is the
    // scorecard ledger and the persona picks that make the verdict page
    // (`brief` Part 6) and the dispute record (`brief` Part 7), so they have to
    // survive the round trip too, not just the numbers.
    const input = await loadSeedInput(slug, WORKDIR);
    const rows = buildSeedRows(input);

    const raw = rehydrate(
      {
        products: rows.products,
        scoreRows: rows.scoreRows,
        clusters: rows.clusters,
        clusterMembers: rows.clusterMembers,
        demandVotes: rows.demandVotes,
      },
      {
        jurorRoles: input.jury.jurors.map((juror) => juror.role),
        metricNames: input.jury.metrics.map((metric) => metric.name),
      },
    );

    const recomputed = rankCategory({
      category: input.ranking.category,
      type: input.ranking.type,
      prompt_version: input.ranking.prompt_version,
      uniqueness_version: input.ranking.uniqueness_version,
      demand_version: input.ranking.demand_version,
      products: raw.products,
      metrics: input.jury.metrics.map((metric) => ({ name: metric.name, description: metric.description })),
      jury: input.jury.jurors,
      personas: input.panel.personas,
      scoreLog: raw.scoreLog,
      uniqueness: raw.uniqueness,
      demandLog: raw.demandLog,
      flaggedInjections: input.ranking.flaggedInjections,
    });

    expect(recomputed).toEqual(input.ranking);
  });
});
