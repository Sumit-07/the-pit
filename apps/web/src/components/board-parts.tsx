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
 *   took it** -> and only then the small mono numbers.
 *
 * That order is DOM order, not just visual order, and `test/boards-render.test.ts`
 * asserts it by index — because someone scanning with a screen reader, or a
 * search engine reading the page, meets the reason before the number for exactly
 * the reason a sighted reader does.
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
import { metricLabel, n1, n2, rank2, type RowView } from '@/lib/boards/view';

/** How much of a row's numbers a surface shows. The homepage shows fewer. */
export type NumberSet = 'home' | 'board';

/**
 * The marks a row can carry.
 *
 * Each one is a `title` as well as a colour, because a coloured chip that only a
 * returning visitor can decode is decoration. `solo cluster` in particular is the
 * common case — 32 of 48 and 26 of 44 in the seeded categories — so it is stated
 * as a property, never styled as a warning.
 */
function RowTags({ row }: { row: RowView }): ReactNode {
  if (!row.soloCluster && !row.tiebroken && row.flagged.length === 0) return null;
  return (
    <span className="tags">
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
        <span className="tag fl" title="A juror reason matched the injection alarm. Logged, never dropped.">
          flagged
        </span>
      ) : null}
    </span>
  );
}

/**
 * Rank, name, marks, and the cut that hurt most — in that order.
 *
 * The heaviest deduction rides on the collapsed row with the juror attached. When
 * a card lost nothing at all the row says so in words rather than showing an
 * empty space, because a blank there reads as missing data.
 */
export function RowLead({ row }: { row: RowView }): ReactNode {
  return (
    <span className="nm">
      <b>
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

/**
 * The small mono numbers, to the right of the reason and after it in the DOM.
 *
 * `Cuts` is the one that is allowed to be loud, because it is the connective word
 * `brief` Part 5 keeps on every surface and it is a count of what came off rather
 * than a rating. Merit, demand and core are muted and drop out below 760px: a
 * phone gets the reason and the cuts, which is the whole point of the surface.
 */
export function RowNumbers({ row, set }: { row: RowView; set: NumberSet }): ReactNode {
  return (
    <>
      <span className="cell cuts" title="100 minus the mean metric score — what came off this card">
        <span className="v">&minus;{Math.round(row.cuts)}</span>
      </span>
      <span className="cell c-hide" title="pure merit composite, before the blend">
        <span className="v">{n2(row.composite)}</span>
      </span>
      <span className="cell c-hide" title="reduced demand from the floor">
        {row.demand === undefined ? (
          <span className="v none">none</span>
        ) : (
          <span className="v">{n2(row.demand)}</span>
        )}
      </span>
      {set === 'board' ? (
        <span className="cell c-hide" title="the blended score this row is ranked by">
          <span className="v">{n2(row.core)}</span>
        </span>
      ) : null}
    </>
  );
}

/** The column header, matching whichever number set the surface renders. */
export function BoardHead({ set, trailing }: { set: NumberSet; trailing?: ReactNode }): ReactNode {
  return (
    <div className="bhead">
      <span className="c-rk">#</span>
      <span className="c-nm">Product &middot; the cut that hurt most, and who took it</span>
      <span className="c-x">Cuts</span>
      <span className="c-x c-hide">Merit</span>
      <span className="c-x c-hide">Demand</span>
      {set === 'board' ? <span className="c-x c-hide">Core</span> : null}
      <span className="c-ch">{trailing ?? null}</span>
    </div>
  );
}

/** One metric's ledger: the bar, then every cut with its points, reason and juror. */
function MetricLedger({ metric }: { metric: RowView['metrics'][number] }): ReactNode {
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
      <div className="bar">
        <i className="kept" style={{ width: `${n1(metric.score)}%` }} />
        <i className="lost" style={{ width: `${n1(metric.cuts)}%` }} />
      </div>
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
          no answer from {metric.substituted.join(', ')} &mdash; substituted 50, and counted that way in the rank
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
      <p className="took">
        <b>{row.name}</b> took {Math.round(row.cuts)} in cuts across {row.metrics.length}{' '}
        {row.metrics.length === 1 ? 'metric' : 'metrics'}, from {row.deductionCount}{' '}
        {row.deductionCount === 1 ? 'reason' : 'reasons'}.{' '}
        {row.href === undefined ? (
          <span className="who">{row.url}</span>
        ) : (
          <a href={row.href} target="_blank" rel="noopener noreferrer nofollow">
            {row.url}
          </a>
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
        <p style={{ marginTop: 5 }}>{row.cluster.reason}</p>
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
              <p>The panel convened but named no persona on this product.</p>
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
          <div className="sect">Injection alarm &middot; logged, not dropped</div>
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
 * `--depth` darkens the row as it descends. No row animates on a rank change:
 * `brief` Part 6 is explicit that motion comes from rotating categories and
 * arriving verdicts and never from rank churn, and `brief §1.2` has every rank
 * move on every placement — animating that would advertise instability as a
 * feature.
 */
export function BoardRow({ row, depth, first }: { row: RowView; depth: string; first: boolean }): ReactNode {
  return (
    <details className={first ? 'brow first' : 'brow'}>
      <summary>
        <span className="rowhead" style={{ '--depth': depth } as CSSProperties}>
          {row.soloCluster ? <span className="flag" aria-hidden="true" /> : null}
          <span className="rk">{rank2(row.rank)}</span>
          <RowLead row={row} />
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
