/**
 * The free first throw, over HTTP, through the real handlers.
 *
 * `test/checkout-route.test.ts` proves the ORDER on the paid path — guards, then
 * a row, then a Dodo session — because that is where a pre-payment check goes
 * wrong in practice. This file proves the two orders the free path adds, and both
 * of them are about something that must NOT happen:
 *
 *   - a form POST sends exactly one email and opens NO checkout session;
 *   - a GET on the confirm link creates nothing, grants nothing and enqueues
 *     nothing, because a mail scanner will follow it within seconds.
 *
 * A test that only checked the status code would pass on a handler that granted
 * an attempt to Outlook Safe Links.
 *
 * The third thing it proves is the one that costs real money. One free run per
 * product is `attempts_idempotency_key_uk` and not a policy check — the policy
 * module is a stub on this branch and says yes to everything — so the assertions
 * below run the second confirm against a ledger that enforces the unique key, and
 * separate the two people who arrive at that duplicate: the founder pressing the
 * button twice, and a second address reaching for a throw that is gone.
 *
 * Everything is hand-derived from one fixed instant, the same one
 * `checkout-route.test.ts` uses:
 *
 *   NOW              2026-06-01T20:00:00Z
 *   rebuild          02:00 UTC (`NIGHTLY_REBUILD`)
 *   current cycle    2026-06-01T02:00Z → 2026-06-02T02:00Z, id `2026-06-01`
 *   token expiry     2026-06-02T20:00:00Z (24h)
 *
 * Offline throughout: `FixtureMailTransport` opens no socket, `FixtureDodoTransport`
 * opens no socket, and every store is a `Map`.
 */

import {
  FixtureMailTransport,
  readSession,
  SESSION_COOKIE_NAME,
  type OutboundEmail,
  type SessionKeyring,
} from '@the-pit/auth';
import {
  FixtureDodoTransport,
  type AppendResult,
  type AttemptEntry,
  type CategoryVerdict,
  type ListingSnapshot,
} from '@the-pit/payments';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ListingLookup } from '@/lib/checkout/guards';
import { handleCheckoutCreate, type CheckoutHandlerDeps } from '@/lib/checkout/handlers';
import {
  FREE_ALREADY_USED,
  FREE_RUN_ACTOR,
  freeGrantKey,
  handleFreeConfirm,
  handleFreeConfirmPage,
  handleFreeRunCreate,
  type FreeRunConfirmDeps,
  type FreeRunCreateDeps,
} from '@/lib/free/handlers';
import type { FreeRunCheck, FreeRunPolicy, FreeRunRefusal } from '@/lib/free/policy';
import type { PendingSubmission, PlacementQueue } from '@/lib/payments/enqueue';
import { MemoryCategorySource } from '@/lib/pipeline/catalog';
import type { PlacementRequestedData } from '@/lib/pipeline/inngest';

import { CATEGORY, CATEGORY_SLUG, CATEGORY_VERSION, makeJury, makePanel, makeProducts } from './helpers/panel.js';
import { SEED_SIZE } from './helpers/place.js';
import { passthroughUrlResolver } from './helpers/url-resolver.js';

const ORIGIN = 'https://thepit.show';
const CONFIRM_URL = `${ORIGIN}/free/confirm`;
const FOUNDER = 'founder@example.com';
const STRANGER = 'someone.else@example.com';
const KEYRING: SessionKeyring = ['test-secret-0123456789abcdef0123456789abcdef0123456789abcdef01'];

const NOW = new Date('2026-06-01T20:00:00.000Z');
/** Inside the token's day: the confirm still works. */
const LATER = new Date('2026-06-02T09:00:00.000Z');
/** Past it. The link is an heirloom. */
const NEXT_WEEK = new Date('2026-06-08T20:00:00.000Z');

const MARGIN_TEXT = 'Turns meeting notes into a shared action list without anyone typing one.';
const REWRITTEN_TEXT = 'Records the call, drafts the follow-up email, and books whatever everybody agreed to.';

const PITCHED_TONIGHT = new Date('2026-06-01T19:00:00.000Z');
const PITCHED_LAST_WEEK = new Date('2026-05-25T19:00:00.000Z');

const NORMALIZED = 'example.com/margin';

// ---------------------------------------------------------------------------
// Stores. As strict as the schema they stand in for.
// ---------------------------------------------------------------------------

