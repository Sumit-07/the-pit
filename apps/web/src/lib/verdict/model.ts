/**
 * The frozen verdict, read back.
 *
 * ## Frozen, not derived — and this module is where that is enforced
 *
 * Every ingredient of a verdict page also exists live: `rankings` has the rank,
 * `score_rows` has the deductions, `demand_votes` has the picks. Rendering off
 * those is the obvious design and it is wrong, for the reason `DECISIONS.md §1.2`
 * gives:
 *
 * > appending a product shifts population mean/std so **every existing z-score
 * > changes** ... Do not build anything that assumes rank stability between
 * > placements.
 *
 * A verdict rendered live would therefore show a different number tomorrow than
 * the one that was shared, on the one page whose whole promise is that it keeps
 * showing what its poster was talking about (`brief §2.1`: "a **public permanent
 * URL**, shareable, works logged out"). So the input to this module is a
 * `StoredVerdict` and nothing else. It takes no `Ranking`, no board, no store of
 * current rows — there is no expression in this file that could reach a live
 * score, which is why the rule cannot be broken by forgetting it.
 *
 * ## Two derived numbers, and why they are derived here rather than stored
 *
 * `cuts` and `sharpest` are computed from the frozen scorecard, not read from a
 * field. Both are pure functions of the payload, so they are stable across every
 * render of a given row — the freezing is already done — and computing them here
 * means the verdict page and `packages/engine/src/board/model.ts` share one
 * definition rather than two that can drift.
 *
 * `cuts` is **`100 - mean(metric score)`**, exactly as the board defines it. It
 * is NOT the sum of the ledger's points: those are per-juror deductions off each
 * juror's own 100, and six jurors cutting 20 for the same omission is one
 * 20-point cut, not 120. `brief` Part 5 fixes the word — "Runlet took 97 in
 * cuts" — and a verdict page that used a different arithmetic from the board it
 * links to would be the exact contradiction `lib/pipeline/snapshot.ts` warns
 * about.
 *
 * ## Untrusted input
 *
 * `name`, `url` and every juror reason originate in user-submitted text.
 * `packages/engine/src/panels/data-block.ts` documents the sanitisation applied
 * upstream, and none of it is an escaping guarantee for HTML. Nothing is escaped
 * here — escaping is a property of the output encoding, so it happens once, at
 * render, in `page.ts`. This module's job is to refuse a payload that is not
 * shaped like a verdict, not to rewrite one that is.
 */

import type { CategoryType, RankingWeights } from '@the-pit/engine';

import { robotSvg } from '@/lib/anon';

import type { StoredVerdict } from './store';

/** One juror's deduction, with the juror attached. `brief` Part 6 requires both. */
export interface VerdictDeduction {
  readonly points: number;
  readonly reason: string;
  /** The juror who took it. Never optional: a reason with no author is an anonymous accusation. */
  readonly role: string;
  /** The metric it came off, carried so a deduction can be read outside its ledger block. */
  readonly metric: string;
}

/** One metric row of the ledger. */
export interface VerdictMetric {
  readonly metric: string;
  /** Cross-juror mean, 0-100. */
  readonly score: number;
  /** Cross-juror population std — how much the six disagreed. */
  readonly spread: number;
  /** `100 - score`. */
  readonly cuts: number;
  readonly jurors: number;
  /** Jurors who returned nothing and were substituted a 50. A disclosure, not a detail. */
  readonly substituted: readonly string[];
  /** Heaviest first. */
  readonly deductions: readonly VerdictDeduction[];
}

/** One Floor persona's forced choice. */
export interface VerdictPick {
  readonly persona: string;
  readonly pick: 'first' | 'second';
  readonly strength?: number;
  readonly reason: string;
}

/**
 * What the Floor did.
 *
 * Two arms, not one arm plus a null. `DECISIONS.md` S3 and S11 make a solo
 * cluster a legitimate terminal state — "the Floor only convenes on clusters with
 * >=2 members", and an empty Floor "is a DELIVERY, not a partial failure" — and 32
 * of 48 Developer Tools products are in it. A missing section would read as a
 * broken page to the majority of customers; a discriminated union forces the page
 * to say which case it is and why.
 */
