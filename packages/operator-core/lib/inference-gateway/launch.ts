/**
 * Compose + run the hive inference gateway as a supervised service (hive-inference-gateway P-013).
 *
 * Wires the pieces: resolve the machine's bound account (account-pool) → a refresh-owning
 * credential resolver (P-003) → the pacing proxy (P-006/P-007/P-011) → the account-pool
 * projection feed on pause (P-009, record-only — the operator owns provisioning). The bees point
 * `ANTHROPIC_BASE_URL` at this localhost port, so if the service is DOWN their requests fail
 * (connection refused) rather than silently bursting direct to Anthropic — the fail-CLOSED
 * property (the systemd unit's `Restart=always` keeps it up).
 *
 * Deps are injectable so the composition is hermetically testable without PG / `~/.claude`.
 */
import { resolveAccountPool, type ResolvedAccount } from './account-resolver';
import { CODEX_CLI_REF_PREFIX, parseCodexCliRef, type CodexCliAccount } from './codex-cli-bridge';
import { codexRateLimitBucket, parseCodexRateLimitHeaders } from './codex-oauth-proxy';
import { makeBearerCredentialResolver, makeCredentialResolver, type CredentialResolver } from './credential-store';
import { createFailoverPool, type FailoverPoolOptions } from './account-failover';
import { recordDbOutcome, setDbHealthTransitionHandler, type DbHealthSnapshot } from './db-health';
import {
  formatAtRiskAlertSuffix,
  buildSelfDrainWake,
  formatOrphanedClaimsSuffix,
  type OrphanedClaim,
} from './affected-owners';
import {
  createInferenceGateway,
  parseUnifiedWindow,
  parseUnified7dWindow,
  serviceableAdmissionFor,
  type InferenceGateway,
} from './gateway';
import { INITIAL_PROVIDER_ADMISSION_WINDOW } from './provider-admission-lifecycle';
import { reportRetiredCapacityEnv } from './retired-capacity-env';
import {
  createDurableGatewayAdmissionGovernor,
  type DurableGatewayAdmissionOptions,
} from './durable-admission';
import {
  createGatewayPayloadSpool,
  DEFAULT_PAYLOAD_SPOOL_SWEEP_LIMIT,
  type GatewayPayloadSpool,
  type GatewayPayloadSpoolOptions,
  type PgGatewayPayloadStoreOptions,
} from './payload-spool';
import type { AccountPool, ActiveAccount } from './provider-contracts';
import { createLocalBackendPool, type LocalBackend, type LocalBackendPool } from './local-backend-pool';
import type { LocalBackendRecord } from './local-backend-store';
import {
  parsePriorityTierMap,
  tiersOfMap,
  defaultTierCaps,
  DEFAULT_GATEWAY_PRIORITY_MAP,
  type PriorityTierMap,
  type TierAdmissionConfig,
} from '@papercusp/papercusp-shared/agent';
import { trackDetached } from '../detached-imports';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { EXTERNAL_SCHEDULES } from '../schedule-descriptors.mjs';

/** Default localhost port for the gateway (not one of the dev stack's ports). */
export const DEFAULT_GATEWAY_PORT = 8788;
/** Payload-spool GC runs once a minute so its bounded batch keeps up with bursty ingest. */
export const DEFAULT_PAYLOAD_SPOOL_SWEEP_INTERVAL_MS = 60_000;
/** Reserved-floor fraction of the admission pool held for tier 1 (gateway-priority-tiers-2026-06-22).
 *  `reserve = max(1, ceil(poolSlots * frac))`. Env-tunable via `GATEWAY_T1_RESERVE_FRAC`. */
export const DEFAULT_T1_RESERVE_FRAC = 0.15;

/**
 * How long the gateway waits for a cold-started on-demand backend to answer `/health`
 * (P-008/D-006/D-009). `ensureLocalBackendRunning` deliberately has NO default for this, so the
 * caller that starts backends has to state a figure — this is that statement.
 *
 * ✅ MEASURED 2026-08-17 (D-006 discharged; see D-011/D-012 for how the measurement was unblocked).
 * `llama-ornith.service` — 15.5GB IQ3_M blob, 2 slots x 90112 ctx, RTX 3090 — cold-started to a
 * 200 on `/health` in **67.5s**, with GPU memory moving 4448 -> 21754 MiB (+17.3GB) and the
 * process RSS settling at 1.2GB. (The original 300s default was ~4.4x that figure.)
 *
 * ✅ DISK-COLD MEASURED 2026-10-06 (WI-10006503, reboot-residue R-002 live probe): the same unit,
 * same blob, started on demand from idle in normal operation, logged `model loaded` at **261s**
 * and **304s** on two cold starts (and 63s on a warm-page-cache one). 304s is past the old 300s
 * budget, so the gateway returned 502 to the request that triggered the start while the load
 * was still progressing. The value below is ~3x the measured disk-cold worst case; the guard in
 * on-demand-start.test.ts fails if it is ever set below 2x it.
 *
 * ⚠ READ WHAT THE 67.5s ACTUALLY MEASURES BEFORE TIGHTENING IT. That run had the weights already
 * in the PAGE CACHE (an accidental CPU-only start minutes earlier had just read all 15.5GB into
 * RAM), so it is a warm-page-cache figure and a genuinely disk-cold start is strictly slower —
 * bounded below by the time to read 15.5GB off this box's storage. It was not measured with caches
 * dropped, because that needs root and would evict every other agent's working set. So 67.5s is a
 * FLOOR on the cold path, not the worst case, and the headroom below is not slack to reclaim.
 *
 * The asymmetry that sets the margin is unchanged: overshooting costs only a slow FIRST request on
 * an already-idle backend, while undershooting abandons a load that is still progressing (the seam
 * leaves the unit RUNNING on timeout, so the next request usually finds it warm). The failure is
 * soft in one direction only, and this box routinely sits at load avg ~70-80 under memory
 * pressure — exactly when a cold start is slowest.
 */
export const LOCAL_BACKEND_COLD_START_TIMEOUT_MS =
  Number(process.env.PAPERCUSP_GATEWAY_LOCAL_BACKEND_COLD_START_TIMEOUT_MS) || 900_000;

/** Disk-cold load time of the slowest measured on-demand backend (llama-ornith, 2026-10-06). */
export const LOCAL_BACKEND_MEASURED_DISK_COLD_START_MS = 304_000;

/**
 * Resolve the priority-TIER admission config (gateway-priority-tiers-2026-06-22), flag-gated by
 * `GATEWAY_PRIORITY_TIERS`. Returns `null` when the flag is OFF (the gateway then runs its flat
 * priority+aging queue, byte-identical to today). When ON, builds the role→tier map (defaults merged
 * with the `GATEWAY_PRIORITY_MAP` JSON env), the per-tier in-flight caps + the reserved tier-1 floor
 * (`max(1, ceil(poolSlots * GATEWAY_T1_RESERVE_FRAC))`) sized to `poolSlots` (the admission concurrency).
 * Pure-ish: the only side effect is the flag read; env parsing is the resilience lib's pure helpers.
 */
export async function resolvePriorityTiers(
  poolSlots: number,
  opts: { flagOverride?: boolean; env?: NodeJS.ProcessEnv } = {},
): Promise<{ map: PriorityTierMap; config: TierAdmissionConfig } | null> {
  let on = opts.flagOverride;
  if (on === undefined) {
    const { getFlag } = await import('@papercusp/flags/server');
    const { FLAGS } = await import('@papercusp/flags');
    on = await getFlag(FLAGS.GATEWAY_PRIORITY_TIERS, 'system');
  }
  if (!on) return null;
  const env = opts.env ?? process.env;
  const map = parsePriorityTierMap(env.GATEWAY_PRIORITY_MAP, DEFAULT_GATEWAY_PRIORITY_MAP);
  const fracRaw = Number(env.GATEWAY_T1_RESERVE_FRAC);
  const frac = Number.isFinite(fracRaw) && fracRaw >= 0 ? fracRaw : DEFAULT_T1_RESERVE_FRAC;
  const tiers = tiersOfMap(map);
  const { caps, reserve } = defaultTierCaps(poolSlots, tiers, frac);
  // Pass the fraction ITSELF, not just the absolute it produced: the queue rescales the reserve on
  // every AIMD change and would otherwise re-derive the fraction as reserve/poolSlots — which at
  // this seed window (8) is ceil(8*0.15)/8 = 0.25, not the 0.15 configured here (EI-21833234632961797).
  return { map, config: { caps, tier1Reserve: reserve, reserveFrac: frac } };
}

