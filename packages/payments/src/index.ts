/**
 * `@the-pit/payments` — the money path.
 *
 * Everything the brief calls a rule about money or about who may submit lives
 * here, as pure logic behind small interfaces, so it can be tested with no
 * network, no database and no API key, and so it composes with whatever schema
 * the web app grows around it.
 *
 * The rules, and where each one is enforced:
 *
 * | `brief` | Enforced by |
 * |---|---|
 * | §2.2 grant on the signed webhook only | `handleDodoWebhook`; `resolveSuccessRedirect` takes no store |
 * | §2.2 idempotent webhook | `grantIdempotencyKey` + a UNIQUE index |
 * | §2.2 idempotent job creation | `jobIdempotencyKey` + a UNIQUE index |
 * | §2.3 $5 = 1 attempt, $15 = 3 | `PRICE_TIERS`, `tierForPayment` |
 * | §2.3 consumed only on delivery | `AttemptsLedger.deliver`, inside one `DeliveryTx` |
 * | §2.3 failures are free retries | `decideAttempt` |
 * | §2.3 partial success is a failure | the engine's `RunOutcome` union, read by `decideAttempt` |
 * | §2.3 cap free retries at 3 | `FREE_RETRY_CAP` |
 * | §2.4 re-pitch replaces | `planRepitch`, which is given no score to compare |
 * | §2.4 materially changed text | `materialChange` |
 * | §2.4 one pitch per product per cycle | `checkSubmissionLocal` + `cycleAt` |
 * | §2.5 normalized URL | `normalizeSubmissionUrl`, wrapping the engine's `normalizeUrl` |
 * | `DECISIONS.md` S12 category, pre-payment | `checkSubmission` + the `SubmissionClearance` brand |
 * | `DECISIONS.md` S8 | left OPEN as `RepitchPolicy`, a required argument with no default |
 *
 * ## Storage vocabulary
 *
 * Nothing here names a table or a column. The four ids this package passes
 * around — `accountId`, `runId`, `listingId`, `verdictId` — are `accounts.id`,
 * `jobs.id`, `products.id` and `verdicts.id` in `@the-pit/db`, and the mapping
 * lives once, at that boundary, in `packages/db/src/identity.ts`. It re-declares
 * `AttemptEntry` and `VerdictWrite` structurally and asserts mutual assignability
 * against the real types, so a field changed here fails that package's typecheck
 * rather than silently writing the wrong column.
 */

export * from './hash.js';
export * from './money.js';

export * from './attempts/decide.js';
export * from './attempts/ledger.js';
export * from './attempts/types.js';

export * from './checkout/fixture-transport.js';
export * from './checkout/session.js';
export * from './checkout/signature.js';
export * from './checkout/types.js';
export * from './checkout/webhook.js';

export * from './listing/repitch.js';

export * from './submission/category.js';
export * from './submission/cycle.js';
export * from './submission/guards.js';
export * from './submission/job.js';
export * from './submission/material-change.js';
