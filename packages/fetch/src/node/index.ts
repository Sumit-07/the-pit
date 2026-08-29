/**
 * The real resolver and the real socket.
 *
 * Split from the package root so that importing `@the-pit/fetch` never pulls
 * `node:dns` or `node:https` into a bundle, and so the guards in `src/` can be
 * driven by fakes with no network in sight. Everything security-relevant lives
 * on the other side of this boundary; what is here is plumbing, and it is the
 * one place where getting the plumbing wrong would undo a guard — see
 * `transport.ts` on why the `lookup` hook is not optional.
 */

export { createNodeResolver } from './resolver.js';
export { createNodeTransport } from './transport.js';
export { createNodeFetcher, type NodeFetcherOptions } from './fetcher.js';
