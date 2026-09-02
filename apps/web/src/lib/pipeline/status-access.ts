/**
 * Who is allowed to watch a run.
 *
 * ## The signed link, and why it is not a session
 *
 * `brief §2.1` is guest checkout. The person refreshing this page is on a phone,
 * has no cookie, has never logged in, and has no account until the Dodo webhook
 * resolves one from the address Dodo verified — which may not have happened yet.
 * `submissions` carries no account id, so there is nothing on the row to compare
 * a session against even once an account exists. A session gate here would lock
 * out every buyer at the exact moment the page is for.
 *
 * So the gate is a signature over the submission id, minted server-side at the
 * moment the submission was created and carried home on the Dodo return URL.
 * `@the-pit/auth`'s `mintRunStatusToken` is the only thing that makes one, and it
 * runs in one place: beside the `submissions` insert, before the buyer leaves.
 *
 * ## The submission id alone is not the gate
 *
 * It travels through Dodo's metadata, through webhook payloads, and through
 * whatever logs sit under both. Treating "knows the id" as "may read the run"
 * would make every one of those surfaces a way into a stranger's page. The
 * signature is ours and cannot be produced anywhere else.
 *
 * ## A refusal is a 404
 *
 * Not a 403. Telling somebody holding a guessed id that it was a real submission
 * is free reconnaissance, and it is the same posture `capabilityRejectedPage` and
 * `verifyRejectedPage` already take.
 */

import { verifyRunStatusToken, type SessionKeyring } from '@the-pit/auth';

import { sessionKeyring } from '@/lib/auth/config';

/**
 * The keyring, or nothing.
 *
 * `sessionKeyring()` throws when `SESSION_SECRET` is unset. Here that is not an
 * error to surface: with no secret nobody holds a valid token, so nobody may
 * read a run, and the page 404s. Swallowed at this seam rather than in the route,
 * so the "is this an error?" judgement is made once.
 */
function keyringOrNone(): SessionKeyring | undefined {
  try {
    return sessionKeyring();
  } catch {
    return undefined;
  }
}

/** May this request read this submission's run? */
export function mayReadRunStatus(
  submissionId: string,
  token: string | undefined,
  keyring: SessionKeyring | undefined = keyringOrNone(),
): boolean {
  if (keyring === undefined) return false;
  return verifyRunStatusToken(submissionId, token, keyring);
}
