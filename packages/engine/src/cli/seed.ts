/**
 * `pnpm engine seed --category "X" --dry-run` / `--run`.
 *
 * `01 §4` Step 4 in two halves: `--dry-run` prints the projection and spends
 * nothing; `--run` executes after a person has looked at it. Neither is the
 * default. A CLI that ran on a bare `seed` would have turned an approval gate
 * into a typo.
 *
 * ## What it loads, and what it refuses to generate
 *
 * The jury and the persona panel are read from `cjr/references/jurors/<slug>.json`
 * and `cjr/references/personas/<slug>.json` and re-validated through Task 6's
 * validators before use. They are NOT generated here. `01 §4` Steps 2 and 3 are
 * APPROVAL GATES 1 and 2 — a human reads the panel and installs it — and Task 6's
 * builders return prompt TEXT for a person to dispatch, not dispatchable
 * requests. Re-validating an already-installed file is not redundant: the file is
 * hand-edited between runs, and an edit that breaks the weights-keyed-by-metric
 * rule would otherwise surface as silently reweighted composites.
 *
 * ## The client
 *
 * `AnthropicClient` is constructed HERE and only here, inside the `--run` branch,
 * and injected downward. Nothing under `src/run/` or `src/panels/` imports it.
 * That is Global Constraint 5's requirement and Task 9's precondition: swapping
 * in a `HandoffClient` is a change to this file alone.
 */

import { join } from 'node:path';

import { AnthropicClient } from '../model/anthropic-client.js';
import type { ModelClient } from '../model/types.js';
import { categorySlug } from '../panels/seeded.js';
import { formatProjection, projectRun } from '../run/dry-run.js';
import { runCategory } from '../run/run-category.js';
import { DEFAULT_WORKDIR, FileRunStore } from '../run/store.js';
import type { RunOutcome } from '../run/types.js';
import { loadCategory } from '../ingest/load-category.js';
import type { ProductSet } from '../types.js';
import { boolFlag, intFlag, optionalFlag, requireFlag, rejectUnknownFlags, UsageError, type ParsedArgs } from './args.js';
import { loadJury, loadPersonas, loadStoredProducts, runDir } from './load.js';

/** Everything the command touches that a test wants to replace. */
export interface SeedDeps {
  log: (line: string) => void;
  /** Built only on `--run`, so a dry run cannot construct a client even by accident. */
  makeClient: () => ModelClient;
}

const SEED_FLAGS = ['category', 'dry-run', 'run', 'workdir', 'xlsx', 'version', 'chunk-size', 'resume'];

export const SEED_USAGE = `Usage:
  engine seed --category "Developer Tools" --dry-run [--workdir cjr] [--xlsx PATH]
  engine seed --category "Developer Tools" --run     [--workdir cjr] [--xlsx PATH]
                                                     [--version v1] [--chunk-size 40] [--resume]

  --dry-run     print the projected call count, token estimate and cost. Spends nothing.
  --run         execute the run. Requires an API key in the environment.
  --resume      reuse phase results already on disk instead of re-buying them (brief §2.3).

Reads the INSTALLED jury and persona panel from <workdir>/references/{jurors,personas}/<slug>.json.
Neither is generated here: 01 §4 Steps 2 and 3 are human approval gates.`;

/** Run the `seed` command. Returns a process exit code. */
export async function seedCommand(args: ParsedArgs, deps: SeedDeps): Promise<number> {
  rejectUnknownFlags(args, SEED_FLAGS);

  const category = requireFlag(args, 'category');
  const dryRun = boolFlag(args, 'dry-run');
  const execute = boolFlag(args, 'run');

  // Neither defaults. See the header: the gate is the point.
  if (dryRun === execute) {
    throw new UsageError('pass exactly one of --dry-run or --run');
  }

  const workdir = optionalFlag(args, 'workdir') ?? DEFAULT_WORKDIR;
  const slug = categorySlug(category);
  if (slug === '') throw new UsageError(`--category ${JSON.stringify(category)} has no slug`);

  const { productSet, fromDisk } = await loadProducts(category, slug, workdir, optionalFlag(args, 'xlsx'));
  const jury = await loadJury(workdir, slug);
  const personas = await loadPersonas(workdir, slug);
  const categoryVersion = optionalFlag(args, 'version') ?? jury.prompt_version;
  const chunkSize = intFlag(args, 'chunk-size');

  if (dryRun) {
    deps.log(
      formatProjection(
        projectRun({
          category,
          products: productSet.products,
          jury,
          personas: personas.personas,
          ordering: { category, categoryVersion },
          ...(chunkSize === undefined ? {} : { chunkSize }),
        }),
      ),
    );
    return 0;
  }

  const store = new FileRunStore(category, workdir);

  // Pin the ids BEFORE any call is made. `Product.id` is a 0-based index into the
  // usable rows of the workbook (`01 §4` Step 1), so a sheet that gains or loses
  // a row renumbers every product — and ids are how scores, clusters and votes
  // attach to products. Once this file exists, `loadProducts` reads it in
  // preference to the workbook and the ids stop moving. Written on `--run` only:
  // the dry run is an approval gate and writes nothing.
  if (!fromDisk) {
    await store.writeProducts(productSet);
    deps.log(`Prepared ${productSet.products.length} products -> ${join(store.path, 'products.json')}`);
  }

  const outcome = await runCategory({
    category,
    products: productSet.products,
    jury,
    personas,
    client: deps.makeClient(),
    store,
    config: {
      categoryVersion,
      resume: boolFlag(args, 'resume'),
      ...(chunkSize === undefined ? {} : { chunkSize }),
    },
  });

  deps.log(formatOutcome(outcome, store.path));
  // A failed run is a non-zero exit so a wrapper (a shell loop, an Inngest step)
  // does not treat "retry this, do not deliver" as success.
  return outcome.status === 'delivered' ? 0 : 1;
}

