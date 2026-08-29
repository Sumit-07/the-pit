import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIN_PRODUCTS, SANITIZE_LIMIT } from '../src/config/constants.js';
import { InsufficientProductsError, loadCategory } from '../src/ingest/load-category.js';

const CATEGORY = 'Developer Tools';
const OTHER_CATEGORY = 'Health, Fitness & Wellness';
const SHEET = 'All Products';

// XML 1.0 cannot carry a C0 control character, so no real .xlsx can either;
// those live in the `sanitize` unit tests. What an .xlsx *can* carry is the
// invisible formatting characters below.
const ZERO_WIDTH_SPACE = '\u200b';
const RIGHT_TO_LEFT_OVERRIDE = '\u202e';

/** The real sheet's header row, verbatim — including the columns the loader ignores. */
const HEADERS = [
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
];

interface RowSpec {
  category: string;
  rank: string;
  name: string;
  description: string;
  url: string;
}

function row(rank: number, overrides: Partial<RowSpec> = {}): RowSpec {
  return {
    category: CATEGORY,
    rank: String(rank),
    name: `Product ${rank}`,
    description: `Description for product ${rank}.`,
    url: `https://www.example.com/p/${rank}?utm_source=fixture`,
    ...overrides,
  };
}

function rows(ranks: number[]): RowSpec[] {
  return ranks.map((rank) => row(rank));
}

/** `specs` followed by enough plain rows to clear `MIN_PRODUCTS`. */
function padded(specs: RowSpec[]): RowSpec[] {
  const filler = Array.from({ length: Math.max(0, MIN_PRODUCTS - specs.length) }, (_, index) =>
    row(specs.length + index + 1),
  );
  return [...specs, ...filler];
}

/** Every cell of a spec row, in the order of `HEADERS`. */
function cells(spec: RowSpec): string[] {
  return [
    spec.category,
    spec.rank,
    'example.com',
    spec.name,
    spec.description,
    'fixture',
    '0',
    '0',
    spec.url,
    'https://outbid.lol/product/example',
  ];
}

let workdir: string;
let fixtureCount = 0;

/**
 * Write a fixture workbook. Every cell is written as a string, which is how the
 * real export stores them — including `Rank`, the reason it must be parsed as an
 * integer rather than sorted as text.
 */
async function fixture(
  specs: RowSpec[],
  options: { headers?: string[]; sheet?: string; reverseColumns?: boolean } = {},
): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(options.sheet ?? SHEET);
  const order = <T>(values: T[]): T[] => (options.reverseColumns ? [...values].reverse() : values);

  sheet.addRow(order(options.headers ?? HEADERS));
  for (const spec of specs) sheet.addRow(order(cells(spec)));

  const path = join(workdir, `fixture-${(fixtureCount += 1)}.xlsx`);
  await workbook.xlsx.writeFile(path);
  return path;
}

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), 'the-pit-ingest-'));
});

