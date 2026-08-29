# Phase 0 — Orientation

Answers the four questions in `the-pit-agent-prompts.md` Phase 0. No code.

---

## 1. The system in one page

**The Pit ranks products inside one category, never across categories.** A visitor pays
$5, and three panels evaluate the submission. Two of them move rank; one is a parallel
human dataset.

**The Six (merit).** Six critics each score every product on 3–6 category-tailored
metrics, 0–100. Each starts every metric at 100 and takes points *off*, pairing each
deduction with a reason of 20 words or fewer; deductions for a metric must sum to
exactly `100 − score`. The six carry the **same metrics but different weights** — the
panel's disagreement is structural, living in the weight vector, not in the rubric.
Raw scores are z-normalized **per juror, per metric, across products** before combining,
so a lenient juror cannot dominate a harsh one. The mean of those weighted z-scores over
the six jurors is the **merit composite**.

**The clustering pass (one call).** Groups products whose core idea is essentially the
same into clusters, and scores each product 0–100 for **scarcity** — how rare the idea
is, not how good. Serves three roles: it defines the comparison sets the buyers choose
within, it feeds a small bounded tilt on final rank, and it is the within-set redundancy
signal.

**The Floor (demand).** Six synthetic buyer personas, each a specific customer with
needs and a price sensitivity — not a judge. For every cluster with 2+ members each
persona makes one **forced choice**: which one product would you adopt, how strongly,
or none. First pick counts 1.0, runner-up 0.5. Reduced per product into
`0.4·breadth + 0.6·intensity` — breadth is in-cluster vote share times the fraction of
personas active in the cluster, intensity is the mean of that product's top-2 conviction
scores. **Intensity-leaning by design**: a niche favourite two personas love strongly
still climbs.

**The Mob (separate board).** Real visitors doing the *identical* forced choice, in a
cluster from a category that isn't theirs, voting before they see the Floor's answer.
Costs zero model calls, does not affect rank, and is the one dataset a competitor can't
copy. Divergence between Mob and Floor is surfaced on the board.

**What determines rank:**

```
core     = 0.65·z(merit) + 0.35·z(demand)      # both re-standardized before blending
rank_key = core + 0.075·(scarcity − 50)/50     # bounded tilt, ±0.075 only
```
Where a product has no cluster peers the Floor cannot convene, and merit is
renormalized to weight 1.0 rather than being blended against a zero.

**No model call ever produces or sees a rank.** Every call returns raw scores, cluster
assignments, or a buyer's pick. All ranking arithmetic is pure code, run afterwards over
the stored raw rows — which is why a ranking can be recomputed offline, for free, and
why the score log is the integrity record if a placement is ever disputed.

**The 13 calls** (one product, one category, at n ≤ chunk size):
6 jurors + 1 clustering + 6 personas. A full category seed is
`6 × ceil(n/chunk) + 1 + 6`; Developer Tools at n=48 is 6×2+1+6 = **19**.

---

## 2. Where 01 and 02 conflict with the brief

Confirmed: **the brief wins in every case.** Eight were resolved with the founder and
are recorded in `DECISIONS.md`; the rest are listed below with the resolution applied.

| # | `01`/`02` says | Brief says | Resolution |
|---|---|---|---|
| S1 | `validate_jury` requires **exactly 5** jurors (§4); cost is `5 × chunks` (§7.1) | "The Six", six critics (Part 4); mockups say `six v3` | **Six.** Validator, weight vectors and cost formula all change. |
| S2 | Scarcity tilts rank, `UNIQ_LAMBDA = 0.075` (§6.3) | Never mentions uniqueness or scarcity, anywhere | **Kept, and made visible** on the verdict page. New design surface. |
| S3 | Solo cluster → `z_demand = 0` (§6.2) | §1.6: "measure first, no fix yet" | **Renormalize to merit-only** when no demand exists. |
| S5 | `sanitize` truncates at 300 (§7.1) | — | **300 stays.** Seeds are cold-start scaffolding. |
| S9 | Injection regex matches bare `prompt`/`system`/`instructions`, applied to juror output (§8) | §2.6: flagged previews are held, not served | **Split.** Narrow phrase list gates input; broad regex is an output alarm that never gates. |
| S11 | — | §2.3: Six-scored-but-Floor-failed is a failure | Floor returns an explicit terminal status; `skipped: solo_cluster` is a **delivery**. |
| S12 | — | Standing rule: rank must not be improvable except by resolution | Category choice was free arbitrage. **Classifier blocks mismatches pre-payment.** |
| S13 | `02` §2: free preview returns full rank, merit, demand, scorecard, picks; opt-in placement afterwards | §2.6: one juror, one metric, a **band**; guest checkout places you | **`02` §2 and §10 are dead.** No preview→place funnel. |
| 1.1 | `--add-product` scores one product alone | Include ~15 pre-scored peers as calibration | Brief. **The most important fix in the project.** |
| 1.2 | `02` §7: incremental "reproduces the same z-scores as a full run" | False — appending shifts mean/std, every z moves | Brief. Nothing may assume rank stability between placements. |
| 1.4 | `chunkSize: 40` → n=44 splits 40/4 | `ceil(n / ceil(n/40))` → 22/22 | Brief. |
| 1.5 | Clusters implicitly re-derived per run | Append-only; full re-cluster is an admin op that clears demand | Brief. |
| — | `01` §1/§9: no API key, no deployment, no auth, no payments; local subagents | Part 7: Vercel, Neon, Inngest, Dodo | Brief. `01` §9 rule 1 describes the **local skill**, not the product. |
| — | `01` §9 rule 2: never a cross-category leaderboard | Homepage rotates categories; "Landing now" feed | Rotation complies. The landing feed is **open (S14)**. |