/** Render a finished run for a terminal. */
export function formatOutcome(outcome: RunOutcome, path: string): string {
  const { meta } = outcome.results;
  const money = (usd: number): string => `$${usd.toFixed(4)}`;
  const lines = [
    `${outcome.status === 'delivered' ? 'RUN COMPLETE' : 'RUN FAILED'} — ${meta.category}`,
    '',
    '  phase        status     calls   input tok   output tok   cache read        cost',
  ];

  for (const [phase, summary] of Object.entries(meta.phases)) {
    const status = summary.status === 'skipped' ? `skipped:${summary.skipped ?? ''}` : summary.status;
    lines.push(
      `  ${phase.padEnd(11)}${status.padEnd(11)}${String(summary.cost.calls).padStart(6)}` +
        `${String(summary.cost.usage.input_tokens).padStart(12)}${String(summary.cost.usage.output_tokens).padStart(13)}` +
        `${String(summary.cost.usage.cache_read_input_tokens).padStart(13)}${money(summary.cost.cost_usd).padStart(12)}`,
    );
  }

  const { total } = meta.ledger;
  lines.push(
    `  ${'TOTAL'.padEnd(22)}${String(total.calls).padStart(6)}${String(total.usage.input_tokens).padStart(12)}` +
      `${String(total.usage.output_tokens).padStart(13)}${String(total.usage.cache_read_input_tokens).padStart(13)}` +
      `${money(total.cost_usd).padStart(12)}`,
    '',
  );

  if (meta.warnings.length > 0) {
    lines.push('  Warnings:', ...meta.warnings.map((warning) => `    ! ${warning}`), '');
  }

  if (outcome.status === 'failed') {
    lines.push(
      outcome.retryable
        ? '  Every failure is retryable: this is a FREE retry (brief §2.3). Re-run with --resume; nothing is delivered.'
        : '  At least one failure is terminal: retrying cannot change the outcome. Do not burn free retries on it.',
      '',
    );
    for (const failure of outcome.failures) {
      lines.push(`    [${failure.code}] ${failure.message}`, ...failure.causes.map((cause) => `      - ${cause}`));
    }
    lines.push('', `  Partial results written to ${join(path, 'results.json')}`);
    return lines.join('\n');
  }

  lines.push(
    `  ${outcome.ranking.ranking.length} products ranked; discrimination ${outcome.ranking.health.discrimination.toFixed(4)}`,
    `  Written to ${path}/{results.json,ranking.json}`,
  );
  return lines.join('\n');
}

/**
 * The category's products: `products.json` if `01 §4` Step 1 has already run,
 * otherwise from the source workbook.
 *
 * Reading the stored file first is what makes the ids stable across runs.
 * `Product.id` is a 0-based index into the USABLE rows, so re-deriving it from a
 * workbook that has since gained or lost a row would silently renumber every
 * product — and every stored score, cluster and vote is keyed on that id.
 */
async function loadProducts(
  category: string,
  slug: string,
  workdir: string,
  xlsx: string | undefined,
): Promise<{ productSet: ProductSet; fromDisk: boolean }> {
  const stored = await loadStoredProducts(workdir, slug, category);
  if (stored !== undefined) return { productSet: stored, fromDisk: true };

  if (xlsx === undefined) {
    throw new UsageError(
      `no ${join(runDir(workdir, slug), 'products.json')} and no --xlsx given. ` +
        'Pass --xlsx PATH to prepare the category from the source workbook (01 §4 Step 1).',
    );
  }
  // `--run` writes this back to `products.json` before spending anything, so the
  // ids are derived from the workbook exactly once per category.
  return { productSet: await loadCategory(xlsx, category), fromDisk: false };
}

/** The real client. Separated so `seedCommand` never imports it on the dry-run path. */
export function makeAnthropicClient(): ModelClient {
  return new AnthropicClient();
}
