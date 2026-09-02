/**
 * What the buyer's status page actually puts in the document.
 *
 * Three of the four things `brief` Part 6 asks of it are properties of the
 * markup rather than of anybody's intentions:
 *
 * 1. A delivered run **links the verdict**, prominently. The page it replaced
 *    linked nothing, from anywhere, ever — the surface Part 6 calls "the thing
 *    someone pays $5 for" was reachable only by pasting a slug.
 * 2. A stopped run **says so**, in the words the app already uses.
 * 3. It renders inside the **site shell** — `.wrap`, the nav, the palette — and
 *    not as the bare `<main><h1>` it was.
 *
 * The fourth, resumability, is a property of what the server hands the component
 * as its first paint; `test/submission-status.test.ts` asserts that reconstruction
 * and this file asserts that it reaches the page.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EXPECTED_WAIT, RunStatusPage } from '@/components/run-status';
import type { SubmissionStatusView } from '@/lib/pipeline/service';
import type { RunState, RunStatus, StepStatus } from '@/lib/pipeline/status';

const VERSIONS = {
  category_version: 'cat-v1',
  prompt_version: 'jury-v1',
  persona_version: 'personas-v1',
  engine_version: '0.1.0-test',
};

function status(state: RunState, steps: StepStatus['state'][]): RunStatus {
  const names: StepStatus['step'][] = ['score', 'cluster', 'persona', 'rank', 'deliver'];
  return {
    slug: 'health-fitness-wellness',
    state,
    steps: names.map((step, index) => ({ step, state: steps[index] ?? 'pending' })),
    completed: steps.filter((one) => one === 'done' || one === 'skipped').length,
    total: 5,
    versions: VERSIONS,
    votes_cached: 0,
  };
}

function view(overrides: Partial<SubmissionStatusView> = {}): SubmissionStatusView {
  return {
    submissionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    name: 'Margin',
    categorySlug: 'health-fitness-wellness',
    status: status('running', ['done', 'done', 'pending', 'pending', 'pending']),
    verdictSlug: null,
    ...overrides,
  };
}

function render(one: SubmissionStatusView, token?: string): string {
  return renderToStaticMarkup(createElement(RunStatusPage, { view: one, token }));
}

/** Markup out, entities out, whitespace collapsed. What a reader actually sees. */
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/&rsquo;/g, '’')
    .replace(/\s+/g, ' ')
    .trim();
}

describe('a run in flight', () => {
  it('renders inside the site shell rather than as a bare heading', () => {
    const html = render(view());
    expect(html).toContain('class="wrap runstatus"');
    expect(html).toContain('<nav>');
    expect(html).toContain('href="/how-it-works"');
    expect(html).toContain('href="/boards"');
    expect(html).toContain('<footer>');
  });

  it('keeps the phase names, which are the best copy in the app', () => {
    const text = textOf(render(view()));
    expect(text).toContain('The Six take their cuts');
    expect(text).toContain('Finding what it competes with');
    expect(text).toContain('The Floor picks');
    expect(text).toContain('Working out where it lands');
    expect(text).toContain('Publishing the board');
  });

  it('states the wait once and nowhere else', () => {
    const text = textOf(render(view()));
    expect(text).toContain(EXPECTED_WAIT);
    expect(text.split(EXPECTED_WAIT)).toHaveLength(2);
  });

  it('paints the run’s real state, not a spinner', () => {
    // `brief` Part 6: someone who closes the tab at 40s comes back to progress.
    // Two finished steps are in the FIRST paint, before a poll has happened.
    const text = textOf(render(view()));
    expect(text).toContain('In the pit.');
    expect(text).toContain('2 / 5');
  });

  it('says nothing about a verdict there is no link to yet', () => {
    expect(textOf(render(view()))).not.toContain('Read your verdict');
  });

  it('holds no sentence longer than twenty words', () => {
    // The rule `test/copy-budget.test.ts` puts under every other chrome surface:
    // prose longer than this is, in this app, always a justification.
    //
    // Measured per element rather than over the whole document. This page is a
    // ledger of labels — "The Floor picks", "waiting" — and none of them ends in
    // a full stop, so a document-wide split would weld the five step rows into
    // one 39-word "sentence" nobody wrote and nobody reads.
    for (const chunk of render(view()).split(/<[^>]*>/)) {
      for (const sentence of textOf(chunk).split(/(?<=[.!?])\s+/)) {
        const words = sentence.split(/\s+/).filter((word) => /[a-z]/i.test(word));
        expect(`${sentence} (${words.length})`).toBe(`${sentence} (${Math.min(words.length, 20)})`);
      }
    }
  });
});

describe('a run that finished', () => {
  it('links the verdict, prominently', () => {
    const html = render(
      view({
        status: status('delivered', ['done', 'done', 'skipped', 'done', 'done']),
        verdictSlug: 'quiet-anvil-4417',
      }),
    );
    expect(html).toContain('href="/v/quiet-anvil-4417"');
    // `.cta` is the app's one primary action, and this is the page's.
    expect(html).toContain('class="cta" href="/v/quiet-anvil-4417"');
    expect(textOf(html)).toContain('Done. Every cut is in.');
  });

  it('offers no link while the verdict has not settled', () => {
    // A published board with no `verdicts` row is a settlement that has not
    // landed. A dead link is worse than a moment more waiting.
    const html = render(view({ status: status('delivered', ['done', 'done', 'done', 'done', 'done']) }));
    expect(html).not.toContain('Read your verdict');
  });
});

describe('a run that stopped', () => {
  it('says so, in the words the app already uses', () => {
    const stopped = status('needs_support', ['done', 'failed', 'pending', 'pending', 'pending']);
    stopped.failure = { step: 'cluster', message: 'That step failed.', retryable: false };
    const text = textOf(render(view({ status: stopped })));
    expect(text).toContain('Stopped. This one needs a person.');
    expect(text).toContain('Nothing has been charged.');
  });

  it('calls a retry free, where the customer is looking', () => {
    const retrying = status('retrying', ['failed', 'pending', 'pending', 'pending', 'pending']);
    retrying.failure = { step: 'score', message: 'A juror timed out.', retryable: true };
    expect(textOf(render(view({ status: retrying })))).toContain('Retrying. Free.');
  });
});
