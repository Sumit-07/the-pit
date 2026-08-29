/**
 * Fixtures for the verdict page.
 *
 * Two sources, deliberately:
 *
 * 1. **The real seeded boards.** `loadSeedInput` + `buildSeedRows` are
 *    `@the-pit/db`'s own code, run over the committed `cjr/runs/<slug>/ranking.json`.
 *    The frozen payloads they produce are the ones a seed would insert, so the
 *    parser is checked against the real freezer rather than against a hand-typed
 *    guess at its shape. No database, no network — both functions are pure over
 *    files.
 * 2. **A hand-built row.** For the cases the real data cannot supply: a hostile
 *    product name, a payload that contradicts its own column, a card with nothing
 *    cut off it.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSeedRows, loadSeedInput } from '@the-pit/db';

import type { StoredVerdict } from '@/lib/verdict/store';

/** `cjr/` at the repository root; the suite's cwd is `apps/web`. */
export const WORKDIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'cjr');

/** A fixed instant, so every stamp in these tests is a hand-derived string. */
export const ISSUED_AT = new Date('2026-08-27T14:03:00.000Z');

const cache = new Map<string, Promise<StoredVerdict[]>>();

/**
 * Every frozen verdict row for one seeded board, stamped at `ISSUED_AT`.
 *
 * The stamp is overridden because `buildSeedRows` uses `new Date()`: a test that
 * asserted on the delivery timestamp would otherwise assert on the clock.
 */
export function seededVerdicts(slug: string): Promise<StoredVerdict[]> {
  const existing = cache.get(slug);
  if (existing !== undefined) return existing;

  const rows = loadSeedInput(slug, WORKDIR).then((input) =>
    buildSeedRows(input).verdicts.map((row) => ({
      publicSlug: row.publicSlug,
      payload: row.payload,
      productCount: row.productCount,
      attemptNumber: row.attemptNumber ?? null,
      deliveredAt: ISSUED_AT,
    })),
  );
  cache.set(slug, rows);
  return rows;
}

/** The frozen row for one product, by the name it was submitted under. */
export async function seededVerdictNamed(slug: string, startsWith: string): Promise<StoredVerdict> {
  const rows = await seededVerdicts(slug);
  const found = rows.find((row) => {
    const payload = row.payload as { verdict?: { name?: unknown } };
    return typeof payload.verdict?.name === 'string' && payload.verdict.name.startsWith(startsWith);
  });
  if (found === undefined) throw new Error(`no seeded verdict in ${slug} whose name starts with ${startsWith}`);
  return found;
}

/** A payload built by hand, in the shape `packages/db/src/seed/build.ts` freezes. */
export interface HandBuilt {
  name?: string;
  url?: string;
  category?: string;
  rank?: number;
  productCount?: number;
  attemptNumber?: number | null;
  deliveredAt?: Date;
  demandStatus?: 'scored' | 'solo_cluster';
  clusterSize?: number;
  clusterLabel?: string;
  scorecard?: unknown[];
  picks?: unknown[];
  /** Overrides `product_count` INSIDE the payload only. Used to force a disagreement. */
  payloadProductCount?: number;
}

export function handBuiltVerdict(overrides: HandBuilt = {}): StoredVerdict {
  const productCount = overrides.productCount ?? 48;
  const demandStatus = overrides.demandStatus ?? 'solo_cluster';
  const clusterSize = overrides.clusterSize ?? (demandStatus === 'solo_cluster' ? 1 : 4);

  const scorecard = overrides.scorecard ?? [
    {
      metric: 'Trust Surface',
      score: 60,
      spread: 10,
      juror_count: 6,
      substituted_roles: [],
      deductions: [
        { points: 50, reason: 'No stated data handling or failure mode.', role: 'The Release Engineer' },
        { points: 20, reason: 'Plain files I can read is a real signal.', role: 'The Weekend Shipper' },
      ],
    },
    {
      metric: 'Workflow Fit',
      score: 80,
      spread: 4,
      juror_count: 6,
      substituted_roles: ['The Docs Writer'],
      deductions: [{ points: 30, reason: 'No SDK or CLI surface is named.', role: 'The Seed Investor' }],
    },
  ];

  return {
    publicSlug: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    productCount,
    attemptNumber: overrides.attemptNumber === undefined ? 3 : overrides.attemptNumber,
    deliveredAt: overrides.deliveredAt ?? ISSUED_AT,
    payload: {
      category: overrides.category ?? 'Developer Tools',
      category_type: 'b2b',
      product_count: overrides.payloadProductCount ?? productCount,
      issued_at: ISSUED_AT.toISOString(),
      category_snapshot_version: 'seed-1',
      prompt_version: 'v2',
      persona_version: 'v1',
      uniqueness_version: 'v2',
      weights: { merit: 0.65, demand: 0.35, uniqueness_lambda: 0.075 },
      metrics: [{ name: 'Trust Surface', description: 'proof, not promises' }],
      verdict: {
        id: 31,
        name: overrides.name ?? 'Runlet',
        url: overrides.url ?? 'https://runlet.dev/',
        rank: overrides.rank ?? 7,
        composite: 0.86,
        core: 1.07,
        demand_status: demandStatus,
        tiebroken: false,
        scorecard,
        cluster: {
          id: 'c-1',
          label: overrides.clusterLabel ?? 'Scheduled job runners',
          size: clusterSize,
          uniqueness: 72,
          reason: 'Runs work on a schedule and reports what happened.',
        },
        ...(demandStatus === 'solo_cluster'
          ? {}
          : {
              demand: 0.41,
              demand_detail: {
                demand: 0.41,
                breadth: 0.33,
                intensity: 0.62,
                capture: 0.5,
                share: 0.25,
                picks: overrides.picks ?? [
                  {
                    persona: 'Priya Raghunathan',
                    pick: 'first',
                    strength: 88,
                    reason: 'Only one that does not need me to touch CI config.',
                  },
                  { persona: 'Marco Devlin', pick: 'second', reason: 'Would pick it if the audit log were there.' },
                ],
              },
            }),
      },
    },
  };
}
