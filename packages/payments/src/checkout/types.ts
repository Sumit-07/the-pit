/**
 * The Dodo seam: what we send to open a checkout, what comes back, and the
 * shape of the events Dodo posts to us.
 *
 * Nothing in this package performs I/O. `DodoTransport` is the single hole
 * through which a real HTTP client is injected, which is what makes the whole
 * money path testable with no network, no key, and no fixture server —
 * `FixtureDodoTransport` implements the same interface over an in-memory map.
 *
 * The event types are declared with only the fields we actually read. A wider
 * mirror of Dodo's payload would be a second source of truth that goes stale
 * silently; `parseDodoEvent` validates exactly what it uses and ignores the
 * rest, so a new field upstream is a non-event and a REMOVED field we depend on
 * is a loud parse failure.
 */

/** `test` until a human deliberately flips it. `brief` Phase 3: Dodo test mode. */
export type DodoMode = 'test' | 'live';

export interface DodoConfig {
  readonly mode: DodoMode;
  /** The endpoint secret for signature verification, `whsec_...`. */
  readonly webhookSecret: string;
  /** Dodo product ids mapped to our tiers. Takes precedence over the amount. */
  readonly productIds: Readonly<Record<string, 'single' | 'triple'>>;
  /** Where Dodo sends the buyer after paying. A display route; it grants nothing. */
  readonly returnUrl: string;
}

/**
 * What we ask Dodo to open — guest checkout, per `brief §2.1`.
 *
 * There is no `accountId` and no `customerId`. Nothing sits between a visitor
 * and their purchase: the buyer types a URL, a name, a description, and pays.
 * The account is created server-side afterwards, from the email Dodo collected
 * and verified, on the webhook. `metadata` is how the submission travels across
 * that gap.
 */
export interface DodoCheckoutRequest {
  readonly productId: string;
  readonly quantity: number;
  readonly returnUrl: string;
  /**
   * Our own idempotency key for the checkout call, so a double-clicked "pay"
   * button opens one session rather than two. Distinct from the job idempotency
   * key: this one guards the call to Dodo, that one guards the run.
   */
  readonly idempotencyKey: string;
  /**
   * Carried through Dodo and handed back on the webhook. Keep it small and keep
   * it non-authoritative: it is attacker-influenced by construction, so the
   * webhook re-derives the normalized URL and re-reads the tier from the amount
   * rather than trusting what comes back here.
   */
  readonly metadata: Readonly<Record<string, string>>;
}

export interface DodoCheckoutSession {
  readonly sessionId: string;
  readonly paymentLink: string;
}

/** The one hole through which real HTTP reaches Dodo. */
export interface DodoTransport {
  createCheckoutSession(request: DodoCheckoutRequest): Promise<DodoCheckoutSession>;
}

/**
 * The events we act on.
 *
 * Only `payment.succeeded` grants. `payment.processing` and `payment.failed`
 * are recorded and ignored; a dispute or refund is a human decision (a $30
 * dispute fee per `brief §2.2` is not something to automate a clawback around)
 * and reaches an operations queue rather than the ledger.
 */
export type DodoEventType =
  | 'payment.succeeded'
  | 'payment.processing'
  | 'payment.failed'
  | 'payment.cancelled'
  | 'refund.succeeded'
  | 'dispute.opened';

/**
 * A Dodo webhook payload, narrowed to what we read.
 *
 * `id` is the provider's event id and the idempotency key for the entire
 * handler. `customer.email` is what `brief §2.1` turns into an account with no
 * separate identity system — Dodo verified it as part of taking the payment.
 */
export interface DodoEvent {
  readonly id: string;
  readonly type: DodoEventType;
  readonly createdAt: string;
  readonly paymentId: string;
  readonly amountCents: number;
  readonly currency: string;
  readonly productId?: string | undefined;
  readonly customerEmail: string;
  readonly metadata: Readonly<Record<string, string>>;
}

export type ParseResult =
  | { readonly ok: true; readonly event: DodoEvent }
  | { readonly ok: false; readonly reason: string };

const KNOWN_TYPES: ReadonlySet<string> = new Set<DodoEventType>([
  'payment.succeeded',
  'payment.processing',
  'payment.failed',
  'payment.cancelled',
  'refund.succeeded',
  'dispute.opened',
]);

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringMap(value: unknown): Record<string, string> {
  const source = record(value);
  if (source === undefined) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (typeof entry === 'string') {
      out[key] = entry;
    }
  }
  return out;
}

/**
 * Parse a verified webhook body.
 *
 * Runs only AFTER the signature check — an unverified body is attacker-authored
 * and has no business reaching a parser that decides how much money moved.
 * Returns a reason rather than throwing so the route can answer 400 with
 * something loggable; an unparseable body from a correctly signed sender is a
 * contract change on Dodo's side, and it must page a human rather than be
 * absorbed as a 200.
 */
export function parseDodoEvent(rawBody: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: 'body is not JSON' };
  }

  const root = record(parsed);
  if (root === undefined) {
    return { ok: false, reason: 'body is not an object' };
  }

  const id = str(root['id']) ?? str(root['event_id']);
  const type = str(root['type']);
  if (id === undefined) {
    return { ok: false, reason: 'missing event id' };
  }
  if (type === undefined) {
    return { ok: false, reason: 'missing event type' };
  }
  if (!KNOWN_TYPES.has(type)) {
    return { ok: false, reason: `unknown event type ${JSON.stringify(type)}` };
  }

  const data = record(root['data']) ?? {};
  const customer = record(data['customer']) ?? {};

  const amount = data['total_amount'] ?? data['amount'];
  if (typeof amount !== 'number' || !Number.isInteger(amount)) {
    return { ok: false, reason: 'missing or non-integer amount' };
  }

  const currency = str(data['currency']);
  if (currency === undefined) {
    return { ok: false, reason: 'missing currency' };
  }

  const paymentId = str(data['payment_id']) ?? str(data['id']);
  if (paymentId === undefined) {
    return { ok: false, reason: 'missing payment id' };
  }

  const email = str(customer['email']);
  if (email === undefined) {
    return { ok: false, reason: 'missing customer email' };
  }

  return {
    ok: true,
    event: {
      id,
      type: type as DodoEventType,
      createdAt: str(root['created_at']) ?? str(data['created_at']) ?? '',
      paymentId,
      amountCents: amount,
      currency,
      productId: str(data['product_id']),
      customerEmail: email,
      metadata: stringMap(data['metadata']),
    },
  };
}
