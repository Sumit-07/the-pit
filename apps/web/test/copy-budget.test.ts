/**
 * The twenty-word rule, as a test.
 *
 * ## What it is for
 *
 * The founder's note on this app was that "there are lots of places where
 * unnecessary justification is being given to what is being done". The audit that
 * followed found the same shape everywhere: a heading, then a paragraph arguing
 * that the thing under it is legitimate — why the panel disagrees on purpose, why
 * a harsh juror cannot outvote a lenient one, why anonymity is frozen before
 * scoring, why money cannot buy a position, why a session cookie does not sign
 * anybody out. None of it is wrong. All of it is the product defending itself to
 * somebody who has not accused it of anything.
 *
 * The useful thing about that failure is that it has a LENGTH. Every string in
 * this app that still carries the voice is short — `Nothing left to throw.`,
 * `Done. Every cut is in.`, `Attempts never expire.`, `Stopped. This one needs a
 * person.` — and every string that had lost it was long. Justification cannot be
 * written briefly: to defend a decision you must first restate it, then give the
 * reason, then handle the objection. So a word budget catches the thing the
 * founder actually objected to, and it catches it in a way a reviewer can run.
 *
 * Twenty words is the number the audit was applied at, and it is generous — the
 * copy this test guards mostly lands between four and twelve.
 *
 * ## Sentences, not string literals
 *
 * A literal-by-literal check would be trivial to satisfy and worthless: the copy
 * these modules emit is assembled from concatenated fragments, so `'We reduce
 * this to an identity — no protocol, ' + 'no www., no tracking parameters.'` is
 * two short literals and one long sentence. What a reader meets is the sentence,
 * so that is the unit. Each surface is rendered with a fixture, the markup is
 * stripped, and every sentence in the result is measured.
 *
 * ## What is exempt, and why
 *
 * Two things, both narrow:
 *
 * - **The data-bearing surfaces are not measured at all** — the board and the
 *   verdict page. A juror's reason, a buyer's reason and a persona biography are
 *   written by the panel, are the thing a customer paid to read, and are quoted
 *   verbatim there. A budget over those would be a budget on the jury's prose, so
 *   the surfaces listed below are the chrome ones: the shared board strings, the
 *   auth screens, `/account` and `/submit`.
 * - **`ALLOW`** — individual sentences that carry a real obligation and cannot be
 *   said shorter. Every entry needs a reason next to it, and the list is meant to
 *   stay short enough to read. It is a ledger of exceptions, not a pressure valve:
 *   if it starts growing, the rule is being routed around rather than kept.
 *
 * `test/boards-copy.test.ts` still pins the `brief` Part 5 strings that may not
 * be reworded at all. This test is the floor under everything else.
 */

import { describe, expect, it } from 'vitest';

import {
  BOARD_LEDE,
  COPY,
  HEALTH_NOTE,
  HOME_LEGEND,
  SOLO_NOTE,
  STAMP_NOTE,
} from '@/lib/boards/copy';
import { renderAccountPage, renderSignedOutPage } from '@/lib/account/page';
import { EMPTY_FORM, renderSubmitPage } from '@/lib/checkout/page';
import * as authPages from '@/lib/auth/pages';

/** The budget. Prose longer than this is, in this app, always a justification. */
const LIMIT = 20;

/**
 * Sentences that carry an obligation and cannot be shortened without dropping it.
 *
 * Each one needs its reason stated here. Adding an entry to silence a failure,
 * rather than because the sentence genuinely cannot be cut, defeats the test.
 */
const ALLOW: readonly { readonly text: string; readonly why: string }[] = [
  {
    // An account-enumeration defence: it has to be true whether or not the
    // address has an account, which is what makes it long.
    text: 'If that address has an account, a sign-in link is on its way.',
    why: 'enumeration defence — the hedge IS the security property',
  },
];

function allowed(sentence: string): boolean {
  return ALLOW.some((entry) => sentence.includes(entry.text));
}

