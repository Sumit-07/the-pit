/**
 * `validatePersonas` — APPROVAL GATE 2. `01 §4` Step 3.
 *
 * The panel is the denominator of demand. `01 §6.2` computes `capture` as the
 * share of personas that picked a product out of `P`, the number that answered,
 * so the roster's size and its make-up are both load-bearing: a panel of three
 * makes every `breadth` a third, and a panel of eight identical buyers makes
 * every `breadth` either 0 or 1.
 *
 * This validator enforces the parts of that a machine can check — the bounds, the
 * fields, the unique names, the price sensitivities. What it cannot check is
 * whether the six buyers are actually different people, which is exactly why
 * `01 §4` Step 3 ends in **STOP and show the user** the roster. The generation
 * prompt asks for a price-insensitive capability-chaser and a high-sensitivity
 * defector; a human confirms they arrived.
 */

import { PERSONAS_MAX, PERSONAS_MIN } from '../../config/constants.js';
import type { Persona, PersonaPanel, PriceSensitivity } from '../../types.js';
import type { ValidationResult } from './fields.js';
import { describeValue, Failures, findDuplicates, isRecord, requireNonEmptyString } from './fields.js';

/** The three levels `01 §4` Step 3 admits, matched case-insensitively. */
const PRICE_SENSITIVITIES: readonly PriceSensitivity[] = ['low', 'medium', 'high'];

/**
 * Validate a candidate persona panel, returning it typed or returning EVERY
 * reason it was rejected.
 *
 * `price_sensitivity` is the one field NORMALIZED rather than merely checked:
 * `01` matches it case-insensitively, so `"High"` is valid, but `Persona`
 * declares the lowercase union and `buildChoiceRequest` looks the value up in a
 * gloss table keyed by it. An un-normalized `"High"` would validate here and then
 * render `undefined` into a persona's prompt. Every other field is carried
 * through exactly as written, including its whitespace: trimming a persona's
 * `description` would be editing the roster a human approved.
 */
export function validatePersonas(obj: unknown): ValidationResult<PersonaPanel> {
  const failures = new Failures();

  if (!isRecord(obj)) {
    failures.add('personas', `must be an object (got ${describeValue(obj)})`);
    return { valid: false, errors: failures.all };
  }

  const version = obj['persona_version'];
  const hasVersion = requireNonEmptyString(failures, 'persona_version', version);

  const personas = validateRoster(failures, obj['personas']);

  if (!failures.empty || !hasVersion) {
    return { valid: false, errors: failures.all };
  }

  return { valid: true, value: { persona_version: version, personas }, errors: [] };
}

/**
 * `personas`: a list of `PERSONAS_MIN`..`PERSONAS_MAX` (4-8), each with a
 * non-empty unique `name`, a non-empty `description`, a non-empty `needs` list of
 * non-empty strings, and a valid `price_sensitivity`.
 *
 * `01 §4` Step 3 is explicit that these bounds are wider than what the prompt
 * asks for: "the prompt asks for 6, 5-7 acceptable, but the validator's hard
 * bounds are 4-8". The validator enforces the hard bounds only — narrowing them
 * to the prompt's request would reject a roster a human is entitled to edit down.
 */
function validateRoster(failures: Failures, value: unknown): Persona[] {
  if (!Array.isArray(value)) {
    failures.add('personas', `must be an array (got ${describeValue(value)})`);
    return [];
  }

  if (value.length < PERSONAS_MIN || value.length > PERSONAS_MAX) {
    failures.add('personas', `must have ${PERSONAS_MIN} to ${PERSONAS_MAX} entries (got ${value.length})`);
  }

  const personas: Persona[] = [];
  const names: { index: number; value: string }[] = [];

  value.forEach((entry, index) => {
    const path = `personas[${index}]`;
    if (!isRecord(entry)) {
      failures.add(path, `must be an object (got ${describeValue(entry)})`);
      return;
    }

    const name = entry['name'];
    const hasName = requireNonEmptyString(failures, `${path}.name`, name);
    if (hasName) names.push({ index, value: name });

    const description = entry['description'];
    const hasDescription = requireNonEmptyString(failures, `${path}.description`, description);

    const needs = validateNeeds(failures, path, entry['needs']);
    const sensitivity = validatePriceSensitivity(failures, path, entry['price_sensitivity']);

    if (hasName && hasDescription && needs !== undefined && sensitivity !== undefined) {
      personas.push({ name, description, needs, price_sensitivity: sensitivity });
    }
  });

  for (const duplicate of findDuplicates(names)) {
    failures.add(`personas[${duplicate.index}].name`, `duplicate persona name ${describeValue(duplicate.value)}`);
  }

  return personas;
}

/**
 * `needs`: a NON-EMPTY list of non-empty strings.
 *
 * An empty list is its own failure and not merely a degenerate case of the string
 * check: `buildChoiceRequest` renders needs as the bullet list under "What you
 * need", so a persona with none is a buyer asked to choose with no stated basis
 * for choosing.
 */
function validateNeeds(failures: Failures, path: string, value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    failures.add(`${path}.needs`, `must be an array (got ${describeValue(value)})`);
    return undefined;
  }

  if (value.length === 0) {
    failures.add(`${path}.needs`, 'must have at least one entry');
    return undefined;
  }

  const needs: string[] = [];
  let ok = true;

  value.forEach((need, index) => {
    if (requireNonEmptyString(failures, `${path}.needs[${index}]`, need)) needs.push(need);
    else ok = false;
  });

  return ok ? needs : undefined;
}

/** `price_sensitivity ∈ {low, medium, high}`, case-insensitive, normalized to lowercase. */
function validatePriceSensitivity(failures: Failures, path: string, value: unknown): PriceSensitivity | undefined {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    const match = PRICE_SENSITIVITIES.find((candidate) => candidate === normalized);
    if (match !== undefined) return match;
  }

  const allowed = PRICE_SENSITIVITIES.map((candidate) => `"${candidate}"`).join(', ');
  failures.add(`${path}.price_sensitivity`, `must be one of ${allowed} (got ${describeValue(value)})`);
  return undefined;
}
