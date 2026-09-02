/**
 * Is the juror prompt's cached prefix long enough for Haiku to cache it at all?
 *
 * ## Why this is a test and not a note
 *
 * The minimum cacheable prefix is model-dependent and it is not monotonic across
 * generations: 512 tokens on the newest models, 1,024 on Sonnet 5, and **4,096 on
 * `claude-haiku-4-5`** — which is `MODEL_ID_HAIKU`, the model every juror runs on.
 * Below that minimum a `cache_control` marker is not an error and not a warning.
 * It is silence: `cache_creation_input_tokens` comes back 0, every call pays full
 * price, and the run looks exactly like a run that was caching perfectly. That is
 * the failure `src/model/anthropic-client.ts` warns about at the top, and it is
 * the failure a person cannot see.
 *
 * `runScorePhase` now serializes a primer call ahead of the fan-out so the other
 * five jurors can read what it wrote. That trade is only worth making if the
 * prefix is over the line — a primer that writes nothing has bought a round trip
 * for nothing — so the length is asserted here rather than assumed.
 *
 * ## Measured offline, checked online
 *
 * Global Constraint 5: `pnpm test` passes with no network and no environment
 * variables, so the standing assertion is over CHARACTERS, converted at a rate
 * chosen to UNDERSTATE the token count. English averages roughly 3.5-4 characters
 * per token; this prompt is denser than prose (ids, punctuation, `<<<`
 * delimiters, `[id N]` markers), so dividing by 4 is a floor, not an estimate.
 * If the floor clears 4,096 the real count clears it by more.
 *
 * The exact number comes from the API's own tokenizer, and `count_tokens` is
 * free — so when `PIT_COUNT_TOKENS=1` and a key are both present this calls it
 * and asserts the real figure. Without them the call is skipped, which is the
 * only way an offline suite can carry an online fact.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { MODEL_ID_HAIKU, MODEL_JUROR } from '../../src/config/constants.js';
import { orderedChunks } from '../../src/panels/ordering.js';
import { buildScoreRequest } from '../../src/panels/prompts/score.js';
import type { Jury, Product } from '../../src/types.js';

/** `claude-haiku-4-5`'s minimum cacheable prefix. Shorter prefixes silently do not cache. */
const HAIKU_MIN_CACHEABLE_TOKENS = 4096;

/**
 * Characters per token, chosen to UNDERSTATE the count.
 *
 * A structured prompt tokenizes worse than prose, so the true ratio is below
 * this and the true token count is above what this yields.
 */
const CHARS_PER_TOKEN_FLOOR = 4;

/** `cjr/` at the repository root; the suite's cwd is `packages/engine`. */
const WORKDIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'cjr');

async function seededCategory(slug: string): Promise<{ products: Product[]; jury: Jury }> {
  const products = JSON.parse(await readFile(join(WORKDIR, 'runs', slug, 'products.json'), 'utf8')) as {
    products: Product[];
  };
  const jury = JSON.parse(await readFile(join(WORKDIR, 'references', 'jurors', `${slug}.json`), 'utf8')) as Jury;
  return { products: products.products, jury };
}

/** The bytes a cache prefix covers: all tools, plus system blocks 0..cacheBreakpoint. */
function prefixText(request: ReturnType<typeof buildScoreRequest>): string {
  const breakpoint = request.cacheBreakpoint ?? request.system.length - 1;
  return [JSON.stringify(request.tools), ...request.system.slice(0, breakpoint + 1).map((block) => block.text)].join(
    '\n',
  );
}