export interface GatewayServiceOptions {
  port?: number;
  workspace?: string;
  concurrency?: number;
  /* RETIRED by P-010: no Codex-only admission size. Removed from the options
   * surface so no deployment path can reinstate a Codex-specific ceiling. */
  upstreamBase?: string;
  /** Proactively refresh the bound token on this interval (ms). 0 = on-demand only. Default 45 min. */
  refreshIntervalMs?: number;
  /** Poll interval (ms) to HOT-RELOAD the DB account pool into the live failover pool WITHOUT a restart
   *  (B-HOT-1). 0 = disabled. Default 60s. Tests inject a tiny value (or 0) to control it. */
  poolReloadIntervalMs?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  /** Environment to read DEPLOYMENT-level inputs from. Defaults to `process.env`. Injected rather
   *  than read globally so the P-012 retired-capacity readback can be exercised without mutating
   *  process.env under a parallel test run. */
  env?: NodeJS.ProcessEnv;
  // ── injectable for tests ──
  /** Resolve a SINGLE bound account (back-compat). When set, takes precedence over resolveAccounts
   *  and yields a one-account, no-failover pool. */
  resolveAccount?: (ws?: string) => Promise<ResolvedAccount>;
  /** Resolve the full failover pool (EI-535). Default: resolveAccountPool. */
  resolveAccounts?: (ws?: string, provider?: 'claude' | 'codex') => Promise<ResolvedAccount[]>;
  makeResolver?: (credentialRef: string, accountId: string) => CredentialResolver;
  /** Subscribe the account-pool projection feed; returns an unsubscribe. Default: initAccountScaleObserver (record-only). */
  observePool?: (accountId: string, ws: string | undefined, log: GatewayServiceOptions['log']) => () => void;
  fetchImpl?: typeof fetch;
  /** Resolve the local inference-backend registry (llama-server/vllm/ollama pool,
   *  local-concurrent-inference-2026-07-02 P-004). Default: lazy-imports
   *  local-backend-store's listLocalBackends (kept lazy so a test that injects this option, or a
   *  deployment that never registers a local backend, never touches PG for it). */
  resolveLocalBackends?: (ws?: string) => Promise<LocalBackendRecord[]>;
  /** Poll interval (ms) to hot-reload the local-backend registry + run its health checks. 0 disables.
   *  Default 30s — independent of poolReloadIntervalMs (local backends are cheaper to re-check and a
   *  dead local process should drop out of rotation fast). */
  localBackendReloadIntervalMs?: number;
  /**
   * Use the canonical durable work-item admission queue for gateway requests.
   * Production's sidecar entrypoint enables this explicitly; direct/unit
   * callers retain the in-memory compatibility queue unless opted in.
   */
  durableAdmission?: boolean | Omit<DurableGatewayAdmissionOptions, 'workspaceId'>;
  /**
   * PRE-ACCEPTANCE request-body spool (D-004/D-011).
   *
   * DEFAULTS TO `durableAdmission`, and that coupling is deliberate rather than a convenience: a
   * durable receipt whose body was never spooled cannot satisfy D-004's "restart/failover preserves
   * accepted work" — after a restart the receipt would name a request whose bytes died with the
   * socket. Enabling the durable queue without the spool produces receipts the gateway cannot
   * honour, so the two travel together unless a caller explicitly says otherwise.
   *
   * Pass `false` to run the durable queue without spooling (a test seam), or an options object to
   * tune the ceiling / TTL.
   */
  payloadSpool?:
    | boolean
    | GatewayPayloadSpool
    | Omit<GatewayPayloadSpoolOptions & PgGatewayPayloadStoreOptions, 'workspaceId'>;
  /** Lifecycle sweep interval for the durable payload spool. 0 disables the timer. */
  payloadSpoolSweepIntervalMs?: number;
  /** Maximum rows reclaimed by one payload-spool lifecycle sweep. */
  payloadSpoolSweepLimit?: number;
}

export interface RunningGatewayService {
  gateway: InferenceGateway;
  port: number;
  account: ResolvedAccount;
  /** Current account-pool config version — bumps on each successful hot-reload (B-HOT-1). */
  configVersion(): number;
  /** Hot-reload the account pool from the DB source-of-truth WITHOUT a restart. No-op if unchanged or
   *  not hot-reloadable. Returns whether it changed + the new version + the live account ids. */
  reloadPool(): Promise<{ changed: boolean; version: number; accounts: string[] }>;
  stop(): Promise<void>;
}

/** Default pool-feed: record each pause into the account-pool projection (PG) so the operator's
    scale-out + accounts:status see a gateway-paced account's exhaustion; provisioning stays the
    operator's job (record-only scaleOut). */
function defaultObservePool(_accountId: string, ws: string | undefined, log: GatewayServiceOptions['log']): () => void {
  // Lazy import to keep the gateway bin's cold-start light + avoid a PG import in tests that inject.
  let unsub = () => {};
  void trackDetached(import('../deployment/account-pool-store'))
    .then(({ initAccountScaleObserver }) => {
      unsub = initAccountScaleObserver({
        workspaceId: ws ? () => ws : undefined,
        scaleOut: async () => ({ scaledOut: false as const, reason: 'no-fresh-account' as const }),
        log: log ? (lvl, m) => log(lvl, m) : undefined,
        // EI-19303809952284205: report ONLY the penalty read-modify-write's DB outcome, not the whole
        // observer's. A scale-out that declines (no fresh account, policy off) is not a DB fault, and
        // attributing it to one would fabricate a gateway-DB alarm out of normal operation.
        onDbOutcome: (ok, err) => recordDbOutcome('scale-observer', ok, err),
      });
    })
    .catch((e) => log?.('warn', `pool-feed observer not wired: ${(e as Error).message}`));
  return () => unsub();
}

/**
 * Build the gateway `onResponse` hook that feeds each upstream response's unified-5h budget window
 * (utilization + reset) into the account-pool projection (D-003). The gateway is the ONLY process
 * that sees these headers, so this is how the spawn-side drain selector (`selectAccountForSpawn`)
 * gets real cross-process budget. Throttled: ≤1 PG write / 30s / account, and only on a meaningful
 * utilization move (≥0.03) or a window-reset roll — the projection is low-churn, the gateway hot.
 */
function makeWindowProjector(
  ws: string | undefined,
  log: (level: 'info' | 'warn' | 'error', msg: string) => void,
): (headers: Record<string, string | undefined>, status: number, model: string, accountId: string) => void {
  const WRITE_MIN_MS = 30_000;
  const last = new Map<string, { util: number; resetAt: number; util7d: number; resetAt7d: number; at: number; usageCreditsAvailable?: boolean }>();
  return (headers, status, model, accountId) => {
    const observedCredits = parseCodexRateLimitHeaders(headers).usageCreditsAvailable;
    const usageCreditsAvailable = status === 429 ? false : observedCredits;
    let w = parseUnifiedWindow(headers);
    let w7 = parseUnified7dWindow(headers);
    if (
      w.utilization === undefined &&
      w.windowResetAt === undefined &&
      w7.utilization7d === undefined &&
      w7.windowResetAt7d === undefined
    ) {
      // WI-38582: not the Anthropic dialect — try the ChatGPT codex backend's
      // x-codex-* headers (the codex OAuth proxy feeds this same hook), so codex
      // accounts stop reading `never-observed` forever.
      const cw = parseCodexRateLimitHeaders(headers);
      w = { utilization: cw.utilization, windowResetAt: cw.windowResetAt };
      w7 = { utilization7d: cw.utilization7d, windowResetAt7d: cw.windowResetAt7d };
    }
    if (
      w.utilization === undefined &&
      w.windowResetAt === undefined &&
      w7.utilization7d === undefined &&
      w7.windowResetAt7d === undefined &&
      usageCreditsAvailable === undefined
    )
      return;
    const t = Date.now();
    // Generic premium and Luna reserve headers can arrive back-to-back during a
    // reactive reserve retry. Keep independent throttle slots so the reserve
    // reading is not discarded as a duplicate of the preceding premium 429.
    const hasAnthropic = Object.keys(headers).some((key) => key.toLowerCase().startsWith('anthropic-ratelimit-unified-'));
    const bucket = hasAnthropic ? 'anthropic' : codexRateLimitBucket(headers);
    if (bucket === 'base_model_inference') {
      // EI-22103680502746318: the Luna reserve tier is a DIFFERENT meter from the premium weekly/5h
      // windows this projection describes. Writing its (small) utilization into `rate.utilization[7d]`
      // un-walls a weekly-exhausted account, the failover pool routes premium traffic onto it, and the
      // next premium 429 re-walls it — a burn-governor fact assert/retract + fleet broadcast per flip.
      // Observe it (throttled) but never project it.
      const skipKey = `${accountId}:reserve-not-projected`;
      const seen = last.get(skipKey);
      if (!seen || t - seen.at >= WRITE_MIN_MS * 10) {
        last.set(skipKey, { util: w.utilization ?? 0, resetAt: 0, util7d: w7.utilization7d ?? 0, resetAt7d: 0, at: t });
        log(
          'info',
          `inference-gateway: '${accountId}' reserve-meter (base_model_inference) reading util=${w.utilization ?? '-'} util7d=${w7.utilization7d ?? '-'} NOT projected — the premium meter is unchanged`,
        );
      }
      return;
    }
    const modelKey = model.trim().toLowerCase() || 'unknown';
    const projectionKey = `${accountId}:${bucket}:${modelKey}`;
    const prev = last.get(projectionKey);
    const util = w.utilization ?? prev?.util ?? 0;
    const resetAt = w.windowResetAt ?? prev?.resetAt ?? 0;
    const util7d = w7.utilization7d ?? prev?.util7d ?? 0;
    const resetAt7d = w7.windowResetAt7d ?? prev?.resetAt7d ?? 0;
    const creditChanged = usageCreditsAvailable !== undefined && usageCreditsAvailable !== prev?.usageCreditsAvailable;
    if (prev && t - prev.at < WRITE_MIN_MS && !creditChanged) return; // throttle ordinary meter updates
    // Write on a meaningful move in EITHER window (≥0.03 utilization) or a reset roll.
    const significant =
      !prev ||
      Math.abs(util - prev.util) >= 0.03 ||
      resetAt !== prev.resetAt ||
      Math.abs(util7d - prev.util7d) >= 0.03 ||
      resetAt7d !== prev.resetAt7d ||
      creditChanged ||
      usageCreditsAvailable !== undefined;
    if (!significant) return;
    last.set(projectionKey, { util, resetAt, util7d, resetAt7d, at: t, usageCreditsAvailable: usageCreditsAvailable ?? prev?.usageCreditsAvailable });
    // WI-41147 leg c: the shared write-seam wrapper — records the window AND states any
    // burn-verdict wall the fresh reading implies (fact + severe-event on the transition
    // edge). Live traffic is the most frequent observer, so this is where an escalation
    // usually becomes visible first — it must not be silent here.
    void trackDetached(import('./burn-alert'))
      .then(({ recordAccountWindowWithBurnAlert }) =>
        recordAccountWindowWithBurnAlert(
          accountId,
          {
            utilization: w.utilization,
            windowResetAt: w.windowResetAt,
            utilization7d: w7.utilization7d,
            windowResetAt7d: w7.windowResetAt7d,
            usageCreditsAvailable,
          },
          t,
          ws,
        ),
      )
      // EI-19303809952284205: this write IS the Accounts tab's live data, and its failure was silent
      // for hours. Record BOTH outcomes — the success is what clears a streak, so recording only
      // failures would latch the alarm on after a single transient blip.
      .then(() => recordDbOutcome('window-projection', true))
      .catch((e) => {
        recordDbOutcome('window-projection', false, e);
        log('warn', `account window projection write failed for '${accountId}': ${(e as Error).message}`);
      });
  };
}

