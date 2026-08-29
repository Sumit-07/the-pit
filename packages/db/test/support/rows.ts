/**
 * Minimal valid rows, so a constraint test can insert one bad row against an
 * otherwise legal graph.
 *
 * Every helper writes the smallest thing that satisfies every OTHER constraint on
 * its table. That is what makes the tests discriminating: when an insert is
 * rejected, exactly one rule can have rejected it, and the test asserts which.
 */

import type { PGlite } from '@electric-sql/pglite';

/** SHA-256 of the empty string — a valid `products.description_hash` shape. */
export const A_HASH = '0'.repeat(64);

export async function insertCategory(pg: PGlite, slug = 'developer-tools'): Promise<string> {
  const result = await pg.query<{ id: string }>(
    `INSERT INTO categories (slug, name, type, prompt_version, persona_version, category_snapshot_version)
     VALUES ($1, $1, 'b2b', 'v1', 'v1', 'snap-1') RETURNING id`,
    [slug],
  );
  return required(result.rows[0]?.id, 'categories.id');
}

export async function insertProduct(
  pg: PGlite,
  categoryId: string,
  engineId = 0,
  normalizedUrl = 'example.com',
): Promise<string> {
  const result = await pg.query<{ id: string }>(
    `INSERT INTO products
       (category_id, engine_id, name, url, normalized_url, description, description_hash,
        source, status, placed_at)
     VALUES ($1, $2, 'A product', 'https://example.com', $3, 'A description.', $4,
             'seeded', 'placed', now())
     RETURNING id`,
    [categoryId, engineId, normalizedUrl, A_HASH],
  );
  return required(result.rows[0]?.id, 'products.id');
}

export async function insertCluster(pg: PGlite, categoryId: string, key = 'c1-thing'): Promise<string> {
  const result = await pg.query<{ id: string }>(
    `INSERT INTO clusters (category_id, cluster_key, label, uniqueness_version)
     VALUES ($1, $2, 'A cluster', 'u1') RETURNING id`,
    [categoryId, key],
  );
  return required(result.rows[0]?.id, 'clusters.id');
}

/** A job in whatever delivery state the caller needs. */
export async function insertJob(
  pg: PGlite,
  categoryId: string,
  options: { delivered?: boolean; productId?: string; email?: string } = {},
): Promise<string> {
  const delivered = options.delivered ?? false;
  const result = await pg.query<{ id: string }>(
    `INSERT INTO jobs
       (kind, status, category_id, product_id, account_email,
        prompt_version, persona_version, category_snapshot_version, engine_version, delivered_at)
     VALUES ('placement', $4, $1, $2, $3, 'v1', 'v1', 'snap-1', '0.1.0', $5)
     RETURNING id`,
    [
      categoryId,
      options.productId ?? (await insertProduct(pg, categoryId, 900 + Math.floor(Math.random() * 90))),
      options.email ?? 'payer@example.com',
      delivered ? 'succeeded' : 'running',
      delivered ? new Date().toISOString() : null,
    ],
  );
  return required(result.rows[0]?.id, 'jobs.id');
}

/** A paid order granting `attemptsGranted` attempts. */
export async function insertOrder(
  pg: PGlite,
  options: { eventId?: string; paymentId?: string; email?: string; attemptsGranted?: number } = {},
): Promise<string> {
  const unique = Math.random().toString(36).slice(2);
  const result = await pg.query<{ id: string }>(
    `INSERT INTO orders
       (provider_event_id, provider_payment_id, account_email, amount_cents, currency, attempts_granted, status, raw_event)
     VALUES ($1, $2, $3, 500, 'USD', $4, 'paid', '{}'::jsonb)
     RETURNING id`,
    [
      options.eventId ?? `evt_${unique}`,
      // A granting order must name its payment (`orders_grant_names_payment`),
      // and one payment grants once (`orders_payment_grant_uk`), so each fixture
      // order is its own payment.
      options.paymentId ?? `pay_${unique}`,
      options.email ?? 'payer@example.com',
      options.attemptsGranted ?? 1,
    ],
  );
  return required(result.rows[0]?.id, 'orders.id');
}

/**
 * Grant an order's attempts as one ledger row.
 *
 * `delta` must equal the order's `attempts_granted`
 * (`attempts_grant_matches_order`), and the idempotency key is namespaced the way
 * `@the-pit/payments` namespaces it: `dodo:event:<providerEventId>`.
 */
export async function grantAttempt(
  pg: PGlite,
  orderId: string,
  email = 'payer@example.com',
  delta = 1,
): Promise<void> {
  await pg.query(
    `INSERT INTO attempts (account_email, kind, delta, idempotency_key, order_id)
     VALUES ($1, 'grant', $2, 'dodo:event:' || $3::text, $3::uuid)`,
    [email, delta, orderId],
  );
}

/** Consume one attempt against a delivered job, keyed the way the payments ledger keys it. */
export async function consumeAttempt(pg: PGlite, jobId: string, email = 'payer@example.com'): Promise<void> {
  await pg.query(
    `INSERT INTO attempts (account_email, kind, delta, idempotency_key, job_id)
     VALUES ($1, 'consume', -1, 'delivery:run:' || $2::text, $2::uuid)`,
    [email, jobId],
  );
}

function required(value: string | undefined, what: string): string {
  if (value === undefined) throw new Error(`test fixture: ${what} was not returned`);
  return value;
}
