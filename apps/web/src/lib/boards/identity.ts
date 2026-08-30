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
 * ## The seam
 *
 * The flag is the submission path's to set and is not in the ranking documents
 * yet, so `productIdentity` reads it defensively and treats its absence as
 * "named" — which is the state the seeded rows are in today, and is consistent
 * with the fact that their names and URLs are currently rendered in full on
 * every row and in every ledger. When the field lands, this one predicate is the
 * only thing that has to change, and the favicon follows it automatically.
 *
 * The robot avatar an anonymous row shows instead is generated deterministically
 * from the product id — see `components/robot-avatar.tsx`, which is the seam for
 * that generator and is deliberately not an implementation of it.
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
 * `anonymous === true` and nothing looser: a string `"false"`, a `0` or a
 * missing field all mean named. A privacy flag read by truthiness is a privacy
 * flag that turns itself off when the column type changes.
 */
export function productIdentity(row: IdentityInput): ProductIdentity {
  const flagged = (row as { anonymous?: unknown }).anonymous === true;
  return flagged ? { kind: 'anonymous', seed: String(row.id) } : { kind: 'named' };
}
