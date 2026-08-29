/**
 * The fix-1.1 evidence: the A/B check and the test-retest baseline it can only be
 * read against.
 *
 * ## What is being tested
 *
 * `the-pit-build-brief.md` §1.1: in a full run a juror sees up to `CHUNK_SIZE`
 * products at once and spreads deductions across them; on the `--add-product`
 * path it sees one product alone and returns systematically different raw scores
 * for the same text. Every paid submission takes that path, so the whole bias
 * lands on customers. The fix is `selectCalibrationSample` — `CALIBRATION_SAMPLE`
 * already-scored peers embedded in the incremental prompt with their published
 * scores, as reference, never re-scored.
 *
 * This module is the only thing in the project that can say whether the fix
 * worked.
 *
 * ## Why the test-retest half is not optional
 *
 * A model is stochastic. Score the same product twice through the SAME path and
 * the numbers move. So an A/B difference of, say, 3 points means nothing until
 * you know what the same-path difference is: if re-running the identical prompt
 * also moves scores 3 points, the A/B "difference" is sampling noise wearing a
 * label. `docs/plans/phase-1-engine.md` Task 8 is explicit — "Without this, the
 * A/B deltas cannot be separated from ordinary sampling noise" — so the two are
 * measured together, reported together, and the report says plainly which is
 * larger.
 *
 * ## The design, and why the ranks are comparable
 *
 * For each of `AB_SAMPLE` target products:
 *
 *   A (batch)       the target inside ONE full run over all n products
 *   B (incremental) a full run over the n-1 products WITHOUT the target
 *                   ("leave-one-out"), then `runIncremental` places the target
 *                   back with the calibration sample
 *   B' (retest)     `runIncremental` again, same seed, same inputs
 *
 * The leave-one-out seed is what makes the rank deltas mean anything. Both paths
 * end with the target sitting in a category of exactly n products, so a rank in
 * one is a rank in the other. The cheaper design — one seed run excluding all
 * five targets, then five placements into it — would compare a rank out of n
 * against a rank out of n-4, and the difference would be mostly arithmetic.
 *
 * Path A is run once and reused for all five targets. Path B needs its own seed
 * run per target, so the cost is one full run plus `AB_SAMPLE` more, plus two
 * placements each.
 *
 * ## This SPENDS
 *
 * `runAbCheck` takes a `ModelClient` and makes real calls. It is deliberately not
 * reachable from the report path, which is pure computation over stored rows: the
 * A/B result is written to `cjr/runs/<slug>/ab.json` by the `ab` command and the
 * report reads it. Its own cost is measured and returned, so the Phase 1 report
 * can say what the evidence cost to produce.
 */

import { AB_SAMPLE, ENGINE_VERSION } from '../config/constants.js';
import type { ModelClient } from '../model/types.js';
import { selectCalibrationSample } from '../panels/calibration.js';
import { categorySlug, mulberry32, requireSlug, seedFrom } from '../panels/seeded.js';
import { partitionSizes } from '../rank/chunk.js';
import { mean } from '../rank/stats.js';
import { runIncremental } from '../run/incremental.js';
import { buildLedger, zeroCost } from '../run/ledger.js';
import { runCategory, type RunConfig } from '../run/run-category.js';
import type { CostLedger, PhaseCost, PhaseName } from '../run/types.js';
import type { Jury, PersonaPanel, Product, RankedProduct, Ranking } from '../types.js';
import { measuredCost, type MeasuredCost } from './cost.js';

/** Namespace for the target draw. Changing it redraws every A/B sample. */
const AB_SEED_NAMESPACE = 'ab-targets';

/** One product's scores and position, on one of the three paths. */
export interface AbPathResult {
  /** Metric name -> the published cross-juror mean score for that metric. */
  metrics: Record<string, number>;
  /** 1-based final rank on the board this path produced. */
  rank: number;
  /** Pure merit composite. */
  composite: number;
  /** Products in the category this rank is out of. Equal across paths by design. */
  category_size: number;
}

