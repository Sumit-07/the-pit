/**
 * The success page's handover: turning "you just paid" into "here is your
 * account URL", while the buyer is still looking at the screen.
 *
 * This is the point of the whole capability path. `brief §2.2` is emphatic that
 * the success redirect grants nothing — attempts come from the signed webhook —
 * and this does not grant anything either. It is a READ: the webhook has already
 * created the account and minted its slug, and this shows the buyer the slug
 * that is already theirs.
 *
 * ## Why it is bounded by a clock as well as by a rate limit
 *
 * Dodo sends the buyer back with the payment's id in the query string. That id
 * is the only handle the returning browser has, so it is what the lookup keys
 * on — and it is a weak secret. It sits in the address bar, in our access logs,
 * in any analytics that records a landing URL, and in the browser history of a
 * shared machine. Treating it as a permanent key to a bearer URL would mean a
 * line in a log file is an account takeover.
 *
 * So the handover expires. `HANDOFF_WINDOW_MS` after the order was recorded, the
 * payment id stops revealing anything and the page says "check your email, or
 * ask for a sign-in link" instead. Thirty minutes is far longer than the gap
 * between paying and landing — which is a redirect, so it is seconds — and short
 * enough that a leaked log line is stale before anyone reads it.
 *
 * The window is measured from the ORDER's timestamp, not from the request, so
 * the clock cannot be restarted by asking again.
 *
 * ## What it never does
 *
 * It does not create an account, it does not grant an attempt, it does not
 * rotate the slug, and it does not establish a session. A buyer who has just
 * paid gets a URL to bookmark; following that URL is what signs them in, and
 * that path has its own rate limit and its own headers. Keeping the two separate
 * means the success page can be cached-busted, screenshotted or shared without
 * having handed anybody a session cookie.
 */

import { AUTH_RATE_LIMITS, bucketKey, type RateLimiter } from '../rate-limit.js';
import { capabilityUrl } from './slug.js';

/**
 * How long after the order a payment id still reveals the capability URL.
 *
 * See the header: the redirect happens in seconds, so this is slack for a slow
 * webhook, a buyer who opened the tab and got distracted, and a refresh.
 */
export const HANDOFF_WINDOW_MS = 30 * 60 * 1000;

/** What the store must be able to answer for the success page. */
export interface HandoffStore {
  /**
   * The account behind a payment, and its current slug — but only if the order
   * is younger than `windowMs`.
   *
   * The age check belongs in the query rather than in a caller's `if`: an
   * implementation that returned the row and left the comparison to TypeScript
   * would hand the whole answer to any caller who forgot, and the one that
   * forgets is the one written in a hurry against a support ticket.
   */
  findCapabilityByPayment(input: {
    readonly provider: string;
    readonly providerPaymentId: string;
    readonly now: Date;
    readonly windowMs: number;
  }): Promise<{ readonly accountId: string; readonly email: string; readonly slug: string } | null>;
}

export interface HandoffDeps {
  readonly store: HandoffStore;
  readonly limiter: RateLimiter;
  /** Overridable so a test can shorten or lengthen the window. */
  readonly windowMs?: number;
}

export interface HandoffInput {
  /** `dodo`. Named so a second processor cannot collide payment-id spaces. */
  readonly provider: string;
  /** Straight from the query string. Never trusted beyond a shape check. */
  readonly paymentId: string;
  readonly origin: string;
  readonly ip: string;
  readonly now: Date;
}

export type HandoffResult =
  | {
      readonly outcome: 'ready';
      readonly email: string;
      readonly slug: string;
      readonly url: string;
    }
  /**
   * No such payment, or the window closed. One outcome for both — telling a
   * caller which would confirm that a guessed payment id was real.
   */
  | { readonly outcome: 'unavailable' }
  | { readonly outcome: 'rate_limited'; readonly retryAfterSeconds: number };

/**
 * Provider payment ids are opaque strings. This rejects the ones that cannot be
 * one — empty, enormous, or carrying characters that have no business in an
 * identifier and every business in a log-injection attempt.
 */
const PAYMENT_ID_PATTERN = /^[A-Za-z0-9_.:-]{6,128}$/;

export async function capabilityHandoff(input: HandoffInput, deps: HandoffDeps): Promise<HandoffResult> {
  if (!PAYMENT_ID_PATTERN.test(input.paymentId)) {
    return { outcome: 'unavailable' };
  }

  const byIp = await deps.limiter.consume({
    key: bucketKey('auth:handoff:ip', input.ip),
    policy: AUTH_RATE_LIMITS.handoffPerIp,
    now: input.now,
  });
  if (!byIp.allowed) {
    return { outcome: 'rate_limited', retryAfterSeconds: byIp.retryAfterSeconds };
  }

  const found = await deps.store.findCapabilityByPayment({
    provider: input.provider,
    providerPaymentId: input.paymentId,
    now: input.now,
    windowMs: deps.windowMs ?? HANDOFF_WINDOW_MS,
  });
  if (found === null) {
    return { outcome: 'unavailable' };
  }

  return {
    outcome: 'ready',
    email: found.email,
    slug: found.slug,
    url: capabilityUrl(input.origin, found.slug),
  };
}
