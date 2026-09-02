/**
 * The free first throw: a form post that sends one email, and a confirm POST that
 * creates an account, grants one attempt, and starts the run.
 *
 * ```
 * POST /api/free      parse -> guards -> policy.check -> submissions row -> ONE email
 *                             ^^^^^^^^^^^^^^^^^^^^^^^
 *                             the same guards the paid path runs, in the same order
 *
 * GET  /free/confirm  a button. Nothing else. Ever.
 *
 * POST /free/confirm  token -> policy.check -> policy.record -> account -> grant
 *                                                                          |
 *                                       303 <- cookie <- enqueue <---------+
 * ```
 *
 * ## Why this is a second handler and not a branch in `handleCheckoutCreate`
 *
 * Everything before the money is identical and everything after it is not. The
 * paid path ends at a Dodo session and grants nothing; this one ends at a mailbox
 * and eventually grants an attempt. A single handler with a boolean would have
 * been a handler holding both an `AttemptsLedger` and a `DodoTransport`, and
 * `lib/checkout/handlers.ts` says at length why the checkout route holds no
 * ledger:
 *
 * > There is no ledger in `CheckoutHandlerDeps`. […] The absence of the
 * > dependency is the guarantee.
 *
 * That guarantee survives here. `CheckoutHandlerDeps` still has no ledger, and
 * `FreeRunCreateDeps` — the form half of THIS flow — has no ledger either. Only
 * `FreeRunConfirmDeps` does, and the only way into it is a valid signature over a
 * submission id and an address.
 *
 * ## The guards are not re-implemented, re-ordered or relaxed
 *
 * `runSubmissionGuards` with the same `SubmissionGuardDeps` the paid path uses:
 * the cycle lock, the material-change measure, the ownership rule, the category
 * classifier, in that order, with the classifier last so a submission that is
 * going to be refused for pitching twice tonight does not spend a model call.
 * `brief §2.4` does not say "unless it was free".
 *
 * ## One free run per product is a fact about the DATABASE
 *
 * The grant is an adjustment keyed `free:url:<normalized url>`, and
 * `attempts_idempotency_key_uk` is what refuses the second one. Not the policy
 * module, not a lookup in this file, and not an `if`. The consequence is that
 * this handler works correctly against the policy STUB — which says yes to
 * everything — because the axis that costs real money is closed by an index.
 *
 * A duplicate is not an error. It is either the same person pressing the button
 * twice (their run, their redirect, no second grant) or a second address reaching
 * for a throw that is gone (a refusal, and the $5 form). `grants.holderOf` is the
 * one lookup that separates those two, and `packages/db`'s
 * `createPostgresFreeRunGrants` says why guessing is not an option.
 *
 * ## `DECISIONS.md` S17 is unchanged, and enforced here rather than trusted
 *
 * Free runs publish under the product's name. `anonymous: false` is written from
 * a literal below — the posted byline is READ, so the form can echo it back, and
 * is never consulted on this path. An attacker editing the radio buys nothing,
 * and neither does an honest submitter who picked the robot and then pressed the
 * free button: the page says which button buys which byline, and the server does
 * not take the field's word for it either way.
 */

import {
  clientIp,
  freeRunConfirmUrl,
  freeRunIdempotencyKey,
  isPlausibleEmail,
  mintFreeRunToken,
  mintRunStatusToken,
  newSessionPayload,
  normalizeEmail,
  renderFreeRunEmail,
  serializeSessionCookie,
  signSessionCookie,
  verifyFreeRunToken,
  UNKNOWN_CLIENT_IP,
  type CreatedAccount,
  type MailTransport,
  type SessionKeyring,
} from '@the-pit/auth';
import { runStatusPath, type AttemptEntry, type AppendResult } from '@the-pit/payments';

import {
  readSubmissionValues,
  submitPageView,
  type SubmissionWriter,
} from '@/lib/checkout/handlers';
import {
  nextRebuildFor,
  rejectionSummary,
  runSubmissionGuards,
  type SubmissionGuardDeps,
} from '@/lib/checkout/guards';
import { renderRejectionPage, renderSubmitPage, type SubmitFormValues } from '@/lib/checkout/page';
import { PITCH_LIMIT, readPitch } from '@/lib/checkout/pitch';
import { freeConfirmButtonPage, freeConfirmRejectedPage, freeSentPage } from '@/lib/free/pages';
import type { FreeRunPolicy, FreeRunRefusal } from '@/lib/free/policy';
import { enqueuePlacementForPayment, type PlacementEnqueueDeps, type SubmissionLookup } from '@/lib/payments/enqueue';

