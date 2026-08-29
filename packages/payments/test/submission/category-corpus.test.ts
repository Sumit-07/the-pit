/**
 * The one number that decides whether this classifier is better than the stub:
 * **how many correct category choices would it reject?**
 *
 * `DECISIONS.md` S12 and `brief §2.5` both say a false rejection on a paying
 * customer costs more than a missed run, and a blocked submitter has nowhere to
 * appeal. So the corpus is run through the guard twice — once against the shipped
 * table, once against models that have never seen the row being judged — and both
 * false-rejection counts are asserted at zero. A future change that trades a
 * customer for a catch fails here, by name.
 *
 * The detection floors in the last block are the other half of the vice. Without
 * them, `classify` could be replaced with "always match" and every assertion
 * above would still pass.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createNearestCentroidClassifier, seededCategoryClassifier } from '../../src/submission/category-classifier.js';
import type { LabelledProduct } from '../../src/submission/category-model.js';
import { buildCategoryModel, scoreCategories } from '../../src/submission/category-model.js';
import { SEEDED_CATEGORY_MODEL } from '../../src/submission/category-model.data.js';
import type { CategoryClassifier } from '../../src/submission/category.js';
import { decideCategory } from '../../src/submission/category.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');

/**
 * The labelled set: every product in the outbid workbook that has a description,
 * carrying the category its own submitter picked.
 */
const CORPUS = JSON.parse(
  readFileSync(join(here, '..', 'fixtures', 'labelled-products.json'), 'utf8'),
) as LabelledProduct[];

const ALL_CATEGORIES = SEEDED_CATEGORY_MODEL.categories;
const BOARDS = ['developer-tools', 'health-fitness-wellness'] as const;

/** `cjr/runs/<slug>/products.json` — the two categories that were actually seeded. */
function seededProducts(slug: string): LabelledProduct[] {
  const file = join(repoRoot, 'cjr', 'runs', slug, 'products.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
    products: Array<{ name: string; description: string }>;
  };
  return parsed.products.map((product) => ({ slug, name: product.name, description: product.description }));
}

/** The category this product scores lowest against, out of all 28. */
function worstCategoryFor(product: LabelledProduct): string {
  const { scores } = scoreCategories(SEEDED_CATEGORY_MODEL, product.name, product.description);
  return scores[scores.length - 1]?.slug ?? product.slug;
}

async function isBlocked(
  classifier: CategoryClassifier,
  product: LabelledProduct,
  chosenCategory: string,
  candidateCategories: readonly string[],
): Promise<boolean> {
  const verdict = await classifier.classify({
    name: product.name,
    description: product.description,
    chosenCategory,
    candidateCategories,
  });
  return decideCategory(verdict, chosenCategory).action === 'block';
}

async function falseRejections(
  classifier: CategoryClassifier,
  products: readonly LabelledProduct[],
  candidateCategories: readonly string[],
): Promise<LabelledProduct[]> {
  const rejected: LabelledProduct[] = [];
  for (const product of products) {
    if (await isBlocked(classifier, product, product.slug, candidateCategories)) rejected.push(product);
  }
  return rejected;
}

describe('the labelled corpus is the set this was measured on', () => {
  it('is the whole workbook: 1028 products across 28 categories', () => {
    expect(CORPUS).toHaveLength(1028);
    expect(new Set(CORPUS.map((product) => product.slug)).size).toBe(28);
    expect(ALL_CATEGORIES).toHaveLength(28);
    expect(SEEDED_CATEGORY_MODEL.documentCount).toBe(1028);
  });

  it('covers both seeded boards, at the sizes the seeded runs hold', () => {
    expect(CORPUS.filter((product) => product.slug === 'developer-tools')).toHaveLength(48);
    expect(CORPUS.filter((product) => product.slug === 'health-fitness-wellness')).toHaveLength(44);
  });
});

