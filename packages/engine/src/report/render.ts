/**
 * Rendering the Phase 1 report: Markdown for `cjr/runs/<slug>/report.md`, and a
 * short summary for the terminal.
 *
 * Written for a founder reading it ONCE to make a go/no-go call. Two consequences
 * shape the layout:
 *
 * 1. **The verdict table is first.** Every check that could stop the project is
 *    on one screen, with its consequence spelled out, before any descriptive
 *    statistic. Someone who reads only the first page has read the decision.
 * 2. **Every dollar figure carries its basis and the price table's date.** A
 *    measured cost and an estimated one never appear in the same total, and the
 *    date the prices were checked is printed in both money sections rather than
 *    once at the bottom, because a stale price is invisible otherwise.
 *
 * Pure string building. `buildReport` did the arithmetic; nothing here computes a
 * statistic, so a formatting change can never move a number.
 */

import {
  DISCRIMINATION_FLOOR,
  JUROR_CORRELATION_CEILING,
  JUROR_COUNT,
  METRICS_MAX,
  METRICS_MIN,
  PERSONAS_MAX,
  PERSONAS_MIN,
  UNIQ_LAMBDA,
} from '../config/constants.js';
import type { Spread } from './clusters.js';
import type { GateCheck, ReportModel } from './model.js';

const money = (usd: number): string => `$${usd.toFixed(4)}`;
const money2 = (usd: number): string => `$${usd.toFixed(2)}`;
const num = (value: number, places = 4): string => value.toFixed(places);
const pct = (fraction: number): string => `${(fraction * 100).toFixed(1)}%`;
const int = (value: number): string => value.toLocaleString('en-US');

