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
 *
 * ## The authoritative half of `brief §2.4`'s two checks
 *
 * > "Check before payment (client, fast feedback) **and** before enqueue
 * > (server, authoritative)."
 *
 * The pre-payment half runs in `handleCheckoutCreate`. This is the other half,
 * and it is the binding one, because the board moves between the two: minutes
 * pass while a card is authorised, and in that window a nightly rebuild can close
 * the cycle or another pitch can land on the same normalized URL. A submission
 * that was clear at checkout and is cycle-locked at settlement must not be placed
 * — it would be the second pitch for one product in one cycle, which is exactly
 * what `brief §2.4` caps.
 *
 * It runs BEFORE `queue.send`, which is what makes it worth running at all: a
 * placement is six juror calls, a clustering pass and four forced choices, and a
 * guard that fired after the event was sent would be a guard that had already
 * paid for the run it was refusing.
 *
 * **The ownership conflict is here on purpose and does not move earlier.** Under
 * guest checkout there is no identity until the webhook resolves one from the
 * address Dodo verified, so this is the first moment the rule can be evaluated at
 * all — `checkSubmissionLocal` skips it whenever `accountId` is null, and at
 * checkout it is null. The one exception is a submitter who was signed in when
 * they submitted: `handleCheckoutCreate` passes their account id, the conflict is
 * refused before the charge, and this hold never fires for them.
 *
 * **The product's identity is NOT re-derived here.** `submission.normalizedUrl`
 * is the resolved cap key — `brief §2.5`'s shortener resolution, run once before
 * the buyer left for Dodo — and it is passed back into the re-check as
 * `resolvedUrl` rather than being recomputed from `submission.url`. Two reasons,
 * and both are about the money having already moved. Re-resolving would put a
 * network call between a settled payment and the run it bought, so a shortener
 * being slow at settlement could refuse a paid submission outright. And a
 * resolution that came back DIFFERENTLY — the destination moved in the minutes
 * the card took to authorise — would silently re-key the product, so the guard
 * would read one board row while `jobIdempotencyKey` and the placement wrote
 * another. The re-check is authoritative about the board, not about which product
 * this is; that was settled, and paid for, before it got here.
 *
 * **No attempt is consumed by any of this.** `brief §2.3` spends an attempt only
 * when a verdict is delivered, inside the delivery transaction. A refusal here
 * costs the customer their money's worth of attempts sitting on their balance,
 * unspent, and a support conversation — which is why the caller parks the event
 * for review rather than discarding it.
 */

import type { Product } from '@the-pit/engine';
import { jobIdempotencyKey } from '@the-pit/payments';

import { assignPseudonyms } from '@/lib/anon';

import { rejectionSummary, runSubmissionGuards, type SubmissionGuardDeps } from '@/lib/checkout/guards';
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
  /**
   * The founder's own words, when they wrote any.
   *
   * Read back so a follow-up has it, and deliberately UNUSED here: the placement
   * event still carries the same `Product` — a name and a description — and the
   * juror prompts are unchanged. Wiring the pitch into scoring is an engine
   * change with its own calibration cost; see the phase report.
   */
  readonly pitch?: string | null;
  /**
   * The buyer asked to be published without their name or their URL.
   *
   * Read back and USED, unlike the pitch. It is the one field on the draft that
   * changes what the panel is shown: an anonymous listing is marshalled into the
   * engine already wearing its designation, because a juror who is given a real
   * name can write it into a reason and a reason is published verbatim
   * (`lib/pipeline/pg-catalog.ts` argues this at length for the rows already on
   * the board; below is the same argument for the row being placed).
   *
   * Optional in the type only so a fixture or a row written before the column
   * existed still parses. Absent is NAMED, which is what those rows were promised
   * — the form that took them offered no other option.
   */
  readonly anonymous?: boolean;
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
  /**
   * `brief §2.4`'s authoritative check, re-run against the board as it stands at
   * settlement. See the module header.
   *
   * Nullable, and the null arm is a real deployment rather than a convenience: a
   * process with no listing store bound cannot answer "has this product already
   * been pitched tonight", and answering it wrongly in either direction is worse
   * than saying so. So `null` means the check does not run, the placement
   * proceeds on the pre-payment clearance, and the caller has one greppable
   * reason for why. It is never the default in `lib/payments/config.ts`.
   */
  readonly guards?: SubmissionGuardDeps | null;
  /**
   * The clock the re-check runs against. Injected so the cycle arithmetic is
   * testable at a fixed instant, exactly as `CheckoutHandlerDeps.now` is —
   * every rule this re-check applies is a rule about *when*.
   */
  readonly now?: () => Date;
}

export interface EnqueuePlacementInput {
  readonly accountId: string;
  /**
   * The address Dodo verified and billed.
   *
   * `brief §2.1`: there is no login at submission, and "the email IS the account
   * key at this phase". It travels beside the account id rather than instead of
   * it because the two answer to different tables —
   * `products.submitted_by_email` is the address,
   * `verdicts.account_id`/`attempts.account_id` are the uuid — and
   * `products_source_submitter` requires the address on any row marked `paid`.
   *
   * Without it the placement writes the paying customer's listing as a seeded,
   * unclaimed row, which is what `brief` Part 7 reserves for the cold-start
   * boards and what silently disables `brief §2.4`'s cycle cap, its
   * material-change rule and the ownership rule (see `lib/pipeline/pg-store.ts`).
   */
  readonly email: string;
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

