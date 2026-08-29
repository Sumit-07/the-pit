/**
 * The panel-facing corrections from `the-pit-build-brief.md` Part 1.
 *
 * Prompt bodies and response schemas for The Six, the uniqueness pass and The
 * Floor land here too (Task 5). This file currently carries only what feeds
 * them: the calibration sample (§1.1) and the preview cache key (§1.3).
 */

export type { CalibrationProduct, CalibrationRanking, CalibrationSample } from './calibration.js';
export { selectCalibrationSample } from './calibration.js';
export type { PreviewCacheKeyInput } from './preview-cache-key.js';
export { previewCacheKey } from './preview-cache-key.js';
