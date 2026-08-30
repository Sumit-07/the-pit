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
 * ## One key, computed once, used everywhere
 *
 * This module owns the cap key, because it owns the listing lookup and the key
 * is what the lookup takes.
 *
 * `deps.resolveUrl` produces it: `@the-pit/fetch`'s `resolveProductUrl`, reached
 * through `lib/ingest/product-url.ts`, following the submitted URL to its
 * destination and adopting that destination when it lands on another host
 * (`brief §2.5`'s last rule). The offline `normalizeUrl` runs inside that — it is
 * the same function the seed workbook was keyed with, which is the only reason a
 * paid submission and a seeded row can be recognised as the same product.
 *
 * The key is then handed to `checkSubmission` as `resolvedUrl`, and that handoff
 * is the point of the design rather than a convenience. `checkSubmissionLocal`
 * used to re-normalize `draft.url` and mint the clearance from THAT string, so
 * resolving here alone would have looked right and been worse than doing
 * nothing: the listing would be found under `ledger.example/pricing` while the
 * clearance — and with it the Dodo metadata, the job idempotency key and the
 * eventual `products.normalized_url` — still said `bit.ly/x`. One identity
 * consulted, another recorded. Both sides landed together; `resolvedUrl` is the
 * wire between them, and `shortener-wiring.test.ts`'s assertion that all five
 * sites agree is the guard against it coming loose.
 *
 * `resolveUrl` is a REQUIRED dependency for the same reason. An optional one
 * defaulting to the real fetcher is a dependency a caller can forget, and a
 * caller who forgets it gets a submission path where the cap is one short link
 * from free — silently. Making it required means the compiler asks.
 *
 * The lookup is keyed on that URL and on nothing else — no account id is in the
 * query. `brief §2.4`'s cap is **per product, not per account**, so someone with
 * four side projects submits all four tonight and none of them sees the other.
 *
 * ## Resolution is a network call, and it is not a hard dependency of paying
 *
 * `lib/ingest/product-url.ts` holds the policy in full. In short: a SECURITY
 * refusal is a rejection, a known shortener that cannot be followed is a
 * rejection, and an ordinary site that is merely slow or down is NOT — it keys on
 * the offline URL and raises `url_unresolved` for review. `brief §2.5`: "a false
 * rejection on a paying customer is worse than an extra run."
 *
 * And AFTER the money moves the resolution does not run at all.
 * `enqueuePlacementForPayment` passes the key banked at checkout as
 * `input.resolvedUrl`, so the pre-enqueue re-check reads the board with the
 * identity the buyer paid under. That is the strongest form of the same policy:
 * once a payment has settled, no network condition can re-key the product or
 * block the run it bought. The re-check still re-runs every other guard, which is
 * what makes it authoritative.
 *
 * ## The cross-host rule, and the domain that genuinely moved
 *
 * Adopting a different destination host is what catches a shortener nobody has
 * heard of, and it costs one thing: a product whose site moves from `myapp.com`
 * to `myapp.dev` re-keys, so its history does not follow it. Weighed against
 * `brief §2.5` that is the right way round — a re-key buys the evader at most one
 * extra run, and the alternative leaves every self-hosted shortener open — so the
 * rule stays.
 *
 * But a re-key is observable, so it is not left silent. `url_redirected` reaches
 * the review queue, and when the resolved key finds NO listing the lookup is
 * retried under the SUBMITTED key below. That second lookup can only ever make
 * the cap stricter — it runs when the first found nothing, so there was no cap to
 * relax — and it is what lets a genuine domain move keep its attempt count and
 * its cycle lock.
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
  type SubmissionUrlResolver,
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
   * `brief §2.5`'s shortener resolution — the function that turns what a visitor
   * typed into the key the cap is enforced on.
   *
   * Required, and required on purpose. `resolveSubmissionUrl` in
   * `lib/ingest/product-url.ts` is the production one; a test supplies a function
   * over a `Map` and opens no socket. There is no default, because a default is
   * something a new call site can inherit without noticing, and the thing it
   * would inherit is the largest evasion route in the system.
   */
  readonly resolveUrl: SubmissionUrlResolver;
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
  /**
   * A cap key that was already resolved, so this run must not resolve again.
   *
   * Set by `enqueuePlacementForPayment` from the `submissions` row: the key the
   * buyer paid under. The pre-enqueue re-check is authoritative about the BOARD,
   * not about the product's identity — that was settled before the money moved,
   * and re-deriving it here would let a shortener being slow at settlement change
   * which product a paid run belongs to, or block it outright.
   */
  readonly resolvedUrl?: string;
}

/**
 * Run every guard, in the order `@the-pit/payments` puts them in: the URL, then
 * cheap and local, the classifier last.
 *
 * A URL that will not normalize never reaches the resolver or the listing lookup,
 * which is the correct ordering for a reason beyond cost — there is no key to
 * look it up by, and no point dereferencing a string that is not an address.
 */
export async function runSubmissionGuards(
  input: SubmissionGuardInput,
  deps: SubmissionGuardDeps,
): Promise<SubmissionCheck> {
  // The typo gate, offline and first. `checkSubmissionLocal` runs it again for
  // the callers that reach it directly; running it here as well is what keeps the
  // resolver from being handed `htp:/runlet`.
  const offline = normalizeSubmissionUrl(input.draft.url);
  if (!offline.ok) {
    return { status: 'rejected', rejection: offline.rejection };
  }

  const banked = input.resolvedUrl;
  let capKey: string;
  let urlFlags: readonly string[];

  if (banked !== undefined && banked !== '') {
    // Post-payment. The identity was decided before the buyer paid; see the
    // header. No network call happens on this path at all.
    capKey = banked;
    urlFlags = [];
  } else {
    const resolution = await deps.resolveUrl(input.draft.url);
    if (!resolution.ok) {
      return { status: 'rejected', rejection: resolution.rejection };
    }
    capKey = resolution.resolved.normalizedUrl;
    urlFlags = resolution.resolved.flags;
  }

  // Keyed on the resolved URL and nothing else. The cap is per product.
  let existing = await deps.listings.findByNormalizedUrl(capKey);

  // The domain that genuinely moved. When adopting a cross-host destination
  // found nothing, ask again under what was actually submitted: `myapp.com` may
  // still hold this product's history from before it started redirecting to
  // `myapp.dev`. This can only tighten the cap — it runs precisely when the first
  // lookup found nothing to enforce — so it cannot cause a false rejection that
  // adopting the destination had not already caused.
  if (existing === null && urlFlags.includes('url_redirected') && offline.normalizedUrl !== capKey) {
    existing = await deps.listings.findByNormalizedUrl(offline.normalizedUrl);
  }

  return await checkSubmission({
    draft: input.draft,
    existing,
    // The one key, handed down. Everything the clearance feeds — the checkout
    // metadata, `jobIdempotencyKey`, `products.normalized_url` — reads it from
    // there, so all four sites name the product this lookup just consulted.
    resolvedUrl: capKey,
    urlFlags,
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
