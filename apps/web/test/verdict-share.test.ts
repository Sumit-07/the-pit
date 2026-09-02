/**
 * The share row, and the strings that leave the page on it.
 *
 * `brief` Part 5's rule is the one that matters here: a rank never travels
 * without its product count, and the share row is the surface it travels
 * furthest on. The rest is sinks — HTML attributes, a query string, markdown —
 * and this file checks that each one is escaped for itself and not for one of the
 * others.
 */

import { describe, expect, it } from 'vitest';

import { badgeWidth } from '@/lib/verdict/badge';
import { parseVerdict } from '@/lib/verdict/model';
import { cutsLine } from '@/lib/verdict/page';
import { badgeMarkdown, renderShareRow, shareLine, tweetIntentUrl } from '@/lib/verdict/share';

import { handBuiltVerdict, seededVerdictNamed } from './helpers/verdict.js';

const ORIGIN = 'https://thepit.show';

const SLUG = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe('the verdict line, as it travels', () => {
  it('carries the cuts, the rank, the count and the moment in one line', async () => {
    const line = shareLine(parseVerdict(await seededVerdictNamed('developer-tools', 'Sequo')));

    expect(line).toMatch(/^Unit [A-Za-z]+-\d{3} took 30 in cuts\. · 7 of 48 products on 27 Aug 2026, 14:03 UTC$/);
    // The submitted name is not on it: a seeded listing is anonymous, and the
    // most public string the page produces is the last place to leak it.
    expect(line).not.toContain('Sequo');
  });

  it('never states a rank without its product count and its moment', () => {
    const line = shareLine(parseVerdict(handBuiltVerdict()));

    expect(line).toContain('7 of 48 products');
    expect(line).toContain('27 Aug 2026, 14:03 UTC');
  });

  it('carries `brief` Part 5\'s sentence whole, as the page prints it', () => {
    // Not a re-edit of the sentence for the share surface: `cutsLine` verbatim,
    // full stop and all, and then the stamp. What follows the interpunct is a
    // stamp rather than a second clause.
    const verdict = parseVerdict(handBuiltVerdict());
    expect(shareLine(verdict).startsWith(cutsLine(verdict))).toBe(true);
  });
});

describe('the X intent', () => {
  it('sends the line as text and the permanent URL as a separate parameter', () => {
    const url = new URL(tweetIntentUrl(parseVerdict(handBuiltVerdict()), ORIGIN));

    expect(url.origin + url.pathname).toBe('https://twitter.com/intent/tweet');
    expect(url.searchParams.get('text')).toBe(shareLine(parseVerdict(handBuiltVerdict())));
    expect(url.searchParams.get('url')).toBe(`${ORIGIN}/v/${SLUG}`);
    // The URL is X's own card parameter and must not also be inside the text,
    // where it would be counted a second time.
    expect(url.searchParams.get('text')).not.toContain('thepit.show');
  });

  it('keeps the text inside 200 characters however long the name is', () => {
    const verdict = parseVerdict(handBuiltVerdict({ name: 'A '.repeat(160).trim() }));
    const text = new URL(tweetIntentUrl(verdict, ORIGIN)).searchParams.get('text') ?? '';

    expect(text.length).toBeLessThanOrEqual(200);
    expect(text).toContain('…');
  });

  it('percent-encodes for the query and not for HTML', () => {
    const raw = tweetIntentUrl(parseVerdict(handBuiltVerdict({ name: 'Ampersand & Co "quoted"' })), ORIGIN);

    // One `&` in the whole URL: the separator between `text` and `url`. A name's
    // ampersand is `%26`, and an HTML entity here would be printed literally on
    // somebody's timeline.
    expect(raw.split('&')).toHaveLength(2);
    expect(raw).toContain('%26');
    expect(raw).not.toContain('&amp;');
    expect(new URL(raw).searchParams.get('text')).toContain('Ampersand & Co "quoted"');
  });
});

