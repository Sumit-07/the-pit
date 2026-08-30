/**
 * The two origins of a seeded board, held to one answer about who is anonymous.
 *
 * ## The bug
 *
 * A cold-start board reaches a reader down two independent paths, and they
 * disagreed:
 *
 * - `packages/db/src/seed/build.ts` inserts every seeded product with
 *   `anonymous: true` — `products_seeded_is_anonymous` (`migrations/0009`) accepts
 *   no other row — and redacts the whole ranking before freezing a verdict page.
 * - `apps/web/src/lib/boards/source.ts` serves the board in filesystem mode,
 *   where there is no database at all. Its fallback, `anonymousIdsIn`, calls a row
 *   anonymous only when `row.url === ''`. The seeded `cjr/runs/<slug>/ranking.json`
 *   files carry REAL urls, so that set came back empty and the board rendered all
 *   92 real product names — Capgo, Sequo, Revopush — beside robot markup that
 *   never activated.
 *
 * The sentinel is not wrong; it answers a different question ("was this row
 * already redacted upstream") from the one the file path was asking ("should this
 * row be anonymous"). A seeded snapshot is anonymous by construction, and the
 * file could not know that, because the rule was a comment in two files that do
 * not import each other.
 *
 * This is the fourth time that shape has appeared in this repository — the board
 * read path bypassing the snapshot sink, production binding a filesystem category
 * source, six connection pools each documented as the only one, and now this. In
 * every case a comment claimed a property no file was bound by. So this test is
 * the binding, in the same discipline `theme-drift.test.ts` uses for the three
 * theme copies and `one-pool.test.ts` uses for database handles: it renders BOTH
 * origins from the real committed `cjr/` and fails if they say different things.
 *
 * ## What it will not accept
 *
 * 1. The two origins naming different anonymous sets.
 * 2. The two origins naming the same listing differently.
 * 3. Either origin publishing a real name, brand, URL or host — searched over the
 *    whole served document and the rendered HTML, not over the field that was
 *    supposed to hold the name. A name in a juror's reason is a leak that renders
 *    correctly.
 * 4. The committed seeded documents quietly ceasing to declare `anonymous_ids`.
 * 5. A future `anonymous_ids` that NARROWS a seeded run. The database refuses to
 *    store a named seeded row, so a JSON file is not where one gets opted back in.
 *
 * It reads the real `cjr/` rather than a fixture on purpose: the leak was in the
 * data these tests would otherwise have mocked away.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSeedRows, loadSeedInput, SEEDED_SLUGS } from '@the-pit/db';
import type { Ranking } from '@the-pit/engine';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { CategoryBoard } from '@/components/category-board';
import { seededAnonymousIds } from '@/lib/anon';
import { FileBoardSource, type BoardDocument } from '@/lib/boards/source';
import { toBoardView } from '@/lib/boards/view';

/** `cjr/` at the repository root; the suite's cwd is `apps/web`. */
const WORKDIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'cjr');

/**
 * A snapshot root that does not exist, so the SEEDED path is what is exercised.
 *
 * The published-snapshot branch wins where both exist, and it was never the
 * broken one. Pointing this at nothing is how the test stays about the origin
 * that shipped the names.
 */
const NO_SNAPSHOTS = join(WORKDIR, 'public-does-not-exist');

async function rawRanking(slug: string): Promise<Ranking> {
  return JSON.parse(await readFile(join(WORKDIR, 'runs', slug, 'ranking.json'), 'utf8')) as Ranking;
}

function board(slug: string): Promise<BoardDocument | undefined> {
  return new FileBoardSource({ workdir: WORKDIR, snapshotRoot: NO_SNAPSHOTS }).read(slug);
}

/** The rows of the seed builder's frozen verdicts, by engine id. */
async function frozenVerdicts(slug: string): Promise<Map<number, { name: string; url: string; json: string }>> {
  const rows = buildSeedRows(await loadSeedInput(slug, WORKDIR));
  const out = new Map<number, { name: string; url: string; json: string }>();
  for (const row of rows.verdicts) {
    const payload = row.payload as { verdict?: { id?: unknown; name?: unknown; url?: unknown } };
    const verdict = payload.verdict;
    if (typeof verdict?.id !== 'number') throw new Error(`${slug}: a frozen verdict has no engine id`);
    out.set(verdict.id, {
      name: String(verdict.name),
      url: String(verdict.url),
      json: JSON.stringify(row.payload),
    });
  }
  return out;
}

