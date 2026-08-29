/**
 * `POST /api/checkout` — the guards, the `submissions` row, and the Dodo session,
 * in that order, exercised over HTTP through the real handler.
 *
 * `packages/payments` already proves the RULES with 146 mutation-verified tests:
 * the cycle arithmetic, the Jaccard measure, the classifier's blocking policy.
 * What this file proves is the ORDER, which is where a pre-payment check goes
 * wrong in practice — it gets moved, or it gets bypassed, or it gets duplicated
 * on one side and drifts.
 *
 * `DECISIONS.md` S12 made the ordering a decision: the check runs "BEFORE payment
 * so nobody pays for a rejection". `brief §2.4` gives the same rule its money
 * shape — a customer told "not until tonight's rebuild, 02:00 UTC" *before*
 * paying is informed; one told it *after* paying wants a refund. So the
 * assertions that matter here are not "the response was 422". They are:
 *
 *   - the Dodo transport was never called, and
 *   - no `submissions` row was written.
 *
 * A test that only checked the status would pass on a handler that opened a
 * checkout, charged the card, and then noticed.
 *
 * Everything is hand-derived from one fixed instant:
 *
 *   NOW              2026-06-01T20:00:00Z
 *   rebuild          02:00 UTC (`NIGHTLY_REBUILD`)
 *   current cycle    2026-06-01T02:00Z → 2026-06-02T02:00Z, id `2026-06-01`
 *   countdown        6h 0m
 *
 * Offline throughout: `FixtureDodoTransport` opens no socket, the stores are
 * `Map`s, and the webhook signature at the end is real HMAC-SHA256 computed with
 * `signWebhook` — the same function the verifier reads.
 */

import { newSessionPayload, signSessionCookie, SESSION_COOKIE_NAME, type SessionKeyring } from '@the-pit/auth';
import {
  AttemptsLedger,
  FixtureDodoTransport,
  seededCategoryClassifier,
  signWebhook,
  type AppendResult,
  type AttemptEntry,
  type AttemptsStore,
  type CategoryClassifier,
  type CategoryVerdict,
  type DodoConfig,
  type DodoEvent,
  type ListingSnapshot,
  type ResolvedAccount,
  type WebhookStore,
} from '@the-pit/payments';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ListingLookup } from '@/lib/checkout/guards';
import {
  handleCheckoutCreate,
  handleSubmitPage,
  submitPageDepsFrom,
  type CheckoutHandlerDeps,
} from '@/lib/checkout/handlers';
import type { PendingSubmission, PlacementQueue } from '@/lib/payments/enqueue';
import { enqueuePlacementForPayment } from '@/lib/payments/enqueue';
import { handleDodoWebhookRequest, type DodoWebhookDeps } from '@/lib/payments/webhook-handlers';
import { MemoryCategorySource } from '@/lib/pipeline/catalog';
import type { PlacementRequestedData } from '@/lib/pipeline/inngest';

import { CATEGORY, CATEGORY_SLUG, CATEGORY_VERSION, makeJury, makePanel, makeProducts } from './helpers/panel.js';
import { SEED_SIZE } from './helpers/place.js';

const ORIGIN = 'https://thepit.show';
const PAYER = 'payer@example.com';
const ACCOUNT = 'acct_founder';
const SECRET = 'whsec_' + Buffer.from('a-thirty-two-byte-endpoint-secret').toString('base64');
const KEYRING: SessionKeyring = ['test-secret-0123456789abcdef0123456789abcdef0123456789abcdef01'];

/** The instant every cycle assertion below is derived from. See the header. */
const NOW = new Date('2026-06-01T20:00:00.000Z');

/** Inside the current cycle: 02:00 today has passed, 02:00 tomorrow has not. */
const PITCHED_TONIGHT = new Date('2026-06-01T19:00:00.000Z');
/** Two cycles ago. The lock does not fire; the material-change rule still does. */
const PITCHED_LAST_WEEK = new Date('2026-05-25T19:00:00.000Z');

const MARGIN_TEXT = 'Turns meeting notes into a shared action list without anyone typing one.';
/** Ten tokens shared with none of MARGIN_TEXT's — a genuine rewrite, not an edit. */
const REWRITTEN_TEXT = 'Records the call, drafts the follow-up email, and books whatever everybody agreed to.';

// ---------------------------------------------------------------------------
// Stores. In memory, and as strict as the schema they stand in for.
// ---------------------------------------------------------------------------

/**
 * The listing lookup, keyed on the normalized URL and on NOTHING else.
 *
 * There is no account id in this map's key, which is the structural form of
 * `brief §2.4`'s "per product, not per account". A cap that could be evaded by
 * changing accounts, or that punished someone for owning four products, would
 * have to be written against a different interface than this one.
 */
