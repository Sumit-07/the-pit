/**
 * The Postgres arm of the "Just judged" feed. Reached ONLY by dynamic import.
 *
 * `lib/boards/recent.ts` is on the board read path and may not name
 * `@the-pit/db` as a static edge — `test/boards-read-path.test.ts` walks the
 * graph from `/`, `/boards` and `/boards/<slug>` and fails if it does. This
 * module is the far side of that seam: it imports the database package freely,
 * and it is forbidden BY NAME in that same test, so the only way to reach it
 * stays `await import('./pg-recent')` inside the one branch that has already
 * decided the deployment has a database.
 *
 * The consequence is worth stating plainly: in filesystem mode this file is never
 * evaluated. No driver is loaded, no connection is opened, and a prerendered
 * board is a document rather than a query — which is `brief` Part 3's "reads
 * never touch a model" holding for the strip as well as for the rows.
 *
 * ## Why enumerating verdicts is allowed here and not in `verdict/store.ts`
 *
 * `lib/verdict/store.ts` is deliberately one method, `bySlug`, because the public
 * verdict route has no session and a store that could `list` an account's
 * verdicts would be reachable from it (`brief §2.1` splits the surfaces:
 * "verdict URLs are public; attempt balance and history sit behind a session").
 *
 * That argument is about ONE ACCOUNT'S history. This read is the opposite shape:
 * the newest N verdicts across the whole table, with no account filter and no
 * account column selected, every one of which is already a public page anybody
 * can open. It cannot be pointed at a person, because it takes no person as an
 * argument. `account_id` and `job_id` are not in the projection at all, for the
 * same reason `bySlug` leaves them out — a payload that reaches a page cannot
 * carry a payer's identity if the payer was never selected.
 */

import { createDatabase, createPostgresRecentVerdicts } from '@the-pit/db';

import { parseVerdict } from '@/lib/verdict/model';

import { faviconInitial } from './favicon';
import { isNewVerdict, type RecentVerdict } from './recent';
import type { BoardView, RowView } from './view';

/**
 * The newest delivered verdicts, as strip cards.
 *
 * ## The join back to a board, and what it is for
 *
 * A frozen payload carries the category's LABEL ("Developer Tools") and the
 * engine's product id, not the category's slug — `verdictPayload` freezes
 * `ranking.category`, which is what the verdict page prints. Two things the card
 * wants are on the board rather than in the payload: the slug, so the category
 * chip links somewhere, and the product's favicon class, whose bytes live in the
 * board's own `iconCss` block.
 *
 * So each verdict is matched to a board by label and then to a row by engine id.
 * A verdict that finds no board still renders — it keeps its label, loses its
 * link and draws its fallback mark. A strip that dropped a delivered verdict
 * because its category had not been read yet would be hiding the one thing it
 * exists to show.
 *
 * Nothing about the CARD is taken from the live row: the rank, the product count,
 * the health and the sharpest cut all come out of the frozen payload, which is
 * the whole point of freezing it. `brief §1.2` moves every z-score on every
 * placement, so a strip that read health off the current board would show a
 * different number an hour later for a verdict that was handed over once.
 */
export async function deliveredVerdicts(
  limit: number,
  boards: readonly BoardView[],
  now: Date,
): Promise<RecentVerdict[]> {
  const store = createPostgresRecentVerdicts(createDatabase(undefined, 1).db);
  const rows = await store.recent(limit);

  const byLabel = new Map<string, BoardView>();
  for (const board of boards) byLabel.set(board.category, board);

  const cards: RecentVerdict[] = [];
  for (const row of rows) {
    let verdict;
    try {
      verdict = parseVerdict(row);
    } catch {
      // One unreadable payload is not a reason to serve no strip. The verdict's
      // own page still throws loudly on it — `VerdictPayloadError` exists so a
      // malformed record cannot render as a blank card — and that is where a
      // dispute is argued from. A feed skips it.
      continue;
    }

    const board = byLabel.get(verdict.category);
    const engineId = engineIdOf(row.payload);
    const match: RowView | undefined =
      board === undefined || engineId === undefined
        ? undefined
        : board.rows.find((candidate) => candidate.id === engineId);

    cards.push({
      categorySlug: board?.slug ?? '',
      category: verdict.category,
      ...(engineId === undefined ? {} : { engineId }),
      name: verdict.name,
      anonymous: verdict.anonymous,
      // The designation IS the seed — `lib/boards/identity.ts` — so the robot on
      // a card and the robot on the verdict it links to are the same drawing.
      ...(verdict.anonymous ? { robotSeed: verdict.name } : {}),
      // Never on an anonymous listing: a favicon is a trademark at sixteen
      // pixels. `view.ts` already refuses to put one on such a row, and this
      // reads it from there rather than deciding again.
      ...(match?.iconClass === undefined ? {} : { iconClass: match.iconClass }),
      mark: match?.mark ?? faviconInitial(verdict.name),
      rank: verdict.rank,
      productCount: verdict.productCount,
      health: 100 - verdict.cuts,
      cut:
        verdict.sharpest === null
          ? null
          : {
              points: verdict.sharpest.points,
              reason: verdict.sharpest.reason,
              role: verdict.sharpest.role,
              metric: verdict.sharpest.metric,
            },
      deliveredAt: verdict.issuedAt,
      href: `/v/${verdict.slug}`,
      // Pitched, and inside the window. `recent.ts`'s header says why the ordinal
      // and not the clock alone: a seeded row's stamp is a file's mtime, and a
      // fresh checkout would otherwise light up every one of them.
      isNew: isNewVerdict(row, now),
    });
  }
  return cards;
}

/** `payload.verdict.id` — the engine id, read back off the frozen document. */
function engineIdOf(payload: unknown): number | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const verdict = (payload as { verdict?: unknown }).verdict;
  if (typeof verdict !== 'object' || verdict === null) return undefined;
  const id = (verdict as { id?: unknown }).id;
  return typeof id === 'number' ? id : undefined;
}
