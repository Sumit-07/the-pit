/**
 * `/how-it-works` — what the engine does to a product, in the founder's words:
 * "just the basic details of what we do to calculate the rank and strengths and
 * weaknesses signals so that user is aware what he's stepping into."
 *
 * ## Short, and not a spec
 *
 * `01-skill-reference.md` §5–§6 is the specification and runs to a few thousand
 * words of prompts, schemas and exact arithmetic. This page is eight steps and
 * three warnings. The test of a sentence here is not "is it complete" but "would a
 * founder about to spend five dollars be surprised by it afterwards" — so the
 * mechanism is stated where it changes what a reader should expect (the panel
 * disagrees on purpose; a harsh juror is normalised away; most products never face
 * a buyer at all) and the exact formulae are left where they live.
 *
 * ## Every figure on it is a fold over the real boards
 *
 * `lib/boards/mechanics.ts` derives them, `test/how-it-works.test.ts` recomputes
 * each one off `cjr/runs/<category>/ranking.json` and fails if the page and the boards
 * disagree. Nothing here is typed in by hand — the page's own argument is that the
 * method is checkable, and a hand-typed number would be the one thing on it a
 * reader has to take on trust. Where the boards do not agree on a figure,
 * `mechanicsOf` returns `null` and the sentence is written without it rather than
 * with a constant restated from a document.
 *
 * ## Three things it says because they protect the reader
 *
 * The board moves under everyone, on every placement (`brief §1.2`); five dollars
 * buys an evaluation and never a position (`brief` Part 5, Part 2.3); and
 * disliking the result is not a failure (`brief §2.3`, which puts that sentence on
 * the purchase page — it belongs here too, where somebody reads before deciding
 * rather than while paying).
 *
 * **No rank is promised anywhere on this page.** `brief` Part 5 forbids it and
 * `test/how-it-works.test.ts` holds this surface to the same regexes
 * `test/boards-copy.test.ts` holds the homepage to.
 *
 * ## Reads
 *
 * `brief` Part 3: boards are CDN snapshots and a read never touches a model. This
 * route reads the same board JSON the homepage does and nothing else, and is
 * prerendered on the same daily revalidation.
 */

import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { COPY } from '@/lib/boards/copy';
import { asPercent, inWords, mechanicsOf, type Mechanics } from '@/lib/boards/mechanics';
import { defaultBoardSource } from '@/lib/boards/source';
import { toBoardView, type BoardView } from '@/lib/boards/view';

export const revalidate = 86400;

export const metadata: Metadata = {
  title: 'How this works',
  description:
    'Everyone walks in at 100. Six critics take points off with a reason each, six simulated buyers make a forced choice, and ordinary code does the arithmetic. No model ever sees a rank.',
};

async function loadBoards(): Promise<BoardView[]> {
  const source = defaultBoardSource();
  const views: BoardView[] = [];
  for (const slug of await source.list()) {
    const document_ = await source.read(slug);
    if (document_ !== undefined) views.push(toBoardView(document_));
  }
  return views.sort((a, b) => b.productCount - a.productCount || a.category.localeCompare(b.category));
}

/**
 * One numbered step.
 *
 * The number, the claim and the explanation are three DIRECT children of the
 * grid rather than a number beside a nested block, because on a wide screen they
 * become three columns — a ledger row, which is how this app draws every other
 * list of findings. A wrapper `<div>` around the last two would make that layout
 * impossible without a second grid.
 *
 * The number is a label and not a rank, so it is mono in the muted stop and
 * carries neither hue: `--cut` and `--held` mean taken and survived here.
 */
function Step({ n, title, children }: { n: number; title: string; children: ReactNode }): ReactNode {
  return (
    <div className="step">
      <span className="n">{n < 10 ? `0${n}` : n}</span>
      <h3>{title}</h3>
      {children}
    </div>
  );
}

/**
 * "32 of 48 on Developer Tools, 26 of 44 on Health, Fitness & Wellness."
 *
 * Written out per board rather than summed, because the claim is that this is the
 * ordinary case on a board a reader can go and open — a pooled fraction would hide
 * a category where it was not.
 */
function soloSentence(mechanics: Mechanics): string {
  return mechanics.boards
    .map((panel) => `${panel.soloCount} of ${panel.productCount} on ${panel.category}`)
    .join(', ');
}

