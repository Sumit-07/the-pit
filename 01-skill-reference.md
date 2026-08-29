# Category Jury Ranking — Complete Skill Reference

> A precise, exhaustive specification of the `category-jury-ranking` (CJR)
> skill: what it does, every parameter and constant, how the jury and the
> customer panel are selected, and the exact ranking mathematics. This is the
> source-of-truth reference — every number here is copied from the code, not
> from memory. File/line citations point at the installed skill.

---

## 1. What the skill is

CJR ranks products **within a single category** by merit — never by price, and
never across categories. It answers "which products in *this* category win on
their own terms," by combining three independent panels of local Claude Code
subagents (dispatched through the **Workflow** tool):

1. **Merit jury** — 5 critics score every product 0–100 on a category-tailored
   rubric. Produces a per-product **merit composite**.
2. **Uniqueness / clustering pass** — one subagent groups near-duplicate ideas
   and rates each product's scarcity 0–100. Serves *three* roles: a small
   graded nudge on the final rank, the "similar-app sets" the customers choose
   within, and a within-set redundancy signal.
3. **Customer-demand panel** — ~6 synthetic buyer personas each make a forced
   choice *within* each set of similar apps (adopt which one, how strongly, or
   none). Produces a per-product **demand** signal.

Merit and demand are **co-primary**; uniqueness is a bounded tilt. Everything
runs locally: **no Anthropic API key, no deployment, no auth, no payments.** The
board is a stdlib HTTP server showing **one category at a time** — there is
deliberately no cross-category leaderboard, because categories are not
comparable.

### Design invariant: why a scorecard, not raw scores

Absolute LLM scores cluster and drift between jurors. Four guardrails keep the
0–100 resolution honest (`SKILL.md:28`):

1. **Anchored scales** — each metric defines what 100/80/50/20 concretely mean.
2. **Deduction reasons** — jurors start at 100 and take points *off* with a
   reason; the deduction log is both the differentiator and the readable "why."
3. **Per-juror z-normalization** before combining — cancels scale/shift drift
   so a "hot" juror can't dominate.
4. **A disagreeing jury** — all 5 jurors score the *same* metrics but carry
   different **weights**; structural tension lives in the weight divergence.

---

## 2. Pipeline overview

```
                 ┌─────────────────────────────────────────┐
  products.json  │  Workflow: run_category.mjs               │
  jury.json  ───▶│                                           │
  personas.json  │  Phase 1 (parallel):                      │
                 │    Score      ── 5 jurors × chunks         │
                 │    Uniqueness ── 1 clustering pass         │
                 │                     │                      │
                 │  Phase 2 (after Uniqueness):               │
                 │    Customer   ── 1 call per persona,       │
                 │                  over similar-app sets     │
                 └───────────────────┬───────────────────────┘
                                     │  results.json
                                     ▼
                 rank_final.py  ──▶  ranking.json  ──▶ build_index.py ──▶ serve.py
```

- **Score ∥ Uniqueness** run in parallel (both read only the products).
- **Customer** depends on the clusters, so it runs after Uniqueness.
- Ranking mathematics happen entirely in `rank_final.py` (Python), *after* the
  Workflow returns — the Workflow only gathers raw votes/scores. This means the
  ranking can be recomputed offline from `results.json` without spending tokens.

---

## 3. Files the skill reads and writes

`cjr_lib.Paths` (`scripts/lib/cjr_lib.py:28`) defines every path. `slug()`
lowercases the category and collapses non-alphanumerics to single dashes.

```
cjr/
  index.json                          # build_index.py — the board's category list
  references/jurors/<slug>.json       # generate_jury.py --save  (APPROVED jury+rubric)
  references/personas/<slug>.json     # generate_personas.py --save (APPROVED panel)
  runs/<slug>/products.json           # prepare_category.py
  runs/<slug>/results.json            # the Workflow return value (you Write it)
  runs/<slug>/uniqueness.json         # only for the retrofit path (apply_uniqueness.py)
  runs/<slug>/ranking.json            # rank_final.py  (what the board renders)
```

