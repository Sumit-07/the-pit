import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import { JUROR_COUNT } from '../../src/config/constants.js';
import { boolFlag, intFlag, parseArgs, rejectUnknownFlags, requireFlag, UsageError } from '../../src/cli/args.js';
import { seedCommand } from '../../src/cli/seed.js';
import { FixtureClient } from '../../src/model/fixture-client.js';
import { ModelCallError } from '../../src/model/types.js';
import { FileRunStore } from '../../src/run/store.js';
import type { RunResults } from '../../src/run/types.js';
import { CATEGORY, JURY, makeProducts, makeScript, PANEL } from '../helpers/run-fixtures.js';

/**
 * The CLI. `--dry-run` versus `--run` is `01 §4` Step 4's approval gate, so the
 * flags are tested for what they REFUSE as much as for what they do: a CLI that
 * defaulted to spending would have turned a gate into a typo.
 */

const SLUG = 'health-fitness-wellness';

/** A workdir laid out exactly as `01 §3` describes, ready for `seed`. */
async function makeWorkdir(products = 10): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'the-pit-cli-'));
  await mkdir(join(root, 'runs', SLUG), { recursive: true });
  await mkdir(join(root, 'references', 'jurors'), { recursive: true });
  await mkdir(join(root, 'references', 'personas'), { recursive: true });

  await writeFile(
    join(root, 'runs', SLUG, 'products.json'),
    JSON.stringify({ category: CATEGORY, products: makeProducts(products) }),
  );
  await writeFile(join(root, 'references', 'jurors', `${SLUG}.json`), JSON.stringify(JURY));
  await writeFile(join(root, 'references', 'personas', `${SLUG}.json`), JSON.stringify(PANEL));
  return root;
}

/**
 * A source workbook in the shape `01 §4` Step 1 reads: sheet `All Products`,
 * with the five columns ingest uses. Written once per test that needs the
 * `--xlsx` path, so the `products.json` write can be observed for real rather
 * than stubbed.
 */
async function makeWorkbook(root: string, count: number): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('All Products');
  sheet.addRow([
    'Category',
    'Rank',
    'Website',
    'Product Name',
    'Description',
    'Desc. Source',
    'Price (USD)',
    'Clicks',
    'Website URL',
    'outbid.lol Page',
  ]);
  for (let rank = 1; rank <= count; rank += 1) {
    sheet.addRow([
      CATEGORY,
      String(rank),
      'example.com',
      `Product ${rank}`,
      `A tool that does thing ${rank} for people who are tired of spreadsheets.`,
      'fixture',
      '0',
      '0',
      `https://www.example.com/p/${rank}`,
      'https://outbid.lol/product/example',
    ]);
  }

  const path = join(root, 'source.xlsx');
  await workbook.xlsx.writeFile(path);
  return path;
}

function capture(): { log: (line: string) => void; text: () => string } {
  const lines: string[] = [];
  return { log: (line) => lines.push(line), text: () => lines.join('\n') };
}

const refuseToSpend = (): never => {
  throw new Error('a dry run must never construct a client');
};

