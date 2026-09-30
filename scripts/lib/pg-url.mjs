/**
 * pg-url.mjs — the ONE Postgres-URL resolver for `scripts/*` CLIs.
 *
 * ## Why this exists (EI-20081449067583201, measured 2026-08-10)
 *
 * Four scripts had hand-rolled the same resolution chain, and all four were BROKEN from a
 * fresh shell (no inherited operator env). Each did:
 *
 *     const disc = require('@papercusp/embedded-pg-discovery');
 *     return disc.resolvePgUrl?.() ?? disc.getHarnessAdminUrl?.();
 *
 * That is the GENERIC resolver, and it takes a REQUIRED config
 * (`{ envVars, discoveryFile, fallbackUrl }`) and returns an OBJECT (`{ url, source }`).
 * Called with no argument it throws `Cannot read properties of undefined (reading
 * 'envVars')` — and had it not thrown it would have handed back an object where the
 * caller wanted a string. The `?.` guards protect against a MISSING export, never
 * against the function itself throwing, so the whole fallback leg was dead and the
 * scripts died with `No database URL. Set HARNESS_ADMIN_DATABASE_URL (or DATABASE_URL)`.
 *
 * The in-tree comments blamed "an operator context this script does not have". That
 * diagnosis was wrong, and being wrong is why it stayed broken for so long: the
 * correctly-configured wrapper is `getHarnessAdminUrl()` in operator-core, it needs no
 * operator context at all, and it imports fine from a bare `node scripts/x.mjs` (Node
 * strips types; `package.json` engines pins `node >=25`). It also NEVER throws — its last
 * resort is the native-PG fallback — so the "No database URL" error those scripts raised
 * was not reachable through the correct path in the first place.
 *
 * ## Resolution order — steps 4-6 are DELEGATED, never re-implemented here
 *
 *   1. `HARNESS_ADMIN_DATABASE_URL` — an explicit admin DSN always wins.
 *   2. `PAPERCUSP_PG_PORT` — THIS PROCESS OWNS A DEDICATED PG (see the isolation note
 *      below). Resolves to that port and stops; the ambient dev DSN is exactly what must
 *      NOT be used here.
 *   3. repo-root `.env.local`, for any of {@link PG_URL_ENV_VARS} not already set in the
 *      real environment (real env always wins; skipped entirely under 2).
 *   4. those same env vars, first non-empty wins                       ─┐
 *   5. the discovery file (`$PAPERCUSP_HOME/embedded-pg.json`), pid- +  │ getHarnessAdmin
 *      listening-port-gated                                             │ UrlWithSource()
 *   6. the native-PG fallback                                          ─┘
 *
 * ## Why `.env.local` (step 3)
 *
 * The operator service is launched as `set -a; [ -f .env.local ] && . ./.env.local; set +a`
 * (`~/.config/systemd/user/papercup-dev-api.service`), so `.env.local` IS the operator's
 * DATABASE_URL. A script that ignores it can silently read or write a DIFFERENT database
 * than the operator whose state it exists to maintain. Only the DB-url names are applied —
 * a script's environment is not the operator's environment, and the two only need to agree
 * about WHICH DATABASE.
 *
 * ## Why `PAPERCUSP_PG_PORT` outranks it (step 2) — the isolation rail
 *
 * `scripts/with-test-pg.mjs` boots a throwaway PG and runs its child with
 * `PAPERCUSP_PG_PORT=<port>` + `PAPERCUSP_SKIP_PG_DISCOVERY=1` and DELIBERATELY no
 * `HARNESS_ADMIN_DATABASE_URL` ("a test harness must not perturb the tests it runs"). A
 * naive `.env.local` read would hand that child the LIVE DEV DSN and let a test suite
 * write to the real database. So an isolation lever suppresses step 3 outright, and
 * `PAPERCUSP_PG_PORT` resolves positively rather than falling through to a hardcoded 5432.
 *
 * ⚠ That last part is a deliberate DIVERGENCE from `getHarnessAdminUrl()`, whose native
 * fallback hardcodes `:5432` and does not honor `PAPERCUSP_PG_PORT` (measured 2026-08-10,
 * reading both it and the generic resolver end to end — despite
 * `harness-invoke-once.ts`'s comment asserting that it does). `connection.ts`'s `adminUrl()`
 * DOES honor it, with the identical `harness_admin` DSN built below. Collapsing the two
 * resolvers is tracked separately (EI-19384906720464601); until then a script must not be
 * the one place that ignores the lever.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// The Papercusp-CONFIGURED resolver. Deliberately not the generic
// `@papercusp/embedded-pg-discovery` — configuring it at each call site is the defect
// this module exists to delete.
import { getHarnessAdminUrlWithSource } from '../../packages/operator-core/lib/embedded-pg-discovery.ts';

/** Env var names carrying a Postgres URL, in the order operator-core checks them. */
export const PG_URL_ENV_VARS = ['HARNESS_ADMIN_DATABASE_URL', 'DATABASE_URL', 'PAPERCUSP_PG_URL'];

