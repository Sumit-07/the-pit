/**
 * The robot an anonymous listing wears instead of a favicon.
 *
 * ## In-process, offline, inline
 *
 * There is a well-known service that returns exactly this image for exactly this
 * purpose, and it is not used, for two reasons that are both about the reader
 * rather than about taste:
 *
 * 1. **A third-party request on every board view leaks the visitor.** A board is
 *    a public page with forty-odd rows on it. Pointing forty `<img>` tags at
 *    somebody else's host hands that host the IP, the User-Agent and the Referer
 *    of every person who has ever looked at the board, and the referer carries
 *    the category. The Pit's own read path is a CDN snapshot precisely so that
 *    reading a board tells nobody anything (`brief` Part 3).
 * 2. **It breaks when it moves.** An avatar that 404s leaves a broken-image glyph
 *    in the identity slot of a row whose identity is the point. Every anonymous
 *    row on the site would degrade at once, on somebody else's schedule.
 *
 * So the image is built here, from the hash, as inline SVG. No network, no
 * `<img>`, no cache, nothing to expire. It is also why the markup is emitted as a
 * string of primitives rather than assembled from a drawing library: the whole
 * thing has to survive being saved to disk, because `brief` Part 6 makes a
 * verdict page downloadable.
 *
 * ## Drawn for 16px first
 *
 * The hard constraint is the board row, where this is a 16-20px square beside a
 * name. Most generated-avatar schemes are designed at 128px and become grey mush
 * at 16 — the identity lives in fine detail that is gone by the time it is drawn.
 * So the variation here is ordered by how well it survives being small:
 *
 * - **The head tone** is the loudest signal and reads at any size: four steps of
 *   ink over the recess, far enough apart to tell apart at a glance. It is on the
 *   head rather than on the plate behind it, and `HEADS` below says why — the
 *   first draft had it the other way round and every robot read as a smudge.
 * - **The visor** is the next, and is deliberately the largest feature on the
 *   face. Six variants, all of them big blocks rather than pupils, because two
 *   3px dots and one 10px bar are distinguishable at 16px where two different
 *   arrangements of pupils are not.
 * - **The crown** — antenna or none — changes the SILHOUETTE, which is the thing
 *   a reader picks up before any interior detail.
 * - **The jaw** and **the bolts** are the fine detail. They do almost nothing at
 *   16px and are what makes the same robot hold up at 96px on a verdict page,
 *   which is the other half of the brief.
 *
 * 4 x 6 x 4 x 4 x 2 = 768 distinct robots, and the fields are sliced out of
 * different bit ranges of an avalanched hash so that two adjacent seeds do not
 * produce two robots that differ only in the bolts.
 *
 * `shape-rendering="crispEdges"` is not a detail: at 16px, antialiasing a 1px
 * rect turns it into a grey smudge, and the whole face is 1px and 2px rects.
 *
 * ## The palette is the neutral stack, and that is a rule about meaning
 *
 * `lib/theme.ts` gives the two hues one job each — `--cut` is what was taken,
 * `--held` is what survived — and says so in a test. An avatar painted in either
 * would make an identity read as a score: a red robot would look like a product
 * that lost badly before a reader had looked at a single number. So the robot is
 * built out of the surface and ink tokens only, and `test/anon-robot.test.ts`
 * asserts the absence of both hues in the emitted markup rather than trusting
 * this paragraph.
 */

import { hash32 } from './pseudonym.js';

/**
 * How the head reads: four steps of ink over the recess.
 *
 * This is the loudest signal at 16px, and it is on the HEAD rather than on the
 * plate behind it — which is the opposite of the first draft, and the change came
 * from looking at a real board row. With the tone on the plate and a dark head
 * sitting on it, the silhouette was a hole rather than a shape: the head was
 * near-identical to the page ground, the features were 2px marks inside a dark
 * blob, and at row scale the whole thing read as a smudge that might have been a
 * broken image.
 *
 * Putting the tone on the head inverts it. The plate is the recess the slot is
 * cut into, the head is a plainly lighter block standing in it, and the face is
 * brighter still. Three levels that step the same way every other surface in this
 * theme steps — `lib/theme.ts`: on dark, elevation is lightness.
 *
 * The floor is .22 rather than something smaller: below that the head stops
 * separating from the recess at 16px, which is the failure this ramp exists to
 * avoid. The four steps are far enough apart to tell apart at a glance.
 */
