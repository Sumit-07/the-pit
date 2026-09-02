/**
 * The delivery email, as a document.
 *
 * The other two emails interpolate a URL this codebase built out of a base and a
 * base64url token. This one interpolates a product NAME off a submission form and
 * a deduction REASON off a model, into HTML, and mails it to somebody. That is
 * the first email in the product where escaping is load-bearing rather than
 * precautionary, so it is what most of this file is about.
 *
 * The other half is `brief` Part 5's rank rule: the message is handed a whole
 * stamped sentence and never a bare number, and there is no input here that would
 * let it print one.
 */

import { describe, expect, it } from 'vitest';

import { renderVerdictEmail, verdictIdempotencyKey } from '../src/index.js';

const INPUT = {
  email: 'founder@example.com',
  from: 'The Pit <no-reply@thepit.show>',
  name: 'Runlet',
  cuts: 96.7,
  rankStamp: '4 of 48 products on 27 Aug 2026, 14:03 UTC',
  sharpest: { role: 'Skeptic', reason: 'The pricing page names no number.' },
  url: 'https://thepit.show/v/quiet-anvil-4821',
  accountUrl: 'https://thepit.show/a/k7m2q9x4hd82',
  accountId: 'acct_1',
};

describe('the subject line', () => {
  it('says the verdict is in and what it cost, rounded', () => {
    expect(renderVerdictEmail(INPUT).subject).toBe('Your verdict is in: Runlet took 97 in cuts');
  });

  it('is not escaped, because an inbox list renders text and not HTML', () => {
    // `&lt;` in a subject line would be the bug, not the fix.
    const message = renderVerdictEmail({ ...INPUT, name: '<b>Runlet</b>' });
    expect(message.subject).toBe('Your verdict is in: <b>Runlet</b> took 97 in cuts');
  });
});

describe('the body', () => {
  const message = renderVerdictEmail(INPUT);

  it('carries a plain-text alternative — a HTML-only mail scores worse with filters', () => {
    expect(message.text).toContain('Runlet took 97 in cuts.');
    expect(message.text).toContain('https://thepit.show/v/quiet-anvil-4821');
  });

  it('stamps the rank with its denominator and its date (brief Part 5)', () => {
    // Never a bare number: the module is given the whole sentence, so there is no
    // input it could print a promise out of.
    expect(message.text).toContain('4 of 48 products on 27 Aug 2026, 14:03 UTC');
    expect(message.html).toContain('4 of 48 products on 27 Aug 2026, 14:03 UTC');
  });

  it('quotes the sharpest juror, and names them', () => {
    expect(message.text).toContain('“The pricing page names no number.” — Skeptic');
    expect(message.html).toContain('“The pricing page names no number.” — Skeptic');
  });

  it('links the public verdict URL once, as a button and as text', () => {
    expect(message.html).toContain(
      '<a href="https://thepit.show/v/quiet-anvil-4821"',
    );
    expect(message.html).toContain('Read the verdict');
    // The bare URL too, for a client that strips the button.
    expect(message.html).toContain('>https://thepit.show/v/quiet-anvil-4821</p>');
  });

  it('says what the URL is', () => {
    expect(message.text).toContain('It is public and permanent; share it.');
    expect(message.html).toContain('It is public and permanent; share it.');
  });

  it('carries the account link the capability email already mints', () => {
    expect(message.text).toContain('Your attempts and history: https://thepit.show/a/k7m2q9x4hd82');
    expect(message.html).toContain('https://thepit.show/a/k7m2q9x4hd82');
  });

  it('says nothing about an account that has no slug', () => {
    const noSlug = renderVerdictEmail({ ...INPUT, accountUrl: null });
    expect(noSlug.text).not.toContain('attempts and history');
    expect(noSlug.html).not.toContain('attempts and history');
    // And the verdict is still delivered, which is the whole message.
    expect(noSlug.text).toContain('https://thepit.show/v/quiet-anvil-4821');
  });

  it('draws no quote when nothing came off the card', () => {
    const clean = renderVerdictEmail({ ...INPUT, sharpest: null });
    expect(clean.html).not.toContain('<blockquote');
    expect(clean.text).toContain('Runlet took 97 in cuts.');
  });

  it('keeps every sentence it wrote itself under twenty words', () => {
    // The copy is ours; the name and the juror's reason are not. Strip the two
    // lines that carry somebody else's text and check what is left.
    const ours = renderVerdictEmail({ ...INPUT, name: 'X', sharpest: null })
      .text.split('\n')
      .filter((sentence) => sentence !== '');
    for (const sentence of ours) {
      expect(sentence.split(/\s+/).length, sentence).toBeLessThanOrEqual(20);
    }
  });
});

describe('escaping, because none of this text is ours', () => {
  const hostile = renderVerdictEmail({
    ...INPUT,
    name: '<script>alert(1)</script>',
    sharpest: { role: 'Skeptic & Co', reason: '"cheap" <img src=x onerror=alert(1)>' },
    url: 'https://thepit.show/v/a?b=1&c=2',
    accountUrl: 'https://thepit.show/a/"><script>alert(2)</script>',
  });

  it('escapes a product name carrying markup', () => {
    expect(hostile.html).not.toContain('<script>alert(1)');
    expect(hostile.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes a juror reason carrying markup', () => {
    expect(hostile.html).not.toContain('<img src=x');
    expect(hostile.html).toContain('&lt;img src=x');
    expect(hostile.html).toContain('Skeptic &amp; Co');
  });

  it('escapes both URLs into the attributes and the text they sit in', () => {
    expect(hostile.html).toContain('href="https://thepit.show/v/a?b=1&amp;c=2"');
    expect(hostile.html).not.toContain('<script>alert(2)');
  });

  it('leaves the plain-text alternative alone, because it is not markup', () => {
    expect(hostile.text).toContain('<script>alert(1)</script> took 97 in cuts.');
  });
});

describe('the idempotency key', () => {
  it('is derived from the account and the URL, and carries neither', () => {
    const key = verdictIdempotencyKey('acct_1', INPUT.url);
    expect(key).toMatch(/^verdict:[0-9a-f]{32}$/);
    expect(key).not.toContain('acct_1');
    expect(key).not.toContain('quiet-anvil');
    expect(renderVerdictEmail(INPUT).idempotencyKey).toBe(key);
  });

  it('is stable across renders and different per verdict', () => {
    expect(verdictIdempotencyKey('acct_1', INPUT.url)).toBe(verdictIdempotencyKey('acct_1', INPUT.url));
    expect(verdictIdempotencyKey('acct_1', 'https://thepit.show/v/other')).not.toBe(
      verdictIdempotencyKey('acct_1', INPUT.url),
    );
  });
});