/**
 * Env vars that mean "this process owns a dedicated/hermetic PG". Either one suppresses
 * the `.env.local` step, because the whole point of both levers is that the ambient dev
 * database is NOT the one to talk to.
 */
export const PG_ISOLATION_ENV_VARS = ['PAPERCUSP_PG_PORT', 'PAPERCUSP_SKIP_PG_DISCOVERY'];

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Byte-identical to connection.ts's adminUrl() native fallback, port included. */
const isolatedAdminUrl = (port) =>
  `postgresql://harness_admin:harness_admin_pwd@localhost:${Number(port) || 5432}/papercusp`;

/**
 * Parse a dotenv-style file into a Map. Deliberately minimal — it handles exactly what
 * `set -a; . ./.env.local` handles for the shapes this repo writes: `KEY=value`, an
 * optional `export ` prefix, `#` comments, and surrounding single/double quotes. It does
 * NOT expand `$VAR` or run command substitution; a value that needs either is a value a
 * script should get from its real environment, not from a file read by a parser.
 *
 * @param {string} text
 * @returns {Map<string, string>}
 */
export function parseEnvFile(text) {
  const out = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out.set(m[1], value);
  }
  return out;
}

/**
 * Apply the DB-url keys from `<root>/.env.local` onto `env`, WITHOUT overwriting anything
 * already set. This is the one deliberate difference from the service's `set -a; . ./.env.local`
 * (which lets the file clobber an inherited value): here an explicit
 * `DATABASE_URL=… node scripts/x.mjs` must win, or a caller could not override the file at all.
 *
 * Refuses outright when an isolation lever is set — see {@link PG_ISOLATION_ENV_VARS}.
 *
 * @param {{ root?: string, env?: Record<string, string | undefined> }} [opts]
 * @returns {{ file: string, exists: boolean, present: string[], applied: string[], skipped: string | null }}
 */
export function applyEnvLocal({ root = REPO_ROOT, env = process.env } = {}) {
  const file = join(root, '.env.local');
  const isolatedBy = PG_ISOLATION_ENV_VARS.find((n) => env[n]);
  if (isolatedBy) return { file, exists: existsSync(file), present: [], applied: [], skipped: isolatedBy };
  if (!existsSync(file)) return { file, exists: false, present: [], applied: [], skipped: null };
  let parsed;
  try {
    parsed = parseEnvFile(readFileSync(file, 'utf8'));
  } catch {
    return { file, exists: true, present: [], applied: [], skipped: 'unreadable' };
  }
  const present = [];
  const applied = [];
  for (const name of PG_URL_ENV_VARS) {
    const value = parsed.get(name);
    if (!value) continue;
    present.push(name);
    if (env[name]) continue; // real env wins
    env[name] = value;
    applied.push(name);
  }
  return { file, exists: true, present, applied, skipped: null };
}