/** "five metrics" where every board agrees, "its own metrics" where they do not. */
function metricPhrase(mechanics: Mechanics): string {
  const counts = new Set(mechanics.boards.map((panel) => panel.metrics));
  const only = counts.size === 1 ? [...counts][0] : undefined;
  return only === undefined ? 'each of the metrics' : `each of the ${inWords(only)} metrics`;
}

export default async function HowItWorks(): Promise<ReactNode> {
  const boards = await loadBoards();
  const m = mechanicsOf(boards);

  // The panel sizes. `null` only if two boards were installed with different
  // panels, in which case the sentence says "the critics" and stays true.
  const critics = m.jurors === null ? 'The critics' : `The ${inWords(m.jurors)}`;
  const criticsLower = m.jurors === null ? 'the critics' : inWords(m.jurors);
  const buyers = m.buyers === null ? 'Simulated buyers' : `${inWords(m.buyers).replace(/^./, (c) => c.toUpperCase())} simulated buyers`;

  return (
    <div className="wrap hiw">
      <nav>
        <a className="mark" href="/">
          THE <i>PIT</i>
        </a>
        <span className="navr">
          <span className="navlink">how it works</span>
          <a className="navlink" href="/boards">
            boards
          </a>
        </span>
      </nav>

      <div className="head">
        <span className="sh">How this works</span>
        <h1>What happens when you throw something in.</h1>
        <p className="headsub">
          The short version: who scores a product, what they are allowed to take off it, and what the
          number at the end is a summary of. Every figure below is read off the boards on this site, and
          nothing here is a promise about a position &mdash; the last section says why there could not be
          one.
        </p>
      </div>

      {boards.length === 0 ? (
        <div className="empty">
          No board has been published yet, so there are no figures to read off one. The method below is
          unchanged; this page prints numbers only when a delivered run has produced them.
        </div>
      ) : (
        <div className="stats">
          <div>
            <span className="n">{m.products}</span>
            <span className="k">products judged</span>
          </div>
          <div>
            <span className="n">{m.cuts}</span>
            <span className="k">cuts on the record</span>
          </div>
          <div>
            <span className="n">{m.solo}</span>
            <span className="k">ranked on merit alone</span>
          </div>
          <div>
            <span className="n">{m.boards.length}</span>
            <span className="k">categories open</span>
          </div>
        </div>
      )}

      <section>
        <h2>Where the number comes from</h2>
        <p className="lede">
          Eight steps, in the order the engine runs them. Nothing in here adds points to anything.
        </p>

        <div className="steps">
          <Step n={1} title="Everyone walks in at 100.">
            <p>
              A product starts at <b>100</b> on {metricPhrase(m)} its category is scored on. {critics}{' '}
              take points off, and <b>every deduction carries a reason and the name of the juror who made
              it</b>. That ledger is the product of this whole exercise; the number at the top of a verdict
              is a summary of it, and it is the ledger that is published in full.
            </p>
          </Step>

          <Step n={2} title="The panel is meant to disagree.">
            <p>
              {critics} share one rubric and carry <b>different weights</b> on it &mdash; the one who cares
              about whether a claim is backed and the one who cares about whether it survives a bad week are
              not supposed to arrive at the same answer. The disagreement is structural, not accidental, and
              a verdict shows how far apart they were on every metric. Each category gets its own{' '}
              {criticsLower}, its own rubric and its own metrics.
            </p>
          </Step>

          <Step n={3} title="A harsh juror cannot outvote a lenient one.">
            <p>
              Before the panel is combined, each juror&rsquo;s scores are <b>z-normalised per juror per
              metric</b> across the whole board. What survives is where a juror placed a product relative to
              everything else they scored &mdash; not how low they were personally willing to go. Being read
              by a hard marker costs nothing.
            </p>
          </Step>

          <Step n={4} title="Scarcity is how rare the idea is, not how good it is.">
            <p>
              A separate pass reads the whole category and groups products whose <b>core idea</b> is
              essentially the same. It then scores each product for <b>scarcity</b>: no close analogue and
              little market saturation at one end, crowded commodity at the other. It is a fact about the
              idea&rsquo;s neighbourhood and it is not a quality judgement.
            </p>
          </Step>

          <Step n={5} title="Then buyers are made to choose.">
            <p>
              Inside each cluster of near-substitutes, {buyers.toLowerCase()} are shown the members together
              and made to make a <b>forced choice</b>: which one would you adopt, how strongly, or none of
              them. No abstaining and no ties. Their picks and the sentence behind each one are the demand
              signal, and they are published with the verdict.
            </p>
          </Step>

          <Step n={6} title="Rank is merit and demand together.">
            <p>
              {m.merit === null || m.demand === null ? (
                <>Merit and demand are blended into one score, both re-standardised first so the split is over comparable axes.</>
              ) : (
                <>
                  <b>{asPercent(m.merit)} merit, {asPercent(m.demand)} demand</b>, both re-standardised first
                  so the split is over comparable axes.
                </>
              )}{' '}
              Scarcity enters only as a bounded nudge
              {m.scarcityTilt === null ? '' : ` of ±${m.scarcityTilt}`} &mdash; enough to decide an order
              where merit and demand are genuinely close, never enough to move a product past a real gap.
            </p>
          </Step>

          <Step n={7} title="Most products never face a buyer at all.">
            <p>
              A forced choice needs something to choose between. <b>A product with no near-substitutes has
              no buyers to face</b>, so no buyer is ever shown it and it is placed on merit alone, with the
              demand weight moved onto merit rather than scored as a zero. This is the majority case and not
              an edge case: {soloSentence(m)}. It cuts both ways &mdash; a strong product gains what a weak
              one loses.
            </p>
          </Step>

          <Step n={8} title="No model ever sees or produces a rank.">
            <p>
              Every model call returns one of exactly three things: raw scores with their reasons, a cluster
              assignment with a scarcity score, or one buyer&rsquo;s pick. <b>All the ranking arithmetic
              &mdash; the normalisation, the blend, the tilt, the ordering &mdash; is ordinary code over
              stored rows.</b>{' '}
              That is what makes a verdict reproducible if somebody disputes it: the stored responses can be
              re-ranked and must produce the same board, so a disputed placement is something to recompute
              rather than something to argue about.
            </p>
          </Step>
        </div>
      </section>

      <section>
        <h2>Three things this cannot do for you</h2>
        <p className="lede">
          Each of these is here because it protects the reader, not us. They are the parts of the method
          most likely to feel like a mistake later.
        </p>

        <div className="blk">
          <div className="sect">The board moves</div>
          <p>
            <b>Your number changes when other products are placed.</b> Every placement shifts the population
            that every score is normalised against, so the same scorecard produces a different position on a
            board of forty-eight than it does on a board of fifty &mdash; because of who else arrived, and
            nothing to do with the product. That is why every verdict is stamped with a timestamp and a
            product count, and why nothing on this site promises a position to anybody.
          </p>
        </div>

        <div className="blk">
          <div className="sect">Money buys an evaluation, never a position</div>
          <p>
            <b>{COPY.terms}</b> The same five dollars for everyone, and the same panel. Paying again,
            submitting again, or signing in changes nothing about where a product lands. There is no boost,
            no featured slot, no exception, and nothing on any board is for sale.
          </p>
        </div>

        <div className="blk">
          <div className="sect">Disliking the result is not a failure</div>
          <p>
            <b>Disliking the result is not a failure.</b> An attempt is spent when a whole verdict is
            delivered, not when it says something welcome. What does count as a failure is a run that broke
            &mdash; a timeout, a crash, a phase that never came back &mdash; and those are free retries that
            cost nothing.
          </p>
        </div>
      </section>

      <section>
        <h2>What the board is today</h2>
        <p className="lede">
          Worth knowing before you read one, because it is not the steady state.
        </p>
        <div className="blk">
          <div className="sect">Seeded, anonymous, same panel</div>
          <p>
            Most listings on the boards are <b>seeded</b>: real products taken from the market so the panels
            have a population to normalise against. They are published <b>anonymously</b> &mdash; no name,
            no address, no logo, only a designation &mdash; and they are scored by <b>exactly the same panel
            a paying submission faces</b>, with the same rubric and the same six. Nothing is scored more
            gently for being a seed, and no seeded listing is claimed by anybody. As paid listings arrive, a
            category drops its seeds a few at a time.
          </p>
        </div>
      </section>

      <div className="actrow">
        <a className="cta" href="/submit">
          Throw it in <small>&middot; $5</small>
        </a>
        <span className="terms">
          {COPY.terms}
          <br />
          <a href="/boards">or read a board first &mdash; they cost nothing</a>
        </span>
      </div>

      <footer>
        <span>THE PIT</span>
        <span>boards are snapshots &middot; rebuilt on every placement</span>
      </footer>
    </div>
  );
}
