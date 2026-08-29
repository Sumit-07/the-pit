/**
 * The capability slug — the entry point that does not depend on email arriving.
 *
 * ## Why a third path exists at all
 *
 * `brief §2.1` makes the magic link the way a returning customer reaches their
 * balance, and the magic link is correct. It is also, operationally, a bet on
 * DNS: SPF, DKIM and DMARC on a new sending domain want one to two weeks at
 * `p=none` before anything is tightened, plus reputation warm-up, and until that
 * is done a "check your inbox" is a promise the infrastructure cannot keep. It
 * fails worst for exactly the addresses that paid — corporate mailboxes behind
 * Proofpoint and Mimecast, where an unwarmed domain lands in quarantine rather
 * than in a junk folder the customer can look in.
 *
 * A capability URL removes email from the critical path. It is minted when the
 * Dodo webhook creates the account, shown on the success page while the buyer is
 * still looking at it, and emailed only as a backup. The customer bookmarks it.
 * Nothing has to be delivered for it to work.
 *
 * ## What it is, precisely
 *
 * 32 bytes from the OS CSPRNG, base64url-encoded: 43 characters, 256 bits. The
 * same construction as the magic-link token in `token.ts`, and for the same
 * reason — it is a bearer credential, so the only thing standing between it and
 * an attacker is that guessing is not worth attempting. 128 bits is the floor
 * this module asserts (`CAPABILITY_SLUG_MIN_BITS`); 256 is what it ships,
 * because there is no cost to the extra 11 characters.
 *
 * Three things it is deliberately NOT:
 *
 * - **Not sequential.** `/a/1`, `/a/2` is an enumeration of the customer list.
 * - **Not derived from the email.** A slug that is `sha256(email)` — or any
 *   function of it — is guessable by anyone who knows the address, which for a
 *   business customer is printed on their website.
 * - **Not derived from the account id.** `accounts.id` is a uuid that travels in
 *   foreign keys, log lines and admin URLs precisely because it is *not* secret;
 *   deriving a secret from it would make every one of those places a leak.
 *
 * `mintCapabilitySlug` therefore takes NO input. It cannot be a function of the
 * account, because it has nothing to be a function of.
 *
 * ## The one revocation story
 *
 * A bearer URL cannot be un-shared. There is no expiry that would help — the
 * whole point is that it still works in six months when the customer digs the
 * bookmark out — and no per-request check that could tell the customer's browser
 * from someone who read the URL over their shoulder. So the only control is
 * rotation: mint a new slug, write it over the old one, and the old one stops
 * resolving in the same statement. See `access.ts`'s `rotateCapability`, and
 * note that the slug lives in a single column on `accounts` rather than in a
 * table of slugs — a table would allow two live slugs at once, which is exactly
 * the thing rotation exists to prevent.
 *
 * ## Where it must not appear
 *
 * The URL is the credential, so every place URLs are routinely collected is a
 * disclosure: an HTTP access log, an analytics page-view, a Sentry breadcrumb,
 * and above all the `Referer` header, which is how a URL escapes to every
 * third-party asset a page loads. `apps/web`'s `/a/[slug]` route answers with
 * `Referrer-Policy: no-referrer` and redirects to `/account` without the slug,
 * so the credential is never in the address bar of a page that loads anything.
 */

import { randomBytes } from 'node:crypto';

/**
 * The floor. Below this a slug is worth grinding at offline, and there is no
 * rate limit that helps once someone has a list of candidate URLs to try
 * against a CDN.
 */
export const CAPABILITY_SLUG_MIN_BITS = 128;

/** 32 bytes — 256 bits. Twice the floor, at a cost of 11 characters. */
export const CAPABILITY_SLUG_BYTES = 32;

/** `ceil(32 * 8 / 6)` = 43 unpadded base64url characters. */
export const CAPABILITY_SLUG_LENGTH = 43;

/**
 * base64url and nothing else: the slug is a path segment, and `+`, `/` and `=`
 * all mean something in a URL path. The same alphabet the magic-link token uses,
 * so one answer to "what does one of our secrets look like".
 */
export const CAPABILITY_SLUG_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The shape of a byte source. Injected only so a test can pin the encoding. */
export type RandomBytes = (size: number) => Buffer;

/**
 * The default source, exported by reference so a test can assert WHICH generator
 * this module reaches for.
 *
 * `node:crypto`'s `randomBytes` is the OS CSPRNG — `getrandom(2)` on Linux,
 * `BCryptGenRandom` on Windows. `Math.random()` is a per-process xorshift whose
 * entire future output is recoverable from a handful of samples, and a slug
 * generator that quietly switched to it would still pass a uniqueness test, a
 * length test and a character-class test. `test/capability.test.ts` asserts
 * `CAPABILITY_CSPRNG === randomBytes` by identity, which is the only assertion
 * that actually fails when the source is swapped.
 */
export const CAPABILITY_CSPRNG: RandomBytes = randomBytes;

/**
 * A fresh slug. Takes no account, no email, and no id — see the header.
 *
 * The length check is not defensive padding: a source that returns fewer bytes
 * than asked (a stub, a mock, a polyfill) would silently produce a shorter and
 * weaker slug that still matches every other property this module advertises.
 * Failing loudly is the only outcome that is not a silent downgrade.
 */
export function mintCapabilitySlug(random: RandomBytes = CAPABILITY_CSPRNG): string {
  const bytes = random(CAPABILITY_SLUG_BYTES);
  if (bytes.length !== CAPABILITY_SLUG_BYTES) {
    throw new RangeError(
      `capability slug source returned ${bytes.length} bytes, expected ${CAPABILITY_SLUG_BYTES}. ` +
        'A short slug is a weak credential; refusing to mint one.',
    );
  }
  return bytes.toString('base64url');
}

/**
 * Does this string have the shape of a slug?
 *
 * A cheap gate in front of the store, so a request for `/a/../../etc/passwd` or
 * a 4KB path segment is refused before it becomes a database round trip. It
 * says nothing about whether the slug resolves — that is the store's answer, and
 * `openCapabilityUrl` deliberately renders the same page for both.
 */
export function isCapabilitySlug(value: string): boolean {
  return CAPABILITY_SLUG_PATTERN.test(value);
}

/** The path a slug lives at. One definition, so the route and the email agree. */
export function capabilityPath(slug: string): string {
  return `/a/${slug}`;
}

/**
 * The absolute URL, for the success page and the backup email.
 *
 * `new URL` rather than string concatenation so a trailing slash on the origin
 * cannot produce `//a/<slug>`, which some proxies treat as a protocol-relative
 * URL and send somewhere else entirely.
 */
export function capabilityUrl(origin: string, slug: string): string {
  return new URL(capabilityPath(slug), origin).toString();
}
