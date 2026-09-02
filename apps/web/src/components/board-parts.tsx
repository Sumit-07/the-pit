/**
 * The pieces every board surface is built from.
 *
 * Pure, prop-driven React with no data access of its own — which is what lets the
 * homepage (a client component, because it rotates) and the category board (a
 * server component, prerendered) render *identical* rows. A row that looked one
 * way on the homepage and another on the board would be two answers to the same
 * question.
 *
 * ## The one rule these components exist to keep
 *
 * `brief` Part 6: "Lead with deductions and reasons, not composites. Numeric
 * ratings stay small and secondary." So `<RowLead>` emits, in this order:
 *
 *   rank -> name -> marks -> **the heaviest cut, its reason, and the juror who
 *   took it** -> the cut meter -> and only then the small mono numbers.
 *
 * That order is DOM order, not just visual order, and `test/boards-render.test.ts`
 * asserts it by index — because someone scanning with a screen reader, or a
 * search engine reading the page, meets the reason before the number for exactly
 * the reason a sighted reader does.
 *
 * ## The signature: the cut meter
 *
 * `<CutMeter>` is the one element this design is remembered by, and it is the
 * mechanic drawn rather than a chart bolted onto it. Every product walks in at
 * 100. The track is that 100; the teal head is the **health** that survived;
 * each segment after it is **one metric's** contribution to the loss.
 *
 * The head used to be a neutral grey and the caption used to read "83 of 100
 * left" — the meter has always drawn health, and never said so. It says so now:
 * the head is `--held`, the caption leads with the figure, and `<RowNumbers>`
 * puts that same figure at the end of the row as the loud number. `cuts` did not
 * leave; `brief` Part 5 keeps it as the connective word and it is still on this
 * row, in the column header, in the lead and in the caption. What changed is
 * which of the two the eye lands on, and the bar and the number now agree: the
 * wide teal block on the left IS the number on the right.
 *
 * The widths are exact, not illustrative. `cuts = 100 − mean(metric score)`, so a
 * metric contributes `metricCuts / metricCount` and the segments sum to the bar
 * with no residue — verified against all 92 seeded products in both categories.
 * Segments are heaviest-first, so the most expensive metric is the widest block
 * against the boundary, and each one carries its metric, its points and its
 * heaviest reason **with the juror who took it** in a `title`.
 *
 * `<JurorMeter>` is the same figure one level down, inside an open ledger, split
 * by juror instead of by metric. That decomposition is exact for the same reason:
 * a metric's score is the mean of six jurors' own 100s, so juror J contributes
 * `(sum of J's points on this metric) / jurorCount`. It is why "every deduction
 * shows the juror" is structural here and not a caption — the juror is a
 * measurable share of the bar.
 *
 * Neither meter is the only route to its content. Both are `aria-hidden` with the
 * same facts stated in text beside them, and every deduction is written out in
 * full in the ledger below, because a `title` is not an accessible name and a
 * hover is not available to a keyboard.
 *
 * ## The mark beside the name
 *
 * Every row opens with a sixteen-pixel box holding one of three things: a robot
 * if the product is anonymous, its favicon if it is named and we could read one,
 * and its initial if it is named and we could not. `<RowMark>` carries the
 * reasoning — the short version is that the box is painted on every row in all
 * three states, because a gutter that appears late shifts the name under the
 * reader's eye, and that a blank one reads as broken where a considered fallback
 * reads as designed.
 *
 * The icon reaches the row as a CLASS, from the board's single `iconCss` block,
 * never as a `data:` URL on the row itself — `lib/boards/favicon.ts` has the
 * measurement that made that the shape. The bytes behind it were fetched
 * offline by `lib/boards/favicon-backfill.ts` under `@the-pit/fetch`'s guards
 * and stored beside the board data. No board surface ever hotlinks a product's
 * own server: 48 rows would be 48 third-party requests on every page view, each
 * one telling a stranger who is reading their row.
 *
 * ## Escaping
 *
 * Product names, descriptions and URLs are user-submitted, and juror reasons
 * quote them. Everything here goes through JSX text or a JSX attribute, so React
 * escapes it; there is no `dangerouslySetInnerHTML` on any board surface and
 * there must never be one. Only `http(s)` URLs become an `href` — `view.ts`
 * decides that, and a rejected URL is still shown as text so a reader can see
 * what was submitted.
 */

