/**
 * `brief` Part 5, checked character by character.
 *
 * The five fixed strings are re-typed here from the brief rather than imported
 * and compared to themselves, so this file is a second copy of the specification
 * and a reworded homepage fails rather than quietly redefining the brand. The
 * rendering assertions then prove those exact words reach the document — a
 * constant nobody renders is not copy.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';

import { CLOSER_PARTS, COPY, HEADLINE_PARTS, STAMP_NOTE, cutsSentence } from '@/lib/boards/copy';
import Home from '@/app/page';
import BoardPage from '@/app/boards/[slug]/page';

import { textOf, writeSeededWorkdir } from './helpers/boards';
import { rm } from 'node:fs/promises';

const scratch: string[] = [];

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
  delete process.env['PIT_WORKDIR'];
});

async function renderHome(): Promise<string> {
  const workdir = await writeSeededWorkdir({ slug: 'developer-tools' });
  scratch.push(workdir);
  process.env['PIT_WORKDIR'] = workdir;
  return renderToStaticMarkup(await Home());
}

describe('the five fixed strings', () => {
  it('are `brief` Part 5, exactly', () => {
    expect(COPY.headline).toBe("You can't outbid the pit.");
    expect(COPY.sub).toBe('Everyone walks in at 100. Fewest cuts wins.');
    expect(COPY.terms).toBe("$5 to enter. That's all money does here.");
    expect(COPY.cta).toBe('Throw it in · $5');
    expect(COPY.closer).toBe('Throwing money in the pit just makes noise.');
  });

  it('splits for the type treatment without rewriting anything', () => {
    expect(HEADLINE_PARTS.join(' ')).toBe(COPY.headline);
    expect(CLOSER_PARTS.join(' ')).toBe(COPY.closer);
  });

  it('keeps Part 5’s register for a score', () => {
    // Part 5's own example sentence.
    expect(cutsSentence('Runlet', 97)).toBe('Runlet took 97 in cuts.');
  });
});

describe('the homepage says them', () => {
  it('renders the headline, the sub, the terms line and the CTA verbatim', async () => {
    const text = textOf(await renderHome());
    expect(text).toContain(COPY.headline);
    expect(text).toContain(COPY.sub);
    expect(text).toContain(COPY.terms);
    expect(text).toContain(COPY.cta);
    expect(text).toContain(COPY.closer);
  });

  it('keeps the connective word on the surface', async () => {
    // `brief` Part 5: "Connective word: *cuts*. Keep it on every surface."
    const text = textOf(await renderHome());
    expect(text).toContain('Fewest cuts wins');
    expect(text).toContain('Cuts');
    expect(text).toContain('Cuts on the record');
  });

  it('never promises a rank, and never claims a placement has landed', async () => {
    const text = textOf(await renderHome());
    expect(text).not.toMatch(/\bguarantee/i);
    expect(text).not.toMatch(/\byour rank\b/i);
    expect(text).not.toMatch(/\bwill rank\b/i);
    // The strip carries cuts already on the record; it does not announce arrivals
    // from a feed that does not exist yet.
    expect(text).toContain('nothing here is a rank');
  });

  it('points the CTA at /submit, live, with no form embedded on this surface', async () => {
    // The paid path is complete end to end, so the CTA is a real link and not a
    // disabled button — but the homepage itself still renders no form and no
    // input; the form lives on `/submit`, one click away.
    const html = await renderHome();
    expect(html).not.toContain('<form');
    expect(html).not.toContain('<input');
    expect(html).not.toContain('disabled=""');
    expect(html).toMatch(/<a class="cta" href="\/submit"[^>]*>/);
    expect(textOf(html)).toContain('the door’s open');
  });

  it('shows the board itself, above the three panels', async () => {
    const html = await renderHome();
    const boardAt = html.indexOf('class="board"');
    const panelsAt = html.indexOf('class="three"');
    expect(boardAt).toBeGreaterThan(-1);
    expect(panelsAt).toBeGreaterThan(boardAt);
    expect(html).toContain('Ashgrove');
  });
});

describe('the board page behind it stays plain', () => {
  it('carries the connective word and the no-promise stamp, and none of the shouting', async () => {
    const workdir = await writeSeededWorkdir({ slug: 'developer-tools' });
    scratch.push(workdir);
    process.env['PIT_WORKDIR'] = workdir;

    const text = textOf(
      renderToStaticMarkup(
        await BoardPage({ params: Promise.resolve({ slug: 'developer-tools' }) }),
      ),
    );

    expect(text).toContain('Cuts');
    expect(text).toContain('Runlet took 97 in cuts');
    expect(text).toContain(STAMP_NOTE);
    // Part 5: aggressive on the homepage, plain everywhere behind it.
    expect(text).not.toContain(COPY.headline);
    expect(text).not.toContain(COPY.closer);
  });
});
