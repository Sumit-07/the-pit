/**
 * `brief §2.5`'s shortener resolution, wired through the whole submission path —
 * and the one test that proves it is wired through ALL of it.
 *
 * ## What was broken, and why half a fix was worse than none
 *
 * The per-product cap (`brief §2.4`, one pitch per product per recalibration
 * cycle) hangs off a normalized URL. Every other `§2.5` rule collapses a
 * *spelling* — casing, `www.`, the trailing slash, the query string. A shortener
 * is not a spelling: `bit.ly/3xYz` and `ledger.example/pricing` share no bytes,
 * so they were two products and the cap was one short link from free.
 *
 * `@the-pit/fetch` closed the resolution. The danger in *using* it was that the
 * key is read in five places and derived in two: `runSubmissionGuards` looks the
 * listing up, and `checkSubmissionLocal` used to re-normalize `draft.url` and
 * mint the `SubmissionClearance` from THAT string. Resolving only in the first
 * would have consulted the target and then recorded the shortener — in the Dodo
 * metadata, on the `submissions` row, in `jobIdempotencyKey`, and in the
 * `products.normalized_url` the placement writes. A system that disagrees with
 * itself about which product a submission is would be worse than one that is
 * merely evadable, which is why `all five sites carry the resolved key` below is
 * the most load-bearing test in this file. It fails if ANY one of them still uses
 * the raw input.
 *
 * ## Everything is hand-derived, and offline
 *
 *   NOW              2026-06-01T20:00:00Z
 *   rebuild          02:00 UTC (`NIGHTLY_REBUILD`)
 *   current cycle    2026-06-01T02:00Z → 2026-06-02T02:00Z, id `2026-06-01`
 *
 *   submitted                          resolves to                    key
 *   https://bit.ly/3xYzAbC             https://www.ledger.example/    ledger.example/pricing
 *                                        pricing?ref=42
 *   https://ledger.example/pricing     (no redirect)                  ledger.example/pricing
 *   https://beacon.sh/status           (no redirect)                  beacon.sh/status
 *
 * The two shortener spellings landing on one key is the whole feature; the third
 * URL is the control that proves the resolver is not simply collapsing
 * everything onto one string.
 *
 * No socket is opened anywhere: the resolver is a `Map` (`helpers/url-resolver`),
 * the Dodo transport is `FixtureDodoTransport`, and the stores are `Map`s. The
 * one suite that exercises the REAL `resolveSubmissionUrl` installs a fake
 * `GuardedFetcher` through `registerProductUrlFetcher`, exactly as
 * `packages/fetch`'s own tests fake their transport.
 */

import {
  FixtureDodoTransport,
  jobIdempotencyKey,
  type DodoConfig,
  type ListingSnapshot,
} from '@the-pit/payments';
import type { FetchOutcome, FetchedAsset, FetchedDocument, FetchRefusalCode, GuardedFetcher, ResolvedTarget } from '@the-pit/fetch';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runSubmissionGuards, type ListingLookup, type SubmissionGuardDeps } from '@/lib/checkout/guards';
import { handleCheckoutCreate, type CheckoutHandlerDeps } from '@/lib/checkout/handlers';
import { registerProductUrlFetcher, resetProductUrlWiring, resolveSubmissionUrl } from '@/lib/ingest/product-url';
import { enqueuePlacementForPayment, type PendingSubmission, type PlacementQueue } from '@/lib/payments/enqueue';
import { MemoryCategorySource } from '@/lib/pipeline/catalog';
import type { PlacementRequestedData } from '@/lib/pipeline/inngest';

import { CATEGORY, CATEGORY_SLUG, CATEGORY_VERSION, makeJury, makePanel, makeProducts } from './helpers/panel.js';
import { SEED_SIZE } from './helpers/place.js';
import { fakeUrlResolver, type FakeUrlResolver } from './helpers/url-resolver.js';