/**
 * The tier a free run is recorded under.
 *
 * `single`, the same one $5 buys, because the row describes WHAT was submitted
 * and one throw is one throw. What separates the two is the ledger — a free run's
 * attempt arrives as an `adjustment` with `actor:'free_first_throw'` and no
 * `orders` row behind it, and `orders_grants_only_when_paid` is what keeps the
 * two kinds of arrival apart. Inventing a `free` tier would have put the
 * distinction in the wrong table and made `PRICE_TIERS` describe something that
 * is not for sale.
 */
const FREE_TIER = 'single' as const;

/** `actor` on the ledger row. Greppable, and the only value this path writes. */
export const FREE_RUN_ACTOR = 'free_first_throw';

/** The idempotency key that makes one-free-per-product a database fact. */
export function freeGrantKey(normalizedUrl: string): string {
  return `free:url:${normalizedUrl}`;
}

/** The note on the ledger row. `attempts_adjustment_has_reason` requires one. */
export function freeGrantNote(normalizedUrl: string): string {
  return `url:${normalizedUrl}`;
}

/** The sentence somebody sees when the free throw for their product is gone. */
export const FREE_ALREADY_USED = 'This product has already had its free throw. $5 for another.';

/** What each policy refusal is told to the person it refused. All under twenty words. */
const REFUSAL_MESSAGE: Readonly<Record<FreeRunRefusal, string>> = {
  url_used: FREE_ALREADY_USED,
  email_used: 'That address has had its free throw. $5 for another.',
  disposable_email: 'Use an address you can be reached at. $5 skips this.',
  ip_window: 'Too many free throws from here. Try later, or pay $5.',
  daily_cap: 'Today’s free throws are gone. $5 goes in now.',
};

/** What the submitter is told when the address is missing or malformed. */
const EMAIL_UNREADABLE = 'Type an address we can send the link to.';

/** The one write the free path is allowed to make against the ledger. */
export interface FreeRunLedger {
  append(entry: AttemptEntry): Promise<AppendResult>;
  /** Which account already holds this key, or `null`. See `packages/db`. */
  holderOf(idempotencyKey: string): Promise<string | null>;
}

/**
 * The account seam, narrowed to two methods.
 *
 * Deliberately not the whole `AccountStore`. `rotateCapabilitySlug`,
 * `linkIdentity` and the token methods have no business on a path that grants an
 * attempt, and a handler that held them would be a handler that could rotate
 * somebody's account URL from a link in an email.
 */
export interface FreeRunAccounts {
  findAccountByEmail(email: string): Promise<{ readonly accountId: string; readonly email: string } | null>;
  createAccountForEmail(input: { readonly email: string; readonly now: Date }): Promise<CreatedAccount>;
}

/** What the form POST needs. Note what is missing: a ledger, and an account store. */
export interface FreeRunCreateDeps {
  readonly submissions: SubmissionWriter;
  readonly guards: SubmissionGuardDeps;
  readonly policy: FreeRunPolicy;
  readonly mail: MailTransport;
  readonly mailFrom: string;
  /** Absolute, e.g. `https://thepit.show/free/confirm`. */
  readonly confirmUrl: string;
  readonly keyring: SessionKeyring;
  /** How many proxies we control sit in front of this process. Vercel: 1. */
  readonly trustedProxyHops?: number;
  readonly now?: () => Date;
}

/** What the confirm POST needs, and it is the only thing that holds a ledger. */
export interface FreeRunConfirmDeps {
  readonly submissions: SubmissionLookup;
  readonly accounts: FreeRunAccounts;
  readonly ledger: FreeRunLedger;
  readonly policy: FreeRunPolicy;
  readonly guards: SubmissionGuardDeps;
  /**
   * Where a confirmed submission becomes a run. `null` in a deployment that has
   * taken the pipeline out of this process: the attempt still lands on the
   * balance, and the missing run is a log line rather than a lost customer.
   */
  readonly placement: PlacementEnqueueDeps | null;
  readonly keyring: SessionKeyring;
  readonly secureCookies?: boolean;
  readonly trustedProxyHops?: number;
  readonly now?: () => Date;
}

/**
 * `no-store` on every response here, for the two reasons `lib/auth/handlers.ts`
 * gives: one of these pages carries a bearer token in its URL and another sets a
 * 90-day credential. `no-referrer` is how the token stays out of the `Referer` of
 * anything either page loads.
 */
const FREE_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store, no-cache, must-revalidate',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
};

function html(body: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { ...FREE_HEADERS, 'content-type': 'text/html; charset=utf-8', ...extra },
  });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...FREE_HEADERS, 'content-type': 'application/json; charset=utf-8' },
  });
}

