/**
 * `pnpm engine rank --category "X"` — recompute `ranking.json` from the stored
 * raw rows. `01 §2`, `01 §4` Step 6, `01 §6`.
 *
 * `01 §2` is explicit that the ranking mathematics happen AFTER the panels return
 * and read only `results.json`: "the ranking can be recomputed offline from
 * `results.json` without spending tokens." `runCategory` already writes a ranking
 * on a delivered run, so this command is not how a ranking first comes to exist —
 * it is how it is re-derived: after a constant is corrected, after a bug in the
 * blend is fixed, or by someone disputing a rank who has the integrity record and
 * no API key (`brief` Part 7).
 *
 * It takes no `ModelClient` and constructs none, so it cannot spend and cannot
 * change a single vote. Every input is read off disk; the only output is the
 * ranking document.
 *
 * ## What it refuses
 *
 * A run whose `meta.outcome` is `failed`. `brief §2.3` forbids delivering a
 * degraded verdict, and `assembleResults` deliberately writes NO votes for a
 * failed phase — so ranking such a run would not merely be premature, it would
 * rank a category off an empty or partial score log and produce a board that
 * looks finished. The failure is the answer; the remedy is to finish the run.
 */

import { categorySlug } from '../panels/seeded.js';
import { rankCategory } from '../rank/ranking.js';
import { DEFAULT_WORKDIR, FileRunStore } from '../run/store.js';
import { optionalFlag, rejectUnknownFlags, requireFlag, UsageError, type ParsedArgs } from './args.js';
import { loadJury, loadPersonas, loadResults, loadStoredProducts, runDir } from './load.js';

const RANK_FLAGS = ['category', 'workdir'];

export const RANK_USAGE = `Usage:
  engine rank --category "Developer Tools" [--workdir cjr]

Recomputes <workdir>/runs/<slug>/ranking.json from results.json, products.json and the
installed jury and persona panel. Pure arithmetic (01 §6): no model call, no API key,
nothing spent. Refuses a run whose meta.outcome is "failed" (brief §2.3).`;

export interface RankDeps {
  log: (line: string) => void;
}

/** Run the `rank` command. Returns a process exit code. */
export async function rankCommand(args: ParsedArgs, deps: RankDeps): Promise<number> {
  rejectUnknownFlags(args, RANK_FLAGS);

  const category = requireFlag(args, 'category');
  const workdir = optionalFlag(args, 'workdir') ?? DEFAULT_WORKDIR;
  const slug = categorySlug(category);
  if (slug === '') throw new UsageError(`--category ${JSON.stringify(category)} has no slug`);

  const products = await loadStoredProducts(workdir, slug, category);
  if (products === undefined) {
    throw new UsageError(
      `no ${runDir(workdir, slug)}/products.json. Product ids are pinned by the first seed pass; ` +
        'without that file there is nothing for the stored scores to attach to.',
    );
  }

  const results = await loadResults(workdir, slug);
  if (results.meta.outcome === 'failed') {
    throw new UsageError(
      `${runDir(workdir, slug)}/results.json records outcome "failed". A failed run stores its diagnosis ` +
        'and no votes, so ranking it would publish a board built from nothing (brief §2.3). Finish the run first: ' +
        'engine seed --category "…" --ingest --round 1, then --emit/--ingest --round 2.',
    );
  }

  const jury = await loadJury(workdir, slug);
  const personas = await loadPersonas(workdir, slug);

  const ranking = rankCategory({
    category,
    type: jury.type,
    prompt_version: results.meta.prompt_version,
    uniqueness_version: results.meta.uniqueness_version,
    demand_version: results.demand?.demand_version ?? results.meta.persona_version,
    products: products.products,
    metrics: jury.metrics.map((metric) => ({ name: metric.name, description: metric.description })),
    jury: jury.jurors,
    // The roster echoed into the document is the run's own, when it has one: a
    // panel edited after the run must not be able to relabel votes it never cast.
    personas: results.demand?.personas ?? personas.personas,
    scoreLog: results.scoreLog,
    uniqueness: results.uniqueness,
    demandLog: results.demand?.demandLog ?? null,
    flaggedInjections: results.flaggedInjections,
  });

  const store = new FileRunStore(category, workdir);
  await store.writeRanking(ranking);

  const solo = ranking.ranking.filter((row) => row.demand_status === 'solo_cluster').length;
  deps.log(
    [
      `RANKED — ${category}`,
      '',
      `  ${ranking.ranking.length} products`,
      `  discrimination        ${ranking.health.discrimination.toFixed(4)}`,
      `  demand discrimination ${ranking.health.demand_discrimination.toFixed(4)}`,
      `  avg metric spread     ${ranking.health.avg_metric_spread.toFixed(4)}`,
      `  tiebroken             ${ranking.health.tiebreak_count}`,
      `  solo clusters         ${solo}/${ranking.ranking.length}`,
      '',
      ...(results.meta.seeding === undefined ? [] : [`  ${results.meta.seeding.caveat}`, '']),
      `  Written to ${runDir(workdir, slug)}/ranking.json`,
    ].join('\n'),
  );

  return 0;
}
