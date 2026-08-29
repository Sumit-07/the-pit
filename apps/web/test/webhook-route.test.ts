/**
 * `POST /api/webhooks/dodo` — the one endpoint that can create an account and an
 * attempt, exercised over HTTP through the real handler.
 *
 * `packages/payments` already proves the DECISIONS with 146 mutation-verified
 * tests. What this file proves is the WIRING, which is where a webhook goes wrong
 * in practice: the route hands the handler a re-serialized body and verification
 * stops working, or the enqueue is fired on the wrong arm, or the idempotency key
 * the whole placement guard hangs off is simply never put on the event.
 *
 * Every assertion below is hand-derived from the seeded fixture:
 *
 * - The seed run is 8 products: 6 juror calls + 1 clustering pass + 4 forced
 *   choices = 11.
 * - A placement is the same shape over one product: 6 + 1 + 4 = 11.
 * - So a submission placed once reads 11 and then 0, and a submission placed
 *   twice reads 11 and 11. The `idempotencyKey` field is the only difference
 *   between those two numbers, which is what makes the last test in this file
 *   fail the moment the enqueue site stops setting it.
 *
 * Offline throughout: no network, no database, no Dodo credentials. The
 * signature is real HMAC-SHA256 over a real Standard Webhooks payload, computed
 * with `signWebhook` — the same function the verifier reads.
 */

import { FixtureClient, type PhaseVersions } from '@the-pit/engine';
import {
  MemoryAuthStore,
  MemoryRateLimiter,
  SESSION_COOKIE_NAME,
  startOAuthSignIn,
  FixtureOAuthProvider,
  verifiedEmail,
  mintCapabilitySlug,
  type SessionKeyring,
} from '@the-pit/auth';
import {
  AttemptsLedger,
  signWebhook,
  type AppendResult,
  type AttemptEntry,
  type AttemptsStore,
  type DodoConfig,
  type DodoEvent,
  type ResolvedAccount,
  type WebhookStore,
} from '@the-pit/payments';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleCapabilityOpen, type CapabilityHandlerDeps } from '@/lib/auth/capability-handlers';
import { handleGitHubCallback, type OAuthHandlerDeps } from '@/lib/auth/oauth-handlers';
import type { PendingSubmission, PlacementQueue } from '@/lib/payments/enqueue';
import { handleDodoWebhookRequest, type DodoWebhookDeps } from '@/lib/payments/webhook-handlers';
import { MemoryCategorySource } from '@/lib/pipeline/catalog';
import { MemoryPlacementClaims } from '@/lib/pipeline/claims';
import { executePlacement, executeRun, type PlacementRequestedData } from '@/lib/pipeline/inngest';
import { CallMeter, RecordingStepRunner } from '@/lib/pipeline/local';
import type { RunnerBindings, RunScope } from '@/lib/pipeline/service';
import { MemorySnapshotSink } from '@/lib/pipeline/snapshot';
import { MemoryPipelineStore, placementScope, type PipelineStore } from '@/lib/pipeline/store';

import {
  CATEGORY,
  CATEGORY_SLUG,
  CATEGORY_VERSION,
  makeJury,
  makePanel,
  makeProducts,
  makeScript,
} from './helpers/panel.js';
import { SEED_SIZE } from './helpers/place.js';

const SECRET = 'whsec_' + Buffer.from('a-thirty-two-byte-endpoint-secret').toString('base64');
const PAYER = 'payer@example.com';
const ORIGIN = 'https://thepit.show';
const SUBMISSION_ID = '11111111-2222-4333-8444-555555555555';

// ---------------------------------------------------------------------------
// In-memory stores. Deliberately as strict as the schema they stand in for.
// ---------------------------------------------------------------------------

/**
 * `WebhookStore`, in memory.
 *
 * `ensureAccount` is an upsert keyed on the address — `accounts_email_uk` — and
 * reports `created` from whether it inserted, which is what `xmax = 0` gives the
 * real one. `recordEvent` is keyed on the event id, so a redelivery is
 * `duplicate` and files no second ticket.
 */
class MemoryWebhookStore implements WebhookStore {
  readonly accounts = new Map<string, string>();
  readonly slugs = new Map<string, string>();
  readonly events = new Map<string, { type: string; outcome: string }>();
  readonly reviews: { eventId: string; reason: string }[] = [];
  #counter = 0;