/**
 * Everything about one product that must not appear on a page: the name, the
 * brand at the front of it, the URL and the bare host.
 *
 * The same four things `redactRanking` builds patterns from, restated here from
 * the RAW document rather than imported from it — a leak test that derived its
 * needles from the redactor would pass by agreeing with the bug.
 */
function identityTokens(name: string, url: string): string[] {
  const tokens = [name, url];
  const head = name.split(/\s[—–|:·-]\s|[|:]/u)[0]?.trim() ?? '';
  if (head !== '' && head !== name.trim() && head.length >= 4) tokens.push(head);
  const host = url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^www\./i, '').split(/[/?#]/u)[0] ?? '';
  if (host.length >= 4) tokens.push(host);
  return tokens;
}

/**
 * Where a token occurs in a document, case-sensitively.
 *
 * Case-SENSITIVE, matching how `redactRanking` treats a brand head: prose says
 * "a first-party AI app builder" and "browsing crutch reviews" about products
 * called `AI App Builder | OverSkill` and `Crutch Reviews | Honest…`, and a
 * case-insensitive assertion would demand that ordinary English sentences be
 * mangled to protect an identity they are not naming.
 */
function occurrences(haystack: string, token: string): number {
  if (token === '') return 0;
  return haystack.split(token).length - 1;
}

describe.each(SEEDED_SLUGS)('%s: the two origins of a seeded board', (slug) => {
  it('declares its anonymous rows in the document, and declares all of them', async () => {
    // The intent lives in the data rather than in a heuristic — which is the
    // point of the field. If a re-rank drops it (`pnpm engine rank` writes the
    // engine's own schema), this fails and says so, rather than the board
    // quietly falling back to inference.
    const raw = (await rawRanking(slug)) as Ranking & { anonymous_ids?: unknown };

    expect(raw.anonymous_ids, `${slug}/ranking.json must declare anonymous_ids`).toBeDefined();
    expect(raw.anonymous_ids).toEqual(raw.ranking.map((row) => row.id).sort((a, b) => a - b));
  });

  it('agrees, file path and database path, on exactly who is anonymous', async () => {
    const document_ = await board(slug);
    const seed = buildSeedRows(await loadSeedInput(slug, WORKDIR));

    expect(document_).toBeDefined();
    const fromFile = [...(document_?.anonymousIds ?? [])].sort((a, b) => a - b);
    const fromDatabase = seed.products
      .filter((product) => product.anonymous === true)
      .map((product) => product.engineId as number)
      .sort((a, b) => a - b);

    expect(fromFile).toEqual(fromDatabase);
    // And that is every row on the board: this is the assertion the old fallback
    // failed, and it failed silently.
    expect(fromFile).toEqual((await rawRanking(slug)).ranking.map((row) => row.id).sort((a, b) => a - b));
    expect(fromFile.length).toBeGreaterThan(0);
  });

  it('gives one listing one designation, whichever origin a reader arrives through', async () => {
    // A board row and the verdict page it links to are two documents. If they
    // disagreed about what the listing is called, the anonymity would still hold
    // and the site would be incoherent — the row a reader clicked would not be
    // the page they landed on.
    const document_ = await board(slug);
    const frozen = await frozenVerdicts(slug);

    expect(document_).toBeDefined();
    for (const row of document_?.ranking.ranking ?? []) {
      expect(frozen.get(row.id)?.name, `engine id ${row.id}`).toBe(row.name);
      expect(frozen.get(row.id)?.url).toBe('');
      expect(row.name).toMatch(/^Unit [A-Za-z]+-\d{3}$/);
    }
  });

  it('publishes no real name, brand, URL or host — down either path', async () => {
    // The absence assertion, over whole documents. Searched from the RAW file, so
    // a product that is only ever mentioned inside another product's reason is
    // covered — which is where two of the leaks actually were.
    const raw = await rawRanking(slug);
    const document_ = await board(slug);
    if (document_ === undefined) throw new Error(`${slug} has no board`);

    const served = JSON.stringify(document_.ranking);
    const html = renderToStaticMarkup(createElement(CategoryBoard, { board: toBoardView(document_) }));
    const frozen = [...(await frozenVerdicts(slug)).values()].map((entry) => entry.json).join('\n');

    const leaks: string[] = [];
    for (const row of raw.ranking) {
      for (const token of identityTokens(row.name, row.url)) {
        if (occurrences(served, token) > 0) leaks.push(`board document: ${token}`);
        if (occurrences(html, token) > 0) leaks.push(`rendered board: ${token}`);
        if (occurrences(frozen, token) > 0) leaks.push(`frozen verdict: ${token}`);
      }
    }

    expect(leaks).toEqual([]);
  });

  it('still publishes every deduction, juror, score and cluster', async () => {
    // Anonymity withholds the identity and nothing else. A redaction that also
    // took the evidence would pass every test above and destroy the product.
    const raw = await rawRanking(slug);
    const document_ = await board(slug);
    if (document_ === undefined) throw new Error(`${slug} has no board`);

    const served = document_.ranking;
    expect(served.ranking.length).toBe(raw.ranking.length);

    for (const [index, row] of raw.ranking.entries()) {
      const out = served.ranking[index];
      expect(out?.id).toBe(row.id);
      expect(out?.rank).toBe(row.rank);
      expect(out?.composite).toBe(row.composite);
      expect(out?.demand).toBe(row.demand);
      // The cluster it was judged inside, in full. Its ID is not asserted to be
      // byte-identical: an id is minted from a product name (`c27-boldrouter`),
      // so the redaction rewrites the ones that spell out a withheld brand. What
      // must hold is that it still JOINS — a row's cluster is a cluster on the
      // board — and that everything a reader is shown about it is unchanged.
      expect(served.clusters.some((cluster) => cluster.cluster_id === out?.cluster.id)).toBe(true);
      expect(out?.cluster.label).toBe(row.cluster.label);
      expect(out?.cluster.size).toBe(row.cluster.size);
      expect(out?.cluster.uniqueness).toBe(row.cluster.uniqueness);
      expect(out?.cluster.reason.length).toBeGreaterThan(0);
      // Every metric, every deduction, every juror.
      expect(out?.scorecard.length).toBe(row.scorecard.length);
      for (const [metric, card] of row.scorecard.entries()) {
        expect(out?.scorecard[metric]?.score).toBe(card.score);
        expect(out?.scorecard[metric]?.deductions.length).toBe(card.deductions.length);
        for (const [cut, deduction] of card.deductions.entries()) {
          const kept = out?.scorecard[metric]?.deductions[cut];
          expect(kept?.points).toBe(deduction.points);
          expect(kept?.role).toBe(deduction.role);
          // The reason survives; only a name inside it can have moved.
          expect(kept?.reason.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('the rule itself', () => {
  it('does not read the redaction sentinel to decide who should be redacted', async () => {
    // The regression, stated directly. `url === ''` was the fallback that shipped
    // 92 names: every seeded row has a real URL, so it answered "nobody".
    const raw = await rawRanking('developer-tools');

    expect(raw.ranking.every((row) => row.url !== '')).toBe(true);
    expect(raw.ranking.filter((row) => row.url === '').map((row) => row.id)).toEqual([]);
    expect(seededAnonymousIds(raw).length).toBe(raw.ranking.length);
  });

  it('treats a document that declares nothing as fully anonymous', async () => {
    // A run seeded before the field existed, or one `pnpm engine rank` has just
    // rewritten. The safe default is not "infer", it is "all of it".
    const raw = (await rawRanking('developer-tools')) as Ranking & { anonymous_ids?: unknown };
    const { anonymous_ids: _dropped, ...withoutDeclaration } = raw;

    expect(seededAnonymousIds(withoutDeclaration as Ranking)).toEqual(
      raw.ranking.map((row) => row.id).sort((a, b) => a - b),
    );
  });

  it('will not let a declaration narrow a seeded run', async () => {
    // A file cannot opt a seeded row back into being named — the database refuses
    // to store one. A declaration adds; it never subtracts.
    const raw = await rawRanking('developer-tools');

    expect(seededAnonymousIds({ ...raw, anonymous_ids: [] })).toEqual(
      raw.ranking.map((row) => row.id).sort((a, b) => a - b),
    );
    expect(seededAnonymousIds({ ...raw, anonymous_ids: [raw.ranking[0]?.id ?? 0] }).length).toBe(raw.ranking.length);
    // Junk is not a declaration, and must not become one.
    expect(seededAnonymousIds({ ...raw, anonymous_ids: 'all' }).length).toBe(raw.ranking.length);
  });
});
