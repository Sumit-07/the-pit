/**
 * "Your verdict is in": once, after the commit, and never at the cost of a
 * delivery.
 *
 * The template is tested as a document in `packages/auth/test/verdict-mail.test.ts`.
 * What is testable only here is the WIRING, and the four things that go wrong with
 * a send bolted onto a money path:
 *
 * 1. it does not fire when the transaction did not commit;
 * 2. it fires exactly once across a retry, which Inngest will perform;
 * 3. a provider that throws does not take a delivered verdict down with it;
 * 4. and nobody who did not pay is ever mailed.
 *
 * Every scenario drives the real pipeline through `test/helpers/run.ts`, so the
 * payload the email reads is the document a real delivery freezes rather than a
 * hand-written shape — which is what makes the drift assertion below mean
 * something: the email has to say what `/v/<slug>` says.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { FixtureMailTransport, ThrowingMailTransport } from '@the-pit/auth';

import { settleDelivery } from '@/lib/delivery/settle';
import type { VerdictMailDeps } from '@/lib/delivery/verdict-mail';
import { parseVerdict } from '@/lib/verdict/model';
import { cutsLine, stampedRank } from '@/lib/verdict/page';
import type { DeliveryRecord } from '@/lib/pipeline/types';

import { FakeDelivery } from './helpers/delivery.js';
import { CATEGORY_SLUG } from './helpers/panel.js';
import { PAYER, RUN_ID, makeHarness, run } from './helpers/run.js';

const LISTING = '77777777-6666-4555-8444-333333333333';
const ORIGIN = 'https://thepit.show';
const SLUG = 'k7m2q9x4hd82';

/** A delivery, fully wired: attempts granted, the paid listing on the board. */
function ready(options: { seeded?: boolean; failAt?: 'appendAttemptEntry' } = {}): FakeDelivery {
  const fake = new FakeDelivery(options.failAt === undefined ? {} : { failAt: options.failAt });
  fake.grant(PAYER.accountId, 1);
  fake.addListing(CATEGORY_SLUG, PAYER.engineId, { productId: LISTING, email: PAYER.email });
  if (options.seeded === true) {
    // `products_source_submitter` leaves the address NULL on anything that is not
    // `paid`, and `brief` Part 7's cold-start listings have no account behind them.
    fake.listings.set(`${CATEGORY_SLUG}:${PAYER.engineId}`, {
      productId: LISTING,
      source: 'seed',
      submittedByEmail: null,
    });
  }
  return fake;
}

/** A mail seam over a fixture transport, with the account's slug already minted. */
function mailer(options: { slug?: string | null; transport?: VerdictMailDeps['transport'] } = {}): {
  deps: VerdictMailDeps;
  sent: FixtureMailTransport;
  slugCalls: string[];
} {
  const sent = new FixtureMailTransport();
  const slugCalls: string[] = [];
  return {
    sent,
    slugCalls,
    deps: {
      transport: options.transport ?? sent,
      from: 'The Pit <no-reply@thepit.show>',
      origin: ORIGIN,
      capabilitySlugFor: (accountId: string) => {
        slugCalls.push(accountId);
        return Promise.resolve(options.slug === undefined ? SLUG : options.slug);
      },
    },
  };
}

