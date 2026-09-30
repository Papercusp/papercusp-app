#!/usr/bin/env node
/**
 * pg-url (CLI) — the gated Postgres DSN for a SHELL caller.
 *
 * ## The gap this closes (EI-20478658560683440, measured 2026-08-18)
 *
 * Every JS consumer on this box resolves Postgres through one liveness-gated chain
 * (`scripts/lib/pg-url.mjs` → `getHarnessAdminUrlWithSource()` → the generic resolver's
 * pid + listening-port gates). A SHELL caller had no entry to that chain at all — the
 * whole surface was JS-only — so an agent that needed to MUTATE the database (which
 * `dev:pg_query` cannot do: it runs read-only) reached for the one thing a shell can
 * read, `$PAPERCUSP_HOME/embedded-pg.json`, and pasted its `url` into psql.
 *
 * That file is written once at boot and is never cleaned up on an unclean exit, so
 * existence is not liveness. The live instance of it on this box was 15 days stale: its
 * pid (1471022) was long dead and nothing was listening on its port (19838), while the
 * gated chain — reading the very same file — correctly rejected it and resolved to the
 * native :5432 that was actually serving. The shell caller got ECONNREFUSED; every JS
 * caller was fine. The bug was never in the resolver. It was that the resolver had no
 * door a shell could open.
 *
 * ## Credential safety — why `--export` exists and why it is the one to reach for
 *
 * The obvious idiom puts the password in the process table:
 *
 *     psql "$(node scripts/pg-url.mjs)"        # DSN visible in `ps` to every agent
 *
 * This box runs ~100 concurrent agents sharing one process namespace, so that argv is
 * readable by all of them. `--export` emits libpq environment variables instead, which
 * psql reads without any of them appearing in argv:
 *
 *     eval "$(node scripts/pg-url.mjs --export)" && psql -c 'UPDATE …'
 *
 * `--describe` prints provenance only and NEVER prints credentials — safe for logs, error
 * output, and pasting into a work-item.
 *
 * ## Liveness is VERIFIED, not inferred (default; `--no-verify` opts out)
 *
 * The gates inside the resolver are synchronous by contract — a pid probe and a
 * /proc/net/tcp LISTEN scan — because `resolvePgUrl` is called per query and cannot await.
 * A CLI has no such constraint and runs once, so it does the definitive check the library
 * cannot: it actually connects and runs `SELECT 1`. A LISTEN socket proves something is
 * bound to the port; it does not prove that something is the Postgres you can log into.
 * On failure this exits non-zero with the provenance line, so a dead target is a loud
 * error at resolution time rather than a DSN that refuses later inside someone's psql.
 *
 * ## Usage
 *
 *   node scripts/pg-url.mjs                 # DSN on stdout, provenance on stderr
 *   node scripts/pg-url.mjs --export        # `export PG…=…` lines for eval (no argv leak)
 *   node scripts/pg-url.mjs --describe      # provenance only, never credentials
 *   node scripts/pg-url.mjs --no-verify     # skip the connect (pg unavailable / speed)
 *
 * Exit codes: 0 resolved (and verified, unless --no-verify) · 1 resolved but NOT reachable
 * · 2 bad usage.
 */
import { describePgUrlResolution, resolveScriptPgUrl } from './lib/pg-url.mjs';

