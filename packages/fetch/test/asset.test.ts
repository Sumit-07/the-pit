/**
 * `fetchAsset` — the third entry point into the one guarded walk.
 *
 * The point of these tests is that adding a way to pull BYTES off a stranger's
 * server did not add a second set of guards that can drift from the first. So
 * the file is in two halves:
 *
 * 1. The guards it inherits, re-asserted through this entry point rather than
 *    assumed: the address check on every hop, the redirect cap, the wall clock,
 *    the port and scheme refusals. If someone ever gives `fetchAsset` its own
 *    hop loop, these fail.
 * 2. The two things that are genuinely different, because an image is not a
 *    document: an image content-type allowlist that excludes SVG, and a body
 *    that is refused rather than truncated when it does not fit.
 *
 * No socket. `FakeResolver` and `FakeTransport` produce the responses no real
 * server would send on request — a favicon that 302s to the cloud metadata
 * endpoint, a 4 GB `image/png`, an SVG.
 */

import { describe, expect, it } from 'vitest';

import { createGuardedFetcher } from '../src/fetch.js';
import { IMAGE_CONTENT_TYPES, MAX_ASSET_BYTES } from '../src/limits.js';
import { FakeResolver, FakeTransport, binaryBody, fakeClock, redirectTo } from './helpers/fakes.js';

const PUBLIC = '93.184.216.34';
const METADATA = '169.254.169.254';

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);

function fetcherOver(transport: FakeTransport, overrides = {}) {
  return createGuardedFetcher({
    resolver: new FakeResolver({
      'a.example': [PUBLIC],
      'b.example': [PUBLIC],
      'c.example': [PUBLIC],
      'rebind.example': [PUBLIC, METADATA],
    }),
    transport,
    ...overrides,
  });
}

describe('the guards are the same guards', () => {
  it('refuses a scheme the fetcher will not dereference, without resolving anything', async () => {
    const resolver = new FakeResolver({});
    const transport = new FakeTransport();
    const fetcher = createGuardedFetcher({ resolver, transport });

    for (const url of ['file:///etc/passwd', 'data:image/png;base64,AAAA', 'gopher://a.example/']) {
      const result = await fetcher.fetchAsset(url);
      expect(result.ok, url).toBe(false);
      if (!result.ok) expect(result.refusal.code, url).toBe('unsupported_scheme');
    }
    expect(resolver.calls).toEqual([]);
    expect(transport.requests).toEqual([]);
  });

  it('refuses a host whose answers include a private address, and never dials', async () => {
    const transport = new FakeTransport().otherwise(binaryBody('image/png', PNG));

    const result = await fetcherOver(transport).fetchAsset('https://rebind.example/favicon.ico');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('blocked_address');
    // Not "it connected and we ignored the answer" — it never connected.
    expect(transport.requests).toEqual([]);
  });

  it('re-checks the address on a REDIRECT hop, which is the whole bypass', async () => {
    // The classic: a public host whose favicon 302s to the cloud metadata
    // endpoint. Checking only the first hop is the standard mistake.
    const transport = new FakeTransport()
      .route('https://a.example/icon.png', redirectTo('http://169.254.169.254/latest/meta-data/'))
      .otherwise(binaryBody('image/png', PNG));

    const result = await fetcherOver(transport).fetchAsset('https://a.example/icon.png');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('blocked_address');
    // One dial: the first hop. The metadata address was never contacted.
    expect(transport.dialled).toEqual([PUBLIC]);
  });

  it('dials the address that was checked, not the hostname', async () => {
    const transport = new FakeTransport().otherwise(binaryBody('image/png', PNG));

    await fetcherOver(transport).fetchAsset('https://a.example/icon.png');

    expect(transport.requests[0]?.address).toBe(PUBLIC);
    expect(transport.requests[0]?.hostname).toBe('a.example');
  });

  it('caps the redirect chain', async () => {
    const transport = new FakeTransport()
      .route('https://a.example/1', redirectTo('https://a.example/2'))
      .route('https://a.example/2', redirectTo('https://a.example/3'))
      .route('https://a.example/3', redirectTo('https://a.example/4'))
      .otherwise(binaryBody('image/png', PNG));

    const result = await fetcherOver(transport, { maxRedirects: 2 }).fetchAsset('https://a.example/1');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('too_many_redirects');
  });

  it('runs out of wall clock like the other two entry points do', async () => {
    const clock = fakeClock();
    const transport = new FakeTransport()
      .route('https://a.example/1', redirectTo('https://a.example/2'))
      .otherwise(binaryBody('image/png', PNG));
    const fetcher = fetcherOver(transport, {
      timeoutMs: 100,
      now: () => {
        const at = clock.now();
        clock.advance(80);
        return at;
      },
    });

    const result = await fetcher.fetchAsset('https://a.example/1');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('timeout');
  });

  it('refuses a port that is not a website', async () => {
    const transport = new FakeTransport().otherwise(binaryBody('image/png', PNG));

    const result = await fetcherOver(transport).fetchAsset('https://a.example:6379/icon.png');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('blocked_port');
    expect(transport.requests).toEqual([]);
  });

  it('refuses a URL carrying credentials', async () => {
    const transport = new FakeTransport().otherwise(binaryBody('image/png', PNG));

    const result = await fetcherOver(transport).fetchAsset('https://user:pass@a.example/icon.png');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('credentials_in_url');
  });
});