describe('the README badge markdown', () => {
  it('links the badge image at the verdict it belongs to', () => {
    const markdown = badgeMarkdown(parseVerdict(handBuiltVerdict()), ORIGIN);

    expect(markdown).toBe(
      `[![The Pit: #7 of 48 in Developer Tools](${ORIGIN}/v/${SLUG}/badge.svg)](${ORIGIN}/v/${SLUG})`,
    );
  });

  it('states the count beside the rank in the alt text too', () => {
    expect(badgeMarkdown(parseVerdict(handBuiltVerdict({ rank: 1 })), ORIGIN)).toContain('#1 of 48 in');
  });

  it('neutralises brackets so a label cannot close the markdown early', () => {
    const markdown = badgeMarkdown(parseVerdict(handBuiltVerdict({ category: 'Dev [Tools]' })), ORIGIN);

    expect(markdown).toContain('Dev (Tools)');
    expect(markdown.indexOf(']')).toBe(markdown.indexOf(`](${ORIGIN}`));
  });
});

describe('the share row', () => {
  it('renders all four controls', () => {
    const html = renderShareRow(parseVerdict(handBuiltVerdict()), { origin: ORIGIN });

    expect(html).toContain('<div class="share-row">');
    expect(html).toContain('Copy verdict line');
    expect(html).toContain('Post on X');
    expect(html).toContain('Badge for README');
    expect(html).toContain('Download');
    // Two buttons that copy, one intent, one download, one preview.
    expect(html.match(/data-copy=/g)).toHaveLength(2);
    // Absolute, so the link still resolves in a copy saved to disk.
    expect(html).toContain(`href="${ORIGIN}/v/${SLUG}?download=1"`);
  });

  it('points the preview and the copied markdown at the same badge URL', () => {
    const verdict = parseVerdict(handBuiltVerdict());
    const html = renderShareRow(verdict, { origin: ORIGIN });

    expect(html).toContain(`src="${ORIGIN}/v/${SLUG}/badge.svg"`);
    expect(badgeMarkdown(verdict, ORIGIN)).toContain(`${ORIGIN}/v/${SLUG}/badge.svg`);
    // The preview declares the width the route will actually serve, so the row
    // does not reflow when the image lands.
    expect(html).toContain(`width="${badgeWidth(verdict)}" height="20"`);
  });

  it('copies the line and the URL together, on two lines', () => {
    const html = renderShareRow(parseVerdict(handBuiltVerdict()), { origin: ORIGIN });
    const copy = /data-copy="([^"]*)"/.exec(html)?.[1] ?? '';

    expect(copy).toContain('took 30 in cuts');
    expect(copy).toContain('7 of 48 products');
    // The newline is an entity, not a raw byte inside an attribute.
    expect(copy).toContain('&#10;');
    expect(copy).toContain(`${ORIGIN}/v/${SLUG}`);
  });

  it('flips the label back after a second and a half', () => {
    const html = renderShareRow(parseVerdict(handBuiltVerdict()), { origin: ORIGIN });

    expect(html).toContain("textContent='Copied'");
    expect(html).toContain('1500');
    expect(html).toContain('navigator.clipboard');
    // The fallback for an insecure origin and for the downloaded copy of this
    // page, which is opened from `file://`.
    expect(html).toContain('execCommand');
  });

  it('escapes a hostile name into every attribute it lands in', () => {
    const html = renderShareRow(
      parseVerdict(handBuiltVerdict({ name: '"><script>alert(1)</script>' })),
      { origin: ORIGIN },
    );

    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('&quot;&gt;');
    // Exactly one script element, and it is the copy handler.
    expect(html.match(/<script/g)).toHaveLength(1);
  });

  it('opens the intent in a new tab without handing X an opener', () => {
    const html = renderShareRow(parseVerdict(handBuiltVerdict()), { origin: ORIGIN });

    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });
});