export type VerdictFloor =
  | {
      readonly kind: 'convened';
      readonly demand: number;
      readonly breadth: number;
      readonly intensity: number;
      readonly capture: number;
      readonly share: number;
      readonly picks: readonly VerdictPick[];
      /** How many personas named it their first choice. */
      readonly firstPicks: number;
      /** How many named it runner-up. */
      readonly secondPicks: number;
      /**
       * How many personas could have picked it at all — the denominator
       * `firstPicks + secondPicks` needs to mean anything. `packages/db/src/seed/
       * build.ts`'s `demand_roster_size`: the number of personas that returned
       * choices for this run, which is `01 §6.2`'s `P`. Never read for a `solo`
       * floor, where there is no numerator to divide.
       */
      readonly rosterSize: number;
    }
  | {
      readonly kind: 'solo';
      /** Always 1 in practice; carried so the page can state the fact rather than assume it. */
      readonly clusterSize: number;
    };

/** The cluster the product was judged inside. */
export interface VerdictCluster {
  readonly id: string;
  readonly label: string;
  readonly size: number;
  readonly uniqueness: number;
  readonly reason: string;
}

/**
 * A verdict, ready to render.
 *
 * Every number on it came out of the frozen payload or a frozen column. Nothing
 * here was looked up.
 */
export interface Verdict {
  /** The public URL this was resolved by. */
  readonly slug: string;
  /**
   * What the listing was called ON THE DAY IT WAS DELIVERED.
   *
   * On an anonymous listing this is the designation, and it came out of the
   * frozen payload like everything else on this page. That is what makes the
   * promise hold over time: `verdicts` is append-only and the payload carries the
   * name the verdict was issued under, so a link somebody shared last month
   * cannot start naming the product because its founder has since claimed it and
   * chosen to be named. Claiming names a product on FUTURE boards; it never
   * reaches back into a verdict that was issued anonymously.
   */
  readonly name: string;
  /** The address, or `''` on an anonymous listing, which withholds it. */
  readonly url: string;
  /**
   * Delivered without a name or a URL.
   *
   * From the payload, never from a live lookup on `products.anonymous` — a live
   * read would make this page say something different from what it said when it
   * was handed over, which is the one thing `DECISIONS.md §1.2` and `brief`
   * Part 6 forbid it to do.
   */
  readonly anonymous: boolean;
  /** The robot, inline SVG, sized for the page header. Present iff `anonymous`. */
  readonly robot?: string;
  readonly category: string;
  readonly categoryType: CategoryType;

  /**
   * The rank it held. `brief` Part 5: never promise a rank — so this value is
   * only ever rendered beside `productCount` and `issuedAt`, which say which
   * board it was and when.
   */
  readonly rank: number;
  /** `brief` Part 5's product count stamp. From the column, cross-checked against the payload. */
  readonly productCount: number;
  /** `brief` Part 5's timestamp stamp. ISO-8601, from `verdicts.delivered_at`. */
  readonly issuedAt: string;
  /** `brief §2.4`, 1-based. `null` on an unclaimed seeded listing nobody has pitched. */
  readonly attemptNumber: number | null;
  /** `"3rd pitch"`, or `null` when there is no pitch to count. */
  readonly pitchLabel: string | null;

  /** `100 - mean(metric score)`. The connective word (`brief` Part 5). */
  readonly cuts: number;
  /** Pure merit composite, before the blend. */
  readonly composite: number;
  /** The blended score the row was ranked by. */
  readonly core: number;
  /** Reduced demand, absent when the Floor never convened. */
  readonly demand?: number;
  /** Demand and scarcity moved the row off its pure-merit position. */
  readonly tiebroken: boolean;

  /** The single heaviest deduction anywhere on the card. `null` if nothing came off. */
  readonly sharpest: VerdictDeduction | null;
  /** Ledger, heaviest loss first. */
  readonly metrics: readonly VerdictMetric[];
  readonly cluster: VerdictCluster;
  readonly floor: VerdictFloor;

