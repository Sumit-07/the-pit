import { existsSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { MIN_PRODUCTS, SANITIZE_LIMIT } from '../src/config/constants.js';
import { loadCategory } from '../src/ingest/load-category.js';
import { normalizeUrl } from '../src/ingest/normalize-url.js';

/**
 * The real export. It lives outside the repo and is not committed, so this file
 * skips itself on a machine that does not have it; `pnpm test` stays green
 * either way. Every other ingest test builds its own fixture workbook.
 */
const XLSX = '/Users/sumitkumar/Downloads/outbid_all_categories.xlsx';

/** The two categories Phase 1 seeds, with their usable-row counts. */
const SEED_CATEGORIES: ReadonlyArray<readonly [string, number]> = [
  ['Developer Tools', 48],
  ['Health, Fitness & Wellness', 44],
];

describe.skipIf(!existsSync(XLSX))('loadCategory against outbid_all_categories.xlsx', () => {
  it.each(SEED_CATEGORIES)('%s has %i usable products', async (category, usable) => {
    const result = await loadCategory(XLSX, category);

    expect(result.category).toBe(category);
    expect(result.products).toHaveLength(usable);
    expect(usable).toBeGreaterThanOrEqual(MIN_PRODUCTS);
  });

  it('returns dense ids in ascending rank order', async () => {
    const { products } = await loadCategory(XLSX, 'Developer Tools');

    expect(products.map((product) => product.id)).toEqual([...products.keys()]);

    const ranks = products.map((product) => product.orig_rank);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it('emits nothing unjudgeable and nothing over the limit', async () => {
    for (const [category] of SEED_CATEGORIES) {
      const { products } = await loadCategory(XLSX, category);

      for (const product of products) {
        expect(product.name).not.toBe('');
        expect(product.description).not.toBe('');
        expect(product.description.length).toBeLessThanOrEqual(SANITIZE_LIMIT);
        expect(product.description).not.toMatch(/[\p{Cc}\p{Cf}]|\s\s/u);
        expect(product.normalized_url).toBe(normalizeUrl(product.url));
      }
    }
  });

  it('gives every product in a category a distinct normalized URL', async () => {
    for (const [category] of SEED_CATEGORIES) {
      const { products } = await loadCategory(XLSX, category);
      const normalized = products.map((product) => product.normalized_url);

      expect(new Set(normalized).size).toBe(normalized.length);
    }
  });

  it('truncates the descriptions that are genuinely too long', async () => {
    const { products } = await loadCategory(XLSX, 'Developer Tools');

    // Truncation is real but rare in this export; if none of the seed rows hit
    // the limit the truncation path is going untested against real data.
    const atLimit = products.filter((product) => product.description.length === SANITIZE_LIMIT);
    expect(atLimit.length).toBeGreaterThan(0);
  });
});
