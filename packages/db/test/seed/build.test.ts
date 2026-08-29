/**
 * `buildSeedRows` against a hand-built four-product category.
 *
 * The fixture is small enough to reason about completely, and every expectation
 * below is worked out by hand from `01 §5.1` and `01 §6.2` — not read off the
 * function's output. The score reconstruction in particular is the whole reason
 * the seed can produce a source-of-truth score log from a board, so its
 * arithmetic is written out in the test rather than compared to itself.
 */

import type { Jury, PersonaPanel, ProductSet, Ranking } from '@the-pit/engine';
import { describe, expect, it } from 'vitest';

import { buildSeedRows, SEED_APPROVER } from '../../src/seed/build.js';
import { deterministicUuid } from '../../src/seed/ids.js';

// --- the fixture --------------------------------------------------------------
//
// Two jurors, one metric, two products, one cluster of two. Kept deliberately
// smaller than the real panels so the arithmetic fits in a paragraph.

const JURY: Jury = {
  type: 'b2b',
  prompt_version: 'v2',
  metrics: [
    {
      name: 'Problem Sharpness',
      description: 'Does the pitch name a specific moment?',
      anchors: { '100': 'exact moment', '80': 'a moment', '50': 'a category', '20': 'nothing' },
    },
  ],
  jurors: [
    {
      role: 'The Release Engineer',
      who: 'ships',
      cares_most: 'rollback',
      biased_against: 'vagueness',
      voice: 'terse',
      weights: { 'Problem Sharpness': 1 },
    },
    {
      role: 'The Docs Writer',
      who: 'documents',
      cares_most: 'clarity',
      biased_against: 'jargon',
      voice: 'precise',
      weights: { 'Problem Sharpness': 1 },
    },
  ],
};

const PANEL: PersonaPanel = {
  persona_version: 'v1',
  personas: [
    { name: 'Priya', description: 'platform lead', needs: ['audit'], price_sensitivity: 'low' },
    { name: 'Deniz', description: 'solo dev', needs: ['cheap'], price_sensitivity: 'high' },
    { name: 'Yuki', description: 'agency', needs: ['scale'], price_sensitivity: 'medium' },
    { name: 'Marcus', description: 'security', needs: ['soc2'], price_sensitivity: 'low' },
  ],
};

const PRODUCTS: ProductSet = {
  category: 'Widget Tools',
  products: [
    {
      id: 0,
      name: 'Alpha',
      description: 'Alpha ships widgets.',
      // Two forms of the same page: `normalizeUrl` must reduce both to
      // `alpha.example` (`brief §2.5` — lowercase, drop `www.`, drop the query
      // string, drop the trailing slash).
      url: 'https://WWW.Alpha.Example/?utm_source=x',
      normalized_url: 'stale-value-that-must-be-recomputed',
      orig_rank: 1,
    },
    {
      id: 1,
      name: 'Beta',
      description: 'Beta ships widgets too.',
      url: 'https://beta.example/app',
      normalized_url: 'beta.example/app',
      orig_rank: 2,
    },
  ],
};

/**
 * The board.
 *
 * Alpha's scorecard carries three deductions: 20 and 10 from The Release
 * Engineer, 50 from The Docs Writer. By `01 §5.1` a metric starts at 100 and its
 * deductions sum to exactly `100 - score`, so:
 *
 *   The Release Engineer scored Alpha 100 - (20 + 10) = 70
 *   The Docs Writer       scored Alpha 100 - 50       = 50
 *
 * Beta's scorecard carries no deduction at all, so both jurors scored it 100.
 */