const ORIGIN = 'https://thepit.show';
const PAYER = 'payer@example.com';
const ACCOUNT = 'acct_founder';
const NOW = new Date('2026-06-01T20:00:00.000Z');
/** The cycle `NOW` falls in — `2026-06-01T02:00Z` to `2026-06-02T02:00Z`. */
const CYCLE_ID = '2026-06-01';

const SHORT_URL = 'https://bit.ly/3xYzAbC';
const TARGET_URL = 'https://www.ledger.example/pricing?ref=42';
const DIRECT_URL = 'https://ledger.example/pricing';
/** What all three of the above must agree on. Derived by hand from `§2.5`'s rules. */
const RESOLVED_KEY = 'ledger.example/pricing';
/** What the offline normalizer alone would have produced for the short link. */
const UNRESOLVED_KEY = 'bit.ly/3xyzabc';

const OTHER_URL = 'https://beacon.sh/status';
const OTHER_KEY = 'beacon.sh/status';

const LEDGER_TEXT = 'Reconciles every invoice against the bank feed and flags the ones that do not match.';
const REWRITTEN_TEXT = 'Watches your payment processor, drafts the chase email, and books whatever finally arrives.';

const SECRET = 'whsec_' + Buffer.from('a-thirty-two-byte-endpoint-secret').toString('base64');
const CONFIG: DodoConfig = {
  mode: 'test',
  webhookSecret: SECRET,
  productIds: { prod_single: 'single', prod_triple: 'triple' },
  returnUrl: `${ORIGIN}/checkout/success`,
};

// ---------------------------------------------------------------------------
// Stores, in memory and no more permissive than the schema they stand for.
// ---------------------------------------------------------------------------

/** Keyed on the normalized URL and on nothing else — the cap is per product. */
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

class MemorySubmissions {
  readonly rows: PendingSubmission[] = [];
  #counter = 0;

  create(draft: Omit<PendingSubmission, 'submissionId'> & { now: Date }): Promise<string> {
    this.#counter += 1;
    const submissionId = `11111111-2222-4333-8444-${String(this.#counter).padStart(12, '0')}`;
    const { now: _now, ...rest } = draft;
    this.rows.push({ ...rest, submissionId });
    return Promise.resolve(submissionId);
  }

  find(submissionId: string): Promise<PendingSubmission | null> {
    return Promise.resolve(this.rows.find((row) => row.submissionId === submissionId) ?? null);
  }
}

class RecordingQueue implements PlacementQueue {
  readonly sent: PlacementRequestedData[] = [];
  send(event: PlacementRequestedData): Promise<void> {
    this.sent.push(event);
    return Promise.resolve();
  }
}

/**
 * What the placement will eventually write, as the board the NEXT submission
 * meets.
 *
 * Built from the enqueued event rather than from the test's own idea of the key,
 * so the second submission is checked against whatever the first one actually
 * recorded. If the wiring banked the wrong identity, this row lands under it and
 * the cap test fails for the right reason.
 */
