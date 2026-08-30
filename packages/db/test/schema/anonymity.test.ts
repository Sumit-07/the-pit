/**
 * Anonymity is chosen at submission and frozen there.
 *
 * The rule this file defends is not "the handler refuses to flip it". A handler
 * is one code path among several, and the damage from any bypass — a script, an
 * admin console, a second route written later — is silent and permanent: a board
 * that has been quietly flattered looks exactly like a board that has not. So
 * every case below performs the destructive UPDATE **directly against the
 * database**, with no application code between the statement and the constraint.
 * If these pass, the rule holds for every caller that will ever exist.
 *
 * What is being defended: if a founder could go anonymous after reading their
 * verdict, good scores would stay named and bad ones would hide, and the named
 * half of every board would drift toward the flattering — `brief §2.4`'s
 * never-keep-the-best rule in a different currency. See
 * `migrations/0009_anonymous_listings.sql`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { expectRejection, migratedDatabase, type TestDatabase } from '../support/pg.js';
import { insertAccount, insertCategory, insertJob, insertProduct, insertVerdict } from '../support/rows.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await migratedDatabase();
});

afterAll(async () => {
  await database?.close();
});

let counter = 0;
const freshSlug = (prefix: string): string => `${prefix}-${(counter += 1)}`;

/** A seeded listing, which `products_seeded_is_anonymous` makes anonymous. */
async function anonymousProduct(prefix: string): Promise<{ categoryId: string; productId: string }> {
  const categoryId = await insertCategory(database.pg, freshSlug(prefix));
  const productId = await insertProduct(database.pg, categoryId, 0);
  return { categoryId, productId };
}

describe('the choice is frozen after delivery', () => {
  it('refuses to name a product that chose anonymity, once its verdict has been delivered', async () => {
    // The whole point. The listing has been scored, the verdict is out, and the
    // founder has now seen the number. This is the moment the flip would be
    // worth making, and it is the moment it is refused.
    const { categoryId, productId } = await anonymousProduct('flip');
    const job = await insertJob(database.pg, categoryId, { delivered: true, productId });
    await insertVerdict(database.pg, productId, { jobId: job });

    const message = await expectRejection(
      database.pg,
      `UPDATE products SET anonymous = false WHERE id = $1`,
      [productId],
    );
    expect(message).toMatch(/frozen/);

    // And the row did not move.
    const after = await database.pg.query<{ anonymous: boolean }>(
      'SELECT anonymous FROM products WHERE id = $1',
      [productId],
    );
    expect(after.rows[0]?.anonymous).toBe(true);
  });

  it('refuses the flip before delivery too — the choice was made at submission', async () => {
    // There is no window in which it is legal. A product that wanted to be named
    // had its chance before it knew anything about how it would score.
    const { productId } = await anonymousProduct('early');

    const message = await expectRejection(
      database.pg,
      `UPDATE products SET anonymous = false WHERE id = $1`,
      [productId],
    );
    expect(message).toMatch(/frozen/);
  });

  it('refuses a named product going anonymous, which is the hide-a-bad-score move', async () => {
    const categoryId = await insertCategory(database.pg, freshSlug('hide'));
    const paid = await database.pg.query<{ id: string }>(
      `INSERT INTO products
         (category_id, engine_id, name, url, normalized_url, description, description_hash,
          source, status, anonymous, submitted_by_email, placed_at)
       VALUES ($1, 0, 'Named Thing', 'https://named.example', 'named.example', 'A description.',
               $2, 'paid', 'placed', false, 'payer@example.com', now())
       RETURNING id`,
      [categoryId, '0'.repeat(64)],
    );
    const productId = paid.rows[0]?.id ?? '';

    const message = await expectRejection(
      database.pg,
      `UPDATE products SET anonymous = true WHERE id = $1`,
      [productId],
    );
    expect(message).toMatch(/frozen/);
  });

  it('refuses the flip even when it rides along with an unrelated lifecycle update', async () => {
    // The lifecycle columns stay mutable by design (`0002_append_only_guards.sql`),
    // so the cheap bypass is to smuggle the flip into a statement that is
    // otherwise legal. The trigger compares the column, not the statement.
    const { productId } = await anonymousProduct('smuggle');

    const message = await expectRejection(
      database.pg,
      `UPDATE products SET opted_out_at = now(), anonymous = false WHERE id = $1`,
      [productId],
    );
    expect(message).toMatch(/frozen/);
  });

  it('still lets the lifecycle move, so the guard is a rule and not a blanket', async () => {
    const { productId } = await anonymousProduct('lifecycle');

    await database.pg.query('UPDATE products SET opted_out_at = now() WHERE id = $1', [productId]);
    const after = await database.pg.query<{ opted_out_at: string | null; anonymous: boolean }>(
      'SELECT opted_out_at, anonymous FROM products WHERE id = $1',
      [productId],
    );
    expect(after.rows[0]?.opted_out_at).not.toBeNull();
    expect(after.rows[0]?.anonymous).toBe(true);
  });
});

