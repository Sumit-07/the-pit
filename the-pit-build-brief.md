# The Pit — build brief

> Read alongside `01-skill-reference.md` (ranking engine) and
> `02-app-conversion-design.md` (deployment). Where this document disagrees with
> either, **this document wins** — it carries corrections and decisions made after
> those were written. Ignore any earlier `techwars-agent-prompt.md`; it describes a
> duel-based design that has been replaced.

---

## Part 1 — Corrections to the ranking engine

These are defects in `01-skill-reference.md`. Fix before seeding any boards.

### 1.1 Isolated scoring bias (critical)

In a full run, jurors score up to 40 products in one prompt and spread deductions
across them. In the `--add-product` path they score **one product alone**, which
produces systematically different raw scores. Every paid submission uses that path,
so the bias lands entirely on customers.

**Fix:** include a fixed **calibration sample** of ~15 existing products from the
category in the incremental scoring prompt — shown *with their already-assigned
scores*, not re-scored. This restores comparative context. Output stays ~200 tokens
instead of ~2,400. The sample must be stable per category and versioned.

### 1.2 §7's reproducibility claim is false

The doc claims incremental scoring reproduces a full run exactly. It does not:
raw scores differ (see 1.1), and appending a product shifts population mean/std so
**every existing z-score changes**. That is correct behaviour, but it means ranks
reshuffle on every placement. Do not build anything that assumes rank stability
between placements.

### 1.3 Preview cache key

Preview results are cached on description hash alone. The same text yields a
different rank after any placement in that category. Key on:

```
(description_hash, category_snapshot_version, prompt_version, persona_version)
```

### 1.4 Chunk balancing

`chunkSize: 40` on n=44 gives chunks of 40 and 4 — the second chunk is scored
against 3 peers instead of 39. Use `ceil(n / ceil(n / 40))` so 44 splits 22/22.

### 1.5 Cluster stability

Demand votes are keyed to `cluster_id`. Re-clustering invalidates every stored vote.
Clusters are **append-only**: a new product joins an existing cluster or opens a new
one. Full re-clustering is an explicit admin operation that clears demand for that
category.

### 1.6 Watch solo clusters

Solo-cluster products get `z_demand = 0` while demand is 35% of core. Log whether
solo-cluster products systematically over- or under-rank once several categories
are seeded. No fix yet — measure first.

---

## Part 2 — Auth, payments, attempts

Not covered in either existing doc.

### 2.1 Auth: guest checkout, magic link afterwards

**No login at submission.** Nothing sits between a visitor and their purchase.

1. Guest checkout — URL, name, description, pay
2. Dodo webhook fires → create account server-side from the email Dodo collected →
   enqueue run
3. Verdict lands at a **public permanent URL**, shareable, works logged out
4. Returning later (balance, re-pitch, history) → magic link to that same email

No GitHub, no Google. Dodo supplies a verified email with the payment, so a magic
link to that address matches the payer with no extra identity system and no
guest-payment claiming flow.

**Magic link implementation:**

- Table: `tokens(token_hash, email, expires_at, used_at, created_at)`
- Store **SHA-256 of the token**, never the raw value. 15-minute expiry, single use.
- `POST /auth/request` → always respond "check your inbox" regardless of whether the
  email exists (no account enumeration)
- `GET /auth/verify` renders a **button**; a `POST` does the actual verification.
  Corporate mail scanners (Outlook Safe Links) follow GET links and would burn
  single-use tokens. Do not skip this.
- Rate limit per email and per IP
- Session cookie, signed, 90 days
- SPF + DKIM + DMARC on the sending domain — budget more time for DNS than for code

**Public vs private:** verdict URLs are public. Attempt balance and history are
behind the session.

### 2.2 Payments — Dodo (Merchant of Record)

- Fees: 4% + $0.40, +1.5% international cards. Assume **5.5% + $0.40**.
- **No auth-and-void needed** (see 2.3). Immediate capture is fine.
- Grant attempts on the **signed webhook**, never on the success redirect.
- Webhook handler must be **idempotent** — Dodo retries.
- Idempotency key on job creation so a double-clicked submit doesn't buy twice.
- $30 per dispute, $1 per refund, $5 payout fee under $1,000, $50 minimum payout,
  bi-monthly payouts (1st–15th → 18th, 16th–EOM → 4th).
- **Verify before launch:** whether Dodo holds new-merchant payouts (many MoRs hold
  the first 14–30 days). Not confirmed.

