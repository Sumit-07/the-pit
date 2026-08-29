/**
 * The two seams the fetcher is built on: name resolution and the socket.
 *
 * They are interfaces rather than direct calls to `node:dns` and `node:https`
 * for two reasons, and only one of them is testing.
 *
 * The first is the DNS-rebinding guard. If the fetcher called `fetch(url)` it
 * would hand the hostname to the network stack, which would resolve it a SECOND
 * time — and the second answer is free to differ from the one that passed the
 * address check. So resolution and connection are separated: `HostResolver`
 * answers once, `fetch.ts` judges that answer, and `Transport` is handed the
 * validated ADDRESS to connect to. A transport that re-resolves `request.url`
 * instead of dialling `request.address` reopens the hole; `node/transport.ts`
 * pins it through the `lookup` hook for exactly that reason.
 *
 * The second is that this makes every guard testable with no network at all. A
 * fake resolver and a fake transport can produce a redirect to the cloud
 * metadata address, a 4 GB body, or a `text/plain` response on demand, which is
 * the only way to prove the guards fire.
 */

/** Resolves a hostname to the addresses it currently points at. Called ONCE per hop. */
export interface HostResolver {
  /**
   * Every address for `hostname`, as text. An empty array and a rejection are
   * both `dns_failure`; neither is a reason to proceed.
   */
  resolve(hostname: string): Promise<readonly string[]>;
}

export interface TransportRequest {
  /** The full URL, used for the request line, the `Host` header and TLS SNI. */
  readonly url: string;
  readonly hostname: string;
  readonly port: number;
  readonly protocol: 'http:' | 'https:';
  /** The validated IP to dial. A transport MUST connect to this, not re-resolve `hostname`. */
  readonly address: string;
  readonly family: 4 | 6;
  readonly headers: Readonly<Record<string, string>>;
  /** Fires when the wall-clock budget expires. A transport must abandon the request. */
  readonly signal: AbortSignal;
}

export interface TransportResponse {
  readonly status: number;
  /** Header names lowercased. A repeated header is joined, `set-cookie` excepted and ignored. */
  readonly headers: Readonly<Record<string, string>>;
  /**
   * Read at most `limit` bytes of the body, then stop pulling from the socket.
   *
   * `truncated` says the body had more to give. An implementation must not
   * buffer the whole response and slice it — the cap exists to bound memory, not
   * just the return value.
   */
  read(limit: number): Promise<{ readonly bytes: Uint8Array; readonly truncated: boolean }>;
  /** Abandon the body unread. Called for every redirect hop and every refusal. */
  discard(): void;
}

export interface Transport {
  send(request: TransportRequest): Promise<TransportResponse>;
}
