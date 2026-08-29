/**
 * `brief §2.5`'s last rule: **resolve link shorteners to their target and store
 * that** — the one normalization rule `packages/engine`'s `normalizeUrl` cannot
 * implement, because it is the only one that needs a network.
 *
 * ## Why this is the hole that mattered
 *
 * The per-product submission cap (`brief §2.4`, one pitch per product per
 * recalibration cycle) hangs off the normalized URL and nothing else. Every
 * other §2.5 rule collapses a *spelling* of a URL: casing, `www.`, the trailing
 * slash, the referral query string. A shortener is not a spelling — `bit.ly/x`
 * and `example.com/alpha` share no bytes — so before this module the cap was one
 * `bit.ly` link away from being free, and a product could take every slot on a
 * board by pasting a fresh short link each time. That is why the deferral was
 * recorded in three places and why closing it needed an SSRF-guarded fetcher
 * first: the input is a URL an attacker chose, and dereferencing it is the
 * dangerous part.
 *
 * ## The rule, and why it is not "resolve shorteners"
 *
 * A curated list of shortener hostnames closes `bit.ly` and closes nothing else:
 * an evader registers `s.example` and shortens through that. So the rule this
 * module actually applies is broader and does not depend on the list being
 * complete:
 *
 * > **If following the URL lands on a different HOST, the destination is the
 * > product and the destination is what gets stored.** If it lands on the same
 * > host, the submitted URL is the product and it is kept as-is.
 *
 * That collapses `bit.ly/x`, a self-hosted shortener, and a marketing
 * redirect domain onto the target, all without a list. The same-host half is
 * what makes the key STABLE: `example.com` → `example.com/en/home` is a site
 * canonicalising a path, and adopting today's landing page would re-key the
 * product every time the site changed its homepage redirect — which would hand
 * the cap back to anyone who could get their own site to move.
 *
 * The hostname list still earns its place, for one job only: deciding what
 * happens when the fetch FAILS.
 *
 * ## Failing closed, without hard-blocking a paying customer
 *
 * `brief §2.5` also says evasion via a genuinely different URL is **flagged for
 * review, not hard-blocked** — "a false rejection on a paying customer is worse
 * than an extra run". So the two failure classes are separated:
 *
 * - A **security** refusal (private address, `file:`, a redirect loop, an
 *   unroutable port) is always a rejection. Nothing about that URL is a product
 *   website, and there is no reading under which letting it through is the safe
 *   default.
 * - An **availability** refusal (DNS down, timeout, a 500) is a rejection ONLY
 *   for a known shortener host, where falling back to `bit.ly/x` as the key would
 *   reopen the evasion route the moment a shortener got slow. For any other host
 *   it falls back to the offline key and raises `url_unresolved` for review —
 *   somebody's site being down for thirty seconds must not cost them a pitch.
 */

import { normalizeUrl } from '@the-pit/engine';

import type { GuardedFetcher } from './fetch.js';
import { refuse, type FetchOutcome, type FetchRefusalCode } from './refusal.js';

/**
 * Hosts whose whole purpose is to point somewhere else.
 *
 * Not a security control and not load-bearing for the common case — the
 * cross-host rule above catches a shortener nobody has heard of. This list only
 * decides whether an unreachable URL is rejected or flagged, so a name missing
 * from it costs a flag, not a hole.
 */
export const SHORTENER_HOSTS: ReadonlySet<string> = new Set([
  'amzn.to',
  'bit.ly',
  'bl.ink',
  'buff.ly',
  'clck.ru',
  'cutt.ly',
  'dub.sh',
  'fb.me',
  'git.io',
  'goo.gl',
  'ift.tt',
  'is.gd',
  'lnkd.in',
  'ow.ly',
  'po.st',
  'rb.gy',
  'rebrand.ly',
  's.id',
  'short.io',
  'shorturl.at',
  'spoti.fi',
  't.co',
  't.ly',
  'tiny.cc',
  'tinyurl.com',
  'tr.im',
  'trib.al',
  'v.gd',
  'wp.me',
  'youtu.be',
]);

/**
 * Refusals that are about SAFETY, not about reachability.
 *
 * Every one of these means the URL is not a product website under any reading,
 * so none of them may fall back to the offline key.
 */
