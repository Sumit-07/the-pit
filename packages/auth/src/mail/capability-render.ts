/**
 * The receipt-time message that carries the capability URL — as a BACKUP.
 *
 * The ordering matters and the copy says it out loud. The buyer has already seen
 * this URL on the success page, where nothing had to be delivered for it to
 * arrive. This message exists for the case where they closed the tab before
 * bookmarking it, and it is written so that a customer who never receives it has
 * still lost nothing: everything it contains, they were shown.
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
    'This is the same link the page showed you after payment. Bookmark it — it is how you',
    'reach your remaining attempts, your history, and a re-pitch.',
    '',
    input.url,
    '',
    'It does not expire and it does not need a password. Treat it like a key: anyone who has',
    'it can reach your account. If you think it has got out, sign in and rotate it — the old',
    'link stops working the moment you do.',
    '',
    'Your verdict page is public and separate. Nothing here is needed to view or share it.',
  ].join('\n');

  const html = [
    '<!doctype html>',
    '<html lang="en"><body style="margin:0;padding:24px;background:#0b0b0c;color:#e8e8ea;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif">',
    '<h1 style="font-size:20px;margin:0 0 16px">Your account link</h1>',
    '<p style="margin:0 0 20px">The same link the page showed you after payment. Bookmark it — it is how you reach your remaining attempts, your history, and a re-pitch.</p>',
    `<p style="margin:0 0 24px"><a href="${safeUrl}" style="display:inline-block;padding:12px 20px;background:#e8e8ea;color:#0b0b0c;text-decoration:none;border-radius:4px;font-weight:600">Open my account</a></p>`,
    `<p style="margin:0 0 20px;font-size:14px;word-break:break-all;opacity:.7">${safeUrl}</p>`,
    '<p style="margin:0 0 8px;font-size:14px;opacity:.7">No password, no expiry. Treat it like a key: anyone who has it can reach your account. If you think it has got out, sign in and rotate it — the old link stops working the moment you do.</p>',
    '<p style="margin:0;font-size:14px;opacity:.7">Your verdict page is public and separate. Nothing here is needed to view or share it.</p>',
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
