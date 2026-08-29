/**
 * The three reads behind `/account`.
 *
 * `brief §2.1` splits the product in one line: "Public vs private: verdict URLs
 * are public. Attempt balance and history are behind the session." Everything in
 * this file is the second half. Nothing here is reachable without an account id,
 * and an account id comes from a signed session cookie and from nowhere else.
 *
 * ## Why the reads live here and not in the page
 *
 * Same rule as `auth-store.ts`: each of these is a claim about a table's shape
 * and its indexes, and the schema tests can execute a claim against a real
 * Postgres. `apps/web` gets an interface it can also satisfy in memory, so the
 * page renders in a test with no database and the SQL is still exercised where
 * the constraints are.
 *
 * ## The balance is a fold, never a column
 *
 * `commerce.ts` is explicit about why `attempts` is a ledger and not a counter:
 * "when a customer says 'I paid for three and got one', the ledger answers; a
 * counter only restates the complaint." So the number this page shows is
 * `sum(delta)`, computed at read time, over `attempts_account_idx`. A cached
 * column would be allowed to disagree with the rows, and the page that displays
 * it is precisely where a disagreement becomes a support ticket.
 *
 * ## Listings are found by email, on purpose
 *
 * `products.submitted_by_email` is the payer's address and
 * `products_submitted_by_email_idx` exists for this exact query — its own comment
 * says so: "'Balance and history are behind the session' (`brief §2.1`) — a
 * user's products, by the only identity we hold." The account id is resolved to
 * that address in the same statement rather than by the caller, so a caller who
 * held an id and a stale address cannot read someone else's listings.
 *
 * ## One verdict per listing, the latest
 *
 * `brief §2.4`: a new attempt REPLACES the previous listing, and `verdicts` is
 * append-only with a row per pitch (`verdicts_product_attempt_uk`). The account
 * page shows the current one, so the join takes the most recently delivered row.
 * The older verdicts keep their permanent public URLs — `brief` Part 6 requires
 * that — they are simply not what this page links to.
 */

import { sql } from 'drizzle-orm';

import type { Database } from './client.js';

/** One purchase, as the history table shows it. */
export interface AccountPurchaseRow {
  readonly orderId: string;
  readonly providerPaymentId: string | null;
  readonly amountCents: number;
  readonly currency: string;
  readonly attemptsGranted: number;
  readonly includesFitReport: boolean;
  readonly createdAt: Date;
}

/** One listing, with the verdict it currently links to. */
export interface AccountListingRow {
  readonly productId: string;
  readonly name: string;
  readonly url: string;
  readonly categorySlug: string;
  readonly status: string;
  /** Null while the run has not delivered. */
  readonly verdictSlug: string | null;
  /** `brief §2.4`: shown publicly as "3rd pitch". Null on an undelivered listing. */
  readonly attemptNumber: number | null;
  readonly deliveredAt: Date | null;
}

export interface PostgresAccountStore {
  /** `sum(delta)` over the ledger. `brief §2.3`: attempts never expire. */
  balance(accountId: string): Promise<number>;
  /** Every order that granted, newest first. Refunds and disputes are not purchases. */
  purchases(accountId: string): Promise<readonly AccountPurchaseRow[]>;
  /** Every product this account submitted, newest first, with its current verdict. */
  listings(accountId: string): Promise<readonly AccountListingRow[]>;
}

/** `db.execute` is an array under postgres-js and `{ rows }` under some drivers. */
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (typeof result === 'object' && result !== null && Array.isArray((result as { rows?: unknown }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

/** Postgres hands `integer` back as a number and `bigint`/`numeric` as a string. */
function int(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0);
}

function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function nullableDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : date(value);
}

export function createPostgresAccountStore(db: Database): PostgresAccountStore {
  return {
    async balance(accountId: string): Promise<number> {
      const result: unknown = await db.execute(
        sql`select coalesce(sum(delta), 0)::int as balance from attempts where account_id = ${accountId}`,
      );
      return int(rowsOf<{ balance: number }>(result)[0]?.balance);
    },

    async purchases(accountId: string): Promise<readonly AccountPurchaseRow[]> {
      // `attempts_granted > 0` and not `status = 'paid'`: a refund event on a
      // paid order is recorded too, and `orders_grants_only_when_paid` already
      // ties the two together. What the customer's history means is "the times
      // money bought attempts", which is exactly the granting rows —
      // `orders_payment_grant_uk` is the partial index over the same predicate.
      const result: unknown = await db.execute(sql`
        select id, provider_payment_id, amount_cents, currency,
               attempts_granted, includes_fit_report, created_at
          from orders
         where account_id = ${accountId} and attempts_granted > 0
         order by created_at desc, id
      `);

      return rowsOf<Record<string, unknown>>(result).map((row) => ({
        orderId: String(row['id']),
        providerPaymentId: row['provider_payment_id'] === null ? null : String(row['provider_payment_id']),
        amountCents: int(row['amount_cents']),
        currency: String(row['currency']),
        attemptsGranted: int(row['attempts_granted']),
        includesFitReport: row['includes_fit_report'] === true,
        createdAt: date(row['created_at']),
      }));
    },

    async listings(accountId: string): Promise<readonly AccountListingRow[]> {
      // The account id is resolved to the payer's address INSIDE the statement.
      // A caller that passed both would be trusted about the pairing, and the one
      // that gets it wrong is the one written in a hurry against a support ticket.
      const result: unknown = await db.execute(sql`
        select p.id, p.name, p.url, p.status, c.slug as category_slug,
               v.public_slug, v.attempt_number, v.delivered_at
          from products p
          join categories c on c.id = p.category_id
          left join lateral (
                 select public_slug, attempt_number, delivered_at
                   from verdicts
                  where product_id = p.id
                  order by delivered_at desc
                  limit 1
               ) v on true
         where p.submitted_by_email = (select email from accounts where id = ${accountId})
         order by p.created_at desc, p.id
      `);

      return rowsOf<Record<string, unknown>>(result).map((row) => ({
        productId: String(row['id']),
        name: String(row['name']),
        url: String(row['url']),
        categorySlug: String(row['category_slug']),
        status: String(row['status']),
        verdictSlug: row['public_slug'] === null || row['public_slug'] === undefined ? null : String(row['public_slug']),
        attemptNumber:
          row['attempt_number'] === null || row['attempt_number'] === undefined ? null : int(row['attempt_number']),
        deliveredAt: nullableDate(row['delivered_at']),
      }));
    },
  };
}
