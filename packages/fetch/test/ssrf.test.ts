/**
 * The guards that make this package worth having.
 *
 * Every test here is written to FAIL against a plausible naive implementation —
 * `await fetch(url)`, or a fetcher that checks the first host and then follows
 * redirects itself. Where the distinction is subtle the comment says which naive
 * version the test catches.
 */

import { describe, expect, it } from 'vitest';

import { createGuardedFetcher } from '../src/fetch.js';
import { FakeResolver, FakeTransport, htmlPage, redirectTo } from './helpers/fakes.js';

const PUBLIC = '93.184.216.34';

function fetcherOver(resolver: FakeResolver, transport: FakeTransport, overrides = {}) {
  return createGuardedFetcher({ resolver, transport, ...overrides });
}

describe('address guards', () => {
  it('refuses a host that resolves to the cloud metadata address, and never dials it', async () => {
    const resolver = new FakeResolver({ 'lovely-startup.example': ['169.254.169.254'] });
    const transport = new FakeTransport().otherwise(htmlPage('<title>hi</title>'));

    const result = await fetcherOver(resolver, transport).fetchDocument('https://lovely-startup.example/');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('blocked_address');
    expect(result.refusal.reason).toMatch(/169\.254\.169\.254 is link-local \(cloud instance metadata\)/);
    // The name is public and ordinary; only the ANSWER was hostile. A fetcher
    // that judged the hostname would have connected.
    expect(transport.requests).toHaveLength(0);
  });

  it('refuses an IP literal in the URL by the same rule as a resolved answer', async () => {
    const resolver = new FakeResolver({});
    const transport = new FakeTransport().otherwise(htmlPage(''));

    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://127.0.0.1/', 'http://10.1.2.3/', 'http://[::1]/']) {
      const result = await fetcherOver(resolver, transport).fetchDocument(url);
      expect(result.ok, url).toBe(false);
      if (!result.ok) expect(result.refusal.code, url).toBe('blocked_address');
    }
    expect(transport.requests).toHaveLength(0);
    // A literal needs no DNS, and asking for one would be a needless leak.
    expect(resolver.calls).toHaveLength(0);
  });

  it('refuses each private family a host can hide behind', async () => {
    const cases: readonly (readonly [string, string])[] = [
      ['loopback.example', '127.0.0.1'],
      ['ten.example', '10.4.5.6'],
      ['seventeentwo.example', '172.20.0.9'],
      ['oneninetwo.example', '192.168.0.7'],
      ['v6loop.example', '::1'],
      ['ula.example', 'fd12:3456::1'],
      ['mapped.example', '::ffff:127.0.0.1'],
      ['sixtofour.example', '2002:7f00:1::'],
    ];

    for (const [host, address] of cases) {
      const transport = new FakeTransport().otherwise(htmlPage(''));
      const result = await fetcherOver(new FakeResolver({ [host]: [address] }), transport).fetchDocument(`https://${host}/`);
      expect(result.ok, host).toBe(false);
      if (!result.ok) expect(result.refusal.code, host).toBe('blocked_address');
      expect(transport.requests, host).toHaveLength(0);
    }
  });

  it('refuses the whole hop when ONE of several answers is private', async () => {
    // A name answering with a public and a private address is a rebinding
    // attack hoping the fetcher checks the first and dials the second. Refusing
    // only the private answer, or checking only answers[0], passes a naive test
    // and fails this one.
    const resolver = new FakeResolver({ 'split.example': [PUBLIC, '169.254.169.254'] });
    const transport = new FakeTransport().otherwise(htmlPage(''));

    const result = await fetcherOver(resolver, transport).fetchDocument('https://split.example/');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('blocked_address');
    expect(transport.requests).toHaveLength(0);
  });
});

