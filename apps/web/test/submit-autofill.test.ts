/**
 * The form itself: the autofill that ships on it, and the pitch field beside it.
 *
 * ## The script under test is the one that ships
 *
 * `packages/fetch` has been correct and called from nowhere for four commits.
 * The way that keeps happening is that a test proves a FUNCTION works and
 * nobody proves the page reaches it. So nothing here imports a helper and
 * exercises it in isolation. The script these tests run is pulled out of the
 * rendered HTML with a regex, and executed against a hand-rolled DOM stub — so
 * a rename, a dropped `id`, a `<script>` that never made it into `document_()`
 * or an enhancement that silently binds to nothing all fail here.
 *
 * The stub is deliberately tiny: `getElementById`, `addEventListener`, `.value`,
 * `.textContent`, `.hidden`, `.className`, `.src`, and a `fetch` that answers
 * from a fixture. That is the entire browser API the script is allowed to use,
 * and the stub is therefore also a specification of that.
 *
 * ## The rules being discriminated
 *
 * - A fetched description fills an EMPTY field.
 * - It does NOT overwrite a field the visitor typed in — including one they
 *   typed while the lookup was in flight.
 * - Every path ends with the status line saying something. No spinner survives.
 * - Nothing the script does can prevent the form from posting.
 * - The pitch cap is enforced on the SERVER: 801 characters is refused before a
 *   Dodo session is opened and before a `submissions` row is written, and the
 *   accepted value is what reaches the writer.
 */

import { FixtureDodoTransport, PRICE_TIERS, type DodoConfig, type ListingSnapshot } from '@the-pit/payments';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ListingLookup } from '@/lib/checkout/guards';
import { handleCheckoutCreate, type CheckoutHandlerDeps, type SubmissionWriter } from '@/lib/checkout/handlers';
import { EMPTY_FORM, renderSubmitPage, type SubmitPageView } from '@/lib/checkout/page';
import { PITCH_LIMIT, readPitch } from '@/lib/checkout/pitch';

import { passthroughUrlResolver } from './helpers/url-resolver.js';

const ORIGIN = 'https://thepit.show';
const CATEGORY_SLUG = 'developer-tools';
const DESCRIPTION = 'Turns meeting notes into a shared action list without anyone typing one.';

const VIEW: SubmitPageView = {
  categories: [CATEGORY_SLUG, 'health-apps'],
  tiers: PRICE_TIERS,
  values: EMPTY_FORM,
  descriptionLimit: 300,
  signedIn: false,
};

// ---------------------------------------------------------------------------
// The markup.
// ---------------------------------------------------------------------------

describe('the rendered form', () => {
  const page = renderSubmitPage(VIEW);

  it('posts to the checkout route with a plain method="post" form', () => {
    // Nothing the script does is on the submit path — no `onsubmit`, no
    // `preventDefault`, no disabled button. The button posts the form.
    expect(page).toContain('action="/api/checkout"');
    expect(page).toContain('method="post"');
    expect(page).not.toContain('onsubmit');
    expect(page).not.toContain('preventDefault');
    expect(page).toContain('<button class="act" type="submit">');
  });

  it('carries every field name POST /api/checkout reads', () => {
    for (const field of ['url', 'name', 'description', 'pitch', 'category', 'tier']) {
      expect(page).toContain(`name="${field}"`);
    }
  });

  it('labels the two text fields so the difference is visible while filling it in', () => {
    // The whole reason there are two. One is the site's copy, one is theirs.
    expect(page).toContain('What the site says');
    expect(page).toContain('Your pitch');
  });

  it('caps the pitch in the browser at the same number the server uses', () => {
    expect(page).toContain(`<textarea name="pitch" maxlength="${PITCH_LIMIT}"`);
    expect(PITCH_LIMIT).toBe(800);
  });

  it('carries the favicon slot and the status line beside the URL field', () => {
    expect(page).toMatch(/<img class="icon" id="site-icon"[^>]*hidden>/);
    expect(page).toMatch(/<span class="look" id="site-state" role="status" aria-live="polite" hidden>/);
  });

  it('echoes a pitch back into the form, escaped', () => {
    const withPitch = renderSubmitPage({
      ...VIEW,
      values: { ...EMPTY_FORM, pitch: 'We <b>win</b> & "win"' },
    });

    expect(withPitch).toContain('We &lt;b&gt;win&lt;/b&gt; &amp; &quot;win&quot;');
    expect(withPitch).not.toContain('<b>win</b>');
  });

  it('ships exactly one inline script and loads nothing from anywhere else', () => {
    const scripts = [...page.matchAll(/<script(\s[^>]*)?>/g)];

    expect(scripts).toHaveLength(1);
    expect(page).not.toMatch(/<script[^>]*\ssrc=/);
  });
});

