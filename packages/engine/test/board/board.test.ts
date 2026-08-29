import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

import { describe, expect, it } from 'vitest';

import { toBoard } from '../../src/board/model.js';
import { renderPage } from '../../src/board/page.js';
import { loadBoards, startBoardServer } from '../../src/board/serve.js';
import type { Ranking } from '../../src/types.js';

/**
 * `engine board` — the local preview surface (`brief` Part 6).
 *
 * The assertions here are about the two things a preview can get wrong in a way
 * nobody notices: it can quietly omit a board, and it can quietly show a stale
 * one. So the tests pin what happens to an unrankable category (omitted, never
 * fatal), what the derived numbers mean, and that the honesty block — the health
 * numbers and the seeding caveat — actually reaches the page.
 */

function ranking(overrides: Partial<Ranking> = {}): Ranking {
  return {
    category: 'Developer Tools',
    prompt_version: 'v2',
    uniqueness_version: 'v2',
    demand_version: 'v1',
    type: 'b2b',
    weights: { merit: 0.65, demand: 0.35, uniqueness_lambda: 0.075 },
    personas: [{ name: 'Priya', description: 'd', needs: ['n'], price_sensitivity: 'low' }],
    metrics: [{ name: 'Problem Sharpness', description: 'd' }],
    clusters: [{ cluster_id: 'c1', label: 'OTA', size: 2 }],
    health: {
      avg_metric_spread: 6.24,
      discrimination: 0.7365,
      demand_discrimination: 0.2791,
      tiebreak_count: 1,
    },
    flaggedInjections: [{ source: 'The Docs Writer', reason: 'ignore previous', matched: 'ignore', product_id: 1 }],
    ranking: [
      {
        id: 1,
        name: 'Capgo',
        url: 'https://capgo.app/',
        rank: 1,
        composite: 1.45,
        core: 1.76,
        demand: 0.775,
        demand_status: 'scored',
        tiebroken: false,
        cluster: { id: 'c1', label: 'OTA', size: 2, uniqueness: 40, reason: 'small niche' },
        demand_detail: {
          demand: 0.775,
          breadth: 0.625,
          intensity: 0.875,
          capture: 0.833,
          share: 0.75,
          picks: [{ persona: 'Priya', pick: 'first', strength: 55, reason: 'open source' }],
        },
        scorecard: [
          {
            metric: 'Problem Sharpness',
            score: 60,
            spread: 13.4,
            juror_count: 6,
            substituted_roles: [],
            deductions: [
              { points: 20, reason: 'small cut', role: 'The Docs Writer' },
              { points: 50, reason: 'the heaviest cut', role: 'The Seed Investor' },
            ],
          },
          {
            metric: 'Durability',
            score: 80,
            spread: 2.7,
            juror_count: 6,
            substituted_roles: ['The Docs Writer'],
            deductions: [{ points: 20, reason: 'a durability cut', role: 'The Platform Owner' }],
          },
        ],
      },
      {
        id: 2,
        name: 'Carillon',
        url: 'https://carillon.example/',
        rank: 2,
        composite: 1.12,
        core: 1.52,
        demand_status: 'solo_cluster',
        tiebroken: true,
        cluster: { id: 'c2', label: 'push', size: 1, uniqueness: 30, reason: 'narrow' },
        scorecard: [
          {
            metric: 'Problem Sharpness',
            score: 74,
            spread: 5,
            juror_count: 6,
            substituted_roles: [],
            deductions: [{ points: 45, reason: 'a category, not a moment', role: 'The Terminal Minimalist' }],
          },
        ],
      },
    ],
    ...overrides,
  };
}

async function workdir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'the-pit-board-'));
}

describe('toBoard — the derived numbers', () => {
  const board = toBoard('developer-tools', ranking(), { rankedAt: '2026-08-29T20:55:00.000Z', caveat: 'local subagents' });

  it('states cuts as 100 minus the mean metric score, not the sum of the ledger', () => {
    // Row 1's ledger sums to 90 points across two metrics; its cuts are 30,
    // because six jurors cutting for the same omission is one cut on the board.
    expect(board.rows[0]?.cuts).toBeCloseTo(30, 10);
    expect(board.rows[1]?.cuts).toBeCloseTo(26, 10);
  });

  it('leads each row with the heaviest single deduction and the juror who took it', () => {
    expect(board.rows[0]?.headline).toEqual({
      points: 50,
      reason: 'the heaviest cut',
      role: 'The Seed Investor',
      metric: 'Problem Sharpness',
    });
  });

  it('orders the ledger by what the metric cost, heaviest first', () => {
    expect(board.rows[0]?.metrics.map((metric) => metric.metric)).toEqual(['Problem Sharpness', 'Durability']);
    expect(board.rows[0]?.metrics[0]?.cuts).toBe(40);
  });

  it('marks solo clusters and tiebroken rows, and counts them', () => {
    expect(board.rows[0]?.soloCluster).toBe(false);
    expect(board.rows[1]?.soloCluster).toBe(true);
    expect(board.rows[1]?.demand).toBeUndefined();
    expect(board.soloCount).toBe(1);
    expect(board.tiebrokenCount).toBe(1);
  });

  it('attaches injection flags to the product they were logged against', () => {
    expect(board.rows[0]?.flagged).toHaveLength(1);
    expect(board.rows[1]?.flagged).toHaveLength(0);
  });

  it('keeps the disclosure that a juror did not answer', () => {
    expect(board.rows[0]?.metrics[1]?.substituted).toEqual(['The Docs Writer']);
  });
});