/** A GitHub-flavoured Markdown table. Empty rows render as an explicit "(none)". */
function table(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  if (rows.length === 0) return '_(none)_';
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

/** Column width for the status mark: the longest label plus a separating space. */
const GATE_MARK_WIDTH = 12;

const GATE_MARK: Record<GateCheck['status'], string> = {
  pass: 'PASS',
  flag: 'FLAG',
  missing: 'MISSING',
  // Deliberately not 'PASS' and deliberately not blank: the evidence ran and
  // settled nothing, which is a decision the reader has to make rather than a
  // box that got ticked.
  inconclusive: 'NO EVIDENCE',
  info: 'READ',
};

function spreadRow(label: string, spread: Spread, places = 2): string[] {
  return [
    label,
    String(spread.n),
    num(spread.min, places),
    num(spread.p25, places),
    num(spread.median, places),
    num(spread.p75, places),
    num(spread.max, places),
    num(spread.mean, places),
    num(spread.spread, places),
  ];
}

const SPREAD_HEADERS = ['', 'n', 'min', 'p25', 'median', 'p75', 'max', 'mean', 'pop std'];

/** The whole report as Markdown. */
export function renderReport(model: ReportModel): string {
  return [
    header(model),
    verdict(model),
    sectionJury(model),
    sectionDisagreement(model),
    sectionFix11(model),
    sectionLeak(model),
    sectionMeasuredCost(model),
    sectionEstimatedCost(model),
    sectionDistributions(model),
    sectionDeductions(model),
    sectionClusters(model),
    sectionDemand(model),
    sectionWarnings(model),
  ].join('\n\n');
}

function header(model: ReportModel): string {
  const p = model.provenance;
  return [
    `# Phase 1 report — ${model.category}`,
    '',
    `${model.products} products, ${model.completeness.jurors_present} of ${model.completeness.jurors_expected} ` +
      `jurors, ${model.metrics.length} metrics (${model.metrics.join(', ')}).`,
    '',
    table(
      ['field', 'value'],
      [
        ['run outcome', p.outcome],
        ['category_version', p.category_version],
        ['prompt_version', p.prompt_version],
        ['persona_version', p.persona_version],
        ['uniqueness_version', p.uniqueness_version],
        ['engine_version', p.engine_version],
      ],
    ),
    '',
    'Every number below is pure arithmetic over the stored score log, cluster rows and demand log. ' +
      'No model was called to produce this report.',
  ].join('\n');
}

function verdict(model: ReportModel): string {
  return [
    '## Verdict',
    '',
    'Ordered by what would stop the project, not by what is easy to compute.',
    '',
    table(
      ['', 'check', 'value', 'what it means'],
      model.gates.map((gate) => [GATE_MARK[gate.status], gate.name, gate.value, gate.note]),
    ),
  ].join('\n');
}

function sectionJury(model: ReportModel): string {
  const c = model.completeness;
  const adjusted = model.discrimination_over_full_panel;

  return [
    '## 1. Does the jury separate the products?',
    '',
    table(
      ['statistic', 'value', 'source'],
      [
        ['discrimination (pop std of merit composites)', num(model.health.discrimination), '`01` §6.5'],
        ['— renormalized over the full installed panel', num(adjusted), 'see below'],
        ['demand_discrimination (pop std of demand_raw)', num(model.health.demand_discrimination), '`01` §6.5'],
        ['avg_metric_spread (mean cross-juror pop std)', num(model.health.avg_metric_spread), '`01` §6.5'],
        ['tiebreak_count (moved off pure-merit rank)', String(model.health.tiebreak_count), '`01` §6.4'],
      ],
    ),
    '',
    `\`01\` §6.5 flags \`discrimination < ${DISCRIMINATION_FLOOR}\` as **merit alone is fragile**: the products ` +
      'score alike, so the board ends up decided by demand and by the bounded uniqueness tilt rather than by ' +
      'the jury.',
    '',
    '### Juror response completeness',
    '',
    'Printed here rather than in an appendix because `discrimination` cannot be read without it. ' +
      '`computeComposite` divides the summed per-juror contributions by the number of distinct juror roles ' +
      'ACTUALLY PRESENT in the score log, not by the size of the installed jury. A run missing one juror of six ' +
      'therefore reports composites — and a `discrimination` over them — scaled by 6/5 = 1.2 relative to a ' +
      'full-panel normalization, which can lift a fragile panel over the 0.5 floor without a single score changing.',
    '',
    table(
      ['field', 'value'],
      [
        ['jurors present (the divisor)', String(c.jurors_present)],
        ['jurors on the installed jury', String(c.jurors_expected)],
        ['missing roles', c.missing_roles.length === 0 ? '—' : c.missing_roles.join(', ')],
        ['unexpected roles in the score log', c.unexpected_roles.length === 0 ? '—' : c.unexpected_roles.join(', ')],
        ['cells expected (present jurors × products × metrics)', int(c.cells_expected)],
        ['cells actually scored', int(c.cells_present)],
        ['cells published as a substituted 50', int(c.cells_substituted)],
        ['complete', c.complete ? 'yes' : 'NO'],
      ],
    ),
  ].join('\n');
}

function sectionDisagreement(model: ReportModel): string {
  const { roles, matrix, flagged } = model.correlation;

  const matrixRows = roles.map((role, i) => [
    role,
    ...roles.map((_, j) => num(matrix[i]?.[j] ?? 0, 3)),
  ]);

  return [
    '## 2. Does the jury genuinely disagree?',
    '',
    '`01` §4 Step 2 requires that the jury genuinely disagree, and that is a HUMAN approval gate — no validator ' +
      'can check it. This matrix is the only quantitative proxy for it. Each cell is the Pearson correlation of ' +
      "two jurors' per-product merit composites, computed with the same `computeComposite` the board uses, over " +
      'one juror at a time. Two jurors at r ≈ 1 are, for ranking purposes, one juror with a doubled vote.',
    '',
    table(['', ...roles], matrixRows),
    '',
    `Mean pair correlation **${num(model.correlation.mean_pair_correlation)}**. ` +
      `Threshold: any pair at or above **${JUROR_CORRELATION_CEILING}** is flagged.`,
    '',
    ...(model.correlation.flat_roles.length === 0
      ? []
      : [
          `> **Read that mean with care.** ${model.correlation.flat_roles.length} juror(s) — ` +
            `${model.correlation.flat_roles.join(', ')} — gave every product the SAME composite. A ` +
            'constant vector correlates 0 with everything, which is exactly the value a perfectly ' +
            'independent juror would score, so a juror that said nothing pulls this mean DOWN. That is not ' +
            'merely flattering: **it HIDES real dependence between the jurors that did vote**, because ' +
            'every pair involving the silent one dilutes the pairs that carry the actual agreement. Over ' +
            'the jurors that actually voted the mean is ' +
            `**${num(model.correlation.mean_pair_correlation_excluding_flat)}**. That is the number to read.`,
          '',
        ]),
    flagged.length === 0
      ? '_No pair reaches the threshold._'
      : `**${flagged.length} flagged pair(s):**\n\n` +
        table(['juror A', 'juror B', 'r'], flagged.map((pair) => [pair.a, pair.b, num(pair.r)])) +
        '\n\nA panel of jurors who all say the same thing is the failure mode that makes the whole product ' +
        'worthless. Redesign the mandates before seeding further categories.',
  ].join('\n');
}

function sectionFix11(model: ReportModel): string {
  const lines = [
    '## 3. Does fix 1.1 work? (A/B against the test-retest floor)',
    '',
    '`brief` §1.1 is the most important correction in the project: on the `--add-product` path a juror scores ' +
      'one product alone and returns systematically different raw scores, and every paid submission takes that ' +
      'path. The fix embeds already-scored peers in the prompt as calibration. This section is the only evidence ' +
      'that it worked.',
    '',
    '**The A/B delta cannot be read without the test-retest floor.** A model is stochastic: score the same ' +
      'product twice through the SAME path and the numbers move. An A/B difference only means the two paths ' +
      'differ to the extent it exceeds what resampling one path does. Both are below, and the comparison is stated.',
    '',
  ];

  if (model.ab === undefined) {
    lines.push(
      '> **MISSING.** No `ab.json` was produced for this category, so Phase 1 has not answered its own question.',
      '>',
      '> Run `pnpm engine ab --category "…" --run` to produce it. That command SPENDS: it runs one full batch ' +
        'over the category, one leave-one-out seed run per target, and two placements per target.',
    );
    return lines.join('\n');
  }

  const ab = model.ab;
  const s = ab.summary;

  lines.push(
    // Column labels avoid the `|Δ|` notation on purpose: a literal pipe inside a
    // GitHub-Markdown table cell splits the row, so the table would render as
    // garbage in exactly the section a founder reads first.
    table(
      ['comparison', 'mean abs Δ per metric (points)', 'mean abs Δ rank (positions)'],
      [
        ['A/B — batch vs calibrated incremental', num(s.mean_abs_metric_delta_ab, 3), num(s.mean_abs_rank_delta_ab, 2)],
        ['test-retest — incremental twice', num(s.mean_abs_metric_delta_retest, 3), num(s.mean_abs_rank_delta_retest, 2)],
        [
          'ratio (A/B ÷ retest)',
          Number.isFinite(s.metric_delta_ratio) ? num(s.metric_delta_ratio, 2) : '∞ (retest floor is exactly 0)',
          Number.isFinite(s.rank_delta_ratio) ? num(s.rank_delta_ratio, 2) : '∞ (retest floor is exactly 0)',
        ],
      ],
    ),
    '',
    `**Reading:** ${s.reading}`,
    '',
    '### Per product',
    '',
    table(
      ['id', 'name', 'rank A', 'rank B', 'rank B′', 'Δrank A/B', 'Δrank retest', 'mean abs Δ A/B', 'mean abs Δ retest', 'peers'],
      ab.products.map((product) => [
        String(product.id),
        product.name,
        String(product.batch.rank),
        String(product.incremental.rank),
        String(product.retest.rank),
        String(product.rank_delta_ab),
        String(product.rank_delta_retest),
        num(product.mean_abs_metric_delta_ab, 3),
        num(product.mean_abs_metric_delta_retest, 3),
        String(product.calibration_peers),
      ]),
    ),
    '',
    '### Per metric, per product',
    '',
    table(
      ['id', 'metric', 'A (batch)', 'B (incremental)', 'B′ (retest)', 'Δ A/B', 'Δ retest'],
      ab.products.flatMap((product) =>
        Object.keys(product.batch.metrics).map((metric) => [
          String(product.id),
          metric,
          num(product.batch.metrics[metric] ?? 0, 2),
          num(product.incremental.metrics[metric] ?? 0, 2),
          num(product.retest.metrics[metric] ?? 0, 2),
          num(product.metric_delta_ab[metric] ?? 0, 2),
          num(product.metric_delta_retest[metric] ?? 0, 2),
        ]),
      ),
    ),
    '',
    ...ab.notes.map((note) => `- ${note}`),
    ...(ab.failures.length === 0 ? [] : ['', '**Targets that did not complete:**', ...ab.failures.map((f) => `- ${f}`)]),
    '',
    `Producing this evidence cost **${money(ab.cost.total.cost_usd)}** over ${ab.cost.total.calls} call(s) ` +
      `(${ab.cost.basis}). ${ab.cost.note}`,
  );

  return lines.join('\n');
}

function sectionLeak(model: ReportModel): string {
  const l = model.leak;
  return [
    '## 4. Did the source ranking leak into our board?',
    '',
    'Task 5 fixed a Critical defect: prompts rendered products in `orig_rank` order and chunks were ' +
      'rank-contiguous, so each chunk was judged against a uniformly strong or uniformly weak field. The fix ' +
      'removed the POSITIONAL signal. It did not remove the NUMERIC one — prompts still print `[id N]` markers ' +
      'and `Product.id` is itself monotone in `orig_rank`. Remapping display ids was rejected: ids are the join ' +
      'key for the score log, the clusters and the demand log, and a translation bug that misattributed a score ' +
      'to the wrong product would be far worse than the residual signal. So the size of what remains is measured.',
    '',
    table(
      ['correlation', 'Spearman ρ', 'reading'],
      [
        ['final rank vs `orig_rank`', num(l.final_rank_vs_orig_rank), '+1 = identical order, −1 = reversed'],
        ['merit composite vs `orig_rank`', num(l.merit_vs_orig_rank), 'negative = agreement (high merit, low rank number)'],
        ['`core` vs `orig_rank`', num(l.core_vs_orig_rank), 'negative = agreement'],
        ['`Product.id` vs `orig_rank`', num(l.id_vs_orig_rank), '+1 by construction — this IS the residual channel'],
      ],
    ),
    '',
    `Top-${l.top_ten_size} overlap: **${l.top_ten_overlap} of ${l.top_ten_size}** products in our top ` +
      `${l.top_ten_size} are also in outbid's, over ${l.n} products.`,
    '',
    `> ${model.leak_reading}`,
  ].join('\n');
}

function sectionMeasuredCost(model: ReportModel): string {
  const c = model.cost;
  return [
    '## 5. Cost — MEASURED',
    '',
    `Summed from \`usage\` on responses that actually came back. Basis: **${c.basis}**.`,
    '',
    `> ${c.note}`,
    '',
    table(
      ['phase', 'calls', 'input tok', 'output tok', 'cache write', 'cache read', 'cost'],
      [
        ...Object.entries(c.phases).map(([phase, cost]) => [
          phase,
          int(cost.calls),
          int(cost.usage.input_tokens),
          int(cost.usage.output_tokens),
          int(cost.usage.cache_creation_input_tokens),
          int(cost.usage.cache_read_input_tokens),
          money(cost.cost_usd),
        ]),
        [
          '**TOTAL**',
          int(c.total.calls),
          int(c.total.usage.input_tokens),
          int(c.total.usage.output_tokens),
          int(c.total.usage.cache_creation_input_tokens),
          int(c.total.usage.cache_read_input_tokens),
          `**${money(c.total.cost_usd)}**`,
        ],
      ],
    ),
    '',
    // Only the unpriced-models line is conditional. Filtering every empty string
    // out of this array would collapse the blank lines Markdown needs between
    // paragraphs and tables, so the omission is a spread of an empty array.
    ...(c.unpriced_models.length === 0
      ? []
      : [
          `Unpriced model ids seen: ${c.unpriced_models.map((id) => `\`${id}\``).join(', ')}. Their tokens were ` +
            'booked at $0 — the total above is not a total.',
          '',
        ]),
    priceTableBlock(model),
  ].join('\n');
}

function sectionEstimatedCost(model: ReportModel): string {
  const s = model.schedule;
  return [
    '## 6. Cost — ESTIMATED: the recalibration schedule',
    '',
    '`brief` Part 3 specifies **top 20 per category nightly, plus a full board weekly**; `brief` Part 7 budgets ' +
      `**$${s.budget.min_usd}–${s.budget.max_usd}/month** for recalibration inference. A single pass of a single ` +
      'category is not that comparison — this is.',
    '',
    'Nothing in this section was measured. Input tokens are counted off the rendered bytes of requests that were ' +
      'never sent; output tokens come from the worst-case per-row derivations behind the `MAX_TOKENS_*` constants. ' +
      'These figures are never added to the measured ones above.',
    '',
    '### One pass, one category',
    '',
    table(
      ['pass', 'products', 'chunks', 'calls', 'est. input tok', 'est. output tok', 'score-only cost', 'full-pipeline cost'],
      [s.nightly, s.weekly].map((pass) => [
        pass.label,
        String(pass.products),
        String(pass.chunks),
        String(pass.calls),
        int(pass.estimated_input_tokens),
        int(pass.estimated_output_tokens),
        money(pass.score_only_cost_usd),
        money(pass.full_pipeline_cost_usd),
      ]),
    ),
    '',
    '**Which phases a pass runs is NOT settled.** `brief` Part 3 does not say. `brief` §1.5 settles exactly ' +
      'one half of it: clusters are append-only and full re-clustering is an explicit admin operation that ' +
      'clears demand, so a routine pass cannot RE-CLUSTER. It says nothing about re-polling the Floor over ' +
      'clusters whose membership did not move — that shifts no membership and clears no demand — and ' +
      '`DECISIONS.md` **S7 records exactly that question as OPEN**: "Does nightly recalibration re-run the ' +
      'Floor?". So there are three readings, and **score + customer**, the one S7 leaves open, is arguably ' +
      'the likeliest. All three are below, bracketed.',
    '',
    '### The month, across every category',
    '',
    `${num(s.nights_per_month, 4)} nights and ${num(s.weeks_per_month, 4)} weeks per month ` +
      `(365 ÷ 12, and that ÷ 7 — not a rounded 30 and 4, which would understate the total).`,
    '',
    table(
      ['reading', 'per category / month', `× ${s.categories} categories`, `vs $${s.budget.max_usd} ceiling`, 'verdict'],
      [
        [
          'score only (lower bound)',
          money2(s.monthly_score_only_per_category_usd),
          `**${money2(s.monthly_score_only_usd)}**`,
          `${num(s.score_only_vs_budget_max, 2)}×`,
          s.score_only_within_budget ? 'within' : '**OVER**',
        ],
        [
          'score + customer (S7 open)',
          money2(s.monthly_score_and_customer_per_category_usd),
          `**${money2(s.monthly_score_and_customer_usd)}**`,
          `${num(s.score_and_customer_vs_budget_max, 2)}×`,
          s.score_and_customer_within_budget ? 'within' : '**OVER**',
        ],
        [
          'full pipeline (ceiling)',
          money2(s.monthly_full_pipeline_per_category_usd),
          `**${money2(s.monthly_full_pipeline_usd)}**`,
          `${num(s.full_pipeline_vs_budget_max, 2)}×`,
          s.full_pipeline_within_budget ? 'within' : '**OVER**',
        ],
      ],
    ),
    '',
    s.verdict_survives_s7
      ? 'All three readings land on the same side of the ceiling, so **this verdict does not depend on S7 ' +
        'being resolved.**'
      : '**The readings disagree**, so the answer genuinely turns on `DECISIONS.md` S7. Resolve S7 before ' +
        'treating either figure as the budget.',
    '',
    inputsBlock(model),
    '',
    `The $${s.budget.min_usd}–${s.budget.max_usd} line was stated over **${s.budget.stated_categories}** ` +
      `categories (\`brief\` Part 3). The data has **${s.categories}**, and the panel is six jurors where ` +
      '`01` §4 assumed five (`DECISIONS.md` S1). This is the re-baseline `DECISIONS.md` lists as an open ' +
      'Phase 1 item.',
    '',
    '**Assumptions:**',
    ...s.caveats.map((caveat) => `- ${caveat}`),
    '',
    priceTableBlock(model),
  ].join('\n');
}

/**
 * The S2/S3 verdict.
 *
 * Separated out because it has to be able to say "I did not measure this". The
 * mean of an empty list is 0 by convention (`mean([]) === 0`), and 0 is also the
 * value that means "S3 moves solo products nowhere" — so a category with NO
 * solo-cluster products would otherwise answer the bolded question with a
 * measured-looking `0.0000`. Measuring that interaction is the entire purpose of
 * this subsection, so reporting it as settled when it was never asked is the
 * worst available outcome here.
 *
 * The yardstick for "near zero" is the magnitude of one full uniqueness tilt
 * (`UNIQ_LAMBDA`), because the question is comparative: S2 and S3 are the two
 * ways novelty touches `core`, and the honest statement about the second is
 * whether it is larger or smaller than the whole of the first. The same figure is
 * also given as a fraction of `core_spread`, the way the tilt already is, so a
 * reader who prefers the population yardstick has it.
 */
function noveltyVerdict(model: ReportModel): string {
  const n = model.novelty;
  const preamble =
    '**Is novelty credited twice?** S3 is two-directional by design: a strong solo product gains ' +
    '`DEMAND_W × z_merit` and a weak one loses exactly that much, so the test is not whether the gain ' +
    'is non-zero — it is whether the MEAN SIGNED gain over solo products is near zero. ';

  if (n.s3_gain_solo.n === 0) {
    return (
      preamble +
      '**Not measured in this category: no product has a missing demand entry, so S3 renormalized ' +
      'nobody and there is no population to take that mean over.** The 0.0000 a naive reading would ' +
      'print here is `mean([])`, not a finding. The interaction remains unmeasured until a category ' +
      'with solo clusters is seeded.'
    );
  }

  const asCoreSpread =
    n.core_spread === 0 ? undefined : Math.abs(n.mean_s3_gain_solo) / n.core_spread;
  const yardstick =
    `It is **${num(n.mean_s3_gain_solo)}** \`core\` units over ${n.s3_gain_solo.n} solo product(s)` +
    (asCoreSpread === undefined ? '' : `, i.e. ${pct(asCoreSpread)} of one population std of \`core\``) +
    `, against a full uniqueness tilt of ±${UNIQ_LAMBDA}. `;

  const reading =
    Math.abs(n.mean_s3_gain_solo) <= n.max_tilt
      ? 'That is within one full uniqueness tilt, so S3 is not moving solo products as a group in either ' +
        'direction — the individual gains cancel, which is what two-directional means.'
      : n.mean_s3_gain_solo > 0
        ? 'That is a LIFT larger than a full uniqueness tilt: solo products are being raised as a group, on ' +
          'top of the tilt. Novelty is credited twice at a magnitude that shows on the board.'
        : 'That is a PENALTY larger than a full uniqueness tilt — solo products are, as a group, weaker on ' +
          'merit than the rest, and S3 amplifies that downward. Novelty is not being credited twice here; ' +
          'the renormalization is working in the direction the merit says.';

  return preamble + yardstick + reading;
}

/**
 * What the token estimate was actually rendered from.
 *
 * A projection carries a real category name and real-looking dollars whatever it
 * was computed over, so the inputs that drive prompt size are printed beside it —
 * with `DECISIONS.md` S5's measured 141-character seeded median as the reference.
 * A run against synthetic fixture text then declares itself instead of reading as
 * a measurement of the real corpus. What this section verifies is the COMPOSITION
 * of the schedule; the magnitude is only as good as these numbers.
 */
function inputsBlock(model: ReportModel): string {
  const inputs = model.schedule.inputs;
  const drift = inputs.median_description_chars - inputs.seeded_corpus_median_chars;
  return [
    '**What the magnitude rests on.** The composition above is verified arithmetic. The dollar amounts are ' +
      'only as good as the prompt bytes they were rendered from:',
    '',
    table(
      ['driver', 'this projection', 'real seeded corpus'],
      [
        ['products in the category', String(inputs.products), 'varies by category'],
        [
          'median description characters',
          String(inputs.median_description_chars),
          `${inputs.seeded_corpus_median_chars} (\`DECISIONS.md\` S5)`,
        ],
        ['rubric metrics', String(inputs.metrics), `${METRICS_MIN}–${METRICS_MAX} (\`01\` §4 Step 2)`],
        ['personas', String(inputs.personas), `${PERSONAS_MIN}–${PERSONAS_MAX} (\`01\` §4 Step 3)`],
        ['jurors', String(inputs.jurors), `${JUROR_COUNT} (\`DECISIONS.md\` S1)`],
      ],
    ),
    '',
    drift === 0
      ? ''
      : `This projection's median description is ${Math.abs(drift)} characters ${drift < 0 ? 'SHORTER' : 'longer'} ` +
        `than the real seeded median, and description text is the largest single driver of a scoring prompt. ` +
        `${drift < 0 ? 'The real magnitude is therefore more likely HIGHER than the figure above, not lower.' : ''} ` +
        'Treat the magnitude as unconfirmed until this harness runs against a seeded category.',
  ]
    .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
    .join('\n');
}

/**
 * The price table, printed in BOTH money sections.
 *
 * Repeated on purpose. Prices are the one input to this engine that is not
 * derivable from a repository document, and nothing in the codebase notices when
 * they go stale — so the date lives beside every dollar figure rather than once
 * at the bottom where a reader scanning one section would never see it.
 */
function priceTableBlock(model: ReportModel): string {
  return [
    `**Price table — checked ${model.price_table_date}.** USD per million tokens. Cache rates are the published ` +
      "multipliers on each model's own input rate.",
    '',
    table(
      ['model id', 'input', 'output', 'cache write', 'cache read'],
      model.prices.map((row) => [
        `\`${row.model_id}\``,
        money(row.input),
        money(row.output),
        money(row.cache_write),
        money(row.cache_read),
      ]),
    ),
  ].join('\n');
}

function sectionDistributions(model: ReportModel): string {
  return [
    '## 7. Score distribution, per juror, per metric',
    '',
    'Computed over the cells each juror ACTUALLY returned — not over the substituted table the composite reads. ' +
      'Padding a juror\'s distribution with fabricated 50s would pull it toward the centre and make a silent ' +
      'juror look like a moderate one; `missing` carries that information without the distortion.',
    '',
    'Bands are counts in 0–19 / 20–39 / 40–59 / 60–79 / 80–100.',
    '',
    table(
      ['juror', 'metric', 'n', 'missing', 'min', 'p25', 'median', 'p75', 'max', 'mean', 'pop std', 'bands'],
      model.distributions.map((d) => [
        d.role,
        d.metric,
        String(d.n),
        String(d.missing),
        num(d.min, 0),
        num(d.p25, 0),
        num(d.median, 1),
        num(d.p75, 0),
        num(d.max, 0),
        num(d.mean, 2),
        num(d.spread, 2),
        d.bands.join('/'),
      ]),
    ),
  ].join('\n');
}

function sectionDeductions(model: ReportModel): string {
  const d = model.deductions;
  return [
    '## 8. Deduction rate, per juror',
    '',
    '`01` §5.1 makes the deduction the unit of a juror\'s opinion: start at 100 and deduct with reasons. A juror ' +
      'that barely deducts is not lenient, it is not participating — its per-metric z-scores collapse toward zero ' +
      'and it contributes a near-constant column to the composite while still counting in the divisor.',
    '',
    table(
      ['juror', 'points deducted', 'deductions issued', 'cells touched', 'points / touched cell', 'verdict'],
      d.jurors.map((juror) => [
        juror.role,
        int(juror.points),
        int(juror.count),
        int(juror.cells_touched),
        num(juror.points_per_touched_cell, 2),
        juror.dead_weight ? '**DEAD WEIGHT**' : 'participating',
      ]),
    ),
    '',
    `Panel median: **${num(d.median_points, 0)}** points. Dead-weight cut (half the median): ` +
      `**${num(d.threshold, 1)}**. ` +
      (d.dead_weight_roles.length === 0
        ? 'No juror falls below it.'
        : `Below it: **${d.dead_weight_roles.join(', ')}**.`),
  ].join('\n');
}

function sectionClusters(model: ReportModel): string {
  const c = model.clusters;
  const n = model.novelty;

  return [
    '## 9. Clusters, scarcity, and whether novelty is credited twice',
    '',
    table(
      ['cluster size', 'clusters', 'products'],
      c.histogram.map((bar) => [String(bar.size), String(bar.clusters), String(bar.products)]),
    ),
    '',
    table(
      ['field', 'value'],
      [
        ['clusters', String(c.clusters)],
        ['products', String(c.products)],
        ['largest cluster', String(c.largest_cluster)],
        ['solo clusters (size 1)', `${c.solo_clusters} (${pct(c.solo_cluster_fraction)} of clusters)`],
        [
          'products with no demand entry',
          `${c.solo_status_products} (${pct(c.solo_status_fraction)} of products)`,
        ],
        ['products the uniqueness pass returned nothing for', String(c.unclustered_products)],
      ],
    ),
    '',
    '### The S2/S3 interaction',
    '',
    '`DECISIONS.md` S2 keeps the ±0.075 uniqueness tilt and S3 renormalizes a product with no demand entry to ' +
      'merit-only at full weight, so a solo-cluster product is touched by novelty twice. Both effects are measured ' +
      'below in the same units (`core`), because neither decision alone answers the question.',
    '',
    table(SPREAD_HEADERS, [
      spreadRow('scarcity — no demand entry', n.scarcity_solo, 1),
      spreadRow('scarcity — has demand entry', n.scarcity_scored, 1),
      spreadRow('S2 tilt — no demand entry', n.tilt_solo, 4),
      spreadRow('S2 tilt — has demand entry', n.tilt_scored, 4),
      spreadRow('S3 gain — no demand entry', n.s3_gain_solo, 4),
    ]),
    '',
    `The tilt is bounded to ±${UNIQ_LAMBDA} by construction. Population std of \`core\` across this board is ` +
      `**${num(n.core_spread)}**, so the largest possible tilt is **${pct(n.max_tilt_as_core_spread)}** of one ` +
      'population std. It can only decide order where `core` is genuinely close.',
    '',
    `It actually moved **${n.moved_by_tilt}** product(s) off the order \`core\` alone would give ` +
      `(${n.moved_by_tilt_solo} of them with no demand entry), by at most **${n.max_positions_moved_by_tilt}** ` +
      'position(s). The counterfactual re-sorts by `(−core, −composite, id)`, i.e. `01` §6.4\'s final sort with ' +
      'the tilt removed, so the difference is attributable to the tilt and nothing else.',
    '',
    noveltyVerdict(model),
  ].join('\n');
}

function sectionDemand(model: ReportModel): string {
  const d = model.demand;
  return [
    '## 10. Demand coverage',
    '',
    '`01` §6.3 re-standardizes `demand_raw` over the products that HAVE an entry. That makes the size of that ' +
      'population load-bearing: with exactly two, a population z is always exactly ±1 and demand contributes a ' +
      'fixed ±0.35 to `core` regardless of what the personas said. This section exists to find out whether that ' +
      'degenerate case is reachable in real data rather than to assume it is not.',
    '',
    table(
      ['field', 'value'],
      [
        ['products', String(d.products)],
        ['with a demand entry', `${d.with_demand} (${pct(d.fraction_with_demand)})`],
        ['without one', String(d.without_demand)],
        ['clusters carrying demand', String(d.clusters_with_demand)],
        ['degenerate (exactly 2 with demand)', d.degenerate_two ? '**YES**' : 'no'],
        ['degenerate (exactly 1 with demand)', d.degenerate_one ? '**YES**' : 'no'],
        ['no demand at all', d.no_demand_at_all ? '**YES**' : 'no'],
      ],
    ),
    '',
    table(SPREAD_HEADERS, [spreadRow('demand_raw (products with an entry)', d.demand_raw, 4)]),
  ].join('\n');
}

function sectionWarnings(model: ReportModel): string {
  return [
    '## Warnings carried from the run',
    '',
    model.warnings.length === 0 ? '_(none)_' : model.warnings.map((warning) => `- ${warning}`).join('\n'),
  ].join('\n');
}

/**
 * The terminal summary: the verdict table and the three numbers that decide the
 * gate. Everything else is in the file.
 */
export function formatReportSummary(model: ReportModel, path: string): string {
  const lines = [
    `PHASE 1 REPORT — ${model.category}`,
    '',
    `  ${model.products} products, ${model.completeness.jurors_present}/${model.completeness.jurors_expected} jurors, ` +
      `${model.metrics.length} metrics, run outcome ${model.provenance.outcome}`,
    '',
  ];

  for (const gate of model.gates) {
    // Wide enough for the longest mark ('NO EVIDENCE', 11) plus a space. A pad
    // shorter than the widest label does not truncate, it runs the two columns
    // together — and it would do so on exactly the row that must be readable.
    lines.push(`  ${GATE_MARK[gate.status].padEnd(GATE_MARK_WIDTH)}${gate.name.padEnd(42)}${gate.value}`);
  }

  // Every status that is not a pass and not a deliberate READ. `inconclusive`
  // belongs here for the same reason it exists at all: a gate with no usable
  // evidence behind it is a decision someone has to make, and omitting it would
  // print "No gate is flagged." for a run whose fix-1.1 A/B settled nothing —
  // moving the exact failure the `inconclusive` status was added to eliminate out
  // of the gate table and into the console summary. It is also the only place the
  // note ("Nothing can be concluded…") reaches a reader who never opens the file.
  const needsDecision = model.gates.filter(
    (gate) => gate.status === 'flag' || gate.status === 'missing' || gate.status === 'inconclusive',
  );
  lines.push(
    '',
    needsDecision.length === 0 ? '  No gate needs a decision.' : `  ${needsDecision.length} gate(s) need a decision:`,
  );
  for (const gate of needsDecision) lines.push(`    ! ${gate.name}: ${gate.note}`);

  lines.push(
    '',
    `  Measured spend: ${money(model.cost.total.cost_usd)} (${model.cost.basis}) over ${model.cost.total.calls} call(s).`,
    // The last line printed and the single most quotable figure in the whole
    // output, so it carries its own hedges rather than relying on the reader
    // having seen §6. A range, not one number, because which phases a pass runs
    // is open (DECISIONS.md S7); and the inputs it was rendered from, because a
    // projection carries real-looking dollars whatever produced them.
    `  Estimated schedule: ${money2(model.schedule.monthly_score_only_usd)}-` +
      `${money2(model.schedule.monthly_full_pipeline_usd)}/mo across 3 readings (S7 open), over ` +
      `${model.schedule.categories} categories, against a $${model.schedule.budget.min_usd}-` +
      `${model.schedule.budget.max_usd} budget stated over ${model.schedule.budget.stated_categories}. ` +
      `Prices checked ${model.price_table_date}.`,
    `    ESTIMATED, not measured, and rendered from ${model.schedule.inputs.products} products at a ` +
      `${model.schedule.inputs.median_description_chars}-char median description ` +
      `(real seeded corpus: ${model.schedule.inputs.seeded_corpus_median_chars}, DECISIONS.md S5) — ` +
      'the composition is verified, the magnitude is not. Do not quote it as measured.',
    '',
    `  Written to ${path}`,
  );

  return lines.join('\n');
}
