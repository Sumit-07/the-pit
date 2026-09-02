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

import { mintRunStatusToken, readSession, type SessionKeyring } from '@the-pit/auth';
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

import { BYLINE_FIELD, readByline, type BylineCheck } from '@/lib/checkout/byline';
import {
  nextRebuildFor,
  rejectionSummary,
  runSubmissionGuards,
  type SubmissionGuardDeps,
} from '@/lib/checkout/guards';
import { readCategoryPanels } from '@/lib/checkout/panel';
import { PITCH_LIMIT, readPitch } from '@/lib/checkout/pitch';
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
    /**
     * The founder's own words, or `null`. Separate from `description`, which is
     * now the site's — see `lib/checkout/pitch.ts`.
     *
     * It rides on the DRAFT and not on the clearance, and that placement is the
     * decision. `SubmissionClearance` is what `checkSubmission` produced, and
     * nothing in `@the-pit/payments` has an opinion about the pitch: it is not
     * part of the cap key, not part of `descriptionHash`, and not part of the
     * material-change measure. Putting it on the clearance would imply a rule
     * had been run over it. None has.
     */
    readonly pitch: string | null;
    /**
     * Published as a robot rather than under a name — the buyer's own choice, made
     * on the form before anything was scored.
     *
     * On the DRAFT for the same reason the pitch is, and for a stronger one.
     * `SubmissionClearance` is what `checkSubmission` produced, and nothing in
     * `@the-pit/payments` has an opinion about a byline: it is not part of the cap
     * key, not part of `descriptionHash`, not part of the material-change measure.
     * Putting it on the clearance would imply a rule had been run over it, and
     * worse, `SubmissionClearance` is branded precisely so it cannot be persisted
     * and read back as proof of anything — while this value must survive the round
     * trip through Dodo and be read back by the webhook as authoritative. It is a
     * fact the customer stated, not a conclusion we reached.
     *
     * Required rather than optional. An omitted flag on a write path is how a
     * listing gets published under a name its owner asked us to withhold, which is
     * the one mistake here that no later code can undo.
     */
    readonly anonymous: boolean;
    readonly cycleId: string;
    readonly tier: PriceTierId;
    readonly attemptNumber: number;
    readonly repitchOf: string | null;
    readonly now: Date;
  }): Promise<string>;
}

/**
 * Reading the cookie, and nothing else.
 *
 * Both halves of this module want a session and neither is gated on one, so the
 * two fields are named once here rather than duplicated on both dependency sets.
 * Every field is optional because "we do not know who this is" is the ordinary
 * state of a guest checkout — see `submitterAccountId`.
 */
interface SessionSource {
  readonly keyring?: SessionKeyring;
  readonly secureCookies?: boolean;
}

/**
 * What `GET /submit` needs. It is deliberately NOT `CheckoutHandlerDeps`.
 *
 * The form is a static document: four fields, a price, and a `<select>` whose
 * options are the categories that have a board. Rendering it writes nothing,
 * charges nothing and reads no row — the roster comes from the snapshot sink,
 * which is JSON on a disk or behind a CDN (`lib/boards/source.ts`), and the
 * session is optional in the strong sense below.
 *
 * So this type holds no `DodoConfig`, no `DodoTransport`, no `SubmissionWriter`
 * and no `ListingLookup`, and `lib/checkout/config.ts` can therefore resolve it
 * with no `DATABASE_URL` and no `DODO_WEBHOOK_SECRET`. That is the point: the
 * page that takes someone's money must render on a deployment where the write
 * path is still being wired, and `brief §2.1` promises nothing sits between a
 * visitor and their purchase. A missing binding must be reported at the moment
 * money would move — which is `handleCheckoutCreate` below, and `POST` only —
 * and never by 500-ing the form.
 *
 * The absence of the write dependencies is the guarantee, the same way the
 * absence of an `AttemptsLedger` from `CheckoutHandlerDeps` is: a `GET` handler
 * that held a `SubmissionWriter` would be a `GET` handler that could write one.
 */
export interface SubmitPageDeps extends SessionSource {
  /** Every category on offer. See `lib/checkout/bindings.ts`; no database. */
  readonly candidateCategories: () => Promise<readonly string[]>;
}

