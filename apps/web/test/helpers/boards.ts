/**
 * A hand-built `ranking.json` for the board tests, and the scratch workdir that
 * holds it.
 *
 * Every number in `sampleRanking()` was chosen so the expected output can be
 * derived by hand rather than by running the code and writing down what came out:
 *
 * | product   | metric scores | mean | cuts | heaviest cut |
 * |-----------|---------------|------|------|--------------|
 * | Ashgrove  | 60, 90        | 75   | 25   | 40, The Seed Investor |
 * | (hostile) | 50            | 50   | 50   | 50, The Terminal Minimalist |
 * | Runlet    | 3             | 3    | 97   | 97, The Weekend Shipper |
 *
 * Runlet's 97 is `brief` Part 5's own example — "Runlet took 97 in cuts" — so the
 * register the copy fixes is the register the fixture exercises.
 *
 * The second product's name and URL are hostile on purpose. Product names and
 * descriptions are user-submitted (`brief §2.5`, and `01 §8`'s injection alarm
 * exists because juror reasons quote them), so a board that did not escape them
 * would be a stored-XSS hole on the one surface that is public, cached and
 * indexed.
 */

import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Ranking } from '@the-pit/engine';

/** A product name a submitter could actually type, and a URL that must never become an href. */
export const HOSTILE_NAME = '<script>alert("pit")</script> & "quotes" \'n\' <img src=x onerror=alert(1)>';
export const HOSTILE_URL = 'javascript:alert(document.domain)';

export function sampleRanking(overrides: Partial<Ranking> = {}): Ranking {
  const ranking: Ranking = {
    category: 'Developer Tools',
    prompt_version: 'v2',
    uniqueness_version: 'v2',
    demand_version: 'v1',
    type: 'b2b',
    weights: { merit: 0.65, demand: 0.35, uniqueness_lambda: 0.075 },
    personas: [
      { name: 'Priya Raghunathan', description: 'fintech platform lead', needs: ['audit'], price_sensitivity: 'low' },
      { name: 'Deniz Aksoy', description: 'solo shipper', needs: ['cheap'], price_sensitivity: 'high' },
    ],
    metrics: [
      { name: 'Problem Sharpness', description: 'names the moment' },
      { name: 'Workflow Fit', description: 'fits the day' },
    ],
    clusters: [
      { cluster_id: 'c1-ota', label: 'Over-the-air updates', size: 2 },
      { cluster_id: 'c2-push', label: 'EU-hosted mobile push', size: 1 },
    ],
    health: {
      avg_metric_spread: 6.24209899626309,
      discrimination: 0.7364984101069441,
      demand_discrimination: 0.27910845166972714,
      tiebreak_count: 1,
    },
    flaggedInjections: [
      {
        source: 'The Terminal Minimalist',
        reason: "'describe it, get a site' is a prompt-wrapper.",
        matched: 'prompt',
        product_id: 3,
      },
    ],
    ranking: [
      {
        id: 1,
        name: 'Ashgrove',
        url: 'https://ashgrove.example/',
        rank: 1,
        composite: 1.4540742115251797,
        demand: 0.775,
        demand_status: 'scored',
        core: 1.763082651777721,
        tiebroken: false,
        scorecard: [
          {
            // Listed second-heaviest first, so a test can tell a sorted ledger
            // from an unsorted one.
            metric: 'Workflow Fit',
            score: 90,
            spread: 4,
            juror_count: 6,
            substituted_roles: [],
            deductions: [
              { points: 10, reason: 'Integration mechanism is never named.', role: 'The Docs Writer' },
            ],
          },
          {
            metric: 'Problem Sharpness',
            score: 60,
            spread: 8,
            juror_count: 6,
            substituted_roles: [],
            deductions: [
              { points: 20, reason: 'Names a category, not a moment.', role: 'The Release Engineer' },
              { points: 40, reason: 'No trigger event anywhere in the pitch.', role: 'The Seed Investor' },
            ],
          },
        ],
        cluster: {
          id: 'c1-ota',
          label: 'Over-the-air updates',
          size: 2,
          uniqueness: 40,
          reason: 'A small niche with one direct peer.',
        },
        demand_detail: {
          demand: 0.775,
          breadth: 0.625,
          intensity: 0.875,
          capture: 0.8333333333333334,
          share: 0.75,
          picks: [
            { persona: 'Priya Raghunathan', pick: 'first', strength: 55, reason: 'Auditable, and it skips review.' },
            { persona: 'Deniz Aksoy', pick: 'second', reason: 'Cheaper substitute already in my stack.' },
          ],
        },
      },
      {
        id: 2,
        name: HOSTILE_NAME,
        url: HOSTILE_URL,
        rank: 2,
        composite: 0.4,
        demand_status: 'solo_cluster',
        core: 0.4,
        tiebroken: true,
        scorecard: [
          {
            metric: 'Problem Sharpness',
            score: 50,
            spread: 0,
            juror_count: 6,
            substituted_roles: ['The Docs Writer'],
            deductions: [
              { points: 50, reason: 'Nothing here but a name.', role: 'The Terminal Minimalist' },
            ],
          },
        ],
        cluster: {
          id: 'c2-push',
          label: 'EU-hosted mobile push',
          size: 1,
          uniqueness: 30,
          reason: 'Established category, narrower hosting angle.',
        },
      },
      {
        id: 3,
        name: 'Runlet',
        url: 'https://runlet.example/',
        rank: 3,
        composite: -1.2,
        demand: 0.05,
        demand_status: 'scored',
        core: -1.3,
        tiebroken: false,
        scorecard: [
          {
            metric: 'Problem Sharpness',
            score: 3,
            spread: 1,
            juror_count: 6,
            substituted_roles: [],
            deductions: [
              { points: 97, reason: 'Cron with a graph is a feature, not a product.', role: 'The Weekend Shipper' },
            ],
          },
        ],
        cluster: {
          id: 'c1-ota',
          label: 'Over-the-air updates',
          size: 2,
          uniqueness: 40,
          reason: 'A small niche with one direct peer.',
        },
        demand_detail: { demand: 0.05, breadth: 0.1, intensity: 0.05, capture: 0, share: 0.1, picks: [] },
      },
    ],
  };
  return { ...ranking, ...overrides };
}