  ensureAccount(input: { email: string; now: Date }): Promise<ResolvedAccount> {
    const existing = this.accounts.get(input.email);
    if (existing !== undefined) return Promise.resolve({ accountId: existing, created: false });
    this.#counter += 1;
    const accountId = `acct_${this.#counter}`;
    this.accounts.set(input.email, accountId);
    // The webhook is the only thing that creates an account, and it is therefore
    // the only thing that mints a capability slug (`schema/accounts.ts`).
    this.slugs.set(accountId, mintCapabilitySlug());
    return Promise.resolve({ accountId, created: true });
  }

  recordEvent(input: { eventId: string; type: string; receivedAt: Date; outcome: string }): Promise<'recorded' | 'duplicate'> {
    if (this.events.has(input.eventId)) return Promise.resolve('duplicate');
    this.events.set(input.eventId, { type: input.type, outcome: input.outcome });
    return Promise.resolve('recorded');
  }

  queueForReview(input: { eventId: string; reason: string; event: DodoEvent }): Promise<void> {
    this.reviews.push({ eventId: input.eventId, reason: input.reason });
    return Promise.resolve();
  }
}

/**
 * `AttemptsStore`, in memory, enforcing BOTH unique indexes the real table has.
 *
 * The idempotency key is the one `brief §2.2` names, and it catches a redelivered
 * event. `orders_payment_grant_uk` — a partial unique on the payment id over
 * granting rows — is the one it does not, and it is the reason two different
 * event ids for one payment grant once. A fake that enforced only the first
 * would make that case pass here and fail on Neon.
 */
class MemoryAttemptsStore implements AttemptsStore {
  readonly entries: AttemptEntry[] = [];
  readonly keys = new Set<string>();
  readonly grantedPayments = new Set<string>();

  append(entry: AttemptEntry): Promise<AppendResult> {
    const balance = (): number =>
      this.entries.filter((row) => row.accountId === entry.accountId).reduce((sum, row) => sum + row.delta, 0);

    if (this.keys.has(entry.idempotencyKey)) return Promise.resolve({ outcome: 'duplicate', balance: balance() });
    if (entry.reason.kind === 'grant') {
      if (this.grantedPayments.has(entry.reason.providerPaymentId)) {
        return Promise.resolve({ outcome: 'duplicate', balance: balance() });
      }
      this.grantedPayments.add(entry.reason.providerPaymentId);
    }

    this.keys.add(entry.idempotencyKey);
    this.entries.push(entry);
    return Promise.resolve({ outcome: 'appended', balance: balance() });
  }

  balance(accountId: string): Promise<number> {
    return Promise.resolve(
      this.entries.filter((row) => row.accountId === accountId).reduce((sum, row) => sum + row.delta, 0),
    );
  }
}

