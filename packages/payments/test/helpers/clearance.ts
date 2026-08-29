/**
 * A clearance can only be minted by an accepted check — that is the point of the
 * brand. So test fixtures go through the real guard rather than hand-rolling
 * the object, which also means a rule change that makes a fixture invalid shows
 * up as a failing helper rather than as a test quietly exercising a state the
 * app can no longer reach.
 */

import { checkSubmissionLocal } from '../../src/submission/guards.js';
import type { ListingSnapshot, SubmissionClearance, SubmissionDraft } from '../../src/submission/guards.js';

export function clearanceFor(
  draft: SubmissionDraft,
  now: Date,
  existing: ListingSnapshot | null = null,
): SubmissionClearance {
  const result = checkSubmissionLocal({ draft, existing, now });
  if (result.status !== 'accepted') {
    throw new Error(`fixture draft was rejected: ${result.rejection.code}`);
  }
  return result.clearance;
}
