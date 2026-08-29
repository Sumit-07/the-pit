/**
 * `validateJury` — APPROVAL GATE 1. `01 §4` Step 2, with `JUROR_COUNT = 6`.
 *
 * ## What this gate is actually holding
 *
 * A jury file is written by a model and then edited by hand. Nothing downstream
 * re-checks it. `computeComposite` (`01 §6.1`) normalizes whatever weight vector
 * it is handed, so a `weights` object that names `"Clarity"` while the rubric
 * names `"Clairty"` does not fail — it silently drops that metric's contribution
 * for that juror and renormalizes the rest, and the board publishes a composite
 * that is wrong rather than an error. Likewise a jury of five where the pipeline
 * expects `JUROR_COUNT`: the arithmetic still runs, the cost projection is wrong,
 * and "The Six" is a lie on the verdict page.
 *
 * So this validator is the type system for the part of the configuration a human
 * writes by hand, and it is the only one there is. Every rule `01 §4` Step 2
 * lists is checked here, including the ones that look like formalities.
 *
 * ## The one divergence from `01 §4` Step 2
 *
 * `01` hard-requires `jurors` length **exactly 5**. That is superseded by
 * `DECISIONS.md S1`: the brand is "The Six", the homepage and the verdict mockup
 * both say six, and the 13-call pipeline is sized for six. `JUROR_COUNT` is
 * imported rather than written, so the count cannot drift from the constant the
 * cost model uses.
 *
 * Every other rule stands as written.
 */

import { JUROR_COUNT, METRICS_MAX, METRICS_MIN } from '../../config/constants.js';
import type { CategoryType, Jury, JurorMandate, MetricAnchors, RubricMetric } from '../../types.js';
import { ANCHOR_LEVELS } from '../anchors.js';
import type { ValidationResult } from './fields.js';
import { describeValue, Failures, findDuplicates, isRecord, requireNonEmptyString } from './fields.js';

/** The three archetypes `01 §4` Step 2 admits. */
const CATEGORY_TYPES: readonly CategoryType[] = ['b2b', 'consumer', 'prosumer'];

/** The five prose fields every juror mandate carries. `01 §4` Step 2. */
const MANDATE_FIELDS = ['role', 'who', 'cares_most', 'biased_against', 'voice'] as const;

/**
 * Validate a candidate jury document, returning it typed or returning EVERY
 * reason it was rejected.
 *
 * The returned `Jury` is rebuilt field by field from the values that passed, so
 * an installed jury carries exactly the fields `01 §4` Step 2 defines and nothing
 * else. Anything extra in the file is dropped rather than carried into a prompt.
 */
export function validateJury(obj: unknown): ValidationResult<Jury> {
  const failures = new Failures();

  if (!isRecord(obj)) {
    failures.add('jury', `must be an object (got ${describeValue(obj)})`);
    return { valid: false, errors: failures.all };
  }

  const type = validateType(failures, obj['type']);
  const promptVersion = validatePromptVersion(failures, obj['prompt_version']);
  const metrics = validateMetrics(failures, obj['metrics']);
  const jurors = validateJurors(failures, obj['jurors'], metrics.names);

  if (!failures.empty) return { valid: false, errors: failures.all };

  // Unreachable unless a check above recorded no failure while returning
  // undefined, which would be a bug in this file rather than in the document.
  if (type === undefined || promptVersion === undefined) {
    return { valid: false, errors: ['jury: internal validator error'] };
  }

  return {
    valid: true,
    value: { type, prompt_version: promptVersion, metrics: metrics.value, jurors },
    errors: [],
  };
}

/** `type ∈ {b2b, consumer, prosumer}`. */
function validateType(failures: Failures, value: unknown): CategoryType | undefined {
  const match = CATEGORY_TYPES.find((candidate) => candidate === value);
  if (match !== undefined) return match;

  const allowed = CATEGORY_TYPES.map((candidate) => `"${candidate}"`).join(', ');
  failures.add('type', `must be one of ${allowed} (got ${describeValue(value)})`);
  return undefined;
}

