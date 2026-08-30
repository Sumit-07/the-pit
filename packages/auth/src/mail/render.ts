/**
 * The magic-link message.
 *
 * Short on purpose. This mail has one job — get a human to a button — and every
 * extra sentence is another thing a spam classifier weighs. `brief` Part 5 fixes
 * the voice: the connective word is *cuts*, and the domain is thepit.show.
 *
 * ## The link is a GET to a page that does nothing
 *
 * `brief §2.1`: "`GET /auth/verify` renders a **button**; a `POST` does the
 * actual verification. Corporate mail scanners (Outlook Safe Links) follow GET
 * links and would burn single-use tokens."
 *
 * That is the reason the copy says "opens a page with a button" rather than
 * "signs you in". It also means the token in this URL is safe to be fetched by a
 * scanner, a link preview, an antivirus proxy, or a mail client prefetching for
 * offline reading — all of which will follow it, none of which will POST.
 *
 * ## Escaping
 *
 * The URL is built from a base and a base64url token, so nothing in it needs
 * escaping today. It is escaped anyway, because "today" is doing a lot of work
 * in that sentence and an unescaped interpolation into HTML is the kind of thing
 * that stops being true when someone makes the base configurable per
 * environment.
 */

import { MAGIC_TOKEN_TTL_MS } from '../token.js';
import { MAIL_BODY_STYLE, MAIL_BUTTON_STYLE, MAIL_SMALL_STYLE } from './theme.js';
import type { OutboundEmail } from './types.js';

export interface MagicLinkMessageInput {
  /** The normalized recipient. */
  readonly email: string;
  /** `From:`, e.g. `The Pit <no-reply@thepit.show>`. */
  readonly from: string;
  /** Absolute URL of the verify page, e.g. `https://thepit.show/auth/verify`. */
  readonly verifyUrl: string;
  /** The RAW token. It exists in this message and in the redeeming POST, nowhere else. */
  readonly rawToken: string;
  /** Used only to key the send; derived from the hash, so the token cannot leak through it. */
  readonly idempotencyKey: string;
}

const TTL_MINUTES = MAGIC_TOKEN_TTL_MS / 60000;

/** Minimal HTML entity escaping for text interpolated into the body. */
export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * The full link, token in the query string.
 *
 * `URL` rather than string concatenation so that a base with an existing query,
 * a missing slash, or a trailing one all produce the same well-formed result,
 * and so the token is percent-encoded by something that knows the rules.
 */
export function magicLinkUrl(verifyUrl: string, rawToken: string): string {
  const url = new URL(verifyUrl);
  url.searchParams.set('token', rawToken);
  return url.toString();
}

export function renderMagicLinkEmail(input: MagicLinkMessageInput): OutboundEmail {
  const link = magicLinkUrl(input.verifyUrl, input.rawToken);
  const safeLink = escapeHtml(link);

  const text = [
    'Sign in to The Pit',
    '',
    'Open this link and press the button on the page:',
    link,
    '',
    `The link stops working in ${TTL_MINUTES} minutes and works once.`,
    '',
    'If you did not ask for this, nothing has happened to your account and you can ignore this message.',
  ].join('\n');

  const html = [
    '<!doctype html>',
    `<html lang="en"><body style="${MAIL_BODY_STYLE}">`,
    '<h1 style="font-size:20px;margin:0 0 16px">Sign in to The Pit</h1>',
    '<p style="margin:0 0 20px">Open this link and press the button on the page.</p>',
    `<p style="margin:0 0 24px"><a href="${safeLink}" style="${MAIL_BUTTON_STYLE}">Open the sign-in page</a></p>`,
    `<p style="margin:0 0 8px;${MAIL_SMALL_STYLE}">The link stops working in ${TTL_MINUTES} minutes and works once.</p>`,
    `<p style="margin:0;${MAIL_SMALL_STYLE}">If you did not ask for this, nothing has happened to your account and you can ignore this message.</p>`,
    '</body></html>',
  ].join('');

  return {
    to: input.email,
    from: input.from,
    subject: 'Sign in to The Pit',
    text,
    html,
    idempotencyKey: input.idempotencyKey,
  };
}