import type { CSSProperties, ReactNode } from 'react';

import { SOLO_NOTE } from '@/lib/boards/copy';
import { RobotAvatar } from '@/components/robot-avatar';
import { metricLabel, n1, n2, rank2, type MetricView, type RowView } from '@/lib/boards/view';

/** How much of a row's numbers a surface shows. The homepage shows fewer. */
export type NumberSet = 'home' | 'board';

/** The opacity ramp a segment sits on: heaviest is solid, the rest step back. */
function segClass(index: number): string {
  return index === 0 ? 'seg' : `seg s${Math.min(index + 1, 6)}`;
}

/**
 * The marks a row can carry.
 *
 * Each one is a `title` as well as a treatment, because a chip that only a
 * returning visitor can decode is decoration. `solo cluster` in particular is the
 * common case — 32 of 48 and 26 of 44 in the seeded categories — so it is a
 * hairline outline and never a colour: the one hue in this system means "taken",
 * and a solo cluster took nothing from anyone.
 */
function RowTags({ row }: { row: RowView }): ReactNode {
  if (!row.anonymous && !row.soloCluster && !row.tiebroken && row.flagged.length === 0) return null;
  return (
    <span className="tags">
      {/*
       * First, because it explains the two things a reader has already noticed
       * about the row — the robot and the designation — before they wonder
       * whether something failed to load. The tag is a plain state chip and takes
       * neither hue: withholding a name is not a deduction and not health.
       */}
      {row.anonymous ? (
        <span
          className="tag anon"
          title="Name and URL withheld by choice at submission."
        >
          anonymous
        </span>
      ) : null}
      {row.soloCluster ? (
        <span className="tag solo" title={row.soloNote ?? SOLO_NOTE}>
          solo cluster
        </span>
      ) : null}
      {row.tiebroken ? (
        <span className="tag tb" title="Demand and scarcity moved this row off its pure-merit position.">
          moved
        </span>
      ) : null}
      {row.flagged.length > 0 ? (
        <span className="tag fl" title="Flagged for review.">
          flagged
        </span>
      ) : null}
    </span>
  );
}

/**
 * The product's own mark: one box, three things that can be in it.
 *
 * ## The three states, and why they are three and not two
 *
 * 1. **Anonymous** — a robot, drawn deterministically from the product id. The
 *    product withheld its name, its URL and its face at submission, before it
 *    was scored, and that choice is immutable. It never shows a favicon: a
 *    favicon is a trademark at sixteen pixels, and putting one beside a
 *    pseudonym identifies the product completely rather than partially.
 *    `lib/boards/identity.ts` holds the decision; `view.ts` enforces it by never
 *    putting an icon on such a row, so this branch cannot leak one even if it
 *    were written wrongly.
 * 2. **Named, with an icon** — its favicon, painted by a class from the board's
 *    one `iconCss` block.
 * 3. **Named, with nothing usable at its site** — its initial. This is roughly a
 *    third of every board, so it is a common state, not an edge.
 *
 * Anonymity and "we could not read your site" are different facts and get
 * different marks. Showing the fallback initial for an anonymous product would
 * be worse than useless — it would leak the first letter of a name that is being
 * withheld.
 *
 * ## The space is always there
 *
 * `.fav` is a fixed sixteen-pixel box, painted on every row, in all three
 * states. That is why `RowView.mark` is a required field rather than something a
 * surface derives when an icon is missing: a gutter that appeared only for rows
 * that resolved would shift every name on the board sideways depending on
 * whether a stranger's server answered. The submit page's URL field learned this
 * first — `lib/checkout/page.ts` reserves the same gutter, for the same reason,
 * because padding that arrives with the favicon moves the caret mid-sentence.
 *
 * ## Missing has to look deliberate
 *
 * A blank sixteen-pixel hole reads as a page that failed to load; the product's
 * initial in the row's own mono, inside a hairline box the same size as the
 * icons above and below it, reads as a mark that was chosen. It borrows neither
 * hue — `--cut` means *this was taken* and `--held` means *this survived*, and
 * neither anonymity nor an unreadable website is either of those. Both get the
 * neutral outline `.tag.solo` gets, for the same reason.
 *
 * ## `aria-hidden`, all three
 *
 * A favicon is decoration: the product's name is right beside it, in text. An
 * initial taken FROM that name is decoration twice over, and announcing "C,
 * Capgo" on forty-eight rows would be noise. So the wrapper is hidden and a row
 * reads as its name whichever of the three is drawn.
 *
 * ## No network at render
 *
 * The icon is a `data:` URL that is already in this document, reached through a
 * class. There is no request here — which is also why there is no
 * `loading="lazy"` anywhere: a lazily-loaded `data:` URL is a hint about a fetch
 * that will never happen.
 */
