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
 * two hues doing the two jobs they do everywhere else: `--held` is what survived,
 * `--cut` is what was taken. `brief` Part 5's rule rides in the data —
 * `fields.rank` cannot be produced without its product count and its timestamp —
 * so there is no arrangement of this layout that shows a bare rank.
 *
 * ## What it puts first, and why that changed
 *
 * The card used to lead with the cuts total, set at 120px, and then print the
 * same number again in words underneath: `97` over `took 97 in cuts`. Two thirds
 * of the card's visual budget went to saying one number twice, and the rank —
 * the thing a founder shares a verdict FOR — was a 26px line under it. The rank
 * is now the biggest element, the two halves of the hundred are a bar rather
 * than a repeated figure, and the brand is a wordmark in the corner instead of a
 * word inside a tracked-out eyebrow.
 *
 * ## The type is fetched, and the card survives it failing
 *
 * satori has no font of its own, so before this the card was set in whatever
 * fallback `next/og` bundles — which is not Archivo, and the one surface that
 * travels off the site was the one surface not in the site's type. Archivo 700
 * and IBM Plex Mono 500 are fetched from Google Fonts as TTF at REQUEST time and
 * cached for the life of the process. Request time and not build time for the
 * reason `app/layout.tsx` gives about `next/font/google`: `pnpm -r build` has to
 * work on a machine with no network. If the fetch fails the card is drawn in the
 * default face and every word on it is still there — a share image with the
 * wrong typeface is a blemish, a share image that 500s is a broken link.
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
/** `--sunk`, the recess: the health bar's track, as on every board row. */
const SUNK = '#0F0A06';
/** `--line` (ink at .17) resolved over `--card`. */
const RULE = '#4A453D';
/** `--ink`. */
const INK = '#EDE6DE';
/** `--dimmer` (ink at .66) resolved over `--pit`. */
const MUTED = '#A59F98';
/** `--cut` — what was taken. */
const CUT = '#F45C33';
/** `--held` — what survived. The kept head of the bar, and nothing else. */
const HELD = '#3E9C86';

const SIZE = { width: 1200, height: 630 } as const;

/** The rail, and the gutters inside it. The layout is measured off these. */
const RAIL = 6;
const PAD_X = 60;
/**
 * The column every element on the card is set in: 1074px.
 *
 * It is a NUMBER rather than a `100%`, because satori distributes a flex line
 * from an available width that ignores this container's padding — the health bar
 * beside the rank was handed `1200 − rank` instead of `1074 − rank` and ran 60px
 * off the right edge with its red tail clipped away. Percentages inherited that
 * same wrong basis, so the fix is to stop asking: the band below sets both of its
 * columns from this constant, and they add up to it by construction.
 */
const CONTENT = SIZE.width - RAIL - PAD_X * 2;
/** Room for `#48` at 180px beside `/ 48` at 46px, in tabular mono. */
const RANK_COL = 420;
const BAND_GAP = 40;
const BAR_COL = CONTENT - RANK_COL - BAND_GAP;

const SANS = 'Archivo';
const MONO = 'IBM Plex Mono';

/**
 * One Google font file, as TTF, fetched once per process.
 *
 * `css2` hands back a `truetype` source rather than a `woff2` one when the
 * request does not advertise woff2 support, which is what Node's own fetch does
 * — and truetype is the only one of the two satori can parse. The two-step is
 * the shape `next/og`'s own documentation uses: read the stylesheet, pull the
 * one `src: url(…)` out of it, fetch that.
 *
 * The promise is cached rather than the bytes, so a burst of crawler requests on
 * a cold process shares one fetch. A FAILED fetch is evicted, because a share
 * card is served for as long as the process lives and a network blip at boot
 * must not cost every card after it its typeface.
 */
const fonts = new Map<string, Promise<ArrayBuffer | undefined>>();

