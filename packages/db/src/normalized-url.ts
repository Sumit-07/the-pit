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
 * ## Shortener resolution happens above this function, not inside it
 *
 * `brief §2.5`'s remaining rule — "Resolve link shorteners to their target and
 * store that" — is implemented, in `@the-pit/fetch`'s `resolveProductUrl`. It is
 * not implemented here and it never will be: it needs a network, and this
 * function's whole value is that it is offline, deterministic, and the same one
 * the seeded boards were keyed with.
 *
 * What `resolveProductUrl` does is follow the submitted URL behind an SSRF guard
 * (scheme allow-list, every DNS answer checked against the private ranges and
 * re-checked on every redirect hop, a redirect cap, a wall-clock budget, a body
 * cap) and then apply THIS function to whichever URL won — the destination when
 * it landed on a different host, the submitted URL when it did not. That is why a
 * resolved shortener and a directly-typed URL produce the same string, and why
 * only the value written into `products.normalized_url` changed: not its type,
 * its index, or anything that reads it.
 *
 * Two consequences for anyone writing this column:
 *
 * - On the submission path the value comes from the resolution, carried on the
 *   `SubmissionClearance`. Calling this function on the raw URL and storing THAT
 *   is the bug the whole wiring exists to prevent.
 * - Rows written before the wiring hold unresolved keys.
 *   `src/backfill/normalized-url.ts` re-resolves them; until it has run, the cap
 *   joins only rows written after the change.
 *
 * Seeding is the exception and stays offline: a workbook row has no submitter to
 * evade a cap, and `loadCategory` must not become network-bound.
 */

export { normalizeUrl } from '@the-pit/engine';
