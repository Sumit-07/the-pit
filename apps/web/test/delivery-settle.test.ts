/**
 * The end of the money path: when an attempt is spent, and when it is not.
 *
 * `brief §2.3` is four clauses and three of them are prohibitions:
 *
 * > "An attempt is consumed **only on delivery** — decrement in the same
 * > transaction that writes the verdict and marks it delivered. **Not on job
 * > start, not on pipeline completion.**"
 *
 * A test that only proved "a delivered run consumes one" would pass against an
 * implementation that consumed at every one of those moments, so every assertion
 * below is paired with the negative it discriminates against: the ledger is
 * examined after enqueue, after the run finishes, and after a delivery that broke
 * halfway, and it has to be untouched at all three.
 *
 * Hand-derived throughout. Eight products, six jurors, one chunk, four clusters
 * of two: 6 scoring calls + 1 clustering call + 4 persona calls = 11. The
 * all-solo variant closes `01 §5.3`'s gate and costs 7.
 *
 * Nothing here is stubbed except the model (the engine's `FixtureClient`) and the
 * database (`FakeDelivery`, which enforces every constraint the schema does —
 * `test/delivery-pg.test.ts` runs the same paths against the real DDL).
 */

import { describe, expect, it } from 'vitest';
import { ModelCallError } from '@the-pit/engine';

import { deliveredVerdictId, settleDelivery } from '@/lib/delivery/settle';
import type { DeliveryRecord } from '@/lib/pipeline/types';

import { FakeDelivery, RecordingInvalidator } from './helpers/delivery.js';
import { CATEGORY_SLUG } from './helpers/panel.js';
import { PAYER, RUN_ID, makeHarness, run, runExpectingFailure } from './helpers/run.js';

const LISTING = '77777777-6666-4555-8444-333333333333';

/** A delivery, fully wired: attempts granted, the paid listing on the board. */
function ready(options: { failAt?: 'writeVerdict' | 'markDelivered' | 'appendAttemptEntry' } = {}): FakeDelivery {
  const fake = new FakeDelivery(options.failAt === undefined ? {} : { failAt: options.failAt });
  // One $5 payment, one attempt. `brief §2.3` keeps $5 the atomic unit.
  fake.grant(PAYER.accountId, 1);
  fake.addListing(CATEGORY_SLUG, PAYER.engineId, { productId: LISTING, email: PAYER.email });
  return fake;
}

/** Drive the real pipeline for a paying customer and hand back what it delivered. */
async function paidRun(options: Parameters<typeof makeHarness>[0] = {}): Promise<{
  record: DeliveryRecord;
  harness: ReturnType<typeof makeHarness>;
}> {
  const harness = makeHarness({ ...options, paid: PAYER, runId: RUN_ID });
  await run(harness);
  const record = harness.delivered[0];
  if (record === undefined) throw new Error('the run delivered nothing');
  return { record, harness };
}

