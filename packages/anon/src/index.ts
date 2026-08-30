/**
 * Anonymous listings: the one place a designation, a robot, or a redaction is
 * produced.
 *
 * ## Why this is a package and not a folder in `apps/web`
 *
 * It started as one, and could not stay there, because three callers need it and
 * no two of them are allowed to reach the same folder:
 *
 * 1. **The board read path** (`apps/web/src/lib/boards/`) redacts a stored
 *    ranking before projecting it. That path may not import `@the-pit/db` —
 *    `test/boards-read-path.test.ts` walks the module graph from every public
 *    board route and fails if a database driver appears on it, because a board is
 *    a CDN snapshot and `brief` Part 3 says reads never touch a model.
 * 2. **The seed builder** (`packages/db/src/seed/build.ts`) freezes a verdict
 *    payload for every cold-start listing, and every one of those listings is
 *    anonymous (`DECISIONS.md`, S4-source). It cannot import from `apps/web`:
 *    `PHASE-0.md §3` forbids a package depending on the app.
 * 3. **The verdict page**, which renders the frozen payload back.
 *
 * A folder in the app satisfies (1) and (3) and leaves (2) freezing real names
 * into `verdicts.payload` — a leak in the permanent record rather than on a page,
 * which is worse, because the page can be fixed and a frozen document cannot.
 * Duplicating the generator would put two answers to "what is this listing
 * called" in a system whose whole claim is that a shared verdict link keeps
 * showing what it showed.
 *
 * So it is a package with **no runtime dependencies at all** — the engine appears
 * only as `import type` in `redact.ts`, erased at compile time. That is what lets
 * it sit on the board read path without being on the forbidden list: there is
 * nothing here to open a connection with.
 *
 * ## The three files
 *
 * - `pseudonym.ts` — the hash, the call-sign vocabulary, and the collision-free
 *   per-category assignment.
 * - `robot.ts` — the deterministic inline-SVG avatar, drawn for 16px first and
 *   painted only in the neutral surface and ink tokens.
 * - `redact.ts` — removing a listing's name and URL from a ranking document,
 *   including from other products' free text.
 *
 * ## The seam
 *
 * Two other surfaces consume this and neither should reimplement any of it:
 *
 * - **A board row's identity slot.** `RowView.anonymous` says whether a row is
 *   anonymous and `RowView.robotSeed` carries the designation to draw from. A
 *   favicon is attached if and only if `anonymous` is false — and an anonymous
 *   row has no `url` and no `href` to derive one from, so the rule is structural
 *   rather than remembered.
 * - **A verdict page's header.** `Verdict.anonymous` and `Verdict.robot`, from
 *   the frozen payload, never from a live lookup.
 */

export { anonSeed, assignPseudonyms, DESIGNATIONS, hash32, pseudonymFor } from './pseudonym.js';
export { robotSpec, robotSvg, type RobotOptions, type RobotSpec } from './robot.js';
export { anonIdentities, redactRanking, type AnonIdentity } from './redact.js';
