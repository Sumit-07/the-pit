/**
 * The buyer's status page: the run it resolves, the version it resolves it at,
 * and who is allowed to look.
 *
 * ## The regression this file exists for
 *
 * The page it replaces was keyed on the CATEGORY slug and read phases at the
 * category's current `category_snapshot_version`. A running job is stamped with
 * the version that was read when it was enqueued, and `brief §1.2` moves the
 * category's on every placement — appending a product shifts the population mean
 * and std and therefore every z-score, so the board that comes out is a different
 * board under a different version. The consequence was silent and total: the
 * moment any stranger's placement delivered, the waiting customer's page reported
 * five pending steps and no failure. A dead job, on the page whose whole purpose
 * is to prove the job is not dead.
 *
 * So `reads at the version stamped on the job` below is the test, and
 * `does not blank when a later placement moves the category` is the same test
 * written from the failure. The second one fails against a page that reads the
 * category's current version, and passes against one that reads the job's.
 *
 * Offline, like the rest of this suite: no network, no database, no API key. The
 * run underneath is a REAL placement through `runPlacement` over the engine's
 * `FixtureClient`, so the phase envelopes the status is reconstructed from are
 * the ones the pipeline actually writes.
 */

import { phaseVersions, type PhaseVersions } from '@the-pit/engine';
import { mintRunStatusToken, type SessionKeyring } from '@the-pit/auth';
import { describe, expect, it } from 'vitest';

import * as statusRoute from '@/app/api/runs/s/[submissionId]/status/route';
import { MemoryPlacementClaims } from '@/lib/pipeline/claims';
import { nextCategorySnapshotVersion } from '@/lib/pipeline/pg-store';
import type { SubmissionRecord, SubmissionRunSource } from '@/lib/pipeline/run-lookup';
import { loadSubmissionStatus, type RunnerBindings } from '@/lib/pipeline/service';
import { mayReadRunStatus } from '@/lib/pipeline/status-access';
import { MemoryPipelineStore } from '@/lib/pipeline/store';
import type { PipelineInput } from '@/lib/pipeline/types';

import { CATEGORY, CATEGORY_SLUG, CATEGORY_VERSION, makeJury, makePanel } from './helpers/panel.js';
import { makePlacementHarness, NEW_ID, place, seedCategory } from './helpers/place.js';
import { PAYER, RUN_ID } from './helpers/run.js';

/** Any 32+ character string. The keyring is asserted on, never the secret. */
const KEYRING: SessionKeyring = ['test-secret-that-is-long-enough-32chars'];

const SUBMISSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const OTHER_SUBMISSION = 'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee';

/**
 * The version the category has moved to since this run was enqueued.
 *
 * What a later placement leaves behind. Nothing in a correct status read may ever
 * ask for it.
 */
const MOVED_VERSION = nextCategorySnapshotVersion(CATEGORY_VERSION, 7);

/** A placement, run for real, plus bindings that address the rows it wrote. */
async function placedRun(): Promise<{
  bindings: RunnerBindings;
  /** Every `categoryVersion` the status read asked the catalogue for. */
  asked: string[];
  versions: PhaseVersions;
}> {
  const seeded = await seedCategory();
  const harness = await makePlacementHarness({ seeded, paid: PAYER, runId: RUN_ID });
  await place(harness);

  const asked: string[] = [];
  const products = [...seeded.products, harness.input.product];

  const bindings: RunnerBindings = {
    categories: {
      load(slug: string, options?: { categoryVersion?: string }): Promise<PipelineInput | undefined> {
        if (slug !== CATEGORY_SLUG) return Promise.resolve(undefined);
        // The category as it stands NOW is `MOVED_VERSION`. A caller that omits a
        // version gets the moved one, which is precisely what the old page did.
        const categoryVersion = options?.categoryVersion ?? MOVED_VERSION;
        asked.push(categoryVersion);
        return Promise.resolve({
          category: CATEGORY,
          products,
          jury: makeJury(),
          personas: makePanel(),
          config: { categoryVersion },
        });
      },
    },
    claims: new MemoryPlacementClaims(),
    // The two handles the placement itself ran through, and nothing else. A
    // scope naming a DIFFERENT engine id is a different placement and gets an
    // empty store, which is what the production binding does with a different
    // job row.
    store: (_category, _versions, scope) => {
      if (scope?.placement === undefined) return harness.category;
      return scope.placement === NEW_ID ? harness.phases : new MemoryPipelineStore(CATEGORY);
    },
    snapshots: harness.snapshots,
  };

  return { bindings, asked, versions: phaseVersions(harness.input) };
}

/** A lookup that answers with one fixed run, whatever it is asked for. */
function sourceFor(run: SubmissionRecord['run']): SubmissionRunSource {
  return {
    find: (submissionId: string): Promise<SubmissionRecord | null> =>
      Promise.resolve(
        submissionId === SUBMISSION
          ? { submissionId, name: 'Margin', categorySlug: CATEGORY_SLUG, run }
          : null,
      ),
  };
}