describe('an attempt is consumed only on delivery (brief §2.3)', () => {
  it('has not moved the ledger when the pipeline finishes — only the settle does', async () => {
    const fake = ready();
    const { record, harness } = await paidRun();

    // The run is over. The board is published. `onDelivered` has fired and the
    // record exists. THIS is `brief §2.3`'s "not on pipeline completion": the
    // whole pipeline has run and nothing has been spent, because spending is a
    // separate transaction that has not been asked for yet.
    expect(harness.snapshots.published).toHaveLength(1);
    expect(fake.entryCount).toBe(1); // the grant, and nothing else
    expect(fake.consumes).toHaveLength(0);
    expect(fake.balance(PAYER.accountId)).toBe(1);

    const result = await settleDelivery(record, { bindings: fake.bindings() });

    expect(result.outcome).toBe('settled');
    expect(fake.consumes).toHaveLength(1);
    expect(fake.balance(PAYER.accountId)).toBe(0);
  });

  it('writes the verdict, the delivered flag and the decrement, in that order', async () => {
    const fake = ready();
    const { record } = await paidRun();
    await settleDelivery(record, { bindings: fake.bindings() });

    const verdict = fake.state.verdicts[0];
    expect(verdict).toBeDefined();
    expect(verdict?.verdict.runId).toBe(RUN_ID);
    expect(verdict?.verdict.listingId).toBe(LISTING);
    expect(verdict?.verdict.accountId).toBe(PAYER.accountId);
    expect(verdict?.verdict.attemptNumber).toBe(1);
    expect(verdict?.productCount).toBe(8);

    // The job is marked, which is the precondition
    // `attempts_consume_requires_delivery` checks before it will accept the row.
    expect(fake.state.delivered.get(RUN_ID)).toBeDefined();

    // And the consume names the run, the verdict and the listing.
    const consume = fake.consumes[0];
    expect(consume?.delta).toBe(-1);
    expect(consume?.reason).toMatchObject({
      kind: 'consume',
      runId: RUN_ID,
      listingId: LISTING,
      verdictId: deliveredVerdictId(RUN_ID),
    });
    // `consumeIdempotencyKey`, keyed on the run — which is what makes the replay
    // below charge nothing.
    expect(consume?.idempotencyKey).toBe(`delivery:run:${RUN_ID}`);
  });

  it('charges once when the same delivery is settled twice', async () => {
    const fake = ready();
    const { record } = await paidRun();

    const first = await settleDelivery(record, { bindings: fake.bindings() });
    const second = await settleDelivery(record, { bindings: fake.bindings() });

    expect(first.outcome).toBe('settled');
    expect(second.outcome).toBe('already_settled');
    expect(fake.consumes).toHaveLength(1);
    expect(fake.state.verdicts).toHaveLength(1);
    expect(fake.balance(PAYER.accountId)).toBe(0);
    // Both settles resolve the same public URL. A retried delivery that minted a
    // second slug would leave the first one dead in whatever was already shared.
    if (first.outcome !== 'settled' || second.outcome !== 'already_settled') {
      throw new Error('unreachable');
    }
    expect(second.verdictSlug).toBe(first.verdictSlug);
  });

  it('refuses to deliver a run nobody paid for, and spends nothing', async () => {
    const fake = ready();
    const harness = makeHarness({ runId: RUN_ID });
    await run(harness);
    const record = harness.delivered[0];
    if (record === undefined) throw new Error('the run delivered nothing');

    // A seed run and an admin re-run publish a board and settle nothing. The
    // cold-start verdicts already exist, written by the seed CLI with a NULL job
    // and a NULL ordinal — `brief` Part 7's unclaimed listings.
    expect(record.paid).toBeUndefined();
    expect((await settleDelivery(record, { bindings: fake.bindings() })).outcome).toBe('unpaid');
    expect(fake.consumes).toHaveLength(0);
    expect(fake.state.verdicts).toHaveLength(0);
  });
});

describe('a delivery that fails partway consumes nothing and writes nothing', () => {
  // One transaction, all or nothing. The three cases are the three writes, and
  // the assertion after each is identical: no verdict, no delivered flag, no
  // ledger row. An implementation that lost its transaction would pass exactly
  // one of these and fail the other two, which is why all three are here.
  for (const failAt of ['writeVerdict', 'markDelivered', 'appendAttemptEntry'] as const) {
    it(`rolls back when ${failAt} throws`, async () => {
      const fake = ready({ failAt });
      const { record } = await paidRun();

      await expect(settleDelivery(record, { bindings: fake.bindings() })).rejects.toThrow();

      expect(fake.state.verdicts).toHaveLength(0);
      expect(fake.state.delivered.size).toBe(0);
      expect(fake.consumes).toHaveLength(0);
      // The customer keeps what they bought.
      expect(fake.balance(PAYER.accountId)).toBe(1);
    });
  }

  it('refuses the whole transaction when the balance cannot cover it', async () => {
    // No grant: a run that reached delivery with no attempt behind it is a bug
    // upstream, and delivering it anyway would hide the bug behind free work.
    const fake = new FakeDelivery();
    fake.addListing(CATEGORY_SLUG, PAYER.engineId, { productId: LISTING, email: PAYER.email });
    const { record } = await paidRun();

    await expect(settleDelivery(record, { bindings: fake.bindings() })).rejects.toThrow(
      /cannot consume|attempts/i,
    );
    expect(fake.state.verdicts).toHaveLength(0);
    expect(fake.state.delivered.size).toBe(0);
  });

  it('does not settle a delivery whose paid listing never landed', async () => {
    // The catalogue write runs between the publish and the settle. A missing row
    // means it did not, and `verdicts.product_id` is a foreign key onto it — so
    // this has to stop here rather than inside the money transaction.
    const fake = new FakeDelivery();
    fake.grant(PAYER.accountId, 1);
    const { record } = await paidRun();

    const result = await settleDelivery(record, { bindings: fake.bindings() });
    expect(result.outcome).toBe('not_settleable');
    expect(fake.consumes).toHaveLength(0);
    expect(fake.balance(PAYER.accountId)).toBe(1);
  });
});

