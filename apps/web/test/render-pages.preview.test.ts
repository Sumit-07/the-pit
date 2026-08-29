/**
 * Not a test — a renderer, run through the test runner because that is where the
 * page builders are already importable.
 *
 * `/submit`, `/account` and the magic-link screens all need a database or a live
 * session before their routes will serve, and there is neither on a laptop. This
 * writes the same documents those routes return to `PIT_PREVIEW_OUT` so the design
 * can be looked at in a browser. Skipped unless the variable is set, so it costs a
 * normal run nothing.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, it } from 'vitest';

import { renderAccountPage } from '@/lib/account/page';
import { EMPTY_FORM, renderSubmitPage } from '@/lib/checkout/page';
import { signInPage, verifyButtonPage } from '@/lib/auth/pages';

const out = process.env['PIT_PREVIEW_OUT'];

describe.skipIf(out === undefined || out === '')('page previews', () => {
  it('writes submit, account and the magic-link screens', async () => {
    const dir = out ?? '';
    await mkdir(dir, { recursive: true });

    await writeFile(
      join(dir, 'submit.html'),
      renderSubmitPage({
        categories: ['developer-tools', 'health-fitness-wellness'],
        tiers: [
          { id: 'single', label: 'One attempt', amountCents: 500, attempts: 1, includesFitReport: false },
          { id: 'triple', label: 'Three attempts', amountCents: 1500, attempts: 3, includesFitReport: true },
        ] as never,
        values: { ...EMPTY_FORM, categorySlug: 'developer-tools' },
        descriptionLimit: 300,
        signedIn: false,
      }),
      'utf8',
    );

    await writeFile(
      join(dir, 'account.html'),
      renderAccountPage({
        accountId: 'acct_1',
        email: 'founder@example.com',
        balance: 2,
        capabilityUrl: 'https://thepit.show/a/k7m2q9x4hd82',
        github: { linked: false },
        purchases: [
          {
            orderId: 'ord_2',
            amountCents: 1500,
            currency: 'USD',
            attemptsGranted: 3,
            includesFitReport: true,
            createdAt: new Date('2026-08-26T09:12:00Z'),
          },
          {
            orderId: 'ord_1',
            amountCents: 500,
            currency: 'USD',
            attemptsGranted: 1,
            includesFitReport: false,
            createdAt: new Date('2026-08-20T18:40:00Z'),
          },
        ],
        listings: [
          {
            productId: 'p1',
            name: 'Capgo - Live Updates for Ionic and Capacitor Apps',
            url: 'https://capgo.app/',
            categorySlug: 'developer-tools',
            status: 'delivered',
            verdictSlug: 'capgo-live-updates',
            attemptNumber: 2,
            deliveredAt: new Date('2026-08-27T14:03:00Z'),
          },
          {
            productId: 'p2',
            name: 'Sequo — stop re-explaining your project to your coding agent',
            url: 'https://sequo.dev/',
            categorySlug: 'developer-tools',
            status: 'running',
            verdictSlug: null,
            attemptNumber: 1,
            deliveredAt: null,
          },
        ],
      }),
      'utf8',
    );

    await writeFile(join(dir, 'sign-in.html'), signInPage(), 'utf8');
    await writeFile(join(dir, 'verify.html'), verifyButtonPage('abc123'), 'utf8');
  });
});
