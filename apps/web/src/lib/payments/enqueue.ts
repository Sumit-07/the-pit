/**
 * Turning a settled payment into one enqueued placement — and the key that makes
 * a second delivery of that event cost nothing.
 *
 * ## The whole point of this module is one field
 *
 * `pit/placement.requested` has carried an optional `idempotencyKey` since the
 * placement function was written, and `PlacementClaims` has been reading it, and
 * `jobs_idempotency_key_uk` has been the unique index behind it. Nothing was
 * putting a value in it, because nothing was firing the event. This is the
 * enqueue site, so this is where the key is computed, and `claims.ts` is precise
 * about what it buys:
 *
 * > "Two placements are twelve juror calls, two clustering passes and two persona
 * > rounds for one $5 — and because nobody is double-charged, nobody reports it.
 * > It surfaces as an inference bill that does not match the sales count, months
 * > later."
 *
 * The key is `jobIdempotencyKey` from `@the-pit/payments`, unchanged and not
 * re-derived here:
 * `(accountId, normalizedUrl, descriptionHash, cycleId)`. Deliberately not the
 * payment id — an account that bought three attempts pitches three different
 * products against one payment — and deliberately including the cycle, so
 * `brief §2.4`'s re-pitch after the next rebuild is a genuinely different
 * submission rather than a silent no-op resolving to the first job.
 *
 * ## Why the webhook enqueues rather than the success redirect
 *
 * Same sentence as the grant. `brief §2.2`: the redirect is a URL the buyer's
 * browser lands on, and a redirect that started a paid run would be a
 * free-inference endpoint with its parameters written on the outside.
 *
 * ## The engine id is assigned here, and it has to be
 *
 * `PlacementRequestedData.product` is a `Product`, and `Product.id` is the
 * engine's 0-based index into a category's usable rows — the key every stored
 * score, cluster and vote attaches to. `assertPlaceable` refuses a colliding one.
 * So the id is drawn from the category's current roster at enqueue time, as
 * `max(existing) + 1`, rather than from the roster's LENGTH: a category that ever
 * loses a row (`DECISIONS.md` OPEN-1 drains seeds gradually) would otherwise
 * hand a new submission an id that a dropped product still owns in the score log.
 *
 * `orig_rank` gets the same number. A paid submission has no source-sheet rank —
 * there is no sheet — and the seeded rows are sorted by `orig_rank`, so their id
 * and their rank already move together. Giving a paid row its own position keeps
 * `report/leak.ts`'s `id_vs_orig_rank` measuring what it measures instead of
 * being pulled by an arbitrary constant.
 */

import type { Product } from '@the-pit/engine';
import { jobIdempotencyKey } from '@the-pit/payments';

import type { CategorySource } from '@/lib/pipeline/catalog';
import type { PlacementRequestedData } from '@/lib/pipeline/inngest';

/** The draft the buyer typed, read back after the payment settled. */
export interface PendingSubmission {
  readonly submissionId: string;
  readonly categorySlug: string;
  readonly name: string;
  readonly url: string;
  readonly normalizedUrl: string;
  readonly description: string;
  readonly descriptionHash: string;
  readonly cycleId: string;
  readonly tier: 'single' | 'triple';
  readonly attemptNumber: number;
  readonly repitchOf: string | null;
}

/**
 * Where the pending pitch is read from.
 *
 * One method, and it is a READ. The webhook must not be able to create a
 * submission: the draft is written before checkout opens, by the route that took
 * the buyer's text, and a webhook that could invent one would be a way to start a
 * paid run from a payload a third party posts to us.
 */
export interface SubmissionLookup {
  find(submissionId: string): Promise<PendingSubmission | null>;
}

/** Where a placement event goes. `inngest.send`, or a recorder in a test. */
export interface PlacementQueue {
  send(event: PlacementRequestedData): Promise<void>;
}

export interface PlacementEnqueueDeps {
  readonly submissions: SubmissionLookup;
  readonly categories: CategorySource;
  readonly queue: PlacementQueue;
}

export interface EnqueuePlacementInput {
  readonly accountId: string;
  /** Dodo's `metadata`, verbatim. Attacker-influenced; only the id is read. */
  readonly metadata: Readonly<Record<string, string>>;
}

/**
 * What happened, in a shape the caller can log and route.
 *
 * A refusal is never a throw. Every arm below is a state in which the customer
 * has already paid and already has attempts on their balance, so the money is
 * safe and what is missing is a run — which is a review-queue entry and a
 * support conversation, not a 500 that tells Dodo to redeliver a payment we
 * already recorded.
 */
export type EnqueuePlacementResult =
  | { readonly enqueued: true; readonly idempotencyKey: string; readonly event: PlacementRequestedData }
  | { readonly enqueued: false; readonly reason: string };

export async function enqueuePlacementForPayment(
  input: EnqueuePlacementInput,
  deps: PlacementEnqueueDeps,
): Promise<EnqueuePlacementResult> {
  const submissionId = input.metadata['submission_id'] ?? '';
  if (submissionId === '') {
    // A payment with no submission attached. Legitimate for a manually created
    // Dodo payment link and never legitimate for a checkout we opened, so it is
    // reported rather than absorbed.
    return { enqueued: false, reason: 'the payment carries no submission_id' };
  }

  const submission = await deps.submissions.find(submissionId);
  if (submission === null) {
    return { enqueued: false, reason: `no pending submission ${JSON.stringify(submissionId)}` };
  }

  // The category as it stands NOW, not as it stood when checkout opened. A
  // placement between the two moved `category_snapshot_version` and every
  // z-score with it (`brief §1.2`), and the event must name the version it will
  // actually run under or the pipeline resolves a different population.
  const category = await deps.categories.load(submission.categorySlug);
  if (category === undefined) {
    return {
      enqueued: false,
      reason: `the category ${JSON.stringify(submission.categorySlug)} is not seeded here`,
    };
  }

  const product: Product = {
    id: nextEngineId(category.products),
    name: submission.name,
    description: submission.description,
    url: submission.url,
    normalized_url: submission.normalizedUrl,
    orig_rank: nextEngineId(category.products) + 1,
  };

  const idempotencyKey = jobIdempotencyKey({
    accountId: input.accountId,
    normalizedUrl: submission.normalizedUrl,
    descriptionHash: submission.descriptionHash,
    cycleId: submission.cycleId,
  });

  const event: PlacementRequestedData = {
    slug: submission.categorySlug,
    categoryVersion: category.config.categoryVersion,
    product,
    idempotencyKey,
  };

  await deps.queue.send(event);
  return { enqueued: true, idempotencyKey, event };
}

/** `max(existing) + 1`, and `0` for a category with no rows. See the header. */
function nextEngineId(products: readonly Product[]): number {
  return products.reduce((highest, product) => Math.max(highest, product.id), -1) + 1;
}
