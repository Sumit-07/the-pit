/**
 * Prices, provider fees, and the arithmetic that decides how many attempts a
 * payment is worth.
 *
 * ## Why $5 is a constant and not a config value
 *
 * `brief §2.3` gives the tiers as "$5 = 1 attempt, $15 = 3 attempts + fit
 * report" and then gives the REASON: $5 stays the atomic unit so "same five
 * dollars for everyone" is literally true. A tier table that could express
 * "$40 = 12 attempts" or "$5 = 1 attempt, but $50 = 15 attempts and priority"
 * would quietly make that sentence false, so the table is closed: two tiers,
 * both defined here, and `tierForPayment` refuses anything it does not
 * recognise rather than dividing the amount by 500 and guessing.
 *
 * ## Everything is integer cents
 *
 * No float ever holds a money amount. The fee is applied in basis points
 * (`FEE_BPS`) over integers so `500 * 550 / 10000` is exactly `27.5` rather than
 * `27.500000000000004`, and only the final half-up rounding is inexact — by one
 * cent, deliberately, in the direction that never understates what Dodo keeps.
 *
 * ## The fee figure is an assumption, not an invoice
 *
 * `brief §2.2` gives Dodo's schedule as 4% + $0.40 with +1.5% on international
 * cards, and instructs: assume 5.5% + $0.40. That is the pessimistic reading
 * (every card international). Nothing here reads a real settlement figure — when
 * Dodo reports actual fees on a payout, THAT is the number for the books. These
 * functions exist for unit economics and for the pricing page, and
 * `netProceedsCents` is named for what it is: a projection.
 */

/** Dodo's percentage cut, in basis points. `brief §2.2`: 4% + 1.5% international. */
export const FEE_BPS = 550;

/** Dodo's flat per-transaction cut, in cents. `brief §2.2`. */
export const FEE_FLAT_CENTS = 40;

/** Basis points in one whole. */
const BPS_DENOMINATOR = 10_000;

/** The only currency the tiers are priced in. Anything else needs review, not a guess. */
export const SUPPORTED_CURRENCY = 'USD';

/**
 * The two things that can be bought.
 *
 * `fit_report` is a per-purchase entitlement rather than a third attempt tier,
 * because `brief` Part 4 makes the fit report an OFF-BOARD advisory run: it
 * never writes to rankings, so it is not an attempt and must not be counted as
 * one.
 */
export type PriceTierId = 'single' | 'triple';

export interface PriceTier {
  readonly id: PriceTierId;
  readonly amountCents: number;
  readonly attempts: number;
  readonly fitReport: boolean;
  /** The line the purchase page shows. `brief` Part 5: "$5 to enter." */
  readonly label: string;
}

/** `brief §2.3`. One attempt, five dollars, the atomic unit. */
export const TIER_SINGLE: PriceTier = {
  id: 'single',
  amountCents: 500,
  attempts: 1,
  fitReport: false,
  label: 'Throw it in · $5',
};

/** `brief §2.3`. Three attempts plus the off-board fit report. */
export const TIER_TRIPLE: PriceTier = {
  id: 'triple',
  amountCents: 1500,
  attempts: 3,
  fitReport: true,
  label: 'Three throws + fit report · $15',
};

export const PRICE_TIERS: readonly PriceTier[] = [TIER_SINGLE, TIER_TRIPLE];

/**
 * The purchase-page terms, kept here rather than in the UI package because two
 * of these lines are RULES that live in this module and one of them
 * ("disliking the result is not a failure") is the only thing standing between
 * the free-retry policy and a dispute. `brief §2.3` says to state it on the
 * purchase page; a copy string that lives next to the code enforcing it does not
 * drift away from it.
 */
export const PURCHASE_TERMS: readonly string[] = [
  'An attempt is spent only when a verdict is delivered to you.',
  'If a run fails — timeout, rate limit, crashed worker — the retry is free and costs no attempt.',
  'A run that finished but came back incomplete is a failure too. We retry it rather than show you a partial verdict.',
  'Disliking the result is not a failure. The panel is the same for everyone and the score stands.',
  'Attempts never expire.',
  'A new attempt replaces your previous listing. We never keep whichever score came out better.',
];

/** Cents in one dollar. */
const CENTS_PER_DOLLAR = 100;

function assertWholeCents(amountCents: number, label: string): void {
  if (!Number.isInteger(amountCents)) {
    throw new Error(`${label}: expected whole cents, got ${amountCents}`);
  }
  if (amountCents < 0) {
    throw new Error(`${label}: expected a non-negative amount, got ${amountCents}`);
  }
}

/**
 * Dodo's projected cut on one payment, in cents: 5.5% + $0.40, rounded half up.
 *
 * Half UP rather than half down or banker's rounding: a half-cent that we round
 * toward ourselves shows up later as a shortfall on a real payout, and a unit
 * economics model that is optimistic by a cent per sale is worse than useless.
 * On the $5 tier this returns 68 — which is the figure `brief` Part 7 already
 * books as "Dodo −$0.68".
 */
export function providerFeeCents(amountCents: number): number {
  assertWholeCents(amountCents, 'providerFeeCents');
  if (amountCents === 0) {
    return 0;
  }
  return Math.round((amountCents * FEE_BPS) / BPS_DENOMINATOR) + FEE_FLAT_CENTS;
}

/**
 * What lands with us, in cents, before inference and hosting. A PROJECTION —
 * see the module header. Never negative: a fee larger than the payment (which
 * only a sub-dollar amount could produce) clamps to zero rather than reporting a
 * negative deposit.
 */
export function netProceedsCents(amountCents: number): number {
  return Math.max(0, amountCents - providerFeeCents(amountCents));
}

/** `5000` -> `"$50.00"`. Display only; never feed the result back into arithmetic. */
export function formatUsd(amountCents: number): string {
  assertWholeCents(amountCents, 'formatUsd');
  const dollars = Math.floor(amountCents / CENTS_PER_DOLLAR);
  const cents = amountCents % CENTS_PER_DOLLAR;
  return `$${dollars}.${String(cents).padStart(2, '0')}`;
}

/** What a webhook tells us about the money that moved. */
export interface PaymentAmount {
  readonly amountCents: number;
  readonly currency: string;
  /** Dodo's product id for the purchased line item, when the event carries one. */
  readonly productId?: string | undefined;
}

/**
 * Which tier a settled payment bought, or `null` if we cannot say.
 *
 * `null` is not an error path to be smoothed over — it is the answer for an
 * amount we did not price (a discount code, a currency conversion, a partially
 * captured payment, a tier someone added in the Dodo dashboard without adding it
 * here). The webhook handler turns `null` into a review queue entry, NEVER into
 * `Math.floor(amountCents / 500)` attempts. Granting attempts from arithmetic
 * over an amount we do not recognise is how a $5 promotion becomes a
 * twelve-attempt account.
 *
 * The product id wins when present and mapped, because it is the thing Dodo
 * actually sold; the amount is the fallback for events that omit it.
 */
export function tierForPayment(
  payment: PaymentAmount,
  productIds: Readonly<Record<string, PriceTierId>> = {},
): PriceTier | null {
  if (payment.currency.toUpperCase() !== SUPPORTED_CURRENCY) {
    return null;
  }
  const mapped = payment.productId === undefined ? undefined : productIds[payment.productId];
  if (mapped !== undefined) {
    return PRICE_TIERS.find((tier) => tier.id === mapped) ?? null;
  }
  return PRICE_TIERS.find((tier) => tier.amountCents === payment.amountCents) ?? null;
}
