/**
 * A product's favicon, as the boards hold it: bytes, not a link.
 *
 * ## Why the bytes and not the URL
 *
 * The obvious implementation is `<img src={product.faviconUrl}>`. It is wrong
 * three times over, and the reasons are the design:
 *
 * 1. **It leaks every visitor to forty-eight strangers.** A category board is 48
 *    products. Hotlinking makes one page view forty-eight requests to
 *    forty-eight third-party hosts, each carrying the visitor's IP, their
 *    `User-Agent`, and a `Referer` naming the board they are reading. The Pit's
 *    whole claim is that the board is not for sale; quietly telling forty-eight
 *    companies who is reading their row is not compatible with it.
 * 2. **It breaks constantly, and silently.** Sites move icons. A hotlinked
 *    favicon that 404s renders as a broken-image glyph in the middle of a row,
 *    and nothing in this repo would ever find out.
 * 3. **It is a render-time network dependency.** `brief` Part 3: boards are CDN
 *    snapshots and "reads never touch a model"; `02 §4`: "the board never
 *    computes anything at read time". A row that cannot draw itself until a
 *    stranger's server answers is not a static document.
 *
 * So the bytes are fetched ONCE, offline, by `favicon-backfill.ts`, through
 * `@the-pit/fetch`'s guards, and stored in an index that sits beside the board
 * data it describes. At render, an icon is a string that is already in hand.
 *
 * ## What the render path is allowed to know
 *
 * This module is on the board read path, so it holds the SHAPE and the two
 * pure functions the surfaces call, and nothing else. It reads no file, opens no
 * socket, and does not decode a byte: `data` is stored base64 and
 * `faviconDataUri` concatenates it into a `data:` URL. Everything that inspects
 * actual image bytes lives in `favicon-image.ts`, which the read path never
 * imports.
 *
 * ## The two things a stored icon is never allowed to be
 *
 * An SVG, and a lie about its own format. `IMAGE_CONTENT_TYPES` in
 * `@the-pit/fetch` refuses the first at the header, and `favicon-image.ts`
 * decides the format from the file's magic bytes rather than from what the
 * server claimed — so `mime` here was derived from the bytes it is attached to,
 * and a `data:` URL built from it cannot announce a type the payload is not.
 * That matters because a `data:` URL is same-origin: getting this wrong would be
 * stored XSS on every board at once.
 */

/**
 * Bumped when the stored shape changes and an existing index must be rebuilt.
 *
 * `isFaviconIndex` requires an exact match rather than accepting anything
 * lower, so an index written by an older backfill is simply not read: the board
 * draws fallbacks and re-running the backfill rebuilds it. That is cheaper and
 * far safer than a migration for a file that can be regenerated from the web.
 *
 * 2 — `weight` joined the record when the page-weight budget moved from file
 * size to compressed cost.
 */
export const FAVICON_INDEX_VERSION = 2;

/** The raster formats a stored icon may be. There is deliberately no vector here. */
export type FaviconFormat = 'png' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'ico';

/** One resolved icon. `data` is base64 of exactly `bytes` bytes of `format`. */
export interface StoredFavicon {
  /** The URL the bytes came from, after redirects. Recorded so a re-run can be audited. */
  source: string;
  format: FaviconFormat;
  /** The MIME derived from the BYTES, not from the response header. */
  mime: string;
  width: number;
  height: number;
  /** Length of the decoded payload. `data.length` is roughly 4/3 of this. */
  bytes: number;
  /**
   * What this icon costs a reader, in compressed bytes of `data`.
   *
   * Recorded rather than recomputed because it is the number the page-weight
   * budget was applied to (`FAVICON_WEIGHT_LIMIT`), and because it lets anyone
   * total a board's icon cost by reading the index instead of building the site.
   * Measuring it needs `node:zlib`, which the board read path has no business
   * importing.
   */
  weight: number;
  /** Base64. Rendered straight into a `data:` URL with no decode step. */
  data: string;
  /** ISO-8601. When the bytes were taken. */
  fetchedAt: string;
}

/**
 * A product that has no icon, and why.
 *
 * Recorded as carefully as a hit, for two reasons. It is what makes the backfill
 * RESUMABLE without re-fetching the two thirds of the web that will fail again —
 * a miss is an answer, and re-asking for it costs the same five seconds it cost
 * the first time. And it is the only way anyone can later tell "we never looked"
 * from "we looked and there is nothing there", which are very different facts
 * about a blank space on a board.
 */
export interface FaviconMiss {
  /** `FetchRefusalCode`, or one of `favicon-image.ts`'s rejection codes. */
  code: string;
  reason: string;
  checkedAt: string;
}

/**
 * One board's icons, keyed by the product URL exactly as `ranking.json` spells
 * it.
 *
 * Keyed by URL rather than by the engine's product id because the id is a
 * position in a run and the URL is the product's identity (`brief §2.5`
 * normalizes a submission to exactly that). A re-rank that renumbers rows must
 * not orphan every icon.
 */
export interface FaviconIndex {
  version: number;
  slug: string;
  /** ISO-8601 of the last backfill pass that touched this file. */
  updatedAt: string;
  icons: Record<string, StoredFavicon>;
  misses: Record<string, FaviconMiss>;
}

export function emptyFaviconIndex(slug: string): FaviconIndex {
  return { version: FAVICON_INDEX_VERSION, slug, updatedAt: new Date(0).toISOString(), icons: {}, misses: {} };
}

/**
 * The shape check a stored index has to pass to be used.
 *
 * Shallow, like `isRanking` next door, and for the same reason: this is a
 * document we wrote, and the failure it has to survive is "half-written" or
 * "from an older version", not "hostile". A version mismatch is a miss, not a
 * crash — the board renders fallbacks and a re-run of the backfill fixes it.
 */