class MemoryListings implements ListingLookup {
  readonly rows = new Map<string, ListingSnapshot>();
  readonly lookups: string[] = [];

  add(listing: ListingSnapshot): this {
    this.rows.set(listing.normalizedUrl, listing);
    return this;
  }

  findByNormalizedUrl(normalizedUrl: string): Promise<ListingSnapshot | null> {
    this.lookups.push(normalizedUrl);
    return Promise.resolve(this.rows.get(normalizedUrl) ?? null);
  }
}

/**
 * `submissions`, in memory, on both of its seams at once — the WRITE the checkout
 * route holds and the READ the webhook holds.
 *
 * One object so an end-to-end test can watch a row written on one request and
 * read back on another, which is the whole thing that was missing.
 */
class MemorySubmissions {
  readonly rows: (PendingSubmission & { createdAt: Date })[] = [];
  #counter = 0;

  create(draft: Omit<PendingSubmission, 'submissionId'> & { now: Date }): Promise<string> {
    this.#counter += 1;
    // A uuid shape, because `createPostgresSubmissionStore.find` rejects anything
    // that is not one before it touches the database.
    const submissionId = `11111111-2222-4333-8444-${String(this.#counter).padStart(12, '0')}`;
    const { now, ...rest } = draft;
    this.rows.push({ ...rest, submissionId, createdAt: now });
    return Promise.resolve(submissionId);
  }

  find(submissionId: string): Promise<PendingSubmission | null> {
    return Promise.resolve(this.rows.find((row) => row.submissionId === submissionId) ?? null);
  }
}

/** `WebhookStore`, in memory. Same shape as `webhook-route.test.ts`'s. */
class MemoryWebhookStore implements WebhookStore {
  readonly accounts = new Map<string, string>();
  readonly events = new Map<string, string>();
  readonly reviews: { eventId: string; reason: string }[] = [];

  ensureAccount(input: { email: string; now: Date }): Promise<ResolvedAccount> {
    const existing = this.accounts.get(input.email);
    if (existing !== undefined) return Promise.resolve({ accountId: existing, created: false });
    this.accounts.set(input.email, ACCOUNT);
    return Promise.resolve({ accountId: ACCOUNT, created: true });
  }

  recordEvent(input: { eventId: string; type: string; receivedAt: Date; outcome: string }): Promise<'recorded' | 'duplicate'> {
    if (this.events.has(input.eventId)) return Promise.resolve('duplicate');
    this.events.set(input.eventId, input.outcome);
    return Promise.resolve('recorded');
  }

  queueForReview(input: { eventId: string; reason: string; event: DodoEvent }): Promise<void> {
    this.reviews.push({ eventId: input.eventId, reason: input.reason });
    return Promise.resolve();
  }
}

/** `AttemptsStore`, in memory. Here to be watched, mostly — see the last describe. */
class MemoryAttemptsStore implements AttemptsStore {
  readonly entries: AttemptEntry[] = [];
  readonly keys = new Set<string>();

  append(entry: AttemptEntry): Promise<AppendResult> {
    const balance = (): number =>
      this.entries.filter((row) => row.accountId === entry.accountId).reduce((sum, row) => sum + row.delta, 0);
    if (this.keys.has(entry.idempotencyKey)) return Promise.resolve({ outcome: 'duplicate', balance: balance() });
    this.keys.add(entry.idempotencyKey);
    this.entries.push(entry);
    return Promise.resolve({ outcome: 'appended', balance: balance() });
  }

  balance(accountId: string): Promise<number> {
    return Promise.resolve(this.entries.filter((row) => row.accountId === accountId).reduce((sum, row) => sum + row.delta, 0));
  }
}

class RecordingQueue implements PlacementQueue {
  readonly sent: PlacementRequestedData[] = [];
  send(event: PlacementRequestedData): Promise<void> {
    this.sent.push(event);
    return Promise.resolve();
  }
}

