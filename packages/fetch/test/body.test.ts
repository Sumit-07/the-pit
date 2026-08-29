/**
 * The caps that stop a hostile response costing more than it should: content
 * type decided from headers alone, a byte cap that bounds what comes off the
 * wire, and a wall clock the redirect chain cannot outrun.
 */

import { describe, expect, it } from 'vitest';

import { createGuardedFetcher } from '../src/fetch.js';
import { FakeResolver, FakeTransport, fakeClock, htmlPage, redirectTo } from './helpers/fakes.js';

const PUBLIC = '93.184.216.34';

function fetcherOver(transport: FakeTransport, overrides = {}) {
  return createGuardedFetcher({
    resolver: new FakeResolver({ 'a.example': [PUBLIC], 'b.example': [PUBLIC], 'c.example': [PUBLIC] }),
    transport,
    ...overrides,
  });
}

describe('content type', () => {
  it('refuses a non-HTML response WITHOUT reading its body', async () => {
    for (const type of ['application/json', 'text/plain', 'application/pdf', 'video/mp4', 'application/octet-stream']) {
      const transport = new FakeTransport().route('https://a.example/', {
        status: 200,
        headers: { 'content-type': `${type}; charset=utf-8`, 'content-length': '4294967296' },
        body: 'x'.repeat(10_000),
      });

      const result = await fetcherOver(transport).fetchDocument('https://a.example/');

      expect(result.ok, type).toBe(false);
      if (!result.ok) expect(result.refusal.code, type).toBe('unsupported_content_type');
      // The decision came from the headers. A fetcher that read the body and
      // then checked would have set this true.
      expect(transport.responses[0]?.bodyRead, type).toBe(false);
      expect(transport.responses[0]?.discarded, type).toBe(true);
    }
  });

  it('refuses a response that declares no content type at all', async () => {
    const transport = new FakeTransport().route('https://a.example/', { status: 200, headers: {}, body: '<title>x</title>' });

    const result = await fetcherOver(transport).fetchDocument('https://a.example/');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('unsupported_content_type');
    expect(transport.responses[0]?.bodyRead).toBe(false);
  });

  it('accepts HTML however the type is spelled', async () => {
    for (const type of ['text/html', 'TEXT/HTML', 'text/html;charset=UTF-8', 'text/html ; charset=iso-8859-1', 'application/xhtml+xml']) {
      const transport = new FakeTransport().route('https://a.example/', {
        status: 200,
        headers: { 'content-type': type },
        body: '<title>Ledger</title>',
      });

      const result = await fetcherOver(transport).fetchDocument('https://a.example/');

      expect(result.ok, type).toBe(true);
      if (result.ok) expect(result.value.html, type).toContain('Ledger');
    }
  });

  it('refuses a non-2xx status without reading the body', async () => {
    for (const status of [400, 403, 404, 410, 500, 503]) {
      const transport = new FakeTransport().route('https://a.example/', {
        status,
        headers: { 'content-type': 'text/html' },
        body: '<title>error page</title>',
      });

      const result = await fetcherOver(transport).fetchDocument('https://a.example/');

      expect(result.ok, String(status)).toBe(false);
      if (!result.ok) expect(result.refusal.code, String(status)).toBe('bad_status');
      expect(transport.responses[0]?.bodyRead, String(status)).toBe(false);
    }
  });
});

