/**
 * The one function that may produce a value for `products.normalized_url`.
 *
 * It is `normalizeUrl` from `@the-pit/engine`, re-exported and not reimplemented.
 * That is a requirement rather than a convenience: `brief §2.5` keys the
 * per-product submission cap on the normalized URL, and a cap enforced with a
 * *second* implementation of the normalization rules is a cap with a documented
 * bypass — anywhere the two disagree, the same page has two identities and the
 * limit does not apply. The engine's copy is the one the seeded boards were built
 * with, so it is also the one that makes a seeded row and a paid row comparable.
 *
 * `packages/engine/src/ingest/normalize-url.ts` implements, from `brief §2.5`:
 * lowercase; strip the protocol; strip `www.`; strip the trailing slash; drop
 * every query parameter (which is what kills the affiliate, referral and UTM
 * variants) and the fragment. A bare `example.com/x` is read as https. Anything
 * that is not an http(s) URL throws rather than normalizing to something
 * misleading.
 *
 * ## Shortener resolution is deferred, deliberately
 *
 * `brief §2.5`'s remaining rule — "Resolve link shorteners to their target and
 * store that" — is NOT implemented here or in the engine, and the column stores
 * the shortener's own identity until it is. This is a known, accepted gap:
 * `bit.ly/abc` and the page it points at are two different values of
 * `normalized_url`, so a submitter who shortens their URL evades the per-product
 * cap.
 *
 * The reason it is deferred rather than added is that resolving it means our
 * server issuing an HTTP request to an address an untrusted user chose, which is
 * a server-side request forgery primitive unless it is built with:
 *
 *   - a scheme allow-list (http/https only, no `file:`, `gopher:`, `data:`);
 *   - DNS resolution checked against the private ranges — 127/8, 10/8, 172.16/12,
 *     192.168/16, 169.254/16 (cloud metadata), ::1, fc00::/7 — and re-checked
 *     after every redirect, because the first hop can be public and the second
 *     internal;
 *   - a redirect cap and a total timeout;
 *   - a response size cap, since the body is never read but a slow one still
 *     holds a connection.
 *
 * None of that is Phase 2 work, and half of it is worse than none. `brief §2.5`
 * also softens the consequence: evasion "flag for review, do not hard-block. A
 * false rejection on a paying customer is worse than an extra run." Phase 3 owns
 * the guarded fetcher; when it lands, only the value written into this column
 * changes — not its type, its index, or anything that reads it.
 */

export { normalizeUrl } from '@the-pit/engine';
