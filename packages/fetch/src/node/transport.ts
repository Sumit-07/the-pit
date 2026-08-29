/**
 * The socket, pinned to an address that has already been judged.
 *
 * ## The one thing this file must get right
 *
 * `fetch.ts` resolves a hostname and checks every answer. If this transport then
 * handed the same hostname to `https.request` and let Node resolve it again, the
 * second answer would be free to differ from the checked one — that is DNS
 * rebinding, and it is the reason a fetcher that "validates the host first" is
 * usually still vulnerable.
 *
 * So the connection is pinned through Node's `lookup` hook, which is the
 * supported seam for exactly this: the request is made to the hostname (so the
 * `Host` header and the TLS SNI/certificate check are correct, and a virtual
 * host serves the right site), but the resolution step is replaced by a constant
 * — the address `fetch.ts` already approved. One resolution, one check, one
 * connection, to the address that was checked.
 *
 * ## The rest
 *
 * - `identity` encoding, requested in `fetch.ts`: a compressed body would make
 *   the byte cap a cap on COMPRESSED bytes, and a few hundred kilobytes of gzip
 *   expands to a decompression bomb.
 * - `read(limit)` destroys the socket the moment the limit is reached. The cap
 *   bounds what crosses the network, not just what is returned.
 * - Redirects are NOT followed here. `fetch.ts` follows them so that every hop
 *   goes back through the address check; a transport that followed its own
 *   redirects would skip every guard after the first.
 */

import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';

import type { Transport, TransportRequest, TransportResponse } from '../transport.js';

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address?: string | readonly { readonly address: string; readonly family: number }[],
  family?: number,
) => void;

function pinnedLookup(request: TransportRequest) {
  return (_hostname: string, options: { readonly all?: boolean }, callback: LookupCallback): void => {
    if (options.all === true) {
      callback(null, [{ address: request.address, family: request.family }]);
      return;
    }
    callback(null, request.address, request.family);
  };
}

function flattenHeaders(message: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(message.headers)) {
    if (value === undefined) continue;
    // `set-cookie` is the one header Node keeps as an array by contract, and it
    // is also the one header this fetcher has no business carrying anywhere.
    if (name === 'set-cookie') continue;
    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

export function createNodeTransport(): Transport {
  return {
    send(request: TransportRequest): Promise<TransportResponse> {
      const target = new URL(request.url);
      const client = request.protocol === 'https:' ? https : http;

      return new Promise<TransportResponse>((resolve, reject) => {
        const outgoing = client.request(
          {
            protocol: request.protocol,
            hostname: request.hostname,
            port: request.port,
            path: `${target.pathname}${target.search}`,
            method: 'GET',
            headers: { ...request.headers, host: target.host },
            signal: request.signal,
            // See the module header: this is the DNS-rebinding guard.
            lookup: pinnedLookup(request) as unknown as undefined,
            // The certificate is still checked against the hostname, not the
            // pinned address — pinning changes where we dial, never who we trust.
            ...(request.protocol === 'https:' ? { servername: request.hostname } : {}),
          },
          (incoming) => {
            let settled = false;
            const response: TransportResponse = {
              status: incoming.statusCode ?? 0,
              headers: flattenHeaders(incoming),
              read(limit: number) {
                return new Promise<{ bytes: Uint8Array; truncated: boolean }>((done, fail) => {
                  const chunks: Buffer[] = [];
                  let size = 0;
                  let truncated = false;
                  const finish = (): void => {
                    if (settled) return;
                    settled = true;
                    done({ bytes: new Uint8Array(Buffer.concat(chunks, Math.min(size, limit))), truncated });
                  };
                  incoming.on('data', (chunk: Buffer) => {
                    if (settled) return;
                    const room = limit - size;
                    if (chunk.length >= room) {
                      chunks.push(chunk.subarray(0, room));
                      size = limit;
                      truncated = chunk.length > room || !incoming.readableEnded;
                      // Past the cap nothing more is pulled off the socket.
                      incoming.destroy();
                      outgoing.destroy();
                      finish();
                      return;
                    }
                    chunks.push(chunk);
                    size += chunk.length;
                  });
                  incoming.on('end', finish);
                  incoming.on('error', (error) => {
                    if (settled) return;
                    settled = true;
                    fail(error);
                  });
                });
              },
              discard(): void {
                settled = true;
                incoming.resume();
                incoming.destroy();
                outgoing.destroy();
              },
            };
            resolve(response);
          },
        );

        outgoing.on('error', reject);
        outgoing.end();
      });
    },
  };
}
