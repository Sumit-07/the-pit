import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

/**
 * `brief` Part 5 fixes the brand: the domain is thepit.show, the headline is
 * "You can't outbid the pit", the sub is "Everyone walks in at 100. Fewest cuts
 * wins." The connective word is *cuts*, and it belongs on every surface.
 *
 * The shell carries the metadata and nothing else. Type is deliberately absent:
 * `the-pit-home.html` and `platform-surfaces-mockup.html` are the visual
 * reference and the boards are another agent's, so a stylesheet written here
 * would be a second opinion for them to unpick.
 */
export const metadata: Metadata = {
  title: {
    default: "The Pit — you can't outbid the pit",
    template: '%s — The Pit',
  },
  description: 'Everyone walks in at 100. Fewest cuts wins.',
};

export const viewport: Viewport = {
  // `brief` Part 6: the board occupies most of the page, above the fold on
  // mobile. Whatever renders it starts from a correctly scaled viewport.
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
