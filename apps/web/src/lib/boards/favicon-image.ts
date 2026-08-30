/**
 * Deciding what a favicon actually is, from the bytes rather than from what the
 * server said it was.
 *
 * ## Why the header is not enough
 *
 * `@the-pit/fetch`'s `fetchAsset` checks `Content-Type` against a raster
 * allowlist before it reads a byte, and that check is worth having — it is what
 * stops a 4 GB video costing 4 GB. But it is a check on a CLAIM. The three
 * things a real backfill actually meets are:
 *
 * - **An HTML error page served as `image/png`.** Extremely common: a site with
 *   a catch-all router answers `/favicon.ico` with its 200-status "not found"
 *   page and a content type copied from the route it thought it was serving.
 *   Storing that gets you a broken-image glyph on the board.
 * - **A 1×1 tracking pixel, or a 1×1 transparent GIF used as a placeholder.**
 *   Perfectly valid image bytes. Renders as nothing, which looks exactly like
 *   the bug we are trying to avoid.
 * - **A 2400×1200 OpenGraph banner behind `<link rel="icon">`.** Also valid, and
 *   also not a favicon.
 *
 * So every stored icon is identified by its magic bytes, measured, and only then
 * accepted. `StoredFavicon.format` and `.mime` are always the answer this module
 * gave, never the answer the server gave.
 *
 * ## ICO gets opened
 *
 * A `.ico` is a container: a directory of entries at several sizes, each of
 * which is either a PNG or a raw DIB. Multi-resolution icons routinely carry a
 * 256×256 layer that costs 30 KB and that nobody will ever see at sixteen
 * pixels — and page weight is the whole cost of this feature, since the icons
 * ride inside the board document.
 *
 * So an ICO whose best entry is a PNG is UNWRAPPED to that PNG and stored as
 * one. That is not a transcode; it is lifting a member out of an archive, and it
 * is where most of the size saving is. An ICO whose entries are all raw DIBs is
 * kept whole — decoding a DIB and re-encoding a PNG would be an image codec, and
 * an image codec written to save a kilobyte is a bad trade. Those are usually
 * the small single-entry 16×16 files anyway.
 *
 * ## No SVG, at any layer
 *
 * There is no signature for SVG in this table and there never will be. An SVG is
 * a document that can carry script; these bytes are stored and then served back
 * inside our own origin as a `data:` URL. `@the-pit/fetch` refuses the content
 * type and this module fails to recognise the bytes — two independent refusals,
 * because one of them being wrong should not be enough.
 */

import type { FaviconFormat } from './favicon';

/** What a candidate must clear to be stored. */
export interface FaviconLimits {
  /** Smallest edge accepted. Kills 1×1 pixels and other invisible marks. */
  minEdge: number;
  /** Largest edge accepted. A banner behind `rel="icon"` is not a favicon. */
  maxEdge: number;
  /**
   * Largest payload considered, in bytes.
   *
   * A sanity bound and not the page-weight budget — that is `FAVICON_WEIGHT_LIMIT`
   * below, and it is measured on compressed bytes because compressed bytes are
   * what a reader downloads. This one exists so that a 300 KB "favicon" is
   * discarded before anything bothers to compress it.
   */
  maxBytes: number;
}

/**
 * The page-weight budget, in COMPRESSED bytes, per icon.
 *
 * ## Why the budget is not on the file size
 *
 * It was, and the file size turned out to be the wrong number by a factor of
 * three. Measured over the sixty-five icons the seeded ninety-two resolve to:
 *
 *     PNG    gzips to 1.01× its own size    — already deflated; incompressible
 *     WebP   gzips to 1.07×                  — likewise
 *     ICO    gzips to 0.34×                  — a raw uncompressed DIB, mostly
 *                                              runs of transparent padding
 *
 * A byte budget therefore charges a 4.3 KB `.ico` the same as a 4.3 KB `.png`
 * while the page pays 1.5 KB for one and 4.3 KB for the other. It rejects cheap
 * icons and admits expensive ones — precisely backwards. Budgeting on the
 * compressed size prices them the way the reader experiences them, and the
 * effect is not marginal: at this limit every one of the seventeen `.ico` files
 * is kept, for 24 KB across both boards.
 *
 * ## Why 2.5 KB
 *
 * The icons ride inside the board document, which is prerendered, so a board
 * pays the sum of these once. Measured on the real ninety-two:
 *
 *     limit    icons kept    icon bytes on the two boards
 *     1.5 KB      32/92           28 KB
 *     2.5 KB      53/92           66 KB
 *     5.0 KB      62/92           98 KB
 *
 * Above 2.5 KB the curve turns: the last nine icons cost 32 KB, over 3.5 KB each
 * of compressed page weight for one 16-pixel mark. Below it, the run of ordinary
 * 32×32 PNGs starts being thrown away for very little. `favicons-report.md` has
 * the measurement and the resulting page sizes.
 *
 * The expensive icons are almost all large PNGs — 96², 192², 201² — being drawn
 * into a sixteen-pixel box. Downscaling them would fit them inside this budget
 * easily and is the obvious next improvement; it needs a decoder and an encoder,
 * which is a different piece of work from this one.
 */
