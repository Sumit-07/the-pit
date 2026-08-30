/**
 * Taking the identity out of a ranking document.
 *
 * An anonymous listing withholds exactly two things — the product name and the
 * URL — and withholds nothing else. Every cut, every reason, every juror, the
 * per-metric scores, the cluster and the whole demand picture stay public,
 * because a verdict nobody can check is the opaque leaderboard The Pit exists to
 * replace. Only the identity is private.
 *
 * ## Why the name is scrubbed from the prose too
 *
 * The obvious implementation replaces `row.name` and blanks `row.url`, and it
 * leaks. Juror reasons, cluster reasons and persona picks are free text about the
 * product, and free text about a product sometimes contains its name. On the two
 * cold-start boards in this repository there is exactly one such sentence —
 * `developer-tools` id 31's cluster reason opens "Same idea as SummonAI Kit" —
 * which is a rate of one in 2,892 strings and precisely the rate at which a bug
 * survives review and ships. One sentence is enough: the promise is that the name
 * appears NOWHERE on the page, and a reader who finds it in a deduction has been
 * told something the listing paid not to say.
 *
 * So the redaction is a document-wide substitution, not a field-wide one. Every
 * string in the ranking is walked, and every occurrence of an anonymous product's
 * real name is replaced by its pseudonym — including in OTHER products' reasons,
 * which is where the one real instance was found.
 *
 * ## Two defences, and only one of them is this file
 *
 * This is the second line. The first is that an anonymous product never shows the
 * model its real name at all: `lib/pipeline/pg-catalog.ts` marshals the row into
 * the engine already wearing its pseudonym, so a juror scoring a listing that
 * chose anonymity at submission is scoring `Unit Kilo-427` and cannot write the
 * real name into a reason it was never shown. That is what makes the choice's
 * TIMING load-bearing rather than merely procedural — anonymity is picked before
 * scoring because the panel's output has to be safe to publish in full.
 *
 * This file exists because that defence does not cover documents produced before
 * it existed: every `cjr/runs/<slug>/ranking.json` was scored with real names, and
 * `DECISIONS.md`'s resolution makes every one of those seeded rows anonymous.
 * Legacy data is the whole reason a text scrub is here, and it stays afterwards
 * as the belt to the other's braces.
 *
 * ## Idempotent, on purpose
 *
 * `redactRanking` is applied twice on the paid path — once when a snapshot is
 * built, so the document at rest in the bucket and the one `/api/boards/<slug>`
 * serves have never held the name, and once when a board document is read, which
 * is what covers the seeded runs. Running it over an already-redacted document
 * must therefore be a no-op, and it is: the pseudonyms are recomputed from the
 * category slug and the engine ids rather than from the current names, so the
 * second pass assigns each row the name it already has and finds no real names
 * left to scrub.
 *
 * ## What it does not touch
 *
 * Nothing numeric. No score, composite, rank, cluster membership or demand value
 * is read or written here — `01 §2` and the plan's Global Constraint 1 put every
 * number in `packages/engine/src/rank/`, and a redactor that could move a rank
 * would be a second ranking implementation hiding inside a privacy feature.
 */

import type { Ranking } from '@the-pit/engine';

import { assignPseudonyms } from './pseudonym';

/**
 * The shortest real name that is scrubbed from free text.
 *
 * A two- or three-character name — "Go", "Vim", "n8n" — occurs inside ordinary
 * English constantly ("the **go**-to choice", "wor**k n8n**" is a stretch but
 * "**Go**od" is not), and substituting a designation into those sentences would
 * corrupt reasons that are the product's actual evidence. Above three characters
 * a false positive is rare and a missed name is the worse failure, so that is
 * where the line sits.
 *
 * The name itself is ALWAYS replaced on the row it belongs to, whatever its
 * length — this floor governs only the search through other text.
 */
const MIN_SCRUBBABLE = 4;

/** What one listing withholds, and what it shows instead. */
export interface AnonIdentity {
  engineId: number;
  /** The designation the row is published under. */
  pseudonym: string;
}

/** Escape a literal for use in a `RegExp`. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replace every string in a JSON-shaped value, in place on a fresh clone.
 *
 * Recursive over arrays and plain objects, which is every shape a `Ranking` has —
 * it is a document that has just been parsed from JSON or is about to be
 * serialized to it.
 */
function mapStrings(value: unknown, transform: (text: string) => string): unknown {
  if (typeof value === 'string') return transform(value);
  if (Array.isArray(value)) return value.map((entry) => mapStrings(entry, transform));
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = mapStrings(entry, transform);
    }
    return out;
  }
  return value;
}

/**
 * The designations for a category's anonymous rows.
 *
 * Separated from `redactRanking` because the surfaces need the mapping without
 * the document: a board view has to know which rows are anonymous in order to
 * draw a robot, and a verdict page needs one listing's designation.
 */
export function anonIdentities(
  categorySlug: string,
  anonymousIds: Iterable<number>,
): ReadonlyMap<number, AnonIdentity> {
  const assigned = assignPseudonyms(categorySlug, anonymousIds);
  const out = new Map<number, AnonIdentity>();
  for (const [engineId, pseudonym] of assigned) out.set(engineId, { engineId, pseudonym });
  return out;
}

/**
 * A ranking with its anonymous listings' identities removed.
 *
 * Returns a new document; the input is never mutated, because on the read path
 * the input is a parsed snapshot that other callers may still be holding.
 *
 * When no row is anonymous this returns the input unchanged — a board of named
 * products does not pay for a deep clone on every render.
 */
export function redactRanking(
  ranking: Ranking,
  anonymousIds: Iterable<number>,
  categorySlug: string,
): Ranking {
  const ids = new Set(anonymousIds);
  if (ids.size === 0) return ranking;

  const identities = anonIdentities(categorySlug, ids);

  // The substitutions, collected BEFORE anything is rewritten: the real name and
  // the real URL of each anonymous row, and what each becomes. Read off the input
  // document, which is the only place the real values exist on this path.
  const substitutions: { pattern: RegExp; replacement: string }[] = [];
  for (const row of ranking.ranking) {
    const identity = identities.get(row.id);
    if (identity === undefined) continue;

    if (typeof row.name === 'string' && row.name.length >= MIN_SCRUBBABLE) {
      substitutions.push({
        pattern: new RegExp(escapeRegExp(row.name), 'gi'),
        replacement: identity.pseudonym,
      });
    }
    // A URL is scrubbed at any length: it is never a word that occurs by
    // accident, and it is the other half of what a listing is withholding.
    if (typeof row.url === 'string' && row.url !== '') {
      substitutions.push({
        pattern: new RegExp(escapeRegExp(row.url), 'gi'),
        replacement: identity.pseudonym,
      });
    }
  }

  const scrub = (text: string): string => {
    let out = text;
    for (const { pattern, replacement } of substitutions) out = out.replace(pattern, replacement);
    return out;
  };

  // Field-level first: the row's own identity is ASSIGNED rather than
  // substituted, so a row whose name is shorter than the scrub floor — or is a
  // substring of another product's name — still loses it.
  const rows = ranking.ranking.map((row) => {
    const identity = identities.get(row.id);
    if (identity === undefined) return row;
    return { ...row, name: identity.pseudonym, url: '' };
  });

  // Then document-wide, over everything including the rows just rewritten. The
  // assigned pseudonyms are not themselves patterns, so this pass cannot undo
  // the one above.
  return mapStrings({ ...ranking, ranking: rows }, scrub) as Ranking;
}