/** A classifier that blocks with certainty. `DECISIONS.md` S12's blocking arm. */
function blockingClassifier(suggested: string): CategoryClassifier {
  return {
    classify(): Promise<CategoryVerdict> {
      return Promise.resolve({ verdict: 'mismatch', confidence: 0.95, suggested, reason: 'the copy is about developers' });
    },
  };
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const CONFIG: DodoConfig = {
  mode: 'test',
  webhookSecret: SECRET,
  productIds: { prod_single: 'single', prod_triple: 'triple' },
  returnUrl: `${ORIGIN}/checkout/success`,
};

const CATEGORIES = [CATEGORY_SLUG, 'health-apps'];

let listings: MemoryListings;
let submissions: MemorySubmissions;
let transport: FixtureDodoTransport;
let deps: CheckoutHandlerDeps;

beforeEach(() => {
  listings = new MemoryListings();
  submissions = new MemorySubmissions();
  transport = new FixtureDodoTransport();

  deps = {
    config: CONFIG,
    transport,
    submissions,
    guards: {
      listings,
      candidateCategories: () => Promise.resolve(CATEGORIES),
    },
    keyring: KEYRING,
    now: () => NOW,
  };
});

/** A listing on the board at one URL, with everything else at its quiet default. */
function listing(overrides: Partial<ListingSnapshot> & { normalizedUrl: string }): ListingSnapshot {
  return {
    listingId: `prod_${overrides.normalizedUrl}`,
    accountId: ACCOUNT,
    categorySlug: CATEGORY_SLUG,
    description: MARGIN_TEXT,
    descriptionHash: 'a'.repeat(64),
    attemptNumber: 1,
    lastPitchedAt: PITCHED_LAST_WEEK,
    clusterId: null,
    currentVerdictId: null,
    ...overrides,
  };
}

interface Submitted {
  readonly url?: string;
  readonly name?: string;
  readonly description?: string;
  readonly category?: string;
  readonly tier?: string;
}

/** A plain `<form method="post">` submission — no JavaScript, no JSON, no login. */
function post(values: Submitted = {}, options: { cookie?: string } = {}): Request {
  const body = new URLSearchParams({
    url: values.url ?? 'https://example.com/margin',
    name: values.name ?? 'Margin',
    description: values.description ?? MARGIN_TEXT,
    category: values.category ?? CATEGORY_SLUG,
    tier: values.tier ?? 'single',
  });
  return new Request(`${ORIGIN}/api/checkout`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'text/html',
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    },
    body: body.toString(),
  });
}

