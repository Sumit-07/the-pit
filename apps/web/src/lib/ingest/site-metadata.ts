/**
 * `POST /api/site-metadata` — the submission form's autofill, and the only
 * public door onto the guarded fetcher.
 *
 * ## Why this endpoint exists
 *
 * 913 of the 1028 seeded product descriptions were scraped from a third-party
 * directory rather than written by the companies, so today's jurors are partly
 * scoring a directory's house style. And a paid submission gets 300 characters
 * against a seeded median of 141, so the two populations are not even the same
 * shape. Reading a product's own `<title>` and `<meta name="description">` fixes
 * both at once: seeded rows and paid rows end up carrying first-party copy of
 * comparable length, and what the founder *claims* moves into its own labelled
 * field (`pitch`) beside it.
 *
 * ## Nothing here fetches anything
 *
 * Every outbound request goes through `readProductMetadata` in
 * `lib/ingest/product-url.ts`, which is `@the-pit/fetch`'s `fetchPageMetadata`
 * behind the SSRF guards: scheme, port and credentials checked per hop, the
 * hostname resolved ONCE and every answer judged, the transport handed the
 * address that was judged rather than the name, a redirect cap, a wall-clock
 * budget and a byte cap. A second fetch path on this route would be an
 * unauthenticated SSRF hole, so there is not one — this module contains no
 * `fetch`, no `node:https` and no `node:dns`, and the only network-shaped thing
 * it can reach is that one injected function.
 *
 * ## The three rules the answer obeys
 *
 * 1. **It never fails the submission.** A site with no description, a site that
 *    times out, a guard refusal, a resolver that threw — every one of them is
 *    `{"status":"nothing"}` with a `reason` for the log, answered 200. The form
 *    still posts, the buyer still pays, and nothing has to be cleared. The only
 *    non-200 is the rate limit, and the browser treats that as "nothing found"
 *    too.
 * 2. **Everything it returns is untrusted third-party text.** It lands in a form
 *    field, and from there in a `submissions` row, a juror prompt and a rendered
 *    page. `extractMetadata` already decoded entities once, stripped tags and
 *    ran the engine's `sanitize`; `outboundText` below is the second pass at the
 *    boundary, and it deliberately does NOT decode again — see its comment.
 * 3. **It is rate limited.** `submit:metadata:ip`. See `SITE_METADATA_RATE_LIMIT`.
 */

import { bucketKey, clientIp, type RateLimitPolicy, type RateLimiter } from '@the-pit/auth';
import { SANITIZE_LIMIT } from '@the-pit/engine';
import { bestCopy, METADATA_URL_LIMIT, TITLE_LIMIT, type FetchOutcome, type PageMetadata } from '@the-pit/fetch';

import { readProductMetadata } from '@/lib/ingest/product-url';

/**
 * The budget: 20 lookups per 5 minutes, per client address.
 *
 * Sized against the two populations that hit it. A person filling the form in
 * touches the URL field a handful of times — paste, correct a typo, tab away
 * again — and the browser only asks when the value actually CHANGED, so twenty
 * is several careful attempts and well clear of anyone real. A script walking a
 * list of hosts to see which ones answer wants thousands, and meets the wall on
 * its twenty-first.
 *
 * Five minutes rather than fifteen because this is a form-filling session, not a
 * mail budget: someone who genuinely burned twenty lookups is back in business
 * before they have finished typing their pitch.
 */
export const SITE_METADATA_RATE_LIMIT: RateLimitPolicy = { limit: 20, windowMs: 5 * 60 * 1000 };

/**
 * How much of each field crosses back.
 *
 * The description cap is `SANITIZE_LIMIT` and not something of this module's own
 * choosing: it is the size of the field this text is about to be dropped into,
 * and returning 400 characters for a 300-character `<textarea>` would hand the
 * browser a value the server would then reject.
 */
export const METADATA_TITLE_LIMIT = TITLE_LIMIT;
export const METADATA_DESCRIPTION_LIMIT = SANITIZE_LIMIT;

