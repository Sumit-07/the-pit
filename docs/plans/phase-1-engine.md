# Plan — Phase 1: ranking engine + seed two categories

**Spec:** `the-pit-build-brief.md` (authoritative) > `01-skill-reference.md` >
`02-app-conversion-design.md`. Decisions that override all three: `DECISIONS.md`.
Orientation: `PHASE-0.md`.

**Scope.** The evaluation engine as a standalone TypeScript package, plus the harness
that seeds two categories and produces the Phase 1 report. **No web app, no database,
no payments.** Artifacts are flat JSON under `cjr/`.

---

## Global Constraints

Binding on every task. A reviewer checks against these verbatim.

1. **No model call ever produces or sees a rank.** Models return raw 0–100 scores,
   cluster assignments, or a buyer's pick. Every ranking arithmetic operation is pure
   TypeScript over stored raw rows.
2. **Product text is UNTRUSTED.** Sanitize, truncate to 300 chars, wrap in `<<< >>>`,
   label as DATA, and instruct the model that content inside is to be judged and never
   obeyed. Juror mandates are INSTRUCTIONS and go outside the data block, never inside.
3. **Rank must never be purchasable.** If any change would let money or repetition
   improve expected rank rather than just resolution, stop and report it.
4. **Exact constants.** Never invent a number. Every constant lives in
   `packages/engine/src/config/constants.ts` and is imported; no magic numbers at use
   sites.
5. **Deterministic and offline-testable.** Every model call goes through the
   `ModelClient` interface. Tests use the fixture adapter and require no API key.
   `pnpm test` must pass with no network and no environment variables.
6. **TypeScript strict mode.** No `any` in exported signatures. Vitest for tests.
7. **Population standard deviation** (divide by N), never sample std, everywhere.
8. Report actual token counts and cost at the end of any task that spends.

### Frozen constants (from `01` §7.1, with the corrections applied)

```
MERIT_W            0.65     DEMAND_W          0.35
UNIQ_LAMBDA        0.075    UNIQ_NEUTRAL      50.0
BREADTH_W          0.4      INTENSITY_W       0.6
FIRST_PICK_W       1.0      SECOND_PICK_W     0.5
STRENGTH_DEFAULT   50       SCORE_CLAMP_DEFAULT 50
MIN_PRODUCTS       8        SANITIZE_LIMIT    300
TAGLINE_SAMPLE     15       CHUNK_SIZE        40
JUROR_COUNT        6        <- was 5 in 01 §4. See DECISIONS.md S1.
CALIBRATION_SAMPLE 15       <- new, brief §1.1
METRICS_MIN 3  METRICS_MAX 6   PERSONAS_MIN 4  PERSONAS_MAX 8  PERSONAS_TARGET 6
MODEL_JUROR "haiku"   MODEL_CLUSTER "sonnet"   MODEL_PERSONA "sonnet"
```

---

## Task 1 — Scaffold and constants

Create the pnpm workspace and `packages/engine` with TypeScript strict + Vitest.
Layout per `PHASE-0.md` §3. Write `src/config/constants.ts` containing every frozen
constant above, each with a one-line comment citing its source (`01 §7.1`,
`brief §1.1`, `DECISIONS.md S1`). Write `src/types.ts` with the data shapes from
`01` §5 output schemas and §6.6 (`Product`, `ScoreRow`, `Deduction`, `Cluster`,
`UniquenessResult`, `DemandChoice`, `RankedProduct`, `Health`, `Ranking`).

`pnpm test` must run and pass with zero tests. No logic in this task.

## Task 2 — Ingest and sanitization

`src/ingest/`. Reads `/Users/sumitkumar/Downloads/outbid_all_categories.xlsx`,
sheet **`All Products`**, columns `Category, Rank, Product Name, Description,
Website URL`.

- `sanitize(text, limit)` — strip control chars, collapse whitespace, trim to limit.
- Filter to one category; **drop rows with an empty description**; sort by `Rank`
  (it is a string in the sheet — parse as integer, and fail loudly on a value that
  does not parse rather than sorting lexicographically).
