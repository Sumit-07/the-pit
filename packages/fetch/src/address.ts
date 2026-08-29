/**
 * Which IP addresses the fetcher is allowed to talk to.
 *
 * This is the deny list the whole package exists for. Everything else here —
 * the redirect cap, the size cap, the content-type check — is hygiene; this is
 * the security control. Two rules shape it:
 *
 * 1. **It classifies an ADDRESS, never a hostname.** A hostname tells you
 *    nothing: `internal.attacker.example` is a perfectly ordinary public name
 *    whose A record is `169.254.169.254`. `fetch.ts` therefore resolves first
 *    and asks this module about the answer, not about the name.
 * 2. **It is an allow-by-exclusion list, and the exclusions are generous.** A
 *    range that is merely *unusual* for a product's marketing site (carrier-grade
 *    NAT, benchmarking, multicast) is refused, because the cost of refusing one
 *    is a message to a submitter and the cost of allowing one is the AWS
 *    metadata endpoint. `169.254.169.254` is the address this is all about, and
 *    it is reached by way of `169.254.0.0/16`, not by name.
 *
 * The IPv6 side is where naive implementations fall over: `::ffff:127.0.0.1`,
 * `2002:7f00:1::` (6to4) and `64:ff9b::7f00:1` (NAT64) all reach 127.0.0.1
 * while matching none of the obvious IPv6 prefixes. Each is unwrapped to the
 * IPv4 address it embeds and re-judged.
 */

/** A parsed IP literal. `bytes` is 4 octets for v4 and 16 for v6. */
export interface ParsedAddress {
  readonly family: 4 | 6;
  readonly bytes: Uint8Array;
}

/** One refused range: the CIDR, and what it is, for the refusal message. */
interface BlockedRange {
  readonly cidr: string;
  readonly name: string;
  readonly bytes: Uint8Array;
  readonly prefix: number;
}

function v4(a: number, b: number, c: number, d: number): Uint8Array {
  return Uint8Array.of(a, b, c, d);
}

function range(cidr: string, name: string, bytes: Uint8Array, prefix: number): BlockedRange {
  return { cidr, name, bytes, prefix };
}

/**
 * IPv4 ranges that are not the public internet.
 *
 * RFC 1918 (`10/8`, `172.16/12`, `192.168/16`) and RFC 3927 (`169.254/16`) are
 * the ones the brief names. The rest are here because they are equally reachable
 * from a server and equally not a customer's website: `100.64/10` is the address
 * space a host behind carrier NAT sees its neighbours on, `192.0.0/24` holds
 * protocol assignments including the NAT64 well-known prefix's IPv4 side,
 * `198.18/15` is the benchmarking range some infrastructure routes internally,
 * and `240/4` (which swallows `255.255.255.255`) is simply not routable.
 */
const BLOCKED_V4: readonly BlockedRange[] = [
  range('0.0.0.0/8', 'this-network', v4(0, 0, 0, 0), 8),
  range('10.0.0.0/8', 'private-use', v4(10, 0, 0, 0), 8),
  range('100.64.0.0/10', 'carrier-grade NAT', v4(100, 64, 0, 0), 10),
  range('127.0.0.0/8', 'loopback', v4(127, 0, 0, 0), 8),
  range('169.254.0.0/16', 'link-local (cloud instance metadata)', v4(169, 254, 0, 0), 16),
  range('172.16.0.0/12', 'private-use', v4(172, 16, 0, 0), 12),
  range('192.0.0.0/24', 'IETF protocol assignments', v4(192, 0, 0, 0), 24),
  range('192.0.2.0/24', 'documentation', v4(192, 0, 2, 0), 24),
  range('192.168.0.0/16', 'private-use', v4(192, 168, 0, 0), 16),
  range('198.18.0.0/15', 'benchmarking', v4(198, 18, 0, 0), 15),
  range('198.51.100.0/24', 'documentation', v4(198, 51, 100, 0), 24),
  range('203.0.113.0/24', 'documentation', v4(203, 0, 113, 0), 24),
  range('224.0.0.0/4', 'multicast', v4(224, 0, 0, 0), 4),
  range('240.0.0.0/4', 'reserved', v4(240, 0, 0, 0), 4),
];

