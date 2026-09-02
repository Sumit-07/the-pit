/**
 * The generator's own contract.
 *
 * `apps/web/test/anonymous-listings.test.ts` asserts the property that actually
 * matters — that a withheld name appears nowhere in a served page — over the real
 * cold-start board. These are the unit-level claims underneath it: that a
 * designation is stable and unique, that a robot is deterministic and legible
 * small, and that a redaction removes an identity from a whole document rather
 * than from the field it happened to be stored in.
 *
 * They live here rather than in the app because this package is what the seed
 * builder in `@the-pit/db` also depends on. A property proved only through the
 * app's rendering would not cover the path that freezes a verdict payload, and
 * that path is the one where a mistake is permanent.
 */

import type { Ranking } from '@the-pit/engine';
import { describe, expect, it } from 'vitest';

import { assignPseudonyms, DESIGNATIONS, hash32, pseudonymFor } from '../src/pseudonym.js';
import { anonIdentities, redactRanking } from '../src/redact.js';
import { declaredAnonymousIds, seededAnonymousIds } from '../src/seeded.js';
import { robotSpec, robotSvg } from '../src/robot.js';

/**
 * A ranking with two products, one of which mentions the other by name.
 *
 * The cross-mention is the case that makes a field-wide redaction wrong: on the
 * real `developer-tools` board exactly one cluster reason names a different
 * product, and a redactor that only rewrote `row.name` would publish it.
 */
function ranking(): Ranking {
  const row = (id: number, name: string, url: string, reason: string): unknown => ({
    id,
    name,
    url,
    rank: id + 1,
    composite: 0,
    core: 0,
    tiebroken: false,
    demand_status: 'solo_cluster',
    scorecard: [
      {
        metric: 'clarity',
        score: 70,
        spread: 4,
        juror_count: 6,
        substituted_roles: [],
        deductions: [{ points: 30, reason, role: 'The Seed Investor' }],
      },
    ],
    cluster: { id: 'c1', label: 'notes', size: 2, uniqueness: 40, reason: 'A small niche.' },
  });

  return {
    category: 'Developer Tools',
    type: 'b2b',
    prompt_version: 'v2',
    demand_version: 'v1',
    uniqueness_version: 'v2',
    weights: { merit: 0.65, demand: 0.35, uniqueness_lambda: 0.075 },
    metrics: [{ name: 'clarity', description: 'How clear', weight: 1 }],
    personas: [],
    clusters: [],
    flaggedInjections: [],
    health: { discrimination: 0, demand_discrimination: 0, avg_metric_spread: 0, tiebreak_count: 0 },
    ranking: [
      row(0, 'Ashgrove', 'https://ashgrove.example/', 'Reads like a worse Runlet Deploy.'),
      row(1, 'Runlet Deploy', 'https://runlet.example/', 'Nothing here but a name.'),
    ],
  } as unknown as Ranking;
}

describe('the hash', () => {
  it('moves nearly half its bits when one input bit changes', () => {
    // Every seed is short and similar (`developer-tools#0`, `#1`, …), and the
    // robot slices this value into five small fields. Sluggish low bits would
    // give adjacent rows near-identical robots.
    const a = hash32('developer-tools#7');
    const b = hash32('developer-tools#8');
    const differing = (a ^ b).toString(2).split('').filter((bit) => bit === '1').length;
    expect(differing).toBeGreaterThan(8);
  });

  it('is a 32-bit unsigned value for every input', () => {
    for (const seed of ['', 'a', 'developer-tools#0', '\u{1F916}', 'x'.repeat(500)]) {
      const h = hash32(seed);
      expect(Number.isInteger(h)).toBe(true);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThanOrEqual(0xffffffff);
    }
  });
});

describe('the designation', () => {
  it('uses the NATO alphabet, spelled as the standard spells it', () => {
    // `Alfa` and `Juliett` look like typos and are not. The standard spelling is
    // the cheapest signal that this is a call sign rather than a brand.
    expect(DESIGNATIONS).toContain('Alfa');
    expect(DESIGNATIONS).toContain('Juliett');
    expect(DESIGNATIONS).toHaveLength(26);
  });

  it('spreads across the vocabulary rather than favouring a few words', () => {
    const words = new Set(
      Array.from({ length: 500 }, (_, index) => pseudonymFor(`developer-tools#${index}`).split(' ')[1]?.split('-')[0]),
    );
    expect(words.size).toBeGreaterThan(20);
  });

  it('is stable and unique across a category', () => {
    const ids = Array.from({ length: 300 }, (_, index) => index);
    const first = assignPseudonyms('developer-tools', ids);
    const again = assignPseudonyms('developer-tools', ids);

    expect(new Set(first.values()).size).toBe(300);
    for (const [id, name] of first) expect(again.get(id)).toBe(name);
  });

  it('is not disturbed by the order the ids arrive in', () => {
    // A placement appends a row; the planner may hand them back in any order.
    // The walk sorts, so the answer cannot depend on that.
    const ascending = assignPseudonyms('developer-tools', [0, 1, 2, 3]);
    const scrambled = assignPseudonyms('developer-tools', [3, 1, 0, 2]);
    for (const [id, name] of ascending) expect(scrambled.get(id)).toBe(name);
  });
});

