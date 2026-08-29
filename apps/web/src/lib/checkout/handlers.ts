/**
 * `POST /api/checkout` — where a visitor becomes a buyer, and the only place a
 * `submissions` row is written.
 *
 * This is the half of the funnel the webhook has been waiting for. Every settled
 * payment before this route existed resolved an account, granted attempts
 * correctly, and then parked with *"the payment carries no submission_id"*,
 * because `pit/placement.requested` carries a `Product` — a name and a
 * 300-character description — and Dodo metadata is a small string map. The draft
 * has to be written to our own storage and only its id may cross a third party.
 * That is what this route does, in this order:
 *
 * ```
 * parse  ->  guards  ->  submissions row  ->  Dodo session  ->  303 to the payment link
 *            ^^^^^^
 *            everything below fails to happen when this refuses
 * ```
 *
 * ## The guards run FIRST, and the type system says so
 *
 * `createCheckoutSession` takes a `SubmissionClearance`, which is branded with a
 * module-private symbol in `@the-pit/payments` and can only be produced by an
 * accepted `checkSubmission`. There is no expression in this file that opens a
 * checkout without one, and there is no expression anywhere that fabricates one.
 * `DECISIONS.md` S12 made "before payment so nobody pays for a rejection" a
 * decision; the brand makes it a compile error to reverse.
 *
 * The ordering is also why the submissions row is written *after* the check and
 * not before. A row written first would let a cycle-locked submission leave a
 * trace that the pre-enqueue lookup then has to reason about, and — more
 * importantly — `listing-store.ts` deliberately does not key the cycle lock on
 * `submissions` at all, because a row written before payment would let anyone
 * lock a product out of tonight's board by opening a checkout and never paying.
 *
 * ## Guest checkout, and GitHub beside it
 *
 * `brief §2.1`: no login at submission. This handler reads a session if one
 * happens to be in the cookie jar and does absolutely nothing when there is not
 * one — no redirect, no 401, no prompt. The session is used for exactly one
 * thing: it supplies an `accountId` to the guards, which is what lets an
 * ownership conflict be caught *before* the charge for a signed-in submitter
 * instead of becoming a post-payment hold. That is a strictly better outcome for
 * someone who signed in, and it is the entire mechanism by which GitHub is "an
 * optional upgrade that may sit beside this flow" without ever gating it.
 *
 * A failure to read the session is not a failure to submit. If the keyring is
 * missing or the cookie is junk, the submission proceeds as a guest — which is
 * the same path the overwhelming majority of buyers take anyway.
 *
 * ## No attempt is granted, consumed, or looked at
 *
 * There is no ledger in `CheckoutHandlerDeps`. `brief §2.2` grants on the signed
 * webhook and `brief §2.3` consumes on delivery, and a checkout route holding an
 * `AttemptsLedger` would be a route that could do either. The absence of the
 * dependency is the guarantee; `test/checkout-route.test.ts` asserts it from the
 * outside as well, because a dependency can always be added back.
 */

import { readSession, type SessionKeyring } from '@the-pit/auth';
import { SANITIZE_LIMIT } from '@the-pit/engine';
import {
  createCheckoutSession,
  PRICE_TIERS,
  type DodoConfig,
  type DodoTransport,
  type PriceTier,
  type PriceTierId,
  type SubmissionClearance,
  type SubmissionDraft,
  type SubmissionRejection,
} from '@the-pit/payments';

import {
  nextRebuildFor,
  rejectionSummary,
  runSubmissionGuards,
  type SubmissionGuardDeps,
} from '@/lib/checkout/guards';
import {
  renderRejectionPage,
  renderSubmitPage,
  type SubmitFormValues,
  type SubmitPageView,
} from '@/lib/checkout/page';

/**
 * Where the draft is written. One method, and it is a WRITE.
 *
 * The mirror of `SubmissionLookup` in `lib/payments/enqueue.ts`, which has one
 * method and it is a read. Split deliberately: the webhook must not be able to
 * invent a submission, and this route has no business reading one back.
 */
export interface SubmissionWriter {
  create(draft: {
    readonly categorySlug: string;
    readonly name: string;
    readonly url: string;
    readonly normalizedUrl: string;
    readonly description: string;
    readonly descriptionHash: string;
    readonly cycleId: string;
    readonly tier: PriceTierId;
    readonly attemptNumber: number;
    readonly repitchOf: string | null;
    readonly now: Date;
  }): Promise<string>;
}

