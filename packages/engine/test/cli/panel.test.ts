import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseArgs } from '../../src/cli/args.js';
import { panelCommand } from '../../src/cli/panel.js';
import { JUROR_COUNT } from '../../src/config/constants.js';
import type { Jury } from '../../src/types.js';
import { CATEGORY, JURY, PANEL, makeProducts } from '../helpers/run-fixtures.js';

/**
 * `engine panel` — `01 §4` Steps 2 and 3, the two approval gates.
 *
 * The assertions that matter are about what the command REFUSES to do and what it
 * insists a person look at. It never calls a model, it never installs something
 * the validators rejected, and after a successful install it prints the weight
 * matrix and the roster — because the gate's real question ("does this panel
 * actually disagree?") is one no validator can answer.
 */

const SLUG = 'health-fitness-wellness';

function capture(): { log: (line: string) => void; text: () => string } {
  const lines: string[] = [];
  return { log: (line) => lines.push(line), text: () => lines.join('\n') };
}

async function makeWorkdir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'the-pit-panel-'));
  await mkdir(join(root, 'runs', SLUG), { recursive: true });
  await writeFile(
    join(root, 'runs', SLUG, 'products.json'),
    JSON.stringify({ category: CATEGORY, products: makeProducts(20) }),
  );
  return root;
}

function run(root: string, flags: string[], log: (line: string) => void): Promise<number> {
  return panelCommand(parseArgs(['panel', '--category', CATEGORY, '--workdir', root, ...flags]), { log });
}

describe('engine panel — the generation prompts', () => {
  it('prints the jury prompt, sampled from this category’s own taglines', async () => {
    const root = await makeWorkdir();
    const out = capture();
    expect(await run(root, ['--kind', 'jury'], out.log)).toBe(0);

    expect(out.text()).toContain(`Write exactly ${JUROR_COUNT} jurors`);
    expect(out.text()).toContain('task number 0');
  });

  it('prints the persona prompt', async () => {
    const root = await makeWorkdir();
    const out = capture();
    expect(await run(root, ['--kind', 'personas'], out.log)).toBe(0);
    expect(out.text()).toContain('personas');
    expect(out.text()).toContain('price_sensitivity');
  });

  it('refuses a kind it does not have a prompt for', async () => {
    const root = await makeWorkdir();
    await expect(run(root, ['--kind', 'referees'], capture().log)).rejects.toThrow(/--kind must be "jury"/);
  });

  it('says which file is missing rather than failing on ENOENT', async () => {
    const root = await mkdtemp(join(tmpdir(), 'the-pit-panel-'));
    await expect(run(root, ['--kind', 'jury'], capture().log)).rejects.toThrow(/no --xlsx given/);
  });
});

describe('engine panel --install — APPROVAL GATES 1 and 2', () => {
  it('installs a valid jury and puts the weight matrix in front of a person', async () => {
    const root = await makeWorkdir();
    const source = join(root, 'jury.json');
    await writeFile(source, JSON.stringify(JURY));

    const out = capture();
    expect(await run(root, ['--kind', 'jury', '--install', source], out.log)).toBe(0);

    const installed = JSON.parse(
      await readFile(join(root, 'references', 'jurors', `${SLUG}.json`), 'utf8'),
    ) as Jury;
    expect(installed.jurors).toHaveLength(JUROR_COUNT);

    expect(out.text()).toContain('APPROVAL GATE 1');
    expect(out.text()).toContain('Weights');
    // The line the gate exists for. It is not a validator's job and the command
    // says so rather than implying the check has been done.
    expect(out.text()).toContain('The validator checked STRUCTURE only');
    expect(out.text()).toContain('genuinely DISAGREE');
    expect(out.text()).toContain('BUMP prompt_version');
  });

  it('installs a valid persona roster and names the two segments that must be there', async () => {
    const root = await makeWorkdir();
    const source = join(root, 'personas.json');
    await writeFile(source, JSON.stringify(PANEL));

    const out = capture();
    expect(await run(root, ['--kind', 'personas', '--install', source], out.log)).toBe(0);
    expect(out.text()).toContain('APPROVAL GATE 2');
    expect(out.text()).toContain('price-insensitive');
    expect(out.text()).toContain('high-price-sensitivity defector');
    expect(out.text()).toContain('BUMP persona_version');
  });

  it('refuses an invalid jury with every failure at once, and installs nothing', async () => {
    const root = await makeWorkdir();
    const source = join(root, 'jury.json');
    // Five jurors (01 §4's number, not DECISIONS.md S1's six) and a juror whose
    // weights name a metric the rubric does not have.
    const broken = {
      ...JURY,
      jurors: JURY.jurors.slice(0, 5).map((juror, index) =>
        index === 0 ? { ...juror, weights: { ...juror.weights, Vibes: 1 } } : juror,
      ),
    };
    await writeFile(source, JSON.stringify(broken));

    const error = await run(root, ['--kind', 'jury', '--install', source], capture().log).catch(
      (caught: unknown) => caught,
    );
    expect((error as Error).message).toContain('was NOT installed');
    expect((error as Error).message).toMatch(/2 problem\(s\)|problem\(s\)/);
    await expect(readFile(join(root, 'references', 'jurors', `${SLUG}.json`), 'utf8')).rejects.toThrow(/ENOENT/);
  });
});