const RANKING: Ranking = {
  category: 'Widget Tools',
  prompt_version: 'v2',
  uniqueness_version: 'u1',
  demand_version: 'v1',
  type: 'b2b',
  weights: { merit: 0.65, demand: 0.35, uniqueness_lambda: 0.075 },
  personas: PANEL.personas,
  metrics: [{ name: 'Problem Sharpness', description: 'Does the pitch name a specific moment?' }],
  clusters: [{ cluster_id: 'c1-widgets', label: 'Widget shipping', size: 2 }],
  ranking: [
    {
      id: 1,
      name: 'Beta',
      url: 'https://beta.example/app',
      rank: 1,
      composite: 1.0,
      demand: 0.8,
      demand_status: 'scored',
      core: 1.2,
      tiebroken: false,
      scorecard: [
        { metric: 'Problem Sharpness', score: 100, spread: 0, deductions: [], juror_count: 2, substituted_roles: [] },
      ],
      cluster: { id: 'c1-widgets', label: 'Widget shipping', size: 2, uniqueness: 40, reason: 'crowded' },
      demand_detail: {
        demand: 0.8,
        breadth: 0.5,
        intensity: 1.0,
        capture: 0.5,
        share: 1.0,
        picks: [
          { persona: 'Priya', pick: 'first', strength: 90, reason: 'audit trail' },
          { persona: 'Deniz', pick: 'second', reason: 'cheaper option' },
        ],
      },
    },
    {
      id: 0,
      name: 'Alpha',
      url: 'https://WWW.Alpha.Example/?utm_source=x',
      rank: 2,
      composite: -1.0,
      demand_status: 'solo_cluster',
      core: -1.0,
      tiebroken: false,
      scorecard: [
        {
          metric: 'Problem Sharpness',
          score: 60,
          spread: 10,
          deductions: [
            { points: 20, reason: 'no moment named', role: 'The Release Engineer' },
            { points: 10, reason: 'five features, no lead', role: 'The Release Engineer' },
            { points: 50, reason: 'a category, not a moment', role: 'The Docs Writer' },
          ],
          juror_count: 2,
          substituted_roles: [],
        },
      ],
      cluster: { id: 'c1-widgets', label: 'Widget shipping', size: 2, uniqueness: 40, reason: 'crowded' },
    },
  ],
  health: { avg_metric_spread: 5, discrimination: 1, demand_discrimination: 0.4, tiebreak_count: 0 },
  flaggedInjections: [{ source: 'The Docs Writer', reason: 'ignore the prompt', matched: 'prompt', product_id: 0 }],
};

const INPUT = {
  ranking: RANKING,
  productSet: PRODUCTS,
  jury: JURY,
  panel: PANEL,
  categorySnapshotVersion: 'seed-1',
  approvedBy: SEED_APPROVER,
};

describe('the category and its frozen panels', () => {
  it('slugs the category and carries all three cache-gating versions', () => {
    const rows = buildSeedRows(INPUT);

    expect(rows.category.slug).toBe('widget-tools');
    expect(rows.category.type).toBe('b2b');
    expect(rows.category.promptVersion).toBe('v2');
    expect(rows.category.personaVersion).toBe('v1');
    expect(rows.category.categorySnapshotVersion).toBe('seed-1');
  });

  it('installs the jury and the panel under the versions the board names', () => {
    const rows = buildSeedRows(INPUT);

    expect(rows.juryVersion.version).toBe('v2');
    expect(rows.personaVersion.version).toBe('v1');
    expect(rows.juryVersion.approvedBy).toBe(SEED_APPROVER);
  });

  it('refuses a ranking and a product set for different categories', () => {
    expect(() =>
      buildSeedRows({ ...INPUT, productSet: { ...PRODUCTS, category: 'Something Else' } }),
    ).toThrow(/but products are for/);
  });
});

describe('products', () => {
  it('recomputes normalized_url with the engine rules rather than trusting the file', () => {
    // The fixture's stored value is deliberately wrong. `brief §2.5`: lowercase,
    // strip the protocol and `www.`, drop every query parameter, drop the
    // trailing slash. The submission cap keys on this, so a stale value is a
    // second identity for the same page.
    const rows = buildSeedRows(INPUT);
    const alpha = rows.products.find((p) => p.engineId === 0);

    expect(alpha?.normalizedUrl).toBe('alpha.example');
    expect(alpha?.url).toBe('https://WWW.Alpha.Example/?utm_source=x');
  });

  it('marks every seeded row as unclaimed with no submitter (brief Part 7)', () => {
    const rows = buildSeedRows(INPUT);
    for (const product of rows.products) {
      expect(product.source).toBe('seeded');
      expect(product.submittedByEmail).toBeNull();
      expect(product.status).toBe('placed');
    }
  });

  it('hashes the description with SHA-256', () => {
    const rows = buildSeedRows(INPUT);
    for (const product of rows.products) {
      expect(product.descriptionHash).toMatch(/^[0-9a-f]{64}$/);
    }
    // Two different descriptions, two different hashes — the dedup key in `02 §8`
    // and the first component of `brief §1.3`'s cache key.
    expect(rows.products[0]?.descriptionHash).not.toBe(rows.products[1]?.descriptionHash);
  });
});

