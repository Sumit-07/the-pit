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
 *
 * ## But they are resolved behind the gate, not in front of it
 *
 * They used to be called here, eagerly, which meant a logged-out visitor to a
 * deployment with no `DATABASE_URL` got a 500 rather than the 401 page that
 * names the three doors. `handleAccountPage` promised in its own header that the
 * signed-out path touches no store; that was true of the handler and false of
 * this function, which resolved both of them before the handler had read the
 * cookie. So `stores` is a thunk, called only after a session verifies.
 *
 * The keyring is NOT deferred, and that is deliberate. It is the gate itself:
 * without `SESSION_SECRET` no cookie can be verified, and answering 401 to a
 * customer holding a perfectly good session because a secret went missing would
 * silently sign out everybody, which is a worse failure than a loud one.
 * `MissingSessionSecretError` is a secret, not a database handle, and it is
 * still raised on the first request.
 */

import { capabilityDeps, secureCookies, sessionKeyring } from '@/lib/auth/config';
import type { AccountHandlerDeps, AccountStores } from '@/lib/account/handlers';
import { accountStore } from '@/lib/payments/config';

export function accountDeps(): AccountHandlerDeps {
  return {
    keyring: sessionKeyring(),
    secureCookies: secureCookies(),
    stores: (): AccountStores => {
      // Resolved from `capabilityDeps()` and not from a third set of variables,
      // so the slug this page displays is the slug `/a/<slug>` resolves and
      // `POST /auth/capability/rotate` replaces. See the header.
      const capability = capabilityDeps();
      return {
        origin: capability.origin,
        identities: capability.capability.store,
        reads: accountStore(),
      };
    },
  };
}
