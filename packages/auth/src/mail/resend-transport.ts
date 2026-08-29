/**
 * Resend, over `fetch`, with no SDK.
 *
 * `brief` Part 7 names Resend. This is forty lines of JSON POST; an SDK would
 * add a dependency, a bundling exception in `next.config.ts`, and a second
 * opinion about retries, in exchange for nothing this file does not already do.
 *
 * ## `fetch` is injected
 *
 * The constructor takes its `fetch`. That is what lets `test/resend.test.ts`
 * assert the exact request this transport builds — URL, method, authorization
 * header, body — with no network, no API key, and no fixture server. A transport
 * that reached for the global `fetch` could only be tested by monkey-patching a
 * global, which leaks between test files and stops being true the moment one of
 * them runs in parallel.
 *
 * ## It returns failures rather than throwing
 *
 * Per `mail/types.ts`: the requester is told "check your inbox" whether or not
 * delivery worked, because a response that varies with the target address is
 * `brief §2.1`'s enumeration oracle wearing an error page. A non-2xx from Resend
 * is a `failed` result carrying a reason for the log, and a thrown network error
 * is caught and turned into the same thing.
 *
 * The API key never appears in a returned reason. Provider error bodies are
 * truncated for the same reason.
 */

import type { MailSendResult, MailTransport, OutboundEmail } from './types.js';

export const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/** How much of a provider error body reaches the log. */
const MAX_REASON_LENGTH = 300;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ResendTransportOptions {
  readonly apiKey: string;
  readonly fetch: FetchLike;
  /** Overridable for a proxy or a test double. */
  readonly endpoint?: string;
}

export class ResendMailTransport implements MailTransport {
  readonly #apiKey: string;
  readonly #fetch: FetchLike;
  readonly #endpoint: string;

  constructor(options: ResendTransportOptions) {
    if (options.apiKey === '') {
      throw new RangeError('ResendMailTransport: apiKey is empty. Use FixtureMailTransport when there is no key.');
    }
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetch;
    this.#endpoint = options.endpoint ?? RESEND_ENDPOINT;
  }

  async send(message: OutboundEmail): Promise<MailSendResult> {
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
          // Resend honours this for at-least-once senders; ours is derived from
          // the token HASH, so a retry of the same magic link is one message.
          'idempotency-key': message.idempotencyKey,
        },
        body: JSON.stringify({
          from: message.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          html: message.html,
        }),
      });
    } catch (error) {
      return { outcome: 'failed', reason: `transport error: ${describe(error)}` };
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return {
        outcome: 'failed',
        reason: `resend responded ${response.status}: ${body.slice(0, MAX_REASON_LENGTH)}`,
      };
    }

    const parsed: unknown = await response.json().catch(() => null);
    const id =
      typeof parsed === 'object' && parsed !== null && typeof (parsed as { id?: unknown }).id === 'string'
        ? (parsed as { id: string }).id
        : '';

    return { outcome: 'sent', providerMessageId: id };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
