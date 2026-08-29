/**
 * The evasion route, closed.
 *
 * The per-product cap hangs off one string. These tests are about that string:
 * two spellings of one product must produce the same one, two different products
 * must not, and a URL that cannot be followed must not quietly produce a key
 * that lets the cap be skipped.
 */

import { describe, expect, it } from 'vitest';

import { createGuardedFetcher, type GuardedFetcher } from '../src/fetch.js';
import { hostOfKey, isShortenerHost, resolveProductUrl } from '../src/product-url.js';
import { FakeResolver, FakeTransport, htmlPage, redirectTo } from './helpers/fakes.js';

const PUBLIC = '93.184.216.34';

const HOSTS: Record<string, readonly string[]> = {
  'bit.ly': [PUBLIC],
  't.co': [PUBLIC],
  'ledger.example': [PUBLIC],
  'www.ledger.example': [PUBLIC],
  'rival.example': [PUBLIC],
  'go.ledger.example': [PUBLIC],
  'links.attacker.example': [PUBLIC],
  'evil.example': [PUBLIC],
  'metadata.example': ['169.254.169.254'],
};

function fetcherOver(transport: FakeTransport): GuardedFetcher {
  return createGuardedFetcher({ resolver: new FakeResolver(HOSTS), transport });
}

async function keyOf(url: string, transport: FakeTransport): Promise<string> {
  const result = await resolveProductUrl(url, fetcherOver(transport));
  if (!result.ok) throw new Error(`expected ${url} to normalize, got ${result.refusal.code}: ${result.refusal.reason}`);
  return result.value.normalizedUrl;
}

/** The board as it would really be: one product, reachable several ways. */
function board(): FakeTransport {
  return new FakeTransport()
    .route('https://bit.ly/3xYzAbC', redirectTo('https://www.ledger.example/pricing?utm_source=twitter'))
    .route('https://t.co/abc', redirectTo('https://bit.ly/3xYzAbC'))
    .route('https://go.ledger.example/promo', redirectTo('https://ledger.example/pricing'))
    .route('https://links.attacker.example/aa', redirectTo('https://ledger.example/pricing'))
    .route('https://bit.ly/rival', redirectTo('https://rival.example/pricing'))
    .route('https://www.ledger.example/pricing?utm_source=twitter', htmlPage('<title>Ledger</title>'))
    .route('https://ledger.example/pricing', htmlPage('<title>Ledger</title>'))
    .route('https://rival.example/pricing', htmlPage('<title>Rival</title>'))
    .otherwise(htmlPage('<title>other</title>'));
}

describe('shortener resolution — the cap collapses onto one key', () => {
  it('gives a shortener and its target the SAME key', async () => {
    // Before this, `bit.ly/x` normalized to `bit.ly/x` and the target to
    // `ledger.example/pricing`: two products, one cap each, and the cap was one
    // short link away from being free.
    const viaShortener = await keyOf('https://bit.ly/3xYzAbC', board());
    const direct = await keyOf('https://www.ledger.example/pricing?utm_source=twitter', board());

    expect(viaShortener).toBe('ledger.example/pricing');
    expect(direct).toBe('ledger.example/pricing');
  });

  it('collapses every spelling of one product onto one key at once', async () => {
    const spellings = [
      'https://bit.ly/3xYzAbC',
      'https://t.co/abc',
      'https://go.ledger.example/promo',
      'https://links.attacker.example/aa',
      'https://www.Ledger.example/Pricing/?ref=affiliate-42#plans',
      'ledger.example/pricing',
    ];

    const keys = new Set<string>();
    for (const spelling of spellings) keys.add(await keyOf(spelling, board()));

    expect([...keys]).toEqual(['ledger.example/pricing']);
  });

  it('keeps two genuinely different products apart', async () => {
    // The rule must not collapse everything: a cap that merges rivals is worse
    // than the hole it closed.
    expect(await keyOf('https://bit.ly/3xYzAbC', board())).not.toBe(await keyOf('https://bit.ly/rival', board()));
    expect(await keyOf('https://bit.ly/rival', board())).toBe('rival.example/pricing');
  });

  it('follows a shortener that points at another shortener', async () => {
    const result = await resolveProductUrl('https://t.co/abc', fetcherOver(board()));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.normalizedUrl).toBe('ledger.example/pricing');
      expect(result.value.finalUrl).toBe('https://www.ledger.example/pricing?utm_source=twitter');
      expect(result.value.redirected).toBe(true);
      expect(result.value.flags).toEqual(['url_redirected']);
    }
  });

  it('catches a shortener nobody has ever heard of, because the rule is not the list', async () => {
    // `links.attacker.example` is not in SHORTENER_HOSTS and never will be.
    // Registering your own shortener is the obvious answer to a curated list.
    expect(isShortenerHost('links.attacker.example')).toBe(false);
    expect(await keyOf('https://links.attacker.example/aa', board())).toBe('ledger.example/pricing');
  });
});

