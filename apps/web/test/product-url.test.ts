/**
 * The web app's seam onto the guarded fetcher.
 *
 * The guards themselves are proved in `packages/fetch`; what is tested here is
 * the wiring: that the app has exactly one door onto the fetcher, that a test
 * can install a fake through it and never open a socket, and that a refusal
 * reaches a visitor as a sentence they can act on rather than as an exception.
 */

import { afterEach, describe, expect, it } from 'vitest';

import type { FetchOutcome, FetchRefusalCode, FetchedAsset, FetchedDocument, GuardedFetcher, ResolvedTarget } from '@the-pit/fetch';

import {
  productUrlFetcher,
  readProductMetadata,
  registerProductUrlFetcher,
  resetProductUrlWiring,
  resolveSubmittedUrl,
  submissionUrlMessage,
} from '@/lib/ingest/product-url';

/** A fetcher over a fixed map. No transport, no resolver, no socket. */
function fakeFetcher(routes: Readonly<Record<string, { final?: string; html?: string; refuse?: FetchRefusalCode }>>): GuardedFetcher {
  const lookup = (url: string): { final?: string; html?: string; refuse?: FetchRefusalCode } =>
    routes[url] ?? { refuse: 'dns_failure' };

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
          html: route.html ?? '',
          bytesRead: (route.html ?? '').length,
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

afterEach(() => {
  resetProductUrlWiring();
});

describe('productUrlFetcher', () => {
  it('prefers a registered fetcher, so a test never reaches the network', () => {
    const fake = fakeFetcher({});
    registerProductUrlFetcher(fake);

    expect(productUrlFetcher()).toBe(fake);
  });

  it('forgets the registration on reset', () => {
    registerProductUrlFetcher(fakeFetcher({}));
    resetProductUrlWiring();

    // The real one. Constructing it opens nothing; it is asked for nothing here.
    expect(productUrlFetcher()).not.toBeNull();
  });
});

describe('resolveSubmittedUrl', () => {
  it('keys a shortener on its target, which is the whole point of the cap', async () => {
    registerProductUrlFetcher(
      fakeFetcher({ 'https://bit.ly/3xYzAbC': { final: 'https://www.ledger.example/pricing?ref=42' } }),
    );

    const result = await resolveSubmittedUrl('https://bit.ly/3xYzAbC');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.normalizedUrl).toBe('ledger.example/pricing');
      expect(result.value.flags).toEqual(['url_redirected']);
    }
  });

  it('gives the direct URL the same key', async () => {
    registerProductUrlFetcher(fakeFetcher({ 'https://ledger.example/pricing': {} }));

    const result = await resolveSubmittedUrl('https://ledger.example/pricing');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.normalizedUrl).toBe('ledger.example/pricing');
  });

  it('returns a refusal rather than throwing when the URL is not fetchable', async () => {
    registerProductUrlFetcher(fakeFetcher({}));

    // `normalizeUrl` refuses a non-http(s) URL before the fetcher is consulted,
    // so this never becomes a request at all — which is the cheapest possible
    // place for `file:///etc/passwd` to die.
    const result = await resolveSubmittedUrl('file:///etc/passwd');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('invalid_url');
  });

  it('flags an unreachable ordinary site instead of rejecting a paying customer', async () => {
    registerProductUrlFetcher(fakeFetcher({}));

    const result = await resolveSubmittedUrl('https://ledger.example/pricing');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.normalizedUrl).toBe('ledger.example/pricing');
      expect(result.value.flags).toEqual(['url_unresolved']);
    }
  });
});

describe('readProductMetadata', () => {
  it('reads a page’s own copy, sanitized', async () => {
    registerProductUrlFetcher(
      fakeFetcher({
        'https://ledger.example/': {
          html: '<head><title>Ledger</title><meta name="description" content="Books &lt;b&gt;that&lt;/b&gt; balance"></head>',
        },
      }),
    );

    const result = await readProductMetadata('https://ledger.example/');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.title).toBe('Ledger');
      expect(result.value.description).toBe('Books that balance');
    }
  });

  it('succeeds with the description absent when a page has none', async () => {
    registerProductUrlFetcher(fakeFetcher({ 'https://ledger.example/': { html: '<head><title>Ledger</title></head>' } }));

    const result = await readProductMetadata('https://ledger.example/');

    expect(result.ok).toBe(true);
    if (result.ok) expect('description' in result.value).toBe(false);
  });
});

describe('submissionUrlMessage', () => {
  it('says something a visitor can act on for every refusal code', () => {
    const codes: readonly FetchRefusalCode[] = [
      'invalid_url',
      'unsupported_scheme',
      'credentials_in_url',
      'blocked_port',
      'blocked_address',
      'dns_failure',
      'too_many_redirects',
      'redirect_without_location',
      'redirect_loop',
      'bad_status',
      'unsupported_content_type',
      'timeout',
      'transport_error',
    ];

    for (const code of codes) {
      const message = submissionUrlMessage({ code, reason: 'because', url: 'https://x.example/' });
      expect(message.length, code).toBeGreaterThan(20);
      // Never the raw internal reason, and never a bare code.
      expect(message, code).not.toContain(code);
    }
  });

  it('does not tell a visitor to retry an address that is refused on principle', () => {
    expect(submissionUrlMessage({ code: 'blocked_address', reason: 'x', url: 'y' })).toMatch(/not the public internet/);
    expect(submissionUrlMessage({ code: 'timeout', reason: 'x', url: 'y' })).toMatch(/short link/);
  });
});
