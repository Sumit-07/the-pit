/**
 * `GET /account` — the page every sign-in path redirects to.
 *
 * `brief §2.1` is one sentence with two halves and this file asserts both, from
 * the outside:
 *
 * > "Public vs private: verdict URLs are public. Attempt balance and history are
 * > behind the session."
 *
 * The private half is asserted by giving the handler a store that RECORDS EVERY
 * CALL and checking the log is empty on the signed-out path. "The page does not
 * render the balance" would still pass if the handler fetched it and threw it
 * away; "the store was never asked" is the property that survives a refactor.
 *
 * The public half is asserted twice, because it is the one that could regress
 * silently now that a gated page links to it: the account page emits bare
 * `/v/<slug>` hrefs with no token and no query string, and the verdict route
 * still serves a page to a request carrying no cookie at all.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MemoryAuthStore,
  MemoryRateLimiter,
  mintCapabilitySlug,
  newSessionPayload,
  serializeSessionCookie,
  signSessionCookie,
  type SessionKeyring,
} from '@the-pit/auth';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { handleCapabilityOpen, handleCapabilityRotate, type CapabilityHandlerDeps } from '@/lib/auth/capability-handlers';
import { handleAccountPage, type AccountHandlerDeps } from '@/lib/account/handlers';
import type { AccountListing, AccountPurchase, AccountReads } from '@/lib/account/view';

process.env['PIT_WORKDIR'] = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'cjr');

const ORIGIN = 'https://thepit.show';
const PAYER = 'payer@example.com';
const KEYRING: SessionKeyring = ['test-secret-0123456789abcdef0123456789abcdef0123456789abcdef01'];
const ACCOUNT_ID = 'acct_7';

/**
 * The three private reads, in memory, with a call log.
 *
 * The log is the point: it is what proves the signed-out path never asked.
 */
class RecordingReads implements AccountReads {
  readonly calls: string[] = [];
  balanceValue = 0;
  purchaseRows: AccountPurchase[] = [];
  listingRows: AccountListing[] = [];

  balance(accountId: string): Promise<number> {
    this.calls.push(`balance:${accountId}`);
    return Promise.resolve(this.balanceValue);
  }

  purchases(accountId: string): Promise<readonly AccountPurchase[]> {
    this.calls.push(`purchases:${accountId}`);
    return Promise.resolve(this.purchaseRows);
  }

  listings(accountId: string): Promise<readonly AccountListing[]> {
    this.calls.push(`listings:${accountId}`);
    return Promise.resolve(this.listingRows);
  }
}

function purchase(overrides: Partial<AccountPurchase> = {}): AccountPurchase {
  return {
    orderId: 'ord_1',
    amountCents: 500,
    currency: 'USD',
    attemptsGranted: 1,
    includesFitReport: false,
    createdAt: new Date('2026-06-01T12:00:00.000Z'),
    ...overrides,
  };
}

function listing(overrides: Partial<AccountListing> = {}): AccountListing {
  return {
    productId: 'prod_1',
    name: 'Runlet',
    url: 'https://runlet.dev/',
    categorySlug: 'developer-tools',
    status: 'placed',
    verdictSlug: 'runlet-first-pitch',
    attemptNumber: 1,
    deliveredAt: new Date('2026-06-01T12:00:00.000Z'),
    ...overrides,
  };
}

let reads: RecordingReads;
let identity: MemoryAuthStore;
let deps: AccountHandlerDeps;
/** How many times the handler asked for a store handle. Zero when signed out. */
let storeCalls: number;
let capability: CapabilityHandlerDeps;
let slug: string;

beforeEach(() => {
  reads = new RecordingReads();
  identity = new MemoryAuthStore();
  slug = mintCapabilitySlug();
  identity.seedAccount(PAYER, ACCOUNT_ID, slug);

  storeCalls = 0;
  deps = {
    keyring: KEYRING,
    secureCookies: true,
    stores: () => {
      // Counted, not just recorded: the signed-out path must not resolve the
      // stores AT ALL, which is a stronger claim than "it read nothing from
      // them" — a deployment with no DATABASE_URL throws here, and a 500 on the
      // logged-out page is what that used to mean.
      storeCalls += 1;
      return { origin: ORIGIN, reads, identities: identity };
    },
  };
  capability = {
    origin: ORIGIN,
    capability: { store: identity, limiter: new MemoryRateLimiter(), keyring: KEYRING, secureCookies: true },
  };
});

/** The `Cookie:` header a browser would send for a freshly minted session. */
function sessionCookie(): string {
  const payload = newSessionPayload({ accountId: ACCOUNT_ID, email: PAYER, now: new Date() });
  const setCookie = serializeSessionCookie(signSessionCookie(payload, KEYRING), { secure: true });
  return setCookie.split(';')[0] ?? '';
}

function get(cookie?: string): Request {
  const headers: Record<string, string> = {};
  if (cookie !== undefined) headers['cookie'] = cookie;
  return new Request(`${ORIGIN}/account`, { headers });
}

async function render(cookie?: string): Promise<{ status: number; body: string; headers: Headers }> {
  const response = await handleAccountPage(get(cookie), deps);
  return { status: response.status, body: await response.text(), headers: response.headers };
}

