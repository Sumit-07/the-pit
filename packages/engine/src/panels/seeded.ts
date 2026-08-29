/**
 * The seed discipline every deterministic panel decision shares.
 *
 * `src/panels/calibration.ts` established it: a choice that must be identical for
 * the same category at the same version, in every process and on every machine,
 * is derived from a digest of `(namespace, category slug, categoryVersion)` and
 * fed to a named, fully specified integer PRNG. Never `Math.random()`, never a
 * clock, and never the order the caller's arrays happen to arrive in.
 *
 * This module exists because a SECOND thing now needs the same discipline —
 * the order products are rendered and chunked in (`src/panels/ordering.ts`) — and
 * two independent PRNGs with two seed conventions would be two things to keep in
 * agreement. The behaviour is unchanged from the calibration sampler's original
 * private copy: `seedFrom('calibration-seed', …)` produces the byte-identical
 * seed it always did, so no existing sample moves.
 */

import { createHash } from 'node:crypto';

/**
 * The category's stable identity for seeding, derived from its name: lowercased,
 * every run of non-alphanumeric characters folded to a single `-`, trimmed.
 * "Health, Fitness & Wellness" -> "health-fitness-wellness".
 *
 * Seeding on a slug rather than on the display string means re-casing or
 * re-punctuating a category's name does not silently reshuffle anything derived
 * from it.
 */
export function categorySlug(category: string): string {
  return category
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
}

/** SHA-256 of `text`, hex. Used for both seeds and content versions. */
export function digest(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * `categorySlug`, refusing the inputs that would collide two different states
 * onto one seed: an empty `categoryVersion`, or a name with no alphanumeric
 * characters at all (which slugs to `''`).
 *
 * @param what The caller's name, so the thrown message points at the real caller.
 */
export function requireSlug(what: string, category: string, categoryVersion: string): string {
  if (typeof categoryVersion !== 'string' || categoryVersion === '') {
    throw new RangeError(`${what}: categoryVersion must be a non-empty string`);
  }
  const slug = categorySlug(category);
  if (slug === '') {
    throw new RangeError(
      `${what}: category must contain at least one alphanumeric character, got ${JSON.stringify(category)}`,
    );
  }
  return slug;
}

/**
 * A 32-bit seed derived from a namespace, the category slug and the category
 * version. Deterministic across processes, machines and Node versions: SHA-256 is
 * specified byte for byte, and the first four bytes of it are as good a seed as
 * any other four.
 *
 * `namespace` keeps unrelated decisions from sharing a stream — the calibration
 * selection and the render order are drawn from the same `(slug, version)` pair
 * and must not move together.
 */
export function seedFrom(namespace: string, slug: string, categoryVersion: string): number {
  return Number.parseInt(digest(JSON.stringify([namespace, slug, categoryVersion])).slice(0, 8), 16) >>> 0;
}

/**
 * mulberry32, returning raw uint32 values rather than the usual float in [0, 1).
 *
 * A named, published, fully specified integer PRNG: given the same seed it
 * produces the same stream everywhere, which is the entire requirement here.
 * Integer output keeps the draw free of any floating-point rounding question —
 * every draw is reduced with `%` over a small range, where the modulo bias is far
 * below the point where it could distort a sample of a few dozen.
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  };
}

/**
 * Fisher-Yates over a copy, driven by `mulberry32(seed)`. Same seed, same input,
 * same permutation — everywhere, always.
 *
 * The caller is responsible for handing this a CANONICALLY ordered list. A
 * shuffle of an arbitrarily ordered input is deterministic only in the seed, not
 * in the result, so `[a, b]` and `[b, a]` would shuffle to different orders and
 * the guarantee would hold by luck.
 */
export function shuffleSeeded<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  const nextUint32 = mulberry32(seed);

  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = nextUint32() % (i + 1);
    const a = out[i];
    const b = out[j];
    // Unreachable: both indices are within bounds by construction. Checked rather
    // than asserted because a silent `undefined` here would drop a product from a
    // scoring prompt.
    if (a === undefined || b === undefined) throw new Error('shuffleSeeded: index out of range');
    out[i] = b;
    out[j] = a;
  }

  return out;
}
