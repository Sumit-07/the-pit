/**
 * `brief §1.1` on the paid path — the correction that only exists if it is in the
 * prompt.
 *
 * > "In a full run, jurors score up to 40 products in one prompt and spread
 * > deductions across them. In the `--add-product` path they score **one product
 * > alone**, which produces systematically different raw scores. Every paid
 * > submission uses that path, so the bias lands entirely on customers."
 *
 * This is the assertion that cannot be recovered from any output. A placement
 * whose scoring prompt lost the calibration block returns well-formed scores for
 * one product, passes every schema check, ranks, delivers and charges — and is
 * biased in a direction nobody can see from the board. `01 §6.1` then z-normalizes
 * those raw scores into the same population as scores produced under comparative
 * conditions, so the bias moves the placement rather than staying in a column
 * somebody could correct later.
 *
 * So the tests below read what the pipeline SENT. `FixtureClient` records every
 * request; the calibration block is `system[2]` of a scoring call and is absent
 * entirely when no sample is supplied, which is exactly the regression to catch.
 *
 * Hand-derived from the fixed inputs:
 *
 *   8 seeded products, all scored          -> 8 eligible calibration peers
 *   CALIBRATION_SAMPLE is 15, so 8 <= 15   -> every peer is shown, ids 0-7
 *   1 product submitted, chunk size 40     -> 1 chunk, and it holds only id 99
 *   6 jurors x 1 chunk                     -> 6 scoring calls, all calibrated
 */

import {
  ASSIGN_TOOL_NAME,
  JUROR_COUNT,
  SCORE_TOOL_NAME,
  UNIQ_TOOL_NAME,
  selectCalibrationSample,
  type ModelRequest,
} from '@the-pit/engine';
import { describe, expect, it } from 'vitest';

import { CATEGORY_VERSION, OPEN_NEW } from './helpers/panel.js';
import { makePlacementHarness, NEW_ID, place, seedCategory, SEED_SIZE } from './helpers/place.js';

/** Every scoring request the placement made, in the order it made them. */
function scoringRequests(requests: readonly ModelRequest[]): ModelRequest[] {
  return requests.filter((request) => request.toolName === SCORE_TOOL_NAME);
}

/** The system block that carries a given heading, or `''` if no block does. */
function blockWith(request: ModelRequest, heading: string): string {
  return request.system.find((block) => block.text.includes(heading))?.text ?? '';
}

describe('the calibration sample is in the placement prompt (brief §1.1)', () => {
  it('embeds already-scored peers as reference in every juror’s prompt', async () => {
    const harness = await makePlacementHarness();
    await place(harness);

    const requests = scoringRequests(harness.fixture.requests);
    expect(requests).toHaveLength(JUROR_COUNT);

    for (const request of requests) {
      const prompt = request.system.map((block) => block.text).join('\n');
      // Three separate strings, because each is a different half of the fix: the
      // heading marks the block, `ALREADY SCORED` marks each peer as reference,
      // and `scores already assigned` is what carries the numbers a juror
      // calibrates against. A block with the heading and no scores would be
      // decoration.
      expect(prompt).toContain('Calibration — already scored, DO NOT SCORE THESE');
      expect(prompt).toContain('ALREADY SCORED — REFERENCE ONLY');
      expect(prompt).toContain('scores already assigned:');
    }
  });

  it('shows the whole seeded category as peers, spread across the score range', async () => {
    const harness = await makePlacementHarness();
    await place(harness);

    const calibration = blockWith(scoringRequests(harness.fixture.requests)[0] as ModelRequest, 'ALREADY SCORED');
    const peers = [...calibration.matchAll(/\[id (\d+)\] ALREADY SCORED/g)].map((match) => Number(match[1]));

    // Eight seeded products, every one of them an eligible peer, because
    // `CALIBRATION_SAMPLE` is 15 and 8 candidates cannot be narrowed.
    expect(peers.slice().sort((a, b) => a - b)).toEqual([...Array(SEED_SIZE).keys()]);
    expect(peers).not.toContain(NEW_ID);
  });

  it('sends the sample the engine’s own selector draws for this category', async () => {
    const seeded = await seedCategory();
    const harness = await makePlacementHarness({ seeded });
    await place(harness);

    // Derived independently, from the public selector, over the same category and
    // version. `calibration_version` is a digest of the sample's exact CONTENT —
    // the ids, the text and the scores — so this fails if the pipeline passed a
    // different sample, an empty one, or one drawn under a different version.
    const expected = selectCalibrationSample(seeded.products, seeded.input.ranking, CATEGORY_VERSION);
    expect(expected.sample).toHaveLength(SEED_SIZE);

    for (const request of scoringRequests(harness.fixture.requests)) {
      expect(blockWith(request, 'ALREADY SCORED')).toContain(
        `Calibration set version: ${expected.calibration_version}`,
      );
    }
  });

  it('asks the jury to score ONLY the submitted product', async () => {
    const harness = await makePlacementHarness();
    await place(harness);

    for (const request of scoringRequests(harness.fixture.requests)) {
      const products = blockWith(request, '## PRODUCTS TO SCORE');
      expect(products).toContain(`The id is: ${NEW_ID}.`);
      // The peers are reference material in their own block. Re-scoring them here
      // would cost forty times the output tokens and, worse, would overwrite the
      // published scores this placement is being calibrated against.
      expect([...products.matchAll(/\[id (\d+)\]/g)].map((m) => Number(m[1]))).toEqual([NEW_ID]);
    }
  });

  it('calibrates a solo placement too, where no peer will ever be shown on the board', async () => {
    // The product that opens its own cluster is the case where nothing downstream
    // compares it to anybody, so an uncalibrated score would sit on the board
    // uncontradicted. It gets the same sample.
    const harness = await makePlacementHarness({ assignAnswer: OPEN_NEW });
    await place(harness);

    const requests = scoringRequests(harness.fixture.requests);
    expect(requests).toHaveLength(JUROR_COUNT);
    for (const request of requests) {
      expect(blockWith(request, 'ALREADY SCORED')).toContain('ALREADY SCORED — REFERENCE ONLY');
    }
  });

  it('never re-clusters the category: one placement call, no uniqueness pass', async () => {
    const harness = await makePlacementHarness();
    await place(harness);

    // `brief §1.5`: re-deriving the roster would orphan every stored demand vote.
    // The placement path must reach the ASSIGN prompt and never the clustering one.
    const tools = harness.fixture.requests.map((request) => request.toolName);
    expect(tools.filter((tool) => tool === UNIQ_TOOL_NAME)).toHaveLength(0);
    expect(tools.filter((tool) => tool === ASSIGN_TOOL_NAME)).toHaveLength(1);
  });
});
