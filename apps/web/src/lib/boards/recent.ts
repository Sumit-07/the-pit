/**
 * What just landed — the feed behind the "Just judged" strip.
 *
 * ## `DECISIONS.md` S14, resolved
 *
 * S14 asked what a cross-category feed may show, because `01 §9` rule 2 forbids a
 * cross-category leaderboard: scores are z-normalised inside a category, so a
 * health of 83 in Developer Tools and a health of 83 in Health & Fitness are two
 * different achievements and ordering them against each other invents a
 * comparison the engine never made.
 *
 * The resolution is that **the feed is ordered by time and by nothing else**.
 * Every row carries its own category and the rank it was stamped with at
 * delivery — "#12 of 49 in Developer Tools when judged" — which is a fact about
 * one board, not a position in this list. There is no sort control, no default
 * ordering by rank, and no arithmetic anywhere in this module that puts two
 * categories on one scale. A reader can see that Developer Tools moved and that
 * something scored 83; they are given nothing with which to conclude that one
 * category's 83 beat another's.
 *
 * That is why the strip's numbers are drawn in the row's own category and never
 * as a column: a column is a leaderboard whatever the header says.
 *
 * ## Both storage modes, and the read path stays clean
 *
 * `test/boards-read-path.test.ts` walks the import graph from `/`, `/boards` and
 * `/boards/<slug>` and fails if anything on it gains a runtime import of
 * `@the-pit/db`, a driver, the engine or an SDK. This module is on that graph, so
 * it imports none of them:
 *
 * - **filesystem** — the seeded verdicts, derived from the same board documents
 *   the page has already read. Every field the strip shows is on a projected row:
 *   the name (or designation), the health, the sharpest cut with its juror, the
 *   stamped rank, the product count, and the `/v/of/<category>/<id>` path that
 *   resolves to the verdict's own URL. The stamp is the board's `generatedAt`,
 *   which is the ranking file's mtime — exactly what `lib/verdict/service.ts`
 *   freezes a seeded verdict's `deliveredAt` to. Two derivations of one instant
 *   would be two answers; this is the same one, read off the document both
 *   surfaces already hold.
 * - **postgres** — `verdicts` ordered by `delivered_at desc`, behind a DYNAMIC
 *   import of `./pg-recent`. The specifier never appears as a static edge, so
 *   nothing is loaded in filesystem mode and a prerendered board opens no
 *   connection. `pg-recent.ts` is forbidden by name in the read-path test, which
 *   is what keeps that seam from being turned into a static import by accident.
 *
 * ## `isNew` is off for anything nobody pitched
 *
 * A seeded listing has no delivery instant. `lib/verdict/service.ts` stamps it
 * with `ranking.json`'s mtime because that is the honest substitute for a column
 * it does not have — and a checkout sets that mtime to now, so a fresh clone
 * would light up ninety-two NEW chips for products that have been sitting there
 * since the cold start.
 *
 * So the rule is stated on the thing that actually distinguishes them: a verdict
 * carries a pitch ordinal when somebody pitched for it (`verdicts.attempt_number`,
 * NULL on a seeded row by `brief §2.4`). No ordinal, no chip — in both arms, for
 * the same reason. `NEW` means "somebody put this in and it came out this week",
 * which is the only reading that is true of every row wearing it.
 */

import { pickFaviconCss } from './favicon';
import { defaultBoardSource } from './source';
import { stampBoard, toBoardView, type BoardView, type RowView } from './view';
import { storageMode, type Env } from '@/lib/pipeline/mode';

/** Seven days. `brief` has no window of its own; this is the one the chip means. */
export const NEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Does this verdict wear the chip?
 *
 * Two conditions, and the first is the one that is easy to leave out. **Somebody
 * has to have pitched it**: `verdicts.attempt_number` is NULL on a seeded row
 * (`brief §2.4` counts pitches, and nobody has pitched an unclaimed listing), and
 * a seeded row's `delivered_at` is a stamp of convenience — the ranking file's
 * mtime in filesystem mode, the seed run's clock in Postgres. A window applied to
 * that timestamp alone lights up every cold-start listing on a fresh checkout or
 * a fresh seed, which is exactly wrong: those are the oldest things on the site.
 *
 * Stated once, here, so the two storage arms cannot answer it differently.
 */
