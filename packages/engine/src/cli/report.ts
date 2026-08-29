/**
 * `pnpm engine report --category "X"` — the Phase 1 gate.
 *
 * Reads what is already on disk and writes `cjr/runs/<slug>/report.md`, plus a
 * summary to the terminal. It takes no `ModelClient` and constructs none, so it
 * CANNOT spend: the report is pure arithmetic over the stored score log, cluster
 * rows and demand log, exactly as `runCategory`'s ranking is. That is not a
 * convenience — a gate report has to be re-derivable from the integrity record
 * (`brief` Part 7) long after the run, by someone who is disputing it and has no
 * API key.
 *
 * The one number a stored run cannot supply is the fix-1.1 A/B, because producing
 * it means scoring products through both paths. That lives in `engine ab`, which
 * writes `ab.json`; this command reads the file if it exists and renders the gate
 * as MISSING if it does not.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { categorySlug } from '../panels/seeded.js';
import { buildReport } from '../report/model.js';
import { formatReportSummary, renderReport } from '../report/render.js';
import { DEFAULT_WORKDIR } from '../run/store.js';
import { intFlag, optionalFlag, rejectUnknownFlags, requireFlag, UsageError, type ParsedArgs } from './args.js';
import { loadAbCheck, loadJury, loadPersonas, loadRanking, loadResults, loadStoredProducts, runDir } from './load.js';

const REPORT_FLAGS = ['category', 'workdir', 'out', 'categories', 'chunk-size'];

export const REPORT_USAGE = `Usage:
  engine report --category "Developer Tools" [--workdir cjr] [--out PATH]
                                             [--categories 28] [--chunk-size 40]

  --out         where to write the Markdown. Default <workdir>/runs/<slug>/report.md.
  --categories  categories the recalibration schedule projects over. Default: the
                measured 28 in the source workbook.

Reads results.json, ranking.json and products.json from the run, the installed jury and
persona panel, and ab.json if the A/B check has been run. Makes no model calls and
requires no API key.`;

export interface ReportDeps {
  log: (line: string) => void;
  /** Injected so a test can assert the rendered file without touching a disk. */
  write?: (path: string, contents: string) => Promise<void>;
}

/** Run the `report` command. Returns a process exit code. */
export async function reportCommand(args: ParsedArgs, deps: ReportDeps): Promise<number> {
  rejectUnknownFlags(args, REPORT_FLAGS);

  const category = requireFlag(args, 'category');
  const workdir = optionalFlag(args, 'workdir') ?? DEFAULT_WORKDIR;
  const slug = categorySlug(category);
  if (slug === '') throw new UsageError(`--category ${JSON.stringify(category)} has no slug`);

  const products = await loadStoredProducts(workdir, slug, category);
  if (products === undefined) {
    throw new UsageError(
      `no ${join(runDir(workdir, slug), 'products.json')}. Ids are pinned by the first --run; ` +
        'without that file the report cannot join scores to products.',
    );
  }

  const results = await loadResults(workdir, slug);
  const ranking = await loadRanking(workdir, slug);
  const jury = await loadJury(workdir, slug);
  const personas = await loadPersonas(workdir, slug);
  const ab = await loadAbCheck(workdir, slug);

  const model = buildReport({
    ranking,
    results,
    products: products.products,
    jury,
    personas: personas.personas,
    ...(ab === undefined ? {} : { ab }),
    ...(intFlag(args, 'categories') === undefined ? {} : { categories: intFlag(args, 'categories') as number }),
    ...(intFlag(args, 'chunk-size') === undefined ? {} : { chunkSize: intFlag(args, 'chunk-size') as number }),
  });

  const out = optionalFlag(args, 'out') ?? join(runDir(workdir, slug), 'report.md');
  const write = deps.write ?? writeFile2;
  await write(out, `${renderReport(model)}\n`);

  deps.log(formatReportSummary(model, out));

  // A flagged gate is not a command failure — the report rendered, and its whole
  // job is to put the flag in front of a person. What DOES exit non-zero is a
  // gate with no answer behind it: `missing` (the evidence was never produced)
  // and `inconclusive` (it was produced and settles nothing). A Phase 1 report in
  // either state has not answered the question Phase 1 was for, and a wrapper
  // must not treat it as done. The two are separate statuses because they need
  // separate remedies, but they are the same exit code.
  return model.gates.some((gate) => gate.status === 'missing' || gate.status === 'inconclusive') ? 1 : 0;
}

async function writeFile2(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents, 'utf8');
}
