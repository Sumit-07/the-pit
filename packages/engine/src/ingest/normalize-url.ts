/**
 * URL normalization, `the-pit-build-brief.md` §2.5.
 *
 * The normalized form is an identity, not a fetchable address: it is the key
 * the per-product submission cap hangs off, so two URLs that reach the same
 * page must reduce to the same string. Hence lowercasing the whole thing,
 * dropping `www.`, and dropping every query parameter (which is what kills the
 * affiliate / referral / UTM variants).
 *
 * §2.5 also asks for link shorteners to be resolved to their target. That rule
 * is OUT OF SCOPE for Phase 1 (`docs/plans/phase-1-engine.md` Task 2): it needs
 * an SSRF-guarded fetcher — redirect cap, timeout, private-address blocking —
 * and it exists to stop evasion of a paid submission cap that Phase 1 does not
 * have. Deferred to Phase 3. Nothing here performs I/O.
 */

/** `scheme:` at the head of the string, per RFC 3986. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function parse(candidate: string): URL | null {
  try {
    return new URL(candidate);
  } catch {
    return null;
  }
}

/**
 * Reduce a URL to `host[:port]/path`: lowercased, protocol stripped, `www.`
 * stripped, trailing slashes stripped, query string and fragment dropped.
 *
 * A bare `example.com/x` is accepted and read as https. Anything that is not an
 * http(s) URL throws rather than normalizing to something misleading — an
 * unparseable `Website URL` is a defect in the source sheet, and the ingest
 * fails loudly on it the same way it fails on an unparseable `Rank`.
 */
export function normalizeUrl(url: string): string {
  const raw = url.trim();
  if (raw === '') {
    throw new Error('normalizeUrl: URL is empty');
  }

  const parsed = parse(HAS_SCHEME.test(raw) ? raw : `https://${raw}`);
  if (parsed === null) {
    throw new Error(`normalizeUrl: cannot parse ${JSON.stringify(url)} as a URL`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`normalizeUrl: expected an http(s) URL, got ${JSON.stringify(url)}`);
  }
  if (parsed.host === '') {
    throw new Error(`normalizeUrl: ${JSON.stringify(url)} has no host`);
  }

  // `host` carries the port but not the userinfo, and a default port is already
  // gone. The lookahead keeps the registrable domain `www.com` intact; without
  // it, stripping the prefix would leave the bare TLD `com` as an identity.
  const host = parsed.host.toLowerCase().replace(/^www\.(?=.*\.)/, '');

  // `pathname` carries neither the query string nor the fragment.
  return `${host}${parsed.pathname}`.toLowerCase().replace(/\/+$/, '');
}
