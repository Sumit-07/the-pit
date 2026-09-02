/**
 * The share card for one board.
 *
 * A board link is the second thing on this site anyone pastes into a chat — the
 * first is a verdict — and until this existed it unfurled as a title over a bare
 * domain. This is the same card as `/v/<slug>/og` at one lower temperature: the
 * wordmark, the category, what the board holds, and the three rows at the top of
 * it with the health each walked out with.
 *
 * ## It is deliberately simpler than the verdict card
 *
 * No fetched typeface. This file is PRERENDERED — `generateStaticParams` below
 * gives it the same slugs the page has, so `next build` rasterises both boards
 * into static files — and `app/layout.tsx` already says why a build must not
 * depend on a font host being up: a card that cannot be built offline is a card
 * that cannot be built in CI. The verdict card fetches its type because it is
 * served on demand, which is a different situation with a different answer.
 *
 * ## It computes nothing a board read does not already compute
 *
 * One `defaultBoardSource().read` and one `toBoardView`, which is exactly what
 * `page.tsx` beside it does. `brief` Part 3's "reads never touch a model" and
 * `02 §4`'s "the board never computes anything at read time" hold here for the
 * same reason they hold there: nothing on this graph can open a connection.
 *
 * `brief` Part 5 rides in what is NOT here. The card shows three rows in the
 * order the snapshot holds them and stamps the moment the board was ranked; it
 * never says a row IS first, because the board moves.
 */

import { ImageResponse } from 'next/og';

import { boardStats } from '@/lib/boards/home';
import { defaultBoardSource } from '@/lib/boards/source';
import { stampUtc, toBoardView } from '@/lib/boards/view';

export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const alt = 'A category board on The Pit';

/** `lib/theme.ts`'s tokens as literals, for the same reason `/v/<slug>/og` holds them. */
const GROUND = '#1A1610';
const PANEL = '#29241C';
const SUNK = '#0F0A06';
const RULE = '#4A453D';
const INK = '#EDE6DE';
const MUTED = '#A59F98';
const CUT = '#F45C33';
const HELD = '#3E9C86';

export async function generateStaticParams(): Promise<{ slug: string }[]> {
  return (await defaultBoardSource().list()).map((slug) => ({ slug }));
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }): Promise<ImageResponse> {
  const { slug } = await params;
  const document_ = await defaultBoardSource().read(slug);
  const board = document_ === undefined ? undefined : toBoardView(document_);
  const rows = board === undefined ? [] : board.rows.slice(0, 3);

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: GROUND,
          color: INK,
          // Explicit sides, not the three-value shorthand: satori expands
          // `48px 60px 44px` without a padding-RIGHT, so a flex row's line box
          // was 60px wider than the card's content column and the health bar
          // ran off the canvas with its red tail clipped.
          paddingTop: 48,
          paddingRight: 60,
          paddingBottom: 44,
          paddingLeft: 60,
          borderLeft: `6px solid ${CUT}`,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{ display: 'flex', width: 18, height: 18, background: CUT }} />
            <div style={{ display: 'flex', fontSize: 26, fontWeight: 700, letterSpacing: 2, marginLeft: 12 }}>
              THE PIT
            </div>
          </div>
          <div style={{ display: 'flex', fontSize: 20, letterSpacing: 3, color: MUTED }}>THE BOARD</div>
        </div>

        <div style={{ display: 'flex', fontSize: 68, fontWeight: 700, marginTop: 30, lineHeight: 1.04 }}>
          {board === undefined ? 'No board here' : board.category}
        </div>

        <div style={{ display: 'flex', fontSize: 26, color: MUTED, marginTop: 14 }}>
          {board === undefined
            ? 'This category has no published board.'
            : `${board.productCount} products judged · median health ${Math.round(boardStats([board]).medianHealth)}`}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 34 }}>
          {rows.map((row) => (
            <div
              key={row.rank}
              style={{
                display: 'flex',
                alignItems: 'center',
                background: PANEL,
                borderTop: `1px solid ${RULE}`,
                borderLeft: `6px solid ${CUT}`,
                padding: '16px 20px',
                marginBottom: 10,
              }}
            >
              <div style={{ display: 'flex', fontSize: 30, fontWeight: 700, flexGrow: 1 }}>{row.name}</div>
              <div style={{ display: 'flex', flexDirection: 'column', width: 320, marginLeft: 24 }}>
                <div style={{ display: 'flex', width: '100%', height: 12, background: SUNK }}>
                  <div
                    style={{
                      display: 'flex',
                      width: `${Math.max(0, Math.min(100, Math.round(row.health)))}%`,
                      height: '100%',
                      background: HELD,
                    }}
                  />
                  <div style={{ display: 'flex', flexGrow: 1, height: '100%', background: CUT }} />
                </div>
                <div style={{ display: 'flex', fontSize: 20, color: MUTED, marginTop: 8 }}>
                  {`${Math.round(row.health)} health left`}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'auto' }}>
          <div style={{ display: 'flex', fontSize: 19, color: MUTED }}>
            {board === undefined ? 'thepit.show' : `ranked ${stampUtc(board.generatedAt)} · thepit.show`}
          </div>
        </div>
      </div>
    ),
    size,
  );
}
