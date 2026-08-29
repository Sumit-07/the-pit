/**
 * The recalibration cycle — the clock the per-product submission cap hangs off.
 *
 * `brief §2.4` is specific about this and gives the reason: the limit is "one
 * pitch per product per recalibration cycle", NOT "3 per day", so that the
 * rejection can carry a countdown to the next rebuild ("next pitch after
 * tonight's rebuild, 02:00 UTC") rather than an arbitrary number. A user who is
 * told when they may pitch again has been told something true about how the
 * board works. A user who is told "limit reached" has been told they are being
 * rationed.
 *
 * The cap is also per PRODUCT and not per account: nothing in this module takes
 * an account id, and `checkSubmission` keys the lookup on the normalized URL, so
 * someone with four side projects can submit all four tonight.
 *
 * Times are UTC throughout. `brief` Part 3 puts the nightly rebuild at a fixed
 * wall-clock hour, and a local-time schedule would move the boundary twice a
 * year — silently granting one product two pitches in a cycle in spring and
 * costing a user a night in autumn.
 */

/** When the nightly rebuild runs, in UTC. */
export interface RecalibrationSchedule {
  readonly hourUtc: number;
  readonly minuteUtc: number;
}

/** `brief §2.4`'s worked example: 02:00 UTC. */
export const NIGHTLY_REBUILD: RecalibrationSchedule = { hourUtc: 2, minuteUtc: 0 };

const MILLIS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;
const HOURS_PER_DAY = 24;
const MILLIS_PER_DAY = MILLIS_PER_SECOND * SECONDS_PER_MINUTE * MINUTES_PER_HOUR * HOURS_PER_DAY;

/**
 * One window between rebuilds. `id` is the UTC date the window opened, so the
 * cycle running from 02:00 on the 28th to 02:00 on the 29th is `2026-08-28`
 * throughout — including during the small hours of the 29th, which is exactly
 * the case a naive "today's date" key gets wrong.
 */
export interface RecalibrationCycle {
  readonly id: string;
  readonly startedAt: Date;
  readonly endsAt: Date;
}

function boundaryOn(now: Date, schedule: RecalibrationSchedule): number {
  return Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    schedule.hourUtc,
    schedule.minuteUtc,
    0,
    0,
  );
}

function isoDate(millis: number): string {
  return new Date(millis).toISOString().slice(0, 10);
}

/**
 * The cycle `now` falls inside. Half-open: a submission at exactly the rebuild
 * instant belongs to the new cycle, not the one that just closed.
 */
export function cycleAt(now: Date, schedule: RecalibrationSchedule = NIGHTLY_REBUILD): RecalibrationCycle {
  const todaysBoundary = boundaryOn(now, schedule);
  const startedAt = now.getTime() < todaysBoundary ? todaysBoundary - MILLIS_PER_DAY : todaysBoundary;
  return {
    id: isoDate(startedAt),
    startedAt: new Date(startedAt),
    endsAt: new Date(startedAt + MILLIS_PER_DAY),
  };
}

export interface RebuildCountdown {
  readonly nextRebuildAt: Date;
  readonly secondsRemaining: number;
  /** `"4h 30m"`. Rendered here so the client and the server say the same thing. */
  readonly humanized: string;
}

function humanize(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / (SECONDS_PER_MINUTE * MINUTES_PER_HOUR));
  const minutes = Math.floor((seconds % (SECONDS_PER_MINUTE * MINUTES_PER_HOUR)) / SECONDS_PER_MINUTE);
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

/** How long until the cycle closes and the product may be pitched again. */
export function countdownTo(cycle: RecalibrationCycle, now: Date): RebuildCountdown {
  const secondsRemaining = Math.max(0, Math.ceil((cycle.endsAt.getTime() - now.getTime()) / MILLIS_PER_SECOND));
  return {
    nextRebuildAt: cycle.endsAt,
    secondsRemaining,
    humanized: humanize(secondsRemaining),
  };
}

/**
 * The rejection sentence. `brief §2.4`: a countdown to the next rebuild, not an
 * arbitrary limit — so the time is named twice, once as a wall clock the user
 * can plan around and once as a duration they can feel.
 */
export function cycleLockedMessage(
  cycle: RecalibrationCycle,
  now: Date,
  schedule: RecalibrationSchedule = NIGHTLY_REBUILD,
): string {
  const countdown = countdownTo(cycle, now);
  const clock = `${String(schedule.hourUtc).padStart(2, '0')}:${String(schedule.minuteUtc).padStart(2, '0')} UTC`;
  return `This product has already been pitched into the current board. Next pitch after the rebuild at ${clock}, in ${countdown.humanized}.`;
}
