/**
 * The homepage — the public face of The Pit.
 *
 * `brief` Part 6 is the specification. The structure it fixes is unchanged — a
 * compact hero, a rolling category rail with its 7s progress bar, the board
 * occupying most of the page, the three panels, the closer — and the surface
 * treatment is new: `app/pit.css` and `lib/theme.ts` carry a five-value theme on a
 * real surface stack, one sans, one mono, and no display face. `brief` Part 6's
 * "rows darken as they descend (the pit is literal)" is read as depth in that
 * stack rather than as mud in the palette: the first row is a lifted white card
 * and the last is flush with the floor.
 *
 * ## Copy
 *
 * `brief` Part 5, verbatim, from `lib/boards/copy.ts`. The headline, the sub, the
 * terms line, the CTA and the closer are constants, not literals, so a reworded
 * homepage fails a test instead of shipping. The connective word — **cuts** — is
 * on this surface in the sub, in the board's primary column, in every row's lead
 * and in the strip beneath it. Outbid is never named. No rank is promised
 * anywhere: the board carries a time and a product count instead, because
 * `brief §1.2` moves every rank on every placement.
 *
 * ## Reads
 *
 * `brief` Part 3: "Boards are CDN snapshots, regenerated on placement. Reads never
 * touch a model." This route reads JSON from `lib/boards/source.ts` and nothing
 * else — no database, no model client, no engine import at runtime. It is
 * prerendered, so a visitor is a cache hit and nothing behind the CDN wakes up.
 * `test/boards-read-path.test.ts` walks the import graph from here and fails if
 * that ever stops being true.
 *
 * ## The CTA
 *
 * The paid path is complete end to end — guards, checkout, webhook, grant,
 * enqueue, pipeline, delivery, attempt consumption, verdict — so the CTA is a
 * real link to `/submit` and not a disabled button. It still carries `brief`
 * Part 5's exact words; only the element changed. A button that took a visitor
 * nowhere was the dishonest choice while the door was shut, and a button that
 * refuses to move now that it opens would be the same lie pointed the other way.
 */

import type { ReactNode } from 'react';

import { CLOSER_PARTS, COPY, HEADLINE_PARTS } from '@/lib/boards/copy';
import { boardStats, toHomeBoard, tickerLines, type HomeBoard as HomeBoardData } from '@/lib/boards/home';
import { defaultBoardSource } from '@/lib/boards/source';
import { n1, toBoardView, type BoardView } from '@/lib/boards/view';
import { HomeBoard } from '@/components/home-board';

/**
 * Revalidated daily, matching `BOARD_CACHE_CONTROL`'s `s-maxage=86400` on the
 * board JSON. A placement invalidates the path it rewrote; this is the ceiling on
 * how stale the homepage can get if nothing invalidates anything.
 */
export const revalidate = 86400;

async function loadBoards(): Promise<BoardView[]> {
  const source = defaultBoardSource();
  const views: BoardView[] = [];
  for (const slug of await source.list()) {
    const document_ = await source.read(slug);
    if (document_ !== undefined) views.push(toBoardView(document_));
  }
  // Biggest board first: the homepage opens on the category with the most
  // products, which is the one whose rank means the most.
  return views.sort((a, b) => b.productCount - a.productCount || a.category.localeCompare(b.category));
}

/**
 * The icon rules for every board the rail can rotate to, deduplicated across
 * them.
 *
 * Two categories can hold the same product, and two products can share a
 * template's favicon; a rule emitted twice would be a duplicate CSS declaration
 * and duplicated bytes. Sorted so the document is byte-stable between builds
 * that resolved the same icons.
 */
function HomeIconStyles({ boards }: { boards: readonly HomeBoardData[] }): ReactNode {
  const rules = new Set<string>();
  for (const board of boards) {
    for (const rule of board.iconCss.split('\n')) {
      if (rule !== '') rules.add(rule);
    }
  }
  if (rules.size === 0) return null;
  return <style>{[...rules].sort().join('\n')}</style>;
}

