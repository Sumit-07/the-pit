/**
 * The submission guards — everything that must be true before a visitor is
 * asked for money, and again before a run is enqueued.
 *
 * ## Two checks, one rule set
 *
 * `brief §2.4` requires the cap to be checked "before payment (client, fast
 * feedback) AND before enqueue (server, authoritative)". Those are two different
 * places with two different capabilities: the browser has no database and no
 * model, the server has both. Duplicating the rules across them is how the two
 * drift apart until the client says yes and the server says no, which is the
 * worst possible ordering.
 *
 * So the rules live once. `checkSubmissionLocal` is synchronous and pure and
 * runs anywhere — it is the client-side check, given whatever the page already
 * knows. `checkSubmission` runs the same function and then adds the one rule
 * that needs a model: the category classifier. The server calls the second; the
 * client calls the first; there is exactly one copy of the cycle arithmetic.
 *
 * ## Ordering is a cost decision and a courtesy
 *
 * Cheap and local first (URL, length, cycle, material change), model call last.
 * A submission that is going to be rejected for pitching twice tonight should
 * not cost a classifier call, and a submitter who has made three mistakes should
 * be told about the free ones first.
 *
 * The whole sequence runs BEFORE checkout — `DECISIONS.md` S12's "so nobody pays
 * for a rejection" — and the type system carries that: `SubmissionClearance` is
 * branded and can only be produced by an accepted check, and
 * `createCheckoutSession` will not open a checkout without one.
 *
 * ## The cap key is handed in, not derived here
 *
 * `brief §2.5`'s last rule — resolve link shorteners to their target and store
 * that — needs a network, and nothing in this package performs I/O. So the
 * resolution happens in the caller (`@the-pit/fetch`'s `resolveProductUrl`,
 * reached through `apps/web/src/lib/ingest/product-url.ts`) and the resolved key
 * arrives here as `LocalCheckInput.resolvedUrl`.
 *
 * It has to arrive that way rather than being re-derived, and that is the whole
 * point of the field. `normalizeSubmissionUrl` is the OFFLINE key: exactly right
 * for the browser's fast feedback on a typo, and wrong as the cap key the moment
 * a shortener is involved. If this function re-normalized `draft.url` while the
 * caller looked the listing up under the resolved target, the guard would consult
 * one identity and the clearance — and with it the Dodo metadata, the job
 * idempotency key and `products.normalized_url` — would record another. A system
 * that disagrees with itself about which product this is would be worse than one
 * that is merely evadable, so there is exactly one key and it is computed once,
 * upstream of the listing lookup, because the listing is an input to this check.
 *
 * `urlFlags` rides along with it. `brief §2.5` says evasion via a genuinely
 * different URL is flagged for review and not hard-blocked, so `url_redirected`
 * (the submitted URL pointed at another host, and that host's key was adopted)
 * and `url_unresolved` (the site could not be reached, so the offline key was
 * used) land on the clearance's existing review flags rather than in a rejection.
 * A refusal that IS a rejection — a private address, a scheme that is not
 * http(s), a shortener that cannot be followed — arrives as `url_unfetchable`
 * from the caller and never reaches this function.
 *
 * ## What this deliberately does not do
 *
 * It does not hard-block a URL that merely resembles another
 * (`example.com` vs `example.io`). `brief §2.5` is explicit: flag for review, do
 * not hard-block, because a false rejection on a paying customer is worse than
 * an extra run.
 */

import { normalizeUrl, SANITIZE_LIMIT } from '@the-pit/engine';

import { descriptionHash as hashDescription } from '../hash.js';
import type { CategoryClassifier, CategoryVerdict } from './category.js';
import { CATEGORY_MISMATCH_BLOCK_CONFIDENCE, decideCategory } from './category.js';
import type { RecalibrationCycle, RecalibrationSchedule } from './cycle.js';
import { countdownTo, cycleAt, cycleLockedMessage, NIGHTLY_REBUILD } from './cycle.js';
import type { MaterialChangeResult, MaterialChangeThresholds } from './material-change.js';
import { materialChange, normalizeDescription } from './material-change.js';