describe('DNS rebinding', () => {
  it('resolves once per hop and dials the address it checked', async () => {
    // The resolver flips to loopback on its SECOND answer. An implementation
    // that validates the name and then hands the NAME to the socket — which is
    // what `fetch(url)` does — connects to 127.0.0.1. This one asks once, and
    // dials what it was told.
    const resolver = new FakeResolver({ 'flip.example': [[PUBLIC], ['127.0.0.1']] });
    const transport = new FakeTransport().otherwise(htmlPage('<title>Flip</title>'));

    const result = await fetcherOver(resolver, transport).fetchDocument('https://flip.example/');

    expect(result.ok).toBe(true);
    expect(resolver.calls).toEqual(['flip.example']);
    expect(transport.dialled).toEqual([PUBLIC]);
    // The hostname still goes out, so `Host` and TLS SNI are right.
    expect(transport.requests[0]?.hostname).toBe('flip.example');
  });

  it('re-resolves each DISTINCT hop, so a redirect gets its own check', async () => {
    const resolver = new FakeResolver({ 'a.example': [PUBLIC], 'b.example': [PUBLIC] });
    const transport = new FakeTransport()
      .route('https://a.example/', redirectTo('https://b.example/'))
      .route('https://b.example/', htmlPage('<title>B</title>'));

    const result = await fetcherOver(resolver, transport).fetchDocument('https://a.example/');

    expect(result.ok).toBe(true);
    expect(resolver.calls).toEqual(['a.example', 'b.example']);
  });
});

describe('redirects are checked on every hop', () => {
  it('refuses a public URL that 302s to the metadata address', async () => {
    // The standard bypass, and checking only the first host is the standard
    // mistake. The first hop is genuinely fine, and must be seen to be fine.
    const resolver = new FakeResolver({ 'lovely-startup.example': [PUBLIC], 'internal.example': ['169.254.169.254'] });
    const transport = new FakeTransport()
      .route('https://lovely-startup.example/', redirectTo('http://internal.example/latest/meta-data/'))
      .otherwise(htmlPage('<title>secrets</title>'));

    const result = await fetcherOver(resolver, transport).fetchDocument('https://lovely-startup.example/');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe('blocked_address');
    expect(result.refusal.url).toBe('http://internal.example/latest/meta-data/');
    expect(result.refusal.reason).toMatch(/internal\.example resolves to 169\.254\.169\.254/);
    // Hop one happened; hop two did not.
    expect(transport.requests.map((request) => request.url)).toEqual(['https://lovely-startup.example/']);
  });

  it('refuses a redirect to an IP literal, including IPv6 loopback', async () => {
    for (const location of ['http://169.254.169.254/', 'http://[::1]/', 'http://10.0.0.1/']) {
      const resolver = new FakeResolver({ 'hop.example': [PUBLIC] });
      const transport = new FakeTransport().route('https://hop.example/', redirectTo(location)).otherwise(htmlPage(''));
      const result = await fetcherOver(resolver, transport).fetchDocument('https://hop.example/');
      expect(result.ok, location).toBe(false);
      if (!result.ok) expect(result.refusal.code, location).toBe('blocked_address');
      expect(transport.requests, location).toHaveLength(1);
    }
  });

  it('refuses a redirect that changes scheme to something unfetchable', async () => {
    const resolver = new FakeResolver({ 'hop.example': [PUBLIC] });
    const transport = new FakeTransport().route('https://hop.example/', redirectTo('file:///etc/passwd'));

    const result = await fetcherOver(resolver, transport).fetchDocument('https://hop.example/');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('unsupported_scheme');
  });

  it('never reads the body of a redirect', async () => {
    const resolver = new FakeResolver({ 'a.example': [PUBLIC], 'b.example': [PUBLIC] });
    const transport = new FakeTransport()
      .route('https://a.example/', { status: 302, headers: { location: 'https://b.example/' }, body: 'x'.repeat(5_000) })
      .route('https://b.example/', htmlPage('<title>B</title>'));

    await fetcherOver(resolver, transport).fetchDocument('https://a.example/');

    expect(transport.responses[0]?.bodyRead).toBe(false);
    expect(transport.responses[0]?.discarded).toBe(true);
  });
});

