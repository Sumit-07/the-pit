/**
 * The site's theme, for the two surfaces that are emails.
 *
 * These are the only surfaces in the product that cannot use the token system.
 * An email is rendered by Gmail, Outlook and a dozen clients that strip `<style>`
 * blocks and do not resolve CSS custom properties, so every colour has to be an
 * inline literal. That is a constraint of the medium, not a licence for a second
 * palette: each value below is one of `apps/web/src/lib/theme.ts`'s own tokens,
 * written out, and `apps/web/test/theme-drift.test.ts` reads this file and fails
 * if one of them stops matching the token it is a copy of.
 *
 * It is in `packages/auth` rather than imported from `apps/web` because
 * `PHASE-0.md §3` runs the dependency the other way; the drift test is what holds
 * them together, and the test dependency points from the app toward the package.
 *
 * Before this file the two emails carried `#0b0b0c` on `#e8e8ea` in `system-ui` —
 * the palette the redesign replaced everywhere else. The magic-link *screens* were
 * brought onto the shared theme in that pass and the *emails* that send people to
 * them were missed, so the first thing a customer ever saw of The Pit was the one
 * surface that looked like a different product.
 *
 * There is no accent here, and that is the rule working rather than an omission:
 * `--cut` means "this was taken", and nothing has been taken from anyone in a
 * sign-in email.
 */

/** `--pit`: the ground. */
export const MAIL_GROUND = '#1A1610';

/** `--ink`: the text, and the fill of the one button. */
export const MAIL_INK = '#EDE6DE';

/**
 * `--dimmer` (`--ink` at .66) composited over `--pit`.
 *
 * Written as a resolved hex rather than as `opacity:.7`, which is what these
 * emails used to do. Opacity is inconsistently supported across clients, and the
 * value it happened to land on was below WCAG AA on this ground — which is the
 * usual way small print in a dark email becomes unreadable.
 */
export const MAIL_MUTED = '#A59F98';

/**
 * The site's own family stack.
 *
 * Not `system-ui`: an email client that has Archivo should set the mail in it,
 * and one that does not falls back to exactly what the website falls back to.
 */
export const MAIL_FONT = '16px/1.5 "Archivo","Helvetica Neue",Helvetica,Arial,sans-serif';

/** The shared `<body>` opener. One string, so the two emails cannot drift apart. */
export const MAIL_BODY_STYLE = `margin:0;padding:24px;background:${MAIL_GROUND};color:${MAIL_INK};font:${MAIL_FONT}`;

/** The one action in either email: a lit fill with the ground as its type. */
export const MAIL_BUTTON_STYLE =
  `display:inline-block;padding:12px 20px;background:${MAIL_INK};color:${MAIL_GROUND};` +
  'text-decoration:none;border-radius:6px;font-weight:600';

/** Small print: the resolved muted stop, never an opacity. */
export const MAIL_SMALL_STYLE = `font-size:14px;color:${MAIL_MUTED}`;
