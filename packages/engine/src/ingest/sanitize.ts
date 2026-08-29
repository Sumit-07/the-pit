/**
 * Product text is UNTRUSTED (Global Constraint 2). Everything that reaches a
 * prompt passes through here first.
 *
 * Source: `01 §4` Step 1 (`sanitize_description`) and `01 §8` — "strips control
 * characters, collapses whitespace, truncates".
 */

/**
 * Control characters that separate words rather than hide inside them: tab,
 * line feed, vertical tab, form feed, carriage return, and U+0085 NEL (a line
 * break that JavaScript's `\s` does not match). These become a space, so
 * "a\nb" stays two words while a genuine control character is simply deleted.
 */
const SEPARATING_CONTROLS = /[\t\n\v\f\r\u0085]/u;

/**
 * Unicode `Cc` (control) plus `Cf` (format). `Cf` covers the zero-width and
 * bidi-override characters — U+200B, U+200E, U+202E, U+FEFF — which render as
 * nothing and are the cheapest way to smuggle text past a human reviewer and
 * into a juror prompt. They are stripped for the same reason `Cc` is.
 */
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/gu;

/**
 * Strip control characters, collapse every whitespace run to a single space,
 * trim, and truncate to `limit` characters.
 *
 * Truncation counts code points, not UTF-16 units, so the cut never splits an
 * astral character into a lone surrogate.
 */
export function sanitize(text: string, limit: number): string {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new RangeError(`sanitize: limit must be a non-negative integer, got ${limit}`);
  }

  const collapsed = text
    .replace(CONTROL_OR_FORMAT, (char) => (SEPARATING_CONTROLS.test(char) ? ' ' : ''))
    .replace(/\s+/gu, ' ')
    .trim();

  if (collapsed.length <= limit) return collapsed;
  return Array.from(collapsed).slice(0, limit).join('');
}
