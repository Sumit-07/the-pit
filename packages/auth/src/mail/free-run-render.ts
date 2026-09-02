/**
 * The message that stands between a free submission and the panel reading it.
 *
 * The fourth email in the product, and the second one whose link must not be
 * spent by a machine. `brief §2.1` already argued that case for the magic link:
 *
 * > Corporate mail scanners (Outlook Safe Links) follow GET links and would burn
 * > single-use tokens. Do not skip this.
 *
 * The same rule applies here for a bigger stake. A scanner that started the run
 * would spend six juror calls before the founder had opened the mail, and the
 * page they eventually reached would say the verdict was already on its way to
 * somebody. So this link goes to a page that renders a BUTTON, and the button
 * POSTs. The copy says "press" for that reason and not as a figure of speech.
 *
 * ## One button, and nothing to read around it
 *
 * The person opening this typed four fields ninety seconds ago. They do not need
 * the product explained back to them, they need the one control. Everything that
 * is not the button is the expiry and the opt-out, both of which are obligations.
 *
 * ## Escaping
 *
 * The URL is built from a base, a uuid and a base64url token, so nothing in it
 * needs escaping today. It is escaped anyway, for the reason `render.ts` gives:
 * "today" is doing a lot of work in that sentence.
 */

import { createHash } from 'node:crypto';

import { FREE_RUN_SUBMISSION_PARAM, FREE_RUN_TOKEN_PARAM, FREE_RUN_TOKEN_TTL_MS } from '../session/free-run-token.js';
import { MAIL_BODY_STYLE, MAIL_BUTTON_STYLE, MAIL_SMALL_STYLE } from './theme.js';
import { escapeHtml } from './render.js';
import type { OutboundEmail } from './types.js';

export interface FreeRunMessageInput {
  /** The normalized recipient — the address the token was signed for. */
  readonly email: string;
  /** `From:`, e.g. `The Pit <no-reply@thepit.show>`. */
  readonly from: string;
  /** The product, as the submitter named it. Escaped on the way into the body. */
  readonly name: string;
  /** The absolute confirm URL, token and all. See `freeRunConfirmUrl`. */
  readonly confirmUrl: string;
  /** Derived from the submission id; never carries the token. */
  readonly idempotencyKey: string;
}

const TTL_HOURS = FREE_RUN_TOKEN_TTL_MS / 3_600_000;

/**
 * The confirm link.
 *
 * `URL` rather than string concatenation so a base with an existing query, a
 * missing slash, or a trailing one all produce the same well-formed result, and
 * so both values are percent-encoded by something that knows the rules.
 */
export function freeRunConfirmUrl(confirmUrl: string, submissionId: string, token: string): string {
  const url = new URL(confirmUrl);
  url.searchParams.set(FREE_RUN_SUBMISSION_PARAM, submissionId);
  url.searchParams.set(FREE_RUN_TOKEN_PARAM, token);
  return url.toString();
}

/**
 * The message key: `sha256(submissionId)`, truncated.
 *
 * Hashed for the reason `capability-render.ts` and `verdict-render.ts` hash
 * theirs — an idempotency key is displayed in a provider dashboard, a delivery
 * log and a bounce report — and derived from the submission rather than from the
 * token, so the bearer credential cannot leak through the key.
 */
export function freeRunIdempotencyKey(submissionId: string): string {
  return `free-run:${createHash('sha256').update(submissionId, 'utf8').digest('hex').slice(0, 32)}`;
}

export function renderFreeRunEmail(input: FreeRunMessageInput): OutboundEmail {
  const safeLink = escapeHtml(input.confirmUrl);
  const safeName = escapeHtml(input.name);

  const text = [
    'Start your verdict',
    '',
    `${input.name} is ready to go in. Press the button.`,
    input.confirmUrl,
    '',
    `The link stops working in ${TTL_HOURS} hours.`,
    '',
    'Didn’t ask for this? Ignore it.',
  ].join('\n');

  const html = [
    '<!doctype html>',
    `<html lang="en"><body style="${MAIL_BODY_STYLE}">`,
    '<h1 style="font-size:20px;margin:0 0 16px">Start your verdict</h1>',
    `<p style="margin:0 0 20px">${safeName} is ready to go in. Press the button.</p>`,
    `<p style="margin:0 0 24px"><a href="${safeLink}" style="${MAIL_BUTTON_STYLE}">Start my verdict</a></p>`,
    `<p style="margin:0 0 8px;${MAIL_SMALL_STYLE}">The link stops working in ${TTL_HOURS} hours.</p>`,
    `<p style="margin:0;${MAIL_SMALL_STYLE}">Didn’t ask for this? Ignore it.</p>`,
    '</body></html>',
  ].join('');

  return {
    to: input.email,
    from: input.from,
    subject: 'Start your verdict',
    text,
    html,
    idempotencyKey: input.idempotencyKey,
  };
}
