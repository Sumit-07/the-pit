/**
 * The one read the verdict page needs, and nothing else.
 *
 * ## Why this is an interface and not a query
 *
 * The `verdicts` table is another agent's, being written now. `packages/payments`
 * and `packages/auth` both hit the same problem earlier and both answered it the
 * same way — `AttemptsStore` is two methods, `AuthStore` is a handful — so this
 * follows them: state the narrowest read that satisfies the surface, implement
 * against it, and let the schema land underneath without anything above moving.
 *
 * The read is one row by one column:
 *
 *   SELECT public_slug, payload, product_count, attempt_number, delivered_at
 *   FROM verdicts WHERE public_slug = $1
 *
 * That is deliberately the whole interface. There is no `byProductId`, no
 * `latestFor`, no `list`. `brief §2.1` splits the surfaces — "verdict URLs are
 * public; attempt balance and history sit behind a session" — and a store that
 * could enumerate an account's verdicts would be reachable from the one route in
 * the product that has no session at all. What this interface cannot do is what
 * keeps the public page public.
 *
 * ## What is deliberately absent
 *
 * `account_id`, `job_id` and `product_id` are not read. The public page shows a
 * product's verdict, not who paid for it, and a payload that never carries the
 * payer's identity cannot leak it into a shared screenshot.
 *
 * ## S8
 *
 * `DECISIONS.md` S8 — what a re-pitch does to the old URL — is open, and
 * `planRepitch` implements every reading behind a `RepitchPolicy` with no
 * default. This interface prejudges none of them: it resolves a slug to the row
 * that slug names. Under `archive_at_permanent_url` that is the whole answer;
 * under `redirect_to_current` the route adds a redirect above this read using a
 * lookup that is not this store's business. Both readings need "the row that
 * slug names" and neither can be built without it.
 */

/**
 * One frozen verdict, as the page needs it.
 *
 * Every field is a column, not a derivation. `brief §1.2` moves every z-score on
 * every placement, so a page that re-derived any of this from current rankings
 * would show a different number tomorrow than the one that was shared.
 */
export interface StoredVerdict {
  /** `verdicts.public_slug` — the URL this row was resolved by. */
  readonly publicSlug: string;
  /**
   * `verdicts.payload` — the rendered verdict, frozen at delivery. `unknown`
   * because it crosses a process boundary as `jsonb`: it is parsed and validated
   * by `parseVerdict`, never trusted by shape.
   */
  readonly payload: unknown;
  /**
   * `verdicts.product_count` — how many products were on the board when this was
   * issued. `brief` Part 5 stamps it on the card, and Part 5 also forbids
   * promising a rank: a rank of 7 means something different out of 44 than out
   * of 200, and the board it refers to has since moved.
   */
  readonly productCount: number;
  /**
   * `verdicts.attempt_number` — which pitch this is, 1-based. `brief §2.4`:
   * "Show the attempt count publicly". NULL on a seeded, unclaimed listing,
   * which has never been pitched and so has no ordinal to show.
   */
  readonly attemptNumber: number | null;
  /** `verdicts.delivered_at` — the instant it was handed over. */
  readonly deliveredAt: Date;
}

/** The seam. One method, because the public page makes one read. */
export interface VerdictStore {
  /** The verdict at a public URL, or `undefined` if no such URL was ever issued. */
  bySlug(slug: string): Promise<StoredVerdict | undefined>;
}

/**
 * A store over rows held in memory.
 *
 * Used by the tests, and by any environment with no database: a deployment with
 * no `DATABASE_URL` serves 404s rather than crashing on import, which is what
 * keeps `next build` — which imports server modules to trace them — independent
 * of whether Neon is provisioned.
 */
export class MemoryVerdictStore implements VerdictStore {
  private readonly rows = new Map<string, StoredVerdict>();

  constructor(rows: readonly StoredVerdict[] = []) {
    for (const row of rows) this.rows.set(row.publicSlug, row);
  }

  /** Append-only, like the table: a slug already present is never overwritten. */
  add(row: StoredVerdict): this {
    if (this.rows.has(row.publicSlug)) {
      throw new RangeError(
        `MemoryVerdictStore: ${row.publicSlug} is already issued. verdicts is append-only ` +
          '(migrations/0003 refuses UPDATE); a re-pitch inserts under a new slug.',
      );
    }
    this.rows.set(row.publicSlug, row);
    return this;
  }

  bySlug(slug: string): Promise<StoredVerdict | undefined> {
    return Promise.resolve(this.rows.get(slug));
  }
}