/** What a visitor typed. `brief §2.1`: URL, name, description — and nothing else. */
export interface SubmissionDraft {
  readonly url: string;
  readonly name: string;
  readonly description: string;
  readonly categorySlug: string;
}

/**
 * The current state of whatever is already on the board at this normalized URL.
 *
 * `accountId` is nullable because seeded listings are unclaimed (`brief` Part 7:
 * "mark clearly as unclaimed, offer one-click opt-out"), and a paid submission
 * for a seeded product claims it rather than colliding with it.
 *
 * `description` is stored in full, not only as a hash, because
 * `materialChange` needs the tokens. That is a real requirement on the schema:
 * a listing row that keeps only `description_hash` cannot answer "is this
 * materially different", only "is this identical", and identical-only is the
 * check that a one-word edit walks straight through.
 */
export interface ListingSnapshot {
  readonly listingId: string;
  readonly accountId: string | null;
  readonly normalizedUrl: string;
  readonly categorySlug: string;
  readonly description: string;
  readonly descriptionHash: string;
  /**
   * How many paid pitches this product has had. `0` on a seeded listing, which
   * has never been pitched by anybody. `brief §2.4`: shown publicly as "3rd
   * pitch", so it counts pitches and not runs — a free retry does not advance it.
   */
  readonly attemptNumber: number;
  /**
   * When the most recent PAID pitch was accepted, or `null` if there has never
   * been one.
   *
   * Null is what a seeded listing looks like, and it is why the type is nullable
   * rather than carrying the seeding date. Both rules below — the cycle lock and
   * the materially-changed-text requirement — are rules about RE-pitching
   * (`brief §2.4`), and a founder claiming their own seeded row is making a
   * first pitch. Using the seed date here would cycle-lock a product nobody had
   * ever pitched, and comparing against seed text would reject a founder for
   * being too close to a description `DECISIONS.md` S4-source records that
   * outbid wrote about them.
   */
  readonly lastPitchedAt: Date | null;
  readonly clusterId: string | null;
  readonly currentVerdictId: string | null;
}

export type SubmissionRejection =
  | { readonly code: 'invalid_url'; readonly message: string }
  /**
   * The URL parses but could not be dereferenced, and falling back to its own
   * spelling as the cap key is not safe.
   *
   * Two disjoint causes, both of which mean "this is not a product website":
   * a SECURITY refusal (a private or link-local address, a scheme or port that
   * is not a website, a redirect loop) under any host; or a KNOWN SHORTENER that
   * could not be followed, where accepting `bit.ly/x` as its own key because
   * bit.ly was slow is the evasion route reopening itself.
   *
   * An ordinary site that is merely unreachable is NOT this. It falls back to
   * the offline key and raises `url_unresolved` on the clearance flags, because
   * `brief §2.5` is explicit that a false rejection on a paying customer is
   * worse than an extra run.
   */
  | { readonly code: 'url_unfetchable'; readonly message: string; readonly reason: string }
  | { readonly code: 'name_empty'; readonly message: string }
  | { readonly code: 'description_empty'; readonly message: string }
  | { readonly code: 'description_too_long'; readonly message: string; readonly limit: number }
  | {
      readonly code: 'cycle_locked';
      readonly message: string;
      readonly nextRebuildAt: Date;
      readonly secondsRemaining: number;
    }
  | {
      readonly code: 'description_unchanged';
      readonly message: string;
      readonly similarity: number;
      readonly tokenDelta: number;
    }
  | {
      readonly code: 'category_mismatch';
      readonly message: string;
      readonly suggested: string;
      readonly verdict: CategoryVerdict;
    }
  | {
      readonly code: 'ownership_conflict';
      readonly message: string;
      readonly listingId: string;
    };