### 2.3 Attempts

- **$5 = 1 attempt. $15 = 3 attempts + fit report.** Keeps $5 as the atomic unit so
  "same five dollars for everyone" stays literally true.
- An attempt is **consumed only on delivery** — decrement in the same transaction
  that writes the verdict and marks it delivered. Not on job start, not on pipeline
  completion.
- **Failures are free retries.** Provider timeout, rate limit, worker crash → no
  decrement.
- **Partial success is a failure.** If the Six scored but the Floor call failed, the
  composite is missing 35% of its weight. Retry only the failed phase (cache makes
  completed calls free) and deliver once whole. Never deliver a degraded verdict.
- **Disliking the result is not a failure.** State this on the purchase page.
- **Cap free retries at 3 per attempt**, then route to a support queue. Otherwise a
  user can burn compute by killing the connection repeatedly.
- Attempts never expire.

### 2.4 Re-pitching

- A new attempt **replaces** the previous listing. Never keep-the-best — that is a
  slot machine, exploitable on variance alone, and matches Dodo's prohibited
  "chance-based reward mechanics" language.
- Require **materially changed description text**.
- **Show the attempt count publicly** — "3rd pitch" next to the rank.
- **One pitch per product per recalibration cycle.** Not "3 per day" — tie it to the
  rebuild, so the rejection carries a countdown ("next pitch after tonight's rebuild,
  02:00 UTC") rather than an arbitrary limit.
- Cap is **per product, not per account**. Someone with four side projects should be
  able to submit all four tonight.
- Check before payment (client, fast feedback) **and** before enqueue (server,
  authoritative).

### 2.5 URL normalization

Key the per-product cap on a normalized URL. Copy outbid's rules, which exist because
they already fought the evasion cases:

- Lowercase, strip protocol, `www.`, trailing slash
- Strip all query parameters (kills affiliate/referral/UTM variants)
- Resolve link shorteners to their target and store that
- Index the normalized column

Evasion via a genuinely different URL: **flag for review, do not hard-block.** A false
rejection on a paying customer is worse than an extra run.

### 2.6 Free preview

The only cost that scales with traffic rather than sales, and the only line that can
run away. One juror, one metric, returns a rank **band** not a number.

- Turnstile + per-IP rate limit. No login.
- Hard daily ceiling that degrades to "previews paused, back tomorrow" rather than
  silently spending.
- **Hold flagged submissions** rather than serving them — the injection policy is
  flag-not-drop, which on a free unmoderated tier means a flagged result still gets
  returned.

---

## Part 3 — Recalibration

- **Top 20 per category nightly**, full board weekly. Cost then scales with category
  count (controlled) rather than product count (uncontrolled).
- Boards are **CDN snapshots**, regenerated on placement. Reads never touch a model.
- Recalibration is free to users — it's ~$17–25/month total across 15 categories.
- Email on rank movement is the retention hook ("boards rebuilt, you moved 7 → 11").
  Month-two feature, but **capture the email from day one**.
- Monitor `discrimination` and `avg_metric_spread` per category as drift alarms.

### Changing the panel later

A juror swap means a new weight vector, a new composite, a reshuffled board, and a
`prompt_version` bump that invalidates cache. Handle it as a season change:
pre-announce, keep old snapshots permanently addressable at dated URLs so issued
verdict cards still resolve, label boards by jury version, and **shadow-run the
candidate panel for one cycle** before switching.

Do **not** pick replacement jurors by how often users select them — that measures
perceived leniency. Use drop-one contribution (recompute without juror J, measure
rank correlation) and agreement with real Mob votes.

---

## Part 4 — The three panels

| Name | What it is | Affects rank |
|---|---|---|
| **The Six** | Six critics. Start at 100, deduct with reasons. Merit. | Yes |
| **The Floor** | Six simulated buyers. Forced choice within cluster. Demand. | Yes |
| **The Mob** | Real visitors doing the **identical task** to the Floor. | Separate board |

**The Mob is the differentiator.** Same forced choice, same cluster, same schema — so
synthetic demand and real demand are directly comparable per cluster. Costs zero model
calls. No competitor has this dataset.

Rules:

- **Never serve someone duels from their own category.**
- **Vote before seeing the Floor's verdict**, or you're measuring anchoring.
- Close the loop: "you agreed with the Floor 6 of 8 times."
- Show divergence on the board — a marker on rows where Mob and Floor disagree, with
  a running count.

### Custom panels (fit report)

- **Canonical run** — always the default Six and default Floor. This is what places
  you on the board. Identical for everyone.
- **Custom panel run** — user selects from a **curated pool** (~12 pre-approved
  archetypes per category). Off-board advisory report. Never writes to rankings.
- **No user-authored personalities.** Juror mandates enter the prompt as
  *instructions*, not inside the `<<< >>>` data block — free text there is a far worse
  injection surface than product descriptions, and bypasses `validate_jury`.
- Capture the founder's **hypothesis before the reveal** (expected jurors + expected
  customer segments), locked at submission. The product is the chosen-vs-actual gap.
