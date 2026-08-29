/**
 * Phase "Score" — the merit jury. `01 §5.1`, `01 §2`'s Round 1.
 *
 * ## One phase, one step
 *
 * `brief` Part 7: "Make each *phase* one step that fires its calls in parallel
 * inside it — not one step per juror call. Free tier is 50K executions and 5
 * concurrent steps; a 6-way fan-out as separate steps throttles badly." So all
 * `JUROR_COUNT x chunks` calls go out together here and the phase returns once,
 * with one persisted result. The Phase-1 engine is not running on Inngest yet,
 * but the shape has to be the one Phase 2 lifts into a step, or the granularity
 * decision gets made by accident later.
 *
 * ## Chunking
 *
 * `orderedChunks`, never `chunkItems`. `Product.id` is assigned after sorting by
 * the source sheet's rank, so id order IS the incoming leaderboard: chunking in
 * that order hands chunk 1 the products ranked 1-22 and chunk 2 those ranked
 * 23-44. Scoring is comparative (`01 §5.1` — start at 100 and deduct against the
 * field in front of you), so the two chunks come back on different scales, and
 * `01 §6.1` then z-normalizes both halves as ONE population. That is
 * `brief §1.1`'s isolated-scoring bias reappearing between chunks, and it is
 * invisible: the prompts look perfect either way. `orderedChunks` shuffles under
 * a seed derived from the category slug and version, then chunks, so each chunk
 * is a sample across the whole range. `chunkItems` is not exported from
 * `src/rank/index.ts` so this cannot be got wrong by autocomplete.
 *
 * ## Partial answers
 *
 * A juror that fails ANY of its chunks contributes nothing at all. Splicing in
 * the chunks it did return would put that juror's z-scores over a subset of the
 * category while every other juror's are over all of it — `01 §6.1` normalizes
 * per juror across products, so a half-present juror is worse than an absent one.
 * It is recorded as a missing role, and `auditScoreCoverage` turns that into
 * `brief §2.3`'s partial failure.
 */

import { JUROR_COUNT } from '../../config/constants.js';
import type { ModelClient, TokenUsage } from '../../model/types.js';
import type { CalibrationSample } from '../../panels/calibration.js';
import { alarmOutput } from '../../panels/injection.js';
import type { PanelOrdering } from '../../panels/ordering.js';
import { orderedChunks } from '../../panels/ordering.js';
import { buildScoreRequest } from '../../panels/prompts/score.js';
import { validateScoreResult } from '../../panels/schemas.js';
import type { FlaggedInjection, Jury, Product, ScoreLogEntry, ScoreRow } from '../../types.js';
import { auditScoreCoverage, describeCoverage } from '../coverage.js';
import { dispatch, type DispatchResult } from '../dispatch.js';
import { PhaseLedger } from '../ledger.js';
import type { PhaseResult, ScorePhaseValue } from '../types.js';

export interface ScorePhaseInput {
  client: ModelClient;
  products: readonly Product[];
  jury: Jury;
  ordering: PanelOrdering;
  /** Only on the incremental path (`brief §1.1`); a full run's chunk is its own comparison set. */
  calibration?: CalibrationSample;
  /** Max products per call. Defaults to `CHUNK_SIZE` inside `orderedChunks`. */
  chunkSize?: number;
}