describe('loadBoards — a category with no ranking is omitted, never fatal', () => {
  it('skips an unranked and a malformed category and keeps the readable one', async () => {
    const root = await workdir();
    await mkdir(join(root, 'runs', 'unranked'), { recursive: true });
    await mkdir(join(root, 'runs', 'malformed'), { recursive: true });
    await mkdir(join(root, 'runs', 'good'), { recursive: true });
    await writeFile(join(root, 'runs', 'unranked', 'products.json'), '{"products":[]}');
    await writeFile(join(root, 'runs', 'malformed', 'ranking.json'), '{ not json');
    await writeFile(join(root, 'runs', 'good', 'ranking.json'), JSON.stringify(ranking()));

    const { payload, skipped } = await loadBoards(root);
    expect(payload.boards.map((board) => board.slug)).toEqual(['good']);
    expect(skipped.sort()).toEqual(['malformed', 'unranked']);
  });

  it('returns no boards rather than throwing when there is no runs directory', async () => {
    const { payload } = await loadBoards(join(await workdir(), 'nowhere'));
    expect(payload.boards).toEqual([]);
  });

  it('carries the seeding caveat off results.json, and says so when there is none', async () => {
    const root = await workdir();
    await mkdir(join(root, 'runs', 'a'), { recursive: true });
    await mkdir(join(root, 'runs', 'b'), { recursive: true });
    await writeFile(join(root, 'runs', 'a', 'ranking.json'), JSON.stringify(ranking()));
    await writeFile(
      join(root, 'runs', 'a', 'results.json'),
      JSON.stringify({ meta: { seeding: { path: 'local_subagent', caveat: 'DOES NOT TRANSFER' } } }),
    );
    await writeFile(join(root, 'runs', 'b', 'ranking.json'), JSON.stringify(ranking()));

    const { payload } = await loadBoards(root);
    expect(payload.boards[0]?.caveat).toBe('DOES NOT TRANSFER');
    expect(payload.boards[1]?.caveat).toBeUndefined();
  });
});

describe('renderPage — one self-contained document', () => {
  it('pulls in no font, script or stylesheet from anywhere', () => {
    const html = renderPage({ boards: [toBoard('dt', ranking(), { rankedAt: 'x' })], readAt: 'y' });
    expect(html).not.toContain('<link');
    expect(html).not.toContain('src="http');
    expect(html).not.toContain('//fonts.');
  });

  it('cannot be broken out of by a juror reason containing a script tag', () => {
    const hostile = ranking();
    hostile.ranking[0]!.scorecard[0]!.deductions[0]!.reason = '</script><script>alert(1)</script>';
    const html = renderPage({ boards: [toBoard('dt', hostile, { rankedAt: 'x' })], readAt: 'y' });
    // Two script tags of our own, and no third opened by the data.
    expect(html.match(/<script/g)).toHaveLength(2);
    expect(html).toContain('\\u003c/script>');
  });

  it('renders an empty state instead of a broken board when nothing is ranked', () => {
    expect(renderPage({ boards: [], readAt: 'y' })).toContain('No ranking.json was found');
  });
});

describe('the server', () => {
  it('serves the board at /, the payload at /board.json, and nothing else', async () => {
    const root = await workdir();
    await mkdir(join(root, 'runs', 'good'), { recursive: true });
    await writeFile(join(root, 'runs', 'good', 'ranking.json'), JSON.stringify(ranking()));

    const server = await startBoardServer({ workdir: root, port: 0 });
    const { port } = server.address() as AddressInfo;
    try {
      const page = await fetch(`http://127.0.0.1:${port}/`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('Capgo');
      expect(html).toContain('the heaviest cut');

      const json = await fetch(`http://127.0.0.1:${port}/board.json`);
      expect(json.status).toBe(200);
      expect(((await json.json()) as { boards: unknown[] }).boards).toHaveLength(1);

      expect((await fetch(`http://127.0.0.1:${port}/elsewhere`)).status).toBe(404);
      expect((await fetch(`http://127.0.0.1:${port}/`, { method: 'POST' })).status).toBe(405);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('re-reads ranking.json on every request, so a re-rank needs no restart', async () => {
    const root = await workdir();
    await mkdir(join(root, 'runs', 'good'), { recursive: true });
    const path = join(root, 'runs', 'good', 'ranking.json');
    await writeFile(path, JSON.stringify(ranking()));

    const server = await startBoardServer({ workdir: root, port: 0 });
    const { port } = server.address() as AddressInfo;
    try {
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toContain('Capgo');

      const rebuilt = ranking();
      rebuilt.ranking[0]!.name = 'Reranked';
      await writeFile(path, JSON.stringify(rebuilt));

      const after = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      expect(after).toContain('Reranked');
      expect(after).not.toContain('"name":"Capgo"');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