class MemoryListings implements ListingLookup {
  readonly rows = new Map<string, ListingSnapshot>();

  add(listing: ListingSnapshot): this {
    this.rows.set(listing.normalizedUrl, listing);
    return this;
  }

  findByNormalizedUrl(normalizedUrl: string): Promise<ListingSnapshot | null> {
    return Promise.resolve(this.rows.get(normalizedUrl) ?? null);
  }
}

/** `submissions`, on both seams at once — the write and the read. */
class MemorySubmissions {
  readonly rows: (PendingSubmission & { createdAt: Date })[] = [];
  #counter = 0;

  create(draft: Omit<PendingSubmission, 'submissionId'> & { now: Date }): Promise<string> {
    this.#counter += 1;
    const submissionId = `11111111-2222-4333-8444-${String(this.#counter).padStart(12, '0')}`;
    const { now, ...rest } = draft;
    this.rows.push({ ...rest, submissionId, createdAt: now });
    return Promise.resolve(submissionId);
  }

  find(submissionId: string): Promise<PendingSubmission | null> {
    return Promise.resolve(this.rows.find((row) => row.submissionId === submissionId) ?? null);
  }
}

/**
 * `accounts`, in memory, strict about the one thing that matters here: the
 * address is UNIQUE, so a second `createAccountForEmail` for one address returns
 * the first account rather than opening a second.
 */
class MemoryAccounts {
  readonly byEmail = new Map<string, string>();
  readonly created: string[] = [];
  #counter = 0;

  findAccountByEmail(email: string): Promise<{ accountId: string; email: string } | null> {
    const accountId = this.byEmail.get(email);
    return Promise.resolve(accountId === undefined ? null : { accountId, email });
  }

  createAccountForEmail(input: { email: string; now: Date }): Promise<{
    accountId: string;
    email: string;
    created: boolean;
  }> {
    const existing = this.byEmail.get(input.email);
    if (existing !== undefined) {
      return Promise.resolve({ accountId: existing, email: input.email, created: false });
    }
    this.#counter += 1;
    const accountId = `acct_${this.#counter}`;
    this.byEmail.set(input.email, accountId);
    this.created.push(input.email);
    return Promise.resolve({ accountId, email: input.email, created: true });
  }
}

/**
 * The ledger, enforcing `attempts_idempotency_key_uk`.
 *
 * A fake that let a duplicate key through would make this whole file pass against
 * a product that hands out one free run per submission rather than one per
 * product — which is the failure the unique index exists to prevent.
 */
class MemoryLedger {
  readonly entries: AttemptEntry[] = [];

  append(entry: AttemptEntry): Promise<AppendResult> {
    const balance = (): number =>
      this.entries.filter((row) => row.accountId === entry.accountId).reduce((sum, row) => sum + row.delta, 0);
    if (this.entries.some((row) => row.idempotencyKey === entry.idempotencyKey)) {
      return Promise.resolve({ outcome: 'duplicate', balance: balance() });
    }
    this.entries.push(entry);
    return Promise.resolve({ outcome: 'appended', balance: balance() });
  }

  holderOf(idempotencyKey: string): Promise<string | null> {
    return Promise.resolve(this.entries.find((row) => row.idempotencyKey === idempotencyKey)?.accountId ?? null);
  }

  balance(accountId: string): number {
    return this.entries.filter((row) => row.accountId === accountId).reduce((sum, row) => sum + row.delta, 0);
  }
}

class RecordingQueue implements PlacementQueue {
  readonly sent: PlacementRequestedData[] = [];
  send(event: PlacementRequestedData): Promise<void> {
    this.sent.push(event);
    return Promise.resolve();
  }
}

/** A policy that records every question and answers whatever it was told to. */
class RecordingPolicy implements FreeRunPolicy {
  readonly checks: FreeRunCheck[] = [];
  readonly records: (FreeRunCheck & { submissionId: string })[] = [];
  refusal: FreeRunRefusal | null = null;

  check(input: FreeRunCheck): Promise<{ ok: true } | { ok: false; reason: FreeRunRefusal }> {
    this.checks.push(input);
    return Promise.resolve(this.refusal === null ? { ok: true } : { ok: false, reason: this.refusal });
  }

