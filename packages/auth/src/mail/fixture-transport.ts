/**
 * A `MailTransport` that never opens a socket.
 *
 * Every test in this package and in `apps/web` runs against it, which is what
 * makes "no network, no API key" true rather than aspirational. It is also what
 * local development uses: the link is printed to the console, so the whole
 * returning-customer flow is clickable with no Resend account.
 *
 * `failNext` and `failAlways` exist because the interesting property of the
 * failure path is that it is INVISIBLE — `brief §2.1` requires the same "check
 * your inbox" whether or not delivery worked, and a transport that cannot be
 * made to fail leaves that untested.
 */

import type { MailSendResult, MailTransport, OutboundEmail } from './types.js';

export class FixtureMailTransport implements MailTransport {
  /** Every message the service asked to send, in order. */
  readonly sent: OutboundEmail[] = [];
  /** Every send that was made to fail, so a test can assert it was attempted. */
  readonly failed: OutboundEmail[] = [];
  #counter = 0;
  #failAlways = false;
  #failNext = 0;

  /**
   * @param log optional sink for the delivered message — `console.log` in local
   * development, so the magic link is clickable from the terminal.
   */
  constructor(private readonly log?: (message: OutboundEmail) => void) {}

  send(message: OutboundEmail): Promise<MailSendResult> {
    if (this.#failAlways || this.#failNext > 0) {
      if (this.#failNext > 0) {
        this.#failNext -= 1;
      }
      this.failed.push(message);
      return Promise.resolve({ outcome: 'failed', reason: 'fixture transport was told to fail' });
    }
    this.sent.push(message);
    this.log?.(message);
    this.#counter += 1;
    return Promise.resolve({ outcome: 'sent', providerMessageId: `fixture_${this.#counter}` });
  }

  failNextSends(count: number): void {
    this.#failNext = count;
  }

  failEverySend(): void {
    this.#failAlways = true;
  }

  /** The most recent delivered message, or `undefined`. */
  get last(): OutboundEmail | undefined {
    return this.sent.at(-1);
  }

  /** Delivered messages addressed to one recipient. */
  to(recipient: string): readonly OutboundEmail[] {
    return this.sent.filter((message) => message.to === recipient);
  }
}

/**
 * A transport that throws instead of returning a failure.
 *
 * A provider client that rejects — a DNS failure, an aborted socket, a 500 that
 * the SDK turns into an exception — is the case where an unguarded `await` would
 * turn into a 500 response, and a 500 for a known address next to a 200 for an
 * unknown one is the enumeration oracle in its purest form. Something has to be
 * able to produce that in a test.
 */
export class ThrowingMailTransport implements MailTransport {
  readonly attempted: OutboundEmail[] = [];

  send(message: OutboundEmail): Promise<MailSendResult> {
    this.attempted.push(message);
    return Promise.reject(new Error('mail provider is unreachable'));
  }
}