export interface CheckoutHandlerDeps extends SessionSource {
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

/** The `GET` half of a `CheckoutHandlerDeps`, for the `POST` that re-renders the form. */
export function submitPageDepsFrom(deps: CheckoutHandlerDeps): SubmitPageDeps {
  return {
    candidateCategories: () => deps.guards.candidateCategories(),
    ...(deps.keyring === undefined ? {} : { keyring: deps.keyring }),
    ...(deps.secureCookies === undefined ? {} : { secureCookies: deps.secureCookies }),
  };
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

/**
 * What the visitor sent, plus whether their byline was readable.
 *
 * The byline is the one field whose wire value can be WRONG rather than merely
 * long or empty, and the two directions of getting it wrong are not symmetric —
 * see `lib/checkout/byline.ts`. So it is resolved once, here, and the parse
 * result travels beside the values: `values.anonymous` is what the form re-renders
 * with, and `byline` is what decides whether the request proceeds at all.
 */
interface ParsedSubmission {
  readonly values: SubmitFormValues;
  readonly byline: BylineCheck;
}

/** What the visitor sent, whatever shape they sent it in. */
async function readValues(request: Request): Promise<ParsedSubmission> {
  const contentType = request.headers.get('content-type') ?? '';

  if (contentType.includes('application/json')) {
    const parsed: unknown = await request.json().catch(() => ({}));
    const body = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const byline = readByline(body[BYLINE_FIELD]);
    return {
      byline,
      values: {
        url: str(body['url']),
        name: str(body['name']),
        description: str(body['description']),
        pitch: str(body['pitch']),
        categorySlug: str(body['category'] ?? body['categorySlug']),
        tier: str(body['tier']) === '' ? 'single' : str(body['tier']),
        // An unreadable value re-renders as NAMED, which is what the refusal page
        // then shows pre-checked. That is the honest echo: we did not understand
        // what they asked for, so we show them the default and make them say it
        // again rather than guessing at a choice that cannot be taken back.
        anonymous: byline.ok && byline.anonymous,
      },
    };
  }

  // `formData()` covers both `application/x-www-form-urlencoded` (what a plain
  // `<form method="post">` sends) and `multipart/form-data`.
  const form = await request.formData().catch(() => new FormData());
  const field = (key: string): string => str(form.get(key));
  const tier = field('tier');
  const byline = readByline(field(BYLINE_FIELD));
  return {
    byline,
    values: {
      url: field('url'),
      name: field('name'),
      description: field('description'),
      pitch: field('pitch'),
      categorySlug: field('category') === '' ? field('categorySlug') : field('category'),
      tier: tier === '' ? 'single' : tier,
      anonymous: byline.ok && byline.anonymous,
    },
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
function submitterAccountId(request: Request, deps: SessionSource, now: Date = new Date()): string | null {
  if (deps.keyring === undefined) return null;
  try {
    const verified = readSession({
      cookieHeader: request.headers.get('cookie'),
      keyring: deps.keyring,
      // The REQUEST's instant, not a second reading of the wall clock. Every other
      // rule this handler applies runs against `deps.now`, and a session read at a
      // different instant from the cycle arithmetic is a request being evaluated
      // at two times at once — which is also how a test pinned to a fixed `now`
      // ends up reading a cookie that expired in real time.
      now,
      ...(deps.secureCookies === undefined ? {} : { secure: deps.secureCookies }),
    });
    return verified.valid ? verified.session.accountId : null;
  } catch {
    return null;
  }
}

async function pageView(
  candidateCategories: () => Promise<readonly string[]>,
  values: SubmitFormValues,
  signedIn: boolean,
  notice?: string,
): Promise<SubmitPageView> {
  const categories = await candidateCategories();
  return {
    categories,
    // The jury for each offered category, read off the installed reference files.
    // A deployment with no reference files gets `[]` and the form renders alone;
    // nothing here invents a panel. See `lib/checkout/panel.ts`.
    panels: await readCategoryPanels(categories),
    tiers: PRICE_TIERS,
    values,
    descriptionLimit: SANITIZE_LIMIT,
    signedIn,
    ...(notice === undefined ? {} : { notice }),
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

/**
 * `GET /submit` — the form. Reachable by anybody, signed in or not, and by a
 * deployment whose write path is not wired.
 *
 * Takes `SubmitPageDeps` and not `CheckoutHandlerDeps`, so there is no
 * expression in this function that could reach a database handle, a Dodo client
 * or the submissions table. See the type.
 */
export async function handleSubmitPage(request: Request, deps: SubmitPageDeps): Promise<Response> {
  const signedIn = submitterAccountId(request, deps) !== null;
  const view = await pageView(deps.candidateCategories, emptyFormFrom(request), signedIn);
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
    pitch: '',
    categorySlug: params.get('category') ?? '',
    // Not read from the query string. One tier is on sale and a link that named
    // another would render a form that cannot be posted; `tierFor` is what
    // refuses a wrong value, and it refuses it on the POST where it costs
    // nothing rather than on the GET where it would look like a broken page.
    tier: 'single',
    // NOT prefillable from the query string, and that is the point. A "pitch this"
    // link is written by whoever made the link, and the byline is the one field on
    // this form that its owner must choose for themselves — a URL that arrived
    // with the choice already made would be somebody else deciding, invisibly,
    // about a thing that cannot be changed afterwards. The control renders
    // pre-selected to the default and they pick.
    anonymous: false,
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
  const { values, byline } = await readValues(request);
  const accountId = submitterAccountId(request, deps, now);
  const form = await pageView(
    () => deps.guards.candidateCategories(),
    values,
    accountId !== null,
  );

  /**
   * The byline, before anything else.
   *
   * First because it is the cheapest refusal on the page and because it is the
   * only field whose failure mode is a disclosure rather than a delay: a value we
   * cannot read is refused rather than defaulted, since publishing a name the
   * buyer meant to withhold cannot be undone and a refusal before payment costs
   * them one click. `lib/checkout/byline.ts` argues the asymmetry in full.
   */
  if (!byline.ok) {
    console.info('[checkout] refused before payment — byline_unreadable');
    return wantsJson(request)
      ? json({ status: 'rejected', code: 'byline_unreadable', message: byline.message, charged: false }, 422)
      : html(
          renderSubmitPage(
            await pageView(() => deps.guards.candidateCategories(), values, accountId !== null, byline.message),
          ),
          422,
        );
  }

  /**
   * The pitch cap, server-side.
   *
   * Before the guards and before the tier check, because it is the cheapest
   * refusal available and because it is the one that is purely about what was
   * typed: no listing lookup, no classifier, no network. Refusing here costs the
   * visitor an edit; `maxlength` on the `<textarea>` is what usually means they
   * never see it, and is not what enforces it.
   */
  const pitch = readPitch(values.pitch);
  if (!pitch.ok) {
    console.info(`[checkout] refused before payment — pitch_too_long: ${pitch.length} characters`);
    return wantsJson(request)
      ? json(
          { status: 'rejected', code: 'pitch_too_long', message: pitch.message, limit: PITCH_LIMIT, charged: false },
          422,
        )
      : html(
          renderSubmitPage(
            await pageView(() => deps.guards.candidateCategories(), values, accountId !== null, pitch.message),
          ),
          422,
        );
  }

  const tier = tierFor(values.tier);
  if (tier === null) {
    // Not a `SubmissionRejection` — the tier is ours, not theirs, and a value
    // outside the one `brief §2.3` closes the table at means the form was edited.
    // Refused, never coerced to `single`: a request that asked to be charged for
    // something we do not sell must not be quietly charged for something else.
    console.info(`[checkout] refused before payment — unknown_tier: ${values.tier}`);
    return wantsJson(request)
      ? json({ status: 'rejected', code: 'unknown_tier', message: 'Pick $5.', charged: false }, 422)
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
    // From the checked FORM value and not from the clearance, because the
    // clearance does not carry it — no rule in `@the-pit/payments` reads the
    // pitch, so there is nothing there for it to have been derived from.
    pitch: pitch.pitch,
    // From the parsed FORM value, beside the pitch and for the same reason: no
    // rule in `@the-pit/payments` reads a byline, so the clearance has nothing to
    // have derived it from. This is the moment the choice becomes a fact — after
    // it, `products_anonymity_immutable` owns it, and no path in this application
    // offers to change it again.
    anonymous: byline.anonymous,
    cycleId: clearance.cycle.id,
    tier: tier.id,
    attemptNumber: clearance.attemptNumber,
    repitchOf: clearance.repitchOf,
    now,
  });

  /**
   * The buyer's key to their own status page, minted here and nowhere else.
   *
   * This is the last instant at which we know the person asking is the person
   * who typed the submission — after this there is only a browser coming back
   * from Dodo with a query string on it. So the signature is made now, rides the
   * return URL home, and `/checkout/success` mints nothing. See
   * `lib/pipeline/status-access.ts`.
   *
   * Absent when no keyring is bound, which on this route means `SESSION_SECRET`
   * is unset. The checkout still opens: `brief §2.1` puts nothing between a
   * visitor and their purchase, and a missing status link is not a reason to
   * refuse somebody's money.
   */
  const statusToken = deps.keyring === undefined ? undefined : mintRunStatusToken(submissionId, deps.keyring);

  let created: CheckoutCreated;
  try {
    const result = await createCheckoutSession({
      clearance,
      tier,
      config: deps.config,
      transport: deps.transport,
      submissionId,
      ...(statusToken === undefined ? {} : { statusToken }),
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
              // Said once. The eyebrow over this heading already reads "Not
              // charged", and a body that repeated it would be the third place
              // on one screen that insists nobody took the money.
              message: 'We could not open a checkout just now. Try again in a moment.',
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
