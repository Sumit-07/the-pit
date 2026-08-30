/**
 * `submissions.pitch` — the founder's own words, and the floor under the cap.
 *
 * The browser's `maxlength` is one devtools edit away from irrelevant and the
 * route's `readPitch` is one refactor away from being skipped by a second
 * writer. This is the check that neither of those can get past, asserted against
 * the DDL Postgres actually created rather than against the `.sql` file that
 * asked for it — PGlite is Postgres, in-process, with every migration applied in
 * journal order.
 *
 * Hand-derived, from `0008_submission_pitch.sql`:
 *
 *   NULL              accepted — the field is optional, and every row written
 *                     before the column existed genuinely has no answer
 *   1 character       accepted
 *   800 characters    accepted   (the cap: ~130 words)
 *   801 characters    REJECTED by `submissions_pitch_limit`
 *   ''                REJECTED — an empty string is a claim nobody made, and
 *                     `NULL` is the value that says so
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { constraintsOf, expectRejection, migratedDatabase, type TestDatabase } from '../support/pg.js';

let database: TestDatabase;

beforeAll(async () => {
  database = await migratedDatabase();
});

afterAll(async () => {
  await database?.close();
});

const A_HASH = '0'.repeat(64);
let counter = 0;

/**
 * A `submissions` row that satisfies every OTHER constraint on the table, so a
 * rejection can only ever be the pitch's.
 */
async function insertPitch(pitch: string | null): Promise<string | null> {
  counter += 1;
  return await expectRejection(
    database.pg,
    `INSERT INTO submissions
       (category_slug, name, url, normalized_url, description, description_hash, pitch,
        cycle_id, tier, attempt_number)
     VALUES ('developer-tools', 'Ashgrove', 'https://ashgrove.dev', $1,
             'Turns meeting notes into a shared action list.', $2, $3,
             '2026-06-01', 'single', 1)`,
    [`ashgrove${counter}.dev`, A_HASH, pitch],
  );
}

describe('submissions.pitch', () => {
  it('exists as a nullable column, so the field stays optional', async () => {
    const rejection = await insertPitch(null);

    expect(rejection).toBeNull();
  });

  it('accepts a pitch at exactly the 800-character cap', async () => {
    const rejection = await insertPitch('x'.repeat(800));

    expect(rejection).toBeNull();
  });

  it('refuses 801 characters, naming the constraint that refused it', async () => {
    const rejection = await insertPitch('x'.repeat(801));

    expect(rejection).toContain('submissions_pitch_limit');
  });

  it('refuses an empty string, because NULL is what "said nothing" looks like', async () => {
    const rejection = await insertPitch('');

    expect(rejection).toContain('submissions_pitch_limit');
  });

  it('accepts a single character, so the cap is a ceiling and not a floor of one word', async () => {
    const rejection = await insertPitch('x');

    expect(rejection).toBeNull();
  });

  it('is a CHECK on the table, visible in pg_constraint', async () => {
    const constraints = await constraintsOf(database.pg, 'submissions');

    expect([...constraints.keys()]).toContain('submissions_pitch_limit');
    // The description's own cap is untouched: this migration is additive, and
    // the field it added is beside `description`, not a widening of it.
    expect([...constraints.keys()]).toContain('submissions_description_limit');
  });

  it('leaves description at 300, so nothing about what the jurors read has moved', async () => {
    counter += 1;
    const rejection = await expectRejection(
      database.pg,
      `INSERT INTO submissions
         (category_slug, name, url, normalized_url, description, description_hash, pitch,
          cycle_id, tier, attempt_number)
       VALUES ('developer-tools', 'Ashgrove', 'https://ashgrove.dev', $1, $2, $3, 'A short claim.',
               '2026-06-01', 'single', 1)`,
      [`ashgrove${counter}.dev`, 'x'.repeat(301), A_HASH],
    );

    expect(rejection).toContain('submissions_description_limit');
  });
});