/** The same submission as an API call, for the tests that read a code. */
function postJson(values: Submitted = {}): Request {
  return new Request(`${ORIGIN}/api/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      url: values.url ?? 'https://example.com/margin',
      name: values.name ?? 'Margin',
      description: values.description ?? MARGIN_TEXT,
      category: values.category ?? CATEGORY_SLUG,
      tier: values.tier ?? 'single',
    }),
  });
}

function sessionCookie(accountId: string = ACCOUNT): string {
  const value = signSessionCookie(newSessionPayload({ accountId, email: PAYER, now: NOW }), KEYRING);
  return `${SESSION_COOKIE_NAME}=${value}`;
}

/** Nothing was opened and nothing was written. The pre-payment assertion. */
function expectNothingBought(): void {
  expect(transport.calls).toEqual([]);
  expect(transport.sessionCount).toBe(0);
  expect(submissions.rows).toEqual([]);
}

// ---------------------------------------------------------------------------

describe('guest checkout: nothing sits between a visitor and their purchase', () => {
  it('opens a checkout for someone with no session, no cookie and no account', async () => {
    // `brief §2.1`: no login at submission. This request carries nothing that
    // identifies anybody, and it is the ordinary path.
    const response = await handleCheckoutCreate(post(), deps);

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('checkout.dodopayments.com');
    expect(transport.sessionCount).toBe(1);
  });

  it('never answers 401 or redirects to a sign-in page', async () => {
    const response = await handleCheckoutCreate(post(), deps);
    expect(response.status).not.toBe(401);
    expect(response.headers.get('location') ?? '').not.toContain('/auth/');
  });

  it('renders the form to a signed-out visitor with no mention of signing in', async () => {
    const page = await (
      await handleSubmitPage(new Request(`${ORIGIN}/submit`), submitPageDepsFrom(deps))
    ).text();

    expect(page).toContain('name="url"');
    expect(page).toContain('name="description"');
    expect(page).toContain('action="/api/checkout"');
    // A sign-in prompt on a buying path becomes a step in the buying path.
    expect(page).not.toContain('Sign in');
    expect(page).not.toContain('/auth/github');
  });

  it('accepts a form post with no JavaScript — urlencoded body, no JSON anywhere', async () => {
    // The whole page works as a plain form. `formData()` reads what a browser with
    // scripting disabled sends.
    const response = await handleCheckoutCreate(post(), deps);
    expect(response.status).toBe(303);
  });
});

describe('the submission row — the thing that was missing', () => {
  it('writes exactly one row, and the checkout carries its id and not the pitch', async () => {
    await handleCheckoutCreate(post(), deps);

    expect(submissions.rows).toHaveLength(1);
    const row = submissions.rows[0];
    const call = transport.calls[0];

    // The id crosses Dodo. The 300-character description does not.
    expect(call?.metadata['submission_id']).toBe(row?.submissionId);
    expect(JSON.stringify(call?.metadata)).not.toContain(MARGIN_TEXT);
  });

  it('stores the DERIVED values, not the raw form', async () => {
    await handleCheckoutCreate(post({ url: 'HTTPS://WWW.Example.com/Margin/?utm_source=x' }), deps);

    const row = submissions.rows[0];
    // `normalizeUrl` from the engine: lowercased, scheme and `www.` and trailing
    // slash gone, every query parameter dropped.
    expect(row?.normalizedUrl).toBe('example.com/margin');
    expect(row?.cycleId).toBe('2026-06-01');
    expect(row?.descriptionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.attemptNumber).toBe(1);
    expect(row?.repitchOf).toBeNull();
  });

  it('numbers a re-pitch from the listing it replaces', async () => {
    listings.add(listing({ normalizedUrl: 'example.com/margin', attemptNumber: 2 }));

    await handleCheckoutCreate(post({ description: REWRITTEN_TEXT }), deps);

    // `brief §2.4`: shown publicly as "3rd pitch".
    expect(submissions.rows[0]?.attemptNumber).toBe(3);
    expect(submissions.rows[0]?.repitchOf).toBe('prod_example.com/margin');
  });

  it('opens ONE Dodo session for a double-clicked pay button', async () => {
    // `checkoutIdempotencyKey` is derived from what is being bought — this
    // product, this text, this cycle, this tier — so it is stable across a
    // reload and distinct across a genuine second purchase.
    await handleCheckoutCreate(post(), deps);
    await handleCheckoutCreate(post(), deps);

    expect(transport.calls).toHaveLength(2);
    expect(transport.sessionCount).toBe(1);
  });

  it('records the tier the buyer chose', async () => {
    await handleCheckoutCreate(post({ tier: 'triple' }), deps);
    expect(submissions.rows[0]?.tier).toBe('triple');
    expect(transport.calls[0]?.productId).toBe('prod_triple');
  });
});

describe('the cycle lock fires BEFORE a checkout exists', () => {
  it('rejects a product already pitched into tonight’s board without opening one', async () => {
    listings.add(listing({ normalizedUrl: 'example.com/margin', lastPitchedAt: PITCHED_TONIGHT }));

    const response = await handleCheckoutCreate(post({ description: REWRITTEN_TEXT }), deps);

    expect(response.status).toBe(422);
    // This is the assertion the test exists for. A handler that opened the
    // checkout and then noticed would pass a status check and fail here.
    expectNothingBought();
  });

  it('carries a countdown to the next rebuild, not a bare refusal', async () => {
    // Hand-derived: NOW is 20:00 on 1 June, the rebuild is 02:00 UTC, so the
    // current cycle closes at 02:00 on 2 June — six hours away.
    listings.add(listing({ normalizedUrl: 'example.com/margin', lastPitchedAt: PITCHED_TONIGHT }));

    const page = await (await handleCheckoutCreate(post({ description: REWRITTEN_TEXT }), deps)).text();

    expect(page).toContain('02:00 UTC');
    expect(page).toContain('6h 0m');
    expect(page).toContain('2 Jun');
    // `brief §2.4` explicitly does NOT want the cap expressed as a number.
    expect(page).not.toContain('limit reached');
    expect(page).toContain('Nothing was charged');
  });

  it('reports the same countdown to an API caller', async () => {
    listings.add(listing({ normalizedUrl: 'example.com/margin', lastPitchedAt: PITCHED_TONIGHT }));

    const body = (await (await handleCheckoutCreate(postJson({ description: REWRITTEN_TEXT }), deps)).json()) as Record<
      string,
      unknown
    >;

    expect(body['code']).toBe('cycle_locked');
    expect(body['nextRebuildAt']).toBe('2026-06-02T02:00:00.000Z');
    expect(body['nextRebuildIn']).toBe('6h 0m');
    expect(body['charged']).toBe(false);
  });

  it('lets the same product through once the cycle it was pitched in has closed', async () => {
    // The other half of the countdown being true: after the rebuild, it works.
    listings.add(listing({ normalizedUrl: 'example.com/margin', lastPitchedAt: PITCHED_LAST_WEEK }));

    const response = await handleCheckoutCreate(post({ description: REWRITTEN_TEXT }), deps);
    expect(response.status).toBe(303);
  });
});

describe('the cap is per product, not per account', () => {
  it('lets one account pitch a second side project on the same night', async () => {
    // Someone with four side projects submits all four tonight. The first is
    // cycle-locked; the second has never been on a board and is unaffected.
    listings.add(listing({ normalizedUrl: 'example.com/margin', lastPitchedAt: PITCHED_TONIGHT }));

    const locked = await handleCheckoutCreate(post({ description: REWRITTEN_TEXT }, { cookie: sessionCookie() }), deps);
    const other = await handleCheckoutCreate(
      post({ url: 'https://ledger.dev', name: 'Ledger', description: REWRITTEN_TEXT }, { cookie: sessionCookie() }),
      deps,
    );

    expect(locked.status).toBe(422);
    expect(other.status).toBe(303);
    expect(submissions.rows).toHaveLength(1);
    expect(submissions.rows[0]?.normalizedUrl).toBe('ledger.dev');
  });

  it('opens two checkouts for two different products from one session', async () => {
    const first = await handleCheckoutCreate(
      post({ url: 'https://margin.dev', name: 'Margin' }, { cookie: sessionCookie() }),
      deps,
    );
    const second = await handleCheckoutCreate(
      post({ url: 'https://ledger.dev', name: 'Ledger' }, { cookie: sessionCookie() }),
      deps,
    );

    expect([first.status, second.status]).toEqual([303, 303]);
    // Two DISTINCT sessions, not one reused: they are different purchases.
    expect(transport.sessionCount).toBe(2);
    expect(submissions.rows).toHaveLength(2);
  });

  it('never asks the listing store anything but a normalized URL', async () => {
    // The structural form of "per product": nothing about the submitter reaches
    // the query the cap is decided from.
    await handleCheckoutCreate(post({ url: 'https://margin.dev' }, { cookie: sessionCookie() }), deps);
    expect(listings.lookups).toEqual(['margin.dev']);
  });
});

describe('normalization is what makes the cap a cap', () => {
  it('catches the same product submitted under a different URL spelling', async () => {
    // The listing was pitched tonight under `example.com/margin`. This request
    // spells it with a protocol, a `www.`, capitals, a trailing slash and a UTM
    // parameter — five ways to look like a different product, all of which
    // `normalizeUrl` removes.
    listings.add(listing({ normalizedUrl: 'example.com/margin', lastPitchedAt: PITCHED_TONIGHT }));

    const response = await handleCheckoutCreate(
      post({ url: 'HTTPS://WWW.Example.COM/Margin/?utm_source=twitter', description: REWRITTEN_TEXT }),
      deps,
    );

    expect(response.status).toBe(422);
    expectNothingBought();
    expect(listings.lookups).toEqual(['example.com/margin']);
  });

  it('does not confuse two genuinely different paths on one host', async () => {
    listings.add(listing({ normalizedUrl: 'example.com/margin', lastPitchedAt: PITCHED_TONIGHT }));

    const response = await handleCheckoutCreate(post({ url: 'https://example.com/ledger' }), deps);
    expect(response.status).toBe(303);
  });

  it('refuses a URL it cannot normalize, and asks for a real one', async () => {
    const response = await handleCheckoutCreate(postJson({ url: 'htp:/not a url' }), deps);
    const body = (await response.json()) as Record<string, unknown>;

    expect(body['code']).toBe('invalid_url');
    expectNothingBought();
  });
});

describe('a re-pitch has to be a new pitch', () => {
  it('rejects the identical description, before payment', async () => {
    listings.add(listing({ normalizedUrl: 'example.com/margin', description: MARGIN_TEXT }));

    const response = await handleCheckoutCreate(post({ description: MARGIN_TEXT }), deps);
    const page = await response.text();

    expect(response.status).toBe(422);
    expectNothingBought();
    expect(page).toContain('same pitch');
  });

  it('rejects a one-word edit, which is the case an identity check would miss', async () => {
    // `materialChange` is Jaccard over token SETS plus an absolute floor of three
    // moved tokens. Swapping one word clears "identical" and fails the floor.
    listings.add(listing({ normalizedUrl: 'example.com/margin', description: MARGIN_TEXT }));

    const response = await handleCheckoutCreate(
      post({ description: MARGIN_TEXT.replace('shared', 'common') }),
      deps,
    );

    expect(response.status).toBe(422);
    expectNothingBought();
  });

  it('accepts a genuine rewrite', async () => {
    listings.add(listing({ normalizedUrl: 'example.com/margin', description: MARGIN_TEXT }));

    const response = await handleCheckoutCreate(post({ description: REWRITTEN_TEXT }), deps);
    expect(response.status).toBe(303);
  });

  it('does not apply the rule to a seeded listing nobody has ever pitched', async () => {
    // `brief` Part 7's unclaimed rows. Both the cycle lock and this rule are
    // rules about RE-pitching; a founder claiming their own seeded listing is
    // making a first pitch, and comparing against text somebody else wrote about
    // them would reject them for it.
    listings.add(
      listing({ normalizedUrl: 'example.com/margin', accountId: null, attemptNumber: 0, lastPitchedAt: null }),
    );

    const response = await handleCheckoutCreate(post({ description: MARGIN_TEXT }), deps);
    expect(response.status).toBe(303);
    expect(submissions.rows[0]?.attemptNumber).toBe(1);
  });
});

describe('the category check, DECISIONS.md S12', () => {
  it('blocks a high-confidence mismatch before payment and names a better room', async () => {
    deps = { ...deps, guards: { ...deps.guards, classifier: blockingClassifier('developer-tools') } };

    const response = await handleCheckoutCreate(post({ category: 'health-apps' }), deps);
    const page = await response.text();

    expect(response.status).toBe(422);
    // The highest-leverage free lever in the system, refused for free.
    expectNothingBought();
    expect(page).toContain('developer-tools');
    expect(page).toContain('Nothing was charged');
  });

  it('blocks with the REAL classifier, over the two boards this branch actually has', async () => {
    // The tests above hand the route a hand-written verdict, which proves the
    // policy and proves nothing about the classifier. This one wires the shipped
    // `seededCategoryClassifier` — the same object `lib/checkout/config.ts`
    // resolves in production — and posts a consumer gym app to Developer Tools.
    deps = {
      ...deps,
      guards: {
        ...deps.guards,
        classifier: seededCategoryClassifier,
        candidateCategories: () => Promise.resolve(['developer-tools', 'health-fitness-wellness']),
      },
    };

    const response = await handleCheckoutCreate(
      post({
        category: 'developer-tools',
        name: 'LiftLog — strength training workout tracker',
        description:
          'Log every workout, track your lifts and follow a strength training programme. Rest ' +
          'timers, personal records, calorie and protein targets, and recovery tips for the gym.',
      }),
      deps,
    );
    const page = await response.text();

    expect(response.status).toBe(422);
    expectNothingBought();
    expect(page).toContain('health-fitness-wellness');
    expect(page).toContain('Nothing was charged');
  });

  it('lets a real developer tool through the real classifier', async () => {
    // The other half, and the one that matters more: the guard is only worth
    // having if it does not cost a sale. Same wiring, a genuine developer tool.
    deps = {
      ...deps,
      guards: {
        ...deps.guards,
        classifier: seededCategoryClassifier,
        candidateCategories: () => Promise.resolve(['developer-tools', 'health-fitness-wellness']),
      },
    };

    const response = await handleCheckoutCreate(
      post({
        category: 'developer-tools',
        name: 'Prelint — automated code review on every pull request',
        description:
          'Static analysis and linting for your CI pipeline. Prelint reviews every pull request on ' +
          'GitHub, runs your test suite and reports coverage.',
      }),
      deps,
    );

    expect(response.status).toBe(303);
  });

  it('lets an uncertain classifier through rather than refusing on a guess', async () => {
    // S12's blocking policy errs toward letting people in: only a HIGH-confidence
    // mismatch blocks, because a blocked submitter has nowhere to appeal at 2am.
    deps = {
      ...deps,
      guards: {
        ...deps.guards,
        classifier: {
          classify: () => Promise.resolve<CategoryVerdict>({ verdict: 'uncertain', confidence: 0.4, reason: 'thin copy' }),
        },
      },
    };

    const response = await handleCheckoutCreate(post(), deps);
    expect(response.status).toBe(303);
  });

  it('runs the classifier LAST, after the free rules', async () => {
    // Ordering is a cost decision: a submission that is going to be rejected for
    // pitching twice tonight should not spend a model call.
    let classified = 0;
    listings.add(listing({ normalizedUrl: 'example.com/margin', lastPitchedAt: PITCHED_TONIGHT }));
    deps = {
      ...deps,
      guards: {
        ...deps.guards,
        classifier: {
          classify: (): Promise<CategoryVerdict> => {
            classified += 1;
            return Promise.resolve({ verdict: 'match', confidence: 1 });
          },
        },
      },
    };

    await handleCheckoutCreate(post({ description: REWRITTEN_TEXT }), deps);
    expect(classified).toBe(0);
  });
});

describe('ownership: a post-payment hold, unless the submitter signed in first', () => {
  it('does not fire for a guest, because there is no identity to compare', async () => {
    // `brief §2.1` is guest checkout, so at this point in the flow we genuinely do
    // not know who is submitting. The conflict is caught later, by the webhook.
    listings.add(listing({ normalizedUrl: 'example.com/margin', accountId: 'acct_somebody_else' }));

    const response = await handleCheckoutCreate(post({ description: REWRITTEN_TEXT }), deps);
    expect(response.status).toBe(303);
  });

  it('fires for a signed-in submitter, refusing before the charge instead of holding after it', async () => {
    // The one thing a GitHub session buys on this path, and it sits BESIDE the
    // flow rather than in front of it: a strictly better outcome for the person
    // who happened to be signed in.
    listings.add(listing({ normalizedUrl: 'example.com/margin', accountId: 'acct_somebody_else' }));

    const response = await handleCheckoutCreate(
      post({ description: REWRITTEN_TEXT }, { cookie: sessionCookie('acct_founder') }),
      deps,
    );

    expect(response.status).toBe(422);
    expectNothingBought();
  });

  it('ignores a forged or expired cookie and proceeds as a guest', async () => {
    // A session that does not verify means "we do not know who this is", which is
    // the ordinary state of this route — never a reason to refuse a purchase.
    listings.add(listing({ normalizedUrl: 'example.com/margin', accountId: 'acct_somebody_else' }));

    const response = await handleCheckoutCreate(
      post({ description: REWRITTEN_TEXT }, { cookie: `${SESSION_COOKIE_NAME}=not.a.real.cookie` }),
      deps,
    );

    expect(response.status).toBe(303);
  });
});

describe('nothing on this path can touch the ledger', () => {
  it('has no ledger to touch', () => {
    // The structural guarantee: `CheckoutHandlerDeps` has no `AttemptsLedger` and
    // no `AttemptsStore`. `brief §2.2` grants on the signed webhook and `§2.3`
    // consumes on delivery; a checkout route holding a ledger could do either.
    expect(Object.keys(deps).sort()).toEqual(['config', 'guards', 'keyring', 'now', 'submissions', 'transport']);
  });

  it('says nothing about a balance on the way out', async () => {
    // A checkout that reported attempts would be implying it had granted some.
    // `brief §2.2` grants on the signed webhook, which has not run yet and may
    // not run for minutes.
    const response = await handleCheckoutCreate(postJson(), deps);
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).not.toContain('balance');
    expect(body).not.toContain('attempts');
    expect(body).not.toContain('granted');
  });
});

// ---------------------------------------------------------------------------
// The end to end: checkout writes the row, the webhook finds it, the run starts.
// ---------------------------------------------------------------------------

describe('the funnel, end to end', () => {
  let webhookStore: MemoryWebhookStore;
  let ledger: MemoryAttemptsStore;
  let queue: RecordingQueue;
  let webhookDeps: DodoWebhookDeps;

  beforeEach(() => {
    webhookStore = new MemoryWebhookStore();
    ledger = new MemoryAttemptsStore();
    queue = new RecordingQueue();

    webhookDeps = {
      config: CONFIG,
      store: webhookStore,
      ledgerFor: () =>
        new AttemptsLedger(ledger, () => {
          throw new Error('the webhook may never consume an attempt');
        }),
      placement: {
        submissions,
        categories: new MemoryCategorySource([
          {
            category: CATEGORY,
            products: makeProducts(SEED_SIZE),
            jury: makeJury(),
            personas: makePanel(),
            config: { categoryVersion: CATEGORY_VERSION },
          },
        ]),
        queue,
        guards: { listings, candidateCategories: () => Promise.resolve(CATEGORIES) },
        now: () => NOW,
      },
    };
  });

  /** Dodo's `payment.succeeded`, carrying whatever metadata the checkout set. */
  function settled(metadata: Record<string, string>, eventId = 'evt_1'): Request {
    const raw = JSON.stringify({
      id: eventId,
      type: 'payment.succeeded',
      created_at: '2026-06-01T20:05:00.000Z',
      data: {
        payment_id: 'pay_1',
        total_amount: 500,
        currency: 'USD',
        customer: { email: PAYER },
        metadata,
      },
    });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = signWebhook({ id: 'wh_1', timestamp, rawBody: raw, secret: SECRET });
    return new Request(`${ORIGIN}/api/webhooks/dodo`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'webhook-id': 'wh_1',
        'webhook-timestamp': timestamp,
        'webhook-signature': `v1,${signature}`,
      },
      body: raw,
    });
  }

  /** Buy something, and hand back the metadata Dodo would carry back to us. */
  async function buy(values: Submitted = {}): Promise<Record<string, string>> {
    const response = await handleCheckoutCreate(post(values), deps);
    expect(response.status).toBe(303);
    return { ...(transport.calls[transport.calls.length - 1]?.metadata ?? {}) };
  }

  it('a settled payment now finds its submission and enqueues a placement', async () => {
    // The case that was broken: every settled payment granted correctly and then
    // parked with "the payment carries no submission_id", because nothing wrote a
    // `submissions` row. This is the whole funnel in four lines.
    const metadata = await buy();
    const response = await handleDodoWebhookRequest(settled(metadata), webhookDeps);

    expect(await response.json()).toEqual({ status: 'granted' });
    expect(webhookStore.reviews).toEqual([]);
    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0]?.product.name).toBe('Margin');
    expect(queue.sent[0]?.product.description).toBe(MARGIN_TEXT);
    expect(queue.sent[0]?.product.normalized_url).toBe('example.com/margin');
    expect(queue.sent[0]?.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('carries the payer to the placement, which is what makes the listing paid', async () => {
    // The second thing that was broken. The event named a product and nobody who
    // bought it, so `PgPipelineStore.writeProducts` wrote the customer's listing
    // as `source = 'seeded'` with a null submitter — `brief` Part 7's "unclaimed"
    // label on a row somebody paid $5 for, and with it the death of the cycle
    // cap, the material-change rule and the ownership rule, all of which read
    // `lastPitchedAt`, which is NULL for a seeded row.
    const metadata = await buy();
    await handleDodoWebhookRequest(settled(metadata), webhookDeps);

    expect(queue.sent[0]?.payer).toEqual({
      accountId: ACCOUNT,
      // The address Dodo verified, lowercased so `products_email_lowercase` and
      // `accounts_email_lowercase` agree about who this is.
      email: PAYER,
      // `brief §2.4`'s ordinal, computed before the money moved and read back off
      // the `submissions` row rather than recomputed here.
      attemptNumber: 1,
    });
  });

  it('carries the 300-character description through OUR storage and not through Dodo', async () => {
    const long = 'x'.repeat(300);
    const metadata = await buy({ description: long });

    expect(JSON.stringify(metadata)).not.toContain(long);
    await handleDodoWebhookRequest(settled(metadata), webhookDeps);
    expect(queue.sent[0]?.product.description).toBe(long);
  });

  it('grants the tier and spends nothing — no attempt is consumed at checkout or at enqueue', async () => {
    const metadata = await buy();
    await handleDodoWebhookRequest(settled(metadata), webhookDeps);

    // `brief §2.3`: an attempt is spent only when a verdict is DELIVERED. Both
    // the checkout and the enqueue have now run; the balance is the whole grant.
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries.every((entry) => entry.delta > 0)).toBe(true);
    expect(await ledger.balance(ACCOUNT)).toBe(1);
  });

  it('re-runs the guards before the placement and refuses one that went stale', async () => {
    // The authoritative half of `brief §2.4`. The submission was clear when the
    // buyer clicked pay; between then and settlement the product was pitched into
    // tonight's board. Placing it anyway would be the second pitch for one product
    // in one cycle — which is the thing the cap exists to prevent.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const metadata = await buy();
    listings.add(listing({ normalizedUrl: 'example.com/margin', lastPitchedAt: PITCHED_TONIGHT }));

    const response = await handleDodoWebhookRequest(settled(metadata), webhookDeps);

    // Not a single model call was bought.
    expect(queue.sent).toEqual([]);
    // The money still landed — a 500 would ask Dodo to redeliver a charge we have.
    expect(await response.json()).toEqual({ status: 'granted' });
    expect(ledger.entries).toHaveLength(1);
    expect(webhookStore.reviews[0]?.reason).toContain('no longer passes its guards');
    expect(webhookStore.reviews[0]?.reason).toContain('cycle_locked');
    errors.mockRestore();
  });

  it('holds an ownership conflict AFTER payment, which is the first moment it can be checked', async () => {
    // Guest checkout means there is no identity until this webhook resolves one
    // from the address Dodo verified. The hold is a consequence of that, not a
    // choice — and the customer keeps their attempts.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const metadata = await buy();
    listings.add(
      listing({ normalizedUrl: 'example.com/margin', accountId: 'acct_somebody_else', lastPitchedAt: PITCHED_LAST_WEEK, description: MARGIN_TEXT }),
    );

    await handleDodoWebhookRequest(settled(metadata), webhookDeps);

    expect(queue.sent).toEqual([]);
    expect(webhookStore.reviews[0]?.reason).toContain('ownership_conflict');
    expect(await ledger.balance(ACCOUNT)).toBe(1);
    errors.mockRestore();
  });

  it('places a submission whose guards still pass at settlement', async () => {
    // The control for the two above: nothing changed in between, so it runs.
    const metadata = await buy();
    await handleDodoWebhookRequest(settled(metadata), webhookDeps);
    expect(queue.sent).toHaveLength(1);
  });

  it('still enqueues when no guards are bound, and the reason is one field', async () => {
    // The null arm is a real deployment: a process with no listing store cannot
    // answer "has this been pitched tonight", and `enqueuePlacementForPayment`
    // proceeds on the pre-payment clearance rather than guessing.
    const metadata = await buy();
    const result = await enqueuePlacementForPayment(
      { accountId: ACCOUNT, email: PAYER, metadata },
      { ...(webhookDeps.placement as NonNullable<DodoWebhookDeps['placement']>), guards: null },
    );

    expect(result.enqueued).toBe(true);
  });
});
