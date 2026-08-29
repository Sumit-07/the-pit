import { describe, expect, it } from 'vitest';

import { checkAddress, parseIPv4, parseIPv6, unwrapEmbeddedV4 } from '../src/address.js';

function blocked(text: string): string {
  const verdict = checkAddress(text);
  if (verdict.allowed) throw new Error(`expected ${text} to be refused, it was allowed`);
  return verdict.reason;
}

function allowed(text: string): boolean {
  return checkAddress(text).allowed;
}

describe('checkAddress — IPv4', () => {
  it('refuses the cloud instance metadata address, by range and by name', () => {
    // The address this whole package exists for.
    expect(blocked('169.254.169.254')).toMatch(/link-local \(cloud instance metadata\), 169\.254\.0\.0\/16/);
  });

  it('refuses the whole link-local range, not just the metadata address', () => {
    expect(allowed('169.254.0.1')).toBe(false);
    expect(allowed('169.254.255.255')).toBe(false);
  });

  it('refuses loopback anywhere in 127/8, not only 127.0.0.1', () => {
    expect(blocked('127.0.0.1')).toMatch(/loopback/);
    // A check written as `=== '127.0.0.1'` passes the line above and fails here.
    expect(allowed('127.9.9.9')).toBe(false);
  });

  it('refuses the RFC 1918 ranges', () => {
    expect(blocked('10.0.0.1')).toMatch(/private-use, 10\.0\.0\.0\/8/);
    expect(blocked('192.168.1.1')).toMatch(/private-use, 192\.168\.0\.0\/16/);
    expect(blocked('172.16.0.1')).toMatch(/private-use, 172\.16\.0\.0\/12/);
  });

  it('gets the 172.16/12 boundaries right in both directions', () => {
    // `startsWith('172.')` over-blocks; `172.16.` under-blocks. Both fail here.
    expect(allowed('172.15.255.255')).toBe(true);
    expect(allowed('172.16.0.0')).toBe(false);
    expect(allowed('172.31.255.255')).toBe(false);
    expect(allowed('172.32.0.0')).toBe(true);
  });

  it('refuses 0.0.0.0 and the rest of 0/8', () => {
    expect(blocked('0.0.0.0')).toMatch(/this-network/);
    expect(allowed('0.1.2.3')).toBe(false);
  });

  it('refuses carrier-grade NAT, benchmarking, multicast and reserved space', () => {
    expect(blocked('100.64.0.1')).toMatch(/carrier-grade NAT/);
    expect(allowed('100.63.255.255')).toBe(true);
    expect(blocked('198.18.0.1')).toMatch(/benchmarking/);
    expect(blocked('224.0.0.1')).toMatch(/multicast/);
    expect(blocked('255.255.255.255')).toMatch(/reserved/);
  });

  it('allows ordinary public addresses', () => {
    expect(allowed('93.184.216.34')).toBe(true);
    expect(allowed('8.8.8.8')).toBe(true);
    expect(allowed('1.1.1.1')).toBe(true);
  });
});

