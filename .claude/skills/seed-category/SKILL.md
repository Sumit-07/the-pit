---
name: seed-category
description: Use when a product category in The Pit needs to be scored, re-scored, or picked up mid-way and no ANTHROPIC_API_KEY is available — including a category with no jury or persona panel installed yet, a round whose responses are only partly written, and a run whose ranking or Phase 1 report has not been produced.
---

# Seed a category

## Overview

Three panels judge one category: a six-juror merit jury, one clustering pass, and a persona
customer panel (`01 §2`). With no API key they are local Claude Code subagents, and a Node
process cannot dispatch one — so the engine writes each request to a file, you answer it, and
it reads the answers back through the real schemas and the real ranking arithmetic.

**Core principle: nothing counts until it validates.** Every answer is checked against its
panel's schema and against what that call asked for. Deductions that do not sum to exactly
`100 − score` are a hard failure naming the file — never a warning.

> **Model provenance — repeat this in any summary you write.** Locally-seeded scores come
> from Claude Code subagents, not from the `claude-haiku-4-5` / `claude-sonnet-5` Messages API
> calls production will make, and the local path exposes no `effort` control. The pipeline,
> the fix-1.1 A/B, cluster behaviour, discrimination and juror-correlation results are all
> valid. **Absolute score levels and per-run cost do not transfer to production** and must be
> re-baselined once a key exists. Cost is stamped `unmeasured`; the report prints
> "UNMEASURED — not $0.00". Never quote it as measured.

## When to use

- A category needs scoring and there is no `ANTHROPIC_API_KEY`.
- A round is half-answered or a session stopped mid-way: every command is resumable, and
  re-running one is a no-op.
- Not for re-ranking a finished run (`engine rank`) or the paid path (`engine seed --run`).

## Quick reference

From the repo root; `X` is the category name as the workbook spells it.

| # | Command |
|---|---|
| 1 | `pnpm engine panel --category "X" --kind jury --xlsx <abs>.xlsx` |
| 2 | `pnpm engine panel --category "X" --kind jury --install /tmp/jury.json` |
| 3 | as 1–2 with `--kind personas` |
| 4 | `pnpm engine seed --category "X" --emit --round 1 --xlsx <abs>.xlsx` |
| 5 | `pnpm engine seed --category "X" --ingest --round 1` |
| 6 | `pnpm engine seed --category "X" --emit --round 2` |
| 7 | `pnpm engine seed --category "X" --ingest --round 2` |
| 8 | `pnpm engine rank --category "X"`, then `pnpm engine report --category "X"` |

## Procedure

1. **Jury — APPROVAL GATE 1.** Print the prompt, dispatch **one** subagent with it, save the
   JSON, `--install` it. **STOP. Show the founder the rubric, mandates and weight matrix and
   do not continue without an explicit yes.** The validators check structure only; they cannot
   check what the gate is for. The jury must genuinely **disagree** — one juror's
   heavily-weighted metric must be another's near-zero one. Read the matrix yourself.
2. **Personas — APPROVAL GATE 2.** Same shape, `--kind personas`. **STOP** again: the roster
   must be genuinely different buyers, including one price-insensitive capability-chaser and
   one high-price-sensitivity defector.
3. Weak panel? Edit the installed file and **bump `prompt_version` / `persona_version`**.
4. **Round 1 (Score ‖ Uniqueness).** `--emit --round 1` prints the request count and every
   path. Per `*.request.json`: dispatch one subagent, hand it the file's `prompt` field
   verbatim, require **only** JSON matching that file's `tools[0].input_schema`, and write it
   to the sibling file named in `response_file`. They are independent — dispatch in parallel.
5. `--ingest --round 1`. If it names missing files, answer those and re-run; answered files
   are not re-read.
6. **Round 2 (Customer)** — only now, because personas choose *within* round 1's clusters.
   Repeat step 4's loop for `round-2`, then `--ingest --round 2`, which ranks and delivers.
7. `rank`, then `report`. Relay the gate flags and the provenance caveat.

## Common mistakes

| Mistake | What actually happens |
|---|---|
| Dispatching round 2 before round 1 is ingested | Refused — the sets do not exist yet. The command lists the round-1 responses still missing. |
| Editing a jury or rubric without bumping `prompt_version` | The next `--emit`/`--ingest` refuses by name: the request no longer matches the answer on disk. Bumping instead makes the resume check discard the stored phases — correct, at the cost of re-answering. |
| Quoting the run's cost | It is `unmeasured`, not `$0.00`. See the caveat. |
| Skipping a gate because the validators passed | They are structural. An agreeable jury and a uniform roster pass every check and produce a board with no information in it. |
| Editing a `.response.json` to get past ingest | The deduction ledger is the audit trail. Re-dispatch the subagent. |