describe('one buyer’s run, read at the version stamped on their job', () => {
  it('reconstructs every step of a delivered placement', async () => {
    const { bindings } = await placedRun();
    const lookup = await loadSubmissionStatus(
      SUBMISSION,
      sourceFor({
        runId: RUN_ID,
        categorySlug: CATEGORY_SLUG,
        categoryVersion: CATEGORY_VERSION,
        engineId: NEW_ID,
        verdictSlug: null,
      }),
      bindings,
    );

    expect(lookup.found).toBe(true);
    if (!lookup.found) throw new Error('unreachable');

    const byStep = new Map(lookup.view.status.steps.map((step) => [step.step, step.state]));
    expect(byStep.get('score')).toBe('done');
    expect(byStep.get('cluster')).toBe('done');
    expect(byStep.get('persona')).toBe('done');
    expect(byStep.get('rank')).toBe('done');
    expect(byStep.get('deliver')).toBe('done');
    expect(lookup.view.status.completed).toBe(5);
    expect(lookup.view.status.state).toBe('delivered');
  });

  it('asks the catalogue for the job’s version and never for the category’s', async () => {
    const { bindings, asked } = await placedRun();
    await loadSubmissionStatus(
      SUBMISSION,
      sourceFor({
        runId: RUN_ID,
        categorySlug: CATEGORY_SLUG,
        categoryVersion: CATEGORY_VERSION,
        engineId: NEW_ID,
        verdictSlug: null,
      }),
      bindings,
    );

    expect(asked).toEqual([CATEGORY_VERSION]);
    expect(asked).not.toContain(MOVED_VERSION);
  });

  /**
   * The regression, stated as its own failure.
   *
   * Reading the same run at the version the category has SINCE moved to reports
   * nothing done — which is exactly what the customer saw. If this ever agrees
   * with the test above, the version stamp has stopped meaning anything and the
   * two tests above have stopped proving what they claim.
   */
  it('does not blank when a later placement moves the category', async () => {
    const { bindings } = await placedRun();
    const atMoved = await loadSubmissionStatus(
      SUBMISSION,
      sourceFor({
        runId: RUN_ID,
        categorySlug: CATEGORY_SLUG,
        categoryVersion: MOVED_VERSION,
        engineId: NEW_ID,
        verdictSlug: null,
      }),
      bindings,
    );
    if (!atMoved.found) throw new Error('unreachable');
    const moved = new Map(atMoved.view.status.steps.map((step) => [step.step, step.state]));
    // Every phase is reported as work that has not survived — which is what the
    // customer was shown while their run was finishing normally.
    expect(moved.get('score')).toBe('pending');
    expect(moved.get('cluster')).toBe('pending');
    expect(moved.get('persona')).toBe('pending');
    expect(moved.get('deliver')).toBe('pending');
    expect(atMoved.view.status.state).not.toBe('delivered');

    const atStamped = await loadSubmissionStatus(
      SUBMISSION,
      sourceFor({
        runId: RUN_ID,
        categorySlug: CATEGORY_SLUG,
        categoryVersion: CATEGORY_VERSION,
        engineId: NEW_ID,
        verdictSlug: null,
      }),
      bindings,
    );
    if (!atStamped.found) throw new Error('unreachable');
    expect(atStamped.view.status.completed).toBe(5);
  });

  it('reads the phases of THIS placement and not of another one', async () => {
    const { bindings } = await placedRun();
    // Two placements against one category carry identical version stamps —
    // `store.ts` says so at length — so the engine id is the only thing that
    // keeps their phase envelopes apart. A status read that dropped it would show
    // one customer another customer's progress.
    const other = await loadSubmissionStatus(
      SUBMISSION,
      sourceFor({
        runId: RUN_ID,
        categorySlug: CATEGORY_SLUG,
        categoryVersion: CATEGORY_VERSION,
        engineId: NEW_ID + 1,
        verdictSlug: null,
      }),
      bindings,
    );
    if (!other.found) throw new Error('unreachable');
    const byStep = new Map(other.view.status.steps.map((step) => [step.step, step.state]));
    expect(byStep.get('score')).toBe('pending');
    expect(byStep.get('cluster')).toBe('pending');
    expect(byStep.get('persona')).toBe('pending');
  });

  it('says queued, honestly, before the webhook has enqueued anything', async () => {
    const { bindings } = await placedRun();
    const lookup = await loadSubmissionStatus(SUBMISSION, sourceFor(null), bindings);
    if (!lookup.found) throw new Error('unreachable');
    expect(lookup.view.status.state).toBe('queued');
    expect(lookup.view.status.completed).toBe(0);
    expect(lookup.view.status.steps).toHaveLength(5);
  });

  it('is a 404 for a submission nobody took', async () => {
    const { bindings } = await placedRun();
    expect((await loadSubmissionStatus(OTHER_SUBMISSION, sourceFor(null), bindings)).found).toBe(false);
  });

  it('carries the verdict slug once the run has settled', async () => {
    const { bindings } = await placedRun();
    const lookup = await loadSubmissionStatus(
      SUBMISSION,
      sourceFor({
        runId: RUN_ID,
        categorySlug: CATEGORY_SLUG,
        categoryVersion: CATEGORY_VERSION,
        engineId: NEW_ID,
        verdictSlug: 'quiet-anvil-4417',
      }),
      bindings,
    );
    if (!lookup.found) throw new Error('unreachable');
    expect(lookup.view.verdictSlug).toBe('quiet-anvil-4417');
    expect(lookup.view.status.state).toBe('delivered');
  });
});

