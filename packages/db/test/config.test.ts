/**
 * `DATABASE_URL`, and the failure that has to be loud.
 *
 * There is no database provisioned for this project, so the unset case is the
 * ordinary one and its message is the whole user interface. These tests assert
 * the message says three things — which variable, what was found, and where to
 * set it — because a message that only says "invalid connection string" costs the
 * reader the twenty minutes this exists to save.
 */

import { describe, expect, it } from 'vitest';

import { DATABASE_URL_ENV, hasDatabaseUrl, MissingDatabaseUrlError, requireDatabaseUrl } from '../src/config.js';

/** The message `requireDatabaseUrl` produces for a value, or `''` if it accepted it. */
function messageFor(value: string): string {
  try {
    requireDatabaseUrl({ DATABASE_URL: value });
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('requireDatabaseUrl', () => {
  it('returns the URL when it is set', () => {
    const url = 'postgresql://user:pw@db.example.com/pit?sslmode=require';
    expect(requireDatabaseUrl({ DATABASE_URL: url })).toBe(url);
  });

  it('accepts the postgres:// spelling too', () => {
    const url = 'postgres://user:pw@db.example.com/pit';
    expect(requireDatabaseUrl({ DATABASE_URL: url })).toBe(url);
  });

  it('trims surrounding whitespace, which is how a copied value usually arrives', () => {
    expect(requireDatabaseUrl({ DATABASE_URL: '  postgres://u@h/db\n' })).toBe('postgres://u@h/db');
  });

  it('throws a typed error when unset', () => {
    // Typed rather than bare, so a health check can tell "not configured" from
    // "the database refused the connection" — same symptom, different fix.
    expect(() => requireDatabaseUrl({})).toThrow(MissingDatabaseUrlError);
  });

  it('names the variable, the problem, and where to set it', () => {
    let message = '';
    try {
      requireDatabaseUrl({});
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain(DATABASE_URL_ENV);
    expect(message).toContain('is not set');
    expect(message).toContain('postgresql://');
    expect(message).toContain('Vercel');
  });

  it('distinguishes empty from unset', () => {
    // A variable set to '' is a different mistake from one nobody set: it usually
    // means a deploy hook wrote an empty value, and the fix is elsewhere.
    expect(() => requireDatabaseUrl({ DATABASE_URL: '   ' })).toThrow(/set but empty/);
  });

  it('rejects a value that is not a URL', () => {
    expect(() => requireDatabaseUrl({ DATABASE_URL: 'psql -h db.example.com' })).toThrow(/is not a URL/);
  });

  it('rejects a URL that is not Postgres', () => {
    // The realistic mistake: pasting the Neon dashboard link instead of the
    // connection string.
    expect(() => requireDatabaseUrl({ DATABASE_URL: 'https://console.neon.tech/app/projects/x' })).toThrow(
      /must be a postgres:\/\/ or postgresql:\/\/ URL/,
    );
  });

  it('truncates an unparseable value rather than echoing it whole', () => {
    // The message can reach a log, and the password is in the URL. The
    // unparseable branch is the only one that echoes the value at all, so it is
    // the only one that has to truncate.
    // No colon anywhere, so `new URL` rejects it outright rather than reading
    // the first token as a scheme.
    const secret = `${'s3cr3t'.repeat(20)}@host/db`;
    const message = messageFor(secret);

    expect(message).not.toContain(secret);
    expect(message).toContain('...');
    expect(message).toContain(secret.slice(0, 40));
  });

  it('echoes only the scheme when the value parses but is not Postgres', () => {
    // A URL that parses carries its credentials in the userinfo. The message
    // names the protocol and stops there.
    const message = messageFor('mysql://user:s3cr3t@host/db');

    expect(message).toContain('"mysql:"');
    expect(message).not.toContain('s3cr3t');
  });
});

describe('hasDatabaseUrl', () => {
  it('is false when unset and true when valid', () => {
    expect(hasDatabaseUrl({})).toBe(false);
    expect(hasDatabaseUrl({ DATABASE_URL: 'postgres://u@h/db' })).toBe(true);
  });

  it('is false for a value that would fail at connection time', () => {
    // The `describe.skipIf` guards read this. A guard that said "configured" for
    // an unusable value would let the integration suite fail on this machine.
    expect(hasDatabaseUrl({ DATABASE_URL: 'https://example.com' })).toBe(false);
  });
});

describe('importing the package reads no environment', () => {
  it('exposes the schema without a DATABASE_URL', async () => {
    // `next build` traces server modules by importing them. A connection opened
    // at module scope would turn a missing variable into a build failure.
    const module = await import('../src/index.js');
    expect(Object.keys(module)).toContain('products');
    expect(Object.keys(module)).toContain('attempts');
  });
});
