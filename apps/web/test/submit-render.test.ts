/**
 * The form renders on a server with nothing wired, and the money path does not.
 *
 * Two faults, one boundary. `GET /submit` called `checkoutDeps()`, which throws
 * `PaymentsNotWiredError` without a `DATABASE_URL` — so the single page a
 * visitor has to see before they can pay answered 500 on any deployment whose
 * database was not yet bound. That is a read path pulling in a write path's
 * wiring, the same fault `/boards` was fixed for, on the highest-value read in
 * the product. `brief §2.1` promises nothing sits between a visitor and their
 * purchase; a 500 is the largest possible something.
 *
 * So every test here runs with `DATABASE_URL`, `DODO_WEBHOOK_SECRET` and
 * `DODO_API_KEY` deleted from the environment, and asserts both halves:
 *
 *   GET  /submit        200, with a rendered form            <- was 500
 *   POST /api/checkout  PaymentsNotWiredError naming DATABASE_URL  <- unchanged
 *   GET  /account       401, the signed-out page             <- was 500
 *
 * The `POST` assertions are as important as the `GET` ones. Making the form
 * render is only correct if the refusal it used to inherit is still raised where
 * money would actually move; a "fix" that made `checkoutDeps()` lazy or
 * tolerant would move a boot-time failure to the first paid request, which is
 * the failure `instrumentation.ts` exists to prevent.
 *
 * ## Nothing here opens a handle, and that is checked rather than assumed
 *
 * `createDatabase` is replaced with a function that throws. `hasDatabaseUrl`,
 * the schema and everything else in `@the-pit/db` are the real ones, so the
 * refusal path is genuine — but any code on the `GET` path that reached for a
 * connection detonates by name instead of quietly succeeding against whatever
 * `DATABASE_URL` happened to be exported into the test run.
 *
 * ## The fields are asserted by NAME, not by copy
 *
 * `name="url"`, `name="name"`, `name="description"`, `name="category"` and
 * `name="tier"` are the form's contract with `POST /api/checkout` — they are
 * what `readValues` reads. Labels, headings and prices are being reworked
 * elsewhere and are not asserted, with one exception: the tier VALUE and its
 * amount come from `PRICE_TIERS` in `@the-pit/payments`, which is `brief §2.3`'s
 * rule and not the theme's.
 *
 * Hand-derived, from `packages/payments/src/money.ts`:
 *
 *   single   500 cents   formatUsd -> "$5.00"    the only thing on sale
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Every `createDatabase` in the app comes through here. A `GET` that opened a
 * pool would throw this message rather than pass for the wrong reason.
 */
vi.mock('@the-pit/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@the-pit/db')>();
  return {
    ...actual,
    createDatabase: (): never => {
      throw new Error('a /submit render opened a database connection');
    },
  };
});

// Statically imported, all of it. The app graph reaches `@the-pit/engine` and
// costs seconds to load the first time; paying that inside a `beforeEach` makes
// the first test in the file fail on the hook timeout and nothing else.
import { acceptAllClassifier, PRICE_TIERS, seededCategoryClassifier } from '@the-pit/payments';
import * as payments from '@the-pit/payments';

import { POST as checkoutPost } from '@/app/api/checkout/route';
import { GET as accountGet } from '@/app/account/route';
import { GET as submitGet } from '@/app/submit/route';
import { accountDeps } from '@/lib/account/config';
import { handleAccountPage } from '@/lib/account/handlers';
import { resetAuthWiring } from '@/lib/auth/config';
import { checkoutDeps, resetCheckoutWiring, submitPageDeps } from '@/lib/checkout/config';
import { PaymentsNotWiredError, resetPaymentsWiring } from '@/lib/payments/config';

/** Long enough for `assertUsableKeyring`; the same shape the other suites use. */
const KEYRING_SECRET = 'test-secret-0123456789abcdef0123456789abcdef0123456789abcdef01';

const ORIGIN = 'https://thepit.show';

