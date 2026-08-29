/**
 * `POST /api/webhooks/dodo` — the only endpoint in the product that can create an
 * account or an attempt.
 *
 * Same shape as `lib/auth/handlers.ts`: the route file is three lines, and
 * everything worth testing is a pure function of a `Request` and its
 * dependencies, testable with a hand-built `Request` and no server.
 *
 * ## This file decides almost nothing
 *
 * `handleDodoWebhook` in `@the-pit/payments` is the handler. It verifies the
 * signature before it parses, refuses an unverifiable body without side effects,
 * resolves the account from the email Dodo verified, appends the grant — which
 * no-ops on a replay — and records the event last, in that order, because that is
 * the only order in which a crash between two steps leaves a retry that reaches
 * the same end state. Its 146 tests are mutation-verified. Nothing here re-opens
 * any of it, and in particular nothing here re-checks the signature, re-reads the
 * amount, or turns a `needs_review` into a guess.
 *
 * What this file contributes is four things a package with no I/O cannot do:
 *
 * 1. **The raw body, as bytes.** `request.text()` and never `request.json()`.
 *    The signature covers the exact bytes Dodo sent; `JSON.parse` then
 *    `JSON.stringify` reorders keys and re-renders numbers, and a route that
 *    handed the handler a re-serialized object would fail every verification and
 *    the tempting fix would be to stop verifying.
 * 2. **The HTTP status.** Taken from `result.httpStatus` and never invented. 200
 *    tells Dodo to stop retrying, so a body we could not verify or parse gets
 *    400 and everything we understood — including an event we chose to ignore —
 *    gets 200.
 * 3. **The enqueue.** `brief §2.2` grants on the signed webhook; the run has to
 *    start from the same place, for the same reason.
 * 4. **A response that says nothing.** `{"status":"…"}` and no account id, no
 *    balance, no email. The reply goes to whoever posted the request, which
 *    before verification is anybody.
 *
 * ## The enqueue runs on `duplicate` too, deliberately
 *
 * The grant is idempotent and the enqueue is separately idempotent — that is what
 * `PlacementClaims` and `jobs_idempotency_key_uk` are for. So the failure this
 * ordering protects against is the interesting one: a delivery that granted and
 * then died before the event was sent. Dodo redelivers, the grant answers
 * `duplicate`, and if the enqueue were skipped on that arm the customer would
 * have an attempt and no run, permanently, with nothing in any log saying so.
 * Enqueueing on both arms costs one extra event and one claim lookup, and the
 * claim resolves it to the first placement's outcome without spending a model
 * call (`claims.ts`).
 *
 * ## The guards run again on this path, and that is the authoritative run
 *
 * `brief §2.4` wants the submission guards run twice — "before payment (client,
 * fast feedback) and before enqueue (server, authoritative)" — because the board
 * moves in between. The pre-payment half runs in `handleCheckoutCreate`; the
 * pre-enqueue half runs inside `enqueuePlacementForPayment`, before the event is
 * sent, so a submission that became cycle-locked or category-mismatched between
 * checkout and settlement is refused rather than placed. A refusal is not a
 * failure of this handler: the grant has already landed, the attempts are on the
 * balance unspent (`brief §2.3` consumes only on delivery), and the event goes to
 * the review queue where a person decides what the customer is owed.
 *
 * This is also the first point at which the OWNERSHIP rule can be evaluated at
 * all. Guest checkout means there is no identity until this webhook resolves one
 * from the address Dodo verified, so the conflict is a post-payment hold by
 * necessity rather than by choice — except for a submitter who was signed in when
 * they submitted, whose conflict was already refused before the charge.
 */

import {
  handleDodoWebhook,
  type AttemptsLedger,
  type DodoConfig,
  type DodoEvent,
  type WebhookStore,
} from '@the-pit/payments';

import { enqueuePlacementForPayment, type PlacementEnqueueDeps } from '@/lib/payments/enqueue';

