/**
 * What a favicon actually is, decided from the bytes.
 *
 * `@the-pit/fetch` checks the `Content-Type` header before it reads a body, and
 * that check is worth having — but it is a check on a CLAIM, and the three
 * things a real backfill meets are an HTML error page served as `image/png`, a
 * 1×1 tracking pixel, and a 2400px banner behind `rel="icon"`. All three pass
 * the header check. None of them is a favicon.
 *
 * So these are the tests for the second half of that decision: the magic bytes,
 * the dimensions read out of each format's own header, the two limits that keep
 * an invisible mark and a hero image off a board, and the container surgery that
 * makes a multi-resolution `.ico` affordable.
 *
 * Every fixture is built here, byte by byte. No files, no network, no fixtures
 * directory — the point of each one is a specific byte at a specific offset, and
 * a binary blob on disk would hide exactly the thing under test.
 */

import { describe, expect, it } from 'vitest';

import { FAVICON_LIMITS, inspectImage } from '@/lib/boards/favicon-image';

// ------------------------------------------------------------------ fixtures

/** A PNG whose IHDR declares `width` × `height`, padded to `size` bytes. */
function png(width: number, height: number, size = 200): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, 24));
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  bytes.set([0, 0, 0, 13], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  writeU32BE(bytes, 16, width);
  writeU32BE(bytes, 20, height);
  return bytes;
}

function gif(width: number, height: number, size = 60): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, 13));
  bytes.set([...'GIF89a'].map((c) => c.charCodeAt(0)));
  writeU16LE(bytes, 6, width);
  writeU16LE(bytes, 8, height);
  return bytes;
}

function bmp(width: number, height: number, size = 80): Uint8Array {
  const bytes = new Uint8Array(Math.max(size, 26));
  bytes.set([0x42, 0x4d]); // "BM"
  writeI32LE(bytes, 18, width);
  writeI32LE(bytes, 22, height);
  return bytes;
}

/** A JPEG with `bytesOfJunk` of EXIF before the frame, so the marker walk is exercised. */
function jpeg(width: number, height: number, bytesOfJunk = 40): Uint8Array {
  const junkSegment = 2 + bytesOfJunk;
  const bytes = new Uint8Array(2 + 2 + junkSegment + 2 + 9 + 10);
  let at = 0;
  bytes.set([0xff, 0xd8], at);
  at += 2;
  // APP1 (EXIF), which the walk has to step over by its declared length.
  bytes.set([0xff, 0xe1], at);
  at += 2;
  writeU16BE(bytes, at, junkSegment);
  at += junkSegment;
  // SOF0.
  bytes.set([0xff, 0xc0], at);
  writeU16BE(bytes, at + 2, 11);
  bytes[at + 4] = 8; // precision
  writeU16BE(bytes, at + 5, height);
  writeU16BE(bytes, at + 7, width);
  return bytes;
}

function webpLossy(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(40);
  bytes.set([...'RIFF'].map((c) => c.charCodeAt(0)));
  bytes.set([...'WEBP'].map((c) => c.charCodeAt(0)), 8);
  bytes.set([...'VP8 '].map((c) => c.charCodeAt(0)), 12);
  writeU16LE(bytes, 26, width);
  writeU16LE(bytes, 28, height);
  return bytes;
}

interface IcoMember {
  width: number;
  height: number;
  payload: Uint8Array;
}

/** A real ICO container: 6-byte header, one 16-byte directory entry each, then the members. */
function ico(members: readonly IcoMember[]): Uint8Array {
  const directory = 6 + members.length * 16;
  const total = directory + members.reduce((sum, member) => sum + member.payload.byteLength, 0);
  const bytes = new Uint8Array(total);
  writeU16LE(bytes, 0, 0);
  writeU16LE(bytes, 2, 1); // type: icon
  writeU16LE(bytes, 4, members.length);

  let offset = directory;
  members.forEach((member, index) => {
    const at = 6 + index * 16;
    bytes[at] = member.width === 256 ? 0 : member.width;
    bytes[at + 1] = member.height === 256 ? 0 : member.height;
    bytes[at + 6] = 32; // bit depth, carried through a repack unchanged
    writeU32LE(bytes, at + 8, member.payload.byteLength);
    writeU32LE(bytes, at + 12, offset);
    bytes.set(member.payload, offset);
    offset += member.payload.byteLength;
  });
  return bytes;
}

/** A raw DIB member — an ICO's other payload form, which is not a standalone BMP. */
function dib(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  writeU32LE(bytes, 0, 40); // BITMAPINFOHEADER
  return bytes;
}

