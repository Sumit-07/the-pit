/**
 * Every Postgres enum in the schema, in one file, each citing the document that
 * fixed its members.
 *
 * They are enums rather than `text` + a check because the value set is closed and
 * the app reads them back into TypeScript unions: `pgEnum` gives Drizzle the
 * union type for free, so a typo is a compile error rather than a row nobody
 * queries. Adding a member is `ALTER TYPE ... ADD VALUE` in a migration, which is
 * the review friction we want on a value set that gates money or delivery.
 */

import { pgEnum } from 'drizzle-orm/pg-core';

/**
 * Category archetype. Source: `brief` Part 4 — "Categories carry a `type` field
 * (`b2b` / `consumer` / `prosumer`). It drives juror mandate generation **and**
 * panel labels." Same members as `CategoryType` in `@the-pit/engine`.
 */
export const categoryType = pgEnum('category_type', ['b2b', 'consumer', 'prosumer']);

/**
 * Where a product came from.
 *
 * `seeded` is `brief` Part 7's cold-start scaffolding — "mark clearly as
 * unclaimed, offer one-click opt-out" — and `DECISIONS.md` OPEN-1's drain
 * threshold counts `paid` rows per category, so the two have to be
 * distinguishable in a single indexed predicate rather than inferred from a null
 * `submitted_by_email`.
 */
export const productSource = pgEnum('product_source', ['seeded', 'paid']);

/**
 * A product's lifecycle.
 *
 * `02 §9` sketched `('preview','pending','placed','rejected')`. `preview` is gone:
 * `DECISIONS.md` S13 kills the preview→place funnel outright ("`02` §2 and §10 are
 * dead"), and `brief §2.6`'s free preview returns a rank BAND and persists
 * nothing, so it never produces a product row. `held` is added for `brief §2.6`
 * and `02 §8`: a flagged submission is held for moderation, not dropped
 * (`DECISIONS.md` S9's flag-not-drop).
 */
export const productStatus = pgEnum('product_status', ['pending', 'placed', 'held', 'rejected']);

/**
 * One slot of a forced choice. Source: `01 §5.3` / `CHOICE_SCHEMA`.
 *
 * `none` is not in `02 §9`'s `('first','second')` and has to be: `DemandChoice`
 * carries `none: true` for "nothing in this set was worth adopting", and that row
 * is the difference between a persona who declined a cluster and a persona who
 * was never asked about it. Without it the raw votes cannot reconstruct
 * `demandLog`, and reconstructing `demandLog` exactly is the whole reason the raw
 * votes are the source of truth (`02 §7`).
 *
 * Shared by `demand_votes` and `mob_votes` on purpose: `brief` Part 4 requires
 * the Mob to do "the **identical task** to the Floor … same forced choice, same
 * cluster, same schema — so synthetic demand and real demand are directly
 * comparable per cluster". Two enums would let them drift apart.
 */
export const demandPick = pgEnum('demand_pick', ['first', 'second', 'none']);

/**
 * Whether a ranked row's `core` carries a demand term. Source: `DECISIONS.md` S3
 * and S11, and `DemandStatus` in `@the-pit/engine`.
 */
export const demandStatus = pgEnum('demand_status', ['scored', 'solo_cluster']);

/**
 * What a job is for.
 *
 * - `preview` — `brief §2.6`'s free tier: one juror, one metric, a band. Persists
 *   no product; the row exists for the daily ceiling and the per-IP rate limit.
 * - `placement` — a paid submission (`brief §2.1`'s guest checkout).
 * - `full_run` — an admin seed or re-seed of a whole category (`01 §4`).
 * - `recalibration` — `brief` Part 3's nightly top-20 / weekly full board. Not in
 *   `02 §9`, which predates Part 3.
 */
export const jobKind = pgEnum('job_kind', ['preview', 'placement', 'full_run', 'recalibration']);

/**
 * A job's state, as the resumable status page (`brief` Part 6) reads it.
 *
 * `failed` does NOT mean the customer was charged: `brief §2.3` makes failures
 * free retries, and the attempt ledger records that by simply never writing a
 * `consume` row. `held` is the moderation queue.
 */
export const jobStatus = pgEnum('job_status', ['queued', 'running', 'succeeded', 'failed', 'held']);

/**
 * Why an attempt ledger row exists. The discriminant an audit reads first.
 *
 * - `grant` — `brief §2.2`: attempts appear on a SIGNED WEBHOOK and nowhere
 *   else, never on the success redirect.
 * - `consume` — `brief §2.3`: one attempt, on delivery, in the transaction that
 *   writes the verdict.
 * - `adjustment` — a human's decision: a refund, a support credit, a correction.
 *   The ledger is append-only, so a mistake is fixed by a compensating row and
 *   never by an UPDATE. Without this member the only way to correct one would be
 *   to edit history, which is the design the table exists to refuse.
 *
 * Matches `AttemptEntryReason` in `@the-pit/payments`, which is the service that
 * writes these rows.
 */
export const attemptKind = pgEnum('attempt_kind', ['grant', 'consume', 'adjustment']);

/**
 * An order's state at the payment provider. `brief §2.2` prices a dispute at $30
 * and a refund at $1, so both need to be visible on the row rather than inferred
 * from a later event.
 */
export const orderStatus = pgEnum('order_status', ['paid', 'refunded', 'disputed']);

/**
 * Which of `DECISIONS.md` S9's two jobs a flag came from. They are deliberately
 * not one thing:
 *
 * - `input` — the narrow injection-shaped phrase gate on submitted text. This one
 *   GATES: a match holds the submission for moderation (`brief §2.6`).
 * - `output` — `01 §8`'s broad regex over juror / cluster / persona reasons. This
 *   one is an alarm and NEVER gates delivery or holds a preview.
 *
 * Storing them in one table with no discriminator would make the admin board
 * unable to tell a held customer from a logged curiosity.
 */
export const injectionStage = pgEnum('injection_stage', ['input', 'output']);