describe('what an image is, decided from the headers, before any body is read', () => {
  it('accepts the raster types the allowlist names', async () => {
    for (const type of IMAGE_CONTENT_TYPES) {
      const transport = new FakeTransport().route('https://a.example/i', binaryBody(type, PNG));

      const result = await fetcherOver(transport).fetchAsset('https://a.example/i');

      expect(result.ok, type).toBe(true);
      if (result.ok) {
        expect(result.value.contentType, type).toBe(type);
        expect([...result.value.bytes], type).toEqual([...PNG]);
      }
    }
  });

  it('REFUSES image/svg+xml, and does not read a byte of it', async () => {
    // The one refusal in this file that is a policy rather than a cap. An SVG is
    // a document that can carry script, and these bytes are stored and served
    // back inside our own origin as a `data:` URL.
    const transport = new FakeTransport().route('https://a.example/logo.svg', {
      status: 200,
      headers: { 'content-type': 'image/svg+xml' },
      body: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
    });

    const result = await fetcherOver(transport).fetchAsset('https://a.example/logo.svg');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('unsupported_content_type');
    expect(transport.responses[0]?.bodyRead).toBe(false);
    expect(transport.responses[0]?.discarded).toBe(true);
    // And it is not merely absent from a default: naming it explicitly must not
    // sneak it back in.
    expect(IMAGE_CONTENT_TYPES).not.toContain('image/svg+xml');
  });

  it('refuses a huge non-image WITHOUT reading it, so a video behind rel=icon costs headers', async () => {
    for (const type of ['text/html', 'video/mp4', 'application/octet-stream', 'application/pdf']) {
      const transport = new FakeTransport().route('https://a.example/i', {
        status: 200,
        headers: { 'content-type': type, 'content-length': '4294967296' },
        body: 'x'.repeat(50_000),
      });

      const result = await fetcherOver(transport).fetchAsset('https://a.example/i');

      expect(result.ok, type).toBe(false);
      if (!result.ok) expect(result.refusal.code, type).toBe('unsupported_content_type');
      expect(transport.responses[0]?.bodyRead, type).toBe(false);
    }
  });

  it('refuses a response that declares no content type at all', async () => {
    const transport = new FakeTransport().route('https://a.example/i', { status: 200, headers: {}, bytes: PNG });

    const result = await fetcherOver(transport).fetchAsset('https://a.example/i');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('unsupported_content_type');
    expect(transport.responses[0]?.bodyRead).toBe(false);
  });

  it('reads the essence, so a charset parameter and odd case still match', async () => {
    for (const type of ['IMAGE/PNG', 'image/png; charset=binary', 'image/png ']) {
      const transport = new FakeTransport().route('https://a.example/i', {
        status: 200,
        headers: { 'content-type': type },
        bytes: PNG,
      });

      const result = await fetcherOver(transport).fetchAsset('https://a.example/i');

      expect(result.ok, type).toBe(true);
    }
  });

  it('lets a caller narrow the allowlist, and refuses what falls outside it', async () => {
    const transport = new FakeTransport().route('https://a.example/i', binaryBody('image/gif', PNG));

    const result = await fetcherOver(transport).fetchAsset('https://a.example/i', { contentTypes: ['image/png'] });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('unsupported_content_type');
  });

  it('asks for images rather than for HTML', async () => {
    // Not a guard — every guard is applied to what came back — but a
    // content-negotiating server handed `Accept: text/html` will send its 404
    // page instead of the icon, and then the bytes check has to catch it.
    const transport = new FakeTransport().route('https://a.example/i', binaryBody('image/png', PNG));

    await fetcherOver(transport).fetchAsset('https://a.example/i');

    expect(transport.requests[0]?.headers['accept']).toContain('image/png');
    expect(transport.requests[0]?.headers['accept-encoding']).toBe('identity');
  });
});

