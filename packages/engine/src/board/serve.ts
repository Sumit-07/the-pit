/**
 * `pnpm engine board` — a local preview server for the seeded boards.
 *
 * A read-only surface over `cjr/runs/<slug>/ranking.json`. It has no database, no
 * build step and no dependencies beyond Node's own `http`, and it holds nothing
 * in memory between requests: every `GET /` re-reads the run directory from disk,
 * so `engine rank` in another terminal shows up on a refresh. That is deliberate
 * — `01 §2` makes the ranking recomputable offline, and a preview that cached its
 * boards would quietly show you the previous answer while you were checking a fix.
 *
 * Scope is `brief` Part 6's **category board** and nothing else: no submission, no
 * payment, no auth, no verdict page. Those are later phases.
 *
 * ## What it refuses to crash on
 *
 * A category with no `ranking.json` is **omitted**, not fatal. A ranking is only
 * written for a DELIVERED run (`brief §2.3`), so a run directory holding only
 * `products.json` is a normal mid-pipeline state, and a preview server that died
 * on it would be unusable exactly when someone is seeding. The same goes for a
 * malformed document and for a `results.json` that is missing or unreadable — the
 * board renders, the caveat block says the provenance is unknown.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { Ranking } from '../types.js';
import type { RunResults } from '../run/types.js';
import { toBoard, type Board, type BoardPayload } from './model.js';
import { renderPage } from './page.js';

/** Port `brief` has no opinion about, so: one nobody else is on. */
export const DEFAULT_BOARD_PORT = 8765;

async function readJsonFile(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    // Missing, unreadable or malformed all mean the same thing to a preview: the
    // caller decides whether that omits a board or just its provenance line.
    return undefined;
  }
}

/** The shape check `01 §6.6` earns: enough to render, no more. */
function isRanking(value: unknown): value is Ranking {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<Ranking>;
  return (
    Array.isArray(candidate.ranking) &&
    Array.isArray(candidate.metrics) &&
    Array.isArray(candidate.clusters) &&
    Array.isArray(candidate.personas) &&
    typeof candidate.category === 'string' &&
    candidate.health !== undefined &&
    candidate.weights !== undefined
  );
}

/**
 * Read every board under `<workdir>/runs/`.
 *
 * Returns the boards that could be read and the slugs that could not, so the
 * caller can say what it skipped rather than silently showing a short board.
 */
export async function loadBoards(workdir: string): Promise<{ payload: BoardPayload; skipped: string[] }> {
  const runsDir = join(workdir, 'runs');
  let entries: string[];
  try {
    entries = (await readdir(runsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return { payload: { boards: [], readAt: new Date().toISOString() }, skipped: [] };
  }

  const boards: Board[] = [];
  const skipped: string[] = [];

  for (const slug of entries) {
    const rankingPath = join(runsDir, slug, 'ranking.json');
    const raw = await readJsonFile(rankingPath);
    if (!isRanking(raw)) {
      skipped.push(slug);
      continue;
    }

    let rankedAt = new Date().toISOString();
    try {
      rankedAt = (await stat(rankingPath)).mtime.toISOString();
    } catch {
      // Keep the render-time stamp; the footer still carries a time.
    }

    // The provenance caveat lives in `results.json`, not in the ranking. It is
    // read here rather than copied into `ranking.json` so the board can never
    // show a caveat the run does not actually carry.
    const results = (await readJsonFile(join(runsDir, slug, 'results.json'))) as Partial<RunResults> | undefined;
    const caveat = results?.meta?.seeding?.caveat;

    boards.push(toBoard(slug, raw, { rankedAt, ...(typeof caveat === 'string' ? { caveat } : {}) }));
  }

  return { payload: { boards, readAt: new Date().toISOString() }, skipped };
}

export interface BoardServerOptions {
  workdir: string;
  port?: number;
  host?: string;
  log?: (line: string) => void;
}

function send(response: ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    // A preview whose whole point is that a re-rank shows up on refresh must not
    // be cached by anything, least of all by the browser in front of it.
    'cache-control': 'no-store',
  });
  response.end(body);
}

/** Build the request handler. Exported so it can be exercised without a socket. */
export function boardHandler(options: BoardServerOptions) {
  const log = options.log ?? (() => {});

  return async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = (request.url ?? '/').split('?')[0] ?? '/';

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(response, 405, 'text/plain; charset=utf-8', 'GET only.\n');
      return;
    }

    try {
      if (path === '/' || path === '/index.html') {
        const { payload, skipped } = await loadBoards(options.workdir);
        if (skipped.length > 0) log(`  (no readable ranking.json in: ${skipped.join(', ')} — omitted)`);
        send(response, 200, 'text/html; charset=utf-8', renderPage(payload));
        return;
      }

      if (path === '/board.json') {
        const { payload } = await loadBoards(options.workdir);
        send(response, 200, 'application/json; charset=utf-8', JSON.stringify(payload, null, 2));
        return;
      }

      if (path === '/favicon.ico') {
        response.writeHead(204).end();
        return;
      }

      send(response, 404, 'text/plain; charset=utf-8', 'Not here. The board is at /.\n');
    } catch (error) {
      log(`error serving ${path}: ${error instanceof Error ? error.message : String(error)}`);
      send(response, 500, 'text/plain; charset=utf-8', 'The board could not be read. See the server log.\n');
    }
  };
}

/**
 * Start the preview server and resolve once it is listening.
 *
 * The caller owns the returned server, and therefore owns shutting it down; this
 * function installs no signal handlers of its own.
 */
export async function startBoardServer(options: BoardServerOptions): Promise<Server> {
  const handle = boardHandler(options);
  const server = createServer((request, response) => {
    void handle(request, response);
  });

  const port = options.port ?? DEFAULT_BOARD_PORT;
  const host = options.host ?? '127.0.0.1';

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  return server;
}