**Data-level conflicts found by inspecting the Excel, not stated in any doc:**

- The brief's recalibration budget assumes **15 categories**; the data has **28**.
  With six jurors instead of five, the Part 7 figure of $17–25/month is low by roughly
  2.2×. To be re-baselined with measured token counts in the Phase 1 report.
- **913 of 1028 usable descriptions were scraped from outbid.lol**, plus 61 more
  truncated from it. Only 172 are first-party. Jurors will be deducting points from
  pitches the companies did not write. Opt-out is decided; source labelling is **open**.
- Seeded median description is **141 characters** against a 300-char submission limit,
  so paid products enter with roughly twice the surface area of the board they join.

---

## 3. Repo structure and stack

**Agreed with the default**, with one substitution and one addition.

```
Next.js 15 (App Router) on Vercel Pro   — app, API routes, Inngest handler
Postgres on Neon + Drizzle              — source of truth: raw score rows
Inngest                                 — pipeline, one step per PHASE
Dodo Payments                           — merchant of record, guest checkout
Resend                                  — magic links, rank-movement email
Cloudflare Turnstile                    — free-preview gate
Sentry                                  — errors, with spend alarms
TypeScript throughout, Vitest           — engine and app in one language
```

**Substitution — the ranker is TypeScript, not ported Python.** `02` §6 calls porting
`rank_final.py` unchanged "the single most valuable reuse," and that reasoning holds
when a Python skill and a Python app must not diverge. Here there is no Python skill:
`01` is a specification of code that does not exist on this machine. Running Python
inside a Vercel/Inngest pipeline to preserve parity with an absent original buys
nothing and costs a second runtime on the critical path. The math moves to TypeScript,
and the safety net is **hand-computed golden fixtures** — small cases (n=4, n=5) whose
expected z-scores, demand reductions and health metrics are worked out by hand from
`01` §6 and committed as the oracle. A second implementation transcribed from the same
spec by the same reader would share any misreading; hand-computed expectations do not.

**Addition — a pluggable model client.** Every model call goes through one interface
with two adapters: the Anthropic Messages API for real runs, and a deterministic
fixture adapter for tests. The engine is therefore fully testable with no API key —
which matters, because **no `ANTHROPIC_API_KEY` is currently set on this machine**.

```
the-pit/
  packages/engine/          # no Next.js, no DB — pure evaluation + ranking
    src/rank/               # composite, demand, blend, health   ← the math
    src/panels/             # score / uniqueness / choice prompts + schemas
    src/model/              # Messages API adapter + fixture adapter
    src/ingest/             # Excel → products, sanitize, URL normalization
    src/config/             # every constant from 01 §7.1 + the corrections
    test/golden/            # hand-computed fixtures — the oracle
  apps/web/                 # Next.js: boards, verdict, checkout, Inngest  (Phase 2+)
  cjr/                      # run artifacts: products, results, ranking JSON
  DECISIONS.md  PHASE-0.md
```

`packages/engine` never imports from `apps/web`. The engine is a library the pipeline
calls, so the whole ranking path stays runnable from a local CLI — which is what
Phase 1 needs, and what makes disputes reproducible later.

---

## 4. Still ambiguous — not blocking Phase 1

Carried in `DECISIONS.md` under Open, with the phase each one blocks: S6 (nightly
top-20 recalibration mixes two scoring epochs into one z-norm), S7 (does nightly re-run
the Floor?), S8 (re-pitch replaces the listing vs permanent shareable verdict URLs vs
cluster identity), S10 (preview cache key invalidates hourly on the only
traffic-scaling cost line), S14 (cross-category landing feed), the outbid description
source question, and the cost re-baseline.

**One thing Phase 1 cannot answer without a key:** seeding two categories requires real
model calls. Everything up to the seed run — engine, ingest, prompts, validators,
dry-run projection, the full report harness — is buildable and testable now.