/** Everything the money path is wired from, and the session secret beside it. */
const MANAGED = [
  'DATABASE_URL',
  'DODO_WEBHOOK_SECRET',
  'DODO_API_KEY',
  'DODO_MODE',
  'DODO_PRODUCT_SINGLE',
  'SESSION_SECRET',
  'SESSION_SECRET_PREVIOUS',
  'AUTH_DEV_MEMORY_STORE',
  'APP_ORIGIN',
] as const;

const saved = new Map<string, string | undefined>();

function resetWiring(): void {
  resetCheckoutWiring();
  resetPaymentsWiring();
  resetAuthWiring();
}

beforeEach(() => {
  for (const key of MANAGED) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env['APP_ORIGIN'] = ORIGIN;
  resetWiring();
});

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
  resetWiring();
});

/** Call a route export that may throw synchronously or reject. One shape either way. */
async function attempt(call: () => Promise<Response>): Promise<{ response?: Response; error?: unknown }> {
  try {
    return { response: await call() };
  } catch (error) {
    return { error };
  }
}

async function renderSubmit(url = `${ORIGIN}/submit`): Promise<{ status: number; body: string }> {
  const result = await attempt(() => submitGet(new Request(url)));
  if (result.error !== undefined) {
    throw new Error(
      `GET /submit threw instead of rendering: ${
        result.error instanceof Error ? `${result.error.name}: ${result.error.message}` : String(result.error)
      }`,
    );
  }
  const response = result.response as Response;
  return { status: response.status, body: await response.text() };
}

// ---------------------------------------------------------------------------
// GET /submit — the form, on a server with no database.
// ---------------------------------------------------------------------------