describe('claiming is the one legitimate reveal', () => {
  it('lets a CLAIMED listing choose to be named', async () => {
    // An owner who has proved the listing is theirs, choosing to be named. This
    // is an act of consent about their own product rather than a reaction to a
    // score, and it is the only transition the trigger allows.
    const { categoryId, productId } = await anonymousProduct('claimed');
    const job = await insertJob(database.pg, categoryId, { delivered: true, productId });
    await insertVerdict(database.pg, productId, { jobId: job });
    const account = await insertAccount(database.pg, `owner-${counter}@example.com`);

    await database.pg.query(
      `UPDATE products SET claimed_at = now(), claimed_by_account_id = $2, anonymous = false WHERE id = $1`,
      [productId, account.id],
    );

    const after = await database.pg.query<{ anonymous: boolean }>(
      'SELECT anonymous FROM products WHERE id = $1',
      [productId],
    );
    expect(after.rows[0]?.anonymous).toBe(false);
  });

  it('refuses the reveal when the row is not claimed — a claim is what authorizes it', async () => {
    const { productId } = await anonymousProduct('unclaimed');

    const message = await expectRejection(
      database.pg,
      `UPDATE products SET anonymous = false WHERE id = $1`,
      [productId],
    );
    expect(message).toMatch(/frozen/);
  });

  it('does not let a revealed listing go back into hiding', async () => {
    // Reveal is one-way. Otherwise a claimed founder could name themselves on a
    // good board and hide again on a bad one, which is the original adverse
    // selection with an extra step.
    const { productId } = await anonymousProduct('oneway');
    const account = await insertAccount(database.pg, `oneway-${counter}@example.com`);
    await database.pg.query(
      `UPDATE products SET claimed_at = now(), claimed_by_account_id = $2, anonymous = false WHERE id = $1`,
      [productId, account.id],
    );

    const message = await expectRejection(
      database.pg,
      `UPDATE products SET anonymous = true WHERE id = $1`,
      [productId],
    );
    expect(message).toMatch(/frozen/);
  });

  it('refuses to withdraw a claim, because the claim is the record that authorized the name', async () => {
    const { productId } = await anonymousProduct('withdraw');
    const account = await insertAccount(database.pg, `withdraw-${counter}@example.com`);
    await database.pg.query(
      `UPDATE products SET claimed_at = now(), claimed_by_account_id = $2, anonymous = false WHERE id = $1`,
      [productId, account.id],
    );

    const message = await expectRejection(
      database.pg,
      `UPDATE products SET claimed_at = NULL, claimed_by_account_id = NULL WHERE id = $1`,
      [productId],
    );
    expect(message).toMatch(/not withdrawn or reassigned/);
  });

  it('refuses half a claim', async () => {
    const { productId } = await anonymousProduct('halfclaim');

    const message = await expectRejection(
      database.pg,
      `UPDATE products SET claimed_at = now() WHERE id = $1`,
      [productId],
    );
    expect(message).toMatch(/products_claim_is_whole/);
  });
});

describe('a seeded listing is anonymous (DECISIONS.md, S4-source)', () => {
  it('refuses to insert a named seeded row', async () => {
    // 913 of the 1028 seeded descriptions were scraped rather than written by the
    // companies they describe. A named seeded row is AI criticism of copy that
    // company never wrote, and this is the constraint that makes it unwritable.
    const categoryId = await insertCategory(database.pg, freshSlug('namedseed'));

    const message = await expectRejection(
      database.pg,
      `INSERT INTO products
         (category_id, engine_id, name, url, normalized_url, description, description_hash,
          source, status, anonymous)
       VALUES ($1, 0, 'Scraped Co', 'https://x.com', 'x.com', 'd', $2, 'seeded', 'pending', false)`,
      [categoryId, '0'.repeat(64)],
    );
    expect(message).toMatch(/products_seeded_is_anonymous/);
  });

  it('allows a PAID row to be named, which is the ordinary case', async () => {
    const categoryId = await insertCategory(database.pg, freshSlug('paidnamed'));

    const inserted = await database.pg.query<{ anonymous: boolean }>(
      `INSERT INTO products
         (category_id, engine_id, name, url, normalized_url, description, description_hash,
          source, status, anonymous, submitted_by_email)
       VALUES ($1, 0, 'Paid Co', 'https://paid.example', 'paid.example', 'd', $2, 'paid', 'pending',
               false, 'payer@example.com')
       RETURNING anonymous`,
      [categoryId, '0'.repeat(64)],
    );
    expect(inserted.rows[0]?.anonymous).toBe(false);
  });

  it('allows a PAID row to choose anonymity at submission, which is the feature', async () => {
    const categoryId = await insertCategory(database.pg, freshSlug('paidanon'));

    const inserted = await database.pg.query<{ anonymous: boolean }>(
      `INSERT INTO products
         (category_id, engine_id, name, url, normalized_url, description, description_hash,
          source, status, anonymous, submitted_by_email)
       VALUES ($1, 0, 'Shy Co', 'https://shy.example', 'shy.example', 'd', $2, 'paid', 'pending',
               true, 'payer@example.com')
       RETURNING anonymous`,
      [categoryId, '0'.repeat(64)],
    );
    expect(inserted.rows[0]?.anonymous).toBe(true);
  });

  it('lets a claimed seeded row be named — the founder turning up is the point', async () => {
    const categoryId = await insertCategory(database.pg, freshSlug('claimseed'));
    const account = await insertAccount(database.pg, `founder-${(counter += 1)}@example.com`);

    const inserted = await database.pg.query<{ anonymous: boolean }>(
      `INSERT INTO products
         (category_id, engine_id, name, url, normalized_url, description, description_hash,
          source, status, anonymous, claimed_at, claimed_by_account_id)
       VALUES ($1, 0, 'Reclaimed Co', 'https://r.example', 'r.example', 'd', $2, 'seeded', 'pending',
               false, now(), $3)
       RETURNING anonymous`,
      [categoryId, '0'.repeat(64), account.id],
    );
    expect(inserted.rows[0]?.anonymous).toBe(false);
  });
});
