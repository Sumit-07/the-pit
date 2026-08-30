/**
 * The backfill, driven against a fake network.
 *
 * Ninety-two product URLs is a small number of hosts and a large number of ways
 * for a host to disappoint you. The properties worth pinning are therefore not
 * "it fetches an icon" — that is the easy path and it holds — but the ones that
 * decide whether this can be RUN AGAIN:
 *
 * - a miss is an answer, recorded, and not re-asked;
 * - a hit is never re-fetched;
 * - a second run over an unchanged board does no network work and produces an
 *   identical file;
 * - an interrupted run leaves enough behind to resume from;
 * - and every failure the real web produces is a miss rather than a throw.
 *
 * The fake fetcher counts calls, because most of these are claims about what did
 * NOT happen.
 */

import { describe, expect, it } from 'vitest';
import type { AssetOptions, FetchOutcome, FetchedAsset, FetchedDocument, GuardedFetcher, ResolvedTarget } from '@the-pit/fetch';

import { emptyFaviconIndex, faviconDataUri, type FaviconIndex } from '@/lib/boards/favicon';
import { FAVICON_WEIGHT_LIMIT } from '@/lib/boards/favicon-image';
import { resolveBoardFavicons, type FaviconTarget } from '@/lib/boards/favicon-backfill';

// ------------------------------------------------------------------- fixtures

/** A PNG of `size` bytes declaring 32x32. Compressible, so it fits the weight budget. */
function png(size = 400): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8);
  bytes.set([0, 0, 0, 32], 16);
  bytes.set([0, 0, 0, 32], 20);
  return bytes;
}

/** A PNG of INCOMPRESSIBLE noise, so its compressed cost is roughly its size. */
function noisyPng(size: number): Uint8Array {
  const bytes = png(size);
  let state = 12345;
  for (let i = 24; i < size; i += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    bytes[i] = (state >> 16) & 0xff;
  }
  return bytes;
}

const HTML = (head: string): string => `<html><head>${head}</head><body></body></html>`;

interface Route {
  /** The page's HTML, or a refusal code for the page fetch. */
  page?: string;
  pageRefusal?: string;
  /** Asset routes, by absolute URL. */
  assets?: Record<string, { bytes?: Uint8Array; contentType?: string; refusal?: string }>;
}

class CountingFetcher implements GuardedFetcher {
  documentCalls: string[] = [];
  assetCalls: string[] = [];

  constructor(private readonly routes: Readonly<Record<string, Route>>) {}

  get calls(): number {
    return this.documentCalls.length + this.assetCalls.length;
  }

  resolveFinal(url: string): Promise<FetchOutcome<ResolvedTarget>> {
    return Promise.resolve({ ok: true, value: { requestedUrl: url, finalUrl: url, chain: [url], status: 200 } });
  }

  fetchDocument(url: string): Promise<FetchOutcome<FetchedDocument>> {
    this.documentCalls.push(url);
    const route = this.routes[url];
    if (route?.pageRefusal !== undefined || route?.page === undefined) {
      return Promise.resolve({
        ok: false,
        refusal: { code: (route?.pageRefusal ?? 'bad_status') as never, reason: `fake page failure for ${url}`, url },
      });
    }
    return Promise.resolve({
      ok: true,
      value: {
        requestedUrl: url,
        finalUrl: url,
        chain: [url],
        status: 200,
        contentType: 'text/html',
        html: route.page,
        bytesRead: route.page.length,
        truncated: false,
      },
    });
  }

  fetchAsset(url: string, _options?: AssetOptions): Promise<FetchOutcome<FetchedAsset>> {
    this.assetCalls.push(url);
    for (const route of Object.values(this.routes)) {
      const asset = route.assets?.[url];
      if (asset === undefined) continue;
      if (asset.refusal !== undefined || asset.bytes === undefined) {
        return Promise.resolve({
          ok: false,
          refusal: { code: (asset.refusal ?? 'bad_status') as never, reason: `fake asset failure for ${url}`, url },
        });
      }
      return Promise.resolve({
        ok: true,
        value: {
          requestedUrl: url,
          finalUrl: url,
          chain: [url],
          status: 200,
          contentType: asset.contentType ?? 'image/png',
          bytes: asset.bytes,
        },
      });
    }
    return Promise.resolve({
      ok: false,
      refusal: { code: 'bad_status' as never, reason: `${url} answered 404`, url },
    });
  }
}

const FIXED = (): Date => new Date('2026-08-30T12:00:00.000Z');

function targets(...urls: string[]): FaviconTarget[] {
  return urls.map((url, index) => ({ url, name: `Product ${index}` }));
}

// ---------------------------------------------------------------------- tests