function v6(...groups: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    bytes[index * 2] = (group >> 8) & 0xff;
    bytes[index * 2 + 1] = group & 0xff;
  });
  return bytes;
}

/**
 * IPv6 ranges refused on their own terms.
 *
 * The embedding prefixes (`::ffff:0:0/96`, `::/96`, `64:ff9b::/96`, `2002::/16`)
 * are deliberately NOT in this table: they carry an IPv4 address inside them and
 * are handled by `unwrapEmbeddedV4`, so that `::ffff:8.8.8.8` stays reachable
 * while `::ffff:127.0.0.1` does not.
 */
const BLOCKED_V6: readonly BlockedRange[] = [
  range('::/128', 'unspecified', v6(), 128),
  range('::1/128', 'loopback', v6(0, 0, 0, 0, 0, 0, 0, 1), 128),
  range('100::/64', 'discard-only', v6(0x0100), 64),
  range('2001::/32', 'Teredo tunnelling', v6(0x2001), 32),
  range('2001:db8::/32', 'documentation', v6(0x2001, 0x0db8), 32),
  range('fc00::/7', 'unique local', v6(0xfc00), 7),
  range('fe80::/10', 'link-local', v6(0xfe80), 10),
  range('fec0::/10', 'site-local (deprecated)', v6(0xfec0), 10),
  range('ff00::/8', 'multicast', v6(0xff00), 8),
];

function withinPrefix(address: Uint8Array, range_: BlockedRange): boolean {
  const wholeBytes = range_.prefix >> 3;
  for (let index = 0; index < wholeBytes; index += 1) {
    if (address[index] !== range_.bytes[index]) return false;
  }
  const remainingBits = range_.prefix & 7;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  return ((address[wholeBytes] ?? 0) & mask) === ((range_.bytes[wholeBytes] ?? 0) & mask);
}

/**
 * Strict dotted-quad parse: exactly four decimal octets, no leading zeros.
 *
 * The leading-zero rule matters. `010.0.0.1` is 8.0.0.1 to any resolver that
 * reads it as octal and 10.0.0.1 to one that does not, and a parser that guesses
 * differently from the network stack is a bypass. Nothing here guesses: a
 * non-canonical literal is simply not an IPv4 address, and `classifyHost` refuses
 * anything that looks numeric but does not parse rather than handing it to DNS.
 */
export function parseIPv4(text: string): Uint8Array | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const bytes = new Uint8Array(4);
  for (let index = 0; index < 4; index += 1) {
    const part = parts[index] ?? '';
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith('0')) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes[index] = value;
  }
  return bytes;
}

/** RFC 4291 textual IPv6, including `::` compression and a trailing IPv4 tail. */
export function parseIPv6(text: string): Uint8Array | null {
  let body = text;
  // A zone id (`fe80::1%eth0`) never survives a URL host, and honouring one
  // would let a literal name an interface. Refused outright.
  if (body.includes('%')) return null;

  const doubleColon = body.indexOf('::');
  if (doubleColon !== body.lastIndexOf('::')) return null;

  let tail: Uint8Array | null = null;
  const lastColon = body.lastIndexOf(':');
  const afterLastColon = body.slice(lastColon + 1);
  if (afterLastColon.includes('.')) {
    tail = parseIPv4(afterLastColon);
    if (tail === null) return null;
    body = body.slice(0, lastColon + 1) + '0:0';
  }

  const [headText, tailText] = doubleColon === -1 ? [body, null] : [body.slice(0, doubleColon), body.slice(doubleColon + 2)];

  const readGroups = (text_: string): number[] | null => {
    if (text_ === '') return [];
    const groups: number[] = [];
    for (const group of text_.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(group)) return null;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };

  const head = readGroups(headText);
  if (head === null) return null;
  const rest = tailText === null ? [] : readGroups(tailText);
  if (rest === null) return null;

  const total = head.length + rest.length;
  if (tailText === null ? total !== 8 : total > 7) return null;

  const groups = tailText === null ? head : [...head, ...new Array<number>(8 - total).fill(0), ...rest];
  const bytes = v6(...groups);
  if (tail !== null) bytes.set(tail, 12);
  return bytes;
}

