/**
 * `@the-pit/fetch` — the guarded URL fetcher, and the three features that needed
 * one.
 *
 * This entry point is transport-agnostic on purpose: every export here takes its
 * resolver and its socket as arguments, so `packages/engine`'s ingest,
 * `apps/web`'s submission path and the test suite all drive the same guards.
 * `@the-pit/fetch/node` supplies the real `node:dns` and `node:https`
 * implementations; nothing in this file imports either.
 */

export {
  addressBlockReason,
  checkAddress,
  parseAddress,
  parseIPv4,
  parseIPv6,
  unwrapEmbeddedV4,
  type ParsedAddress,
} from './address.js';
export {
  createGuardedFetcher,
  type AssetOptions,
  type FetchedAsset,
  type FetchedDocument,
  type GuardedFetcher,
  type GuardedFetcherOptions,
  type ResolvedTarget,
} from './fetch.js';
export {
  ALLOWED_PORTS,
  HTML_CONTENT_TYPES,
  IMAGE_CONTENT_TYPES,
  MAX_ASSET_BYTES,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  MAX_URL_LENGTH,
  METADATA_URL_LIMIT,
  TITLE_LIMIT,
  TOTAL_TIMEOUT_MS,
  USER_AGENT,
} from './limits.js';
export { bestCopy, cleanText, extractMetadata, type PageMetadata } from './metadata.js';
export { fetchPageMetadata } from './page.js';
export {
  hostOfKey,
  isShortenerHost,
  resolveProductUrl,
  SHORTENER_HOSTS,
  type ProductUrlFlag,
  type ResolvedProductUrl,
} from './product-url.js';
export { refuse, type FetchOutcome, type FetchRefusal, type FetchRefusalCode } from './refusal.js';
export type { HostResolver, Transport, TransportRequest, TransportResponse } from './transport.js';