describe('the robot', () => {
  it('is deterministic, and different for a different seed', () => {
    expect(robotSvg('Unit Kilo-427')).toBe(robotSvg('Unit Kilo-427'));
    expect(robotSvg('Unit Kilo-427')).not.toBe(robotSvg('Unit Kilo-428'));
  });

  it('reaches most of its 768 faces over a realistic population', () => {
    const specs = new Set(
      Array.from({ length: 600 }, (_, index) => JSON.stringify(robotSpec(pseudonymFor(`c#${index}`)))),
    );
    expect(specs.size).toBeGreaterThan(300);
  });

  it('carries neither hue, so an avatar cannot read as a score', () => {
    for (let index = 0; index < 200; index += 1) {
      const svg = robotSvg(pseudonymFor(`c#${index}`));
      expect(svg).not.toContain('--cut');
      expect(svg).not.toContain('--held');
    }
  });

  it('is one unit per device pixel at row scale, and crisp', () => {
    const svg = robotSvg('Unit Kilo-427', { size: 16 });
    expect(svg).toContain('viewBox="0 0 16 16"');
    expect(svg).toContain('width="16" height="16"');
    expect(svg).toContain('shape-rendering="crispEdges"');
  });

  it('is hidden from a screen reader unless it is given a name', () => {
    // On a board the designation sits in text beside it, so a label here would
    // make a reader say the name twice. On a verdict page it is the header's own
    // mark. There is no default, because a default is wrong on one of the two.
    expect(robotSvg('Unit Kilo-427')).toContain('aria-hidden="true"');
    const labelled = robotSvg('Unit Kilo-427', { label: 'Unit Kilo-427, an anonymous listing' });
    expect(labelled).toContain('role="img"');
    expect(labelled).toContain('aria-label="Unit Kilo-427, an anonymous listing"');
  });

  it('escapes a label rather than letting it become markup', () => {
    const svg = robotSvg('seed', { label: '"><script>alert(1)</script>' });
    expect(svg).not.toContain('<script>');
    expect(svg).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('reaches for nothing on the network', () => {
    const svg = robotSvg('Unit Kilo-427');
    expect(svg).not.toContain('http');
    expect(svg).not.toContain('<image');
    expect(svg).not.toContain('url(');
  });
});

describe('the redaction', () => {
  it('replaces the name and blanks the URL of the rows it is given', () => {
    const out = redactRanking(ranking(), [0], 'developer-tools');
    const target = out.ranking.find((row) => row.id === 0);

    expect(target?.name).toMatch(/^Unit [A-Za-z]+-\d{3}$/);
    expect(target?.url).toBe('');
  });

  it('scrubs the name out of ANOTHER product’s free text', () => {
    // Row 1's deduction reason mentions "Runlet Deploy", which is row 1's own
    // name — the shape of the one real cross-mention on the seeded board.
    const out = redactRanking(ranking(), [1], 'developer-tools');
    expect(JSON.stringify(out)).not.toContain('Runlet Deploy');
  });

  it('scrubs the BRAND, not only the full name, because that is what prose says', () => {
    // The leak that was found by rendering a real board. Directory-scraped names
    // look like "Sequo — stop re-explaining your project to your coding agent",
    // and no reason on `developer-tools` contains that string; three contain
    // "Sequo". Matching only the exact name would have published the brand of a
    // listing that withheld it.
    const input = ranking();
    (input.ranking[0] as { name: string }).name = 'Ashgrove — the notes app for teams';
    (input.ranking[1] as { scorecard: { deductions: { reason: string }[] }[] }).scorecard[0]!.deductions[0]!.reason =
      'Ashgrove already does this, and does it in the repo.';

    const out = redactRanking(input, [0], 'developer-tools');
    expect(JSON.stringify(out)).not.toContain('Ashgrove');
  });

  it('scrubs the brand when a plain hyphen separates it from the tagline', () => {
    // The second half of the same leak, found the same way. Eleven of the 48
    // `developer-tools` names are `Brand - tagline` with an ASCII hyphen rather
    // than an em dash, and the first separator list did not include it — so the
    // board published "…but Capgo's open-source rival directly undercuts the
    // moat" and "near-identical peer (BuildAI) in this set" beside a robot.
    const input = ranking();
    (input.ranking[0] as { name: string }).name = 'Ashgrove - the notes app for teams';
    (input.ranking[1] as { scorecard: { deductions: { reason: string }[] }[] }).scorecard[0]!.deductions[0]!.reason =
      "Ashgrove's open-source rival directly undercuts the moat.";

    const out = redactRanking(input, [0], 'developer-tools');
    expect(JSON.stringify(out)).not.toContain('Ashgrove');
  });

  it('does not split a name on a hyphen that is inside the brand', () => {
    // ` - ` and never a bare `-`. "Hold-My-Lid" and "GLP-1 Journey Log App" are
    // real seeded names; splitting on the bare character would scrub the
    // fragment "Hold" out of every reason on the board.
    const input = ranking();
    (input.ranking[0] as { name: string }).name = 'Hold-My-Lid';
    (input.ranking[1] as { cluster: { reason: string } }).cluster.reason = 'Hold the lid open and keep coding.';

    const out = redactRanking(input, [0], 'developer-tools');
    expect(out.ranking.find((row) => row.id === 1)?.cluster.reason).toBe('Hold the lid open and keep coding.');
  });

  it('scrubs the bare host as well as the full URL', () => {
    // `https://ashgrove.example/` and `ashgrove.example` name the same company,
    // and a reason that mentions the second is not covered by a pattern built
    // from the first.
    const input = ranking();
    (input.ranking[1] as { cluster: { reason: string } }).cluster.reason = 'Same idea as ashgrove.example.';

    const out = redactRanking(input, [0], 'developer-tools');
    expect(JSON.stringify(out)).not.toContain('ashgrove.example');
  });

  it('turns a cluster id into a positional token, so it can spell nothing', () => {
    // The uniqueness pass mints an id from the idea a cluster is about, and a
    // cluster of one has the product for an idea — `c9-invofox`. A slug is the
    // one form of a name that neither the full-name pattern nor the
    // case-sensitive brand head matches, so the fix is to stop the id carrying
    // text at all.
    const input = ranking();
    input.clusters = [
      { cluster_id: 'c9-ashgrove', label: 'Notes', size: 2 },
      { cluster_id: 'c4-runlet-deploy', label: 'Deploys', size: 1 },
    ];
    (input.ranking[0] as { cluster: { id: string } }).cluster.id = 'c4-runlet-deploy';
    (input.ranking[1] as { cluster: { id: string } }).cluster.id = 'c9-ashgrove';

    const out = redactRanking(input, [0, 1], 'developer-tools');

    expect(out.clusters.map((cluster) => cluster.cluster_id)).toEqual(['c1', 'c2']);
    expect(JSON.stringify(out)).not.toContain('ashgrove');
    expect(JSON.stringify(out)).not.toContain('runlet');
  });

  it('moves every reference to an id with the id itself', () => {
    // Positional or not, an id is a join key: the row's cluster must still be a
    // cluster on the roster.
    const input = ranking();
    input.clusters = [
      { cluster_id: 'c9-ashgrove', label: 'Notes', size: 2 },
      { cluster_id: 'c4-runlet-deploy', label: 'Deploys', size: 1 },
    ];
    (input.ranking[0] as { cluster: { id: string } }).cluster.id = 'c4-runlet-deploy';
    (input.ranking[1] as { cluster: { id: string } }).cluster.id = 'c9-ashgrove';

    const out = redactRanking(input, [0, 1], 'developer-tools');
    const roster = new Set(out.clusters.map((cluster) => cluster.cluster_id));

    expect(out.ranking[0]?.cluster.id).toBe('c2');
    expect(out.ranking[1]?.cluster.id).toBe('c1');
    for (const row of out.ranking) expect(roster.has(row.cluster.id)).toBe(true);
  });

  it('numbers a cluster no row names, so the roster never loses one', () => {
    // A cluster the panel scored and nobody was ranked into is still on the
    // board's roster, and a rewrite that only walked the rows would drop it.
    const input = ranking();
    input.clusters = [
      { cluster_id: 'c9-ashgrove', label: 'Notes', size: 2 },
      { cluster_id: 'c2-empty', label: 'Nobody', size: 0 },
    ];
    (input.ranking[0] as { cluster: { id: string } }).cluster.id = 'c9-ashgrove';
    (input.ranking[1] as { cluster: { id: string } }).cluster.id = 'c9-ashgrove';

    const out = redactRanking(input, [0], 'developer-tools');
    expect(out.clusters.map((cluster) => cluster.cluster_id)).toEqual(['c1', 'c2']);
    expect(out.ranking.every((row) => row.cluster.id === 'c1')).toBe(true);
  });

  it('leaves a row it was not given completely alone', () => {
    const out = redactRanking(ranking(), [0], 'developer-tools');
    const other = out.ranking.find((row) => row.id === 1);

    expect(other?.name).toBe('Runlet Deploy');
    expect(other?.url).toBe('https://runlet.example/');
  });

  it('keeps every number, reason and cluster intact', () => {
    // Anonymity withholds the identity and nothing else. A redactor that touched
    // a score would be a second ranking implementation hiding inside a privacy
    // feature.
    const before = ranking();
    const out = redactRanking(before, [0, 1], 'developer-tools');

    expect(out.ranking[0]?.scorecard[0]?.score).toBe(70);
    expect(out.ranking[0]?.cluster.uniqueness).toBe(40);
    expect(out.ranking[0]?.scorecard[0]?.deductions[0]?.points).toBe(30);
    expect(out.ranking[0]?.scorecard[0]?.deductions[0]?.role).toBe('The Seed Investor');
    expect(out.weights).toEqual(before.weights);
  });

  it('does not mutate the document it was handed', () => {
    // On the read path the input is a parsed snapshot other callers may still be
    // holding.
    const input = ranking();
    redactRanking(input, [0], 'developer-tools');
    expect(input.ranking[0]?.name).toBe('Ashgrove');
  });

  it('is idempotent, so three redaction points cannot disagree', () => {
    const once = redactRanking(ranking(), [0, 1], 'developer-tools');
    const twice = redactRanking(once, [0, 1], 'developer-tools');
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });

  it('returns the input untouched when nothing is anonymous', () => {
    const input = ranking();
    expect(redactRanking(input, [], 'developer-tools')).toBe(input);
  });

  it('agrees with the identity map the surfaces read', () => {
    const out = redactRanking(ranking(), [0], 'developer-tools');
    const identities = anonIdentities('developer-tools', [0]);
    expect(out.ranking.find((row) => row.id === 0)?.name).toBe(identities.get(0)?.pseudonym);
  });
});

// ------------------------------------------------- who a seeded board hides

describe('a seeded board’s anonymous set', () => {
  it('is every row when the document declares nothing', () => {
    // The safe default, and the one the filesystem board did not have: its
    // fallback asked whether a row was ALREADY redacted (`url === ''`), and a
    // seeded row has a real address, so it answered "nobody is anonymous" for a
    // document the database considers entirely anonymous.
    const input = ranking();
    expect(seededAnonymousIds(input)).toEqual([0, 1]);
    expect(input.ranking.every((row) => row.url !== '')).toBe(true);
  });

  it('reads the declaration the document carries', () => {
    const input = { ...ranking(), anonymous_ids: [0, 1] };
    expect(seededAnonymousIds(input)).toEqual([0, 1]);
    expect(declaredAnonymousIds(input)).toEqual([0, 1]);
  });

  it('lets a declaration add, and never subtract', () => {
    // `products_seeded_is_anonymous` refuses a named seeded row, so a JSON file
    // on disk is not where one gets opted back into being named.
    expect(seededAnonymousIds({ ...ranking(), anonymous_ids: [] })).toEqual([0, 1]);
    expect(seededAnonymousIds({ ...ranking(), anonymous_ids: [1] })).toEqual([0, 1]);
  });

  it('treats a malformed declaration as no declaration', () => {
    // This reads a file the process did not write. A string or a `null` must not
    // become an engine id that matches nothing.
    expect(declaredAnonymousIds({ anonymous_ids: 'all' })).toBeUndefined();
    expect(declaredAnonymousIds({ anonymous_ids: [1, null] })).toBeUndefined();
    expect(declaredAnonymousIds({})).toBeUndefined();
    expect(seededAnonymousIds({ ...ranking(), anonymous_ids: 'all' })).toEqual([0, 1]);
  });
});