/** Drive the real pipeline for a paying customer and hand back what it delivered. */
async function paidRun(): Promise<DeliveryRecord> {
  const harness = makeHarness({ paid: PAYER, runId: RUN_ID });
  await run(harness);
  const record = harness.delivered[0];
  if (record === undefined) throw new Error('the run delivered nothing');
  return record;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a settled delivery tells the customer', () => {
  it('sends one message, to the address on the listing', async () => {
    const fake = ready();
    const mail = mailer();
    const record = await paidRun();

    const result = await settleDelivery(record, { bindings: fake.bindings(), mail: mail.deps });

    expect(result.outcome).toBe('settled');
    expect(result).toMatchObject({ mailed: true });
    expect(mail.sent.sent).toHaveLength(1);
    expect(mail.sent.last?.to).toBe('payer@example.com');
    expect(mail.sent.last?.from).toBe('The Pit <no-reply@thepit.show>');
  });

  it('says exactly what the verdict page says', async () => {
    // The email restates `cutsLine` and `stampedRank` because `@the-pit/auth`
    // cannot import `apps/web` (`PHASE-0.md §3`). This is the assertion that
    // stops the restatement drifting from the page it restates.
    const fake = ready();
    const mail = mailer();
    const record = await paidRun();

    const result = await settleDelivery(record, { bindings: fake.bindings(), mail: mail.deps });
    if (result.outcome !== 'settled') throw new Error('unreachable');

    const paid = record.paid;
    if (paid === undefined) throw new Error('the run was not paid for');
    const verdict = parseVerdict({
      publicSlug: result.verdictSlug,
      payload: paid.payload,
      productCount: record.product_count,
      attemptNumber: paid.attemptNumber,
      deliveredAt: new Date(record.delivered_at),
    });

    const message = mail.sent.last;
    expect(message?.subject).toBe(`Your verdict is in: ${cutsLine(verdict).replace(/\.$/, '')}`);
    expect(message?.text).toContain(cutsLine(verdict));
    expect(message?.text).toContain(stampedRank(verdict));
    // A rank, and never a rank alone (`brief` Part 5).
    expect(message?.text).toContain(`${verdict.rank} of ${verdict.productCount} products`);
  });

  it('links the public verdict URL and the account URL the capability path already minted', async () => {
    const fake = ready();
    const mail = mailer();
    const record = await paidRun();

    const result = await settleDelivery(record, { bindings: fake.bindings(), mail: mail.deps });
    if (result.outcome !== 'settled') throw new Error('unreachable');

    expect(mail.sent.last?.text).toContain(`${ORIGIN}/v/${result.verdictSlug}`);
    expect(mail.sent.last?.text).toContain(`${ORIGIN}/a/${SLUG}`);
    // Read from the account, never minted here.
    expect(mail.slugCalls).toEqual([PAYER.accountId]);
  });

  it('still delivers to an account with no slug, and says nothing about one', async () => {
    const fake = ready();
    const mail = mailer({ slug: null });
    const record = await paidRun();

    const result = await settleDelivery(record, { bindings: fake.bindings(), mail: mail.deps });

    expect(result).toMatchObject({ outcome: 'settled', mailed: true });
    expect(mail.sent.last?.text).not.toContain('attempts and history');
  });
});

describe('the send is after the transaction, and cannot reach into it', () => {
  it('sends nothing when the transaction rolled back, and charges nothing', async () => {
    const fake = ready({ failAt: 'appendAttemptEntry' });
    const mail = mailer();
    const record = await paidRun();

    await expect(
      settleDelivery(record, { bindings: fake.bindings(), mail: mail.deps }),
    ).rejects.toThrow();

    expect(mail.sent.sent).toHaveLength(0);
    expect(fake.state.verdicts).toHaveLength(0);
    expect(fake.balance(PAYER.accountId)).toBe(1);
  });

  it('delivers anyway when the mail provider throws', async () => {
    // A DNS failure, an aborted socket, an SDK that rejects. The verdict is
    // written, public and permanent; the customer has simply not been told.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fake = ready();
    const throwing = new ThrowingMailTransport();
    const mail = mailer({ transport: throwing });
    const record = await paidRun();

    const result = await settleDelivery(record, { bindings: fake.bindings(), mail: mail.deps });

    expect(result).toMatchObject({ outcome: 'settled', mailed: false });
    expect(throwing.attempted).toHaveLength(1);
    expect(fake.consumes).toHaveLength(1);
    expect(fake.state.verdicts).toHaveLength(1);
    expect(errors).toHaveBeenCalled();
  });

  it('delivers anyway when the provider answers with a failure', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fake = ready();
    const mail = mailer();
    mail.sent.failEverySend();
    const record = await paidRun();

    const result = await settleDelivery(record, { bindings: fake.bindings(), mail: mail.deps });

    expect(result).toMatchObject({ outcome: 'settled', mailed: false });
    expect(mail.sent.failed).toHaveLength(1);
    expect(fake.consumes).toHaveLength(1);
    expect(errors).toHaveBeenCalled();
  });
});

