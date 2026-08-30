/**
 * The frozen comparison.
 *
 * Everything a verdict page overlays is arithmetic on the board being delivered,
 * frozen at that instant. `DECISIONS.md §1.2` forbids a page from FETCHING a
 * baseline — every z-score moves on the next placement, so a fetched one would
 * make a shared link change under its reader. It does not forbid freezing one,
 * and these tests are about the difference: every figure below is checked against
 * the committed board by an independent walk of `ranking.json`, so a derivation
 * that silently changed would fail rather than agree with itself.
 *
 * The identity rules get their own block. A peer's name is another product's
 * property, the payload can never be updated, and the founder's decision is that
 * anonymity is chosen at submission and immutable — so "we froze a name we should
 * not have" is a permanent public mistake, and it is tested for directly.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Ranking, RankedProduct } from '@the-pit/engine';

import { loadSeedInput, SEEDED_SLUGS } from '../src/seed/load.js';
import {
  freezeComparison,
  jurorCut,
  juryRoster,
  median,
  personaConviction,
  PEER_LIMIT,
  withheldIdentity,
} from '../src/verdict-comparison.js';

const WORKDIR = new URL('../../../cjr', import.meta.url).pathname;

async function board(slug: string): Promise<Ranking> {
  return (await loadSeedInput(slug, WORKDIR)).ranking;
}

/** The installed panel file, read straight off disk rather than through the loader. */
async function installedJurors(slug: string): Promise<string[]> {
  const raw = await readFile(join(WORKDIR, 'references', 'jurors', `${slug}.json`), 'utf8');
  return (JSON.parse(raw) as { jurors: { role: string }[] }).jurors.map((juror) => juror.role);
}

describe('the axis order is the installed panel, not an accident of drawing', () => {
  // The whole radar objection turns on this. If the axis order were arbitrary
  // then the SHAPE a reader remembers would be an artefact of which juror was
  // drawn first, and a comparison of two shapes would mean nothing. It is not
  // arbitrary: `rank/scorecard.ts` emits each metric's deductions in merged
  // score-log order, so every deduction list is a subsequence of the installed
  // roster and merging them recovers it exactly.
  for (const slug of SEEDED_SLUGS) {
    it(`recovers ${slug}'s installed juror order from the board alone`, async () => {
      expect(juryRoster(await board(slug))).toEqual(await installedJurors(slug));
    });
  }

  it('uses the run’s own frozen persona roster for the buyer axes', async () => {
    const ranking = await board('developer-tools');
    const row = ranking.ranking[0];
    if (row === undefined) throw new Error('the seeded board is empty');

    expect(freezeComparison(ranking, row).personas).toEqual(ranking.personas.map((persona) => persona.name));
  });

  it('survives a board whose first product does not show every juror', async () => {
    // The naive derivation — first appearance across the whole board — is right
    // only when the top row happens to have all six jurors in order on its first
    // metric. Strip the leading juror out of the first row's first metric and a
    // first-appearance roster reorders; the merge does not.
    const ranking = await board('developer-tools');
    const installed = await installedJurors('developer-tools');
    const first = installed[0];
    if (first === undefined) throw new Error('no installed jurors');

    const damaged: Ranking = {
      ...ranking,
      ranking: ranking.ranking.map((row, index) =>
        index !== 0
          ? row
          : {
              ...row,
              scorecard: row.scorecard.map((entry, entryIndex) =>
                entryIndex !== 0
                  ? entry
                  : { ...entry, deductions: entry.deductions.filter((d) => d.role !== first) },
              ),
            },
      ),
    };

    expect(juryRoster(damaged)).toEqual(installed);
  });
});

