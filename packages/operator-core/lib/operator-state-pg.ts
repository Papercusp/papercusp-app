/**
 * Shared read/write helpers for the operator-state PG tables introduced
 * by migration 020 (and later extensions through migration 027).
 *
 * Each table is single-row-per-workspace with a JSONB payload. The
 * existing module-level types (`BudgetState`, `LastScanEntry`,
 * `TtsSpendState`, etc.) continue to govern the payload shape — these
 * helpers just hide the SQL.
 *
 * Why per-workspace: prior file-backed approach had the workspace baked
 * into the path (`<ws>/.papercusp/system/operator/X.json`). Moving to
 * PG keeps the same scoping by stamping every row with workspace_id,
 * which `activeWorkspaceId()` resolves at call time.
 *
 * Encryption-at-rest: tables in `ENCRYPTED_TABLES` (migration 027) have
 * a sibling `payload_ct BYTEA` column holding pgcrypto-encrypted bytes.
 * Reads decrypt via pgp_sym_decrypt with a key sourced from
 * `~/.papercusp/db-encryption-key` (or the env-var override). Writes
 * always populate `payload_ct`; the legacy `payload` column is kept null
 * on writes so a future migration can drop it. Tables NOT in the set
 * continue to use the plaintext `payload` JSONB column unchanged.
 */
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';
import { ENCRYPTED_TABLES, getDbEncryptionKey } from './db-encryption';
import { pinModuleState } from '@papercusp/module-singleton';
import { isRetriablePgConnectError, withPgRetry, type PgRetryOpts } from './pg-transient-retry';

/**
 * Read-only retry classifier for the operator-state SELECTs below. A SELECT that never
 * reached the server is safe to re-issue, so on top of the connect-phase timeout the
 * default `isRetriablePgConnectError` admits, this ALSO retries the two pgbouncer
 * pool-starvation shapes that killed a 60-minute green-checkpoint run at its decision
 * stage on 2026-09-05 (`readOperatorState` threw `PostgresError: query_wait_timeout`,
 * SQLSTATE 08P01 — the pooler gave up waiting for a server slot, so nothing executed)
 * and the closed-mid-flight `CONNECTION_CLOSED` that follows it. Mutating call sites
 * keep the narrow default: a CONNECTION_CLOSED write may have partially run (see the
 * module header of pg-transient-retry.ts).
 */
export function isRetriablePgReadError(e: unknown): boolean {
  if (isRetriablePgConnectError(e)) return true;
  const x = e as { code?: string; message?: string } | null;
  if (!x) return false;
  const msg = x.message ?? '';
  return (
    /\bquery_wait_timeout\b/.test(msg) ||
    x.code === 'CONNECTION_CLOSED' ||
    /\bCONNECTION_CLOSED\b/.test(msg)
  );
}

const READ_RETRY: PgRetryOpts = {
  retries: 2,
  backoffMs: 500,
  classifier: isRetriablePgReadError,
  label: 'readOperatorState',
};

