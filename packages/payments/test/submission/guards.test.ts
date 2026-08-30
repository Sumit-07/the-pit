import { describe, expect, it } from 'vitest';

import type { CategoryClassifier, CategoryVerdict } from '../../src/submission/category.js';
import { acceptAllClassifier, decideCategory } from '../../src/submission/category.js';
import type { ListingSnapshot, SubmissionDraft } from '../../src/submission/guards.js';
import { checkSubmission, checkSubmissionLocal, normalizeSubmissionUrl } from '../../src/submission/guards.js';

const NOW = new Date('2026-08-29T21:30:00.000Z');
/** The cycle containing NOW opened at 02:00 on the 29th. */
const THIS_CYCLE = new Date('2026-08-29T10:00:00.000Z');
const LAST_CYCLE = new Date('2026-08-28T10:00:00.000Z');

const CATEGORIES = ['developer-tools', 'health-fitness'];

function draft(overrides: Partial<SubmissionDraft> = {}): SubmissionDraft {
  return {
    url: 'https://www.runlet.dev/',
    name: 'Runlet',
    description: 'A fast Rust web server for edge deploys',
    categorySlug: 'developer-tools',
    ...overrides,
  };
}

function listing(overrides: Partial<ListingSnapshot> = {}): ListingSnapshot {
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

function classifierReturning(verdict: CategoryVerdict): CategoryClassifier {
  return { classify: () => Promise.resolve(verdict) };
}

describe('URL normalization (brief §2.5) keys the per-product cap', () => {
  it('reduces affiliate, protocol and www variants to one identity', () => {
    const spellings = [
      'https://www.runlet.dev/',
      'http://runlet.dev',
      'RUNLET.DEV',
      'https://runlet.dev/?utm_source=hn&ref=abc',
      'runlet.dev/',
    ];
    for (const spelling of spellings) {
      const result = normalizeSubmissionUrl(spelling);
      expect(result.ok ? result.normalizedUrl : result.rejection.code).toBe('runlet.dev');
    }
  });

  it('catches the same product submitted under two different spellings', () => {
    // The listing was found by normalizing; the second spelling normalizes to
    // the same key, so the cycle lock applies. Without normalization these are
    // two products and the cap is one URL edit away from being free.
    const existing = listing({ lastPitchedAt: THIS_CYCLE });
    const first = checkSubmissionLocal({ draft: draft({ url: 'https://www.runlet.dev/' }), existing, now: NOW });
    const second = checkSubmissionLocal({
      draft: draft({ url: 'HTTP://RunLet.dev/?utm_campaign=launch' }),
      existing,
      now: NOW,
    });
    expect(first.status).toBe('rejected');
    expect(second.status).toBe('rejected');
    expect(second.status === 'rejected' ? second.rejection.code : '').toBe('cycle_locked');
  });

  it('rejects a typo with a message rather than throwing', () => {
    const result = checkSubmissionLocal({ draft: draft({ url: 'htp:/runlet' }), existing: null, now: NOW });
    expect(result.status === 'rejected' ? result.rejection.code : '').toBe('invalid_url');
  });

  it('is the OFFLINE key and does not follow a shortener — that is the caller\'s job', () => {
    // `normalizeSubmissionUrl` performs no I/O and never will: it is the typo
    // gate and the browser's fast feedback. A shortener resolves to its target
    // upstream, in `@the-pit/fetch`, and arrives as `resolvedUrl` — see the
    // describe below. Asserting the offline behaviour here is what pins the two
    // apart, so nobody "fixes" this function by giving it a network.
    const short = normalizeSubmissionUrl('https://bit.ly/3xYz');
    const target = normalizeSubmissionUrl('https://runlet.dev');
    expect(short.ok ? short.normalizedUrl : '').toBe('bit.ly/3xYz'.toLowerCase());
    expect(short.ok ? short.normalizedUrl : '').not.toBe(target.ok ? target.normalizedUrl : '');
  });
});

describe('brief §2.5: the resolved key is HANDED IN, and it is the one that is banked', () => {
  it('mints the clearance from the resolved key, not from what was typed', () => {
    // The line the whole shortener wiring turns on. `runSubmissionGuards` looked
    // the listing up under `runlet.dev`; if this minted `bit.ly/3xyz` instead,
    // the Dodo metadata, the job idempotency key and `products.normalized_url`
    // would all name a different product than the cap was enforced on.
    const result = checkSubmissionLocal({
      draft: draft({ url: 'https://bit.ly/3xYz' }),
      resolvedUrl: 'runlet.dev',
      existing: null,
      now: NOW,
    });

    expect(result.status).toBe('accepted');
    expect(result.status === 'accepted' ? result.clearance.normalizedUrl : '').toBe('runlet.dev');
    // And not the offline key, which is what it would have been before.
    expect(result.status === 'accepted' ? result.clearance.normalizedUrl : '').not.toBe('bit.ly/3xyz');
  });

  it('falls back to the offline key when no caller resolved one', () => {
    // The browser's check, and every rule-level test in this file. Omitting the
    // field must not mean "no key".
    const result = checkSubmissionLocal({ draft: draft(), existing: null, now: NOW });
    expect(result.status === 'accepted' ? result.clearance.normalizedUrl : '').toBe('runlet.dev');
  });

  it('still refuses a typo, even when a caller hands it a perfectly good key', () => {
    // The typo gate runs on what was TYPED. A resolver that somehow produced a
    // key for `htp:/runlet` must not launder it into an accepted submission.
    const result = checkSubmissionLocal({
      draft: draft({ url: 'htp:/runlet' }),
      resolvedUrl: 'runlet.dev',
      existing: null,
      now: NOW,
    });
    expect(result.status === 'rejected' ? result.rejection.code : '').toBe('invalid_url');
  });

  it('carries url_redirected and url_unresolved onto the review flags, and blocks on neither', () => {
    // `brief §2.5`: "flag for review, do not hard-block. A false rejection on a
    // paying customer is worse than an extra run."
    const result = checkSubmissionLocal({
      draft: draft({ url: 'https://bit.ly/3xYz' }),
      resolvedUrl: 'runlet.dev',
      urlFlags: ['url_redirected'],
      existing: null,
      now: NOW,
    });

    expect(result.status).toBe('accepted');
    expect(result.status === 'accepted' ? result.clearance.flags : []).toEqual(['url_redirected']);
  });

  it('keeps the url flags alongside the ones the rules raise, rather than replacing them', () => {
    // A seeded listing being claimed AND a redirected URL are two independent
    // observations, and the review queue needs both.
    const result = checkSubmissionLocal({
      draft: draft({ url: 'https://bit.ly/3xYz', description: 'A wholly different sentence about edge deployment tooling' }),
      resolvedUrl: 'runlet.dev',
      urlFlags: ['url_redirected'],
      existing: listing({ accountId: null, lastPitchedAt: null }),
      now: NOW,
    });

    expect(result.status).toBe('accepted');
    expect(result.status === 'accepted' ? [...result.clearance.flags].sort() : []).toEqual([
      'claims_seeded_listing',
      'url_redirected',
    ]);
  });

  it('makes a shortener and its target ONE product to the cycle lock', async () => {
    // Two submissions, two different strings, one resolved key — and the second
    // is locked out by the first. This is the rule the cap exists to enforce,
    // stated at the level the rules live at.
    const existing = listing({ lastPitchedAt: THIS_CYCLE });

    const viaShortener = await checkSubmission({
      draft: draft({ url: 'https://bit.ly/3xYz' }),
      resolvedUrl: existing.normalizedUrl,
      existing,
      now: NOW,
      classifier: acceptAllClassifier,
      candidateCategories: CATEGORIES,
    });

    expect(viaShortener.status === 'rejected' ? viaShortener.rejection.code : '').toBe('cycle_locked');
  });
});

describe('the first pitch of a product', () => {
  it('is accepted with no previous listing', () => {
    const result = checkSubmissionLocal({ draft: draft(), existing: null, now: NOW });
    expect(result.status).toBe('accepted');
    expect(result.status === 'accepted' ? result.clearance.attemptNumber : 0).toBe(1);
    expect(result.status === 'accepted' ? result.clearance.repitchOf : 'x').toBeNull();
  });

  it('is accepted against an unclaimed seeded listing, and is flagged as a claim', () => {
    // A seeded listing has never been pitched, so neither the cycle lock nor
    // the materially-changed rule applies — both are rules about RE-pitching.
    const seeded = listing({ accountId: null, attemptNumber: 0, lastPitchedAt: null, currentVerdictId: null });
    const result = checkSubmissionLocal({ draft: draft(), existing: seeded, now: NOW });
    expect(result.status).toBe('accepted');
    expect(result.status === 'accepted' ? [...result.clearance.flags] : []).toContain('claims_seeded_listing');
    expect(result.status === 'accepted' ? result.clearance.attemptNumber : 0).toBe(1);
  });
});

describe('one pitch per product per recalibration cycle (brief §2.4)', () => {
  it('rejects a second pitch inside the same cycle, with a countdown', () => {
    const result = checkSubmissionLocal({
      draft: draft({ description: 'A slow Python API gateway for cloud teams' }),
      existing: listing({ lastPitchedAt: THIS_CYCLE }),
      now: NOW,
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected' || result.rejection.code !== 'cycle_locked') {
      throw new Error('expected a cycle_locked rejection');
    }
    expect(result.rejection.nextRebuildAt.toISOString()).toBe('2026-08-30T02:00:00.000Z');
    expect(result.rejection.secondsRemaining).toBe(16200);
    expect(result.rejection.message).toContain('4h 30m');
    expect(result.rejection.message).toContain('02:00 UTC');
  });

  it('accepts once the rebuild has closed the previous cycle', () => {
    const result = checkSubmissionLocal({
      draft: draft({ description: 'A slow Python API gateway for cloud teams' }),
      existing: listing({ lastPitchedAt: LAST_CYCLE }),
      now: NOW,
    });
    expect(result.status).toBe('accepted');
    expect(result.status === 'accepted' ? result.clearance.attemptNumber : 0).toBe(2);
    expect(result.status === 'accepted' ? result.clearance.repitchOf : null).toBe('lst_1');
  });

  it('caps per product and not per account — four side projects all go in tonight', () => {
    // brief §2.4: "Someone with four side projects should be able to submit all
    // four tonight." Nothing in the check reads an account id for this rule.
    const urls = ['https://runlet.dev', 'https://beacon.sh', 'https://plotpad.io', 'https://tinyq.app'];
    const results = urls.map((url) => checkSubmissionLocal({ draft: draft({ url }), existing: null, now: NOW }));
    expect(results.every((result) => result.status === 'accepted')).toBe(true);
  });

  it('locks one product without locking another owned by the same person', () => {
    const locked = checkSubmissionLocal({
      draft: draft({ description: 'A slow Python API gateway for cloud teams' }),
      existing: listing({ lastPitchedAt: THIS_CYCLE }),
      now: NOW,
      accountId: 'acct_1',
    });
    const other = checkSubmissionLocal({
      draft: draft({ url: 'https://beacon.sh' }),
      existing: null,
      now: NOW,
      accountId: 'acct_1',
    });
    expect(locked.status).toBe('rejected');
    expect(other.status).toBe('accepted');
  });
});

describe('materially changed description (brief §2.4)', () => {
  it('rejects a re-pitch with unchanged text', () => {
    const result = checkSubmissionLocal({ draft: draft(), existing: listing(), now: NOW });
    expect(result.status === 'rejected' ? result.rejection.code : '').toBe('description_unchanged');
  });

  it('rejects a reordered description, which a hash comparison would let through', () => {
    const result = checkSubmissionLocal({
      draft: draft({ description: 'deploys edge for server web Rust fast a' }),
      existing: listing(),
      now: NOW,
    });
    expect(result.status === 'rejected' ? result.rejection.code : '').toBe('description_unchanged');
  });

  it('accepts a rewrite', () => {
    const result = checkSubmissionLocal({
      draft: draft({ description: 'A slow Python API gateway for cloud teams' }),
      existing: listing(),
      now: NOW,
    });
    expect(result.status).toBe('accepted');
  });
});

describe('field limits', () => {
  it('rejects an empty name and an empty description', () => {
    expect(
      checkSubmissionLocal({ draft: draft({ name: '   ' }), existing: null, now: NOW }).status,
    ).toBe('rejected');
    expect(
      checkSubmissionLocal({ draft: draft({ description: '  ' }), existing: null, now: NOW }).status,
    ).toBe('rejected');
  });

  it('rejects a description past the 300-character limit the whole board is scored under', () => {
    const result = checkSubmissionLocal({ draft: draft({ description: 'x'.repeat(301) }), existing: null, now: NOW });
    expect(result.status === 'rejected' ? result.rejection.code : '').toBe('description_too_long');
    expect(checkSubmissionLocal({ draft: draft({ description: 'x'.repeat(300) }), existing: null, now: NOW }).status).toBe(
      'accepted',
    );
  });

  it('carries the trimmed description into the clearance', () => {
    const result = checkSubmissionLocal({
      draft: draft({ description: '  A fast Rust web server for edge deploys  ' }),
      existing: null,
      now: NOW,
    });
    expect(result.status === 'accepted' ? result.clearance.draft.description : '').toBe(
      'A fast Rust web server for edge deploys',
    );
  });
});

describe('ownership', () => {
  it('holds a submission for someone else’s claimed listing rather than replacing it', () => {
    const result = checkSubmissionLocal({
      draft: draft({ description: 'A slow Python API gateway for cloud teams' }),
      existing: listing({ accountId: 'acct_other' }),
      now: NOW,
      accountId: 'acct_1',
    });
    expect(result.status === 'rejected' ? result.rejection.code : '').toBe('ownership_conflict');
  });

  it('cannot evaluate ownership before payment, because guest checkout has no identity', () => {
    // brief §2.1: no login at submission. The pre-payment check passes; the
    // pre-enqueue check, which has the account from the Dodo webhook email,
    // is where this is caught.
    const result = checkSubmissionLocal({
      draft: draft({ description: 'A slow Python API gateway for cloud teams' }),
      existing: listing({ accountId: 'acct_other' }),
      now: NOW,
    });
    expect(result.status).toBe('accepted');
  });
});

describe('category choice, checked before payment (DECISIONS.md S12)', () => {
  it('blocks a confident mismatch and names the category it would have picked', async () => {
    const result = await checkSubmission({
      draft: draft({ categorySlug: 'health-fitness' }),
      existing: null,
      now: NOW,
      classifier: classifierReturning({
        verdict: 'mismatch',
        confidence: 0.95,
        suggested: 'developer-tools',
        reason: 'a web server is not a fitness product',
      }),
      candidateCategories: CATEGORIES,
    });

    expect(result.status).toBe('rejected');
    if (result.status !== 'rejected' || result.rejection.code !== 'category_mismatch') {
      throw new Error('expected a category_mismatch rejection');
    }
    expect(result.rejection.suggested).toBe('developer-tools');
    expect(result.rejection.message).toContain('you have not been charged');
  });

  it('lets an unconfident mismatch through and flags it instead', () => {
    const decision = decideCategory(
      { verdict: 'mismatch', confidence: 0.4, suggested: 'developer-tools', reason: 'unsure' },
      'health-fitness',
    );
    expect(decision.action).toBe('allow');
    expect(decision.action === 'allow' ? decision.flagForReview : false).toBe(true);
  });

  it('lets an uncertain verdict through — a false rejection is worse than an extra run', async () => {
    const result = await checkSubmission({
      draft: draft(),
      existing: null,
      now: NOW,
      classifier: classifierReturning({ verdict: 'uncertain', confidence: 0.5, reason: 'ambiguous' }),
      candidateCategories: CATEGORIES,
    });
    expect(result.status).toBe('accepted');
    expect(result.status === 'accepted' ? [...result.clearance.flags] : []).toContain('category_uncertain');
  });

  it('never blocks with the stub classifier, and never claims confidence it does not have', async () => {
    const result = await checkSubmission({
      draft: draft(),
      existing: null,
      now: NOW,
      classifier: acceptAllClassifier,
      candidateCategories: CATEGORIES,
    });
    expect(result.status).toBe('accepted');
    expect(await acceptAllClassifier.classify({
      name: 'x',
      description: 'y',
      chosenCategory: 'developer-tools',
      candidateCategories: CATEGORIES,
    })).toEqual({ verdict: 'match', confidence: 0 });
  });

  it('does not spend a classifier call on a submission the cheap rules already rejected', async () => {
    let calls = 0;
    const counting: CategoryClassifier = {
      classify: () => {
        calls += 1;
        return Promise.resolve<CategoryVerdict>({ verdict: 'match', confidence: 1 });
      },
    };
    await checkSubmission({
      draft: draft(),
      existing: listing({ lastPitchedAt: THIS_CYCLE }),
      now: NOW,
      classifier: counting,
      candidateCategories: CATEGORIES,
    });
    expect(calls).toBe(0);
  });
});

describe('the client-side and server-side checks agree', () => {
  it('reject for the same reason on the shared rules', async () => {
    const input = {
      draft: draft(),
      existing: listing({ lastPitchedAt: THIS_CYCLE }),
      now: NOW,
    };
    const client = checkSubmissionLocal(input);
    const server = await checkSubmission({
      ...input,
      classifier: acceptAllClassifier,
      candidateCategories: CATEGORIES,
    });
    expect(client.status === 'rejected' ? client.rejection.code : '').toBe(
      server.status === 'rejected' ? server.rejection.code : '',
    );
  });
});
