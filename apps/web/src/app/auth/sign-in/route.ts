/**
 * `GET /auth/sign-in` — the form that starts the flow.
 *
 * A route handler rather than a `page.tsx` so it shares `pages.ts` with the
 * verify screens: the three auth pages are the same small document with
 * different text, and rendering two of them through route handlers and one
 * through React would mean two answers to "what does an auth page look like".
 *
 * It is a plain `<form method="post">`. No script, so it works with JavaScript
 * disabled, in a text browser, and in the situation people actually reach it in
 * — on a phone, from an email client's in-app browser, mildly annoyed.
 */

import { signInPage } from '@/lib/auth/pages';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(): Response {
  return new Response(signInPage(), {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    },
  });
}