declare const clearanceBrand: unique symbol;

/**
 * Proof that a submission passed every pre-payment guard.
 *
 * Branded, and the brand is a module-private symbol, so this interface cannot be
 * written out by hand anywhere in the codebase — the only way to hold one is to
 * have run `checkSubmission` and got an `accepted` result. `createCheckoutSession`
 * requires one, which is how "checked before payment" stops being an ordering
 * convention that a refactor can reverse.
 */
export interface SubmissionClearance {
  readonly [clearanceBrand]: true;
  readonly draft: SubmissionDraft;
  /**
   * The cap key: `LocalCheckInput.resolvedUrl` when the caller resolved one, the
   * offline key otherwise. Everything downstream reads it from HERE and never
   * re-derives it from `draft.url` — `createCheckoutSession`'s idempotency hash
   * and Dodo metadata, the `submissions` row, `jobIdempotencyKey`, and the
   * `products.normalized_url` the placement writes.
   */
  readonly normalizedUrl: string;
  readonly descriptionHash: string;
  readonly cycle: RecalibrationCycle;
  readonly checkedAt: Date;
  /** The listing this pitch replaces, or `null` for a product's first pitch. */
  readonly repitchOf: string | null;
  /** Which pitch this will be, 1-based. `brief §2.4`. */
  readonly attemptNumber: number;
  /** Non-blocking observations for the review queue (`brief §2.5`, `DECISIONS.md` S12). */
  readonly flags: readonly string[];
}

/**
 * The only place a `SubmissionClearance` is minted.
 *
 * The brand exists solely at the type level, so producing one requires an
 * assertion somewhere; confining that assertion to a single private function
 * means the guarantee is "one line in this file" rather than "nobody wrote
 * `as SubmissionClearance` anywhere in the app". `Omit` over the brand key is
 * what makes the argument still fully type-checked.
 */
function mintClearance(fields: Omit<SubmissionClearance, typeof clearanceBrand>): SubmissionClearance {
  return fields as SubmissionClearance;
}

export type SubmissionCheck =
  | { readonly status: 'accepted'; readonly clearance: SubmissionClearance }
  | { readonly status: 'rejected'; readonly rejection: SubmissionRejection };

export interface LocalCheckInput {
  readonly draft: SubmissionDraft;
  /**
   * The listing at this draft's cap key, or `null`.
   *
   * The caller looks it up, which means the caller has already computed the key.
   * `resolvedUrl` is how it says which key it used, and passing the listing
   * without the key it was found under is the bug this field exists to make
   * impossible to write by accident.
   */
  readonly existing: ListingSnapshot | null;
  /**
   * The cap key, already resolved — `resolveProductUrl`'s `normalizedUrl`, which
   * is the SUBMITTED URL's target when it points at another host.
   *
   * Omitted only by a caller that has no network: the browser's fast-feedback
   * check, and the tests of rules that have nothing to do with the URL. When it
   * is omitted the offline key is used, which is right for a typo check and
   * wrong for the cap — see the module header. Whatever value ends up here is the
   * one the clearance carries, so it is also the one the Dodo metadata, the job
   * idempotency key and `products.normalized_url` will carry.
   */
  readonly resolvedUrl?: string;
  /**
   * Non-blocking observations from that resolution — `url_redirected`,
   * `url_unresolved`. Appended to the clearance's flags, per `brief §2.5`'s
   * "flag for review, do not hard-block".
   */
  readonly urlFlags?: readonly string[];
  readonly now: Date;
  /**
   * Who is submitting, when we know. `null` before payment — `brief §2.1` is
   * guest checkout, so at the pre-payment check there is no identity at all and
   * the ownership rule cannot be evaluated. The server passes the account id
   * resolved from the Dodo webhook email at the pre-enqueue check.
   */
  readonly accountId?: string | null;
  readonly schedule?: RecalibrationSchedule;
  readonly materialChangeThresholds?: MaterialChangeThresholds;
}

