/**
 * The submission guards, bound to this app's stores — once, for both places
 * `brief §2.4` requires them to run.
 *
 * > "Check before payment (client, fast feedback) **and** before enqueue
 * > (server, authoritative)."
 *
 * Two callers, one function:
 *
 * - `handleCheckoutCreate` runs it before a Dodo session is opened, so a
 *   rejection costs the visitor nothing. `DECISIONS.md` S12 is explicit about
 *   why: "so nobody pays for a rejection". A customer told "not until tonight's
 *   rebuild, 02:00 UTC" *before* paying has been told something true about how
 *   the board works; the same sentence *after* paying is a refund request.
 * - `enqueuePlacementForPayment` runs it again when the payment settles, and
 *   THAT run is the binding one. The board moves in between — a nightly rebuild
 *   may have closed the cycle, another pitch may have landed on the same
 *   normalized URL — and the check that decides whether inference is bought has
 *   to be the one made against the board the run will actually enter.
 *
 * Nothing about the RULES lives here. `checkSubmission` in `@the-pit/payments`
 * owns every one of them and is mutation-verified; this module supplies the two
 * things a package with no I/O cannot: the listing at a normalized URL, and a
 * classifier. Reimplementing the cycle arithmetic or the material-change measure
 * on this side is precisely the drift `guards.ts` says it exists to prevent.
 *
 * ## The URL is normalized by the engine, and only by the engine
 *
 * `normalizeSubmissionUrl` wraps `normalizeUrl` from
 * `packages/engine/src/ingest/`. It is the same function the seed workbook was
 * keyed with, which is the only reason a paid submission and a seeded row can be
 * recognised as the same product. Nothing here re-derives it.
 *
 * The lookup happens BEFORE `checkSubmission` because the listing is an input to
 * it, and it is keyed on the normalized URL and on nothing else — no account id
 * is in that query. `brief §2.4`'s cap is **per product, not per account**, so
 * someone with four side projects submits all four tonight and none of them sees
 * the other.
 *
 * ## Shortener resolution is still deferred, and it is the open evasion route
 *
 * `brief §2.5` asks for link shorteners to be resolved to their target before the
 * URL is used as an identity. `normalizeUrl` performs no I/O by design — doing it
 * needs an SSRF-guarded fetcher (redirect cap, timeout, private-address and
 * link-local blocking, scheme allow-list) over an attacker-supplied URL — so
 * `bit.ly/x` and the address behind it are two different products to this code,
 * and the per-product cap does not catch that. Named here, not built here.
 */

import {
  checkSubmission,
  countdownTo,
  cycleAt,
  normalizeSubmissionUrl,
  NIGHTLY_REBUILD,
  seededCategoryClassifier,
  type CategoryClassifier,
  type ListingSnapshot,
  type RecalibrationSchedule,
  type SubmissionCheck,
  type SubmissionDraft,
  type SubmissionRejection,
} from '@the-pit/payments';

/**
 * The one read the guards cannot run without.
 *
 * `createPostgresListingStore` in `@the-pit/db` implements it over
 * `products_normalized_url_idx`; the test suites implement it over a `Map`. One
 * method, and it takes a normalized URL — never a raw one, and never an account.
 */
export interface ListingLookup {
  findByNormalizedUrl(normalizedUrl: string): Promise<ListingSnapshot | null>;
}

export interface SubmissionGuardDeps {
  readonly listings: ListingLookup;
  /**
   * `DECISIONS.md` S12's classifier.
   *
   * `seededCategoryClassifier` is the default, and the default matters: an
   * omitted classifier used to mean "no category rule at all", which is the
   * unpoliced free rank lever S12 exists to close. A caller that wants the
   * category rule out of the way now has to say so — `acceptAllClassifier`, in a
   * test, in writing.
   */
  readonly classifier?: CategoryClassifier;
  /** Every category on offer, so a mismatch can name a better one. */
  readonly candidateCategories: () => Promise<readonly string[]>;
  /** `brief §2.4`'s rebuild clock. 02:00 UTC unless a test moves it. */
  readonly schedule?: RecalibrationSchedule;
}

export interface SubmissionGuardInput {
  readonly draft: SubmissionDraft;
  readonly now: Date;
  /**
   * Who is submitting, when we know.
   *
   * `null` at checkout under guest checkout (`brief §2.1`: no login at
   * submission), which is why the ownership rule cannot fire there and stays a
   * post-payment hold. Non-null in two cases: the webhook, which has resolved the
   * account from the address Dodo verified; and a visitor who happened to be
   * signed in when they submitted, for whom the conflict is caught before they
   * are charged rather than after.
   */
  readonly accountId: string | null;
}

/**
 * Run every guard, in the order `@the-pit/payments` puts them in: cheap and
 * local first, the classifier last.
 *
 * A URL that will not normalize never reaches the listing lookup, which is the
 * correct ordering for a reason beyond cost — there is no key to look it up by.
 */
export async function runSubmissionGuards(
  input: SubmissionGuardInput,
  deps: SubmissionGuardDeps,
): Promise<SubmissionCheck> {
  const normalized = normalizeSubmissionUrl(input.draft.url);
  if (!normalized.ok) {
    return { status: 'rejected', rejection: normalized.rejection };
  }

  // Keyed on the normalized URL and nothing else. The cap is per product.
  const existing = await deps.listings.findByNormalizedUrl(normalized.normalizedUrl);

  return await checkSubmission({
    draft: input.draft,
    existing,
    now: input.now,
    accountId: input.accountId,
    classifier: deps.classifier ?? seededCategoryClassifier,
    candidateCategories: await deps.candidateCategories(),
    ...(deps.schedule === undefined ? {} : { schedule: deps.schedule }),
  });
}

/**
 * The rejection, as one line for a log or a review-queue reason.
 *
 * The code is first so the queue can be grouped by it, and the message is kept
 * whole rather than re-worded: for `cycle_locked` that message IS the countdown
 * (`cycleLockedMessage` renders "in 4h 30m" from the same arithmetic the client
 * used), and a summariser that dropped it would leave support guessing at when.
 */
export function rejectionSummary(rejection: SubmissionRejection): string {
  return `${rejection.code}: ${rejection.message}`;
}

/**
 * When the product may be pitched again, for a rejection that has an answer.
 *
 * `brief §2.4` is specific that the cap is expressed as a countdown to the next
 * rebuild and not as an arbitrary limit — "a user who is told when they may pitch
 * again has been told something true about how the board works; a user who is
 * told 'limit reached' has been told they are being rationed". This is the value
 * the page renders next to the sentence.
 */
export function nextRebuildFor(
  rejection: SubmissionRejection,
  now: Date,
  schedule: RecalibrationSchedule = NIGHTLY_REBUILD,
): { readonly at: Date; readonly humanized: string } | null {
  if (rejection.code !== 'cycle_locked') return null;
  const countdown = countdownTo(cycleAt(now, schedule), now);
  return { at: countdown.nextRebuildAt, humanized: countdown.humanized };
}