- Assign `id` as a 0-based index into the **usable** rows, per `01` §4 Step 1.
- Return `{category, products:[{id, name, description, url, orig_rank}]}`.
- Refuse a category with fewer than `MIN_PRODUCTS` usable rows, naming the count.
- `normalizeUrl(url)` per brief §2.5 — lowercase, strip protocol, `www.`, trailing
  slash, **strip all query parameters and the fragment**. Shortener resolution is
  explicitly OUT OF SCOPE for Phase 1 (it needs an SSRF-guarded fetcher; note it in
  the report). Store as a separate `normalized_url` field.

Tests: a fixture xlsx (build it in the test, do not read the real file in unit
tests) covering empty descriptions, a 400-char description truncating to exactly 300,
control characters, ranks like "10" sorting after "9", and the under-8 refusal.
One integration test may read the real file and assert Developer Tools = 48 usable
and Health, Fitness & Wellness = 44 usable.

## Task 3 — The ranking math

`src/rank/`. This is the task that matters most; it is the entire product.
Implement exactly `01` §6, with the two corrections below. Pure functions, no I/O.

- `computeComposite(scoreRows, jury)` — `01` §6.1. Normalize each juror's weights to
  sum 1 over metric names (negatives→0; all-zero→uniform `1/len`). For each juror, for
  each metric: take that juror's 0–100 score per product (**missing → 50.0**),
  z-normalize **across products** with population std (**std == 0 → z = 0**), multiply
  by that juror's normalized weight for the metric, and accumulate. Divide the
  accumulated total by the juror count.
- `reduceDemand(demandLog, clusters)` — `01` §6.2 verbatim, including `capture` as
  `|picked_personas| / P` where P is the number of personas that returned choices, and
  `intensity` as the mean of the **top 2** strengths for that product divided by 100.
  Return the per-product `detail` object of §6.2. No demand log or no clusters →
  return empty.
- `blend(...)` — `01` §6.3, **with the S3 correction**: when a product has no entry in
  `demand_raw` (solo cluster, or a cluster the panel skipped), rank it on merit alone
  at weight 1.0 — `core = z_merit` — rather than `0.65·z_merit + 0.35·0`. Products
  that DO have a demand entry use `0.65/0.35` unchanged. Set a
  `demand_status: 'scored' | 'solo_cluster'` field on each product so the verdict page
  and the pipeline can tell the two apart (this is the S11 signal — a solo cluster is
  a successful delivery, not a partial failure).
- `rank_key = core + UNIQ_LAMBDA·(uniqueness − UNIQ_NEUTRAL)/50`, missing → neutral.
- Final order: sort by `(−rank_key, −core, −composite, id)`. `merit_order` sorts by
  `(−composite, id)`. `tiebroken = merit_rank !== final_rank`.
- `juryHealth(...)` — `01` §6.5: `discrimination` (popstd of composites),
  `demand_discrimination` (popstd of demand_raw), `avg_metric_spread` (mean over
  (product, metric) of the cross-juror popstd of raw scores), `tiebreak_count`.
- Emit `ranking.json` exactly per `01` §6.6, plus `demand_status`.

**Golden fixtures are the deliverable's spine.** Hand-compute expected values from
`01` §6 and commit them under `test/golden/` with the arithmetic shown in comments.
Do NOT generate expectations by running the implementation. Minimum cases:

- **Shift invariance (verified anchor — use exactly this).** 2 jurors, 1 metric `M`,
  weights `{M: 1.0}` each, 4 products. Juror A scores `[90,80,70,60]`; Juror B scores
  `[100,90,80,70]`. Both have mean/popstd of `75/11.18034` and `85/11.18034`, so both
  produce `z = [1.341641, 0.447214, -0.447214, -1.341641]` and
  `composite = [1.341641, 0.447214, -0.447214, -1.341641]`. This proves per-juror
  z-normalization cancels a constant offset between jurors — guardrail 3 in `01` §1.