describe('a body that does not fit is refused, not truncated', () => {
  it('refuses an oversized image rather than handing back a prefix', async () => {
    // A prefix of an HTML document still has a usable `<head>`. A prefix of a
    // PNG is rubble, and storing one would put a broken image on a board.
    const big = new Uint8Array(4_000);
    big.set(PNG);
    const transport = new FakeTransport().route('https://a.example/i', binaryBody('image/png', big, 500));

    const result = await fetcherOver(transport).fetchAsset('https://a.example/i', { maxBytes: 1_000 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe('asset_too_large');
      expect(result.refusal.reason).toContain('1000');
    }
  });

  it('stops pulling bytes off the wire at the cap, rather than buffering and slicing', async () => {
    const big = new Uint8Array(20_000);
    const transport = new FakeTransport().route('https://a.example/i', binaryBody('image/png', big, 1_000));

    await fetcherOver(transport).fetchAsset('https://a.example/i', { maxBytes: 2_000 });

    expect(transport.responses[0]?.readLimit).toBe(2_000);
    // 20 chunks exist; the cap stopped the fake at 2.
    expect(transport.responses[0]?.chunksProduced).toBe(2);
  });

  it('accepts a body that exactly fills the cap', async () => {
    const exact = new Uint8Array(1_000);
    exact.set(PNG);
    const transport = new FakeTransport().route('https://a.example/i', binaryBody('image/png', exact, 250));

    const result = await fetcherOver(transport).fetchAsset('https://a.example/i', { maxBytes: 1_000 });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.bytes.byteLength).toBe(1_000);
  });

  it('refuses an empty body, which is a 200 that said nothing', async () => {
    const transport = new FakeTransport().route('https://a.example/i', binaryBody('image/png', new Uint8Array(0)));

    const result = await fetcherOver(transport).fetchAsset('https://a.example/i');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('asset_too_large');
  });

  it('defaults the cap to MAX_ASSET_BYTES when the caller names none', async () => {
    const transport = new FakeTransport().route('https://a.example/i', binaryBody('image/png', PNG));

    await fetcherOver(transport).fetchAsset('https://a.example/i');

    expect(transport.responses[0]?.readLimit).toBe(MAX_ASSET_BYTES);
  });
});

describe('status', () => {
  it('refuses a non-2xx and discards its body', async () => {
    for (const status of [404, 403, 500, 304]) {
      const transport = new FakeTransport().route('https://a.example/i', {
        status,
        headers: { 'content-type': 'image/png' },
        bytes: PNG,
      });

      const result = await fetcherOver(transport).fetchAsset('https://a.example/i');

      expect(result.ok, String(status)).toBe(false);
      if (!result.ok) expect(result.refusal.code, String(status)).toBe('bad_status');
      expect(transport.responses[0]?.discarded, String(status)).toBe(true);
    }
  });

  it('refuses a 204, which is a 2xx that answered with no icon', async () => {
    // Reached often in practice: a CDN answers `/favicon.ico` 204 rather than
    // 404 so that browsers stop asking. It is a success status and an absence,
    // and the empty-body refusal is what tells the two apart.
    const transport = new FakeTransport().route('https://a.example/i', {
      status: 204,
      headers: { 'content-type': 'image/png' },
    });

    const result = await fetcherOver(transport).fetchAsset('https://a.example/i');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('asset_too_large');
  });

  it('reports where a redirected asset actually came from', async () => {
    const transport = new FakeTransport()
      .route('https://a.example/icon.ico', redirectTo('https://b.example/static/icon.png'))
      .route('https://b.example/static/icon.png', binaryBody('image/png', PNG));

    const result = await fetcherOver(transport).fetchAsset('https://a.example/icon.ico');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.requestedUrl).toBe('https://a.example/icon.ico');
      // The FINAL url, which is what a stored record has to remember: it is the
      // base a future re-fetch resolves against and the thing an audit reads.
      expect(result.value.finalUrl).toBe('https://b.example/static/icon.png');
      expect(result.value.chain).toEqual(['https://a.example/icon.ico', 'https://b.example/static/icon.png']);
    }
  });
});
