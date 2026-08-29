# The Pit — decision log

Answers to contradictions found across `the-pit-build-brief.md`, `01-skill-reference.md`,
`02-app-conversion-design.md`. Precedence: brief > 01 > 02. This file records where the
brief was silent or the docs disagreed.

## Resolved

### S1 — Juror count: SIX (was 5 in 01)
`01` §4 hard-validated `jurors == 5`. Brief/homepage/mockup all say "The Six".
- `validate_jury` must require **6**, not 5.
- Jury generation prompt asks for 6 mandates; 6-key weight vector per metric.
- Cost formula becomes `6 × chunks + 1 + personas` (13 calls at n <= chunkSize).
- `01` §7.1 `5 × chunks` and §5.1 "all 5 jurors" are SUPERSEDED.

### S2 — Scarcity tilt: KEPT, and made visible
`rank_key = core + 0.075*(U-50)/50` stays (`UNIQ_LAMBDA = 0.075`).
- Verdict page must show the scarcity score and its reason.
- NEW design work: no slot exists in either mockup. Needs a name that fits the
  "cuts" vocabulary without reading as a purchasable bonus.

### S5 — Description limit: STAYS AT 300
Seeded median is 141 chars; paid submissions will use the full 300. Accepted as a
known population asymmetry because seeds are cold-start scaffolding, to be removed
once enough real products are onboarded.
- Phase 1 report must still measure paid-vs-seeded score drift, so the size of the
  asymmetry is known before it matters.
- See OPEN-1: seed removal is a population swap with real consequences.

### S4 — Phase 1 seed categories
Developer Tools (48 usable, b2b) + Health, Fitness & Wellness (44 usable, consumer).
H&F n=44 exercises chunk-balancing fix 1.4 (44 -> 22/22, not 40/4) and is the worked
example in `01` §7.3, so results are comparable to the prior local run.

### S13 — `02` §2 and §10 are dead
`02`'s "ephemeral preview showing full rank/merit/demand/scorecard, opt-in permanent"
is replaced by brief §2.6 (one juror, one metric, a rank BAND) plus guest checkout.
No preview -> place funnel.

### S3 — Solo cluster: renormalize to merit-only
The Floor only convenes on clusters with >=2 members (`01` §5.3). When no demand signal
exists, rank on merit at weight 1.0 rather than `0.65*z_merit + 0.35*0`.
- `rank_final.py` change: renormalize MERIT_W/DEMAND_W per product when `demand_raw`
  has no entry, instead of substituting z_demand = 0.
- Verdict page must state why the Floor did not convene.
- Note: this AMPLIFIES merit for solo products in both directions (a strong solo
  product gains 0.35*z_merit, a weak one loses the same), so it is not a novelty
  bonus and cannot be gamed by writing an idiosyncratic description.
- Interaction with S2: a solo product also tends to score high on scarcity, earning
  the +0.075 tilt. Novelty is therefore credited twice. The tilt is ~7.5% of one
  population std, so the effect is a few places at most — accepted, but Phase 1 should
  report solo-cluster products' scarcity distribution to confirm the size.

### S11 — Empty Floor is a DELIVERY, not a partial failure
Follows from S3. Brief §2.3 says "Six scored but Floor failed" is a failure requiring
retry. The Floor phase must therefore return an explicit terminal status distinguishing
`skipped: solo_cluster` (legitimate, deliver, consume the attempt) from a genuine call
failure (retry free, do not deliver). Without this, every solo-cluster submission burns
3 free retries and lands in the support queue after a successful run.

### S9 — Injection: split detection from gating
Two different jobs, currently conflated into one regex.
- INPUT gate (decides hold-vs-serve): injection-shaped phrases only — "ignore previous",
  "disregard the above", "system prompt". Bare `prompt`/`system`/`instructions` REMOVED.
- OUTPUT alarm (juror/cluster/persona reasons): keep `01` §8's broad regex, log to
  `flagged_injections` and surface on the admin board, but it NEVER gates delivery or
  holds a preview.
- Motivated by Developer Tools + AI Agents + SEO categories being full of legitimate
  products about prompts and systems.

### S12 — Category: user picks, classifier blocks obvious mismatches
Category choice moves rank more than copy editing and was previously free and
unmoderated — a violation of the standing rule that rank must not be improvable by
anything other than resolution.
- Cheap classifier at submission, run BEFORE payment so nobody pays for a rejection.
- On mismatch: reject with the suggested correct category.

### S15 — GitHub OAuth vs §2.1's "No GitHub, no Google"
`brief §2.1` says it literally, and the founder has since shipped GitHub OAuth as one
of three sign-in paths (magic link, capability URL, GitHub). Read as a ban on the
words, that is a contradiction. Read as the answer to the question §2.1 was asking —
*what identifies the payer?* — it is not, and the sentence stands.

**Why §2.1's design is intact.** The paragraph gives its own reason: "Dodo supplies a
verified email with the payment, so a magic link to that address matches the payer with
no extra identity system and no guest-payment claiming flow." Both clauses still hold.

- **The payer identity is unchanged.** GitHub matches *against* the verified payment
  email. `completeOAuthSignIn` takes only addresses GitHub reports as
  `"verified": true`, looks for an `accounts` row with that address, and answers
  `no_purchase_found` when there is none. It never becomes the identity; it resolves to
  the one §2.1 chose.
- **It cannot mint an account.** `AuthStore` has `findAccountByEmail` and deliberately
  no `createAccount`; `IdentityStore` has none either. The only INSERT into `accounts`
  in the repository is `createPostgresWebhookAccounts.ensureAccount`, called from the
  signed Dodo webhook. **An account is a purchase** — there is no signup, no invitation
  and no "sign in with GitHub to get started".