export default async function Home(): Promise<ReactNode> {
  const boards = await loadBoards();
  const homeBoards = boards.map((board) => toHomeBoard(board));
  // Folded over the FULL boards, before the eight-row slice below.
  const stats = boardStats(boards);

  return (
    <div className="wrap">
      <nav>
        <a className="mark" href="/">
          THE <i>PIT</i>
        </a>
        <span className="navr">
          {/*
            `/how-it-works` sits before the boards on every nav in the app. It is
            the page a first-time reader needs before the CTA means anything —
            the mechanism the homepage's three panels only gesture at — and
            `brief` Part 5's rule that no rank is promised anywhere is easier to
            keep when the explanation has a home of its own to keep it in.
          */}
          <a className="navlink" href="/how-it-works">
            how it works
          </a>
          <a className="navlink" href="/boards">
            boards
          </a>
        </span>
      </nav>

      <div className="hero">
        <h1>
          {HEADLINE_PARTS[0]}
          <br />
          <em>{HEADLINE_PARTS[1]}</em>
        </h1>
        <p className="sub">
          Everyone walks in at <b>100</b>. Fewest <b>cuts</b> wins.
        </p>
        <div className="herorow">
          {/*
            `brief` Part 5's CTA, word for word, and now a real link. The paid path
            is complete end to end, so `/submit` is where this goes — guest
            checkout, no login, `brief §2.1`.
          */}
          <a className="cta" href="/submit" aria-describedby="terms">
            Throw it in <small>&middot; $5</small>
          </a>
          <span className="terms" id="terms">
            {COPY.terms}
            <br />
            <i>$5. Five minutes. Public forever.</i>
          </span>
        </div>
      </div>

      {boards.length === 0 ? (
        <div className="empty">No boards yet.</div>
      ) : (
        <>
          {/*
            The canvas's stats row, with the canvas's numbers taken out of it.
            Every figure here is a fold over the boards on disk — `boardStats` in
            `lib/boards/home.ts` says which fold, and why "verdicts per run" is
            not among them. `brief` Part 5 forbids promising a rank, and a
            fabricated headline number on the page whose argument is that the
            board cannot be bought would be worse than a missing one.
          */}
          <div className="stats">
            <div>
              <span className="n">{stats.products}</span>
              <span className="k">products judged</span>
            </div>
            <div>
              <span className="n held">{n1(stats.medianHealth)}</span>
              <span className="k">median health left</span>
            </div>
            <div>
              <span className="n">{stats.cuts}</span>
              <span className="k">cuts on the record</span>
            </div>
            <div>
              <span className="n">{stats.categories}</span>
              <span className="k">categories open</span>
            </div>
          </div>

          {/*
            Every icon the homepage's rotating boards can show, emitted ONCE by
            this server component.
            `<HomeBoard>` is a client component, so anything handed to it as a
            prop is serialized into the hydration payload as well as rendered —
            an icon passed down as a `data:` URL would be in the document twice.
            Rows carry a class name; the bytes stay here. And they are emitted
            for every board, not just the one showing, because the rail rotates
            on a 7s timer and `brief` Part 3 does not allow a read to go back to
            the network when it does.
          */}
          <HomeIconStyles boards={homeBoards} />
          <HomeBoard boards={homeBoards} ticker={tickerLines(boards)} deepest={stats.deepest} />
        </>
      )}

      {/*
        Three panels, and each one ends with `brief` Part 4's own column: **affects
        rank**, yes or no. That line is the section's whole job — the page can only
        claim money buys nothing if it says out loud what does. Three feature cards
        without it would be decoration on a page whose argument is a mechanism.

        The label is "Affects rank" and never "your rank": `brief` Part 5 forbids
        promising a rank, and `test/boards-copy.test.ts` holds the homepage to it
        with a regex. The panel weighting is a property of the panel, not an offer
        to the reader.
      */}
      <section>
        <div className="three">
          <div className="card six">
            <h3>The Six</h3>
            <div className="role">Critics &middot; merit</div>
            <p>
              They start you at a hundred and take it apart. Every point comes off with a reason short
              enough to sting, and the reason is on the board next to the cut.
            </p>
            <div className="moves">
              <span>Affects rank</span>
              <b>65% of it</b>
            </div>
          </div>
          <div className="card floor">
            <h3>The Floor</h3>
            <div className="role">Simulated buyers &middot; demand</div>
            <p>
              Six customers shown you beside your closest substitutes and made to pick one. No abstaining,
              no ties. Alone in your cluster, nobody is shown you at all, and the board says so.
            </p>
            <div className="moves">
              <span>Affects rank</span>
              <b>35% of it</b>
            </div>
          </div>
          <div className="card mob">
            <h3>The Mob</h3>
            <div className="role">Real people &middot; free &middot; opens next</div>
            <p>
              Everyone walking past, given the same choice the floor gets. Where they disagree is the whole
              point.
            </p>
            <div className="moves">
              <span>Affects rank</span>
              <b>Never &middot; own board</b>
            </div>
          </div>
        </div>
        {/*
          The three panels say WHO judges and how much each one moves. The
          mechanism behind them is written out on `/how-it-works`, and this is the
          link to it — named and not explained. The page does not argue for the
          method on the way past; the method has its own page.
        */}
        <p className="lede">
          That is who judges. <a href="/how-it-works">How this works.</a>
        </p>
      </section>

      <div className="closer">
        <h2>
          {CLOSER_PARTS[0]} <em>{CLOSER_PARTS[1]}</em>
        </h2>
        <p>same five for everyone &middot; no boosts &middot; no featured slots &middot; no exceptions</p>
      </div>

      <footer>
        <span>THE PIT</span>
        <span>boards are snapshots &middot; rebuilt on every placement</span>
      </footer>
    </div>
  );
}
