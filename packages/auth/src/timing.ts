/**
 * A response-time floor, because `brief §2.1`'s no-enumeration rule is not only
 * about the response body.
 *
 * ## The oracle an identical body does not close
 *
 * `POST /auth/request` answers "check your inbox" for a known and an unknown
 * address. Byte for byte identical — and still trivially distinguishable, if the
 * known address took 340ms because the handler awaited a Resend API call and the
 * unknown one took 12ms because it did not. An attacker with a list of addresses
 * and a stopwatch reads that difference through the noise in a handful of
 * samples; it is a stronger signal than most timing side channels because the
 * difference is an entire network round trip rather than a few microseconds of
 * comparison.
 *
 * The fix is a floor: the handler does not return until at least `floorMs` of
 * wall clock has passed, so both paths are indistinguishable up to jitter that
 * no longer correlates with account existence. It costs latency on the one
 * endpoint in the product where nobody is waiting for anything — the human is
 * about to go and look at their inbox.
 *
 * ## Why the clock and the sleep are injected
 *
 * So the tests can be exact and instant. A test that actually slept 500ms would
 * be slow and, worse, flaky — it would assert on measured durations, which is
 * the one thing a CI runner will not give you twice. `FakeTimingFloor` in the
 * tests records the sleeps that were requested; the assertion is that the same
 * total elapsed time is reached on the known and the unknown path, which is the
 * property, stated directly.
 *
 * The floor is applied ONLY to the path that reaches the account lookup. A 400
 * for a malformed address and a 429 for a spent rate limit both depend on things
 * the caller already knows about themselves, so padding them would buy nothing
 * and would hand an attacker a way to pin a serverless function open for half a
 * second per request.
 */

/** Long enough to hide a provider round trip; short enough that nobody notices. */
export const DEFAULT_REQUEST_FLOOR_MS = 500;

export interface TimingFloor {
  readonly floorMs: number;
  /** A monotonic millisecond reading. Never `Date.now()` — that can go backwards. */
  monotonicNow(): number;
  sleep(ms: number): Promise<void>;
}

/** The production floor: `performance.now()` and `setTimeout`. */
export function systemTimingFloor(floorMs: number = DEFAULT_REQUEST_FLOOR_MS): TimingFloor {
  return {
    floorMs,
    monotonicNow: () => performance.now(),
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }),
  };
}

/** A floor of zero. For tests whose subject is not timing. */
export function noTimingFloor(): TimingFloor {
  return {
    floorMs: 0,
    monotonicNow: () => 0,
    sleep: () => Promise.resolve(),
  };
}

/**
 * Wait until `floorMs` have elapsed since `startedAt`.
 *
 * A no-op when the work already took longer, which is the common case under
 * load and is fine: the floor removes the *correlation* between duration and
 * account existence, and once real latency dominates there is no correlation
 * left to remove.
 */
export async function padTo(floor: TimingFloor, startedAt: number): Promise<void> {
  const remaining = floor.floorMs - (floor.monotonicNow() - startedAt);
  if (remaining > 0) {
    await floor.sleep(remaining);
  }
}
