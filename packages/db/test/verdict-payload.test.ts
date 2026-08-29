/**
 * The one freezer, now that two callers use it.
 *
 * `verdictPayload` was private to `seed/build.ts` while the only verdicts in
 * existence were `brief` Part 7's cold-start ones. A paid delivery freezes the
 * same document at the moment the board republishes, so it moved out — and the
 * point of moving it rather than writing a second one is that two freezers would
 * be two answers to "what did we actually say to this customer", differing
 * invisibly, because both produce a page that renders.
 *
 * So the assertions here are about the document being COMPLETE. `brief` Part 6
 * enumerates the card and Part 5 stamps it; a field missing from the payload is a
 * field the permanent public page can never show, on a table that refuses UPDATE.
 *
 * Built over the real committed board, through `loadSeedInput`, so the shape is
 * the one `apps/web`'s `parseVerdict` actually reads. No database, no network.
 */

import { describe, expect, it } from 'vitest';

import { loadSeedInput } from '../src/seed/load.js';
import { verdictPayload, verdictPayloadFor, VerdictRowMissingError } from '../src/verdict-payload.js';

const ISSUED_AT = new Date('2026-08-27T14:03:00.000Z');
const WORKDIR = new URL('../../../cjr', import.meta.url).pathname;

async function board(): Promise<Awaited<ReturnType<typeof loadSeedInput>>> {
  return loadSeedInput('developer-tools', WORKDIR);
}

describe('the frozen verdict document', () => {
  it('carries the board-level context a rank is meaningless without', async () => {
    const input = await board();
    const row = input.ranking.ranking[0];
    if (row === undefined) throw new Error('the seeded board is empty');

    const payload = verdictPayload(input.ranking, row, input.categorySnapshotVersion, ISSUED_AT);

    // `DECISIONS.md §1.2` moves every z-score on the next placement, so without
    // these two a rank of 4 is a number with no denominator.
    expect(payload['product_count']).toBe(input.ranking.ranking.length);
    expect(payload['issued_at']).toBe(ISSUED_AT.toISOString());

    // `brief §1.3`: the page is auditable against the panels that produced it.
    expect(payload['category_snapshot_version']).toBe(input.categorySnapshotVersion);
    expect(payload['prompt_version']).toBe(input.ranking.prompt_version);
    expect(payload['persona_version']).toBe(input.ranking.demand_version);
    expect(payload['uniqueness_version']).toBe(input.ranking.uniqueness_version);

    // `core` is a blend and the page shows the blend, so the weights travel with
    // it. `health` deliberately does not: it is a statement about the PANEL, it is
    // already frozen on the snapshot row, and copying it onto 48 verdicts would
    // make one board's quality metrics 48 rows that could disagree.
    expect(payload['weights']).toEqual(input.ranking.weights);
    expect(payload['health']).toBeUndefined();
  });

  it('embeds the ranked row whole rather than projecting it', async () => {
    // `RankedProduct` already carries every deduction with its reason and its
    // juror, the cluster the product was judged inside, and the Floor's picks.
    // Projecting those into named fields would drop one the moment the engine
    // adds it — on a table with no UPDATE path.
    const input = await board();
    const row = input.ranking.ranking[0];
    if (row === undefined) throw new Error('the seeded board is empty');

    const payload = verdictPayload(input.ranking, row, input.categorySnapshotVersion, ISSUED_AT);
    expect(payload['verdict']).toBe(row);
  });

  it('carries the denominator a pick count needs to mean anything', async () => {
    // "5 personas picked you" reads as a strong result or a weak one depending on
    // whether the roster was 6 or 40, and the row carries only the numerator.
    // `01 §6.2`'s `P` is the run's OWN frozen roster, not a panel read live off
    // disk, which can have drifted since the board was produced.
    const input = await board();
    const row = input.ranking.ranking[0];
    if (row === undefined) throw new Error('the seeded board is empty');

    const payload = verdictPayload(input.ranking, row, input.categorySnapshotVersion, ISSUED_AT);
    expect(payload['demand_roster_size']).toBe(input.ranking.personas.length);
  });
});

describe('freezing one product of a delivered board', () => {
  it('finds the row by the engine id the run knows it as', async () => {
    const input = await board();
    const row = input.ranking.ranking[2];
    if (row === undefined) throw new Error('the seeded board is too small');

    const payload = verdictPayloadFor(input.ranking, row.id, input.categorySnapshotVersion, ISSUED_AT);
    expect(payload['verdict']).toBe(row);
  });

  it('refuses a product the board does not rank', async () => {
    // The delivery path's alternative to a verdict is not "no verdict" — it is an
    // attempt consumed for nothing. `brief §1.2` re-ranks the whole category on a
    // placement, so a placed product missing from the ranking means the re-rank
    // did not include the thing that was paid for, and that has to stop the
    // transaction rather than be skipped.
    const input = await board();
    expect(() => verdictPayloadFor(input.ranking, 99_999, input.categorySnapshotVersion, ISSUED_AT)).toThrow(
      VerdictRowMissingError,
    );
  });

  it('names the product it could not find, so the failure is diagnosable', async () => {
    const input = await board();
    expect(() => verdictPayloadFor(input.ranking, 99_999, input.categorySnapshotVersion, ISSUED_AT)).toThrow(
      /99999/,
    );
  });
});

describe('the seed and the delivery freeze the same document', () => {
  it('produces byte-identical output for the same row and instant', async () => {
    // The property that makes one freezer worth having. If these ever differ, a
    // cold-start page and a paid page are two shapes and `parseVerdict` reads
    // only one of them.
    const input = await board();
    const row = input.ranking.ranking[1];
    if (row === undefined) throw new Error('the seeded board is too small');

    const direct = verdictPayload(input.ranking, row, input.categorySnapshotVersion, ISSUED_AT);
    const byId = verdictPayloadFor(input.ranking, row.id, input.categorySnapshotVersion, ISSUED_AT);
    expect(JSON.stringify(byId)).toBe(JSON.stringify(direct));
  });
});
