/**
 * Load the seeded boards into `DATABASE_URL`.
 *
 * `pnpm --filter @the-pit/db db:seed [-- <slug>...]`, from the repository root
 * (the artifacts are read from `./cjr`, so the working directory matters).
 *
 * Idempotent: every insert is `ON CONFLICT DO NOTHING` against deterministic ids,
 * so a second run adds nothing and a partial first run completes.
 *
 * `--dry-run` builds every row and prints the counts without connecting to
 * anything. That is the mode this repository can actually exercise today — there
 * is no database provisioned — and it is what verifies the whole build path
 * against the real seeded boards in CI.
 */

import { createDatabase } from '../client.js';
import { MissingDatabaseUrlError } from '../config.js';
import type { SeedRows } from '../seed/build.js';
import { buildSeedRows } from '../seed/build.js';
import { insertSeedRows } from '../seed/insert.js';
import { loadSeedInput, SEEDED_SLUGS } from '../seed/load.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const slugs = args.filter((arg) => !arg.startsWith('--'));
  const targets = slugs.length > 0 ? slugs : [...SEEDED_SLUGS];

  const built: { slug: string; rows: SeedRows }[] = [];
  for (const slug of targets) {
    const rows = buildSeedRows(await loadSeedInput(slug));
    built.push({ slug, rows });
    report(slug, rows);
  }

  if (dryRun) {
    process.stdout.write('\n--dry-run: nothing written.\n');
    return;
  }

  const handle = createDatabase();
  try {
    for (const { slug, rows } of built) {
      const counts = await insertSeedRows(handle.db, rows);
      process.stdout.write(`${slug}: written ${JSON.stringify(counts)}\n`);
    }
  } finally {
    await handle.close();
  }
}

function report(slug: string, rows: SeedRows): void {
  const lines = [
    `${slug} (${rows.category.type}) from ${rows.source}.json`,
    `  products          ${rows.products.length}`,
    `  score_rows        ${rows.scoreRows.length}`,
    `  clusters          ${rows.clusters.length}`,
    `  cluster_members   ${rows.clusterMembers.length}`,
    `  demand_votes      ${rows.demandVotes.length}`,
    `  rankings          ${rows.rankings.length}`,
    `  flagged_injection ${rows.flaggedInjections.length}`,
    `  verdicts          ${rows.verdicts.length}`,
    `  accounts          ${rows.accounts.length}`,
  ];
  for (const warning of rows.warnings) lines.push(`  WARNING ${warning}`);
  process.stdout.write(`${lines.join('\n')}\n`);
}

main().catch((error: unknown) => {
  if (error instanceof MissingDatabaseUrlError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  }
  process.exitCode = 1;
});
