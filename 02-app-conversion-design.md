# Category Jury Ranking → Deployed App: Design & Recommendation

> How to turn the local CJR skill into a public, high-concurrency web app where
> visitors browse per-category rankings and submit their own product to be
> evaluated and (optionally) placed among the ranked set. This assumes a
> **relational database (Postgres)** and **object/bucket storage + CDN** are
> available. It is a recommendation, not a locked plan — the numbers trace back
> to the skill reference (`01-skill-reference.md`).

---

## 1. The problem the app must solve

The skill is a batch tool: a human runs 7 steps per category, approves 3 gates,
and reads a local board. An app inverts two things:

1. **Reads must be instant and cheap** — thousands of visitors browsing static
   rankings should never touch a model.
2. **Writes are slow and expensive** — evaluating one submitted product is an
   inherently multi-second, multi-call LLM job (§6), and it must not corrupt the
   curated ranking or let arbitrary user text drive the jury.

The core architectural move is therefore **split reads from writes**: serve
precomputed ranking JSON from a CDN, and process submissions through an async
worker pool that returns a `job_id`.

---

## 2. The placement model — *Ephemeral preview, opt-in permanent*

This is the decision that shapes everything else. A submitted product is
evaluated in one of two tiers:

### Preview tier (default, for everyone)

- **Lock-free, stateless, horizontally scalable.** The submission is scored
  against the category's *frozen* jury + personas + existing product set, and
  the visitor is shown **where their product would land** — its rank, core,
  merit, demand, scorecard, and the personas' picks.
- The result is **not persisted** into the ranking. It is cacheable by a
  **content-hash of the submitted description** (same text → same preview, no
  re-spend).
- Because nothing is mutated, any number of previews can run concurrently,
  bounded only by the global token budget (§5).

### Permanent tier (opt-in, moderated)

- The submitter (or a moderator) explicitly opts to **place the product in the
  real ranking.** This path:
  1. acquires a **per-category single-writer lock**,
  2. appends the product to the category's stored set,
  3. recomputes the ranking (incremental, §7),
  4. republishes the category's `ranking.json` snapshot to the bucket/CDN,
  5. releases the lock.
- Guarded by moderation, dedup, per-user quota, and a cost budget (§8).

**Why this split:** previews are the common case and must be fast, cheap, and
safe — they can never damage the curated data because they never write to it.
Permanence is rare, deliberate, and serialized, so contention and moderation
are manageable.

---

## 3. High-level architecture

```
                         ┌──────────────┐
   Browser (SPA) ───────▶│   CDN / edge │   (static: index.json, ranking.json snapshots)
        │  reads         └──────────────┘
        │                        ▲  republish on permanent placement
        │ POST /submit           │
        ▼                 ┌───────────────┐        ┌──────────────────┐
   ┌─────────┐  enqueue   │  API service  │──rows─▶ │  Postgres         │
   │  API    │──────────▶ │  (stateless,  │◀──────  │  (source of truth)│
   │ gateway │            │   many pods)  │        └──────────────────┘
   └─────────┘            └──────┬────────┘
        ▲  job_id / SSE          │ job on queue
        │                        ▼
        │                 ┌───────────────┐   Anthropic Messages API
        └── result ◀──────│  Worker pool  │──▶ (global token-bucket limiter)
                          │  (evaluators) │
                          └───────┬───────┘
                                  │ writes snapshot
                                  ▼
                          ┌──────────────┐
                          │  Bucket      │──▶ CDN
                          └──────────────┘
```

### Components

| Component | Role | Scaling |
|---|---|---|
| **SPA (static)** | The current `frontend/index.html`, repointed at CDN JSON. | Served from CDN; infinite. |
| **API service** | Accepts submissions, returns `job_id`, streams results (SSE/poll), serves signed read URLs. Stateless. | Horizontal, many pods. |
| **Worker pool** | Runs the evaluation (the port of `run_category.mjs` + `rank_final.py`). | Horizontal, capped by token budget. |
| **Queue** | Decouples submit from evaluate; holds jobs. | Managed (SQS/PubSub/Redis). |
| **Postgres** | Source of truth: products, scoreLog rows, clusters, demand votes, jobs, jury/persona snapshots. | Primary + read replicas. |
| **Bucket + CDN** | Published artifacts: `index.json`, per-category `ranking.json`. | Managed. |

---

## 4. Reads: precomputed snapshots

- The board never computes anything at read time. `build_index.py` and
  `rank_final.py` already emit exactly the JSON the SPA consumes; the app keeps
  that contract and simply **publishes those files to the bucket** behind the
  CDN.
