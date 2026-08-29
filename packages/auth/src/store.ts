/**
 * The persistence seam — the whole of it.
 *
 * Three methods. Nothing in this package opens a socket, reads an environment
 * variable, or knows that Postgres exists, for the same reason `packages/
 * payments` does not: the identity schema is another agent's, and a package that
 * imported their tables would have to be rewritten every time they moved one.
 * Everything here is testable with no database, and `MemoryAuthStore` is the
 * proof that the interface is implementable without one.
 *
 * ## The contract the real implementation must honour
 *
 * `packages/db`'s `tokens` table already exists and this interface is written to
 * fit it exactly — `tokens(token_hash, email, expires_at, used_at, created_at)`,
 * `token_hash` primary key. The only thing an implementer has to add is the
 * account lookup, against whatever the `accounts` table ends up being called.
 *
 * `consumeToken` is the one with a sharp edge. It MUST be the single atomic
 * statement the schema was designed around:
 *
 * ```sql
 * UPDATE tokens SET used_at = now()
 *  WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
 *  RETURNING email
 * ```
 *
 * One statement, every condition in the WHERE clause. A read-then-write —
 * `SELECT` the row, check `used_at` in TypeScript, `UPDATE` it — is a race:
 * two concurrent redemptions of the same link both read a null `used_at` and
 * both succeed, and single use (`brief §2.1`) is gone. The interface returns a
 * union rather than a row precisely so that no caller is tempted to make the
 * decision itself.
 *
 * ## Why `consumeToken` reports no reason
 *
 * Expired, already used, and never existed are one outcome: `rejected`. That is
 * not laziness, it is the same posture `brief §2.1` requires of
 * `POST /auth/request` — "always respond 'check your inbox' regardless of
 * whether the email exists" — carried to the redemption side. The UPDATE above
 * physically cannot distinguish them (it reports rows affected), and a richer
 * return type would invite a route to render the difference, which tells someone
 * holding a stolen or guessed token whether they are close.
 */

/**
 * An account, as the session needs it. Deliberately two fields: the auth path
 * has no business reading a balance, a name, or a payment history.
 */
export interface AuthAccount {
  readonly accountId: string;
  /** The stored, normalized address. `normalizeEmail`'s output. */
  readonly email: string;
}

/**
 * A row for `tokens`, and only ever this shape. There is no `token` field and
 * there must never be one: see `src/token.ts`.
 */
export interface NewMagicToken {
  /** Lowercase hex SHA-256 of the raw token — `hashToken`'s output, 64 chars. */
  readonly tokenHash: string;
  /** Lowercased — `normalizeEmail`'s output. The table CHECKs this. */
  readonly email: string;
  /** `createdAt + 15 minutes`, per `brief §2.1`. */
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export type ConsumeTokenResult =
  /** The link was valid and is now spent. `email` is the row's stored address. */
  | { readonly outcome: 'consumed'; readonly email: string }
  /** Expired, already used, or never existed — and no caller may learn which. */
  | { readonly outcome: 'rejected' };

export interface AuthStore {
  /**
   * The account for a normalized address, or `null`.
   *
   * Never creates. Account creation happens in exactly one place in this
   * project — the signed Dodo webhook (`brief §2.1`, `packages/payments`'
   * `WebhookStore.ensureAccount`) — and an auth path that could create an
   * account would turn the magic link into a self-serve signup, which is the
   * thing the whole design is avoiding.
   */
  findAccountByEmail(email: string): Promise<AuthAccount | null>;

  /**
   * Insert one token row.
   *
   * Called for every well-formed request, including requests for addresses with
   * no account — see `requestMagicLink`, which keeps the database work identical
   * either way so that response latency does not become the enumeration oracle
   * the identical response body was written to close.
   */
  createToken(token: NewMagicToken): Promise<void>;

  /**
   * Spend a token if and only if it is unspent and unexpired, atomically.
   *
   * See the module comment: one UPDATE, everything in the WHERE clause.
   */
  consumeToken(input: { readonly tokenHash: string; readonly now: Date }): Promise<ConsumeTokenResult>;
}