/** What the site said, after two passes of sanitizing. Every field optional. */
export interface SiteMetadataFound {
  readonly status: 'found';
  /** The URL the document was finally served from, after redirects. */
  readonly url: string;
  readonly title?: string;
  readonly description?: string;
  /** Absolute http(s). Rendered as an `<img src>`, so it is re-checked here. */
  readonly faviconUrl?: string;
}

/**
 * Nothing usable, for any reason at all.
 *
 * `reason` is a short machine code — a `FetchRefusalCode`, or one of the local
 * ones below. It is for the browser's status line and the server log, and it is
 * never a sentence the visitor has to act on: there is nothing to fix, because
 * the fields they were going to type are still theirs to type.
 */
export interface SiteMetadataNothing {
  readonly status: 'nothing';
  readonly reason: string;
}

export type SiteMetadataAnswer = SiteMetadataFound | SiteMetadataNothing;

function nothing(reason: string): SiteMetadataNothing {
  return { status: 'nothing', reason };
}

/**
 * The second sanitizing pass, at the boundary where the text leaves us.
 *
 * It does NOT decode entities. `cleanText` in `@the-pit/fetch` decodes exactly
 * once, on purpose, so that `&amp;lt;` survives as the literal `&lt;` rather
 * than becoming `<`; decoding a second time here would undo that guarantee and
 * hand a site a way to smuggle markup past the extractor by double-encoding it.
 *
 * So this pass only ever REMOVES: any angle bracket that somehow survived, any
 * control character, and any run of whitespace collapses to one space. Then it
 * truncates. Every one of those is idempotent and none of them can turn inert
 * text into markup.
 */
export function outboundText(raw: string, limit: number): string {
  return raw
    .replace(/[<>]/g, '')
    // C0, C1, the zero-width smugglers and the bidi overrides. `sanitize` in
    // `@the-pit/engine` already removed these upstream; they are named again
    // here because this is the last function the text passes through before it
    // is somebody else's problem, and the cost of the second pass is nothing.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069\uFEFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

/**
 * An absolute http(s) URL, or nothing.
 *
 * `extractMetadata` already dropped `javascript:` and `data:` favicons. This
 * repeats the check because the value is about to become an `<img src>` on the
 * buying page, and a second `new URL()` costs nothing next to being wrong once.
 */
export function outboundUrl(raw: string | undefined): string | undefined {
  if (raw === undefined || raw === '' || raw.length > METADATA_URL_LIMIT) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  return parsed.href;
}

/** The one function this module needs from the network. Injected, so a test opens no socket. */
export type MetadataReader = (url: string) => Promise<FetchOutcome<PageMetadata>>;

/**
 * Read a URL's `<head>` and answer with something a form field can hold.
 *
 * Total function: it returns an answer for every input, including inputs that
 * are not URLs and fetchers that throw. There is no path out of here that a
 * caller has to `catch`, because the caller is a route on the buying page.
 */
export async function readSiteMetadata(
  rawUrl: string,
  read: MetadataReader = readProductMetadata,
): Promise<SiteMetadataAnswer> {
  const url = rawUrl.trim();
  if (url === '') return nothing('empty_url');

  // Cheap and local, before anything is dereferenced. The guarded fetcher would
  // refuse these too — this only saves it the trip.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return nothing('invalid_url');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return nothing('unsupported_scheme');

  let outcome: FetchOutcome<PageMetadata>;
  try {
    outcome = await read(url);
  } catch (error) {
    // `fetchPageMetadata` returns refusals as values and does not throw. This
    // arm exists because the alternative to catching here is a 500 on the page
    // that takes someone's money, over a field they did not have to fill in.
    console.error(`[site-metadata] the reader threw: ${error instanceof Error ? error.message : String(error)}`);
    return nothing('reader_error');
  }

  if (!outcome.ok) {
    // Deliberately not surfaced as an error. A private address, a timeout and a
    // 404 are all the same thing from the form's point of view: type it yourself.
    return nothing(outcome.refusal.code);
  }

  const metadata = outcome.value;
  // OpenGraph first — it is the copy a site chose for being shared, which is
  // closer to a pitch than a `<title>` full of "| Pricing | Home".
  const copy = bestCopy(metadata);

  const title = outboundText(copy.title ?? '', METADATA_TITLE_LIMIT);
  const description = outboundText(copy.description ?? '', METADATA_DESCRIPTION_LIMIT);
  const faviconUrl = outboundUrl(metadata.faviconUrl);
  const finalUrl = outboundUrl(metadata.url) ?? url;

  // Built by assignment so a field the site did not supply is genuinely ABSENT
  // from the JSON rather than an empty string a caller might prefill with.
  const found: { -readonly [K in keyof SiteMetadataFound]: SiteMetadataFound[K] } = {
    status: 'found',
    url: finalUrl,
  };
  if (title !== '') found.title = title;
  if (description !== '') found.description = description;
  if (faviconUrl !== undefined) found.faviconUrl = faviconUrl;
  return found;
}

// ---------------------------------------------------------------------------
// The route handler.
// ---------------------------------------------------------------------------

export interface SiteMetadataDeps {
  readonly limiter: RateLimiter;
  /** Overridable so a test can prove the wall is hit without spending twenty calls. */
  readonly policy?: RateLimitPolicy;
  /** The guarded read. Defaults to the real one; a test installs a fake. */
  readonly read?: MetadataReader;
  readonly now?: () => Date;
  readonly trustedProxyHops?: number;
}

/**
 * `no-store` and `nosniff` on every answer.
 *
 * The body is text a stranger's server wrote. `nosniff` is what keeps a browser
 * from deciding a JSON response full of someone else's copy is HTML, and
 * `no-store` keeps a per-visitor lookup out of a shared cache.
 */
const METADATA_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store, no-cache, must-revalidate',
  'referrer-policy': 'no-referrer',
  'x-robots-tag': 'noindex, nofollow',
  'x-content-type-options': 'nosniff',
};

