/**
 * The comparison a verdict page is allowed to draw, frozen with everything else.
 *
 * ## Why this exists, and why it could not before
 *
 * A verdict page had no baseline. `charts.ts` said so in as many words: the
 * payload carries "this product's numbers and no one else's", so a radial had
 * nothing to be a shape *against*, and a sorted bar was the better form. The
 * reason was `DECISIONS.md §1.2` — appending a product moves every z-score, so a
 * baseline fetched at render time would make a shared link change under its
 * reader, on the one page whose whole promise is that it does not.
 *
 * That rule forbids **fetching** a baseline. It does not forbid **freezing** one.
 * The cluster peers a product was judged against, and the category it was judged
 * inside, are both known at the instant the board is delivered, and they are on
 * the very `Ranking` this module is handed. Frozen into the payload beside the
 * rank and the timestamp, they are as permanent as everything else on the page:
 * the comparison a reader sees in five years is the comparison the poster saw.
 *
 * ## Two comparisons, because 32 of 48 products have no peers
 *
 * `DECISIONS.md` S3/S11 make a cluster of one a legitimate terminal state, and it
 * is the majority: 32 of 48 Developer Tools products and 26 of 44 Health &
 * Fitness products are solo. So there are two baselines here and the page picks
 * by the shape of the data rather than by a flag:
 *
 * - `peers` — the other products in this product's cluster. Empty for a solo
 *   cluster, and an empty list is the honest answer, never a fabricated one.
 * - `median` — the category's own middle, per juror, per persona and per metric.
 *   The only baseline a solo product can have, and the page labels it as the
 *   category rather than letting it read as a peer.
 *
 * ## What is frozen is a figure, not a scorecard
 *
 * A peer contributes an axis value and its name. It does not contribute its
 * jurors' sentences: the page draws peers as recessive outlines and never quotes
 * them, so embedding four more scorecards would multiply the payload for text no
 * surface renders. Each figure below is arithmetic over the peer's own frozen row
 * and is reproducible from the board that produced it.
 *
 * ## Append-only, and never backfilled
 *
 * `verdicts` refuses UPDATE. Every verdict delivered before this module existed
 * carries no `comparison` key and never will, so the page must render without one
 * — no overlay, and no invented stand-in. `apps/web/src/lib/verdict/charts.ts`
 * treats a missing comparison as "there is no comparison", which is true.
 */

import type { DemandPick, Ranking, ScorecardEntry } from '@the-pit/engine';

import type { RankedRow } from './verdict-payload.js';

/** Two decimal places, so the frozen document does not carry float tails. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * The mean points one juror took per metric they actually scored.
 *
 * `01 §5.1` starts every juror on every metric at 100 and their deductions for it
 * sum to `100 - their score`, so the points a juror took off a metric is exactly
 * their own deduction total, and the mean over the metrics they answered is a
 * 0–100 figure on the same axis as everything else on the page.
 *
 * `null` when they answered none — the only case with no denominator. A
 * substituted metric (`substituted_roles`) is excluded from the denominator
 * rather than counted as a zero: the board wrote a 50 in that juror's place and
 * `apps/web` refuses to draw a fabricated 50 as an opinion.
 */
export function jurorCut(scorecard: readonly ScorecardEntry[], role: string): number | null {
  let points = 0;
  let answered = 0;
  for (const entry of scorecard) {
    if (entry.substituted_roles.includes(role)) continue;
    answered += 1;
    for (const deduction of entry.deductions) {
      if (deduction.role === role) points += deduction.points;
    }
  }
  return answered === 0 ? null : round2(points / answered);
}

/**
 * The conviction one buyer put behind naming this product their FIRST choice.
 *
 * `01 §6.2` appends a strength to a persona's first pick and to nothing else, so
 * this axis is exactly "first-choice conviction" and the page says so. A buyer
 * who made it their runner-up scores `0` on that axis and is marked separately —
 * inventing a number for a runner-up would be publishing a conviction nobody
 * recorded, and dropping the axis would hide a buyer who did name it.
 *
 * A buyer who did not name it at all also scores `0`, which is not an assumption:
 * they were shown it beside its cluster peers and reached for something else.
 */
