/**
 * Read one seeded category's artifacts off disk into `SeedInput`.
 *
 * The layout is `01 §3`'s, as `packages/engine/src/run/store.ts` writes it:
 *
 *   cjr/references/jurors/<slug>.json     the approved jury   (`01 §4` Step 2)
 *   cjr/references/personas/<slug>.json   the approved panel  (`01 §4` Step 3)
 *   cjr/runs/<slug>/products.json         the prepared category
 *   cjr/runs/<slug>/ranking.json          the board            (`01 §6.6`)
 *   cjr/runs/<slug>/results.json          the raw record — GIT-IGNORED
 *
 * `results.json` is optional for exactly that reason: it is in `.gitignore`
 * alongside `report.md`, so it exists on the machine that produced the run and
 * not in a fresh clone. When it is there the seed is exact; when it is not, the
 * board is reconstructed and `buildSeedRows` warns. See `build.ts`'s header.
 *
 * Every file is parsed and shape-checked before it is used. A seed that half
 * loads is worse than one that refuses: it produces a category with a board and
 * no score log, which looks fine on the homepage and cannot be recomputed.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Jury, PersonaPanel, ProductSet, Ranking, RunResults } from '@the-pit/engine';

import type { SeedInput } from './build.js';
import { SEED_APPROVER } from './build.js';

/** `cjr/`, relative to the repository root. `01 §3`. */
export const DEFAULT_WORKDIR = 'cjr';

/**
 * The two categories `DECISIONS.md` S4 chose for Phase 1: Developer Tools (48
 * usable, b2b) and Health, Fitness & Wellness (44 usable, consumer). One of each
 * archetype, and H&F at n=44 is the board that exercises `brief §1.4`'s
 * chunk-balancing fix.
 */
export const SEEDED_SLUGS = ['developer-tools', 'health-fitness-wellness'] as const;

/** Load one category. Throws with the path in the message if anything is missing. */
export async function loadSeedInput(slug: string, workdir: string = DEFAULT_WORKDIR): Promise<SeedInput> {
  const runDir = join(workdir, 'runs', slug);

  const ranking = await readJson<Ranking>(join(runDir, 'ranking.json'));
  const productSet = await readJson<ProductSet>(join(runDir, 'products.json'));
  const jury = await readJson<Jury>(join(workdir, 'references', 'jurors', `${slug}.json`));
  const panel = await readJson<PersonaPanel>(join(workdir, 'references', 'personas', `${slug}.json`));
  const results = await readJsonIfPresent<RunResults>(join(runDir, 'results.json'));

  requireArray(ranking.ranking, `${slug}: ranking.json has no ranking rows`);
  requireArray(productSet.products, `${slug}: products.json has no products`);
  requireArray(jury.jurors, `${slug}: jury has no jurors`);
  requireArray(panel.personas, `${slug}: panel has no personas`);

  if (ranking.prompt_version !== jury.prompt_version) {
    // The board was ranked under one jury and the installed file is another.
    // Seeding both would put a `prompt_version` on `score_rows` that does not
    // match the mandates stored beside it, and `brief §1.3`'s cache key would
    // name a jury that never produced those scores.
    throw new Error(
      `${slug}: ranking.json was produced under prompt_version ${JSON.stringify(ranking.prompt_version)} but the ` +
        `installed jury is ${JSON.stringify(jury.prompt_version)}`,
    );
  }

  if (ranking.demand_version !== panel.persona_version) {
    throw new Error(
      `${slug}: ranking.json was produced under demand_version ${JSON.stringify(ranking.demand_version)} but the ` +
        `installed panel is ${JSON.stringify(panel.persona_version)}`,
    );
  }

  return {
    ranking,
    productSet,
    jury,
    panel,
    results,
    /**
     * `RunMeta.category_version` when the raw record is available; otherwise the
     * board's own `prompt_version` is NOT a stand-in — the population version is
     * a different axis (`brief §1.3`), so a seed with no raw record declares its
     * own initial population version rather than borrowing one.
     */
    categorySnapshotVersion: results?.meta.category_version ?? 'seed-1',
    approvedBy: SEED_APPROVER,
  };
}

async function readJson<T>(path: string): Promise<T> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (cause) {
    throw new Error(`Cannot read ${path}. Has the category been seeded? (see .claude/skills/seed-category)`, { cause });
  }
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new Error(`${path} is not valid JSON`, { cause });
  }
}

async function readJsonIfPresent<T>(path: string): Promise<T | undefined> {
  try {
    await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  return readJson<T>(path);
}

function requireArray(value: unknown, message: string): void {
  if (!Array.isArray(value) || value.length === 0) throw new Error(message);
}
