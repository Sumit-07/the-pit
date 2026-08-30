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
  hostOfKey,
  isShortenerHost,
  resolveProductUrl,
  type FetchOutcome,
  type FetchRefusal,
  type GuardedFetcher,
  type PageMetadata,
  type ResolvedProductUrl,
} from '@the-pit/fetch';
import { normalizeSubmissionUrl, type SubmissionUrlResolution } from '@the-pit/payments';

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
 * The submission path's resolver: one cap key, or one rejection.
 *
 * This is the only function `lib/checkout/guards.ts` calls, and it is where the
 * failure policy lives. Three outcomes, and the split between the last two is
 * the whole decision:
 *
 * - **Resolved.** The key is the destination's when the submitted URL pointed at
 *   another host, and the submitted URL's own when it did not. `url_redirected`
 *   rides along for the review queue.
 * - **Refused, and the refusal is a rejection.** A private or link-local
 *   address, a scheme or port that is not a website, a redirect loop — or a
 *   *known shortener* that could not be followed at all. `resolveProductUrl`
 *   makes that distinction; here it is simply a `url_unfetchable` rejection with
 *   the visitor-facing sentence `submissionUrlMessage` already writes.
 * - **Unreachable, and NOT a rejection.** An ordinary product site that is slow,
 *   down, or answering 500 resolves to the offline key with `url_unresolved`
 *   flagged. This is the deliberate choice: the resolution is a network call on
 *   the purchase path, and `brief §2.5` is explicit that "a false rejection on a
 *   paying customer is worse than an extra run". Somebody's site being down for
 *   thirty seconds must not cost them a pitch.
 *
 * The `try` is part of that policy rather than defensive noise. `resolveProductUrl`
 * returns refusals as values and does not throw, but this runs on the money path,
 * and an unforeseen throw here would be a 500 in front of a customer who was
 * about to pay. So an exception is treated as the availability case it almost
 * certainly is — fall back to the offline key, flag it, let a human look — except
 * where the offline key is a shortener's own, where falling back is the hole
 * reopening and the rejection stands.
 */
export async function resolveSubmissionUrl(url: string): Promise<SubmissionUrlResolution> {
  let outcome: FetchOutcome<ResolvedProductUrl>;
  try {
    outcome = await resolveSubmittedUrl(url);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[submit] the URL resolver threw: ${reason}`);
    return offlineFallback(url, reason);
  }

  if (!outcome.ok) {
    return {
      ok: false,
      rejection: {
        code: 'url_unfetchable',
        message: submissionUrlMessage(outcome.refusal),
        reason: `${outcome.refusal.code}: ${outcome.refusal.reason}`,
      },
    };
  }

  return {
    ok: true,
    resolved: { normalizedUrl: outcome.value.normalizedUrl, flags: outcome.value.flags },
  };
}

/**
 * The offline key, for the one case `resolveProductUrl` never reaches: it threw.
 *
 * It re-applies that function's own rule rather than inventing a softer one — a
 * shortener whose destination is unknown is still refused, because keying on
 * `bit.ly/x` is what the cap cannot survive.
 */
function offlineFallback(url: string, reason: string): SubmissionUrlResolution {
  const offline = normalizeSubmissionUrl(url);
  if (!offline.ok) {
    return { ok: false, rejection: offline.rejection };
  }
  if (isShortenerHost(hostOfKey(offline.normalizedUrl))) {
    return {
      ok: false,
      rejection: {
        code: 'url_unfetchable',
        message: 'We could not follow that short link. Paste the address it points at.',
        reason: `resolver_error: ${reason}`,
      },
    };
  }
  return {
    ok: true,
    resolved: { normalizedUrl: offline.normalizedUrl, flags: ['url_unresolved'] },
  };
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