- All-identical scores → popstd 0 → every z = 0 → composite all zeros, no crash.
- A missing metric score defaulting to 50.0.
- Demand: a 3-member cluster, 6 personas, one `none`, one second_pick — hand-compute
  `share`, `capture`, `breadth`, `intensity`, `demand_raw`.
- A solo-cluster product alongside scored ones, asserting merit-only renormalization
  and `demand_status: 'solo_cluster'`.
- Uniqueness tilt at U=0, 50, 100 changing order only where `core` is within 0.075.

## Task 4 — Chunking and the calibration sample

`src/rank/chunk.ts` and `src/panels/calibration.ts`.

- **Fix 1.4:** `balancedChunks(n, maxSize = CHUNK_SIZE)` splits into
  `ceil(n / ceil(n / maxSize))`-sized chunks. n=44 → `[22, 22]`, n=48 → `[24, 24]`,
  n=13 → `[13]`, n=80 → `[40, 40]`, n=81 → `[27, 27, 27]`. Test each.
- **Fix 1.1 — the most important fix in the project.** `selectCalibrationSample(
  products, rankings, categoryVersion)` picks `CALIBRATION_SAMPLE` (15) already-scored
  products from the category to embed in an incremental scoring prompt **with their
  already-assigned scores, shown as reference, never re-scored**. The sample must be
  **stable per category** (same category + same version → identical sample, so
  selection is deterministic given a seed derived from the category slug + version,
  not from `Math.random()`) and **versioned** (`calibration_version` emitted alongside).
  Spread the sample across the score range — do not take the top 15 — so the anchor
  covers the distribution the new product is being placed into.
- **Fix 1.3:** `previewCacheKey({descriptionHash, categorySnapshotVersion,
  promptVersion, personaVersion})` → a stable string. Pure function, no cache store.

## Task 5 — Model client, panel prompts, schemas, injection

`src/model/` and `src/panels/`.

- `ModelClient` interface: `complete({model, system, messages, tools, cacheBreakpoint})`
  returning parsed JSON plus token usage. Two adapters: `AnthropicClient` (Messages API,
  model ids resolved from a map so `"haiku"`/`"sonnet"` stay configurable) and
  `FixtureClient` (deterministic, replays recorded JSON, used by every test).
- Reconstruct the three prompts from `01` §5 — they are described there in detail but
  not given verbatim, so write them from the descriptions and keep each in its own file
  with the `01` section cited:
  - `scorePrompt` (`01` §5.1): juror mandate as INSTRUCTIONS; the metric rubric with
    all four anchors (100/80/50/20); the product list as DATA in `<<< >>>`. Method:
    start at 100 and deduct; each deduction pairs points with a ≤20-word reason;
    **deductions for a metric must sum to exactly (100 − score)**; a perfect metric is
    score 100 with an empty deductions list. When a calibration sample is supplied
    (Task 4), include it as clearly-labelled already-scored reference products that
    must NOT be re-scored.
  - `uniquenessPrompt` (`01` §5.2): cluster near-identical ideas, label each, score
    every product 0–100 for **scarcity not quality** (100 = rare/novel, 50 = familiar
    with a few peers, 0 = crowded commodity), ≤20-word reason each.
  - `choicePrompt` (`01` §5.3): frames the agent as a **specific customer, not a
    judge**. For each cluster with ≥2 members, one forced choice: `first_pick`,
    optional `second_pick`, `strength` 0–100, ≤20-word reason in their own voice,
    or `none: true`.
- Schemas `SCORE_SCHEMA`, `UNIQ_SCHEMA`, `CHOICE_SCHEMA` per `01` §5 as tool
  definitions. Validate every response against its schema and fail loudly.
- **Prompt caching** (`02` §6): mark the stable prefix — rubric, product list, cluster
  sets, calibration sample — as a cache breakpoint so only the per-juror mandate and
  per-persona identity are uncached.