/** Markup out, entities out, whitespace collapsed. What a reader actually sees. */
function visibleText(html: string): string {
  return html
    .replaceAll(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    // A block boundary ENDS a sentence. Without this a heading with no full stop
    // runs into the paragraph under it and the two are measured as one long
    // sentence — which would report a phantom failure and, worse, hide a real
    // one behind it.
    .replaceAll(/<\/?(?:p|div|li|ul|ol|h[1-6]|section|header|footer|nav|br|td|tr|title|figcaption|blockquote|label|option)\b[^>]*>/gi, ' . ')
    .replaceAll(/<[^>]+>/g, ' ')
    .replaceAll('&middot;', '·')
    .replaceAll('&mdash;', '—')
    .replaceAll('&rsquo;', '’')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll(/&[a-z]+;/gi, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

/**
 * Text into sentences.
 *
 * Split on a terminator followed by a capital, so `linear.app is enough` and
 * `$5.` do not become two sentences. A list item or a heading with no terminator
 * is one sentence, which is what we want to measure it as.
 */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z“"‘'])/u)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** Words, ignoring bare numbers, symbols and mono figure runs. */
function wordCount(sentence: string): number {
  return sentence.split(/\s+/u).filter((word) => /[A-Za-z]{2,}/u.test(word)).length;
}

function overBudget(html: string): { sentence: string; words: number }[] {
  return sentences(visibleText(html))
    .filter((sentence) => !allowed(sentence))
    .map((sentence) => ({ sentence, words: wordCount(sentence) }))
    .filter((entry) => entry.words > LIMIT);
}

/** A fixture with nothing withheld, so every optional block renders. */
const ACCOUNT_VIEW: Parameters<typeof renderAccountPage>[0] = {
  accountId: 'acc_1',
  email: 'founder@example.com',
  balance: 2,
  purchases: [
    {
      orderId: 'ord_1',
      amountCents: 500,
      currency: 'USD',
      attemptsGranted: 1,
      includesFitReport: false,
      createdAt: new Date('2026-08-27T14:03:00Z'),
    },
  ],
  listings: [
    {
      productId: 'prod_1',
      name: 'Runlet',
      url: 'https://runlet.dev',
      categorySlug: 'developer-tools',
      status: 'delivered',
      verdictSlug: '838caab9fd742cfd06a0fd120c5e7d83',
      attemptNumber: 1,
      deliveredAt: new Date('2026-08-27T14:03:00Z'),
    },
  ],
  capabilityUrl: 'https://thepit.show/a/abc123',
  github: { linked: false },
};

const SUBMIT_VIEW: Parameters<typeof renderSubmitPage>[0] = {
  categories: ['developer-tools', 'health-fitness-wellness'],
  tiers: [
    { id: 'single', label: '$5', amountCents: 500, attempts: 1, includesFitReport: false },
  ] as unknown as Parameters<typeof renderSubmitPage>[0]['tiers'],
  values: EMPTY_FORM,
  descriptionLimit: 300,
  signedIn: false,
};

describe('the twenty-word rule', () => {
  it('holds every shared board string to the budget', () => {
    const shared = { COPY: Object.values(COPY), BOARD_LEDE, HEALTH_NOTE, HOME_LEGEND, SOLO_NOTE, STAMP_NOTE };
    for (const [name, value] of Object.entries(shared)) {
      for (const text of Array.isArray(value) ? value : [value]) {
        expect(wordCount(text), `${name}: ${text}`).toBeLessThanOrEqual(LIMIT);
      }
    }
  });

  it('holds the auth and capability screens to the budget', () => {
    // Every zero-argument page in the module, so a screen added later is covered
    // without anybody remembering to list it here.
    const rendered = Object.entries(authPages)
      .filter((entry): entry is [string, () => string] => typeof entry[1] === 'function' && entry[1].length === 0)
      .map(([name, render]) => [name, render()] as const);

    expect(rendered.length).toBeGreaterThan(5);
    for (const [name, html] of rendered) {
      expect(overBudget(html), name).toEqual([]);
    }
  });

  it('holds the pages that take an argument to the budget', () => {
    const pages: [string, string][] = [
      ['requestResultPage', authPages.requestResultPage('Check your inbox.')],
      ['verifyButtonPage', authPages.verifyButtonPage('token')],
      ['capabilityHandoffPage', authPages.capabilityHandoffPage({ url: 'https://thepit.show/a/x', email: 'a@b.c' })],
      ['capabilityRotatedPage', authPages.capabilityRotatedPage('https://thepit.show/a/y')],
    ];
    for (const [name, html] of pages) {
      expect(overBudget(html), name).toEqual([]);
    }
  });

  it('holds /account to the budget, signed in and signed out', () => {
    expect(overBudget(renderAccountPage(ACCOUNT_VIEW)), 'signed in').toEqual([]);
    expect(overBudget(renderSignedOutPage()), 'signed out').toEqual([]);
  });

  it('holds /submit to the budget', () => {
    expect(overBudget(renderSubmitPage(SUBMIT_VIEW)), 'submit').toEqual([]);
  });

  it('holds /submit signed in, which adds a line', () => {
    expect(overBudget(renderSubmitPage({ ...SUBMIT_VIEW, signedIn: true })), 'signed in').toEqual([]);
  });

  it('keeps the exception list short and reasoned', () => {
    // A growing allow-list means the rule is being routed around. Every entry
    // carries a reason; the cap is the pressure that keeps it honest.
    expect(ALLOW.length).toBeLessThanOrEqual(5);
    for (const entry of ALLOW) expect(entry.why.length).toBeGreaterThan(10);
  });
});
