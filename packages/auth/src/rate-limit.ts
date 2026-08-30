/**
 * Rate limiting, per `brief §2.1`: "Rate limit per email and per IP."
 *
 * ## Why both, and why they are independent
 *
 * They stop different attacks and neither one covers the other.
 *
 * - **Per email** stops using this endpoint as a mail cannon: one address, a
 *   thousand requests, a thousand messages into someone's inbox from a domain
 *   we are trying to keep out of spam folders. The attacker rotates IPs freely,
 *   so an IP limit alone does nothing here.
 * - **Per IP** stops enumeration and address harvesting: a thousand different
 *   addresses from one host. The email bucket for each is untouched, so an email
 *   limit alone does nothing here.
 *
 * Because they defend against different things, they are counted in different
 * namespaces and one filling up must never fill the other. `bucketKey` is what
 * enforces that, and `test/rate-limit.test.ts` asserts it: exhausting one
 * address's budget leaves a second address on the same IP still able to request,
 * and exhausting an IP's budget leaves the same address able to request from
 * elsewhere.
 *
 * ## Sliding window, not fixed
 *
 * A fixed window lets a caller spend the whole budget in the last second of one
 * window and the whole budget again in the first second of the next — double the
 * intended rate, at the worst possible moment. The window here slides: a request
 * is allowed when fewer than `limit` requests fall inside the last `windowMs`.
 *
 * ## Where the real one lives
 *
 * `MemoryRateLimiter` is correct and is the right implementation for a single
 * long-lived process. It is NOT correct on Vercel, where every serverless
 * invocation may be a fresh instance and the map is empty again — a limiter
 * there has to be shared state (Upstash Redis, or a `SELECT count(*)` over
 * `tokens` for the email side, which is exactly what `tokens_email_idx` was
 * indexed for). The interface is what production swaps; see the Phase 4 report.
 */

/** A budget: at most `limit` events inside any `windowMs` sliding window. */
export interface RateLimitPolicy {
  readonly limit: number;
  readonly windowMs: number;
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Budget left AFTER this call, floored at zero. */
  readonly remaining: number;
  /** Seconds until the caller could succeed. `0` when allowed. */
  readonly retryAfterSeconds: number;
}

/**
 * The seam a distributed limiter plugs into.
 *
 * `consume` both asks and spends — one call, not a `check` then an `increment`,
 * because two calls are a race and the race is exploitable by exactly the
 * caller the limiter exists to stop.
 */
export interface RateLimiter {
  consume(input: {
    readonly key: string;
    readonly policy: RateLimitPolicy;
    readonly now: Date;
  }): Promise<RateLimitDecision>;
}

const MINUTE_MS = 60 * 1000;

/**
 * The budgets.
 *
 * Chosen so that a real person never meets one and a script always does:
 *
 * - `requestPerEmail` — 3 per 15 minutes, deliberately the same 15 minutes as
 *   `MAGIC_TOKEN_TTL_MS`. A person who does not see the mail resends twice and
 *   then has to wait for their first link to expire anyway, so the limit never
 *   costs them a working link. It also caps the inbox at 3 messages per quarter
 *   hour for a targeted address.
 * - `requestPerIp` — 10 per 15 minutes. Above a household or a small office
 *   behind one NAT address, far below a harvesting script.
 * - `verifyPerIp` — 20 per 15 minutes, on the redemption side. `brief §2.1` does
 *   not ask for this one; it is here because a 256-bit token is unguessable only
 *   if guessing is also unprofitable, and an unlimited verify endpoint is a free
 *   oracle. 20 accommodates a mail client that retries and a user who clicks
 *   twice.
 * - `capabilityPerIp` — 30 per 15 minutes. The capability URL is a bookmark, so
 *   a person hits it once and then not again for weeks; anything doing it in
 *   volume is walking the keyspace. The budget is deliberately looser than
 *   `verifyPerIp` because a shared office NAT can carry several genuine
 *   bookmarks, and deliberately finite because 256 bits is only unguessable if
 *   guessing also costs something.
 * - `oauthPerIp` — 20 per 15 minutes, on the callback. Each one costs two
 *   outbound HTTP requests to GitHub, so an unlimited callback is a way to spend
 *   our rate limit at GitHub using someone else's browser.
 * - `handoffPerIp` — 20 per 15 minutes, on the success page's capability
 *   handoff. That endpoint turns a payment id into a bearer URL, so it is the
 *   one place a leaked provider id could be walked; see `capability/handoff.ts`,
 *   which also bounds it by time.
 */
