/**
 * The theme lives in three files. This is the thing that holds them in step.
 *
 * `src/lib/theme.ts` is the copy for the surfaces that are self-contained HTML
 * strings; `src/app/pit.css` is the React mirror, which cannot be generated from
 * the first because a `.css` file cannot be interpolated into a `<style>` block
 * that has to survive being saved to disk; and `packages/engine/src/board/page.ts`
 * is a third copy on purpose, because `PHASE-0.md §3` forbids the engine importing
 * from `apps/web` and the preview board must render with no network at all.
 *
 * Three hand-kept copies of the same values, with nothing checking them, is
 * exactly the shape of the connection-pool bug one layer up: the copies were
 * "kept in step by hand" right up until they were not, and nothing said so. So
 * this file does not test that the theme is pretty. It tests the four things that
 * actually break:
 *
 * 1. **The three copies agree**, token for token.
 * 2. **The channel triplets match the hexes they claim to be.** `--ink-c` exists
 *    only so an alpha can be attached to `--ink` without a preprocessor. If a hex
 *    moves and its triplet does not, every derived tone in the system silently
 *    becomes a different colour from the thing it is derived from — and nothing
 *    looks broken enough to notice.
 * 3. **The surface stack stays ordered and stays separated.** A dark theme whose
 *    surfaces collapse toward each other is the flat near-black default; a step
 *    below ~4 CIE L* does not read as a different surface at all.
 * 4. **Contrast.** Every text stop clears WCAG AA on every surface it is used on.
 *    The mono numerals are 10–12px and are where dark themes fail; a token nudged
 *    "just a little darker" for looks is the normal way that happens.
 * 5. **Each hue keeps its one job.** There are two now — `--cut` for what was
 *    taken and `--held` for the health that survived — and a two-colour system is
 *    only better than a one-colour system for exactly as long as neither colour
 *    leaks. So the meaning is asserted as CSS: a kept head is `--held` and never
 *    `--cut`, a deduction is `--cut` and never `--held`, and the marks that are
 *    merely states (`solo`, `moved`) get neither.
 *
 * It reads the engine's file as TEXT rather than importing it, so the test
 * dependency runs from the app toward the engine and `PHASE-0.md §3` is untouched.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { TOKENS } from '@/lib/theme';

const here = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

const PIT_CSS = readFileSync(here('../src/app/pit.css'), 'utf8');
const OG_ROUTE = readFileSync(here('../src/app/v/[slug]/og/route.tsx'), 'utf8');
const ENGINE_PAGE = readFileSync(here('../../../packages/engine/src/board/page.ts'), 'utf8');
const MAIL_THEME = readFileSync(here('../../../packages/auth/src/mail/theme.ts'), 'utf8');

/** Strip CSS and JSDoc comments, so prose about the theme is never mistaken for it. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

/**
 * The custom properties declared in a source's `:root{…}` block.
 *
 * Values are normalised before comparison, because two of the three copies are
 * run through Prettier as `.css` and the third is a template literal inside a
 * `.ts` file: Prettier writes `.6` where the string says `.60`, and puts a space
 * after every comma in a font stack. Those are formatting, not values, and a
 * drift test that fails on them would be turned off within a week. Hex case is
 * normalised for the same reason. Everything that survives normalisation is the
 * colour, the alpha or the geometry — which is what is actually under test.
 */
