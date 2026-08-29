/**
 * Step 1 of `01 §4`: the Excel sheet becomes one category's `products.json`.
 *
 * Every failure here is loud. A category that reaches the panels with a
 * silently mis-sorted, mis-indexed or half-empty product list produces a
 * ranking that looks fine and is wrong, which is the one outcome this engine
 * cannot afford.
 */

import ExcelJS from 'exceljs';

import { MIN_PRODUCTS, SANITIZE_LIMIT } from '../config/constants.js';
import type { Product, ProductSet } from '../types.js';
import { normalizeUrl } from './normalize-url.js';
import { sanitize } from './sanitize.js';

/** The workbook tab holding every category. Source: `01 §4` Step 1. */
const SHEET_NAME = 'All Products';

/** The header cells this loader needs. The sheet has others; they are ignored. */
const REQUIRED_COLUMNS = [
  'Category',
  'Rank',
  'Product Name',
  'Description',
  'Website URL',
] as const;

type ColumnName = (typeof REQUIRED_COLUMNS)[number];

/** Header row index, and therefore the row every data row comes after. */
const HEADER_ROW = 1;

/**
 * A category with too few usable products is skipped rather than run
 * (`01 §4` Step 1, `run_category.mjs:396`). It is thrown as its own type so a
 * caller can tell "this category is too small" — an expected, reportable
 * outcome — from "this spreadsheet is malformed".
 */
export class InsufficientProductsError extends Error {
  override readonly name = 'InsufficientProductsError';

  constructor(
    readonly category: string,
    readonly count: number,
    readonly minimum: number,
  ) {
    super(
      `Category ${JSON.stringify(category)} has ${count} usable product(s); ` +
        `${minimum} are required. Skip it rather than forcing a run.`,
    );
  }
}

const quoted = (values: Iterable<string>): string =>
  [...values].map((value) => JSON.stringify(value)).join(', ');

/** Map each required header to its 1-based column index, or fail naming what is missing. */
function locateColumns(sheet: ExcelJS.Worksheet): Record<ColumnName, number> {
  const headers = new Map<string, number>();
  sheet.getRow(HEADER_ROW).eachCell((cell, columnIndex) => {
    headers.set(cell.text.trim(), columnIndex);
  });

  const located: Partial<Record<ColumnName, number>> = {};
  const missing: ColumnName[] = [];
  for (const name of REQUIRED_COLUMNS) {
    const index = headers.get(name);
    if (index === undefined) missing.push(name);
    else located[name] = index;
  }

  if (missing.length > 0) {
    throw new Error(
      `Sheet ${JSON.stringify(SHEET_NAME)} is missing column(s) ${quoted(missing)}. ` +
        `Found: ${quoted(headers.keys())}`,
    );
  }
  // Safe: the loop above filled every key or threw naming the ones it could not.
  return located as Record<ColumnName, number>;
}

/**
 * `Rank` as an integer. Excel hands it back as text, so a lexicographic sort
 * would put "10" before "9" and quietly scramble the seed order. A value that
 * is not a plain integer is a defect in the sheet, not something to guess at.
 */
function parseRank(text: string, rowNumber: number): number {
  const trimmed = text.trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(
      `Row ${rowNumber}: Rank ${JSON.stringify(text)} is not an integer. ` +
        `Fix the sheet; ranks are never sorted as text.`,
    );
  }
  return Number.parseInt(trimmed, 10);
}

/**
 * Read one category out of the workbook.
 *
 * Rows are filtered to `category`, sorted by `Rank` as an integer, then rows
 * whose description sanitizes to nothing are dropped — they cannot be judged.
 * `id` is a 0-based index into what survives, so ids are dense and follow the
 * sheet's own rank order.
 *
 * @throws {InsufficientProductsError} when fewer than `MIN_PRODUCTS` survive.
 */
export async function loadCategory(xlsxPath: string, category: string): Promise<ProductSet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(xlsxPath);

  const sheet = workbook.getWorksheet(SHEET_NAME);
  if (sheet === undefined) {
    throw new Error(
      `${xlsxPath} has no sheet named ${JSON.stringify(SHEET_NAME)}. ` +
        `Found: ${quoted(workbook.worksheets.map((each) => each.name))}`,
    );
  }

  const columns = locateColumns(sheet);
  const usable: Array<Omit<Product, 'id'>> = [];
  let matchedRows = 0;

  sheet.eachRow((row, rowNumber) => {
    const cell = (name: ColumnName): string => row.getCell(columns[name]).text;
    if (rowNumber === HEADER_ROW || cell('Category').trim() !== category) return;
    matchedRows += 1;

    // Parsed before the drop below: `Rank` orders the whole category, so a bad
    // value anywhere in it means the ordering itself cannot be trusted.
    const orig_rank = parseRank(cell('Rank'), rowNumber);

    const description = sanitize(cell('Description'), SANITIZE_LIMIT);
    if (description === '') return;

    const url = cell('Website URL').trim();
    let normalized_url: string;
    try {
      normalized_url = normalizeUrl(url);
    } catch (cause) {
      throw new Error(`Row ${rowNumber}: ${(cause as Error).message}`, { cause });
    }

    usable.push({
      name: sanitize(cell('Product Name'), SANITIZE_LIMIT),
      description,
      url,
      normalized_url,
      orig_rank,
    });
  });

  if (matchedRows === 0) {
    throw new Error(
      `Category ${JSON.stringify(category)} has no rows in sheet ${JSON.stringify(SHEET_NAME)}.`,
    );
  }

  // Ties in `Rank` keep sheet order: `Array#sort` is stable, so the result is
  // deterministic either way (Global Constraint 5).
  usable.sort((a, b) => a.orig_rank - b.orig_rank);

  const products: Product[] = usable.map((product, id) => ({ id, ...product }));

  if (products.length < MIN_PRODUCTS) {
    throw new InsufficientProductsError(category, products.length, MIN_PRODUCTS);
  }

  return { category, products };
}
