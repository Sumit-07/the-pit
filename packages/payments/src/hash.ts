/**
 * Content hashing. One algorithm, one encoding, one place.
 *
 * Two things are hashed in this package and both are identities rather than
 * secrets: the description (so a listing can say "this is the same pitch"
 * without storing a second copy of the text on every row) and the job
 * idempotency key (so a double-clicked submit resolves to the same key).
 *
 * SHA-256 hex, and no truncation. A shortened hash saves 32 bytes on a row and
 * buys a birthday collision at a scale this project would celebrate reaching.
 */

import { createHash } from 'node:crypto';

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * The identity of a pitch's text.
 *
 * Hashed over the NORMALIZED description — lowercased, punctuation stripped,
 * whitespace collapsed — so that a trailing space or a changed capital does not
 * read as a new pitch. That is the same normalization `materialChange` uses, and
 * deliberately so: the hash and the similarity measure must agree about what
 * "the same text" means, or a submission can be identical by one and changed by
 * the other.
 */
export function descriptionHash(description: string, normalize: (text: string) => string): string {
  return sha256Hex(normalize(description));
}
