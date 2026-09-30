#!/usr/bin/env node
/**
 * PgBouncer pool sampler — EI-19384024494946006.
 *
 * The mcp-proxy watchdog's data-plane probe (watchdog.mjs, WI-6739) has twice now caught the
 * operator serving its tool catalog from memory while every DB-backed call hangs — GREEN
 * `/api/health`, GREEN session plane, DEAD data plane, for anywhere from ~90s to 457s, always
 * self-recovering with no intervention. Both incidents closed with the wedge MECHANISM
 * explicitly unproven (WI-6739's own title says so), because nobody was watching PgBouncer's
 * pool state WHILE it was happening — by the time an agent could look, the box had already
 * healed and the moment was gone.
 *
 * This module is that missing observer. It runs `SHOW POOLS` + `SHOW STATS` against the
 * PgBouncer ADMIN console (not the app databases — a separate virtual `pgbouncer` database
 * pgbouncer answers itself, see /etc/pgbouncer/pgbouncer.ini's `admin_users`) and appends the
 * result to a durable log, so the NEXT occurrence — instead of being investigated after the
 * fact from the outside — gets a direct, timestamped answer to "were pgbouncer's server slots
 * exhausted (cl_waiting > 0) at the exact moment the data plane was reported dead?".
 *
 * WHY THIS SPECIFIC HYPOTHESIS. The suggested diagnostic in EI-19384024494946006 itself:
 * PG, PgBouncer and the operator PROCESS were all independently confirmed healthy during the
 * 2026-08-02 incident while only DB-backed calls hung — pointing at the pooled path
 * (operator -> pgbouncer -> PG) rather than the proxy or the process. A live snapshot taken
 * OUTSIDE any flap (2026-08-03, this item's investigation) found both `papercusp` pools
 * (harness_admin, harness_app) sitting with sv_active+sv_idle EXACTLY at `default_pool_size`
 * (100) — i.e. permanently running at their configured ceiling with reserve_pool_size (25) as
 * the only slack — which is circumstantial support, not proof, for pool pressure being at
 * least a contributing factor. Separately, `/var/log/postgresql/pgbouncer.log` carries ZERO
 * "too many"/"no server"/error-class lines in its entire history (640k+ lines) and nothing
 * unusual in the exact incident window — which argues AGAINST an outright PgBouncer-level
 * rejection, but says nothing about whether clients were quietly WAITING (`cl_waiting`) for a
 * few hundred ms to several seconds at a time, which is invisible to the log and only visible
 * in a live `SHOW POOLS` sample. This sampler settles that the next time it fires for real.
 *
 * NEVER throws and never blocks its caller for longer than SAMPLE_TIMEOUT_MS — a diagnostic
 * that could itself wedge the watchdog would be strictly worse than the blindness it exists to
 * cure (same rule as the watchdog's own `log()`).
 */
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const ADMIN_HOST = process.env.PAPERCUSP_PGBOUNCER_ADMIN_HOST || '127.0.0.1';
/** Shares PAPERCUSP_PGBOUNCER_PORT with connection.ts's maybePgbouncer() so the sampler always
 *  points at the SAME pooler the app is actually routed through (default 6432). */
const ADMIN_PORT = Number(process.env.PAPERCUSP_PGBOUNCER_PORT) || 6432;
const ADMIN_USER = process.env.PAPERCUSP_PGBOUNCER_ADMIN_USER || 'harness_admin';
/**
 * Matches NATIVE_FALLBACK in embedded-pg-discovery.ts — the box's own public dev default
 * (already committed in plaintext there), not a new secret. Override via env for a box with a
 * real password / different admin user.
 */
const ADMIN_PASSWORD = process.env.PAPERCUSP_PGBOUNCER_ADMIN_PASSWORD || 'harness_admin_pwd';
/** Exported (not just internal) so the watchdog's own startup log can report where samples
 *  land, without a second copy of the env-resolution logic drifting from this one. */