- A permanent placement is the *only* event that regenerates a category's
  `ranking.json`; the worker writes the new snapshot and invalidates the CDN
  path for that one category. Everything else is a cache hit.
- **Preview results are returned to the one requester** (via the job result),
  never written to the shared snapshot — so reads stay immutable between
  permanent placements.

---

## 5. Writes: async jobs + a global rate limiter

Evaluation is multi-second (≈5–10 s with parallel fan-out) and multi-call, so a
synchronous request would tie up a connection and blow past provider rate
limits under load. Instead:

1. `POST /submit` validates input, computes the description content-hash, checks
   the preview cache, and if missed **enqueues a job** and returns `202 {job_id}`.
2. The SPA subscribes to results via **SSE** (or polls `GET /job/{id}`).
3. A **worker** pulls the job and runs the evaluation.
4. **A global token-bucket limiter** sits in front of every Anthropic call so
   that N workers never collectively exceed the account's tokens-per-minute /
   requests-per-minute. Workers block on the bucket, not on each other.

**Concurrency rules:**
- **Previews:** unlimited concurrency, bounded only by the token bucket. No
  locks (they don't write shared state).
- **Permanent placements:** a **per-category single-writer lock** (a Postgres
  advisory lock or a row lock on the category). Only one placement mutates a
  given category at a time; different categories proceed in parallel.

---

## 6. The evaluation engine: what a worker runs

A worker reproduces the skill's spend-side, minus the human gates (which are
replaced by *frozen, pre-approved* juries and panels — see §8).

**Recommended: a lean Messages API port.** Reimplement the three phases
directly against the Anthropic Messages API rather than shelling out to headless
Claude Code / the Agent SDK. The skill's logic is small and already isolated:

- Port `scorePrompt` / `uniquenessPrompt` / `choicePrompt` (the exact prompts in
  `run_category.mjs`) verbatim.
- Port the JSON schemas (`SCORE_SCHEMA`, `UNIQ_SCHEMA`, `CHOICE_SCHEMA`) as
  tool/`response_format` constraints.
- Port `rank_final.py` **unchanged** — it's pure Python over JSON and needs no
  model. This is the single most valuable reuse: the ranking math (z-norm,
  demand reduction, uniqueness nudge, health) stays byte-for-byte identical to
  the skill, so the app and the skill can't diverge.

Why the port over headless CC: lower latency and cost per call, no subprocess
management, native batching and **prompt caching**. (Headless CC / Agent SDK
stays a viable fallback if you want the Workflow orchestration for free, at
higher per-call overhead.)

**Prompt caching:** the shared, stable prefix — the rubric (metrics + anchors),
the full product list, and the cluster sets — is identical across the 5 jurors
and across all personas within a category. Mark it as a cache breakpoint so only
the per-juror mandate / per-persona identity is uncached. On a full-category run
this is the bulk of the tokens.

**Model tiers (unchanged from the skill):** jurors → haiku; clustering +
personas → sonnet. Keep them configurable per deployment.

---

## 7. Incremental placement — the common write

Placing **one new product** into an already-evaluated category must not re-run
the whole panel. The incremental path:

| Phase | Full run | `--add-product` (one new product) |
|---|---|---|
| Scoring | 5 × chunks | **5** (one call — the 5 jurors score just the new product; low effort) |
| Clustering | 1 | **1** (assign the new product to an existing cluster or a new one) |
| Customer | `personas` (≈6) | **0–6** (only personas of clusters whose membership changed re-choose) |
| Rank | local | local (re-derived exactly) |

- **Merit z-norm is re-derived exactly** by `rank_final.py` from the raw
  `scoreLog` rows in Postgres — appending one product's scores and re-running
  the pure-Python ranker reproduces the same z-scores as a full run, because the
  composite is computed from the stored raw 0–100 scores, not from cached
  z-values.
- **Demand is set-local:** only the clusters the new product joins need their
  personas to re-choose; untouched clusters keep their stored votes.
- **Realistic cost:** ≈ 6–12 calls, roughly **$0.05–0.15** on the lean port —
  versus a full re-run.

This is why Postgres stores **raw `scoreLog` rows, cluster assignments, and
demand votes** rather than only the reduced ranking: incremental placement and
exact recomputation both require the raw inputs.

---

## 8. Guardrails (the human gates, replaced)

The skill's three approval gates protected against a bad jury, a bad panel, and
runaway spend. In the app, submissions must never be able to regenerate or
influence the jury/personas. Replacements:

