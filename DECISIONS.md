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
  no `createAccount`; `completeOAuthSignIn` answers `no_purchase_found` and creates
  nothing. A verified GitHub address is proof of a GitHub account and not of anybody
  having thrown anything into the pit. (The rule it used to cite — *an account is a
  purchase* — has since been amended; see **S15-free** below. The GitHub path is
  unaffected by that amendment and still creates nothing.)
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

### S15-free — An account is a purchase, **or** a confirmed email with a free run

**This amends S15's account rule and nothing else about S15.** The perk constraint
above is untouched — GitHub perks stay procedural or informational, never positional
— and so is the payer identity, the absence of a claiming flow, and the rule that
nothing sits on the buying path.

What changed is the sentence "an account is a purchase". It now reads:

> **An account is a purchase, OR a confirmed email with a free run.** A row in
> `accounts` means somebody paid $5, or somebody proved they hold an inbox and took
> the one free throw a product ever gets. There is still no signup, no invitation and
> no "sign in with GitHub to get started".

**Why it had to change.** The founder's free first throw (3 Sep 2026) is keyed on the
product URL and gated on a confirmed email, and it grants one attempt. An attempt
lands on a ledger, a ledger row names an account, and there was no way to create one
outside the Dodo webhook. The alternatives were worse in the ways that matter: a
shadow "pre-account" table would have given one person two balances and two
histories; granting against the paying customer's account would have been wrong when
there is no paying customer; and putting GitHub in front of the free run is the thing
the founder refused, because it blocks somebody on a phone.

**What creates one now, and what still cannot.** The insert is still exactly one
statement — `createPostgresWebhookAccounts.ensureAccount`'s upsert — and the new
`IdentityStore.createAccountForEmail` delegates to it rather than writing a second
one, so the two arrivals cannot drift about `xmax`, about the capability slug, or
about what a conflict means. A customer who paid last month and then takes a free
throw on a new product resolves to their existing row: one person, one balance.

The method is on `IdentityStore` and deliberately **not** on `AuthStore`.
`verifyMagicLink` takes the three-method `AuthStore` and cannot reach past it, so
redeeming a sign-in link for an address nobody ever confirmed still answers
`no_account`. Exactly one caller may reach the new arm — `POST /free/confirm`, after
`verifyFreeRunToken` has checked our own HMAC over that submission and that address.

**What "confirmed" means, and where it is enforced.** `GET /free/confirm` renders a
button and is given no dependencies at all; the `POST` does the work. That is
`brief §2.1`'s Outlook Safe Links defence applied to a run instead of a token, and
the stake is higher: a mail scanner that started the run would buy six juror calls
before the founder opened the message.

**One free run per product is a database fact, not a policy.** The grant is an
`attempts` adjustment with `actor = 'free_first_throw'` and
`idempotency_key = 'free:url:<normalized url>'`, and `attempts_idempotency_key_uk`
refuses the second one. `apps/web/src/lib/free/policy.ts` holds the abuse rules that
are *not* structural — disposable domains, a per-IP window, a daily cap — and it is a
stub on this branch that says yes to everything. That is safe precisely because the
axis that costs money is closed by an index rather than by the stub.

A duplicate is a **success**, and which success depends on who arrived: the same
account gets its run and its redirect with no second grant, and a second address gets
"This product has already had its free throw. $5 for another." with the $5 form
pre-filled. `createPostgresFreeRunGrants.holderOf` is the one lookup that separates
them; guessing would either refuse somebody their own run or hand out a second free
one.

**S17 is unchanged and is enforced rather than trusted.** Free runs publish under the
product's name. `anonymous: false` is written from a literal on the free path — the
posted byline is read so the form can echo it back and is never consulted — so an
edited radio buys nothing and neither does an honest mistake. The byline is still
chosen before scoring and still frozen; on the free path there is only one of it, and
the form says which button buys which byline. $5 buys the robot.

**What the money line becomes.** `brief` Part 5's terms line said "$5 to enter", and
that stopped being true, so it now reads "First throw free. Public forever." The half
that is Part 5's actual argument — *public forever* — is untouched and applies to a
free throw exactly as it applies to a paid one. `test/boards-copy.test.ts` pins the
new pair and the other three strings unchanged.

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

### S17 — Anonymous listings: chosen at submission, frozen before scoring

A product can be published without its **name** and its **URL**. It appears as a
deterministic robot and a stable designation — `Unit Kilo-427`. It withholds those
two things and **nothing else**: every cut, every deduction with its reason and the
juror who took it, the per-metric scores and spreads, the cluster it was judged
inside and the whole demand picture stay public.

That split is the product. The Pit sells verdicts that are checkable; hiding the
reasons would leave an opaque leaderboard, which is the thing it exists to replace.
Only the identity is private.

**The choice is made at submission, before the panel scores anything, and it is
immutable.** The timing is the whole design and it is defended in two places:

1. **Against adverse selection.** If a founder could go anonymous *after* reading
   their verdict, the good scores would stay named and the bad ones would hide.
   Each row would still be accurate and the board as a whole would become
   systematically flattering, so a reader could no longer treat a name as evidence
   of anything. That is exactly what `§2.4`'s never-keep-the-best rule refuses, in
   a different currency: you may buy an evaluation, and you may not buy the right
   to un-buy the ones that went badly. Buying an anonymous evaluation up front has
   no selection effect at all, because the choice is made in ignorance of the
   result.
2. **Because a later choice could not be honoured.** Three prompts render a
   product's name into their data block (`score`, `uniqueness`, `choice`), and all
   three produce free text that is published in full. A juror shown the real name
   can write it into a deduction reason, and the page prints it. So an anonymous
   listing is marshalled into the engine already wearing its designation
   (`apps/web/src/lib/pipeline/pg-catalog.ts`) and the panel never sees the name at
   all. The decision has to exist before the prompt is built.

**Enforced at the database, not in a handler.** `products_anonymity_immutable` in
`migrations/0009_anonymous_listings.sql` — a trigger, because it compares NEW
against OLD, which a CHECK cannot see. The same posture `0002_append_only_guards.sql`
already takes for a delivered job, a published snapshot and the text that was
scored. A handler is one code path among several, and the damage from any bypass is
silent: a board that has been quietly flattered does not look broken.

**The one legal transition is anonymous → named on a CLAIMED listing.** A founder
who proves the listing is theirs through the existing GitHub path (verified-email
matching only, S15) and then chooses to be named is performing an act of consent
about their own product, which is a different act from reacting to a score — and
the difference is legible in the data rather than in intent. The reveal is
**prospective only**, and that falls out of the schema rather than needing a rule:
`verdicts` is append-only and `payload` carries the name the listing was delivered
under, so a link somebody shared keeps showing the designation it showed on the
day. Claiming names a product on future boards; it cannot reach back.

Named → anonymous is refused always. A product that wanted anonymity had its
chance before it knew anything.

**What is withheld is withheld everywhere.** The redaction is document-wide, not
field-wide, because free text about a product sometimes contains its name — on the
`developer-tools` cold-start board exactly one cluster reason names another
product, one sentence in 2,892, which is precisely the rate at which a bug survives
review and ships. It runs at publish (so the name never reaches the bucket, the CDN
or `/api/boards/<slug>`, which serves the snapshot verbatim) and again at the
projection (so no board surface is ever handed an identity it could leak). The
favicon is withheld by the same rule and for the same reason: a site's favicon is
its trademark at sixteen pixels, and rendering one beside a pseudonym identifies
the product completely.

**The robot is generated in-process, offline, as inline SVG** (`apps/web/src/lib/anon/`).
Not robohash.org or anything like it: a third-party request on every board view
hands that host the IP, User-Agent and Referer of every visitor to a public page,
and leaves a broken-image glyph in every identity slot on the site the day it
moves. It is painted only in the neutral surface and ink tokens — never `--cut` or
`--held`, which carry meaning, because an avatar in either would make an identity
read as a score.

### S4-source RESOLVED — Seeded listings are anonymous

**This supersedes the S4-source entry the Open section carried, and closes it.**

The open question was whether to re-scrape the 913 seeded descriptions or to label
their source. Neither was ever sufficient, because the exposure was not really
about attribution: publishing AI criticism of copy a **named** company never wrote
is the largest legal and reputational risk in the project, and `brief` Part 7's
"mark clearly as unclaimed, offer one-click opt-out" only ever helped the companies
that happened to find out.

Seeding anonymously removes it at the root. The board still demonstrates the method
on real market data, every cut and every reason is still public and still
checkable, and **nobody is named without consent**. A founder who wants their name
on their row claims the listing and reveals it, which is the S17 transition and is
the same act `brief` Part 7's opt-out is the other end of.

It is a constraint rather than a default: `products_seeded_is_anonymous` refuses to
store a named unclaimed seeded row, so there is no fixture, script or admin path
that can quietly produce one. The cold-start boards in `cjr/` are flat files that
never pass through that constraint, so `lib/boards/source.ts` applies the same rule
on read — every row of a seeded run is anonymous.

Note the interaction with OPEN-1: as a category sheds seeds and fills with paid
listings, the anonymous share of a board falls on its own. Nothing about the drain
changes.

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
- ~~**S4-source** [Ph.1] 913 of 1028 seeded descriptions were written by outbid.lol,
  not by the founders.~~ **RESOLVED** above: seeded listings are published
  anonymously, so the question of re-scraping versus labelling no longer decides
  anything — nobody is named without consent either way.
- **Cost re-baseline** [Ph.1] Brief Part 3 budgets $17-25/mo across 15 categories; the
  data has 28. Six jurors instead of five adds ~20% on top.
