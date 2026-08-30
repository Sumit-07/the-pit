/**
 * An offline stand-in for `brief §2.5`'s shortener resolution. Not a test file.
 *
 * `SubmissionGuardDeps.resolveUrl` is a required dependency, so every suite that
 * builds those deps needs one, and none of them may open a socket. This supplies
 * the two behaviours the guards actually branch on, and nothing else:
 *
 * - a redirect table, `submitted URL -> destination URL`, which is what a
 *   shortener is from the guards' point of view;
 * - a refusal table, so a suite can make one URL unfetchable and assert the
 *   policy for it.
 *
 * The KEY it produces is the engine's real `normalizeUrl`, applied to whichever
 * URL wins, because that is what `resolveProductUrl` does. Reimplementing the
 * normalization here would let a suite pass against a spelling the real path
 * would never produce.
 *
 * The cross-host rule is reproduced faithfully too: a redirect that stays on the
 * same host does NOT re-key, so a suite cannot accidentally rely on a stability
 * property the real resolver does not have. `calls` counts invocations, which is
 * how the post-payment path proves it resolves nothing at all.
 */

import { normalizeUrl } from '@the-pit/engine';
import type { SubmissionUrlResolution, SubmissionUrlResolver } from '@the-pit/payments';

export interface FakeResolverOptions {
  /** `submitted -> destination`. Either side may be a bare host; both are normalized. */
  readonly redirects?: Readonly<Record<string, string>>;
  /** `submitted -> the reason it is unfetchable`. A rejection, never a fallback. */
  readonly refusals?: Readonly<Record<string, string>>;
  /**
   * `submitted -> why it could not be reached`, for an ordinary host.
   *
   * The availability case: the offline key is used and `url_unresolved` is
   * flagged. This is the timeout policy, and a suite asserts against it.
   */
  readonly unreachable?: Readonly<Record<string, string>>;
}

export interface FakeUrlResolver {
  readonly resolve: SubmissionUrlResolver;
  /** How many times the submission path asked. `0` is a meaningful assertion. */
  readonly calls: string[];
}

/** The host of a normalized key: everything before the first `/`. */
function hostOf(normalizedUrl: string): string {
  return normalizedUrl.split('/')[0] ?? '';
}

export function fakeUrlResolver(options: FakeResolverOptions = {}): FakeUrlResolver {
  const calls: string[] = [];
  const redirects = options.redirects ?? {};
  const refusals = options.refusals ?? {};
  const unreachable = options.unreachable ?? {};

  const resolve: SubmissionUrlResolver = (url: string): Promise<SubmissionUrlResolution> => {
    calls.push(url);

    const refusal = refusals[url];
    if (refusal !== undefined) {
      return Promise.resolve({
        ok: false,
        rejection: { code: 'url_unfetchable', message: 'We could not use that address.', reason: refusal },
      });
    }

    let offline: string;
    try {
      offline = normalizeUrl(url);
    } catch {
      return Promise.resolve({
        ok: false,
        rejection: { code: 'invalid_url', message: "That does not look like a web address." },
      });
    }

    const down = unreachable[url];
    if (down !== undefined) {
      return Promise.resolve({ ok: true, resolved: { normalizedUrl: offline, flags: ['url_unresolved'] } });
    }

    const destination = redirects[url];
    if (destination === undefined) {
      return Promise.resolve({ ok: true, resolved: { normalizedUrl: offline, flags: [] } });
    }

    const target = normalizeUrl(destination);
    // Same host is a site tidying its own path, not a pointer at another product.
    if (hostOf(target) === hostOf(offline)) {
      return Promise.resolve({ ok: true, resolved: { normalizedUrl: offline, flags: [] } });
    }
    return Promise.resolve({ ok: true, resolved: { normalizedUrl: target, flags: ['url_redirected'] } });
  };

  return { resolve, calls };
}

/** The common case: no redirects, no refusals, the offline key every time. */
export function passthroughUrlResolver(): SubmissionUrlResolver {
  return fakeUrlResolver().resolve;
}