const HEADS: readonly string[] = [
  'rgb(var(--ink-c) / .22)',
  'rgb(var(--ink-c) / .31)',
  'rgb(var(--ink-c) / .41)',
  'rgb(var(--ink-c) / .52)',
];

/** The face. Full ink, because at 16px the visor is the identity and must not be dimmed. */
const FACE = 'var(--ink)';
/**
 * The crown and the bolts, which are drawn on the PLATE and so must be light.
 * One step below the visor, so the visor still leads.
 */
const TRIM = 'rgb(var(--ink-c) / .70)';
/**
 * The jaw, which is drawn on the HEAD and so must be dark.
 *
 * A grille is a hole in a face, not a decal on one. Painting it in ink would put
 * a light mark on a light block and lose it at the head's brighter tones, where
 * the plate colour reads as a cut at every one of them.
 */
const MOUTH = 'var(--sunk)';
/** The plate the head stands in: the one surface below everything (`--sunk`). */
const PLATE = 'var(--sunk)';

function rect(x: number, y: number, w: number, h: number, fill: string): string {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}"/>`;
}

/**
 * The crown: what the silhouette looks like above the head.
 *
 * Four variants, and the differences are deliberately in the OUTLINE rather than
 * inside it — a reader resolves a shape's edge before its contents, so this is
 * the field that still does work when the whole robot is 16 pixels wide.
 */
function crown(variant: number): string {
  switch (variant % 4) {
    case 0: {
      // Bare: a low ridge across the skull. The absence of an antenna is itself
      // one of the four readings, so a quarter of the population has a flat top.
      return rect(5, 2, 6, 1, TRIM);
    }
    case 1: {
      // One central stalk and a knob.
      return `${rect(7, 0, 2, 3, TRIM)}${rect(6, 0, 4, 1, FACE)}`;
    }
    case 2: {
      // Two horns.
      return `${rect(4, 1, 1, 2, TRIM)}${rect(11, 1, 1, 2, TRIM)}${rect(3, 0, 3, 1, FACE)}${rect(10, 0, 3, 1, FACE)}`;
    }
    default: {
      // One stalk, offset, with a long knob — an asymmetric silhouette, which is
      // the most distinguishable of the four at any size.
      return `${rect(4, 0, 1, 3, TRIM)}${rect(2, 0, 5, 1, FACE)}`;
    }
  }
}

/**
 * The visor: the largest feature on the face, and the main carrier of identity.
 *
 * Every variant is a block or a pair of blocks rather than a pupil, because the
 * face is 12 units wide and a unit is one device pixel at row scale — a pupil is
 * not a shape at that size, and a 3x3 block is.
 */
function visor(variant: number): string {
  switch (variant % 6) {
    case 0: {
      // Two square eyes.
      return `${rect(4, 6, 3, 3, FACE)}${rect(9, 6, 3, 3, FACE)}`;
    }
    case 1: {
      // One wide band. The most machine-like reading, and the most legible small.
      return rect(3, 6, 10, 3, FACE);
    }
    case 2: {
      // Two tall slits.
      return `${rect(5, 5, 2, 5, FACE)}${rect(9, 5, 2, 5, FACE)}`;
    }
    case 3: {
      // Three lamps.
      return `${rect(3, 7, 2, 2, FACE)}${rect(7, 7, 2, 2, FACE)}${rect(11, 7, 2, 2, FACE)}`;
    }
    case 4: {
      // A split band: one visor with a bridge cut out of the middle.
      return `${rect(3, 6, 4, 3, FACE)}${rect(9, 6, 4, 3, FACE)}`;
    }
    default: {
      // One tall cyclops block, offset low.
      return rect(5, 5, 6, 4, FACE);
    }
  }
}

/** The jaw. Fine detail: it earns its place at 88px, not at 16px. */
function jaw(variant: number): string {
  switch (variant % 4) {
    case 0: {
      // A grill.
      return `${rect(4, 11, 1, 2, MOUTH)}${rect(6, 11, 1, 2, MOUTH)}${rect(8, 11, 1, 2, MOUTH)}${rect(10, 11, 1, 2, MOUTH)}`;
    }
    case 1: {
      // A single speaker bar.
      return rect(4, 11, 8, 2, MOUTH);
    }
    case 2: {
      // A dotted row.
      return `${rect(4, 12, 1, 1, MOUTH)}${rect(6, 12, 1, 1, MOUTH)}${rect(8, 12, 1, 1, MOUTH)}${rect(10, 12, 1, 1, MOUTH)}`;
    }
    default: {
      // A hairline mouth.
      return rect(4, 12, 7, 1, MOUTH);
    }
  }
}