describe('parseArgs', () => {
  it('parses --flag value, --flag=value and boolean flags', () => {
    const args = parseArgs(['seed', '--category', 'Developer Tools', '--workdir=out', '--dry-run']);
    expect(args.command).toBe('seed');
    expect(args.flags.get('category')).toBe('Developer Tools');
    expect(args.flags.get('workdir')).toBe('out');
    expect(args.flags.get('dry-run')).toBe(true);
  });

  it('does not let a boolean flag swallow the next flag', () => {
    const args = parseArgs(['seed', '--dry-run', '--category', 'X']);
    expect(args.flags.get('dry-run')).toBe(true);
    expect(args.flags.get('category')).toBe('X');
  });

  it('refuses a bare flag with no command', () => {
    expect(() => parseArgs(['--category', 'X'])).toThrow(UsageError);
    expect(() => parseArgs([])).toThrow(UsageError);
  });

  it('rejects an unknown flag instead of ignoring it', () => {
    const args = parseArgs(['seed', '--dryrun']);
    expect(() => rejectUnknownFlags(args, ['dry-run', 'run'])).toThrow(/--dryrun/);
  });

  it('requires a value where one is required', () => {
    expect(() => requireFlag(parseArgs(['seed', '--category']), 'category')).toThrow(UsageError);
  });

  it('rejects a non-integer chunk size rather than rounding it', () => {
    expect(() => intFlag(parseArgs(['seed', '--chunk-size', '12.5']), 'chunk-size')).toThrow(UsageError);
    expect(() => intFlag(parseArgs(['seed', '--chunk-size', '0']), 'chunk-size')).toThrow(UsageError);
    expect(intFlag(parseArgs(['seed', '--chunk-size', '25']), 'chunk-size')).toBe(25);
  });

  it('reads a boolean flag written either way', () => {
    expect(boolFlag(parseArgs(['seed', '--run']), 'run')).toBe(true);
    expect(boolFlag(parseArgs(['seed', '--run=true']), 'run')).toBe(true);
    expect(boolFlag(parseArgs(['seed']), 'run')).toBe(false);
  });
});

describe('seed --dry-run (01 §4 Step 4, APPROVAL GATE 3)', () => {
  it('prints the projection and never constructs a client', async () => {
    const workdir = await makeWorkdir();
    const out = capture();

    const code = await seedCommand(parseArgs(['seed', '--category', CATEGORY, '--workdir', workdir, '--dry-run']), {
      log: out.log,
      makeClient: refuseToSpend,
    });

    expect(code).toBe(0);
    expect(out.text()).toContain('DRY RUN');
    expect(out.text()).toContain('PROJECTED CALLS');
    expect(out.text()).toContain('Nothing was spent.');
  });

  it('writes nothing', async () => {
    const workdir = await makeWorkdir();
    await seedCommand(parseArgs(['seed', '--category', CATEGORY, '--workdir', workdir, '--dry-run']), {
      log: capture().log,
      makeClient: refuseToSpend,
    });
    await expect(readFile(join(workdir, 'runs', SLUG, 'results.json'))).rejects.toThrow();
  });
});

describe('seed — the gate', () => {
  it('refuses to run with neither --dry-run nor --run', async () => {
    const workdir = await makeWorkdir();
    await expect(
      seedCommand(parseArgs(['seed', '--category', CATEGORY, '--workdir', workdir]), {
        log: capture().log,
        makeClient: refuseToSpend,
      }),
    ).rejects.toThrow(/exactly one of --dry-run or --run/);
  });

  it('refuses both at once', async () => {
    const workdir = await makeWorkdir();
    await expect(
      seedCommand(parseArgs(['seed', '--category', CATEGORY, '--workdir', workdir, '--dry-run', '--run']), {
        log: capture().log,
        makeClient: refuseToSpend,
      }),
    ).rejects.toThrow(/exactly one of/);
  });

  it('refuses a category with no installed jury', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'the-pit-cli-'));
    await mkdir(join(workdir, 'runs', SLUG), { recursive: true });
    await writeFile(
      join(workdir, 'runs', SLUG, 'products.json'),
      JSON.stringify({ category: CATEGORY, products: makeProducts(10) }),
    );

    await expect(
      seedCommand(parseArgs(['seed', '--category', CATEGORY, '--workdir', workdir, '--dry-run']), {
        log: capture().log,
        makeClient: refuseToSpend,
      }),
    ).rejects.toThrow(/no installed jury/);
  });

  it('refuses an installed jury that no longer validates', async () => {
    const workdir = await makeWorkdir();
    // A hand edit that drops a juror. `validateJury` catches it; without the
    // re-validation the composite would silently divide by five.
    await writeFile(
      join(workdir, 'references', 'jurors', `${SLUG}.json`),
      JSON.stringify({ ...JURY, jurors: JURY.jurors.slice(0, 5) }),
    );

    await expect(
      seedCommand(parseArgs(['seed', '--category', CATEGORY, '--workdir', workdir, '--dry-run']), {
        log: capture().log,
        makeClient: refuseToSpend,
      }),
    ).rejects.toThrow(/not a valid jury/);
  });
});

