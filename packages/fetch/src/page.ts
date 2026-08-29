/**
 * The two things a caller actually wants, wired together: follow a URL under
 * guard, and read the metadata out of what comes back.
 *
 * Kept apart from `fetch.ts` so the transport guards have no opinion about HTML,
 * and apart from `metadata.ts` so the parser can be tested against a string with
 * no fetcher in sight.
 */

import type { GuardedFetcher } from './fetch.js';
import { extractMetadata, type PageMetadata } from './metadata.js';
import type { FetchOutcome } from './refusal.js';

/**
 * Fetch a page and read its `<head>`.
 *
 * The refusal is passed through unchanged: a caller that wants to treat "the
 * site is down" differently from "the site resolves to the metadata endpoint"
 * has the code to branch on, and neither of them silently becomes an empty
 * result.
 */
export async function fetchPageMetadata(url: string, fetcher: GuardedFetcher): Promise<FetchOutcome<PageMetadata>> {
  const document = await fetcher.fetchDocument(url);
  if (!document.ok) return document;
  // Parsed against the FINAL url, so a relative `og:image` on a page reached
  // through two redirects resolves against where it was served from.
  return { ok: true, value: extractMetadata(document.value.html, document.value.finalUrl) };
}