function json(body: unknown, status: number, extra: Readonly<Record<string, string>> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...METADATA_HEADERS, ...extra, 'content-type': 'application/json; charset=utf-8' },
  });
}

/** The submitted URL, whichever way the caller sent it. */
async function readUrlField(request: Request): Promise<string> {
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const parsed: unknown = await request.json().catch(() => ({}));
    const body = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const value = body['url'];
    return typeof value === 'string' ? value : '';
  }
  const form = await request.formData().catch(() => new FormData());
  const value = form.get('url');
  return typeof value === 'string' ? value : '';
}

/**
 * `POST /api/site-metadata`.
 *
 * POST and not GET, deliberately. A GET that makes an outbound request is a URL
 * anyone can put in an `<img>`, a link preview or a crawler's queue, and every
 * one of those spends our egress from someone else's browser. A POST has to be
 * asked for.
 */
export async function handleSiteMetadata(request: Request, deps: SiteMetadataDeps): Promise<Response> {
  const now = (deps.now ?? (() => new Date()))();
  const ipOptions = deps.trustedProxyHops === undefined ? {} : { trustedProxyHops: deps.trustedProxyHops };
  const ip = clientIp(request.headers, ipOptions);

  const decision = await deps.limiter.consume({
    key: bucketKey('submit:metadata:ip', ip),
    policy: deps.policy ?? SITE_METADATA_RATE_LIMIT,
    now,
  });

  if (!decision.allowed) {
    // The one non-200. The browser reads it as "nothing found" like any other
    // failure, so a limited visitor types the fields themselves and still pays.
    return json({ status: 'limited', retryAfterSeconds: decision.retryAfterSeconds }, 429, {
      'retry-after': String(decision.retryAfterSeconds),
    });
  }

  const url = await readUrlField(request);
  const answer = await readSiteMetadata(url, deps.read ?? readProductMetadata);
  return json(answer, 200);
}
