/**
 * Phase "Uniqueness" — clustering and scarcity. `01 §5.2`, `01 §2`'s Round 1.
 *
 * One call over the whole category, in parallel with Score (both read only the
 * products). Its clusters are what the Customer phase's similar-app sets are made
 * of, so `01 §2` puts Customer strictly after it.
 *
 * ## The failure this phase must not disguise
 *
 * If this call does not come back, `rankCategory` still produces a perfectly
 * plausible board: with no `UniquenessResult` every product falls into the
 * `'unclustered'` stand-in cluster (`src/rank/ranking.ts`), takes neutral
 * scarcity, gets no demand entry, and is blended at `demand_status:
 * 'solo_cluster'` on merit alone. That is byte-for-byte what a category of
 * genuinely unique products produces — which `DECISIONS.md` S11 says is a
 * successful delivery.
 *
 * So the two states are indistinguishable in the OUTPUT and must be distinguished
 * at the SOURCE. This phase knows whether its own call returned; that knowledge
 * becomes the `PhaseFailed` arm here and is never re-derived downstream by
 * looking for `cluster.id === 'unclustered'` or reading `demand_status`. Deciding
 * whether to charge a customer by string-matching a fallback id would be a coin
 * flip dressed up as a check.
 */

import type { ModelClient } from '../../model/types.js';
import { INJECTION_SOURCE_UNIQUENESS, alarmOutput } from '../../panels/injection.js';
import type { PanelOrdering } from '../../panels/ordering.js';
import { buildUniquenessRequest } from '../../panels/prompts/uniqueness.js';
import { validateUniquenessResult } from '../../panels/schemas.js';
import type { FlaggedInjection, Product, UniquenessResult } from '../../types.js';
import { dispatch } from '../dispatch.js';
import { PhaseLedger } from '../ledger.js';
import type { PhaseResult, UniquenessPhaseValue } from '../types.js';

export interface UniquenessPhaseInput {
  client: ModelClient;
  products: readonly Product[];
  ordering: PanelOrdering;
}

/** Run the single clustering / scarcity pass. */
export async function runUniquenessPhase(input: UniquenessPhaseInput): Promise<PhaseResult<UniquenessPhaseValue>> {
  const ledger = new PhaseLedger();
  const productIds = input.products.map((product) => product.id);

  const result = await dispatch(
    input.client,
    buildUniquenessRequest(input.products, input.ordering),
    'clustering pass',
    ledger,
    (output) => validateUniquenessResult(output, productIds),
  );

  const cost = ledger.total();

  if (!result.ok) {
    return {
      phase: 'uniqueness',
      status: 'failed',
      cost,
      warnings: [],
      failure: {
        code: result.code,
        retryable: result.retryable,
        message:
          'clustering pass did not return a usable answer. Without it there are no clusters, so the ' +
          'Floor cannot convene and every product would rank on merit alone — indistinguishable in the ' +
          'output from a category of genuinely unique products (DECISIONS.md S11), which is why this is ' +
          'reported here rather than inferred downstream.',
        causes: [result.message],
      },
    };
  }

  return {
    phase: 'uniqueness',
    status: 'ok',
    cost,
    warnings: [],
    value: { uniqueness: result.value, flaggedInjections: flagUniqueness(result.value) },
  };
}

/** `01 §8`'s output alarm over each product's scarcity reason. Log only (`DECISIONS.md` S9). */
function flagUniqueness(uniqueness: UniquenessResult): FlaggedInjection[] {
  const flagged: FlaggedInjection[] = [];
  for (const row of uniqueness.products) {
    const hit = alarmOutput(row.reason, INJECTION_SOURCE_UNIQUENESS, row.id);
    if (hit !== null) flagged.push(hit);
  }
  for (const cluster of uniqueness.clusters) {
    const hit = alarmOutput(cluster.label, INJECTION_SOURCE_UNIQUENESS);
    if (hit !== null) flagged.push(hit);
  }
  return flagged;
}