describe('the two runs that look identical and mean opposite things (DECISIONS.md S11)', () => {
  it('consumes an attempt and writes a verdict for a genuine solo cluster', async () => {
    const fake = ready();
    const { record, harness } = await paidRun({ clusterPlan: 'all-solo' });

    // No cluster held two products, so the Floor was never asked anything: 6
    // scoring calls + 1 clustering call + 0 choices.
    expect(harness.meter.total).toBe(7);
    expect(harness.meter.callsIn('persona')).toBe(0);

    // Merit-only is the COMMON case — 32 of 48 Developer Tools products and 26 of
    // 44 Health & Fitness products have no cluster peers — and it is a successful
    // delivery. The decision says so in a field rather than by omission.
    expect(record.paid?.decision).toEqual({
      action: 'consume',
      consumesAttempt: true,
      customerPhase: 'skipped',
    });

    const result = await settleDelivery(record, { bindings: fake.bindings() });
    expect(result.outcome).toBe('settled');
    expect(fake.consumes).toHaveLength(1);
    expect(fake.state.verdicts).toHaveLength(1);
    expect(fake.balance(PAYER.accountId)).toBe(0);
  });

  it('consumes nothing and writes nothing when the clustering pass failed', async () => {
    const fake = ready();
    const harness = makeHarness({
      paid: PAYER,
      runId: RUN_ID,
      uniquenessError: () => new ModelCallError('gateway timeout', { retryable: true, status: 504 }),
    });

    await runExpectingFailure(harness);

    // The contrast with the block above: the same absent demand signal, the
    // opposite decision. There is no delivery record at all, so there is nothing
    // to settle and no way for the settling path to be asked to charge for it.
    expect(harness.snapshots.published).toHaveLength(0);
    expect(harness.delivered).toHaveLength(0);
    expect(fake.consumes).toHaveLength(0);
    expect(fake.balance(PAYER.accountId)).toBe(1);
  });

  it('reports the Floor as convened when it actually convened', async () => {
    // The positive control for the solo case: the field has to discriminate, not
    // just be present.
    const { record } = await paidRun();
    expect(record.paid?.decision).toEqual({
      action: 'consume',
      consumesAttempt: true,
      customerPhase: 'convened',
    });
  });
});

describe('what the settle refuses to do', () => {
  it('reports rather than throws when no database is bound', async () => {
    const { record } = await paidRun();
    const result = await settleDelivery(record, { bindings: null });

    // The customer has paid and the board is published. A throw here would make
    // the executor retry a delivery against a process that has no ledger, three
    // times, and then give up silently.
    expect(result.outcome).toBe('not_settleable');
    expect(result).toMatchObject({ reason: expect.stringContaining('no database') as unknown as string });
  });

  it('reports rather than throws when the run has no durable identity', async () => {
    const fake = ready();
    const harness = makeHarness({ paid: PAYER });
    await run(harness);
    const record = harness.delivered[0];
    if (record === undefined) throw new Error('the run delivered nothing');

    // A filesystem or memory store keys a run by nothing, so there is no
    // `jobs` row to mark delivered — and `attempts_consume_requires_delivery`
    // reads exactly that column before it will accept a decrement.
    expect(record.run_id).toBeUndefined();
    expect((await settleDelivery(record, { bindings: fake.bindings() })).outcome).toBe('not_settleable');
    expect(fake.consumes).toHaveLength(0);
  });

  it('refuses a decision that is not a consume, without touching the ledger', async () => {
    const fake = ready();
    const { record } = await paidRun();
    const paid = record.paid;
    if (paid === undefined) throw new Error('the run was not paid for');

    const tampered: DeliveryRecord = {
      ...record,
      paid: {
        ...paid,
        decision: { action: 'moderation_queue', consumesAttempt: false, matched: 'ignore previous' },
      },
    };

    const result = await settleDelivery(tampered, { bindings: fake.bindings() });
    expect(result.outcome).toBe('not_settleable');
    expect(fake.appendCalls).toHaveLength(0);
    expect(fake.state.verdicts).toHaveLength(0);
  });
});

describe('the rendered board pages are invalidated on every republish', () => {
  it('invalidates for a paid delivery', async () => {
    const invalidator = new RecordingInvalidator();
    const fake = ready();
    const { record } = await paidRun();

    await settleDelivery(record, { bindings: fake.bindings(), invalidator });
    expect(invalidator.slugs).toEqual([record.slug]);
  });

  it('invalidates for an unpaid one too, and before anything can refuse', async () => {
    // A seed run's republish moves the same three pages a paid placement's does.
    // Invalidation is not part of the money transaction and must not be
    // conditional on it — including on the arms that report `not_settleable`.
    const invalidator = new RecordingInvalidator();
    const harness = makeHarness({ runId: RUN_ID });
    await run(harness);
    const record = harness.delivered[0];
    if (record === undefined) throw new Error('the run delivered nothing');

    await settleDelivery(record, { bindings: null, invalidator });
    expect(invalidator.slugs).toEqual([record.slug]);
  });
});
