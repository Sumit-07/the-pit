/**
 * Which pair of implementations this deployment is bound to, and the environment
 * that decides it.
 *
 * Split out of `service.ts` and deliberately dependency-free: this module imports
 * NOTHING — not the engine, not `@the-pit/db`, not a driver. That is what lets
 * the board READ path ask the same question the write path asks, without the
 * question dragging a Postgres client onto a page that `brief` Part 3 requires to
 * be a static snapshot ("reads never touch a model"). Two copies of the rule
 * would be worse than either answer: the day one of them changed, a board would
 * quietly start reading a different place from the one a placement writes to.
 *
 * `service.ts` re-exports every name here, so nothing that already imported them
 * from there has to move.
 */

/** Which pair of implementations a deployment is bound to. */
export type StorageMode = 'filesystem' | 'postgres';

/** The environment variable that overrides the default choice. */
export const STORAGE_MODE_ENV = 'PIT_STORAGE';

/** The bucket the board snapshots are published to, and read back from. Required in `postgres` mode. */
export const SNAPSHOT_BUCKET_URL_ENV = 'PIT_SNAPSHOT_BUCKET_URL';
/** Bearer token for writes to that bucket. */
export const SNAPSHOT_BUCKET_TOKEN_ENV = 'PIT_SNAPSHOT_BUCKET_TOKEN';
/** Optional: where a single-key CDN purge is POSTed after a placement. */
export const SNAPSHOT_PURGE_URL_ENV = 'PIT_SNAPSHOT_PURGE_URL';

/** `@the-pit/db`'s own name for it, restated so this module imports nothing. */
export const DATABASE_URL_ENV = 'DATABASE_URL';

/** A readable snapshot of the process environment. Injectable so tests never mutate the real one. */
export type Env = Readonly<Record<string, string | undefined>>;

/**
 * The deployment cannot be bound as configured.
 *
 * A named class, for the same reason `@the-pit/db` has `MissingDatabaseUrlError`:
 * "this deployment is not configured" and "the database refused the connection"
 * present identically and are fixed in completely different places.
 */
export class PipelineBindingError extends Error {
  override readonly name = 'PipelineBindingError';
}

/**
 * Is this a deployment where an ephemeral filesystem is a correctness bug?
 *
 * `VERCEL` is set in every Vercel build and runtime, including previews — a
 * preview deployment has the same ephemeral filesystem and the same real API key
 * as production, so it gets the same rule. `NODE_ENV` catches a self-hosted
 * production server.
 */
export function requiresDurableStorage(env: Env = process.env): boolean {
  return env['VERCEL'] !== undefined || env['NODE_ENV'] === 'production';
}

/**
 * Is this `next build` rather than a running server?
 *
 * `next build` sets `NODE_ENV=production`, so `requiresDurableStorage` is true on
 * a laptop running `pnpm build` — and a build has no bucket, no database and
 * nothing to spend. `src/instrumentation.ts` already skips the startup assertion
 * on this phase for exactly that reason; the read path needs the same escape,
 * because prerendering a board must not require a provisioned bucket.
 *
 * It is not a way to reach local disk on a live server: `assertBindingsConfigured`
 * runs on the deployed server's first cold start, before any request, and refuses
 * to boot an unconfigured one.
 */
export function isProductionBuild(env: Env = process.env): boolean {
  return env['NEXT_PHASE'] === 'phase-production-build';
}

/**
 * Which mode this environment binds, or a `PipelineBindingError`.
 *
 * `PIT_STORAGE` may only narrow toward durability. Setting it to `filesystem` on
 * a deployment that needs durable storage is refused rather than honoured: it is
 * the one setting that produces the double-charge `service.ts` describes, and an
 * environment variable is not a good enough reason to allow it.
 */
export function storageMode(env: Env = process.env): StorageMode {
  const requested = env[STORAGE_MODE_ENV];
  const durable = requiresDurableStorage(env);

  if (requested === undefined || requested === '') {
    return durable ? 'postgres' : 'filesystem';
  }
  if (requested !== 'filesystem' && requested !== 'postgres') {
    throw new PipelineBindingError(
      `${STORAGE_MODE_ENV} must be "filesystem" or "postgres", got ${JSON.stringify(requested)}.`,
    );
  }
  if (requested === 'filesystem' && durable) {
    throw new PipelineBindingError(
      `${STORAGE_MODE_ENV}=filesystem is refused on this deployment.\n\n` +
        'Every invocation here gets its own filesystem, so a run whose phases land on two instances would\n' +
        'find nothing persisted and re-buy a phase the customer has already paid for (brief §2.3).\n' +
        `Unset ${STORAGE_MODE_ENV} and set ${DATABASE_URL_ENV} and ${SNAPSHOT_BUCKET_URL_ENV} instead.`,
    );
  }
  return requested;
}

/** Where `cjr/` is, for a binding that reads it. */
export function workdirOf(env: Env = process.env): string {
  return env['PIT_WORKDIR'] ?? 'cjr';
}

/** Where `FileSnapshotSink` keeps `boards/<slug>.json`. */
export function snapshotRootOf(env: Env = process.env): string {
  return env['PIT_SNAPSHOT_ROOT'] ?? `${workdirOf(env)}/public`;
}

export const HOW_TO_FIX_BUCKET = [
  `Set ${SNAPSHOT_BUCKET_URL_ENV} to the base URL board snapshots are written under, e.g.`,
  '  https://<bucket>.example-store.com/pit',
  `and ${SNAPSHOT_BUCKET_TOKEN_ENV} to a token with write access to it.`,
  '',
  `${SNAPSHOT_PURGE_URL_ENV} is optional: set it when the CDN in front of the bucket has a purge API,`,
  "so a placement invalidates that one category's board path (02 §4) instead of waiting out s-maxage.",
].join('\n');

/**
 * What is wrong with the bucket configuration, if anything.
 *
 * Separate from `bindingProblems` in `service.ts` because that one also needs
 * `DATABASE_URL`, which means importing `@the-pit/db` — and this half has to stay
 * reachable from a board read.
 */
export function bucketProblems(env: Env = process.env): string[] {
  const bucket = env[SNAPSHOT_BUCKET_URL_ENV];
  if (bucket === undefined || bucket.trim() === '') {
    return [
      `${SNAPSHOT_BUCKET_URL_ENV} is not set, so a delivered board has nowhere durable to be published.\n\n` +
        HOW_TO_FIX_BUCKET,
    ];
  }
  if (!/^https?:\/\//.test(bucket.trim())) {
    return [
      `${SNAPSHOT_BUCKET_URL_ENV} must be an http(s) URL, got ${JSON.stringify(bucket)}.\n\n${HOW_TO_FIX_BUCKET}`,
    ];
  }
  return [];
}
