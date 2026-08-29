/**
 * Phase "Customer" — the Floor. `01 §5.3`, `01 §2`'s Round 2.
 *
 * One call per persona, all fired together, each persona choosing across every
 * similar-app set at once. Similar-app sets are uniqueness clusters with **two or
 * more members** (`01 §5.3`): a cluster of one offers no choice, so it is not
 * shown and earns no demand signal.
 *
 * ## The skip is a success
 *
 * `01 §5.3` runs this panel only if `personas.length > 0 && sets.length > 0`.
 * When that gate closes, the phase returns `status: 'skipped'` with a terminal
 * `SkipReason` — a DIFFERENT arm of `PhaseResult` from `failed`, on purpose.
 * `DECISIONS.md` S11: an empty Floor is a delivery, not a partial failure. Both
 * states leave every product at `demand_status: 'solo_cluster'` and both leave
 * `results.demand` null, so no consumer can tell them apart from the artifacts;
 * the distinction exists only here, in the phase that knows why it did not run.
 * Collapsing them would burn all three of a solo-cluster customer's free retries
 * on a run that was correct the first time.
 *
 * ## Partial answers
 *
 * Every persona must answer or the phase fails. `01 §6.2` divides `capture` by
 * `P`, the number of personas that returned choices, so a run with five of six
 * personas does not merely lose a vote — it rescales demand for every product,
 * and demand is 35% of `core`. `brief §2.3` calls that partial success and says
 * to retry rather than deliver.
 */

import type { ModelClient } from '../../model/types.js';
import { INJECTION_SOURCE_DEMAND, alarmOutput } from '../../panels/injection.js';
import type { PanelOrdering } from '../../panels/ordering.js';
import { buildChoiceRequest, setMembership, similarSets } from '../../panels/prompts/choice.js';
import { validateChoiceResult } from '../../panels/schemas.js';
import type { DemandLogEntry, FlaggedInjection, Persona, Product, UniquenessResult } from '../../types.js';
import { dispatch } from '../dispatch.js';
import { PhaseLedger, zeroCost } from '../ledger.js';
import type { CustomerPhaseValue, PhaseResult } from '../types.js';

export interface CustomerPhaseInput {
  client: ModelClient;
  products: readonly Product[];
  personas: readonly Persona[];
  /** The clusters Round 1 produced. `01 §2`: this phase depends on them. */
  uniqueness: UniquenessResult;
  ordering: PanelOrdering;
}

/** Put every similar-app set to every persona, or say why the Floor did not convene. */
export async function runCustomerPhase(input: CustomerPhaseInput): Promise<PhaseResult<CustomerPhaseValue>> {
  // `01 §5.3`'s gate, in its own order: personas first, because "there is nobody
  // to ask" and "there is nothing to ask about" are different facts and a
  // consumer reading `skipped` deserves the one that is true.
  if (input.personas.length === 0) {
    return skipped('no_personas');
  }

  const sets = similarSets(input.uniqueness, input.products);
  if (sets.length === 0) {
    return skipped('no_sets');
  }

  const ledger = new PhaseLedger();
  const membership = setMembership(sets);

  const settled = await Promise.all(
    input.personas.map((persona) =>
      dispatch(
        input.client,
        buildChoiceRequest({ persona, sets, ordering: input.ordering }),
        `persona ${JSON.stringify(persona.name)}`,
        ledger,
        (output) => validateChoiceResult(output, membership),
      ).then((result) => ({ persona, result })),
    ),
  );

  const cost = ledger.total();
  const demandLog: DemandLogEntry[] = [];
  const causes: string[] = [];
  let anyTerminal = false;
  let terminalCode: 'truncated' | 'internal' | undefined;

  for (const { persona, result } of settled) {
    if (result.ok) {
      demandLog.push({ persona: persona.name, choices: result.value });
      continue;
    }
    causes.push(result.message);
    if (!result.retryable) {
      anyTerminal = true;
      if (result.code === 'truncated' || result.code === 'internal') terminalCode = result.code;
    }
  }

  if (causes.length > 0) {
    return {
      phase: 'customer',
      status: 'failed',
      cost,
      warnings: [],
      failure: {
        code: anyTerminal ? (terminalCode ?? 'model_call') : 'model_call',
        retryable: !anyTerminal,
        message:
          `customer panel: ${causes.length} of ${input.personas.length} persona(s) did not answer. ` +
          '01 §6.2 divides capture by the number of personas that returned choices, so a short panel ' +
          'rescales demand for every product rather than merely losing one vote (brief §2.3).',
        causes,
      },
    };
  }

  return {
    phase: 'customer',
    status: 'ok',
    cost,
    warnings: [],
    value: { demandLog, flaggedInjections: flagDemand(demandLog), sets: sets.length },
  };
}

/** A terminal, SUCCESSFUL non-run. `DECISIONS.md` S11. */
function skipped(reason: 'no_sets' | 'no_personas'): PhaseResult<CustomerPhaseValue> {
  return { phase: 'customer', status: 'skipped', cost: zeroCost(), warnings: [], skipped: reason };
}

/** `01 §8`'s output alarm over each choice reason. Log only (`DECISIONS.md` S9). */
function flagDemand(demandLog: readonly DemandLogEntry[]): FlaggedInjection[] {
  const flagged: FlaggedInjection[] = [];
  for (const entry of demandLog) {
    for (const choice of entry.choices) {
      const hit = alarmOutput(choice.reason, INJECTION_SOURCE_DEMAND, choice.first_pick);
      if (hit !== null) flagged.push(hit);
    }
  }
  return flagged;
}