export const SAMPLE_LOG_FILE =
  process.env.PAPERCUSP_MCP_PROXY_WATCHDOG_POOL_SAMPLE_LOG ||
  join(homedir(), '.papercusp', 'mcp-proxy-watchdog-pgbouncer-samples.log');
const SAMPLE_TIMEOUT_MS = Number(process.env.PAPERCUSP_PGBOUNCER_SAMPLE_TIMEOUT_MS) || 5_000;
/**
 * Never sample more than once per this window even under a burst of onset callers (the
 * reachability AND data-plane probes can both fire within the same poll cycle). SHOW POOLS is
 * cheap, but this keeps the log readable and bounds worst-case psql-spawn cost under exactly
 * the load spike we are trying to observe rather than adding to it.
 */
export const MIN_SAMPLE_INTERVAL_MS = Number(process.env.PAPERCUSP_PGBOUNCER_SAMPLE_MIN_INTERVAL_MS) || 20_000;

/**
 * Pure: the exact argv used to query the PgBouncer admin console. Exported so the invariant —
 * we ask SHOW POOLS + SHOW STATS, against the admin virtual `pgbouncer` database, as the
 * configured admin user — is unit-testable without spawning a real process. `-At` keeps the
 * diagnostic output tuple-only: the header/aligned formatter was the shape observed hanging
 * during the original incident, while the same query in this mode returned promptly.
 */
export function buildShowPoolsArgs({ host = ADMIN_HOST, port = ADMIN_PORT, user = ADMIN_USER } = {}) {
  return ['-h', host, '-p', String(port), '-U', user, '-d', 'pgbouncer', '-At', '-c', 'SHOW POOLS;', '-c', 'SHOW STATS;'];
}

let lastSampleAt = 0;

/**
 * Fire a real SHOW POOLS/SHOW STATS query and append the result to a durable, journald-
 * independent log (same rationale as the watchdog's own LOG_FILE — EI-2434: a decision log
 * nobody can read is as good as no log). Debounced (see MIN_SAMPLE_INTERVAL_MS); NEVER throws.
 *
 * `execFileImpl`/`now` are injectable for tests.
 */
export async function samplePgBouncerPools(reason, { execFileImpl = execFile, now = Date.now } = {}) {
  const t = now();
  if (t - lastSampleAt < MIN_SAMPLE_INTERVAL_MS) {
    return { ok: false, skipped: 'debounced' };
  }
  lastSampleAt = t;
  const args = buildShowPoolsArgs();
  return new Promise((resolve) => {
    let settled = false;
    try {
      execFileImpl(
        'psql',
        args,
        // SIGKILL cannot be caught by psql. The timeout must be a hard upper bound for this
        // watchdog diagnostic, rather than a best-effort SIGTERM that could leave a child
        // process (and this Promise) alive while the data-plane incident is unfolding.
        { env: { ...process.env, PGPASSWORD: ADMIN_PASSWORD }, timeout: SAMPLE_TIMEOUT_MS, killSignal: 'SIGKILL' },
        (err, stdout, stderr) => {
          if (settled) return; // execFile guarantees one callback, but stay defensive under test doubles
          settled = true;
          const line =
            `[pgbouncer-sample ${new Date().toISOString()}] reason=${reason}\n` +
            (err ? `ERROR: ${err.message}\n${stderr || ''}` : String(stdout ?? '')) +
            '\n';
          try {
            mkdirSync(dirname(SAMPLE_LOG_FILE), { recursive: true });
            appendFileSync(SAMPLE_LOG_FILE, line);
          } catch {
            /* best-effort — never let logging failure surface to the caller */
          }
          resolve({ ok: !err, output: String(stdout ?? ''), error: err ? err.message : null });
        },
      );
    } catch (e) {
      // A synchronous throw from execFileImpl itself (e.g. a broken test double) — still never
      // throws out of this function.
      if (!settled) {
        settled = true;
        resolve({ ok: false, output: '', error: e?.message ?? String(e) });
      }
    }
  });
}

/** Test-only — resets the debounce state between tests. */
export function _resetSampleDebounceForTests() {
  lastSampleAt = 0;
}