- **Frozen, human-approved juries & personas.** A jury/panel is generated and
  approved *offline* (the skill's Steps 2–3) and stored, versioned, in Postgres.
  A submission is scored against the frozen set; it **can never trigger jury or
  persona regeneration.** Only an admin action bumps a version.
- **Injection: flag-not-drop, on all untrusted input.** The submitted name +
  description run through `sanitize` and the `INJECTION` regex before entering
  any prompt (and are always wrapped `<<< >>>` as DATA). Flags are stored and
  shown; the product is not silently dropped, but a flagged submission can be
  held for moderation.
- **Moderation** on the permanent tier: a submission is placed only after
  passing content moderation (and optionally a human moderator for flagged
  ones).
- **Dedup** by description content-hash and by URL, so the same product can't be
  placed twice.
- **Per-user quota** (submissions/day) and a **global cost budget** with a
  per-submission ceiling (≈ **$0.10/submission** target on the lean port).
  Workers check the budget before spending.

---

## 9. Data model (Postgres, sketch)

```
categories(id, name, slug, type, jury_version, persona_version, snapshot_url, updated_at)
jury_versions(category_id, version, metrics_json, jurors_json, approved_by, created_at)
persona_versions(category_id, version, personas_json, approved_by, created_at)
products(id, category_id, name, url, description, description_hash,
         status ENUM('preview','pending','placed','rejected'), submitted_by, created_at)
score_rows(product_id, juror_role, metric, score, deductions_json, prompt_version)
clusters(id, category_id, cluster_id, label)
cluster_members(cluster_id, product_id)
demand_votes(product_id, persona_name, cluster_id, pick ENUM('first','second'),
             strength, reason, flagged)
jobs(id, kind ENUM('preview','placement','full_run'), category_id, product_id,
     status, cost_cents, result_json, created_at, finished_at)
flagged_injections(source, product_id, persona_or_role, cluster_id, reason, created_at)
```

- **Source of truth = these raw rows.** `ranking.json` is a *derived artifact*
  pushed to the bucket, always reproducible by running the ported `rank_final`
  over the rows.
- The `jobs` table drives SSE/polling and gives an audit + cost ledger.

---

## 10. Request lifecycles

**Preview:**
```
POST /submit {category, name, description, mode:"preview"}
  → sanitize + injection-scan + hash
  → cache hit? return cached preview
  → else enqueue job(kind=preview); return 202 {job_id}
Worker: score(1 product, frozen jury) ∥ assign cluster
      → persona re-choice for the joined cluster(s)
      → ported rank_final over (stored rows + this product, in-memory)
      → result_json = the product's rank/core/merit/demand/scorecard/picks
SPA: SSE delivers result; nothing persisted to the shared snapshot.
```

**Permanent placement:**
```
POST /place {job_id or submission}  (after preview, opt-in)
  → moderation + dedup + quota + budget checks
  → acquire per-category writer lock
  → persist product + score_rows + cluster_members + demand_votes
  → ported rank_final over the full category → new ranking.json
  → upload snapshot to bucket; invalidate CDN path for this category
  → release lock
```

---

## 11. What ports directly vs. what is new

| Reused from the skill | New for the app |
|---|---|
| `rank_final.py` (all math) — port unchanged | API service + queue + worker pool |
| The three prompts + schemas | Global token-bucket limiter |
| Model tiers (haiku/sonnet) | Per-category single-writer lock |
| Injection regex + `sanitize` | Postgres schema + snapshot publisher |
| The `ranking.json` / `index.json` contract | Preview cache, dedup, quota, moderation, cost ledger |
| The SPA (`frontend/index.html`) | Incremental `--add-product` code path |

---

## 12. Summary of the recommendation

1. **Split reads (instant, CDN-served precomputed JSON) from writes (async
   worker jobs).**
2. **Ephemeral preview by default; opt-in, moderated, single-writer permanent
   placement.**
3. **Port `rank_final.py` unchanged** and reimplement the three prompt phases on
   the **Messages API** with prompt caching; keep haiku/sonnet tiers.
4. **Postgres holds raw scoreLog / clusters / demand votes as source of truth;
   `ranking.json` snapshots in a bucket are the published artifact.**
5. **A global token-bucket** governs provider limits; **per-category locks** only
   for permanent writes.
6. **Frozen human-approved juries/personas** replace the interactive gates;
   submissions can never regenerate them. Injection stays flag-not-drop.
7. **Incremental placement** keeps a single-product add to ≈6–12 calls
   (≈$0.05–0.15) by re-scoring only the new product and re-choosing only the
   affected clusters, with z-norm re-derived exactly from the raw rows.

The one non-negotiable inherited rule survives the port: **one category at a
time, ranked on merit — never a cross-category leaderboard, never price.**