/**
 * `DATABASE_URL`, and what happens when it is not set.
 *
 * There is no Postgres provisioned for this project yet (`brief` Part 7 budgets
 * Neon at $19/month; nothing has been created). Everything in this package is
 * therefore built to be verifiable without one, and this module is the seam that
 * makes that true: nothing imports a connection at module scope, so importing
 * `@the-pit/db` — for its schema, its types, or its seed builder — never touches
 * the environment.
 *
 * When the URL IS needed and IS missing, the failure has to be loud and it has to
 * say what to do. A `undefined is not a valid connection string` from deep inside
 * a driver, or worse a silent fallback to `localhost:5432`, both cost the reader
 * the twenty minutes this message saves. `brief` Part 7 puts this app on Vercel
 * behind Neon, where a missing environment variable in one deployment target and
 * not another is an ordinary Tuesday.
 */

/** The one environment variable this package reads. */
export const DATABASE_URL_ENV = 'DATABASE_URL';

/**
 * Thrown by `requireDatabaseUrl` when `DATABASE_URL` is unset, empty, or not a
 * Postgres URL.
 *
 * A named class rather than a bare `Error` so a caller — a health check, a
 * migration runner, the Next.js boot path — can tell "this deployment is not
 * configured" from "the database refused the connection", which are the same
 * symptom and completely different fixes.
 */
export class MissingDatabaseUrlError extends Error {
  override readonly name = 'MissingDatabaseUrlError';

  constructor(message: string) {
    super(message);
  }
}

/** Schemes `postgres` and `postgresql` both address Postgres; drivers accept either. */
const POSTGRES_SCHEMES = ['postgres:', 'postgresql:'];

const HOW_TO_FIX = [
  `Set ${DATABASE_URL_ENV} to the Postgres connection string, e.g.`,
  '  postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=require',
  '',
  'Locally: put it in .env (already git-ignored).',
  'On Vercel: Project Settings -> Environment Variables, for every environment',
  'the deployment runs in (Production, Preview and Development are separate).',
].join('\n');

/**
 * Read `DATABASE_URL`, or throw with a message that names the variable, says what
 * was found instead, and says where to set it.
 *
 * Validated as far as the scheme and nothing further. A URL that parses and names
 * Postgres but points at the wrong host is a mistake this function cannot see and
 * should not pretend to; the value of the check is that it catches the
 * overwhelmingly common failures — unset, empty, a stray quote, someone pasting a
 * `psql` command line or a Neon dashboard URL — at the point of use rather than
 * as a connection timeout thirty seconds later.
 *
 * @param env The environment to read. Defaults to `process.env`; injectable so
 *   the tests never have to mutate the real one.
 */
export function requireDatabaseUrl(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const raw = env[DATABASE_URL_ENV];

  if (raw === undefined) {
    throw new MissingDatabaseUrlError(`${DATABASE_URL_ENV} is not set.\n\n${HOW_TO_FIX}`);
  }

  const value = raw.trim();
  if (value === '') {
    throw new MissingDatabaseUrlError(`${DATABASE_URL_ENV} is set but empty.\n\n${HOW_TO_FIX}`);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new MissingDatabaseUrlError(
      `${DATABASE_URL_ENV} is not a URL: ${JSON.stringify(truncate(value))}\n\n${HOW_TO_FIX}`,
    );
  }

  if (!POSTGRES_SCHEMES.includes(parsed.protocol)) {
    throw new MissingDatabaseUrlError(
      `${DATABASE_URL_ENV} must be a postgres:// or postgresql:// URL, got ${JSON.stringify(parsed.protocol)}.` +
        `\n\n${HOW_TO_FIX}`,
    );
  }

  return value;
}

/**
 * Whether a database is configured, without throwing.
 *
 * The predicate the `describe.skipIf(...)` guards on the integration suites read,
 * and the one a health endpoint reads to report "not configured" rather than
 * crashing the process.
 */
export function hasDatabaseUrl(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  try {
    requireDatabaseUrl(env);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep a malformed value short in the error, and never echo a whole connection
 * string — the message may reach a log, and the password is in the URL.
 */
function truncate(value: string): string {
  const LIMIT = 40;
  return value.length <= LIMIT ? value : `${value.slice(0, LIMIT)}...`;
}
