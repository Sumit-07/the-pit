#!/usr/bin/env node
/**
 * `pnpm engine <command>` — the engine's command line.
 *
 * Six commands: `panel` (the two approval gates), `seed` (with an API key, or
 * through Task 9's file handoff with none), `rank`, `ab`, `report` and `board`
 * (the local preview surface). The dispatch is a table rather than an `if`
 * so a new command is a row here and a module beside `seed.ts`.
 *
 * `main` takes an argv and returns an exit code, and does no process I/O of its
 * own beyond the injected `log`. The bottom of the file is the only place that
 * touches `process`, so the whole surface is testable without spawning anything.
 */

import { pathToFileURL } from 'node:url';

import { abCommand, AB_USAGE } from './ab.js';
import { parseArgs, UsageError } from './args.js';
import { boardCommand, BOARD_USAGE } from './board.js';
import { panelCommand, PANEL_USAGE } from './panel.js';
import { rankCommand, RANK_USAGE } from './rank.js';
import { reportCommand, REPORT_USAGE } from './report.js';
import { makeAnthropicClient, SEED_USAGE, seedCommand } from './seed.js';

const USAGE = `the-pit engine

Commands:
  panel    print / install the jury and customer panel (01 §4 Steps 2-3, the approval gates)
  seed     score a category (01 §4 Steps 4-6), with or without an API key
  rank     recompute ranking.json from results.json (01 §6; spends nothing)
  ab       produce the fix-1.1 A/B and test-retest evidence (SPENDS)
  report   render the Phase 1 report (spends nothing, needs no API key)
  board    serve the seeded boards locally as a preview (brief Part 6; spends nothing)

${PANEL_USAGE}

${SEED_USAGE}

${RANK_USAGE}

${AB_USAGE}

${REPORT_USAGE}

${BOARD_USAGE}`;

/** Dispatch one command line. Returns the exit code; never calls `process.exit`. */
export async function main(argv: readonly string[], log: (line: string) => void = console.log): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    log(USAGE);
    return argv.length === 0 ? 1 : 0;
  }

  try {
    const args = parseArgs(argv);
    switch (args.command) {
      case 'panel':
        return await panelCommand(args, { log });
      case 'seed':
        return await seedCommand(args, { log, makeClient: makeAnthropicClient });
      case 'rank':
        return await rankCommand(args, { log });
      case 'ab':
        return await abCommand(args, { log, makeClient: makeAnthropicClient });
      case 'report':
        return await reportCommand(args, { log });
      case 'board':
        return await boardCommand(args, { log });
      default:
        log(`unknown command ${JSON.stringify(args.command)}\n\n${USAGE}`);
        return 1;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      log(`error: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    // A real failure. Printed with its message rather than a stack, because the
    // messages this engine throws are written for the person reading them —
    // `InsufficientProductsError` names the count, a validator names the field.
    log(`error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

// Entry point. `import.meta.url` rather than `__dirname`: this package is ESM.
// `pathToFileURL` rather than a hand-built `file://` string, which mis-encodes a
// path containing a space or a `#` and would silently make the CLI a no-op.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