/** libpq env var per URL part. PGPASSWORD is what keeps the secret out of argv. */
const LIBPQ = [
  ['PGHOST', (u) => u.hostname],
  ['PGPORT', (u) => u.port || '5432'],
  ['PGUSER', (u) => decodeURIComponent(u.username)],
  ['PGPASSWORD', (u) => decodeURIComponent(u.password)],
  ['PGDATABASE', (u) => u.pathname.replace(/^\//, '')],
];

/**
 * Parse argv. Unknown flags are a hard error rather than a silent ignore: a typo'd
 * `--describe` that falls through to the default would print the CREDENTIALS to a place
 * the caller believed was redacted.
 *
 * @param {string[]} argv
 * @returns {{ mode: 'url' | 'export' | 'describe' | 'help', verify: boolean } | { error: string }}
 */
export function parseArgs(argv) {
  let mode = /** @type {'url' | 'export' | 'describe' | 'help'} */ ('url');
  let verify = true;
  let modeSetBy = null;
  for (const a of argv) {
    const asMode = { '--export': 'export', '--describe': 'describe', '--help': 'help', '-h': 'help' }[a];
    if (asMode) {
      if (modeSetBy && modeSetBy !== a) return { error: `conflicting modes: ${modeSetBy} and ${a}` };
      mode = /** @type {'url' | 'export' | 'describe' | 'help'} */ (asMode);
      modeSetBy = a;
      continue;
    }
    if (a === '--no-verify') {
      verify = false;
      continue;
    }
    return { error: `unknown argument: ${a}` };
  }
  return { mode, verify };
}

/**
 * Single-quote for POSIX `eval`. A DSN password is arbitrary bytes; unquoted it can carry
 * `$`, backticks or `;` straight into the caller's shell, which turns a convenience helper
 * into command injection against whoever ran `eval`.
 *
 * @param {string} v
 * @returns {string}
 */
export function shellSingleQuote(v) {
  return `'${String(v).replaceAll("'", `'\\''`)}'`;
}

/**
 * `export PG…=…` lines for `eval`. Throws on an unparseable URL rather than emitting a
 * partial environment — a half-set libpq environment silently falls back to libpq's own
 * defaults (local socket, $USER), i.e. it connects somewhere REAL but wrong.
 *
 * @param {string} url
 * @returns {string}
 */
export function formatExportLines(url) {
  const u = new URL(url);
  return LIBPQ.map(([name, get]) => `export ${name}=${shellSingleQuote(get(u))}`).join('\n');
}

async function verifyReachable(url) {
  const { Client } = await import('pg');
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return null;
  } catch (err) {
    return /** @type {Error} */ (err).message;
  } finally {
    await client.end().catch(() => {});
  }
}

const USAGE = `pg-url — the gated Postgres DSN for a shell caller.

  node scripts/pg-url.mjs               DSN on stdout, provenance on stderr
  node scripts/pg-url.mjs --export      \`export PG…=…\` lines for eval (keeps the
                                        password out of argv — prefer this)
  node scripts/pg-url.mjs --describe    provenance only, never credentials
  node scripts/pg-url.mjs --no-verify   skip the connect check

  eval "$(node scripts/pg-url.mjs --export)" && psql -c 'SELECT 1'

Exit: 0 ok · 1 resolved but unreachable · 2 bad usage.`;

/**
 * @param {string[]} argv
 * @returns {Promise<0 | 1 | 2>} the process exit code
 */
export async function main(argv) {
  const args = parseArgs(argv);
  if ('error' in args) {
    process.stderr.write(`pg-url: ${args.error}\n\n${USAGE}\n`);
    return 2;
  }
  if (args.mode === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const resolution = resolveScriptPgUrl();
  const provenance = describePgUrlResolution(resolution);

  const failure = args.verify ? await verifyReachable(resolution.url) : null;
  if (failure) {
    // The provenance line is the whole point of failing here: "ECONNREFUSED" alone does
    // not say WHICH of the six resolution steps produced the address that refused.
    process.stderr.write(`pg-url: resolved but NOT reachable — ${failure}\n  ${provenance}\n`);
    return 1;
  }

  if (args.mode === 'describe') {
    process.stdout.write(`${provenance}\n`);
    return 0;
  }
  // Provenance goes to stderr so `$(…)`/`eval` capture only the payload.
  process.stderr.write(`${provenance}\n`);
  process.stdout.write(`${args.mode === 'export' ? formatExportLines(resolution.url) : resolution.url}\n`);
  return 0;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