async function googleFont(family: string, weight: number): Promise<ArrayBuffer | undefined> {
  const key = `${family}:${weight}`;
  let pending = fonts.get(key);
  if (pending === undefined) {
    pending = (async (): Promise<ArrayBuffer | undefined> => {
      const url = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}`;
      const sheet = await fetch(url);
      if (!sheet.ok) return undefined;
      const source = /src:\s*url\((https:\/\/[^)]+)\)\s*format\('truetype'\)/.exec(await sheet.text())?.[1];
      if (source === undefined) return undefined;
      const file = await fetch(source);
      return file.ok ? await file.arrayBuffer() : undefined;
    })().catch(() => undefined);
    fonts.set(key, pending);
  }

  const data = await pending;
  if (data === undefined) fonts.delete(key);
  return data;
}

/** Satori's font list, or an empty one when the host is unreachable. */
async function typeface(): Promise<
  { name: string; data: ArrayBuffer; weight: 500 | 700; style: 'normal' }[] | undefined
> {
  const [sans, mono] = await Promise.all([googleFont(SANS, 700), googleFont(MONO, 500)]);
  const loaded: { name: string; data: ArrayBuffer; weight: 500 | 700; style: 'normal' }[] = [];
  if (sans !== undefined) loaded.push({ name: SANS, data: sans, weight: 700, style: 'normal' });
  if (mono !== undefined) loaded.push({ name: MONO, data: mono, weight: 500, style: 'normal' });
  // `fonts: []` is not "use the default", it is "no font at all", and satori
  // throws on it. Undefined is the way to ask for the bundled fallback.
  return loaded.length === 0 ? undefined : loaded;
}

export async function GET(_request: Request, context: { params: Promise<{ slug: string }> }): Promise<Response> {
  const { slug } = await context.params;
  const store = await verdictStore();
  const row = await store.bySlug(slug);

  if (row === undefined) {
    return new Response('no verdict at this url', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  }

  const fields = ogFields(parseVerdict(row));
  const loaded = await typeface();

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
          fontFamily: SANS,
          // Explicit sides, not the three-value shorthand: satori expands
          // `48px 60px 44px` without a padding-RIGHT, so a flex row's line box
          // was 60px wider than the card's content column and the health bar
          // ran off the canvas with its red tail clipped.
          paddingTop: 48,
          paddingRight: PAD_X,
          paddingBottom: 44,
          paddingLeft: PAD_X,
          borderLeft: `6px solid ${CUT}`,
        }}
      >
        {/* The wordmark, and the category it was judged in. `pit.css`'s `.mark`
            is the same two things: a square of `--cut`, then THE PIT. */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{ display: 'flex', width: 18, height: 18, background: CUT }} />
            <div style={{ display: 'flex', fontSize: 26, fontWeight: 700, letterSpacing: 2, marginLeft: 12 }}>
              THE PIT
            </div>
          </div>
          <div style={{ display: 'flex', fontFamily: MONO, fontSize: 20, letterSpacing: 3, color: MUTED }}>
            {fields.category}
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'baseline', marginTop: 34 }}>
          <div style={{ display: 'flex', fontSize: 48, fontWeight: 700, lineHeight: 1.06, flexGrow: 1 }}>
            {fields.name}
          </div>
          {fields.pitch === '' ? (
            <div style={{ display: 'flex' }} />
          ) : (
            <div
              style={{
                display: 'flex',
                fontFamily: MONO,
                fontSize: 19,
                color: MUTED,
                border: `1px solid ${RULE}`,
                padding: '5px 11px',
                marginLeft: 24,
              }}
            >
              {fields.pitch}
            </div>
          )}
        </div>

        {/*
          The rank, big, with the count it is meaningless without — and beside it
          the hundred everyone walks in with, whose head is what survived and
          whose tail is what was taken. They share a band rather than stacking
          because a 180px figure and a full-width bar on separate lines leave the
          quote nothing to sit in; `lineHeight` is above 1 because at this size a
          line box of exactly 1em clips the crossbar off the `#`.
        */}
        <div style={{ display: 'flex', alignItems: 'flex-end', width: CONTENT }}>
          <div style={{ display: 'flex', alignItems: 'baseline', width: RANK_COL, flexShrink: 0 }}>
            <div style={{ display: 'flex', fontFamily: MONO, fontSize: 180, color: CUT, lineHeight: 1.16 }}>
              {fields.rankNumber}
            </div>
            <div style={{ display: 'flex', fontFamily: MONO, fontSize: 46, color: MUTED, marginLeft: 14 }}>
              {fields.rankOf}
            </div>
          </div>

          {/* Square, like the meter on every board row. */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              width: BAR_COL,
              flexShrink: 0,
              marginLeft: BAND_GAP,
              marginBottom: 34,
            }}
          >
            <div style={{ display: 'flex', width: BAR_COL, height: 16, background: SUNK }}>
              <div style={{ display: 'flex', width: `${fields.health}%`, height: '100%', background: HELD }} />
              <div style={{ display: 'flex', flexGrow: 1, height: '100%', background: CUT }} />
            </div>
            <div style={{ display: 'flex', fontFamily: MONO, fontSize: 21, color: MUTED, marginTop: 12 }}>
              {fields.healthLine}
            </div>
          </div>
        </div>

        {fields.quote === '' ? (
          <div style={{ display: 'flex', marginTop: 'auto' }} />
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              marginTop: 'auto',
              background: PANEL,
              borderLeft: `6px solid ${CUT}`,
              borderTop: `1px solid ${RULE}`,
              padding: '18px 22px',
            }}
          >
            <div style={{ display: 'flex', fontSize: 26, lineHeight: 1.32, color: INK }}>{fields.quote}</div>
            <div style={{ display: 'flex', fontFamily: MONO, fontSize: 19, color: MUTED, marginTop: 10 }}>
              {fields.attribution}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 16 }}>
          <div style={{ display: 'flex', fontFamily: MONO, fontSize: 19, color: MUTED }}>{fields.stamp}</div>
        </div>
      </div>
    ),
    {
      ...SIZE,
      ...(loaded === undefined ? {} : { fonts: loaded }),
      headers: {
        // The image is as frozen as the row behind it, and it is fetched by
        // crawlers rather than by people, so it is cached as hard as the page.
        'Cache-Control': 'public, max-age=300, s-maxage=31536000, stale-while-revalidate=604800',
      },
    },
  );
}
