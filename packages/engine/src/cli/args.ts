/**
 * Argument parsing for `pnpm engine ...`.
 *
 * Deliberately hand-rolled and deliberately strict. This CLI's flags decide
 * whether a command SPENDS money — `--dry-run` versus `--run` is `01 §4` Step
 * 4's approval gate — and the failure mode of a permissive parser is that a
 * mistyped flag is ignored and the default fires. There is no safe default here,
 * so an unrecognised flag is an error and neither mode is assumed.
 */

/** A parsed command line: the subcommand, its flags, and its positional words. */
export interface ParsedArgs {
  command: string;
  flags: Map<string, string | true>;
  positional: string[];
}

export class UsageError extends Error {
  override readonly name = 'UsageError';
}

/**
 * Parse `<command> [--flag value | --flag=value | --boolean] [positional...]`.
 *
 * A flag whose next token is another flag (or nothing) is a boolean. That is the
 * one ambiguity in this grammar, and it is resolved in the direction that cannot
 * silently swallow the next argument.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (command === undefined || command.startsWith('-')) {
    throw new UsageError('expected a command, e.g. `seed`');
  }

  const flags = new Map<string, string | true>();
  const positional: string[] = [];

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === undefined) continue;

    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }

    const body = token.slice(2);
    const equals = body.indexOf('=');
    if (equals !== -1) {
      flags.set(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }

    const next = rest[index + 1];
    if (next === undefined || next.startsWith('--')) {
      flags.set(body, true);
    } else {
      flags.set(body, next);
      index += 1;
    }
  }

  return { command, flags, positional };
}

/** A flag that must carry a value. Throws rather than defaulting. */
export function requireFlag(args: ParsedArgs, name: string): string {
  const value = args.flags.get(name);
  if (typeof value !== 'string' || value === '') {
    throw new UsageError(`--${name} is required and must have a value`);
  }
  return value;
}

/** An optional string flag. */
export function optionalFlag(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A boolean flag. Present-with-no-value or `--flag=true` both count. */
export function boolFlag(args: ParsedArgs, name: string): boolean {
  const value = args.flags.get(name);
  return value === true || value === 'true';
}

/** An integer flag, or `undefined`. Rejects a non-integer rather than rounding one. */
export function intFlag(args: ParsedArgs, name: string): number | undefined {
  const raw = optionalFlag(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError(`--${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return value;
}

/** Reject anything not in the known set, so a typo cannot fall through to a default. */
export function rejectUnknownFlags(args: ParsedArgs, known: readonly string[]): void {
  const allowed = new Set(known);
  const unknown = [...args.flags.keys()].filter((flag) => !allowed.has(flag));
  if (unknown.length > 0) {
    throw new UsageError(
      `unknown flag(s): ${unknown.map((flag) => `--${flag}`).join(', ')}. Known: ${known.map((flag) => `--${flag}`).join(', ')}`,
    );
  }
}