/**
 * Build the gateway `onCredentialDead` side-channel (#5 PART A). The gateway calls this FIRE-AND-FORGET the
 * first time an account's credential 401s past the dead threshold despite the drop+refresh — i.e. a genuinely
 * DEAD/expired credential silently breaking spawns/evals. We surface it LOUDLY: a durable human-facing
 * escalation (severity 'blocker', tagged `source: 'credential-health'` so the open is TRANSITION-ONLY —
 * idempotent across the whole dead episode, not re-opened every 401 request) + a fleet broadcast.
 *
 * The escalation is per-ACCOUNT-keyed (`meta.deadAccountId`) so two different dead credentials each get their
 * own alert, and a second dead credential isn't swallowed by the first account's still-open escalation. The
 * gateway clears the per-account streak on the next successful auth (a 2xx); a LATER episode on the same
 * account re-fires only after a fresh streak crosses the threshold again — but if the prior escalation is still
 * open (nobody resolved it) we don't pile a duplicate on top. Best-effort: every import/IO failure is swallowed
 * (it must never throw back into the gateway's fire-and-forget call).
 */
function makeCredentialHealthAlert(
  ws: string | undefined,
  log: (level: 'info' | 'warn' | 'error', msg: string) => void,
): (info: { accountId: string; consecutive401s: number }) => void {
  const identity = { ownerId: 'inference-gateway', ownerLabel: 'inference-gateway', source: 'static-client' as const, workspaceId: ws ?? null, userId: null };
  return ({ accountId, consecutive401s }) => {
    void (async () => {
      const summary = `Inference credential for account '${accountId}' is DEAD — ${consecutive401s} consecutive 401s despite token refresh; spawns/evals on it will fail "produced no turn"`;
      const body =
        `The inference gateway dropped + refreshed account '${accountId}'s OAuth token after each 401, but the refresh keeps yielding the same invalid credential — so it is genuinely dead/expired (revoked, or its refresh token is bad), not merely stale-cached. ` +
        `Re-authenticate or replace the credential (accounts:* / re-login) and the gateway's next successful 2xx for this account clears the alert state. Routing has already failed this account over to a healthy account where one exists.`;
      // Durable, transition-only escalation (idempotent per dead account).
      try {
        const { openEscalation, listEscalations } = await import('../agent-tools/coordination/escalations');
        const open = await listEscalations({ status: 'open' });
        const already = open.some(
          (e) =>
            (e as Record<string, unknown>).source === 'credential-health' &&
            (e as Record<string, unknown>).deadAccountId === accountId,
        );
        if (!already) {
          await openEscalation(identity, {
            severity: 'blocker',
            summary,
            body,
            // EI-21843060786178076 audit: the `already` check above is a read-then-write race —
            // narrow, but not atomic. Pin the same entity onto a stable subjectSignature too, so
            // even a raced double-fire coalesces through openEscalation's own PG-advisory-lock
            // dedup path instead of leaking a duplicate escalation.
            meta: {
              source: 'credential-health',
              deadAccountId: accountId,
              consecutive401s,
              subjectSignature: `inference-gateway:credential-health:${accountId}`,
            },
          });
        }
      } catch (e) {
        log('warn', `credential-health escalation failed for '${accountId}': ${(e as Error).message}`);
      }
      // Loud fleet broadcast (best-effort, independent of the escalation).
      try {
        const { sendMessage } = await import('../agent-tools/coordination/messages');
        await sendMessage(identity, { to: ['*'], summary, body, category: 'service-health' });
      } catch (e) {
        log('warn', `credential-health broadcast failed for '${accountId}': ${(e as Error).message}`);
      }
    })();
  };
}

/**
 * Build the gateway's DB-HEALTH transition handler (EI-19303809952284205). Fired ONCE per episode by
 * db-health.ts when the durable side-paths cross from healthy → sustained-failing (and once again on
 * recovery) — never per failed write, so a flapping reconnect cannot spam the fleet.
 *
 * Deliberately the SAME shape as `makeCredentialHealthAlert` above: a durable transition-only
 * escalation (idempotent across the whole episode via `source: 'gateway-db-health'`, so an
 * already-open alert is never piled on) plus a fleet broadcast, everything fire-and-forget and
 * every IO failure swallowed — this is called from inside the gateway's own `.catch()` handlers and
 * must never throw back into them.
 *
 * The recovery leg RESOLVES the open escalation rather than opening a second one: the 2026-08-01
 * incident's whole shape was "nobody noticed for hours", and an alert that cannot close itself
 * becomes noise that trains the reader to ignore it (the EI-2146 lesson from liveness-alarm).
 */
function makeDbHealthAlert(
  ws: string | undefined,
  log: (level: 'info' | 'warn' | 'error', msg: string) => void,
): (event: { healthy: boolean; snapshot: DbHealthSnapshot }) => void {
  const identity = { ownerId: 'inference-gateway', ownerLabel: 'inference-gateway', source: 'static-client' as const, workspaceId: ws ?? null, userId: null };
  const SOURCE = 'gateway-db-health';
  return ({ healthy, snapshot }) => {
    void (async () => {
      const ops = snapshot.failingOps.join(', ') || 'unknown';
      const mins = snapshot.unhealthyForMs === null ? 0 : Math.round(snapshot.unhealthyForMs / 60_000);
      const summary = healthy
        ? `Inference gateway REGAINED its database — durable account writes are landing again`
        : `Inference gateway has LOST its database — ${ops} failing for ${mins}m; account usage-window writes are being dropped`;
      const body = healthy
        ? `The gateway's durable side-paths (usage-window projection / pool reload / rate hints / scale observer) are succeeding again. /healthz is back to 200.`
        : `The gateway is still serving traffic, but every durable write is failing (${ops}; last error: ${snapshot.lastError ?? 'unknown'}). ` +
          `While this persists: account usage-window observations are DROPPED (the Accounts tab freezes at its last reading), the account pool ` +
          `cannot be reloaded (the gateway falls back to a single synthetic credential and IGNORES every account pin, reporting healthyAccounts: 0), ` +
          `and auto-scale-out is inert. ` +
          (snapshot.connectionLevel
            ? `The errors are connection-level, so the database is UNREACHABLE from this process — most likely a cached-at-boot Postgres port that no longer exists (see endStalePool, EI-19285027465993737: a long-lived process that predates that fix stays wedged until it restarts, and the dead port appears in no config file). Restarting the gateway is the fastest recovery. `
            : `The errors are NOT connection-level — the database is reachable and rejecting these writes, so check permissions/schema before restarting. `) +
          `/healthz now reports ok:false + 503 for as long as this lasts.`;
      // Durable, transition-only escalation (idempotent per episode).
      try {
        const { openEscalation, listEscalations, resolveEscalation } = await import('../agent-tools/coordination/escalations');
        const open = await listEscalations({ status: 'open' });
        const mine = open.filter((e) => (e as Record<string, unknown>).source === SOURCE);
        if (healthy) {
          for (const e of mine) {
            await resolveEscalation({
              msg_id: String((e as Record<string, unknown>).msg_id ?? ''),
              choice: 'recovered',
              note: summary,
              resolver: identity.ownerId,
            });
          }
        } else if (mine.length === 0) {
          await openEscalation(identity, {
            severity: 'blocker',
            summary,
            body,
            // EI-21843060786178076 audit: same read-then-write race as credential-health above —
            // add the stable subjectSignature so a raced double-fire still coalesces atomically.
            // This condition is global (one gateway DB), so the key carries no per-entity suffix.
            meta: {
              source: SOURCE,
              failingOps: snapshot.failingOps,
              connectionLevel: snapshot.connectionLevel,
              lastError: snapshot.lastError,
              subjectSignature: 'inference-gateway:db-health',
            },
          });
        }
      } catch (e) {
        log('warn', `gateway db-health escalation failed: ${(e as Error).message}`);
      }
      // Loud fleet broadcast (best-effort, independent of the escalation) — every agent routing
      // through this gateway is running on ignored account pins while it lasts.
      try {
        const { sendMessage } = await import('../agent-tools/coordination/messages');
        await sendMessage(identity, { to: ['*'], summary, body, category: 'service-health' });
      } catch (e) {
        log('warn', `gateway db-health broadcast failed: ${(e as Error).message}`);
      }
    })();
  };
}

/**
 * Build the gateway `onOrgDisallowed` side-channel. The gateway calls this FIRE-AND-FORGET the first time an
 * account returns a short streak of org/subscription-disqualified 403s ("not allowed for this organization" /
 * "subscription disabled for claude code") — a PERMANENT Anthropic-side disable the 6h in-memory pause can't
 * cure (it resets on every gateway restart, re-exposing the dead account: ownerhandle, 2026-07-01). We PERSISTENTLY
 * remove the account from the pool (survives restarts, never re-selected) + surface a LOUD transition-only
 * escalation + fleet broadcast. Best-effort: every IO failure is swallowed (must never throw into the gateway).
 */