/**
 * `brief §2.1` is guest checkout, so the person on this page has no session and
 * `submissions` has no account id to compare one against. The gate is a signature
 * minted at submission and carried home on the Dodo return URL.
 */
describe('who may watch a run', () => {
  it('opens for the submission the token was minted for', () => {
    const token = mintRunStatusToken(SUBMISSION, KEYRING);
    expect(mayReadRunStatus(SUBMISSION, token, KEYRING)).toBe(true);
  });

  it('refuses another buyer’s submission, token and all', () => {
    // The exact failure the gate exists for: a valid, correctly signed token,
    // pointed at somebody else's run.
    const mine = mintRunStatusToken(SUBMISSION, KEYRING);
    expect(mayReadRunStatus(OTHER_SUBMISSION, mine, KEYRING)).toBe(false);
  });

  it('refuses a submission id on its own', () => {
    // The id travels through Dodo metadata, webhook payloads and the logs under
    // both. Knowing one must not be the same as being allowed to read the run.
    expect(mayReadRunStatus(SUBMISSION, undefined, KEYRING)).toBe(false);
    expect(mayReadRunStatus(SUBMISSION, '', KEYRING)).toBe(false);
  });

  it('refuses a token forged under a different secret', () => {
    const forged = mintRunStatusToken(SUBMISSION, ['a-different-secret-of-adequate-length']);
    expect(mayReadRunStatus(SUBMISSION, forged, KEYRING)).toBe(false);
  });

  it('still opens a link minted before a secret rotation', () => {
    const old = mintRunStatusToken(SUBMISSION, ['the-previous-secret-of-adequate-length']);
    expect(mayReadRunStatus(SUBMISSION, old, ['a-brand-new-secret-of-adequate-length', 'the-previous-secret-of-adequate-length'])).toBe(true);
  });

  it('refuses everything when no secret is bound', () => {
    expect(mayReadRunStatus(SUBMISSION, mintRunStatusToken(SUBMISSION, KEYRING), undefined)).toBe(false);
  });
});

/**
 * The polling endpoint behind the page, gated the same way.
 *
 * Two doors onto one run is how the second one comes to be softer than the
 * first, and this is the one that is easy to forget: nobody looks at it.
 */
describe('GET /api/runs/s/[submissionId]/status', () => {
  const params = (submissionId: string): { params: Promise<{ submissionId: string }> } => ({
    params: Promise.resolve({ submissionId }),
  });

  it('is a 404 for a token minted for somebody else’s submission', async () => {
    const previous = process.env['SESSION_SECRET'];
    process.env['SESSION_SECRET'] = KEYRING[0];
    try {
      const mine = mintRunStatusToken(SUBMISSION, KEYRING);
      const response = await statusRoute.GET(
        new Request(`https://thepit.show/api/runs/s/${OTHER_SUBMISSION}/status?t=${mine}`),
        params(OTHER_SUBMISSION),
      );
      expect(response.status).toBe(404);
      // One body for "no such run" and for "not your run". Telling them apart is
      // free reconnaissance for whoever guessed the id.
      expect(await response.json()).toEqual({ error: 'no run' });
      expect(response.headers.get('cache-control')).toBe('no-store');
    } finally {
      if (previous === undefined) delete process.env['SESSION_SECRET'];
      else process.env['SESSION_SECRET'] = previous;
    }
  });

  it('is a 404 for a bare submission id with no signature', async () => {
    const previous = process.env['SESSION_SECRET'];
    process.env['SESSION_SECRET'] = KEYRING[0];
    try {
      const response = await statusRoute.GET(
        new Request(`https://thepit.show/api/runs/s/${SUBMISSION}/status`),
        params(SUBMISSION),
      );
      expect(response.status).toBe(404);
    } finally {
      if (previous === undefined) delete process.env['SESSION_SECRET'];
      else process.env['SESSION_SECRET'] = previous;
    }
  });

  it('is never cached, and never indexed', async () => {
    const response = await statusRoute.GET(
      new Request(`https://thepit.show/api/runs/s/${SUBMISSION}/status`),
      params(SUBMISSION),
    );
    expect(response.headers.get('x-robots-tag')).toContain('noindex');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(statusRoute.dynamic).toBe('force-dynamic');
  });
});
