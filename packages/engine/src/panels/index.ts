/**
 * The three panels: their prompts (`01 §5`), their output schemas and validators,
 * and the injection handling that surrounds them (`01 §8`, `DECISIONS.md` S9).
 *
 * Plus the panel-facing corrections from `the-pit-build-brief.md` Part 1 that
 * feed them: the calibration sample (§1.1) and the preview cache key (§1.3).
 *
 * Nothing here calls a model or sequences a phase. A prompt builder returns a
 * `ModelRequest`; running it, retrying it and paying for it are Task 7's.
 */

export { ANCHOR_LEVELS } from './anchors.js';
export type { CalibrationProduct, CalibrationRanking, CalibrationSample } from './calibration.js';
export { selectCalibrationSample } from './calibration.js';
export type { ScreenResult } from './injection.js';
export { alarmOutput, INJECTION_SOURCE_DEMAND, INJECTION_SOURCE_UNIQUENESS, screenInput } from './injection.js';
export type { PreviewCacheKeyInput } from './preview-cache-key.js';
export { previewCacheKey } from './preview-cache-key.js';
export { DATA_CLOSE, DATA_OPEN, dataBlock, dataField, dataValue, UNTRUSTED_DATA_RULE } from './data-block.js';
export type { TypeHint, ValidationResult } from './generate/index.js';
export {
  B2B_WORDS,
  buildJuryPrompt,
  buildPersonaPrompt,
  CONSUMER_WORDS,
  inferTypeHint,
  sampleTaglines,
  validateJury,
  validatePersonas,
} from './generate/index.js';
export type { PanelOrdering } from './ordering.js';
export { orderedChunks, orderingSeed, panelOrder } from './ordering.js';
export type { AssignRequestInput, Assignment } from './prompts/assign.js';
export { ASSIGN_SCHEMA, ASSIGN_TOOL_NAME, buildAssignRequest, validateAssignResult } from './prompts/assign.js';
export type { ChoiceRequestInput, SimilarSet } from './prompts/choice.js';
export { buildChoiceRequest, setMembership, similarSets } from './prompts/choice.js';
export type { ScoreRequestInput } from './prompts/score.js';
export { buildScoreRequest } from './prompts/score.js';
export { buildUniquenessRequest } from './prompts/uniqueness.js';
export { categorySlug, digest, mulberry32, requireSlug, seedFrom, shuffleSeeded } from './seeded.js';
export type { ScoreExpectation } from './schemas.js';
export {
  CHOICE_SCHEMA,
  CHOICE_TOOL_NAME,
  SCORE_SCHEMA,
  SCORE_TOOL_NAME,
  SchemaValidationError,
  UNIQ_SCHEMA,
  UNIQ_TOOL_NAME,
  validateChoiceResult,
  validateScoreResult,
  validateUniquenessResult,
} from './schemas.js';