/** Parse an IP literal of either family. Returns `null` for a hostname. */
export function parseAddress(text: string): ParsedAddress | null {
  const bare = text.startsWith('[') && text.endsWith(']') ? text.slice(1, -1) : text;
  const four = parseIPv4(bare);
  if (four !== null) return { family: 4, bytes: four };
  if (!bare.includes(':')) return null;
  const six = parseIPv6(bare);
  return six === null ? null : { family: 6, bytes: six };
}

const EMBEDDING_PREFIXES: readonly { readonly name: string; readonly test: (bytes: Uint8Array) => boolean; readonly at: number }[] = [
  // ::ffff:0:0/96 — IPv4-mapped. The form a dual-stack socket reports.
  {
    name: 'IPv4-mapped',
    at: 12,
    test: (b) => b.slice(0, 10).every((byte) => byte === 0) && b[10] === 0xff && b[11] === 0xff,
  },
  // ::/96 — IPv4-compatible, deprecated but still parsed by some stacks.
  {
    name: 'IPv4-compatible',
    at: 12,
    test: (b) => b.slice(0, 12).every((byte) => byte === 0) && !b.slice(12).every((byte) => byte === 0),
  },
  // 64:ff9b::/96 — the NAT64 well-known prefix.
  {
    name: 'NAT64',
    at: 12,
    test: (b) => b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every((byte) => byte === 0),
  },
  // 2002::/16 — 6to4, which carries the IPv4 address in bytes 2..5.
  { name: '6to4', at: 2, test: (b) => b[0] === 0x20 && b[1] === 0x02 },
];

/** The IPv4 address an IPv6 literal embeds, if it embeds one. */
export function unwrapEmbeddedV4(bytes: Uint8Array): { readonly name: string; readonly bytes: Uint8Array } | null {
  for (const prefix of EMBEDDING_PREFIXES) {
    if (prefix.test(bytes)) {
      return { name: prefix.name, bytes: bytes.slice(prefix.at, prefix.at + 4) };
    }
  }
  return null;
}

/**
 * Why this address is refused, or `null` if it may be contacted.
 *
 * The string is a reason, not a code: it names the range, so a refusal can say
 * "169.254.169.254 is link-local (cloud instance metadata), 169.254.0.0/16"
 * rather than "blocked". Failing closed is only half the requirement; saying why
 * is the other half.
 */
export function addressBlockReason(address: ParsedAddress): string | null {
  if (address.family === 4) {
    for (const blocked of BLOCKED_V4) {
      if (withinPrefix(address.bytes, blocked)) return `${blocked.name}, ${blocked.cidr}`;
    }
    return null;
  }

  // The native IPv6 ranges are judged FIRST so that `::1` is reported as
  // loopback rather than as an IPv4-compatible wrapper around `0.0.0.1` — both
  // refuse it, but only one of them says something true.
  for (const blocked of BLOCKED_V6) {
    if (withinPrefix(address.bytes, blocked)) return `${blocked.name}, ${blocked.cidr}`;
  }

  const embedded = unwrapEmbeddedV4(address.bytes);
  if (embedded !== null) {
    const inner = addressBlockReason({ family: 4, bytes: embedded.bytes });
    if (inner !== null) return `${embedded.name} IPv6 wrapping ${formatV4(embedded.bytes)} (${inner})`;
    return null;
  }

  return null;
}

function formatV4(bytes: Uint8Array): string {
  return Array.from(bytes).join('.');
}

/**
 * Classify a textual address. Unparseable input is REFUSED, not passed through:
 * a caller reaches this with something a resolver returned or a URL contained,
 * and "I could not read it" is not a reason to connect to it.
 */
export function checkAddress(text: string): { readonly allowed: true } | { readonly allowed: false; readonly reason: string } {
  const parsed = parseAddress(text);
  if (parsed === null) {
    return { allowed: false, reason: `${JSON.stringify(text)} is not an IP address this fetcher can classify` };
  }
  const reason = addressBlockReason(parsed);
  return reason === null ? { allowed: true } : { allowed: false, reason: `${text} is ${reason}` };
}