/** Fire the whole merit panel and assemble its score log. */
export async function runScorePhase(input: ScorePhaseInput): Promise<PhaseResult<ScorePhaseValue>> {
  const ledger = new PhaseLedger();
  const warnings: string[] = [];

  const chunks = orderedChunks(input.products, input.ordering, input.chunkSize);
  const metricNames = input.jury.metrics.map((metric) => metric.name);
  const productIds = input.products.map((product) => product.id);

  if (input.jury.jurors.length !== JUROR_COUNT) {
    // Not fatal here — `validateJury` is the gate that enforces the count, and it
    // ran before the panel was installed. Worth saying out loud, because the
    // composite divides by the juror count and a short panel changes every score.
    warnings.push(
      `installed jury has ${input.jury.jurors.length} juror(s); DECISIONS.md S1 fixes the panel at ${JUROR_COUNT}`,
    );
  }

  // One flat fan-out over (juror x chunk). `brief` Part 7's one-step phase.
  const calls = input.jury.jurors.flatMap((juror, jurorIndex) =>
    chunks.map((chunk, chunkIndex) => {
      const request = buildScoreRequest({
        metrics: input.jury.metrics,
        products: chunk,
        juror,
        ordering: input.ordering,
        ...(input.calibration === undefined ? {} : { calibration: input.calibration }),
      });
      const label = `juror ${JSON.stringify(juror.role)} chunk ${chunkIndex + 1}/${chunks.length}`;
      const expectation = { productIds: chunk.map((product) => product.id), metricNames };
      return dispatch(input.client, request, label, ledger, (output) =>
        validateScoreResult(output, expectation),
      ).then((result) => ({ jurorIndex, result }));
    }),
  );

  const settled = await Promise.all(calls);

  // Group by juror, preserving the installed panel's order so the score log reads
  // the same way twice.
  const byJuror = new Map<number, DispatchResult<ScoreRow[]>[]>();
  for (const { jurorIndex, result } of settled) {
    const bucket = byJuror.get(jurorIndex) ?? [];
    bucket.push(result);
    byJuror.set(jurorIndex, bucket);
  }

  const scoreLog: ScoreLogEntry[] = [];
  const causes: string[] = [];
  let anyRetryable = false;
  let anyTerminal = false;
  let terminalCode: 'truncated' | 'internal' | undefined;

  for (const [jurorIndex, juror] of input.jury.jurors.entries()) {
    const results = byJuror.get(jurorIndex) ?? [];
    const failures = results.filter((result) => !result.ok);

    if (failures.length > 0) {
      for (const failure of failures) {
        if (failure.ok) continue;
        causes.push(failure.message);
        if (failure.retryable) anyRetryable = true;
        else {
          anyTerminal = true;
          if (failure.code === 'truncated' || failure.code === 'internal') terminalCode = failure.code;
        }
      }
      // See the header: a juror present for only some chunks would z-normalize
      // over a subset. It contributes nothing and is reported as absent.
      continue;
    }

    const scores = results.flatMap((result) => (result.ok ? result.value : []));
    scoreLog.push({ juror_role: juror.role, prompt_version: input.jury.prompt_version, scores });
  }

  const cost = ledger.total();

  // Audited unconditionally, BEFORE the call failures are reported. A juror whose
  // calls threw contributes no score-log entry, so nothing else in the pipeline
  // would ever name it in `substituted_roles` — and `substituted_roles` is the
  // field the verdict page reads to disclose "this juror did not answer". Running
  // the audit only on the success path would mean the one report that most needs
  // to say which juror is missing is the one that cannot.
  const coverage = auditScoreCoverage({
    scoreLog,
    jury: input.jury.jurors,
    metricNames,
    productIds,
    promptVersion: input.jury.prompt_version,
  });

  if (causes.length > 0) {
    // A terminal cause dominates: if any call cannot come out differently, the
    // whole phase cannot, and retrying it spends `brief §2.3`'s free retries on a
    // failure that is already decided.
    return {
      phase: 'score',
      status: 'failed',
      cost,
      warnings,
      failure: {
        code: anyTerminal ? (terminalCode ?? 'model_call') : 'model_call',
        retryable: !anyTerminal && anyRetryable,
        message:
          `merit jury: ${causes.length} of ${settled.length} scoring call(s) did not return a usable answer, ` +
          `leaving ${coverage.jurors_answered}/${coverage.jurors_expected} juror(s) on the panel and ` +
          `${coverage.substituted.length} scorecard cell(s) that would publish a substituted default`,
        causes: [...causes, ...describeCoverage(coverage)],
        coverage,
      },
    };
  }

  if (!coverage.complete) {
    // Every call returned and validated, and the panel is STILL short. Reachable
    // when the installed jury names a juror no call was made for, or when a
    // response validated against a rubric that has since changed. Either way it
    // is `brief §2.3`'s partial success: retry, never deliver.
    return {
      phase: 'score',
      status: 'failed',
      cost,
      warnings,
      failure: {
        code: 'incomplete_panel',
        retryable: true,
        message:
          `merit jury: ${coverage.jurors_answered}/${coverage.jurors_expected} juror(s) answered and ` +
          `${coverage.substituted.length} scorecard cell(s) would be published as substituted defaults ` +
          '— a degraded verdict, which brief §2.3 says to retry rather than deliver',
        causes: describeCoverage(coverage),
        coverage,
      },
    };
  }

  warnings.push(...cacheWarnings(cost.usage, input.jury.jurors.length, chunks.length));

  return {
    phase: 'score',
    status: 'ok',
    cost,
    warnings,
    value: {
      scoreLog,
      flaggedInjections: flagScoreLog(scoreLog),
      coverage,
      chunks: chunks.length,
    },
  };
}

/**
 * The cache watch (`src/model/anthropic-client.ts`'s note, `02 §6`).
 *
 * Every juror of a run sends a byte-identical prefix — method, rubric,
 * calibration, product chunk — and only its own mandate differs, so from the
 * second juror onward every call should be reading that prefix from cache. A
 * persistent zero means either the prefix fell below the model's minimum
 * cacheable length or something is invalidating it, and either way roughly 90% of
 * the input cost of five calls is being paid needlessly. It is surfaced rather
 * than swallowed: nothing else in the pipeline would ever mention it, because a
 * cold cache produces perfectly correct scores.
 *
 * A phase that reported NO input tokens at all is silent instead. There is no
 * cache to be cold on Task 9's handoff path — a local Claude Code subagent
 * reports no token counts, so `cache_read_input_tokens` is zero for the same
 * reason every other count is — and a warning that fires on every locally-seeded
 * run would be noise standing exactly where a real cost regression needs to be
 * noticed.
 */
function cacheWarnings(usage: TokenUsage, jurors: number, chunks: number): string[] {
  if (jurors < 2 || chunks < 1) return [];
  if (usage.input_tokens === 0 && usage.cache_creation_input_tokens === 0) return [];
  if (usage.cache_read_input_tokens > 0) return [];
  return [
    `prompt cache never hit: ${jurors} jurors x ${chunks} chunk(s) shared one prefix and ` +
      'cache_read_input_tokens summed to 0. Either the cached prefix is below the model’s minimum ' +
      'cacheable length (a small category), or something is varying inside it between jurors.',
  ];
}

/**
 * `01 §8`'s output alarm over every deduction reason, tagged with the juror role
 * that wrote it. Log only — per `DECISIONS.md` S9 the output alarm never gates
 * delivery and never holds a preview.
 */
function flagScoreLog(scoreLog: readonly ScoreLogEntry[]): FlaggedInjection[] {
  const flagged: FlaggedInjection[] = [];
  for (const entry of scoreLog) {
    for (const row of entry.scores) {
      for (const metric of row.metrics) {
        for (const deduction of metric.deductions) {
          const hit = alarmOutput(deduction.reason, entry.juror_role, row.id);
          if (hit !== null) flagged.push(hit);
        }
      }
      if (row.note !== undefined) {
        const hit = alarmOutput(row.note, entry.juror_role, row.id);
        if (hit !== null) flagged.push(hit);
      }
    }
  }
  return flagged;
}
