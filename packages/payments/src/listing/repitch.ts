/**
 * What a re-pitch does to the listing, the old verdict, and the cluster.
 *
 * ## Settled: replacement, and it is enforced structurally
 *
 * `brief §2.4`: "A new attempt **replaces** the previous listing. Never
 * keep-the-best — that is a slot machine, exploitable on variance alone, and
 * matches Dodo's prohibited 'chance-based reward mechanics' language."
 *
 * Keep-the-best is not forbidden here by a rule. It is forbidden by the absence
 * of an input: nothing in `RepitchInput` carries a rank, a score, a composite or
 * a cuts total, for either the old verdict or the new one. There is no
 * expression this function could contain that compares them. `brief §1.2` is why
 * that matters — raw scores genuinely differ between runs, so a keep-the-best
 * rule would pay out on variance, and a $5 reroll with a "keep the better score"
 * promise is a slot machine however carefully it is described.
 *
 * `02 §8`'s dedup-by-URL is satisfied by the same shape: the plan's only listing
 * action is `replace_in_place` on an existing listing id. There is no branch that
 * inserts a second row for a URL that already has one.
 *
 * ## Undecided: what happens to the old verdict's URL, and to the cluster
 *
 * `DECISIONS.md` **S8 is OPEN**, and this module does not close it. Three
 * documents pull in different directions:
 *
 * - `brief §2.4` — a re-pitch replaces the previous listing;
 * - `brief §2.1` and Part 6 — verdict URLs are PUBLIC, PERMANENT and shareable,
 *   and are the object people post;
 * - `02 §8` — dedup by URL forbids placing the same product twice.
 *
 * And a second question rides along: does the re-pitched product keep the
 * cluster it joined under its OLD description? `brief §1.5` makes clusters
 * append-only and demand votes keyed to `cluster_id`, so the answer decides
 * whether the Mob and Floor votes cast against the old pitch still count.
 *
 * Both questions are expressed as `RepitchPolicy`, which is a REQUIRED argument
 * with no default. There is no `DEFAULT_REPITCH_POLICY` export, on purpose: a
 * default is a decision, and this one has not been made. `REPITCH_POLICY_OPTIONS`
 * records what each reading costs so the choice can be made from the trade-offs
 * rather than from whichever branch happened to be written first.
 *
 * What changes when it is decided: the policy VALUE at the call site in the web
 * app. This file needs no edit under either reading; both are already
 * implemented and tested.
 */

import type { ListingSnapshot, SubmissionClearance } from '../submission/guards.js';

/**
 * S8, first half: the old verdict's public URL.
 *
 * - `archive_at_permanent_url` — the old verdict keeps resolving at its own URL,
 *   marked superseded, with a link to the current one. Honours "permanent and
 *   shareable" literally: a link someone posted six weeks ago still shows what
 *   they were talking about. Costs a permanently growing set of public pages
 *   that show ranks which are no longer true, each of which is screenshot-able
 *   as if it were current.
 * - `redirect_to_current` — the old URL 301s to the listing's current verdict.
 *   Honours "replaces the previous listing" literally: there is one live truth
 *   per product. Costs the shareability guarantee — a link posted six weeks ago
 *   now shows something the poster never saw, which is the failure mode `brief`
 *   Part 5 already worries about when it says never to promise a rank in copy.
 */
export type PreviousVerdictPolicy = 'archive_at_permanent_url' | 'redirect_to_current';

/**
 * S8, second half: the cluster the product joined under its old description.
 *
 * - `keep_joined_cluster` — the listing stays where it was placed. Demand votes
 *   keyed to that `cluster_id` (`brief §1.5`) survive, including real Mob votes,
 *   which cost nothing to collect and cannot be recollected. Costs accuracy: the
 *   product is judged for demand inside a cluster chosen for a description it no
 *   longer has, and a re-pitch that genuinely repositions the product is scored
 *   against the wrong peers.
 * - `reassign_on_new_description` — the uniqueness pass runs on the new text and
 *   the listing joins whichever cluster now fits, append-only per `brief §1.5`.
 *   Costs the votes: every demand vote that was cast in a forced choice
 *   involving this product in its old cluster is now about a set that no longer
 *   exists, and `brief §1.5` says re-clustering clears demand.
 */
export type ClusterPolicy = 'keep_joined_cluster' | 'reassign_on_new_description';

export interface RepitchPolicy {
  readonly previousVerdict: PreviousVerdictPolicy;
  readonly cluster: ClusterPolicy;
}

/** One reading, with what it costs. Written down so S8 is decided on trade-offs. */
export interface RepitchPolicyOption {
  readonly policy: RepitchPolicy;
  readonly honours: readonly string[];
  readonly costs: readonly string[];
}

/**
 * The four combinations. Not a menu to pick from at runtime — a record of the
 * argument, for whoever closes S8.
 */
export const REPITCH_POLICY_OPTIONS: readonly RepitchPolicyOption[] = [
  {
    policy: { previousVerdict: 'archive_at_permanent_url', cluster: 'keep_joined_cluster' },
    honours: ['permanent shareable verdict URLs', 'every demand vote ever cast, Mob included'],
    costs: ['a growing set of public pages showing stale ranks', 'demand judged against the old description’s peers'],
  },
  {
    policy: { previousVerdict: 'archive_at_permanent_url', cluster: 'reassign_on_new_description' },
    honours: ['permanent shareable verdict URLs', 'demand judged against the peers the new pitch actually competes with'],
    costs: ['a growing set of public pages showing stale ranks', 'demand votes cleared for the abandoned cluster (`brief §1.5`)'],
  },
  {
    policy: { previousVerdict: 'redirect_to_current', cluster: 'keep_joined_cluster' },
    honours: ['one live truth per product', 'every demand vote ever cast, Mob included'],
    costs: ['a shared link shows something its poster never saw', 'demand judged against the old description’s peers'],
  },
  {
    policy: { previousVerdict: 'redirect_to_current', cluster: 'reassign_on_new_description' },
    honours: ['one live truth per product', 'demand judged against the peers the new pitch actually competes with'],
    costs: ['a shared link shows something its poster never saw', 'demand votes cleared for the abandoned cluster (`brief §1.5`)'],
  },
];

