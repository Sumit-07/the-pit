import { describe, expect, it } from 'vitest';

import type { RepitchInput, RepitchPolicy } from '../../src/listing/repitch.js';
import { ordinalPitch, planRepitch, REPITCH_POLICY_OPTIONS } from '../../src/listing/repitch.js';
import type { ListingSnapshot, SubmissionDraft } from '../../src/submission/guards.js';
import { clearanceFor } from '../helpers/clearance.js';

const NOW = new Date('2026-08-29T21:30:00.000Z');
const LAST_CYCLE = new Date('2026-08-28T10:00:00.000Z');

const DRAFT: SubmissionDraft = {
  url: 'https://www.runlet.dev/',
  name: 'Runlet',
  description: 'A slow Python API gateway for cloud teams',
  categorySlug: 'developer-tools',
};

function previous(overrides: Partial<ListingSnapshot> = {}): ListingSnapshot {
  return {
    listingId: 'lst_1',
    accountId: 'acct_1',
    normalizedUrl: 'runlet.dev',
    categorySlug: 'developer-tools',
    description: 'A fast Rust web server for edge deploys',
    descriptionHash: 'hash_1',
    attemptNumber: 1,
    lastPitchedAt: LAST_CYCLE,
    clusterId: 'cl_1',
    currentVerdictId: 'vrd_1',
    ...overrides,
  };
}

function input(policy: RepitchPolicy, overrides: Partial<RepitchInput> = {}): RepitchInput {
  const prior = overrides.previous ?? previous();
  return {
    previous: prior,
    clearance: clearanceFor(DRAFT, NOW, prior),
    newVerdictId: 'vrd_2',
    newClusterId: 'cl_2',
    policy,
    now: NOW,
    ...overrides,
  };
}

const ARCHIVE_KEEP: RepitchPolicy = {
  previousVerdict: 'archive_at_permanent_url',
  cluster: 'keep_joined_cluster',
};
const REDIRECT_REASSIGN: RepitchPolicy = {
  previousVerdict: 'redirect_to_current',
  cluster: 'reassign_on_new_description',
};

describe('a re-pitch replaces the previous listing (brief §2.4)', () => {
  it('updates the existing row in place rather than adding a second one', () => {
    // `02 §8`: dedup by URL forbids placing the same product twice. There is one
    // listing action and it names an existing listing id.
    const plan = planRepitch(input(ARCHIVE_KEEP));
    expect(plan.listing.action).toBe('replace_in_place');
    expect(plan.listing.listingId).toBe('lst_1');
  });

  it('always points the listing at the new verdict', () => {
    for (const option of REPITCH_POLICY_OPTIONS) {
      const plan = planRepitch(input(option.policy));
      expect(plan.listing.currentVerdictId).toBe('vrd_2');
    }
  });

  it('cannot keep the best, because it is given nothing to compare', () => {
    // brief §2.4 forbids keep-the-best as a slot machine. The guarantee here is
    // structural: no field on either side of this call carries a rank, a score,
    // a composite or a cuts total, so there is no expression `planRepitch` could
    // contain that compares the old verdict with the new one. This assertion
    // fails the moment someone widens the input surface to make one possible.
    const call = input(ARCHIVE_KEEP);
    expect(Object.keys(call).sort()).toEqual([
      'clearance',
      'newClusterId',
      'newVerdictId',
      'now',
      'policy',
      'previous',
    ]);
    expect(Object.keys(call.previous)).not.toContain('rank');
    expect(Object.keys(call.previous)).not.toContain('cuts');
    expect(Object.keys(call.previous)).not.toContain('score');
    expect(Object.keys(call.clearance)).not.toContain('rank');
  });

  it('advances the pitch count and labels it for the public board', () => {
    const plan = planRepitch(input(ARCHIVE_KEEP, { previous: previous({ attemptNumber: 2 }) }));
    expect(plan.listing.attemptNumber).toBe(3);
    expect(plan.publicLabel).toBe('3rd pitch');
  });
});

