/**
 * Test doubles that make the timing and delivery properties observable.
 *
 * A test that measured real wall-clock durations would be slow and flaky, and
 * flaky is worse than absent for a security assertion — it gets skipped. So the
 * clock is a number this file owns: the mail transport advances it, the service
 * pads against it, and the assertion is on the arithmetic rather than on a
 * stopwatch.
 */

import type { MailSendResult, MailTransport, OutboundEmail, TimingFloor } from '../../src/index.js';

/**
 * A `TimingFloor` whose clock only moves when something says it moved.
 *
 * `sleep` advances it, so after `padTo` the reading is exactly where the floor
 * put it — which is the value the enumeration test compares across a known and
 * an unknown address.
 */
export class FakeTimingFloor implements TimingFloor {
  readonly sleeps: number[] = [];
  #clock = 0;

  constructor(readonly floorMs: number) {}

  monotonicNow(): number {
    return this.#clock;
  }

  sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.#clock += ms;
    return Promise.resolve();
  }

  /** Something took time. Called by `SlowMailTransport`. */
  advance(ms: number): void {
    this.#clock += ms;
  }

  get elapsed(): number {
    return this.#clock;
  }
}

/**
 * A transport that costs time — the provider round trip that makes the
 * known-address path measurably slower than the unknown one when nothing pads
 * it. This is the leak the floor closes, so a test needs to be able to cause it.
 */
export class SlowMailTransport implements MailTransport {
  readonly sent: OutboundEmail[] = [];

  constructor(
    private readonly clock: FakeTimingFloor,
    private readonly costMs: number,
  ) {}

  send(message: OutboundEmail): Promise<MailSendResult> {
    this.clock.advance(this.costMs);
    this.sent.push(message);
    return Promise.resolve({ outcome: 'sent', providerMessageId: `slow_${this.sent.length}` });
  }
}

/** A 64-character signing secret. Long enough for `assertUsableKeyring`. */
export const TEST_SECRET = 'test-secret-0123456789abcdef0123456789abcdef0123456789abcdef01';

/** A second one, for the keyring-rotation tests. */
export const TEST_SECRET_OLD = 'old-secret-0123456789abcdef0123456789abcdef0123456789abcdef012';

/** Headers as a `Request` exposes them, for `clientIp`. */
export function headers(entries: Record<string, string>): { get(name: string): string | null } {
  const map = new Map(Object.entries(entries).map(([key, value]) => [key.toLowerCase(), value]));
  return { get: (name) => map.get(name.toLowerCase()) ?? null };
}
