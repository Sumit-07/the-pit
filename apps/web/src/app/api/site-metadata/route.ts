/**
 * `POST /api/site-metadata` — what the site says about itself, for the submit
 * form's autofill.
 *
 * `runtime = 'nodejs'` is load-bearing: the guarded fetcher underneath reaches
 * for `node:dns` and `node:https` so it can resolve a hostname once, judge every
 * answer, and then dial the ADDRESS it judged rather than the name. None of that
 * exists on the edge runtime, and a version of it that used `fetch()` would be
 * the DNS-rebinding hole `packages/fetch` was written to close.
 *
 * There is deliberately no `GET`. See `handleSiteMetadata`: a GET that makes an
 * outbound request is a URL anybody can drop into an `<img>` tag and spend our
 * egress from a stranger's browser.
 */

import { siteMetadataDeps } from '@/lib/ingest/metadata-config';
import { handleSiteMetadata } from '@/lib/ingest/site-metadata';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function POST(request: Request): Promise<Response> {
  return handleSiteMetadata(request, siteMetadataDeps());
}