  // `brief §2.4`, the authoritative half: every guard re-run against the board
  // as it stands now, BEFORE a single model call is bought. A submission that was
  // clear when the buyer clicked pay and is cycle-locked, materially unchanged,
  // category-mismatched or owned by somebody else at settlement stops here.
  if (deps.guards !== undefined && deps.guards !== null) {
    const rechecked = await runSubmissionGuards(
      {
        draft: {
          url: submission.url,
          name: submission.name,
          description: submission.description,
          categorySlug: submission.categorySlug,
        },
        now: (deps.now ?? (() => new Date()))(),
        // The identity Dodo verified. This is the first point in a guest checkout
        // at which the ownership rule can be evaluated at all.
        accountId: input.accountId,
        // The cap key banked at checkout — the same string that goes into
        // `jobIdempotencyKey` and `products.normalized_url` twenty lines below.
        // No resolver runs on this path. See the module header.
        resolvedUrl: submission.normalizedUrl,
      },
      deps.guards,
    );

    if (rechecked.status === 'rejected') {
      return {
        enqueued: false,
        // Prefixed, so the review queue can be filtered to the payments that
        // landed and were then refused — which is a different conversation from
        // a payment that could not find its submission.
        reason: `the submission no longer passes its guards — ${rejectionSummary(rechecked.rejection)}`,
      };
    }
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

  /**
   * The identity the RUN is allowed to see.
   *
   * `pg-catalog.ts` already does this for every row that is on the board: an
   * anonymous listing is marshalled into the engine wearing its designation, with
   * its address blanked, because names reach three prompts and every one of those
   * passes produces free text that is published in full. A juror who was shown
   * "Ashgrove" can put "Ashgrove" in a reason, and there is no filter that takes it
   * back out of prose about the thing.
   *
   * The row being PLACED cannot be covered by that, because it is not in
   * `products` yet — it exists only on this event. So the same redaction is
   * applied here, at the one place the event is built, and everything downstream
   * inherits it without a second rule: the panel scores a designation, `deliver`
   * reads `url === ''` to decide what to redact out of the published board, and
   * `verdictPayload` reads the same sentinel to stamp the frozen verdict
   * `anonymous`. One blanked address, three surfaces, no new agreement to keep.
   *
   * The designation is assigned across the category's whole anonymous population
   * rather than minted alone, exactly as `pg-catalog` assigns it — ascending
   * engine id, first free wins — so the name this placement is given is the same
   * name every later board build reproduces for it.
   */
  const engineId = nextEngineId(category.products);
  const anonymous = submission.anonymous === true;
  const designation = anonymous
    ? assignPseudonyms(submission.categorySlug, [...anonymousIdsIn(category.products), engineId]).get(engineId)
    : undefined;

  const product: Product = {
    id: engineId,
    name: designation ?? submission.name,
    description: submission.description,
    // Blank is the sentinel every downstream surface already reads. See above.
    url: anonymous ? '' : submission.url,
    normalized_url: anonymous ? '' : submission.normalizedUrl,
    orig_rank: engineId + 1,
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
    payer: {
      accountId: input.accountId,
      // Lowercased because `products_email_lowercase` and
      // `accounts_email_lowercase` are the same rule on two tables: one address
      // is one person, and `A@b.com` and `a@b.com` must not become two.
      email: input.email.trim().toLowerCase(),
      // `brief §2.4`'s publicly-shown ordinal, computed by `checkSubmissionLocal`
      // BEFORE the money moved and carried on the `submissions` row since. It
      // counts pitches and not runs, which is why it is read back here rather
      // than derived from anything the pipeline can see: a free retry re-enters
      // the pipeline with the same submission and must not advance it.
      attemptNumber: submission.attemptNumber,
      /**
       * The choice, and the identity it withholds.
       *
       * `anonymous` is what `products.anonymous` is written from, and it is the
       * last hop of a value that started on a radio button and has not been
       * re-derived once: form -> `submissions.anonymous` -> here -> `products`,
       * where `products_anonymity_immutable` freezes it.
       *
       * `listing` is the real name and address, which the `product` above no
       * longer carries. The catalogue write needs them — `products` stores the
       * TRUTH and redacts on the way out, which is what `pg-catalog` reads and
       * what makes a later claim able to reveal anything at all. A row that stored
       * its own designation would have forgotten who it was, and the one legal
       * transition (`anonymous -> named` on a verified claim) would have nothing
       * to reveal.
       *
       * Sent only when the listing is anonymous. On a named placement the product
       * already carries both, and a second copy would be two answers to one
       * question.
       */
      ...(anonymous
        ? { anonymous: true, listing: { name: submission.name, url: submission.url } }
        : {}),
    },
  };

  await deps.queue.send(event);
  return { enqueued: true, idempotencyKey, event };
}

/** `max(existing) + 1`, and `0` for a category with no rows. See the header. */
function nextEngineId(products: readonly Product[]): number {
  return products.reduce((highest, product) => Math.max(highest, product.id), -1) + 1;
}

/**
 * Which rows in the loaded category are already published anonymously.
 *
 * The blank address, which is the sentinel `pg-catalog` sets when it marshals an
 * anonymous row into the engine and the same one `deliverStep` reads. Asking the
 * catalogue rather than the database keeps this function on the data the event is
 * actually being built from — a second query could disagree with the roster whose
 * engine ids the designation has to avoid.
 */
function anonymousIdsIn(products: readonly Product[]): number[] {
  return products.filter((product) => product.url === '').map((product) => product.id);
}
