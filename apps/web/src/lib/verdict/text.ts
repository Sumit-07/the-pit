/**
 * String work the verdict's two share surfaces both need, and a leaf.
 *
 * This module imports nothing, and that is its whole reason for existing.
 * `trimTo` used to live in `og.ts` and `share.ts` reached across for it, which
 * closed a ring: `page.ts` imports `share.ts`, `share.ts` imported `og.ts`, and
 * `og.ts` imports `page.ts` for `PIT_ORIGIN` and `stampTime`.
 *
 * That ring was not theoretical. ESM hoists function declarations, so the ring
 * was invisible for as long as every member exported only functions — and then
 * `og.ts` grew a module-level `const DOMAIN = PIT_ORIGIN.replace(…)`, which
 * evaluates while `page.ts` is still half-initialised and threw on the binding.
 * A cycle that tolerates functions and not constants is a trap laid for whoever
 * next adds a value to any of the three files.
 *
 * A leaf cannot be part of a ring. The one function both surfaces need lives
 * here, both import it, and there is now no arrangement of `page.ts`, `og.ts` and
 * `share.ts` that forms a cycle at all.
 */

/**
 * Trim to `limit` characters on a word boundary, with an ellipsis.
 *
 * A juror reason is one sentence and usually fits; a few run long, and a share
 * card that overflows is a broken share card. Cutting mid-word reads as a
 * rendering fault rather than as a quotation, so the break lands on whitespace
 * when there is any to land on.
 */
export function trimTo(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= limit) return clean;
  const head = clean.slice(0, limit - 1);
  const space = head.lastIndexOf(' ');
  return `${(space > limit * 0.6 ? head.slice(0, space) : head).replace(/[,;:.\s]+$/, '')}…`;
}
