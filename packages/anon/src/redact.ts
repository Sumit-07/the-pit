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
 * And it matches more than the exact name, because **prose names the brand, not
 * the listing**. Directory-scraped names look like `Sequo — stop re-explaining
 * your project to your coding agent`, and no reason on the board contains that
 * string; three contain "Sequo". Four patterns are therefore built per anonymous
 * row: the full name, the brand at the front of it, the URL, and the bare host.
 * `brandHead` and `hostOf` below carry the reasoning and the matching rules.
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

import { assignPseudonyms } from './pseudonym.js';

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
 * The brand at the front of a product name.
 *
 * Directory-scraped names are overwhelmingly `Brand — tagline`, `Brand | what it
 * does` or `Brand: descriptor`, and **prose refers to the brand, not to the whole
 * string.** On the `developer-tools` board the full name "Sequo — stop
 * re-explaining your project to your coding agent" never appears in a reason, and
 * the bare token "Sequo" appears three times: twice in another product's persona
 * picks and once in a third product's cluster reason. A redactor that matched
 * only the full name would rewrite none of them and publish the brand of a
 * listing that paid to withhold it.
 *
 * So the head is scrubbed as well, and it is matched more strictly than the full
 * name is — case-sensitively and on word boundaries — because a head is short
 * enough to collide with ordinary English where a whole product name is not.
 *
 * ## The separator list is data, and it was wrong
 *
 * The first version of this split on the typographic dashes and on `|` and `:`,
 * and not on a plain hyphen. Eleven of the 48 `developer-tools` names and six of
 * the 44 health names are `Brand - tagline` with an ASCII hyphen — "Capgo - Live
 * Updates for Ionic and Capacitor Apps", "BuildAI - Build AI Apps In Minutes" —
 * so for those rows `brandHead` returned `''` and the brand was never a pattern
 * at all. The board then published, in prose, "…but Capgo's open-source rival
 * directly undercuts the moat" and "near-identical peer (BuildAI) in this set"
 * beside a robot and a designation. Rendering found it; reading the code did not,
 * because the code was obviously correct for every name anyone had looked at.
 *
 * The hyphen is only accepted SPACED — ` - ` — and never bare. A bare hyphen is
 * inside the brand as often as it is between the brand and its tagline
 * ("Hold-My-Lid", "GLP-1"), and splitting on it would cut names in half and
 * scrub a fragment. `|` and `:` keep their unspaced forms because neither occurs
 * inside a brand.
 *
 * Returns `''` when there is no head worth scrubbing, which is the same answer as
 * "the head is the whole name" (already covered) or "the head is too short to
 * match safely".
 */
function brandHead(name: string): string {
  const head = name.split(/\s[—–|:·-]\s|[|:]/u)[0]?.trim() ?? '';
  if (head === '' || head === name.trim()) return '';
  return head.length >= MIN_SCRUBBABLE ? head : '';
}

/**
 * A URL reduced to the host it names.
 *
 * `https://www.modulate.ai/` and `modulate.ai` identify the same company, and a
 * reason that mentions the second is not covered by a pattern built from the
 * first. Scheme, `www.` and any path are dropped, which is the same reduction
 * `normalizeUrl` performs for a different purpose.
 */
