/**
 * A `DodoTransport` that never opens a socket.
 *
 * Shipped in `src` rather than in `test`, for the same reason the engine ships
 * `FixtureClient`: local development and CI need to run the whole purchase flow
 * without a Dodo account, and a fixture that only exists inside the test folder
 * gets reimplemented — differently — the first time someone wants to click
 * through the app.
 *
 * It also enforces the guarantee it is standing in for: calling it twice with
 * the same idempotency key returns the SAME session rather than a second one,
 * which is what a test of the double-clicked pay button needs to be able to
 * observe. `calls` records every request so a test can assert one was made.
 */

import type { DodoCheckoutRequest, DodoCheckoutSession, DodoTransport } from './types.js';

export class FixtureDodoTransport implements DodoTransport {
  readonly calls: DodoCheckoutRequest[] = [];
  readonly #sessions = new Map<string, DodoCheckoutSession>();
  #counter = 0;

  createCheckoutSession(request: DodoCheckoutRequest): Promise<DodoCheckoutSession> {
    this.calls.push(request);
    const existing = this.#sessions.get(request.idempotencyKey);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    this.#counter += 1;
    const session: DodoCheckoutSession = {
      sessionId: `cs_test_${this.#counter}`,
      paymentLink: `https://test.checkout.dodopayments.com/session/cs_test_${this.#counter}`,
    };
    this.#sessions.set(request.idempotencyKey, session);
    return Promise.resolve(session);
  }

  /** How many DISTINCT sessions were opened, as opposed to how many calls were made. */
  get sessionCount(): number {
    return this.#sessions.size;
  }
}
