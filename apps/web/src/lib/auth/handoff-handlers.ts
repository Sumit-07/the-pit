/**
 * The success page — where the capability URL is actually handed over.
 *
 * This is the whole reason the capability path removes email from the critical
 * path: the customer is shown their account URL seconds after paying, on a page
 * they are certainly looking at, with nothing having had to be delivered.
 *
 * ## It grants nothing
 *
 * `brief §2.2`: "Grant attempts on the **signed webhook**, never on the success
 * redirect." Nothing here appends to the ledger, and nothing here creates an
 * account — the webhook did both before this page loaded. This is a READ of a
 * slug that already exists, and it does not even establish a session: following
 * the URL is what signs the customer in, through `/a/<slug>`, which has its own
 * rate limit and its own headers.
 *
 * Keeping those separate is what lets this page be screenshotted or refreshed
 * without anybody having been handed a session cookie.
 *
 * ## Why the page can be reached with no session and no login
 *
 * Because that is the point. The buyer paid as a guest — `brief §2.1`, nothing
 * between a visitor and their purchase — so at this instant they have no way to
 * prove who they are except the payment they just made. The payment id in the
 * return URL is that proof, and it is a weak one, which is why
 * `capabilityHandoff` bounds it by a thirty-minute window measured from the
 * order and by a per-IP rate limit. See `capability/handoff.ts`.
 */

import { capabilityHandoff, clientIp, type HandoffDeps } from '@the-pit/auth';
import { resolveSuccessRedirect } from '@the-pit/payments';

import { capabilityHandoffPage, capabilityUnavailablePage, capabilityRateLimitedPage } from '@/lib/auth/pages';

export interface HandoffHandlerDeps {
  readonly handoff: HandoffDeps;
  readonly origin: string;
  /** `dodo`. Named so a second processor cannot collide payment-id spaces. */
  readonly provider: string;
  readonly trustedProxyHops?: number;
}

/**
 * `no-referrer` above all: this page has the capability URL in its BODY, and it
 * is the one page in the product that does. Anything it loaded would otherwise
 * receive this page's own URL — which carries the payment id that reveals the
 * slug — in a `Referer` header.
 */
const HANDOFF_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store, no-cache, must-revalidate',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
};

function html(body: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { ...HANDOFF_HEADERS, 'content-type': 'text/html; charset=utf-8', ...extra },
  });
}

/**
 * `GET /checkout/success?payment_id=...`
 *
 * Dodo appends its own identifiers to the return URL. `payment_id` is the one
 * that maps onto `orders.provider_payment_id`, which `orders_payment_idx`
 * covers; `submission_id` and its signature are ours, written onto the return URL
 * at checkout, and `resolveSuccessRedirect` in `@the-pit/payments` turns them
 * into the path this page links forward to.
 *
 * The two are independent. The payment id decides whether an account link may be
 * shown; the submission id decides which run is watched. Neither is evidence for
 * the other, and one failing does not withhold the other.
 *
 * A 200 either way. The unavailable page is not an error — the payment worked,
 * the account exists, and the run is starting; the only thing that has expired
 * is our willingness to show a bearer URL to whoever holds a payment id.
 */
export async function handleCheckoutSuccess(request: Request, deps: HandoffHandlerDeps): Promise<Response> {
  const url = new URL(request.url);
  const ipOptions = deps.trustedProxyHops === undefined ? {} : { trustedProxyHops: deps.trustedProxyHops };

  /**
   * Where the run is watched. `resolveSuccessRedirect` reads `submission_id` and
   * the signature off the same query string the payment id arrived on, and it is
   * a pure function from that string to a path — it grants nothing and knows
   * nothing about a balance.
   *
   * This page LINKS forward rather than redirecting, and that is the whole reason
   * it still exists. The capability URL is a bearer credential and this is the
   * one page in the product that has it in the body; sending it onward as a query
   * parameter would put it in a `Referer`, in a history entry and in whatever
   * sits in front of the origin. So the account link is handed over here, under
   * `no-referrer`, and the status page is one press away.
   */
  const forward = resolveSuccessRedirect(Object.fromEntries(url.searchParams)).statusPath;

  const result = await capabilityHandoff(
    {
      provider: deps.provider,
      paymentId: url.searchParams.get('payment_id') ?? '',
      origin: deps.origin,
      ip: clientIp(request.headers, ipOptions),
      now: new Date(),
    },
    deps.handoff,
  );

  if (result.outcome === 'rate_limited') {
    return html(capabilityRateLimitedPage(), 429, { 'retry-after': String(result.retryAfterSeconds) });
  }
  if (result.outcome === 'unavailable') {
    return html(capabilityUnavailablePage(forward), 200);
  }

  return html(capabilityHandoffPage({ url: result.url, email: result.email, statusPath: forward }), 200);
}
