/**
 * Prompt-injection handling, split into two functions that must not be merged.
 *
 * `DECISIONS.md` S9 is a ruled decision: detection and gating are different jobs
 * that `01 §8` conflates into one regex.
 *
 * - `screenInput` decides whether a *submission* is held for a human before it is
 *   served. It matches injection-SHAPED phrases only.
 * - `alarmOutput` runs `01 §8`'s broad regex over *model output* — juror
 *   deduction reasons, clustering reasons, persona choice reasons — records what
 *   it finds, and never gates anything.
 *
 * Why the split is load-bearing: four of the 28 categories (Developer Tools, AI
 * Agents, SEO, and their neighbours) are full of legitimate products *about*
 * prompts and systems. `01 §8`'s regex includes bare `\bprompt\b`, `\bsystem\b`
 * and `\binstructions?\b`, so on those categories it fires on ordinary product
 * copy — "a prompt library for your team", "design system tokens". Wired to a
 * gate that would hold a large fraction of honest paying customers for manual
 * review; wired to a log it is a cheap, high-recall tripwire a human reads. The
 * same regex is right for one job and wrong for the other, so there are two
 * functions.
 */

import type { FlaggedInjection } from '../types.js';

/**
 * The INPUT gate. Injection-shaped phrases only — a fixed list from
 * `DECISIONS.md` S9 and the Task 5 brief:
 *
 *   ignore (the )?(previous|above)
 *   disregard (the )?(above|previous)
 *   system prompt
 *   new instructions
 *   you are now
 *   <<<   >>>
 *
 * Bare `prompt`, `system` and `instructions` are deliberately ABSENT. Adding any
 * of them here re-creates the defect S9 exists to fix, so this list is a
 * decision, not a starting point.
 *
 * `<<<` and `>>>` are here because they are the DATA delimiters every prompt
 * wraps untrusted text in: text containing them is trying to close the block
 * early and continue outside it. (The delimiters are also neutralized when the
 * text is rendered — see `src/panels/prompts/data-block.ts` — so this is the
 * second of two independent defences, not the only one.)
 *
 * Case-insensitive. Not global: a `g` flag would make `lastIndex` persist across
 * calls on a module-level regex and silently skip matches on every other call.
 */
const INPUT_SCREEN =
  /ignore (?:the )?(?:previous|above)|disregard (?:the )?(?:above|previous)|system prompt|new instructions|you are now|<<<|>>>/i;

/**
 * `01 §8`'s regex, verbatim, for the OUTPUT alarm:
 *
 *   /ignore (the )?previous|disregard (the )?(above|previous)|\bsystem prompt\b|\binstructions?\b|\bprompt\b|\bsystem\b/i
 *
 * Kept byte-identical to the source — capturing groups and all — so it stays
 * auditable against `01 §8` rather than becoming a paraphrase of it. It is broad
 * on purpose: a juror reason that merely says the word "prompt" is worth a human
 * glance, and the cost of a false positive on a log line is a wasted glance.
 */
const OUTPUT_ALARM =
  /ignore (the )?previous|disregard (the )?(above|previous)|\bsystem prompt\b|\binstructions?\b|\bprompt\b|\bsystem\b/i;

/** What the input gate decided. `hold` true means: do not serve, route to a human. */
export interface ScreenResult {
  hold: boolean;
  /** The exact substring that tripped the gate, for the reviewer. `null` when clean. */
  matched: string | null;
}

/**
 * Screen UNTRUSTED submitted text (a product name or description) before it is
 * accepted and served.
 *
 * This is the only injection check that gates anything. It answers one question —
 * hold this submission for a human, or serve it — and it answers it on the shape
 * of an instruction, not on the presence of a topic word.
 *
 * It is not a sanitizer and not a substitute for one: text that passes here is
 * still sanitized, truncated, wrapped in `<<< >>>` and labelled DATA before any
 * model sees it (Global Constraint 2). A screen that passes is not permission to
 * trust the text.
 */
export function screenInput(text: string): ScreenResult {
  const match = INPUT_SCREEN.exec(text);
  return match === null ? { hold: false, matched: null } : { hold: true, matched: match[0] };
}

/**
 * Run `01 §8`'s broad regex over one model-produced `reason` and record a hit.
 *
 * **Never gates delivery and never holds a preview** (`DECISIONS.md` S9). The
 * score, cluster or vote that carried the reason is KEPT — `01 §8`'s rule is
 * "flag, never drop" — and the flag surfaces on the admin board for a human to
 * judge. Returning the record rather than pushing it into a list keeps this pure;
 * Task 7 collects the non-null results into `ranking.flaggedInjections`.
 *
 * ## The `FlaggedInjection` shape (pinned here)
 *
 * `01 §8` specifies only `source` and `reason`. Task 1 inferred `matched` and
 * `product_id`; this task pins all four:
 *
 * - `source` — the juror `role`, or `"uniqueness"`, or `"demand"`, exactly as
 *   `01 §8` lists them. A free string, because juror roles are generated per
 *   category and cannot be enumerated in a type.
 * - `reason` — the full reason text, unmodified. The reviewer needs the sentence,
 *   not just the trigger.
 * - `matched` — the substring that fired, so a reviewer can see at a glance
 *   whether this is the word "prompt" in a product about prompts (the common
 *   case, dismissible in a second) or an actual instruction. Without it every
 *   flag costs a full re-read of the reason.
 * - `product_id` — optional, and optional for a real reason: juror deductions and
 *   uniqueness reasons are about one product, but a persona's choice reason is
 *   about a whole cluster and has no single product to attribute it to. Absent
 *   means cluster-level, not unknown.
 *
 * @param reason The model-produced reason text.
 * @param source Juror `role`, `"uniqueness"`, or `"demand"` (`01 §8`).
 * @param productId The product the reason is about, where there is exactly one.
 */
export function alarmOutput(reason: string, source: string, productId?: number): FlaggedInjection | null {
  const match = OUTPUT_ALARM.exec(reason);
  if (match === null) return null;

  const flagged: FlaggedInjection = { source, reason, matched: match[0] };
  if (productId !== undefined) flagged.product_id = productId;
  return flagged;
}

/** `01 §8`'s fixed source labels for the two non-juror panels. */
export const INJECTION_SOURCE_UNIQUENESS = 'uniqueness';
export const INJECTION_SOURCE_DEMAND = 'demand';
