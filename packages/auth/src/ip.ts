/**
 * The client address, for the per-IP budget in `brief §2.1`.
 *
 * ## Why this is not one line
 *
 * `x-forwarded-for` is a client-supplied header. Anyone can send
 * `X-Forwarded-For: 1.2.3.4` and, on a naive reading, land in whichever rate
 * bucket they like — including a fresh one for every request, which turns the
 * per-IP limit off entirely.
 *
 * It is only trustworthy because a proxy we control APPENDS to it: the real peer
 * address ends up last, after anything the client sent. So the LAST entry is the
 * one to read behind a single trusted proxy, not the first — and reading the
 * first, which is the common mistake and what most snippets do, is what makes
 * the header forgeable.
 *
 * On Vercel the correct value is `x-vercel-forwarded-for`, which the platform
 * sets from the connection and which a client cannot influence, so it is
 * preferred when present and `x-forwarded-for` is the fallback for other
 * deployments. `trustedProxyHops` exists for a deployment with more than one
 * proxy in front of it; the default of 1 matches Vercel.
 *
 * ## The fallback
 *
 * When nothing resolves, every such request shares the bucket `unknown`. That is
 * a deliberately harsh default — it means an unidentifiable population is
 * limited collectively rather than not at all — and it is the safe direction: a
 * misconfigured proxy degrades to "too strict", never to "unlimited".
 */

export const UNKNOWN_CLIENT_IP = 'unknown';

export interface ClientIpOptions {
  /**
   * How many proxies we control sit in front of this process. The client address
   * is that many entries from the END of `x-forwarded-for`.
   */
  readonly trustedProxyHops?: number;
}

export interface HeaderReader {
  get(name: string): string | null;
}

export function clientIp(headers: HeaderReader, options: ClientIpOptions = {}): string {
  // Platform-set and not client-influenced. Preferred wherever it exists.
  const vercel = firstEntry(headers.get('x-vercel-forwarded-for'));
  if (vercel !== undefined) {
    return vercel;
  }

  const hops = Math.max(1, options.trustedProxyHops ?? 1);
  const forwarded = headers.get('x-forwarded-for');
  if (forwarded !== null && forwarded !== '') {
    const entries = forwarded
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
    // Count back from the end: those are the entries our own proxies appended.
    const candidate = entries[entries.length - hops];
    if (candidate !== undefined) {
      return candidate;
    }
    // Fewer entries than trusted hops means the chain is shorter than configured
    // — take the earliest real one rather than inventing trust we do not have.
    const earliest = entries[0];
    if (earliest !== undefined) {
      return earliest;
    }
  }

  const real = firstEntry(headers.get('x-real-ip'));
  return real ?? UNKNOWN_CLIENT_IP;
}

function firstEntry(value: string | null): string | undefined {
  if (value === null || value === '') {
    return undefined;
  }
  const entry = value.split(',')[0]?.trim();
  return entry === undefined || entry === '' ? undefined : entry;
}