// ---------------------------------------------------------------------------

describe('with no session', () => {
  it('renders neither balance nor history, and never asks for them', async () => {
    reads.balanceValue = 3;
    reads.purchaseRows = [purchase()];
    reads.listingRows = [listing()];

    const page = await render();

    expect(page.status).toBe(401);
    // The store was not touched. Not "the numbers are absent from the HTML" —
    // that would still pass if the handler fetched them and dropped them.
    expect(reads.calls).toEqual([]);
    // Stronger: it was never even RESOLVED. `accountDeps()` used to open both
    // stores before the handler read the cookie, so a deployment with no
    // DATABASE_URL served a 500 here instead of this page.
    expect(storeCalls).toBe(0);
    expect(page.body).not.toContain('Runlet');
    expect(page.body).not.toContain('$5.00');
    expect(page.body).not.toContain(PAYER);
    expect(page.body).not.toContain(slug);
  });

  it('offers both doors it can render rather than only email', async () => {
    const page = await render();
    expect(page.body).toContain('/auth/sign-in');
    expect(page.body).toContain('/auth/github/start');
  });

  it('refuses a cookie it did not sign', async () => {
    const forged = newSessionPayload({ accountId: ACCOUNT_ID, email: PAYER, now: new Date() });
    const signedByAnother = serializeSessionCookie(
      signSessionCookie(forged, ['a-different-secret-0123456789abcdef0123456789abcdef0123456']),
      { secure: true },
    );

    const page = await render(signedByAnother.split(';')[0]);
    expect(page.status).toBe(401);
    expect(reads.calls).toEqual([]);
  });
});

describe('with a session', () => {
  it('shows the balance, the history and the listings', async () => {
    reads.balanceValue = 2;
    reads.purchaseRows = [purchase({ amountCents: 1500, attemptsGranted: 3, includesFitReport: true })];
    reads.listingRows = [listing()];

    const page = await render(sessionCookie());

    expect(page.status).toBe(200);
    expect(reads.calls).toEqual([`balance:${ACCOUNT_ID}`, `purchases:${ACCOUNT_ID}`, `listings:${ACCOUNT_ID}`]);
    expect(page.body).toContain('>2<');
    expect(page.body).toContain('3 attempts + fit report');
    expect(page.body).toContain('$15.00');
    expect(page.body).toContain('Runlet');
    expect(page.body).toContain('1 Jun 2026');
  });

  it('is never cached, and leaks nothing through a Referer', async () => {
    // The page renders a bearer URL in its body. A CDN or a shared browser cache
    // holding it is the next person's account.
    const page = await render(sessionCookie());
    expect(page.headers.get('cache-control')).toContain('no-store');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.get('x-robots-tag')).toContain('noindex');
  });

  it('carries the connective word', async () => {
    // `brief` Part 5: "cuts" is the one thread from the loud homepage to the
    // plain surfaces behind it.
    reads.listingRows = [listing()];
    const page = await render(sessionCookie());
    expect(page.body).toContain('Read the cuts');
  });

  it('escapes a product name, because descriptions and names are user-submitted', async () => {
    reads.listingRows = [listing({ name: '<script>alert(1)</script>Runlet' })];
    const page = await render(sessionCookie());

    expect(page.body).not.toContain('<script>alert(1)</script>');
    expect(page.body).toContain('&lt;script&gt;');
  });

  it('will not turn a javascript: URL into a link', async () => {
    reads.listingRows = [listing({ url: 'javascript:alert(1)' })];
    const page = await render(sessionCookie());

    expect(page.body).not.toContain('href="javascript:');
    // Still shown, as text, so the customer can see what they submitted.
    expect(page.body).toContain('javascript:alert(1)');
  });

  it('says what it has to say when there is nothing to show', async () => {
    const page = await render(sessionCookie());
    expect(page.status).toBe(200);
    expect(page.body).toContain('Nothing in the pit yet');
    expect(page.body).toContain('No purchases on this account yet');
  });
});