/** One target product, scored three ways. */
export interface AbProduct {
  id: number;
  name: string;
  /** A: inside a full batch. */
  batch: AbPathResult;
  /** B: placed by `runIncremental` with the calibration sample. */
  incremental: AbPathResult;
  /** B': the same placement run a second time. */
  retest: AbPathResult;
  /** `incremental - batch`, per metric. The fix-1.1 signal. */
  metric_delta_ab: Record<string, number>;
  /** `retest - incremental`, per metric. The same-path noise floor. */
  metric_delta_retest: Record<string, number>;
  mean_abs_metric_delta_ab: number;
  mean_abs_metric_delta_retest: number;
  /** `incremental.rank - batch.rank`. Positive means the placement ranked it worse. */
  rank_delta_ab: number;
  rank_delta_retest: number;
  /** Peers embedded in this product's incremental prompt. */
  calibration_peers: number;
  /** The exact sample those peers came from (`brief §1.1`'s versioning rule). */
  calibration_version: string;
}

/** The comparison the Phase 1 gate turns on. */
export interface AbSummary {
  /** Mean over targets and metrics of `|incremental - batch|`. */
  mean_abs_metric_delta_ab: number;
  /** Mean over targets and metrics of `|retest - incremental|`. */
  mean_abs_metric_delta_retest: number;
  mean_abs_rank_delta_ab: number;
  mean_abs_rank_delta_retest: number;
  /**
   * `ab / retest` for the metric deltas. Above 1 means the path difference is
   * larger than same-path noise; at or below 1 the A/B deltas are indistinguishable
   * from resampling. `Infinity` when the retest floor is exactly 0, which a
   * deterministic client produces and a real model never will.
   */
  metric_delta_ratio: number;
  rank_delta_ratio: number;
  /** True when the A/B metric delta exceeds the test-retest floor. */
  ab_exceeds_retest: boolean;
  /** One sentence stating which is larger, for a reader who reads nothing else. */
  reading: string;
}

/** Everything the `ab` command writes to `cjr/runs/<slug>/ab.json`. */
export interface AbCheckResult {
  category: string;
  category_version: string;
  engine_version: string;
  /** Targets requested. `products.length` may be smaller if a path failed. */
  sample_size: number;
  /** Products in the full category — the population every rank is out of. */
  category_size: number;
  products: AbProduct[];
  summary: AbSummary;
  /** What producing this evidence cost, with its measured/unmeasured basis. */
  cost: MeasuredCost;
  /** Targets whose paths did not complete, named with the reason. */
  failures: string[];
  notes: string[];
}

export interface AbCheckInput {
  category: string;
  products: readonly Product[];
  jury: Jury;
  personas: PersonaPanel;
  client: ModelClient;
  config: RunConfig;
  /** Targets to score both ways. Defaults to `AB_SAMPLE`. */
  sampleSize?: number;
}

/**
 * Run the A/B check and the test-retest baseline. SPENDS — see the header.
 *
 * @throws when the batch run does not deliver. There is then nothing to compare
 *   against, and a partial result would invite exactly the wrong conclusion: an
 *   A/B with no A reads as "no difference".
 */