describe('redirect caps', () => {
  function chain(length: number): { resolver: FakeResolver; transport: FakeTransport } {
    const table: Record<string, readonly string[]> = {};
    const transport = new FakeTransport();
    for (let index = 0; index < length; index += 1) {
      table[`hop${index}.example`] = [PUBLIC];
      transport.route(`https://hop${index}.example/`, redirectTo(`https://hop${index + 1}.example/`));
    }
    table[`hop${length}.example`] = [PUBLIC];
    transport.route(`https://hop${length}.example/`, htmlPage('<title>End</title>'));
    return { resolver: new FakeResolver(table), transport };
  }

  it('follows exactly maxRedirects hops', async () => {
    const { resolver, transport } = chain(3);
    const result = await fetcherOver(resolver, transport, { maxRedirects: 3 }).fetchDocument('https://hop0.example/');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.chain).toHaveLength(4);
  });

  it('refuses one hop past the cap', async () => {
    const { resolver, transport } = chain(4);
    const result = await fetcherOver(resolver, transport, { maxRedirects: 3 }).fetchDocument('https://hop0.example/');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('too_many_redirects');
    // Four requests went out and the fifth did not, so the cap counts hops and
    // not something adjacent to hops.
    expect(transport.requests).toHaveLength(4);
  });

  it('refuses a redirect loop even when it is shorter than the cap', async () => {
    const resolver = new FakeResolver({ 'a.example': [PUBLIC], 'b.example': [PUBLIC] });
    const transport = new FakeTransport()
      .route('https://a.example/', redirectTo('https://b.example/'))
      .route('https://b.example/', redirectTo('https://a.example/'));

    const result = await fetcherOver(resolver, transport, { maxRedirects: 4 }).fetchDocument('https://a.example/');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('redirect_loop');
  });

  it('refuses a 3xx with no Location rather than treating it as the final page', async () => {
    const resolver = new FakeResolver({ 'a.example': [PUBLIC] });
    const transport = new FakeTransport().route('https://a.example/', { status: 301, headers: {} });

    const result = await fetcherOver(resolver, transport).fetchDocument('https://a.example/');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('redirect_without_location');
  });

  it('resolves a relative Location against the CURRENT hop, not the original URL', async () => {
    const resolver = new FakeResolver({ 'a.example': [PUBLIC], 'b.example': [PUBLIC] });
    const transport = new FakeTransport()
      .route('https://a.example/start', redirectTo('https://b.example/deep/page'))
      .route('https://b.example/deep/page', redirectTo('../moved'))
      .route('https://b.example/moved', htmlPage('<title>Moved</title>'));

    const result = await fetcherOver(resolver, transport).fetchDocument('https://a.example/start');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.finalUrl).toBe('https://b.example/moved');
  });
});

describe('schemes and ports', () => {
  it('refuses every scheme but http and https, before touching DNS', async () => {
    const resolver = new FakeResolver({});
    const transport = new FakeTransport().otherwise(htmlPage(''));

    for (const url of [
      'file:///etc/passwd',
      'data:text/html,<title>hi</title>',
      'gopher://example.com:70/_x',
      'ftp://example.com/x',
      'javascript:alert(1)',
    ]) {
      const result = await fetcherOver(resolver, transport).fetchDocument(url);
      expect(result.ok, url).toBe(false);
      if (!result.ok) {
        expect(result.refusal.code, url).toBe('unsupported_scheme');
        expect(result.refusal.reason, url).toMatch(/http and https only/);
      }
    }
    expect(resolver.calls).toHaveLength(0);
    expect(transport.requests).toHaveLength(0);
  });

  it('refuses a port that is not a website', async () => {
    const resolver = new FakeResolver({ 'a.example': [PUBLIC] });
    const transport = new FakeTransport().otherwise(htmlPage(''));

    for (const port of [22, 6379, 11211, 25]) {
      const result = await fetcherOver(resolver, transport).fetchDocument(`http://a.example:${port}/`);
      expect(result.ok, String(port)).toBe(false);
      if (!result.ok) expect(result.refusal.code, String(port)).toBe('blocked_port');
    }
    expect(transport.requests).toHaveLength(0);
  });

  it('refuses credentials in a URL', async () => {
    const resolver = new FakeResolver({ 'a.example': [PUBLIC] });
    const transport = new FakeTransport().otherwise(htmlPage(''));

    const result = await fetcherOver(resolver, transport).fetchDocument('http://admin:hunter2@a.example/');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('credentials_in_url');
    expect(transport.requests).toHaveLength(0);
  });

  it('refuses an over-long URL without parsing it', async () => {
    const resolver = new FakeResolver({ 'a.example': [PUBLIC] });
    const result = await fetcherOver(resolver, new FakeTransport()).fetchDocument(`https://a.example/${'x'.repeat(3_000)}`);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('invalid_url');
  });
});

describe('DNS failures fail closed', () => {
  it('refuses when the name does not resolve', async () => {
    const result = await fetcherOver(new FakeResolver({}), new FakeTransport()).fetchDocument('https://nowhere.example/');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe('dns_failure');
      expect(result.refusal.reason).toMatch(/ENOTFOUND/);
    }
  });

  it('refuses when the name resolves to nothing at all', async () => {
    const result = await fetcherOver(new FakeResolver({ 'empty.example': [] }), new FakeTransport()).fetchDocument(
      'https://empty.example/',
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.reason).toMatch(/resolved to no addresses/);
  });
});