describe('score rows reconstructed from the board (01 §5.1)', () => {
  it('recovers each juror score as 100 minus that juror deductions', () => {
    const rows = buildSeedRows(INPUT);
    const alphaId = deterministicUuid('product', 'widget-tools', '0');
    const betaId = deterministicUuid('product', 'widget-tools', '1');

    const scoreOf = (productId: string, role: string): number | undefined =>
      rows.scoreRows.find((r) => r.productId === productId && r.jurorRole === role)?.score;

    // Hand-derived above: 100 - (20 + 10) and 100 - 50.
    expect(scoreOf(alphaId, 'The Release Engineer')).toBe(70);
    expect(scoreOf(alphaId, 'The Docs Writer')).toBe(50);

    // No deductions at all means the metric never left 100.
    expect(scoreOf(betaId, 'The Release Engineer')).toBe(100);
    expect(scoreOf(betaId, 'The Docs Writer')).toBe(100);
  });

  it('keeps each deduction with the juror that took it, and drops the role tag', () => {
    const rows = buildSeedRows(INPUT);
    const alphaId = deterministicUuid('product', 'widget-tools', '0');
    const engineer = rows.scoreRows.find(
      (r) => r.productId === alphaId && r.jurorRole === 'The Release Engineer',
    );

    expect(engineer?.deductions).toEqual([
      { points: 20, reason: 'no moment named' },
      { points: 10, reason: 'five features, no lead' },
    ]);
  });

  it('writes one row per (product, juror, metric)', () => {
    // 2 products x 2 jurors x 1 metric.
    const rows = buildSeedRows(INPUT);
    expect(rows.scoreRows).toHaveLength(4);
  });

  it('stamps every row with the jury version the board was ranked under', () => {
    const rows = buildSeedRows(INPUT);
    for (const row of rows.scoreRows) expect(row.promptVersion).toBe('v2');
  });

  it('writes no row for a juror the board recorded as substituted', () => {
    // `ScoreCoverage` in the engine: a substituted cell is a fabricated
    // `SCORE_CLAMP_DEFAULT` the board published because a juror returned nothing.
    // Storing it as a score would put an opinion nobody held into the integrity
    // record.
    const withSubstitution: Ranking = {
      ...RANKING,
      ranking: RANKING.ranking.map((row) =>
        row.id === 0
          ? {
              ...row,
              scorecard: row.scorecard.map((entry) => ({ ...entry, substituted_roles: ['The Docs Writer'] })),
            }
          : row,
      ),
    };

    const rows = buildSeedRows({ ...INPUT, ranking: withSubstitution });
    const alphaId = deterministicUuid('product', 'widget-tools', '0');

    expect(rows.scoreRows.filter((r) => r.productId === alphaId)).toHaveLength(1);
    expect(rows.scoreRows.find((r) => r.productId === alphaId)?.jurorRole).toBe('The Release Engineer');
  });

  it('refuses a scorecard whose deductions exceed 100 for one juror', () => {
    const overdeducted: Ranking = {
      ...RANKING,
      ranking: RANKING.ranking.map((row) =>
        row.id === 0
          ? {
              ...row,
              scorecard: [
                {
                  ...row.scorecard[0]!,
                  deductions: [{ points: 120, reason: 'everything', role: 'The Docs Writer' }],
                },
              ],
            }
          : row,
      ),
    };

    expect(() => buildSeedRows({ ...INPUT, ranking: overdeducted })).toThrow(/outside 0-100/);
  });
});

