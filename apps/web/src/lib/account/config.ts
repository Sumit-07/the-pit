/**
 * Where `/account` gets its dependencies at runtime.
 *
 * Deliberately assembled from two existing resolvers rather than from a third
 * set of environment variables:
 *
 * - `capabilityDeps()` (`lib/auth/config.ts`) already resolves the identity
 *   store, the session keyring, the cookie policy and the origin. Reading them
 *   from there is what makes the slug this page displays the same slug
 *   `/a/<slug>` resolves and `POST /auth/capability/rotate` replaces. A second
 *   resolver would be a second answer to "which slug is live", and the two would
 *   disagree on the day one of them was changed.
 * - `accountStore()` (`lib/payments/config.ts`) is the money side, over the same
 *   pooled connection the webhook writes through.
 *
 * Both throw when the environment cannot be bound, and the route lets them: a
 * private page that rendered an empty balance because a store was missing would
 * be indistinguishable, to the customer, from a balance of zero.
 */

import { capabilityDeps } from '@/lib/auth/config';
import type { AccountHandlerDeps } from '@/lib/account/handlers';
import { accountStore } from '@/lib/payments/config';

export function accountDeps(): AccountHandlerDeps {
  const capability = capabilityDeps();
  return {
    origin: capability.origin,
    keyring: capability.capability.keyring,
    secureCookies: capability.capability.secureCookies,
    identities: capability.capability.store,
    reads: accountStore(),
  };
}