function hostOf(url: string): string {
  const host = url
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/^www\./i, '')
    .split(/[/?#]/u)[0];
  return host !== undefined && host.length >= MIN_SCRUBBABLE ? host : '';
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
 * Positional cluster ids, in the order the document already lists them.
 *
 * ## The third leak, and why the prose scrub could never have caught it
 *
 * The uniqueness pass mints a cluster identifier from the idea the cluster is
 * about, and when a cluster has one member that idea IS the product:
 * `c9-invofox`, `c35-holdmylid`, `c1-ai-app-builder`, `c32-modulate`. Twenty of
 * the 39 `developer-tools` ids spell out a seeded product that way.
 *
 * None of them was reachable by the substitutions above. An id is a lowercase
 * hyphen-joined slug, so `holdmylid` does not match the full name pattern
 * (`Hold-My-Lid`, whose hyphens and capitals are gone) and does not match the
 * brand-head pattern either, which is deliberately case-SENSITIVE and
 * word-BOUNDED for the reasons `brandHead` gives. A slug is precisely the form
 * that survives both. The two ids that did get rewritten — the ones whose brand
 * happens to be a single lowercase-identical token — were rewritten by accident,
 * which is worse than not being rewritten at all: it made the field look handled.
 *
 * Rendered HTML shows `cluster.label`, so nothing on a page said it. The leak
 * surface is the document itself — `GET /api/boards/<slug>` and the snapshot
 * JSON in the bucket — which is exactly the surface this file exists to make
 * safe, because "the identity appears nowhere" is a promise about what The Pit
 * SERVES and not about what it happens to render today.
 *
 * ## Why positional rather than scrubbed
 *
 * A pattern-based fix would be a fourth needle chasing the same failure mode,
 * and the mode is that an id is DERIVED FROM TEXT. So the derivation goes: every
 * id becomes `c1`…`cN`, carrying no text at all, and a future name shape cannot
 * reintroduce the bug. Nothing is lost — an id is a join key, and everything a
 * reader is shown about a cluster lives in `label`, `size`, `uniqueness` and
 * `reason`, none of which this touches.
 *
 * The order is the document's own: `ranking.clusters` first (the roster, already
 * sorted by size), then any id a row names that the roster omits, in row order.
 * That is stable for a given document, which is what makes the rewrite idempotent
 * — a second pass over `c1`…`cN` assigns each id the token it already carries.
 */
function positionalClusterIds(ranking: Ranking): ReadonlyMap<string, string> {
  const order: string[] = [];
  const seen = new Set<string>();
  const note = (id: unknown): void => {
    if (typeof id !== 'string' || id === '' || seen.has(id)) return;
    seen.add(id);
    order.push(id);
  };

  for (const cluster of ranking.clusters ?? []) note(cluster.cluster_id);
  for (const row of ranking.ranking ?? []) note(row.cluster?.id);

  const out = new Map<string, string>();
  for (const [index, id] of order.entries()) out.set(id, `c${index + 1}`);
  return out;
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

      // The brand at the front of the name, which is what prose actually says.
      // Case-sensitive and bounded, because a head is short enough to collide
      // with ordinary English. See `brandHead`.
      const head = brandHead(row.name);
      if (head !== '') {
        substitutions.push({
          pattern: new RegExp(`\\b${escapeRegExp(head)}\\b`, 'g'),
          replacement: identity.pseudonym,
        });
      }
    }
    // A URL is scrubbed at any length: it is never a word that occurs by
    // accident, and it is the other half of what a listing is withholding.
    if (typeof row.url === 'string' && row.url !== '') {
      substitutions.push({
        pattern: new RegExp(escapeRegExp(row.url), 'gi'),
        replacement: identity.pseudonym,
      });

      // And the bare host, which names the same company without the scheme.
      const host = hostOf(row.url);
      if (host !== '') {
        substitutions.push({
          pattern: new RegExp(escapeRegExp(host), 'gi'),
          replacement: identity.pseudonym,
        });
      }
    }
  }

  // Every cluster identifier in the document, and the positional token it
  // becomes. Read off the input for the same reason the substitutions are:
  // this is the last point at which the real ids exist on this path.
  const clusterIds = positionalClusterIds(ranking);

  const scrub = (text: string): string => {
    // A string that IS a cluster id is replaced whole, and nothing else is done
    // to it. Exact equality rather than a pattern: it needs no boundary rules and
    // cannot touch prose, and every reference to an id in this document is a
    // field holding the id by itself — `clusters[].cluster_id` and
    // `ranking[].cluster.id` are the two the schema has, and this covers any
    // third a later schema adds without needing to be told about it.
    const positional = clusterIds.get(text);
    if (positional !== undefined) return positional;

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