// (operator_last_scan / operator_idle_snapshot / operator_scanner_session were
// removed with the scanner teardown — unify-agent-launches D-005, migration 167.)
type StateTable =
  | 'operator_budget'
  | 'operator_standing_candidates'
  | 'operator_tts_spend'
  | 'operator_stt_spend'
  | 'operator_voice_prefs'
  | 'operator_credentials'
  // Round-2 extensions (migration 021):
  | 'operator_agent_config'
  | 'operator_first_run'
  | 'operator_user_profile'
  // Round-3 extensions (migration 022):
  | 'operator_prompt_user'
  | 'operator_preferences'
  | 'operator_publish_credentials'
  // Round-4 extension (migration 023):
  | 'operator_voice_credentials'
  // Round-5 extensions (migration 024):
  | 'operator_oracle_prompt'
  | 'operator_oracle_memory'
  | 'operator_marketplace_token'
  // Round-6 extensions (migration 025):
  | 'harness_registry'
  // Round-6 extensions (migration 026):
  | 'operator_trust_store'
  // Round-7 extension (migration 029):
  | 'operator_paused'
  // Migration 047 — search-provider keys for OMP web_search:
  | 'operator_search_provider_credentials'
  // Migration 062 — Setup Wizard state + telemetry reports buffer:
  | 'setup_wizard_state'
  | 'telemetry_reports'
  // Migration 158 — the Pot's self-declared-wake state (autoloop-pot-operator-rebuild P0):
  | 'pot_wake'
  // Migration 161 — the live-editable fleet rate-limit knobs (rate-limit-layer-v2 D-004):
  | 'operator_rate_limit_config'
  // Migration 164 — P2P voice-channel registry (holepunch-voice-channels P-007/D-011):
  | 'operator_voice_channels'
  // Migration 182 — P2P hive-directory offline cache (p2p-hive-directory P-003).
  // Renamed hive_directory_cache -> pot_directory_cache by migration 557
  // (cup-lexicon rename phase 3, 2026-07-10) — WI-953: the app code still
  // said 'hive_directory_cache' after the table rename, so every
  // readOperatorState/writeOperatorState call hit "relation ... does not
  // exist" and the directory-announce cache/tombstone path silently
  // no-opped (both catch(() => null)/catch(() => {})), starving
  // /api/discovery/hives of the persisted announce even when the P2P
  // gossip layer paired + accepted it in memory. Fixed here to the
  // current table name.
  | 'pot_directory_cache'
  // Migration 294 — withdrawal-tombstone watermarks (hive-from-repo-hardening
  // P-005). NOTE: each StateTable is its OWN harness_shared.<name> table, so
  // this needed its own migration (294) — the original "no new migration
  // needed" assumption was wrong and broke the hive-directory join path.
  // Renamed hive_directory_tombstones -> pot_directory_tombstones by
  // migration 557 (see the pot_directory_cache note above — same gap, same fix):
  | 'pot_directory_tombstones'
  // Migration 190 — Queen Claude-account pool (cloud-deployment-layer Phase 7 P-019):
  | 'operator_account_pool'
  // Migration 297 — owner's session-now account override (accounts-pool-tab P-004/D-015):
  | 'operator_account_override'
  // Migration 416 — durable dynamic agent→account pins (account-dynamic-pin; gateway honors per-request):
  | 'operator_owner_pins'
  // Migration 216 — PG-backed runtime flag overrides (audit P-070, EI-76):
  | 'operator_flag_overrides'
  // Migration 223 — P2P voice blind-relay state (holepunch-voice-channels
  // P-013/D-009; table was missing until EI-300):
  | 'voice_relay'
  // Migration 337 — runtime-settable deploy-migration lock_timeout/statement_timeout
  // (live-configurability-audit-2026-06-20 P-003):
  | 'operator_migrate_policy'
  // Migration 341 — settable fleet opus-budget shed bands (live-configurability-audit P-005):
  | 'operator_opus_budget_policy'
  // Migration 342 — settable account scale-out trigger policy (live-configurability-audit P-006):
  | 'operator_scale_policy'
  // Migration 346 — settable auto-implement risk policy + dispatch limits (live-configurability-audit P-011):
  | 'operator_auto_implement_policy'
  // Migration 348 — coordination liveness/reclaim config (live-configurability-audit P-014):
  | 'operator_coord_liveness_config'
  // Migration 350 — hive placement-watchdog control policy (live-configurability-audit P-015):
  | 'operator_pot_control_policy'
  // Migration 351 — green-checkpoint / release thresholds (live-configurability-audit P-016):
  | 'operator_release_checkpoint_config'
  // Migration 352 — runtime per-role capability-envelope overrides (live-configurability-audit P-009):
  | 'operator_capability_envelopes'
  // Migration 354 — runtime telemetry-buffer overrides (live-configurability-audit P-020):
  | 'operator_telemetry_buffer_config'
  // Migration 356 — runtime per-workspace txn lock/statement timeouts (live-configurability-audit P-020):
  | 'operator_txn_timeouts_config'
  // Migration 393 — runtime Scout workspace spend-ceiling override (live-configurability-audit P-022):
  | 'operator_scout_budget'
  // Migration 394 — runtime per-(tool,role) quota overrides (live-configurability-audit P-018):
  | 'operator_quota_overrides'
  // Migration 400 — runtime §G auth/sandbox overrides, DARK (live-configurability-audit P-019):
  | 'operator_auth_config'
  // Migration 401 — runtime capability→tier overrides, DARK (live-configurability-audit P-010):
  | 'operator_capability_tiers'
  // Migration 526 — generic third-party integration API keys (owner-ask-batch-2026-07-06 P-002):
  | 'operator_integration_credentials'
  // Migration 604 — context-door / compaction-threshold constant overrides
  // (deterministic-context-carry-2026-07-14 P-023): workspace defaults + per-session:
  | 'operator_context_doors_config'
  // Migration 635 — durable cross-worker flap-episode counters for the
  // infra-liveness alarm (EI-15126 fix — see the migration's own comment for
  // the full root-cause story):
  | 'operator_liveness_flap_state'
  // Migration 812 — durable per-unit administrative-pause clock for the
  // supervision reconciler (EI-20003974512096022 fixes 1+2 — the same
  // in-memory-amnesia class as 635 above; see the migration's own comment):
  | 'operator_supervision_pause_state'
  // Migration 1092 — durable per-subject announced-quiesce windows so an ad-hoc
  // deliberate quiesce (no systemd trace) can suppress the single-primary alarm
  // the way D-026 already does for the release-cut contract (EI-22040647386284200;
  // see system-health/announced-quiesce.ts):
  | 'operator_announced_quiesce_state'
  // Migration 639 — knowledge-pack loop settings (cadence presets, adoption
  // policy, hygiene/delivery knobs; knowledge-pack-settings-2026-07-19 P-001):
  | 'knowledge_pack_config'
  // Migration 739 — cross-SERVICE booted-handles snapshot (EI-19327550671915579,
  // part 2 of EI-18735338283879820): the substrate owner process publishes its
  // listBootedHandles() snapshot here so a request-only host under the
  // dedicated-bg-host topology (:3070/:3270, a SEPARATE systemd service from
  // papercup-bg-host — node:cluster IPC cannot cross that boundary) can read it.
  // See sync/hyperbee/substrate-booted-handles-pg.ts.
  | 'substrate_booted_handles_status'
  // Migration 967 — launch-declared SESSION tool confinements, keyed by coord ownerId
  // (directed-pair-work-items-2026-08-25 P-004 / D-017). Read into a sync cache at the
  // dispatch checkCapabilityEnvelope step; empty payload ⇒ every session unconfined ⇒
  // byte-identical to no gate. Deliberately its OWN table rather than a field on
  // session_briefs.control_state, which other writers replace wholesale (D-017 §3).
  | 'operator_session_confinements'
  // Migration 1057 — standing Inbox automation authority + confidence policy.
  | 'operator_attention_automation_policy'
  // Migration 1202 — consult expert-routing settings: the ranked allowlist of models
  // allowed to ANSWER a consult (D-004) plus the stage-2 recency half-life
  // (consult-expert-routing-2026-09-22 P-005 / D-001 §2). Read on the dispatch
  // critical path, so an empty/absent row degrades to the owner-stated seed.
  | 'operator_consult_expert_routing'
  // Migration 1210 — the Settings choice of embedding device, auto|cuda|cpu
  // (memory-reduction-2026-09-24 P-008 / D-008). Read at boot by every process
  // that embeds; a concrete PAPERCUSP_EMBED_DEVICE host override outranks it.
  | 'operator_embed_device';