function RowMark({ row }: { row: RowView }): ReactNode {
  if (row.anonymous) {
    return (
      <span className="fav" aria-hidden="true">
        <RobotAvatar seed={row.robotSeed ?? String(row.rank)} size={16} />
      </span>
    );
  }
  if (row.iconClass === undefined) {
    return (
      <span className="fav" aria-hidden="true">
        <span className="favmark">{row.mark}</span>
      </span>
    );
  }
  return <span className={`fav favimg ${row.iconClass}`} aria-hidden="true" />;
}

/**
 * The mark, the name, the row's tags, and the cut that hurt most — in that
 * order.
 *
 * The heaviest deduction rides on the collapsed row with the juror attached. When
 * a card lost nothing at all the row says so in words rather than showing an
 * empty space, because a blank there reads as missing data.
 */
export function RowLead({ row }: { row: RowView }): ReactNode {
  return (
    <span className="nm">
      <b>
        <RowMark row={row} />
        <span className="pname">{row.name}</span>
        <RowTags row={row} />
      </b>
      <span className="topcut">
        {row.headline === null ? (
          <span className="who">nothing came off this card</span>
        ) : (
          <>
            <span className="pts">&minus;{row.headline.points}</span> {row.headline.reason}{' '}
            <span className="who">
              {row.headline.role} &middot; {metricLabel(row.headline.metric)}
            </span>
          </>
        )}
      </span>
    </span>
  );
}

/** The `title` a metric segment carries: what it cost, and the worst thing said. */
function segmentTitle(metric: MetricView, share: number): string {
  const worst = metric.deductions.at(0);
  const head = `${metricLabel(metric.metric)} — ${n1(metric.cuts)} off 100, ${n1(share)} of this card's cuts`;
  return worst === undefined ? `${head}. Nothing came off this metric.` : `${head}. −${worst.points} ${worst.reason} — ${worst.role}`;
}

/**
 * The cut meter. See the module header — this is the signature element.
 *
 * `aria-hidden` on the bar itself and the same facts in the caption beside it:
 * the meter is a second reading of numbers that are already written down, and a
 * screen reader should get the sentence rather than a run of unlabelled boxes.
 */
export function CutMeter({ row }: { row: RowView }): ReactNode {
  const count = row.metrics.length;
  const cuts = Math.max(0, Math.min(100, row.cuts));
  // The head's width and the health figure are the same quantity, clamped once.
  const kept = 100 - cuts;
  const cutWord = row.deductionCount === 1 ? 'cut' : 'cuts';
  // `view.ts` sorts metrics heaviest-loss-first, so the first is the widest block.
  const heaviest = row.metrics.at(0);

  return (
    <span className="meterwrap">
      <span className="meter" aria-hidden="true">
        <i className="kept" style={{ width: `${kept}%` }} />
        {row.metrics.map((metric, index) => (
          <i
            className={segClass(index)}
            style={{ width: `${Math.max(0, metric.cuts) / Math.max(1, count)}%` }}
            title={segmentTitle(metric, Math.max(0, metric.cuts) / Math.max(1, count))}
            key={metric.metric}
          />
        ))}
      </span>
      <span className="metercap">
        <span>
          {count === 0 ? (
            'no metrics scored'
          ) : (
            <>
              <b className="held">{Math.round(kept)}</b> of 100 health left &middot; {count}{' '}
              {count === 1 ? 'metric' : 'metrics'} &middot; {row.deductionCount} {cutWord}
            </>
          )}
        </span>
        {/*
          The widest block, named. A segmented bar whose blocks can only be
          identified by hovering is a bar a phone cannot read, so the one that
          matters most is written out beside it.
        */}
        {heaviest === undefined ? null : (
          <span className="heaviest">
            widest: {metricLabel(heaviest.metric)} &minus;{n1(heaviest.cuts)}
          </span>
        )}
      </span>
    </span>
  );
}