describe('resolving one product', () => {
  it('prefers the icon the page itself declares', async () => {
    const fetcher = new CountingFetcher({
      'https://a.example/': {
        page: HTML('<link rel="icon" href="/brand/icon.png">'),
        assets: { 'https://a.example/brand/icon.png': { bytes: png(500) } },
      },
    });

    const result = await resolveBoardFavicons('cat', targets('https://a.example/'), fetcher, undefined, { now: FIXED });

    expect(result.resolved).toBe(1);
    const icon = result.index.icons['https://a.example/'];
    expect(icon?.source).toBe('https://a.example/brand/icon.png');
    expect(icon?.format).toBe('png');
    expect(icon?.width).toBe(32);
    expect(icon?.bytes).toBe(500);
    // One page fetch, one asset fetch. The conventional path was never asked
    // for, because the declared one worked.
    expect(fetcher.assetCalls).toEqual(['https://a.example/brand/icon.png']);
  });

  it('falls back to /favicon.ico when the page cannot be read at all', async () => {
    // A JS-only shell, or a 403 to a bot user-agent. Extremely common, and the
    // conventional path is usually still sitting right there.
    const fetcher = new CountingFetcher({
      'https://a.example/': {
        pageRefusal: 'timeout',
        assets: { 'https://a.example/favicon.ico': { bytes: png(300), contentType: 'image/x-icon' } },
      },
    });

    const result = await resolveBoardFavicons('cat', targets('https://a.example/'), fetcher, undefined, { now: FIXED });

    expect(result.resolved).toBe(1);
    expect(result.index.icons['https://a.example/']?.source).toBe('https://a.example/favicon.ico');
  });

  it('falls back when the declared icon is an SVG the fetcher refuses', async () => {
    // The single commonest reason a live, healthy site fails the first
    // candidate: it declares `favicon.svg`, and an SVG is a document that can
    // carry script, so `@the-pit/fetch` will not read one.
    const fetcher = new CountingFetcher({
      'https://a.example/': {
        page: HTML('<link rel="icon" href="/favicon.svg">'),
        assets: {
          'https://a.example/favicon.svg': { refusal: 'unsupported_content_type' },
          'https://a.example/favicon.ico': { bytes: png(300) },
        },
      },
    });

    const result = await resolveBoardFavicons('cat', targets('https://a.example/'), fetcher, undefined, { now: FIXED });

    expect(result.resolved).toBe(1);
    expect(fetcher.assetCalls).toEqual(['https://a.example/favicon.svg', 'https://a.example/favicon.ico']);
  });

  it('records a miss with the code and the sentence, and never throws', async () => {
    const fetcher = new CountingFetcher({ 'https://gone.example/': { pageRefusal: 'dns_failure' } });

    const result = await resolveBoardFavicons('cat', targets('https://gone.example/'), fetcher, undefined, { now: FIXED });

    expect(result.resolved).toBe(0);
    expect(result.missed).toBe(1);
    const miss = result.index.misses['https://gone.example/'];
    expect(miss?.code).toBe('bad_status');
    expect(miss?.reason).toContain('answered 404');
    expect(miss?.checkedAt).toBe('2026-08-30T12:00:00.000Z');
    // A miss is an answer, not an error: nothing was thrown and the run finished.
    expect(result.index.icons['https://gone.example/']).toBeUndefined();
  });

  it('rejects an HTML error page served with an image content type', async () => {
    // The header said `image/png`; the bytes are a document. Only the second
    // check can see this, and without it the board gets a broken-image glyph.
    const html = Uint8Array.from([...'<!DOCTYPE html><h1>Not found</h1>'].map((c) => c.charCodeAt(0)));
    const fetcher = new CountingFetcher({
      'https://a.example/': {
        page: HTML(''),
        assets: { 'https://a.example/favicon.ico': { bytes: html, contentType: 'image/png' } },
      },
    });

    const result = await resolveBoardFavicons('cat', targets('https://a.example/'), fetcher, undefined, { now: FIXED });

    expect(result.resolved).toBe(0);
    expect(result.index.misses['https://a.example/']?.code).toBe('not_an_image');
  });

  it('rejects an icon whose COMPRESSED cost is over the page-weight budget', async () => {
    const fetcher = new CountingFetcher({
      'https://a.example/': {
        page: HTML(''),
        assets: { 'https://a.example/favicon.ico': { bytes: noisyPng(FAVICON_WEIGHT_LIMIT * 3) } },
      },
    });

    const result = await resolveBoardFavicons('cat', targets('https://a.example/'), fetcher, undefined, { now: FIXED });

    expect(result.resolved).toBe(0);
    const miss = result.index.misses['https://a.example/'];
    expect(miss?.code).toBe('too_costly');
    expect(miss?.reason).toContain('compressed bytes');
  });

  it('records the compressed weight of what it did store', async () => {
    const fetcher = new CountingFetcher({
      'https://a.example/': {
        page: HTML(''),
        assets: { 'https://a.example/favicon.ico': { bytes: png(4_000) } },
      },
    });

    const result = await resolveBoardFavicons('cat', targets('https://a.example/'), fetcher, undefined, { now: FIXED });

    const icon = result.index.icons['https://a.example/'];
    expect(icon?.weight).toBeGreaterThan(0);
    expect(icon?.weight).toBeLessThanOrEqual(FAVICON_WEIGHT_LIMIT);
    // A run of zeroes compresses to almost nothing, which is the whole reason
    // the budget is measured on this number and not on `bytes`.
    expect(icon?.weight).toBeLessThan(icon?.bytes ?? 0);
  });

  it('stores base64 that round-trips into a usable data URL', async () => {
    const bytes = png(600);
    const fetcher = new CountingFetcher({
      'https://a.example/': { page: HTML(''), assets: { 'https://a.example/favicon.ico': { bytes } } },
    });

    const result = await resolveBoardFavicons('cat', targets('https://a.example/'), fetcher, undefined, { now: FIXED });

    const uri = faviconDataUri(result.index.icons['https://a.example/']);
    expect(uri).toMatch(/^data:image\/png;base64,/);
    expect([...Buffer.from((uri ?? '').split(',')[1] ?? '', 'base64')]).toEqual([...bytes]);
  });

  it('never asks for a product URL that is not http(s)', async () => {
    const fetcher = new CountingFetcher({});

    const result = await resolveBoardFavicons('cat', targets('not a url at all'), fetcher, undefined, { now: FIXED });

    expect(result.missed).toBe(1);
    // The page fetch is still attempted (the fetcher is the thing that judges a
    // URL), but no `/favicon.ico` was invented for a string that has no origin.
    expect(fetcher.assetCalls).toEqual([]);
  });
});