export async function runAbCheck(input: AbCheckInput): Promise<AbCheckResult> {
  const sampleSize = input.sampleSize ?? AB_SAMPLE;
  if (!Number.isInteger(sampleSize) || sampleSize < 1) {
    throw new RangeError(`runAbCheck: sampleSize must be a positive integer, got ${sampleSize}`);
  }
  const slug = requireSlug('runAbCheck', input.category, input.config.categoryVersion);

  const ledgers: CostLedger[] = [];
  const failures: string[] = [];

  // --- A: one full batch run, reused by every target -------------------------
  const batch = await runCategory({
    category: input.category,
    products: input.products,
    jury: input.jury,
    personas: input.personas,
    client: input.client,
    config: { ...input.config, resume: false },
  });
  ledgers.push(batch.results.meta.ledger);
  if (batch.status !== 'delivered') {
    throw new Error(
      'runAbCheck: the full-batch run did not deliver, so there is no A side to compare against. ' +
        `Failures: ${batch.failures.map((failure) => failure.message).join('; ')}`,
    );
  }

  const targets = selectTargets(batch.ranking, sampleSize, slug, input.config.categoryVersion);
  const products: AbProduct[] = [];

  for (const target of targets) {
    const product = input.products.find((candidate) => candidate.id === target);
    const batchRow = batch.ranking.ranking.find((row) => row.id === target);
    if (product === undefined || batchRow === undefined) {
      failures.push(`product ${target}: not present in both the product set and the batch board`);
      continue;
    }

    // --- B: leave-one-out seed, then place the target back -------------------
    const rest = input.products.filter((candidate) => candidate.id !== target);
    const seedRun = await runCategory({
      category: input.category,
      products: rest,
      jury: input.jury,
      personas: input.personas,
      client: input.client,
      config: { ...input.config, resume: false },
    });
    ledgers.push(seedRun.results.meta.ledger);
    if (seedRun.status !== 'delivered') {
      failures.push(
        `product ${target}: the leave-one-out seed run did not deliver ` +
          `(${seedRun.failures.map((failure) => failure.message).join('; ')})`,
      );
      continue;
    }

    const place = async (): Promise<{ ranking: Ranking; peers: number; version: string } | string> => {
      const outcome = await runIncremental({
        category: input.category,
        product,
        products: rest,
        ranking: seedRun.ranking,
        results: seedRun.results,
        jury: input.jury,
        personas: input.personas,
        client: input.client,
        config: { ...input.config, resume: false },
      });
      ledgers.push(outcome.status === 'held' ? emptyLedger() : outcome.results.meta.ledger);
      if (outcome.status === 'held') return 'the input gate held the product text (DECISIONS.md S9)';
      if (outcome.status === 'failed') {
        return outcome.failures.map((failure) => failure.message).join('; ');
      }
      // The sample is re-derived rather than captured from inside `runIncremental`
      // so the report can state what the juror was actually shown; it is a pure
      // function of the same three inputs the placement passed it, so the two
      // cannot disagree.
      const sample = calibrationFor(rest, seedRun.ranking, input.config.categoryVersion);
      return { ranking: outcome.ranking, peers: sample.peers, version: sample.version };
    };

    const first = await place();
    if (typeof first === 'string') {
      failures.push(`product ${target}: incremental placement failed — ${first}`);
      continue;
    }
    const second = await place();
    if (typeof second === 'string') {
      failures.push(`product ${target}: test-retest placement failed — ${second}`);
      continue;
    }

    const incrementalRow = first.ranking.ranking.find((row) => row.id === target);
    const retestRow = second.ranking.ranking.find((row) => row.id === target);
    if (incrementalRow === undefined || retestRow === undefined) {
      failures.push(`product ${target}: placed but missing from the resulting board`);
      continue;
    }

    const batchPath = pathResult(batchRow, batch.ranking.ranking.length);
    const incrementalPath = pathResult(incrementalRow, first.ranking.ranking.length);
    const retestPath = pathResult(retestRow, second.ranking.ranking.length);

    const abDelta = metricDelta(incrementalPath.metrics, batchPath.metrics);
    const retestDelta = metricDelta(retestPath.metrics, incrementalPath.metrics);

    products.push({
      id: target,
      name: product.name,
      batch: batchPath,
      incremental: incrementalPath,
      retest: retestPath,
      metric_delta_ab: abDelta,
      metric_delta_retest: retestDelta,
      mean_abs_metric_delta_ab: meanAbs(abDelta),
      mean_abs_metric_delta_retest: meanAbs(retestDelta),
      rank_delta_ab: incrementalPath.rank - batchPath.rank,
      rank_delta_retest: retestPath.rank - incrementalPath.rank,
      calibration_peers: first.peers,
      calibration_version: first.version,
    });
  }

  return {
    category: input.category,
    category_version: input.config.categoryVersion,
    engine_version: ENGINE_VERSION,
    sample_size: sampleSize,
    category_size: input.products.length,
    products,
    summary: summarizeAb(products),
    cost: measuredCost(sumLedgers(ledgers)),
    failures,
    notes: [
      'A is the target inside one full batch run over the whole category; B places it with ' +
        'runIncremental into a leave-one-out seed of the same category, so both ranks are out of ' +
        `${input.products.length} products.`,
      'B′ (retest) repeats B with identical inputs. Its deltas are the same-path noise floor: ' +
        'an A/B delta is only evidence of a path difference to the extent it exceeds this.',
      'Both paths run through runScorePhase, so this compares two routes through one implementation ' +
        'rather than two implementations.',
    ],
  };
}