  readonly weights: RankingWeights;
  readonly versions: {
    readonly prompt: string;
    readonly persona: string;
    readonly uniqueness: string;
    readonly categorySnapshot: string;
  };
}

/**
 * A payload that is not a verdict.
 *
 * Thrown rather than rendered as an empty page. A stored verdict is the record a
 * dispute is argued from (`brief` Part 7), so "we could not read it" has to be
 * loud: a page that silently rendered a blank card would look like a delivered
 * verdict with nothing wrong with it.
 */
export class VerdictPayloadError extends Error {
  override readonly name = 'VerdictPayloadError';
  readonly slug: string;

  constructor(slug: string, detail: string) {
    super(`verdict ${slug}: ${detail}`);
    this.slug = slug;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * `1` -> `"1st pitch"`. `brief §2.4`: shown publicly, next to the rank.
 *
 * A four-line restatement of `ordinalPitch` in `@the-pit/payments`, and it is a
 * restatement on purpose: `apps/web` does not depend on that package, and adding
 * a dependency from the public read path onto the module that owns the money
 * rules would put `AttemptsLedger` one import away from a route that has no
 * session. The behaviour is pinned by a table in `test/verdict-model.test.ts`
 * that walks the same cases, including the 11/12/13 exception.
 */
export function pitchLabel(attemptNumber: number): string {
  const n = Math.max(1, Math.trunc(attemptNumber));
  const lastTwo = n % 100;
  const last = n % 10;
  const suffix =
    lastTwo >= 11 && lastTwo <= 13 ? 'th' : last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th';
  return `${n}${suffix} pitch`;
}

function requireString(slug: string, value: unknown, field: string): string {
  if (typeof value !== 'string' || value === '') throw new VerdictPayloadError(slug, `${field} is not a string`);
  return value;
}

function requireNumber(slug: string, value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new VerdictPayloadError(slug, `${field} is not a finite number`);
  }
  return value;
}

function requireRecord(slug: string, value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new VerdictPayloadError(slug, `${field} is not an object`);
  return value;
}

function requireArray(slug: string, value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new VerdictPayloadError(slug, `${field} is not an array`);
  return value;
}

function parseDeductions(slug: string, raw: unknown, metric: string): VerdictDeduction[] {
  return requireArray(slug, raw, `${metric}.deductions`)
    .map((entry, i) => {
      const record = requireRecord(slug, entry, `${metric}.deductions[${i}]`);
      return {
        points: requireNumber(slug, record['points'], `${metric}.deductions[${i}].points`),
        reason: requireString(slug, record['reason'], `${metric}.deductions[${i}].reason`),
        // `brief` Part 6: every deduction with its reason AND its juror. A
        // deduction whose role is missing is not renderable as a verdict, so it
        // is a payload error rather than a blank byline.
        role: requireString(slug, record['role'], `${metric}.deductions[${i}].role`),
        metric,
      };
    })
    .sort((a, b) => b.points - a.points);
}

function parseMetrics(slug: string, raw: unknown): VerdictMetric[] {
  const entries = requireArray(slug, raw, 'scorecard');
  if (entries.length === 0) throw new VerdictPayloadError(slug, 'scorecard is empty');

  return entries
    .map((entry, i) => {
      const record = requireRecord(slug, entry, `scorecard[${i}]`);
      const metric = requireString(slug, record['metric'], `scorecard[${i}].metric`);
      const score = requireNumber(slug, record['score'], `${metric}.score`);
      const substituted = requireArray(slug, record['substituted_roles'], `${metric}.substituted_roles`).map(
        (role, j) => requireString(slug, role, `${metric}.substituted_roles[${j}]`),
      );
      return {
        metric,
        score,
        spread: requireNumber(slug, record['spread'], `${metric}.spread`),
        cuts: 100 - score,
        jurors: requireNumber(slug, record['juror_count'], `${metric}.juror_count`),
        substituted,
        deductions: parseDeductions(slug, record['deductions'], metric),
      };
    })
    // Heaviest loss first: the ledger opens on the metric that cost the most.
    .sort((a, b) => b.cuts - a.cuts);
}

function parseFloor(
  slug: string,
  row: Record<string, unknown>,
  cluster: VerdictCluster,
  payload: Record<string, unknown>,
): VerdictFloor {
  const status = requireString(slug, row['demand_status'], 'demand_status');

  if (status === 'solo_cluster') {
    // `DECISIONS.md` S11: an empty Floor is a delivery, not a failure. It is also
    // not an absence of data — it is a fact with a reason, and the page states it.
    // `demand_roster_size` is not read here: this product had no numerator, and a
    // roster count beside a floor that never convened would read as "0 of M" —
    // the exact misreading `DECISIONS.md` S3 exists to prevent.
    return { kind: 'solo', clusterSize: cluster.size };
  }
  if (status !== 'scored') throw new VerdictPayloadError(slug, `demand_status ${status} is neither scored nor solo_cluster`);

  const rosterSize = requireNumber(slug, payload['demand_roster_size'], 'demand_roster_size');
  if (!Number.isInteger(rosterSize) || rosterSize < 1) {
    throw new VerdictPayloadError(slug, `demand_roster_size ${rosterSize} is not a roster that could have convened`);
  }

  const detail = requireRecord(slug, row['demand_detail'], 'demand_detail');
  // Annotated, because the conditional spread below produces a union of object
  // literals and TypeScript widens `pick` back to `string` across it.
  const picks = requireArray(slug, detail['picks'], 'demand_detail.picks').map((entry, i): VerdictPick => {
    const record = requireRecord(slug, entry, `picks[${i}]`);
    const raw = requireString(slug, record['pick'], `picks[${i}].pick`);
    const pick = raw === 'first' ? 'first' : raw === 'second' ? 'second' : null;
    if (pick === null) {
      throw new VerdictPayloadError(slug, `picks[${i}].pick is ${raw}, not first or second`);
    }
    const strength = record['strength'];
    return {
      persona: requireString(slug, record['persona'], `picks[${i}].persona`),
      pick,
      ...(typeof strength === 'number' && Number.isFinite(strength) ? { strength } : {}),
      reason: requireString(slug, record['reason'], `picks[${i}].reason`),
    };
  });

  return {
    kind: 'convened',
    demand: requireNumber(slug, detail['demand'], 'demand_detail.demand'),
    breadth: requireNumber(slug, detail['breadth'], 'demand_detail.breadth'),
    intensity: requireNumber(slug, detail['intensity'], 'demand_detail.intensity'),
    capture: requireNumber(slug, detail['capture'], 'demand_detail.capture'),
    share: requireNumber(slug, detail['share'], 'demand_detail.share'),
    picks,
    firstPicks: picks.filter((pick) => pick.pick === 'first').length,
    secondPicks: picks.filter((pick) => pick.pick === 'second').length,
    rosterSize,
  };
}

/**
 * Read one frozen verdict.
 *
 * The stamp — rank, product count, timestamp — is assembled here and nowhere
 * else, so `brief` Part 5's rule that a rank never travels without them is a
 * property of the type rather than a habit of the template.
 *
 * `productCount` comes from the COLUMN, which is what `verdictRow` in
 * `@the-pit/db` stamps and what the schema constrains. The payload carries its
 * own copy; a disagreement between the two means the one record a dispute is
 * argued from contradicts itself, so it is an error rather than a
 * silently-preferred value.
 */
export function parseVerdict(row: StoredVerdict): Verdict {
  const slug = row.publicSlug;
  const payload = requireRecord(slug, row.payload, 'payload');
  const verdict = requireRecord(slug, payload['verdict'], 'payload.verdict');

  const payloadCount = payload['product_count'];
  if (typeof payloadCount === 'number' && payloadCount !== row.productCount) {
    throw new VerdictPayloadError(
      slug,
      `product_count disagrees: column says ${row.productCount}, payload says ${payloadCount}`,
    );
  }
  if (!Number.isInteger(row.productCount) || row.productCount < 1) {
    throw new VerdictPayloadError(slug, `product_count ${row.productCount} is not a board with products on it`);
  }
  if (Number.isNaN(row.deliveredAt.getTime())) {
    throw new VerdictPayloadError(slug, 'delivered_at is not a date');
  }

  const categoryType = requireString(slug, payload['category_type'], 'category_type');
  if (categoryType !== 'b2b' && categoryType !== 'consumer' && categoryType !== 'prosumer') {
    throw new VerdictPayloadError(slug, `category_type ${categoryType} is not a category type`);
  }

  const clusterRaw = requireRecord(slug, verdict['cluster'], 'cluster');
  const cluster: VerdictCluster = {
    id: requireString(slug, clusterRaw['id'], 'cluster.id'),
    label: requireString(slug, clusterRaw['label'], 'cluster.label'),
    size: requireNumber(slug, clusterRaw['size'], 'cluster.size'),
    uniqueness: requireNumber(slug, clusterRaw['uniqueness'], 'cluster.uniqueness'),
    reason: requireString(slug, clusterRaw['reason'], 'cluster.reason'),
  };

  const metrics = parseMetrics(slug, verdict['scorecard']);
  const weights = requireRecord(slug, payload['weights'], 'weights');
  const demand = verdict['demand'];

  /**
   * Anonymity, from the frozen document.
   *
   * `payload.anonymous` is the explicit record and is what a verdict frozen since
   * this feature existed carries. A blank `verdict.url` is the fallback for one
   * frozen before it: `products.url` is `NOT NULL` and the engine's `Product.url`
   * is required, so an empty address in a delivered payload can only have come
   * from a redaction.
   *
   * Read BEFORE `url` is required, because `requireString` rejects `''` — an
   * anonymous listing withholding its address is exactly the case that must not
   * be treated as a malformed payload.
   */
  const anonymous = payload['anonymous'] === true || verdict['url'] === '';
  const name = requireString(slug, verdict['name'], 'name');

  return {
    slug,
    name,
    url: anonymous ? '' : requireString(slug, verdict['url'], 'url'),
    anonymous,
    ...(anonymous
      ? { robot: robotSvg(name, { size: 88, label: `${name}, an anonymous listing` }) }
      : {}),
    category: requireString(slug, payload['category'], 'category'),
    categoryType,

    rank: requireNumber(slug, verdict['rank'], 'rank'),
    productCount: row.productCount,
    issuedAt: row.deliveredAt.toISOString(),
    attemptNumber: row.attemptNumber,
    pitchLabel: row.attemptNumber === null ? null : pitchLabel(row.attemptNumber),

    cuts: 100 - mean(metrics.map((metric) => metric.score)),
    composite: requireNumber(slug, verdict['composite'], 'composite'),
    core: requireNumber(slug, verdict['core'], 'core'),
    ...(typeof demand === 'number' && Number.isFinite(demand) ? { demand } : {}),
    tiebroken: verdict['tiebroken'] === true,

    // The heaviest cut anywhere on the card, chosen across metrics rather than
    // within one — `brief` Part 6 wants the card to lead with a reason, and the
    // sharpest line is the one a reader should meet first.
    sharpest: metrics.flatMap((metric) => metric.deductions).sort((a, b) => b.points - a.points)[0] ?? null,
    metrics,
    cluster,
    floor: parseFloor(slug, verdict, cluster, payload),

    weights: {
      merit: requireNumber(slug, weights['merit'], 'weights.merit'),
      demand: requireNumber(slug, weights['demand'], 'weights.demand'),
      uniqueness_lambda: requireNumber(slug, weights['uniqueness_lambda'], 'weights.uniqueness_lambda'),
    },
    versions: {
      prompt: requireString(slug, payload['prompt_version'], 'prompt_version'),
      persona: requireString(slug, payload['persona_version'], 'persona_version'),
      uniqueness: requireString(slug, payload['uniqueness_version'], 'uniqueness_version'),
      categorySnapshot: requireString(slug, payload['category_snapshot_version'], 'category_snapshot_version'),
    },
  };
}
