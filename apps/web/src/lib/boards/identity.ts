/**
 * Whether a product on a board is showing its face.
 *
 * ## The decision this implements
 *
 * A product can be submitted **anonymously**, and the choice is made at
 * submission, before scoring, and is immutable. That ordering is the whole
 * point: if the choice could be made after the verdict, every good score would
 * stay named and every bad one would hide, and the boards would stop meaning
 * anything. Made before, it is a privacy setting rather than a reputation
 * strategy.
 *
 * An anonymous product keeps everything that makes the board worth reading — its
 * cuts, every deduction reason, the juror who took each one, its cluster and its
 * rank. What is withheld is the identity: the name, the URL, and — the reason
 * this module exists in the favicon feature at all — **the favicon**.
 *
 * ## A favicon is an identity, not a decoration
 *
 * A site's favicon is its trademark at sixteen pixels. Rendering one beside a
 * pseudonym does not partially identify the product; it identifies it
 * completely, to anyone who has ever seen the logo, in a way that no amount of
 * withholding the name can undo. So this is not a cosmetic branch — it is the
 * difference between an anonymous listing and a listing that says who it is in
 * the one place nobody thought to look.
 *
 * The enforcement therefore lives in the PROJECTION and not in a component.
 * `view.ts` never attaches an icon to an anonymous row, so there is no icon for
 * a surface to leak: a new board surface written next year, by someone who has
 * not read this file, cannot render one because the data is not there.
 * `test/boards-favicons.test.ts` asserts exactly that, by rendering an anonymous
 * row with an icon in the index and searching the whole output for `data:image`.
 *
 * ## Where the answer comes from
 *
 * A set of engine ids, carried on the board document beside the ranking, and NOT
 * a field on the ranked row. That is deliberate, and it is the shape the data
 * actually has:
 *
 * - `products.anonymous` is the source of truth, and it is frozen at submission
 *   by `products_anonymity_immutable` (`migrations/0009_anonymous_listings.sql`).
 *   A board read never sees that column — a board is a CDN snapshot and
 *   `test/boards-read-path.test.ts` keeps the database off this graph — so the
 *   set travels on the published document as `anonymous_ids`.
 * - The ranking itself has already been REDACTED by the time it reaches here.
 *   `lib/boards/source.ts` runs `redactRanking` on both origins, so an anonymous
 *   row's `name` is already its designation and its `url` is already `''`. There
 *   is no field on the row that could carry the real name for a predicate to
 *   read, which is the point: the identity is not hidden behind a flag, it is
 *   absent.
 *
 * Every row of a SEEDED run is in the set. `DECISIONS.md`'s resolution of
 * S4-source: 913 of the 1028 seeded descriptions were scraped from a third-party
 * directory rather than written by the companies they describe, so a named seeded
 * row is AI criticism of copy that company never wrote.
 *
 * ## The seed
 *
 * `seed` is the product's DESIGNATION — `Unit Kilo-427` — which after redaction
 * is simply `row.name`. Two reasons it is the name rather than the id:
 *
 * 1. **It survives freezing.** `verdicts.payload` stores the name a listing was
 *    delivered under, and `verdicts` is append-only, so deriving the robot from
 *    the name means a shared verdict link keeps the avatar it was issued with —
 *    for free, with nothing extra frozen.
 * 2. **One chain, not two.** The designation is already derived from the category
 *    slug and the engine id, with collisions resolved across the category
 *    (`lib/anon/pseudonym.ts`). Deriving the robot from it means there is one
 *    identity, and the picture and the name cannot disagree about which listing
 *    they belong to.
 */

/** The fields of a ranked product this decision reads. Deliberately not `RankedProduct`. */
export interface IdentityInput {
  id: number;
  name: string;
  url: string;
}

export type ProductIdentity =
  | { kind: 'named' }
  /** `seed` is the stable input to the robot generator: the same product, the same robot, forever. */
  | { kind: 'anonymous'; seed: string };

/**
 * Read a product's identity.
 *
 * Membership of `anonymousIds` and nothing looser. The set is built by
 * `source.ts` from the published document's own record of what it redacted, so a
 * row is anonymous here if and only if its identity was actually taken out of the
 * document — the predicate cannot answer "anonymous" for a row whose name is
 * still in the ranking, or "named" for one whose name is gone.
 */
export function productIdentity(row: IdentityInput, anonymousIds: ReadonlySet<number>): ProductIdentity {
  return anonymousIds.has(row.id) ? { kind: 'anonymous', seed: row.name } : { kind: 'named' };
}