describe('a retried settle does not send twice', () => {
  it('mails on the pass that settled and on no other', async () => {
    // Inngest replays a step. The ledger's own idempotency key
    // (`delivery:run:<runId>`) is what makes the second pass `already_settled`,
    // and `already_settled` is what makes it silent — no column, no second read.
    const fake = ready();
    const mail = mailer();
    const record = await paidRun();

    const first = await settleDelivery(record, { bindings: fake.bindings(), mail: mail.deps });
    const second = await settleDelivery(record, { bindings: fake.bindings(), mail: mail.deps });
    const third = await settleDelivery(record, { bindings: fake.bindings(), mail: mail.deps });

    expect(first).toMatchObject({ outcome: 'settled', mailed: true });
    expect(second).toMatchObject({ outcome: 'already_settled', mailed: false });
    expect(third).toMatchObject({ outcome: 'already_settled', mailed: false });
    expect(mail.sent.sent).toHaveLength(1);
    expect(fake.consumes).toHaveLength(1);
  });

  it('keys the message on the account and the URL, so a provider dedupes it too', async () => {
    const fake = ready();
    const mail = mailer();
    const record = await paidRun();

    await settleDelivery(record, { bindings: fake.bindings(), mail: mail.deps });

    const key = mail.sent.last?.idempotencyKey ?? '';
    expect(key).toMatch(/^verdict:[0-9a-f]{32}$/);
    expect(key).not.toContain(PAYER.accountId);
  });
});

describe('nobody who did not pay is mailed', () => {
  it('sends nothing for a seed run, which has no payer at all', async () => {
    const fake = ready();
    const mail = mailer();
    const harness = makeHarness({ runId: RUN_ID });
    await run(harness);
    const record = harness.delivered[0];
    if (record === undefined) throw new Error('the run delivered nothing');

    expect(record.paid).toBeUndefined();
    const result = await settleDelivery(record, { bindings: fake.bindings(), mail: mail.deps });

    expect(result.outcome).toBe('unpaid');
    expect(mail.sent.sent).toHaveLength(0);
  });

  it('sends nothing for a listing with no submitter address', async () => {
    // `brief` Part 7's cold-start listings carry a NULL `submitted_by_email`.
    // A settle that guessed an address here would mail a stranger their own
    // seeded product's verdict.
    const fake = ready({ seeded: true });
    const mail = mailer();
    const record = await paidRun();

    const result = await settleDelivery(record, { bindings: fake.bindings(), mail: mail.deps });

    expect(result).toMatchObject({ outcome: 'settled', mailed: false });
    expect(mail.sent.sent).toHaveLength(0);
  });

  it('sends nothing when the settle is not settleable', async () => {
    const fake = ready();
    const mail = mailer();
    const record = await paidRun();

    const result = await settleDelivery(
      { ...record, run_id: undefined },
      { bindings: fake.bindings(), mail: mail.deps },
    );

    expect(result.outcome).toBe('not_settleable');
    expect(mail.sent.sent).toHaveLength(0);
  });

  it('sends nothing when no mail seam is bound at all', async () => {
    const fake = ready();
    const record = await paidRun();

    const result = await settleDelivery(record, { bindings: fake.bindings() });

    // The delivery is complete without it. `brief §2.3`'s clause is about the
    // ledger, and the verdict is public the moment the transaction commits.
    expect(result).toMatchObject({ outcome: 'settled', mailed: false });
    expect(fake.state.verdicts).toHaveLength(1);
  });
});