/** Every event the enqueue site sent, in order. */
class RecordingQueue implements PlacementQueue {
  readonly sent: PlacementRequestedData[] = [];
  send(event: PlacementRequestedData): Promise<void> {
    this.sent.push(event);
    return Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// The fixture wiring
// ---------------------------------------------------------------------------

const DRAFT: PendingSubmission = {
  submissionId: SUBMISSION_ID,
  categorySlug: CATEGORY_SLUG,
  name: 'Margin',
  url: 'https://example.com/margin',
  normalizedUrl: 'example.com/margin',
  description: 'Turns meeting notes into a shared action list without anyone typing one.',
  descriptionHash: 'c'.repeat(64),
  cycleId: '2026-06-01',
  tier: 'single',
  attemptNumber: 1,
  repitchOf: null,
};

function memoryBindings(): {
  bindings: RunnerBindings;
  snapshots: MemorySnapshotSink;
} {
  const stores = new Map<string, MemoryPipelineStore>();
  const snapshots = new MemorySnapshotSink();

  const store = (category: string): PipelineStore => {
    const existing = stores.get(category);
    if (existing !== undefined) return existing;
    const created = new MemoryPipelineStore(category);
    stores.set(category, created);
    return created;
  };

  return {
    snapshots,
    bindings: {
      claims: new MemoryPlacementClaims(),
      categories: new MemoryCategorySource([
        {
          category: CATEGORY,
          products: makeProducts(SEED_SIZE),
          jury: makeJury(),
          personas: makePanel(),
          config: { categoryVersion: CATEGORY_VERSION },
        },
      ]),
      store: (category: string, _versions: PhaseVersions, scope?: RunScope) =>
        store(scope?.placement === undefined ? category : placementScope(category, scope.placement)),
      snapshots,
    },
  };
}

let store: MemoryWebhookStore;
let ledgerStore: MemoryAttemptsStore;
let queue: RecordingQueue;
let bindings: RunnerBindings;
let snapshots: MemorySnapshotSink;
let deps: DodoWebhookDeps;
let submissions: Map<string, PendingSubmission>;

const CONFIG: DodoConfig = {
  mode: 'test',
  webhookSecret: SECRET,
  productIds: {},
  returnUrl: `${ORIGIN}/checkout/success`,
};

beforeEach(() => {
  store = new MemoryWebhookStore();
  ledgerStore = new MemoryAttemptsStore();
  queue = new RecordingQueue();
  submissions = new Map([[SUBMISSION_ID, DRAFT]]);

  const wired = memoryBindings();
  bindings = wired.bindings;
  snapshots = wired.snapshots;

  deps = {
    config: CONFIG,
    store,
    ledgerFor: () =>
      new AttemptsLedger(ledgerStore, () => {
        throw new Error('the webhook may never consume an attempt');
      }),
    placement: {
      submissions: { find: (id) => Promise.resolve(submissions.get(id) ?? null) },
      categories: bindings.categories,
      queue,
    },
  };
});

/** A `payment.succeeded` body in Dodo's shape, with only the fields we read. */
function body(overrides: { eventId?: string; paymentId?: string; amount?: number; type?: string; metadata?: Record<string, string> } = {}): string {
  return JSON.stringify({
    id: overrides.eventId ?? 'evt_1',
    type: overrides.type ?? 'payment.succeeded',
    created_at: '2026-06-01T12:00:00.000Z',
    data: {
      payment_id: overrides.paymentId ?? 'pay_1',
      total_amount: overrides.amount ?? 500,
      currency: 'USD',
      customer: { email: PAYER },
      metadata: overrides.metadata ?? { submission_id: SUBMISSION_ID },
    },
  });
}

/** A correctly signed request, as Dodo would send it. */
function signed(raw: string, options: { id?: string; secret?: string; at?: Date } = {}): Request {
  const id = options.id ?? 'wh_1';
  const timestamp = String(Math.floor((options.at ?? new Date()).getTime() / 1000));
  const signature = signWebhook({ id, timestamp, rawBody: raw, secret: options.secret ?? SECRET });
  return new Request(`${ORIGIN}/api/webhooks/dodo`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'webhook-id': id,
      'webhook-timestamp': timestamp,
      'webhook-signature': `v1,${signature}`,
    },
    body: raw,
  });
}