// ---------------------------------------------------------------------------
// The DOM stub, and the script that ships.
// ---------------------------------------------------------------------------

interface StubElement {
  id: string;
  value: string;
  textContent: string;
  hidden: boolean;
  className: string;
  src: string;
  onerror: (() => void) | null;
  listeners: Map<string, (() => void)[]>;
  addEventListener(type: string, handler: () => void): void;
}

function element(id: string, value = ''): StubElement {
  return {
    id,
    value,
    textContent: '',
    hidden: true,
    className: 'urlrow',
    src: '',
    onerror: null,
    listeners: new Map(),
    addEventListener(type, handler) {
      const list = this.listeners.get(type) ?? [];
      list.push(handler);
      this.listeners.set(type, list);
    },
  };
}

/** The one `<script>` the page ships, taken out of the page the page renders. */
function shippedScript(): string {
  const match = /<script>([\s\S]*?)<\/script>/.exec(renderSubmitPage(VIEW));
  if (match === null) throw new Error('the submit page shipped no script');
  return match[1] as string;
}

interface Harness {
  readonly url: StubElement;
  readonly name: StubElement;
  readonly description: StubElement;
  readonly icon: StubElement;
  readonly row: StubElement;
  readonly state: StubElement;
  /** Every URL the script asked the endpoint about, in order. */
  readonly asked: string[];
  blur(): Promise<void>;
}

type Answer = { readonly ok: boolean; readonly body: unknown } | { readonly reject: true };

/**
 * Run the shipped script against a stub form.
 *
 * `answers` is consumed one per lookup, so a test can give a slow first answer
 * and a fast second one — which is the out-of-order case the `seq` guard exists
 * for.
 */
