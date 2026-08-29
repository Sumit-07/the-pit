/**
 * `HttpDodoTransport` — the one class in this repository that opens a socket to
 * Dodo, tested with the socket held shut.
 *
 * `fetch` is injected, so every assertion below is about the REQUEST we compose
 * and the RESPONSE we accept, with no network, no API key and no Dodo account.
 * That is the point of `DodoTransport` being an interface: `FixtureDodoTransport`
 * lets the whole purchase flow run offline, and this file makes sure the thing
 * standing in for it in production is composing the request the fixture is
 * pretending to be.
 *
 * The two failures worth naming, because they are the ones that look like
 * success:
 *
 * 1. **A 200 with no checkout URL.** Returning `{paymentLink: ''}` would put a
 *    button on the page that leads to nowhere, and the buyer would report it as
 *    "the site is broken" rather than as "the payment failed".
 * 2. **Live mode reached by accident.** The base URL comes from
 *    `DodoConfig.mode`, so a deployment that has not said `DODO_MODE=live` cannot
 *    talk to the host that moves real money.
 */

import { describe, expect, it } from 'vitest';

import { DODO_API_BASE, DodoTransportError, HttpDodoTransport } from '@/lib/checkout/transport';

const REQUEST = {
  productId: 'prod_single',
  quantity: 1,
  returnUrl: 'https://thepit.show/checkout/success',
  idempotencyKey: 'a'.repeat(64),
  metadata: { submission_id: 'sub_1', cycle_id: '2026-06-01' },
};

interface Captured {
  url: string;
  init: RequestInit;
}

/** A `fetch` that records what it was asked for and answers from a fixture. */
function recordingFetch(
  response: { status: number; body: unknown } | { throws: string },
): { fetch: typeof globalThis.fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchLike = (input: unknown, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} });
    if ('throws' in response) return Promise.reject(new Error(response.throws));
    return Promise.resolve(
      new Response(JSON.stringify(response.body), {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetch: fetchLike as typeof globalThis.fetch, calls };
}

function headerOf(init: RequestInit, name: string): string {
  const headers = (init.headers ?? {}) as Record<string, string>;
  return headers[name] ?? '';
}

describe('the request we compose', () => {
  it('posts to the TEST host in test mode', async () => {
    const { fetch, calls } = recordingFetch({ status: 200, body: { session_id: 'cs_1', checkout_url: 'https://pay' } });
    await new HttpDodoTransport({ apiKey: 'k', mode: 'test', fetch }).createCheckoutSession(REQUEST);

    expect(calls[0]?.url).toBe(`${DODO_API_BASE.test}/checkouts`);
    expect(calls[0]?.url).not.toContain('live');
  });

  it('posts to the LIVE host only when the mode says so', async () => {
    const { fetch, calls } = recordingFetch({ status: 200, body: { session_id: 'cs_1', checkout_url: 'https://pay' } });
    await new HttpDodoTransport({ apiKey: 'k', mode: 'live', fetch }).createCheckoutSession(REQUEST);

    expect(calls[0]?.url).toBe(`${DODO_API_BASE.live}/checkouts`);
  });

  it('carries the API key as a bearer token and never in the URL', async () => {
    const { fetch, calls } = recordingFetch({ status: 200, body: { session_id: 'cs_1', checkout_url: 'https://pay' } });
    await new HttpDodoTransport({ apiKey: 'sk_test_secret', mode: 'test', fetch }).createCheckoutSession(REQUEST);

    expect(headerOf(calls[0]?.init ?? {}, 'authorization')).toBe('Bearer sk_test_secret');
    // A key in a query string ends up in access logs and in `Referer`.
    expect(calls[0]?.url).not.toContain('sk_test_secret');
  });

  it('sends our idempotency key as Dodo’s idempotency key', async () => {
    // The key that makes a double-clicked pay button open one session rather than
    // two. Distinct from `jobIdempotencyKey`, which guards the run.
    const { fetch, calls } = recordingFetch({ status: 200, body: { session_id: 'cs_1', checkout_url: 'https://pay' } });
    await new HttpDodoTransport({ apiKey: 'k', mode: 'test', fetch }).createCheckoutSession(REQUEST);

    expect(headerOf(calls[0]?.init ?? {}, 'idempotency-key')).toBe(REQUEST.idempotencyKey);
  });

  it('sends the cart, the return URL and the metadata, and nothing else', async () => {
    const { fetch, calls } = recordingFetch({ status: 200, body: { session_id: 'cs_1', checkout_url: 'https://pay' } });
    await new HttpDodoTransport({ apiKey: 'k', mode: 'test', fetch }).createCheckoutSession(REQUEST);

    const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['metadata', 'product_cart', 'return_url']);
    expect(body['product_cart']).toEqual([{ product_id: 'prod_single', quantity: 1 }]);
    expect(body['return_url']).toBe(REQUEST.returnUrl);
    expect(body['metadata']).toEqual(REQUEST.metadata);
  });
});

describe('the response we accept', () => {
  it('reads the session and the link', async () => {
    const { fetch } = recordingFetch({
      status: 200,
      body: { session_id: 'cs_test_9', checkout_url: 'https://test.checkout.dodopayments.com/s/9' },
    });
    const session = await new HttpDodoTransport({ apiKey: 'k', mode: 'test', fetch }).createCheckoutSession(REQUEST);

    expect(session).toEqual({ sessionId: 'cs_test_9', paymentLink: 'https://test.checkout.dodopayments.com/s/9' });
  });

  it('accepts the alternative field names the SDK has used', async () => {
    // Read tolerantly, because a renamed field upstream must not be a silent
    // empty link. Written strictly — see the request tests above.
    const { fetch } = recordingFetch({ status: 200, body: { id: 'cs_2', payment_link: 'https://pay/2' } });
    const session = await new HttpDodoTransport({ apiKey: 'k', mode: 'test', fetch }).createCheckoutSession(REQUEST);

    expect(session).toEqual({ sessionId: 'cs_2', paymentLink: 'https://pay/2' });
  });

  it('refuses a 200 that carries no checkout URL rather than returning an empty one', async () => {
    // The failure that looks like success: a pay button that leads to "".
    const { fetch } = recordingFetch({ status: 200, body: { session_id: 'cs_3' } });

    await expect(
      new HttpDodoTransport({ apiKey: 'k', mode: 'test', fetch }).createCheckoutSession(REQUEST),
    ).rejects.toThrow(DodoTransportError);
  });

  it('reports the status on a refusal and does not echo Dodo’s body into our log', async () => {
    const { fetch } = recordingFetch({ status: 401, body: { message: 'invalid api key sk_test_secret' } });

    await expect(
      new HttpDodoTransport({ apiKey: 'k', mode: 'test', fetch }).createCheckoutSession(REQUEST),
    ).rejects.toThrow(/HTTP 401/);
    await expect(
      new HttpDodoTransport({ apiKey: 'k', mode: 'test', fetch }).createCheckoutSession(REQUEST),
    ).rejects.not.toThrow(/sk_test_secret/);
  });

  it('turns an unreachable host into a named error, not an unhandled rejection', async () => {
    const { fetch } = recordingFetch({ throws: 'ECONNREFUSED' });

    await expect(
      new HttpDodoTransport({ apiKey: 'k', mode: 'test', fetch }).createCheckoutSession(REQUEST),
    ).rejects.toThrow(/could not reach Dodo/);
  });
});
