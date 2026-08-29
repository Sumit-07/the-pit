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

export type { CalibrationProduct, CalibrationRanking, CalibrationSample } from './calibration.js';
export { selectCalibrationSample } from './calibration.js';
export type { ScreenResult } from './injection.js';
export { alarmOutput, INJECTION_SOURCE_DEMAND, INJECTION_SOURCE_UNIQUENESS, screenInput } from './injection.js';
export type { PreviewCacheKeyInput } from './preview-cache-key.js';
export { previewCacheKey } from './preview-cache-key.js';
export type { ChoiceRequestInput, SimilarSet } from './prompts/choice.js';
export { buildChoiceRequest, setMembership, similarSets } from './prompts/choice.js';
export {
  DATA_CLOSE,
  DATA_OPEN,
  dataBlock,
  dataField,
  dataValue,
  LABEL_LIMIT,
  UNTRUSTED_DATA_RULE,
} from './prompts/data-block.js';
export type { ScoreRequestInput } from './prompts/score.js';
export { buildScoreRequest } from './prompts/score.js';
export { buildUniquenessRequest } from './prompts/uniqueness.js';
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
