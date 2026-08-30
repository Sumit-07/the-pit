/**
 * Re-resolve `products.normalized_url` against `DATABASE_URL`.
 *
 * `pnpm --filter @the-pit/db db:backfill-urls [-- --dry-run] [--shorteners]
 * [--batch=N] [--after=<uuid>]`, after a build.
 *
 * This is the half of `brief §2.5`'s shortener resolution that the submission
 * path cannot do for itself. Rows written before the wiring hold the offline key,
 * so until this has run a `bit.ly/x` row and a resolved submission for the page
 * behind it are two products and the per-product cap does not join them. See
 * `src/backfill/normalized-url.ts` for why it is idempotent and what it refuses
 * to guess at.
 *
 * `--dry-run` resolves everything and writes nothing, which is how to see how
 * many rows move and how many products are about to merge before any of it
 * happens. `--shorteners` narrows to rows already keyed on a known shortener host
 * — faster, and strictly less complete, because the cross-host rule catches
 * shorteners that are on no list.
 *
 * The fetcher is the app's, at its package defaults. There is no flag that
 * widens a cap here for the reason `apps/web/src/lib/ingest/product-url.ts`
 * gives: an operator who can raise the redirect cap from a shell can raise it
 * from a compromised shell.
 */

import { resolveProductUrl, SHORTENER_HOSTS } from '@the-pit/fetch';
import { createNodeFetcher } from '@the-pit/fetch/node';

import type { BackfillUrlResolver } from '../backfill/normalized-url.js';
import { backfillNormalizedUrls } from '../backfill/normalized-url.js';
import { createDatabase } from '../client.js';
import { MissingDatabaseUrlError } from '../config.js';

function numberFlag(args: readonly string[], name: string): number | undefined {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  if (found === undefined) return undefined;
  const value = Number(found.slice(name.length + 3));
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function textFlag(args: readonly string[], name: string): string | undefined {
  const found = args.find((arg) => arg.startsWith(`--${name}=`));
  return found === undefined ? undefined : found.slice(name.length + 3);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const shortenersOnly = args.includes('--shorteners');
  const batchSize = numberFlag(args, 'batch');
  const startAfterId = textFlag(args, 'after');

  const fetcher = createNodeFetcher();
  const resolve: BackfillUrlResolver = async (url) => {
    const outcome = await resolveProductUrl(url, fetcher);
    if (!outcome.ok) return { ok: false, reason: `${outcome.refusal.code}: ${outcome.refusal.reason}` };
    return { ok: true, normalizedUrl: outcome.value.normalizedUrl };
  };

  const handle = createDatabase();
  try {
    const report = await backfillNormalizedUrls(handle.db, resolve, {
      dryRun,
      shortenerHostsOnly: shortenersOnly,
      shortenerHosts: SHORTENER_HOSTS,
      ...(batchSize === undefined ? {} : { batchSize }),
      ...(startAfterId === undefined ? {} : { startAfterId }),
      onChange: (change) => {
        process.stdout.write(`${change.productId}  ${change.from}  ->  ${change.to}\n`);
      },
    });

    process.stdout.write(
      [
        '',
        `scanned    ${report.scanned}`,
        `unchanged  ${report.unchanged}`,
        `${dryRun ? 'would write' : 'rewritten '} ${dryRun ? report.changes : report.rewritten}`,
        `merged     ${report.collided}  (rows now sharing a key with another row — the point)`,
        `refused    ${report.refused}  (left exactly as they were)`,
        `last id    ${report.lastId ?? '-'}  (resume with --after=<id>)`,
        '',
      ].join('\n'),
    );

    for (const refusal of report.refusals) {
      process.stdout.write(`refused ${refusal.productId} ${refusal.url}: ${refusal.reason}\n`);
    }
    if (dryRun) process.stdout.write('\n--dry-run: nothing written.\n');
  } finally {
    await handle.close();
  }
}

main().catch((error: unknown) => {
  if (error instanceof MissingDatabaseUrlError) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  }
  process.exitCode = 1;
});
