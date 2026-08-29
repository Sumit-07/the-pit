/**
 * `pnpm engine board` — serve the seeded boards locally. `brief` Part 6.
 *
 * A preview surface, not a product: it reads `ranking.json` off disk on every
 * request, renders one self-contained page, and spends nothing. Like `rank` and
 * `report` it constructs no `ModelClient` and needs no API key.
 *
 * The command does not return while the server is up. It resolves on SIGINT or
 * SIGTERM, which is how a person stops it, and returns 0 for a clean stop.
 */

import type { Server } from 'node:http';

import { DEFAULT_WORKDIR } from '../run/store.js';
import { DEFAULT_BOARD_PORT, loadBoards, startBoardServer } from '../board/serve.js';
import { intFlag, optionalFlag, rejectUnknownFlags, type ParsedArgs } from './args.js';

const BOARD_FLAGS = ['port', 'workdir', 'host'];

export const BOARD_USAGE = `Usage:
  engine board [--port ${DEFAULT_BOARD_PORT}] [--workdir ${DEFAULT_WORKDIR}] [--host 127.0.0.1]

Serves a local preview of every <workdir>/runs/*/ranking.json as a category board
(brief Part 6). Files are re-read on every request, so a re-rank appears on refresh
with no restart. A category with no readable ranking.json is omitted, not fatal.
Spends nothing and needs no API key. Ctrl-C to stop.`;

export interface BoardDeps {
  log: (line: string) => void;
  /** Overridable so a test can drive the lifecycle without signals. */
  waitForStop?: (server: Server) => Promise<void>;
}

/** Resolve when the process is asked to stop, or when the server closes on its own. */
function defaultWaitForStop(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
      server.close(() => resolve());
      // `close` waits for open connections; a keep-alive browser tab would hold
      // the process forever, so idle sockets are dropped rather than awaited.
      server.closeIdleConnections();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    server.once('close', () => resolve());
  });
}

/** Run the `board` command. Returns a process exit code. */
export async function boardCommand(args: ParsedArgs, deps: BoardDeps): Promise<number> {
  rejectUnknownFlags(args, BOARD_FLAGS);

  const workdir = optionalFlag(args, 'workdir') ?? DEFAULT_WORKDIR;
  const port = intFlag(args, 'port') ?? DEFAULT_BOARD_PORT;
  const host = optionalFlag(args, 'host') ?? '127.0.0.1';

  // Read once before listening, purely so the startup log can say what is there.
  // The served page does its own read; nothing from here is cached into it.
  const { payload, skipped } = await loadBoards(workdir);

  const server = await startBoardServer({ workdir, port, host, log: deps.log });

  deps.log(
    [
      `THE PIT — board preview on http://${host}:${port}`,
      '',
      ...(payload.boards.length === 0
        ? [`  no ranking.json under ${workdir}/runs — the page will say so`]
        : payload.boards.map(
            (board) =>
              `  ${board.category} — ${board.productCount} products, ` +
              `${board.soloCount} solo cluster, ${board.tiebrokenCount} moved by demand` +
              `  http://${host}:${port}/#${board.slug}`,
          )),
      ...(skipped.length === 0 ? [] : ['', `  omitted (no readable ranking.json): ${skipped.join(', ')}`]),
      '',
      `  ranking.json is re-read on every request — re-rank, then refresh.`,
      '  Ctrl-C to stop.',
    ].join('\n'),
  );

  await (deps.waitForStop ?? defaultWaitForStop)(server);
  deps.log('board preview stopped.');
  return 0;
}
