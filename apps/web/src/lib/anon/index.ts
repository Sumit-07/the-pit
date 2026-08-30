/**
 * Anonymous listings: the one place a pseudonym or a robot is produced.
 *
 * ## The seam
 *
 * Two other surfaces need this and neither should reimplement any of it:
 *
 * - **A board row's identity slot.** `RowView.anonymous` says whether a row is
 *   anonymous and `RowView.robot` carries the finished inline SVG. A favicon is
 *   rendered for a row if and only if `anonymous` is false — an anonymous
 *   listing has no URL on the read path to fetch one from, which is the property
 *   that makes the privacy rule structural rather than a rule to remember.
 * - **A verdict page's header.** `Verdict.anonymous` and `Verdict.robot`, from
 *   the frozen payload, never from a live lookup.
 *
 * Everything here is PURE: no I/O, no database, no network, no environment. That
 * is what lets it sit on the board read path, which
 * `test/boards-read-path.test.ts` keeps free of `@the-pit/db` and of any runtime
 * import of `@the-pit/engine` — the engine appears below only as `import type`,
 * which is erased.
 *
 * ## The three files
 *
 * - `pseudonym.ts` — the hash, the designation vocabulary, and the
 *   collision-free per-category assignment.
 * - `robot.ts` — the deterministic inline-SVG avatar, drawn for 16px first and
 *   painted only in the neutral surface and ink tokens.
 * - `redact.ts` — removing a listing's name and URL from a ranking document,
 *   including from other products' free text.
 */

export { anonSeed, assignPseudonyms, DESIGNATIONS, hash32, pseudonymFor } from './pseudonym';
export { robotSpec, robotSvg, type RobotOptions, type RobotSpec } from './robot';
export { anonIdentities, redactRanking, type AnonIdentity } from './redact';