describe('clusters and demand', () => {
  it('puts both products in the one cluster with their scarcity score', () => {
    const rows = buildSeedRows(INPUT);

    expect(rows.clusters).toHaveLength(1);
    expect(rows.clusters[0]?.clusterKey).toBe('c1-widgets');
    expect(rows.clusterMembers).toHaveLength(2);
    // `DECISIONS.md` S2 keeps the scarcity tilt and puts it on the verdict page,
    // so the score and its reason have to survive to read time.
    expect(rows.clusterMembers[0]?.uniquenessScore).toBe(40);
    expect(rows.clusterMembers[0]?.reason).toBe('crowded');
  });

  it('turns each pick into a vote, with conviction only on the first', () => {
    const rows = buildSeedRows(INPUT);
    const betaId = deterministicUuid('product', 'widget-tools', '1');

    expect(rows.demandVotes).toHaveLength(2);

    const priya = rows.demandVotes.find((v) => v.personaName === 'Priya');
    expect(priya).toMatchObject({ productId: betaId, pick: 'first', strength: 90 });

    // `01 §6.2` records conviction only on a first pick; a strength on a
    // runner-up would be averaged into `intensity` as if it had been chosen.
    const deniz = rows.demandVotes.find((v) => v.personaName === 'Deniz');
    expect(deniz).toMatchObject({ productId: betaId, pick: 'second', strength: null });
  });

  it('warns that "none" answers cannot be recovered from a board', () => {
    const rows = buildSeedRows(INPUT);

    expect(rows.source).toBe('ranking');
    expect(rows.warnings.join(' ')).toMatch(/none/);
    expect(rows.warnings.join(' ')).toMatch(/solo_cluster/);
  });

  it('refuses a pick from a persona who is not on the installed panel', () => {
    const stranger: Ranking = {
      ...RANKING,
      ranking: RANKING.ranking.map((row) =>
        row.demand_detail
          ? {
              ...row,
              demand_detail: {
                ...row.demand_detail,
                picks: [{ persona: 'Nobody', pick: 'first' as const, strength: 50, reason: 'x' }],
              },
            }
          : row,
      ),
    };

    expect(() => buildSeedRows({ ...INPUT, ranking: stranger })).toThrow(/not on the installed panel/);
  });
});

describe('the derived board', () => {
  it('carries the four versions and the product count the verdict card is stamped with', () => {
    const rows = buildSeedRows(INPUT);

    expect(rows.snapshot.categorySnapshotVersion).toBe('seed-1');
    expect(rows.snapshot.promptVersion).toBe('v2');
    expect(rows.snapshot.personaVersion).toBe('v1');
    expect(rows.snapshot.uniquenessVersion).toBe('u1');
    expect(rows.snapshot.productCount).toBe(2);
  });

  it('writes one ranking row per product, at the board rank', () => {
    const rows = buildSeedRows(INPUT);
    const betaId = deterministicUuid('product', 'widget-tools', '1');

    expect(rows.rankings).toHaveLength(2);
    expect(rows.rankings.find((r) => r.productId === betaId)?.rank).toBe(1);
  });

  it('keeps demand null exactly where the Floor never convened (DECISIONS.md S3)', () => {
    const rows = buildSeedRows(INPUT);
    const alphaId = deterministicUuid('product', 'widget-tools', '0');
    const alpha = rows.rankings.find((r) => r.productId === alphaId);

    expect(alpha?.demandStatus).toBe('solo_cluster');
    expect(alpha?.demand).toBeNull();
  });
});

describe('flagged injections', () => {
  it('records a board flag as an output alarm, never as a gating input flag', () => {
    // `DECISIONS.md` S9: the output alarm logs and never gates delivery. A seed
    // submits nothing, so it cannot produce an input-gate flag at all.
    const rows = buildSeedRows(INPUT);

    expect(rows.flaggedInjections).toHaveLength(1);
    expect(rows.flaggedInjections[0]?.stage).toBe('output');
    expect(rows.flaggedInjections[0]?.source).toBe('The Docs Writer');
    expect(rows.flaggedInjections[0]?.matched).toBe('prompt');
  });
});