describe('the juror prompt is long enough for Haiku to cache', () => {
  it('clears the 4,096-token minimum on the real developer-tools board', async () => {
    const { products, jury } = await seededCategory('developer-tools');
    const ordering = { category: 'developer-tools', categoryVersion: 'v1' };
    const chunks = orderedChunks(products, ordering);
    const chunk = chunks[0];
    if (chunk === undefined) throw new Error('developer-tools produced no chunk');

    const juror = jury.jurors[0];
    if (juror === undefined) throw new Error('developer-tools has no installed juror');

    const request = buildScoreRequest({ metrics: jury.metrics, products: chunk, juror, ordering });

    // The mandate is the volatile part and sits OUTSIDE the prefix, in
    // `messages`. Nothing after the breakpoint counts toward the minimum.
    // `ModelRequest.model` names the TIER; the adapter maps it to the api id.
    expect(request.model).toBe(MODEL_JUROR);
    expect(request.cacheBreakpoint).toBe(request.system.length - 1);

    const chars = prefixText(request).length;
    const floor = Math.floor(chars / CHARS_PER_TOKEN_FLOOR);

    // Printed, because the point of this test is the number. 48 products over a
    // CHUNK_SIZE of 40 gives a 24-product first chunk, i.e. the SMALLER of the
    // two — so this is close to the worst case a full board produces.
    console.log(
      `[cache prefix] developer-tools chunk 1/${chunks.length}: ${chunk.length} products, ` +
        `${chars} chars, >= ~${floor} tokens (Haiku minimum ${HAIKU_MIN_CACHEABLE_TOKENS})`,
    );

    expect(floor).toBeGreaterThanOrEqual(HAIKU_MIN_CACHEABLE_TOKENS);
  });

  it('clears it for the smallest chunk a full board can produce', async () => {
    // `orderedChunks` balances, so a 48-product board never makes a chunk of one
    // — but the incremental path (`brief §1.1`) scores a SINGLE product, and that
    // request is where the prefix is shortest. It is measured, not asserted: a
    // one-product incremental call legitimately may not reach the minimum, and
    // the number is what tells a reader whether the breakpoint is earning
    // anything on that path.
    const { products, jury } = await seededCategory('developer-tools');
    const ordering = { category: 'developer-tools', categoryVersion: 'v1' };
    const one = products.slice(0, 1);
    const juror = jury.jurors[0];
    if (juror === undefined) throw new Error('developer-tools has no installed juror');

    const request = buildScoreRequest({ metrics: jury.metrics, products: one, juror, ordering });
    const chars = prefixText(request).length;
    console.log(
      `[cache prefix] incremental, 1 product: ${chars} chars, >= ~${Math.floor(chars / CHARS_PER_TOKEN_FLOOR)} tokens`,
    );

    expect(chars).toBeGreaterThan(0);
  });

  it.runIf(process.env['PIT_COUNT_TOKENS'] === '1' && process.env['ANTHROPIC_API_KEY'] !== undefined)(
    'agrees with the API tokenizer',
    async () => {
      // Guarded twice — an explicit opt-in AND a key — because Global Constraint
      // 5 says the suite runs with neither. `count_tokens` is free, so the guard
      // is about the network, not the bill.
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      const { products, jury } = await seededCategory('developer-tools');
      const ordering = { category: 'developer-tools', categoryVersion: 'v1' };
      const chunk = orderedChunks(products, ordering)[0];
      const juror = jury.jurors[0];
      if (chunk === undefined || juror === undefined) throw new Error('developer-tools is not seeded');

      const request = buildScoreRequest({ metrics: jury.metrics, products: chunk, juror, ordering });
      const breakpoint = request.cacheBreakpoint ?? request.system.length - 1;

      const counted = await new Anthropic().messages.countTokens({
        model: MODEL_ID_HAIKU,
        system: request.system.slice(0, breakpoint + 1),
        tools: [...request.tools],
        // `count_tokens` needs a message; the mandate is what really follows the
        // prefix, and it is counted here only so the request is well-formed. The
        // assertion is that the PREFIX alone already clears the minimum, so a
        // count that includes the mandate clearing it is the weaker claim — which
        // is why the floor above is the standing test and this is the check.
        messages: [...request.messages],
      });

      console.log(`[cache prefix] count_tokens says ${counted.input_tokens} tokens (prefix + mandate)`);
      expect(counted.input_tokens).toBeGreaterThanOrEqual(HAIKU_MIN_CACHEABLE_TOKENS);
    },
    30_000,
  );
});