// ── operator-state read cache (infra-perf-robustness-audit-2026-06-18 P-004) ────
//
// `harness_registry` and `operator_account_pool` are read via readOperatorState on
// hot request paths. The original audit found ~13.8M registry seq-scans/window;
// P-008 later measured 1,434,412 account-pool reads since the 2026-09-07 stats
// reset (~51/min, 8,715s cumulative) against a 6.2KB row. Both rows are written
// through the invalidating helpers below and change far less often than they are
// read. A tiny per-(table, workspace) cache cuts that round-trip volume — easing
// both the PG pool and the event loop the psu incident exposed.
//
// SAFETY: only an ALLOWLIST of read-mostly tables is cached. The SAME process that
// writes invalidates its entry immediately (writeOperatorState / updateOperatorState
// below), so a write-then-read in one process is never stale. ACROSS processes (the
// cluster) staleness is bounded to the short TTL — acceptable for the registry, whose
// changes are rare and tolerate a couple seconds to propagate. Account-pool
// writes also publish `accounts.pool` invalidation; the TTL is the fail-safe for
// a process that misses that advisory event, never a second source of truth.
// Disable entirely with PAPERCUSP_OPSTATE_CACHE_MS=0 (the kill-switch).
// Encrypted tables are NOT allowlisted (no in-process plaintext caching of secrets).
//
// WI-10004071: the cluster (:3070 runs PAPERCUSP_CLUSTER=16 workers) made the
// "bounded by the TTL" claim above the ONLY coherence mechanism for a sibling
// worker, so a create-then-use over MCP (harness:create, then a call that lands
// on another worker) read a stale registry for up to the TTL. Each cacheable
// table therefore names the `sync_invalidate` events that mean "another process
// wrote me"; startOperatorStateCacheCoherence() drops the entry on those events
// in every worker. The allowlist is DERIVED from this map, so making a table
// cacheable without naming its coherence events is a type error. The TTL stays
// as the fail-safe for a missed NOTIFY, never the mechanism.
type CacheableStateTable = 'harness_registry' | 'operator_account_pool';
export const OPERATOR_STATE_CACHE_COHERENCE_EVENTS: Readonly<Record<CacheableStateTable, readonly string[]>> = {
  harness_registry: ['harnessProjects.lite'],
  operator_account_pool: ['accounts.pool'],
};
const CACHEABLE_STATE_TABLES: ReadonlySet<StateTable> = new Set<StateTable>(
  Object.keys(OPERATOR_STATE_CACHE_COHERENCE_EVENTS) as CacheableStateTable[],
);