export function isFaviconIndex(value: unknown): value is FaviconIndex {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<FaviconIndex>;
  return (
    candidate.version === FAVICON_INDEX_VERSION &&
    typeof candidate.slug === 'string' &&
    typeof candidate.icons === 'object' &&
    candidate.icons !== null &&
    typeof candidate.misses === 'object' &&
    candidate.misses !== null
  );
}

/**
 * A stored icon as an `<img src>`.
 *
 * The MIME is re-derived from `format` rather than trusted from the record, so
 * an index hand-edited to say `mime: "image/svg+xml"` over PNG bytes still emits
 * `image/png`. There is no format in the map whose value is a document type, and
 * that is the property being defended: a `data:` URL renders in this origin.
 */
const MIME_OF: Readonly<Record<FaviconFormat, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

/** Base64 and nothing else. A `data:` URL is same-origin; its payload is not a place to be relaxed. */
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function faviconDataUri(icon: StoredFavicon | undefined): string | undefined {
  if (icon === undefined) return undefined;
  const mime = MIME_OF[icon.format];
  if (mime === undefined) return undefined;
  if (typeof icon.data !== 'string' || icon.data === '' || !BASE64.test(icon.data)) return undefined;
  return `data:${mime};base64,${icon.data}`;
}

/**
 * The class name a row wears to get its icon — and the reason the icons are not
 * `<img src="data:...">` on the rows themselves.
 *
 * A board page is a server-rendered React document, which means anything that
 * reaches a component as a PROP is written into the page twice: once in the HTML
 * and once again in the serialized payload React ships for hydration. A 4 KB
 * data URL on 33 rows is therefore 264 KB of document, not 132 KB — measured, on
 * this board, before this indirection existed.
 *
 * Hoisting the bytes into one `<style>` block and passing rows a class name
 * fixes both halves of that at once:
 *
 * - the payload carries `"fi-1k2x9p"` instead of four kilobytes, so the doubling
 *   disappears;
 * - the class is derived from the icon's CONTENT, so products sharing an icon —
 *   and six of the seeded ninety-two share one, being built on the same
 *   template — share a rule and the bytes are emitted once.
 *
 * That is the "single sprite" option from the design space, built out of data
 * URLs rather than a stitched-together PNG: one document, no extra request, and
 * no per-row duplication. A stitched sprite would have been one more image to
 * regenerate whenever any single product's icon changed, and would have made a
 * board's icons un-cacheable independently of each other for no gain.
 *
 * FNV-1a over the payload, with the length mixed in. Short, stable across
 * builds, a valid CSS identifier, and a hash collision would show the wrong
 * 16-pixel icon on one row of one board rather than mean anything.
 */
export function faviconClass(icon: StoredFavicon): string {
  let hash = 0x811c9dc5;
  const source = `${icon.format}:${icon.bytes}:${icon.data}`;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    // The FNV prime, as shifts, because `hash * 16777619` loses precision.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return `fi-${hash.toString(36)}`;
}

/**
 * Every distinct icon on a board, as one block of CSS.
 *
 * Emitted into a `<style>` element by the surface that renders the rows. It is
 * safe as element TEXT rather than as raw HTML — the board surfaces have no
 * `dangerouslySetInnerHTML` and must never gain one — because every character
 * this can produce comes from a fixed template, a base64 alphabet and a MIME
 * string chosen from `MIME_OF`. None of those contains `<`, `>` or `&`, so React
 * escapes nothing and the CSS the browser parses is the CSS written here.
 * `faviconDataUri` refuses any payload that is not base64, which is what makes
 * that claim true of hostile input as well as of ours.
 */
/**
 * Narrow a board's CSS to the icons a subset of its rows actually wears.
 *
 * The homepage shows eight rows of a forty-eight-row board. Shipping the other
 * forty icons' bytes to draw eight of them would undo the entire point of
 * `home.ts`'s slice, and it would do it with the heaviest field on the row.
 *
 * One rule per line, each beginning `.<class>{`, so this is a filter over lines
 * rather than a CSS parser — which is the right amount of machinery for a
 * document this module wrote three functions ago.
 */
export function pickFaviconCss(css: string, keep: ReadonlySet<string>): string {
  if (css === '') return '';
  return css
    .split('\n')
    .filter((rule) => {
      const end = rule.indexOf('{');
      return end > 1 && keep.has(rule.slice(1, end));
    })
    .join('\n');
}

export function faviconCss(icons: readonly StoredFavicon[]): string {
  const rules = new Map<string, string>();
  for (const icon of icons) {
    const name = faviconClass(icon);
    if (rules.has(name)) continue;
    const uri = faviconDataUri(icon);
    if (uri === undefined) continue;
    rules.set(name, `.${name}{background-image:url("${uri}")}`);
  }
  return [...rules.values()].join('\n');
}

/**
 * The letter a product with no icon gets.
 *
 * Not a decorative choice. With ninety-two products and the real hit rate of
 * favicon resolution, a meaningful fraction of every board has no icon — so the
 * empty state is a design element with a large surface area, and a blank
 * sixteen-pixel gap reads as a page that failed to load. An initial in the same
 * box, at the same size, in the row's own mono, reads as a mark that was chosen.
 *
 * The first letter or digit of the name, which is what a reader would say if
 * asked to abbreviate it. A name with none — an emoji, a script with no case —
 * gets `·`, which is a mark rather than a hole.
 */
export function faviconInitial(name: string): string {
  const found = /[\p{L}\p{N}]/u.exec(name);
  return found === null ? '·' : (found[0] ?? '·').toUpperCase();
}