export function isNewVerdict(
  verdict: { readonly attemptNumber: number | null; readonly deliveredAt: Date },
  now: Date,
): boolean {
  if (verdict.attemptNumber === null) return false;
  const age = now.getTime() - verdict.deliveredAt.getTime();
  return Number.isFinite(age) && age >= 0 && age < NEW_WINDOW_MS;
}

/** How many cards the homepage strip holds. Four to six; six is the fullest honest row. */
export const HOME_STRIP = 6;
/** How many the board index holds. It has the full width, so it holds more. */
export const INDEX_STRIP = 8;

/** One card of the strip. Every field is a fact frozen at delivery or read off the board it names. */
export interface RecentVerdict {
  /** The category's slug, for the link back to its board. `''` when only a label is known. */
  categorySlug: string;
  /** The category's own label — "Developer Tools". Carried on every row, per S14. */
  category: string;
  /** The engine product id, when the row could be joined back to a board. */
  engineId?: number;
  /** The name it was judged under, or the designation if it withheld one. */
  name: string;
  anonymous: boolean;
  robotSeed?: string;
  iconClass?: string;
  mark: string;
  /** The rank stamped at delivery. Never a position in this feed. */
  rank: number;
  /** How many products were on that board. The other half of the stamp. */
  productCount: number;
  /** `100 − cuts`, what it walked out with. */
  health: number;
  /** The heaviest single cut, with the juror who took it. `null` when nothing came off. */
  cut: { points: number; reason: string; role: string; metric: string } | null;
  /** ISO-8601, from `verdicts.delivered_at` or the seeded ranking's mtime. */
  deliveredAt: string;
  /** This verdict's own page. */
  href: string;
  /** Delivered inside the window, and pitched by somebody. See the module header. */
  isNew: boolean;
}

/** What a delivered row needs from the world outside the board it sits on. */
export interface RecentOptions {
  /** Boards the caller has already read, so the page does not read them twice. */
  boards?: readonly BoardView[];
  /** The instant `isNew` is measured against. Injected so a test is not a clock. */
  now?: Date;
  env?: Env;
}

async function boardsOf(options: RecentOptions): Promise<readonly BoardView[]> {
  if (options.boards !== undefined) return options.boards;
  const source = defaultBoardSource();
  const views: BoardView[] = [];
  for (const slug of await source.list()) {
    const document_ = await source.read(slug);
    if (document_ !== undefined) views.push(toBoardView(document_));
  }
  return views;
}

/**
 * One board row, as a card.
 *
 * `isNew` is hard-`false` here and not computed: this is the seeded arm, and a
 * seeded listing was never pitched. The module header says why that is a rule
 * about the ordinal rather than about the clock.
 */
function cardOf(board: BoardView, row: RowView, deliveredAt: string): RecentVerdict {
  return {
    categorySlug: board.slug,
    category: board.category,
    engineId: row.id,
    name: row.name,
    anonymous: row.anonymous,
    ...(row.robotSeed === undefined ? {} : { robotSeed: row.robotSeed }),
    ...(row.iconClass === undefined ? {} : { iconClass: row.iconClass }),
    mark: row.mark,
    rank: row.rank,
    productCount: board.productCount,
    health: row.health,
    cut: row.headline,
    deliveredAt,
    href: row.verdictHref ?? `/boards/${board.slug}`,
    isNew: false,
  };
}

