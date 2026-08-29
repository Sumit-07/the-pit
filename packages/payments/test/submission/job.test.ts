import { describe, expect, it } from 'vitest';

import type { SubmissionDraft } from '../../src/submission/guards.js';
import { createSubmissionJob, jobIdempotencyKey } from '../../src/submission/job.js';
import { clearanceFor } from '../helpers/clearance.js';
import { MemoryJobStore } from '../helpers/stores.js';

const NOW = new Date('2026-08-29T21:30:00.000Z');
const NEXT_CYCLE = new Date('2026-08-30T21:30:00.000Z');

function draft(overrides: Partial<SubmissionDraft> = {}): SubmissionDraft {
  return {
    url: 'https://www.runlet.dev/',
    name: 'Runlet',
    description: 'A fast Rust web server for edge deploys',
    categorySlug: 'developer-tools',
    ...overrides,
  };
}

describe('a double-clicked submit creates one job (brief §2.2)', () => {
  it('returns the first job the second time, and enqueues nothing new', async () => {
    const store = new MemoryJobStore();
    const clearance = clearanceFor(draft(), NOW);

    const first = await createSubmissionJob(store, { clearance, accountId: 'acct_1', jobId: 'job_1', now: NOW });
    // The second click generates a fresh uuid — that is exactly why a
    // client-supplied nonce would guard nothing.
    const second = await createSubmissionJob(store, { clearance, accountId: 'acct_1', jobId: 'job_2', now: NOW });

    expect(first.outcome).toBe('created');
    expect(second.outcome).toBe('duplicate');
    expect(second.job.jobId).toBe('job_1');
    expect(store.jobs.size).toBe(1);
    // Both clicks reached the store; only one row exists. A read-then-write
    // implementation would pass the first assertion and fail this one under
    // concurrency.
    expect(store.createCalls).toHaveLength(2);
  });

  it('keys the job on the account, product, text and cycle', () => {
    const base = {
      accountId: 'acct_1',
      normalizedUrl: 'runlet.dev',
      descriptionHash: 'hash_1',
      cycleId: '2026-08-29',
    };
    expect(jobIdempotencyKey(base)).toBe(jobIdempotencyKey({ ...base }));
    expect(jobIdempotencyKey(base)).not.toBe(jobIdempotencyKey({ ...base, accountId: 'acct_2' }));
    expect(jobIdempotencyKey(base)).not.toBe(jobIdempotencyKey({ ...base, normalizedUrl: 'beacon.sh' }));
    expect(jobIdempotencyKey(base)).not.toBe(jobIdempotencyKey({ ...base, descriptionHash: 'hash_2' }));
    expect(jobIdempotencyKey(base)).not.toBe(jobIdempotencyKey({ ...base, cycleId: '2026-08-30' }));
  });

  it('is a fixed-width hash, so a URL containing the separator cannot be crafted to collide', () => {
    const key = jobIdempotencyKey({
      accountId: 'acct_1',
      normalizedUrl: 'runlet.dev',
      descriptionHash: 'hash_1',
      cycleId: '2026-08-29',
    });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('one payment can buy several different products', () => {
  it('creates a separate job per product for the same account', async () => {
    const store = new MemoryJobStore();
    const urls = ['https://runlet.dev', 'https://beacon.sh', 'https://plotpad.io'];
    for (const url of urls) {
      await createSubmissionJob(store, {
        clearance: clearanceFor(draft({ url }), NOW),
        accountId: 'acct_1',
        jobId: `job_${url}`,
        now: NOW,
      });
    }
    expect(store.jobs.size).toBe(3);
  });
});

describe('a legitimate re-pitch next cycle is a new job', () => {
  it('does not resolve to the previous cycle’s job', async () => {
    const store = new MemoryJobStore();
    await createSubmissionJob(store, {
      clearance: clearanceFor(draft(), NOW),
      accountId: 'acct_1',
      jobId: 'job_1',
      now: NOW,
    });
    const later = await createSubmissionJob(store, {
      clearance: clearanceFor(draft(), NEXT_CYCLE),
      accountId: 'acct_1',
      jobId: 'job_2',
      now: NEXT_CYCLE,
    });
    expect(later.outcome).toBe('created');
    expect(store.jobs.size).toBe(2);
  });
});

describe('the job carries what the run needs', () => {
  it('starts with no free retries spent and the right pitch number', async () => {
    const store = new MemoryJobStore();
    const result = await createSubmissionJob(store, {
      clearance: clearanceFor(draft(), NOW),
      accountId: 'acct_1',
      jobId: 'job_1',
      now: NOW,
    });
    expect(result.job.freeRetriesUsed).toBe(0);
    expect(result.job.attemptNumber).toBe(1);
    expect(result.job.normalizedUrl).toBe('runlet.dev');
    expect(result.job.cycleId).toBe('2026-08-29');
  });
});