describe('seed --run', () => {
  it('writes results.json and ranking.json under cjr/runs/<slug>/', async () => {
    const workdir = await makeWorkdir();
    const out = capture();

    const code = await seedCommand(parseArgs(['seed', '--category', CATEGORY, '--workdir', workdir, '--run']), {
      log: out.log,
      makeClient: () => new FixtureClient(makeScript({ clusterPlan: 'pairs' })),
    });

    expect(code).toBe(0);
    expect(out.text()).toContain('RUN COMPLETE');

    const results = JSON.parse(await readFile(join(workdir, 'runs', SLUG, 'results.json'), 'utf8')) as RunResults;
    expect(results.meta.outcome).toBe('delivered');
    expect(results.meta.ledger.total.calls).toBe(JUROR_COUNT + 1 + PANEL.personas.length);

    // Every phase result is on disk too, written as it landed, in a
    // version-stamped envelope — the path carries only the slug, so the versions
    // have to live inside the file.
    for (const phase of ['score', 'uniqueness', 'customer']) {
      const stored = JSON.parse(await readFile(join(workdir, 'runs', SLUG, 'phases', `${phase}.json`), 'utf8')) as {
        versions: Record<string, string>;
        result: { status: string };
      };
      expect(stored.result.status).toBe('ok');
      expect(stored.versions.prompt_version).toBe(JURY.prompt_version);
      expect(stored.versions.persona_version).toBe(PANEL.persona_version);
    }

    await expect(readFile(join(workdir, 'runs', SLUG, 'ranking.json'), 'utf8')).resolves.toContain('"rank"');
  });

  it('exits non-zero on a retryable failure and says the retry is FREE', async () => {
    const workdir = await makeWorkdir();
    const out = capture();

    const code = await seedCommand(parseArgs(['seed', '--category', CATEGORY, '--workdir', workdir, '--run']), {
      log: out.log,
      makeClient: () =>
        new FixtureClient(
          makeScript({ uniquenessError: () => new ModelCallError('503', { retryable: true, status: 503 }) }),
        ),
    });

    expect(code).toBe(1);
    expect(out.text()).toContain('RUN FAILED');
    // Asserted as the exact branch, not as an OR that either arm satisfies.
    expect(out.text()).toContain('this is a FREE retry');
    expect(out.text()).not.toContain('At least one failure is terminal');
    // No board is written for a failed run.
    await expect(readFile(join(workdir, 'runs', SLUG, 'ranking.json'))).rejects.toThrow();
  });

  it('says a TERMINAL failure is not worth a free retry', async () => {
    const workdir = await makeWorkdir();
    const out = capture();

    const code = await seedCommand(parseArgs(['seed', '--category', CATEGORY, '--workdir', workdir, '--run']), {
      log: out.log,
      makeClient: () =>
        new FixtureClient(
          makeScript({
            uniquenessError: () =>
              new ModelCallError('truncated at max_tokens', { retryable: true, code: 'max_tokens' }),
          }),
        ),
    });

    expect(code).toBe(1);
    expect(out.text()).toContain('At least one failure is terminal');
    expect(out.text()).not.toContain('this is a FREE retry');
  });

  it('prints the unpriced-model warning instead of reporting $0.0000 as fact', async () => {
    const workdir = await makeWorkdir();
    const out = capture();

    await seedCommand(parseArgs(['seed', '--category', CATEGORY, '--workdir', workdir, '--run']), {
      log: out.log,
      makeClient: () => new FixtureClient(makeScript({ modelId: 'local-subagent' })),
    });

    expect(out.text()).toContain('$0.0000');
    expect(out.text()).toContain('cost is UNDERSTATED');
  });
});