export interface CheckInput extends LocalCheckInput {
  readonly classifier: CategoryClassifier;
  readonly candidateCategories: readonly string[];
  readonly categoryBlockConfidence?: number;
}

export type NormalizeResult =
  | { readonly ok: true; readonly normalizedUrl: string }
  | { readonly ok: false; readonly rejection: SubmissionRejection };

/**
 * `normalizeUrl` from the engine, with its throw turned into a rejection.
 *
 * The engine throws because an unparseable URL in the seed workbook is a defect
 * that should stop an ingest. A visitor typing `htp://` is not a defect, it is a
 * typo, and it gets a message. The normalization RULES are not reimplemented
 * here — that is `packages/engine/src/ingest/normalize-url.ts`, and it is the
 * same function the seed data was keyed with, which is the only reason a paid
 * submission and a seeded row can be recognised as the same product.
 */
/**
 * What a resolution produced: the key to enforce the cap on, and whatever the
 * review queue should know about how it was arrived at.
 */
export interface ResolvedSubmissionUrl {
  readonly normalizedUrl: string;
  readonly flags: readonly string[];
}

export type SubmissionUrlResolution =
  | { readonly ok: true; readonly resolved: ResolvedSubmissionUrl }
  | { readonly ok: false; readonly rejection: SubmissionRejection };

/**
 * The seam the network hangs off.
 *
 * Declared here and implemented in `apps/web` (over `@the-pit/fetch`) so this
 * package keeps performing no I/O while the RULE — which refusals reject and
 * which merely flag — stays next to the rules it belongs with. A test supplies a
 * function over a `Map` and never opens a socket.
 */
export type SubmissionUrlResolver = (url: string) => Promise<SubmissionUrlResolution>;

export function normalizeSubmissionUrl(url: string): NormalizeResult {
  try {
    return { ok: true, normalizedUrl: normalizeUrl(url) };
  } catch {
    return {
      ok: false,
      rejection: {
        code: 'invalid_url',
        message: "That does not look like a web address. Paste the product's URL, including the domain.",
      },
    };
  }
}

function rejected(rejection: SubmissionRejection): SubmissionCheck {
  return { status: 'rejected', rejection };
}

/**
 * Every rule that needs neither a database round trip nor a model call.
 *
 * Safe to run in the browser. Given `existing: null` — which is all a cold page
 * load knows — it still catches an invalid URL, an empty name, and an
 * over-length description, which is most of what fast feedback is for. Given a
 * listing fetched by the page, it also catches the cycle lock and the unchanged
 * description, with the same arithmetic the server will use.
 */