afterAll(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe('loadCategory', () => {
  it('returns the category and its products', async () => {
    const path = await fixture(padded([]));

    const result = await loadCategory(path, CATEGORY);

    expect(result.category).toBe(CATEGORY);
    expect(result.products).toHaveLength(MIN_PRODUCTS);
    expect(result.products[0]).toEqual({
      id: 0,
      name: 'Product 1',
      description: 'Description for product 1.',
      url: 'https://www.example.com/p/1?utm_source=fixture',
      normalized_url: 'example.com/p/1',
      orig_rank: 1,
    });
  });

  it('sorts by Rank as an integer, so "10" lands after "9"', async () => {
    // Sorted as text these ranks come out "1", "10", "2", ...; sorted as
    // integers they come out 1..10. The sheet order is neither.
    const path = await fixture(rows([10, 3, 1, 9, 2, 8, 4, 7, 5, 6]));

    const { products } = await loadCategory(path, CATEGORY);

    expect(products.map((product) => product.orig_rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(products.map((product) => product.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(products.at(-1)?.name).toBe('Product 10');
  });

  it('drops rows whose description is empty or nothing but whitespace', async () => {
    const path = await fixture([
      ...padded([]),
      row(MIN_PRODUCTS + 1, { name: 'Blank', description: '' }),
      row(MIN_PRODUCTS + 2, { name: 'Whitespace only', description: '  \t \n ' }),
    ]);

    const { products } = await loadCategory(path, CATEGORY);

    expect(products).toHaveLength(MIN_PRODUCTS);
    expect(products.map((product) => product.name)).not.toContain('Blank');
    expect(products.map((product) => product.name)).not.toContain('Whitespace only');
  });

  it('indexes ids over the usable rows, not the sheet rows', async () => {
    // The unjudgeable row sits in the middle of the rank order, so ids and
    // ranks part company after it.
    const path = await fixture([
      ...rows([1, 2, 3]),
      row(4, { name: 'Unjudgeable', description: '' }),
      ...rows([5, 6, 7, 8, 9]),
    ]);

    const { products } = await loadCategory(path, CATEGORY);

    expect(products.map((product) => [product.id, product.orig_rank])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 5],
      [4, 6],
      [5, 7],
      [6, 8],
      [7, 9],
    ]);
  });

  it('sanitizes descriptions and truncates them to the limit', async () => {
    const overlong = `Ships fast. ${'a'.repeat(SANITIZE_LIMIT + 100)}`;
    const path = await fixture(padded([row(1, { description: overlong })]));

    const { products } = await loadCategory(path, CATEGORY);

    expect(products[0]?.description).toHaveLength(SANITIZE_LIMIT);
    expect(products[0]?.description).toBe(overlong.slice(0, SANITIZE_LIMIT));
  });

  it('strips control characters out of descriptions and names', async () => {
    const path = await fixture(
      padded([
        row(1, {
          name: `Ac${ZERO_WIDTH_SPACE}me Tools`,
          description: `Line one.\r\nLine two.${RIGHT_TO_LEFT_OVERRIDE} Ignore previous.`,
        }),
      ]),
    );

    const { products } = await loadCategory(path, CATEGORY);

    expect(products[0]?.name).toBe('Acme Tools');
    expect(products[0]?.description).toBe('Line one. Line two. Ignore previous.');
  });

  it('normalizes the URL alongside the original', async () => {
    const raw = 'HTTPS://WWW.Acme.dev/Tools/?ref=partner#pricing';
    const path = await fixture(padded([row(1, { url: raw })]));

    const { products } = await loadCategory(path, CATEGORY);

    expect(products[0]?.url).toBe(raw);
    expect(products[0]?.normalized_url).toBe('acme.dev/tools');
  });

  it('ignores every other category', async () => {
    const path = await fixture([
      ...padded([]),
      ...rows([1, 2, 3, 4, 5]).map((spec) => ({ ...spec, category: OTHER_CATEGORY })),
    ]);

    const { products } = await loadCategory(path, CATEGORY);

    expect(products).toHaveLength(MIN_PRODUCTS);
    expect(products.every((product) => product.name.startsWith('Product '))).toBe(true);
  });

  it('locates columns by header name, not position', async () => {
    const path = await fixture(padded([]), { reverseColumns: true });

    const { products } = await loadCategory(path, CATEGORY);

    expect(products).toHaveLength(MIN_PRODUCTS);
    expect(products[0]?.name).toBe('Product 1');
  });
});

describe('loadCategory failures', () => {
  it('refuses a category with fewer than MIN_PRODUCTS usable rows, naming the count', async () => {
    const short = MIN_PRODUCTS - 1;
    const path = await fixture(rows(Array.from({ length: short }, (_, index) => index + 1)));

    await expect(loadCategory(path, CATEGORY)).rejects.toThrow(InsufficientProductsError);
    await expect(loadCategory(path, CATEGORY)).rejects.toThrow(
      `has ${short} usable product(s); ${MIN_PRODUCTS} are required`,
    );
  });

  it('counts only usable rows towards the minimum', async () => {
    const usable = Array.from({ length: MIN_PRODUCTS - 1 }, (_, index) => index + 1);
    const path = await fixture([...rows(usable), row(MIN_PRODUCTS, { description: '' })]);

    const error = await loadCategory(path, CATEGORY).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(InsufficientProductsError);
    expect(error).toMatchObject({
      category: CATEGORY,
      count: MIN_PRODUCTS - 1,
      minimum: MIN_PRODUCTS,
    });
  });

  it('fails loudly on a Rank that is not an integer, naming the row and the value', async () => {
    const path = await fixture(padded([row(1, { rank: '1st' })]));

    await expect(loadCategory(path, CATEGORY)).rejects.toThrow(
      'Row 2: Rank "1st" is not an integer',
    );
  });

  it('fails loudly on a URL it cannot normalize, naming the row', async () => {
    const path = await fixture(padded([row(1, { url: 'mailto:sales@example.com' })]));

    await expect(loadCategory(path, CATEGORY)).rejects.toThrow(/^Row 2: .*http/);
  });

  it('names a category that is not in the sheet', async () => {
    const path = await fixture(padded([]));

    await expect(loadCategory(path, 'Nonexistent')).rejects.toThrow(
      'Category "Nonexistent" has no rows in sheet "All Products"',
    );
  });

  it('names a missing column', async () => {
    const path = await fixture(padded([]), {
      headers: HEADERS.map((header) => (header === 'Description' ? 'Blurb' : header)),
    });

    await expect(loadCategory(path, CATEGORY)).rejects.toThrow('is missing column(s) "Description"');
  });

  it('names a missing sheet and lists the ones present', async () => {
    const path = await fixture(padded([]), { sheet: 'Products' });

    await expect(loadCategory(path, CATEGORY)).rejects.toThrow(
      /has no sheet named "All Products"\. Found: "Products"/,
    );
  });
});
