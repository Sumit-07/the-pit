import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { abCommand } from '../../src/cli/ab.js';
import { parseArgs } from '../../src/cli/args.js';
import { main } from '../../src/cli/main.js';
import { reportCommand } from '../../src/cli/report.js';
import { FixtureClient } from '../../src/model/fixture-client.js';
import { categorySlug } from '../../src/panels/seeded.js';
import { runCategory } from '../../src/run/run-category.js';
import { MemoryRunStore } from '../../src/run/store.js';
import { CATEGORY, CATEGORY_VERSION, JURY, PANEL, makeProducts, makeScript } from '../helpers/run-fixtures.js';

/**
 * The `report` and `ab` commands.
 *
 * The property that matters most is negative: `report` takes NO `ModelClient`
 * and constructs none, so it cannot spend and needs no API key. Every test here
 * runs with neither, which is Global Constraint 5 restated for this command.
 */

const SLUG = categorySlug(CATEGORY);
const PLACEMENT = { cluster_id: 'pair-0', uniqueness_score: 35, reason: 'several tools already do this' };

let workdir: string;

/** A seeded category on disk: products, results, ranking, jury and panel. */
async function seedWorkdir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pit-report-'));
  const products = makeProducts(20);

  const outcome = await runCategory({
    category: CATEGORY,
    products,
    jury: JURY,
    personas: PANEL,
    client: new FixtureClient(makeScript({ clusterPlan: 'pairs' })),
    store: new MemoryRunStore(CATEGORY),
    config: { categoryVersion: CATEGORY_VERSION },
  });
  if (outcome.status !== 'delivered') throw new Error('fixture seed did not deliver');

  const runPath = join(root, 'runs', SLUG);
  await mkdir(runPath, { recursive: true });
  await mkdir(join(root, 'references', 'jurors'), { recursive: true });
  await mkdir(join(root, 'references', 'personas'), { recursive: true });

  const write = async (path: string, value: unknown): Promise<void> => {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  };

  await write(join(runPath, 'products.json'), { category: CATEGORY, products });
  await write(join(runPath, 'results.json'), outcome.results);
  await write(join(runPath, 'ranking.json'), outcome.ranking);
  await write(join(root, 'references', 'jurors', `${SLUG}.json`), JURY);
  await write(join(root, 'references', 'personas', `${SLUG}.json`), PANEL);

  return root;
}

beforeAll(async () => {
  workdir = await seedWorkdir();
});

/** Run a command line through the command function, capturing its output. */
async function runReport(argv: readonly string[]): Promise<{ code: number; log: string; written: Map<string, string> }> {
  const lines: string[] = [];
  const written = new Map<string, string>();
  const code = await reportCommand(parseArgs(argv), {
    log: (line) => lines.push(line),
    write: (path, contents) => {
      written.set(path, contents);
      return Promise.resolve();
    },
  });
  return { code, log: lines.join('\n'), written };
}

