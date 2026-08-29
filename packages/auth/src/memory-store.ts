/**
 * An `AuthStore` that enforces every guarantee the real one has to, in memory.
 *
 * A fake that is more permissive than the database it stands in for produces
 * tests that pass and production that does not, so this one is deliberately
 * strict:
 *
 * - `createToken` rejects a `tokenHash` that is not 64 lowercase hex characters,
 *   which is `packages/db`'s `tokens_hash_is_sha256_hex` CHECK. A regression
 *   that stored the raw token would fail here the same way it would fail in
 *   Postgres, rather than quietly passing and being caught only by the one test
 *   that inspects the stored value.
 * - `createToken` rejects a mixed-case email (`tokens_email_lowercase`) and an
 *   expiry at or before creation (`tokens_expiry_after_creation`).
 * - `createToken` rejects a duplicate hash, because `token_hash` is the PRIMARY
 *   KEY.
 * - `consumeToken` is a single atomic step over the map, checking `usedAt` and
 *   `expiresAt` and writing `usedAt` with nothing in between — the JavaScript
 *   equivalent of putting every condition in the UPDATE's WHERE clause.
 *
 * It also records every call, in order, so a test can assert "the store was
 * never touched" — which is what proves `GET /auth/verify` does not consume a
 * token — rather than only "the token still works afterwards".
 *
 * Shipped in `src` because the web app's route tests and local development both
 * need it and cannot import another package's `test/` folder.
 */

import type { AuthAccount, AuthStore, ConsumeTokenResult, NewMagicToken } from './store.js';

/** A stored row: the five columns `tokens` has, and not a sixth. */
export interface StoredToken {
  readonly tokenHash: string;
  readonly email: string;
  readonly expiresAt: Date;
  usedAt: Date | null;
  readonly createdAt: Date;
}

export type AuthStoreCall =
  | { readonly method: 'findAccountByEmail'; readonly email: string }
  | { readonly method: 'createToken'; readonly tokenHash: string; readonly email: string }
  | { readonly method: 'consumeToken'; readonly tokenHash: string };

const SHA256_HEX = /^[0-9a-f]{64}$/;

export class MemoryAuthStore implements AuthStore {
  /** `email -> accountId`. Populated by `seedAccount`, never by the auth path. */
  readonly #accounts = new Map<string, string>();
  /** `tokenHash -> row`. The primary key is the hash, as in the real table. */
  readonly #tokens = new Map<string, StoredToken>();
  /** Every call that reached the store, in order. */
  readonly calls: AuthStoreCall[] = [];
  #counter = 0;

  /**
   * Stand in for the Dodo webhook's `ensureAccount`. Named so it can never be
   * mistaken for something the auth path is allowed to call.
   */
  seedAccount(email: string, accountId?: string): AuthAccount {
    this.#counter += 1;
    const id = accountId ?? `acct_${this.#counter}`;
    this.#accounts.set(email, id);
    return { accountId: id, email };
  }

  findAccountByEmail(email: string): Promise<AuthAccount | null> {
    this.calls.push({ method: 'findAccountByEmail', email });
    const accountId = this.#accounts.get(email);
    return Promise.resolve(accountId === undefined ? null : { accountId, email });
  }

  createToken(token: NewMagicToken): Promise<void> {
    this.calls.push({ method: 'createToken', tokenHash: token.tokenHash, email: token.email });

    if (!SHA256_HEX.test(token.tokenHash)) {
      return Promise.reject(
        new Error(
          `tokens_hash_is_sha256_hex: refused ${JSON.stringify(token.tokenHash)}. ` +
            'brief §2.1 stores the SHA-256 of the token, never the raw value.',
        ),
      );
    }
    if (token.email !== token.email.toLowerCase()) {
      return Promise.reject(new Error(`tokens_email_lowercase: refused ${JSON.stringify(token.email)}`));
    }
    if (token.expiresAt.getTime() <= token.createdAt.getTime()) {
      return Promise.reject(new Error('tokens_expiry_after_creation: a token that expires before it is issued'));
    }
    if (this.#tokens.has(token.tokenHash)) {
      return Promise.reject(new Error('tokens_pkey: duplicate token_hash'));
    }

    this.#tokens.set(token.tokenHash, {
      tokenHash: token.tokenHash,
      email: token.email,
      expiresAt: token.expiresAt,
      usedAt: null,
      createdAt: token.createdAt,
    });
    return Promise.resolve();
  }

  consumeToken(input: { tokenHash: string; now: Date }): Promise<ConsumeTokenResult> {
    this.calls.push({ method: 'consumeToken', tokenHash: input.tokenHash });

    const row = this.#tokens.get(input.tokenHash);
    // Every condition together, then the write — no await, no read-then-decide.
    // The real implementation gets this from a single UPDATE ... WHERE.
    if (row === undefined || row.usedAt !== null || row.expiresAt.getTime() <= input.now.getTime()) {
      return Promise.resolve({ outcome: 'rejected' });
    }
    row.usedAt = input.now;
    return Promise.resolve({ outcome: 'consumed', email: row.email });
  }

  /**
   * Read a stored row. For assertions only — nothing in `src` calls it, and the
   * real store deliberately exposes no such method.
   */
  storedToken(tokenHash: string): StoredToken | undefined {
    const row = this.#tokens.get(tokenHash);
    return row === undefined ? undefined : { ...row };
  }

  /** Every stored row, so a test can search for a raw token across all of them. */
  allStoredTokens(): readonly StoredToken[] {
    return [...this.#tokens.values()].map((row) => ({ ...row }));
  }

  get tokenCount(): number {
    return this.#tokens.size;
  }
}
