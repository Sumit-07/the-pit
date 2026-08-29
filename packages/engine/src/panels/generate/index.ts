/**
 * Jury and persona generation — the two APPROVAL GATES of `01 §4` Steps 2-3.
 *
 * Two prompt builders that produce text for a human to dispatch, and two
 * validators that decide whether what comes back may be installed. Nothing here
 * calls a model, sequences a phase, or reads a rank: generation is deliberately
 * out-of-band, because both gates end in a person approving what they see.
 */

export type { ValidationResult } from './fields.js';
export { buildJuryPrompt, buildPersonaPrompt } from './prompts.js';
export type { TypeHint } from './type-hint.js';
export { B2B_WORDS, CONSUMER_WORDS, inferTypeHint, sampleTaglines } from './type-hint.js';
export { validateJury } from './validate-jury.js';
export { validatePersonas } from './validate-personas.js';