/**
 * `prompt_version` present (truthy).
 *
 * NARROWER THAN `01`, deliberately: `01` says "present (truthy)", which would
 * admit `42` or `true`. `prompt_version` is carried verbatim into `ranking.json`
 * (`01 §6.6`, typed `string`) and into the score log, where it is the field that
 * says which rubric a stored score was produced under. A non-string truthy value
 * would have to be coerced somewhere downstream, and the coercion would be
 * invisible. The only documents this rejects that `01` would accept are ones
 * whose version is not text; every falsy value is rejected by both.
 */
function validatePromptVersion(failures: Failures, value: unknown): string | undefined {
  return requireNonEmptyString(failures, 'prompt_version', value) ? value : undefined;
}

/** The rubric, plus the metric names the weight check cross-references. */
interface Metrics {
  value: RubricMetric[];
  /**
   * The distinct valid metric names found, in order — `undefined` when no rubric
   * could be read at all (`metrics` was not an array, was empty, or every entry
   * was unusable). There is then nothing to cross-check `weights` against, so the
   * key check is skipped and only the values are checked: the rubric itself has
   * already been reported, and repeating "there is no rubric" once per juror per
   * key would bury the one error worth reading.
   */
  names: string[] | undefined;
}

/**
 * `metrics`: a list of `METRICS_MIN`..`METRICS_MAX`, each with a non-empty unique
 * `name`, a non-empty `description`, and all four anchors non-empty.
 *
 * A length violation does not stop the per-entry checks. The point of returning
 * everything at once is that someone fixing a seven-metric rubric also learns
 * that its fourth metric is missing its "50" anchor.
 */
function validateMetrics(failures: Failures, value: unknown): Metrics {
  if (!Array.isArray(value)) {
    failures.add('metrics', `must be an array (got ${describeValue(value)})`);
    return { value: [], names: undefined };
  }

  if (value.length < METRICS_MIN || value.length > METRICS_MAX) {
    failures.add('metrics', `must have ${METRICS_MIN} to ${METRICS_MAX} entries (got ${value.length})`);
  }

  const metrics: RubricMetric[] = [];
  const names: { index: number; value: string }[] = [];

  value.forEach((entry, index) => {
    const path = `metrics[${index}]`;
    if (!isRecord(entry)) {
      failures.add(path, `must be an object (got ${describeValue(entry)})`);
      return;
    }

    const name = entry['name'];
    const hasName = requireNonEmptyString(failures, `${path}.name`, name);
    if (hasName) names.push({ index, value: name });

    const description = entry['description'];
    const hasDescription = requireNonEmptyString(failures, `${path}.description`, description);

    const anchors = validateAnchors(failures, path, entry['anchors']);

    if (hasName && hasDescription && anchors !== undefined) {
      metrics.push({ name, description, anchors });
    }
  });

  for (const duplicate of findDuplicates(names)) {
    failures.add(`metrics[${duplicate.index}].name`, `duplicate metric name ${describeValue(duplicate.value)}`);
  }

  const distinct: string[] = [];
  for (const entry of names) {
    if (!distinct.includes(entry.value)) distinct.push(entry.value);
  }

  return { value: metrics, names: distinct.length === 0 ? undefined : distinct };
}

/**
 * All four anchors `"100" "80" "50" "20"`, each non-empty.
 *
 * The four keys come from `ANCHOR_LEVELS`, the same list `buildScoreRequest`
 * renders from — so this gate cannot admit a rubric the scoring prompt would then
 * render an `undefined` anchor for.
 */
function validateAnchors(failures: Failures, path: string, value: unknown): MetricAnchors | undefined {
  if (!isRecord(value)) {
    failures.add(`${path}.anchors`, `must be an object (got ${describeValue(value)})`);
    return undefined;
  }

  const found: Partial<Record<keyof MetricAnchors, string>> = {};
  let complete = true;

  for (const level of ANCHOR_LEVELS) {
    const anchor = value[level];
    if (requireNonEmptyString(failures, `${path}.anchors["${level}"]`, anchor)) found[level] = anchor;
    else complete = false;
  }

  if (!complete) return undefined;
  return { '100': found['100'] ?? '', '80': found['80'] ?? '', '50': found['50'] ?? '', '20': found['20'] ?? '' };
}

