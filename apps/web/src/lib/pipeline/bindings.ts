/**
 * Whether this deployment can be bound at all — asked at boot, and asked without
 * loading anything that boots slowly or refuses to bundle.
 *
 * The check itself is `brief §2.3`'s: a deployment missing `DATABASE_URL` or a
 * snapshot bucket must fail in the deploy log, once, before the first request —
 * not forty seconds into a paid run with three phases already bought. That has
 * not changed. What changed is where it lives.
 *
 * ## Why this is its own module and not part of `service.ts`
 *
 * `src/instrumentation.ts` is the only caller, and Next compiles instrumentation
 * in a separate pass from the app's server bundle — one where
 * `serverExternalPackages` is not applied. `service.ts` imports `@the-pit/engine`
 * (for `phaseVersions`) and the engine's `panels/seeded.ts` imports `node:crypto`
 * for its seeded PRNG, so that pass tried to bundle a Node builtin, failed with
 * `UnhandledSchemeError: Reading from "node:crypto" is not handled by plugins`,
 * and every route in the app 500'd on a compile error in a file none of them use.
 *
 * A polyfill or an alias would have hidden that rather than fixed it. The real
 * statement is that **the boot check does not need the engine**: it reads five
 * environment variables. So it sits on a graph that has none — `./mode`, which
 * imports nothing at all, and `@the-pit/db/config`, the dependency-free half of
 * the database package, reached through its own export so the driver, Drizzle and
 * the schema stay behind the `.` entry point where the pipeline uses them.
 *
 * `service.ts` re-exports both functions, so every existing caller and every test
 * still asks for them at the name they already used.
 */

import { requireDatabaseUrl } from '@the-pit/db/config';

import { bucketProblems, PipelineBindingError, SNAPSHOT_PURGE_URL_ENV, storageMode, type Env } from './mode';

/**
 * Every reason this environment cannot be bound, in one message.
 *
 * All of them at once rather than the first: someone configuring a deployment
 * should not have to redeploy three times to be told about three variables.
 * Returns the empty array when the binding is sound.
 */
export function bindingProblems(env: Env = process.env): string[] {
  const problems: string[] = [];

  let mode: 'filesystem' | 'postgres';
  try {
    mode = storageMode(env);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  if (mode === 'filesystem') return problems;

  try {
    requireDatabaseUrl(env);
  } catch (error) {
    // `DATABASE_URL` is what `PgPipelineStore` writes phases through AND what
    // `PgCategorySource` reads the population and the approved panels from. A
    // deployment missing it cannot see a placement either.
    problems.push(error instanceof Error ? error.message : String(error));
  }

  // The bucket half is `mode.ts`'s, because the board READ path needs the same
  // check and must not import a database driver to make it.
  problems.push(...bucketProblems(env));

  return problems;
}

/**
 * Throw unless this environment can be bound. Called once, at server startup.
 *
 * The point of the timing: `brief §2.3` makes a failed run a free retry, but a
 * run that cannot PERSIST is not a failed run — it is a run that spends money and
 * then loses the receipt. Discovering that at the first paid submission is
 * discovering it too late, so it is discovered at boot instead.
 */
export function assertBindingsConfigured(env: Env = process.env): void {
  const problems = bindingProblems(env);
  if (problems.length > 0) {
    throw new PipelineBindingError(
      `The run pipeline cannot be bound in this environment (${problems.length} problem(s)):\n\n` +
        problems.join('\n\n---\n\n'),
    );
  }

  if (storageMode(env) === 'postgres' && (env[SNAPSHOT_PURGE_URL_ENV] ?? '') === '') {
    // A warning, not a failure. Some stores' CDNs revalidate on `Cache-Control`
    // alone and have no purge API at all, and `BOARD_CACHE_CONTROL` already
    // carries `stale-while-revalidate`. What it costs is latency on the one
    // property `02 §4` names, so it is said once, loudly, at startup.
    console.warn(
      `[pipeline] ${SNAPSHOT_PURGE_URL_ENV} is not set: a placement rewrites the board object but does not ` +
        `invalidate its CDN path, so the new board can be up to s-maxage (1 day) late at the edge (02 §4).`,
    );
  }
}
