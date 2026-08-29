/**
 * The shared vocabulary of the two approval-gate validators (`01 §4` Steps 2-3).
 *
 * ## Why every failure comes back at once
 *
 * A jury file and a persona roster are written by a model and then edited BY
 * HAND, at a gate whose whole purpose is a human changing things. A validator
 * that reports the first problem and stops turns one fix into a queue of
 * edit-run-edit-run rounds, and every round is a chance to introduce the next
 * problem. So the validators here never short-circuit on a sibling: they collect,
 * and they return the complete list.
 *
 * They do short-circuit DOWNWARD, on one axis only — a field that is not the
 * right kind of thing is not then inspected as if it were. `metrics` that is a
 * string produces one error about `metrics`, not fifteen about its characters.
 *
 * ## Why the messages look the way they do
 *
 * Every message is `<path>: <what is wrong>`, with `path` naming the exact
 * position in the document (`jurors[3].weights["Clarity"]`). The person reading
 * it is looking at a JSON file, so the message has to say where in the file to
 * look. The strings are also the test surface: `test/panels/generate.test.ts`
 * asserts the exact SET of messages for an object broken on several axes at once,
 * which is only a meaningful assertion because the messages are precise enough
 * that a wrong one cannot pass for a right one.
 */

/** A validated document, or the complete list of reasons it was rejected. */
export type ValidationResult<T> =
  | {
      valid: true;
      /** The document, typed. Only ever produced by a validator. */
      value: T;
      /** Always empty. Present on both arms so a caller can read it without narrowing. */
      errors: readonly string[];
    }
  | {
      valid: false;
      /** Every failure found, not just the first. Never empty. */
      errors: readonly string[];
    };

/** A JSON object, as far as a validator is concerned. */
export type Unknowns = Record<string, unknown>;

/** True for a plain object: not null, not an array, not a primitive. */
export function isRecord(value: unknown): value is Unknowns {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True for a string with at least one non-whitespace character.
 *
 * `01` says "non-empty" of these fields. A `voice` of `"   "` is empty in every
 * sense that matters — it renders as nothing in a prompt — so whitespace-only is
 * rejected rather than passed through to a juror mandate that says nothing.
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** Accumulates failures. One per validator run. */
export class Failures {
  private readonly messages: string[] = [];

  /** Record one failure at `path`. */
  add(path: string, problem: string): void {
    this.messages.push(`${path}: ${problem}`);
  }

  /** Every failure recorded, in the order found. */
  get all(): string[] {
    return [...this.messages];
  }

  get empty(): boolean {
    return this.messages.length === 0;
  }
}

/**
 * Check one required non-empty string field, recording a failure if it is not.
 * Returns whether it passed, so a caller can skip dependent checks.
 */
export function requireNonEmptyString(failures: Failures, path: string, value: unknown): value is string {
  if (isNonEmptyString(value)) return true;
  failures.add(path, `must be a non-empty string (got ${describeValue(value)})`);
  return false;
}

/**
 * A short, safe rendering of a bad value for an error message.
 *
 * Truncated hard, because the value came out of a file a model wrote: an error
 * message that echoes an unbounded string is a way for that file to write
 * whatever it likes into an operator's terminal.
 */
export function describeValue(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value === 'object') return 'an object';
  if (typeof value === 'string') {
    const flat = value.replaceAll(/\s+/g, ' ').trim();
    if (flat === '') return 'an empty string';
    return flat.length > DESCRIBE_LIMIT ? `"${flat.slice(0, DESCRIBE_LIMIT)}..."` : `"${flat}"`;
  }
  return String(value);
}

/** How much of an offending value an error message quotes. */
const DESCRIBE_LIMIT = 40;

/**
 * Record a failure for each name that has already been seen.
 *
 * Comparison is on the trimmed string, exactly: `01` says names must be unique
 * and does not say case-insensitively, and two jurors called "The Operator" and
 * "the operator" are a legitimate (if unwise) pair, whereas `"Craft"` and
 * `"Craft "` are the same key written twice — and would collide in a `weights`
 * object, which is the concrete harm the rule exists to prevent.
 */
export function findDuplicates(values: readonly { index: number; value: string }[]): { index: number; value: string }[] {
  const seen = new Set<string>();
  const duplicates: { index: number; value: string }[] = [];

  for (const entry of values) {
    const key = entry.value.trim();
    if (seen.has(key)) duplicates.push(entry);
    else seen.add(key);
  }

  return duplicates;
}
