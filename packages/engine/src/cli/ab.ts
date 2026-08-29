/**
 * `pnpm engine ab --category "X" --run` — produce the fix-1.1 evidence.
 *
 * Split out from `report` because it SPENDS and the report must not. The A/B
 * check runs one full batch over the category, one leave-one-out seed run per
 * target, and two placements per target, so on a 44-product category with the
 * default sample it is roughly 250 model calls. That is a real bill, and a
 * command that could incur it as a side effect of asking for a report would be a
 * trap.
 *
 * `--dry-run` / `--run` follow `seed`'s discipline for the same reason: neither
 * is the default, so a mistyped flag cannot spend.
 *
 * The result is written to `cjr/runs/<slug>/ab.json` and read back by
 * `engine report`. It is deliberately a separate file from `results.json`: the
 * A/B's own runs are throwaway (they use an in-memory store and never touch the
 * category's phase files), and folding their scores into the seeded run's
 * integrity record would corrupt exactly the record `brief` Part 7 relies on.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { AB_SAMPLE } from '../config/constants.js';
import type { ModelClient } from '../model/types.js';
import { categorySlug } from '../panels/seeded.js';
import { runAbCheck, type AbCheckResult } from '../report/ab-check.js';
import { DEFAULT_WORKDIR } from '../run/store.js';
import { boolFlag, intFlag, optionalFlag, rejectUnknownFlags, requireFlag, UsageError, type ParsedArgs } from './args.js';
import { loadJury, loadPersonas, loadStoredProducts, runDir } from './load.js';

const AB_FLAGS = ['category', 'workdir', 'version', 'run', 'dry-run', 'sample', 'chunk-size'];

export const AB_USAGE = `Usage:
  engine ab --category "Developer Tools" --dry-run   [--workdir cjr] [--sample 5]
  engine ab --category "Developer Tools" --run       [--workdir cjr] [--sample 5]
                                                     [--version v1] [--chunk-size 40]

  --dry-run   print how many runs and calls the check would make. Spends nothing.
  --run       execute it. SPENDS: one full batch run, one leave-one-out seed run per
              target, and two placements per target.

Writes <workdir>/runs/<slug>/ab.json, which \`engine report\` reads as the fix-1.1 evidence.`;

export interface AbDeps {
  log: (line: string) => void;
  /** Built only on `--run`, so a dry run cannot construct a client even by accident. */
  makeClient: () => ModelClient;
  write?: (path: string, contents: string) => Promise<void>;
}

/** Run the `ab` command. Returns a process exit code. */
export async function abCommand(args: ParsedArgs, deps: AbDeps): Promise<number> {
  rejectUnknownFlags(args, AB_FLAGS);

  const category = requireFlag(args, 'category');
  const dryRun = boolFlag(args, 'dry-run');
  const execute = boolFlag(args, 'run');
  if (dryRun === execute) throw new UsageError('pass exactly one of --dry-run or --run');

  const workdir = optionalFlag(args, 'workdir') ?? DEFAULT_WORKDIR;
  const slug = categorySlug(category);
  if (slug === '') throw new UsageError(`--category ${JSON.stringify(category)} has no slug`);

  const stored = await loadStoredProducts(workdir, slug, category);
  if (stored === undefined) {
    throw new UsageError(
      `no ${join(runDir(workdir, slug), 'products.json')}. Seed the category first: the A/B places products ` +
        'back into a category whose ids are already pinned.',
    );
  }

  const jury = await loadJury(workdir, slug);
  const personas = await loadPersonas(workdir, slug);
  const categoryVersion = optionalFlag(args, 'version') ?? jury.prompt_version;
  const sampleSize = intFlag(args, 'sample') ?? AB_SAMPLE;
  const chunkSize = intFlag(args, 'chunk-size');

  if (dryRun) {
    const targets = Math.min(sampleSize, stored.products.length);
    deps.log(
      [
        `A/B DRY RUN — ${category}`,
        '',
        `  products              ${stored.products.length}`,
        `  targets               ${targets}`,
        `  full runs             ${1 + targets}   (1 batch + 1 leave-one-out seed per target)`,
        `  placements            ${targets * 2}   (incremental + retest per target)`,
        '',
        '  Nothing was spent. Re-run with --run to execute.',
      ].join('\n'),
    );
    return 0;
  }

  const result = await runAbCheck({
    category,
    products: stored.products,
    jury,
    personas,
    client: deps.makeClient(),
    sampleSize,
    config: { categoryVersion, ...(chunkSize === undefined ? {} : { chunkSize }) },
  });

  const path = join(runDir(workdir, slug), 'ab.json');
  const write = deps.write ?? writeJson;
  await write(path, `${JSON.stringify(result, null, 2)}\n`);

  deps.log(formatAbOutcome(result, path));
  return result.products.length === 0 ? 1 : 0;
}

/** Render a finished A/B check for a terminal. */
export function formatAbOutcome(result: AbCheckResult, path: string): string {
  const s = result.summary;
  const lines = [
    `A/B CHECK — ${result.category}`,
    '',
    `  targets completed     ${result.products.length}/${result.sample_size}`,
    `  A/B metric delta      ${s.mean_abs_metric_delta_ab.toFixed(3)} points (mean |Δ|)`,
    `  test-retest floor     ${s.mean_abs_metric_delta_retest.toFixed(3)} points (mean |Δ|)`,
    `  A/B rank delta        ${s.mean_abs_rank_delta_ab.toFixed(2)} positions`,
    `  test-retest rank      ${s.mean_abs_rank_delta_retest.toFixed(2)} positions`,
    '',
    `  ${s.reading}`,
    '',
    `  Spent ${`$${result.cost.total.cost_usd.toFixed(4)}`} over ${result.cost.total.calls} call(s) (${result.cost.basis}).`,
    `  ${result.cost.note}`,
  ];

  if (result.failures.length > 0) {
    lines.push('', '  Targets that did not complete:', ...result.failures.map((failure) => `    ! ${failure}`));
  }

  lines.push('', `  Written to ${path}`);
  return lines.join('\n');
}

async function writeJson(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');
}