function makeOrgDisallowedDeactivator(
  ws: string | undefined,
  log: (level: 'info' | 'warn' | 'error', msg: string) => void,
): (info: { accountId: string; consecutive: number; affectedOwners?: string[] }) => void {
  const identity = { ownerId: 'inference-gateway', ownerLabel: 'inference-gateway', source: 'static-client' as const, workspaceId: ws ?? null, userId: null };
  return ({ accountId, consecutive, affectedOwners }) => {
    void (async () => {
      // EI-15153 (detector): name the live sessions that were routing through this account when it
      // was disabled — they cannot self-drain (their next inference turn 403s) so their claimed work
      // risks being silently orphaned. The gateway already computed + filtered `affectedOwners` from
      // its per-owner routing ledger; we just render them into the ALREADY-firing escalation +
      // broadcast so the alert says WHO to check. Empty when none → alert unchanged (purely additive).
      const atRiskOwners = affectedOwners ?? [];
      const atRiskSuffix = formatAtRiskAlertSuffix(atRiskOwners);
      // EI-15153 P-004 (surface-only): look up each at-risk owner's still-held,
      // NON-terminal claims so the disable alert hands the leader a CONCRETE reclaim
      // list — faster + more precise than waiting out the periodic stale-claim
      // reaper's grace window (reclaimStaleWorkItemClaims stays the auto-release
      // backstop; we add NO new reaper). Read-only + best-effort: any lookup failure
      // leaves the alert unchanged (empty suffix). The routing-ledger ownerId equals
      // an su session's claim `taken_by`/`assignee`; a spawn-alias holder that doesn't
      // match simply surfaces no claims here — the leader still has the named owner.
      let orphanedClaims: OrphanedClaim[] = [];
      if (atRiskOwners.length > 0) {
        try {
          const [{ listWorkItems }, { WORK_ITEM_NON_REQUEUE_STATES }] = await Promise.all([
            import('../work-items'),
            import('../work-items-stale-claims'),
          ]);
          const terminal = new Set(WORK_ITEM_NON_REQUEUE_STATES);
          orphanedClaims = (
            await Promise.all(
              atRiskOwners.map(async (ownerId) => {
                const held = await listWorkItems({ assignee: ownerId }).catch(() => []);
                const claims = held
                  .filter((i) => !terminal.has(i.state))
                  .map((i) => ({ id: i.id, title: i.title }));
                return { ownerId, claims };
              }),
            )
          ).filter((o) => o.claims.length > 0);
        } catch (e) {
          log('warn', `org-disallowed orphaned-claim lookup for '${accountId}' failed: ${(e as Error).message}`);
        }
      }
      const orphanSuffix = formatOrphanedClaimsSuffix(orphanedClaims);
      const summary = `Inference account '${accountId}' is org/subscription-DISABLED for Claude Code — removed from the pool`;
      const body =
        `Account '${accountId}' returned ${consecutive} consecutive org/subscription-disqualified 403s ("not allowed for this organization" / "subscription disabled for claude code") — a PERMANENT Anthropic-side disable, NOT a rate limit. The gateway's 6h pause only lived in memory + reset on every restart, so the dead account kept re-entering rotation and failing spawns. It has now been PERSISTENTLY removed from the pool. ` +
        `To restore it: re-enable OAuth API / Claude Code access in that account's Anthropic organization, then re-register it (accounts:register).` +
        atRiskSuffix +
        orphanSuffix;
      // 1. PERSISTENTLY remove the dead account (survives gateway/bg-host restarts; the in-memory pause did not).
      try {
        const [{ updateAccountPool }, { removeAccount }] = await Promise.all([
          import('../deployment/account-pool-store'),
          import('../deployment/account-pool'),
        ]);
        // Atomic RMW (WI-38164). A load-then-blind-save here is especially bad: this runs
        // in the GATEWAY process, which is the pool's highest-frequency writer (a usage
        // window per account per 30s), so its snapshot is the one most likely to be
        // flushed over somebody else's registration.
        let removed = false;
        await updateAccountPool((pool) => {
          if (!pool.accounts.some((a) => a.id === accountId)) return pool;
          removed = true;
          return removeAccount(pool, accountId);
        }, ws);
        if (removed) {
          log('error', `inference-gateway: PERSISTENTLY removed org-disabled account '${accountId}' from the pool (${consecutive} consecutive org-disallowed 403s)`);
        }
      } catch (e) {
        log('warn', `org-disallowed persistent removal of '${accountId}' failed: ${(e as Error).message}`);
      }
      // 2. Durable, transition-only escalation (idempotent per dead account).
      try {
        const { openEscalation, listEscalations } = await import('../agent-tools/coordination/escalations');
        const open = await listEscalations({ status: 'open' });
        const already = open.some(
          (e) =>
            (e as Record<string, unknown>).source === 'account-org-disallowed' &&
            (e as Record<string, unknown>).deadAccountId === accountId,
        );
        if (!already) {
          await openEscalation(identity, {
            severity: 'blocker',
            summary,
            body,
            meta: {
              source: 'account-org-disallowed',
              deadAccountId: accountId,
              consecutive,
              atRiskOwners,
              // P-004 (surface-only): the leader's concrete reclaim list, structured.
              orphanedClaims: orphanedClaims.map((o) => ({ ownerId: o.ownerId, claimIds: o.claims.map((c) => c.id) })),
              // EI-21843060786178076 audit: same read-then-write race as credential-health —
              // stable per-account subjectSignature so a raced double-fire still coalesces.
              subjectSignature: `inference-gateway:account-org-disallowed:${accountId}`,
            },
          });
        }
      } catch (e) {
        log('warn', `org-disallowed escalation failed for '${accountId}': ${(e as Error).message}`);
      }
      // 3. Loud fleet broadcast (best-effort, independent of the escalation).
      try {
        const { sendMessage } = await import('../agent-tools/coordination/messages');
        await sendMessage(identity, { to: ['*'], summary, body, category: 'service-health' });
      } catch (e) {
        log('warn', `org-disallowed broadcast failed for '${accountId}': ${(e as Error).message}`);
      }
      // 4. EI-15153 P-003: best-effort DIRECTED self-drain wake to each still-live
      // at-risk session. The dead account was removed in step 1, so a woken session's
      // NEXT inference turn fails over to a HEALTHY account for one final turn — enough
      // to checkpoint its carry-note + release its claims cleanly instead of cold-
      // orphaning them. Directed (NOT the '*' broadcast) + no ambient category so it
      // lands visibly in the recipient's inbox; wakeRecipients re-invokes a sleeping
      // one. Harmless if the session is already dead (wake is a no-op) or cannot take
      // a turn — the detector alert + the periodic stale-claim reaper still cover it.
      const drain = buildSelfDrainWake(accountId, atRiskOwners);
      if (drain) {
        try {
          const { sendMessage } = await import('../agent-tools/coordination/messages');
          await sendMessage(identity, { to: drain.to, summary: drain.summary, body: drain.body });
          const { wakeRecipients } = await import('../agent-tools/coordination/inbox-wake');
          await wakeRecipients(drain.to, { summary: drain.summary, source: 'account-disable-drain', workspaceId: ws });
        } catch (e) {
          log('warn', `org-disallowed self-drain wake failed for '${accountId}': ${(e as Error).message}`);
        }
      }
    })();
  };
}

function createOptionalFailoverPool(
  entries: readonly ActiveAccount[],
  opts: FailoverPoolOptions = {},
): AccountPool {
  let inner: AccountPool | null = entries.length ? createFailoverPool(entries, opts) : null;
  const unavailable = () => new Error('inference-gateway: no Codex account pool configured');
  return {
    active() {
      if (!inner) throw unavailable();
      return inner.active();
    },
    onExhausted(exhaustedId, resetAt) {
      return inner?.onExhausted(exhaustedId, resetAt) ?? null;
    },
    select(accountId) {
      return inner?.select?.(accountId) ?? null;
    },
    readmit(accountId, opts) {
      return inner?.readmit?.(accountId, opts) ?? false;
    },
    parkState(accountId) {
      return inner?.parkState?.(accountId);
    },
    earliestAvailableAt(opts) {
      // An EMPTY pool never recovers on its own: Infinity, never 0, so a ladder consulting the horizon
      // of an unconfigured codex lane fails fast rather than absorbing toward capacity that cannot exist.
      return inner?.earliestAvailableAt?.(opts) ?? Infinity;
    },
    healthyCount(extra) {
      return inner?.healthyCount?.(extra) ?? 0;
    },
    size() {
      return inner?.size?.() ?? 0;
    },
    peek() {
      if (!inner) throw unavailable();
      return inner.peek?.() ?? inner.active();
    },
    entries() {
      return inner?.entries?.() ?? [];
    },
    msSinceReadmit(accountId, nowMs) {
      return inner?.msSinceReadmit?.(accountId, nowMs);
    },
    reload(next) {
      if (next.length === 0) {
        inner = null;
        // WI-3069: this is now only reachable for a genuinely-empty codex config (reloadPool's
        // own empty-resolve fail-safe keeps a transient hiccup from ever calling reload([]) when
        // codexAccounts was previously non-empty) — but the pool going unavailable is worth a
        // 'warn', not an easily-missed 'info' that reads like a routine, successful reload.
        opts.log?.('warn', 'inference-gateway: Codex account pool hot-reloaded to EMPTY — codex is now UNAVAILABLE until the next non-empty reload');
        return;
      }
      if (inner?.reload) inner.reload(next);
      else inner = createFailoverPool(next, opts);
    },
  };
}

