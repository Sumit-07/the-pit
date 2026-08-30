/**
 * `GET /v/<slug>/og` — the share card for one verdict.
 *
 * `brief` Part 6: "A dynamic OG image per verdict: name, cuts total, rank, the
 * sharpest juror line." All four come from `ogFields`, which is pure, offline and
 * tested; this file is the rasteriser and the layout, and holds no rule.
 *
 * The split exists because `next/og` resolves only through the Next bundler — a
 * unit test that imported this module would fail on module resolution, not on an
 * assertion. So the requirements live one module down, where they can be checked,
 * and what is left here is a picture.
 *
 * The card is the verdict card at 1200x630 in `lib/theme.ts`'s palette, with the
 * single hue on the single number that matters. `brief` Part 5's rule rides in the
 * data — `fields.rank` cannot be produced without its product count and its
 * timestamp — so there is no arrangement of this layout that shows a bare rank.
 *
 * When the site was paper this card was the one surface that INVERTED, because a
 * share image is seen at thumbnail size in a feed next to other people's and the
 * light version disappeared there. Now that the site is dark the card and the site
 * are the same thing, and the exception is gone: these literals are the theme's
 * own tokens resolved, not a second palette. `theme-drift.test.ts` pins them.
 */

import { ImageResponse } from 'next/og';

import { parseVerdict } from '@/lib/verdict/model';
import { ogFields } from '@/lib/verdict/og';
import { verdictStore } from '@/lib/verdict/service';

/**
 * `lib/theme.ts`'s tokens, as literals — satori resolves no `var()` and no
 * `rgb(… / a)`, so the surfaces are the tokens themselves and the derived tones
 * are written out at the values the browser would composite them to.
 */
/** `--pit`. */
const GROUND = '#1A1610';
/** `--card`, one step up: the quote panel. */
const PANEL = '#29241C';
/** `--line` (ink at .17) resolved over `--card`. */
const RULE = '#4A453D';
/** `--ink`. */
const INK = '#EDE6DE';
/** `--dimmer` (ink at .66) resolved over `--pit`. */
const MUTED = '#A59F98';
/** `--cut`. */
const CUT = '#F45C33';

const SIZE = { width: 1200, height: 630 } as const;

export async function GET(_request: Request, context: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await context.params;
  const store = await verdictStore();
  const row = await store.bySlug(slug);

  if (row === undefined) {
    return new Response('no verdict at this url', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  const fields = ogFields(parseVerdict(row));

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
          padding: '56px 64px',
          borderLeft: `14px solid ${CUT}`,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 22, letterSpacing: 4, color: MUTED }}>{fields.eyebrow}</div>
          {fields.pitch === '' ? (
            <div style={{ display: 'flex' }} />
          ) : (
            <div style={{ display: 'flex', fontSize: 20, color: MUTED, border: `1px solid ${RULE}`, padding: '6px 12px' }}>
              {fields.pitch}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', fontSize: 62, fontWeight: 700, marginTop: 26, lineHeight: 1.08 }}>
          {fields.name}
        </div>

        <div style={{ display: 'flex', alignItems: 'baseline', marginTop: 22 }}>
          <div style={{ display: 'flex', fontSize: 120, fontWeight: 700, color: CUT, lineHeight: 1 }}>
            {fields.cuts}
          </div>
          <div style={{ display: 'flex', fontSize: 34, color: INK, marginLeft: 18 }}>{fields.cutsLabel}</div>
        </div>

        {/* `marginBottom` guarantees a gap even when the quote below is pushed
            to the bottom by `marginTop: auto`. */}
        <div style={{ display: 'flex', fontSize: 26, color: MUTED, marginTop: 14, marginBottom: 26 }}>
          {fields.rank}
        </div>

        {fields.quote === '' ? (
          <div style={{ display: 'flex' }} />
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              marginTop: 'auto',
              background: PANEL,
              borderLeft: `6px solid ${CUT}`,
              borderTop: `1px solid ${RULE}`,
              padding: '20px 24px',
            }}
          >
            <div style={{ display: 'flex', fontSize: 28, lineHeight: 1.35, color: INK }}>{fields.quote}</div>
            <div style={{ display: 'flex', fontSize: 20, color: MUTED, marginTop: 12 }}>{fields.attribution}</div>
          </div>
        )}
      </div>
    ),
    {
      ...SIZE,
      headers: {
        // The image is as frozen as the row behind it, and it is fetched by
        // crawlers rather than by people, so it is cached as hard as the page.
        'Cache-Control': 'public, max-age=300, s-maxage=31536000, stale-while-revalidate=604800',
      },
    },
  );
}