export function personaConviction(picks: readonly DemandPick[], persona: string): number {
  const pick = picks.find((candidate) => candidate.persona === persona);
  if (pick === undefined || pick.pick !== 'first') return 0;
  return typeof pick.strength === 'number' && Number.isFinite(pick.strength) ? round2(pick.strength) : 0;
}

/**
 * Which way a buyer named it, for the marker beside a `0` that is not a silence.
 * `null` when they did not name it at all.
 */
export function personaPick(picks: readonly DemandPick[], persona: string): 'first' | 'second' | null {
  return picks.find((candidate) => candidate.persona === persona)?.pick ?? null;
}

/**
 * The installed juror roster, in the order the panel was installed in.
 *
 * There is no juror list on a `Ranking` — `packages/engine/src/types.ts` carries
 * `metrics` and `personas` and nothing else about the panel — and this module
 * cannot read `cjr/references/jurors/<slug>.json`, because the paid delivery path
 * (`apps/web/src/lib/pipeline/run.ts`'s `deliverStep`) holds a store and a board
 * and never the installed jury. So the order is RECOVERED from the board.
 *
 * It is recoverable exactly. `rank/scorecard.ts` builds each metric's
 * `deductions` by walking `mergeScoreLog`'s jurors in order, and that order is
 * the score log's first-appearance order, which is the order the fan-out issued
 * the jury in. Every metric's deduction list is therefore a SUBSEQUENCE of the
 * installed roster — a juror who took nothing on that metric is missing, but the
 * ones present are in order. Merging every such subsequence across every product
 * on the board recovers the full order, which is what the topological sort below
 * does. `test/verdict-comparison.test.ts` checks the result against the installed
 * `cjr/references/jurors/*.json` for both seeded categories.
 *
 * Ties and cycles fall back to first-appearance order, so a malformed board
 * produces a stable roster rather than an exception: the axis order of a chart is
 * not worth refusing to deliver a paid verdict over.
 */
export function juryRoster(ranking: Ranking): string[] {
  const firstSeen: string[] = [];
  const seen = new Set<string>();
  const note = (role: string): void => {
    if (seen.has(role)) return;
    seen.add(role);
    firstSeen.push(role);
  };

  const after = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();

  for (const row of ranking.ranking) {
    for (const entry of row.scorecard) {
      const sequence: string[] = [];
      const local = new Set<string>();
      for (const deduction of entry.deductions) {
        // A juror may take several deductions on one metric; the roster cares
        // about the first time they appear in the list, not how often.
        if (local.has(deduction.role)) continue;
        local.add(deduction.role);
        sequence.push(deduction.role);
        note(deduction.role);
      }
      for (const role of entry.substituted_roles) note(role);

      for (let i = 0; i + 1 < sequence.length; i += 1) {
        const from = sequence[i] as string;
        const to = sequence[i + 1] as string;
        let targets = after.get(from);
        if (targets === undefined) {
          targets = new Set();
          after.set(from, targets);
        }
        if (targets.has(to)) continue;
        targets.add(to);
        indegree.set(to, (indegree.get(to) ?? 0) + 1);
      }
    }
  }

  const position = new Map(firstSeen.map((role, index) => [role, index]));
  const byPosition = (a: string, b: string): number => (position.get(a) ?? 0) - (position.get(b) ?? 0);

  const ready = firstSeen.filter((role) => (indegree.get(role) ?? 0) === 0).sort(byPosition);
  const ordered: string[] = [];
  while (ready.length > 0) {
    const role = ready.shift() as string;
    ordered.push(role);
    for (const next of [...(after.get(role) ?? [])].sort(byPosition)) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
    ready.sort(byPosition);
  }

  // A cycle means two metrics disagreed about juror order, which the engine
  // cannot produce. Falling back keeps every juror on the chart.
  return ordered.length === firstSeen.length ? ordered : firstSeen;
}