describe('idempotent, and resumable', () => {
  const routes = {
    'https://a.example/': { page: HTML(''), assets: { 'https://a.example/favicon.ico': { bytes: png(400) } } },
    'https://b.example/': { pageRefusal: 'dns_failure' },
    'https://c.example/': { page: HTML(''), assets: { 'https://c.example/favicon.ico': { bytes: png(500) } } },
  } as const;
  const all = targets('https://a.example/', 'https://b.example/', 'https://c.example/');

  it('does no network work at all on a second run', async () => {
    const first = new CountingFetcher(routes);
    const one = await resolveBoardFavicons('cat', all, first, undefined, { now: FIXED });
    expect(first.calls).toBeGreaterThan(0);

    const second = new CountingFetcher(routes);
    const two = await resolveBoardFavicons('cat', all, second, one.index, { now: FIXED });

    expect(second.calls).toBe(0);
    expect(two.attempted).toBe(0);
    expect(two.skipped).toBe(3);
  });

  it('produces a byte-identical index on a second run, moving clock and all', async () => {
    // The file is committed beside the board it describes, so "identical" has to
    // survive the timestamp too. A run that learned nothing must not stamp
    // itself, or every invocation puts a diff in front of a reviewer.
    const one = await resolveBoardFavicons('cat', all, new CountingFetcher(routes), undefined, { now: FIXED });
    const later = (): Date => new Date('2027-01-01T00:00:00.000Z');
    const two = await resolveBoardFavicons('cat', all, new CountingFetcher(routes), one.index, { now: later });

    expect(JSON.stringify(two.index)).toBe(JSON.stringify(one.index));
    expect(two.index.updatedAt).toBe(one.index.updatedAt);
  });

  it('does stamp itself when it actually learned something', async () => {
    const one = await resolveBoardFavicons('cat', all, new CountingFetcher(routes), undefined, { now: FIXED });
    const later = (): Date => new Date('2027-01-01T00:00:00.000Z');

    const two = await resolveBoardFavicons('cat', all, new CountingFetcher(routes), one.index, {
      now: later,
      refresh: true,
    });

    expect(two.index.updatedAt).toBe('2027-01-01T00:00:00.000Z');
  });

  it('does not re-ask a recorded miss, which is where a real run spends its time', async () => {
    // The dead hosts are the expensive ones: each is a full five-second budget.
    // Skipping them is what turns a re-run from seven minutes into nothing.
    const one = await resolveBoardFavicons('cat', all, new CountingFetcher(routes), undefined, { now: FIXED });
    expect(one.index.misses['https://b.example/']).toBeDefined();

    const second = new CountingFetcher(routes);
    await resolveBoardFavicons('cat', all, second, one.index, { now: FIXED });

    expect(second.documentCalls).not.toContain('https://b.example/');
  });

  it('re-asks misses on demand, and leaves the hits alone', async () => {
    const one = await resolveBoardFavicons('cat', all, new CountingFetcher(routes), undefined, { now: FIXED });

    // A week later, the host is back.
    const revived = new CountingFetcher({
      ...routes,
      'https://b.example/': { page: HTML(''), assets: { 'https://b.example/favicon.ico': { bytes: png(700) } } },
    });
    const two = await resolveBoardFavicons('cat', all, revived, one.index, { now: FIXED, retryMisses: true });

    expect(two.resolved).toBe(1);
    expect(two.skipped).toBe(2);
    expect(two.index.icons['https://b.example/']).toBeDefined();
    // And the record is no longer in two minds about it.
    expect(two.index.misses['https://b.example/']).toBeUndefined();
    expect(revived.documentCalls).toEqual(['https://b.example/']);
  });

  it('re-fetches everything on refresh, hits included', async () => {
    const one = await resolveBoardFavicons('cat', all, new CountingFetcher(routes), undefined, { now: FIXED });
    const third = new CountingFetcher(routes);

    const two = await resolveBoardFavicons('cat', all, third, one.index, { now: FIXED, refresh: true });

    expect(two.attempted).toBe(3);
    expect(two.skipped).toBe(0);
    expect(third.documentCalls.sort()).toEqual(['https://a.example/', 'https://b.example/', 'https://c.example/']);
  });

  it('never mutates the index it was handed, so an interrupted run cannot corrupt one', async () => {
    const before: FaviconIndex = emptyFaviconIndex('cat');
    const snapshot = JSON.parse(JSON.stringify(before)) as FaviconIndex;

    await resolveBoardFavicons('cat', all, new CountingFetcher(routes), before, { now: FIXED });

    expect(before).toEqual(snapshot);
  });

  it('reports every settled product so a caller can checkpoint as it goes', async () => {
    // This is what makes an interrupted run resumable: the script writes the
    // file on each of these, so a kill at second forty keeps the first thirty.
    const seen: string[] = [];

    await resolveBoardFavicons('cat', all, new CountingFetcher(routes), undefined, {
      now: FIXED,
      onProgress: (event) => seen.push(`${event.kind}:${event.target.url}`),
    });

    expect(seen.sort()).toEqual([
      'hit:https://a.example/',
      'hit:https://c.example/',
      'miss:https://b.example/',
    ]);
  });

  it('reports a skip separately from a hit, so a re-run is legible', async () => {
    const one = await resolveBoardFavicons('cat', all, new CountingFetcher(routes), undefined, { now: FIXED });
    const kinds: string[] = [];

    await resolveBoardFavicons('cat', all, new CountingFetcher(routes), one.index, {
      now: FIXED,
      onProgress: (event) => kinds.push(event.kind === 'skipped' ? `skipped:${event.because}` : event.kind),
    });

    expect(kinds.sort()).toEqual(['skipped:has-icon', 'skipped:has-icon', 'skipped:known-miss']);
  });
});