export const FAVICON_WEIGHT_LIMIT = 2560;

export const FAVICON_LIMITS: FaviconLimits = {
  minEdge: 8,
  maxEdge: 512,
  /**
   * 32 KB — a bound on what is worth compressing, not a page-weight budget.
   *
   * Anything past this is not a favicon: it is an app-store icon, an OpenGraph
   * banner behind the wrong `rel`, or a multi-resolution `.ico` that repacking
   * failed to shrink. `FAVICON_WEIGHT_LIMIT` is the number that decides what a
   * page actually carries.
   */
  maxBytes: 32 * 1024,
};

/** What this module decided about a candidate's bytes. */
export type ImageVerdict =
  | { ok: true; format: FaviconFormat; mime: string; width: number; height: number; bytes: Uint8Array }
  | { ok: false; code: FaviconRejection; reason: string };

export type FaviconRejection =
  /** The bytes are not any raster format this stores — very often an HTML error page. */
  | 'not_an_image'
  /** A raster we recognise, but whose dimensions we could not read. */
  | 'undecodable'
  /** Smaller than `minEdge`. A tracking pixel, a spacer, an invisible mark. */
  | 'too_small'
  /** Larger than `maxEdge`. A banner or a hero image with the wrong `rel`. */
  | 'too_large'
  /** A real icon that costs more page weight than a row of a board is worth. */
  | 'too_heavy'
  /** A real icon whose COMPRESSED cost is over `FAVICON_WEIGHT_LIMIT`. See there. */
  | 'too_costly';

const MIME_OF: Readonly<Record<FaviconFormat, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.byteLength < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(bytes[offset + i] ?? 0);
  return out;
}

function u16le(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function u16be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function u32be(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) * 0x1000000) +
    (((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0))
  );
}

function u32le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) +
    (bytes[offset + 1] ?? 0) * 0x100 +
    (bytes[offset + 2] ?? 0) * 0x10000 +
    (bytes[offset + 3] ?? 0) * 0x1000000
  );
}

/** i32, little-endian. BMP writes a negative height for a top-down bitmap. */
function i32le(bytes: Uint8Array, offset: number): number {
  const value = u32le(bytes, offset);
  return value >= 0x80000000 ? value - 0x100000000 : value;
}

interface Measured {
  format: FaviconFormat;
  width: number;
  height: number;
}

/** PNG: IHDR is always the first chunk, so width and height sit at fixed offsets. */
function measurePng(bytes: Uint8Array): Measured | null {
  if (bytes.byteLength < 24) return null;
  if (ascii(bytes, 12, 4) !== 'IHDR') return null;
  return { format: 'png', width: u32be(bytes, 16), height: u32be(bytes, 20) };
}

function measureGif(bytes: Uint8Array): Measured | null {
  if (bytes.byteLength < 10) return null;
  return { format: 'gif', width: u16le(bytes, 6), height: u16le(bytes, 8) };
}

function measureBmp(bytes: Uint8Array): Measured | null {
  if (bytes.byteLength < 26) return null;
  // A top-down BMP writes its height negative; the picture is the same size.
  return { format: 'bmp', width: Math.abs(i32le(bytes, 18)), height: Math.abs(i32le(bytes, 22)) };
}

/**
 * JPEG: walk the marker segments to a start-of-frame.
 *
 * There is no fixed offset — the frame can sit behind any amount of EXIF, ICC
 * and comment data — so the segments are stepped through by their own declared
 * lengths. Bounded by the buffer, so a truncated or malformed file runs out
 * rather than looping.
 */
function measureJpeg(bytes: Uint8Array): Measured | null {
  let offset = 2;
  while (offset + 9 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1] ?? 0;
    // Standalone markers carry no length: padding, RSTn, SOI, EOI.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    const length = u16be(bytes, offset + 2);
    if (length < 2) return null;
    const isFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isFrame) {
      return { format: 'jpeg', height: u16be(bytes, offset + 5), width: u16be(bytes, offset + 7) };
    }
    offset += 2 + length;
  }
  return null;
}