function harness(
  fields: { url?: string; name?: string; description?: string },
  answers: readonly Answer[],
  hooks: { readonly beforeResolve?: (h: Harness) => void } = {},
): Harness {
  const url = element('f-url', fields.url ?? '');
  const name = element('f-name', fields.name ?? '');
  const description = element('f-description', fields.description ?? '');
  const icon = element('site-icon');
  const row = element('url-row');
  const state = element('site-state');
  const form = element('pitch-form');
  const byId = new Map<string, StubElement>(
    [url, name, description, icon, row, state, form].map((el) => [el.id, el]),
  );

  const asked: string[] = [];
  let served = 0;

  const documentStub = { getElementById: (id: string): StubElement | null => byId.get(id) ?? null };
  const windowStub = {
    fetch: (_target: string, init: { body: string }): Promise<unknown> => {
      asked.push((JSON.parse(init.body) as { url: string }).url);
      const answer = answers[served] ?? { ok: false, body: null };
      served += 1;
      // The hook runs between the request and its answer: that is where a
      // visitor typing into a field mid-flight lives.
      hooks.beforeResolve?.(built);
      if ('reject' in answer) return Promise.reject(new Error('network down'));
      return Promise.resolve({ ok: answer.ok, json: () => Promise.resolve(answer.body) });
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('document', 'window', shippedScript())(documentStub, windowStub);

  const built: Harness = {
    url,
    name,
    description,
    icon,
    row,
    state,
    asked,
    async blur(): Promise<void> {
      for (const handler of url.listeners.get('blur') ?? []) handler();
      // Two microtask turns: `fetch().then().then()`.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
  return built;
}

const FOUND = {
  ok: true,
  body: {
    status: 'found',
    url: 'https://ashgrove.dev/',
    title: 'Ashgrove',
    description: 'Meeting notes to action lists.',
    faviconUrl: 'https://ashgrove.dev/icon.png',
  },
} as const;

describe('the autofill, running the script the page ships', () => {
  it('fills empty name and description from what the site said', async () => {
    const h = harness({ url: 'https://ashgrove.dev/' }, [FOUND]);

    await h.blur();

    expect(h.asked).toEqual(['https://ashgrove.dev/']);
    expect(h.name.value).toBe('Ashgrove');
    expect(h.description.value).toBe('Meeting notes to action lists.');
    expect(h.state.textContent).toContain('name and description');
    expect(h.state.hidden).toBe(false);
  });

  it('does NOT overwrite a name the visitor typed, and still fills the empty description', async () => {
    const h = harness({ url: 'https://ashgrove.dev/', name: 'Ashgrove Pro' }, [FOUND]);

    await h.blur();

    expect(h.name.value).toBe('Ashgrove Pro');
    expect(h.description.value).toBe('Meeting notes to action lists.');
    expect(h.state.textContent).toContain('description');
    expect(h.state.textContent).not.toContain('name and');
  });

  it('does NOT overwrite either field when both already hold the visitor’s words', async () => {
    const h = harness(
      { url: 'https://ashgrove.dev/', name: 'Ashgrove Pro', description: 'Mine, thank you.' },
      [FOUND],
    );

    await h.blur();

    expect(h.name.value).toBe('Ashgrove Pro');
    expect(h.description.value).toBe('Mine, thank you.');
    expect(h.state.textContent).toContain('nothing was changed');
  });

  it('does not overwrite a field the visitor typed WHILE the lookup was in flight', async () => {
    // The emptiness check is made at write time, not at request time. This is
    // the version of the rule that actually bites.
    const h = harness({ url: 'https://ashgrove.dev/' }, [FOUND], {
      beforeResolve: (live) => {
        live.description.value = 'Typed while it was thinking.';
      },
    });

    await h.blur();

    expect(h.description.value).toBe('Typed while it was thinking.');
    expect(h.name.value).toBe('Ashgrove');
  });

  it('shows the favicon beside the field and lights the row', async () => {
    const h = harness({ url: 'https://ashgrove.dev/' }, [FOUND]);

    await h.blur();

    expect(h.icon.src).toBe('https://ashgrove.dev/icon.png');
    expect(h.icon.hidden).toBe(false);
    expect(h.row.className).toBe('urlrow lit');
  });

  it('refuses a favicon that is not http(s), even if the endpoint somehow returned one', async () => {
    const h = harness({ url: 'https://ashgrove.dev/' }, [
      { ok: true, body: { ...FOUND.body, faviconUrl: 'javascript:alert(1)' } },
    ]);

    await h.blur();

    expect(h.icon.src).toBe('');
    expect(h.icon.hidden).toBe(true);
  });

  it('says nothing was found rather than leaving a spinner running', async () => {
    const h = harness({ url: 'https://ashgrove.dev/' }, [{ ok: true, body: { status: 'nothing', reason: 'timeout' } }]);

    await h.blur();

    expect(h.name.value).toBe('');
    expect(h.description.value).toBe('');
    expect(h.state.textContent).toContain('Nothing we could read');
    expect(h.state.textContent).not.toContain('Reading');
  });

  it('resolves the status line when the endpoint answers 429', async () => {
    const h = harness({ url: 'https://ashgrove.dev/' }, [{ ok: false, body: null }]);

    await h.blur();

    expect(h.state.textContent).toContain('Nothing we could read');
  });

  it('resolves the status line when the request fails outright, and allows a retry', async () => {
    const h = harness({ url: 'https://ashgrove.dev/' }, [{ reject: true }, FOUND]);

    await h.blur();
    expect(h.state.textContent).toContain('Nothing we could read');

    // `last` was cleared on failure, so the same value is asked about again.
    await h.blur();
    expect(h.asked).toEqual(['https://ashgrove.dev/', 'https://ashgrove.dev/']);
    expect(h.name.value).toBe('Ashgrove');
  });

  it('asks once for an unchanged value, so tabbing through a filled form costs nothing', async () => {
    const h = harness({ url: 'https://ashgrove.dev/' }, [FOUND, FOUND]);

    await h.blur();
    await h.blur();
    await h.blur();

    expect(h.asked).toEqual(['https://ashgrove.dev/']);
  });

  it('asks about nothing at all for an empty or non-http field', async () => {
    expect((await withBlur({ url: '' })).asked).toEqual([]);
    expect((await withBlur({ url: 'ashgrove.dev' })).asked).toEqual([]);
    expect((await withBlur({ url: 'javascript:alert(1)' })).asked).toEqual([]);

    async function withBlur(fields: { url: string }): Promise<Harness> {
      const h = harness(fields, [FOUND]);
      await h.blur();
      return h;
    }
  });
});

// ---------------------------------------------------------------------------
// The pitch cap, on the server.
// ---------------------------------------------------------------------------

class RecordingWriter implements SubmissionWriter {
  readonly rows: { pitch: string | null; description: string }[] = [];

  create(draft: { pitch: string | null; description: string }): Promise<string> {
    this.rows.push({ pitch: draft.pitch, description: draft.description });
    return Promise.resolve('11111111-2222-4333-8444-555555555555');
  }
}

class NoListings implements ListingLookup {
  findByNormalizedUrl(): Promise<ListingSnapshot | null> {
    return Promise.resolve(null);
  }
}

const CONFIG: DodoConfig = {
  mode: 'test',
  webhookSecret: 'whsec_' + Buffer.from('a-thirty-two-byte-endpoint-secret').toString('base64'),
  productIds: { prod_single: 'single', prod_triple: 'triple' },
  returnUrl: `${ORIGIN}/checkout/success`,
};

let writer: RecordingWriter;
let transport: FixtureDodoTransport;
let deps: CheckoutHandlerDeps;

beforeEach(() => {
  writer = new RecordingWriter();
  transport = new FixtureDodoTransport();
  deps = {
    config: CONFIG,
    transport,
    submissions: writer,
    guards: {
      listings: new NoListings(),
      resolveUrl: passthroughUrlResolver(),
      candidateCategories: () => Promise.resolve([CATEGORY_SLUG, 'health-apps']),
    },
    now: () => new Date('2026-06-01T20:00:00.000Z'),
  };
});

function post(pitch: string, accept = 'text/html'): Request {
  return new Request(`${ORIGIN}/api/checkout`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept },
    body: new URLSearchParams({
      url: 'https://ashgrove.dev/',
      name: 'Ashgrove',
      description: DESCRIPTION,
      pitch,
      category: CATEGORY_SLUG,
      tier: 'single',
    }).toString(),
  });
}

describe('the pitch cap is enforced on the server, not only in the browser', () => {
  it('stores a pitch inside the cap, on the row that crosses Dodo', async () => {
    const pitch = 'x'.repeat(PITCH_LIMIT);

    const response = await handleCheckoutCreate(post(pitch), deps);

    expect(response.status).toBe(303);
    expect(writer.rows).toHaveLength(1);
    expect(writer.rows[0]?.pitch).toBe(pitch);
    // And it did NOT become the description. That separation is the whole point.
    expect(writer.rows[0]?.description).toBe(DESCRIPTION);
  });

  it('refuses 801 characters — before a Dodo session and before a submissions row', async () => {
    const response = await handleCheckoutCreate(post('x'.repeat(PITCH_LIMIT + 1)), deps);

    expect(response.status).toBe(422);
    // The two assertions that make the status mean something.
    expect(writer.rows).toEqual([]);
    expect(transport.calls).toEqual([]);
  });

  it('says why, on the form the visitor is looking at, and says nothing was charged', async () => {
    const body = await (await handleCheckoutCreate(post('x'.repeat(1200)), deps)).text();

    expect(body).toContain('1200 characters');
    expect(body).toContain(String(PITCH_LIMIT));
    expect(body).toContain('nothing was charged');
    // Their text is still in the form, so fixing it is an edit and not a retype.
    expect(body).toContain('Ashgrove');
  });

  it('answers an API caller with a code rather than a page', async () => {
    const response = await handleCheckoutCreate(post('x'.repeat(801), 'application/json'), deps);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(422);
    expect(body['code']).toBe('pitch_too_long');
    expect(body['limit']).toBe(PITCH_LIMIT);
    expect(body['charged']).toBe(false);
  });

  it('accepts an empty pitch as null, which is not the same as an empty claim', async () => {
    await handleCheckoutCreate(post('   '), deps);

    expect(writer.rows[0]?.pitch).toBeNull();
    expect(readPitch('')).toEqual({ ok: true, pitch: null });
    expect(readPitch('  spaced  ')).toEqual({ ok: true, pitch: 'spaced' });
  });

  it('measures the TRIMMED value, so trailing whitespace is not a rejection', async () => {
    const pitch = 'x'.repeat(PITCH_LIMIT) + '   \n  ';

    const response = await handleCheckoutCreate(post(pitch), deps);

    expect(response.status).toBe(303);
    expect(writer.rows[0]?.pitch).toBe('x'.repeat(PITCH_LIMIT));
  });
});