describe('every frozen figure is arithmetic on the board it was frozen from', () => {
  it('freezes a juror’s mean cut as their own points over the metrics they answered', async () => {
    const ranking = await board('developer-tools');
    const row = ranking.ranking[0];
    if (row === undefined) throw new Error('the seeded board is empty');
    const roster = juryRoster(ranking);

    for (const role of roster) {
      // Independent walk: sum this juror's points on the metrics they answered
      // and divide, without touching the function under test.
      let points = 0;
      let answered = 0;
      for (const entry of row.scorecard) {
        if (entry.substituted_roles.includes(role)) continue;
        answered += 1;
        for (const deduction of entry.deductions) if (deduction.role === role) points += deduction.points;
      }
      const expected = answered === 0 ? null : Math.round((points / answered) * 100) / 100;
      expect(jurorCut(row.scorecard, role), role).toBe(expected);
    }

    // And it is a real quantity, not an index: at least one juror took something.
    expect(roster.map((role) => jurorCut(row.scorecard, role)).some((v) => (v ?? 0) > 0)).toBe(true);
  });

  it('excludes a substituted metric from the denominator rather than scoring it zero', () => {
    const scorecard = [
      { metric: 'A', score: 60, spread: 0, juror_count: 2, substituted_roles: [], deductions: [{ points: 40, reason: 'r', role: 'J' }] },
      { metric: 'B', score: 50, spread: 0, juror_count: 2, substituted_roles: ['J'], deductions: [] },
    ];
    // 40 points over ONE answered metric, not 40 over two. The board wrote the 50
    // on metric B; the juror did not, and averaging it in would publish a
    // fabricated opinion as if they had.
    expect(jurorCut(scorecard, 'J')).toBe(40);
    expect(jurorCut(scorecard, 'nobody')).toBe(0);
    expect(jurorCut([{ ...scorecard[1]! }], 'J')).toBeNull();
  });

  it('scores conviction only on a first pick, and zero on a runner-up', () => {
    const picks = [
      { persona: 'A', pick: 'first' as const, strength: 88, reason: 'r' },
      { persona: 'B', pick: 'second' as const, reason: 'r' },
    ];
    expect(personaConviction(picks, 'A')).toBe(88);
    // `01 §6.2` records a strength on a first pick and on nothing else. A number
    // invented for B would be a conviction nobody wrote down.
    expect(personaConviction(picks, 'B')).toBe(0);
    expect(personaConviction(picks, 'C')).toBe(0);
  });

  it('freezes the category median per metric as the real middle of the board', async () => {
    const ranking = await board('developer-tools');
    const row = ranking.ranking[0];
    if (row === undefined) throw new Error('the seeded board is empty');

    const frozen = freezeComparison(ranking, row);
    expect(frozen.median.metrics.length).toBe(ranking.metrics.length);

    for (const entry of frozen.median.metrics) {
      const losses = ranking.ranking
        .flatMap((candidate) => candidate.scorecard.filter((s) => s.metric === entry.metric))
        .map((s) => 100 - s.score)
        .sort((a, b) => a - b);
      const mid = losses.length >> 1;
      const expected =
        losses.length % 2 === 1 ? losses[mid]! : ((losses[mid - 1]! + losses[mid]!) / 2);
      expect(entry.cuts, entry.metric).toBe(Math.round(expected * 100) / 100);
    }
  });

  it('takes the middle and not the mean', () => {
    // The one substitution that would produce plausible garbage everywhere else
    // on this page too.
    expect(median([1, 2, 100])).toBe(2);
    expect(median([1, 2, 3, 100])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it('takes the persona median over the products that faced a forced choice', async () => {
    const ranking = await board('developer-tools');
    const solo = ranking.ranking.find((row) => row.demand_status === 'solo_cluster');
    if (solo === undefined) throw new Error('no solo row on the seeded board');

    const frozen = freezeComparison(ranking, solo);
    const voted = ranking.ranking.filter((row) => row.demand_detail !== undefined);

    // Counting the 32 solo rows' absent votes as zeros would move the middle of
    // "what a buyer gives a product" using products no buyer was ever shown.
    expect(frozen.votedSize).toBe(voted.length);
    expect(frozen.votedSize).toBeLessThan(frozen.boardSize);

    frozen.personas.forEach((persona, index) => {
      const expected = median(voted.map((row) => personaConviction(row.demand_detail?.picks ?? [], persona)));
      expect(frozen.median.personas[index], persona).toBe(expected);
    });
  });
});

describe('the peers are this product’s cluster, and a solo cluster has none', () => {
  it('freezes exactly the other members of the row’s own cluster', async () => {
    const ranking = await board('health-fitness-wellness');
    const row = ranking.ranking.find((candidate) => candidate.cluster.size >= 2);
    if (row === undefined) throw new Error('no clustered row on the seeded board');

    const frozen = freezeComparison(ranking, row);
    const mates = ranking.ranking.filter(
      (candidate) => candidate.cluster.id === row.cluster.id && candidate.id !== row.id,
    );

    expect(frozen.peers.length).toBe(Math.min(mates.length, PEER_LIMIT));
    expect(frozen.peers.map((peer) => peer.rank).sort((a, b) => a - b)).toEqual(
      mates.slice(0, PEER_LIMIT).map((mate) => mate.rank).sort((a, b) => a - b),
    );
    // The row never compares itself against itself.
    expect(frozen.peers.some((peer) => peer.rank === row.rank)).toBe(false);
  });

  it('freezes no peers for a solo cluster, and does not invent one', async () => {
    const ranking = await board('developer-tools');
    const solo = ranking.ranking.find((row) => row.cluster.size === 1);
    if (solo === undefined) throw new Error('no solo cluster on the seeded board');

    const frozen = freezeComparison(ranking, solo);
    expect(frozen.peers).toEqual([]);
    // And the one baseline it CAN have is present, which is the whole point of
    // freezing a median: 32 of 48 rows are in this arm.
    expect(frozen.median.jurors.some((value) => value !== null)).toBe(true);
  });

  it('carries a peer’s own figures, not the subject’s', async () => {
    const ranking = await board('health-fitness-wellness');
    const row = ranking.ranking.find((candidate) => candidate.cluster.size >= 2);
    if (row === undefined) throw new Error('no clustered row on the seeded board');

    const frozen = freezeComparison(ranking, row);
    const first = frozen.peers[0];
    if (first === undefined) throw new Error('no peer frozen');

    const mate = ranking.ranking.find((candidate) => candidate.rank === first.rank);
    if (mate === undefined) throw new Error('the frozen peer is not on the board');

    expect(first.jurors).toEqual(frozen.jurors.map((role) => jurorCut(mate.scorecard, role)));
    expect(first.personas).toEqual(
      frozen.personas.map((persona) => personaConviction(mate.demand_detail?.picks ?? [], persona)),
    );
  });

  it('caps the peers it draws and drops the median once the chart is full', async () => {
    const ranking = await board('developer-tools');
    const row = ranking.ranking[0];
    if (row === undefined) throw new Error('the seeded board is empty');

    // A synthetic cluster of seven. The seeded boards top out at three, and a
    // radial carrying six grey outlines has stopped being a comparison.
    const big: RankedProduct[] = ranking.ranking.slice(0, 7).map((candidate) => ({
      ...candidate,
      cluster: { ...candidate.cluster, id: 'c-big', size: 7 },
    }));
    const subject = big[0];
    if (subject === undefined) throw new Error('no subject');

    const frozen = freezeComparison({ ...ranking, ranking: big }, subject);
    expect(frozen.peers.length).toBe(PEER_LIMIT);
    // Four peers plus a median is five context shapes on six axes. The median is
    // the one that goes: it earns its place when there is little else to compare
    // against, which is the solo case it exists for.
    expect(frozen.median.jurors.every((value) => value === null)).toBe(true);
    // The per-metric median is NOT dropped: it is a tick on a bar, not a shape
    // on the radial, so it costs the radial nothing.
    expect(frozen.median.metrics.length).toBeGreaterThan(0);
  });
});

describe('a peer’s name is never frozen unless that peer chose to be named', () => {
  it('withholds every name by default, and freezes a stable pseudonym instead', async () => {
    const ranking = await board('health-fitness-wellness');
    const row = ranking.ranking.find((candidate) => candidate.cluster.size >= 2);
    if (row === undefined) throw new Error('no clustered row on the seeded board');

    const frozen = freezeComparison(ranking, row);
    const names = ranking.ranking.map((candidate) => candidate.name);
    const serialised = JSON.stringify(frozen);

    for (const peer of frozen.peers) {
      expect(peer.anonymous).toBe(true);
      // A link to a peer's verdict page is the peer's name.
      expect(peer.slug).toBeNull();
      expect(peer.avatarSeed).not.toBe('');
      expect(names).not.toContain(peer.label);
    }
    // Nowhere in the document, not merely nowhere in the `label` field. The
    // payload is append-only: a name frozen here can never be taken back.
    for (const name of names) expect(serialised).not.toContain(name);
  });

  it('gives the same product the same pseudonym every time', () => {
    const row = { id: 31 } as RankedProduct;
    expect(withheldIdentity(row).label).toBe(withheldIdentity(row).label);
    expect(withheldIdentity({ id: 32 } as RankedProduct).label).not.toBe(withheldIdentity(row).label);
  });

  it('lets a resolver name a peer that chose to be named, with a link to its own page', async () => {
    const ranking = await board('health-fitness-wellness');
    const row = ranking.ranking.find((candidate) => candidate.cluster.size >= 2);
    if (row === undefined) throw new Error('no clustered row on the seeded board');

    const frozen = freezeComparison(ranking, row, (peer) => ({
      anonymous: false,
      label: peer.name,
      slug: `slug-${peer.id}`,
      avatarSeed: `peer:${peer.id}`,
    }));

    for (const peer of frozen.peers) {
      expect(peer.anonymous).toBe(false);
      expect(peer.slug).toMatch(/^slug-\d+$/);
      expect(ranking.ranking.map((c) => c.name)).toContain(peer.label);
    }
  });

  it('refuses a link on an anonymous peer even when the resolver supplies one', async () => {
    const ranking = await board('health-fitness-wellness');
    const row = ranking.ranking.find((candidate) => candidate.cluster.size >= 2);
    if (row === undefined) throw new Error('no clustered row on the seeded board');

    // A resolver that contradicts itself. The freezer is the last place this can
    // be caught before it becomes a permanent public page.
    const frozen = freezeComparison(ranking, row, (peer) => ({
      anonymous: true,
      label: 'Anon-TEST',
      slug: `slug-${peer.id}`,
      avatarSeed: `peer:${peer.id}`,
    }));

    for (const peer of frozen.peers) expect(peer.slug).toBeNull();
  });
});