function opStateCacheTtlMs(): number {
  const raw = Number(process.env.PAPERCUSP_OPSTATE_CACHE_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2000;
}

interface OpStateCacheEntry {
  value: unknown;
  at: number;
}
// globalThis-backed (WI-7032), NOT a plain module-level `Map` — this module is
// dependency-of-everything (loaded by both the HTTP route tree and the DBOS
// bootstrap/orchestrator tree), so under the tsx-direct boot entrypoint it hits
// the SAME double-module-load trap already fixed for orchestrator-workflow.ts's
// InjectedPipelineHooks (WI-3830/WI-4015): two instances of this module can
// coexist in one process, each with its OWN plain-`Map` cache. A registration
// write on instance A calls `invalidateOperatorStateCache`, which only clears
// instance A's Map — instance B's cache (if it had already warmed a pre-write,
// project-less read for the same (table, workspace) key, e.g. an early
// `loadHarnessRegistry` probe) stays stale for up to the TTL, so a `resolveProject`
// running on instance B sees NULL for a harness that just committed on instance A.
// This reproduced as "resolveProject NULL — unknown harness slug=gymbaseline…"
// for freshly-registered gym throwaway harnesses even though the registration
// HTTP call had already returned 200 — the write and the read were both correct,
// same-process same-workspace, just on two different in-memory Map instances.
// Storing the cache on globalThis (the same hot-reload-safe-singleton idiom
// idempotent-register-workflow.ts and orchestrator-workflow.ts's pipelineHooks()
// already use) makes every module instance in the process share ONE cache, so a
// same-process write-then-read is never stale regardless of which specifier
// space either side loaded through. Genuine CROSS-process staleness (a
// different OS process entirely, e.g. WI-1378's substrate-sidecar case) is
// unaffected — that still needs `{ fresh: true }`, unchanged by this fix.
// Pinned through @papercusp/module-singleton rather than a hand-rolled
// `globalThis[Symbol.for(...)]` pair. The sharing semantics above are exactly
// what the primitive provides; hand-rolling achieved them but left the pin
// invisible to listModuleDuplications(), which then answers a confident `[]`
// while this module — dependency-of-everything, and so a prime split
// candidate — is duplicated (EI-19479108855357092).
const __state = pinModuleState<{ cache: Map<string, OpStateCacheEntry> }>(
  '@papercusp/operator-core.opStateCache',
  () => ({ cache: new Map<string, OpStateCacheEntry>() }),
);
function opStateCacheMap(): Map<string, OpStateCacheEntry> {
  return __state.cache;
}
const opStateCacheKey = (table: StateTable, ws: string): string => `${table}\x00${ws}`;

/** Invalidate a cached (table, ws) entry — called by every write path so the
 *  writing process never reads its own stale value. Exported for tests. */
export function invalidateOperatorStateCache(table: StateTable, ws: string): void {
  opStateCacheMap().delete(opStateCacheKey(table, ws));
}

/** Drop every workspace's cached entry for `table` (a coherence event carries
 *  no workspace, so a sibling worker cannot tell which one changed). */
export function invalidateOperatorStateTable(table: StateTable): void {
  const prefix = `${table}\x00`;
  const cache = opStateCacheMap();
  for (const key of [...cache.keys()]) if (key.startsWith(prefix)) cache.delete(key);
}

const coherenceState = pinModuleState<{ started: Promise<void> | null }>(
  '@papercusp/operator-core.opStateCacheCoherence',
  () => ({ started: null }),
);

/**
 * Keep this process's operator-state cache coherent with writes made by OTHER
 * processes (WI-10004071). Subscribes to the shared `sync_invalidate` bus and
 * drops a cacheable table's entries when one of its coherence events arrives;
 * on the initial LISTEN and every reconnect it drops ALL cacheable entries, so
 * a NOTIFY missed while disconnected cannot leave a stale entry behind.
 * Idempotent per process; a failed start can be retried.
 */
export function startOperatorStateCacheCoherence(): Promise<void> {
  if (!coherenceState.started) {
    coherenceState.started = (async () => {
      const { registerInvalidationListenHook, subscribe } = await import('./sync-sse');
      registerInvalidationListenHook(() => {
        for (const table of CACHEABLE_STATE_TABLES) invalidateOperatorStateTable(table);
      });
      await subscribe((event) => {
        for (const [table, names] of Object.entries(OPERATOR_STATE_CACHE_COHERENCE_EVENTS)) {
          if (names.includes(event.name)) invalidateOperatorStateTable(table as StateTable);
        }
      });
    })().catch((err) => {
      coherenceState.started = null;
      throw err;
    });
  }
  return coherenceState.started;
}

/** Test hook: forget a started coherence subscription (the bus is mocked per suite). */
export function _resetOperatorStateCacheCoherenceForTests(): void {
  coherenceState.started = null;
}

/**
 * Which sync query names each operator-state table's writes must invalidate.
 *
 * EXPORTED (EI-19304902443341820) so `sync-resolver/__tests__/resolver-backing-table-coverage.test.ts`
 * can check the resolver → table → invalidation chain end to end. This map is the SECOND of the two
 * invalidation surfaces (the other being `TABLE_TO_QUERY_NAMES`), and a resolver whose backing table
 * appeared in NEITHER used to be invisible to every guard — which is how `accounts.pool` sat un-live
 * for ~7 weeks. Keys are bare table names; TABLE_TO_QUERY_NAMES keys are `harness_shared.<table>`.
 */
export const OPERATOR_STATE_SYNC_NAMES: Partial<Record<StateTable, readonly string[]>> = {
  operator_prompt_user: ['operatorConfig.byWorkspace'],
  operator_preferences: ['operatorConfig.byWorkspace', 'operatorPreferences.byWorkspace'],
  operator_voice_prefs: ['voicePrefs.effective', 'voicePrefs.workspace'],
  operator_account_override: ['accounts.sessionOverride', 'accounts.pool'],
  // WI-6796: the POOL itself, not just the owner's override. `accounts.pool`
  // resolves accountStatus() straight off this table, and the inference gateway
  // rewrites it continuously (makeWindowProjector -> recordAccountWindow) as it
  // observes each response's anthropic-ratelimit-unified-* headers — that stream
  // IS the Accounts tab's live data. Without this entry notifyOperatorStateSync
  // early-returns on every saveAccountPool write, so a left-open tab never learns
  // the numbers moved and only refreshes on the handful of explicit
  // notifySyncInvalidate('accounts.pool') action callsites (register / remove /
  // reset-rate / probe-capacity) or on remount. Reported by the owner as "the
  // accounts tab stopped updating". The sibling override entry above had the
  // mapping; the pool never did.
  operator_account_pool: ['accounts.pool'],
  operator_standing_candidates: ['operatorStandingApprovals.byWorkspace'],
  // WI-2145092: the workspace work-scope policy lives under this row's `workScope` key.
  // The /admin/work-scope pane reads workScope.policy and must learn a set/clear
  // (workspace:work_scope or POST /api/work-scope/*) without a remount.
  operator_pot_control_policy: ['workScope.policy', 'potIntegration.createQuestion'],
};

async function notifyOperatorStateSync(table: StateTable): Promise<void> {
  const names = OPERATOR_STATE_SYNC_NAMES[table];
  if (!names?.length) return;
  try {
    const { notifySyncInvalidate } = await import('./sync-sse');
    await Promise.all(names.map((name) => notifySyncInvalidate(name, {})));
  } catch { /* the PG trigger remains the out-of-process guard */ }
}

/**
 * Read the single row for the active workspace, or null if missing.
 * Callers cast the JSONB payload to their module's type. For tables in
 * ENCRYPTED_TABLES, decrypts payload_ct on the fly.
 */
export async function readOperatorState<T>(
  table: StateTable,
  wsOverride?: string,
  opts?: { fresh?: boolean },
): Promise<T | null> {
  const { sql } = getOrgPg();
  const ws = wsOverride ?? activeWorkspaceId();

  // P-004: serve hot read-mostly tables (the allowlist — harness_registry) from a
  // tiny TTL cache. Same-process writes invalidate the entry (below), so a
  // write-then-read here is never stale; cross-process staleness is bounded by the TTL.
  //
  // WI-1378 (federation roster-empty, no-restart path): a correctness-critical caller
  // may pass { fresh:true } to BYPASS the cache READ (it still refreshes the entry
  // below).
  //
  // ⚠ REACHABILITY (EI-18719279795236712, 2026-07-26): the cross-process framing below
  // is the SUBSTRATE_SIDECAR-ON topology, NOT what runs today — that flag is DARK
  // (KNOWN_DARK_FLAGS case:'incomplete', WI-1994; WI-604 deprecated, sidecar never
  // built out). Verified on the live rig 2026-07-26: no substrate-sidecar process
  // exists, so this is ONE process and the same-process invalidation DOES reach here.
  // True when written (WI-1378, 2026-07-01) — inside the 2026-06-29 → 2026-07-05 window
  // where the P-011 inversion made the flag silently default-ON — and falsified on
  // 2026-07-05 by WI-1994 restoring OFF. `fresh:true` is correct either way, so the
  // code is unchanged; see hive-federation.ts joinerPotHomeSlug for the long form.
  //
  // WHEN SUBSTRATE_SIDECAR IS ON: the joiner hive-home resolve (boot.ts
  // resolveHiveHomeProjectionSlug) runs on the in-place rekey INSIDE the substrate
  // SIDECAR process, a DIFFERENT process from the join-hive registry write — so the
  // writer's same-process cache invalidation never reached this process. A warm-stale
  // harness_registry entry made joinerPotHomeSlug return null at rekey → the rebind
  // block skipped → forceReFold never fired → the hive_members/hive_settings
  // projections stayed bound to the MEMBER slug → the owner's roster rows dropped
  // forever (empty until a restart cold-read fresh). A fresh read sees the committed
  // remote_hive/hive_slug (join-hive awaits the mutateRegistry commit before the rekey
  // RPC). The hot loadHarnessRegistry path does NOT pass fresh, so its cache win stands.
  const ttl = CACHEABLE_STATE_TABLES.has(table) ? opStateCacheTtlMs() : 0;
  if (ttl > 0 && !opts?.fresh) {
    const hit = opStateCacheMap().get(opStateCacheKey(table, ws));
    if (hit && Date.now() - hit.at < ttl) return hit.value as T | null;
  }

  let result: T | null;
  if (ENCRYPTED_TABLES.has(table)) {
    const key = getDbEncryptionKey();
    // Read-only SELECT — re-issued on pool starvation (see READ_RETRY / isRetriablePgReadError).
    const rows = await withPgRetry(
      () => sql<{ plaintext: T | null }[]>`
      SELECT
        CASE
          WHEN payload_ct IS NOT NULL
            THEN pgp_sym_decrypt(payload_ct, ${key})::jsonb
          ELSE payload
        END AS plaintext
      FROM ${sql(`harness_shared.${table}`)}
       WHERE workspace_id = ${ws}
    `,
      READ_RETRY,
    );
    result = rows.length > 0 ? (rows[0].plaintext ?? null) : null;
  } else {
    const rows = await withPgRetry(
      () => sql<{ payload: T }[]>`
      SELECT payload FROM ${sql(`harness_shared.${table}`)}
       WHERE workspace_id = ${ws}
    `,
      READ_RETRY,
    );
    result = rows.length > 0 ? rows[0].payload : null;
  }

  if (ttl > 0) opStateCacheMap().set(opStateCacheKey(table, ws), { value: result, at: Date.now() });
  return result;
}

/** Upsert the single row for the active workspace. */
export async function writeOperatorState<T>(
  table: StateTable,
  payload: T,
  wsOverride?: string,
): Promise<void> {
  const { sql } = getOrgPg();
  const ws = wsOverride ?? activeWorkspaceId();
  const now = Date.now();

  if (ENCRYPTED_TABLES.has(table)) {
    const key = getDbEncryptionKey();
    const text = JSON.stringify(payload);
    // payload column kept-null on writes; future migration drops it.
    await sql`
      INSERT INTO ${sql(`harness_shared.${table}`)}
        (workspace_id, payload, payload_ct, updated_at)
      VALUES (
        ${ws},
        '{}'::jsonb,
        pgp_sym_encrypt(${text}, ${key}),
        ${now}
      )
      ON CONFLICT (workspace_id) DO UPDATE
        SET payload = '{}'::jsonb,
            payload_ct = EXCLUDED.payload_ct,
            updated_at = EXCLUDED.updated_at
    `;
    invalidateOperatorStateCache(table, ws); // P-004: same-process read-after-write consistency
    await notifyOperatorStateSync(table);
    return;
  }

  const written = await sql`
    INSERT INTO ${sql(`harness_shared.${table}`)}
      (workspace_id, payload, updated_at)
    VALUES (${ws}, ${JSON.stringify(payload)}::text::jsonb, ${now})
    ON CONFLICT (workspace_id) DO UPDATE
      SET payload = EXCLUDED.payload,
          updated_at = EXCLUDED.updated_at
    WHERE ${table !== 'operator_account_pool'} OR ${sql(`harness_shared.${table}`)}.payload IS DISTINCT FROM EXCLUDED.payload
    RETURNING workspace_id
  `;
  invalidateOperatorStateCache(table, ws); // P-004: same-process read-after-write consistency
  if (table !== 'operator_account_pool' || written.length > 0) await notifyOperatorStateSync(table);
}

/**
 * Read-modify-write atomically inside a single PG round-trip. Avoids the
 * multi-tab race condition of the file-backed approach.
 *
 * The mutator runs inside a transaction; if two tabs call this
 * concurrently, the second one sees the first's committed value as input.
 *
 * Encrypted tables: decrypt → mutate → re-encrypt happens inside the same
 * transaction so the row stays consistent.
 *
 * ⚠ The mutator MUST be pure + synchronous. It runs while this workspace's row is
 * held under `FOR UPDATE`, so every concurrent writer of the same row is blocked
 * for its duration — awaiting IO in there converts a microsecond lock into a
 * request-latency-long one, and (worse) invites a lock-ordering deadlock.
 *
 * WI-38164: the row is INSERTed-if-missing BEFORE the `SELECT … FOR UPDATE`.
 * Without that, the very first write to a workspace locks NOTHING (there is no row
 * to lock), so two concurrent first-writers both read `defaultValue`, both mutate
 * from empty, and the second `ON CONFLICT DO UPDATE` silently discards the first —
 * the same lost-update this function exists to prevent, only at row birth. The
 * pre-insert is `DO NOTHING`, so the loser of that race simply blocks and then
 * reads the winner's row like any other concurrent caller.
 */
export async function updateOperatorState<T>(
  table: StateTable,
  defaultValue: T,
  mutator: (current: T) => T,
  wsOverride?: string,
): Promise<T> {
  const { sql } = getOrgPg();
  const ws = wsOverride ?? activeWorkspaceId();
  const isEncrypted = ENCRYPTED_TABLES.has(table);
  const key = isEncrypted ? getDbEncryptionKey() : null;
  let changed = true;

  const updated = (await sql.begin(async (tx) => {
    // Materialize the row so the FOR UPDATE below has something to lock (see the
    // doc comment). An existing row is untouched by DO NOTHING.
    await tx`
      INSERT INTO ${tx(`harness_shared.${table}`)} (workspace_id, payload, updated_at)
      VALUES (${ws}, '{}'::jsonb, 0)
      ON CONFLICT (workspace_id) DO NOTHING
    `;
    let current: T;
    if (isEncrypted && key !== null) {
      const rows = await tx<{ plaintext: T | null }[]>`
        SELECT
          CASE
            WHEN payload_ct IS NOT NULL
              THEN pgp_sym_decrypt(payload_ct, ${key})::jsonb
            ELSE payload
          END AS plaintext
        FROM ${tx(`harness_shared.${table}`)}
         WHERE workspace_id = ${ws}
         FOR UPDATE
      `;
      current = rows.length > 0 ? (rows[0].plaintext ?? defaultValue) : defaultValue;
    } else {
      const rows = await tx<{ payload: T }[]>`
        SELECT payload FROM ${tx(`harness_shared.${table}`)}
         WHERE workspace_id = ${ws}
         FOR UPDATE
      `;
      current = rows.length > 0 ? rows[0].payload : defaultValue;
    }

    const next = mutator(current);

    if (isEncrypted && key !== null) {
      const text = JSON.stringify(next);
      await tx`
        INSERT INTO ${tx(`harness_shared.${table}`)}
          (workspace_id, payload, payload_ct, updated_at)
        VALUES (
          ${ws},
          '{}'::jsonb,
          pgp_sym_encrypt(${text}, ${key}),
          ${Date.now()}
        )
        ON CONFLICT (workspace_id) DO UPDATE
          SET payload = '{}'::jsonb,
              payload_ct = EXCLUDED.payload_ct,
              updated_at = EXCLUDED.updated_at
      `;
    } else {
      // Account writers may return an unchanged (but rebuilt/normalized) pool.
      // Compare JSONB under the existing row lock, so key order and in-place
      // mutators are handled without dropping concurrent membership changes.
      const written = await tx`
        INSERT INTO ${tx(`harness_shared.${table}`)}
          (workspace_id, payload, updated_at)
        VALUES (${ws}, ${JSON.stringify(next)}::text::jsonb, ${Date.now()})
        ON CONFLICT (workspace_id) DO UPDATE
          SET payload = EXCLUDED.payload,
              updated_at = EXCLUDED.updated_at
        WHERE ${table !== 'operator_account_pool'} OR ${tx(`harness_shared.${table}`)}.payload IS DISTINCT FROM EXCLUDED.payload
        RETURNING workspace_id
      `;
      changed = table !== 'operator_account_pool' || written.length > 0;
    }
    return next;
  })) as T;
  invalidateOperatorStateCache(table, ws); // P-004: same-process read-after-write consistency
  if (changed) await notifyOperatorStateSync(table);
  return updated;
}