export const AUTH_RATE_LIMITS = {
  requestPerEmail: { limit: 3, windowMs: 15 * MINUTE_MS },
  requestPerIp: { limit: 10, windowMs: 15 * MINUTE_MS },
  verifyPerIp: { limit: 20, windowMs: 15 * MINUTE_MS },
  capabilityPerIp: { limit: 30, windowMs: 15 * MINUTE_MS },
  oauthPerIp: { limit: 20, windowMs: 15 * MINUTE_MS },
  handoffPerIp: { limit: 20, windowMs: 15 * MINUTE_MS },
} as const satisfies Record<string, RateLimitPolicy>;

/** The namespaces. Separate prefixes are what makes the buckets independent. */
export type RateLimitScope =
  | 'auth:request:email'
  | 'auth:request:ip'
  | 'auth:verify:ip'
  | 'auth:capability:ip'
  | 'auth:oauth:ip'
  | 'auth:handoff:ip'
  /**
   * `POST /api/site-metadata`, the submission form's autofill.
   *
   * Not an auth scope, and it lives here anyway because the limiter does. That
   * endpoint is unauthenticated and makes an OUTBOUND request on demand, which
   * is the one shape that is worth more to an attacker than to us: without a
   * budget it is a free scanner pointed at whatever the guards in
   * `@the-pit/fetch` have not already refused, paid for with our egress and our
   * IP reputation. The budget itself is `apps/web`'s to choose — see
   * `lib/ingest/site-metadata.ts` — because the cost being bounded is ours.
   */
  | 'submit:metadata:ip';

/**
 * Namespace a subject into a bucket key.
 *
 * The prefix is not decoration. Without it an IPv6 address and an address at a
 * numeric-looking domain could collide, and more importantly a single flat
 * keyspace makes it one edit away for the email and IP budgets to start sharing
 * a counter — which would silently turn two independent defences into one.
 */
export function bucketKey(scope: RateLimitScope, subject: string): string {
  return `${scope}|${subject}`;
}

/**
 * A sliding-window limiter over a `Map`. No I/O, no timers, no ambient clock —
 * `now` is passed in, so every test is deterministic.
 *
 * Shipped in `src` rather than `test` for the same reason `packages/payments`
 * ships `FixtureDodoTransport`: local development and the web app's route tests
 * both need a working limiter with no Redis, and a fake that only exists inside
 * one package's test folder gets reimplemented — differently — by the next one.
 */
export class MemoryRateLimiter implements RateLimiter {
  readonly #hits = new Map<string, number[]>();

  consume(input: { key: string; policy: RateLimitPolicy; now: Date }): Promise<RateLimitDecision> {
    return Promise.resolve(this.consumeSync(input));
  }

  consumeSync(input: { key: string; policy: RateLimitPolicy; now: Date }): RateLimitDecision {
    const nowMs = input.now.getTime();
    const cutoff = nowMs - input.policy.windowMs;

    const kept = (this.#hits.get(input.key) ?? []).filter((at) => at > cutoff);

    if (kept.length >= input.policy.limit) {
      // The window frees a slot when the OLDEST hit inside it falls out.
      const oldest = kept[0] ?? nowMs;
      const waitMs = oldest + input.policy.windowMs - nowMs;
      this.#hits.set(input.key, kept);
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)),
      };
    }

    kept.push(nowMs);
    this.#hits.set(input.key, kept);
    return {
      allowed: true,
      remaining: input.policy.limit - kept.length,
      retryAfterSeconds: 0,
    };
  }

  /** Hits currently inside no window in particular — for assertions only. */
  countFor(key: string): number {
    return (this.#hits.get(key) ?? []).length;
  }

  /** Drop everything. Test and local-development convenience. */
  reset(): void {
    this.#hits.clear();
  }
}

/**
 * A limiter that allows everything, and records what it was asked.
 *
 * For tests whose subject is something else entirely and which would otherwise
 * have to keep their fixture clock inside a rate window to stay green.
 */
export class UnlimitedRateLimiter implements RateLimiter {
  readonly calls: { key: string; policy: RateLimitPolicy; now: Date }[] = [];

  consume(input: { key: string; policy: RateLimitPolicy; now: Date }): Promise<RateLimitDecision> {
    this.calls.push(input);
    return Promise.resolve({ allowed: true, remaining: input.policy.limit, retryAfterSeconds: 0 });
  }
}
