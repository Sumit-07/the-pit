/**
 * Who gets the free first throw, and who has already had it.
 *
 * ## The thing being defended
 *
 * A run costs twelve juror calls, a clustering pass and a persona round. `brief
 * §2.3` prices that at $5 and keeps "$5 as the atomic unit so 'same five dollars
 * for everyone' stays literally true". A free first throw is a deliberate hole in
 * that, opened once per product and once per person so somebody can see what the
 * thing does before they pay for it — and the entire cost of the hole is bounded
 * by the word "once". Every rule below exists to make "once" mean once.
 *
 * The rules are ordered, and the FIRST refusal wins:
 *
 *   1. `disposable_email`  the address is not an identity
 *   2. `url_used`          this product has had its throw, ever
 *   3. `email_used`        this person has had theirs, ever
 *   4. `ip_window`         more than five requests from one address in an hour
 *   5. `daily_cap`         the whole offer's budget for the last 24 hours
 *
 * The order is not arbitrary and it is asserted in `test/free-policy.test.ts`.
 * Refusals get less specific as you go down: "your address is disposable" is
 * something the visitor can act on, "we are at capacity today" is not. Reporting
 * the most actionable true reason is the difference between a person fixing their
 * input and a person concluding the site is broken. `disposable_email` beating
 * `url_used` is the load-bearing case — a throwaway address on a URL that has
 * already run should hear about the address, because that is the one of the two
 * they can do anything about.
 *
 * ## Why this is a table and not a limiter
 *
 * `packages/auth`'s `MemoryRateLimiter` is correct and is not usable here, and it
 * says so about itself: on Vercel "every serverless invocation may be a fresh
 * instance and the map is empty again". Rules 2 and 3 are "ever", which no
 * in-memory window can express at all, and rules 4 and 5 would silently degrade
 * to nothing at the exact moment traffic arrived on more than one instance. So
 * every rule here is a count over `free_run_requests`, which is append-only and
 * shared by every lambda that has the connection string.
 *
 * ## What reaches the table
 *
 * Not the email and not the address. Both are HMAC-SHA256 under `SESSION_SECRET`
 * before they leave this file — the same posture `packages/auth`'s `hashToken`
 * takes with a magic link, and `0012_free_run_requests.sql` enforces it with a
 * `~ '^[0-9a-f]{64}$'` check on both columns so a future caller cannot store the
 * raw value even by accident.
 *
 * HMAC rather than the plain SHA-256 `hashToken` uses, and the difference is the
 * input: a magic-link token is 256 bits from the OS CSPRNG and unguessable, while
 * an email address and an IPv4 address are both small enough to enumerate offline
 * in minutes. Without a key, a dump of that table would be a dump of its people.
 *
 * On READ every secret in the keyring is tried, exactly as
 * `verifyRunStatusToken` does: `SESSION_SECRET_PREVIOUS` exists so a rotation does
 * not log everyone out, and it must equally not amnesty everyone who has already
 * had their free run. Writes always use the newest secret.
 *
 * ## Folding, and what counts as the same person
 *
 * `a.b+throwaway@gmail.com` and `ab@gmail.com` are one inbox. A rule that treated
 * them as two people would be a rule anybody could switch off by typing a `+`, so
 * `foldEmailKey` strips `+tag` from every address and dots from Gmail ones before
 * hashing. Note what this does NOT do: a plus-addressed variant is not refused
 * for being plus-addressed. It is refused only when the folded base has already
 * had a run — which is rule 3, arrived at honestly, rather than a sixth rule that
 * punishes a legitimate way of using an inbox.
 */

import { createHmac } from 'node:crypto';

import { hasDatabaseUrl, type Database } from '@the-pit/db';
import { sql } from 'drizzle-orm';

import { sessionKeyring } from '@/lib/auth/config';
import { checkoutDatabase } from '@/lib/checkout/bindings';
import { isDisposableDomain } from '@/lib/free/disposable-domains';
import { PipelineBindingError, type Env } from '@/lib/pipeline/mode';

/** Why a free run was refused. Ordered as the rules are evaluated. */
export type FreeRunRefusal = 'url_used' | 'email_used' | 'disposable_email' | 'ip_window' | 'daily_cap';

