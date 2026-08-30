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

/**
 * Content types whose body may be read as a RASTER image. Checked before any read.
 *
 * `image/svg+xml` is deliberately absent, and its absence is a security decision
 * rather than an oversight. An SVG is a document: it can carry `<script>`, an
 * `onload`, a `<foreignObject>` full of HTML and an external `<image href>`. A
 * favicon is fetched from an arbitrary host chosen by the person who submitted
 * the product, and the bytes are then stored and served back inside our own
 * pages — so an SVG here is a stored-XSS primitive with an extra fetch in front
 * of it. Sanitising SVG correctly is a project; refusing it is a line. This is
 * the line.
 *
 * `image/x-icon`, `image/vnd.microsoft.icon` and `image/ico` are all the same
 * thing spelled three ways by three generations of server config, and a `.ico`
 * is still what most of the web serves. `application/octet-stream` is NOT here:
 * "I don't know what this is" is not a claim that it is an image, and the header
 * is only half the check anyway — see `IMAGE_SIGNATURES` in the consumer, which
 * decides the real format from the bytes.
 */
export const IMAGE_CONTENT_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/bmp',
  'image/x-icon',
  'image/vnd.microsoft.icon',
  'image/ico',
  'image/x-ms-bmp',
  'image/apng',
];

/**
 * Bytes of an asset body read before truncating.
 *
 * 96 KB. An icon that does not fit in this is not an icon — it is a hero image
 * with the wrong `rel`, or a multi-resolution `.ico` carrying a 256×256 layer
 * nobody will ever see at 16 pixels. The read is still CAPPED rather than
 * refused up front, but a truncated image is a corrupt image, so
 * `fetchAsset` refuses a body that hit the cap instead of handing back a
 * prefix: half a PNG is not a smaller PNG.
 */
export const MAX_ASSET_BYTES = 96 * 1024;

/** `<title>` and `og:title` truncation, in characters. Matches `LABEL_LIMIT`'s intent for short display text. */
export const TITLE_LIMIT = 200;

/** Longest absolute URL kept for `og:image` / favicon. */
export const METADATA_URL_LIMIT = 1_024;

/** What the fetcher calls itself. Honest, and gives a site operator someone to block. */
export const USER_AGENT = 'ThePitBot/1.0 (+https://thepit.example/bot)';