export interface DodoWebhookDeps {
  readonly config: DodoConfig;
  /**
   * The ledger, built around the verified body.
   *
   * A function rather than a value because `orders.raw_event` is the payload a
   * $30 dispute is argued from (`brief §2.2`) and the store cannot be given it
   * until the request exists. Building it per request is also what keeps a
   * granting write from ever being made against a body that is not the one the
   * signature covered.
   */
  readonly ledgerFor: (rawBody: string) => AttemptsLedger;
  readonly store: WebhookStore;
  /**
   * Where a paid submission becomes a run. `null` in a deployment that has taken
   * the pipeline out of this process — the grant still lands, and the missing run
   * goes to the review queue rather than being lost.
   */
  readonly placement: PlacementEnqueueDeps | null;
}

/**
 * Nothing here is cached, indexed, or referred to by anything.
 *
 * `no-store` because the response is about one payment. `nosniff` because the
 * body is JSON and a browser that sniffed it as HTML would be rendering a string
 * that came out of a payload we may not have verified.
 */
const WEBHOOK_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store, no-cache, must-revalidate',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
  'content-type': 'application/json; charset=utf-8',
};

/** What the route answers with. Deliberately barren — see the module header. */
function json(body: { status: string }, status: number): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...WEBHOOK_HEADERS } });
}

export async function handleDodoWebhookRequest(
  request: Request,
  deps: DodoWebhookDeps,
): Promise<Response> {
  // Bytes in, exactly as sent. See the module header.
  const rawBody = await request.text();

  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const result = await handleDodoWebhook({
    rawBody,
    headers,
    config: deps.config,
    ledger: deps.ledgerFor(rawBody),
    store: deps.store,
    now: new Date(),
  });

  if (result.status === 'rejected') {
    // 400 so Dodo keeps retrying and the alarm fires. The reason is logged and
    // not returned: a body that failed verification came from someone we cannot
    // identify, and telling them WHICH check failed is free reconnaissance.
    console.warn(`[dodo] refused a webhook: ${result.reason}`);
    return json({ status: 'rejected' }, result.httpStatus);
  }

  if (result.status === 'granted' || result.status === 'duplicate') {
    await startTheRun(result.accountId, result.event, deps);
  }

  return json({ status: result.status }, result.httpStatus);
}

/**
 * Fire the placement, and put a payment that could not become one in front of a
 * human.
 *
 * Never throws. Every failure here happens after the money is recorded and the
 * attempts are on the balance, so the customer is not owed a retry of the
 * PAYMENT — they are owed a run, and the honest way to owe someone a run is a
 * queue entry with the event on it rather than a 500 that asks Dodo to redeliver
 * a charge we already have.
 */
async function startTheRun(accountId: string, event: DodoEvent, deps: DodoWebhookDeps): Promise<void> {
  if (deps.placement === null) {
    await park(event, 'no placement queue is bound in this deployment', deps);
    return;
  }

  try {
    const enqueued = await enqueuePlacementForPayment(
      // The address Dodo verified travels with the account id: `brief §2.1` has
      // no login at submission, so this is the only identity the paid listing can
      // carry, and `products_source_submitter` requires it on a paid row.
      { accountId, email: event.customerEmail, metadata: event.metadata },
      deps.placement,
    );
    if (!enqueued.enqueued) {
      await park(event, `placement not enqueued: ${enqueued.reason}`, deps);
    }
  } catch (error) {
    await park(event, `placement enqueue threw: ${message(error)}`, deps);
  }
}

/**
 * Put an event on the review queue.
 *
 * `queueForReview` writes onto the row `recordEvent` already created for this
 * event, so a redelivery that fails the same way overwrites the same reason
 * rather than filing a second ticket. It is wrapped because the review queue
 * failing is not a reason to fail the response: the grant has landed, and a 500
 * here would ask Dodo to redeliver a payment that already succeeded.
 */
async function park(event: DodoEvent, reason: string, deps: DodoWebhookDeps): Promise<void> {
  console.error(`[dodo] ${event.id}: ${reason}`);
  try {
    await deps.store.queueForReview({ eventId: event.id, reason, event });
  } catch (error) {
    console.error(`[dodo] ${event.id}: could not queue for review either: ${message(error)}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
