/**
 * The guarded fetcher: the one place in The Pit that dereferences a URL a
 * stranger typed.
 *
 * ## The threat
 *
 * Two features need it — resolving a link shortener so the per-product cap
 * cannot be evaded by pasting `bit.ly/x` (`brief §2.5`), and reading a product's
 * own `<title>`/`<meta>` so the board judges first-party copy. Both take a URL
 * chosen by the person the guard is protecting the system from, which makes both
 * of them server-side request forgery. That is why the fetch lives in its own
 * module with its own tests, and why nothing else in the repo is allowed to call
 * `fetch()` on a submitted URL.
 *
 * ## The order the guards run in, and why that order
 *
 * For every hop, not just the first:
 *
 * 1. **Parse and check the scheme.** `http` and `https` only, before anything
 *    else happens. `file:///etc/passwd` and `data:text/html,...` never reach a
 *    resolver.
 * 2. **Refuse credentials and odd ports.** `http://metadata@evil/` is a parser
 *    confusion attempt; port 6379 is not a website.
 * 3. **Resolve the hostname ONCE**, and judge every address the resolver
 *    returned. Any private, loopback, link-local or otherwise non-public answer
 *    refuses the whole hop — not just that answer — because a name with one
 *    public and one private address is a rebinding attack, not a multi-homed
 *    site.
 * 4. **Connect to the address that was judged.** The transport is handed the IP,
 *    not the name. Resolving twice — once to check, once to connect — is the
 *    classic rebinding hole, and this shape closes it by construction.
 * 5. **On a 3xx, discard the body and go back to step 1** with the `Location`.
 *    The redirect target is a fresh, fully-untrusted URL. A public host that
 *    302s to `169.254.169.254` is the standard bypass and checking only the
 *    first hop is the standard mistake.
 * 6. **On a final response, check the status and the content type BEFORE
 *    reading a byte.** A 12 GB `application/octet-stream` should cost one set of
 *    response headers, not 12 GB of memory.
 *
 * Around all of it: a redirect cap, a wall-clock budget checked at every hop,
 * and a byte cap handed to the transport rather than applied to a buffer that
 * has already been filled.
 *
 * ## Failing closed
 *
 * Everything returns `FetchOutcome`, never a thrown error and never `null`.
 * There is no path that retries without a guard, and callers cannot accidentally
 * treat a refusal as an empty result: they have to read `ok`.
 */

import {
  ALLOWED_PORTS,
  HTML_CONTENT_TYPES,
  MAX_REDIRECTS,
  MAX_RESPONSE_BYTES,
  MAX_URL_LENGTH,
  TOTAL_TIMEOUT_MS,
  USER_AGENT,
} from './limits.js';
import { checkAddress, parseAddress } from './address.js';
import { refuse, type FetchOutcome, type FetchRefusal } from './refusal.js';
import type { HostResolver, Transport, TransportResponse } from './transport.js';

/** The 3xx codes that carry a `Location` worth following. `304` deliberately is not one. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const DEFAULT_PORT: Readonly<Record<string, number>> = { 'http:': 80, 'https:': 443 };

export interface GuardedFetcherOptions {
  readonly resolver: HostResolver;
  readonly transport: Transport;
  readonly maxRedirects?: number;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly allowedPorts?: readonly number[];
  readonly userAgent?: string;
  /** Injectable clock. The wall-clock budget is a guard, so it is testable like one. */
  readonly now?: () => number;
}

/** Where a URL actually leads, after every redirect has been followed and judged. */
export interface ResolvedTarget {
  readonly requestedUrl: string;
  readonly finalUrl: string;
  /** Every URL contacted, in order, starting with the one asked for. */
  readonly chain: readonly string[];
  readonly status: number;
}

export interface FetchedDocument extends ResolvedTarget {
  readonly contentType: string;
  readonly html: string;
  readonly bytesRead: number;
  /** The body hit `maxBytes`. What is here is a prefix, which is all a `<head>` needs. */
  readonly truncated: boolean;
}

export interface GuardedFetcher {
  /**
   * Follow the redirect chain and report where it ends, WITHOUT reading a body.
   *
   * This is what shortener resolution needs, and reading no body is deliberate:
   * a shortener may point at a PDF or a video, and the target's content type is
   * none of the cap's business. It still runs every address guard on every hop.
   */
  resolveFinal(url: string): Promise<FetchOutcome<ResolvedTarget>>;
  /** Follow the chain and read the (capped) body, provided it is HTML. */
  fetchDocument(url: string): Promise<FetchOutcome<FetchedDocument>>;
}

interface Hop {
  readonly url: URL;
  readonly address: string;
  readonly family: 4 | 6;
}

