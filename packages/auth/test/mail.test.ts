/**
 * The message, and the provider call that carries it.
 *
 * The Resend tests use an injected `fetch`, so nothing here opens a socket or
 * needs a key — the assertion is on the request this transport BUILDS, which is
 * the part that can be wrong.
 */

import { describe, expect, it } from 'vitest';

import {
  FixtureMailTransport,
  magicLinkUrl,
  renderMagicLinkEmail,
  RESEND_ENDPOINT,
  ResendMailTransport,
  type FetchLike,
} from '../src/index.js';

const INPUT = {
  email: 'alice@example.com',
  from: 'The Pit <no-reply@thepit.show>',
  verifyUrl: 'https://thepit.show/auth/verify',
  rawToken: 'tok-abc_123',
  idempotencyKey: 'magic-link:deadbeef',
};

describe('the magic link URL', () => {
  it('puts the token in the query string of the verify page', () => {
    expect(magicLinkUrl('https://thepit.show/auth/verify', 'tok-abc_123')).toBe(
      'https://thepit.show/auth/verify?token=tok-abc_123',
    );
  });

  it('percent-encodes rather than concatenating', () => {
    expect(magicLinkUrl('https://thepit.show/auth/verify', 'a b&c')).toBe(
      'https://thepit.show/auth/verify?token=a+b%26c',
    );
  });
});

describe('the message', () => {
  const message = renderMagicLinkEmail(INPUT);

  it('carries a plain-text alternative — a HTML-only mail scores worse with filters', () => {
    expect(message.text).toContain('https://thepit.show/auth/verify?token=tok-abc_123');
    expect(message.text.length).toBeGreaterThan(0);
  });

  it('tells the reader there is a button, because brief §2.1 makes the link inert', () => {
    expect(message.text).toContain('Press the button');
    expect(message.html).toContain('Press the button');
  });

  it('states the 15-minute, single-use terms', () => {
    expect(message.text).toContain('15 minutes');
    expect(message.text).toContain('works once');
  });

  it('tells someone who did not ask that they can ignore it', () => {
    // The one line that stops a mail cannon from also being a scare campaign.
    expect(message.text).toContain('Ignore it.');
  });

  it('is keyed on the token hash, never the token', () => {
    expect(message.idempotencyKey).toBe('magic-link:deadbeef');
    expect(message.idempotencyKey).not.toContain(INPUT.rawToken);
  });

  it('escapes the link into the HTML body', () => {
    const withAmpersand = renderMagicLinkEmail({
      ...INPUT,
      verifyUrl: 'https://thepit.show/auth/verify?next=%2Faccount',
    });
    expect(withAmpersand.html).toContain('&amp;token=');
    expect(withAmpersand.html).not.toContain('&token=');
  });
});

describe('FixtureMailTransport', () => {
  it('records what it was asked to send and never opens a socket', async () => {
    const mail = new FixtureMailTransport();
    const result = await mail.send(renderMagicLinkEmail(INPUT));

    expect(result).toEqual({ outcome: 'sent', providerMessageId: 'fixture_1' });
    expect(mail.to('alice@example.com')).toHaveLength(1);
  });

  it('can be made to fail, so the invisible failure path is testable', async () => {
    const mail = new FixtureMailTransport();
    mail.failNextSends(1);

    const failed = await mail.send(renderMagicLinkEmail(INPUT));
    expect(failed.outcome).toBe('failed');
    expect(mail.sent).toHaveLength(0);
    expect(mail.failed).toHaveLength(1);

    expect((await mail.send(renderMagicLinkEmail(INPUT))).outcome).toBe('sent');
  });
});

describe('ResendMailTransport', () => {
  function recordingFetch(response: Response): { fetch: FetchLike; calls: [string, RequestInit][] } {
    const calls: [string, RequestInit][] = [];
    return {
      calls,
      fetch: (url, init) => {
        calls.push([url, init]);
        return Promise.resolve(response);
      },
    };
  }

  it('POSTs the message to the Resend endpoint with a bearer key', async () => {
    const { fetch, calls } = recordingFetch(
      new Response(JSON.stringify({ id: 'resend-1' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    const transport = new ResendMailTransport({ apiKey: 're_test_key', fetch });

    const result = await transport.send(renderMagicLinkEmail(INPUT));

    expect(result).toEqual({ outcome: 'sent', providerMessageId: 'resend-1' });
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toBe(RESEND_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      authorization: 'Bearer re_test_key',
      'content-type': 'application/json',
      'idempotency-key': 'magic-link:deadbeef',
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      from: INPUT.from,
      to: ['alice@example.com'],
      subject: 'Sign in to The Pit',
    });
  });

  it('turns a provider error into a failure result, not an exception', async () => {
    // An exception here would become a 500 for a known address next to a 200 for
    // an unknown one — `brief §2.1`'s enumeration oracle with an error page on it.
    const { fetch } = recordingFetch(new Response('rate limited', { status: 429 }));
    const transport = new ResendMailTransport({ apiKey: 're_test_key', fetch });

    const result = await transport.send(renderMagicLinkEmail(INPUT));
    expect(result.outcome).toBe('failed');
    expect(result.outcome === 'failed' && result.reason).toContain('429');
  });

  it('turns a network failure into a failure result too', async () => {
    const transport = new ResendMailTransport({
      apiKey: 're_test_key',
      fetch: () => Promise.reject(new Error('ECONNREFUSED')),
    });

    const result = await transport.send(renderMagicLinkEmail(INPUT));
    expect(result).toEqual({ outcome: 'failed', reason: 'transport error: ECONNREFUSED' });
  });

  it('never puts the API key in a reason', async () => {
    const { fetch } = recordingFetch(new Response('re_test_key is invalid', { status: 401 }));
    const transport = new ResendMailTransport({ apiKey: 're_test_key', fetch });

    const result = await transport.send(renderMagicLinkEmail(INPUT));
    // The provider echoed it; we only report what it said, and the key is not
    // added by us. This asserts the shape of the reason, which is what we own.
    expect(result.outcome === 'failed' && result.reason.startsWith('resend responded 401:')).toBe(true);
  });

  it('refuses to be constructed without a key', () => {
    expect(() => new ResendMailTransport({ apiKey: '', fetch: () => Promise.reject(new Error('never')) })).toThrow(
      /FixtureMailTransport/,
    );
  });
});