/** The middle value, or `null` for an empty sample. Population median, ties averaged. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  const value =
    sorted.length % 2 === 1
      ? (sorted[middle] as number)
      : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
  return round2(value);
}

// --- who a peer is allowed to be named as ---------------------------------------

/**
 * A peer's public identity, as it will be frozen.
 *
 * A product's anonymity is chosen at submission, before scoring, and is
 * immutable — so there is no selection effect and nothing to recompute. An
 * anonymous product keeps its cuts, its reasons and its cluster fully public;
 * only its **name and URL** are withheld.
 *
 * `avatarSeed` is a SEAM, not an implementation. The deterministic robot avatar
 * belongs to the identity module; this one supplies the stable string it is drawn
 * from and draws nothing itself.
 */
export interface PeerIdentity {
  readonly anonymous: boolean;
  /** The pseudonym when anonymous, the product name when not. Never both. */
  readonly label: string;
  /**
   * The peer's own public verdict slug, for a link to its page.
   *
   * `null` for an anonymous peer, always — a link to a page carrying the name is
   * the name. Also `null` when the caller cannot resolve one.
   */
  readonly slug: string | null;
  /** Stable input for the robot avatar. Never the product name. */
  readonly avatarSeed: string;
}

/** How a caller tells this module who a peer may be named as. */
export type PeerIdentityResolver = (row: RankedRow) => PeerIdentity;

/** FNV-1a, so a pseudonym is stable for a product across every board it appears on. */
function stableToken(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).toUpperCase().padStart(7, '0').slice(0, 4);
}

/**
 * The default: name nobody.
 *
 * ## Why the default withholds rather than discloses
 *
 * The anonymity flag is the identity module's to own and it does not exist on a
 * `Ranking` yet. Something has to be frozen in the meantime, and the two
 * candidate defaults are not symmetrical:
 *
 * - Defaulting to NAMED writes a product's name into another product's permanent
 *   public payload. `verdicts` refuses UPDATE, so that name can never be taken
 *   back if the product turns out to have chosen anonymity.
 * - Defaulting to WITHHELD prints a pseudonym on a chart. If the product turns
 *   out to be public, the only cost is that verdicts issued before the identity
 *   module landed are less specific than they could have been.
 *
 * One of those is reversible and the other is not, so this is the fail-safe
 * direction. It is also where the seeded boards are going: the founder's decision
 * is that the seeded products will be anonymous, which makes the pseudonymous
 * overlay the normal rendering path rather than an edge case.
 *
 * Replace it by passing a resolver to `freezeComparison`. Nothing else changes.
 */
export const withheldIdentity: PeerIdentityResolver = (row) => ({
  anonymous: true,
  label: `Anon-${stableToken(`peer:${row.id}`)}`,
  slug: null,
  avatarSeed: `peer:${row.id}`,
});

/** One cluster peer, reduced to the shapes a radial draws. */
export interface FrozenPeer {
  /**
   * What this peer may be called. A pseudonym when `anonymous`, the product's own
   * name when not. The real name is never frozen beside a pseudonym: a payload
   * that carried both would be an anonymity that one `JSON.parse` undoes.
   */
  readonly label: string;
  /** Chosen at submission, immutable, and frozen here so a shared page cannot change its mind. */
  readonly anonymous: boolean;
  /** The peer's own verdict page. `null` for an anonymous peer, always. */
  readonly slug: string | null;
  /** Stable seed for the robot avatar the identity module draws. Never the name. */
  readonly avatarSeed: string;
  /** The peer's rank on the same board, so the page can order the legend by it. */
  readonly rank: number;
  /** Mean points taken per answered metric, one per juror, in `jurors` order. */
  readonly jurors: readonly (number | null)[];
  /** First-choice conviction, one per persona, in `personas` order. */
  readonly personas: readonly number[];
}

/** The category's own middle, on all three axes a verdict page can draw. */
export interface FrozenMedian {
  /** Per juror, over every product on the board. */
  readonly jurors: readonly (number | null)[];
  /**
   * Per persona, over the products the Floor actually voted on.
   *
   * Solo-cluster rows are excluded from this sample on purpose. They never faced
   * a forced choice (`DECISIONS.md` S3), so counting their absent votes as zeros
   * would move the middle of "what buyers give a product" using products no buyer
   * was ever shown.
   */
  readonly personas: readonly (number | null)[];
  /** `100 - score` per metric, over every product on the board, in board order. */
  readonly metrics: readonly { readonly metric: string; readonly cuts: number }[];
}

