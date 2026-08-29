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