/** A form post gets a page; an API call gets JSON. Never decided by a query parameter. */
function wantsJson(request: Request): boolean {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) return true;
  const accept = request.headers.get('accept') ?? '';
  return accept.includes('application/json') && !accept.includes('text/html');
}

/**
 * The caller's address, or `null`.
 *
 * `clientIp` answers `UNKNOWN_CLIENT_IP` when there is nothing it will trust, and
 * that string is turned into `null` here rather than passed along. A policy that
 * received the literal `'unknown'` would bucket every unidentifiable caller
 * together and rate-limit them as one person — which is either a free pass or a
 * shared punishment, depending on which way the window falls.
 */
function callerIp(request: Request, trustedProxyHops?: number): string | null {
  const options = trustedProxyHops === undefined ? {} : { trustedProxyHops };
  const ip = clientIp(request.headers, options);
  return ip === UNKNOWN_CLIENT_IP ? null : ip;
}

/** Re-render the form with one sentence over it. `paidOnly` drops the free door. */
async function formPage(
  deps: { readonly guards: SubmissionGuardDeps },
  values: SubmitFormValues,
  notice: string,
  status: number,
  paidOnly = false,
): Promise<Response> {
  return html(
    renderSubmitPage(
      await submitPageView(() => deps.guards.candidateCategories(), values, false, notice, paidOnly),
    ),
    status,
  );
}

// ---------------------------------------------------------------------------
// `POST /api/free` — the form half.
// ---------------------------------------------------------------------------

