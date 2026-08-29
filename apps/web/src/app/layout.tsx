import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import './pit.css';

/**
 * `brief` Part 5 fixes the brand: the domain is thepit.show, the headline is
 * "You can't outbid the pit", the sub is "Everyone walks in at 100. Fewest cuts
 * wins." The connective word is *cuts*, and it belongs on every surface.
 *
 * The shell now carries the type, because the surfaces that use it exist. It is
 * `the-pit-home.html`'s stack, unchanged — Archivo Black for display, Barlow for
 * body, IBM Plex Mono for everything numeric — loaded with plain `<link>` tags
 * rather than `next/font`, for two reasons:
 *
 * 1. `next/font/google` fetches at **build** time. `pnpm -r build` has to work on
 *    a machine with no network, and a homepage that cannot be built offline is a
 *    homepage that cannot be built in CI without a font host being up.
 * 2. Every family in `pit.css` has a real local fallback, so a blocked font host
 *    costs the page its typeface and nothing else. `display=swap` means text is
 *    readable from the first paint either way.
 *
 * `metadataBase` is thepit.show. It matters here rather than looking like
 * decoration: without it, a relative Open Graph URL on a shared board resolves
 * against whatever preview deployment produced it.
 */
export const metadata: Metadata = {
  metadataBase: new URL('https://thepit.show'),
  title: {
    default: "The Pit — you can't outbid the pit",
    template: '%s — The Pit',
  },
  description: 'Everyone walks in at 100. Fewest cuts wins.',
};

export const viewport: Viewport = {
  // `brief` Part 6: the board occupies most of the page, above the fold on
  // mobile. Everything that renders it starts from a correctly scaled viewport.
  width: 'device-width',
  initialScale: 1,
  themeColor: '#120E0C',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=Barlow:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