/** What happens to the superseded verdict. Both arms RETAIN the row. */
export type PreviousVerdictDisposition =
  | {
      readonly action: 'archive';
      readonly verdictId: string;
      /** Still served, still 200, with a superseded banner pointing here. */
      readonly supersededBy: string;
      readonly publiclyResolvable: true;
    }
  | {
      readonly action: 'redirect';
      readonly verdictId: string;
      readonly to: string;
      readonly httpStatus: 301;
      /** The row is kept even though the page moves — see `planRepitch`. */
      readonly publiclyResolvable: false;
    };

export type ClusterDisposition =
  | { readonly action: 'keep'; readonly clusterId: string; readonly demandVotesRetained: true }
  | {
      readonly action: 'reassign';
      readonly from: string | null;
      readonly to: string;
      readonly demandVotesRetained: false;
      /** Clusters whose stored demand is now stale (`brief §1.5`). */
      readonly clearsDemandFor: readonly string[];
    };

export interface ListingUpdate {
  /** The only listing action there is. `02 §8`: one row per normalized URL. */
  readonly action: 'replace_in_place';
  readonly listingId: string;
  readonly attemptNumber: number;
  readonly descriptionHash: string;
  readonly description: string;
  readonly currentVerdictId: string;
  readonly lastPitchedAt: Date;
}

export interface RepitchPlan {
  readonly listing: ListingUpdate;
  readonly previousVerdict: PreviousVerdictDisposition | null;
  readonly cluster: ClusterDisposition;
  /** `brief §2.4`: "Show the attempt count publicly". */
  readonly publicLabel: string;
}

export interface RepitchInput {
  readonly previous: ListingSnapshot;
  readonly clearance: SubmissionClearance;
  readonly newVerdictId: string;
  /**
   * The cluster the engine's placement put the new pitch in. Required under
   * `reassign_on_new_description`; ignored under `keep_joined_cluster`.
   */
  readonly newClusterId: string | null;
  readonly policy: RepitchPolicy;
  readonly now: Date;
}

/** `1` -> `"1st pitch"`. `brief §2.4`: shown next to the rank. */
export function ordinalPitch(attemptNumber: number): string {
  const n = Math.max(1, Math.trunc(attemptNumber));
  const lastTwo = n % 100;
  const last = n % 10;
  const suffix = lastTwo >= 11 && lastTwo <= 13 ? 'th' : last === 1 ? 'st' : last === 2 ? 'nd' : last === 3 ? 'rd' : 'th';
  return `${n}${suffix} pitch`;
}

/**
 * The writes a delivered re-pitch implies.
 *
 * Pure: returns a plan, performs nothing. The caller applies it inside the same
 * transaction as the verdict write and the attempt decrement, which is where
 * `brief §2.3`'s "same transaction" clause puts it.
 *
 * Note what BOTH `previousVerdict` arms have in common: neither deletes the old
 * verdict row. Under `archive` the row is what the old URL serves; under
 * `redirect` the row is what makes the redirect target derivable and what the
 * integrity record (`brief` Part 7: "backups of the score log — it's the
 * integrity record if anyone disputes a ranking") is made of. A schema that
 * lets a re-pitch overwrite a verdict in place cannot implement either reading
 * of S8, which is the one thing this open question already constrains.
 */
export function planRepitch(input: RepitchInput): RepitchPlan {
  const { previous, clearance, policy } = input;

  const listing: ListingUpdate = {
    action: 'replace_in_place',
    listingId: previous.listingId,
    attemptNumber: clearance.attemptNumber,
    descriptionHash: clearance.descriptionHash,
    description: clearance.draft.description,
    currentVerdictId: input.newVerdictId,
    lastPitchedAt: input.now,
  };

  const previousVerdict: PreviousVerdictDisposition | null =
    previous.currentVerdictId === null
      ? null
      : policy.previousVerdict === 'archive_at_permanent_url'
        ? {
            action: 'archive',
            verdictId: previous.currentVerdictId,
            supersededBy: input.newVerdictId,
            publiclyResolvable: true,
          }
        : {
            action: 'redirect',
            verdictId: previous.currentVerdictId,
            to: input.newVerdictId,
            httpStatus: 301,
            publiclyResolvable: false,
          };

  let cluster: ClusterDisposition;
  if (policy.cluster === 'keep_joined_cluster') {
    if (previous.clusterId === null) {
      throw new RangeError(
        'planRepitch: keep_joined_cluster needs a cluster to keep, but the previous listing has none. ' +
          'A listing with no cluster has never been placed; treat this as a first pitch.',
      );
    }
    cluster = { action: 'keep', clusterId: previous.clusterId, demandVotesRetained: true };
  } else {
    if (input.newClusterId === null) {
      throw new RangeError(
        'planRepitch: reassign_on_new_description needs the cluster the placement returned, but newClusterId is null.',
      );
    }
    const clearsDemandFor =
      previous.clusterId !== null && previous.clusterId !== input.newClusterId ? [previous.clusterId] : [];
    cluster = {
      action: 'reassign',
      from: previous.clusterId,
      to: input.newClusterId,
      demandVotesRetained: false,
      clearsDemandFor,
    };
  }

  return {
    listing,
    previousVerdict,
    cluster,
    publicLabel: ordinalPitch(clearance.attemptNumber),
  };
}
