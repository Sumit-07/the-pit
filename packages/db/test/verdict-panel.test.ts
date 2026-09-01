/**
 * The mandate that judged you, frozen with the rest of the verdict.
 *
 * The temptation this exists to close is that `cjr/references/jurors/<slug>.json`
 * and `cjr/references/personas/<slug>.json` are on disk and a verdict page could
 * read them at render time for nothing. That is the mistake `DECISIONS.md §1.2`
 * forbids one level up, applied to the panel instead of the board: a jury is
 * VERSIONED and a mandate can be revised (`01 §4` Steps 2 and 3 bump
 * `prompt_version` and `persona_version` by hand on any edit), so a permanent
 * public URL that read the current panel would eventually describe jurors who
 * are not the ones who cut that product.
 *
 * So it is frozen here, and the asymmetry between the two rosters is the thing
 * worth pinning: a `Ranking` carries its own `personas` (`01 §6.6`), so a buyer's
 * mandate is frozen on every path; it carries no juror roster at all, so a
 * juror's mandate is frozen only where the caller held the installed jury. The
 * second case has to degrade to an empty list rather than to a guess.
 */

import { describe, expect, it } from 'vitest';

import { loadSeedInput } from '../src/seed/load.js';
import { buildSeedRows } from '../src/seed/build.js';
import { freezePanel } from '../src/verdict-panel.js';
import { verdictPayload } from '../src/verdict-payload.js';

const ISSUED_AT = new Date('2026-08-27T14:03:00.000Z');
const WORKDIR = new URL('../../../cjr', import.meta.url).pathname;

async function board(): Promise<Awaited<ReturnType<typeof loadSeedInput>>> {
  return loadSeedInput('developer-tools', WORKDIR);
}

describe('the frozen panel', () => {
  it('freezes every installed juror’s mandate, in installed order', async () => {
    const input = await board();
    const panel = freezePanel(input.ranking, input.jury);

    expect(panel.jurors).toHaveLength(input.jury.jurors.length);
    panel.jurors.forEach((juror, index) => {
      const installed = input.jury.jurors[index];
      expect(juror.role).toBe(installed?.role);
      expect(juror.who).toBe(installed?.who);
      expect(juror.cares_most).toBe(installed?.cares_most);
      expect(juror.biased_against).toBe(installed?.biased_against);
    });

    // `voice` is how a juror WRITES and `weights` is what the ranking math
    // reads. Neither answers "who is this and what do they punish", and both
    // would grow a document written once per product per board.
    for (const juror of panel.jurors) {
      expect(Object.keys(juror).sort()).toEqual(['biased_against', 'cares_most', 'role', 'who']);
    }
  });

  it('freezes every buyer from the run’s own roster, not from the panel file', async () => {
    const input = await board();
    const panel = freezePanel(input.ranking);

    // `ranking.personas` is what the run actually used, frozen in the board
    // artifact. It is the same list `freezeComparison` takes its persona axis
    // order from, so a spoke and its biography cannot come from two rosters.
    expect(panel.buyers.map((buyer) => buyer.name)).toEqual(input.ranking.personas.map((p) => p.name));
    for (const buyer of panel.buyers) {
      expect(buyer.description).not.toBe('');
      expect(buyer.needs.length).toBeGreaterThan(0);
      expect(['low', 'medium', 'high']).toContain(buyer.price_sensitivity);
    }
  });

  it('freezes no juror mandate at all when the caller held no jury', async () => {
    const input = await board();
    const panel = freezePanel(input.ranking);

    // The paid delivery path holds a store and a board and never the installed
    // jury. An empty list is the honest answer there; a biography guessed from
    // the role name would be a permanent public page inventing a person.
    expect(panel.jurors).toEqual([]);
    expect(panel.buyers.length).toBeGreaterThan(0);
  });
});

describe('the panel travels in the document', () => {
  it('is in the payload the freezer writes', async () => {
    const input = await board();
    const row = input.ranking.ranking[0];
    if (row === undefined) throw new Error('the seeded board is empty');

    const withJury = verdictPayload(input.ranking, row, input.categorySnapshotVersion, ISSUED_AT, {
      jury: input.jury,
    });
    const withoutJury = verdictPayload(input.ranking, row, input.categorySnapshotVersion, ISSUED_AT);

    expect((withJury['panel'] as { jurors: unknown[] }).jurors).toHaveLength(input.jury.jurors.length);
    expect((withoutJury['panel'] as { jurors: unknown[] }).jurors).toEqual([]);
    // Buyers on both, because the board carries them.
    for (const payload of [withJury, withoutJury]) {
      expect((payload['panel'] as { buyers: unknown[] }).buyers.length).toBeGreaterThan(0);
    }
  });

  it('rides on every seeded verdict, because the seed holds the jury', async () => {
    const rows = buildSeedRows(await board()).verdicts;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const panel = (row.payload as { panel?: { jurors: unknown[]; buyers: unknown[] } }).panel;
      expect(panel?.jurors.length).toBe(6);
      expect(panel?.buyers.length).toBeGreaterThan(0);
    }
  });
});