/**
 * The small mono numbers, to the right of the reason and after it in the DOM.
 *
 * **Health** is the one that is allowed to be loud, and it is loud because it is
 * the number the bar on this row is a picture of: the wide teal head at the left
 * is this figure. It is still not a rating — `brief` Part 6's "numeric ratings
 * stay small and secondary" is about merit, demand and core, and those are all
 * still 11.5px, still muted, and still gone below 760px.
 *
 * `cuts` moved into that muted group rather than off the row. `brief` Part 5's
 * connective word has to survive on every surface, and it does: it is the column
 * header's `Cuts`, it is the number here, it is in the caption under the meter,
 * and the whole lead is a cut with its juror. What changed is that the loud
 * figure is now the one the drawing agrees with. `HEALTH_NOTE` rides on every
 * surface that shows the column, because health is not the sort order.
 */
export function RowNumbers({ row, set }: { row: RowView; set: NumberSet }): ReactNode {
  return (
    <>
      <span
        className="cell health"
        title="100 minus cuts"
      >
        {/*
          Self-labelling, like every number in `.nums`. The board head's column
          labels are `display:none` at every width — the row is two lines and a
          header cannot align to both of them — so a number that carries its own
          name is the only kind this row can afford.
        */}
        <span className="k">health</span>
        <span className="v">{Math.round(row.health)}</span>
      </span>
      {/*
        Named, because three unlabelled grey decimals are a riddle rather than a
        secondary reading. Small, muted and after the reason in the DOM — `brief`
        Part 6's "numeric ratings stay small and secondary" — and gone entirely
        below 760px, where a phone gets the reason, the meter and the cuts.
      */}
      <span className="nums">
        <span className="cell" title="what came off this card">
          <span className="k">cuts</span>
          <span className="v cut">&minus;{Math.round(row.cuts)}</span>
        </span>
        <span className="cell c-hide" title="pure merit composite, before the blend">
          <span className="k">merit</span>
          <span className="v">{n2(row.composite)}</span>
        </span>
        <span className="cell c-hide" title="reduced demand from the floor">
          <span className="k">demand</span>
          {row.demand === undefined ? (
            <span className="v none">none</span>
          ) : (
            <span className="v">{n2(row.demand)}</span>
          )}
        </span>
        {set === 'board' ? (
          <span className="cell c-hide" title="the blended score this row is ranked by">
            <span className="k">core</span>
            <span className="v">{n2(row.core)}</span>
          </span>
        ) : null}
      </span>
    </>
  );
}

/** The column header, matching whichever number set the surface renders. */
export function BoardHead({ set, trailing }: { set: NumberSet; trailing?: ReactNode }): ReactNode {
  return (
    <div className="bhead">
      <span className="c-rk">#</span>
      <span className="c-nm">Product &middot; the cut that hurt most, and who took it</span>
      <span className="c-x">Health</span>
      <span className="c-x">Cuts</span>
      <span className="c-x c-hide">Merit</span>
      <span className="c-x c-hide">Demand</span>
      {set === 'board' ? <span className="c-x c-hide">Core</span> : null}
      <span className="c-ch">{trailing ?? null}</span>
    </div>
  );
}

/**
 * One metric's loss, split by the juror who caused it.
 *
 * Exact, not illustrative: a metric's merged score is the mean of its jurors' own
 * scores, so juror J's share of the metric's loss is `J's points / jurorCount` and
 * the shares sum to the loss. Jurors are ordered by what they took, heaviest
 * first, so the widest block is the juror who hurt this metric most.
 */
