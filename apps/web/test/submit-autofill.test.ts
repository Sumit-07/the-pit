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
 * `.textContent`, `.hidden`, `.src`, a `fetch` that answers from a fixture, and
 * a `setTimeout`/`clearTimeout` pair over a fake clock. That is the entire
 * browser API the script is allowed to use, and the stub is therefore also a
 * specification of that.
 *
 * The clock is stubbed rather than real. A debounce tested by sleeping is a test
 * that is slow AND flaky; `tick(ms)` fires what the script scheduled, so the
 * pause is asserted rather than waited out.
 *
 * ## The rules being discriminated
 *
 * - **`linear.app` is looked up.** A bare domain is what people type, and the
 *   version of this script that shipped tested the raw value against
 *   `/^https?:\/\//` and returned — no request, no icon, no status line, on the
 *   commonest input there is. That test is first in the file, and it fails
 *   against the code it replaced, as do the ones for `www.`, a path, a trailing
 *   slash and the whitespace around a paste.
 * - **Nothing returns undecided.** Garbage says it is garbage, a half-typed host
 *   clears the line rather than narrating itself, an emptied field clears the
 *   line and the icon, and the rate limit says it is the rate limit. Every one of
 *   those was previously a `return` that left whatever was on screen there.
 * - **The pause is a pause.** A burst of keystrokes is one lookup, fired after
 *   they stop; a paste does not wait for it; `blur` still works for a tab away.
 * - A fetched description fills an EMPTY field.
 * - It does NOT overwrite a field the visitor typed in — including one they
 *   typed while the lookup was in flight.
 * - A slow answer never paints over a newer one, and an answer that arrives
 *   after the field was cleared paints nothing at all.
 * - Nothing the script does can prevent the form from posting — including the
 *   scheme it writes back on blur, which is there so `type="url"` validation
 *   does not refuse at the button what the script accepted at the door.
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
    expect(page).toMatch(/<button class="act" type="submit" id="pay">/);
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

  it('ships only inline scripts and loads nothing from anywhere else', () => {
    // One, on a view with no panels: the autofill. There used to be a second,
    // repricing the button as the tier radios moved, and it went with them — one
    // price needs no script to state it. The number is not the property, though —
    // the property is that every one of them is INLINE, so nothing on the buying
    // page waits on another origin before it can post.
    const scripts = [...page.matchAll(/<script(\s[^>]*)?>/g)];

    expect(scripts).toHaveLength(1);
    expect(scripts.every((match) => match[1] === undefined)).toBe(true);
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

type Answer =
  | { readonly ok: boolean; readonly status?: number; readonly body: unknown }
  | { readonly reject: true };

/**
 * An answer the harness holds until the test hands it over.
 *
 * The out-of-order case cannot be written with promises that resolve in call
 * order, because that is the case that never happens in a browser. `'hold'`
 * parks the request; `deliver(n, answer)` is what lets a test answer the SECOND
 * lookup first and then watch the first one land into a form it must not touch.
 */
type Scripted = Answer | 'hold';

interface Harness {
  readonly url: StubElement;
  readonly name: StubElement;
  readonly description: StubElement;
  readonly icon: StubElement;
  readonly state: StubElement;
  /** Every URL the script asked the endpoint about, in order. */
  readonly asked: string[];
  /** Type into the field, the way a keyboard does: value first, then `input`. */
  type(value: string): Promise<void>;
  /** Paste into the field: `paste` fires first, and the value lands after it. */
  paste(value: string): Promise<void>;
  /** Move the wall clock, firing anything the script had scheduled. */
  tick(ms: number): Promise<void>;
  blur(): Promise<void>;
  change(): Promise<void>;
  /** Hand over a held answer, by the index of the request it belongs to. */
  deliver(index: number, answer: Answer): Promise<void>;
}

/** Four turns: `fetch().then().then()`, plus room for the `catch`. */
async function flush(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

/**
 * Run the shipped script against a stub form and a stub clock.
 *
 * `answers` is consumed one per lookup, so a test can give a slow first answer
 * and a fast second one — which is the out-of-order case the `seq` guard exists
 * for. The clock is stubbed rather than real: a 600ms debounce that a test slept
 * through would add six seconds to the suite and would still be a race.
 */
function harness(
  fields: { url?: string; name?: string; description?: string },
  answers: readonly Scripted[],
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

  let clock = 0;
  let nextTimer = 1;
  const scheduled = new Map<number, { at: number; fire: () => void }>();
  const held = new Map<number, (answer: Answer) => void>();

  function settled(answer: Answer): Promise<unknown> {
    if ('reject' in answer) return Promise.reject(new Error('network down'));
    return Promise.resolve({
      ok: answer.ok,
      status: answer.status ?? 200,
      json: () => Promise.resolve(answer.body),
    });
  }

  const documentStub = { getElementById: (id: string): StubElement | null => byId.get(id) ?? null };
  const windowStub = {
    fetch: (_target: string, init: { body: string }): Promise<unknown> => {
      const index = served;
      asked.push((JSON.parse(init.body) as { url: string }).url);
      const answer = answers[served] ?? { ok: false, body: null };
      served += 1;
      // The hook runs between the request and its answer: that is where a
      // visitor typing into a field mid-flight lives.
      hooks.beforeResolve?.(built);
      if (answer === 'hold') {
        return new Promise((resolve, reject) => {
          held.set(index, (given) => {
            if ('reject' in given) reject(new Error('network down'));
            else resolve({ ok: given.ok, status: given.status ?? 200, json: () => Promise.resolve(given.body) });
          });
        });
      }
      return settled(answer);
    },
    setTimeout: (fire: () => void, ms: number): number => {
      const id = nextTimer;
      nextTimer += 1;
      scheduled.set(id, { at: clock + ms, fire });
      return id;
    },
    clearTimeout: (id: number): void => {
      scheduled.delete(id);
    },
  };

  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('document', 'window', shippedScript())(documentStub, windowStub);

  function fireEvent(el: StubElement, type: string): void {
    for (const handler of el.listeners.get(type) ?? []) handler();
  }

  const built: Harness = {
    url,
    name,
    description,
    icon,
    state,
    asked,
    async type(value: string): Promise<void> {
      url.value = value;
      fireEvent(url, 'input');
      await flush();
    },
    async paste(value: string): Promise<void> {
      fireEvent(url, 'paste');
      url.value = value;
      fireEvent(url, 'input');
      await flush();
    },
    async tick(ms: number): Promise<void> {
      clock += ms;
      for (const [id, timer] of [...scheduled]) {
        if (timer.at <= clock) {
          scheduled.delete(id);
          timer.fire();
        }
      }
      await flush();
    },
    async blur(): Promise<void> {
      fireEvent(url, 'blur');
      await flush();
    },
    async change(): Promise<void> {
      fireEvent(url, 'change');
      await flush();
    },
    async deliver(index: number, answer: Answer): Promise<void> {
      const give = held.get(index);
      if (give === undefined) throw new Error(`no request ${index} is waiting for an answer`);
      held.delete(index);
      give(answer);
      await flush();
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

/** Long enough that every debounce the script can schedule has fired. */
const PAUSE = 700;

describe('what a person actually types, running the script the page ships', () => {
  it('looks up a bare domain — the case that used to do nothing at all', async () => {
    // This is the bug. `linear.app` is what somebody types when a form asks for
    // a web address, and the old script tested the raw value against
    // /^https?:\/\// and returned: no request, no icon, no status line.
    const h = harness({}, [FOUND]);

    await h.type('linear.app');
    await h.tick(PAUSE);

    expect(h.asked).toEqual(['https://linear.app/']);
    expect(h.state.hidden).toBe(false);
    expect(h.name.value).toBe('Ashgrove');
  });

  it('normalizes www., a path and a trailing slash to one URL each', async () => {
    expect((await lookedUp('www.example.com')).asked).toEqual(['https://www.example.com/']);
    expect((await lookedUp('example.com/path')).asked).toEqual(['https://example.com/path']);
    expect((await lookedUp('example.com/')).asked).toEqual(['https://example.com/']);
    expect((await lookedUp('  example.com  ')).asked).toEqual(['https://example.com/']);
    expect((await lookedUp('HTTPS://Example.com')).asked).toEqual(['https://example.com/']);
    expect((await lookedUp('http://example.com/x?utm=1')).asked).toEqual(['http://example.com/x?utm=1']);
  });

  it('treats the schemed and schemeless spellings of one address as one lookup', async () => {
    const h = harness({}, [FOUND, FOUND]);

    await h.type('linear.app');
    await h.tick(PAUSE);
    await h.type('https://linear.app');
    await h.tick(PAUSE);
    await h.blur();

    expect(h.asked).toEqual(['https://linear.app/']);
  });

  it('says the value is not an address rather than returning silently', async () => {
    const h = harness({}, [FOUND]);

    await h.type('not a url');
    await h.tick(PAUSE);

    expect(h.asked).toEqual([]);
    expect(h.state.hidden).toBe(false);
    expect(h.state.textContent).toContain('does not look like a web address');
  });

  it('refuses a scheme that is not http(s), out loud', async () => {
    for (const value of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'ftp://example.com']) {
      const h = harness({}, [FOUND]);

      await h.type(value);
      await h.tick(PAUSE);

      expect(h.asked).toEqual([]);
      expect(h.state.textContent).toContain('does not look like a web address');
    }
  });

  it('says nothing at all about a half-typed host, and calls it wrong once they leave', async () => {
    const h = harness({}, [FOUND]);

    await h.type('linear');
    await h.tick(PAUSE);

    // No lookup, and no sentence either. The line used to narrate the field back
    // at the person filling it in ("Waiting for the rest of the address"); blank
    // is the honest state for "they are mid-word", and it is a DECIDED blank —
    // the icon is gone and the line is hidden rather than left holding a stale
    // answer about the previous value.
    expect(h.asked).toEqual([]);
    expect(h.state.textContent).toBe('');
    expect(h.state.hidden).toBe(true);
    expect(h.icon.hidden).toBe(true);

    // Leaving the field with it is a different statement: they are done, and it
    // is not an address.
    await h.blur();
    expect(h.state.textContent).toContain('does not look like a web address');
  });

  it('says it is reading BEFORE the answer arrives, so a slow first fetch reads as alive', async () => {
    const h = harness({}, ['hold']);

    await h.type('linear.app');
    await h.tick(PAUSE);

    expect(h.asked).toEqual(['https://linear.app/']);
    expect(h.state.hidden).toBe(false);
    expect(h.state.textContent).toBe('Reading linear.app…');

    await h.deliver(0, FOUND);
    expect(h.state.textContent).not.toContain('Reading');
  });

  it('asks once for a burst of keystrokes, on the pause at the end of it', async () => {
    const h = harness({}, [FOUND]);

    await h.type('lin');
    await h.tick(200);
    await h.type('linear.a');
    await h.tick(200);
    await h.type('linear.app');
    expect(h.asked).toEqual([]);

    await h.tick(PAUSE);
    expect(h.asked).toEqual(['https://linear.app/']);
  });

  it('acts on a paste without waiting out the typing pause', async () => {
    const h = harness({}, [FOUND]);

    await h.paste('https://ashgrove.dev/');
    await h.tick(100);

    expect(h.asked).toEqual(['https://ashgrove.dev/']);
  });

  it('still fires on blur, for a field left by tab or by click', async () => {
    const h = harness({ url: 'ashgrove.dev' }, [FOUND]);

    await h.blur();

    expect(h.asked).toEqual(['https://ashgrove.dev/']);
    expect(h.description.value).toBe('Meeting notes to action lists.');
  });

  it('writes the scheme back into the field, so the browser will let the form post', async () => {
    // `type="url" required` refuses a bare host at submit time. Accepting one at
    // the door and then having the browser refuse it at the button is the same
    // silent dead end, moved.
    const h = harness({ url: '  linear.app  ' }, [FOUND]);

    await h.blur();

    expect(h.url.value).toBe('https://linear.app');
    expect(h.asked).toEqual(['https://linear.app/']);
  });

  it('leaves a value that is not an address exactly as typed', async () => {
    const h = harness({ url: 'not a url' }, [FOUND]);

    await h.blur();

    expect(h.url.value).toBe('not a url');
    expect(h.asked).toEqual([]);
  });
});

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
    // It says what it did and stops. The old line went on to explain that the
    // visitor's own words were already there, which they can see.
    expect(h.state.textContent).toBe('Read ashgrove.dev.');
    expect(h.state.textContent).not.toContain('filled in');
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

  it('shows the favicon beside the field', async () => {
    const h = harness({ url: 'https://ashgrove.dev/' }, [FOUND]);

    await h.blur();

    expect(h.icon.src).toBe('https://ashgrove.dev/icon.png');
    expect(h.icon.hidden).toBe(false);
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
    expect(h.state.textContent).toContain('Nothing we could read at ashgrove.dev');
    expect(h.state.textContent).not.toContain('Reading');
  });

  it('says the rate limit is the rate limit, and not that the site is unreadable', async () => {
    // A 429 reported as "nothing we could read there" describes every site in a
    // row as broken, which is how a working fetcher gets reported as a bug.
    const h = harness({ url: 'https://ashgrove.dev/' }, [
      { ok: false, status: 429, body: { status: 'limited', retryAfterSeconds: 42 } },
    ]);

    await h.blur();

    expect(h.state.textContent).toContain('Too many lookups');
    expect(h.state.textContent).not.toContain('Nothing we could read');
    // And it is retryable: the wall comes down on its own.
    await h.blur();
    expect(h.asked).toHaveLength(2);
  });

  it('resolves the status line when the endpoint answers some other failure', async () => {
    const h = harness({ url: 'https://ashgrove.dev/' }, [{ ok: false, status: 500, body: null }]);

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
    await h.change();

    expect(h.asked).toEqual(['https://ashgrove.dev/']);
  });

  it('asks about nothing at all for an empty field', async () => {
    const h = harness({ url: '' }, [FOUND]);

    await h.blur();
    await h.type('');
    await h.tick(PAUSE);

    expect(h.asked).toEqual([]);
    expect(h.state.hidden).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The two ways a stale answer can lie: out of order, and after a clear.
// ---------------------------------------------------------------------------

describe('a stale answer never paints over a newer one', () => {
  it('drops a slow FIRST response that lands after a fast second one', async () => {
    const h = harness({}, ['hold', 'hold']);

    await h.type('slow.example');
    await h.tick(PAUSE);
    await h.type('fast.example');
    await h.tick(PAUSE);

    expect(h.asked).toEqual(['https://slow.example/', 'https://fast.example/']);

    // The second lookup answers first — the ordinary case on a real network.
    await h.deliver(1, {
      ok: true,
      body: { status: 'found', url: 'https://fast.example/', title: 'Fast', description: 'The one they meant.' },
    });
    expect(h.name.value).toBe('Fast');

    // And now the first one lands. It must change nothing at all.
    await h.deliver(0, {
      ok: true,
      body: {
        status: 'found',
        url: 'https://slow.example/',
        title: 'Slow',
        description: 'The typo.',
        faviconUrl: 'https://slow.example/icon.png',
      },
    });

    expect(h.name.value).toBe('Fast');
    expect(h.description.value).toBe('The one they meant.');
    expect(h.state.textContent).toContain('fast.example');
    expect(h.icon.src).toBe('');
  });

  it('clears the icon and the line when the URL is cleared, and ignores the answer still in flight', async () => {
    const h = harness({}, [FOUND, 'hold']);

    await h.type('ashgrove.dev');
    await h.tick(PAUSE);
    expect(h.icon.hidden).toBe(false);
    expect(h.state.hidden).toBe(false);

    // Select-all, delete. Immediately — no waiting on a debounce to notice.
    await h.type('');

    expect(h.icon.hidden).toBe(true);
    expect(h.state.textContent).toBe('');
    expect(h.state.hidden).toBe(true);

    // The two text fields keep what is in them: the visitor may have edited the
    // words we offered, and an emptied URL is not a reason to take them back.
    expect(h.name.value).toBe('Ashgrove');

    // A second lookup that was already in flight when they cleared must not put
    // a status line, an icon or another site's copy onto an empty field.
    await h.type('other.example');
    await h.tick(PAUSE);
    await h.type('');
    await h.deliver(1, {
      ok: true,
      body: {
        status: 'found',
        url: 'https://other.example/',
        title: 'Other',
        description: 'Somewhere else entirely.',
        faviconUrl: 'https://other.example/icon.png',
      },
    });

    expect(h.state.hidden).toBe(true);
    expect(h.icon.hidden).toBe(true);
    expect(h.name.value).toBe('Ashgrove');
    expect(h.description.value).toBe('Meeting notes to action lists.');
  });

  it('drops the old site’s favicon the moment a different host is looked up', async () => {
    const h = harness({}, [FOUND, 'hold']);

    await h.type('ashgrove.dev');
    await h.tick(PAUSE);
    expect(h.icon.hidden).toBe(false);

    await h.type('linear.app');
    await h.tick(PAUSE);

    // Reading linear.app, so ashgrove.dev's icon is gone rather than sitting
    // beside a URL it does not belong to.
    expect(h.icon.hidden).toBe(true);
    expect(h.state.textContent).toBe('Reading linear.app…');
  });
});

async function lookedUp(value: string): Promise<Harness> {
  const h = harness({}, [FOUND]);
  await h.type(value);
  await h.tick(PAUSE);
  return h;
}


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
  productIds: { prod_single: 'single' },
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

  it('names both numbers on the form the visitor is looking at, and nothing else', async () => {
    const body = await (await handleCheckoutCreate(post('x'.repeat(1200)), deps)).text();

    // What they typed, and what they are allowed. The test above this one is the
    // one that proves nothing was charged, and it proves it from the ledger of
    // rows and transport calls rather than from a sentence promising it.
    expect(body).toContain('1200 characters');
    expect(body).toContain(String(PITCH_LIMIT));
    expect(body).not.toMatch(/trim it and try again/i);
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