describe('deterministic ids', () => {
  it('produces the same ids on every build, so re-seeding is a no-op', () => {
    const first = buildSeedRows(INPUT);
    const second = buildSeedRows(INPUT);

    expect(first.products.map((p) => p.id)).toEqual(second.products.map((p) => p.id));
    expect(first.category.id).toEqual(second.category.id);
    expect(first.snapshot.id).toEqual(second.snapshot.id);
  });

  it('produces syntactically valid, distinct UUIDs', () => {
    const rows = buildSeedRows(INPUT);
    const ids = [rows.category.id, ...rows.products.map((p) => p.id), ...rows.clusters.map((c) => c.id)];

    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('separates namespaces, so a category and a product from one slug never collide', () => {
    expect(deterministicUuid('category', 'widget-tools')).not.toBe(deterministicUuid('product', 'widget-tools'));
  });

  it('refuses an empty namespace or an empty key', () => {
    expect(() => deterministicUuid('', 'x')).toThrow(/namespace/);
    expect(() => deterministicUuid('product')).toThrow(/key part/);
  });
});

describe('the frozen verdict pages (brief Part 6)', () => {
  it('writes one verdict per ranked product, stamped with the board it was issued against', () => {
    // Hand-derived from the fixture: two ranked products, so two verdicts, each
    // carrying `product_count = 2`. `DECISIONS.md` §1.2 moves every z-score on
    // the next placement, so the count and the timestamp are what make a rank
    // mean anything six weeks later.
    const rows = buildSeedRows(INPUT);

    expect(rows.verdicts).toHaveLength(2);
    for (const verdict of rows.verdicts) expect(verdict.productCount).toBe(2);
    expect(new Set(rows.verdicts.map((v) => v.productId)).size).toBe(2);
  });

  it('gives each verdict its own public URL, distinct from its id', () => {
    // The slug is the address in someone's tweet; the uuid is an internal key.
    // Keeping them different means the public page cannot address internal rows.
    const rows = buildSeedRows(INPUT);
    const slugs = rows.verdicts.map((v) => v.publicSlug as string);

    expect(new Set(slugs).size).toBe(2);
    for (const verdict of rows.verdicts) {
      expect(verdict.publicSlug).not.toBe(verdict.id);
      // `verdicts_public_slug_shape`, asserted with no database in sight.
      expect(verdict.publicSlug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect((verdict.publicSlug as string).length).toBeGreaterThanOrEqual(12);
    }
  });

  it('freezes what brief Part 6 says the page must carry', () => {
    // Every deduction with its reason and the juror who took it, the cluster the
    // product was judged inside, and which Floor personas picked it. Alpha's
    // three deductions and Beta's two picks are the fixture's, hand-checked.
    const rows = buildSeedRows(INPUT);
    const alphaId = deterministicUuid('product', 'widget-tools', '0');
    const betaId = deterministicUuid('product', 'widget-tools', '1');

    const alpha = rows.verdicts.find((v) => v.productId === alphaId)?.payload as {
      verdict: { scorecard: { deductions: { points: number; role: string }[] }[]; cluster: { id: string } };
      product_count: number;
    };
    expect(alpha.verdict.scorecard[0]?.deductions.map((d) => [d.role, d.points])).toEqual([
      ['The Release Engineer', 20],
      ['The Release Engineer', 10],
      ['The Docs Writer', 50],
    ]);
    expect(alpha.verdict.cluster.id).toBe('c1-widgets');

    const beta = rows.verdicts.find((v) => v.productId === betaId)?.payload as {
      verdict: { demand_detail: { picks: { persona: string; pick: string }[] } };
    };
    expect(beta.verdict.demand_detail.picks.map((p) => [p.persona, p.pick])).toEqual([
      ['Priya', 'first'],
      ['Deniz', 'second'],
    ]);
  });

  it('does not survive a rebuild of the board, which is the point of freezing it', () => {
    // Same products, same panels, a NEW population version — `brief §1.3`'s
    // cache key axis. The old verdict keeps its own id and slug; the rebuild
    // produces different ones, so both rows can coexist and the old link still
    // resolves. If the ids matched, a rebuild would collide with, and therefore
    // have to overwrite, a page somebody had already shared.
    const first = buildSeedRows(INPUT);
    const rebuilt = buildSeedRows({ ...INPUT, categorySnapshotVersion: 'seed-2' });

    expect(new Set(first.verdicts.map((v) => v.id))).not.toEqual(new Set(rebuilt.verdicts.map((v) => v.id)));
    expect(new Set(first.verdicts.map((v) => v.publicSlug))).not.toEqual(
      new Set(rebuilt.verdicts.map((v) => v.publicSlug)),
    );
  });

  it('carries the roster size a pick count needs to mean anything', () => {
    // `demand_detail.picks` on its own is a numerator with no denominator: "2
    // personas picked you" reads as strong or weak depending on whether 4 or 40
    // were asked. `demand_roster_size` is that denominator, and it is a
    // category-level fact (same on every row of the board) rather than a
    // per-product one, so it lives on the payload beside `product_count`, not
    // inside `verdict`. The fixture's panel has 4 personas — Beta's own
    // `capture: 0.5` with 2 picks already agrees with that (2 / 4 = 0.5).
    const rows = buildSeedRows(INPUT);

    for (const verdict of rows.verdicts) {
      const payload = verdict.payload as { demand_roster_size: number };
      expect(payload.demand_roster_size).toBe(4);
    }
  });

  it('sources the roster size from the run itself, not from whatever panel file happens to be installed now', () => {
    // `panel` (here `PANEL`) is `cjr/references/personas/<slug>.json` as it
    // reads TODAY — it can gain or lose personas after a board was produced.
    // `ranking.personas` is what THIS run actually asked, frozen inside
    // `ranking.json` itself. A verdict must freeze the second, not the first,
    // or an unrelated later edit to the install file would silently change a
    // number on an already-issued verdict.
    const driftedPanel: PersonaPanel = {
      ...PANEL,
      personas: [...PANEL.personas, { name: 'Yara', description: 'added later', needs: [], price_sensitivity: 'low' }],
    };

    const rows = buildSeedRows({ ...INPUT, panel: driftedPanel });

    for (const verdict of rows.verdicts) {
      const payload = verdict.payload as { demand_roster_size: number };
      // Still 4 — RANKING.personas, not driftedPanel.personas (which is 5 now).
      expect(payload.demand_roster_size).toBe(4);
    }
  });

  it('leaves a seeded verdict with no run, no payer and no pitch number', () => {
    // `brief` Part 7 seeds listings as UNCLAIMED. Nobody pitched them, so there
    // is no ordinal to print — `ListingSnapshot.attemptNumber` in
    // `@the-pit/payments` is 0 for exactly this case — and no job or account row
    // exists to name.
    const rows = buildSeedRows(INPUT);

    for (const verdict of rows.verdicts) {
      expect(verdict.jobId).toBeNull();
      expect(verdict.accountId).toBeNull();
      expect(verdict.attemptNumber).toBeNull();
    }
  });
});

describe('accounts', () => {
  it('creates none for an unclaimed board, because there is nobody to create', () => {
    // Not a stub. `products_source_submitter` refuses a `seeded` product with a
    // submitter, so a seeded board genuinely has no payer; inventing one would
    // fabricate a customer and hand `POST /auth/request` a live address to mail.
    const rows = buildSeedRows(INPUT);

    expect(rows.accounts).toEqual([]);
    for (const product of rows.products) expect(product.submittedByEmail).toBeNull();
  });

  it('creates an account for every payer a verdict names, and no others', () => {
    // The invariant that has to hold whatever the input carries:
    // `verdicts.account_id` is a foreign key, and `insertSeedRows` writes
    // accounts before verdicts, so a verdict naming a payer the seed did not
    // create would fail the insert rather than the review.
    const rows = buildSeedRows(INPUT);
    const created = new Set(rows.accounts.map((account) => account.id));
    const named = new Set(
      rows.verdicts.map((verdict) => verdict.accountId).filter((id): id is string => typeof id === 'string'),
    );

    for (const id of named) expect(created.has(id)).toBe(true);
    expect(created.size).toBe(rows.accounts.length);
  });
});