- **Injection, split per DECISIONS.md S9 — two separate functions, do not merge:**
  - `screenInput(text)` → gates hold-vs-serve. Matches injection-SHAPED phrases only:
    `ignore (the )?(previous|above)`, `disregard (the )?(above|previous)`,
    `system prompt`, `new instructions`, `you are now`, `<<<`, `>>>`.
    **Bare `prompt`, `system` and `instructions` are NOT in this list** — four of the
    28 categories are full of legitimate products about prompts and systems.
  - `alarmOutput(reason)` → runs `01` §8's broad regex over juror/cluster/persona
    reasons, records to `flaggedInjections` with its source, and **never gates
    delivery or holds a preview**. Log only.

## Task 6 — Jury and persona generation with validators

`src/panels/generate/`.

- `buildJuryPrompt(category, taglines)` and `buildPersonaPrompt(...)` — sample the
  first `TAGLINE_SAMPLE` (15) taglines and infer a provisional type with the keyword
  heuristic from `01` §4 Step 2 (b2b words: `compliance, soc 2, enterprise,
  procurement, api, infrastructure, sales, crm, security, workflow`; consumer words:
  `you, your, fun, game, photo, personal, daily, free`).
- `validateJury(obj)` per `01` §4 Step 2 **with JUROR_COUNT = 6**: `type ∈ {b2b,
  consumer, prosumer}`; truthy `prompt_version`; `metrics` length 3–6 with unique
  non-empty names, non-empty descriptions, and all four anchors `"100" "80" "50" "20"`
  non-empty; `jurors` length **exactly 6** with unique non-empty `role`, and non-empty
  `who`, `cares_most`, `biased_against`, `voice`; each juror's `weights` keyed by
  **exactly** the metric names, values numeric `>= 0`, sum `> 0`.
- `validatePersonas(obj)` per `01` §4 Step 3: truthy `persona_version`; `personas`
  length 4–8; each with non-empty `name` and `description`, `needs` a non-empty list of
  non-empty strings, `price_sensitivity ∈ {low, medium, high}` case-insensitive; unique
  names.
- Each validator returns every failure at once, not just the first.
- Test both validators against a valid fixture and one fixture per failure mode.

## Task 7 — Orchestrator, dry-run, cost ledger

`src/run/`.

- `runCategory({products, jury, personas, config})`. Phases: **Score ∥ Uniqueness**
  in parallel, then **Customer** after Uniqueness (it needs the clusters).
  Fire the six juror calls in parallel *within* the Score phase — one phase, one
  logical step, per brief Part 7.
- Similar-app sets = clusters with **≥ 2 members** (`01` §5.3). Customer phase runs
  only if `personas.length > 0 && sets.length > 0`; when it does not run, every product
  gets `demand_status: 'solo_cluster'` and the phase returns a terminal
  `skipped: 'no_sets'` status — **not an error** (S11).
- **Dry-run:** print the projected call count `JUROR_COUNT × chunks + 1 + personas` and
  a token estimate, and spend nothing. This is `01`'s approval gate 3.
- Persist each phase result as it lands; never batch-commit at the end.
- Cost ledger: per-phase input/output tokens and dollar cost, written into
  `results.json` under `meta`.
- Write `cjr/runs/<slug>/results.json` with `{scoreLog, uniqueness, demand,
  flaggedInjections, meta}`.
- A CLI: `pnpm engine seed --category "X" --dry-run` / `--run`.

## Task 8 — The Phase 1 report harness

`src/report/` and a CLI `pnpm engine report --category "X"`.

Produces every number the Phase 1 gate in `the-pit-agent-prompts.md` demands:

- Distribution of per-metric scores, per juror.
- `discrimination`, `demand_discrimination`, `avg_metric_spread` per category, with
  `01` §6.5's `discrimination < 0.5` flagged as "merit alone is fragile".
- **Per-juror deduction rate** — total points deducted and deductions issued per juror.
  Flag any juror whose rate is under half the panel median as dead weight.
- Cross-juror correlation matrix of per-product composites. Flag any pair above 0.9 —
  that is the "panel too correlated, redesign mandates" signal.
- Cluster size histogram and the **solo-cluster count and percentage**, plus the
  scarcity distribution of solo-cluster products specifically (S2/S3 interaction:
  confirm novelty is not being credited twice at a meaningful magnitude).