describe('false-rejection rate on correct category choices', () => {
  it('rejects none of the 1028 correct assignments, with every category on offer', async () => {
    const rejected = await falseRejections(seededCategoryClassifier, CORPUS, ALL_CATEGORIES);

    // COMMITTED NUMBER: 0 of 1028, a false-rejection rate of 0.00%.
    // Named products in the failure message, so a regression says who it cost.
    expect(rejected.map((product) => `${product.slug}: ${product.name}`)).toEqual([]);
    expect(rejected.length / CORPUS.length).toBe(0);
  });

  it('rejects none of them under 5-fold cross-validation, where the model never saw the row', async () => {
    // The shipped table has memorized its own corpus, so the paragraph above is
    // the easy half of the claim. This is the honest half: five models, each
    // built from four fifths of the corpus, judging the fifth they were not
    // shown — which is the regime an unseen paying customer arrives in.
    const folds = 5;
    const rejected: string[] = [];
    for (let fold = 0; fold < folds; fold += 1) {
      const training = CORPUS.filter((_, index) => index % folds !== fold);
      const held = CORPUS.filter((_, index) => index % folds === fold);
      const classifier = createNearestCentroidClassifier(buildCategoryModel(training));
      for (const product of await falseRejections(classifier, held, ALL_CATEGORIES)) {
        rejected.push(`${product.slug}: ${product.name}`);
      }
    }

    // COMMITTED NUMBER: 0 of 1028 held-out rows, a false-rejection rate of 0.00%.
    expect(rejected).toEqual([]);
  }, 120_000);

  it('accepts every seeded Developer Tools product in Developer Tools', async () => {
    const products = seededProducts('developer-tools');
    expect(products).toHaveLength(48);

    expect(await falseRejections(seededCategoryClassifier, products, BOARDS)).toEqual([]);
    expect(await falseRejections(seededCategoryClassifier, products, ALL_CATEGORIES)).toEqual([]);
  });

  it('accepts every seeded Health & Fitness product in Health & Fitness', async () => {
    const products = seededProducts('health-fitness-wellness');
    expect(products).toHaveLength(44);

    expect(await falseRejections(seededCategoryClassifier, products, BOARDS)).toEqual([]);
    expect(await falseRejections(seededCategoryClassifier, products, ALL_CATEGORIES)).toEqual([]);
  });
});

describe('it still catches the pick S12 is about', () => {
  it('blocks most products filed in the category they fit WORST', async () => {
    // `DECISIONS.md` S12's lever in its purest form: the submitter shops the
    // roster for the category whose peers are softest, which in the limit is the
    // category their product resembles least.
    let blocked = 0;
    for (const product of CORPUS) {
      // Score once to find the worst-fitting category, then ask the guard as if
      // the submitter had chosen it.
      const worst = worstCategoryFor(product);
      if (await isBlocked(seededCategoryClassifier, product, worst, ALL_CATEGORIES)) blocked += 1;
    }

    // COMMITTED FLOOR. Measured at 86.6% with the shipped table and 51.8% under
    // cross-validation; the floor sits below the first so ordinary drift does not
    // fail the build, and a change that guts the guard still does.
    expect(blocked / CORPUS.length).toBeGreaterThan(0.75);
  }, 120_000);

  it('leaves the review queue small: almost every correct choice is a plain match', async () => {
    // A guard that flagged half its traffic would be a guard nobody reads.
    let flagged = 0;
    for (const product of CORPUS) {
      const verdict = await seededCategoryClassifier.classify({
        name: product.name,
        description: product.description,
        chosenCategory: product.slug,
        candidateCategories: ALL_CATEGORIES,
      });
      const decision = decideCategory(verdict, product.slug);
      if (decision.action === 'allow' && decision.flagForReview) flagged += 1;
    }

    // Measured: 36 of 1028 (3.5%), every one of them `uncertain` — text too short
    // or too far outside the corpus's languages to judge, never a suspected mismatch.
    expect(flagged / CORPUS.length).toBeLessThan(0.06);
  }, 120_000);

  it('blocks a seeded Health & Fitness product filed under Developer Tools, and names the board it belongs to', async () => {
    const products = seededProducts('health-fitness-wellness');
    let blocked = 0;
    let suggestedCorrectly = 0;
    for (const product of products) {
      const verdict = await seededCategoryClassifier.classify({
        name: product.name,
        description: product.description,
        chosenCategory: 'developer-tools',
        candidateCategories: BOARDS,
      });
      if (decideCategory(verdict, 'developer-tools').action === 'block') {
        blocked += 1;
        if (verdict.verdict === 'mismatch' && verdict.suggested === 'health-fitness-wellness') {
          suggestedCorrectly += 1;
        }
      }
    }

    // COMMITTED FLOOR: with only two boards on offer the guard is much weaker.
    // Measured at 5 of 44 (11.4%) this way and 11 of 48 (22.9%) in the other
    // direction — the Health & Fitness corpus is app-store copy, so a developer
    // tool still scores something against it. Two boards is also the setting
    // where the lever is worth least: there is only one other category to move
    // to. Every block it does make names the right board, which is the property
    // that has to hold at any recall.
    expect(blocked / products.length).toBeGreaterThan(0.09);
    expect(suggestedCorrectly).toBe(blocked);
  });
});

