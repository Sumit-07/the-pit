/**
 * `pnpm engine panel --category "X" --kind jury|personas` — `01 §4` Steps 2 and 3,
 * **APPROVAL GATES 1 and 2**.
 *
 * Two invocations, exactly as `01` describes `generate_jury.py` and
 * `generate_personas.py`:
 *
 *   panel --kind jury                    prints the generation PROMPT. Calls no model.
 *   panel --kind jury --install FILE     validates and installs, then prints what a
 *                                        person now has to approve.
 *
 * ## This command cannot generate a jury, on purpose
 *
 * It prints a prompt for a person to dispatch to a subagent, and installs what
 * comes back. `01 §4` Step 2 is a human gate: "STOP and show the user the type,
 * the metrics with anchors, and the mandates + weights… Do not proceed until
 * approved." A command that generated, validated and installed in one motion
 * would have turned that gate into a progress bar.
 *
 * The install path runs Task 6's validators, which check STRUCTURE — six jurors,
 * unique roles, weights keyed by exactly the metric names, all four anchors
 * present. They cannot check the thing the gate exists for: whether the panel
 * genuinely disagrees, and whether the roster is genuinely different buyers. So
 * the install prints the weight matrix and the roster in full, because a person
 * reading them is the only check there is.
 *
 * No `ModelClient` is imported here and none is constructed. Nothing this command
 * does can spend.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { loadCategory } from '../ingest/load-category.js';
import { buildJuryPrompt, buildPersonaPrompt } from '../panels/generate/prompts.js';
import { validateJury } from '../panels/generate/validate-jury.js';
import { validatePersonas } from '../panels/generate/validate-personas.js';
import { categorySlug } from '../panels/seeded.js';
import { DEFAULT_WORKDIR } from '../run/store.js';
import type { Jury, PersonaPanel, Product } from '../types.js';
import { optionalFlag, rejectUnknownFlags, requireFlag, UsageError, type ParsedArgs } from './args.js';
import { loadStoredProducts, readJson, runDir } from './load.js';

const PANEL_FLAGS = ['category', 'kind', 'install', 'workdir', 'xlsx'];

export const PANEL_USAGE = `Usage:
  engine panel --category "Developer Tools" --kind jury      [--workdir cjr] [--xlsx PATH]
  engine panel --category "Developer Tools" --kind jury      --install /tmp/jury.json
  engine panel --category "Developer Tools" --kind personas  [--workdir cjr] [--xlsx PATH]
  engine panel --category "Developer Tools" --kind personas  --install /tmp/personas.json

Without --install: prints the generation prompt (01 §4 Steps 2-3). Calls no model.
With --install: validates the JSON a subagent returned and installs it to
<workdir>/references/{jurors,personas}/<slug>.json, then prints what a person must approve.

APPROVAL GATES 1 and 2. The validators check structure only — that the jury genuinely
disagrees, and that the personas are genuinely different buyers, is a human judgement.`;

export interface PanelDeps {
  log: (line: string) => void;
}

/** Run the `panel` command. Returns a process exit code. */
export async function panelCommand(args: ParsedArgs, deps: PanelDeps): Promise<number> {
  rejectUnknownFlags(args, PANEL_FLAGS);

  const category = requireFlag(args, 'category');
  const kind = requireFlag(args, 'kind');
  if (kind !== 'jury' && kind !== 'personas') {
    throw new UsageError(`--kind must be "jury" or "personas", got ${JSON.stringify(kind)}`);
  }

  const workdir = optionalFlag(args, 'workdir') ?? DEFAULT_WORKDIR;
  const slug = categorySlug(category);
  if (slug === '') throw new UsageError(`--category ${JSON.stringify(category)} has no slug`);

  const install = optionalFlag(args, 'install');
  if (install !== undefined) {
    return await installPanel({ category, slug, kind, workdir, path: install, log: deps.log });
  }

  const products = await resolveProducts(category, slug, workdir, optionalFlag(args, 'xlsx'));
  // Taglines are the product descriptions, sampled to `TAGLINE_SAMPLE` inside the
  // builder (`01 §4` Step 2: "samples the first 15 taglines").
  const taglines = products.map((product) => product.description);

  deps.log(kind === 'jury' ? buildJuryPrompt(category, taglines) : buildPersonaPrompt(category, taglines));
  return 0;
}

interface InstallInput {
  category: string;
  slug: string;
  kind: 'jury' | 'personas';
  workdir: string;
  path: string;
  log: (line: string) => void;
}

