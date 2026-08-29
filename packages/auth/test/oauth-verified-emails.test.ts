/**
 * The filter that stands between a customer's account and anyone who can type.
 *
 * `GET /user/emails` returns verified and unverified addresses in one array, and
 * adding an address to a GitHub account requires proving nothing — only
 * VERIFYING it does. So every test here is really the same test asked in a
 * different shape: does an address that nobody proved control of ever reach the
 * list we match purchases against?
 */

import { describe, expect, it } from 'vitest';

import { unverifiedProviderEmails, verifiedProviderEmails, type ProviderIdentity } from '../src/index.js';

function identity(emails: ProviderIdentity['emails']): ProviderIdentity {
  return { providerUserId: '4242', emails };
}

describe('what may be matched against a purchase', () => {
  it('keeps verified addresses', () => {
    const kept = verifiedProviderEmails(
      identity([{ email: 'payer@example.com', verified: true, primary: true }]),
    );
    expect(kept).toEqual(['payer@example.com']);
  });

  it('drops unverified ones — the whole attack', () => {
    // The attacker added the customer's address to their own GitHub and never
    // confirmed it. If this returns it, they own the customer's account.
    const kept = verifiedProviderEmails(
      identity([{ email: 'victim@example.com', verified: false, primary: true }]),
    );
    expect(kept).toEqual([]);
  });

  it('keeps the verified ones and drops the unverified ones from the same identity', () => {
    // The realistic shape: the attacker's own verified address alongside the
    // customer's unverified one. Only their own may match anything.
    const kept = verifiedProviderEmails(
      identity([
        { email: 'victim@example.com', verified: false, primary: true },
        { email: 'attacker@example.com', verified: true, primary: false },
      ]),
    );
    expect(kept).toEqual(['attacker@example.com']);
  });

  it('treats a stringly-typed "false" as unverified', () => {
    // JSON from a third party is exactly where a boolean arrives as a string,
    // and `"false"` is truthy. `=== true` is the reason this passes.
    const kept = verifiedProviderEmails(
      identity([{ email: 'sneaky@example.com', verified: 'false' as unknown as boolean, primary: true }]),
    );
    expect(kept).toEqual([]);
  });

  it('treats any non-true value as unverified', () => {
    for (const value of [1, 'true', {}, [], 'yes']) {
      const kept = verifiedProviderEmails(
        identity([{ email: 'sneaky@example.com', verified: value as unknown as boolean, primary: true }]),
      );
      expect(`${JSON.stringify(value)} -> ${JSON.stringify(kept)}`).toBe(`${JSON.stringify(value)} -> []`);
    }
  });
});

describe('normalizing, so a match is possible at all', () => {
  it('lowercases, because accounts.email is stored lowercase and CHECKs it', () => {
    // Unfolded, the customer who paid is simply not found, and the failure looks
    // like "no purchase" rather than like the bug it is.
    const kept = verifiedProviderEmails(
      identity([{ email: 'Payer@Example.COM', verified: true, primary: true }]),
    );
    expect(kept).toEqual(['payer@example.com']);
  });

  it('trims surrounding whitespace', () => {
    const kept = verifiedProviderEmails(identity([{ email: '  payer@example.com  ', verified: true, primary: true }]));
    expect(kept).toEqual(['payer@example.com']);
  });

  it('drops anything that is not a plausible address', () => {
    // These arrive over the network from a third party. Whitespace inside the
    // address is a header-injection attempt; the rest cannot be an address.
    const kept = verifiedProviderEmails(
      identity([
        { email: '', verified: true, primary: false },
        { email: 'no-at-sign', verified: true, primary: false },
        { email: 'nobody@localhost', verified: true, primary: false },
        { email: 'a@b.com\nBcc: victim@example.com', verified: true, primary: false },
        { email: 'real@example.com', verified: true, primary: false },
      ]),
    );
    expect(kept).toEqual(['real@example.com']);
  });

  it('de-duplicates addresses GitHub lists more than once', () => {
    const kept = verifiedProviderEmails(
      identity([
        { email: 'payer@example.com', verified: true, primary: true },
        { email: 'PAYER@example.com', verified: true, primary: false },
      ]),
    );
    expect(kept).toEqual(['payer@example.com']);
  });
});

describe('candidate order is a property of the data, not of GitHub`s JSON', () => {
  it('puts the primary address first regardless of position in the array', () => {
    const kept = verifiedProviderEmails(
      identity([
        { email: 'secondary@example.com', verified: true, primary: false },
        { email: 'primary@example.com', verified: true, primary: true },
        { email: 'tertiary@example.com', verified: true, primary: false },
      ]),
    );
    expect(kept).toEqual(['primary@example.com', 'secondary@example.com', 'tertiary@example.com']);
  });

  it('keeps declaration order among the non-primary addresses', () => {
    const kept = verifiedProviderEmails(
      identity([
        { email: 'b@example.com', verified: true, primary: false },
        { email: 'a@example.com', verified: true, primary: false },
      ]),
    );
    expect(kept).toEqual(['b@example.com', 'a@example.com']);
  });

  it('ignores the primary flag on an unverified address', () => {
    // A primary-but-unverified address is still unverified. GitHub will not let
    // you make an unverified address primary, but the parser must not depend on
    // a remote system's invariant.
    const kept = verifiedProviderEmails(
      identity([
        { email: 'unverified-primary@example.com', verified: false, primary: true },
        { email: 'verified@example.com', verified: true, primary: false },
      ]),
    );
    expect(kept).toEqual(['verified@example.com']);
  });
});

describe('the rejected list', () => {
  it('names what was ignored, so the page can explain itself', () => {
    const ignored = unverifiedProviderEmails(
      identity([
        { email: 'Kept@example.com', verified: true, primary: true },
        { email: 'Dropped@example.com', verified: false, primary: false },
      ]),
    );
    expect(ignored).toEqual(['dropped@example.com']);
  });

  it('never overlaps with the matched list', () => {
    // Two functions, two names, and no address in both — so a caller cannot
    // reconstruct the unfiltered array by concatenating them without noticing.
    const both = identity([
      { email: 'yes@example.com', verified: true, primary: true },
      { email: 'no@example.com', verified: false, primary: false },
    ]);
    const matched = verifiedProviderEmails(both);
    const ignored = unverifiedProviderEmails(both);
    expect(matched.filter((email) => ignored.includes(email))).toEqual([]);
  });
});
