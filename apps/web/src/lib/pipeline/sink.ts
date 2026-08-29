/**
 * The one place a `SnapshotSink` is constructed from the environment.
 *
 * A placement PUBLISHES through a sink (`run.ts`'s `deliver` step, via
 * `service.ts`'s bindings) and `/boards/<slug>` READS through one
 * (`lib/boards/source.ts`). Until this module existed those were two different
 * pieces of code pointed at two different places: the write side went to the
 * bucket in production and the read side went to `readFile` always, so a customer
 * could pay, place, and watch the public board never change. Nothing threw. The
 * board was simply a different document from the one that had just been written.
 *
 * So the factory is one function and both sides call it. That is the property
 * worth having — not "the read path also knows about buckets", but "there is no
 * second answer to where a board lives".
 *
 * ## What it does NOT drag onto the read path
 *
 * Nothing here imports `@the-pit/engine`, `@the-pit/db`, a driver or an SDK.
 * `bucket.ts` is `fetch` and JSON with the transport injected; `snapshot.ts` is
 * types, cache policy and a directory. `brief` Part 3's "reads never touch a
 * model" and `02 §4`'s "the board never computes anything at read time" stay
 * properties of the import graph, and `test/boards-read-path.test.ts` walks it
 * from the routes and fails if that stops being true.
 */

import { BucketSnapshotSink, HttpObjectStore } from './bucket';
import {
  bucketProblems,
  isProductionBuild,
  PipelineBindingError,
  SNAPSHOT_BUCKET_TOKEN_ENV,
  SNAPSHOT_BUCKET_URL_ENV,
  SNAPSHOT_PURGE_URL_ENV,
  snapshotRootOf,
  storageMode,
  type Env,
} from './mode';
import { FileSnapshotSink, type SnapshotSink } from './snapshot';

/**
 * The sink this environment publishes to and reads from.
 *
 * `filesystem` is a directory of board JSON, which is the local and CI story and
 * the one `01 §4`'s offline seeding produces. `postgres` is the bucket, and it is
 * REQUIRED rather than defaulted: a deployment whose bucket is unset would
 * otherwise write a board to a lambda's disk and 404 it on the next request.
 *
 * The one exception is `next build`, which sets `NODE_ENV=production` on a laptop
 * with nothing provisioned. Prerendering a board there must not require a bucket
 * — and it cannot reach local disk on a live server instead, because
 * `assertBindingsConfigured` refuses to boot one in this state
 * (`src/instrumentation.ts`).
 */
export function defaultSnapshotSink(env: Env = process.env): SnapshotSink {
  if (storageMode(env) === 'filesystem') return new FileSnapshotSink(snapshotRootOf(env));

  const problems = bucketProblems(env);
  if (problems.length > 0) {
    if (isProductionBuild(env)) return new FileSnapshotSink(snapshotRootOf(env));
    throw new PipelineBindingError(problems.join('\n\n---\n\n'));
  }

  return new BucketSnapshotSink(
    new HttpObjectStore({
      baseUrl: (env[SNAPSHOT_BUCKET_URL_ENV] ?? '').trim(),
      ...(env[SNAPSHOT_BUCKET_TOKEN_ENV] === undefined ? {} : { token: env[SNAPSHOT_BUCKET_TOKEN_ENV] }),
      ...(env[SNAPSHOT_PURGE_URL_ENV] === undefined || env[SNAPSHOT_PURGE_URL_ENV] === ''
        ? {}
        : { purgeUrl: env[SNAPSHOT_PURGE_URL_ENV] }),
    }),
  );
}