/** Validate what a subagent returned and install it, or refuse with every failure at once. */
async function installPanel(input: InstallInput): Promise<number> {
  const raw = await readJson(input.path);
  if (raw === undefined) throw new UsageError(`no such file: ${input.path}`);

  const target =
    input.kind === 'jury'
      ? join(input.workdir, 'references', 'jurors', `${input.slug}.json`)
      : join(input.workdir, 'references', 'personas', `${input.slug}.json`);

  if (input.kind === 'jury') {
    const result = validateJury(raw);
    if (!result.valid) throw new UsageError(refusal(input.path, result.errors));
    await write(target, result.value);
    input.log(describeJury(result.value, input.category, target));
    return 0;
  }

  const result = validatePersonas(raw);
  if (!result.valid) throw new UsageError(refusal(input.path, result.errors));
  await write(target, result.value);
  input.log(describePanel(result.value, input.category, target));
  return 0;
}

/** Every failure at once — the validators return them all, so the person fixes one file once. */
function refusal(path: string, errors: readonly string[]): string {
  return `${path} was NOT installed. ${errors.length} problem(s):\n${errors.map((error) => `  - ${error}`).join('\n')}`;
}

/**
 * The jury, rendered for a human to approve.
 *
 * The weight matrix is printed in full because `01 §4` Step 2's real test lives
 * there: "at least one juror's heavily-weighted metric must be another's
 * near-zero metric." No validator can assert that — a panel of six identical
 * mandates passes every structural check and produces a board with no
 * information in it.
 */
function describeJury(jury: Jury, category: string, path: string): string {
  const names = jury.metrics.map((metric) => metric.name);
  const width = Math.max(...jury.jurors.map((juror) => juror.role.length), 12);

  const lines = [
    `APPROVAL GATE 1 — the jury for ${category}`,
    '',
    `  type            ${jury.type}`,
    `  prompt_version  ${jury.prompt_version}`,
    '',
    '  Rubric:',
    ...jury.metrics.flatMap((metric) => [
      `    ${metric.name} — ${metric.description}`,
      ...(['100', '80', '50', '20'] as const).map((level) => `      ${level.padStart(3)}: ${metric.anchors[level]}`),
    ]),
    '',
    `  Weights (normalized per juror at scoring time, ${jury.jurors.length} jurors):`,
    `    ${'juror'.padEnd(width)}  ${names.map((name) => name.padStart(10)).join(' ')}`,
    ...jury.jurors.map(
      (juror) =>
        `    ${juror.role.padEnd(width)}  ` +
        names.map((name) => (juror.weights[name] ?? 0).toFixed(2).padStart(10)).join(' '),
    ),
    '',
    '  Mandates:',
    ...jury.jurors.flatMap((juror) => [
      `    ${juror.role}`,
      `      who:            ${juror.who}`,
      `      cares most:     ${juror.cares_most}`,
      `      biased against: ${juror.biased_against}`,
    ]),
    '',
    `  Installed to ${path}`,
    '',
    '  STOP. The validator checked STRUCTURE only. Show this to the founder and get an explicit yes.',
    '  The jury must genuinely DISAGREE: at least one juror\'s heavily-weighted metric must be',
    '  another\'s near-zero one. Six agreeable jurors pass every check above and produce a board with',
    '  no information in it. If it is weak, edit the installed file and BUMP prompt_version.',
  ];

  return lines.join('\n');
}

/** The roster, rendered for a human to approve. `01 §4` Step 3. */
function describePanel(panel: PersonaPanel, category: string, path: string): string {
  return [
    `APPROVAL GATE 2 — the customer panel for ${category}`,
    '',
    `  persona_version  ${panel.persona_version}`,
    `  personas         ${panel.personas.length}`,
    '',
    ...panel.personas.flatMap((persona) => [
      `    ${persona.name}  (price sensitivity: ${persona.price_sensitivity})`,
      `      ${persona.description}`,
      ...persona.needs.map((need) => `      - ${need}`),
    ]),
    '',
    `  Installed to ${path}`,
    '',
    '  STOP. The validator checked STRUCTURE only. Show this to the founder and get an explicit yes.',
    '  The segments must be genuinely DIFFERENT buyers: at least one price-insensitive',
    '  capability-chaser and at least one high-price-sensitivity defector. If it is weak, edit the',
    '  installed file and BUMP persona_version.',
  ].join('\n');
}

/** The category's products: the pinned set if it exists, otherwise the source workbook. */
async function resolveProducts(
  category: string,
  slug: string,
  workdir: string,
  xlsx: string | undefined,
): Promise<readonly Product[]> {
  const stored = await loadStoredProducts(workdir, slug, category);
  if (stored !== undefined) return stored.products;

  if (xlsx === undefined) {
    throw new UsageError(
      `no ${join(runDir(workdir, slug), 'products.json')} and no --xlsx given. ` +
        'Pass --xlsx PATH so the generation prompt can sample this category’s taglines (01 §4 Step 1).',
    );
  }
  return (await loadCategory(xlsx, category)).products;
}

async function write(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
