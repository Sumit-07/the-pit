/**
 * Opening a checkout, and what the success redirect is allowed to do.
 *
 * ## Guest checkout
 *
 * `brief §2.1`: no login at submission, nothing between a visitor and their
 * purchase. So `createCheckoutSession` takes no account id and no session — it
 * cannot, because at this point in the flow there is no account. Dodo collects
 * and verifies the email as part of taking the payment, and `brief §2.1` turns
 * that email into an account server-side on the webhook. That is the whole
 * identity system: no GitHub, no Google, no guest-payment claiming flow.
 *
 * ## The clearance argument
 *
 * A `SubmissionClearance` is the only way in, and it can only be produced by an
 * accepted `checkSubmission`. `DECISIONS.md` S12 requires the category check to
 * run "BEFORE payment so nobody pays for a rejection"; making that ordering a
 * function signature rather than a comment means a later refactor that moves the
 * check will not compile.
 *
 * ## The success redirect grants nothing
 *
 * `brief §2.2`: attempts are granted on the signed webhook, never on the success
 * redirect. The redirect is a URL the buyer's browser lands on; its query string
 * is whatever the buyer's browser was told to send, and a redirect that granted
 * attempts would be a free-attempts endpoint with the parameters written on the
 * outside. `resolveSuccessRedirect` therefore takes no store, no ledger and no
 * transport — it is a pure function from query parameters to something to
 * render, and it could not grant an attempt if someone asked it to.
 */

import type { PriceTier } from '../money.js';
import type { SubmissionClearance } from '../submission/guards.js';
import { sha256Hex } from '../hash.js';
import type { DodoCheckoutSession, DodoConfig, DodoTransport } from './types.js';

/** Raised when the Dodo configuration cannot express what we are trying to sell. */
export class CheckoutConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckoutConfigError';
  }
}

export interface CreateCheckoutInput {
  readonly clearance: SubmissionClearance;
  readonly tier: PriceTier;
  readonly config: DodoConfig;
  readonly transport: DodoTransport;
  /**
   * The id of the persisted pending submission.
   *
   * The draft has to survive the round trip through Dodo, and Dodo metadata is
   * a small string map — a 300-character description does not reliably fit and
   * has no business travelling through a third party and back as authoritative
   * input. So the draft is written to our own storage before checkout opens and
   * only its id crosses. The webhook reads the row back and re-runs
   * `checkSubmission` against it before enqueueing.
   */
  readonly submissionId: string;
  /**
   * The signature that lets the buyer open this submission's status page.
   *
   * Minted by the caller, beside the `submissions` row and before this call —
   * see `@the-pit/auth`'s `mintRunStatusToken`. It is carried on the return URL
   * and nowhere else, because this is the last moment at which we know the person
   * holding it is the person who typed the submission: after this, the only thing
   * coming back is a browser with a query string on it.
   *
   * Optional. Without one the return URL still names the submission and the
   * success page still hands over the account link; only the status page is out
   * of reach, which is the right failure for a deployment with no signing secret.
   */
  readonly statusToken?: string;
  /**
   * Required to open a LIVE checkout. Phase 3 ships against Dodo test mode; this
   * flag exists so that going live is one greppable, deliberate edit rather than
   * an environment variable nobody reviewed.
   */
  readonly acknowledgeLiveMode?: boolean;
}

export interface CheckoutResult {
  readonly session: DodoCheckoutSession;
  readonly idempotencyKey: string;
}

/**
 * The key that makes a double-clicked pay button open one session.
 *
 * Derived from what is being bought — this product, this text, this cycle, this
 * tier — so it is stable across a reload and distinct across a genuine second
 * purchase. It is not the job idempotency key: that one includes the account,
 * which does not exist yet.
 */
export function checkoutIdempotencyKey(clearance: SubmissionClearance, tier: PriceTier): string {
  return sha256Hex(
    ['checkout:v1', clearance.normalizedUrl, clearance.descriptionHash, clearance.cycle.id, tier.id].join(' '),
  );
}