export interface CheckoutHandlerDeps {
  readonly config: DodoConfig;
  readonly transport: DodoTransport;
  readonly submissions: SubmissionWriter;
  readonly guards: SubmissionGuardDeps;
  /**
   * Optional, and optional in the strong sense: absent here means every visitor
   * is a guest, which is the flow `brief §2.1` specifies. Present, it upgrades a
   * signed-in submitter's ownership conflict from a post-payment hold to a
   * pre-payment refusal.
   */
  readonly keyring?: SessionKeyring;
  readonly secureCookies?: boolean;
  /** Injected so the cycle arithmetic is testable at a fixed instant. */
  readonly now?: () => Date;
}

/**
 * `no-store` on every response: one of them is a redirect to a payment link
 * carrying an idempotency key, and the others echo back text the visitor typed.
 * Neither belongs in a shared cache.
 */
const CHECKOUT_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store, no-cache, must-revalidate',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
};

function html(body: string, status: number): Response {
  return new Response(body, {
    status,
    headers: { ...CHECKOUT_HEADERS, 'content-type': 'text/html; charset=utf-8' },
  });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CHECKOUT_HEADERS, 'content-type': 'application/json; charset=utf-8' },
  });
}

/**
 * A form post gets a page; an API call gets JSON.
 *
 * Decided by what the caller sent and asked for, never by a query parameter — a
 * response format switch on the URL is a way to make a page render as text in
 * somebody else's frame.
 */
function wantsJson(request: Request): boolean {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) return true;
  const accept = request.headers.get('accept') ?? '';
  return accept.includes('application/json') && !accept.includes('text/html');
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** What the visitor sent, whatever shape they sent it in. */
async function readValues(request: Request): Promise<SubmitFormValues> {
  const contentType = request.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    const parsed: unknown = await request.json().catch(() => ({}));
    const body = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    return {
      url: str(body['url']),
      name: str(body['name']),
      description: str(body['description']),
      categorySlug: str(body['category'] ?? body['categorySlug']),
      tier: str(body['tier']) === '' ? 'single' : str(body['tier']),
    };
  }

  // `formData()` covers both `application/x-www-form-urlencoded` (what a plain
  // `<form method="post">` sends) and `multipart/form-data`.
  const form = await request.formData().catch(() => new FormData());
  const field = (key: string): string => str(form.get(key));
  const tier = field('tier');
  return {
    url: field('url'),
    name: field('name'),
    description: field('description'),
    categorySlug: field('category') === '' ? field('categorySlug') : field('category'),
    tier: tier === '' ? 'single' : tier,
  };
}

function tierFor(id: string): PriceTier | null {
  return PRICE_TIERS.find((tier) => tier.id === id) ?? null;
}

/**
 * The account id to check ownership against, or `null`.
 *
 * Never throws and never refuses. An unreadable cookie, a rotated keyring, a
 * deployment with no keyring at all — every one of them means "we do not know who
 * this is", which is the ordinary state of a guest checkout and not an error.
 */
function submitterAccountId(request: Request, deps: CheckoutHandlerDeps): string | null {
  if (deps.keyring === undefined) return null;
  try {
    const verified = readSession({
      cookieHeader: request.headers.get('cookie'),
      keyring: deps.keyring,
      now: new Date(),
      ...(deps.secureCookies === undefined ? {} : { secure: deps.secureCookies }),
    });
    return verified.valid ? verified.session.accountId : null;
  } catch {
    return null;
  }
}

async function pageView(
  deps: CheckoutHandlerDeps,
  values: SubmitFormValues,
  signedIn: boolean,
): Promise<SubmitPageView> {
  return {
    categories: await deps.guards.candidateCategories(),
    tiers: PRICE_TIERS,
    values,
    descriptionLimit: SANITIZE_LIMIT,
    signedIn,
  };
}

/** The refusal, in whichever register the caller asked for. */
function refuse(
  request: Request,
  rejection: SubmissionRejection,
  now: Date,
  form: SubmitPageView,
  schedule: SubmissionGuardDeps['schedule'],
): Response {
  const nextRebuild = nextRebuildFor(rejection, now, schedule);

  if (wantsJson(request)) {
    return json(
      {
        status: 'rejected',
        code: rejection.code,
        // The message carries the countdown for `cycle_locked`; see
        // `cycleLockedMessage`. It is passed through, never re-worded.
        message: rejection.message,
        ...(nextRebuild === null
          ? {}
          : { nextRebuildAt: nextRebuild.at.toISOString(), nextRebuildIn: nextRebuild.humanized }),
        charged: false,
      },
      422,
    );
  }

  return html(renderRejectionPage({ rejection, nextRebuild, form }), 422);
}