/**
 * `jurors`: exactly `JUROR_COUNT`, each with the five non-empty prose fields, a
 * unique `role`, and a `weights` object keyed by exactly the metric names.
 */
function validateJurors(failures: Failures, value: unknown, metricNames: string[] | undefined): JurorMandate[] {
  if (!Array.isArray(value)) {
    failures.add('jurors', `must be an array (got ${describeValue(value)})`);
    return [];
  }

  if (value.length !== JUROR_COUNT) {
    failures.add('jurors', `must have exactly ${JUROR_COUNT} entries (got ${value.length})`);
  }

  const jurors: JurorMandate[] = [];
  const roles: { index: number; value: string }[] = [];

  value.forEach((entry, index) => {
    const path = `jurors[${index}]`;
    if (!isRecord(entry)) {
      failures.add(path, `must be an object (got ${describeValue(entry)})`);
      return;
    }

    const prose: Partial<Record<(typeof MANDATE_FIELDS)[number], string>> = {};
    let complete = true;

    for (const field of MANDATE_FIELDS) {
      const fieldValue = entry[field];
      if (requireNonEmptyString(failures, `${path}.${field}`, fieldValue)) prose[field] = fieldValue;
      else complete = false;
    }

    if (prose.role !== undefined) roles.push({ index, value: prose.role });

    const weights = validateWeights(failures, path, entry['weights'], metricNames);

    if (complete && weights !== undefined) {
      jurors.push({
        role: prose.role ?? '',
        who: prose.who ?? '',
        cares_most: prose.cares_most ?? '',
        biased_against: prose.biased_against ?? '',
        voice: prose.voice ?? '',
        weights,
      });
    }
  });

  for (const duplicate of findDuplicates(roles)) {
    failures.add(`jurors[${duplicate.index}].role`, `duplicate juror role ${describeValue(duplicate.value)}`);
  }

  return jurors;
}

/**
 * One juror's `weights`: keyed by EXACTLY the metric names — no missing key, no
 * extra key — every value a number >= 0, and the sum > 0.
 *
 * This is the rule with teeth. `01 §6.1` divides each weight by the sum of the
 * weights for the metrics a juror actually scored, so a missing key is not an
 * error downstream, it is a silent reweighting of that juror's opinion; an extra
 * key is a weight that is never applied and a metric name that looks installed
 * but is not; and a sum of zero is a division by zero in the composite.
 *
 * Values must be FINITE: `NaN` and `Infinity` are both `>= 0`-adjacent traps
 * (`NaN >= 0` is false, so `NaN` is caught by the comparison, but `Infinity`
 * passes it and would make one metric the juror's entire opinion after
 * normalization).
 *
 * When `metricNames` is `undefined` — `metrics` was not an array, so there is no
 * rubric to match against — the key cross-check is skipped and only the values
 * are checked. The missing rubric has already been reported once; reporting it
 * again per juror would bury it.
 */
function validateWeights(
  failures: Failures,
  path: string,
  value: unknown,
  metricNames: string[] | undefined,
): Record<string, number> | undefined {
  if (!isRecord(value)) {
    failures.add(`${path}.weights`, `must be an object (got ${describeValue(value)})`);
    return undefined;
  }

  let ok = true;
  const weights: Record<string, number> = {};
  let sum = 0;

  for (const [key, weight] of Object.entries(value)) {
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0) {
      failures.add(`${path}.weights[${JSON.stringify(key)}]`, `must be a number >= 0 (got ${describeValue(weight)})`);
      ok = false;
      continue;
    }
    weights[key] = weight;
    sum += weight;
  }

  if (metricNames !== undefined) {
    for (const name of metricNames) {
      if (!Object.hasOwn(value, name)) {
        failures.add(`${path}.weights`, `missing a weight for metric ${describeValue(name)}`);
        ok = false;
      }
    }

    for (const key of Object.keys(value)) {
      if (!metricNames.includes(key)) {
        failures.add(`${path}.weights`, `unexpected key ${describeValue(key)} — not a metric in the rubric`);
        ok = false;
      }
    }
  }

  if (sum <= 0) {
    failures.add(`${path}.weights`, `must sum to more than 0 (got ${sum})`);
    ok = false;
  }

  return ok ? weights : undefined;
}