function writeU32BE(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = (value >>> 24) & 0xff;
  bytes[at + 1] = (value >>> 16) & 0xff;
  bytes[at + 2] = (value >>> 8) & 0xff;
  bytes[at + 3] = value & 0xff;
}
function writeU16BE(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = (value >>> 8) & 0xff;
  bytes[at + 1] = value & 0xff;
}
function writeU16LE(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = value & 0xff;
  bytes[at + 1] = (value >>> 8) & 0xff;
}
function writeI32LE(bytes: Uint8Array, at: number, value: number): void {
  writeU32LE(bytes, at, value < 0 ? value + 0x100000000 : value);
}
function writeU32LE(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = value & 0xff;
  bytes[at + 1] = (value >>> 8) & 0xff;
  bytes[at + 2] = (value >>> 16) & 0xff;
  bytes[at + 3] = (value >>> 24) & 0xff;
}

const ascii = (text: string): Uint8Array => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));

// --------------------------------------------------------------------- tests

describe('the format is read from the bytes, never from a header', () => {
  it('identifies and measures every raster format it stores', () => {
    const cases = [
      { name: 'png', bytes: png(32, 32), format: 'png', width: 32, height: 32 },
      { name: 'gif', bytes: gif(48, 24), format: 'gif', width: 48, height: 24 },
      { name: 'bmp', bytes: bmp(16, 16), format: 'bmp', width: 16, height: 16 },
      { name: 'jpeg', bytes: jpeg(64, 48), format: 'jpeg', width: 64, height: 48 },
      { name: 'webp', bytes: webpLossy(32, 32), format: 'webp', width: 32, height: 32 },
    ] as const;

    for (const one of cases) {
      const verdict = inspectImage(one.bytes);
      expect(verdict.ok, one.name).toBe(true);
      if (verdict.ok) {
        expect(verdict.format, one.name).toBe(one.format);
        expect([verdict.width, verdict.height], one.name).toEqual([one.width, one.height]);
      }
    }
  });

  it('reads a top-down BMP, whose height is written negative', () => {
    const verdict = inspectImage(bmp(32, -32));
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.height).toBe(32);
  });

  it('rejects an HTML error page served as an image — the commonest real failure', () => {
    // A site with a catch-all router answers /favicon.ico with its 200-status
    // "page not found" document and an image content type copied from the route
    // it thought it was serving. The header check cannot see this.
    const verdict = inspectImage(ascii('<!DOCTYPE html><html><head><title>Not found</title>'));

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe('not_an_image');
      // The message says what it probably was, so nobody has to go and look.
      expect(verdict.reason).toContain('HTML error page');
      expect(verdict.reason).toContain('<!DOCTYPE html>');
    }
  });

  it('rejects an SVG, which has no signature here and never will', () => {
    for (const source of ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', '<?xml version="1.0"?><svg/>']) {
      const verdict = inspectImage(ascii(source));
      expect(verdict.ok, source).toBe(false);
      if (!verdict.ok) expect(verdict.code, source).toBe('not_an_image');
    }
  });

  it('rejects a CUR, which shares three of the ICO signature bytes', () => {
    const cursor = ico([{ width: 32, height: 32, payload: dib(300) }]);
    cursor[2] = 2; // type 2 is a cursor, not an icon
    const verdict = inspectImage(cursor);
    expect(verdict.ok).toBe(false);
  });

  it('rejects empty and truncated input rather than reading past the end', () => {
    for (const bytes of [new Uint8Array(0), new Uint8Array(3), png(32, 32).subarray(0, 12)]) {
      expect(inspectImage(bytes).ok).toBe(false);
    }
  });
});

describe('the two size limits, which are about what an icon IS', () => {
  it('rejects a 1x1 tracking pixel, which is valid image bytes and an invisible mark', () => {
    const verdict = inspectImage(gif(1, 1));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.code).toBe('too_small');
      expect(verdict.reason).toContain('tracking pixel');
    }
  });

  it('accepts exactly the floor and rejects one pixel under it', () => {
    expect(inspectImage(png(FAVICON_LIMITS.minEdge, FAVICON_LIMITS.minEdge)).ok).toBe(true);
    expect(inspectImage(png(FAVICON_LIMITS.minEdge - 1, FAVICON_LIMITS.minEdge)).ok).toBe(false);
  });

  it('rejects an OpenGraph banner behind rel="icon"', () => {
    const verdict = inspectImage(png(2400, 1260, 400));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('too_large');
  });

  it('rejects a zero-dimension frame as undecodable rather than as too small', () => {
    const verdict = inspectImage(png(0, 0));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('undecodable');
  });

  it('rejects a payload past the ceiling on what could be an icon at all', () => {
    const verdict = inspectImage(png(64, 64, FAVICON_LIMITS.maxBytes + 1));
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('too_heavy');
  });
});