describe('shortener resolution — the key stays stable', () => {
  it('keeps the submitted key when a site redirects within its own host', async () => {
    // `example.com` → `example.com/en/home` is a site canonicalising a path.
    // Adopting today's landing page would re-key the product every time the
    // site changed its homepage redirect, which hands the cap straight back.
    const transport = new FakeTransport()
      .route('https://ledger.example/', redirectTo('https://ledger.example/en/home'))
      .route('https://ledger.example/en/home', htmlPage('<title>Ledger</title>'));

    const result = await resolveProductUrl('https://ledger.example/', fetcherOver(transport));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.normalizedUrl).toBe('ledger.example');
      expect(result.value.redirected).toBe(false);
      expect(result.value.flags).toEqual([]);
      // It was still followed — we know where it went, we just did not re-key on it.
      expect(result.value.finalUrl).toBe('https://ledger.example/en/home');
    }
  });

  it('treats a www. redirect as the same host, because normalizeUrl already does', async () => {
    const transport = new FakeTransport()
      .route('http://ledger.example/pricing', redirectTo('https://www.ledger.example/pricing'))
      .route('https://www.ledger.example/pricing', htmlPage('<title>Ledger</title>'));

    const result = await resolveProductUrl('http://ledger.example/pricing', fetcherOver(transport));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.normalizedUrl).toBe('ledger.example/pricing');
      expect(result.value.redirected).toBe(false);
    }
  });
});

describe('shortener resolution — failure', () => {
  it('REFUSES a known shortener that cannot be followed, rather than keying on it', async () => {
    // Falling back to `bit.ly/x` here reopens the hole the moment a shortener is
    // slow, and an attacker who can make bit.ly time out for us gets the cap for
    // free. This is the fail-closed case.
    const transport = new FakeTransport().route('https://bit.ly/3xYzAbC', { error: new Error('ECONNRESET') });

    const result = await resolveProductUrl('https://bit.ly/3xYzAbC', fetcherOver(transport));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('transport_error');
  });

  it('refuses a known shortener that answers 500', async () => {
    const transport = new FakeTransport().route('https://bit.ly/3xYzAbC', { status: 503, headers: {} });

    const result = await resolveProductUrl('https://bit.ly/3xYzAbC', fetcherOver(transport));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('bad_status');
  });

  it('falls back and FLAGS when an ordinary site is merely unreachable', async () => {
    // `brief §2.5`: a false rejection on a paying customer is worse than an
    // extra run. Somebody's site being down for thirty seconds must not cost
    // them a pitch — so the offline key is used and a human is told.
    const transport = new FakeTransport().route('https://ledger.example/pricing', { error: new Error('ETIMEDOUT') });

    const result = await resolveProductUrl('https://ledger.example/pricing', fetcherOver(transport));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.normalizedUrl).toBe('ledger.example/pricing');
      expect(result.value.finalUrl).toBeNull();
      expect(result.value.flags).toEqual(['url_unresolved']);
      expect(result.value.unresolvedReason).toMatch(/ETIMEDOUT/);
    }
  });

  it('never falls back on a SECURITY refusal, shortener or not', async () => {
    // A URL that leads to the metadata endpoint is not a product website under
    // any reading, and the flag-for-review rule does not extend to it.
    const transport = new FakeTransport()
      .route('https://evil.example/x', redirectTo('http://metadata.example/latest/meta-data/'))
      .otherwise(htmlPage(''));

    const result = await resolveProductUrl('https://evil.example/x', fetcherOver(transport));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('blocked_address');
  });

  it('refuses a URL pointed straight at a private address', async () => {
    const result = await resolveProductUrl('http://169.254.169.254/latest/meta-data/', fetcherOver(new FakeTransport()));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('blocked_address');
  });

  it('refuses a URL that is not http(s) without fetching anything', async () => {
    const transport = new FakeTransport();

    for (const url of ['file:///etc/passwd', 'data:text/html,<title>x</title>', 'mailto:sales@ledger.example', '']) {
      const result = await resolveProductUrl(url, fetcherOver(transport));
      expect(result.ok, url).toBe(false);
      if (!result.ok) expect(['invalid_url', 'unsupported_scheme'], url).toContain(result.refusal.code);
    }
    expect(transport.requests).toHaveLength(0);
  });

  it('refuses a shortener chain that never terminates', async () => {
    const transport = new FakeTransport()
      .route('https://bit.ly/3xYzAbC', redirectTo('https://t.co/abc'))
      .route('https://t.co/abc', redirectTo('https://bit.ly/3xYzAbC'));

    const result = await resolveProductUrl('https://bit.ly/3xYzAbC', fetcherOver(transport));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('redirect_loop');
  });
});

describe('helpers', () => {
  it('reads the host out of a normalized key, port and path removed', () => {
    expect(hostOfKey('ledger.example/pricing')).toBe('ledger.example');
    expect(hostOfKey('ledger.example:8080/a/b')).toBe('ledger.example');
    expect(hostOfKey('ledger.example')).toBe('ledger.example');
  });

  it('knows the common shorteners, and knows they are not the whole rule', () => {
    expect(isShortenerHost('bit.ly')).toBe(true);
    expect(isShortenerHost('BIT.LY')).toBe(true);
    expect(isShortenerHost('t.co')).toBe(true);
    expect(isShortenerHost('ledger.example')).toBe(false);
  });
});