const SECURITY_REFUSALS: ReadonlySet<FetchRefusalCode> = new Set<FetchRefusalCode>([
  'invalid_url',
  'unsupported_scheme',
  'credentials_in_url',
  'blocked_port',
  'blocked_address',
  'too_many_redirects',
  'redirect_loop',
]);

/** `scheme:` at the head of the string, matching `normalizeUrl`'s own reading. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

export type ProductUrlFlag =
  /** The URL could not be followed. The offline key was used; a human should look. */
  | 'url_unresolved'
  /** The URL led to a different host, and that host's URL is the stored key. */
  | 'url_redirected';

export interface ResolvedProductUrl {
  /** The key the per-product cap hangs off. This is the field that goes in `products.normalized_url`. */
  readonly normalizedUrl: string;
  /** What was submitted, with a scheme filled in if it had none. */
  readonly requestedUrl: string;
  /** Where it actually led, or `null` if it could not be followed. */
  readonly finalUrl: string | null;
  /** The final host differed from the submitted one, so the destination was adopted. */
  readonly redirected: boolean;
  readonly flags: readonly ProductUrlFlag[];
  /** Present only with `url_unresolved`: what went wrong, for the review queue. */
  readonly unresolvedReason?: string;
}

/** The registrable-ish host of a normalized key: everything before the first `/`, port stripped. */
export function hostOfKey(normalizedUrl: string): string {
  const host = normalizedUrl.split('/')[0] ?? '';
  const colon = host.lastIndexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

export function isShortenerHost(host: string): boolean {
  return SHORTENER_HOSTS.has(host.toLowerCase());
}

/**
 * Normalize a submitted URL to the key the cap is enforced on, following it to
 * its destination first.
 *
 * The offline rules are NOT reimplemented here: `normalizeUrl` is applied to
 * whichever URL wins, which is the only reason a resolved shortener and a
 * directly-typed URL can produce the same string, and the only reason a paid
 * submission can be recognised as the seeded row for the same product.
 */
export async function resolveProductUrl(
  submittedUrl: string,
  fetcher: GuardedFetcher,
): Promise<FetchOutcome<ResolvedProductUrl>> {
  const raw = submittedUrl.trim();

  let offlineKey: string;
  try {
    offlineKey = normalizeUrl(raw);
  } catch (error) {
    return refuse('invalid_url', raw, error instanceof Error ? error.message : String(error));
  }

  const requestedUrl = HAS_SCHEME.test(raw) ? raw : `https://${raw}`;
  const requestedHost = hostOfKey(offlineKey);

  const walked = await fetcher.resolveFinal(requestedUrl);
  if (!walked.ok) {
    if (SECURITY_REFUSALS.has(walked.refusal.code) || isShortenerHost(requestedHost)) {
      // Fail closed. For a shortener this is the whole point: accepting
      // `bit.ly/x` as its own key because bit.ly timed out is the evasion route
      // reopening itself.
      return walked;
    }
    return {
      ok: true,
      value: {
        normalizedUrl: offlineKey,
        requestedUrl,
        finalUrl: null,
        redirected: false,
        flags: ['url_unresolved'],
        unresolvedReason: walked.refusal.reason,
      },
    };
  }

  let finalKey: string;
  try {
    finalKey = normalizeUrl(walked.value.finalUrl);
  } catch (error) {
    return refuse('invalid_url', walked.value.finalUrl, error instanceof Error ? error.message : String(error));
  }

  // Same host: the redirect was the site tidying its own URL, and the submitted
  // key is the stable one. Different host: the submitted URL was a pointer, and
  // the thing it pointed at is the product.
  if (hostOfKey(finalKey) === requestedHost) {
    return {
      ok: true,
      value: {
        normalizedUrl: offlineKey,
        requestedUrl,
        finalUrl: walked.value.finalUrl,
        redirected: false,
        flags: [],
      },
    };
  }

  return {
    ok: true,
    value: {
      normalizedUrl: finalKey,
      requestedUrl,
      finalUrl: walked.value.finalUrl,
      redirected: true,
      flags: ['url_redirected'],
    },
  };
}
