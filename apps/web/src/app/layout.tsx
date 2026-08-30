import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import './pit.css';

/**
 * `brief` Part 5 fixes the brand: the domain is thepit.show, the headline is
 * "You can't outbid the pit", the sub is "Everyone walks in at 100. Fewest cuts
 * wins." The connective word is *cuts*, and it belongs on every surface.
 *
 * The shell carries the type. It is one sans and one mono: **Archivo** — the
 * grotesque, never Archivo Black — from 400 to 800, and **IBM Plex Mono** on
 * numbers only. There is deliberately no display face: the personality is weight,
 * scale and tracking, which is what lets the same family shout at 74px in the hero
 * and stay quiet at 14px in a juror's reason. They are loaded with plain `<link>`
 * tags rather than `next/font`, for two reasons:
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
  // `themeColor` is `--pit`, the page's real ground, so a mobile browser's chrome
  // matches the surface under it instead of a colour nothing else uses. One value
  // and no `media` variants: the pit is dark, and that is an identity rather than
  // a preference, so there is no `prefers-color-scheme` branch to answer.
  width: 'device-width',
  initialScale: 1,
  themeColor: '#1A1610',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Archivo:wght@400;500;600;700;800&family=IBM+Plex+Mono:wght@400;500;600&display=swap"
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