/** WebP: three container shapes — lossy VP8, lossless VP8L, extended VP8X. */
function measureWebp(bytes: Uint8Array): Measured | null {
  if (bytes.byteLength < 30) return null;
  const chunk = ascii(bytes, 12, 4);
  if (chunk === 'VP8 ') {
    // 14 bytes of frame tag, then the 0x9d012a sync code, then two 14-bit sizes.
    return { format: 'webp', width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const packed = u32le(bytes, 21);
    return { format: 'webp', width: (packed & 0x3fff) + 1, height: ((packed >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    const width = 1 + ((bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16));
    const height = 1 + ((bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16));
    return { format: 'webp', width, height };
  }
  return null;
}

interface IcoEntry {
  width: number;
  height: number;
  size: number;
  offset: number;
}

/** The ICO directory. `0` in a size byte means 256 — the format's one wart. */
function icoEntries(bytes: Uint8Array): IcoEntry[] {
  const count = u16le(bytes, 4);
  const entries: IcoEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = 6 + index * 16;
    if (at + 16 > bytes.byteLength) break;
    const size = u32le(bytes, at + 8);
    const offset = u32le(bytes, at + 12);
    if (size === 0 || offset + size > bytes.byteLength) continue;
    entries.push({
      width: (bytes[at] ?? 0) === 0 ? 256 : (bytes[at] ?? 0),
      height: (bytes[at + 1] ?? 0) === 0 ? 256 : (bytes[at + 1] ?? 0),
      size,
      offset,
    });
  }
  return entries;
}

/**
 * Which entry of a multi-resolution icon a sixteen-pixel row wants.
 *
 * Closest to 32 — one step above the display size, so it stays crisp on a 2×
 * screen — and, on a tie, the smaller file. Never the 256×256 layer, which is
 * where the weight is and which no row will ever show.
 */
const ICO_TARGET_EDGE = 32;

function bestIcoEntry(entries: readonly IcoEntry[]): IcoEntry | undefined {
  return [...entries].sort((a, b) => {
    const da = Math.abs(Math.max(a.width, a.height) - ICO_TARGET_EDGE);
    const db = Math.abs(Math.max(b.width, b.height) - ICO_TARGET_EDGE);
    return da - db || a.size - b.size;
  })[0];
}

/**
 * Identify and measure a candidate's bytes, unwrapping an ICO where that helps.
 *
 * Returns the bytes that should actually be STORED, which are not always the
 * bytes that came in: an ICO carrying a PNG hands back the PNG.
 */
export function inspectImage(bytes: Uint8Array): ImageVerdict {
  const measured = identify(bytes);
  if (measured === null) {
    // The commonest cause by a wide margin, so the message says so rather than
    // making whoever reads the log go and look at the bytes themselves.
    const head = ascii(bytes, 0, Math.min(16, bytes.byteLength)).replace(/[^\x20-\x7e]/g, '.');
    return {
      ok: false,
      code: 'not_an_image',
      reason: `the ${bytes.byteLength} bytes are no raster format we store (they begin ${JSON.stringify(head)}) — usually an HTML error page served with an image content type`,
    };
  }

  const { format, width, height, payload } = measured;
  if (width === 0 || height === 0) {
    return { ok: false, code: 'undecodable', reason: `a ${format} that declares a ${width}x${height} frame` };
  }
  const shortest = Math.min(width, height);
  const longest = Math.max(width, height);
  if (shortest < FAVICON_LIMITS.minEdge) {
    return {
      ok: false,
      code: 'too_small',
      reason: `${width}x${height} is under the ${FAVICON_LIMITS.minEdge}px floor — a tracking pixel or a spacer, not an icon`,
    };
  }
  if (longest > FAVICON_LIMITS.maxEdge) {
    return {
      ok: false,
      code: 'too_large',
      reason: `${width}x${height} is over the ${FAVICON_LIMITS.maxEdge}px ceiling — a banner behind rel="icon", not an icon`,
    };
  }
  if (payload.byteLength > FAVICON_LIMITS.maxBytes) {
    return {
      ok: false,
      code: 'too_heavy',
      reason: `${payload.byteLength} bytes is past the ${FAVICON_LIMITS.maxBytes}-byte ceiling on what could be an icon at all`,
    };
  }

  return { ok: true, format, mime: MIME_OF[format], width, height, bytes: payload };
}

interface Identified extends Measured {
  /** The bytes to store. Differs from the input only when an ICO was unwrapped. */
  payload: Uint8Array;
}

function identify(bytes: Uint8Array): Identified | null {
  if (startsWith(bytes, PNG_SIGNATURE)) {
    const measured = measurePng(bytes);
    return measured === null ? null : { ...measured, payload: bytes };
  }
  if (ascii(bytes, 0, 3) === 'GIF') {
    const measured = measureGif(bytes);
    return measured === null ? null : { ...measured, payload: bytes };
  }
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) {
    const measured = measureJpeg(bytes);
    return measured === null ? null : { ...measured, payload: bytes };
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') {
    const measured = measureWebp(bytes);
    return measured === null ? null : { ...measured, payload: bytes };
  }
  if (ascii(bytes, 0, 2) === 'BM') {
    const measured = measureBmp(bytes);
    return measured === null ? null : { ...measured, payload: bytes };
  }
  // ICO: `00 00 01 00`. CUR is `00 00 02 00` and is not an icon.
  if (startsWith(bytes, [0x00, 0x00, 0x01, 0x00])) return identifyIco(bytes);
  return null;
}

function identifyIco(bytes: Uint8Array): Identified | null {
  const entries = icoEntries(bytes);
  const best = bestIcoEntry(entries);
  if (best === undefined) return null;

  const member = bytes.subarray(best.offset, best.offset + best.size);
  // A PNG inside an ICO is lifted out and stored as a PNG. Nothing is decoded
  // or re-encoded; a member of an archive is copied out of it.
  if (startsWith(member, PNG_SIGNATURE)) {
    const measured = measurePng(member);
    if (measured !== null) return { ...measured, payload: member };
  }
  // A raw DIB member cannot be lifted out — an ICO's DIB has a doubled height
  // and a trailing AND mask, so it is not a BMP and turning it into one means
  // decoding pixels. But the CONTAINER can be rebuilt around just this member,
  // which costs no decoding at all and throws away every other resolution.
  //
  // This is where most of the weight actually comes off. The single commonest
  // shape in the seeded set is a three-entry 16/32/48 icon at about 15 KB, of
  // which the 32×32 layer is around 4 KB — over the page-weight budget whole,
  // comfortably inside it repacked.
  if (entries.length > 1) {
    const repacked = repackIco(bytes, best);
    return { format: 'ico', width: best.width, height: best.height, payload: repacked };
  }
  return { format: 'ico', width: best.width, height: best.height, payload: bytes };
}

/**
 * One ICO directory entry and its payload, as a whole ICO file.
 *
 * `6` bytes of header, one `16`-byte directory entry copied verbatim except for
 * its offset, and the member. The entry describes the member and nothing about
 * it changes, so the result is the same picture at the same resolution in the
 * same encoding — this discards the OTHER resolutions and nothing else.
 */
function repackIco(bytes: Uint8Array, entry: IcoEntry): Uint8Array {
  const HEADER = 6;
  const DIRECTORY = 16;
  const payloadAt = HEADER + DIRECTORY;
  const out = new Uint8Array(payloadAt + entry.size);

  // `00 00` reserved, `01 00` type=icon, `01 00` count=1.
  out[2] = 1;
  out[4] = 1;

  // The directory entry this member came with: width, height, colour count,
  // reserved, planes, bit depth, byte size — all still true of the member.
  const source = findEntryIndex(bytes, entry);
  out.set(bytes.subarray(HEADER + source * DIRECTORY, HEADER + source * DIRECTORY + DIRECTORY), HEADER);
  // Only the offset moves, because the member did.
  out[HEADER + 12] = payloadAt & 0xff;
  out[HEADER + 13] = (payloadAt >> 8) & 0xff;
  out[HEADER + 14] = 0;
  out[HEADER + 15] = 0;

  out.set(bytes.subarray(entry.offset, entry.offset + entry.size), payloadAt);
  return out;
}

/** Which directory slot an entry came from. `icoEntries` skips malformed slots, so this re-finds it. */
function findEntryIndex(bytes: Uint8Array, entry: IcoEntry): number {
  const count = u16le(bytes, 4);
  for (let index = 0; index < count; index += 1) {
    const at = 6 + index * 16;
    if (u32le(bytes, at + 12) === entry.offset && u32le(bytes, at + 8) === entry.size) return index;
  }
  return 0;
}