/** `GET /submit` — the form. Reachable by anybody, signed in or not. */
export async function handleSubmitPage(request: Request, deps: CheckoutHandlerDeps): Promise<Response> {
  const signedIn = submitterAccountId(request, deps) !== null;
  const view = await pageView(deps, emptyFormFrom(request), signedIn);
  return html(renderSubmitPage(view), 200);
}

/**
 * Prefill from the query string, so a "pitch this" link from a board can carry a
 * URL. Read as text and echoed through `escapeHtml`; it decides nothing.
 */
function emptyFormFrom(request: Request): SubmitFormValues {
  const params = new URL(request.url).searchParams;
  return {
    url: params.get('url') ?? '',
    name: params.get('name') ?? '',
    description: '',
    categorySlug: params.get('category') ?? '',
    tier: params.get('tier') === 'triple' ? 'triple' : 'single',
  };
}

export interface CheckoutCreated {
  readonly submissionId: string;
  readonly sessionId: string;
  readonly paymentLink: string;
  readonly idempotencyKey: string;
}

/**
 * `POST /api/checkout`.
 *
 * Answers 303 to Dodo's payment link for a form post — the buyer's browser
 * follows it and they are on Dodo's page — and 200 with the link for an API
 * caller. 303 specifically: the response to a POST is a resource to GET, and a
 * 302 leaves some clients re-POSTing the form to Dodo.
 */
export async function handleCheckoutCreate(request: Request, deps: CheckoutHandlerDeps): Promise<Response> {
  const now = (deps.now ?? (() => new Date()))();
  const values = await readValues(request);
  const accountId = submitterAccountId(request, deps);
  const form = await pageView(deps, values, accountId !== null);

  const tier = tierFor(values.tier);
  if (tier === null) {
    // Not a `SubmissionRejection` — the tier is ours, not theirs, and a value
    // outside the two `brief §2.3` closes the table at means the form was edited.
    return wantsJson(request)
      ? json({ status: 'rejected', code: 'unknown_tier', message: 'Pick $5 or $15.', charged: false }, 422)
      : html(renderSubmitPage(form), 422);
  }

  const draft: SubmissionDraft = {
    url: values.url,
    name: values.name,
    description: values.description,
    categorySlug: values.categorySlug,
  };

  // Everything after this line is conditional on the check passing. A rejection
  // returns here — before a `submissions` row, before a Dodo call, before any
  // money can move.
  const checked = await runSubmissionGuards({ draft, now, accountId }, deps.guards);
  if (checked.status === 'rejected') {
    console.info(`[checkout] refused before payment — ${rejectionSummary(checked.rejection)}`);
    return refuse(request, checked.rejection, now, form, deps.guards.schedule);
  }

  const clearance: SubmissionClearance = checked.clearance;

  // The row that survives the round trip through Dodo. Written from the
  // CLEARANCE, not from the raw form: the normalized URL, the description hash
  // and the cycle id are all derived values, and re-deriving them here would be a
  // second answer to what the submitter submitted.
  const submissionId = await deps.submissions.create({
    categorySlug: clearance.draft.categorySlug,
    name: clearance.draft.name,
    url: clearance.draft.url,
    normalizedUrl: clearance.normalizedUrl,
    description: clearance.draft.description,
    descriptionHash: clearance.descriptionHash,
    cycleId: clearance.cycle.id,
    tier: tier.id,
    attemptNumber: clearance.attemptNumber,
    repitchOf: clearance.repitchOf,
    now,
  });

  let created: CheckoutCreated;
  try {
    const result = await createCheckoutSession({
      clearance,
      tier,
      config: deps.config,
      transport: deps.transport,
      submissionId,
    });
    created = {
      submissionId,
      sessionId: result.session.sessionId,
      paymentLink: result.session.paymentLink,
      idempotencyKey: result.idempotencyKey,
    };
  } catch (error) {
    // The draft row survives; nothing found it, nothing will, and it costs a row.
    // Failing loudly here is right: no money has moved, so a 502 is honest and a
    // retry is safe.
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[checkout] could not open a Dodo session: ${reason}`);
    return wantsJson(request)
      ? json({ status: 'unavailable', message: 'Checkout is unavailable right now.', charged: false }, 502)
      : html(
          renderRejectionPage({
            rejection: {
              code: 'invalid_url',
              message:
                'We could not open a checkout just now. Nothing was charged — try again in a moment.',
            },
            nextRebuild: null,
            form,
          }),
          502,
        );
  }

  if (wantsJson(request)) {
    return json({ status: 'created', ...created }, 200);
  }

  return new Response(null, {
    status: 303,
    headers: { ...CHECKOUT_HEADERS, location: created.paymentLink },
  });
}