/** Everything the five rules read. `now` is passed in, so every test is deterministic. */
export interface FreeRunCheck {
  readonly email: string;
  readonly ip: string | null;
  readonly normalizedUrl: string;
  readonly now: Date;
}

export interface FreeRunPolicy {
  check(input: FreeRunCheck): Promise<{ ok: true } | { ok: false; reason: FreeRunRefusal }>;
  record(input: FreeRunCheck & { readonly submissionId: string }): Promise<void>;
}

/** `brief §2.1`'s namespace trick: a digest made here can never verify anywhere else. */
const EMAIL_PURPOSE = 'free-run.email.v1';
const IP_PURPOSE = 'free-run.ip.v1';

/** Requests from one address inside `IP_WINDOW_MS`. The sixth is refused. */
export const FREE_RUN_IP_LIMIT = 5;
export const FREE_RUN_IP_WINDOW_MS = 60 * 60 * 1000;

/** The global budget's window, and the cap when the environment names none. */
export const FREE_RUN_DAY_MS = 24 * 60 * 60 * 1000;
export const FREE_RUNS_PER_DAY_ENV = 'FREE_RUNS_PER_DAY';
export const DEFAULT_FREE_RUNS_PER_DAY = 100;

/**
 * The address, reduced to the person behind it.
 *
 * Lowercased (addresses are compared case-insensitively in practice and
 * `accounts.email` is stored lowercased), `+tag` stripped from the local part,
 * and dots removed when the domain is Gmail's — Google ignores them, so
 * `a.b@gmail.com` and `ab@gmail.com` deliver to one mailbox. `googlemail.com` is
 * folded onto `gmail.com` for the same reason: it is the same account.
 *
 * Anything that is not recognisably `local@domain` is returned lowercased and
 * otherwise untouched. This is a folding function, not a validator — refusing to
 * fold something odd would hand a free run to whoever typed it.
 */
export function foldEmailKey(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return trimmed;

  const rawLocal = trimmed.slice(0, at);
  const rawDomain = trimmed.slice(at + 1).replace(/\.$/, '');

  const domain = rawDomain === 'googlemail.com' ? 'gmail.com' : rawDomain;

  // The tag goes at the FIRST `+`: `a+b+c@x` is one address with the tag `b+c`.
  const plus = rawLocal.indexOf('+');
  const untagged = plus === -1 ? rawLocal : rawLocal.slice(0, plus);

  const local = domain === 'gmail.com' ? untagged.replaceAll('.', '') : untagged;

  // A local part that was nothing but a tag folds to nothing; keep the untagged
  // original rather than inventing an empty key that every such address shares.
  return local === '' ? `${rawLocal}@${domain}` : `${local}@${domain}`;
}

/** The domain half of an address, lowercased. Empty when there is not one. */
export function emailDomain(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  return at === -1 ? '' : trimmed.slice(at + 1).replace(/\.$/, '');
}

