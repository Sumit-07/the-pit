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
 * ## What this deliberately does not do
 *
 * It does not resolve link shorteners. `brief §2.5` asks for it and
 * `packages/engine/src/ingest/normalize-url.ts` explains the deferral: it needs
 * an SSRF-guarded fetcher (redirect cap, timeout, private-address blocking) and
 * nothing here performs I/O. Until that lands, `bit.ly/x` and the URL it points
 * at are two different products to this code. That is an evasion route for the
 * per-product cap and it is open; see the Phase 3 report.
 *
 * It also does not hard-block a URL that merely resembles another
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
   * The listing at this draft's normalized URL, or `null`.
   *
   * The caller looks it up, which means the caller normalizes first —
   * `normalizeSubmissionUrl` exists for exactly that, and this function
   * re-normalizes rather than trusting the caller to have used it.
   */
  readonly existing: ListingSnapshot | null;
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

  const normalized = normalizeSubmissionUrl(draft.url);
  if (!normalized.ok) {
    return rejected(normalized.rejection);
  }

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
      message: `Keep it under ${SANITIZE_LIMIT} characters — everyone on the board gets the same room.`,
      limit: SANITIZE_LIMIT,
    });
  }

  const schedule = input.schedule ?? NIGHTLY_REBUILD;
  const cycle = cycleAt(input.now, schedule);
  const existing = input.existing;
  const flags: string[] = [];

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
      normalizedUrl: normalized.normalizedUrl,
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