export async function handleFreeRunCreate(request: Request, deps: FreeRunCreateDeps): Promise<Response> {
  const now = (deps.now ?? (() => new Date()))();
  const { values } = await readSubmissionValues(request);

  /**
   * The byline is READ and not USED.
   *
   * `readSubmissionValues` resolves it so the re-render can echo what the visitor
   * left the radio on, and this path writes `anonymous: false` from a literal
   * further down. A free run publishes under the product's name — S17's choice is
   * still made before scoring and still frozen; on this path there is only one of
   * it. So an unreadable value is not refused here the way it is on the paid path:
   * there is no irreversible disclosure to protect against when the answer is
   * fixed.
   */

  const email = normalizeEmail(values.email);
  if (!isPlausibleEmail(email)) {
    console.info('[free] refused before sending — email_unreadable');
    return wantsJson(request)
      ? json({ status: 'rejected', code: 'email_unreadable', message: EMAIL_UNREADABLE }, 422)
      : await formPage(deps, values, EMAIL_UNREADABLE, 422);
  }

  // The pitch cap, before the guards, because it is the cheapest refusal on the
  // page and the only one that is purely about what was typed.
  const pitch = readPitch(values.pitch);
  if (!pitch.ok) {
    console.info(`[free] refused before sending — pitch_too_long: ${pitch.length} characters`);
    return wantsJson(request)
      ? json({ status: 'rejected', code: 'pitch_too_long', message: pitch.message, limit: PITCH_LIMIT }, 422)
      : await formPage(deps, values, pitch.message, 422);
  }

  // `brief §2.4`, unchanged and not relaxed. Everything below this line is
  // conditional on it passing — before a row, before a token, before an email.
  const checked = await runSubmissionGuards(
    {
      draft: {
        url: values.url,
        name: values.name,
        description: values.description,
        categorySlug: values.categorySlug,
      },
      now,
      // No session is read on this path. A free throw carries an address and not
      // a cookie, and the ownership rule is re-run at confirm with the account
      // this address resolves to — which is the first moment it can be evaluated.
      accountId: null,
    },
    deps.guards,
  );
  if (checked.status === 'rejected') {
    console.info(`[free] refused before sending — ${rejectionSummary(checked.rejection)}`);
    const form = await submitPageView(() => deps.guards.candidateCategories(), values, false);
    return wantsJson(request)
      ? json({ status: 'rejected', code: checked.rejection.code, message: checked.rejection.message }, 422)
      : html(
          renderRejectionPage({
            rejection: checked.rejection,
            nextRebuild: nextRebuildFor(checked.rejection, now, deps.guards.schedule),
            form,
          }),
          422,
        );
  }

  const { clearance } = checked;

  // The policy, on the RESOLVED url — `brief §2.5`'s cap key, not the string the
  // visitor typed. Before the row and before the email, so a refusal costs a
  // database write and a delivery attempt that were never going to be useful.
  const allowed = await deps.policy.check({
    email,
    ip: callerIp(request, deps.trustedProxyHops),
    normalizedUrl: clearance.normalizedUrl,
    now,
  });
  if (!allowed.ok) {
    console.info(`[free] refused before sending — policy: ${allowed.reason}`);
    const message = REFUSAL_MESSAGE[allowed.reason];
    return wantsJson(request)
      ? json({ status: 'rejected', code: allowed.reason, message }, 422)
      : await formPage(deps, values, message, 422, true);
  }

  const submissionId = await deps.submissions.create({
    categorySlug: clearance.draft.categorySlug,
    name: clearance.draft.name,
    url: clearance.draft.url,
    normalizedUrl: clearance.normalizedUrl,
    description: clearance.draft.description,
    descriptionHash: clearance.descriptionHash,
    pitch: pitch.pitch,
    // `DECISIONS.md` S17, from a literal. See the module header.
    anonymous: false,
    cycleId: clearance.cycle.id,
    tier: FREE_TIER,
    attemptNumber: clearance.attemptNumber,
    repitchOf: clearance.repitchOf,
    now,
  });

  const token = mintFreeRunToken({ submissionId, email, issuedAt: now }, deps.keyring);
  const message = renderFreeRunEmail({
    email,
    from: deps.mailFrom,
    name: clearance.draft.name,
    confirmUrl: freeRunConfirmUrl(deps.confirmUrl, submissionId, token),
    idempotencyKey: freeRunIdempotencyKey(submissionId),
  });

  // A send that fails is logged and NOT surfaced. `mail/types.ts` argues it for
  // the magic link — a response that varied with the address reopens the
  // enumeration oracle — and the same holds here, where the address is somebody
  // else's product's owner as often as not.
  try {
    const sent = await deps.mail.send(message);
    if (sent.outcome === 'failed') {
      console.error(`[free] could not send the confirmation: ${sent.reason}`);
    }
  } catch (error) {
    console.error(`[free] mail transport threw: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (wantsJson(request)) {
    // The submission id, and no token. The token is a bearer credential with one
    // legitimate home — the inbox — and an API response is not it.
    return json({ status: 'sent', submissionId }, 200);
  }
  return html(freeSentPage(email), 200);
}

// ---------------------------------------------------------------------------
// `/free/confirm` — a button, then the run.
// ---------------------------------------------------------------------------

/**
 * `GET /free/confirm` — renders a button and touches nothing.
 *
 * No `deps` parameter, no `async`, no `await`. There is nothing here that could
 * create an account, grant an attempt or enqueue a placement even if someone
 * tried. See `lib/free/pages.ts` for why that is structural rather than a habit.
 */
export function handleFreeConfirmPage(request: Request): Response {
  const params = new URL(request.url).searchParams;
  return html(freeConfirmButtonPage(params.get('s') ?? '', params.get('t') ?? ''), 200);
}

/** Read the two fields, from a form body or a JSON one. */
async function confirmFields(request: Request): Promise<{ submissionId: string; token: string }> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const parsed: unknown = await request.json().catch(() => ({}));
    const body = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    return {
      submissionId: typeof body['s'] === 'string' ? body['s'] : '',
      token: typeof body['t'] === 'string' ? body['t'] : '',
    };
  }
  const form = await request.formData().catch(() => new FormData());
  const field = (key: string): string => {
    const value = form.get(key);
    return typeof value === 'string' ? value : '';
  };
  return { submissionId: field('s'), token: field('t') };
}

/**
 * `POST /free/confirm` — the only thing in the app that can grant a free attempt.
 *
 * Answers 303 to the buyer's own status page. 303 specifically, for the reason
 * `handleVerifySubmit` gives: the browser must follow with a GET, or a refresh
 * replays the POST.
 */
export async function handleFreeConfirm(request: Request, deps: FreeRunConfirmDeps): Promise<Response> {
  const now = (deps.now ?? (() => new Date()))();
  const { submissionId, token } = await confirmFields(request);

  const claim = verifyFreeRunToken(submissionId, token, deps.keyring, now);
  if (claim === null) {
    console.info('[free] refused a confirm — invalid_token');
    return html(freeConfirmRejectedPage(), 400);
  }

  const submission = await deps.submissions.find(submissionId);
  if (submission === null) {
    // A signature we made, over a submission that is not there. Rare enough to
    // log and indistinguishable to the caller from an expired link, because
    // confirming that a submission id was real is free reconnaissance.
    console.warn(`[free] a valid token named no submission: ${JSON.stringify(submissionId)}`);
    return html(freeConfirmRejectedPage(), 400);
  }

  const ip = callerIp(request, deps.trustedProxyHops);
  const input = { email: claim.email, ip, normalizedUrl: submission.normalizedUrl, now };

  // The second call, and the binding one. Hours can pass between the mail landing
  // and the button being pressed, and every rule the policy holds is a rule about
  // a window that moves.
  const allowed = await deps.policy.check(input);
  if (!allowed.ok) {
    console.info(`[free] refused a confirm — policy: ${allowed.reason}`);
    return await refusedAtConfirm(deps, submission, REFUSAL_MESSAGE[allowed.reason]);
  }

  await deps.policy.record({ ...input, submissionId });

  // `DECISIONS.md` S15's second arm. The address was confirmed by our own
  // signature over it, three statements ago, and by nothing else — which is the
  // whole precondition `createAccountForEmail` documents and cannot check.
  const existing = await deps.accounts.findAccountByEmail(claim.email);
  const account =
    existing ?? (await deps.accounts.createAccountForEmail({ email: claim.email, now }));

  const key = freeGrantKey(submission.normalizedUrl);
  const appended = await deps.ledger.append({
    accountId: account.accountId,
    delta: 1,
    reason: { kind: 'adjustment', actor: FREE_RUN_ACTOR, note: freeGrantNote(submission.normalizedUrl) },
    idempotencyKey: key,
    createdAt: now,
  });

  if (appended.outcome === 'duplicate') {
    // Two very different people reach this line. See the module header.
    const holder = await deps.ledger.holderOf(key);
    if (holder !== account.accountId) {
      console.info(`[free] refused a confirm — the free throw for ${key} belongs to another account`);
      return await refusedAtConfirm(deps, submission, FREE_ALREADY_USED);
    }
    // The same person, again. No second grant — the index saw to that — and the
    // same redirect, because a confirm that answered differently the second time
    // would be a confirm nobody could safely refresh.
    console.info(`[free] a repeat confirm for ${JSON.stringify(submissionId)}; nothing granted`);
  }

  await startTheRun(account.accountId, claim.email, submissionId, deps);

  // The session, minted here for the same reason the paid path mints one at the
  // handoff: this is the moment we know who they are, and an account they cannot
  // reach is an account they will contact support about.
  const session = newSessionPayload({ accountId: account.accountId, email: claim.email, now });
  const cookieOptions = deps.secureCookies === undefined ? {} : { secure: deps.secureCookies };
  const setCookie = serializeSessionCookie(signSessionCookie(session, deps.keyring), cookieOptions);

  return new Response(null, {
    status: 303,
    headers: {
      ...FREE_HEADERS,
      location: runStatusPath(submissionId, mintRunStatusToken(submissionId, deps.keyring)),
      'set-cookie': setCookie,
    },
  });
}

/**
 * The refusal, at confirm, with the paid form pre-filled from the row.
 *
 * Everything they typed is still on the `submissions` row, so the form they land
 * on is an edit rather than a retype — which matters more here than on the form
 * POST, because by this point they have left the tab and come back through an
 * email. The free door is withheld: it was closed a sentence ago.
 */
async function refusedAtConfirm(
  deps: FreeRunConfirmDeps,
  submission: { name: string; url: string; description: string; categorySlug: string; pitch?: string | null },
  notice: string,
): Promise<Response> {
  const values: SubmitFormValues = {
    url: submission.url,
    name: submission.name,
    description: submission.description,
    pitch: submission.pitch ?? '',
    categorySlug: submission.categorySlug,
    email: '',
    tier: 'single',
    anonymous: false,
  };
  return await formPage(deps, values, notice, 409, true);
}

/**
 * Fire the placement, and never throw.
 *
 * The same `enqueuePlacementForPayment` the webhook calls, with the same three
 * fields — so the free run and the paid run become the same event, carry the same
 * `jobIdempotencyKey`, and go through the same authoritative re-run of the
 * guards. A second enqueue site would be a second answer to what a placement is.
 *
 * A refusal here is not a failure of the confirm. The attempt is on the balance
 * and the customer is owed a run, which is a log line and a support conversation
 * rather than a 500 on the page that just signed them in.
 */
async function startTheRun(
  accountId: string,
  email: string,
  submissionId: string,
  deps: FreeRunConfirmDeps,
): Promise<void> {
  if (deps.placement === null) {
    console.error(`[free] ${submissionId}: no placement queue is bound in this deployment`);
    return;
  }
  try {
    const enqueued = await enqueuePlacementForPayment(
      { accountId, email, metadata: { submission_id: submissionId } },
      deps.placement,
    );
    if (!enqueued.enqueued) {
      console.error(`[free] ${submissionId}: placement not enqueued: ${enqueued.reason}`);
    }
  } catch (error) {
    console.error(
      `[free] ${submissionId}: placement enqueue threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