/** The cap, read from the environment at CHECK time so a redeploy is not needed to move it. */
export function freeRunsPerDay(env: Env = process.env): number {
  const raw = env[FREE_RUNS_PER_DAY_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_FREE_RUNS_PER_DAY;

  const parsed = Number.parseInt(raw, 10);
  // A malformed cap must not read as "unlimited". A zero or a negative one is
  // taken at face value — "the offer is closed" is a thing an operator may want
  // to say — but `NaN` is a typo, and a typo falls back to the default.
  return Number.isNaN(parsed) ? DEFAULT_FREE_RUNS_PER_DAY : parsed;
}

function digest(purpose: string, value: string, secret: string): string {
  return createHmac('sha256', secret).update(`${purpose}:${value}`, 'utf8').digest('hex');
}

/** Drizzle's `execute` returns an array on one driver and `{ rows }` on another. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (typeof result === 'object' && result !== null && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

function int(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

/**
 * One bound placeholder per hash, comma separated.
 *
 * Written out rather than handed to the driver as an array parameter: the two
 * drivers this runs on — `postgres-js` in production, PGlite under the tests —
 * expand an array bind differently, and an `in` list is the one place where the
 * difference is a silently wrong answer rather than an error.
 */
function hashList(hashes: readonly string[]): ReturnType<typeof sql.join> {
  return sql.join(
    hashes.map((hash) => sql`${hash}`),
    sql`, `,
  );
}

class PostgresFreeRunPolicy implements FreeRunPolicy {
  readonly #db: Database;
  /** Newest first. Writes use `[0]`; reads try all of them. */
  readonly #keyring: readonly [string, ...string[]];

  constructor(db: Database, keyring: readonly [string, ...string[]]) {
    this.#db = db;
    this.#keyring = keyring;
  }

  #emailHashes(email: string): string[] {
    const key = foldEmailKey(email);
    return this.#keyring.map((secret) => digest(EMAIL_PURPOSE, key, secret));
  }

  #ipHashes(ip: string | null): string[] {
    if (ip === null || ip.trim() === '') return [];
    const key = ip.trim().toLowerCase();
    return this.#keyring.map((secret) => digest(IP_PURPOSE, key, secret));
  }

  async check(input: FreeRunCheck): Promise<{ ok: true } | { ok: false; reason: FreeRunRefusal }> {
    // 1. The address is not an identity. Answered without touching the database:
    //    it depends on nothing but the address, so a disposable one costs us a
    //    string split rather than a round trip.
    if (isDisposableDomain(emailDomain(input.email))) {
      return { ok: false, reason: 'disposable_email' };
    }

    const counts = await this.#counts(input);

    // 2. This product has had its throw, ever. Before the email rule because the
    //    product is the thing the offer is about: one free evaluation per thing
    //    being evaluated, whoever submits it.
    if (counts.url > 0) return { ok: false, reason: 'url_used' };

    // 3. This person has had theirs, ever — the folded key, so `+tag` and Gmail
    //    dots land on the same row.
    if (counts.email > 0) return { ok: false, reason: 'email_used' };

    // 4. The hourly window. `> FREE_RUN_IP_LIMIT` counting THIS request, which is
    //    `>=` counting the rows already there: five recorded runs means this is
    //    the sixth, and the sixth is refused.
    if (counts.ip >= FREE_RUN_IP_LIMIT) return { ok: false, reason: 'ip_window' };

    // 5. The whole offer's budget for the last 24 hours. Last because it is the
    //    least actionable refusal there is — nothing about the visitor's input
    //    caused it and nothing they change will fix it.
    if (counts.day >= freeRunsPerDay()) return { ok: false, reason: 'daily_cap' };

    return { ok: true };
  }

  /**
   * The four counts, in one statement.
   *
   * Four scalar subqueries rather than one pass with `filter (where ...)`: each
   * subquery is a lookup on its own index (`free_run_requests_normalized_url_idx`,
   * `_email_key_idx`, `_ip_idx`, `_created_at_idx`), while a single conditional
   * aggregate over the table would read every row that has ever been written to
   * answer questions three of which are about one key or one hour.
   *
   * Timestamps cross as ISO strings with an explicit `::timestamptz`, so the
   * comparison is decided by Postgres and does not depend on how a particular
   * driver chose to serialise a `Date`.
   */
  async #counts(input: FreeRunCheck): Promise<{ url: number; email: number; ip: number; day: number }> {
    const emailHashes = this.#emailHashes(input.email);
    const ipHashes = this.#ipHashes(input.ip);
    const hourAgo = new Date(input.now.getTime() - FREE_RUN_IP_WINDOW_MS).toISOString();
    const dayAgo = new Date(input.now.getTime() - FREE_RUN_DAY_MS).toISOString();

    // No address to count against: the per-IP budget has nothing to key on, so
    // the rule is skipped rather than applied to a bucket everyone shares.
    const ipCount =
      ipHashes.length === 0
        ? sql`0`
        : sql`(select count(*) from free_run_requests
                where ip_hash in (${hashList(ipHashes)}) and created_at > ${hourAgo}::timestamptz)`;

    const result: unknown = await this.#db.execute(sql`
      select
        (select count(*) from free_run_requests
          where normalized_url = ${input.normalizedUrl}) as url_count,
        (select count(*) from free_run_requests
          where email_key_hash in (${hashList(emailHashes)})) as email_count,
        ${ipCount} as ip_count,
        (select count(*) from free_run_requests
          where created_at > ${dayAgo}::timestamptz) as day_count
    `);

    const row = rowsOf<Record<string, unknown>>(result)[0] ?? {};
    return {
      url: int(row['url_count']),
      email: int(row['email_count']),
      ip: int(row['ip_count']),
      day: int(row['day_count']),
    };
  }

  /**
   * One row, written with the NEWEST secret.
   *
   * `on conflict do nothing` on `free_run_requests_submission_uk`: a platform that
   * delivered the same request twice must not raise on the second, and it must
   * not write a second row either — a duplicate would spend the IP window and the
   * daily cap twice for one throw.
   *
   * `created_at` is the caller's `now` rather than the database's, so the same
   * clock decides what "the last hour" means on both sides of the pair. A `check`
   * that passed against a fixture clock and then recorded against `now()` would
   * be two different policies.
   */
  async record(input: FreeRunCheck & { submissionId: string }): Promise<void> {
    const emailHash = this.#emailHashes(input.email)[0] ?? '';
    const ipHash = this.#ipHashes(input.ip)[0] ?? null;

    await this.#db.execute(sql`
      insert into free_run_requests (submission_id, email_key_hash, ip_hash, normalized_url, created_at)
      values (${input.submissionId}::uuid, ${emailHash}, ${ipHash}, ${input.normalizedUrl},
              ${input.now.toISOString()}::timestamptz)
      on conflict (submission_id) do nothing
    `);
  }
}

/**
 * The policy, bound to the same pool the checkout handlers use.
 *
 * ## It throws rather than degrading, and that is the whole point
 *
 * With no `DATABASE_URL` there is nowhere to count, and a policy that cannot
 * count cannot refuse. Every alternative to throwing is worse: returning
 * `{ ok: true }` hands out unlimited free runs on any deployment whose database
 * is not bound yet, and returning `{ ok: false }` turns a configuration mistake
 * into a free door that is permanently shut with no error anybody will see. Both
 * fail silently, which is the failure mode `lib/pipeline/mode.ts` introduced
 * `PipelineBindingError` to prevent: "this deployment is not configured" and "the
 * database refused the connection" present identically and are fixed in
 * completely different places.
 *
 * It throws at CONSTRUCTION rather than on the first check, so the mistake
 * surfaces where the wiring is assembled instead of on somebody's first request.
 *
 * `SESSION_SECRET` is required for the same reason and refused the same way: with
 * no key the hashes would be unkeyed digests of small inputs, which is a table of
 * addresses wearing a costume.
 */
export function freeRunPolicy(): FreeRunPolicy {
  if (!hasDatabaseUrl()) {
    throw new PipelineBindingError(
      'The free first throw needs DATABASE_URL.\n\n' +
        'Every rule on the free door — one run per URL, one per address, five per IP per hour, ' +
        'and the daily cap — is a count over the free_run_requests table. In filesystem mode there ' +
        'is nothing to count, and a policy that cannot count cannot refuse: it would hand out ' +
        'unlimited free runs and say nothing. Bind a database, or do not offer the free throw.',
    );
  }

  let keyring: readonly [string, ...string[]];
  try {
    keyring = sessionKeyring();
  } catch (cause) {
    throw new PipelineBindingError(
      'The free first throw needs SESSION_SECRET.\n\n' +
        'The email and the IP are HMAC-SHA256 under it before they reach free_run_requests, so ' +
        'that the table holds no addresses. Without a key the digests would be unkeyed hashes of ' +
        'inputs small enough to enumerate offline, which is a table of addresses in a costume.\n\n' +
        `Underlying error: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  return new PostgresFreeRunPolicy(checkoutDatabase(), keyring);
}

/**
 * The same policy over a handle the caller already has.
 *
 * For the tests, which run against an in-process PGlite with no `DATABASE_URL`,
 * and for any future caller that is already inside a transaction. It is the same
 * class — a second implementation for tests would only assert itself.
 */
export function freeRunPolicyFor(db: Database, keyring: readonly [string, ...string[]]): FreeRunPolicy {
  return new PostgresFreeRunPolicy(db, keyring);
}
