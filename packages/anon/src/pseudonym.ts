/**
 * The name an anonymous listing wears, and the hash everything anonymous is
 * derived from.
 *
 * ## What a pseudonym has to be
 *
 * Three properties, and each one rules out an obvious cheaper design:
 *
 * 1. **Stable.** The same listing is the same entrant on every board rebuild, in
 *    a shared verdict link, and in a screenshot somebody posted last month. A
 *    random name minted at render time fails this; so does a counter, because
 *    `brief §1.2` rebuilds the whole board on every placement and a counter would
 *    renumber everyone below the new row.
 * 2. **Unique inside a category.** Two rows on one board that answer to the same
 *    name are two rows a reader cannot tell apart, and the board's whole claim is
 *    that each row is a distinct product with a distinct ledger.
 * 3. **Clearly not a product name.** This is the one that decides the FORM. An
 *    adjective-plus-noun generator — the usual choice, and what most avatar
 *    services do — produces "Amber Falcon" and "Quiet Harbour", which are exactly
 *    what a real company is called. A reader scanning a board must never have to
 *    wonder whether a row is a company they have not heard of. So the format is a
 *    DESIGNATION and reads as one: `Unit Kilo-427`.
 *
 * The vocabulary is the NATO phonetic alphabet, which is chosen for the same
 * reason: those words are already understood as call signs rather than as names,
 * they are pronounceable and memorable enough to refer to in a sentence ("the
 * Kilo-427 row"), and no company is called Foxtrot-318.
 *
 * ## Where uniqueness actually comes from
 *
 * 26 words x 900 numbers is 23,400 designations, which is not enough on its own:
 * at 48 products a birthday collision is about a 5% event, and "about 5%" is a
 * bug that shows up on a real board eventually. So `assignPseudonyms` resolves
 * collisions rather than hoping: it walks a category's engine ids in ASCENDING
 * order and gives each one the first designation not already taken.
 *
 * Ascending order is what makes that safe rather than merely deterministic.
 * `brief §1.2` places a new product by APPENDING it to the category — a placement
 * takes the next `engine_id`, and `packages/db/src/schema/products.ts` spells out
 * that an engine id is never re-derived. So a new row is always last in the walk,
 * always takes a free designation, and can never displace one that was already
 * handed out. Everybody else's name is untouched by somebody else's placement,
 * which is property 1 restated as a consequence of the algorithm rather than as a
 * hope.
 *
 * ## The seed
 *
 * `<category slug>#<engine id>`. Those two values identify a listing on every
 * surface that has to draw one — a published snapshot, a seeded `ranking.json`, a
 * `products` row — and neither is a secret, so nothing here leaks by being
 * derivable. The product's uuid would also have worked and is deliberately NOT
 * used: `cjr/runs/<slug>/ranking.json` has no uuid in it, and a generator the
 * cold-start boards could not call is a generator with a second implementation.
 *
 * The robot is then derived from the PSEUDONYM rather than from the seed
 * (`robot.ts`), which is what keeps a frozen verdict's avatar frozen with it:
 * `verdicts.payload` stores the name it was delivered with, so re-deriving the
 * robot from that name cannot drift even if the category is later re-seeded.
 */

/**
 * FNV-1a, then an avalanche mix.
 *
 * FNV-1a alone is fine for a hash table and not for this: its low bits move
 * sluggishly for short similar inputs, and every seed here is short and similar
 * (`developer-tools#0`, `developer-tools#1`, …). Two rows next to each other on a
 * board would take neighbouring designations and, worse, near-identical robots,
 * because `robot.ts` slices this value into small fields. The two multiply-xorshift
 * rounds are the standard 32-bit finalizer and are what make one bit of input
 * change about half the output bits.
 *
 * Not a cryptographic hash and not trying to be. Nothing here is a secret — the
 * seed is a public slug and a public index — so the only property required is
 * good diffusion.
 */
export function hash32(input: string): number {
  let h = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    h ^= input.charCodeAt(index);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d) >>> 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * The call-sign vocabulary.
 *
 * NATO phonetic, verbatim, including the two spellings that look like typos and
 * are not (`Alfa`, `Juliett`) — they are spelled that way in the standard so that
 * speakers of French and English do not read them differently, and using the
 * standard spelling is the cheapest signal that this is a call sign rather than a
 * brand.
 */
export const DESIGNATIONS: readonly string[] = [
  'Alfa',
  'Bravo',
  'Charlie',
  'Delta',
  'Echo',
  'Foxtrot',
  'Golf',
  'Hotel',
  'India',
  'Juliett',
  'Kilo',
  'Lima',
  'Mike',
  'November',
  'Oscar',
  'Papa',
  'Quebec',
  'Romeo',
  'Sierra',
  'Tango',
  'Uniform',
  'Victor',
  'Whiskey',
  'Xray',
  'Yankee',
  'Zulu',
];

/** Three digits, so a designation is always the same width in a column of them. */
const NUMBER_BASE = 100;
const NUMBER_SPAN = 900;

/**
 * The seed for one listing. Public by construction — see the module header.
 *
 * `engineId` is the engine's 0-based product id, which is stable for the life of
 * the row (`packages/db/src/schema/products.ts`).
 */
export function anonSeed(categorySlug: string, engineId: number): string {
  return `${categorySlug}#${engineId}`;
}

/**
 * One designation from a seed, with a variant counter for collision resolution.
 *
 * `variant` 0 is the natural choice for the seed. Higher variants are what
 * `assignPseudonyms` reaches for when that one is taken, and they are drawn from
 * the same space rather than by appending a suffix — a `Unit Kilo-427 (2)` would
 * advertise the collision to a reader who has no way to care about it.
 */
export function pseudonymFor(seed: string, variant: number = 0): string {
  const h = hash32(variant === 0 ? seed : `${seed}/${variant}`);
  const word = DESIGNATIONS[h % DESIGNATIONS.length] ?? DESIGNATIONS[0];
  const number = NUMBER_BASE + (Math.floor(h / DESIGNATIONS.length) % NUMBER_SPAN);
  return `Unit ${word as string}-${number}`;
}

/**
 * Every anonymous row's designation for one category, collision-free.
 *
 * Ascending engine id, first-free-wins. See the module header for why that order
 * is the property that makes a pseudonym survive somebody else's placement.
 *
 * The walk is bounded: after `MAX_VARIANTS` attempts it falls back to a
 * designation that embeds the engine id, which cannot collide because engine ids
 * are unique inside a category. That branch is unreachable for any realistic
 * board — it needs thousands of collisions on one seed — and it exists so the
 * function is total rather than looping.
 */
const MAX_VARIANTS = 64;

export function assignPseudonyms(
  categorySlug: string,
  engineIds: Iterable<number>,
): ReadonlyMap<number, string> {
  const assigned = new Map<number, string>();
  const taken = new Set<string>();

  for (const engineId of [...engineIds].sort((a, b) => a - b)) {
    const seed = anonSeed(categorySlug, engineId);
    let name = `Unit Zulu-${engineId}`;
    for (let variant = 0; variant < MAX_VARIANTS; variant += 1) {
      const candidate = pseudonymFor(seed, variant);
      if (!taken.has(candidate)) {
        name = candidate;
        break;
      }
    }
    taken.add(name);
    assigned.set(engineId, name);
  }

  return assigned;
}