function productIdFor(config: DodoConfig, tier: PriceTier): string {
  const match = Object.entries(config.productIds).find(([, tierId]) => tierId === tier.id);
  if (match === undefined) {
    throw new CheckoutConfigError(
      `no Dodo product id is mapped to the '${tier.id}' tier; set it in DodoConfig.productIds`,
    );
  }
  return match[0];
}

/** Open a guest checkout for one tier. Performs no I/O of its own. */
export async function createCheckoutSession(input: CreateCheckoutInput): Promise<CheckoutResult> {
  if (input.config.mode === 'live' && input.acknowledgeLiveMode !== true) {
    throw new CheckoutConfigError(
      'refusing to open a live-mode checkout without acknowledgeLiveMode; Phase 3 runs against Dodo test mode',
    );
  }

  const idempotencyKey = checkoutIdempotencyKey(input.clearance, input.tier);
  const session = await input.transport.createCheckoutSession({
    productId: productIdFor(input.config, input.tier),
    quantity: 1,
    returnUrl: successReturnUrl(input.config.returnUrl, input.submissionId, input.statusToken),
    idempotencyKey,
    metadata: {
      submission_id: input.submissionId,
      normalized_url: input.clearance.normalizedUrl,
      description_hash: input.clearance.descriptionHash,
      cycle_id: input.clearance.cycle.id,
      category: input.clearance.draft.categorySlug,
      attempt_number: String(input.clearance.attemptNumber),
    },
  });

  return { session, idempotencyKey };
}

/**
 * Where the buyer's run is watched. One definition, three callers.
 *
 * The checkout writes it into the return URL, the success page links forward to
 * it, and the status route parses what comes back. A second spelling of this
 * path anywhere would be a customer landing on a 404 holding a valid token.
 */
export function runStatusPath(submissionId: string, statusToken?: string): string {
  const path = `/status/s/${encodeURIComponent(submissionId)}`;
  return statusToken === undefined || statusToken === ''
    ? path
    : `${path}?t=${encodeURIComponent(statusToken)}`;
}

/**
 * The return URL Dodo sends the buyer back to, with this submission named on it.
 *
 * Dodo appends its own `payment_id`; these two are ours. The submission id is
 * what turns "payment received" into "here is your run", and the token is the
 * only thing that makes that link openable — see `CreateCheckoutInput.statusToken`.
 *
 * Built with `URL` rather than string concatenation because `DodoConfig.returnUrl`
 * is configuration and may already carry a query string.
 */
export function successReturnUrl(returnUrl: string, submissionId: string, statusToken?: string): string {
  const url = new URL(returnUrl);
  url.searchParams.set('submission_id', submissionId);
  if (statusToken !== undefined && statusToken !== '') url.searchParams.set('t', statusToken);
  return url.toString();
}

/**
 * What to render when the buyer comes back from Dodo.
 *
 * "Provisioning", always — never "here are your attempts". The webhook may not
 * have arrived yet, and the page must be honest about that rather than reading a
 * balance the redirect has no business knowing. The status page polls; `brief`
 * Part 6 already requires it to be resumable, so this is one more state it
 * already handles.
 */
export interface SuccessRedirectView {
  readonly status: 'provisioning';
  readonly submissionId: string | null;
  readonly message: string;
  /** Always 0. The redirect does not know the balance and must not imply that it does. */
  readonly attemptsGranted: 0;
  /**
   * Where to send the buyer next, token and all, or `null` when the query names
   * no submission.
   *
   * Derived and not granted. This is a string the caller may put in an `href`;
   * whether it opens anything is decided by the status route, which verifies the
   * signature against the server's own keyring.
   */
  readonly statusPath: string | null;
}

export function resolveSuccessRedirect(query: Readonly<Record<string, string | undefined>>): SuccessRedirectView {
  const submissionId = query['submission_id'] ?? null;
  return {
    status: 'provisioning',
    submissionId,
    message: 'Payment received. Your run starts the moment the payment settles — this page updates itself.',
    attemptsGranted: 0,
    statusPath: submissionId === null || submissionId === '' ? null : runStatusPath(submissionId, query['t']),
  };
}
