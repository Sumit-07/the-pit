/**
 * Every cap the fetcher enforces, in one table.
 *
 * They are all small on purpose. This fetcher exists to read a `<head>` and to
 * find out where a shortener points; it is not a crawler, and every one of these
 * numbers is set to the smallest value that still does that job. A generous cap
 * is an availability bug waiting for someone to point the submission form at a
 * 4 GB file or a redirect treadmill.
 */

/**
 * Redirect hops followed before refusing.
 *
 * Four covers every real chain: a shortener to a second shortener to the target
 * is two, and http→https→www adds two more. It does not cover a chain built to
 * exhaust the timeout, which is the point.
 */
export const MAX_REDIRECTS = 4;

/** Wall-clock budget for the WHOLE walk, redirects included, in milliseconds. */
export const TOTAL_TIMEOUT_MS = 5_000;

/**
 * Bytes of response body read before truncating.
 *
 * 256 KB. A `<head>` is a few kilobytes; anything past this is a document we do
 * not want. The body is truncated rather than refused because a large page with
 * a perfectly good `<title>` in its first kilobyte is a normal site, not an
 * attack — but the bytes past the cap are never pulled off the socket.
 */
export const MAX_RESPONSE_BYTES = 256 * 1024;

/** Longest URL accepted anywhere in the walk, including a `Location` header. */
export const MAX_URL_LENGTH = 2_048;

/**
 * Ports the fetcher will connect to.
 *
 * `normalizeUrl` deliberately keeps a non-default port because it is a different
 * service; the fetcher deliberately refuses one, because a product's public
 * website is on 80 or 443 and the interesting things on other ports are Redis,
 * Memcached and an unauthenticated admin panel. Overridable per call for a
 * caller that knows better.
 */
export const ALLOWED_PORTS: readonly number[] = [80, 443];

/** Content types whose body may be read as HTML. Checked before any read. */
export const HTML_CONTENT_TYPES: readonly string[] = ['text/html', 'application/xhtml+xml'];

/** `<title>` and `og:title` truncation, in characters. Matches `LABEL_LIMIT`'s intent for short display text. */
export const TITLE_LIMIT = 200;

/** Longest absolute URL kept for `og:image` / favicon. */
export const METADATA_URL_LIMIT = 1_024;

/** What the fetcher calls itself. Honest, and gives a site operator someone to block. */
export const USER_AGENT = 'ThePitBot/1.0 (+https://thepit.example/bot)';
