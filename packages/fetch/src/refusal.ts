/**
 * How the fetcher fails.
 *
 * The whole package has one failure mode: refuse, and say why. There is no
 * "try again without the guard" path and no exception that a caller can swallow
 * into a bare `fetch`. Refusals are VALUES, returned in a discriminated union,
 * for that reason — a thrown error is one forgotten `catch` away from becoming a
 * fallback, and a fallback here is the vulnerability.
 */

export type FetchRefusalCode =
  /** Not a URL, or longer than `MAX_URL_LENGTH`. */
  | 'invalid_url'
  /** Anything but `http:` / `https:` — `file:`, `data:`, `gopher:`, `ftp:`. */
  | 'unsupported_scheme'
  /** `http://user:pass@host/` — a credential in a URL is an attempt to confuse a parser. */
  | 'credentials_in_url'
  /** A port outside `ALLOWED_PORTS`. */
  | 'blocked_port'
  /** The hostname did not resolve, or resolved to nothing. */
  | 'dns_failure'
  /** A resolved (or literal) address is private, loopback, link-local, or otherwise not public. */
  | 'blocked_address'
  /** More than `maxRedirects` hops. */
  | 'too_many_redirects'
  /** A 3xx with no usable `Location`. */
  | 'redirect_without_location'
  /** The chain revisited a URL it had already fetched. */
  | 'redirect_loop'
  /** A final status that is not 2xx. */
  | 'bad_status'
  /** A final response that is not HTML. Decided from the headers, before any body is read. */
  | 'unsupported_content_type'
  /** The wall-clock budget ran out. */
  | 'timeout'
  /** The connection failed, or the transport threw. */
  | 'transport_error';

/** A refusal: the code a caller branches on, the sentence a human reads, and where it happened. */
export interface FetchRefusal {
  readonly code: FetchRefusalCode;
  readonly reason: string;
  /** The URL of the hop that was refused, which is not always the URL asked for. */
  readonly url: string;
}

export type FetchOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: FetchRefusal };

export function refuse(code: FetchRefusalCode, url: string, reason: string): { readonly ok: false; readonly refusal: FetchRefusal } {
  return { ok: false, refusal: { code, reason, url } };
}
