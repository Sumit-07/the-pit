/**
 * The shipped table is a cache of a pure function, and this is what keeps it one.
 *
 * `category-model.data.ts` is 194KB of numbers nobody will read. If it can drift
 * from the corpus — hand-edited to unblock one complaint, left stale after a
 * corpus change — then the reported false-rejection rate stops describing the
 * thing that actually runs. Rebuilding it here and comparing weight for weight is
 * the cheapest way to make that impossible.
 *
 * It doubles as the determinism check `brief` Global Constraint 5 asks for:
 * the build reads no clock, no environment and no random source, so two runs on
 * two machines produce the same bytes.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { LabelledProduct } from '../../src/submission/category-model.js';
import { buildCategoryModel, tokenizeProduct } from '../../src/submission/category-model.js';
import { SEEDED_CATEGORY_MODEL } from '../../src/submission/category-model.data.js';

const here = dirname(fileURLToPath(import.meta.url));
const CORPUS = JSON.parse(
  readFileSync(join(here, '..', 'fixtures', 'labelled-products.json'), 'utf8'),
) as LabelledProduct[];

describe('the shipped table', () => {
  it('is exactly what the corpus produces', () => {
    expect(buildCategoryModel(CORPUS)).toEqual(SEEDED_CATEGORY_MODEL);
  });

  it('is reproducible: building it twice gives identical bytes', () => {
    expect(JSON.stringify(buildCategoryModel(CORPUS))).toBe(JSON.stringify(buildCategoryModel(CORPUS)));
  });

  it('does not depend on the order the corpus is read in', () => {
    const shuffled = [...CORPUS].reverse();
    const rebuilt = buildCategoryModel(shuffled);

    expect(rebuilt.categories).toEqual(SEEDED_CATEGORY_MODEL.categories);
    expect(rebuilt.vocabulary).toEqual(SEEDED_CATEGORY_MODEL.vocabulary);
    expect(rebuilt.idf).toEqual(SEEDED_CATEGORY_MODEL.idf);
    // Centroid weights are a sum of floats, so reversing the addition order can
    // move the last bit. Compared to a tolerance rather than asserted identical,
    // because pretending float addition is associative is how a "deterministic"
    // build starts failing on one machine.
    for (const [index, centroid] of SEEDED_CATEGORY_MODEL.centroids.entries()) {
      const other = rebuilt.centroids[index] ?? [];
      expect(other).toHaveLength(centroid.length);
      for (const [position, value] of centroid.entries()) {
        expect(other[position]).toBeCloseTo(value, 5);
      }
    }
  });

  it('stores every category as a unit vector, so a cosine is a cosine', () => {
    for (const centroid of SEEDED_CATEGORY_MODEL.centroids) {
      let squared = 0;
      for (let cursor = 1; cursor < centroid.length; cursor += 2) squared += (centroid[cursor] ?? 0) ** 2;
      expect(Math.sqrt(squared)).toBeCloseTo(1, 4);
    }
  });

  it('holds a centroid for every category and only for categories the corpus has', () => {
    expect(SEEDED_CATEGORY_MODEL.centroids).toHaveLength(SEEDED_CATEGORY_MODEL.categories.length);
    expect(SEEDED_CATEGORY_MODEL.categories).toEqual([...new Set(CORPUS.map((p) => p.slug))].sort());
  });

  it('indexes every centroid weight into the vocabulary it ships', () => {
    const size = SEEDED_CATEGORY_MODEL.vocabulary.length;
    expect(SEEDED_CATEGORY_MODEL.idf).toHaveLength(size);
    for (const centroid of SEEDED_CATEGORY_MODEL.centroids) {
      for (let cursor = 0; cursor < centroid.length; cursor += 2) {
        expect(centroid[cursor]).toBeGreaterThanOrEqual(0);
        expect(centroid[cursor]).toBeLessThan(size);
      }
    }
  });
});

describe('the tokenizer the table was built with', () => {
  it('folds case, drops punctuation and strips a plural s', () => {
    expect([...tokenizeProduct('Workouts, Habits & Streaks!', '').keys()]).toEqual([
      'workout',
      'habit',
      'streak',
    ]);
  });

  it('keeps the symbols that are part of a name', () => {
    expect([...tokenizeProduct('C++ and C# for .NET', '').keys()]).toEqual(['c++', 'c#', 'net']);
  });

  it('drops bare numbers and single characters, which name no category', () => {
    expect([...tokenizeProduct('Ship 10 apps in 2026 — a guide', '').keys()]).toEqual([
      'ship',
      'app',
      'guide',
    ]);
  });

  it('does not fold a word that merely ends in s', () => {
    expect([...tokenizeProduct('analysis business focus', '').keys()]).toEqual([
      'analysis',
      'business',
      'focus',
    ]);
  });

  it('counts repeats, so a term used twice is not two separate terms', () => {
    expect(tokenizeProduct('Calorie tracker', 'A calorie tracker that tracks calories.').get('calorie')).toBe(3);
  });

  it('erases zero-width and bidi characters rather than letting them split a word', () => {
    // `sanitize` deletes them outright, so the smuggled text collapses into one
    // token rather than becoming two. It matches nothing in the vocabulary,
    // which is the safe failure: no score, and therefore no block.
    expect([...tokenizeProduct('work​out‮tracker', '').keys()]).toEqual(['workouttracker']);
    // A real line break IS a word boundary, and stays one.
    expect([...tokenizeProduct('workout\ntracker', '').keys()]).toEqual(['workout', 'tracker']);
  });
});