function JurorMeter({ metric }: { metric: MetricView }): ReactNode {
  const jurors = Math.max(1, metric.jurors);
  const byRole = new Map<string, number>();
  for (const deduction of metric.deductions) {
    byRole.set(deduction.role, (byRole.get(deduction.role) ?? 0) + deduction.points);
  }
  const shares = [...byRole.entries()]
    .map(([role, points]) => ({ role, share: points / jurors, points }))
    .sort((a, b) => b.share - a.share);

  const lost = Math.max(0, Math.min(100, metric.cuts));

  // A metric nobody cut still gets its bar. An absent bar reads as missing data;
  // a full one reads as "this survived", which is what happened.
  if (shares.length === 0) {
    return (
      <>
        <span className="jurorbar" aria-hidden="true">
          <i className="kept" style={{ width: '100%' }} />
        </span>
        <span className="jurorcap">nothing came off this metric</span>
      </>
    );
  }

  return (
    <>
      <span className="jurorbar" aria-hidden="true">
        <i className="kept" style={{ width: `${100 - lost}%` }} />
        {shares.map((entry, index) => (
          <i
            className={segClass(index)}
            style={{ width: `${entry.share}%` }}
            title={`${entry.role} — ${entry.points} points off their own 100, ${n1(entry.share)} off this metric`}
            key={entry.role}
          />
        ))}
      </span>
      <span className="jurorcap">
        {shares.length} of {jurors} {jurors === 1 ? 'juror' : 'jurors'} cut here &middot; widest block is{' '}
        {shares[0]?.role}
      </span>
    </>
  );
}

/** One metric's ledger: the bar, the juror split, then every cut with its points, reason and juror. */
function MetricLedger({ metric }: { metric: MetricView }): ReactNode {
  return (
    <div className="ledger">
      <div className="ledger-h">
        <span className="mt" title={metric.metric}>
          {metricLabel(metric.metric)}
        </span>
        <span className="sc">
          {n1(metric.score)} / 100 &middot; spread &plusmn;{n1(metric.spread)} &middot; {metric.jurors} jurors
        </span>
      </div>
      <JurorMeter metric={metric} />
      {metric.deductions.map((deduction, index) => (
        <div className="ded" key={`${deduction.role}-${index}`}>
          <span className="pts">&minus;{deduction.points}</span>
          <span>
            {deduction.reason} <span className="who">&mdash; {deduction.role}</span>
          </span>
        </div>
      ))}
      {metric.substituted.length > 0 ? (
        <div className="subst">
          no answer from {metric.substituted.join(', ')} &mdash; scored 50
        </div>
      ) : null}
    </div>
  );
}

/**
 * The expanded ledger: every cut, the cluster the product was judged inside, and
 * which of the Floor's buyers picked it.
 *
 * Rendered into the DOM whether or not the row is open — `<details>` hides its
 * content, it does not withhold it. That is deliberate: the ledger is the thing
 * the board is for, it should be findable with ctrl-F and readable with JavaScript
 * switched off, and a CDN-cached document that needed a second request to show a
 * reason would not be a cached document.
 */