describe('bounded concurrency', () => {
  it('never has more than `concurrency` products in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const urls = Array.from({ length: 20 }, (_, index) => `https://h${index}.example/`);
    const routes = Object.fromEntries(
      urls.map((url) => [url, { page: HTML(''), assets: { [`${url}favicon.ico`]: { bytes: png(300) } } }]),
    );

    class SlowFetcher extends CountingFetcher {
      override async fetchDocument(url: string): Promise<FetchOutcome<FetchedDocument>> {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        const answer = await super.fetchDocument(url);
        inFlight -= 1;
        return answer;
      }
    }

    const result = await resolveBoardFavicons('cat', targets(...urls), new SlowFetcher(routes), undefined, {
      now: FIXED,
      concurrency: 4,
    });

    expect(result.resolved).toBe(20);
    expect(peak).toBeLessThanOrEqual(4);
    // And it really did run in parallel, rather than passing by being serial.
    expect(peak).toBeGreaterThan(1);
  });

  it('asks each distinct host once, however many rows share a URL', async () => {
    const fetcher = new CountingFetcher({
      'https://a.example/': { page: HTML(''), assets: { 'https://a.example/favicon.ico': { bytes: png(300) } } },
    });

    const result = await resolveBoardFavicons(
      'cat',
      targets('https://a.example/', 'https://a.example/', 'https://a.example/'),
      fetcher,
      undefined,
      { now: FIXED },
    );

    expect(fetcher.documentCalls).toEqual(['https://a.example/']);
    expect(result.attempted).toBe(1);
  });

  it('finishes an empty board without dialling anything', async () => {
    const fetcher = new CountingFetcher({});
    const result = await resolveBoardFavicons('cat', [], fetcher, undefined, { now: FIXED });

    expect(fetcher.calls).toBe(0);
    expect(result.index.icons).toEqual({});
  });
});
