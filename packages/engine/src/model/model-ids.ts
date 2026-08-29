/**
 * Tier alias -> Messages API model id.
 *
 * `01 §7.2` configures the panels by tier (`cfg.model` = `haiku`,
 * `cfg.clusterModel` / `cfg.personaModel` = `sonnet`) rather than by API id, and
 * the frozen constants keep those aliases. This map is the single place the
 * aliases become real ids, so swapping the juror model is a one-line change here
 * and nowhere else.
 *
 * The ids themselves live in `src/config/constants.ts` (Global Constraint 4) and
 * are audited by `test/constants.test.ts`. They are complete as written: never
 * append a date suffix.
 */

import type Anthropic from '@anthropic-ai/sdk';

import { MODEL_CLUSTER, MODEL_ID_HAIKU, MODEL_ID_SONNET, MODEL_JUROR } from '../config/constants.js';
import { ModelCallError, type ModelTier } from './types.js';

/**
 * Every tier the engine can address, keyed by `ModelTier`.
 *
 * Two keys, not three: `MODEL_CLUSTER` and `MODEL_PERSONA` are both `"sonnet"`
 * in `01 §7.2`'s defaults, so they are the same tier and the same entry. Should
 * they ever diverge, `ModelTier` gains a third member and this literal stops
 * satisfying `Record<ModelTier, ...>` — the compiler asks for the new id rather
 * than a call site silently resolving to `undefined`.
 */
export const MODEL_IDS: Readonly<Record<ModelTier, Anthropic.Model>> = Object.freeze({
  [MODEL_JUROR]: MODEL_ID_HAIKU,
  [MODEL_CLUSTER]: MODEL_ID_SONNET,
});

/**
 * Resolve a tier to the id sent on the wire.
 *
 * Throws rather than defaulting: an unknown tier reaching here means a config
 * value the type system did not catch (a JSON file, a CLI flag), and guessing a
 * model would run a whole paid category on the wrong one.
 */
export function resolveModelId(tier: ModelTier): Anthropic.Model {
  // Widened to `Partial` on purpose: `Record<ModelTier, ...>` promises the key is
  // always present, which is true of every caller the compiler can see and false
  // of a tier that arrived from a config file at runtime. The guard is the point.
  const id = (MODEL_IDS as Partial<Record<ModelTier, Anthropic.Model>>)[tier];
  if (id === undefined) {
    throw new ModelCallError(`resolveModelId: unknown model tier ${JSON.stringify(tier)}`, { retryable: false });
  }
  return id;
}

/**
 * Whether a model supports `output_config.effort`.
 *
 * `01 §5.1` asks for effort `low` on the jurors, but jurors run on
 * `claude-haiku-4-5`, which does not accept `output_config.effort` at all — the
 * request is rejected. `01`'s effort settings were written for local Claude Code
 * subagents dispatched through the Workflow tool, a different surface from the
 * Messages API. See the note on `buildMessageParams`.
 */
export function supportsEffort(modelId: Anthropic.Model): boolean {
  return modelId !== MODEL_ID_HAIKU;
}