No database. All state is flat JSON on disk.

---

## 4. Step-by-step procedure (per category)

There are **three approval gates**; spend never happens before all three fire.

### Step 1 — Prepare products (`prepare_category.py`)

```
python3 scripts/prepare_category.py --xlsx <abs>/outbid_all_categories.xlsx --category "X" --workdir ./cjr
```

- Reads the Excel sheet **`All Products`**; filters `Category == X`; sorts by
  the `Rank` column.
- For each row: `sanitize_description(Description)` (strips control chars,
  collapses whitespace, trims to **300 chars**); rows with an empty description
  are **dropped** (can't be judged).
- Emits `products.json = {category, products:[{id, name, description, url,
  orig_rank}]}` where `id` is a 0-based index into the *usable* rows, `name` =
  `Product Name`, `url` = `Website URL`, `orig_rank` = `Rank`.
- **If fewer than 8 usable products remain, the category is skipped
  downstream** (`run_category.mjs:396`, `if (n < 8)`). Tell the user rather than
  forcing a run.

### Step 2 — Generate the jury + rubric — **APPROVAL GATE 1**

```
python3 scripts/generate_jury.py --category "X" --xlsx <abs>/outbid_all_categories.xlsx
```

This prints a **generation prompt** (it does not call any model). It samples
the first **15** taglines (`sample_taglines`, `k=15`) and infers a provisional
type via a keyword heuristic (`infer_type_hint`: counts b2b words like
`compliance, soc 2, enterprise, procurement, api, infrastructure, sales, crm,
security, workflow` vs consumer words `you, your, fun, game, photo, personal,
daily, free`).

Dispatch **one subagent** with that prompt. It returns JSON:
`{type, prompt_version, metrics:[3–6], jurors:[5]}`. Save to a temp file, then
install:

```
python3 scripts/generate_jury.py --category "X" --save /tmp/jury.json --workdir ./cjr
```

`--save` runs `validate_jury` (`generate_jury.py:9`) and installs to
`cjr/references/jurors/<slug>.json` only if valid. **Validation rules
(exact):**

- `type ∈ {b2b, consumer, prosumer}`.
- `prompt_version` present (truthy).
- `metrics` is a list of length **3–6**. Each metric: non-empty `name`,
  non-empty `description`, and **all four anchors** `"100" "80" "50" "20"`
  non-empty. Metric names must be **unique**.
- `jurors` length is **exactly 5**. Each juror: non-empty `role`, `who`,
  `cares_most`, `biased_against`, `voice`. Roles must be **unique**.
- Each juror's `weights` is an object keyed by **exactly the metric names** (no
  missing, no extra), every value a **number ≥ 0**, and the **sum > 0**.

**STOP and show the user** the type, the metrics with anchors, and the 5
mandates + weights. The jury must genuinely disagree: at least one juror's
heavily-weighted metric must be another's near-zero metric. If weak, edit the
installed JSON and **bump `prompt_version`** (invalidates cached results). Do
not proceed until approved.

### Step 3 — Generate the customer panel — **APPROVAL GATE 2**

```
python3 scripts/generate_personas.py --category "X" --xlsx <abs>/outbid_all_categories.xlsx
```

Prints a generation prompt (same tagline sampling + type heuristic). Dispatch
one subagent; it returns `{persona_version, personas:[6]}`. Save and install:

```
python3 scripts/generate_personas.py --category "X" --save /tmp/personas.json --workdir ./cjr
```

`--save` runs `validate_personas` (`generate_personas.py:8`). **Validation
rules (exact):**