function listingFromEvent(event: PlacementRequestedData, pitchedAt: Date, description: string): ListingSnapshot {
  return {
    listingId: `prod_${event.product.normalized_url}`,
    accountId: event.payer?.accountId ?? ACCOUNT,
    normalizedUrl: event.product.normalized_url,
    categorySlug: event.slug,
    description,
    descriptionHash: 'a'.repeat(64),
    attemptNumber: event.payer?.attemptNumber ?? 1,
    lastPitchedAt: pitchedAt,
    clusterId: null,
    currentVerdictId: null,
  };
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

let listings: MemoryListings;
let submissions: MemorySubmissions;
let transport: FixtureDodoTransport;
let queue: RecordingQueue;
let resolver: FakeUrlResolver;
let deps: CheckoutHandlerDeps;

function guardDeps(): SubmissionGuardDeps {
  return {
    listings,
    resolveUrl: resolver.resolve,
    candidateCategories: () => Promise.resolve([CATEGORY_SLUG]),
  };
}

beforeEach(() => {
  listings = new MemoryListings();
  submissions = new MemorySubmissions();
  transport = new FixtureDodoTransport();
  queue = new RecordingQueue();
  // `bit.ly/3xYzAbC` points at the ledger's pricing page. `beacon.sh` points
  // nowhere and is a different product.
  resolver = fakeUrlResolver({ redirects: { [SHORT_URL]: TARGET_URL } });

  deps = {
    config: CONFIG,
    transport,
    submissions,
    guards: guardDeps(),
    now: () => NOW,
  };
});

afterEach(() => {
  resetProductUrlWiring();
});

interface Submitted {
  readonly url?: string;
  readonly description?: string;
  readonly name?: string;
}

function post(values: Submitted = {}): Request {
  const body = new URLSearchParams({
    url: values.url ?? DIRECT_URL,
    name: values.name ?? 'Ledger',
    description: values.description ?? LEDGER_TEXT,
    category: CATEGORY_SLUG,
    tier: 'single',
  });
  return new Request(`${ORIGIN}/api/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
    body: body.toString(),
  });
}

function categories(): MemoryCategorySource {
  return new MemoryCategorySource([
    {
      category: CATEGORY,
      products: makeProducts(SEED_SIZE),
      jury: makeJury(),
      personas: makePanel(),
      config: { categoryVersion: CATEGORY_VERSION },
    },
  ]);
}

/**
 * Buy, then settle: `POST /api/checkout` and then the enqueue the webhook drives.
 *
 * Returns the metadata Dodo would have carried back, so the assertions can read
 * the clearance's own copy of the key rather than a re-derivation of it.
 */
async function buyAndSettle(values: Submitted = {}): Promise<{
  readonly status: number;
  readonly metadata: Record<string, string>;
  readonly event: PlacementRequestedData | undefined;
}> {
  const response = await handleCheckoutCreate(post(values), deps);
  const metadata = { ...(transport.calls[transport.calls.length - 1]?.metadata ?? {}) };
  if (response.status !== 303) return { status: response.status, metadata, event: undefined };

  const result = await enqueuePlacementForPayment(
    { metadata, accountId: ACCOUNT, email: PAYER },
    { categories: categories(), queue, submissions, guards: guardDeps(), now: () => NOW },
  );
  expect(result.enqueued).toBe(true);
  return { status: response.status, metadata, event: queue.sent[queue.sent.length - 1] };
}

// ---------------------------------------------------------------------------

describe('the partial-wiring guard: one key, computed once, used everywhere', () => {
  it('carries the resolved key to all five places the identity is written', async () => {
    // THE test. Five sites read or write the product's identity, and before this
    // change two of them derived it independently. Every expectation below is the
    // same string, and every one of them was `bit.ly/3xyzabc` under partial
    // wiring — so this fails if any single site regresses, which is the whole
    // reason it enumerates them rather than checking one.
    const { metadata, event } = await buyAndSettle({ url: SHORT_URL });

    // 1. the guard's listing lookup — what the cap was enforced against. Three
    //    lookups, hand-derived: the resolved key at checkout; then, because the
    //    URL changed hosts and that first lookup found nothing, the submitted key
    //    (which is what joins a row written before the backfill ran); then the
    //    resolved key again at the pre-enqueue re-check. The FIRST one is the
    //    cap, and it is the target's.
    expect(listings.lookups[0]).toBe(RESOLVED_KEY);
    expect(listings.lookups).toEqual([RESOLVED_KEY, UNRESOLVED_KEY, RESOLVED_KEY]);

    // 2. the SubmissionClearance, as it reaches Dodo's metadata
    expect(metadata['normalized_url']).toBe(RESOLVED_KEY);

    // 3. the `submissions` row, written from the clearance and read back after
    //    the payment settles
    expect(submissions.rows).toHaveLength(1);
    expect(submissions.rows[0]?.normalizedUrl).toBe(RESOLVED_KEY);
    // The RAW url is still stored verbatim — it is what the submitter typed and
    // it is never the key for anything. Losing it would lose the audit trail.
    expect(submissions.rows[0]?.url).toBe(SHORT_URL);

    // 4. `jobIdempotencyKey` — the run's identity
    expect(event?.idempotencyKey).toBe(
      jobIdempotencyKey({
        accountId: ACCOUNT,
        normalizedUrl: RESOLVED_KEY,
        descriptionHash: submissions.rows[0]?.descriptionHash ?? '',
        cycleId: CYCLE_ID,
      }),
    );
    // And it is a DIFFERENT key from the one the raw input would have produced,
    // which is what makes the assertion above discriminating rather than
    // tautological.
    expect(event?.idempotencyKey).not.toBe(
      jobIdempotencyKey({
        accountId: ACCOUNT,
        normalizedUrl: UNRESOLVED_KEY,
        descriptionHash: submissions.rows[0]?.descriptionHash ?? '',
        cycleId: CYCLE_ID,
      }),
    );

    // 5. `products.normalized_url`, as the placement will write it
    expect(event?.product.normalized_url).toBe(RESOLVED_KEY);
    // The submitted address survives on its own column, as `schema/products.ts`
    // requires: `url` is verbatim, `normalized_url` is the identity.
    expect(event?.product.url).toBe(SHORT_URL);
  });

  it('agrees with the direct submission of the same product, site for site', async () => {
    // The other half of "one product": a shortener and a typed URL must produce
    // identical values everywhere, not merely values that both happen to pass.
    const short = await buyAndSettle({ url: SHORT_URL });
    listings.lookups.length = 0;
    submissions.rows.length = 0;
    queue.sent.length = 0;

    const direct = await buyAndSettle({ url: DIRECT_URL });

    expect(short.metadata['normalized_url']).toBe(direct.metadata['normalized_url']);
    expect(short.event?.product.normalized_url).toBe(direct.event?.product.normalized_url);
    expect(short.event?.idempotencyKey).toBe(direct.event?.idempotencyKey);
    // The typed URL changes no host, so there is no second identity to ask
    // about: one lookup at checkout and one at the re-check, both resolved.
    expect(listings.lookups).toEqual([RESOLVED_KEY, RESOLVED_KEY]);
  });
});

describe('brief §2.4 + §2.5: the cap catches a shortener and its target as ONE product', () => {
  it('cycle-locks a short link submitted after the product it points at', async () => {
    // The end-to-end case that fails without this change. The first pitch is the
    // typed URL; the second is a fresh `bit.ly` link for the same page, which is
    // exactly how the cap was evaded.
    const first = await buyAndSettle({ url: DIRECT_URL });
    expect(first.status).toBe(303);
    expect(first.event).toBeDefined();

    // The board as the placement leaves it: one paid listing, pitched tonight.
    listings.add(listingFromEvent(first.event as PlacementRequestedData, NOW, LEDGER_TEXT));

    const second = await handleCheckoutCreate(post({ url: SHORT_URL, description: REWRITTEN_TEXT }), deps);

    expect(second.status).toBe(422);
    // Before payment, and therefore before any money moved: no second session
    // was opened and no second `submissions` row was written.
    expect(transport.sessionCount).toBe(1);
    expect(submissions.rows).toHaveLength(1);
    const page = await second.text();
    expect(page).toContain('Not charged');
  });

  it('cycle-locks the target submitted after the short link, which is the same rule backwards', async () => {
    const first = await buyAndSettle({ url: SHORT_URL });
    listings.add(listingFromEvent(first.event as PlacementRequestedData, NOW, LEDGER_TEXT));

    const second = await handleCheckoutCreate(post({ url: DIRECT_URL, description: REWRITTEN_TEXT }), deps);

    expect(second.status).toBe(422);
    expect(transport.sessionCount).toBe(1);
  });

  it('leaves two genuinely different products alone', async () => {
    // The control. A cap that collapsed everything onto one key would pass both
    // tests above and would be worthless; this is what stops it.
    const first = await buyAndSettle({ url: DIRECT_URL });
    listings.add(listingFromEvent(first.event as PlacementRequestedData, NOW, LEDGER_TEXT));

    const second = await buyAndSettle({ url: OTHER_URL, description: REWRITTEN_TEXT });

    expect(second.status).toBe(303);
    expect(second.event?.product.normalized_url).toBe(OTHER_KEY);
    expect(second.event?.idempotencyKey).not.toBe(first.event?.idempotencyKey);
    expect(transport.sessionCount).toBe(2);
  });
});

describe('the resolution is not a hard dependency of paying', () => {
  it('lets an unreachable ORDINARY site through on its offline key, and flags it', async () => {
    // The stated policy. `brief §2.5`: "a false rejection on a paying customer is
    // worse than an extra run", so a product site being down for thirty seconds
    // must not cost a pitch. The key falls back to the offline one and
    // `url_unresolved` goes to the review queue instead.
    resolver = fakeUrlResolver({ unreachable: { [DIRECT_URL]: 'timeout after 5000ms' } });
    deps = { ...deps, guards: guardDeps() };

    const checked = await runSubmissionGuards(
      { draft: { url: DIRECT_URL, name: 'Ledger', description: LEDGER_TEXT, categorySlug: CATEGORY_SLUG }, now: NOW, accountId: null },
      guardDeps(),
    );

    expect(checked.status).toBe('accepted');
    if (checked.status === 'accepted') {
      expect(checked.clearance.normalizedUrl).toBe(RESOLVED_KEY);
      expect(checked.clearance.flags).toContain('url_unresolved');
    }

    // And the money path agrees: the checkout opens.
    const response = await handleCheckoutCreate(post({ url: DIRECT_URL }), deps);
    expect(response.status).toBe(303);
    expect(transport.sessionCount).toBe(1);
  });

  it('REFUSES a known shortener that cannot be followed, because falling back reopens the hole', async () => {
    // The exception, and the reason it is an exception: keying on `bit.ly/3xYz`
    // because bit.ly timed out is the evasion route reopening itself. Proved
    // against the REAL `resolveSubmissionUrl` over a fake fetcher, because this
    // is where the policy actually lives.
    registerProductUrlFetcher(fakeFetcher({}));

    const refused = await resolveSubmissionUrl(SHORT_URL);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.rejection.code).toBe('url_unfetchable');
      expect(refused.rejection.message).toContain('short link');
    }

    // The same fetcher, the same failure, an ordinary host: accepted and flagged.
    const flagged = await resolveSubmissionUrl(DIRECT_URL);
    expect(flagged.ok).toBe(true);
    if (flagged.ok) {
      expect(flagged.resolved.normalizedUrl).toBe(RESOLVED_KEY);
      expect(flagged.resolved.flags).toEqual(['url_unresolved']);
    }
  });

  it('refuses a URL that points somewhere that is not the public internet, however it is reached', async () => {
    // A SECURITY refusal never falls back, on any host. `blocked_address` here
    // stands for the whole class `packages/fetch` enumerates.
    registerProductUrlFetcher(fakeFetcher({ 'https://ledger.example/pricing': { refuse: 'blocked_address' } }));

    const result = await resolveSubmissionUrl(DIRECT_URL);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejection.code).toBe('url_unfetchable');
  });

  it('turns a resolver that THROWS into a flag, not a 500 on the money path', async () => {
    // `resolveProductUrl` returns refusals as values, so this should be
    // unreachable — which is exactly why it is worth pinning. An unforeseen throw
    // on the purchase path must degrade the way a timeout does.
    registerProductUrlFetcher({
      resolveFinal: () => Promise.reject(new Error('the DNS library exploded')),
      fetchDocument: () => Promise.reject(new Error('the DNS library exploded')),
      fetchAsset: () => Promise.reject(new Error('the DNS library exploded')),
    });

    const result = await resolveSubmissionUrl(DIRECT_URL);

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolved.flags).toEqual(['url_unresolved']);

    // Except on a shortener, where the fallback is the hole.
    const shortener = await resolveSubmissionUrl(SHORT_URL);
    expect(shortener.ok).toBe(false);
  });
});

describe('after the money moves, nothing is re-resolved', () => {
  it('runs the pre-enqueue re-check on the key the buyer paid under, with no resolver call at all', async () => {
    // The strongest form of the timeout policy: once a payment has settled, no
    // network condition can re-key the product or block the run it bought. The
    // re-check still runs — it just runs against the banked identity.
    const response = await handleCheckoutCreate(post({ url: SHORT_URL }), deps);
    expect(response.status).toBe(303);
    expect(resolver.calls).toEqual([SHORT_URL]);

    const metadata = { ...(transport.calls[0]?.metadata ?? {}) };
    const before = resolver.calls.length;

    const result = await enqueuePlacementForPayment(
      { metadata, accountId: ACCOUNT, email: PAYER },
      { categories: categories(), queue, submissions, guards: guardDeps(), now: () => NOW },
    );

    expect(result.enqueued).toBe(true);
    // Zero further calls. A resolution here could refuse a paid submission
    // because a shortener was slow at settlement.
    expect(resolver.calls).toHaveLength(before);
    // And the re-check asks about ONE key — the banked one. There is no second
    // lookup here, because there was no resolution to raise `url_redirected`.
    expect(listings.lookups).toEqual([RESOLVED_KEY, UNRESOLVED_KEY, RESOLVED_KEY]);
    expect(queue.sent[0]?.product.normalized_url).toBe(RESOLVED_KEY);
  });

  it('still re-runs the cap against the board as it stands at settlement', async () => {
    // Not resolving is not the same as not checking. A pitch that was clear at
    // checkout and is cycle-locked when the payment lands must still stop.
    const response = await handleCheckoutCreate(post({ url: SHORT_URL }), deps);
    expect(response.status).toBe(303);
    const metadata = { ...(transport.calls[0]?.metadata ?? {}) };

    // Somebody else's paid pitch for the same product landed in the meantime.
    listings.add({
      listingId: 'prod_ledger',
      accountId: ACCOUNT,
      normalizedUrl: RESOLVED_KEY,
      categorySlug: CATEGORY_SLUG,
      description: LEDGER_TEXT,
      descriptionHash: 'a'.repeat(64),
      attemptNumber: 1,
      lastPitchedAt: NOW,
      clusterId: null,
      currentVerdictId: null,
    });

    const result = await enqueuePlacementForPayment(
      { metadata, accountId: ACCOUNT, email: PAYER },
      { categories: categories(), queue, submissions, guards: guardDeps(), now: () => NOW },
    );

    expect(result.enqueued).toBe(false);
    expect(queue.sent).toEqual([]);
  });
});

describe('the cross-host rule, and the domain that genuinely moved', () => {
  it('keeps a product’s history when its site starts redirecting to a new domain', async () => {
    // The cost of adopting a cross-host destination: `myapp.com` moves to
    // `myapp.dev` and the key moves with it, so the old row is orphaned and the
    // product could pitch twice in one cycle. `brief §2.5` says an extra run is
    // the cheaper mistake, so the rule stays — but the re-key is observable, and
    // the second lookup under the SUBMITTED key is what makes the history follow.
    listings.add({
      listingId: 'prod_myapp',
      accountId: ACCOUNT,
      normalizedUrl: 'myapp.com',
      categorySlug: CATEGORY_SLUG,
      description: LEDGER_TEXT,
      descriptionHash: 'a'.repeat(64),
      attemptNumber: 1,
      lastPitchedAt: NOW,
      clusterId: null,
      currentVerdictId: null,
    });
    resolver = fakeUrlResolver({ redirects: { 'https://myapp.com': 'https://myapp.dev' } });

    const checked = await runSubmissionGuards(
      { draft: { url: 'https://myapp.com', name: 'MyApp', description: REWRITTEN_TEXT, categorySlug: CATEGORY_SLUG }, now: NOW, accountId: null },
      guardDeps(),
    );

    // Both keys were consulted, resolved first.
    expect(listings.lookups).toEqual(['myapp.dev', 'myapp.com']);
    // And the cap fired, on the row from before the move.
    expect(checked.status).toBe('rejected');
    if (checked.status === 'rejected') expect(checked.rejection.code).toBe('cycle_locked');
  });

  it('does not consult the submitted key when the resolved one found a listing', async () => {
    // The fallback must be able only to TIGHTEN the cap. It runs when the first
    // lookup found nothing, so there was no cap to relax; if it ran otherwise it
    // could pick a different product's row.
    listings.add({
      listingId: 'prod_ledger',
      accountId: ACCOUNT,
      normalizedUrl: RESOLVED_KEY,
      categorySlug: CATEGORY_SLUG,
      description: LEDGER_TEXT,
      descriptionHash: 'a'.repeat(64),
      attemptNumber: 1,
      lastPitchedAt: NOW,
      clusterId: null,
      currentVerdictId: null,
    });

    await runSubmissionGuards(
      { draft: { url: SHORT_URL, name: 'Ledger', description: REWRITTEN_TEXT, categorySlug: CATEGORY_SLUG }, now: NOW, accountId: null },
      guardDeps(),
    );

    expect(listings.lookups).toEqual([RESOLVED_KEY]);
  });

  it('does not consult a second key when the URL did not change hosts', async () => {
    // A same-host redirect is a site tidying its own path, not a pointer. There
    // is no second identity to look under, and asking would be a wasted query on
    // the money path.
    resolver = fakeUrlResolver({ redirects: { [DIRECT_URL]: 'https://ledger.example/en/pricing' } });

    await runSubmissionGuards(
      { draft: { url: DIRECT_URL, name: 'Ledger', description: LEDGER_TEXT, categorySlug: CATEGORY_SLUG }, now: NOW, accountId: null },
      guardDeps(),
    );

    expect(listings.lookups).toEqual([RESOLVED_KEY]);
  });
});

// ---------------------------------------------------------------------------

/** A `GuardedFetcher` over a fixed map. No transport, no resolver, no socket. */
function fakeFetcher(
  routes: Readonly<Record<string, { final?: string; refuse?: FetchRefusalCode }>>,
): GuardedFetcher {
  const lookup = (url: string): { final?: string; refuse?: FetchRefusalCode } =>
    routes[url] ?? { refuse: 'timeout' };

  return {
    resolveFinal(url: string): Promise<FetchOutcome<ResolvedTarget>> {
      const route = lookup(url);
      if (route.refuse !== undefined) {
        return Promise.resolve({ ok: false, refusal: { code: route.refuse, reason: `fake ${route.refuse}`, url } });
      }
      const finalUrl = route.final ?? url;
      return Promise.resolve({ ok: true, value: { requestedUrl: url, finalUrl, chain: [url, finalUrl], status: 200 } });
    },
    fetchDocument(url: string): Promise<FetchOutcome<FetchedDocument>> {
      const route = lookup(url);
      if (route.refuse !== undefined) {
        return Promise.resolve({ ok: false, refusal: { code: route.refuse, reason: `fake ${route.refuse}`, url } });
      }
      const finalUrl = route.final ?? url;
      return Promise.resolve({
        ok: true,
        value: {
          requestedUrl: url,
          finalUrl,
          chain: [url, finalUrl],
          status: 200,
          contentType: 'text/html',
          html: '',
          bytesRead: 0,
          truncated: false,
        },
      });
    },
    /**
     * These suites are about resolving a URL, never about pulling bytes. A fake
     * that could return an image would be a fake with a capability the code
     * under test does not use.
     */
    fetchAsset(url: string): Promise<FetchOutcome<FetchedAsset>> {
      return Promise.resolve({
        ok: false,
        refusal: { code: 'unsupported_content_type', reason: 'this fake fetches no assets', url },
      });
    },
  };
}