/** Side bolts. Present or not — the smallest field, and the last to be read. */
function bolts(variant: number): string {
  return variant % 2 === 0 ? '' : `${rect(0, 7, 2, 2, TRIM)}${rect(14, 7, 2, 2, TRIM)}`;
}

/** What a robot is made of, before it is markup. Exposed so a test can assert the spread. */
export interface RobotSpec {
  head: number;
  crown: number;
  visor: number;
  jaw: number;
  bolts: number;
}

/**
 * Slice one hash into the five fields.
 *
 * Each field takes a DIFFERENT bit range rather than successive remainders of the
 * same number, so two seeds whose hashes differ only in the low bits do not
 * produce two robots that agree on everything except the bolts.
 */
export function robotSpec(seed: string): RobotSpec {
  const h = hash32(seed);
  return {
    head: h & 0x3,
    crown: (h >>> 4) & 0x3,
    visor: (h >>> 8) % 6,
    jaw: (h >>> 14) & 0x3,
    bolts: (h >>> 20) & 0x1,
  };
}

/** What `robotSvg` needs beyond the seed. */
export interface RobotOptions {
  /** Rendered width and height in CSS pixels. The board row uses 18; a verdict page 88. */
  size?: number;
  /**
   * The accessible name. A robot is the identity slot of the row, so it is never
   * `aria-hidden` — a screen reader that skipped it would read a row with no
   * subject. Callers pass the pseudonym, which is the listing's actual name.
   */
  label?: string;
  /** Extra classes, so a surface can size or space it without a wrapper element. */
  className?: string;
}

/**
 * The robot for one seed, as a self-contained inline `<svg>` string.
 *
 * Deterministic: the same seed returns a byte-identical string forever, which is
 * what lets a frozen verdict keep the avatar it was delivered with.
 *
 * **Every byte of the output is generated from this module's own vocabulary.** The
 * only caller-supplied values that reach the markup are `size` (coerced to an
 * integer), `label` and `className`, and all three are escaped below. No product
 * name, URL or juror reason is ever interpolated into an avatar, which is what
 * makes it safe for the React surfaces to inject this with
 * `dangerouslySetInnerHTML` — see `components/board-parts.tsx`.
 */
export function robotSvg(seed: string, options: RobotOptions = {}): string {
  const spec = robotSpec(seed);
  const size = Math.max(8, Math.trunc(options.size ?? 16));
  const className = options.className === undefined ? 'robot' : `robot ${options.className}`;

  const head = HEADS[spec.head] ?? 'rgb(var(--ink-c) / .22)';
  const body = [
    // The plate: a full-bleed square, so the avatar occupies its slot completely
    // rather than floating in it, and so the SVG still reads correctly when the
    // verdict page is saved to disk and opened away from this stylesheet.
    rect(0, 0, 16, 16, PLATE),
    // Drawn against the plate, so an antenna reads even where it clears the head.
    crown(spec.crown),
    // The head block. Its TONE is the field that carries at row scale.
    rect(2, 3, 12, 11, head),
    visor(spec.visor),
    jaw(spec.jaw),
    bolts(spec.bolts),
  ].join('');

  /**
   * Labelled or hidden, and never in between.
   *
   * On the board the robot sits inside an `aria-hidden` wrapper beside the
   * designation in text, so a label here would make a screen reader say the name
   * twice. On the verdict page it is the header's own mark and is announced. A
   * caller says which by passing a label or not; there is no default, because a
   * default would be wrong on one of the two surfaces.
   */
  const semantics =
    options.label === undefined
      ? 'aria-hidden="true"'
      : `role="img" aria-label="${escapeAttribute(options.label)}"`;

  return (
    `<svg class="${escapeAttribute(className)}" viewBox="0 0 16 16" width="${size}" height="${size}" ` +
    `${semantics} shape-rendering="crispEdges" focusable="false">${body}</svg>`
  );
}

/**
 * Escape a value going into an attribute.
 *
 * Only `label` and `className` can carry a caller's string, and `label` is a
 * pseudonym this package generated — but "the caller always passes a pseudonym"
 * is a convention, and a convention is not what should stand between a juror
 * reason and an attribute if somebody wires this up differently later.
 */
function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