/**
 * The Postgres URL a `scripts/*` CLI should connect to. Never throws and never returns
 * empty: the last resort is the native-PG fallback, so a wrong answer surfaces as a
 * connection error naming a real host — not as an "unset variable" error naming a
 * variable this repo does not set.
 *
 * ⚠ `env` governs steps 1-3 only. The delegated legs (4-6) read `process.env` directly,
 * because that is what `getHarnessAdminUrlWithSource()` reads — so passing a synthetic
 * `env` object exercises the isolation/`.env.local` decisions, not the whole chain. Unit
 * tests should drive {@link applyEnvLocal} (pure) rather than faking the delegation.
 *
 * @param {{ root?: string, env?: Record<string, string | undefined> }} [opts]
 * @returns {{ url: string, source: string, envLocal: ReturnType<typeof applyEnvLocal> }}
 */
export function resolveScriptPgUrl({ root = REPO_ROOT, env = process.env } = {}) {
  const envLocal = applyEnvLocal({ root, env });
  // Step 1/2: an explicit admin DSN wins; failing that, a dedicated PG's port is the whole
  // answer — resolving past it is what would reach the ambient dev database instead.
  if (!env.HARNESS_ADMIN_DATABASE_URL && env.PAPERCUSP_PG_PORT) {
    return { url: isolatedAdminUrl(env.PAPERCUSP_PG_PORT), source: 'isolated-pg-port', envLocal };
  }
  const { url, source } = getHarnessAdminUrlWithSource();
  // WHICH variable won, not just "an env var did". `source: 'env'` alone reads as
  // ambiguous exactly when it matters: an explicit HARNESS_ADMIN_DATABASE_URL and a
  // DATABASE_URL this module lifted out of .env.local are the same `source`, and only the
  // name distinguishes "you set this" from "the file set this".
  const via = source === 'env' ? PG_URL_ENV_VARS.find((n) => process.env[n]) : undefined;
  return { url, source, via, envLocal };
}

/**
 * One line saying WHERE the URL came from, with the host/port but never the credentials.
 * Attach it to a connection failure: "ECONNREFUSED" is unactionable until you know which
 * of the four sources produced the address that refused.
 *
 * @param {{ url: string, source: string, via?: string, envLocal: { exists: boolean, applied: string[], skipped: string | null } }} r
 * @returns {string}
 */
export function describePgUrlResolution(r) {
  let where = '';
  try {
    const u = new URL(r.url);
    where = `${u.hostname}:${u.port || '5432'}${u.pathname}`;
  } catch {
    where = '<unparseable url>';
  }
  const envLocalNote = r.envLocal.skipped
    ? `.env.local NOT read — ${r.envLocal.skipped} (isolated PG)`
    : r.envLocal.exists
      ? r.envLocal.applied.length
        ? `.env.local supplied ${r.envLocal.applied.join(', ')}`
        : '.env.local present but did not supply the url'
      : 'no .env.local at the repo root';
  const source = r.via ? `${r.source}:${r.via}` : r.source;
  return `pg url source=${source} → ${where} (${envLocalNote}; env checked: ${PG_URL_ENV_VARS.join(' > ')})`;
}

/**
 * A CONNECTED `pg` Client for a `scripts/*` CLI. On failure the thrown error carries the
 * resolution description, so the first line of the failure says which source produced the
 * address that refused rather than leaving the caller to guess.
 *
 * @param {{ root?: string, env?: Record<string, string | undefined> }} [opts]
 * @returns {Promise<import('pg').Client>}
 */
export async function connectScriptPg(opts = {}) {
  const resolution = resolveScriptPgUrl(opts);
  const { Client } = await import('pg');
  const client = new Client({ connectionString: resolution.url });
  try {
    await client.connect();
  } catch (err) {
    const e = /** @type {Error} */ (err);
    e.message = `${e.message}\n  ${describePgUrlResolution(resolution)}`;
    throw e;
  }
  return client;
}
