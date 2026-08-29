/**
 * The one place in this repository that opens a socket to Dodo.
 *
 * `DodoTransport` is declared in `@the-pit/payments` and that package performs no
 * I/O at all — `checkout/types.ts` calls the interface "the single hole through
 * which a real HTTP client is injected", and `FixtureDodoTransport` is the
 * in-memory implementation that lets the entire purchase flow run in CI and on a
 * laptop with no Dodo account. This file is the other implementation, and it is
 * the ONLY file that has to change if Dodo's API moves.
 *
 * That split is the same one `packages/auth` makes with `FixtureOAuthProvider`
 * and `GitHubOAuthProvider`, and the same one the engine makes with
 * `FixtureClient`. The point of it is not tidiness: it is that every test in this
 * app exercises the real handler, the real guards and the real session logic
 * against a transport that cannot reach the network, so "runs offline" is a
 * property of the code rather than of a mocking library.
 *
 * ## Test mode is the default and live mode is a deliberate act
 *
 * `brief` Phase 3 ships against Dodo test mode. The base URL is derived from
 * `DodoConfig.mode`, so a deployment that has not said `DODO_MODE=live` cannot
 * accidentally charge anybody, and `createCheckoutSession` refuses a live-mode
 * session without `acknowledgeLiveMode` on top of that. Two locks, because the
 * failure they prevent is taking real money for a product that is not ready.
 *
 * ## The response is parsed tolerantly and the request is not
 *
 * We send exactly what we mean. What comes back is read for the two fields we
 * use, under each of the names Dodo's API and its SDK have used for them, and a
 * response that carries neither is a loud error rather than a session object with
 * an empty link in it — a checkout button that leads to `""` is the failure that
 * looks like it worked.
 */

import type { DodoCheckoutRequest, DodoCheckoutSession, DodoMode, DodoTransport } from '@the-pit/payments';

/** Dodo's two hosts. `brief` Phase 3 uses the first one. */
export const DODO_API_BASE: Readonly<Record<DodoMode, string>> = {
  test: 'https://test.dodopayments.com',
  live: 'https://live.dodopayments.com',
};

export class DodoTransportError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'DodoTransportError';
    this.status = status;
  }
}

export interface HttpDodoTransportOptions {
  readonly apiKey: string;
  readonly mode: DodoMode;
  /** Overridable so a contract test can point at a local recorder. */
  readonly baseUrl?: string;
  /** Injected so this class is testable without monkey-patching a global. */
  readonly fetch?: typeof globalThis.fetch;
  /** A checkout call that has not answered in this long has failed. */
  readonly timeoutMs?: number;
}

/** Ten seconds. A buyer is watching a spinner; a stuck socket is not a strategy. */
const DEFAULT_TIMEOUT_MS = 10_000;

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export class HttpDodoTransport implements DodoTransport {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #timeoutMs: number;

  constructor(options: HttpDodoTransportOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl ?? DODO_API_BASE[options.mode];
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async createCheckoutSession(request: DodoCheckoutRequest): Promise<DodoCheckoutSession> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/checkouts`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
          // Dodo's own retry key. Distinct from `jobIdempotencyKey`, which guards
          // the RUN; this one guards the call, so a double-clicked pay button
          // opens one session rather than two.
          'idempotency-key': request.idempotencyKey,
        },
        body: JSON.stringify({
          product_cart: [{ product_id: request.productId, quantity: request.quantity }],
          return_url: request.returnUrl,
          // Attacker-influenced by construction and treated that way on the way
          // back: the webhook re-reads the tier from the amount and re-derives
          // the normalized URL rather than trusting anything in here.
          metadata: request.metadata,
        }),
        signal: controller.signal,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new DodoTransportError(`could not reach Dodo: ${reason}`, 0);
    } finally {
      clearTimeout(timer);
    }

    const body: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      // The status is carried so the caller can tell "we are misconfigured" from
      // "Dodo is down"; the body is not, because it is a third party's text and
      // this message reaches a log a person reads.
      throw new DodoTransportError(`Dodo refused the checkout (HTTP ${response.status})`, response.status);
    }

    const parsed = record(body);
    const paymentLink = text(parsed['checkout_url']) ?? text(parsed['payment_link']) ?? text(parsed['url']);
    const sessionId = text(parsed['session_id']) ?? text(parsed['id']) ?? text(parsed['checkout_id']);

    if (paymentLink === undefined || sessionId === undefined) {
      throw new DodoTransportError(
        'Dodo answered 200 with no checkout URL. Refusing to hand the buyer a link to nowhere.',
        response.status,
      );
    }

    return { sessionId, paymentLink };
  }
}
