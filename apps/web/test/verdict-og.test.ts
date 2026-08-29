/**
 * The share card's copy.
 *
 * `brief` Part 6 names what has to be on it — "name, cuts total, rank, the
 * sharpest juror line" — and `brief` Part 5 adds the rule that makes the rank
 * safe to put there at all. Both are checked here rather than on the image,
 * because the image is a picture and these are requirements.
 */

import { describe, expect, it } from 'vitest';

import { parseVerdict } from '@/lib/verdict/model';
import { ogFields, trimTo } from '@/lib/verdict/og';

import { handBuiltVerdict, seededVerdictNamed } from './helpers/verdict.js';

describe('what the share card says', () => {
  it('carries the four things brief Part 6 asks for', async () => {
    const fields = ogFields(parseVerdict(await seededVerdictNamed('developer-tools', 'Sequo')));

    // 1. the name
    expect(fields.name).toContain('Sequo');
    // 2. the cuts total — 100 - mean(87.5, 86.667, 57.5, 35, 81.667) = 30.333
    expect(fields.cuts).toBe('30');
    expect(fields.cutsLabel).toBe('took 30 in cuts');
    // 3. the rank, stamped
    expect(fields.rank).toBe('7 of 48 products · 27 Aug 2026, 14:03 UTC');
    // 4. the sharpest juror line, with the juror
    expect(fields.quote).toContain('Convenience layer over project-memory features');
    expect(fields.attribution).toBe('The Platform Owner · −80 on Durability');

    expect(fields.eyebrow).toBe('THE PIT · VERDICT · DEVELOPER TOOLS');
  });

  it('never states the rank without its product count and its moment', async () => {
    const fields = ogFields(parseVerdict(await seededVerdictNamed('developer-tools', 'Carillon')));

    expect(fields.rank).toContain('of 48 products');
    expect(fields.rank).toContain('27 Aug 2026, 14:03 UTC');
    // A bare rank would be two characters. Anything that short means one of the
    // two stamps was dropped.
    expect(fields.rank.length).toBeGreaterThan(20);
  });

  it('shows the pitch ordinal when there is one, and nothing when there is not', async () => {
    expect(ogFields(parseVerdict(handBuiltVerdict({ attemptNumber: 3 }))).pitch).toBe('3rd pitch');
    expect(ogFields(parseVerdict(handBuiltVerdict({ attemptNumber: null }))).pitch).toBe('');
    expect(ogFields(parseVerdict(await seededVerdictNamed('developer-tools', 'Sequo'))).pitch).toBe('');
  });

  it('leaves the quote empty rather than inventing one when nothing was cut', () => {
    const fields = ogFields(
      parseVerdict(
        handBuiltVerdict({
          scorecard: [
            { metric: 'Trust Surface', score: 100, spread: 0, juror_count: 6, substituted_roles: [], deductions: [] },
          ],
        }),
      ),
    );

    expect(fields.cuts).toBe('0');
    expect(fields.quote).toBe('');
    expect(fields.attribution).toBe('');
  });

  it('hands the layout raw text, not HTML entities', () => {
    // The sink is a text layout engine, not an HTML parser. Escaping for the
    // wrong sink is how `&amp;` ends up printed on an image.
    const fields = ogFields(parseVerdict(handBuiltVerdict({ name: 'A <script> & "B"' })));

    expect(fields.name).toBe('A <script> & "B"');
    expect(fields.name).not.toContain('&amp;');
    expect(fields.name).not.toContain('&lt;');
  });
});

describe('trimming to fit', () => {
  it('leaves short text alone', () => {
    expect(trimTo('No rollback statement.', 60)).toBe('No rollback statement.');
  });

  it('breaks on a word boundary and marks the cut', () => {
    const trimmed = trimTo('the quick brown fox jumps over the lazy dog', 20);
    expect(trimmed).toBe('the quick brown…');
    expect(trimmed.length).toBeLessThanOrEqual(20);
  });

  it('cuts mid-word rather than losing most of the line to one long word', () => {
    const trimmed = trimTo('a supercalifragilisticexpialidocious claim', 20);
    expect(trimmed).toBe('a supercalifragilis…');
  });

  it('collapses the whitespace a submitted description may carry', () => {
    expect(trimTo('  two   lines\nof text  ', 40)).toBe('two lines of text');
  });
});
