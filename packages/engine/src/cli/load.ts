/**
 * Reading a run's artifacts back off disk, for the commands that consume rather
 * than produce them.
 *
 * `01 §3` fixes the layout — flat JSON under `cjr/`, no database — so every
 * command here is a `readFile` and a shape check. Two rules the whole file obeys:
 *
 * 1. **A missing file is a `UsageError` that names the path and the command that
 *    would create it.** These commands run at the end of a long, expensive
 *    pipeline, and "ENOENT" at that point tells a person nothing about which of
 *    six steps they skipped.
 * 2. **The jury and the persona panel are re-validated on every read.** Both files
 *    are hand-edited between runs (`01 §4` Steps 2 and 3 are human approval
 *    gates), and an edit that breaks the weights-keyed-by-metric rule would
 *    otherwise surface as silently reweighted composites in a report.
 *
 * The stored `results.json` and `ranking.json` are NOT re-validated the same way:
 * they are this engine's own output, written by `FileRunStore`, and a validator
 * for them would be a second transcription of `01 §6.6` to keep in agreement with
 * the first. They are checked for the shape the caller actually dereferences and
 * otherwise trusted.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { validateJury } from '../panels/generate/validate-jury.js';
import { validatePersonas } from '../panels/generate/validate-personas.js';
import type { AbCheckResult } from '../report/ab-check.js';
import type { RunResults } from '../run/types.js';
import type { Jury, PersonaPanel, Product, ProductSet, Ranking } from '../types.js';
import { UsageError } from './args.js';

/** `<workdir>/runs/<slug>/`. */
export function runDir(workdir: string, slug: string): string {
  return join(workdir, 'runs', slug);
}

/** Read a JSON file, or `undefined` if it is not there. Anything else re-throws. */
export async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/** The installed jury, re-validated. `01 §4` Step 2 (APPROVAL GATE 1). */
export async function loadJury(workdir: string, slug: string): Promise<Jury> {
  const path = join(workdir, 'references', 'jurors', `${slug}.json`);
  const raw = await readJson(path);
  if (raw === undefined) {
    throw new UsageError(`no installed jury at ${path}. Generate and approve one first (01 §4 Step 2).`);
  }

  const result = validateJury(raw);
  if (!result.valid) {
    throw new UsageError(`${path} is not a valid jury:\n${result.errors.map((error) => `  - ${error}`).join('\n')}`);
  }
  return result.value;
}

/** The installed customer panel, re-validated. `01 §4` Step 3 (APPROVAL GATE 2). */
export async function loadPersonas(workdir: string, slug: string): Promise<PersonaPanel> {
  const path = join(workdir, 'references', 'personas', `${slug}.json`);
  const raw = await readJson(path);
  if (raw === undefined) {
    throw new UsageError(`no installed persona panel at ${path}. Generate and approve one first (01 §4 Step 3).`);
  }

  const result = validatePersonas(raw);
  if (!result.valid) {
    throw new UsageError(
      `${path} is not a valid persona panel:\n${result.errors.map((error) => `  - ${error}`).join('\n')}`,
    );
  }
  return result.value;
}

/**
 * `products.json` — the pinned product set. `undefined` when the category has
 * never been prepared.
 *
 * `Product.id` is a 0-based index into the USABLE rows of the workbook, so this
 * file, not the workbook, is authoritative once it exists: re-deriving ids from a
 * sheet that has since gained or lost a row renumbers every product, and ids are
 * how every stored score, cluster and vote attaches to one.
 */
export async function loadStoredProducts(
  workdir: string,
  slug: string,
  category: string,
): Promise<ProductSet | undefined> {
  const stored = await readJson(join(runDir(workdir, slug), 'products.json'));
  if (stored === undefined) return undefined;

  const set = stored as Partial<ProductSet>;
  if (!Array.isArray(set.products) || set.products.length === 0) return undefined;
  return { category: set.category ?? category, products: set.products as Product[] };
}

/** `results.json` — `01 §4` Step 5's Workflow return value. */
export async function loadResults(workdir: string, slug: string): Promise<RunResults> {
  const path = join(runDir(workdir, slug), 'results.json');
  const raw = await readJson(path);
  if (raw === undefined) {
    throw new UsageError(`no ${path}. Run \`engine seed --category "…" --run\` first (01 §4 Steps 4-6).`);
  }

  const results = raw as Partial<RunResults>;
  if (!Array.isArray(results.scoreLog) || results.meta === undefined) {
    throw new UsageError(`${path} is not a results document: it has no scoreLog or no meta.`);
  }
  return results as RunResults;
}

/** `ranking.json` — `01 §6.6`, the document the board reads. */
export async function loadRanking(workdir: string, slug: string): Promise<Ranking> {
  const path = join(runDir(workdir, slug), 'ranking.json');
  const raw = await readJson(path);
  if (raw === undefined) {
    throw new UsageError(
      `no ${path}. A ranking is only written for a DELIVERED run; a failed run writes results.json alone ` +
        '(brief §2.3 — a degraded verdict is never delivered).',
    );
  }

  const ranking = raw as Partial<Ranking>;
  if (!Array.isArray(ranking.ranking) || !Array.isArray(ranking.metrics) || ranking.health === undefined) {
    throw new UsageError(`${path} is not a ranking document: it has no ranking, metrics or health.`);
  }
  return ranking as Ranking;
}

/**
 * `ab.json`, if the A/B check has been run. `undefined` is a legitimate state and
 * emphatically NOT an error here — the report renders the fix-1.1 gate as MISSING
 * and says how to produce it, which is more useful than refusing to render at all.
 */
export async function loadAbCheck(workdir: string, slug: string): Promise<AbCheckResult | undefined> {
  const raw = await readJson(join(runDir(workdir, slug), 'ab.json'));
  if (raw === undefined) return undefined;

  const ab = raw as Partial<AbCheckResult>;
  if (!Array.isArray(ab.products) || ab.summary === undefined) return undefined;
  return ab as AbCheckResult;
}