/**
 * The seeded arm: the latest rows across every board, newest board first.
 *
 * ## The tie, and why it is broken by interleaving
 *
 * Every row of a seeded board shares one instant — the ranking file's mtime — so
 * ordering by time alone leaves forty-eight rows tied. A tie is not an order, and
 * filling the whole strip from whichever category happened to be written last
 * would be the page inventing one. So tied rows are taken round-robin across
 * categories, best rank first within each: the same interleave `tickerLines` uses
 * one panel down, for the same reason, and deterministic, so the server and the
 * browser build the same list.
 *
 * Nothing here compares two categories' numbers. The interleave is over
 * POSITION IN THE QUEUE, not over health or cuts — S14's line is that a
 * cross-category ordering must not be a ranking, and "take one from each" is the
 * only ordering that ranks nothing.
 *
 * ## The tie is measured in DAYS, because a mtime does not mean more than that
 *
 * This is not a rounding convenience, and getting it wrong is what the first
 * version of this function did. A `git checkout` writes both seeded rankings in
 * the same second and they land a few milliseconds apart, so at full resolution
 * they are not tied — and the strip filled itself entirely from whichever file
 * the filesystem happened to finish writing second. Six cards, one category, on a
 * feature whose whole subject is that arrivals come from everywhere.
 *
 * The fix is to stop claiming a precision the value does not carry. A mtime says
 * "this board was ranked on this day"; it does not say that one category was
 * ranked before another, because nothing about a checkout is a delivery. So the
 * bucket is the UTC date, and two boards ranked on one day are tied — which they
 * are. A category seeded a month later still leads, because a month is a
 * difference the timestamp can actually support.
 *
 * The card keeps its own exact instant. Only the ORDERING is coarsened, and only
 * to the resolution the number is true at.
 */
export function seededRecentVerdicts(boards: readonly BoardView[], limit: number): RecentVerdict[] {
  const byInstant = new Map<string, BoardView[]>();
  for (const board of boards) {
    const day = board.generatedAt.slice(0, 10);
    const bucket = byInstant.get(day);
    if (bucket === undefined) byInstant.set(day, [board]);
    else bucket.push(board);
  }

  const cards: RecentVerdict[] = [];
  // Newest day first. `generatedAt` is ISO-8601 UTC, so lexical order is
  // chronological order and no Date is constructed to sort.
  for (const day of [...byInstant.keys()].sort((a, b) => b.localeCompare(a))) {
    const tied = (byInstant.get(day) ?? []).slice().sort((a, b) => a.category.localeCompare(b.category));
    const deepest = tied.reduce((most, board) => Math.max(most, board.rows.length), 0);
    for (let index = 0; index < deepest && cards.length < limit; index += 1) {
      for (const board of tied) {
        const row = board.rows[index];
        if (row === undefined) continue;
        // The BOARD's own instant, not the bucket's. The coarsening decides the
        // order; it never reaches the stamp a card prints.
        cards.push(cardOf(board, row, board.generatedAt));
        if (cards.length >= limit) break;
      }
    }
    if (cards.length >= limit) break;
  }
  return cards;
}

/**
 * The latest delivered verdicts across every category, newest first.
 *
 * `limit` is a ceiling, not a promise: a deployment with one board and three
 * products returns three cards and the strip renders three.
 */
export async function recentVerdicts(limit: number, options: RecentOptions = {}): Promise<RecentVerdict[]> {
  const boards = await boardsOf(options);
  const env = options.env ?? process.env;

  if (storageMode(env) === 'filesystem') return seededRecentVerdicts(boards, limit);

  // DYNAMIC, and the specifier is forbidden as a static edge from every board
  // route. Nothing above this line can open a connection, which is what makes a
  // prerendered board a document rather than a query.
  const { deliveredVerdicts } = await import('./pg-recent');
  try {
    return await deliveredVerdicts(limit, boards, options.now ?? new Date());
  } catch {
    // A board must render when the history behind it does not. The strip is the
    // page's least important row and the only one that needs a database; taking
    // the whole homepage down for it would trade a feature for the product.
    return seededRecentVerdicts(boards, limit);
  }
}

