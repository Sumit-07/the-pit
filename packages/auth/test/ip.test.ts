/**
 * The per-IP budget in `brief §2.1` is only worth having if the IP cannot be
 * chosen by the caller. These tests are about forgery, not about parsing.
 */

import { describe, expect, it } from 'vitest';

import { clientIp, UNKNOWN_CLIENT_IP } from '../src/index.js';
import { headers } from './helpers/fixtures.js';

describe('clientIp', () => {
  it('prefers the platform header a client cannot set', () => {
    const request = headers({
      'x-vercel-forwarded-for': '198.51.100.4',
      'x-forwarded-for': '1.2.3.4, 198.51.100.4',
    });
    expect(clientIp(request)).toBe('198.51.100.4');
  });

  it('reads the LAST entry of x-forwarded-for, not the first', () => {
    // The client sent `X-Forwarded-For: 1.2.3.4`; our proxy appended the real
    // peer. Reading the first entry — which is what most snippets do — would
    // hand the attacker a fresh rate-limit bucket on every request.
    const request = headers({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9' });
    expect(clientIp(request)).toBe('203.0.113.9');
  });

  it('is not fooled by a long forged chain', () => {
    const request = headers({ 'x-forwarded-for': '10.0.0.1, 10.0.0.2, 10.0.0.3, 203.0.113.9' });
    expect(clientIp(request)).toBe('203.0.113.9');
  });

  it('counts back further when more proxies are trusted', () => {
    const request = headers({ 'x-forwarded-for': '1.2.3.4, 203.0.113.9, 10.0.0.5' });
    expect(clientIp(request, { trustedProxyHops: 2 })).toBe('203.0.113.9');
  });

  it('degrades to the earliest entry rather than inventing trust', () => {
    const request = headers({ 'x-forwarded-for': '203.0.113.9' });
    expect(clientIp(request, { trustedProxyHops: 3 })).toBe('203.0.113.9');
  });

  it('falls back to x-real-ip', () => {
    expect(clientIp(headers({ 'x-real-ip': '203.0.113.9' }))).toBe('203.0.113.9');
  });

  it('buckets everything unidentifiable together rather than not at all', () => {
    // The safe direction: a misconfigured proxy makes the limit too strict, never
    // unlimited.
    expect(clientIp(headers({}))).toBe(UNKNOWN_CLIENT_IP);
    expect(clientIp(headers({ 'x-forwarded-for': '' }))).toBe(UNKNOWN_CLIENT_IP);
    expect(clientIp(headers({ 'x-forwarded-for': '  ,  ' }))).toBe(UNKNOWN_CLIENT_IP);
  });
});