describe('an ICO is opened rather than swallowed whole', () => {
  it('lifts an embedded PNG out and stores it AS a PNG', () => {
    const container = ico([
      { width: 16, height: 16, payload: png(16, 16, 300) },
      { width: 32, height: 32, payload: png(32, 32, 900) },
      { width: 256, height: 256, payload: png(256, 256, 20_000) },
    ]);

    const verdict = inspectImage(container);

    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      // The 32x32 layer, not the 256x256 one that carries all the weight and
      // that a sixteen-pixel row will never show.
      expect(verdict.format).toBe('png');
      expect([verdict.width, verdict.height]).toEqual([32, 32]);
      expect(verdict.mime).toBe('image/png');
      expect(verdict.bytes.byteLength).toBe(900);
      // It really is the member, not the container.
      expect(verdict.bytes.byteLength).toBeLessThan(container.byteLength);
    }
  });

  it('repacks a multi-entry DIB icon down to the one layer a row shows', () => {
    // The commonest shape in the seeded set: three uncompressed layers at
    // 16/32/48, about 15 KB whole, of which only the 32 is ever drawn.
    const container = ico([
      { width: 16, height: 16, payload: dib(1_400) },
      { width: 32, height: 32, payload: dib(4_200) },
      { width: 48, height: 48, payload: dib(9_400) },
    ]);

    const verdict = inspectImage(container);

    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.format).toBe('ico');
      expect([verdict.width, verdict.height]).toEqual([32, 32]);
      // Header + one directory entry + the 32x32 member, and nothing else.
      expect(verdict.bytes.byteLength).toBe(6 + 16 + 4_200);
      expect(verdict.bytes.byteLength).toBeLessThan(container.byteLength / 3);
    }
  });

  it('repacks into a container that is still a valid one-entry ICO', () => {
    const container = ico([
      { width: 16, height: 16, payload: dib(1_000) },
      { width: 32, height: 32, payload: dib(2_000) },
    ]);

    const verdict = inspectImage(container);

    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    const out = verdict.bytes;
    expect([out[0], out[1], out[2], out[3]]).toEqual([0, 0, 1, 0]); // reserved, type=icon
    expect(out[4]).toBe(1); // exactly one entry
    expect(out[6]).toBe(32); // the entry still describes a 32x32
    expect(out[7]).toBe(32);
    expect(out[6 + 6]).toBe(32); // the bit depth came across unchanged
    // The size and offset are the member's, and the offset points just past the
    // directory — which is the only field a repack is allowed to change.
    expect(out[6 + 8]! + (out[6 + 9]! << 8)).toBe(2_000);
    expect(out[6 + 12]! + (out[6 + 13]! << 8)).toBe(22);
    expect(out.byteLength).toBe(22 + 2_000);
  });

  it('leaves a single-entry icon exactly as it arrived', () => {
    // Nothing to throw away, so nothing is rewritten. A repack here would be
    // churn on the commonest small `.ico` on the web.
    const container = ico([{ width: 16, height: 16, payload: dib(1_100) }]);

    const verdict = inspectImage(container);

    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect([...verdict.bytes]).toEqual([...container]);
  });

  it('prefers the layer nearest 32px, so a 2x screen still has pixels to use', () => {
    const container = ico([
      { width: 16, height: 16, payload: dib(500) },
      { width: 64, height: 64, payload: dib(900) },
      { width: 32, height: 32, payload: dib(700) },
    ]);

    const verdict = inspectImage(container);

    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.width).toBe(32);
  });

  it('reads 0 in a size byte as 256, which is the format’s own wart', () => {
    const container = ico([{ width: 256, height: 256, payload: dib(4_000) }]);

    const verdict = inspectImage(container);

    // Read as 0 this would be `undecodable`; read correctly it is a 256px icon.
    // Which of those it is is the whole test.
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect([verdict.width, verdict.height]).toEqual([256, 256]);
  });

  it('ignores a directory entry pointing outside the file', () => {
    const container = ico([{ width: 32, height: 32, payload: dib(600) }]);
    writeU32LE(container, 6 + 12, 999_999); // offset past the end

    const verdict = inspectImage(container);

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.code).toBe('not_an_image');
  });

  it('ignores an entry claiming a size that runs past the end', () => {
    const container = ico([{ width: 32, height: 32, payload: dib(600) }]);
    writeU32LE(container, 6 + 8, 999_999);

    expect(inspectImage(container).ok).toBe(false);
  });
});