- **There is still no guest-payment claiming flow.** Claiming would mean an unpaid
  identity acquiring a paid account. What GitHub does is the reverse: a session that
  already proves the account attaches a provider link to it, or a verified provider
  address matches a payment that already exists. Neither direction hands anybody an
  account they did not buy.
- **It is not on the buying path.** Guest checkout stays the default on every device
  (`brief §2.1`: "Nothing sits between a visitor and their purchase"). OAuth sits beside
  the funnel, and linking is retroactive by design — someone who paid on a phone reaches
  their account by capability URL and connects GitHub afterwards, converging on the same
  row.

What actually changed is the number of ways a returning customer reaches an account that
already exists, and the reason is delivery risk rather than identity: a magic link is a
bet on SPF/DKIM/DMARC, which want a fortnight at `p=none` plus reputation warm-up, and
until then "check your inbox" is a promise the infrastructure cannot keep — worst for
the corporate mailboxes most likely to have paid.

**The constraint that comes with it: GitHub perks are procedural or informational,
NEVER positional.** No perk may touch rank, ordering, weighting, tie-breaks, or
visibility on a board. A login-conferred rank advantage is the same violation as a
purchased one in a different currency, on the product whose whole line is "$5 to enter.
That's all money does here." The four perks currently offered, and why each is inside
the line:

| Perk | Kind | Why it is not positional |
|---|---|---|
| Ownership verification skips the review hold | procedural | Changes how fast a submission is *processed*, not how it scores. The held run gets the same panel. |
| Claiming a seeded listing | procedural | Transfers who administers a row. `brief` Part 7 already promises seeded listings a one-click opt-out; this is the other end of the same lever. |
| The verified-builder marker | informational | A fact about the submitter rendered beside the listing. It enters no composite and no sort. |
| Frictionless re-pitch | procedural | Removes a round trip through email. `brief §2.4`'s cycle cap and materially-changed-text rule apply unchanged. |

Anything proposed later that cannot be put in one of those two columns is refused, and
`packages/engine` is where that is enforced structurally: nothing in `rank/` takes an
account, a session, or an identity, so a positional perk cannot be implemented without a
new argument someone has to review.

### S16 — The cycle cap's clock reads `products`, never `submissions`
`brief §2.4` caps pitches at one per product per recalibration cycle, and the obvious
place to read "when was this last pitched" is the `submissions` row the checkout route
writes. That is wrong, and the reason is the ordering S12 already fixed.

A `submissions` row is written **before** the buyer leaves for Dodo — it has to be,
because a 300-character description does not fit in Dodo metadata and only its id may
cross a third party. So a cap keyed on it would fire for a checkout that was opened and
never paid: an honest user who changed their mind at the card form has locked their own
product out of tonight's board, and anybody else can lock any product out of any night
for free, from a form with no login on it.

So `ListingSnapshot.lastPitchedAt` is sourced from the first artifact of a **paid**
pitch — `products.created_at`, or the latest `verdicts.delivered_at` once a re-pitch has
delivered — and is NULL for a seeded row, which nobody has pitched. `createPostgresListingStore`
is the one query that answers this, and `submissions` is not in it.

What it costs, stated: two payments for one product inside the seconds between the first
settlement and the first placement both clear the lock. The window is a placement's
latency, both are genuinely paid, and `jobs_idempotency_key_uk` still collapses them to
one run when the description is unchanged. That is a better failure than a free lockout
lever on the buying path.

### OPEN-1 RESOLVED — Seed removal: per-category threshold, drained gradually
- A category sheds seeds only once it holds N paid products (N ~ 25-30, chosen to stay
  well clear of the n>=8 floor from `01` §4).
- Then drop lowest-ranked seeds a few at a time across nightly rebuilds, never in one
  cutover, so rank movement stays inside normal recalibration noise.
- Before dropping any seed, check it is not the last cluster peer of a paid product
  (that would silently push a paying customer into a solo cluster).

## Open

Not blocking Phase 1. Needed before the phase named in brackets.

- **S6** [Ph.7] Nightly top-20 recalibration puts two scoring epochs into one z-norm:
  20 products carry tonight's raw scores, the rest carry last week's.
- **S7** [Ph.7] Does nightly recalibration re-run the Floor? If yes, cluster membership
  shifts and §1.5 says that clears demand. If no, 35% of the composite is stale while
  65% moves nightly.
- **S8** [Ph.3/4] Re-pitch "replaces the listing" (§2.4) vs permanent shareable verdict
  URLs (Part 6) vs `02` §8 dedup-by-URL forbidding a second placement. Also: does a
  re-pitched product keep the cluster it joined under its old description?
- **S10** [Ph.5] Preview cache key (§1.3) includes `category_snapshot_version`, which
  bumps on every placement and every nightly rebuild — so the cache on the only
  traffic-scaling cost line almost never hits. A rank BAND is coarse enough to survive
  population drift on `(description_hash, prompt_version)` alone.
- **S14** [Ph.5] The "Landing now" feed is cross-category, and `01` §9 rule 2 forbids a
  cross-category leaderboard. Does the feed show ranks, or only names and cut totals?
- **S4-source** [Ph.1] 913 of 1028 seeded descriptions were written by outbid.lol, not
  by the founders. Opt-out is decided; re-scraping vs labelling the source is not.
- **Cost re-baseline** [Ph.1] Brief Part 3 budgets $17-25/mo across 15 categories; the
  data has 28. Six jurors instead of five adds ~20% on top.
