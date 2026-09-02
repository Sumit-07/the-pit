/**
 * One nav, one case.
 *
 * The site carried four headers. The homepage wrote lowercase mono ("how it
 * works · boards"), the board index wrote the same words and marked itself with a
 * `<span>`, the category board wrote "all boards", and `/submit` and `/account`
 * wrote Title Case with a third item and a different wordmark. Four navs is four
 * answers to "what is on this site", and a reader who follows a link between two
 * of them is told the site changed.
 *
 * `lib/site/nav.ts` is the one answer, and there are two renderers over it
 * because two kinds of surface have to render it: `<SiteNav>` for the pages Next
 * renders, and `renderSiteNav()` for the ones that are self-contained HTML
 * strings. This file's first job is to prove those two are one nav — byte for
 * byte, not "in spirit" — because two renderers that agree only by inspection
 * are how a fifth variant gets born.
 *
 * Its second job is to prove the header actually reaches the documents readers
 * are served. The React pages get it from `app/layout.tsx`, so they are rendered
 * through the layout here; rendering a page component alone would assert about a
 * document nobody receives.
 */

import type { ReactElement, ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import BoardIndex from '@/app/boards/page';
import CategoryBoard from '@/app/boards/[slug]/page';
import Home from '@/app/page';
import HowItWorks from '@/app/how-it-works/page';
import RootLayout from '@/app/layout';
import { SiteNav } from '@/components/site-nav';
import { renderSiteNav, siteNavItems, type SiteNavState } from '@/lib/site/nav';
import { renderAccountPage, renderSignedOutPage } from '@/lib/account/page';
import { EMPTY_FORM, renderSubmitPage } from '@/lib/checkout/page';

import { writeSeededWorkdir } from './helpers/boards';

const scratch: string[] = [];

afterEach(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
  delete process.env['PIT_WORKDIR'];
});

async function seed(slug = 'developer-tools'): Promise<void> {
  const workdir = await writeSeededWorkdir({ slug });
  scratch.push(workdir);
  process.env['PIT_WORKDIR'] = workdir;
}

/** A page as a reader is served it: through the layout, which is where the nav is. */
function wholeDocument(page: ReactNode): string {
  return renderToStaticMarkup(RootLayout({ children: page }) as ReactElement);
}

function navOf(html: string): string {
  return /<nav[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';
}

function submitPage(signedIn: boolean): string {
  return renderSubmitPage({
    categories: ['developer-tools'],
    tiers: [
      { id: 'single', label: 'One attempt', amountCents: 500, attempts: 1, includesFitReport: false },
    ] as never,
    values: { ...EMPTY_FORM, categorySlug: 'developer-tools' },
    descriptionLimit: 300,
    signedIn,
  });
}

describe('the two renderers are one nav', () => {
  it('emits identical markup from React and from the string builder', () => {
    const states: SiteNavState[] = [
      {},
      { signedIn: true },
      { current: 'boards' },
      { current: 'account', signedIn: true },
      { origin: 'https://thepit.show' },
    ];
    for (const state of states) {
      // Called rather than mounted: every prop on this component is optional,
      // which `createElement` will not narrow to.
      expect(renderToStaticMarkup(SiteNav(state) as ReactElement), JSON.stringify(state)).toBe(
        renderSiteNav(state),
      );
    }
  });

  it('names three doors, in one case, in one order', () => {
    expect(siteNavItems().map((item) => item.label)).toEqual(['How it works', 'Boards', 'Sign in']);
    expect(siteNavItems().map((item) => item.href)).toEqual([
      '/how-it-works',
      '/boards',
      '/auth/sign-in',
    ]);
  });

  it('turns the third door into the account when a session exists', () => {
    const [, , third] = siteNavItems({ signedIn: true });
    expect(third?.label).toBe('Account');
    expect(third?.href).toBe('/account');
  });

  it('marks the page you are on as text rather than as a link to itself', () => {
    const html = renderSiteNav({ current: 'boards' });
    expect(html).toContain('<span class="navlink" aria-current="page">Boards</span>');
    expect(html).not.toContain('href="/boards"');
  });

  it('keeps the wordmark, and keeps it pointing home', () => {
    expect(renderSiteNav()).toContain('<a class="mark" href="/">THE <i>PIT</i></a>');
  });

  it('prefixes every href with an origin when it is given one', () => {
    // The verdict page is downloadable, and a root-relative href in a saved copy
    // points at the reader's own disk.
    const html = renderSiteNav({ origin: 'https://thepit.show' });
    expect(html).toContain('href="https://thepit.show/how-it-works"');
    expect(html).toContain('href="https://thepit.show/boards"');
    expect(html).toContain('href="https://thepit.show/auth/sign-in"');
  });
});

describe('the header reaches every surface', () => {
  it('is on the homepage, the board index, a category board and how-it-works', async () => {
    await seed();
    const pages: [string, string][] = [
      ['the homepage', wholeDocument(await Home())],
      ['the board index', wholeDocument(await BoardIndex())],
      [
        'a category board',
        wholeDocument(await CategoryBoard({ params: Promise.resolve({ slug: 'developer-tools' }) })),
      ],
      ['how-it-works', wholeDocument(await HowItWorks())],
    ];
    for (const [name, html] of pages) {
      expect(navOf(html), `${name} has the shared nav`).toBe(renderSiteNav());
    }
  });

  it('is on the submit page, with the third door named for a guest', () => {
    // `brief §2.1` is guest checkout: the nav offers the way back to an account,
    // and nothing on the buying path asks for one.
    expect(navOf(submitPage(false))).toBe(renderSiteNav({ signedIn: false }));
    expect(navOf(submitPage(true))).toBe(renderSiteNav({ signedIn: true }));
  });

  it('is on the account page, marking the page the reader is on', () => {
    const signedIn = renderAccountPage({
      accountId: 'acct_1',
      email: 'founder@example.com',
      balance: 1,
      capabilityUrl: 'https://thepit.show/a/k7m2q9x4hd82',
      github: { linked: false },
      purchases: [],
      listings: [],
    } as never);
    expect(navOf(signedIn)).toBe(renderSiteNav({ current: 'account', signedIn: true }));
    expect(navOf(renderSignedOutPage())).toBe(renderSiteNav({ current: 'account' }));
  });

  it('renders exactly one header per document', async () => {
    await seed();
    for (const html of [wholeDocument(await Home()), submitPage(false)]) {
      expect([...html.matchAll(/<nav[\s>]/g)]).toHaveLength(1);
    }
  });

  it('costs no client JavaScript: the header is a server component', async () => {
    // The first element in every document must not wait for hydration to appear.
    // `'use client'` at the top of this module is the one line that would change
    // that, so the module is read and checked for it.
    const source = await readFile(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'components', 'site-nav.tsx'),
      'utf8',
    );
    expect(source).not.toContain("'use client'");
  });
});
