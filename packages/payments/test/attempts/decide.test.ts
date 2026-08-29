import type { IncrementalOutcome } from '@the-pit/engine';
import { describe, expect, it } from 'vitest';

import { decideAttempt, failedPhases, FREE_RETRY_CAP } from '../../src/attempts/decide.js';
import {
  deliveredSoloCluster,
  deliveredWithFloor,
  internalFailure,
  providerTimeout,
  scoreAndCustomerFailed,
  sixScoredFloorFailed,
} from '../helpers/outcomes.js';

describe('delivery consumes the attempt (brief §2.3)', () => {
  it('consumes on an ordinary delivery', () => {
    const decision = decideAttempt({ outcome: deliveredWithFloor(), freeRetriesUsed: 0 });
    expect(decision.action).toBe('consume');
    expect(decision.consumesAttempt).toBe(true);
  });

  it('consumes on a genuine solo cluster, which is the common case and not a partial failure', () => {
    // DECISIONS.md S11: the Customer phase returns a TERMINAL `skipped: no_sets`
    // when no cluster has two members. 32 of 48 Developer Tools products and 26
    // of 44 Health & Fitness products are here. Treating this as a failure would
    // burn three free retries per solo submission and land the majority of
    // deliveries in the support queue.
    const decision = decideAttempt({ outcome: deliveredSoloCluster(), freeRetriesUsed: 0 });
    expect(decision).toEqual({ action: 'consume', consumesAttempt: true, customerPhase: 'skipped' });
  });

  it('records that the Floor convened when it did', () => {
    const decision = decideAttempt({ outcome: deliveredWithFloor(), freeRetriesUsed: 0 });
    expect(decision).toEqual({ action: 'consume', consumesAttempt: true, customerPhase: 'convened' });
  });
});

describe('failures are free retries (brief §2.3)', () => {
  it('does not consume on a provider timeout', () => {
    const decision = decideAttempt({ outcome: providerTimeout(), freeRetriesUsed: 0 });
    expect(decision.action).toBe('free_retry');
    expect(decision.consumesAttempt).toBe(false);
  });

  it('does not consume on a partial success — the Six scored but the Floor call failed', () => {
    // brief §2.3: the composite would be missing 35% of its weight. This is the
    // case that must NOT be confused with the solo cluster above; the two differ
    // only in which arm of PhaseResult the Customer phase returned.
    const decision = decideAttempt({ outcome: sixScoredFloorFailed(), freeRetriesUsed: 0 });
    expect(decision.consumesAttempt).toBe(false);
    expect(decision.action).toBe('free_retry');
  });

  it('retries only the phases that failed', () => {
    const decision = decideAttempt({ outcome: scoreAndCustomerFailed(), freeRetriesUsed: 0 });
    expect(decision.action === 'free_retry' ? decision.retryPhases : []).toEqual(['score', 'customer']);
  });

  it('leaves a succeeded phase out of the retry set, so the cache makes it free', () => {
    const decision = decideAttempt({ outcome: providerTimeout(), freeRetriesUsed: 0 });
    expect(decision.action === 'free_retry' ? decision.retryPhases : []).toEqual(['customer']);
  });

  it('counts the retries down from the cap', () => {
    const first = decideAttempt({ outcome: providerTimeout(), freeRetriesUsed: 0 });
    expect(first.action === 'free_retry' ? first.freeRetriesUsed : -1).toBe(1);
    expect(first.action === 'free_retry' ? first.freeRetriesRemaining : -1).toBe(2);

    const third = decideAttempt({ outcome: providerTimeout(), freeRetriesUsed: 2 });
    expect(third.action === 'free_retry' ? third.freeRetriesUsed : -1).toBe(3);
    expect(third.action === 'free_retry' ? third.freeRetriesRemaining : -1).toBe(0);
  });
});

describe('the retry cap (brief §2.3: cap free retries at 3 per attempt)', () => {
  it('is three', () => {
    expect(FREE_RETRY_CAP).toBe(3);
  });

  it('routes to support once three free retries have been spent, and still does not consume', () => {
    const decision = decideAttempt({ outcome: providerTimeout(), freeRetriesUsed: 3 });
    expect(decision.action).toBe('support_queue');
    expect(decision.consumesAttempt).toBe(false);
    expect(decision.action === 'support_queue' ? decision.reason : '').toBe('retry_cap_exhausted');
  });

  it('honours a lowered cap, so the boundary is enforced rather than coincidental', () => {
    const at = decideAttempt({ outcome: providerTimeout(), freeRetriesUsed: 1, freeRetryCap: 1 });
    expect(at.action).toBe('support_queue');
    const under = decideAttempt({ outcome: providerTimeout(), freeRetriesUsed: 0, freeRetryCap: 1 });
    expect(under.action).toBe('free_retry');
  });
});

describe('terminal failures never loop', () => {
  it('sends an engine bug straight to a human without spending a retry', () => {
    const decision = decideAttempt({ outcome: internalFailure(), freeRetriesUsed: 0 });
    expect(decision.action).toBe('support_queue');
    expect(decision.action === 'support_queue' ? decision.reason : '').toBe('terminal_failure');
    expect(decision.consumesAttempt).toBe(false);
  });
});

describe('a held submission (DECISIONS.md S9)', () => {
  const held: IncrementalOutcome = { status: 'held', matched: 'ignore previous' };

  it('goes to moderation with the attempt untouched', () => {
    const decision = decideAttempt({ outcome: held, freeRetriesUsed: 0 });
    expect(decision).toEqual({ action: 'moderation_queue', consumesAttempt: false, matched: 'ignore previous' });
  });
});

describe('consumesAttempt is true on exactly one arm', () => {
  const outcomes = [
    deliveredWithFloor(),
    deliveredSoloCluster(),
    providerTimeout(),
    sixScoredFloorFailed(),
    scoreAndCustomerFailed(),
    internalFailure(),
    { status: 'held', matched: 'x' } satisfies IncrementalOutcome,
  ];

  it('never disagrees with the discriminant', () => {
    for (const outcome of outcomes) {
      for (const freeRetriesUsed of [0, 3]) {
        const decision = decideAttempt({ outcome, freeRetriesUsed });
        expect(decision.consumesAttempt).toBe(decision.action === 'consume');
      }
    }
  });
});

describe('failedPhases', () => {
  it('reports pipeline order, not the order failures were collected', () => {
    expect(failedPhases(scoreAndCustomerFailed().results)).toEqual(['score', 'customer']);
  });

  it('reports nothing for a delivered run, including one whose Customer phase skipped', () => {
    expect(failedPhases(deliveredSoloCluster().results)).toEqual([]);
  });
});