export const SAMPLE_CAVEAT =
  'Locally-seeded scores come from Claude Code subagents. ABSOLUTE SCORE LEVELS DO NOT TRANSFER TO PRODUCTION.';

/** A throwaway `cjr/`-shaped directory holding one seeded run. */
export async function writeSeededWorkdir(options: {
  slug: string;
  ranking?: Ranking;
  results?: unknown;
}): Promise<string> {
  const workdir = await mkdtemp(join(tmpdir(), 'pit-boards-'));
  const dir = join(workdir, 'runs', options.slug);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'ranking.json'), JSON.stringify(options.ranking ?? sampleRanking()), 'utf8');
  await writeFile(
    join(dir, 'results.json'),
    JSON.stringify(
      options.results ?? {
        meta: {
          engine_version: '0.1.0-test',
          category_version: 'v2',
          seeding: { caveat: SAMPLE_CAVEAT },
        },
      },
    ),
    'utf8',
  );
  return workdir;
}

/** Write a published snapshot into a workdir's `public/boards/`. */
export async function writePublishedSnapshot(
  workdir: string,
  snapshot: { slug: string; category: string; generated_at: string; product_count: number; ranking: Ranking },
): Promise<void> {
  const dir = join(workdir, 'public', 'boards');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${snapshot.slug}.json`),
    JSON.stringify({
      snapshot_version: 1,
      engine_version: '0.1.0-published',
      category_version: 'v9',
      ...snapshot,
    }),
    'utf8',
  );
}

/** Strip tags and decode the entities React emits, so a test can assert on prose. */
export function textOf(html: string): string {
  return html
    .replaceAll(/<[^>]*>/g, ' ')
    .replaceAll('&#x27;', "'")
    .replaceAll('&quot;', '"')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&middot;', '·')
    .replaceAll('&minus;', '−')
    .replaceAll('&mdash;', '—')
    .replaceAll('&rsquo;', '’')
    .replaceAll(/\s+/g, ' ')
    // Stripping an inline `<b>100</b>` leaves a space before the sentence's full
    // stop. Normalising it is what lets a test compare against the brief's prose.
    .replaceAll(/\s+([.,;:!?])/g, '$1')
    .trim();
}