export function createGuardedFetcher(options: GuardedFetcherOptions): GuardedFetcher {
  const maxRedirects = options.maxRedirects ?? MAX_REDIRECTS;
  const timeoutMs = options.timeoutMs ?? TOTAL_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
  const allowedPorts = options.allowedPorts ?? ALLOWED_PORTS;
  const userAgent = options.userAgent ?? USER_AGENT;
  const now = options.now ?? (() => Date.now());

  /** Guards 1 and 2: is this string a URL this fetcher is willing to dereference at all? */
  function parseTarget(raw: string): FetchOutcome<URL> {
    if (raw.length > MAX_URL_LENGTH) {
      return refuse('invalid_url', raw.slice(0, 120), `URL is ${raw.length} characters, over the ${MAX_URL_LENGTH} limit`);
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return refuse('invalid_url', raw, `${JSON.stringify(raw)} is not a URL`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return refuse('unsupported_scheme', raw, `${url.protocol} is not a scheme this fetcher will dereference; http and https only`);
    }
    if (url.username !== '' || url.password !== '') {
      return refuse('credentials_in_url', raw, 'a URL carrying credentials will not be fetched');
    }
    if (url.hostname === '') {
      return refuse('invalid_url', raw, 'URL has no host');
    }
    const port = url.port === '' ? (DEFAULT_PORT[url.protocol] ?? -1) : Number(url.port);
    if (!allowedPorts.includes(port)) {
      return refuse('blocked_port', raw, `port ${port} is not in the allowed set (${allowedPorts.join(', ')})`);
    }
    return { ok: true, value: url };
  }

  /**
   * Guards 3 and 4. Resolves once, judges every answer, and returns the single
   * address the transport will dial.
   *
   * An IP literal in the URL skips DNS but not the check — `http://169.254.169.254/`
   * is refused by the same table that refuses a name pointing there.
   */
  async function pin(url: URL): Promise<FetchOutcome<{ readonly address: string; readonly family: 4 | 6 }>> {
    const literal = parseAddress(url.hostname);
    if (literal !== null) {
      const verdict = checkAddress(url.hostname);
      if (!verdict.allowed) {
        return refuse('blocked_address', url.href, verdict.reason);
      }
      return { ok: true, value: { address: stripBrackets(url.hostname), family: literal.family } };
    }

    let answers: readonly string[];
    try {
      answers = await options.resolver.resolve(url.hostname);
    } catch (error) {
      return refuse('dns_failure', url.href, `could not resolve ${url.hostname}: ${messageOf(error)}`);
    }
    if (answers.length === 0) {
      return refuse('dns_failure', url.href, `${url.hostname} resolved to no addresses`);
    }

    // EVERY answer must pass. A name that answers with one public and one
    // private address is not a multi-homed site; it is a rebinding attack
    // hoping the fetcher picks the public one to check and the private one to
    // dial.
    for (const answer of answers) {
      const verdict = checkAddress(answer);
      if (!verdict.allowed) {
        return refuse('blocked_address', url.href, `${url.hostname} resolves to ${verdict.reason}`);
      }
    }

    const first = answers[0] ?? '';
    const parsed = parseAddress(first);
    if (parsed === null) {
      return refuse('dns_failure', url.href, `${url.hostname} resolved to ${JSON.stringify(first)}, which is not an address`);
    }
    return { ok: true, value: { address: stripBrackets(first), family: parsed.family } };
  }

  /**
   * The hop loop. Identical for both entry points — what a caller does with the
   * final response differs, what the guards do does not.
   */
  async function walk(
    requestedUrl: string,
  ): Promise<FetchOutcome<{ readonly hop: Hop; readonly response: TransportResponse; readonly chain: string[] }>> {
    const deadline = now() + timeoutMs;
    const controller = new AbortController();
    const alarm = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof alarm.unref === 'function') alarm.unref();

    try {
      const chain: string[] = [];
      const seen = new Set<string>();
      let next = requestedUrl;

      for (let hopIndex = 0; ; hopIndex += 1) {
        if (hopIndex > maxRedirects) {
          return refuse(
            'too_many_redirects',
            next,
            `more than ${maxRedirects} redirects from ${requestedUrl}; chain was ${chain.join(' -> ')}`,
          );
        }
        if (now() >= deadline) {
          return refuse('timeout', next, `the ${timeoutMs}ms budget ran out after ${chain.length} hop(s)`);
        }

        const target = parseTarget(next);
        if (!target.ok) return target;
        const url = target.value;

        if (seen.has(url.href)) {
          return refuse('redirect_loop', url.href, `${url.href} was already fetched in this chain`);
        }
        seen.add(url.href);
        chain.push(url.href);

        const pinned = await pin(url);
        if (!pinned.ok) return pinned;
        const hop: Hop = { url, address: pinned.value.address, family: pinned.value.family };

        let response: TransportResponse;
        try {
          response = await options.transport.send({
            url: url.href,
            hostname: url.hostname,
            port: url.port === '' ? (DEFAULT_PORT[url.protocol] as number) : Number(url.port),
            protocol: url.protocol as 'http:' | 'https:',
            address: hop.address,
            family: hop.family,
            headers: {
              'user-agent': userAgent,
              accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
              'accept-encoding': 'identity',
            },
            signal: controller.signal,
          });
        } catch (error) {
          if (isAbort(error) || now() >= deadline) {
            return refuse('timeout', url.href, `the ${timeoutMs}ms budget ran out fetching ${url.href}`);
          }
          return refuse('transport_error', url.href, `could not fetch ${url.href}: ${messageOf(error)}`);
        }

        if (REDIRECT_STATUSES.has(response.status)) {
          // The body of a redirect is never interesting and is never read.
          response.discard();
          const location = response.headers['location'];
          if (location === undefined || location.trim() === '') {
            return refuse('redirect_without_location', url.href, `${response.status} with no Location header`);
          }
          // Resolved against the CURRENT hop, not the original request: a
          // relative `Location` on the third hop means something different from
          // the same string on the first.
          let resolved: string;
          try {
            resolved = new URL(location.trim(), url).href;
          } catch {
            return refuse('invalid_url', url.href, `Location ${JSON.stringify(location)} is not a URL`);
          }
          next = resolved;
          continue;
        }

        return { ok: true, value: { hop, response, chain } };
      }
    } finally {
      clearTimeout(alarm);
    }
  }

  return {
    async resolveFinal(requestedUrl: string): Promise<FetchOutcome<ResolvedTarget>> {
      const walked = await walk(requestedUrl);
      if (!walked.ok) return walked;
      const { hop, response, chain } = walked.value;
      // No body is wanted, so none is pulled — a shortener may legitimately
      // point at a 40 MB PDF, and where it points is the only question asked.
      response.discard();
      if (response.status < 200 || response.status >= 300) {
        return refuse('bad_status', hop.url.href, `${hop.url.href} answered ${response.status}`);
      }
      return {
        ok: true,
        value: { requestedUrl, finalUrl: hop.url.href, chain, status: response.status },
      };
    },

    async fetchDocument(requestedUrl: string): Promise<FetchOutcome<FetchedDocument>> {
      const walked = await walk(requestedUrl);
      if (!walked.ok) return walked;
      const { hop, response, chain } = walked.value;

      if (response.status < 200 || response.status >= 300) {
        response.discard();
        return refuse('bad_status', hop.url.href, `${hop.url.href} answered ${response.status}`);
      }

      // Decided from the headers. `read` is not called on this path, so a
      // `video/mp4` costs one set of response headers and nothing else.
      const rawType = response.headers['content-type'] ?? '';
      const essence = rawType.split(';')[0]?.trim().toLowerCase() ?? '';
      if (!HTML_CONTENT_TYPES.includes(essence)) {
        response.discard();
        return refuse(
          'unsupported_content_type',
          hop.url.href,
          rawType === ''
            ? `${hop.url.href} sent no content type; only ${HTML_CONTENT_TYPES.join(' and ')} are read`
            : `${hop.url.href} is ${essence}, not ${HTML_CONTENT_TYPES.join(' or ')}`,
        );
      }

      let body: { readonly bytes: Uint8Array; readonly truncated: boolean };
      try {
        body = await response.read(maxBytes);
      } catch (error) {
        if (isAbort(error)) {
          return refuse('timeout', hop.url.href, `the ${timeoutMs}ms budget ran out reading ${hop.url.href}`);
        }
        return refuse('transport_error', hop.url.href, `could not read ${hop.url.href}: ${messageOf(error)}`);
      }

      return {
        ok: true,
        value: {
          requestedUrl,
          finalUrl: hop.url.href,
          chain,
          status: response.status,
          contentType: essence,
          html: decode(body.bytes, rawType),
          bytesRead: body.bytes.byteLength,
          truncated: body.truncated,
        },
      };
    },
  };
}

/** `URL.hostname` keeps the brackets on an IPv6 literal; a socket does not want them. */
function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * Bytes to text.
 *
 * A truncated body can end mid-sequence, so the decoder is deliberately
 * non-fatal: a half-character at the cap becomes U+FFFD rather than an
 * exception. An unrecognised charset falls back to UTF-8 for the same reason —
 * a site declaring `charset=cp-nonsense` gets mojibake, not a refused
 * submission.
 */
function decode(bytes: Uint8Array, contentType: string): string {
  const declared = /charset\s*=\s*"?([\w.:+-]+)"?/i.exec(contentType)?.[1];
  if (declared !== undefined) {
    try {
      return new TextDecoder(declared, { fatal: false }).decode(bytes);
    } catch {
      // fall through
    }
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type { FetchRefusal };