// --- Target selection ----------------------------------------------------------

/**
 * `sampleSize` targets spread across the board, drawn from a seed.
 *
 * The board is cut into `sampleSize` contiguous bands by rank (`partitionSizes`,
 * the same sums-to-exactly-n split the calibration sampler and the chunker use)
 * and one product is taken from each. Spread, not a top slice: the isolated-
 * scoring bias `brief §1.1` describes is a shift in the raw scale, and a sample
 * drawn only from the top of the board could not show a shift that pulls
 * mid-board products up.
 *
 * Seeded on `(namespace, slug, categoryVersion)` so the same category at the same
 * version always tests the same five products — two Phase 1 reports are then
 * comparable, and a target cannot be re-rolled until it gives a flattering answer.
 */
export function selectTargets(
  ranking: Ranking,
  sampleSize: number,
  slug: string,
  categoryVersion: string,
): number[] {
  const byRank = [...ranking.ranking].sort((a, b) => a.rank - b.rank);
  if (byRank.length <= sampleSize) return byRank.map((row) => row.id);

  const nextUint32 = mulberry32(seedFrom(AB_SEED_NAMESPACE, slug, categoryVersion));
  const targets: number[] = [];
  let offset = 0;
  for (const size of partitionSizes(byRank.length, sampleSize)) {
    const row = byRank[offset + (nextUint32() % size)];
    // Unreachable: the bands partition the board exactly. Checked because a
    // silent `undefined` would drop a target and shrink the evidence set.
    if (row === undefined) throw new Error('selectTargets: band index out of range');
    targets.push(row.id);
    offset += size;
  }
  return targets;
}

/** The category slug, for a caller that has only the name. */
export function abSlug(category: string): string {
  return categorySlug(category);
}

// --- Small pure helpers --------------------------------------------------------

/** One board row reduced to the three things the comparison needs. */
function pathResult(row: RankedProduct, categorySize: number): AbPathResult {
  return {
    // `fromEntries`, never `metrics[name] = x`: metric names come from the jury
    // pass, and a metric named `__proto__` would hit the prototype setter.
    metrics: Object.fromEntries(row.scorecard.map((entry) => [entry.metric, entry.score] as const)),
    rank: row.rank,
    composite: row.composite,
    category_size: categorySize,
  };
}

/** `later - earlier` over the metrics both sides carry. */
function metricDelta(later: Record<string, number>, earlier: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.keys(earlier)
      .filter((metric) => metric in later)
      .map((metric) => [metric, (later[metric] ?? 0) - (earlier[metric] ?? 0)] as const),
  );
}

function meanAbs(deltas: Record<string, number>): number {
  return mean(Object.values(deltas).map(Math.abs));
}

/**
 * Peers and version for the placement that just happened, re-derived from the
 * seed it was given.
 *
 * `runIncremental` selects the sample internally and does not return it, so the
 * report would otherwise have no way to say what the juror was actually shown —
 * which is the one thing fix 1.1 is about. Re-deriving is safe rather than
 * duplicative: `selectCalibrationSample` is a pure function of exactly these
 * three arguments and `runIncremental` calls it with exactly these, so the two
 * cannot disagree. Its own tests pin that determinism.
 */