/**
 * The icon rules the strip's cards wear, and no others.
 *
 * The bytes live in each board's one `iconCss` block; a card carries a class.
 * Selecting per board rather than emitting every rule is the same economy
 * `toHomeBoard` makes — a strip draws six icons and a board holds forty-eight.
 */
export function stripIconCss(boards: readonly BoardView[], cards: readonly RecentVerdict[]): string {
  const worn = new Set(cards.map((card) => card.iconClass).filter((name): name is string => name !== undefined));
  if (worn.size === 0) return '';
  const rules = new Set<string>();
  for (const board of boards) {
    for (const rule of pickFaviconCss(board.iconCss, worn).split('\n')) {
      if (rule !== '') rules.add(rule);
    }
  }
  return [...rules].sort().join('\n');
}

/**
 * The boards, wearing what the feed just learned about them.
 *
 * Two stamps, one pass. `isNew` comes off the same feed the strip renders, so a
 * chip on a row and a card in the strip can never disagree about which products
 * are new. The movement mark needs the board BEFORE this one, which only a
 * deployment with a database can produce — `pg-history.ts` behind the same
 * dynamic seam, and `undefined` in filesystem mode, where there is one snapshot
 * and a dash on every row would be a fabricated comparison.
 */
export async function stampBoards(
  boards: readonly BoardView[],
  recent: readonly RecentVerdict[],
  options: RecentOptions = {},
): Promise<BoardView[]> {
  const newIds = new Map<string, Set<number>>();
  for (const card of recent) {
    if (!card.isNew || card.engineId === undefined) continue;
    const bucket = newIds.get(card.categorySlug);
    if (bucket === undefined) newIds.set(card.categorySlug, new Set([card.engineId]));
    else bucket.add(card.engineId);
  }

  const env = options.env ?? process.env;
  if (storageMode(env) === 'filesystem') {
    return boards.map((board) => stampBoard(board, { ...(newIds.has(board.slug) ? { newIds: newIds.get(board.slug) as Set<number> } : {}) }));
  }

  const { previousRanks } = await import('./pg-history');
  const stamped: BoardView[] = [];
  for (const board of boards) {
    let previous: readonly { key: number; rank: number }[] | undefined;
    try {
      previous = await previousRanks(board.slug, board.categoryVersion);
    } catch {
      // Same posture as the strip: no history is not a broken board.
      previous = undefined;
    }
    stamped.push(
      stampBoard(board, {
        ...(previous === undefined ? {} : { previous }),
        ...(newIds.has(board.slug) ? { newIds: newIds.get(board.slug) as Set<number> } : {}),
      }),
    );
  }
  return stamped;
}

/**
 * "2h ago".
 *
 * ## Coarse on purpose
 *
 * The strip is server-rendered on a page with `revalidate = 86400`, so a card can
 * be up to a day older than the moment its label was computed. A placement
 * invalidates `/` and `/boards` (`lib/delivery/settle.ts`), so the card for a
 * verdict that just landed is drawn within seconds of landing — but the ones
 * behind it age in the cache, and a label reading "14m ago" a day later would be
 * a lie the page tells on its own.
 *
 * Buckets are what make that survivable: "3d ago" is still true tomorrow morning,
 * and anything under an hour is either genuinely fresh or about to be re-rendered
 * by the next placement. The exact instant rides along in a `<time datetime>` on
 * every card, so nothing is lost.
 *
 * No `Intl`, for the reason `stampUtc` gives: the server and the browser would
 * format differently and React would report a hydration mismatch on every card.
 */
export function relativeTime(iso: string, now: Date = new Date()): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 90) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.round(days / 7);
  if (weeks < 52) return `${weeks}w ago`;
  return `${Math.round(weeks / 52)}y ago`;
}

/** The stamp, in the words the strip and the row both use. `brief` Part 5 forbids promising a rank. */
export function stampLine(card: Pick<RecentVerdict, 'rank' | 'productCount' | 'category'>): string {
  return `#${card.rank} of ${card.productCount} in ${card.category} when judged`;
}
