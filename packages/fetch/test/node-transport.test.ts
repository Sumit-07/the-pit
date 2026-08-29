/**
 * The one file whose subject is a real socket.
 *
 * Everything else in this suite drives fakes, which proves the guards fire but
 * cannot prove that the real transport HONOURS them: `node/transport.ts` is the
 * only place where a mistake would let Node resolve the hostname a second time
 * and dial an address nobody checked. So this file uses a loopback server —
 * still offline, nothing leaves the machine — and asks the two questions the
 * fakes cannot:
 *
 * 1. Does the transport dial the address it was handed, ignoring what the
 *    hostname would resolve to?
 * 2. Does the assembled `createNodeFetcher` still refuse loopback, with a real
 *    server sitting there answering?
 */

import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createNodeFetcher, createNodeTransport } from '../src/node/index.js';

let server: Server;
let port: number;
const seenHostHeaders: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    seenHostHeaders.push(request.headers.host ?? '');
    if (request.url === '/big') {
      response.writeHead(200, { 'content-type': 'text/html' });
      // Far more than any cap under test, written in one go.
      response.end('<title>Big</title>'.padEnd(400_000, 'x'));
      return;
    }
    if (request.url === '/moved') {
      response.writeHead(302, { location: '/landing' });
      response.end('ignored body');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<html><head><title>Loopback</title></head></html>');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  port = typeof address === 'object' && address !== null ? address.port : 0;
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
});

describe('createNodeTransport', () => {
  it('dials the address it was given and sends the hostname it was given', async () => {
    // `not-a-real-host.invalid` cannot resolve — `.invalid` is reserved by RFC
    // 2606 precisely so that it never will. If the transport resolved the
    // hostname instead of using `address`, this could not connect at all; and
    // the `Host` header proves the name still travels, so a virtual host serves
    // the right site and TLS would check the right certificate.
    const response = await createNodeTransport().send({
      url: `http://not-a-real-host.invalid:${port}/`,
      hostname: 'not-a-real-host.invalid',
      port,
      protocol: 'http:',
      address: '127.0.0.1',
      family: 4,
      headers: { 'user-agent': 'test' },
      signal: AbortSignal.timeout(5_000),
    });

    expect(response.status).toBe(200);
    const body = await response.read(64 * 1024);
    expect(new TextDecoder().decode(body.bytes)).toContain('Loopback');
    expect(seenHostHeaders.at(-1)).toBe(`not-a-real-host.invalid:${port}`);
  });

  it('stops at the byte cap rather than buffering the whole response', async () => {
    const response = await createNodeTransport().send({
      url: `http://not-a-real-host.invalid:${port}/big`,
      hostname: 'not-a-real-host.invalid',
      port,
      protocol: 'http:',
      address: '127.0.0.1',
      family: 4,
      headers: {},
      signal: AbortSignal.timeout(5_000),
    });

    const body = await response.read(1_024);

    expect(body.bytes.byteLength).toBe(1_024);
    expect(body.truncated).toBe(true);
  });

  it('does not follow redirects itself — following them is the guard loop’s job', async () => {
    // A transport that followed its own redirects would skip the address check
    // on every hop after the first, which is the whole vulnerability.
    const response = await createNodeTransport().send({
      url: `http://not-a-real-host.invalid:${port}/moved`,
      hostname: 'not-a-real-host.invalid',
      port,
      protocol: 'http:',
      address: '127.0.0.1',
      family: 4,
      headers: {},
      signal: AbortSignal.timeout(5_000),
    });

    expect(response.status).toBe(302);
    expect(response.headers['location']).toBe('/landing');
    response.discard();
  });
});

describe('createNodeFetcher', () => {
  it('refuses loopback with a real server answering on it', async () => {
    // End to end, over a real socket, with a live server: the address rule is
    // the thing that stops it, and there is no assembly of the real parts that
    // reaches 127.0.0.1.
    const fetcher = createNodeFetcher({ allowedPorts: [port], timeoutMs: 3_000 });

    const result = await fetcher.fetchDocument(`http://127.0.0.1:${port}/`);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.refusal.code).toBe('blocked_address');
      expect(result.refusal.reason).toMatch(/loopback, 127\.0\.0\.0\/8/);
    }
  });

  it('refuses localhost by the address it resolves to, not by its name', async () => {
    const fetcher = createNodeFetcher({ allowedPorts: [port], timeoutMs: 3_000 });

    const result = await fetcher.fetchDocument(`http://localhost:${port}/`);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.refusal.code).toBe('blocked_address');
  });
});