- `persona_version` present.
- `personas` is a list of length **4–8** (the prompt *asks* for 6, 5–7
  acceptable, but the validator's hard bounds are 4–8).
- Each persona: non-empty `name`; non-empty `description`; `needs` a **non-empty
  list** of non-empty strings; `price_sensitivity ∈ {low, medium, high}`
  (case-insensitive).
- Persona `name`s must be **unique**.

**STOP and show the user** the roster. The segments must be genuinely different
buyers — at least one price-insensitive capability-chaser and at least one
high-price-sensitivity defector. Edit + bump `persona_version` if weak. Do not
proceed until approved.

### Step 4 — Dry-run — **APPROVAL GATE 3**

Invoke **Workflow** with `scriptPath: scripts/run_category.mjs` and
`args: {products, jury, personas, config:{dryRun:true}}`. It prints the
**projected agent-call count** (see §7) and spends nothing. Show the user the
projection and budget. On approval, re-invoke without `dryRun`.

### Step 5 — Save results

The real run returns `{scoreLog, uniqueness, demand, flaggedInjections, meta}`.
**Write** it (Write tool) to `cjr/runs/<slug>/results.json`.

- `uniqueness = {clusters, products:[{id, uniqueness_score, cluster_id,
  reason}], uniqueness_version}`.
- `demand = {personas, demandLog:[{persona, choices:[{cluster_id, first_pick,
  second_pick, strength, reason, none}]}], demand_version}`.

*Retrofit path* (a run scored before uniqueness existed): run a standalone
clustering subagent into `cjr/runs/<slug>/uniqueness.json`, then
`python3 scripts/apply_uniqueness.py --category "X"` stashes it into
`results.json` (and strips any legacy uniqueness metric from `scoreLog` so the
composite stays merit-only; idempotent).

### Step 6 — Rank + index

```
python3 scripts/rank_final.py --category "X" --workdir ./cjr
python3 scripts/build_index.py --workdir ./cjr
```

`rank_final.py` reads `results.json` + `products.json` + the installed
`jury.json` (authoritative for metrics + weights) and writes `ranking.json`
(full schema in §6). `build_index.py` scans all `runs/*/ranking.json` into
`cjr/index.json`.

### Step 7 — Serve the board

```
python3 scripts/serve.py --workdir ./cjr --port 8765
```

`http://localhost:8765`. Left rail = categories with a discrimination badge;
each board shows **Score** (core), **Merit**, **Demand**, and a column per
metric; expand a row for per-metric bars, jury spread, deduction reasons
tagged by juror role, and the customer picks; a "moved" badge marks rows whose
final rank differs from pure merit; a ◇ badge shows uniqueness `U0–100`; a
panel lists flagged possible-injection reasons.

---

## 5. The three panels in detail

### 5.1 Merit jury (Phase "Score")

- **Who runs:** all 5 jurors, dispatched in parallel (`scoreSet`,
  `run_category.mjs:329`). Each juror scores the whole product set, **chunked**
  by `cfg.chunkSize` (default 40) to bound prompt length. So a juror makes
  `ceil(n / chunkSize)` calls.
- **Model:** `juror.model` if the mandate carries one, else `cfg.model`
  (default `haiku`). **Effort: `low`.**
- **Prompt** (`scorePrompt`, `run_category.mjs:300`): gives the juror its
  mandate (role/who/cares_most/biased_against/voice), the metric rubric with all
  four anchor levels, and the product list. Method is **start at 100 and
  deduct**; each deduction pairs points with a ≤20-word reason, and the
  deductions for a metric **must sum to exactly (100 − score)**. A perfect
  metric is score 100 with an empty deductions list.
- **Output schema** (`SCORE_SCHEMA`, `run_category.mjs:151`): `{scores:[{id,
  note?, metrics:[{name, score, deductions:[{points, reason}]}]}]}`.
- **Injection scan:** every deduction `reason` is tested against the `INJECTION`
  regex; matches are pushed to `flaggedInjections` (flag, never drop).

### 5.2 Uniqueness / clustering pass (Phase "Uniqueness")

- **Who runs:** exactly **one** subagent over the whole set
  (`uniquenessPrompt`, `run_category.mjs:351`). **Model:** `cfg.clusterModel`
  (default `sonnet`). **Effort: `medium`.**
- **What it does:** (1) groups products whose core idea is essentially the same
  into clusters (a solo idea is a cluster of one), labels each; (2) scores every
  product 0–100 for **scarcity** — *not* quality — from within-set redundancy +
  world-knowledge market saturation (100 = rare/novel, no close analog and
  little saturation; 50 = familiar with a few peers; 0 = crowded commodity);
  (3) a ≤20-word reason per product.
- **Output schema** (`UNIQ_SCHEMA`, `run_category.mjs:188`): `{clusters:[{cluster_id,
  label, member_ids:[…]}], products:[{id, uniqueness_score, cluster_id,
  reason}]}`.
- These clusters are **reused** as the customer panel's similar-app sets.
- Injection scan runs over each product `reason` (source `"uniqueness"`).

### 5.3 Customer-demand panel (Phase "Customer")

- **Similar-app sets** (`similarSets`, `run_category.mjs:247`): uniqueness
  clusters with **≥ 2 members** (a solo idea offers no choice). Each set lists
  its member apps as DATA.
- **Who runs:** **one subagent per persona** (`run_category.mjs:465`), each over
  *all* sets at once. **Model:** `cfg.personaModel` (default `sonnet`).
  **Effort: `medium`.** Runs only if `personas.length > 0` **and**
  `sets.length > 0`.
- **Prompt** (`choicePrompt`, `run_category.mjs:260`): frames the agent as a
  *specific customer*, not a judge — name/situation/needs/price-sensitivity —
  and for each set asks for a single forced choice among near-substitutes:
  - `first_pick`: the id they'd adopt (omit / `none:true` if none is worth it).
  - `second_pick`: optional runner-up id.
  - `strength`: 0–100 conviction behind the first pick.
  - `reason`: ≤20 words in their own voice.
- **Output schema** (`CHOICE_SCHEMA`, `run_category.mjs:220`): `{choices:[{cluster_id,
  first_pick?, second_pick?, strength?, reason, none?}]}` (`cluster_id` + `reason`
  required).
- Injection scan runs over each choice `reason` (source `"demand"`).

---

## 6. The ranking algorithm (`rank_final.py`) — exact mathematics

All ranking math lives in `_score_products` (`rank_final.py:199`), shared by
`rank_from_scores` and `jury_health` so the board and the health stats always
agree. Helper `_clamp(x, 0, 100, default=50)` guards every raw score; `_pop_std`
is population standard deviation.

### 6.1 Merit composite (`compute_composite`, `rank_final.py:55`)

For each juror, weights are normalized to sum 1 over the metric names
(`_normalize_weights`: negatives→0; all-zero→uniform `1/len`). Then:

```
For each juror jl:
  For each metric m:
    v[i]   = the juror's 0–100 score for product i on m   (missing → 50.0)
    z[i]   = (v[i] − mean_i v) / popstd_i v                (popstd==0 → 0)
    composite[i] += weight_jl[m] · z[i]
composite[i] /= juror_count            # mean over jurors
```

So the composite is **the mean, over jurors, of Σ_metric (normalized weight ×
per-juror per-metric z-score across products).** Per-juror z happens *before*
combining — this is guardrail #3. Merit is fully independent of demand and
uniqueness.

### 6.2 Demand reduction (`reduce_demand`, `rank_final.py:129`)

Cluster membership comes from `uniqueness` (`products[].cluster_id`, else
`clusters[].member_ids`). If there's no demand log or no clusters →
returns `({}, {})` (graceful: no signal). Let `P = len(demandLog)` (number of
personas who returned choices). For **each cluster** with members:

```
Collect each persona's choice for this cluster.
For a valid pick (not "none", first_pick set and a member):
    votes[first_pick]  += 1.0
    votes[second_pick] += 0.5    (if a member)
    strengths[first_pick].append(clamp(strength, default=50))
    picked_personas.add(persona)

total_votes = Σ votes over members
capture     = |picked_personas| / P          # fraction of personas active in this cluster

For each member product pid:
    share     = votes[pid] / total_votes      (0 if total_votes==0)   # in-cluster, normalized
    breadth   = share × capture                                       # broad, contested appeal
    intensity = mean(top-2 of strengths[pid]) / 100                   # niche/private love
    demand_raw[pid] = 0.4·breadth + 0.6·intensity                     # BREADTH_W, INTENSITY_W
```

The blend is **intensity-leaning** (0.6 vs 0.4): a niche favourite that one or
two personas love strongly still climbs, even without broad capture. Products
in solo clusters (or clusters the panel skipped) get no demand entry → their
demand contribution is neutral (z = 0, see below). `reduce_demand` also returns
per-product `detail`: `{demand, breadth, intensity, capture, share, picks:[…]}`
where `picks` lists each persona, whether it was a 1st or 2nd pick, the
strength, and the reason.

### 6.3 Blending into `core` and `rank_key` (`rank_final.py:199`)

```
z_merit  = standardize(composite)         # population z across all products
z_demand = standardize(demand_raw)        # products with no demand → 0.0
core[i]     = 0.65·z_merit[i] + 0.35·z_demand[i]                 # MERIT_W, DEMAND_W
rank_key[i] = core[i] + 0.075·(uniqueness[i] − 50)/50            # UNIQ_LAMBDA, UNIQ_NEUTRAL
```

- Both merit and demand are **re-standardized** (population z) before blending,
  so the 0.65/0.35 split is over comparable axes. A product with no demand
  signal contributes `z_demand = 0` — it neither gains nor loses on the demand
  axis, leaning on merit alone.
- **Uniqueness** enters *only* as a bounded tilt: U=100 → +0.075, U=0 → −0.075,
  U=50 → neutral. Missing uniqueness → assume `UNIQ_NEUTRAL = 50` (no tilt).
  It can only decide order where `core` is genuinely close; it never overrides a
  real merit+demand gap.

### 6.4 Final order and the "moved" flag

```
merit_order = sort ids by (−composite, id)      → merit_rank[pid]   (pure merit)
order       = sort ids by (−rank_key, −core, −composite, id)        (final)
```

`tiebroken` on each product = `merit_rank[pid] != final_rank` — i.e. **demand +
uniqueness moved it off its pure-merit position.** `tiebreak_count` in health is
the count of such products. (The name is historical; the old pairwise-duel
tiebreak is gone. `cfg.tieThreshold`, default 0.15, no longer gates anything —
it survives only as a label concept.)

### 6.5 `jury_health` (`rank_final.py:234`)

- `discrimination` = population std of the merit composites (low ⇒ products
  score alike ⇒ merit alone is fragile; the board flags `< 0.5`).
- `demand_discrimination` = population std of `demand_raw`.
- `avg_metric_spread` = mean over (product, metric) of the cross-juror popstd of
  raw scores — i.e. how much the jury *disagrees* per metric.
- `tiebreak_count` = §6.4.

### 6.6 `ranking.json` schema (what the board reads)

Top level (`rank_final.py:295`): `category`, `prompt_version`,
`uniqueness_version`, `demand_version`, `type`,
`weights:{merit:0.65, demand:0.35, uniqueness_lambda:0.075}`, `personas` (roster),
`metrics:[{name, description}]`, `clusters` (summary sorted by size),
`ranking:[…]`, `health:{avg_metric_spread, discrimination,
demand_discrimination, tiebreak_count}`, `flaggedInjections`.

Each `ranking[]` row: `id, name, url, rank, composite` (pure merit), `demand`
(reduced demand_raw), `core` (the blended score it's ranked by), `tiebroken`,
`scorecard:[{metric, score (cross-juror mean), spread (cross-juror std),
deductions:[{points, reason, role}]}]`, `cluster:{id, label, size, uniqueness,
reason}`, and `demand_detail:{demand, breadth, intensity, capture, share,
picks:[…]}`.

---

## 7. Constants, config, and cost

### 7.1 All numeric constants

| Constant | Value | Where | Meaning |
|---|---|---|---|
| `MERIT_W` | **0.65** | rank_final.py:9 | weight on z(merit) in `core` |
| `DEMAND_W` | **0.35** | rank_final.py:10 | weight on z(demand) in `core` |
| `UNIQ_LAMBDA` | **0.075** | rank_final.py:11 | max ± uniqueness nudge on `core` |
| `UNIQ_NEUTRAL` | **50.0** | rank_final.py:12 | uniqueness assumed when none returned |
| `BREADTH_W` | **0.4** | rank_final.py:14 | weight on breadth in demand_raw |
| `INTENSITY_W` | **0.6** | rank_final.py:15 | weight on intensity in demand_raw |
| 2nd-pick weight | **0.5** | rank_final.py:180 | a runner-up vote counts half a 1st pick |
| 1st-pick weight | **1.0** | rank_final.py:172 | |
| strength default | **50** | rank_final.py:173 | clamp default for a missing strength |
| min products | **8** | run_category.mjs:396 | below this the category is skipped |
| sanitize limit | **300** | cjr_lib.py / mjs | product description truncation |
| taglines sampled | **15** | generate_*.py | for the generation prompt |

### 7.2 Config (`cfg`, `run_category.mjs:382`)

```js
{ dryRun:false, model:"haiku", clusterModel:"sonnet", personaModel:"sonnet",
  tieThreshold:0.15, chunkSize:40 }
```

Overridable via `args.config`. Model tiers: **jurors → haiku** (`config.model`),
**clustering + personas → sonnet** (`clusterModel` / `personaModel`). The final
human review is done on **opus** but is not part of the automated call count.

### 7.3 Cost model

```
agent calls = 5 × chunks + 1 + personas
              └ scoring    └ cluster  └ customer
chunks = ceil(n / chunkSize)          (chunkSize default 40)
```

There are **no LLM duels** — cost does not grow with the number of near-ties.
Worked examples from real runs:

- **Health & Fitness, n=44:** 2 chunks → `5×2 + 1 + 6 = 17` calls.
- **Media & News, n=13:** 1 chunk → `5×1 + 1 + 6 = 12` calls.

Levers: `chunkSize` trades prompt length vs call count; a juror may carry its
own cheaper `model`; the Workflow is resumable (`resumeFromRunId`) so completed
scoring calls return from cache. Bumping `prompt_version` / `persona_version`
invalidates that category's cache.

---

## 8. Safety and validation

- **Injection: flag, never drop.** `INJECTION` regex
  (`run_category.mjs:143`, mirrored in `cjr_lib.py:6`):
  `/ignore (the )?previous|disregard (the )?(above|previous)|\bsystem prompt\b|\binstructions?\b|\bprompt\b|\bsystem\b/i`.
  Applied to juror deduction reasons, clustering reasons, and persona choice
  reasons. A hit is recorded in `flaggedInjections` with its source
  (`role` / `"uniqueness"` / `"demand"`) but the score/vote is **kept** — the
  board surfaces it for a human to judge.
- **All product text is wrapped `<<< … >>>` and labelled DATA** in every prompt,
  with an explicit instruction to ignore anything inside it that reads like an
  instruction.
- **`sanitize`** strips control characters, collapses whitespace, truncates
  (product text 300; labels 60; anchors 160; etc.).
- **Jury / persona validators** (§4 steps 2–3) hard-fail installation on any
  structural problem, so a malformed panel never reaches a run.

---

## 9. Hard rules (never violate)

1. No Anthropic API key, no deployment, no auth, no payments — jurors and
   personas are **local** subagents; the board is a local stdlib server.
2. **Never build a cross-category leaderboard.** Categories aren't comparable;
   the board shows one at a time by design.
3. **Three approval gates always fire before spend:** (a) jury mandates,
   (b) customer panel roster, (c) dry-run projection.
4. Rank on **merit within a category** — never on price, never across
   categories. Demand is co-primary; uniqueness is a bounded nudge only.
5. Editing a jury/panel requires **bumping the version** to invalidate the
   cache and force a clean re-run.