- **No rank appears on the fit report.** Any number that looks like a leaderboard
  position gets screenshotted as one.

### B2B vs consumer

Categories carry a `type` field (`b2b` / `consumer` / `prosumer`). It drives juror
mandate generation **and** panel labels — B2B boards can say "The Panel" and "The
Buyers" where consumer boards say "The Six" and "The Floor". Same data, register that
fits the room.

---

## Part 5 — Brand and copy

- **Domain:** thepit.show (primary), thepit.lol (redirect)
- **Headline:** You can't outbid the pit.
- **Sub:** Everyone walks in at 100. Fewest cuts wins.
- **Terms line:** $5 to enter. That's all money does here.
- **CTA:** Throw it in · $5
- **Closer:** Throwing money in the pit just makes noise.
- **Connective word:** *cuts*. Keep it on every surface — it's the one thread that
  runs from the loud homepage to the plain verdict page. "Runlet took 97 in cuts."

Voice: aggressive on the homepage, plain everywhere behind it. Never name outbid
directly — the dig lands for anyone who knows and stands alone for anyone who doesn't.

**Never promise a rank in copy.** The verdict card is stamped with a timestamp and
product count precisely because the board moves.

---

## Part 6 — Surfaces

Visual reference: `the-pit-home.html`, `platform-surfaces-mockup.html`.

**Homepage** — board occupies most of the page, above the fold on mobile. Categories
auto-rotate every 7s with a progress bar; rows stagger in on switch. Rows darken as
they descend (the pit is literal). Motion comes from *rotating categories and arriving
verdicts*, never from rank churn.

**Category board** — free, CDN-cached, deduction ledgers expandable per row. Lead with
deductions and reasons, not composites. Numeric ratings stay small and secondary.

**Verdict page** — public permanent URL, works logged out. Every deduction with its
reason and juror, the cluster judged inside, which Floor personas picked them.
Timestamped and product-count-stamped. Downloadable.

**Status page** — resumable. Someone who closes the tab at 40s returns to live
progress, not a spinner or a dead job.

---

## Part 7 — Infrastructure

| | Launch | At scale |
|---|---|---|
| Vercel Pro (Hobby forbids commercial) | $20 | $20 |
| Postgres (Neon) | $19 | $25 |
| Inngest | $0 | $75 |
| Resend | $0 | $20 |
| Domains | $5 | $5 |
| Recalibration inference | $17 | $25 |
| **Total** | **$61** | **$170** |

Per $5 sale: Dodo −$0.68, inference −$0.08, previews/storage −$0.05 → **net $4.19**.
**Breakeven ≈ 15 sales/month.**

**Inngest step granularity matters more than cost.** Make each *phase* one step that
fires its calls in parallel inside it — not one step per juror call. Free tier is 50K
executions and **5 concurrent steps**; a 6-way fan-out as separate steps throttles
badly. The vote cache makes a retried phase nearly free, so losing per-call retry
granularity costs nothing.

Also required at launch: **Vercel spend caps**, an **Anthropic spend alarm**,
**moderation before anything renders publicly** (classifier on submit + review queue +
admin kill switch), **Sentry**, and **backups of the score log** — it's the integrity
record if anyone disputes a ranking.

**Seeded listings:** mark clearly as unclaimed, offer one-click opt-out, and keep
juror reasons critical of the *pitch* rather than the company.

---

## Build order

1. Fix Part 1 defects in the skill, seed 2 categories locally (one B2B, one consumer),
   report vote spread and `discrimination`
2. Postgres schema + Inngest pipeline + status page
3. Dodo checkout → webhook → attempts ledger
4. Verdict page (public URL) + magic link
5. Homepage + category boards, CDN-cached
6. The Mob voting
7. Fit report

Ship 1–5. Everything after is week two.