- Actual cost spent, and projected cost for all 28 categories at
  `JUROR_COUNT × chunks + 1 + personas`, versus the brief's $17–25/month figure.
- **A/B check:** score 5 products both ways — inside a full batch, and via the
  incremental path with the calibration sample — and report per-metric score deltas
  and the resulting rank deltas. This is the only evidence that fix 1.1 works.
- **Test-retest:** score the same 5 products twice through the identical path and
  report score and rank deltas. Without this, the A/B deltas cannot be separated from
  ordinary sampling noise.

Report renders as Markdown to `cjr/runs/<slug>/report.md` and prints a summary.

---

## Task 9 — Local handoff runner + `/seed-category` skill

Added after the founder asked to seed locally rather than wait on an API key. This is
not a workaround: `01` §1 and §9 describe the skill running with **no Anthropic API key**,
jurors as local Claude Code subagents, and the Workflow return value hand-written to
`cjr/runs/<slug>/results.json` (§4 Step 5). We are reproducing that flow, made
repeatable.

The engine cannot call the Agent tool from inside a Node process, so the handoff is via
files, in dependency-ordered rounds. Round 1 is Score ∥ Uniqueness (both need only the
products); Round 2 is Customer (needs Round 1's clusters) — matching `01` §2's phase
graph exactly.

### 9.1 `HandoffClient` — a third `ModelClient` adapter

Implements the same interface as `AnthropicClient` and `FixtureClient`.

- **Emit:** serializes each would-be request to
  `cjr/runs/<slug>/handoff/<round>/<phase>-<key>.request.json`, carrying the fully
  rendered system + messages + tool schema, and the `phase`, `juror_role` / `persona` /
  `chunk_index` it belongs to.
- **Ingest:** reads `<same-name>.response.json`, validates it against that phase's schema
  (`SCORE_SCHEMA` / `UNIQ_SCHEMA` / `CHOICE_SCHEMA`) and **fails loudly per file**,
  naming the file and the violated constraint. A juror whose deductions do not sum to
  exactly `100 − score` is a hard failure, not a warning — that invariant is what makes
  the deduction ledger trustworthy.
- Records token counts where the responder reports them; where it cannot, marks cost as
  `unmeasured` rather than guessing. Task 8's cost projection must show which figures
  are measured and which are not.

### 9.2 CLI

```
pnpm engine seed --category "X" --emit  --round 1   # writes N .request.json files
pnpm engine seed --category "X" --ingest --round 1   # validates + persists phase results
pnpm engine seed --category "X" --emit  --round 2   # cluster sets are now known
pnpm engine seed --category "X" --ingest --round 2
pnpm engine rank   --category "X"                    # ranking.json
pnpm engine report --category "X"                    # the Phase 1 report
```

`--emit` prints the exact number of requests and their file paths. Every command is
idempotent and resumable: re-running `--ingest` over already-ingested files is a no-op,
and a partially-answered round reports which files are still missing rather than
failing.

### 9.3 The skill

`.claude/skills/seed-category/SKILL.md`, invoked as `/seed-category "Developer Tools"`.
Encodes the loop: emit round 1 → dispatch one subagent per request file → write each
response → ingest → emit round 2 → dispatch → ingest → rank → report. Built with
`superpowers:writing-skills`.

The skill must state the **model-provenance caveat** prominently, and the runner must
stamp it into `results.json.meta`:

> Locally-seeded scores come from Claude Code subagents, not from the
> `claude-haiku-4-5` / `claude-sonnet-5` Messages API calls production will make, and
> the local path exposes no `effort` control. The pipeline, the fix-1.1 A/B, cluster
> behaviour, discrimination and juror-correlation results are all valid. **Absolute
> score levels and per-run cost do not transfer to production** and must be
> re-baselined once a key exists.

### 9.4 Tests

`HandoffClient` emit/ingest round-trips against fixtures with no network: a well-formed
response ingests; a response with a bad deduction sum, an unknown product id, a missing
required field, or a duplicate cluster choice each fail loudly and name the file.