describe('GET /submit renders with no DATABASE_URL', () => {
  it('answers 200 through the real route module', async () => {
    expect(process.env['DATABASE_URL']).toBeUndefined();

    const page = await renderSubmit();

    expect(page.status).toBe(200);
  });

  it('renders a document and not an empty body', async () => {
    // A 200 with nothing in it is not a rendered form. This is the assertion
    // that makes the status above mean something.
    const page = await renderSubmit();

    expect(page.body.length).toBeGreaterThan(1000);
    expect(page.body).toContain('<!doctype html>');
    expect(page.body).toContain('</html>');
  });

  it('carries the four fields brief §2.1 promises: URL, name, description, category', async () => {
    const page = await renderSubmit();

    // The names `readValues` reads. Not the labels, which are being retyped.
    expect(page.body).toContain('name="url"');
    expect(page.body).toContain('name="name"');
    expect(page.body).toContain('name="description"');
    expect(page.body).toContain('name="category"');

    // And each one is the control it has to be for a no-JavaScript post.
    expect(page.body).toMatch(/<input[^>]*type="url"[^>]*name="url"/);
    expect(page.body).toMatch(/<textarea[^>]*name="description"/);
    expect(page.body).toMatch(/<select[^>]*name="category"/);
  });

  it('carries the tier as a value, not as a choice, because there is one price', async () => {
    const page = await renderSubmit();

    // One tier on sale, so the form states it and posts it. A radio group of one
    // is a control nobody can operate that still asks to be operated.
    expect(PRICE_TIERS.map((tier) => tier.id)).toEqual(['single']);
    expect(page.body).toContain('<input type="hidden" name="tier" value="single">');
    expect(page.body).not.toMatch(/<input type="radio" name="tier"/);

    // $5, from `brief §2.3`, and nothing else priced anywhere on the page.
    expect(PRICE_TIERS.map((tier) => tier.amountCents)).toEqual([500]);
    expect(page.body).toContain('$5.00');
    expect(page.body).not.toContain('$15');
  });

  it('sells no fit report and offers no second tier anywhere in the copy', async () => {
    const page = await renderSubmit();
    expect(page.body).not.toMatch(/fit report/i);
    expect(page.body).not.toMatch(/three throws/i);
    expect(page.body).not.toContain('triple');
  });

  it('names the price on the button, server-rendered, with no script to keep it right', async () => {
    // The button is the one thing on the page that is a number of dollars, so it
    // is rendered from `PRICE_TIERS` rather than written out — and with one price
    // it needs no client script to stay in step with a radio.
    const page = await renderSubmit();
    expect(page.body).toContain('>Take my $5 →</button>');
    expect(page.body).not.toContain('Take my $15');
    expect(page.body).not.toContain('data-pay=');
  });

  it('posts to the checkout route, and nothing on the page intercepts that', async () => {
    // This assertion used to be `not.toContain('<script')`, on the strength of a
    // doc comment that read `brief §2.1` — "no login at submission; nothing sits
    // between a visitor and their purchase" — as a ban on scripting. §2.1 is
    // about AUTHENTICATION. The inference was somebody's, not the founder's, and
    // it has been retired: the page now carries one inline script that fills the
    // name and description in from the product's own page.
    //
    // What replaces it is the property that was actually worth protecting. The
    // form posts itself: no handler intercepts the submit, no script disables
    // the button, and nothing is loaded from another origin before it can.
    const page = await renderSubmit();

    expect(page.body).toContain('method="post" action="/api/checkout"');
    expect(page.body).toMatch(/<button class="act" type="submit" id="pay">/);
    expect(page.body).not.toContain('onsubmit');
    expect(page.body).not.toContain('preventDefault');
    expect(page.body).not.toMatch(/<script[^>]*\ssrc=/);
  });

  it('offers the free door FIRST, on the same form, with one email field', async () => {
    // `DECISIONS.md` S15-free. One form, five fields and two submit buttons: the
    // free one carries `formaction`, the $5 one rides the form's own action.
    const page = await renderSubmit();

    expect(page.body).toContain('formaction="/api/free"');
    expect(page.body).toContain('Throw it in &middot; free →');
    expect(page.body).toContain('name="email"');
    expect(page.body).toMatch(/<input type="email" name="email"/);

    // FIRST in tree order, which is what makes it the form's default button —
    // pressing Enter on a phone keyboard takes the free path rather than the
    // paid one. If these ever swap, the page silently starts charging people who
    // never reached for a button.
    expect(page.body.indexOf('formaction="/api/free"')).toBeLessThan(page.body.indexOf('id="pay"'));
  });

  it('does not require the address, because that would block the $5 button', async () => {
    // One form, two doors: `required` on a field only one of them reads would
    // stop the browser submitting the other. The server decides instead.
    const page = await renderSubmit();
    const field = /<input type="email" name="email"[^>]*>/.exec(page.body)?.[0] ?? '';

    expect(field).not.toContain('required');
    // The whole phone story, in one attribute.
    expect(field).toContain('autocomplete="email"');
  });

  it('says which button buys which byline, under the control that sets it', async () => {
    // S17 is unchanged and a free run has only one of the two on offer. Saying it
    // here is what stops somebody picking the robot, pressing the free button and
    // finding their name on the board.
    const page = await renderSubmit();
    expect(page.body).toContain('Free throws publish under the product’s name. $5 buys the robot.');
  });

  it('carries the pitch field beside the description, labelled differently', async () => {
    const page = await renderSubmit();

    expect(page.body).toContain('name="pitch"');
    // Two fields, two labels. "What the site says" is fetched; the pitch is
    // theirs. A form that called both of them the same thing would be the one
    // field this change exists to stop being.
    expect(page.body).toContain('What the site says');
    expect(page.body).toContain('Your pitch');
  });

  it('carries the byline control, with “under your name” pre-selected', async () => {
    // The choice `products.anonymity` has been frozen against since `0009` and
    // that nothing offered to a customer until now. It renders on the page that
    // takes the money, on a deployment with nothing wired: the control reads no
    // row and the designation it illustrates is generated from a seed, so adding
    // it must not have put a database back on this render path.
    const page = await renderSubmit();

    const radios = [...page.body.matchAll(/<input type="radio" name="anonymous" value="([a-z]+)"( checked)?>/g)];
    expect(radios.map((match) => match[1])).toEqual(['named', 'anonymous']);
    // The default, stated on the page rather than inherited from an unchecked box.
    expect(radios[0]?.[2]).toBe(' checked');
    expect(radios[1]?.[2]).toBeUndefined();
  });

  it('states what is withheld, that the choice is frozen, and the way back', async () => {
    // The copy is load-bearing here in a way it is not elsewhere on the form: this
    // is a decision made once, before the buyer knows their result, that no later
    // code path will offer to change. What has to be on the page is the TERMS —
    // what is withheld, when it stops being changeable, and the one door back. The
    // page used to argue each of them as well, over four paragraphs; the argument
    // is gone and the terms are not, which is what this test now pins.
    const page = await renderSubmit();
    const text = page.body.replaceAll('&#39;', "'").replaceAll('&amp;', '&').replaceAll('&rsquo;', '’');

    // 1. what is withheld — and that it is only that.
    expect(text).toContain('Your name and your address are withheld. Nothing else is.');
    // 2. when it stops being changeable.
    expect(text).toContain('changed after scoring');
    // 3. the robot, and that the designation is stable.
    expect(text).toMatch(/Unit [A-Za-z]+-\d{3}/);
    expect(text).toContain('Yours stays the same everywhere');
    // 4. the one door back, and what it does not reach.
    expect(text).toContain('GitHub');
    expect(text).toContain('Past verdicts keep the robot');

    // And it does not apologise for the option it is selling: no paragraph here
    // defends the choice, and none says the buyer is not hiding.
    expect(text).not.toContain('not hiding');
    expect(text).not.toMatch(/that is on purpose/i);
  });

  it('prefills from the query string without needing anything wired', async () => {
    // The "pitch this" link from a board lands here. It is a read of `req.url`
    // and nothing else, and it must survive the unwired case too.
    const page = await renderSubmit(`${ORIGIN}/submit?url=https%3A%2F%2Fashgrove.dev&tier=triple`);

    expect(page.status).toBe(200);
    expect(page.body).toContain('value="https://ashgrove.dev"');
    // The tier is NOT prefillable. A link that named a withdrawn tier would
    // render a form that cannot be posted; the page renders the one price it
    // sells and `POST /api/checkout` is what refuses anything else.
    expect(page.body).toContain('<input type="hidden" name="tier" value="single">');
  });

  it('renders as a guest when SESSION_SECRET is missing rather than failing', async () => {
    // No secret means no cookie can be valid, which is the ordinary guest
    // checkout — not an error, and certainly not a 500 on the buying path.
    expect(process.env['SESSION_SECRET']).toBeUndefined();

    const page = await renderSubmit();

    expect(page.status).toBe(200);
    expect(page.body).toContain('name="url"');
  });

  it('resolves its dependencies with no config, and holds none of the write path', () => {
    const deps = submitPageDeps() as unknown as Record<string, unknown>;

    expect(typeof deps['candidateCategories']).toBe('function');
    // The absence IS the guarantee. A GET handler holding any of these would be
    // a GET handler that could open a checkout or write a submissions row.
    expect(deps['transport']).toBeUndefined();
    expect(deps['submissions']).toBeUndefined();
    expect(deps['config']).toBeUndefined();
    expect(deps['guards']).toBeUndefined();
  });

  it('lists categories from the snapshot sink, which is JSON and not a table', async () => {
    // Reaching a database here throws the mocked `createDatabase` message.
    const categories = await submitPageDeps().candidateCategories();

    expect(Array.isArray(categories)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// POST /api/checkout — unchanged, and still loud.
// ---------------------------------------------------------------------------

describe('POST /api/checkout still refuses loudly when the database is unwired', () => {
  async function post(): Promise<{ response?: Response; error?: unknown }> {
    const body = new URLSearchParams({
      url: 'https://ashgrove.dev',
      name: 'Ashgrove',
      description: 'Turns meeting notes into a shared action list without anyone typing one.',
      category: 'developer-tools',
      tier: 'single',
    });
    return await attempt(() =>
      checkoutPost(
        new Request(`${ORIGIN}/api/checkout`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
        }),
      ),
    );
  }

  it('raises PaymentsNotWiredError — the same error type, by name', async () => {
    const result = await post();

    expect(result.response).toBeUndefined();
    expect(result.error).toBeInstanceOf(PaymentsNotWiredError);
    expect((result.error as Error).name).toBe('PaymentsNotWiredError');
  });

  it('names DATABASE_URL in the message, so the deploy knows what is missing', async () => {
    const result = await post();

    expect((result.error as Error).message).toContain('DATABASE_URL is not set');
  });

  it('opens no Dodo session and writes no row, because it never gets that far', async () => {
    // The refusal is at the dependency seam, before the handler runs at all.
    // Nothing was parsed, nothing was checked, and nothing was charged.
    const result = await post();

    expect(result.error).toBeDefined();
    expect(result.response).toBeUndefined();
  });

  it('is the SAME resolver the form deliberately does not use', () => {
    expect(() => checkoutDeps()).toThrow(/DATABASE_URL is not set/);
    // Same environment, same module, same instant. One throws and one does not,
    // and that is the whole fix.
    expect(() => submitPageDeps()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// GET /account — a session read, not a database read.
// ---------------------------------------------------------------------------

describe('GET /account renders its signed-out state with no DATABASE_URL', () => {
  beforeEach(() => {
    // The gate itself. `/account` is a function of a cookie, and verifying one
    // needs a secret — that requirement stays.
    process.env['SESSION_SECRET'] = KEYRING_SECRET;
  });

  it('answers 401 to a request with no cookie instead of 500', async () => {
    const result = await attempt(() => accountGet(new Request(`${ORIGIN}/account`)));

    expect(result.error).toBeUndefined();
    expect(result.response?.status).toBe(401);
  });

  it('renders the signed-out page, with no balance and no capability URL on it', async () => {
    const response = await accountGet(new Request(`${ORIGIN}/account`));
    const body = await response.text();

    expect(body).toContain('<!doctype html>');
    expect(body).not.toContain('$5.00');
  });

  it('never resolves the stores on the signed-out path', async () => {
    let resolved = 0;

    const response = await handleAccountPage(new Request(`${ORIGIN}/account`), {
      keyring: [KEYRING_SECRET],
      stores: () => {
        resolved += 1;
        throw new Error('the signed-out page resolved a store');
      },
    });

    expect(response.status).toBe(401);
    expect(resolved).toBe(0);
  });

  it('still refuses at the first signed-in render — deferred, not weakened', () => {
    // The thunk exists and is unresolved; calling it is what a verified session
    // does, and with no database that is still a named failure.
    expect(() => accountDeps().stores()).toThrow();
  });
});

// ---------------------------------------------------------------------------
// The package barrel.
// ---------------------------------------------------------------------------

describe('@the-pit/payments exports its classifier from the barrel', () => {
  it('exports seededCategoryClassifier as a working CategoryClassifier', () => {
    expect(payments.seededCategoryClassifier).toBeDefined();
    expect(typeof payments.seededCategoryClassifier.classify).toBe('function');
  });

  it('classifies offline, with no key and no network', async () => {
    const verdict = await seededCategoryClassifier.classify({
      name: 'Ashgrove',
      description: 'A command line tool that formats and lints your TypeScript source files.',
      chosenCategory: 'developer-tools',
      candidateCategories: ['developer-tools', 'ai-writing-tools'],
    });

    expect(['match', 'mismatch', 'uncertain']).toContain(verdict.verdict);
    expect(typeof verdict.confidence).toBe('number');
  });

  it('also exports the model and the factory that arrived with it', () => {
    // The other symbols from the same merge. A missing barrel line is a
    // build-time error only where something imports it, so they are named here.
    expect(typeof payments.createNearestCentroidClassifier).toBe('function');
    expect(payments.SEEDED_CATEGORY_MODEL).toBeDefined();
    expect(typeof payments.buildCategoryModel).toBe('function');
    expect(typeof payments.scoreCategories).toBe('function');
    expect(typeof payments.tokenizeProduct).toBe('function');
  });

  it('is the classifier the checkout guards default to', () => {
    // Not `acceptAllClassifier` — `DECISIONS.md` S12's free rank lever stays shut.
    expect(seededCategoryClassifier).not.toBe(acceptAllClassifier);
  });
});