/** The same body with no signature at all. */
function unsigned(raw: string): Request {
  return new Request(`${ORIGIN}/api/webhooks/dodo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw,
  });
}

// ---------------------------------------------------------------------------

describe('the signature is the gate, and it is checked before anything else', () => {
  it('refuses an unsigned body: no account, no attempt, no event', async () => {
    const response = await handleDodoWebhookRequest(unsigned(body()), deps);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ status: 'rejected' });
    // The three side effects a webhook can have, all absent.
    expect(store.accounts.size).toBe(0);
    expect(ledgerStore.entries).toEqual([]);
    expect(queue.sent).toEqual([]);
  });

  it('refuses a body signed with the wrong secret', async () => {
    const wrong = 'whsec_' + Buffer.from('a-completely-different-endpoint-key').toString('base64');
    const response = await handleDodoWebhookRequest(signed(body(), { secret: wrong }), deps);

    expect(response.status).toBe(400);
    expect(store.accounts.size).toBe(0);
    expect(ledgerStore.entries).toEqual([]);
  });

  it('refuses a body that was edited after it was signed', async () => {
    // The attack the signature exists for: take a real $5 event, change the
    // amount to $15, keep the signature. The HMAC covers the bytes.
    const raw = body({ amount: 500 });
    const request = signed(raw);
    const tampered = new Request(request, { body: raw.replace('"total_amount":500', '"total_amount":1500') });

    const response = await handleDodoWebhookRequest(tampered, deps);
    expect(response.status).toBe(400);
    expect(ledgerStore.entries).toEqual([]);
  });

  it('refuses a signature whose timestamp is outside the tolerance window', async () => {
    const old = new Date(Date.now() - 60 * 60 * 1000);
    const response = await handleDodoWebhookRequest(signed(body(), { at: old }), deps);

    expect(response.status).toBe(400);
    expect(store.accounts.size).toBe(0);
  });

  it('answers 400 rather than 200, so Dodo keeps retrying and the alarm fires', async () => {
    // 200 tells Dodo to stop. A body we could not verify must never get one.
    const response = await handleDodoWebhookRequest(unsigned(body()), deps);
    expect(response.status).not.toBe(200);
  });
});

describe('a settled payment', () => {
  it('creates the account from the email Dodo verified, and grants the tier', async () => {
    const response = await handleDodoWebhookRequest(signed(body()), deps);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'granted' });
    expect([...store.accounts.keys()]).toEqual([PAYER]);
    expect(ledgerStore.entries).toHaveLength(1);
    expect(ledgerStore.entries[0]?.delta).toBe(1);
  });

  it('grants three for the $15 tier', async () => {
    await handleDodoWebhookRequest(signed(body({ amount: 1500 })), deps);
    expect(ledgerStore.entries[0]?.delta).toBe(3);
    expect(ledgerStore.entries[0]?.reason).toMatchObject({ kind: 'grant', tier: 'triple' });
  });

  it('mints a capability slug the customer can reach the account with', async () => {
    await handleDodoWebhookRequest(signed(body()), deps);
    const accountId = store.accounts.get(PAYER) ?? '';
    expect(store.slugs.get(accountId)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('tells the caller nothing about the account it just made', async () => {
    // The reply goes to whoever posted the request. Before verification that is
    // anybody, and after it there is still no reason to hand back an id.
    const response = await handleDodoWebhookRequest(signed(body()), deps);
    const text = await response.text();
    expect(text).not.toContain(PAYER);
    expect(text).not.toContain('acct_');
  });

  it('routes an amount it does not price to a human instead of dividing by 500', async () => {
    const response = await handleDodoWebhookRequest(signed(body({ amount: 4000 })), deps);

    expect(await response.json()).toEqual({ status: 'needs_review' });
    expect(ledgerStore.entries).toEqual([]);
    expect(store.reviews.map((review) => review.reason)).toEqual([
      'unrecognised amount 4000 USD',
    ]);
  });

  it('records a dispute and files exactly one ticket however many times it is redelivered', async () => {
    const raw = body({ eventId: 'evt_d', type: 'dispute.opened' });
    await handleDodoWebhookRequest(signed(raw), deps);
    await handleDodoWebhookRequest(signed(raw), deps);

    expect(store.reviews).toHaveLength(1);
    expect(ledgerStore.entries).toEqual([]);
  });
});

describe('idempotency: Dodo retries', () => {
  it('grants nothing the second time the same event id arrives', async () => {
    const raw = body();
    const first = await handleDodoWebhookRequest(signed(raw), deps);
    const second = await handleDodoWebhookRequest(signed(raw), deps);

    expect(await first.json()).toEqual({ status: 'granted' });
    expect(await second.json()).toEqual({ status: 'duplicate' });
    expect(ledgerStore.entries).toHaveLength(1);
    expect(await ledgerStore.balance(store.accounts.get(PAYER) ?? '')).toBe(1);
  });

  it('grants once when one payment arrives under two different event ids', async () => {
    // The case the event id cannot catch: a retry re-enveloped with a fresh id,
    // or an authorize/settle pair. `orders_payment_grant_uk` is what closes it.
    await handleDodoWebhookRequest(signed(body({ eventId: 'evt_a' })), deps);
    const second = await handleDodoWebhookRequest(signed(body({ eventId: 'evt_b' })), deps);

    expect(await second.json()).toEqual({ status: 'duplicate' });
    expect(ledgerStore.entries).toHaveLength(1);
    expect(await ledgerStore.balance(store.accounts.get(PAYER) ?? '')).toBe(1);
  });

  it('resolves the same account for a second, genuinely new payment', async () => {
    await handleDodoWebhookRequest(signed(body({ eventId: 'evt_a', paymentId: 'pay_a' })), deps);
    await handleDodoWebhookRequest(signed(body({ eventId: 'evt_b', paymentId: 'pay_b' })), deps);

    expect(store.accounts.size).toBe(1);
    expect(await ledgerStore.balance(store.accounts.get(PAYER) ?? '')).toBe(2);
  });
});

describe('the enqueue', () => {
  it('fires exactly one placement event, carrying the submission', async () => {
    await handleDodoWebhookRequest(signed(body()), deps);

    expect(queue.sent).toHaveLength(1);
    expect(queue.sent[0]?.slug).toBe(CATEGORY_SLUG);
    expect(queue.sent[0]?.product.name).toBe('Margin');
    expect(queue.sent[0]?.categoryVersion).toBe(CATEGORY_VERSION);
  });

  it('puts an idempotency key on the event', async () => {
    // The field the whole placement guard hangs off. Without it `PlacementClaims`
    // is inert on the real path — see the last describe in this file for what
    // that costs.
    await handleDodoWebhookRequest(signed(body()), deps);
    expect(queue.sent[0]?.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives the submission an engine id that does not collide with the roster', async () => {
    // `Product.id` is the key every stored score, cluster and vote attaches to,
    // and `assertPlaceable` refuses a collision. Eight seeded products hold 0-7.
    await handleDodoWebhookRequest(signed(body()), deps);
    expect(queue.sent[0]?.product.id).toBe(SEED_SIZE);
  });

  it('fires on a REDELIVERY too, so a crash between grant and enqueue is recoverable', async () => {
    // The grant is idempotent and the enqueue is separately idempotent, so the
    // failure worth protecting against is the one where the first delivery
    // granted and died. Skipping the enqueue on `duplicate` would leave the
    // customer with an attempt and no run, permanently and silently.
    const raw = body();
    await handleDodoWebhookRequest(signed(raw), deps);
    await handleDodoWebhookRequest(signed(raw), deps);

    expect(queue.sent).toHaveLength(2);
    expect(queue.sent[0]?.idempotencyKey).toBe(queue.sent[1]?.idempotencyKey);
    // And still one grant behind them.
    expect(ledgerStore.entries).toHaveLength(1);
  });

  it('parks a paid submission it cannot enqueue rather than losing it', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    submissions.clear();

    const response = await handleDodoWebhookRequest(signed(body()), deps);

    // The money still landed: a 500 here would ask Dodo to redeliver a charge we
    // already recorded, and answering 200 with nothing queued would lose the run.
    expect(await response.json()).toEqual({ status: 'granted' });
    expect(ledgerStore.entries).toHaveLength(1);
    expect(store.reviews[0]?.reason).toContain('placement not enqueued');
    errors.mockRestore();
  });

  it('does not enqueue for an event that granted nothing', async () => {
    await handleDodoWebhookRequest(signed(body({ type: 'payment.failed' })), deps);
    expect(queue.sent).toEqual([]);
  });
});

describe('the key is not decoration: one payment buys one pipeline', () => {
  /** Seed the category so a placement has stored scores, clusters and votes to append to. */
  async function seed(): Promise<void> {
    await executeRun(
      { slug: CATEGORY_SLUG },
      bindings,
      new RecordingStepRunner(),
      undefined,
      new FixtureClient(makeScript()),
    );
  }

  /** Run one placement event and report what it spent. */
  async function place(event: PlacementRequestedData): Promise<number> {
    const meter = new CallMeter(new FixtureClient(makeScript()));
    await executePlacement(event, bindings, new RecordingStepRunner(), undefined, meter);
    return meter.total;
  }

  it('runs the pipeline ONCE for the event the webhook sent twice', async () => {
    await seed();
    expect(snapshots.published).toHaveLength(1);

    const raw = body();
    await handleDodoWebhookRequest(signed(raw), deps);
    await handleDodoWebhookRequest(signed(raw), deps);
    expect(queue.sent).toHaveLength(2);

    // 6 juror calls + 1 clustering pass + 4 forced choices.
    expect(await place(queue.sent[0] as PlacementRequestedData)).toBe(11);
    // The second event carries the population version the first placement bumped
    // — a genuinely different RUN, not an executor retry, which is exactly the
    // shape the double-placement takes (`brief §1.2`).
    const second = { ...(queue.sent[1] as PlacementRequestedData), categoryVersion: 'cat-v2' };
    expect(await place(second)).toBe(0);

    // One board republish, one delivery, one $5.
    expect(snapshots.published).toHaveLength(2);
  });

  it('runs it TWICE if the key is dropped — which is what the field is preventing', async () => {
    // The control, and the reason the test above is not vacuous. Strip the one
    // field the enqueue site sets and the same two events cost twelve juror
    // calls, two clustering passes and two persona rounds for one payment. The
    // customer is not double-charged (`brief §2.3` consumes on delivery), so it
    // never becomes a support ticket — only an inference bill that does not match
    // the sales count.
    await seed();

    const raw = body();
    await handleDodoWebhookRequest(signed(raw), deps);
    await handleDodoWebhookRequest(signed(raw), deps);

    const stripped = (event: PlacementRequestedData): PlacementRequestedData => {
      const { idempotencyKey: _dropped, ...rest } = event;
      return rest;
    };

    expect(await place(stripped(queue.sent[0] as PlacementRequestedData))).toBe(11);
    expect(
      await place({ ...stripped(queue.sent[1] as PlacementRequestedData), categoryVersion: 'cat-v2' }),
    ).toBe(11);
  });
});

describe('a guest purchase, later linked to GitHub, is one account', () => {
  it('converges on the row the webhook made, and does not open a second', async () => {
    // The mobile story end to end: pay as a guest, reach the account through the
    // capability URL, connect GitHub afterwards with an address that bought
    // nothing, then sign in from a laptop with no cookie at all.
    const identity = new MemoryAuthStore();
    const limiter = new MemoryRateLimiter();
    const keyring: SessionKeyring = ['test-secret-0123456789abcdef0123456789abcdef0123456789abcdef01'];
    const provider = new FixtureOAuthProvider();
    provider.setEmails('4242', [verifiedEmail('personal@example.com', true)]);

    // The webhook is the ONLY thing that creates an account. `seedAccount` is
    // this store's stand-in for exactly that call, named so it can never be
    // mistaken for something an auth path may do.
    await handleDodoWebhookRequest(signed(body()), deps);
    const accountId = store.accounts.get(PAYER) ?? '';
    const slug = store.slugs.get(accountId) ?? '';
    identity.seedAccount(PAYER, accountId, slug);

    const capability: CapabilityHandlerDeps = {
      origin: ORIGIN,
      capability: { store: identity, limiter, keyring },
    };
    const oauth: OAuthHandlerDeps = {
      redirectUri: `${ORIGIN}/auth/github/callback`,
      oauth: { provider, store: identity, limiter, keyring },
    };

    const opened = await handleCapabilityOpen(
      new Request(`${ORIGIN}/a/${slug}`, { headers: { 'x-vercel-forwarded-for': '203.0.113.9' } }),
      slug,
      capability,
    );
    expect(opened.status).toBe(303);
    expect(opened.headers.get('location')).toBe('/account');
    const session = (opened.headers.get('set-cookie') ?? '').split(';')[0] ?? '';

    const started = startOAuthSignIn(
      { redirectUri: oauth.redirectUri, now: new Date(), cookieHeader: session },
      oauth.oauth,
    );
    const state = new URL(started.authorizationUrl).searchParams.get('state') ?? '';
    const linked = await handleGitHubCallback(
      new Request(`${ORIGIN}/auth/github/callback?code=good-code&state=${state}`, {
        headers: {
          cookie: `${session}; ${(started.setCookie ?? '').split(';')[0]}`,
          'x-vercel-forwarded-for': '203.0.113.9',
        },
      }),
      oauth,
    );
    expect(linked.status).toBe(303);

    // One account, and GitHub now reaches it from a device with no cookie.
    expect(identity.accountCount).toBe(1);
    const fresh = startOAuthSignIn({ redirectUri: oauth.redirectUri, now: new Date() }, oauth.oauth);
    const freshState = new URL(fresh.authorizationUrl).searchParams.get('state') ?? '';
    const laptop = await handleGitHubCallback(
      new Request(`${ORIGIN}/auth/github/callback?code=good-code&state=${freshState}`, {
        headers: {
          cookie: (fresh.setCookie ?? '').split(';')[0] ?? '',
          'x-vercel-forwarded-for': '203.0.113.9',
        },
      }),
      oauth,
    );
    expect(laptop.status).toBe(303);
    expect(laptop.headers.getSetCookie().some((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`))).toBe(true);
    expect(identity.accountCount).toBe(1);
  });
});