  record(input: FreeRunCheck & { submissionId: string }): Promise<void> {
    this.records.push(input);
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const CATEGORIES = [CATEGORY_SLUG, 'health-apps'];

let listings: MemoryListings;
let submissions: MemorySubmissions;
let accounts: MemoryAccounts;
let ledger: MemoryLedger;
let queue: RecordingQueue;
let policy: RecordingPolicy;
let sent: OutboundEmail[];
let mail: FixtureMailTransport;
let create: FreeRunCreateDeps;
let confirm: FreeRunConfirmDeps;

function guardDeps(): FreeRunCreateDeps['guards'] {
  return {
    listings,
    resolveUrl: passthroughUrlResolver(),
    candidateCategories: () => Promise.resolve(CATEGORIES),
  };
}

beforeEach(() => {
  listings = new MemoryListings();
  submissions = new MemorySubmissions();
  accounts = new MemoryAccounts();
  ledger = new MemoryLedger();
  queue = new RecordingQueue();
  policy = new RecordingPolicy();
  sent = [];
  mail = new FixtureMailTransport((message) => {
    sent.push(message);
  });

  create = {
    submissions,
    guards: guardDeps(),
    policy,
    mail,
    mailFrom: 'The Pit <no-reply@thepit.show>',
    confirmUrl: CONFIRM_URL,
    keyring: KEYRING,
    now: () => NOW,
  };

  confirm = {
    submissions,
    accounts,
    ledger,
    policy,
    guards: guardDeps(),
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
      guards: guardDeps(),
      now: () => LATER,
    },
    keyring: KEYRING,
    now: () => LATER,
  };
});

function listing(overrides: Partial<ListingSnapshot> & { normalizedUrl: string }): ListingSnapshot {
  return {
    listingId: `prod_${overrides.normalizedUrl}`,
    accountId: 'acct_somebody',
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
  readonly email?: string;
  readonly anonymous?: string;
}

/** A plain `<form method="post">` submission — no JavaScript, no JSON, no login. */
function post(values: Submitted = {}): Request {
  const body = new URLSearchParams({
    url: values.url ?? 'https://example.com/margin',
    name: values.name ?? 'Margin',
    description: values.description ?? MARGIN_TEXT,
    category: values.category ?? CATEGORY_SLUG,
    email: values.email ?? FOUNDER,
    tier: 'single',
    ...(values.anonymous === undefined ? {} : { anonymous: values.anonymous }),
  });
  return new Request(`${ORIGIN}/api/free`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
    body: body.toString(),
  });
}

/** The confirm link out of the email that was just sent, as a URL. */
function confirmLink(index = 0): URL {
  const message = sent[index];
  expect(message, 'no email was sent').toBeDefined();
  const match = /(https:\/\/\S*\/free\/confirm\?[^\s"]+)/.exec(message?.text ?? '');
  expect(match, `no confirm link in:\n${message?.text ?? ''}`).not.toBeNull();
  return new URL(match?.[1] ?? '');
}

/** The confirm POST, exactly as the button page's form sends it. */
function confirmPost(link: URL): Request {
  const body = new URLSearchParams({
    s: link.searchParams.get('s') ?? '',
    t: link.searchParams.get('t') ?? '',
  });
  return new Request(`${ORIGIN}/free/confirm`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
    body: body.toString(),
  });
}

/** Submit for free and hand back the link that came out of the mailbox. */
async function throwItIn(values: Submitted = {}): Promise<URL> {
  const response = await handleFreeRunCreate(post(values), create);
  expect(response.status).toBe(200);
  return confirmLink(sent.length - 1);
}

// ---------------------------------------------------------------------------

describe('the form post: one email, and nothing else', () => {
  it('sends exactly one confirmation and writes one submission row', async () => {
    const response = await handleFreeRunCreate(post(), create);

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(FOUNDER);
    expect(sent[0]?.subject).toBe('Start your verdict');
    expect(submissions.rows).toHaveLength(1);
    expect(await (await handleFreeRunCreate(post({ url: 'https://ledger.dev' }), create)).text()).toContain(
      'Check your inbox',
    );
  });

  it('opens no Dodo session, because there is no transport to open one with', async () => {
    // The structural assertion, in the shape `checkout-route.test.ts` uses for
    // the ledger: `FreeRunCreateDeps` has no `DodoTransport` and no `DodoConfig`,
    // so the form half of this flow could not charge anybody if it tried.
    const transport = new FixtureDodoTransport();
    await handleFreeRunCreate(post(), create);

    expect(Object.keys(create).sort()).toEqual([
      'confirmUrl',
      'guards',
      'keyring',
      'mail',
      'mailFrom',
      'now',
      'policy',
      'submissions',
    ]);
    expect(transport.sessionCount).toBe(0);
  });

  it('holds no ledger and no account store on the form half', () => {
    // `brief §2.3` grants in one place. That place is the CONFIRM, behind a
    // signature — never the unauthenticated route anybody on the internet can
    // post to as many times as they like.
    expect(Object.keys(create)).not.toContain('ledger');
    expect(Object.keys(create)).not.toContain('accounts');
    expect(Object.keys(create)).not.toContain('placement');
  });

  it('grants nothing, creates no account and enqueues nothing', async () => {
    await handleFreeRunCreate(post(), create);

    expect(ledger.entries).toEqual([]);
    expect(accounts.created).toEqual([]);
    expect(queue.sent).toEqual([]);
  });

  it('runs the SAME guards, and a cycle-locked product never reaches a mailbox', async () => {
    listings.add(listing({ normalizedUrl: NORMALIZED, lastPitchedAt: PITCHED_TONIGHT }));

    const response = await handleFreeRunCreate(post({ description: REWRITTEN_TEXT }), create);
    const page = await response.text();

    expect(response.status).toBe(422);
    expect(sent).toEqual([]);
    expect(submissions.rows).toEqual([]);
    // `brief §2.4`'s countdown, not a bare refusal — the same page the paid path
    // renders, because it is the same rejection.
    expect(page).toContain('02:00 UTC');
    expect(page).toContain('6h 0m');
  });

  it('refuses a description that is not a new pitch, before sending', async () => {
    listings.add(listing({ normalizedUrl: NORMALIZED, description: MARGIN_TEXT }));

    const response = await handleFreeRunCreate(post({ description: MARGIN_TEXT }), create);

    expect(response.status).toBe(422);
    expect(sent).toEqual([]);
    expect(submissions.rows).toEqual([]);
  });

  it('blocks a high-confidence category mismatch, before sending', async () => {
    create = {
      ...create,
      guards: {
        ...create.guards,
        classifier: {
          classify: (): Promise<CategoryVerdict> =>
            Promise.resolve({ verdict: 'mismatch', confidence: 0.95, suggested: CATEGORY_SLUG, reason: 'wrong room' }),
        },
      },
    };

    const response = await handleFreeRunCreate(post({ category: 'health-apps' }), create);

    expect(response.status).toBe(422);
    expect(sent).toEqual([]);
  });

  it('asks the policy before it sends, on the RESOLVED url', async () => {
    await handleFreeRunCreate(post({ url: 'HTTPS://WWW.Example.com/Margin/?utm_source=x' }), create);

    expect(policy.checks).toHaveLength(1);
    expect(policy.checks[0]?.normalizedUrl).toBe(NORMALIZED);
    expect(policy.checks[0]?.email).toBe(FOUNDER);
    // `record` is the confirm's job. Recording here would let anybody burn a
    // product's allowance by typing a URL and never opening the mail.
    expect(policy.records).toEqual([]);
  });

  it('refuses an address it cannot read, and sends nothing', async () => {
    const response = await handleFreeRunCreate(post({ email: 'not-an-address' }), create);

    expect(response.status).toBe(422);
    expect(sent).toEqual([]);
    expect(submissions.rows).toEqual([]);
    expect(await response.text()).toContain('Type an address we can send the link to.');
  });

  it('lowercases the address before it signs anything', async () => {
    await handleFreeRunCreate(post({ email: 'Founder@Example.COM' }), create);

    // `accounts_email_lowercase` and `products_email_lowercase` are one rule on
    // two tables: one address is one person.
    expect(sent[0]?.to).toBe(FOUNDER);
    expect(policy.checks[0]?.email).toBe(FOUNDER);
  });
});

describe('the byline: free runs publish under the product’s name', () => {
  it('writes named even when the form posted the robot', async () => {
    await handleFreeRunCreate(post({ anonymous: 'anonymous' }), create);

    // `DECISIONS.md` S17 is unchanged: the choice is made before scoring and
    // frozen. On this path there is only one of it, and the server does not take
    // the field's word for it either way.
    expect(submissions.rows[0]?.anonymous).toBe(false);
  });

  it('writes named for a value it could not read at all', async () => {
    await handleFreeRunCreate(post({ anonymous: 'ture' }), create);
    expect(submissions.rows[0]?.anonymous).toBe(false);
  });

  it('carries the name and the URL into the placement, unredacted', async () => {
    const link = await throwItIn({ anonymous: 'anonymous' });
    await handleFreeConfirm(confirmPost(link), confirm);

    expect(queue.sent[0]?.product.name).toBe('Margin');
    expect(queue.sent[0]?.product.normalized_url).toBe(NORMALIZED);
    expect(queue.sent[0]?.payer?.anonymous).toBeUndefined();
  });
});

describe('GET on the confirm link starts nothing', () => {
  it('renders a button and touches no dependency', async () => {
    const link = await throwItIn();

    // Every scanner, antivirus proxy and link preview in existence follows this
    // URL within seconds of the mail landing. It gets HTML and goes away.
    const response = handleFreeConfirmPage(new Request(link.toString()));
    const page = await response.text();

    expect(response.status).toBe(200);
    expect(page).toContain('<form method="post" action="/free/confirm">');
    expect(page).toContain('Start my verdict');
    expect(ledger.entries).toEqual([]);
    expect(accounts.created).toEqual([]);
    expect(queue.sent).toEqual([]);
    expect(policy.records).toEqual([]);
  });

  it('takes no dependencies at all, which is what makes that structural', () => {
    // Not an unused parameter and not an optional one: the signature has one
    // argument, so there is no store, no ledger and no queue it could reach.
    expect(handleFreeConfirmPage.length).toBe(1);
  });

  it('leaves the token still redeemable afterwards', async () => {
    const link = await throwItIn();
    handleFreeConfirmPage(new Request(link.toString()));

    const response = await handleFreeConfirm(confirmPost(link), confirm);
    expect(response.status).toBe(303);
  });
});

describe('the confirm POST: one account, one attempt, one run', () => {
  it('creates the account, grants once, enqueues once and redirects to the status page', async () => {
    const link = await throwItIn();
    const response = await handleFreeConfirm(confirmPost(link), confirm);
    const submissionId = link.searchParams.get('s') ?? '';

    expect(response.status).toBe(303);
    expect(accounts.created).toEqual([FOUNDER]);
    expect(ledger.entries).toHaveLength(1);
    expect(queue.sent).toHaveLength(1);

    const location = response.headers.get('location') ?? '';
    expect(location.startsWith(`/status/s/${submissionId}?t=`)).toBe(true);
  });

  it('writes the adjustment the invariant names, field for field', async () => {
    const link = await throwItIn();
    await handleFreeConfirm(confirmPost(link), confirm);

    expect(ledger.entries[0]).toEqual({
      accountId: 'acct_1',
      delta: 1,
      reason: { kind: 'adjustment', actor: FREE_RUN_ACTOR, note: `url:${NORMALIZED}` },
      idempotencyKey: freeGrantKey(NORMALIZED),
      createdAt: LATER,
    });
    // Keyed on the PRODUCT and not on the account, the submission or the address.
    // That is what makes it one free run per product rather than per person.
    expect(ledger.entries[0]?.idempotencyKey).toBe('free:url:example.com/margin');
  });

  it('checks the policy again, and records exactly once', async () => {
    const link = await throwItIn();
    await handleFreeConfirm(confirmPost(link), confirm);

    // Twice: once at the form, once here. Hours pass in between and every rule
    // the policy holds is a rule about a window that moves.
    expect(policy.checks).toHaveLength(2);
    expect(policy.checks[1]?.now).toEqual(LATER);
    expect(policy.records).toHaveLength(1);
    expect(policy.records[0]?.submissionId).toBe(link.searchParams.get('s'));
    expect(policy.records[0]?.normalizedUrl).toBe(NORMALIZED);
  });

  it('signs the confirmer in, as the account it just made', async () => {
    const link = await throwItIn();
    const response = await handleFreeConfirm(confirmPost(link), confirm);

    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(SESSION_COOKIE_NAME);

    const value = cookie.slice(cookie.indexOf('=') + 1, cookie.indexOf(';'));
    const verified = readSession({
      cookieHeader: `${SESSION_COOKIE_NAME}=${value}`,
      keyring: KEYRING,
      now: LATER,
    });
    expect(verified.valid).toBe(true);
    expect(verified.valid && verified.session.email).toBe(FOUNDER);
    expect(verified.valid && verified.session.accountId).toBe('acct_1');
  });

  it('sends the placement through the same enqueue the paid path uses', async () => {
    const link = await throwItIn();
    await handleFreeConfirm(confirmPost(link), confirm);

    expect(queue.sent[0]?.payer).toEqual({
      accountId: 'acct_1',
      email: FOUNDER,
      attemptNumber: 1,
      submissionId: link.searchParams.get('s'),
    });
    // The same job key the paid path computes, from the same four values.
    expect(queue.sent[0]?.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('re-runs the guards before the placement and refuses one that went stale', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const link = await throwItIn();
    listings.add(listing({ normalizedUrl: NORMALIZED, lastPitchedAt: new Date('2026-06-02T03:00:00.000Z') }));

    const response = await handleFreeConfirm(confirmPost(link), confirm);

    // Not a single model call was bought — and the attempt is on the balance,
    // unspent, which is what `brief §2.3` promises either way.
    expect(queue.sent).toEqual([]);
    expect(response.status).toBe(303);
    expect(ledger.balance('acct_1')).toBe(1);
    errors.mockRestore();
  });
});

describe('the second confirm', () => {
  it('is idempotent: no second grant, no second account, the same redirect', async () => {
    const link = await throwItIn();
    const first = await handleFreeConfirm(confirmPost(link), confirm);
    const second = await handleFreeConfirm(confirmPost(link), confirm);

    expect(second.status).toBe(303);
    expect(second.headers.get('location')).toBe(first.headers.get('location'));
    // The unique key did this, not an `if`.
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.balance('acct_1')).toBe(1);
    expect(accounts.created).toEqual([FOUNDER]);
  });

  it('signs them in again, because a refresh must not sign anybody out', async () => {
    const link = await throwItIn();
    await handleFreeConfirm(confirmPost(link), confirm);
    const second = await handleFreeConfirm(confirmPost(link), confirm);

    expect(second.headers.get('set-cookie') ?? '').toContain(SESSION_COOKIE_NAME);
  });
});

describe('one free throw per product, and the index is what says so', () => {
  it('refuses a second address reaching for the same URL', async () => {
    const mine = await throwItIn();
    await handleFreeConfirm(confirmPost(mine), confirm);

    // A different person, a different address, the same product. The policy stub
    // says yes; the unique key says no.
    const theirs = await throwItIn({ email: STRANGER, description: REWRITTEN_TEXT });
    const response = await handleFreeConfirm(confirmPost(theirs), confirm);
    const page = await response.text();

    expect(response.status).toBe(409);
    expect(page).toContain(FREE_ALREADY_USED);
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.balance('acct_2')).toBe(0);
    expect(queue.sent).toHaveLength(1);
  });

  it('renders the paid form, pre-filled, and withholds the free button', async () => {
    const mine = await throwItIn();
    await handleFreeConfirm(confirmPost(mine), confirm);

    const theirs = await throwItIn({ email: STRANGER, description: REWRITTEN_TEXT });
    const page = await (await handleFreeConfirm(confirmPost(theirs), confirm)).text();

    // The $5 door, with everything they typed still in it.
    expect(page).toContain('action="/api/checkout"');
    expect(page).toContain('value="https://example.com/margin"');
    expect(page).toContain('value="Margin"');
    expect(page).toContain(REWRITTEN_TEXT);
    expect(page).toContain('Take my $5 →');
    // And not the door that was closed one sentence above it.
    expect(page).not.toContain('formaction="/api/free"');
  });

  it('lets a DIFFERENT product have its own free throw', async () => {
    const first = await throwItIn();
    await handleFreeConfirm(confirmPost(first), confirm);

    const second = await throwItIn({ url: 'https://ledger.dev', name: 'Ledger', email: STRANGER });
    const response = await handleFreeConfirm(confirmPost(second), confirm);

    expect(response.status).toBe(303);
    expect(ledger.entries).toHaveLength(2);
    expect(ledger.entries[1]?.idempotencyKey).toBe('free:url:ledger.dev');
  });
});

describe('a policy refusal', () => {
  it('renders the paid form pre-filled at the form POST, and sends no email', async () => {
    policy.refusal = 'url_used';

    const response = await handleFreeRunCreate(post(), create);
    const page = await response.text();

    expect(response.status).toBe(422);
    expect(sent).toEqual([]);
    expect(submissions.rows).toEqual([]);
    expect(page).toContain(FREE_ALREADY_USED);
    expect(page).toContain('action="/api/checkout"');
    expect(page).toContain('value="https://example.com/margin"');
    expect(page).not.toContain('formaction="/api/free"');
  });

  it('says something different for each reason, all of it short', async () => {
    for (const reason of ['email_used', 'disposable_email', 'ip_window', 'daily_cap'] as const) {
      sent.length = 0;
      policy.refusal = reason;
      const page = await (await handleFreeRunCreate(post(), create)).text();
      expect(page, reason).toContain('$5');
      expect(sent, reason).toEqual([]);
    }
  });

  it('refuses at the confirm too, when the window moved while the mail sat unread', async () => {
    const link = await throwItIn();
    policy.refusal = 'daily_cap';

    const response = await handleFreeConfirm(confirmPost(link), confirm);

    expect(response.status).toBe(409);
    expect(ledger.entries).toEqual([]);
    expect(accounts.created).toEqual([]);
    expect(queue.sent).toEqual([]);
    // Refused before it recorded: an allowance is spent by a run, never by a
    // refusal.
    expect(policy.records).toEqual([]);
  });
});

describe('the token', () => {
  it('refuses a signature made with another keyring', async () => {
    const link = await throwItIn();
    const forged = { ...confirm, keyring: ['a-different-secret-of-entirely-adequate-length'] as SessionKeyring };

    const response = await handleFreeConfirm(confirmPost(link), forged);

    expect(response.status).toBe(400);
    expect(ledger.entries).toEqual([]);
    expect(accounts.created).toEqual([]);
  });

  it('refuses a token replayed against a different submission', async () => {
    const mine = await throwItIn();
    const theirs = await throwItIn({ url: 'https://ledger.dev', name: 'Ledger', email: STRANGER });

    const body = new URLSearchParams({
      s: theirs.searchParams.get('s') ?? '',
      t: mine.searchParams.get('t') ?? '',
    });
    const response = await handleFreeConfirm(
      new Request(`${ORIGIN}/free/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      }),
      confirm,
    );

    expect(response.status).toBe(400);
    expect(ledger.entries).toEqual([]);
  });

  it('stops working after its day is up', async () => {
    const link = await throwItIn();
    const response = await handleFreeConfirm(confirmPost(link), { ...confirm, now: () => NEXT_WEEK });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('That link no longer works');
    expect(ledger.entries).toEqual([]);
  });

  it('refuses an empty POST without touching anything', async () => {
    const response = await handleFreeConfirm(
      new Request(`${ORIGIN}/free/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: '',
      }),
      confirm,
    );

    expect(response.status).toBe(400);
    expect(accounts.created).toEqual([]);
  });
});

describe('the paid path is untouched', () => {
  it('still opens a checkout, and the free form still posts to the free route', async () => {
    const transport = new FixtureDodoTransport();
    const paid: CheckoutHandlerDeps = {
      config: {
        mode: 'test',
        webhookSecret: `whsec_${Buffer.from('a-thirty-two-byte-endpoint-secret').toString('base64')}`,
        productIds: { prod_single: 'single' },
        returnUrl: `${ORIGIN}/checkout/success`,
      },
      transport,
      submissions,
      guards: guardDeps(),
      keyring: KEYRING,
      now: () => NOW,
    };

    const response = await handleCheckoutCreate(
      new Request(`${ORIGIN}/api/checkout`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
        body: new URLSearchParams({
          url: 'https://example.com/margin',
          name: 'Margin',
          description: MARGIN_TEXT,
          category: CATEGORY_SLUG,
          tier: 'single',
          // The email field is on the same form and the paid path ignores it.
          email: FOUNDER,
          anonymous: 'anonymous',
        }).toString(),
      }),
      paid,
    );

    expect(response.status).toBe(303);
    expect(transport.sessionCount).toBe(1);
    // And the byline the buyer PAID for is honoured, unlike on the free path.
    expect(submissions.rows[0]?.anonymous).toBe(true);
    // No email, no account, no attempt.
    expect(sent).toEqual([]);
    expect(accounts.created).toEqual([]);
    expect(ledger.entries).toEqual([]);
  });
});