describe('S8 is left open: the old verdict URL (DECISIONS.md)', () => {
  it('under archive_at_permanent_url, the old verdict keeps resolving', () => {
    const plan = planRepitch(input(ARCHIVE_KEEP));
    expect(plan.previousVerdict).toEqual({
      action: 'archive',
      verdictId: 'vrd_1',
      supersededBy: 'vrd_2',
      publiclyResolvable: true,
    });
  });

  it('under redirect_to_current, the old URL points at the current verdict', () => {
    const plan = planRepitch(input(REDIRECT_REASSIGN));
    expect(plan.previousVerdict).toEqual({
      action: 'redirect',
      verdictId: 'vrd_1',
      to: 'vrd_2',
      httpStatus: 301,
      publiclyResolvable: false,
    });
  });

  it('never deletes the old verdict row under either reading', () => {
    for (const option of REPITCH_POLICY_OPTIONS) {
      const plan = planRepitch(input(option.policy));
      expect(plan.previousVerdict?.action).not.toBe('delete');
      expect(plan.previousVerdict?.verdictId).toBe('vrd_1');
    }
  });

  it('has nothing to dispose of when the previous listing was never delivered', () => {
    const plan = planRepitch(input(ARCHIVE_KEEP, { previous: previous({ currentVerdictId: null }) }));
    expect(plan.previousVerdict).toBeNull();
  });
});

describe('S8 is left open: the cluster the product joined under its old description', () => {
  it('under keep_joined_cluster, the placement and its demand votes stand', () => {
    const plan = planRepitch(input(ARCHIVE_KEEP));
    expect(plan.cluster).toEqual({ action: 'keep', clusterId: 'cl_1', demandVotesRetained: true });
  });

  it('under reassign_on_new_description, the old cluster’s demand is stale (brief §1.5)', () => {
    const plan = planRepitch(input(REDIRECT_REASSIGN));
    expect(plan.cluster).toEqual({
      action: 'reassign',
      from: 'cl_1',
      to: 'cl_2',
      demandVotesRetained: false,
      clearsDemandFor: ['cl_1'],
    });
  });

  it('clears nothing when the new placement lands in the same cluster', () => {
    const plan = planRepitch(input(REDIRECT_REASSIGN, { newClusterId: 'cl_1' }));
    expect(plan.cluster.action === 'reassign' ? plan.cluster.clearsDemandFor : ['x']).toEqual([]);
  });

  it('refuses to keep a cluster that does not exist', () => {
    expect(() => planRepitch(input(ARCHIVE_KEEP, { previous: previous({ clusterId: null }) }))).toThrow(RangeError);
  });

  it('refuses to reassign without the cluster the placement returned', () => {
    expect(() => planRepitch(input(REDIRECT_REASSIGN, { newClusterId: null }))).toThrow(RangeError);
  });
});

describe('REPITCH_POLICY_OPTIONS', () => {
  it('records all four readings, each with what it costs', () => {
    expect(REPITCH_POLICY_OPTIONS).toHaveLength(4);
    const combos = REPITCH_POLICY_OPTIONS.map((option) => `${option.policy.previousVerdict}/${option.policy.cluster}`);
    expect(new Set(combos).size).toBe(4);
    for (const option of REPITCH_POLICY_OPTIONS) {
      expect(option.costs.length).toBeGreaterThan(0);
      expect(option.honours.length).toBeGreaterThan(0);
    }
  });
});

describe('ordinalPitch (brief §2.4: show the attempt count publicly)', () => {
  it('handles the teens, which the naive rule gets wrong', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinalPitch)).toEqual([
      '1st pitch',
      '2nd pitch',
      '3rd pitch',
      '4th pitch',
      '11th pitch',
      '12th pitch',
      '13th pitch',
      '21st pitch',
      '22nd pitch',
      '23rd pitch',
      '101st pitch',
      '111th pitch',
    ]);
  });
});