describe('verdict links are not gated, and are not decorated', () => {
  it('emits a bare /v/<slug> with no token and no query string', async () => {
    reads.listingRows = [listing({ verdictSlug: 'runlet-first-pitch' })];
    const page = await render(sessionCookie());

    expect(page.body).toContain('href="/v/runlet-first-pitch"');
    // A `?from=account`, a signature or a token here would make the URL a
    // customer copies out of this page different from the one a stranger gets —
    // which is how a public permanent URL quietly stops being either.
    expect(page.body).not.toMatch(/href="\/v\/runlet-first-pitch[?#]/);
  });

  it('says the verdict pages are public and work logged out', async () => {
    reads.listingRows = [listing()];
    const page = await render(sessionCookie());
    expect(page.body).toContain('public permanent URL');
  });

  it('still serves a real verdict page to a request with no cookie at all', async () => {
    // The regression guard. `/account` is the first gated surface that links to
    // verdicts, and this is the assertion that says the gate did not spread.
    const { GET } = await import('@/app/v/[slug]/route');
    const { resetVerdictStore, verdictStore } = await import('@/lib/verdict/service');
    const { buildSeedRows, loadSeedInput } = await import('@the-pit/db');

    resetVerdictStore();
    await verdictStore();
    const seed = buildSeedRows(await loadSeedInput('developer-tools', process.env['PIT_WORKDIR'] as string));
    const publicSlug = seed.verdicts[0]?.publicSlug ?? '';
    expect(publicSlug).not.toBe('');

    const response = await GET(new Request(`${ORIGIN}/v/${publicSlug}`), {
      params: Promise.resolve({ slug: publicSlug }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('Set-Cookie')).toBeNull();
    expect(response.headers.get('Cache-Control')).toContain('public');
    // The seeded binding materialises 92 frozen verdict payloads off `cjr/`
    // through the real seed builder, which is real work and is done once per
    // process. Five seconds is not enough for it while the PGlite suites are
    // saturating the machine beside it, and the assertion is about the GATE, not
    // about how fast a cold store builds.
  }, 30_000);
});

describe('the capability URL, and what rotating it does', () => {
  it('shows the live link and a control that replaces it', async () => {
    const page = await render(sessionCookie());

    expect(page.body).toContain(`${ORIGIN}/a/${slug}`);
    expect(page.body).toContain('action="/auth/capability/rotate"');
    expect(page.body).toContain('method="post"');
  });

  it('is a POST, because a GET that replaced a credential is an <img> away', async () => {
    const page = await render(sessionCookie());
    expect(page.body).not.toContain(`<a class="act prime" href="/auth/capability/rotate"`);
  });

  it('says plainly what rotation does NOT do', async () => {
    const page = await render(sessionCookie());
    const body = page.body;

    // Both halves, because a customer who believes rotation logs everyone out
    // will rotate and stop worrying.
    expect(body).toContain('Devices already signed in stay signed in.');
    expect(body).toContain('Replacing it kills the old link instantly.');
  });

  it('rotating invalidates the old link and the page then shows the new one', async () => {
    const before = await render(sessionCookie());
    expect(before.body).toContain(slug);

    const rotated = await handleCapabilityRotate(
      new Request(`${ORIGIN}/auth/capability/rotate`, {
        method: 'POST',
        headers: { cookie: sessionCookie(), 'x-vercel-forwarded-for': '203.0.113.9' },
      }),
      capability,
    );
    expect(rotated.status).toBe(200);

    // The old slug no longer resolves — one column, overwritten, no window in
    // which both work.
    const stale = await handleCapabilityOpen(
      new Request(`${ORIGIN}/a/${slug}`, { headers: { 'x-vercel-forwarded-for': '203.0.113.9' } }),
      slug,
      capability,
    );
    expect(stale.status).toBe(404);

    // And the account page has moved on with it.
    const after = await render(sessionCookie());
    expect(after.body).not.toContain(slug);
    const fresh = identity.seededSlug(ACCOUNT_ID) ?? '';
    expect(fresh).not.toBe(slug);
    expect(after.body).toContain(`${ORIGIN}/a/${fresh}`);
  });

  it('the session established through the old link still works, exactly as the page says', async () => {
    // The limitation the copy is honest about, asserted rather than asserted-in-prose.
    const cookie = sessionCookie();
    await handleCapabilityRotate(
      new Request(`${ORIGIN}/auth/capability/rotate`, {
        method: 'POST',
        headers: { cookie, 'x-vercel-forwarded-for': '203.0.113.9' },
      }),
      capability,
    );

    const stillIn = await render(cookie);
    expect(stillIn.status).toBe(200);
  });
});

describe('GitHub', () => {
  it('explains what linking unlocks when it is not linked', async () => {
    const page = await render(sessionCookie());

    expect(page.body).toContain('Not connected');
    expect(page.body).toContain('skips the review hold');
    expect(page.body).toContain('Claim a seeded listing');
    expect(page.body).toContain('Verified builder');
    expect(page.body).toContain('Re-pitch in one button');
    expect(page.body).toContain('/auth/github/start');
  });

  it('says linking attaches to this account rather than opening a second one', async () => {
    const page = await render(sessionCookie());
    expect(page.body).toContain('Attaches to <b>this</b> account');
  });

  it('promises no rank advantage anywhere in the list', async () => {
    // `DECISIONS.md` S15: GitHub perks are procedural or informational, never
    // positional. A login-conferred rank advantage is the same violation as a
    // purchased one in a different currency.
    const page = await render(sessionCookie());
    expect(page.body).toContain('None of it moves you up.');
  });

  it('shows the link once it exists, without offering to make another', async () => {
    await identity.linkIdentity({
      accountId: ACCOUNT_ID,
      provider: 'github',
      providerUserId: '4242',
      linkedEmail: 'personal@example.com',
      now: new Date(),
    });

    const page = await render(sessionCookie());
    expect(page.body).toContain('Connected');
    expect(page.body).toContain('personal@example.com');
    expect(page.body).not.toContain('Connect GitHub');
  });
});

/** The seeded verdict fixture is read from `cjr/`; make sure it is there. */
beforeAll(() => {
  expect(process.env['PIT_WORKDIR']).toContain('cjr');
});