export async function startGatewayService(opts: GatewayServiceOptions = {}): Promise<RunningGatewayService> {
  const log = opts.log ?? ((lvl, m) => console.log(`[inference-gateway:${lvl}] ${m}`));
  // P-012: every deployment path (dev tsx, systemd unit, packaged re-exec, container) enters the
  // gateway through THIS function, which is what lets one call make "equivalent inputs produce
  // equivalent admission decisions across deployment paths" audible rather than merely true. A
  // retired capacity variable that is silently ignored leaves the deployer with a confident, wrong
  // model of the fleet's capacity; say so out loud, once, at boot.
  reportRetiredCapacityEnv(log, opts.env ?? process.env);
  const makeResolver = opts.makeResolver ?? makeCredentialResolver;
  const observePool = opts.observePool ?? defaultObservePool;
  // Local inference-backend pool (D-002): OPT-IN — the default resolver returns empty (no PG touch),
  // so every existing caller (tests, and any deployment that doesn't pass resolveLocalBackends) is
  // byte-identical to before this landed: zero registered backends ⇒ the pool stays empty ⇒ the
  // gateway's local-backend routes just 404 like they did when the feature didn't exist. A deployment
  // that WANTS the local-backend pool passes `resolveLocalBackends` wired to local-backend-store's
  // listLocalBackends (see bin.ts) — mirrors defaultObservePool's lazy-import-only-when-used shape.
  const resolveLocalBackends = opts.resolveLocalBackends ?? (async () => []);
  const durableAdmission =
    opts.durableAdmission === false || opts.durableAdmission === undefined
      ? undefined
      : createDurableGatewayAdmissionGovernor({
          workspaceId: opts.workspace,
          ...(typeof opts.durableAdmission === 'object' ? opts.durableAdmission : {}),
        });
  // D-004: spool ON wherever the durable queue is on, unless the caller opts out explicitly.
  // `opts.payloadSpool === undefined` inherits the durable-admission decision; only an explicit
  // `false` disables it, so enabling the durable queue can never silently produce receipts whose
  // payload was not persisted.
  const payloadSpoolRequested = opts.payloadSpool ?? durableAdmission !== undefined;
  const isPayloadSpool = (value: unknown): value is GatewayPayloadSpool =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Partial<GatewayPayloadSpool>).spool === 'function' &&
    typeof (value as Partial<GatewayPayloadSpool>).sweep === 'function';
  const payloadSpool =
    payloadSpoolRequested === false
      ? undefined
      : isPayloadSpool(payloadSpoolRequested)
        ? payloadSpoolRequested
      : createGatewayPayloadSpool({
          workspaceId: opts.workspace,
          ...(typeof payloadSpoolRequested === 'object' ? payloadSpoolRequested : {}),
        });
  const localBackendPool: LocalBackendPool = createLocalBackendPool();
  // ⚠ lifecycle + unitName ARE PART OF THIS SIGNATURE ON PURPOSE (P-008/D-009). The signature is
  // what gates reload(), so a field missing here is a field the RUNNING gateway can never see
  // change: flipping a backend to 'on-demand' in the DB would leave the live pool believing it is
  // always-on, and the cold-start path would never fire for it.
  const localBackendSig = (bs: readonly LocalBackend[]) =>
    [...bs]
      .map(
        (b) =>
          `${b.id}|${b.kind}|${b.baseUrl}|${b.models.join(',')}|${b.maxConcurrent}|${b.enabled}|${b.lifecycle ?? 'always-on'}|${b.unitName ?? ''}`,
      )
      .sort()
      .join(';');
  /** Hot-reload the local-backend registry from the DB into the live pool. Fail-soft: a load error
   *  (e.g. migration 445 not yet applied) logs + leaves the current live pool untouched rather than
   *  crashing gateway startup — local backends are additive, never load-bearing for the gateway itself. */
  async function refreshLocalBackends(): Promise<{ changed: boolean; count: number }> {
    let records: LocalBackendRecord[];
    try {
      records = await resolveLocalBackends(opts.workspace);
    } catch (e) {
      log('warn', `inference-gateway: local-backend registry load failed: ${(e as Error).message}`);
      return { changed: false, count: localBackendPool.size() };
    }
    const next: LocalBackend[] = records
      .filter((r) => r.enabled)
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        baseUrl: r.baseUrl,
        models: r.models,
        maxConcurrent: r.maxConcurrent,
        enabled: r.enabled,
        // Carried into the live pool so the ROUTING path can tell a startable dead end from a
        // permanent one (P-008/D-009) — the gateway owns that judgement, not this mapping.
        lifecycle: r.lifecycle,
        unitName: r.unitName,
      }));
    const changed = localBackendSig(next) !== localBackendSig(localBackendPool.entries());
    if (changed) {
      localBackendPool.reload(next);
      log('info', `inference-gateway: local-backend pool HOT-RELOADED [${next.map((b) => b.id).join(', ') || '(empty)'}]`);
    }
    return { changed, count: next.length };
  }

  // Resolve the account pool. A legacy single `resolveAccount` injection → a one-account pool
  // (back-compat, no failover); otherwise the full pool (EI-535 failover across all accounts).
  // Resolve + build the live failover-pool entries (and their credential resolvers) for an account set.
  // Factored so a HOT-RELOAD (B-HOT-1) can re-resolve the DB pool + rebuild the entries from the same recipe.
  function buildResolved(accts: ResolvedAccount[]) {
    const rs = accts.map((a) => ({ account: a, resolver: makeResolver(a.credentialRef, a.accountId) }));
    const entries = rs.map(({ account, resolver }) => ({
      accountId: account.accountId,
      token: () => resolver.current(),
      invalidateToken: () => resolver.invalidate(),
      // anthropic-credits-gateway-2026-09-30 P-005: an `apikey:` account authenticates with
      // x-api-key; the request path picks the headers per attempt from this (P-006).
      authMode: resolver.authMode,
      // P-008: the account's metered spend policy (overflow | never) — selection ranks metered
      // serving behind included allowance, and `never` makes it unselectable while metered.
      ...(account.meteredPolicy ? { meteredPolicy: account.meteredPolicy } : {}),
      // Per-account IP routing (D-003): route this account's upstream through its own egress dispatcher
      // (proxy / bound source IP) when configured; absent ⇒ default shared egress.
      egress: account.egress,
      // Per-account egress IP POOL (gateway-per-account-egress-ip-pool-2026-06-30): the rotating list of
      // egress IPs; when set the gateway round-robins this account's upstream across them so a per-IP
      // Cloudflare throttle takes one IP out of rotation, not the whole account.
      egressPool: account.egressPool,
    }));
    return { resolvers: rs, entries };
  }
  /** Stable signature of a resolved pool — id + credentialRef + egress (singular + pool) — so a reload only
   *  swaps on a REAL change, not on every poll. */
  const egSig = (e?: { proxyUrl?: string; localAddress?: string }) => `${e?.proxyUrl ?? ''}~${e?.localAddress ?? ''}`;
  const sigOf = (a: ResolvedAccount[]) =>
    a
      .map(
        (x) =>
          `${x.accountId}|${x.credentialRef}|${egSig(x.egress)}|${(x.egressPool ?? []).map(egSig).join('+')}|${x.meteredPolicy ?? ''}`,
      )
      .join(',');

  let accounts: ResolvedAccount[] = opts.resolveAccount
    ? [await opts.resolveAccount(opts.workspace)]
    : await (opts.resolveAccounts ?? resolveAccountPool)(opts.workspace, 'claude');
  if (accounts.length === 0) throw new Error('inference-gateway: no account resolved');
  let codexAccounts: ResolvedAccount[] = opts.resolveAccount
    ? []
    : await (opts.resolveAccounts ?? resolveAccountPool)(opts.workspace, 'codex');

  const built0 = buildResolved(accounts);
  let resolvers = built0.resolvers;
  let primary = accounts[0];
  log(
    'info',
    `account pool [${accounts.map((a) => a.accountId).join(', ')}]; primary '${primary.accountId}' via ${primary.source} (channel ${primary.credentialRef.split(':')[0]})`,
  );

  const pool = createFailoverPool(built0.entries, { log });
  // ChatGPT-subscription bridge (codex-cli-bridge.ts): a codex account whose credentialRef is
  // `codex-cli:<CODEX_HOME>` has NO API bearer — it is served by driving the codex CLI. Keep such
  // accounts OUT of the bearer pool (makeBearerCredentialResolver would throw on the scheme) and
  // hand them to the gateway as the CLI list. `codexAccounts` is reassigned by reloadPool, so the
  // getter below stays hot-reload-fresh for free.
  const cliAccountsOf = (accts: ResolvedAccount[]): CodexCliAccount[] =>
    accts.flatMap((a) => {
      const home = parseCodexCliRef(a.credentialRef);
      return home ? [{ accountId: a.accountId, home, egress: a.egress, egressPool: a.egressPool }] : [];
    });
  const buildCliEntries = (accts: ResolvedAccount[]): ActiveAccount[] =>
    cliAccountsOf(accts).map((a) => ({
      accountId: a.accountId,
      // Selection/health only: the OAuth proxy resolves the real token from a.home after routing.
      token: async () => '',
      egress: a.egress,
      egressPool: a.egressPool,
    }));
  const buildBearerEntries = (accts: ResolvedAccount[]) =>
    accts
      .filter((a) => !a.credentialRef.startsWith(CODEX_CLI_REF_PREFIX))
      .map((a) => {
        const resolver = makeBearerCredentialResolver(a.credentialRef);
        return { accountId: a.accountId, token: () => resolver.current(), invalidateToken: () => resolver.invalidate(), egress: a.egress, egressPool: a.egressPool };
      });
  const codexPool = createOptionalFailoverPool(buildBearerEntries(codexAccounts), { log });
  const codexCliPool = createOptionalFailoverPool(buildCliEntries(codexAccounts), { log });
  {
    const cli0 = cliAccountsOf(codexAccounts);
    if (cli0.length) {
      log('info', `inference-gateway: codex-cli (ChatGPT subscription) bridge accounts [${cli0.map((a) => a.accountId).join(', ')}]`);
    }
  }
  const unobserve = observePool(primary.accountId, opts.workspace, log);

  // Priority-TIER admission configs (gateway-priority-tiers-2026-06-22) — flag-gated; null (omitted) under
  // flag-OFF so each gateway queue runs its flat priority+aging behavior unchanged. Resolve Claude and Codex
  // independently: their reserved tier-1 floors protect different admission pools.
  // P-010: this layer no longer mirrors a `DEFAULT_CONCURRENCY = 24` from gateway.ts,
  // and Codex no longer derives a separate account-scaled size. Both lanes start from
  // ONE seed and are grown/contracted independently by the gateway's single capless
  // ProviderAdmissionLifecycle, which owns the live window from that point on.
  //
  // The seed matters here only because the priority-tier reserve has to be sized to
  // SOMETHING at construction time; the lifecycle re-sheds and re-grows those caps
  // against each lane's own high-water mark as soon as traffic starts.
  // SEED FROM REAL POOL SIZE, not a constant (WI-2140943, measured outage 2026-09-02).
  //
  // `sidecar-main.ts` passes no `concurrency` on purpose (P-010: admission concurrency is LEARNED,
  // never configured), so this fell through to the flat `INITIAL_PROVIDER_ADMISSION_WINDOW` of 8 —
  // for a 1-account pool and a 7-account pool alike. "Learned" is the right policy for the LIVE
  // window and the wrong one for where a cold lane STARTS: the AIMD's increase is ADDITIVE at a
  // rate proportional to the window itself, so a cold start far below real capacity takes hours to
  // climb out of, and every gateway restart re-entered that hole. Measured: 7 healthy Claude
  // accounts (serviceable recommendation 28) restarting into a window of 8, with ~90 agents plus
  // the owner's desktop sessions queueing behind it until requests timed out.
  //
  // `serviceableAdmissionFor` is the SAME formula already published as `clamp.recommendation` on
  // GET /stats — previously computed every tick and, per capacity-inventory.ts, "reports and does
  // not bind". This gives it exactly one binding use: the cold-start seed. It stays a SEED, never a
  // cap — the capless lifecycle still grows past it under clean traffic and contracts below it
  // under genuine throttling, so P-007's retirement of the clamp-as-authority is untouched.
  const admissionSeedWindow = Math.max(
    1,
    Math.floor(
      opts.concurrency !== undefined && Number.isFinite(opts.concurrency) && opts.concurrency > 0
        ? opts.concurrency
        : Math.max(INITIAL_PROVIDER_ADMISSION_WINDOW, serviceableAdmissionFor(accounts.length)),
    ),
  );
  const resolveTiers = async (slots: number, lane: 'Claude' | 'Codex') =>
    resolvePriorityTiers(slots).catch((e) => {
      // Fail-safe: a flag/env read fault must never block the gateway from starting → fall back to the flat
      // queue (flag-OFF behavior), loudly.
      log('warn', `inference-gateway: ${lane} priority-tier config resolve failed (${(e as Error).message}) — running the flat admission queue`);
      return null;
    });
  const priorityTiers = await resolveTiers(admissionSeedWindow, 'Claude');
  const codexPriorityTiers = await resolveTiers(admissionSeedWindow, 'Codex');
  if (priorityTiers) {
    log('info', `inference-gateway: Claude priority-tier admission ON — reserve=${priorityTiers.config.tier1Reserve} caps=${JSON.stringify(priorityTiers.config.caps)}`);
  }
  if (codexPriorityTiers) {
    log('info', `inference-gateway: Codex priority-tier admission ON — reserve=${codexPriorityTiers.config.tier1Reserve} caps=${JSON.stringify(codexPriorityTiers.config.caps)}`);
  }

  // codex-gateway-oauth-proxy-2026-07-04 (WI-2198): flag-gated. ON ⇒ a codex-cli
  // (ChatGPT-subscription) account serves a STREAMING /v1/responses via the OAuth
  // reverse-proxy (codex-oauth-proxy.ts) to chatgpt.com/backend-api/codex instead of
  // the one-shot exec bridge. Fail-safe: a flag read fault ⇒ OFF (exec bridge,
  // byte-identical to today). Resolved at the launch layer so unit tests default it off.
  const codexOAuthProxy = await (async () => {
    try {
      const { getFlag } = await import('@papercusp/flags/server');
      const { FLAGS } = await import('@papercusp/flags');
      return await getFlag(FLAGS.CODEX_GATEWAY_OAUTH_PROXY, 'system');
    } catch (e) {
      log('warn', `inference-gateway: codex-oauth-proxy flag read failed (${(e as Error).message}) — exec bridge`);
      return false;
    }
  })();
  if (codexOAuthProxy) {
    log('info', 'inference-gateway: codex OAuth streaming proxy ON — codex-cli accounts stream via the ChatGPT backend');
  }

  // deterministic-context-carry P-017 (WI-4845): flag-gated DETERMINISTIC maintenance-carry
  // branch for POST /maintenance/summarize?carryOwner=… — ON ⇒ inject the carry-doc builder
  // (a builder miss still falls through to the LLM lane inside the gateway). Fail-safe: a
  // flag read fault ⇒ OFF (LLM lane only, byte-identical). Resolved at the launch layer so
  // unit tests default it off; the builder is imported lazily so the carry-doc module graph
  // (PG readers) never loads while the flag is dark.
  const maintenanceCarryOn = await (async () => {
    try {
      const { getFlag } = await import('@papercusp/flags/server');
      const { FLAGS } = await import('@papercusp/flags');
      return await getFlag(FLAGS.GATEWAY_MAINTENANCE_CARRY, 'system');
    } catch (e) {
      log('warn', `inference-gateway: maintenance-carry flag read failed (${(e as Error).message}) — LLM summarize lane only`);
      return false;
    }
  })();
  if (maintenanceCarryOn) {
    log('info', 'inference-gateway: deterministic maintenance-carry ON — /maintenance/summarize?carryOwner=… answers from the carry-doc builder');
  }
  // P-019 residual sampler (D-010 live leg 2): only meaningful when the deterministic
  // branch serves (it samples that branch's boundaries), so it rides the carry flag AND
  // its own kill-switch. Fail-safe: a flag read fault ⇒ OFF (no sampling, byte-identical).
  const residualSamplerOn =
    maintenanceCarryOn &&
    (await (async () => {
      try {
        const { getFlag } = await import('@papercusp/flags/server');
        const { FLAGS } = await import('@papercusp/flags');
        return await getFlag(FLAGS.RESIDUAL_CARRY_SAMPLER, 'system');
      } catch (e) {
        log('warn', `inference-gateway: residual-sampler flag read failed (${(e as Error).message}) — sampling off`);
        return false;
      }
    })());
  if (residualSamplerOn) {
    log('info', 'inference-gateway: P-019 residual carry sampler ON — deterministic maintenance-carry boundaries feed the per-class retirement corpus');
  }

  const gateway = createInferenceGateway({
    readAcceptedOperationModelPolicy: async (ownerId, backend = 'claude') => {
      const [{ activeWorkspaceId }, { readActiveOperationModelPolicy }] = await Promise.all([
        import('../workspace-registry'),
        import('../blueprint/operation-worker-binding'),
      ]);
      return readActiveOperationModelPolicy(opts.workspace ?? activeWorkspaceId(), ownerId, backend);
    },
    recordAcceptedOperationModelAttestation: async (context, evidence) => {
      const [{ getOrgPg }, { recordDirectOperationModelAttestation }] = await Promise.all([
        import('@papercusp/db-org'), import('../blueprint/operation-service'),
      ]);
      await recordDirectOperationModelAttestation(getOrgPg().sql, context, evidence);
    },
    checkGoalInferenceAdmission: async (ownerId) => {
      const [{ activeWorkspaceId }, { getOrgPg }, { checkGoalInferenceAdmission }] = await Promise.all([
        import('../workspace-registry'),
        import('@papercusp/db-org'),
        import('../goal-launch-settings'),
      ]);
      return checkGoalInferenceAdmission({
        workspaceId: opts.workspace ?? activeWorkspaceId(),
        ownerId,
        sql: getOrgPg().sql,
      });
    },
    pool,
    codexPool,
    codexCliPool,
    codexOAuthProxy,
    ...(durableAdmission ? { admissionGovernor: durableAdmission } : {}),
    ...(payloadSpool ? { payloadSpool } : {}),
    // Getter (not a snapshot) so a reloadPool() that adds/removes a codex-cli account
    // applies to the very next /v1/responses request without a gateway restart.
    codexCliAccounts: () => cliAccountsOf(codexAccounts),
    upstreamBase: opts.upstreamBase,
    openaiUpstreamBase: process.env.OPENAI_BASE_URL_UPSTREAM || undefined,
    // Seed only (P-010): the gateway's capless lifecycle owns the live window for
    // BOTH lanes from here on, so there is no separate Codex size to hand down.
    // Pass the POOL-SIZED seed computed above (WI-2140943), not the raw `opts.concurrency`:
    // `createInferenceGateway` falls back to the flat INITIAL_PROVIDER_ADMISSION_WINDOW (8) when
    // this is undefined, which is exactly the cold-start hole the seed exists to close — measured
    // 2026-09-02 05:06Z: 7 accounts, recommendation 28, gateway restarted into a window of 8 while
    // the tier caps (sized from the same seed) already said 28. `admissionSeedWindow` already
    // honours an explicit `opts.concurrency` when one is configured, so this changes nothing there.
    concurrency: admissionSeedWindow,
    // Smooth each per-account RPM allowance into an even pace so the fleet can't fire a sub-minute BURST
    // that trips Anthropic's burst limit (the bare-burst 429 storm, 2026-06-23). Throughput-neutral (the
    // per-minute count gate still caps the rate). On by default in production; set PAPERCUSP_GATEWAY_RPM_SMOOTH=0
    // to disable (ops kill-switch). Resolved here at the launch layer so unit tests default it off.
    smoothRpm: process.env.PAPERCUSP_GATEWAY_RPM_SMOOTH !== '0',
    ...(priorityTiers ? { priorityTiers } : {}),
    ...(codexPriorityTiers ? { codexPriorityTiers } : {}),
    ...(maintenanceCarryOn
      ? {
          maintenanceCarry: async (ownerId: string, o: { effectiveWindowTokens?: number; workspaceId?: string }) => {
            const { buildMaintenanceCarrySummary } = await import('../maintenance-carry');
            return buildMaintenanceCarrySummary(ownerId, {
              ...(o.effectiveWindowTokens ? { effectiveWindowTokens: o.effectiveWindowTokens } : {}),
              ...(o.workspaceId ? { buildOpts: { workspaceId: o.workspaceId } } : {}),
            });
          },
        }
      : {}),
    ...(residualSamplerOn
      ? {
          residualSampler: (input: {
            carryOwner: string;
            stage1Doc: string;
            droppedContext: string;
            interactive: boolean;
            workspaceId?: string;
          }) => {
            // Fire-and-forget: the sampler is lazily imported (its module graph —
            // PG readers, the pass core — never loads while the flag is dark) and
            // every fault is swallowed; the served compaction is already on the wire.
            void trackDetached(import('../residual-carry-pass-live'))
              .then((m) => m.runMaintenanceResidualSample(input))
              .catch(() => {});
          },
        }
      : {}),
    fetchImpl: opts.fetchImpl,
    log,
    onResponse: makeWindowProjector(opts.workspace, log),
    // #5 PART A: a DEAD credential (consecutive 401s despite refresh) fires a loud escalation + broadcast.
    onCredentialDead: makeCredentialHealthAlert(opts.workspace, log),
    // org-disable is a PERMANENT Anthropic-side disqualification, not a throttle — the gateway's in-memory
    // pause resets on restart, so persistently REMOVE the dead account from the pool (+ loud escalation).
    onOrgDisallowed: makeOrgDisallowedDeactivator(opts.workspace, log),
    // B-HOT-2: expose the live config + on-demand hot-reload over /admin/config + /admin/reload.
    // `reloadPool` is a hoisted function declaration; `configVersion`/`accounts` are read lazily at
    // request time (after their initialisers run), so referencing them here is safe.
    onAdminReload: () => reloadPool(),
    adminConfig: () => ({ version: configVersion, accounts: accounts.map((a) => a.accountId), codexAccounts: codexAccounts.map((a) => a.accountId) }),
    // Local inference-backend pool (D-002): the pool object's identity is fixed for the gateway's life;
    // refreshLocalBackends() below mutates it in place via reload(), so this reference stays live.
    localBackends: localBackendPool,
    onAdminReloadLocalBackends: () => refreshLocalBackends(),
    // START-ON-DEMAND (P-008/D-009): the gateway decides WHETHER a dead end is startable (it reads
    // lifecycle + unitName off the pool entry); this closure is the MECHANISM — systemd + the
    // durable watermark, both of which the gateway itself deliberately does not import.
    ensureLocalBackendRunning: async (backend) => {
      const { ensureLocalBackendRunning } = await import('../provisioner/provision');
      const { markLocalBackendBusy } = await import('./local-backend-store');
      const { startOnDemandBackendWithWatermark } = await import('./on-demand-start');
      // Watermark BEFORE and AFTER the start (WI-10006360) — see on-demand-start.ts for the race.
      const result = await startOnDemandBackendWithWatermark(backend.id, {
        markBusy: () => markLocalBackendBusy(backend.id, { workspaceId: opts.workspace }),
        log,
        budgetMs: LOCAL_BACKEND_COLD_START_TIMEOUT_MS,
        start: () => ensureLocalBackendRunning(
        {
          id: backend.id,
          unitName: backend.unitName ?? null,
          baseUrl: backend.baseUrl,
          // Carried purely so the cold-start audit can resolve this backend's catalog entry
          // (D-016). The join is the MODEL REF, not the id: the registry id and the catalog id are
          // independent namespaces (`ornith-llamaserver` vs `ornith-35b-iq3m-llama-server`), and an
          // id-keyed lookup silently audits nothing.
          models: backend.models,
          kind: backend.kind,
        },
        {
          readyTimeoutMs: LOCAL_BACKEND_COLD_START_TIMEOUT_MS,
          // The guard's production reporter (WI-39735). WARN-only by design: a degraded backend
          // still serves, so this never blocks the start — see the D-016 note at the call site.
          // Logged at every verdict, including `ok`: a line that only ever appears on failure
          // cannot be distinguished from a guard that is not running at all.
          onUnitAudit: (audit) => {
            if (audit.verdict === 'degraded') {
              log('warn', `inference-gateway: DEGRADED UNIT starting '${backend.id}' — ${audit.summary}`);
            } else if (audit.verdict === 'unauditable') {
              log('warn', `inference-gateway: could not audit '${backend.id}' before start — ${audit.summary}`);
            } else {
              log('info', `inference-gateway: unit audit clean for '${backend.id}' — ${audit.summary}`);
            }
          },
        },
      ),
      });
      return { ok: result.ok, error: result.error };
    },
  });

  const port = await gateway.listen(opts.port ?? DEFAULT_GATEWAY_PORT);

  // HOT-RELOAD (B-HOT-1): re-resolve the DB account pool (the source of truth) + atomically swap it into
  // the LIVE failover pool WITHOUT a gateway restart. No-op when nothing changed (same signature) or the
  // pool can't hot-reload. Returns the new config version + live account ids; called by the poll below +
  // the /admin/reload endpoint (B-HOT-2).
  let configVersion = 1;
  async function reloadPool(): Promise<{ changed: boolean; version: number; accounts: string[] }> {
    const ids = (a: ResolvedAccount[]) => a.map((x) => x.accountId);
    const next = opts.resolveAccount
      ? [await opts.resolveAccount(opts.workspace)]
      : await (opts.resolveAccounts ?? resolveAccountPool)(opts.workspace, 'claude');
    let nextCodex = opts.resolveAccount ? [] : await (opts.resolveAccounts ?? resolveAccountPool)(opts.workspace, 'codex');
    if (next.length === 0) {
      log('warn', 'inference-gateway: pool reload resolved an EMPTY pool — keeping the current pool (fail-safe)');
      return { changed: false, version: configVersion, accounts: ids(accounts) };
    }
    // WI-3069: mirror the claude-pool empty-resolve fail-safe above for codex. Without this, a
    // transient resolver hiccup that momentarily returns zero codex accounts (while claude's `next`
    // still resolved fine) fell through to `codexPool.reload([])` below, which WIPES the live codex
    // pool to null (createOptionalFailoverPool.reload sets inner=null on an empty list) — every codex
    // call then throws "no Codex account pool configured" until the next successful reload restores
    // it. Only trips when we previously HAD codex accounts (an intentional zero-codex deployment,
    // where codexAccounts was already [], is unaffected) and opts.resolveAccount didn't force codex to
    // [] on purpose (the single-account back-compat mode).
    if (!opts.resolveAccount && nextCodex.length === 0 && codexAccounts.length > 0) {
      log(
        'warn',
        'inference-gateway: codex pool reload resolved an EMPTY pool (previously non-empty) — keeping the current codex pool (fail-safe)',
      );
      nextCodex = codexAccounts;
    }
    const unchanged = sigOf(next) === sigOf(accounts) && sigOf(nextCodex) === sigOf(codexAccounts);
    if (!pool.reload || unchanged) {
      return { changed: false, version: configVersion, accounts: ids(accounts) };
    }
    const built = buildResolved(next);
    pool.reload(built.entries);
    if (codexPool.reload) {
      codexPool.reload(buildBearerEntries(nextCodex));
    }
    codexCliPool.reload?.(buildCliEntries(nextCodex));
    accounts = next;
    codexAccounts = nextCodex;
    resolvers = built.resolvers;
    primary = next[0];
    configVersion++;
    log('info', `inference-gateway: account pool HOT-RELOADED to v${configVersion} [${ids(next).join(', ')}] — no restart`);
    return { changed: true, version: configVersion, accounts: ids(next) };
  }

  // Warm the primary's token now (fail fast on a bad primary credential) + a proactive refresh timer for
  // every file-kind resolver, so an idle gateway never serves the first post-idle request — on ANY pool
  // account — with an expired token. The timer reads the CURRENT resolvers each tick, so a hot-reloaded
  // account's token is proactively refreshed too.
  await resolvers[0]
    .resolver.current()
    .catch((e) =>
      log(
        'error',
        `GATEWAY UNAUTHENTICATED at boot — initial token resolve failed: ${(e as Error).message} ` +
          `(members routed through this gateway will 401 until a live credential appears; the resolver ` +
          `re-scans on every 401 and on each proactive refresh tick, so recovery needs no restart)`,
      ),
    );
  const refreshMs = opts.refreshIntervalMs ?? EXTERNAL_SCHEDULES.gatewayTokenRefresh.defaultIntervalMs;
  let timer: ManagedHandle | undefined;
  if (refreshMs > 0) {
    timer = managedSetInterval(
      EXTERNAL_SCHEDULES.gatewayTokenRefresh.name,
      refreshMs,
      () => {
        for (const { resolver } of resolvers) {
          // `token` setup-tokens and `apikey` Console keys never expire — skip; `file` refreshes via
          // OAuth; `keychain` (macOS local fallback) re-runs the freshest-scan across every local source.
          if (resolver.kind === 'token' || resolver.kind === 'apikey') continue;
          resolver.invalidate();
          void resolver.current().catch((e) => log('warn', `proactive refresh failed: ${(e as Error).message}`));
        }
      },
      {
        category: EXTERNAL_SCHEDULES.gatewayTokenRefresh.category,
        classification: EXTERNAL_SCHEDULES.gatewayTokenRefresh.classification,
        allowInTest: true,
      },
    );
  }

  // POLL the DB pool (B-HOT-1): periodically hot-reload so an account registered / removed / egress-changed
  // via accounts:* applies LIVE (no restart — the friction that needed two restarts to swap one account).
  // Default 60s; 0 disables. Skipped when the pool can't hot-reload (a single-account back-compat pool).
  // EI-19303809952284205: fire ONE durable escalation + fleet broadcast when the gateway's durable
  // paths cross into sustained failure, and resolve it on recovery. db-health.ts emits only on a
  // TRANSITION, so a flapping reconnect cannot turn this into a broadcast storm.
  setDbHealthTransitionHandler(makeDbHealthAlert(opts.workspace, log));

  const reloadMs = opts.poolReloadIntervalMs ?? EXTERNAL_SCHEDULES.gatewayPoolReload.defaultIntervalMs;
  let reloadTimer: ManagedHandle | undefined;
  if (reloadMs > 0 && pool.reload) {
    reloadTimer = managedSetInterval(EXTERNAL_SCHEDULES.gatewayPoolReload.name, reloadMs, () => {
      // EI-19303809952284205: the 60s poll is the gateway's only CONTINUOUS durable-path heartbeat —
      // it runs whether or not traffic is flowing, so it is what advances the failure streak on an
      // idle gateway. When this fails the pool cannot load at all and the gateway silently collapses
      // to a single synthetic `local` credential (healthyAccounts: 0, every account pin ignored).
      void reloadPool()
        .then(() => recordDbOutcome('pool-reload', true))
        .catch((e) => {
          recordDbOutcome('pool-reload', false, e);
          log('warn', `pool reload poll failed: ${(e as Error).message}`);
        });
    }, {
      category: EXTERNAL_SCHEDULES.gatewayPoolReload.category,
      classification: EXTERNAL_SCHEDULES.gatewayPoolReload.classification,
      allowInTest: true,
    });
  }

  // DYNAMIC OWNER PIN durability (account-dynamic-pin-2026-06-29): load the durable agent→account pins from
  // the DB store into the gateway at startup + on the poll, so they SURVIVE a gateway restart (in-memory
  // alone dropped them silently on the wedge-watchdog / deploy / crash restarts). The accounts:pin tool also
  // pushes each change to /admin/owner-pin for IMMEDIATE effect; this is the load + periodic-resync path.
  const refreshGatewayHints = async (): Promise<void> => {
    const { activeWorkspaceId } = await import('../workspace-registry');
    const ws = opts.workspace ?? activeWorkspaceId();
    // RATE HINTS (cold-start seed) — from operator_account_pool (migration 190, ALWAYS present): seed keyOf
    // so a known-dead account is disqualified immediately after a restart. Independent try so it works even
    // before the owner-pins table (migration 416) exists.
    try {
      const [{ loadAccountPool }, { accountBurnAction }] = await Promise.all([
        import('../deployment/account-pool-store'),
        import('../deployment/account-pool'),
      ]);
      const poolFull = await loadAccountPool(ws);
      const hintNow = Date.now();
      gateway.setAccountRateHints(
        (poolFull.accounts ?? []).map((a) => ({
          accountId: a.id,
          pausedUntil: a.rate?.pausedUntil,
          utilization: a.rate?.utilization,
          utilization7d: a.rate?.utilization7d,
          windowResetAt: a.rate?.windowResetAt,
          windowResetAt7d: a.rate?.windowResetAt7d,
          // When the store TOOK the reading — the gateway's store↔pool reconciliation (P-008) clears an
          // in-memory park only on a reading newer than the park it would clear.
          readingAt: Math.max(a.rate?.utilizationAt ?? 0, a.rate?.usageCreditsObservedAt ?? 0) || undefined,
          usageCreditsAvailable: a.rate?.usageCreditsAvailable,
          // Re-evaluate at the hint-read seam instead of trusting the persisted transition stamp:
          // accountBurnAction applies the canonical freshness gate, so a days-old SHED verdict cannot
          // strand an otherwise recovered account after its projection has gone stale.
          burnAction: accountBurnAction(a, hintNow),
        })),
      );
      recordDbOutcome('rate-hints', true);
    } catch (e) {
      // EI-19303809952284205: a failure here means the drain selector is running on cold-start
      // defaults — a known-dead account is no longer disqualified. Silent before this.
      recordDbOutcome('rate-hints', false, e);
      log('warn', `inference-gateway: rate-hint refresh failed: ${(e as Error).message}`);
    }
    // OWNER PINS (durable dynamic pins) — from operator_owner_pins (migration 416). Fail-soft until that
    // migration boot-applies; the in-memory pins set via /admin/owner-pin still work in the interim.
    try {
      const { getOwnerPinsList } = await import('../deployment/account-owner-pins');
      gateway.setOwnerPins(await getOwnerPinsList(ws));
    } catch (e) {
      log('warn', `inference-gateway: owner-pin refresh failed (expected until migration 416 applies): ${(e as Error).message}`);
    }
  };
  await refreshGatewayHints();
  let hintTimer: ManagedHandle | undefined;
  if (reloadMs > 0) {
    hintTimer = managedSetInterval(
      EXTERNAL_SCHEDULES.gatewayRateHintPinResync.name,
      reloadMs,
      () => void refreshGatewayHints(),
      {
        category: EXTERNAL_SCHEDULES.gatewayRateHintPinResync.category,
        classification: EXTERNAL_SCHEDULES.gatewayRateHintPinResync.classification,
        allowInTest: true,
      },
    );
  }

  // Local inference-backend pool (D-002): load the registry now (so the FIRST request after boot
  // already sees any registered backend, not just after the first poll tick) + a periodic
  // reload-from-DB + health-check tick. Fail-soft — see refreshLocalBackends' own try/catch.
  await refreshLocalBackends();
  const localBackendReloadMs = opts.localBackendReloadIntervalMs ?? EXTERNAL_SCHEDULES.gatewayLocalBackendRefresh.defaultIntervalMs;
  let localBackendTimer: ManagedHandle | undefined;
  if (localBackendReloadMs > 0) {
    localBackendTimer = managedSetInterval(
      EXTERNAL_SCHEDULES.gatewayLocalBackendRefresh.name,
      localBackendReloadMs,
      () => {
        void refreshLocalBackends();
        void localBackendPool.runHealthChecks().catch((e) => log('warn', `inference-gateway: local-backend health check failed: ${(e as Error).message}`));
      },
      {
        category: EXTERNAL_SCHEDULES.gatewayLocalBackendRefresh.category,
        classification: EXTERNAL_SCHEDULES.gatewayLocalBackendRefresh.classification,
        allowInTest: true,
      },
    );
  }

  // D-004/D-011: the production payload spool is lazy-GC'd rather than deleting on every
  // release, so a retried receipt can still resurrect its body. Keep the sweep bounded
  // and fail-soft: an individual maintenance failure must not take down the gateway.
  const payloadSpoolSweepMs = opts.payloadSpoolSweepIntervalMs ?? EXTERNAL_SCHEDULES.gatewayPayloadSpoolSweep.defaultIntervalMs;
  const payloadSpoolSweepLimit = opts.payloadSpoolSweepLimit ?? DEFAULT_PAYLOAD_SPOOL_SWEEP_LIMIT;
  let payloadSpoolSweepTimer: ManagedHandle | undefined;
  const sweepPayloadSpool = (): void => {
    if (!payloadSpool) return;
    void payloadSpool.sweep({ limit: payloadSpoolSweepLimit }).catch((e) => {
      log('warn', `inference-gateway: payload-spool sweep failed: ${(e as Error).message}`);
    });
  };
  if (payloadSpool && Number.isFinite(payloadSpoolSweepMs) && payloadSpoolSweepMs > 0) {
    // Run once at startup so a restart does not leave an already-overdue legacy backlog
    // waiting for the first interval tick.
    sweepPayloadSpool();
    payloadSpoolSweepTimer = managedSetInterval(
      EXTERNAL_SCHEDULES.gatewayPayloadSpoolSweep.name,
      payloadSpoolSweepMs,
      sweepPayloadSpool,
      {
        category: EXTERNAL_SCHEDULES.gatewayPayloadSpoolSweep.category,
        classification: EXTERNAL_SCHEDULES.gatewayPayloadSpoolSweep.classification,
        allowInTest: true,
      },
    );
  }

  return {
    gateway,
    port,
    get account() {
      return primary; // the primary can change across a hot-reload
    },
    configVersion: () => configVersion,
    reloadPool,
    async stop() {
      timer?.stop();
      reloadTimer?.stop();
      hintTimer?.stop();
      localBackendTimer?.stop();
      payloadSpoolSweepTimer?.stop();
      // EI-19303809952284205: drop the alert handler with the service. The tracker is a process
      // singleton, so leaving it registered would let a torn-down service (a test, a restarted
      // in-process gateway) keep firing escalations at the fleet.
      setDbHealthTransitionHandler(undefined);
      unobserve();
      await gateway.close();
    },
  };
}
