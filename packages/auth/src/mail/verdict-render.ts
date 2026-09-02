/**
 * The message that says a paid placement has landed.
 *
 * The third email in the product, and the first one that is not about getting
 * somebody into an account. A customer paid, waited while six jurors read their
 * pitch, and closed the tab; this is the one thing that tells them the wait is
 * over. `brief` Part 6 makes the verdict page "a public permanent URL,
 * shareable, works logged out", so the whole message is a pointer to it.
 *
 * ## What it carries, and what it deliberately does not
 *
 * The four facts of a verdict — the cuts line, the stamped rank, the sharpest
 * juror, the URL — and nothing else. Not the scorecard, not the cluster, not the
 * Floor: those are the page's, the page is permanent, and an email that
 * reproduced them would be a second copy of a document whose whole value is that
 * there is only one of it. A summary that drifted from the page it summarises is
 * the failure mode here, so there is very little to drift.
 *
 * ## Never promise a rank
 *
 * `brief` Part 5: "**Never promise a rank in copy.** The verdict card is stamped
 * with a timestamp and product count precisely because the board moves." This
 * module is given `rankStamp` — a whole sentence produced by `stampedRank` in
 * `apps/web`, the one function on the page that emits a rank — and never a bare
 * number. There is no field here a caller could put `4` in, so there is no way
 * for this email to print a rank without its denominator and its date beside it.
 *
 * ## Escaping
 *
 * Unlike the other two emails, most of what goes in this one is text somebody
 * else wrote: a product name off a submission form and a deduction reason off a
 * model. Every interpolation goes through `escapeHtml`, the same function the
 * verdict page and the auth pages use. The SUBJECT is not HTML and is not
 * escaped — a mail client renders it as text, and `&lt;` in an inbox list would
 * be the bug rather than the fix.
 *
 * ## Idempotency
 *
 * Keyed on the account and the verdict URL, hashed, exactly as
 * `capability-render.ts` does it. A settle is retried by Inngest and the caller's
 * own guard is the ledger's `duplicate` answer; this is the second line of
 * defence, at the provider, for the window between a commit and a crash.
 */

import { createHash } from 'node:crypto';

import { MAIL_BODY_STYLE, MAIL_BUTTON_STYLE, MAIL_MUTED, MAIL_SMALL_STYLE } from './theme.js';
import type { OutboundEmail } from './types.js';
import { escapeHtml } from './render.js';

/** The one deduction the message quotes: the heaviest anywhere on the card. */
export interface VerdictSharpestCut {
  /** The juror who took it. A reason with no author is an anonymous accusation. */
  readonly role: string;
  readonly reason: string;
}

export interface VerdictMessageInput {
  /** The normalized recipient — the address that paid for the placement. */
  readonly email: string;
  /** `From:`, e.g. `The Pit <no-reply@thepit.show>`. */
  readonly from: string;
  /** The listing's name as it was DELIVERED — the designation on an anonymous one. */
  readonly name: string;
  /** `brief` Part 5's connective word, as a number. Rounded here, so subject and body agree. */
  readonly cuts: number;
  /**
   * The rank, its denominator and its date, as one sentence.
   *
   * `stampedRank(verdict)` in `apps/web/src/lib/verdict/page.ts`. A whole string
   * rather than three fields, so this module cannot assemble a rank without the
   * two things `brief` Part 5 requires beside it.
   */
  readonly rankStamp: string;
  /** The heaviest cut on the card, or `null` when nothing came off. */
  readonly sharpest: VerdictSharpestCut | null;
  /** The absolute public verdict URL, e.g. `https://thepit.show/v/<slug>`. */
  readonly url: string;
  /**
   * The absolute capability URL, or `null` when the account has no slug.
   *
   * `capabilityUrl(origin, slug)` — the same URL the account-link email carries
   * and the same one the success page showed. Nothing is minted for this message;
   * it prints the slug the account already has, or prints nothing.
   */
  readonly accountUrl: string | null;
  /** Used only to derive the idempotency key. Never rendered. */
  readonly accountId: string;
}

/**
 * The message key.
 *
 * `sha256(accountId + url)`, truncated — `capabilityIdempotencyKey`'s shape, for
 * the same reason it is a hash there: an idempotency key is displayed in a
 * provider dashboard, a delivery log and a bounce report, and a key that carried
 * the account's own URLs would put them in all three.
 */
export function verdictIdempotencyKey(accountId: string, url: string): string {
  return `verdict:${createHash('sha256').update(`${accountId}\n${url}`, 'utf8').digest('hex').slice(0, 32)}`;
}

/**
 * `brief` Part 5's sentence. Rounded, because cuts are read and not audited.
 *
 * A restatement of `cutsLine` in `apps/web/src/lib/verdict/page.ts`, and a
 * restatement on purpose: `PHASE-0.md §3` runs the dependency from the app toward
 * this package, so the page's copy cannot be imported here. The two are pinned
 * together by `apps/web/test/delivery-mail.test.ts`, which renders a real verdict
 * and asserts the email says exactly what the page says.
 */
export function verdictCutsLine(name: string, cuts: number): string {
  return `${name} took ${Math.round(cuts)} in cuts`;
}

export function renderVerdictEmail(input: VerdictMessageInput): OutboundEmail {
  const line = verdictCutsLine(input.name, input.cuts);
  const safeUrl = escapeHtml(input.url);
  const quote =
    input.sharpest === null ? null : `“${input.sharpest.reason}” — ${input.sharpest.role}`;

  const text = [
    'Your verdict is in',
    '',
    `${line}.`,
    input.rankStamp,
    ...(quote === null ? [] : ['', quote]),
    '',
    input.url,
    '',
    'It is public and permanent; share it.',
    ...(input.accountUrl === null ? [] : ['', `Your attempts and history: ${input.accountUrl}`]),
  ].join('\n');

  const html = [
    '<!doctype html>',
    `<html lang="en"><body style="${MAIL_BODY_STYLE}">`,
    '<h1 style="font-size:20px;margin:0 0 16px">Your verdict is in</h1>',
    `<p style="margin:0 0 8px">${escapeHtml(`${line}.`)}</p>`,
    `<p style="margin:0 0 20px;${MAIL_SMALL_STYLE}">${escapeHtml(input.rankStamp)}</p>`,
    ...(quote === null
      ? []
      : [
          `<blockquote style="margin:0 0 20px;padding:0 0 0 12px;border-left:2px solid ${MAIL_MUTED}">`,
          `${escapeHtml(quote)}</blockquote>`,
        ]),
    `<p style="margin:0 0 24px"><a href="${safeUrl}" style="${MAIL_BUTTON_STYLE}">Read the verdict</a></p>`,
    `<p style="margin:0 0 20px;word-break:break-all;${MAIL_SMALL_STYLE}">${safeUrl}</p>`,
    `<p style="margin:0${input.accountUrl === null ? '' : ' 0 8px'};${MAIL_SMALL_STYLE}">It is public and permanent; share it.</p>`,
    ...(input.accountUrl === null
      ? []
      : [
          `<p style="margin:0;word-break:break-all;${MAIL_SMALL_STYLE}">Your attempts and history: `,
          `${escapeHtml(input.accountUrl)}</p>`,
        ]),
    '</body></html>',
  ].join('');

  return {
    to: input.email,
    from: input.from,
    subject: `Your verdict is in: ${line}`,
    text,
    html,
    idempotencyKey: verdictIdempotencyKey(input.accountId, input.url),
  };
}