describe('checkAddress — IPv6', () => {
  it('refuses loopback, and says loopback rather than naming an embedded IPv4', () => {
    expect(blocked('::1')).toMatch(/loopback, ::1\/128/);
    expect(blocked('[::1]')).toMatch(/loopback/);
  });

  it('refuses the unspecified address, unique-local and link-local', () => {
    expect(blocked('::')).toMatch(/unspecified/);
    expect(blocked('fd00::1')).toMatch(/unique local, fc00::\/7/);
    expect(blocked('fdff:ffff::1')).toMatch(/unique local/);
    expect(blocked('fe80::1')).toMatch(/link-local, fe80::\/10/);
    expect(blocked('febf:ffff::1')).toMatch(/link-local/);
    expect(blocked('ff02::1')).toMatch(/multicast/);
  });

  it('unwraps an IPv4-mapped address and judges what is inside it', () => {
    // `::ffff:127.0.0.1` matches no IPv6 private prefix and reaches localhost.
    expect(blocked('::ffff:127.0.0.1')).toMatch(/IPv4-mapped IPv6 wrapping 127\.0\.0\.1 \(loopback/);
    expect(blocked('::ffff:169.254.169.254')).toMatch(/wrapping 169\.254\.169\.254/);
    expect(blocked('::ffff:10.0.0.1')).toMatch(/wrapping 10\.0\.0\.1/);
    // ...and lets a mapped PUBLIC address through, so the unwrap is a judgement
    // and not a second blanket ban.
    expect(allowed('::ffff:8.8.8.8')).toBe(true);
  });

  it('unwraps 6to4 and NAT64, which reach the same places by other spellings', () => {
    // 2002:7f00:0001:: is 6to4 for 127.0.0.1.
    expect(blocked('2002:7f00:1::')).toMatch(/6to4 IPv6 wrapping 127\.0\.0\.1/);
    expect(blocked('2002:a9fe:a9fe::')).toMatch(/6to4 IPv6 wrapping 169\.254\.169\.254/);
    expect(blocked('64:ff9b::a00:1')).toMatch(/NAT64 IPv6 wrapping 10\.0\.0\.1/);
    expect(allowed('2002:5db8:d822::')).toBe(true);
  });

  it('refuses Teredo and site-local outright', () => {
    expect(blocked('2001:0:1::1')).toMatch(/Teredo/);
    expect(blocked('fec0::1')).toMatch(/site-local/);
  });

  it('allows ordinary public IPv6', () => {
    expect(allowed('2606:4700:4700::1111')).toBe(true);
    expect(allowed('2a00:1450:4009:81f::200e')).toBe(true);
  });
});

describe('checkAddress — parsing', () => {
  it('refuses anything it cannot classify rather than passing it through', () => {
    expect(blocked('not-an-address')).toMatch(/not an IP address/);
    expect(blocked('')).toMatch(/not an IP address/);
    expect(blocked('999.1.1.1')).toMatch(/not an IP address/);
  });

  it('refuses a non-canonical dotted quad instead of guessing its base', () => {
    // `010.0.0.1` is 8.0.0.1 to an octal reader and 10.0.0.1 to a decimal one.
    // A parser that guesses differently from the network stack is a bypass, so
    // this is refused, not interpreted.
    expect(parseIPv4('010.0.0.1')).toBeNull();
    expect(blocked('010.0.0.1')).toMatch(/not an IP address/);
    expect(parseIPv4('0.0.0.0')).not.toBeNull();
  });

  it('refuses an IPv6 zone id, which names an interface rather than a host', () => {
    expect(parseIPv6('fe80::1%eth0')).toBeNull();
    expect(blocked('fe80::1%eth0')).toMatch(/not an IP address/);
  });

  it('parses compressed, full and IPv4-tailed IPv6 to the same bytes', () => {
    const compressed = parseIPv6('::ffff:127.0.0.1');
    const full = parseIPv6('0:0:0:0:0:ffff:127.0.0.1');
    const hex = parseIPv6('0000:0000:0000:0000:0000:ffff:7f00:0001');
    expect(compressed).not.toBeNull();
    expect(Array.from(compressed ?? [])).toEqual(Array.from(full ?? []));
    expect(Array.from(compressed ?? [])).toEqual(Array.from(hex ?? []));
  });

  it('rejects malformed IPv6', () => {
    expect(parseIPv6('1::2::3')).toBeNull();
    expect(parseIPv6('1:2:3:4:5:6:7:8:9')).toBeNull();
    expect(parseIPv6('1:2:3:4:5:6:7')).toBeNull();
    expect(parseIPv6('gggg::1')).toBeNull();
  });

  it('reports which embedding a wrapped IPv4 came from', () => {
    expect(unwrapEmbeddedV4(parseIPv6('::ffff:1.2.3.4') ?? new Uint8Array(16))?.name).toBe('IPv4-mapped');
    expect(unwrapEmbeddedV4(parseIPv6('64:ff9b::1.2.3.4') ?? new Uint8Array(16))?.name).toBe('NAT64');
    expect(unwrapEmbeddedV4(parseIPv6('2002:102:304::') ?? new Uint8Array(16))?.name).toBe('6to4');
    expect(unwrapEmbeddedV4(parseIPv6('2606:4700::1111') ?? new Uint8Array(16))).toBeNull();
  });
});