export function checkSubmissionLocal(input: LocalCheckInput): SubmissionCheck {
  const { draft } = input;

  // The typo gate runs on what was typed, for every caller: a resolver is not
  // required to have been consulted, and "that is not a web address" is the
  // sentence a browser check exists to produce.
  const normalized = normalizeSubmissionUrl(draft.url);
  if (!normalized.ok) {
    return rejected(normalized.rejection);
  }

  // The KEY, though, is the caller's resolved one whenever there is one. This
  // single line is why the clearance, the checkout metadata, the job idempotency
  // key and `products.normalized_url` all name the same product as the listing
  // lookup did. Re-deriving it here is the partial wiring the header warns about.
  const capKey = input.resolvedUrl !== undefined && input.resolvedUrl !== '' ? input.resolvedUrl : normalized.normalizedUrl;

  if (draft.name.trim() === '') {
    return rejected({ code: 'name_empty', message: 'Give the product a name.' });
  }

  const description = draft.description.trim();
  if (description === '') {
    return rejected({ code: 'description_empty', message: 'Say what it does. One or two sentences.' });
  }
  if (description.length > SANITIZE_LIMIT) {
    return rejected({
      code: 'description_too_long',
      message: `Keep it under ${SANITIZE_LIMIT} characters.`,
      limit: SANITIZE_LIMIT,
    });
  }

  const schedule = input.schedule ?? NIGHTLY_REBUILD;
  const cycle = cycleAt(input.now, schedule);
  const existing = input.existing;
  const flags: string[] = [...(input.urlFlags ?? [])];

  if (existing !== null) {
    const accountId = input.accountId ?? null;
    if (accountId !== null && existing.accountId !== null && existing.accountId !== accountId) {
      // Not a hard failure of the run — it is a claim dispute, and `brief §2.5`
      // says a false rejection on a paying customer is worse than an extra run.
      // Held for a human; no attempt is consumed because nothing is delivered.
      return rejected({
        code: 'ownership_conflict',
        message:
          'This product is already listed under another account. We have held your submission for review rather than replacing someone else’s listing.',
        listingId: existing.listingId,
      });
    }
    if (existing.accountId === null) {
      flags.push('claims_seeded_listing');
    }

    if (existing.lastPitchedAt !== null) {
      // `brief §2.4`: one pitch per product per recalibration cycle. Keyed on
      // the normalized URL that found this listing, so it is per product;
      // nothing here reads the account.
      if (existing.lastPitchedAt.getTime() >= cycle.startedAt.getTime()) {
        const countdown = countdownTo(cycle, input.now);
        return rejected({
          code: 'cycle_locked',
          message: cycleLockedMessage(cycle, input.now, schedule),
          nextRebuildAt: countdown.nextRebuildAt,
          secondsRemaining: countdown.secondsRemaining,
        });
      }

      const change: MaterialChangeResult = materialChange(
        existing.description,
        description,
        input.materialChangeThresholds ?? {},
      );
      if (!change.material) {
        return rejected({
          code: 'description_unchanged',
          message: change.identical
            ? 'This is the same pitch. A new attempt replaces your listing, so it needs a genuinely different description — rerunning the same words is not a re-pitch.'
            : 'That is a small edit rather than a new pitch. Rewrite what the product claims, not just a word or two.',
          similarity: change.similarity,
          tokenDelta: change.tokenDelta,
        });
      }
    }
  }

  return {
    status: 'accepted',
    clearance: mintClearance({
      draft: { ...draft, description },
      normalizedUrl: capKey,
      descriptionHash: hashDescription(description, normalizeDescription),
      cycle,
      checkedAt: input.now,
      repitchOf: existing === null ? null : existing.listingId,
      attemptNumber: existing === null ? 1 : existing.attemptNumber + 1,
      flags,
    }),
  };
}

/**
 * The authoritative check: the local rules, then the category classifier.
 *
 * Runs before checkout and again before enqueue. Running it twice is not
 * redundant — the board moves between them (a nightly rebuild may have closed
 * the cycle, another pitch may have landed), and the second run is the one whose
 * answer is binding.
 */
export async function checkSubmission(input: CheckInput): Promise<SubmissionCheck> {
  const local = checkSubmissionLocal(input);
  if (local.status === 'rejected') {
    return local;
  }

  const verdict = await input.classifier.classify({
    name: input.draft.name,
    description: local.clearance.draft.description,
    chosenCategory: input.draft.categorySlug,
    candidateCategories: input.candidateCategories,
  });

  const decision = decideCategory(
    verdict,
    input.draft.categorySlug,
    input.categoryBlockConfidence ?? CATEGORY_MISMATCH_BLOCK_CONFIDENCE,
  );

  if (decision.action === 'block') {
    return rejected({
      code: 'category_mismatch',
      message: decision.message,
      suggested: decision.suggested,
      verdict,
    });
  }

  const flags = decision.flagForReview
    ? [...local.clearance.flags, `category_${verdict.verdict}`]
    : local.clearance.flags;

  return {
    status: 'accepted',
    clearance: { ...local.clearance, flags },
  };
}