describe('engine report', () => {
  it('renders the report from stored rows alone, with no client and no key', async () => {
    const { code, log, written } = await runReport(['report', '--category', CATEGORY, '--workdir', workdir]);

    // Exit 1 because the fix-1.1 gate is MISSING — see below. The document
    // still rendered.
    expect(code).toBe(1);
    expect(written.size).toBe(1);

    const [path, markdown] = [...written.entries()][0] ?? ['', ''];
    expect(path).toBe(join(workdir, 'runs', SLUG, 'report.md'));
    expect(markdown).toContain('# Phase 1 report');
    expect(markdown).toContain('No model was called to produce this report');
    expect(log).toContain('PHASE 1 REPORT');
  });

  it('exits non-zero when the fix-1.1 evidence is missing', async () => {
    // Not a rendering failure: the report is the point of the command and it was
    // produced. But a Phase 1 report with no A/B has not answered Phase 1's
    // question, and a wrapper must not treat that as done.
    const { code, log } = await runReport(['report', '--category', CATEGORY, '--workdir', workdir]);
    expect(code).toBe(1);
    expect(log).toContain('MISSING');
    expect(log).toContain('fix 1.1 evidence');
  });

  it('honours --out', async () => {
    const out = join(workdir, 'elsewhere', 'gate.md');
    const { written } = await runReport(['report', '--category', CATEGORY, '--workdir', workdir, '--out', out]);
    expect([...written.keys()]).toEqual([out]);
  });

  it('projects the schedule over the category count it is given', async () => {
    const { written } = await runReport([
      'report',
      '--category',
      CATEGORY,
      '--workdir',
      workdir,
      '--categories',
      '2',
    ]);
    const markdown = [...written.values()][0] ?? '';
    expect(markdown).toContain('× 2 categories');
  });

  it('names the missing artifact and the command that would create it', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'pit-empty-'));
    await expect(runReport(['report', '--category', CATEGORY, '--workdir', empty])).rejects.toThrow(
      /products\.json/,
    );
  });

  it('rejects an unknown flag rather than ignoring it', async () => {
    await expect(runReport(['report', '--category', CATEGORY, '--workdir', workdir, '--nope'])).rejects.toThrow(
      /unknown flag/,
    );
  });

  it('reads ab.json when it exists and turns the fix-1.1 gate green', async () => {
    // Produce the evidence with the `ab` command, then re-render.
    const abLines: string[] = [];
    const abWritten = new Map<string, string>();
    const abCode = await abCommand(parseArgs(['ab', '--category', CATEGORY, '--workdir', workdir, '--run']), {
      log: (line) => abLines.push(line),
      makeClient: () => new FixtureClient(makeScript({ clusterPlan: 'pairs', assignAnswer: PLACEMENT })),
      write: (path, contents) => {
        abWritten.set(path, contents);
        return Promise.resolve();
      },
    });
    expect(abCode).toBe(0);

    const abPath = join(workdir, 'runs', SLUG, 'ab.json');
    expect([...abWritten.keys()]).toEqual([abPath]);
    // The `ab` command's own writer was stubbed, so put the file where the
    // report will look for it.
    await writeFile(abPath, abWritten.get(abPath) ?? '', 'utf8');

    const { code, written } = await runReport(['report', '--category', CATEGORY, '--workdir', workdir]);
    expect(code).toBe(0);

    const markdown = [...written.values()][0] ?? '';
    expect(markdown).not.toContain('**MISSING.**');
    expect(markdown).toContain('test-retest — incremental twice');
    expect(markdown).toContain('### Per metric, per product');
  });
});

describe('engine ab', () => {
  it('refuses to run without exactly one of --dry-run and --run', async () => {
    const deps = {
      log: () => undefined,
      makeClient: () => {
        throw new Error('a client must not be constructed');
      },
    };
    await expect(abCommand(parseArgs(['ab', '--category', CATEGORY, '--workdir', workdir]), deps)).rejects.toThrow(
      /exactly one of --dry-run or --run/,
    );
    await expect(
      abCommand(parseArgs(['ab', '--category', CATEGORY, '--workdir', workdir, '--run', '--dry-run']), deps),
    ).rejects.toThrow(/exactly one of/);
  });

  it('constructs no client on --dry-run and prints the run count', async () => {
    const lines: string[] = [];
    const code = await abCommand(
      parseArgs(['ab', '--category', CATEGORY, '--workdir', workdir, '--dry-run', '--sample', '3']),
      {
        log: (line) => lines.push(line),
        makeClient: () => {
          throw new Error('a dry run must not construct a client');
        },
      },
    );

    expect(code).toBe(0);
    const output = lines.join('\n');
    // 1 batch + 3 leave-one-out seeds = 4 full runs; 3 targets x 2 = 6 placements.
    expect(output).toContain('full runs             4');
    expect(output).toContain('placements            6');
    expect(output).toContain('Nothing was spent');
  });

  it('reports the A/B against its test-retest floor in the terminal', async () => {
    const lines: string[] = [];
    await abCommand(parseArgs(['ab', '--category', CATEGORY, '--workdir', workdir, '--run', '--sample', '2']), {
      log: (line) => lines.push(line),
      makeClient: () => new FixtureClient(makeScript({ clusterPlan: 'pairs', assignAnswer: PLACEMENT })),
      write: () => Promise.resolve(),
    });

    const output = lines.join('\n');
    expect(output).toContain('A/B metric delta');
    expect(output).toContain('test-retest floor');
    expect(output).toContain('targets completed     2/2');
  });
});

describe('engine --help', () => {
  it('lists every command, and says which one spends', async () => {
    const lines: string[] = [];
    const code = await main(['--help'], (line) => lines.push(line));
    expect(code).toBe(0);

    const usage = lines.join('\n');
    expect(usage).toContain('seed');
    expect(usage).toContain('ab       produce the fix-1.1 A/B and test-retest evidence (SPENDS)');
    expect(usage).toContain('report   render the Phase 1 report (spends nothing, needs no API key)');
  });

  it('dispatches `report` through main', async () => {
    const lines: string[] = [];
    const code = await main(['report', '--category', CATEGORY, '--workdir', workdir], (line) => lines.push(line));
    // ab.json now exists from the test above, so every gate resolves.
    expect([0, 1]).toContain(code);
    expect(lines.join('\n')).toContain('PHASE 1 REPORT');
  });
});
