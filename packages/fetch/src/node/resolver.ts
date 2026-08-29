import { lookup } from 'node:dns/promises';

import type { HostResolver } from '../transport.js';

/**
 * Name resolution through the system resolver, asked ONCE and answered in full.
 *
 * `all: true` is the security-relevant flag. With a single answer, a name with
 * one public and one private address would hand back whichever the resolver felt
 * like, and the check would pass or fail by luck. Every answer comes back, and
 * `fetch.ts` refuses the hop if any of them is private.
 *
 * `verbatim: true` keeps the resolver's own ordering rather than re-sorting
 * v4-before-v6, so the address that gets dialled is the address the check
 * looked at first.
 */
export function createNodeResolver(): HostResolver {
  return {
    async resolve(hostname: string): Promise<readonly string[]> {
      const answers = await lookup(hostname, { all: true, verbatim: true });
      return answers.map((answer) => answer.address);
    },
  };
}
