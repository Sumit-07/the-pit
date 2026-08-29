/**
 * The assembled thing a server actually calls.
 *
 * There is no other constructor, and there is no exported escape hatch that
 * fetches without the guards — the whole package is one door, and this is it for
 * anything running on Node.
 */

import { createGuardedFetcher, type GuardedFetcher, type GuardedFetcherOptions } from '../fetch.js';
import { createNodeResolver } from './resolver.js';
import { createNodeTransport } from './transport.js';

export type NodeFetcherOptions = Omit<GuardedFetcherOptions, 'resolver' | 'transport'> &
  Partial<Pick<GuardedFetcherOptions, 'resolver' | 'transport'>>;

/**
 * A fetcher over the system resolver and a real socket, with every cap at its
 * default.
 *
 * The caps are overridable and the seams are injectable, because a caller with a
 * reason to want a smaller budget should not have to reimplement the walk. The
 * ADDRESS rules are not overridable, by anybody, and there is no option for them.
 */
export function createNodeFetcher(options: NodeFetcherOptions = {}): GuardedFetcher {
  return createGuardedFetcher({
    ...options,
    resolver: options.resolver ?? createNodeResolver(),
    transport: options.transport ?? createNodeTransport(),
  });
}
