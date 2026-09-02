/**
 * The emails are the only surfaces in the product a customer sees before the
 * website, and the only ones that cannot use the token system: mail clients strip
 * `<style>` blocks and do not resolve CSS custom properties, so every colour has
 * to be an inline literal.
 *
 * Literals are what drift. These tests fix the two things that actually go wrong
 * with a themed email — the palette quietly diverging from the site's, and the
 * small print falling below AA on a dark ground — and one that already had:
 * before this pass both emails still carried `#0b0b0c` on `#e8e8ea` in
 * `system-ui`, the palette the redesign replaced everywhere else, because the
 * magic-link SCREENS were brought onto the shared theme and the emails that send
 * people to them were not.
 *
 * `apps/web/test/theme-drift.test.ts` is the other half: it reads
 * `src/mail/theme.ts` and fails if a value here stops matching the site token it
 * is a copy of. The dependency points from the app toward this package, so
 * `PHASE-0.md §3` is untouched.
 */

import { describe, expect, it } from 'vitest';

import { renderCapabilityEmail } from '../src/mail/capability-render.js';
import { renderMagicLinkEmail } from '../src/mail/render.js';
import { MAIL_GROUND, MAIL_INK, MAIL_MUTED } from '../src/mail/theme.js';
import { renderVerdictEmail } from '../src/mail/verdict-render.js';

const MAGIC = renderMagicLinkEmail({
  email: 'founder@example.com',
  from: 'The Pit <no-reply@thepit.show>',
  verifyUrl: 'https://thepit.show/auth/verify',
  rawToken: 'tok_abc123',
  idempotencyKey: 'idem_1',
});

const CAPABILITY = renderCapabilityEmail({
  email: 'founder@example.com',
  from: 'The Pit <no-reply@thepit.show>',
  accountId: 'acct_1',
  url: 'https://thepit.show/a/k7m2q9x4hd82',
});

const VERDICT = renderVerdictEmail({
  email: 'founder@example.com',
  from: 'The Pit <no-reply@thepit.show>',
  name: 'Runlet',
  cuts: 96.7,
  rankStamp: '4 of 48 products on 27 Aug 2026, 14:03 UTC',
  sharpest: { role: 'Skeptic', reason: 'The pricing page names no number.' },
  url: 'https://thepit.show/v/quiet-anvil-4821',
  accountUrl: 'https://thepit.show/a/k7m2q9x4hd82',
  accountId: 'acct_1',
});

/**
 * Every email the product sends. A new one that skipped this list would be the
 * exact drift this file exists to catch, so it is a list and not two constants.
 */
const EVERY_EMAIL = [
  ['the sign-in email', MAGIC.html],
  ['the account-link email', CAPABILITY.html],
  ['the verdict email', VERDICT.html],
] as const;

function channels(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function contrast(a: string, b: string): number {
  const linear = (v: number): number => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (hex: string): number => {
    const [r, g, bl] = channels(hex);
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(bl);
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('the emails are the same product as the site', () => {
  for (const [name, html] of EVERY_EMAIL) {
    it(`${name} is set on the site's ground, in the site's ink`, () => {
      expect(html).toContain(`background:${MAIL_GROUND}`);
      expect(html).toContain(`color:${MAIL_INK}`);
    });

    it(`${name} carries none of the palette the redesign replaced`, () => {
      // The specific values that were still here, so this cannot silently return.
      expect(html).not.toContain('#0b0b0c');
      expect(html).not.toContain('#e8e8ea');
      // And the typeface that made them look like a different product.
      expect(html).not.toContain('system-ui');
      expect(html).toContain('Archivo');
    });

    it(`${name} spends no colour, because a mail client cannot be trusted with one`, () => {
      // `--cut` is the system's only hue and it means exactly one thing: a
      // quantity taken, read off a chart. None of these messages draws one — the
      // verdict email points AT the page that does — and a hue that appeared here
      // would be decoration wearing the meaning of a deduction.
      const hexes = new Set((html.match(/#[0-9a-fA-F]{3,6}/g) ?? []).map((found) => found.toUpperCase()));
      for (const found of hexes) {
        const [r, g, b] = channels(found);
        expect(Math.max(r, g, b) - Math.min(r, g, b), `${found} is a hue, in an email that has nothing to say with one`).toBeLessThan(20);
      }
    });
  }
});

describe('the small print survives a dark ground', () => {
  for (const [name, html] of EVERY_EMAIL) {
    it(`${name} states its muted colour instead of leaning on opacity`, () => {
      // `opacity:.7` is inconsistently supported across mail clients, and the
      // tone it landed on here was below AA. A resolved hex is both portable and
      // checkable — which is what lets the next test exist at all.
      expect(html).not.toContain('opacity:');
      expect(html).toContain(`color:${MAIL_MUTED}`);
    });
  }

  it('clears WCAG AA for every tone these emails put on the ground', () => {
    expect(contrast(MAIL_INK, MAIL_GROUND)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(MAIL_MUTED, MAIL_GROUND)).toBeGreaterThanOrEqual(4.5);
    // The one button inverts — the ground becomes the type on a lit fill.
    expect(contrast(MAIL_GROUND, MAIL_INK)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('re-theming changed nothing a reader reads', () => {
  it('leaves the sign-in email saying what it said', () => {
    expect(MAGIC.subject).toBe('Sign in to The Pit');
    expect(MAGIC.html).toContain('Open the sign-in page');
    expect(MAGIC.html).toContain('Press the button.');
    expect(MAGIC.text).toContain('Sign in to The Pit');
  });

  it('leaves the account-link email saying what it said', () => {
    expect(CAPABILITY.subject).toBe('Your account link for The Pit');
    expect(CAPABILITY.html).toContain('Open my account');
    expect(CAPABILITY.html).toContain('Bookmark this.');
  });

  it('leaves the verdict email saying what it said', () => {
    expect(VERDICT.subject).toBe('Your verdict is in: Runlet took 97 in cuts');
    expect(VERDICT.html).toContain('Read the verdict');
    expect(VERDICT.html).toContain('It is public and permanent; share it.');
  });

  it('still escapes the link it was handed, which the styling sits next to', () => {
    const hostile = renderCapabilityEmail({
      email: 'founder@example.com',
      from: 'The Pit <no-reply@thepit.show>',
      accountId: 'acct_1',
      url: 'https://thepit.show/a/"><script>alert(1)</script>',
    });
    expect(hostile.html).not.toContain('<script>alert(1)');
    expect(hostile.html).toContain('&lt;script&gt;');
  });
});
