/**
 * Optional PG client bootstrap for orchestrator CLI mode (activation
 * step 2). Reads connection config from env, attempts to connect, and
 * returns either a working client or `null` (in which case the
 * orchestrator falls back to the existing FS path — every dormant
 * Phase 1-7 module already handles `ctx.pg=undefined` gracefully).
 *
 * Activation is **opt-in**:
 *   - PAPERCUSP_USE_PG_STATE=1  → enable PG path; require connection
 *   - unset / 0                 → FS path (default; no connection attempt)
 *
 * Connection config:
 *   - PAPERCUSP_DATABASE_URL    → standard postgres URL
 *   - default: postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp
 *     (matches the operator's getOrgPg defaults — orchestrator runs on
 *     the same machine as the operator in CLI mode, same DB)
 *
 * Per-harness schema scoping:
 *   The orchestrator runs inside a single harness directory, so the
 *   pg client's search_path is set to `harness_<slug>,harness_shared,public`
 *   on every connection. This matches the operator's `dbcFor(slug)`
 *   pattern — Phase 1's state-pg.ts queries reference `harness_features`
 *   unqualified, and that resolves to `harness_<slug>.harness_features`
 *   via the search_path. Phase 2-7 queries that explicitly target
 *   `harness_shared.*` are unaffected (qualified names always win).
 *
 * The client is verified with a `SELECT 1` before being returned, plus a
 * `SHOW search_path` to confirm the schema was applied. Connection
 * failure → log + null → FS fallback.
 */
import postgres from 'postgres';
import type { OrchestratorPg } from './invoke';

const DEFAULT_DSN_FALLBACK =
  'postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp';

/**
 * Resolve PG DSN: env > discovery file (~/.papercusp/embedded-pg.json,
 * written by the desktop's Rust main on embedded-PG ready) > native
 * fallback. Mirrors the resolution chain in
 * libs/papercusp/libs/db/src/connection.ts so an orchestrator launched
 * outside Tauri (CLI mode, npm run dev) shares the same embedded PG
 * the desktop is running.
 */
function defaultDsn(): string {
  if (process.env.PAPERCUSP_DATABASE_URL) return process.env.PAPERCUSP_DATABASE_URL;
  if (process.env.PAPERCUSP_SKIP_PG_DISCOVERY !== '1') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require('node:fs') as typeof import('node:fs');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const os = require('node:os') as typeof import('node:os');
      const raw = fs.readFileSync(`${os.homedir()}/.papercusp/embedded-pg.json`, 'utf8');
      const parsed = JSON.parse(raw) as { url?: string };
      if (parsed?.url) return parsed.url;
    } catch { /* fall through */ }
  }
  return DEFAULT_DSN_FALLBACK;
}

export interface BootstrapResult {
  pg: OrchestratorPg | null;
  /** When non-null, holds the underlying postgres-js handle for cleanup. */
  cleanup: (() => Promise<void>) | null;
  reason: 'opted-out' | 'connected' | 'connection-failed' | 'verification-failed';
}

export interface BootstrapOptions {
  /**
   * Harness slug. When provided, the pg client's search_path includes
   * `harness_<slug>` ahead of `harness_shared` so Phase 1's unqualified
   * `harness_features` queries resolve to the per-harness schema.
   * Without it, only harness_shared + public are visible — Phases 2-7
   * still work (they use qualified names) but Phase 1 features queries
   * will fail.
   */
  harnessSlug?: string;
}

/**
 * Attempt to bootstrap a PG client for the orchestrator. Returns null
 * for `pg` whenever the orchestrator should fall back to FS — never
 * throws.
 */
export async function bootstrapOrchestratorPg(
  log: (m: string) => void,
  opts: BootstrapOptions = {},
): Promise<BootstrapResult> {
  if (process.env.PAPERCUSP_USE_PG_STATE !== '1') {
    // Production callers MUST set this — the in-memory state fallback
    // is a test-only stub with an empty store. Without PG, pre-loop's
    // featuresExist() returns false even when the DB has features, the
    // scoper runs and exits idempotently (since PG already matches
    // SPEC.md), then pre-loop bails because in-mem is still empty.
    // Log loudly so this is debuggable from /tmp/harness-<slug>.log.
    log(
      'PG bootstrap: PAPERCUSP_USE_PG_STATE!=1 — running with empty in-memory state. ' +
      'This is a test-only mode; production launchers must set the env var. ' +
      'See pg-bootstrap.ts header for details.',
    );
    return { pg: null, cleanup: null, reason: 'opted-out' };
  }
  const dsn = defaultDsn();

  // Build search_path: harness_<slug> first (so unqualified queries hit
  // the per-harness schema), then harness_shared, then public.
  const searchPath = opts.harnessSlug
    ? `harness_${opts.harnessSlug.replace(/-/g, '_')},harness_shared,public`
    : 'harness_shared,public';

  let client: ReturnType<typeof postgres>;
  try {
    client = postgres(dsn, {
      max: 4,
      idle_timeout: 20,
      connect_timeout: 5,
      // Apply search_path on every connection in the pool. postgres-js
      // exposes startup params via `connection: { ... }` — the search_path
      // is set as part of the SET-on-CONNECT phase before any user query
      // runs.
      connection: {
        search_path: searchPath,
      },
      onnotice: () => {},
    });
  } catch (e) {
    log(`PG bootstrap: connection setup failed: ${(e as Error).message} — falling back to FS`);
    return { pg: null, cleanup: null, reason: 'connection-failed' };
  }
  try {
    await client`SELECT 1 AS ok`;
    // Verify the search_path actually took effect; postgres rejects
    // invalid schema names silently in some versions.
    const sp = await client<{ search_path: string }[]>`SHOW search_path`;
    log(
      `PG bootstrap: connected (search_path=${sp[0]?.search_path ?? '?'}); orchestrator running with ctx.pg active`,
    );
  } catch (e) {
    log(`PG bootstrap: verification failed: ${(e as Error).message} — falling back to FS`);
    try { await client.end({ timeout: 1 }); } catch { /* ignore */ }
    return { pg: null, cleanup: null, reason: 'verification-failed' };
  }
  return {
    pg: client as unknown as OrchestratorPg,
    cleanup: async () => {
      try { await client.end({ timeout: 5 }); } catch { /* ignore */ }
    },
    reason: 'connected',
  };
}