describe('response size cap', () => {
  it('stops pulling bytes at the cap instead of buffering the whole body', async () => {
    // 100 chunks of 100 bytes, cap of 250. A fetcher that buffers and then
    // slices reads all 100; this one takes 3 and stops.
    const transport = new FakeTransport().route('https://a.example/', htmlPage('y'.repeat(10_000), 100));

    const result = await fetcherOver(transport, { maxBytes: 250 }).fetchDocument('https://a.example/');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.bytesRead).toBe(250);
    expect(result.value.truncated).toBe(true);
    expect(result.value.html).toHaveLength(250);
    expect(transport.responses[0]?.readLimit).toBe(250);
    expect(transport.responses[0]?.chunksProduced).toBe(3);
  });

  it('keeps the head, which is the only part that was ever wanted', async () => {
    const page = `<html><head><title>Ledger</title><meta name="description" content="Books that balance"></head><body>${'z'.repeat(50_000)}`;
    const transport = new FakeTransport().route('https://a.example/', htmlPage(page, 64));

    const result = await fetcherOver(transport, { maxBytes: 1_024 }).fetchDocument('https://a.example/');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.truncated).toBe(true);
    expect(result.value.html).toContain('<title>Ledger</title>');
  });

  it('reports a body under the cap as complete', async () => {
    const transport = new FakeTransport().route('https://a.example/', htmlPage('<title>Small</title>', 8));

    const result = await fetcherOver(transport, { maxBytes: 1_024 }).fetchDocument('https://a.example/');

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.truncated).toBe(false);
  });
});

describe('time budget', () => {
  it('refuses when the chain outlasts the budget, and names the hop it gave up on', async () => {
    // Each hop is a redirect and the clock advances 400ms per hop. The budget is
    // 1s, so hop four is refused rather than followed.
    const clock = fakeClock();
    const transport = new FakeTransport();
    const table: Record<string, readonly string[]> = {};
    for (let index = 0; index < 8; index += 1) {
      table[`hop${index}.example`] = [PUBLIC];
      transport.route(`https://hop${index}.example/`, redirectTo(`https://hop${index + 1}.example/`));
    }
    table['hop8.example'] = [PUBLIC];
    transport.route('https://hop8.example/', htmlPage('<title>End</title>'));

    const fetcher = createGuardedFetcher({
      resolver: new FakeResolver(table),
      transport: {
        send(request) {
          clock.advance(400);
          return transport.send(request);
        },
      },
      maxRedirects: 20,
      timeoutMs: 1_000,
      now: clock.now,
    });

    const result = await fetcher.fetchDocument('https://hop0.example/');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe('timeout');
      expect(result.refusal.reason).toMatch(/1000ms budget ran out/);
    }
    // Three hops fit inside 1000ms; the fourth is refused before it is sent.
    expect(transport.requests).toHaveLength(3);
  });

  it('maps an aborted transport to a timeout rather than a generic failure', async () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    const transport = new FakeTransport().route('https://a.example/', { error: abort });

    const result = await fetcherOver(transport, { timeoutMs: 50 }).fetchDocument('https://a.example/');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('timeout');
  });

  it('reports an ordinary connection failure as a transport error, not a timeout', async () => {
    const transport = new FakeTransport().route('https://a.example/', { error: new Error('ECONNREFUSED') });

    const result = await fetcherOver(transport).fetchDocument('https://a.example/');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe('transport_error');
      expect(result.refusal.reason).toMatch(/ECONNREFUSED/);
    }
  });
});

describe('resolveFinal', () => {
  it('reports the destination without reading any body', async () => {
    // A shortener may point at a 40 MB PDF. Where it points is the only question.
    const transport = new FakeTransport()
      .route('https://a.example/x', redirectTo('https://b.example/product'))
      .route('https://b.example/product', {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
        body: 'PDF'.repeat(100_000),
      });

    const result = await fetcherOver(transport).resolveFinal('https://a.example/x');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.finalUrl).toBe('https://b.example/product');
      expect(result.value.chain).toEqual(['https://a.example/x', 'https://b.example/product']);
    }
    expect(transport.responses.every((response) => !response.bodyRead)).toBe(true);
  });

  it('still refuses a bad status at the destination', async () => {
    const transport = new FakeTransport().route('https://a.example/x', { status: 404, headers: {} });

    const result = await fetcherOver(transport).resolveFinal('https://a.example/x');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('bad_status');
  });
});

describe('the fetcher never throws', () => {
  it('returns a refusal for every bad input rather than raising', async () => {
    const transport = new FakeTransport().otherwise(htmlPage(''));
    const fetcher = fetcherOver(transport);

    for (const url of ['', 'not a url', 'http://', 'https://:80/', 'file:///etc/passwd', '::::']) {
      const result = await fetcher.fetchDocument(url);
      expect(result.ok, url).toBe(false);
    }
  });
});
