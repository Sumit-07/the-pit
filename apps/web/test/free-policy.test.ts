/**
 * The two things about the free door that need no database.
 *
 * 1. **It refuses to exist unbound.** `freeRunPolicy()` throws at construction
 *    when there is nothing to count against. The alternatives are both silent:
 *    an `{ ok: true }` fallback hands out unlimited free runs on any deployment
 *    whose database is not wired, and an `{ ok: false }` one shuts the door
 *    permanently with nothing in the logs. `lib/pipeline/mode.ts` introduced
 *    `PipelineBindingError` for exactly this shape of failure.
 *
 * 2. **The list is a list a human can read.** `disposable-domains.ts` is 600-odd
 *    lines whose only job is to be scanned and appended to. Sorted, lowercase and
 *    unique is what makes an addition reviewable in a diff, so it is asserted
 *    rather than hoped for.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DISPOSABLE_EMAIL_DOMAINS, isDisposableDomain } from '@/lib/free/disposable-domains';
import { emailDomain, freeRunPolicy } from '@/lib/free/policy';
import { PipelineBindingError } from '@/lib/pipeline/mode';

const SAVED = { database: process.env['DATABASE_URL'], secret: process.env['SESSION_SECRET'] };

beforeEach(() => {
  delete process.env['DATABASE_URL'];
  delete process.env['SESSION_SECRET'];
});

afterEach(() => {
  if (SAVED.database === undefined) delete process.env['DATABASE_URL'];
  else process.env['DATABASE_URL'] = SAVED.database;
  if (SAVED.secret === undefined) delete process.env['SESSION_SECRET'];
  else process.env['SESSION_SECRET'] = SAVED.secret;
});

describe('offline, the policy refuses to be constructed', () => {
  it('names DATABASE_URL rather than allowing everything', () => {
    expect(() => freeRunPolicy()).toThrow(PipelineBindingError);
    expect(() => freeRunPolicy()).toThrow(/DATABASE_URL/);
    // The message has to say what the silent alternative would have been, because
    // the person reading it is deciding whether to "just skip the check".
    expect(() => freeRunPolicy()).toThrow(/unlimited free runs/);
  });

  it('names SESSION_SECRET when there is a database but no key', () => {
    process.env['DATABASE_URL'] = 'postgres://user:pass@localhost:5432/pit';

    expect(() => freeRunPolicy()).toThrow(PipelineBindingError);
    expect(() => freeRunPolicy()).toThrow(/SESSION_SECRET/);
  });

  it('refuses a secret too short to be one', () => {
    process.env['DATABASE_URL'] = 'postgres://user:pass@localhost:5432/pit';
    process.env['SESSION_SECRET'] = 'short';

    // `assertUsableKeyring` throws a RangeError; it arrives here as the binding
    // error, because from the caller's side it is the same fault: not configured.
    expect(() => freeRunPolicy()).toThrow(PipelineBindingError);
  });
});

describe('the disposable list', () => {
  it('is sorted, lowercase, unique and non-trivial', () => {
    expect(DISPOSABLE_EMAIL_DOMAINS.length).toBeGreaterThan(300);

    const sorted = [...DISPOSABLE_EMAIL_DOMAINS].sort();
    expect(DISPOSABLE_EMAIL_DOMAINS).toEqual(sorted);
    expect(new Set(DISPOSABLE_EMAIL_DOMAINS).size).toBe(DISPOSABLE_EMAIL_DOMAINS.length);

    for (const domain of DISPOSABLE_EMAIL_DOMAINS) {
      expect(domain).toBe(domain.toLowerCase());
      expect(domain).not.toMatch(/[@\s]/);
      expect(domain).toMatch(/\./);
    }
  });

  it('carries the ones people actually use', () => {
    for (const domain of [
      'mailinator.com',
      'guerrillamail.com',
      '10minutemail.com',
      'temp-mail.org',
      'yopmail.com',
      'sharklasers.com',
      'dispostable.com',
      'trashmail.com',
      'getnada.com',
      'mohmal.com',
      'maildrop.cc',
      'grr.la',
    ]) {
      expect(DISPOSABLE_EMAIL_DOMAINS).toContain(domain);
    }
  });

  it('does not refuse the mailbox providers real founders use', () => {
    for (const domain of ['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'icloud.com', 'proton.me']) {
      expect(isDisposableDomain(domain)).toBe(false);
    }
  });

  it('matches subdomains and only at a label boundary', () => {
    expect(isDisposableDomain('mailinator.com')).toBe(true);
    expect(isDisposableDomain('MAILINATOR.COM')).toBe(true);
    expect(isDisposableDomain('team.mailinator.com')).toBe(true);
    expect(isDisposableDomain('a.b.mailinator.com')).toBe(true);
    // The trailing-dot form of a fully qualified name.
    expect(isDisposableDomain('mailinator.com.')).toBe(true);

    // `notmailinator.com` is a real Mailinator alias and IS listed, so the false
    // positive being guarded against is spelled with a label that is not one.
    expect(isDisposableDomain('ourmailinator.com')).toBe(false);
    expect(isDisposableDomain('mailinator.com.evil.example')).toBe(false);
    expect(isDisposableDomain('')).toBe(false);
  });
});

describe('emailDomain', () => {
  it('takes the last @, so a quoted local part cannot smuggle a domain', () => {
    expect(emailDomain('a@b@mailinator.com')).toBe('mailinator.com');
    expect(emailDomain('Founder@Example.COM')).toBe('example.com');
    expect(emailDomain('nonsense')).toBe('');
  });
});
