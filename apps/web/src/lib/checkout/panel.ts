/**
 * Who judges a category, read off the panel that is actually installed.
 *
 * The founder's design canvas puts the jury on the submit page — "form on the
 * left, the panel you'll face on the right" — and on a product whose entire
 * promise is that the judging is transparent, that is the strongest single
 * placement in the canvas. Someone about to spend $5 can see the six mandates
 * their pitch will be read against, and the six buyers it will be shown to,
 * *before* they pay rather than in the verdict afterwards.
 *
 * ## Nothing here is written for the page
 *
 * Every string this module returns is lifted verbatim out of the installed
 * reference files:
 *
 * - `cjr/references/jurors/<slug>.json` — `01 §6` — holds the six roles, their
 *   `cares_most` mandate, and their `weights` vector over the category's metrics.
 * - `cjr/references/personas/<slug>.json` — the six buyers The Floor is drawn
 *   from, with their `description` and `price_sensitivity`.
 *
 * These are the *same* documents the pipeline scores against, so the panel a
 * visitor is shown on the form is the panel that will actually read their pitch.
 * There is no editorial copy about jurors anywhere in this file: if a category's
 * jury changes, this page changes with it and nobody has to remember to update
 * a paragraph. Two consequences follow and both are deliberate:
 *
 * 1. **A category with no installed panel renders nothing**, not a placeholder.
 *    `undefined` is a real answer here — a category can exist as a board slug
 *    while its reference files are mid-seed — and inventing six plausible jurors
 *    to fill the column would be exactly the thing the rest of this product
 *    refuses to do.
 * 2. **The sentences are trimmed, never rewritten.** `firstSentence` cuts at the
 *    first full stop and adds nothing. A juror's mandate is two or three
 *    sentences of instruction to a model; the column shows the first, which is
 *    the one that states the job.
 *
 * ## Weights, and what they are allowed to claim
 *
 * `heaviest` is the metric a juror weights highest — a fact about the panel's
 * configuration, available before anyone has run anything. It is deliberately NOT
 * the canvas's "median cut across all runs", which would be a statistic about
 * observed severity: we have two seeded categories and no run history, so that
 * number does not exist yet and is not invented here. "Weighs X most" is what the
 * file says; "cuts X hardest" is what the file does not say.
 *
 * ## Where it may run
 *
 * `/submit` only. It is a `readFile` off the same workdir `lib/boards/source.ts`
 * locates, and it is *not* on the board read path — `test/boards-read-path.test.ts`
 * walks `app/page.tsx` and the two board routes, and none of them reach here.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isBoardSlug, resolveWorkdir } from '@/lib/boards/source';

/** One juror, as the form shows them. */
export interface PanelJuror {
  /** `The Release Engineer`. The same string that will be printed beside a cut. */
  role: string;
  /** The first sentence of their mandate, verbatim. */
  mandate: string;
  /** The metric they weight highest, and by how much out of 10. */
  heaviest: { metric: string; weight: number } | undefined;
}

/** One buyer from The Floor. */
export interface PanelPersona {
  name: string;
  /** The first sentence of their description, verbatim. */
  who: string;
  /** `low` | `medium` | `high`, as installed. Printed as written. */
  priceSensitivity: string;
}

/** A whole category's panel, or nothing. */
export interface CategoryPanel {
  slug: string;
  /** `b2b` or `consumer`, as installed. Drives `panelLabels`' register. */
  type: string;
  /** The metric names the jury scores against, in the file's own order. */
  metrics: string[];
  jurors: PanelJuror[];
  personas: PanelPersona[];
}

/**
 * The first sentence, or the whole string when there is no sentence break.
 *
 * Splits on a full stop followed by a space, so `SOC 2 Type II` and `99.9%` do
 * not become sentence ends. Never appends an ellipsis: an ellipsis says "there
 * is more and we chose not to show it", which is true, and it also says "this
 * sentence is incomplete", which is not.
 */
export function firstSentence(text: string): string {
  const trimmed = text.trim();
  const end = /\.\s/.exec(trimmed);
  return end === null ? trimmed : trimmed.slice(0, (end.index ?? 0) + 1);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    // Missing, unreadable and malformed all mean one thing to this page: there is
    // no installed panel to show, so it shows none.
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** The juror's own highest weight. Ties go to the metric declared first. */
function heaviestOf(weights: unknown): PanelJuror['heaviest'] {
  const record = asRecord(weights);
  if (record === undefined) return undefined;
  let best: { metric: string; weight: number } | undefined;
  for (const [metric, raw] of Object.entries(record)) {
    if (typeof raw !== 'number' || !Number.isFinite(raw)) continue;
    if (best === undefined || raw > best.weight) best = { metric, weight: raw };
  }
  return best;
}

function toJurors(value: unknown): PanelJuror[] {
  if (!Array.isArray(value)) return [];
  const out: PanelJuror[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const role = asString(record?.['role']);
    const cares = asString(record?.['cares_most']);
    if (role === undefined || cares === undefined) continue;
    out.push({ role, mandate: firstSentence(cares), heaviest: heaviestOf(record?.['weights']) });
  }
  return out;
}

function toPersonas(value: unknown): PanelPersona[] {
  if (!Array.isArray(value)) return [];
  const out: PanelPersona[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    const name = asString(record?.['name']);
    const description = asString(record?.['description']);
    if (name === undefined || description === undefined) continue;
    out.push({
      name,
      who: firstSentence(description),
      priceSensitivity: asString(record?.['price_sensitivity']) ?? 'unstated',
    });
  }
  return out;
}

export interface PanelSourceOptions {
  /** Holds `references/jurors/<slug>.json`. Defaults to the located `cjr/`. */
  workdir?: string;
}

/**
 * Read one category's installed panel.
 *
 * `undefined` when the slug is not a slug, when neither reference file is
 * readable, or when the files parse but hold no juror and no persona. A form
 * column that rendered an empty box would be worse than one that renders nothing.
 */
export async function readCategoryPanel(
  slug: string,
  options: PanelSourceOptions = {},
): Promise<CategoryPanel | undefined> {
  if (!isBoardSlug(slug)) return undefined;
  const workdir = options.workdir ?? resolveWorkdir();

  const jury = asRecord(await readJson(join(workdir, 'references', 'jurors', `${slug}.json`)));
  const buyers = asRecord(await readJson(join(workdir, 'references', 'personas', `${slug}.json`)));

  const jurors = toJurors(jury?.['jurors']);
  const personas = toPersonas(buyers?.['personas']);
  if (jurors.length === 0 && personas.length === 0) return undefined;

  const metrics = Array.isArray(jury?.['metrics'])
    ? (jury['metrics'] as unknown[]).map((m) => asString(asRecord(m)?.['name'])).filter((n): n is string => n !== undefined)
    : [];

  return { slug, type: asString(jury?.['type']) ?? 'consumer', metrics, jurors, personas };
}

/** Every installed panel among the categories the form offers, in that order. */
export async function readCategoryPanels(
  slugs: readonly string[],
  options: PanelSourceOptions = {},
): Promise<CategoryPanel[]> {
  const found: CategoryPanel[] = [];
  for (const slug of slugs) {
    const panel = await readCategoryPanel(slug, options);
    if (panel !== undefined) found.push(panel);
  }
  return found;
}