function calibrationFor(
  products: readonly Product[],
  ranking: Ranking,
  categoryVersion: string,
): { peers: number; version: string } {
  const sample = selectCalibrationSample(products, ranking, categoryVersion);
  return { peers: sample.sample.length, version: sample.calibration_version };
}

/** Roll several runs' ledgers into one. Phase-by-phase, so the shape is unchanged. */
export function sumLedgers(ledgers: readonly CostLedger[]): CostLedger {
  const phases: Record<PhaseName, PhaseCost> = {
    score: zeroCost(),
    uniqueness: zeroCost(),
    customer: zeroCost(),
  };

  for (const ledger of ledgers) {
    for (const name of Object.keys(phases) as PhaseName[]) {
      const from = ledger.phases[name];
      const into = phases[name];
      into.calls += from.calls;
      into.usage.input_tokens += from.usage.input_tokens;
      into.usage.output_tokens += from.usage.output_tokens;
      into.usage.cache_creation_input_tokens += from.usage.cache_creation_input_tokens;
      into.usage.cache_read_input_tokens += from.usage.cache_read_input_tokens;
      into.cost_usd += from.cost_usd;
      for (const model of from.unpriced_models) {
        if (!into.unpriced_models.includes(model)) into.unpriced_models.push(model);
      }
    }
  }

  return buildLedger(phases);
}

function emptyLedger(): CostLedger {
  return buildLedger({ score: zeroCost(), uniqueness: zeroCost(), customer: zeroCost() });
}

/**
 * The one comparison the gate turns on: is the path difference bigger than the
 * noise floor?
 *
 * `reading` is written so it can be pasted into the report unaltered and still be
 * true in every case — including the case a deterministic fixture client produces,
 * where both floors are exactly 0 and the honest statement is that the run cannot
 * distinguish them.
 */
export function summarizeAb(products: readonly AbProduct[]): AbSummary {
  const abMetric = mean(products.map((product) => product.mean_abs_metric_delta_ab));
  const retestMetric = mean(products.map((product) => product.mean_abs_metric_delta_retest));
  const abRank = mean(products.map((product) => Math.abs(product.rank_delta_ab)));
  const retestRank = mean(products.map((product) => Math.abs(product.rank_delta_retest)));

  const ratio = (top: number, bottom: number): number => (bottom === 0 ? (top === 0 ? 1 : Infinity) : top / bottom);
  const metricRatio = ratio(abMetric, retestMetric);

  const reading =
    products.length === 0
      ? 'No target completed both paths, so there is no fix-1.1 evidence in this run.'
      : abMetric === 0 && retestMetric === 0
        ? `Both the A/B and the test-retest metric deltas are exactly 0 over ${products.length} product(s). ` +
          'That is what a deterministic client produces; against a real model it would mean the two paths ' +
          'and two samples of one path are indistinguishable. Nothing can be concluded about fix 1.1 from ' +
          'a run with no sampling variance.'
        : abMetric > retestMetric
          ? `The A/B metric delta (${abMetric.toFixed(3)} points) is LARGER than the test-retest floor ` +
            `(${retestMetric.toFixed(3)})` +
            (Number.isFinite(metricRatio)
              ? `, by ${metricRatio.toFixed(2)}x`
              : ' — the floor is exactly 0, which only a deterministic client produces') +
            '. The two paths differ by more than resampling one of them does, so a real path difference ' +
            'survives the calibration sample.'
          : `The A/B metric delta (${abMetric.toFixed(3)} points) is NOT larger than the test-retest floor ` +
            `(${retestMetric.toFixed(3)}). The batch and calibrated-incremental paths are indistinguishable ` +
            'from two samples of the same path — which is what fix 1.1 was for.';

  return {
    mean_abs_metric_delta_ab: abMetric,
    mean_abs_metric_delta_retest: retestMetric,
    mean_abs_rank_delta_ab: abRank,
    mean_abs_rank_delta_retest: retestRank,
    metric_delta_ratio: metricRatio,
    rank_delta_ratio: ratio(abRank, retestRank),
    ab_exceeds_retest: abMetric > retestMetric,
    reading,
  };
}
