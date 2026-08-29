/**
 * Regenerate `src/submission/category-model.data.ts` from the labelled corpus.
 *
 *     pnpm --filter @the-pit/payments run build:category-model
 *
 * Offline and deterministic: it reads one committed JSON file and writes one
 * committed TypeScript file. Nothing in the app runs it — the shipped table is
 * checked in, and `test/submission/category-model.build.test.ts` fails if the
 * checked-in table stops matching what this script would produce, so the
 * artifact can never quietly diverge from the corpus it claims to summarize.
 *
 * It lives outside `src` on purpose. `tsconfig.build.json` compiles `src` only,
 * so the generator cannot end up in `dist` or on the runtime path.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCategoryModel, type LabelledProduct } from '../src/submission/category-model.ts';

const here = dirname(fileURLToPath(import.meta.url));
const corpusPath = join(here, '..', 'test', 'fixtures', 'labelled-products.json');
const outputPath = join(here, '..', 'src', 'submission', 'category-model.data.ts');

const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as LabelledProduct[];
const model = buildCategoryModel(corpus);

/** One array per line, so a weight change shows as one changed line. */
const list = (values: readonly (string | number)[]): string =>
  `[${values.map((value) => JSON.stringify(value)).join(',')}]`;

const header = `/**
 * GENERATED FILE — do not edit by hand.
 *
 * Rebuild with \`pnpm --filter @the-pit/payments run build:category-model\`.
 * Source: \`test/fixtures/labelled-products.json\`, ${model.documentCount} labelled products
 * across ${model.categories.length} categories, scraped from outbid.lol and sanitized to the same
 * ${'`SANITIZE_LIMIT`'} the submission guards enforce.
 *
 * \`test/submission/category-model.build.test.ts\` rebuilds this from the corpus and
 * fails if a single weight differs, so this file is a cache of a pure function and
 * never a place to hand-tune a category.
 */

/* eslint-disable */

import type { CategoryModel } from './category-model.js';

export const SEEDED_CATEGORY_MODEL: CategoryModel = {
  version: ${model.version},
  documentCount: ${model.documentCount},
  categories: ${list(model.categories)},
  vocabulary: ${list(model.vocabulary)},
  idf: ${list(model.idf)},
  unknownIdf: ${model.unknownIdf},
  centroids: [
${model.centroids.map((centroid) => `    ${list(centroid)},`).join('\n')}
  ],
};
`;

writeFileSync(outputPath, header, 'utf8');
console.log(
  `wrote ${outputPath}: ${model.categories.length} categories, ` +
    `${model.vocabulary.length} terms, ${model.centroids.reduce((n, c) => n + c.length / 2, 0)} centroid weights, ` +
    `${(header.length / 1024).toFixed(0)}KB`,
);