export function RowLedger({ row }: { row: RowView }): ReactNode {
  return (
    <div className="detail">
      {/*
        `brief` Part 5's register for a score, kept word for word — "Runlet took
        97 in cuts" — and then the same fact the other way up, which is the one
        the board's column now shows.
      */}
      <p className="took">
        <b>{row.name}</b> took {Math.round(row.cuts)} in cuts and walked out with{' '}
        <b className="held">{Math.round(row.health)}</b> health.{' '}
        {/*
         * An anonymous listing withholds its address, and says so rather than
         * leaving a blank where a link goes — a gap there reads as data that
         * failed to load, and this is a choice the listing made.
         */}
        {row.anonymous ? (
          <span className="who">address withheld</span>
        ) : row.href === undefined ? (
          <span className="who">{row.url}</span>
        ) : (
          <a href={row.href} target="_blank" rel="noopener noreferrer nofollow">
            {row.url}
          </a>
        )}
        {/*
         * The row's own verdict page. The board shows what came off; the verdict
         * shows the whole panel at once — the juror × metric grid, the spread the
         * six disagreed by, and the buyers who named it. Until this link existed
         * the page had no route into it from anywhere on the site.
         *
         * Rendered only when a verdict has actually been issued for the row
         * (`RowView.verdictHref`), so there is no path here to a 404.
         */}
        {row.verdictHref === undefined ? null : (
          <>
            {' · '}
            <a href={row.verdictHref}>Read the full verdict &rarr;</a>
          </>
        )}
      </p>

      {row.metrics.map((metric) => (
        <MetricLedger metric={metric} key={metric.metric} />
      ))}

      <div className="blk">
        <div className="sect">Judged inside</div>
        <p>
          <b>{row.cluster.label}</b> &middot; {row.cluster.size}{' '}
          {row.cluster.size === 1 ? 'product' : 'products'} &middot; uniqueness {row.cluster.uniqueness}/100
        </p>
        <p style={{ marginTop: 7 }}>{row.cluster.reason}</p>
      </div>

      <div className="blk">
        <div className="sect">The floor</div>
        {row.demandDetail === undefined ? (
          /*
           * `brief §1.6`: solo-cluster products get `z_demand = 0` while demand is
           * 35% of core. The row says which cluster it was alone in and what that
           * means for its position — a stated property, not an error state.
           */
          <p className="solonote">{row.soloNote ?? `A cluster of one — ${SOLO_NOTE}.`}</p>
        ) : (
          <>
            {row.demandDetail.picks.length === 0 ? (
              <p>Nobody named it.</p>
            ) : null}
            {row.demandDetail.picks.map((pick, index) => (
              <div className="pick" key={`${pick.persona}-${index}`}>
                <span className={pick.pick === 'second' ? 'p second' : 'p'}>
                  {pick.pick === 'first' ? '1st' : '2nd'}
                  {pick.strength === undefined ? '' : ` · ${pick.strength}`}
                </span>
                <span>
                  {pick.reason} <span className="who">&mdash; {pick.persona}</span>
                </span>
              </div>
            ))}
            <div className="dnums">
              demand {n2(row.demandDetail.demand)} &middot; breadth {n2(row.demandDetail.breadth)} &middot;
              intensity {n2(row.demandDetail.intensity)} &middot; capture {n2(row.demandDetail.capture)} &middot;
              share {n2(row.demandDetail.share)}
            </div>
          </>
        )}
      </div>

      {row.flagged.length > 0 ? (
        <div className="blk">
          <div className="sect">Flagged</div>
          {row.flagged.map((flag, index) => (
            <div className="flagnote" key={index}>
              {flag.source} matched &ldquo;{flag.matched}&rdquo; in: {flag.reason}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * One expandable row of a category board.
 *
 * A native `<details>`, not a JavaScript accordion. The category board is a
 * static CDN document; making its central interaction depend on a hydrated
 * bundle would mean the cached page is inert until the JavaScript lands, and the
 * ledger is the reason anyone opened it.
 *
 * `--depth` sinks the row as it descends. `brief` Part 6's "rows darken as they
 * descend (the pit is literal)" is depth in the surface stack rather than mud in
 * the palette: the first row is a lifted white card and the last is flush with the
 * floor. No row animates on a rank change — `brief` Part 6 is explicit that motion
 * comes from rotating categories and arriving verdicts and never from rank churn,
 * and `brief §1.2` has every rank move on every placement, so animating that would
 * advertise instability as a feature.
 */
export function BoardRow({ row, depth, first }: { row: RowView; depth: string; first: boolean }): ReactNode {
  return (
    <details className={first ? 'brow first' : 'brow'}>
      <summary>
        <span className="rowhead" style={{ '--depth': depth } as CSSProperties}>
          {row.soloCluster ? <span className="flag" aria-hidden="true" /> : null}
          <span className="rk">{rank2(row.rank)}</span>
          <RowLead row={row} />
          <CutMeter row={row} />
          <RowNumbers row={row} set="board" />
          <span className="chev" aria-hidden="true">
            &#9656;
          </span>
        </span>
      </summary>
      <RowLedger row={row} />
    </details>
  );
}