describe('seed --run — products.json is WRITTEN, not merely read', () => {
  it('writes the prepared category before spending anything, so ids stop moving', async () => {
    // `Product.id` is a 0-based index into the usable rows of the workbook, so
    // re-deriving it from a sheet that gained or lost a row renumbers every
    // product — and ids are how scores, clusters and votes attach to products.
    const workdir = await mkdtemp(join(tmpdir(), 'the-pit-cli-'));
    await mkdir(join(workdir, 'references', 'jurors'), { recursive: true });
    await mkdir(join(workdir, 'references', 'personas'), { recursive: true });
    await writeFile(join(workdir, 'references', 'jurors', `${SLUG}.json`), JSON.stringify(JURY));
    await writeFile(join(workdir, 'references', 'personas', `${SLUG}.json`), JSON.stringify(PANEL));

    const xlsx = await makeWorkbook(workdir, 12);
    const out = capture();

    const code = await seedCommand(
      parseArgs(['seed', '--category', CATEGORY, '--workdir', workdir, '--xlsx', xlsx, '--run']),
      { log: out.log, makeClient: () => new FixtureClient(makeScript({ clusterPlan: 'pairs' })) },
    );

    expect(code).toBe(0);
    expect(out.text()).toContain('products.json');

    const written = JSON.parse(await readFile(join(workdir, 'runs', SLUG, 'products.json'), 'utf8')) as {
      category: string;
      products: { id: number }[];
    };
    expect(written.category).toBe(CATEGORY);
    expect(written.products.map((p) => p.id)).toEqual([...Array(12).keys()]);
  });

  it('does not rewrite a products.json that already exists', async () => {
    const workdir = await makeWorkdir();
    const before = await readFile(join(workdir, 'runs', SLUG, 'products.json'), 'utf8');
    const out = capture();

    await seedCommand(parseArgs(['seed', '--category', CATEGORY, '--workdir', workdir, '--run']), {
      log: out.log,
      makeClient: () => new FixtureClient(makeScript({ clusterPlan: 'pairs' })),
    });

    expect(await readFile(join(workdir, 'runs', SLUG, 'products.json'), 'utf8')).toBe(before);
    expect(out.text()).not.toContain('Prepared');
  });

  it('writes nothing on a dry run — the approval gate is read-only', async () => {
    const workdir = await mkdtemp(join(tmpdir(), 'the-pit-cli-'));
    await mkdir(join(workdir, 'references', 'jurors'), { recursive: true });
    await mkdir(join(workdir, 'references', 'personas'), { recursive: true });
    await writeFile(join(workdir, 'references', 'jurors', `${SLUG}.json`), JSON.stringify(JURY));
    await writeFile(join(workdir, 'references', 'personas', `${SLUG}.json`), JSON.stringify(PANEL));
    const xlsx = await makeWorkbook(workdir, 12);

    await seedCommand(
      parseArgs(['seed', '--category', CATEGORY, '--workdir', workdir, '--xlsx', xlsx, '--dry-run']),
      { log: capture().log, makeClient: refuseToSpend },
    );

    await expect(readFile(join(workdir, 'runs', SLUG, 'products.json'))).rejects.toThrow();
  });
});

describe('FileRunStore', () => {
  it('lays artifacts out exactly as 01 §3 describes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'the-pit-store-'));
    const store = new FileRunStore(CATEGORY, root);

    expect(store.slug).toBe(SLUG);
    expect(store.path).toBe(join(root, 'runs', SLUG));

    await store.writePhase('score', { phase: 'score', status: 'ok' });
    expect(await store.readPhase('score')).toEqual({ phase: 'score', status: 'ok' });
  });

  it('reports a phase that was never run as undefined, not as an error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'the-pit-store-'));
    expect(await new FileRunStore(CATEGORY, root).readPhase('customer')).toBeUndefined();
  });

  it('refuses a category with no slug', () => {
    expect(() => new FileRunStore('---')).toThrow(RangeError);
  });
});