/** Everything a verdict page may compare against, frozen. */
export interface FrozenComparison {
  /** Axis order for every juror figure here. Installed order, recovered from the board. */
  readonly jurors: readonly string[];
  /** Axis order for every persona figure here. `ranking.personas`, the run's own roster. */
  readonly personas: readonly string[];
  /** The other products in this product's cluster. Empty for a solo cluster. */
  readonly peers: readonly FrozenPeer[];
  readonly median: FrozenMedian;
  /** How many products the medians were taken over. A median of 3 is not a category. */
  readonly boardSize: number;
  /** How many of those faced a forced choice, the denominator of `median.personas`. */
  readonly votedSize: number;
}

/**
 * How many cluster peers a radial will carry.
 *
 * Four, because four is what the page has distinct line styles for and what the
 * reader can still tell apart. It is a legibility cap rather than a data one:
 * `cluster.size` on the row states the true size either way, so a page whose
 * cluster is larger says so rather than implying the chart is the whole cluster.
 * The highest-ranked peers are the ones kept.
 */
export const PEER_LIMIT = 4;

/**
 * Beyond this many peers the category median is dropped from the frozen
 * comparison.
 *
 * Not a data judgement — the median is still true — but a chart carrying four
 * peer outlines and a median has five context shapes on six axes and has stopped
 * being readable. The median earns its place when there is little else to
 * compare against, which is exactly the case it exists for: a solo cluster.
 */
const MEDIAN_UP_TO_PEERS = 2;

export function freezeComparison(
  ranking: Ranking,
  row: RankedRow,
  identity: PeerIdentityResolver = withheldIdentity,
): FrozenComparison {
  const jurors = juryRoster(ranking);
  const personas = ranking.personas.map((persona) => persona.name);

  const peers: FrozenPeer[] = ranking.ranking
    .filter((candidate) => candidate.id !== row.id && candidate.cluster.id === row.cluster.id)
    .slice(0, PEER_LIMIT)
    .map((peer) => {
      const who = identity(peer);
      return {
        label: who.label,
        anonymous: who.anonymous,
        // Belt and braces: an anonymous peer never carries a link, whatever a
        // resolver returns. The link is the name.
        slug: who.anonymous ? null : who.slug,
        avatarSeed: who.avatarSeed,
        rank: peer.rank,
        jurors: jurors.map((role) => jurorCut(peer.scorecard, role)),
        personas: personas.map((persona) => personaConviction(peer.demand_detail?.picks ?? [], persona)),
      };
    });

  const voted = ranking.ranking.filter((candidate) => candidate.demand_detail !== undefined);
  const withMedian = peers.length <= MEDIAN_UP_TO_PEERS;

  const metricNames: string[] = [];
  for (const candidate of ranking.ranking) {
    for (const entry of candidate.scorecard) {
      if (!metricNames.includes(entry.metric)) metricNames.push(entry.metric);
    }
  }

  return {
    jurors,
    personas,
    peers,
    median: {
      jurors: jurors.map((role) =>
        !withMedian
          ? null
          : median(
              ranking.ranking
                .map((candidate) => jurorCut(candidate.scorecard, role))
                .filter((value): value is number => value !== null),
            ),
      ),
      personas: personas.map((persona) =>
        !withMedian
          ? null
          : median(voted.map((candidate) => personaConviction(candidate.demand_detail?.picks ?? [], persona))),
      ),
      metrics: metricNames.map((metric) => ({
        metric,
        cuts:
          median(
            ranking.ranking
              .flatMap((candidate) => candidate.scorecard.filter((entry) => entry.metric === metric))
              .map((entry) => 100 - entry.score),
          ) ?? 0,
      })),
    },
    boardSize: ranking.ranking.length,
    votedSize: voted.length,
  };
}
