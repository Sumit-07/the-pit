/**
 * The two dependencies `brief §2.4`'s guards need that the rules themselves
 * cannot supply, resolved once for BOTH of the places the guards run.
 *
 * `handleCheckoutCreate` runs the guards before payment and
 * `enqueuePlacementForPayment` runs them again before enqueue. Those live in
 * different modules with different configs, and if each assembled its own listing
 * lookup and its own category roster the two checks would eventually be asking
 * different questions — which is precisely the drift `@the-pit/payments`'
 * `guards.ts` says it keeps the RULES in one place to avoid. Keeping the INPUTS
 * in one place is the other half of that.
 *
 * It is also what breaks the import cycle: `lib/checkout/config.ts` needs
 * `dodoConfig()` from `lib/payments/config.ts`, and `lib/payments/config.ts`
 * needs these two functions. Neither needs the other once they both point here.
 */

import { createPostgresListingStore, type Database } from '@the-pit/db';

import { defaultBoardSource } from '@/lib/boards/source';
import type { ListingLookup } from '@/lib/checkout/guards';

/** The listing lookup, mapped onto the shape `@the-pit/payments` declares. */
export function listingLookup(db: Database): ListingLookup {
  const store = createPostgresListingStore(db);
  return {
    // Field-for-field identical, so this is a pass-through and not a mapping.
    // `listing-store.ts` mirrors `ListingSnapshot` deliberately; if a field is
    // ever added on one side, this line stops compiling.
    findByNormalizedUrl: (normalizedUrl: string) => store.findByNormalizedUrl(normalizedUrl),
  };
}

/**
 * The categories a submitter may choose from: whatever actually has a board.
 *
 * Feeds the `<select>` on the form and the classifier's "name a better one".
 * Both have to be the set the pipeline can load — a category offered on the form
 * that `CategorySource.load` does not know is a paid submission that parks in the
 * review queue — so the roster is `BoardSource.list()` and never a constant
 * maintained beside it.
 */
export async function candidateCategories(): Promise<readonly string[]> {
  try {
    return await defaultBoardSource().list();
  } catch (error) {
    // A form with an empty `<select>` is a broken page; an empty roster with a
    // logged reason is a diagnosable one. The guards still run, and the classifier
    // degrades the safe way: with nothing on offer to suggest, it can only compare
    // the chosen category against itself, which is a `match` and never a block.
    console.error(`[checkout] could not list categories: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}
