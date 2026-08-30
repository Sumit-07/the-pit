/**
 * The fake network the whole suite runs on.
 *
 * No test in this package touches a socket. That is not only about speed: the
 * guards being tested fire on responses no real server would send on demand — a
 * 302 to `169.254.169.254`, a 700 KB body, a `text/plain` homepage, a chain of
 * six redirects — and the only way to prove a guard fires is to be able to
 * produce the thing it guards against.
 *
 * Both fakes RECORD as well as answer, because most of these guards are claims
 * about what did NOT happen: the resolver was consulted once, the transport was
 * never dialled, the body was never read.
 */

import type { HostResolver, Transport, TransportRequest, TransportResponse } from '../../src/transport.js';

export interface FakeResponseSpec {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /**
   * A binary body, for the asset path. Takes precedence over `body`.
   *
   * `body` is encoded as UTF-8, which mangles every byte over 0x7f — so a PNG
   * signature written as a string is not a PNG signature. An image fake has to
   * be able to hand over the bytes it means.
   */
  readonly bytes?: Uint8Array;
  /** Bytes handed over per chunk, so a test can watch the byte cap stop the stream mid-body. */
  readonly chunkSize?: number;
  /** Reject instead of answering, to exercise the transport-error and abort paths. */
  readonly error?: Error;
}

export interface RecordedResponse {
  readonly url: string;
  /** True once `read` was called. A content-type refusal must leave this false. */
  bodyRead: boolean;
  /** True once `discard` was called. */
  discarded: boolean;
  /** The limit `read` was given. */
  readLimit: number | null;
  /** Chunks the fake actually produced. Fewer than the body holds means the cap stopped it. */
  chunksProduced: number;
}

/**
 * A resolver over a fixed table.
 *
 * `answers` may be a list (the same answer every time) or a list of lists (a
 * different answer per call, which is how the rebinding test proves the second
 * answer is never asked for).
 */
export class FakeResolver implements HostResolver {
  readonly calls: string[] = [];
  private readonly table: Map<string, readonly (readonly string[])[]>;

  constructor(table: Readonly<Record<string, readonly string[] | readonly (readonly string[])[]>>) {
    this.table = new Map(
      Object.entries(table).map(([host, value]) => [
        host.toLowerCase(),
        (Array.isArray(value[0]) ? value : [value]) as readonly (readonly string[])[],
      ]),
    );
  }

  resolve(hostname: string): Promise<readonly string[]> {
    this.calls.push(hostname);
    const answers = this.table.get(hostname.toLowerCase());
    if (answers === undefined) {
      const error: NodeJS.ErrnoException = new Error(`getaddrinfo ENOTFOUND ${hostname}`);
      error.code = 'ENOTFOUND';
      return Promise.reject(error);
    }
    const priorCallsForHost = this.calls.filter((call) => call.toLowerCase() === hostname.toLowerCase()).length - 1;
    return Promise.resolve(answers[Math.min(priorCallsForHost, answers.length - 1)] ?? []);
  }
}

const encoder = new TextEncoder();

export class FakeTransport implements Transport {
  readonly requests: TransportRequest[] = [];
  readonly responses: RecordedResponse[] = [];
  private readonly routes = new Map<string, FakeResponseSpec>();
  private fallback: FakeResponseSpec | null = null;

  /** Route by exact URL, as `URL` normalizes it. */
  route(url: string, spec: FakeResponseSpec): this {
    this.routes.set(new URL(url).href, spec);
    return this;
  }

  /** Answer anything unrouted. Without one, an unrouted URL is a test bug and throws. */
  otherwise(spec: FakeResponseSpec): this {
    this.fallback = spec;
    return this;
  }

  /** Every address the transport was actually asked to dial, in order. */
  get dialled(): string[] {
    return this.requests.map((request) => request.address);
  }

  send(request: TransportRequest): Promise<TransportResponse> {
    this.requests.push(request);
    const spec = this.routes.get(new URL(request.url).href) ?? this.fallback;
    if (spec === undefined || spec === null) {
      throw new Error(`FakeTransport: no route for ${request.url}`);
    }
    if (spec.error !== undefined) {
      return Promise.reject(spec.error);
    }

    const record: RecordedResponse = {
      url: request.url,
      bodyRead: false,
      discarded: false,
      readLimit: null,
      chunksProduced: 0,
    };
    this.responses.push(record);

    const bytes = spec.bytes ?? encoder.encode(spec.body ?? '');
    const chunkSize = spec.chunkSize ?? Math.max(bytes.byteLength, 1);

    return Promise.resolve({
      status: spec.status ?? 200,
      headers: lowercase(spec.headers ?? {}),
      read(limit: number) {
        record.bodyRead = true;
        record.readLimit = limit;
        // Chunked deliberately: the byte cap is a claim about how much comes off
        // the wire, so the fake stops producing when the caller stops taking,
        // and `chunksProduced` is what a test asserts against.
        const kept: number[] = [];
        for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
          if (kept.length >= limit) break;
          record.chunksProduced += 1;
          for (const byte of bytes.subarray(offset, offset + chunkSize)) {
            if (kept.length >= limit) break;
            kept.push(byte);
          }
        }
        return Promise.resolve({ bytes: Uint8Array.from(kept), truncated: kept.length < bytes.byteLength });
      },
      discard() {
        record.discarded = true;
      },
    });
  }
}

function lowercase(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

/** A 3xx to `location`. */
export function redirectTo(location: string, status = 302): FakeResponseSpec {
  return { status, headers: { location } };
}

/** A 200 of `contentType` carrying raw `bytes`. The asset path's counterpart to `htmlPage`. */
export function binaryBody(contentType: string, bytes: Uint8Array, chunkSize?: number): FakeResponseSpec {
  return {
    status: 200,
    headers: { 'content-type': contentType },
    ...(chunkSize === undefined ? {} : { chunkSize }),
    bytes,
  };
}

/** A 200 `text/html` carrying `body`. */
export function htmlPage(body: string, chunkSize?: number): FakeResponseSpec {
  return {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    ...(chunkSize === undefined ? {} : { chunkSize }),
    body,
  };
}

/** A clock that only moves when a test moves it. */
export function fakeClock(startMs = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}
