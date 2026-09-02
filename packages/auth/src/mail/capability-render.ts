/**
 * The receipt-time message that carries the capability URL — as a BACKUP.
 *
 * The ordering matters. The buyer has already seen this URL on the success page,
 * where nothing had to be delivered for it to arrive. This message exists for the
 * case where they closed the tab before bookmarking it, so a customer who never
 * receives it has still lost nothing: everything it contains, they were shown.
 *
 * That is the inversion the capability path is for. The magic link makes email a
 * dependency of signing in; this makes email a convenience. Until SPF, DKIM and
 * DMARC are warmed on the sending domain — one to two weeks at `p=none` before
 * anything tightens — that difference is the difference between a customer who
 * can reach the balance they paid for and one who cannot.
 *
 * ## Why the URL is in the body rather than behind a tracked redirect
 *
 * Because a click tracker would put the capability URL through a third party's
 * logs, which is precisely the disclosure the `Referrer-Policy` on the route
 * exists to prevent. For the same reason there is no pixel, no UTM parameter and
 * no analytics link in this message.
 *
 * ## Idempotency
 *
 * Keyed on the account id and the slug, so a webhook retry that re-sends this
 * message is deduplicated by the provider, and so rotating the slug produces a
 * genuinely new message rather than one the provider suppresses as a duplicate.
 * Derived from the slug's HASH rather than the slug, so the credential does not
 * end up in a provider's dashboard as a message key.
 */

import { createHash } from 'node:crypto';

import { MAIL_BODY_STYLE, MAIL_BUTTON_STYLE, MAIL_SMALL_STYLE } from './theme.js';
import type { OutboundEmail } from './types.js';
import { escapeHtml } from './render.js';

export interface CapabilityMessageInput {
  /** The normalized recipient — the address Dodo verified. */
  readonly email: string;
  /** `From:`, e.g. `The Pit <no-reply@thepit.show>`. */
  readonly from: string;
  /** The absolute capability URL. `capabilityUrl(origin, slug)`. */
  readonly url: string;
  /** Used only to derive the idempotency key. Never rendered. */
  readonly accountId: string;
}

/**
 * The message key.
 *
 * `sha256(accountId + url)`, truncated. The URL is the credential, so it is
 * hashed rather than embedded: a provider dashboard, a delivery log and a
 * bounce report all display the idempotency key, and none of them should be a
 * place someone can read an account URL out of.
 */
export function capabilityIdempotencyKey(accountId: string, url: string): string {
  return `capability:${createHash('sha256').update(`${accountId}\n${url}`, 'utf8').digest('hex').slice(0, 32)}`;
}

export function renderCapabilityEmail(input: CapabilityMessageInput): OutboundEmail {
  const safeUrl = escapeHtml(input.url);

  const text = [
    'Your account link for The Pit',
    '',
    'Bookmark this.',
    '',
    input.url,
    '',
    'No password, no expiry. Anyone who has it can reach your account.',
    'Replace it from your account page.',
  ].join('\n');

  const html = [
    '<!doctype html>',
    `<html lang="en"><body style="${MAIL_BODY_STYLE}">`,
    '<h1 style="font-size:20px;margin:0 0 16px">Your account link</h1>',
    '<p style="margin:0 0 20px">Bookmark this.</p>',
    `<p style="margin:0 0 24px"><a href="${safeUrl}" style="${MAIL_BUTTON_STYLE}">Open my account</a></p>`,
    `<p style="margin:0 0 20px;word-break:break-all;${MAIL_SMALL_STYLE}">${safeUrl}</p>`,
    `<p style="margin:0;${MAIL_SMALL_STYLE}">No password, no expiry. Anyone who has it can reach your account. Replace it from your account page.</p>`,
    '</body></html>',
  ].join('');

  return {
    to: input.email,
    from: input.from,
    subject: 'Your account link for The Pit',
    text,
    html,
    idempotencyKey: capabilityIdempotencyKey(input.accountId, input.url),
  };
}