function rootTokens(source: string): Map<string, string> {
  const start = source.indexOf(':root{');
  const braced = start === -1 ? source.indexOf(':root {') : start;
  expect(braced, 'every themed source declares a :root block').toBeGreaterThan(-1);

  // Walk to the matching close brace rather than regexing to the first `}`,
  // because the block contains `rgb(… / .17)` and nested comments.
  let depth = 0;
  let end = -1;
  for (let i = source.indexOf('{', braced); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  const body = stripComments(source.slice(source.indexOf('{', braced) + 1, end));

  const out = new Map<string, string>();
  for (const [, name, value] of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const normalised = (value ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/#[0-9a-fA-F]{6}/g, (found) => found.toUpperCase())
      // `.17` and `0.17` are the same alpha written two ways.
      .replace(/(^|[\s(/,])0\.(\d)/g, '$1.$2')
      // `.60` and `.6` likewise — Prettier writes the second.
      .replace(/(\.\d*?)0+(?![0-9])/g, '$1')
      // `"a", "b"` and `"a","b"` are the same font stack.
      .replace(/,\s*/g, ',');
    out.set(name ?? '', normalised);
  }
  return out;
}

const SOURCES: ReadonlyArray<readonly [string, Map<string, string>]> = [
  ['lib/theme.ts', rootTokens(TOKENS)],
  ['app/pit.css', rootTokens(PIT_CSS)],
  ['engine/board/page.ts', rootTokens(ENGINE_PAGE)],
];

const THEME = SOURCES[0]?.[1] ?? new Map<string, string>();

/** Every token the three copies are required to agree on. */
const SHARED = [
  '--sunk',
  '--pit',
  '--card',
  '--rise',
  '--ink',
  '--cut',
  '--held',
  '--ink-c',
  '--cut-c',
  '--held-c',
  '--pit-c',
  '--shade-c',
  '--dim',
  '--dimmer',
  '--faint',
  '--on-lit',
  '--line',
  '--hair',
  '--wash',
  '--lip',
  '--e1',
  '--e2',
  '--e3',
  '--r1',
  '--r2',
  '--r3',
  '--sans',
  '--mono',
] as const;

// ---------------------------------------------------------------- colour maths

function channels(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

function linear(value: number): number {
  const s = value / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: readonly [number, number, number]): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast ratio, 1:1 to 21:1. */
function contrast(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** CIE L*, 0–100. Perceptual lightness, which is what a "step" in a stack means. */
function lightness(colour: readonly [number, number, number]): number {
  const y = luminance(colour);
  return y <= 216 / 24389 ? (y * 24389) / 27 : 116 * Math.cbrt(y) - 16;
}

/** What the browser composites `rgb(fg / alpha)` to, over an opaque `bg`. */
function over(
  fg: readonly [number, number, number],
  bg: readonly [number, number, number],
  alpha: number,
): [number, number, number] {
  return [0, 1, 2].map((i) => Math.round((fg[i] ?? 0) * alpha + (bg[i] ?? 0) * (1 - alpha))) as [number, number, number];
}

const hex = (name: string): [number, number, number] => channels(THEME.get(name) ?? '#000000');

/** `rgb(var(--ink-c) / .66)` -> `.66`. */
function alphaOf(name: string): number {
  const value = THEME.get(name) ?? '';
  const found = /\/\s*(\.\d+|\d+(?:\.\d+)?)\s*\)/.exec(value);
  expect(found, `${name} is an alpha derivation`).not.toBeNull();
  return Number.parseFloat(found?.[1] ?? '0');
}

/** The stack, ground-up. `--sunk` is below everything; `--rise` is the top. */
const STACK = ['--sunk', '--pit', '--card', '--rise'] as const;

/**
 * Which surfaces each text stop actually sits on.
 *
 * `--cut` and `--held` are deliberately absent from `--rise`: `--rise` is a slab
 * surface — the hero, the closer, the board's rim — and it carries neither hue as
 * type anywhere in the system. That is a constraint on the CSS, not an exemption,
 * and the row hover cap in `pit.css` exists to keep it true.
 */
const TEXT_ON: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['--ink', STACK],
  ['--dim', STACK],
  ['--dimmer', STACK],
  ['--faint', STACK],
  ['--cut', ['--sunk', '--pit', '--card']],
  // `--held` sets 10.5px mono in the meter caption and on the board's stat strip,
  // both of which sit on the `--card` -> `--pit` ramp, and 30px on the homepage
  // stats row over `--pit`.
  ['--held', ['--sunk', '--pit', '--card']],
];

// ------------------------------------------------------------------ the tests

describe('the three copies of the theme agree', () => {
  for (const token of SHARED) {
    it(`${token} is the same value in all three sources`, () => {
      const values = SOURCES.map(([name, map]) => [name, map.get(token)] as const);
      for (const [name, value] of values) {
        expect(value, `${token} is missing from ${name}`).toBeDefined();
      }
      const distinct = new Set(values.map(([, value]) => value));
      expect(
        distinct.size,
        `${token} drifted: ${values.map(([name, value]) => `${name}=${String(value)}`).join('  ')}`,
      ).toBe(1);
    });
  }

  it('declares no token in one copy that the others have not got', () => {
    for (const [name, map] of SOURCES) {
      const extra = [...map.keys()].filter((key) => !SHARED.includes(key as (typeof SHARED)[number]));
      expect(extra, `${name} declares tokens the other copies do not`).toEqual([]);
    }
  });
});

describe('the channel triplets match the colours they are derived from', () => {
  // The failure this catches is silent: a hex moves, its triplet does not, and
  // every derived tone in the system quietly stops being a tint of its own colour.
  for (const [triplet, colour] of [
    ['--ink-c', '--ink'],
    ['--cut-c', '--cut'],
    ['--held-c', '--held'],
    ['--pit-c', '--pit'],
  ] as const) {
    it(`${triplet} is ${colour}'s own channels`, () => {
      expect(THEME.get(triplet)).toBe(hex(colour).join(' '));
    });
  }

  it('builds shadows from --shade-c and never from the text colour', () => {
    expect(THEME.get('--shade-c')).toBe('0 0 0');
    for (const level of ['--e1', '--e2', '--e3'] as const) {
      const value = THEME.get(level) ?? '';
      expect(value, `${level} must be occlusion, not glow`).toContain('var(--shade-c)');
      expect(value, `${level} must not be built from the text colour`).not.toContain('var(--ink-c)');
    }
    // `--wash` marks recession, so on dark it has to darken what it covers.
    expect(THEME.get('--wash')).toContain('var(--shade-c)');
    // `--lip` is the one lit edge, and it is the only one built from the ink.
    expect(THEME.get('--lip')).toContain('var(--ink-c)');
    expect(THEME.get('--lip')).toContain('inset');
  });
});

describe('the surface stack is a stack', () => {
  for (let i = 1; i < STACK.length; i++) {
    const below = STACK[i - 1] ?? '';
    const above = STACK[i] ?? '';
    it(`${above} sits above ${below}, by a step that reads`, () => {
      const step = lightness(hex(above)) - lightness(hex(below));
      // Ordered: elevation is lightness, so a raised surface must be lighter.
      expect(step, `${above} must be lighter than ${below}`).toBeGreaterThan(0);
      // Separated: below roughly 4 L* two surfaces read as one, which is the flat
      // near-black default this theme exists to not be.
      expect(step, `${above} -> ${below} is too small a step to read`).toBeGreaterThan(4);
    });
  }

  it('is dark, and warm, at every step', () => {
    for (const token of STACK) {
      const [r, , b] = hex(token);
      // Dark: the whole stack sits well under the midpoint.
      expect(lightness(hex(token)), `${token} is not a dark surface`).toBeLessThan(30);
      // Warm: a pit is earth, not outer space. Held in absolute channel terms so
      // the floor is as warm as the surfaces above it rather than fading to the
      // blue-black every dark UI ships with.
      expect(r - b, `${token} has lost its warm bias`).toBeGreaterThanOrEqual(8);
    }
  });

  it('keeps the recess below the deepest row, so the meter track stays a groove', () => {
    // Rows descend --card -> --pit. The track is --sunk and must stay under both.
    expect(lightness(hex('--sunk'))).toBeLessThan(lightness(hex('--pit')));
  });
});

describe('contrast clears WCAG AA on every surface a stop is used on', () => {
  for (const [stop, surfaces] of TEXT_ON) {
    for (const surface of surfaces) {
      it(`${stop} on ${surface}`, () => {
        const ground = hex(surface);
        const colour =
          stop === '--cut' || stop === '--held' || stop === '--ink'
            ? hex(stop)
            : over(hex('--ink'), ground, alphaOf(stop));
        const ratio = contrast(colour, ground);
        expect(ratio, `${stop} on ${surface} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      });
    }
  }

  it('keeps every stop legible on a row at any depth of the descent', () => {
    // A row's ground is a mix of --card and --pit, so the whole ramp between them
    // has to hold — not only its two ends.
    const card = hex('--card');
    const pit = hex('--pit');
    for (let step = 0; step <= 10; step++) {
      const ground = over(pit, card, step / 10);
      for (const stop of ['--dim', '--dimmer', '--faint'] as const) {
        expect(contrast(over(hex('--ink'), ground, alphaOf(stop)), ground)).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrast(hex('--cut'), ground), `--cut at depth ${step / 10}`).toBeGreaterThanOrEqual(4.5);
      // The health figure in the meter caption rides the same ramp as the cut.
      expect(contrast(hex('--held'), ground), `--held at depth ${step / 10}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('keeps the text on a lit fill legible, where the ink stops would not be', () => {
    // A filled chip or the primary button inverts: --ink is the fill and the
    // ground is the type. --dim there would be near-white on near-white.
    const fill = hex('--ink');
    expect(contrast(hex('--pit'), fill)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(over(hex('--pit'), fill, alphaOf('--on-lit')), fill)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('the meter reads in the dark', () => {
  // The signature is a groove with a neutral head and an accent ramp in it. The
  // failure mode this guards is the one that only shows on screen: fading an
  // accent toward a near-black track by alpha runs it into mud, and the smallest
  // metric's block stops reading as a cut at all.
  const track = hex('--sunk');
  const ramp = [1, 0.9, 0.8, 0.71, 0.64, 0.58] as const;

  it('draws every segment clear of the track it sits in', () => {
    for (const alpha of ramp) {
      const segment = over(hex('--cut'), track, alpha);
      expect(contrast(segment, track), `segment at ${alpha} vanishes into the track`).toBeGreaterThanOrEqual(2.5);
    }
  });

  it('orders the segments, heaviest first, without any two collapsing together', () => {
    const steps = ramp.map((alpha) => lightness(over(hex('--cut'), track, alpha)));
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i - 1] ?? 0, 'the ramp must descend').toBeGreaterThan(steps[i] ?? 0);
      expect((steps[i - 1] ?? 0) - (steps[i] ?? 0), 'two segments read as one').toBeGreaterThan(2);
    }
  });

  it('keeps what SURVIVED quieter than what was TAKEN', () => {
    // The head is the 83 of 100 a product kept. It is most of the bar, so if it
    // outshone the accent the drawing would say the opposite of what it means.
    // It is `--held` now rather than a neutral, and the rule is unchanged: a hue
    // is not a licence to be louder than the thing it is quieter than.
    const kept = over(hex('--held'), track, 0.7);
    expect(lightness(kept)).toBeLessThan(lightness(hex('--cut')));
    // But it is still a visible object in a groove, not a smear.
    expect(contrast(kept, track)).toBeGreaterThanOrEqual(3);
  });

  it('did not get louder when it got a colour', () => {
    // The head was `rgb(--ink-c / .40)` — CIE L* 41.9 over the track. Recolouring
    // it was supposed to give the larger half of the bar a MEANING, not more
    // weight; a teal head that arrived three stops brighter would have quietly
    // rebalanced every row on the site. Half a stop of drift is the allowance.
    const before = lightness(over(hex('--ink'), track, 0.4));
    const after = lightness(over(hex('--held'), track, 0.7));
    expect(Math.abs(after - before), 'the kept head changed weight, not just hue').toBeLessThan(2);
  });
});

describe('there are two hues, and each means exactly one thing', () => {
  it('is a system of exactly two colours over a neutral stack', () => {
    // Every other token is a neutral: a colour is a colour only if its channels
    // spread far enough to read as one.
    for (const token of [...STACK, '--ink']) {
      const [r, g, b] = hex(token);
      expect(Math.max(r, g, b) - Math.min(r, g, b), `${token} has become a colour`).toBeLessThan(20);
    }
    for (const [token, floor] of [
      ['--cut', 120],
      ['--held', 60],
    ] as const) {
      const [r, g, b] = hex(token);
      expect(Math.max(r, g, b) - Math.min(r, g, b), `${token} must be unmistakably a hue`).toBeGreaterThan(floor);
    }
    // And they must be far enough apart to be told apart in a 10px bar sitting
    // beside each other. Opposite sides of the wheel is the whole point: one is
    // what was taken and the other is what is left.
    const [cr, cg, cb] = hex('--cut');
    const [hr, hg, hb] = hex('--held');
    const distance = Math.hypot(cr - hr, cg - hg, cb - hb);
    expect(distance, 'the two hues must not converge').toBeGreaterThan(150);
  });

  it('spends --cut on taken points and on nothing that is merely a state', () => {
    // The two marks that used to be gold and teal must stay neutral: a solo
    // cluster is 32 of 48 products and must never read as an alarm, and "moved by
    // demand" is a fact about arithmetic rather than a loss.
    const solo = /\.tag\.solo \{[^}]*\}/.exec(PIT_CSS)?.[0] ?? '';
    expect(solo, 'a solo cluster must not borrow a hue').not.toContain('--cut');
    expect(solo, 'a solo cluster must not borrow a hue').not.toContain('--held');
    const moved = /\.tag\.tb \{[^}]*\}/.exec(PIT_CSS)?.[0] ?? '';
    expect(moved, 'moved-by-demand must not borrow a hue').not.toContain('--cut');
    expect(moved, 'moved-by-demand must not borrow a hue').not.toContain('--held');
  });

  it('spends --held on what survived, and never on what was taken', () => {
    // The two rules that make the meter readable at a glance, stated as CSS
    // facts rather than as an intention. If either flips, the drawing means the
    // opposite of its caption and nothing else in the suite would notice.
    for (const [name, source] of [
      ['app/pit.css', PIT_CSS],
      ['engine/board/page.ts', ENGINE_PAGE],
    ] as const) {
      const body = stripComments(source);
      for (const kept of body.match(/\.(?:meter|jurorbar|bar i)[^{]*\.?kept[^{]*\{[^}]*\}/g) ?? []) {
        expect(kept, `${name}: a kept head must be --held`).toContain('--held-c');
        expect(kept, `${name}: a kept head must never be --cut`).not.toContain('--cut');
      }
      for (const taken of body.match(/\.(?:pts|ded \.pts)\s*\{[^}]*\}/g) ?? []) {
        expect(taken, `${name}: a deduction must never be --held`).not.toContain('--held');
      }
    }
    // And the rule is real in both directions: the search above has to have found
    // the heads it is asserting about.
    expect((stripComments(PIT_CSS).match(/\.kept \{[^}]*\}/g) ?? []).length).toBeGreaterThan(0);
  });
});

describe('one committed theme, and no preference branch', () => {
  for (const [name, source] of [
    ['lib/theme.ts', TOKENS],
    ['app/pit.css', PIT_CSS],
    ['engine/board/page.ts', ENGINE_PAGE],
  ] as const) {
    it(`${name} answers no prefers-color-scheme query`, () => {
      // The pit is dark. That is the identity, not a setting, so there is nothing
      // for a light-mode branch to be the other half of. Comments are stripped
      // first: prose ABOUT the absence of a branch is not a branch.
      expect(stripComments(source)).not.toContain('prefers-color-scheme');
    });
  }

  it('declares the scheme to the browser, so native chrome matches', () => {
    for (const [name, source] of [
      ['lib/theme.ts', TOKENS],
      ['app/pit.css', PIT_CSS],
      ['engine/board/page.ts', ENGINE_PAGE],
    ] as const) {
      expect(source.replace(/\s+/g, ''), `${name} must declare color-scheme`).toContain('color-scheme:dark');
    }
  });

  it('still honours prefers-reduced-motion, which is a real preference', () => {
    for (const source of [TOKENS + PIT_CSS, ENGINE_PAGE]) {
      expect(source).toContain('prefers-reduced-motion');
    }
  });
});

describe('the OG card is the theme, not a second palette', () => {
  // The share image is rasterised by satori, which resolves no `var()` and no
  // `rgb(… / a)`, so its colours have to be literals. Literals are exactly what
  // drifts, so each one is pinned to the token it is a copy of.
  const literal = (name: string): string => new RegExp(`const ${name} = '(#[0-9A-Fa-f]{6})'`).exec(OG_ROUTE)?.[1] ?? '';
  const asHex = (c: readonly [number, number, number]): string =>
    `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();

  it('uses --pit as its ground and --card as its panel', () => {
    expect(literal('GROUND').toUpperCase()).toBe(THEME.get('--pit'));
    expect(literal('PANEL').toUpperCase()).toBe(THEME.get('--card'));
  });

  it('uses --ink for its type and --cut for the one number that matters', () => {
    expect(literal('INK').toUpperCase()).toBe(THEME.get('--ink'));
    expect(literal('CUT').toUpperCase()).toBe(THEME.get('--cut'));
  });

  it('writes the derived tones at the values the browser would composite them to', () => {
    expect(literal('MUTED').toUpperCase()).toBe(asHex(over(hex('--ink'), hex('--pit'), alphaOf('--dimmer'))));
    expect(literal('RULE').toUpperCase()).toBe(asHex(over(hex('--ink'), hex('--card'), alphaOf('--line'))));
  });

  it('still clears AA at thumbnail size, where the card is actually seen', () => {
    expect(contrast(channels(literal('INK')), channels(literal('GROUND')))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(channels(literal('MUTED')), channels(literal('GROUND')))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(channels(literal('CUT')), channels(literal('GROUND')))).toBeGreaterThanOrEqual(4.5);
  });
});

describe('the emails are the theme too', () => {
  // `packages/auth/src/mail/theme.ts` is a fourth copy, and unlike the other
  // three it has no choice: mail clients strip `<style>` and do not resolve
  // custom properties, so an email's colours must be inline literals. Pinned here
  // rather than in the auth package because this is where the tokens live, and
  // the dependency runs app -> package, which `PHASE-0.md §3` allows.
  const literal = (name: string): string =>
    new RegExp(`export const ${name} = '(#[0-9A-Fa-f]{6})'`).exec(MAIL_THEME)?.[1]?.toUpperCase() ?? '';
  const asHex = (c: readonly [number, number, number]): string =>
    `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();

  it('sets the mail on --pit, in --ink', () => {
    expect(literal('MAIL_GROUND')).toBe(THEME.get('--pit'));
    expect(literal('MAIL_INK')).toBe(THEME.get('--ink'));
  });

  it('writes its muted stop at the value --dimmer composites to', () => {
    expect(literal('MAIL_MUTED')).toBe(asHex(over(hex('--ink'), hex('--pit'), alphaOf('--dimmer'))));
  });

  it('names the same families the site does, so a client that has them matches', () => {
    const family = /export const MAIL_FONT = '[^']*'/.exec(MAIL_THEME)?.[0] ?? '';
    expect(family).toContain('Archivo');
    expect(family).toContain('Helvetica Neue');
    // Not `system-ui`: that is what made the emails look like a different product.
    expect(family).not.toContain('system-ui');
  });

  it('spends neither hue, because an email has nothing taken and nothing left in it', () => {
    for (const hue of ['--cut', '--held'] as const) {
      expect(MAIL_THEME.toUpperCase()).not.toContain(THEME.get(hue) ?? '#000000');
    }
  });
});

describe('no colour escapes the token system', () => {
  // The reason there is nothing to drift inside a file is that there is no muted
  // hex anywhere: every tone is a token or an alpha of one. A raw hex outside the
  // `:root` block is the beginning of a fifth copy.
  for (const [name, source] of [
    ['lib/theme.ts', TOKENS],
    ['app/pit.css', PIT_CSS],
    ['engine/board/page.ts', ENGINE_PAGE],
  ] as const) {
    it(`${name} declares its hexes only in :root`, () => {
      const declared = new Set(
        [...(rootTokens(source).values() as Iterable<string>)].flatMap((value) => value.match(/#[0-9A-F]{6}/g) ?? []),
      );
      const start = source.indexOf('{', source.search(/:root\s*\{/));
      const rest = source.slice(source.indexOf('}', start) + 1).replace(/\/\*[\s\S]*?\*\//g, '');
      for (const found of rest.match(/#[0-9a-fA-F]{6}/g) ?? []) {
        // `#FFFBF6` is the one licensed literal: the hover state of a fill that is
        // already `--ink`, i.e. the only thing in the system brighter than the
        // brightest token. It has nothing to be a token OF.
        if (found.toUpperCase() === '#FFFBF6') continue;
        expect(declared.has(found.toUpperCase()), `${name} uses ${found} outside :root`).toBe(true);
      }
    });
  }
});
