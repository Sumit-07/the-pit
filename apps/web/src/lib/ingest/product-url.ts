/**
 * The app's one door onto `@the-pit/fetch`, and the only place a submitted URL
 * is dereferenced.
 *
 * Same shape and same reasoning as `lib/engine.ts` and `lib/checkout/config.ts`:
 * one module owns the import, an explicit `registerProductUrlFetcher()` wins so
 * a test never opens a socket, and everything else resolves from the
 * environment. Concentrating it here is what makes "nothing else in the app
 * fetches a user-supplied URL" a checkable claim rather than a hope — the
 * guards are worth nothing if a second route calls `fetch(url)` directly.
 *
 * `next.config.ts` lists `@the-pit/fetch` as an external package for the same
 * reason it lists the engine: it reaches for `node:dns` and `node:https`, which
 * is server-only code that has no business in a bundle.
 *
 * ## What this module decides, and what it does not
 *
 * It decides the WIRING — which fetcher, which caps, and what sentence a person
 * sees when a URL is refused. It decides nothing about the submission rules:
 * whether a normalized URL is cycle-locked, whether a description changed
 * materially and what a rejection costs are `packages/payments`' guards, and
 * they are another agent's. This produces the key those guards are given.
 */

import { createNodeFetcher } from '@the-pit/fetch/node';
import {
  fetchPageMetadata,
  resolveProductUrl,
  type FetchOutcome,
  type FetchRefusal,
  type GuardedFetcher,
  type PageMetadata,
  type ResolvedProductUrl,
} from '@the-pit/fetch';

let registered: GuardedFetcher | null = null;
let memoized: GuardedFetcher | null = null;

/** Install a fetcher directly. Tests use this; production uses the real one. */
export function registerProductUrlFetcher(fetcher: GuardedFetcher): void {
  registered = fetcher;
}

/** Drop what this module memoized. Tests only. */
export function resetProductUrlWiring(): void {
  registered = null;
  memoized = null;
}

/**
 * The fetcher this app uses.
 *
 * Every cap is left at the package default. There is no environment variable
 * that widens them and deliberately so: an operator who can raise the redirect
 * cap from a dashboard can raise it from a compromised dashboard, and none of
 * these numbers is a tuning knob worth that.
 */
export function productUrlFetcher(): GuardedFetcher {
  if (registered !== null) return registered;
  memoized ??= createNodeFetcher();
  return memoized;
}

/**
 * Normalize a submitted URL to the key the per-product cap hangs off, following
 * link shorteners to their target first (`brief §2.5`).
 *
 * The result is what `products.normalized_url` should hold and what
 * `findByNormalizedUrl` should be asked about — NOT the raw string a visitor
 * typed. See the report for what the consumers of that column have to change.
 */
export function resolveSubmittedUrl(url: string): Promise<FetchOutcome<ResolvedProductUrl>> {
  return resolveProductUrl(url, productUrlFetcher());
}

/** A product's own `<title>`, description, OpenGraph pair and favicon. Every field optional. */
export function readProductMetadata(url: string): Promise<FetchOutcome<PageMetadata>> {
  return fetchPageMetadata(url, productUrlFetcher());
}

/**
 * What to tell the person who pasted the URL.
 *
 * Refusals are honest about their cause, because a submitter who is told "that
 * link redirects somewhere we will not follow" can fix it and a submitter who is
 * told "invalid" cannot. Nothing here reveals anything the visitor did not
 * supply: the URL is theirs, and where it leads is a fact about their own link.
 */
export function submissionUrlMessage(refusal: FetchRefusal): string {
  switch (refusal.code) {
    case 'invalid_url':
    case 'unsupported_scheme':
    case 'credentials_in_url':
      return "That does not look like a web address. Paste the product's URL, including the domain.";
    case 'blocked_port':
      return 'That address points at a port we do not fetch. Link to the product’s public website.';
    case 'blocked_address':
      return 'That address resolves somewhere that is not the public internet, so we cannot check where it leads.';
    case 'too_many_redirects':
    case 'redirect_loop':
      return 'That link bounces through too many redirects to follow. Paste the address it ends up at.';
    case 'bad_status':
      return 'That link did not resolve to a working page. Paste the product’s own address.';
    case 'unsupported_content_type':
      return 'That address does not serve a web page we can read.';
    case 'dns_failure':
    case 'timeout':
    case 'transport_error':
      // Only ever reached for a known shortener: for any other host an
      // unreachable site falls back to the offline key and is flagged instead,
      // because a site being down for thirty seconds must not cost a pitch.
      return 'We could not follow that short link. Paste the address it points at.';
    default:
      return 'We could not use that address.';
  }
}
