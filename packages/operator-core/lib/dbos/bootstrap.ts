/**
 * DBOS Transact bootstrap — Phase 0 of `dbos-durable-jobs-2026-05-31`.
 *
 * Boots DBOS durable execution against the operator's embedded Postgres.
 * The call site (instrumentation-node.ts) gates this behind
 * `PAPERCUSP_DBOS_ENABLE=1` (default OFF) — same shape as the other
 * opt-in boot worker (`PAPERCUSP_IPC_ENABLE`). The PostHog `flags:*` A/B gate (plan D-011)
 * comes in Phase 1 with the AutoLoop runtime migration; the boot launch
 * itself stays env-gated so we never block startup on an async flag read.
 *
 * Verified end-to-end in the Phase-0 gate (P-002) against an
 * embedded-postgres-server PG 16 instance:
 *  - DBOS creates its `dbos` schema and runs/resumes workflows.
 *  - An unpinned application-version change leaves prior workflows PENDING
 *    (the D-008 hazard) — hence the pinned `applicationVersion` below.
 *  - A completed step is not re-executed on resume.
 *
 * Design (see the plan):
 *  - D-002: resolve the DSN via `getHarnessAdminUrlWithSource()`; never
 *    hardcode a port. Refuse the native-fallback so we don't point DBOS at
 *    the dead `:5432/papercusp_legacy` when the desktop isn't running.
 *  - DBOS system tables live in a dedicated `dbos` schema.
 *  - D-008 / D-012: pin the application version so timer workflows recover
 *    across app updates. Override per-deploy with `DBOS__APPVERSION`.
 *  - Functional API (`registerWorkflow` / `runStep`), not decorators — the
 *    operator transpiles under tsx/esbuild (:3070) and Next/SWC (:3055),
 *    which handle decorators inconsistently.
 */
import { getHarnessAdminUrlWithSource } from '../embedded-pg-discovery';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
// Eagerly capture process identity before routines-workflow's watchdog is
// lazily imported by the first routinesTick. The watchdog must judge the
// executor against its real host boot, not the delayed first sweep.
import './process-boot-identity';
import {
  dbosOrchestratorActive,
  dbosTimersActive,
  dbosProvisionActive,
  dbosBackupActive,
  dbosRoutinesActive,
  dbosCurationActive,
  dbosReactionsActive,
  dbosPlanRenderActive,
  dbosPeriodicTimersActive,
} from './dbos-flags';

const PINNED_APP_VERSION = process.env.DBOS__APPVERSION || 'papercusp-jobs-v1';

const G = globalThis as unknown as { __papercuspDbosStarted?: boolean };

/**
 * WI-2790: DBOS's own system-database pool (a raw `pg.Pool` inside
 * @dbos-inc/dbos-sdk, wholly separate from this app's postgres-js pools in
 * libs/papercusp/libs/db/src/connection.ts) sets no idle-in-transaction GUC of its
 * own, so it silently inherits the CLUSTER-level default — 60s, per EI-49's
 * deliberate fleet-wide leak/wedge safety net (an app MCP write whose transport
 * drops mid-call must not hold a transaction-scoped advisory lock open forever).
 * That 60s budget assumed "a healthy transaction is never idle this long" — true
 * at the concurrency EI-49 was tuned for, but this host now regularly runs at
 * very high load (measured load average ~40-60 under the full agent fleet), where
 * the Node event loop can legitimately stall a DBOS queue-poller / delayed-workflow
 * transition past 60s with zero actual leak. Postgres then kills the
 * still-healthy connection ("Unexpected error in idle client: ... idle-in-transaction
 * timeout"), and DBOS's own retry logic reconnects and continues — functionally
 * harmless, but ~114 log lines/2h of noise (the WI-2790 report).
 *
 * Fix: widen the timeout ONLY on DBOS's own system-db session, via a startup
 * `options` GUC appended to its connection string (node-postgres forwards `options`
 * verbatim as a startup packet, same mechanism connection.ts uses for the app's own
 * pools — just via the URL instead of a client-options object). The CLUSTER-wide
 * default (60s) — and therefore the EI-49 safety net for every OTHER connection,
 * including this app's own pools — is untouched; only DBOS's dedicated system
 * connections get more slack. A DBOS transaction genuinely wedged for minutes is
 * still clearly anomalous and still gets killed, just later.
 */
export function withDbosIdleTxGrace(url: string): string {
  const graceSec = Math.max(60, Number(process.env.PAPERCUSP_DBOS_IDLE_IN_TX_TIMEOUT_SEC) || 300);
  const opt = encodeURIComponent(`-c idle_in_transaction_session_timeout=${graceSec * 1000}`);
  return url + (url.includes('?') ? '&' : '?') + `options=${opt}`;
}

/** Whether DBOS has actually launched in this process. The route-side A/B fall-back
 *  uses this: a flow flag can be ON while DBOS itself is OFF (PAPERCUSP_DBOS_ENABLE
 *  unset, or PG unreachable so launch was skipped) — in that case callers must use
 *  the legacy path instead of enqueuing into a non-running DBOS. */
export function dbosStarted(): boolean {
  return !!G.__papercuspDbosStarted;
}

/**
 * WI-3619 (2026-07-09 restart-storm incident): the boot-time PG probe in
 * `startDbos` is a SINGLE 5s connect attempt — and on a loaded host (the
 * /tmp/pcv incident ran load 150–290, and boot always races the esbuild
 * bundle + the whole process start storm) that one attempt can time out even
 * though PG is perfectly healthy. The old behavior then skipped DBOS FOR THE
 * PROCESS LIFETIME: no routinesTick, no git-sync routine, nothing — which
 * reads exactly like a "frozen ticker" to bghost-watchdog, whose restart then
 * re-creates the very boot-time load spike that fails the NEXT generation's
 * probe (a self-sustaining restart loop; see EI-8901). Instead of
 * skip-forever, arm a bounded-cadence retry that re-runs `startDbos()` (the
 * G-flag + probe keep it idempotent) until PG answers — DBOS then launches
 * minutes late instead of never, the ticker freshens, and the watchdog goes
 * quiet. One warn line per failed retry (30s default) keeps it diagnosable.
 */
/** Pure: resolve the PG-reachability launch-retry cadence from env (WI-3619).
 *  Exported for unit tests — mirrors `withDbosIdleTxGrace`'s floor+default
 *  shape. Floor 10s (never hammer a down/loaded PG with a tight retry loop);
 *  default 30s; a non-numeric / unset override falls back to the default
 *  (NOT the floor — floor only clamps an explicit too-small value). */
export function resolvePgLaunchRetryMs(env: NodeJS.ProcessEnv = process.env): number {
  return Math.max(10_000, Number(env.PAPERCUSP_DBOS_PG_RETRY_MS) || 30_000);
}

/**
 * DBOS wraps the PostgreSQL error raised while initializing its system
 * database in a DBOSInitializationError. Keep the retry decision independent
 * of the SDK's concrete error class: the wrapped `error.code` is the stable
 * SQLSTATE, while the message is the only signal older pg clients sometimes
 * preserve. Only the transient lock-timeout class is retryable here; a broken
 * registration, schema, or configuration must still reach host-bootstrap's
 * loud failure path.
 */
export function isRetryableDbosLaunchError(error: unknown): boolean {
  const seen = new Set<object>();
  const visit = (value: unknown): boolean => {
    if (value === null || typeof value !== 'object') return false;
    if (seen.has(value)) return false;
    seen.add(value);

    const candidate = value as {
      code?: unknown;
      message?: unknown;
      error?: unknown;
      cause?: unknown;
      originalError?: unknown;
    };
    if (candidate.code === '55P03') return true; // lock_not_available / lock_timeout
    if (typeof candidate.message === 'string' && /lock(?:[_ ]timeout|[_ ]not[_ ]available)/i.test(candidate.message)) {
      return true;
    }
    return visit(candidate.error) || visit(candidate.cause) || visit(candidate.originalError);
  };
  return visit(error);
}

const PG_LAUNCH_RETRY_MS = resolvePgLaunchRetryMs();
let pgRetryTimer: ManagedHandle | null = null;
let pgRetryInFlight = false;
let dbosStartInFlight: Promise<void> | null = null;

/**
 * EI-90 (2026-06-08 DBOS appVersion war, retriggered): arming
 * PAPERCUSP_DBOS_ENABLE=1 on the :3170 STAGING host with the default pinned
 * applicationVersion made staging steal green(:3070/the bg-host primary)'s
 * queued scheduled fires (routinesTick = git-sync!, completionRefVerify) and
 * fail them — "Cannot find workflow function" — because staging registers a
 * different workflow subset under the SAME appVersion the primary uses. Every
 * known-good secondary host (bg-host, gym instances, desktop env siblings —
 * see env-operator-launcher.ts / gym/boot-spec.ts) already pins its OWN
 * DBOS__APPVERSION explicitly; this makes that a hard REQUIREMENT on the
 * staging port specifically, instead of a convention a future arming can
 * silently skip. Pure predicate (env-injectable for tests); exported so
 * `startDbos()` can refuse loudly (host-bootstrap's catch already pages via
 * notifyAttention + broadcastSevereEvent on a thrown boot error) instead of
 * silently sharing the primary's appVersion.
 */
export function assertSafeDbosAppVersionPartition(env: NodeJS.ProcessEnv = process.env): void {
  const isStagingPort = env.PAPERCUSP_HONO_PORT === '3170';
  const hasExplicitAppVersion = !!env.DBOS__APPVERSION;
  if (isStagingPort && !hasExplicitAppVersion) {
    const pinned = env.DBOS__APPVERSION || 'papercusp-jobs-v1';
    throw new Error(
      '[dbos] refusing to launch on PAPERCUSP_HONO_PORT=3170 (the staging host) with ' +
        'PAPERCUSP_DBOS_ENABLE=1 and no explicit DBOS__APPVERSION override — the default ' +
        `pinned applicationVersion ("${pinned}") is SHARED with the primary DBOS host, so this ` +
        'process would steal + fail its queued scheduled fires (routinesTick/git-sync, ' +
        'completionRefVerify, ...) instead of running its own (EI-90, the 2026-06-08 DBOS ' +
        'appVersion war). Set a distinct DBOS__APPVERSION (and DBOS__VMID for recovery ' +
        'isolation) before arming DBOS on this host — see bg-host.service for the pattern.',
    );
  }
}

function armPgLaunchRetry(reason = 'PG reachability'): void {
  if (pgRetryTimer) return;
  console.warn(
    `[dbos] arming PG-reachability launch retry every ${PG_LAUNCH_RETRY_MS}ms — ` +
      `DBOS launches as soon as the transient boot failure clears (reason=${reason})`,
  );
  pgRetryTimer = managedSetInterval(
    'dbos-pg-launch-retry',
    PG_LAUNCH_RETRY_MS,
    () => {
      if (G.__papercuspDbosStarted) {
        pgRetryTimer?.stop();
        pgRetryTimer = null;
        return;
      }
      if (pgRetryInFlight) return; // single-flight: never overlap probes/launches
      pgRetryInFlight = true;
      void startDbos()
        .catch((e) => console.warn('[dbos] launch retry failed:', e instanceof Error ? e.message : e))
        .finally(() => {
          pgRetryInFlight = false;
          if (G.__papercuspDbosStarted && pgRetryTimer) {
            pgRetryTimer.stop();
            pgRetryTimer = null;
            console.log('[dbos] launched on retry — PG became reachable after the boot-time miss');
          }
        });
    },
    { category: 'lifecycle' },
  );
}

/**
 * Clean up the executor DBOS creates before `launch()` initializes it. The SDK
 * intentionally leaves the failed executor global so callers can inspect it,
 * but that also leaves its system-database pool open; shutdown is the only
 * supported path that destroys that pool and permits a fresh launch.
 */
async function cleanupFailedDbosLaunch(dbos: { shutdown: () => Promise<void> }): Promise<void> {
  await dbos.shutdown();
}

/** The actual launch attempt. The public wrapper below coalesces callers. */
async function startDbosOnce(): Promise<void> {
  if (G.__papercuspDbosStarted) return;

  // EI-90: cheap env-only check before any PG probe / SDK import — refuse
  // loudly rather than silently arming a second host under the primary's
  // appVersion.
  assertSafeDbosAppVersionPartition();

  const { url, source } = getHarnessAdminUrlWithSource();
  // Probe the resolved PG before launching. The source label can't distinguish
  // a *dead* native-fallback (desktop product: :5432 is the retired
  // papercusp_legacy) from a *live* one (dev box: :5432 IS the operator DB) —
  // so connect-test instead: launch when reachable, skip cleanly when not.
  {
    const postgres = (await import('postgres')).default;
    const probe = postgres(url, { max: 1, connect_timeout: 5, prepare: false });
    try {
      await probe`SELECT 1`;
    } catch (err) {
      console.warn(
        `[dbos] resolved PG not reachable (source=${source}) — deferring DBOS launch:`,
        err instanceof Error ? err.message : err,
      );
      await probe.end({ timeout: 2 }).catch(() => {});
      // WI-3619: retry instead of skip-forever (see armPgLaunchRetry's doc).
      armPgLaunchRetry();
      return;
    }
    // WI-10004954 — if this executor's previous process shut down GRACEFULLY (it left a
    // marker at SIGTERM/SIGINT), give each of its in-flight workflows back the recovery
    // attempt that the re-dequeue after DBOS.launch() is about to charge. Runs on this
    // probe connection, against the exact database DBOS recovers from, before launch.
    // Crashes leave no marker and still count. Best-effort: a failure leaves the attempt
    // counted (the pre-fix behaviour) and never blocks the launch.
    try {
      const [{ consumeGracefulShutdownCredit }, { DBOS: DbosForCredit }] = await Promise.all([
        import('./graceful-shutdown-recovery-credit'),
        import('@dbos-inc/dbos-sdk'),
      ]);
      const credit = await consumeGracefulShutdownCredit({
        sql: probe,
        executorId: DbosForCredit.executorID,
      });
      if (credit.outcome === 'credited') {
        console.log(
          `[dbos-graceful-credit] previous ${credit.marker.signal} was graceful: credited ` +
            `${credit.ids.length} in-flight workflow(s) on executor ${credit.marker.executorId}` +
            `${credit.ids.length > 0 ? `: ${credit.ids.slice(0, 10).join(', ')}` : ''}`,
        );
      } else if (credit.outcome !== 'no-marker') {
        console.warn(`[dbos-graceful-credit] marker not credited: ${JSON.stringify(credit)}`);
      }
    } catch (e) {
      console.warn(
        '[dbos-graceful-credit] boot credit failed (non-fatal), the restart counts as a recovery attempt:',
        e instanceof Error ? e.message : e,
      );
    }
    await probe.end({ timeout: 2 }).catch(() => {});
  }

  const { DBOS } = await import('@dbos-inc/dbos-sdk');
  DBOS.setConfig({
    name: 'papercusp-operator',
    systemDatabaseUrl: withDbosIdleTxGrace(url),
    systemDatabaseSchemaName: 'dbos',
    applicationVersion: PINNED_APP_VERSION,
    // The operator shares a box with Restart (shop-api binds :3001); DBOS's
    // admin server defaults to :3001 and would EADDRINUSE. We don't use it.
    runAdminServer: false,
  });

  // Register workflows BEFORE launch so recovery + the scheduler can bind them.
  await import('./hello-workflow');
  // BYOC P-046 / D-100: every workspace-host provision enters this host-scoped
  // dedup workflow. It is always registered because the route is flag-ON and a
  // recovered in-flight host operation must bind even before a new request arrives.
  const { registerWorkspaceHostProviderFactories } = await import('../workspace-host/provider-factories');
  const { resolveHostedGcpAuth } = await import('../workspace-host/hosted-gcp-auth');
  // WI-10001672: bind the teardown-obligation ledger's PRODUCING half here. Without this the
  // sweep in periodic-workflows runs over a table nothing writes to and reports "no outstanding
  // obligations" for a project full of live metered resources — absence that reads as an
  // all-clear. This is the composition root where a provisioning provider first gets a DB handle,
  // so it is the one place the binding can be made for every provision path at once.
  const [
    { createCloudResourceObligationObserver, createCloudResourceObligationCloseObserver },
    { getOrgPg },
  ] = await Promise.all([
    import('../workspace-host/cloud-resource-obligations'),
    import('@papercusp/db-org'),
  ]);
  // The CONSUMING half. Bound at the same composition root as its producing twin: without it
  // `closeCloudResourceObligation` has zero production callers, every row stays teardown_owed
  // forever, and the sweep escalates on phantoms — which makes a REAL leak indistinguishable from
  // a torn-down one (EI-23459044188861686). Shared by every cloud provider factory below.
  const obligationObservers = (provider: 'gcp' | 'aws') => {
    const closeObligation = createCloudResourceObligationCloseObserver({
      sql: getOrgPg().sql,
      provider,
      onUnmatched: (event) => {
        // Loud on purpose: a confirmed destroy that matched no open obligation means the
        // create-side kind and the delete-side kind have drifted apart, and a silent
        // `closed:false` here is exactly how that drift stays invisible.
        console.warn(
          '[cloud-resource-obligations] confirmed destroy matched no open obligation',
          {
            workspaceId: event.workspaceId,
            deleteOp: event.resource.deleteOp,
            resourceId: event.resource.providerId,
            incarnationId: event.resource.incarnationId,
          },
        );
      },
    });
    return {
      onResourceCreated: createCloudResourceObligationObserver({ sql: getOrgPg().sql, provider }),
      // Adapted to the provider's fire-and-forget observer contract: the close observer returns
      // { closed } so callers and tests can assert on it, while the provider deliberately does
      // not consume a result from an observer.
      onResourceDestroyed: async (event: Parameters<typeof closeObligation>[0]) => {
        await closeObligation(event);
      },
    };
  };
  // aws-byoc-gcp-parity-2026-10-01 P-003: 'gcp' and 'aws' register through ONE exported function
  // with the same obligation observers, so an EC2 instance or EBS volume is tracked from creation
  // to provider-confirmed absence exactly like a GCP disk, and the registration is unit-testable.
  registerWorkspaceHostProviderFactories({ resolveHostedGcpAuth, obligationObservers });
  await import('./workspace-host-provision-workflow');
  // D-391: the day-long workspace-host soak runs on its OWN queue (the provisioning queue's
  // host-scoped dedup would lock lifecycle actions out for the whole soak). Registered before
  // launch so a controller restart mid-soak recovers it instead of orphaning a day of samples.
  await import('./workspace-host-soak-workflow');
  // WI-10004950: standing health for every live hosted host this controller holds authority for
  // (15-minute schedule). Ungated: a process that controls no host lists nothing and probes nothing.
  await import('./workspace-host-health-workflow');
  // The director-cadence autoloop workflow is RETIRED (autoloop-pot-operator-
  // rebuild-2026-06-05 P-010 / D-009): it read `.papercusp/director-config.json`,
  // an enablement surface nothing wrote. Scheduled decider fires are the routines
  // engine's job — blueprint `triggers.schedule` → `system:blueprint-run` — with
  // the consecutive_errors backoff gate in lib/autoloop.ts protecting the fires.
  if (dbosPeriodicTimersActive()) {
    // Phase 2 (default-on with the orchestrator): periodic timers (telemetry flush,
    // scratch GC, memory cleanup, completion-ref verify, embed backfill, backup
    // cadence) as scheduled workflows; their legacy setInterval workers stand down
    // on dbosTimersActive(). Disable with PAPERCUSP_DBOS_TIMERS=0. A headless UTILITY
    // host skips these shared-DB periodic drains (EI-596) — see dbosPeriodicTimersActive.
    await import('./periodic-workflows');
  }
  if (dbosOrchestratorActive()) {
    // Phase 3 / P-009: the agent pipeline as a durable workflow is now the DEFAULT
    // orchestrator (on unless PAPERCUSP_DBOS_ORCHESTRATOR=0). The legacy main loop
    // is RETIRED — archived to libs/papercusp/_retired/orchestrator-run-loop/ on
    // 2026-06-06 (archive-legacy-orchestrator-deadcode). Setting =0 does NOT revert
    // to it (there is no legacy loop left to revert to); it just leaves no DBOS
    // orchestrator registered at all.
    // Register the workflow + wire the real invoke runner (spawns invoke-once with
    // IDEMPOTENCY_KEY).
    await import('./orchestrator-workflow');
    const { wireOrchestratorInvokeRunner } = await import('./orchestrator-runner');
    wireOrchestratorInvokeRunner();
    // The orchestrator (scheduled): scans PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES for
    // features needing work and starts pipelines (no-op until harnesses opt in).
    await import('./orchestrator-loop');
    // coordination-ops-as-blueprint-primitives P-005: the durable coord-op
    // PROGRAM executor (vote / deliberate) — the program-mode sibling of the
    // feature pipeline. Register the workflow + wire the agent-spawn runner for
    // `orchestrator:spawn-roles`. Additive: no harness uses a program spine until
    // one is created with a `vote`/`deliberate`-shaped blueprint.
    await import('./coord-program-workflow');
    const { wireCoordSpawnRunner } = await import('./coord-spawn-runner');
    wireCoordSpawnRunner();
    // unify-agent-spawn-chokepoint P-010: register the reusable durable-spawn
    // wrapper (autonomous launch-blueprint fires survive a host crash + re-run
    // once) BEFORE launch, alongside the feature-pipeline + coord-program workflows.
    await import('./durable-spawn');
    // portable-identity-packages P-018 (D-029 §5): worn async identity rules run as
    // their own durable workflow + queue — never the in-process reaction path, and
    // not gated on PAPERCUSP_DBOS_REACTIONS (set on no unit). Request workers reach
    // it through a DBOSClient enqueue (events/identity-reaction.ts).
    await import('./identity-reaction-workflow');
  }
  if (dbosProvisionActive()) {
    // dbos-flows P-001/P-002 (default-on; disable with PAPERCUSP_DBOS_PROVISION=0):
    // the plugin setup/teardown/verify provision as a durable workflow — register it
    // before launch so DBOS recovery can resume an interrupted provision. The legacy
    // claim path in provision/runner stands down when this is active.
    await import('./provision-workflow');
  }
  if (dbosBackupActive()) {
    // dbos-flows P-011 (opt-in; enable with PAPERCUSP_DBOS_BACKUP=1): the workspace
    // snapshot op as a durable workflow via the generic StepRunner seam (D-010).
    // Register the workflow before launch (so recovery can resume an interrupted
    // snapshot) and inject the DBOS-backed StepRunner into @papercusp/backup. When
    // off, the lib's snapshot() runs un-stepped exactly as before.
    const { wireBackupStepRunner } = await import('./backup-workflow');
    wireBackupStepRunner();
  }
  if (dbosRoutinesActive()) {
    // git-sync-auto-commit Phase 1 (opt-in; PAPERCUSP_DBOS_ROUTINES=1): the generic
    // scheduled-routines engine — a durable `routinesTick` driving
    // `harness_shared.routines`, replacing the dormant in-process `routine-ticker`.
    // git-sync rides it as the first `system:` action. Registered before launch so
    // recovery + the scheduler bind it.
    await import('./routines-workflow');
  }
  if (dbosCurationActive()) {
    // curator-operator P0 (opt-in; PAPERCUSP_DBOS_CURATION=1): the scheduled
    // `curationTick` — consumes the fleet's structured status, applies the
    // salience policy, and surfaces curated messages into the operator chat
    // ("faster when busy, slower when quiet"). Registered before launch so the
    // scheduler binds it. The urgent (event-driven) half is armed separately
    // below, after launch, so escalations/blockers surface immediately.
    await import('./curation-workflow');
  }
  if (dbosReactionsActive()) {
    // event-reaction-system P1 (opt-in; PAPERCUSP_DBOS_REACTIONS=1): durable
    // reaction execution — a matched reaction runs as a DBOS-queued workflow
    // (survives restart, retried, idempotent via the dedup ledger migration 153)
    // instead of the default in-process fire-and-forget. Register the workflow +
    // queue before launch (so recovery can resume an interrupted reaction) and
    // INJECT the enqueue runner into lib/events. When off, lib/events fires every
    // reaction in-process exactly as today.
    const { wireDurableReactions } = await import('./event-reaction-workflow');
    wireDurableReactions();
  }
  if (dbosPlanRenderActive()) {
    // plan-markdown-auto-render P-006 (opt-in; PAPERCUSP_DBOS_PLAN_RENDER=1): the
    // scheduled `planMarkdownRender` workflow mirrors PG-canonical plans to on-disk
    // markdown under apps/operator/docs/plans/ (incremental + coalesced +
    // settle-guarded, read-only projection). Registered before launch so the
    // scheduler binds it. Opt-in because it writes the tracked tree (git-sync
    // commits the mirror) — see dbosPlanRenderActive.
    await import('./plan-markdown-render-workflow');
  }

  // blueprint-backed-work-item-execution-2026-09-23 P-019 (D-019): explicitly durable tool
  // orchestration — one workflow per `orchestrate:run { execution.durability:'durable' }` run,
  // one checkpointed step per nested tool call. Registered (ungated) before launch so DBOS
  // recovery resumes an interrupted run; nothing executes until a caller admits a durable run.
  await import('./durable-orchestration-workflow');

  // agent-economy-flywheel-2026-08-30 P-041 (D-024): hourly anchoring of the hash-chained
  // ledgers. Registered ungated before launch; a pass publishes only when an anchor key is
  // configured (otherwise it checks cadence and files one missed-hour alert per workspace),
  // and PAPERCUSP_LEDGER_ANCHOR_BACKEND=none turns it off.
  await import('./ledger-anchor-workflow');

  // agent-economy-flywheel-2026-08-30 P-043 (D-025): hourly money reconciliation, plus the
  // month-close final run. Registered ungated: with no rails configured every source reads
  // not-configured and no gate is pushed, so the Worker keeps DAO transfers paused.
  await import('./reconciliation-workflow');

  // EI-20196041413229589: register the release:checkpoint-run eligibility waiter before
  // DBOS.launch, then install its request-side enqueue seam only after the runtime is live.
  // This keeps waitForEligibility transport-safe without making DBOS a request-handler import.
  const { wireCheckpointEligibilityWait } = await import('./checkpoint-eligibility-workflow');
  // D-131 (p2p-public-release-endgame): debounced auto-verify after a persisted repair admit.
  // Same split: register before launch, wire the enqueue seam after.
  const { wireRepairAutoVerify } = await import('./repair-auto-verify-workflow');

  try {
    await DBOS.launch();
  } catch (err) {
    if (!isRetryableDbosLaunchError(err)) throw err;

    // DBOS creates its global executor before migrations run. A lock timeout
    // therefore leaves an uninitialized executor + pool behind; retrying
    // launch directly would leak one pool per attempt and can make the next
    // attempt fail for an unrelated reason. Cleanup must settle before the
    // bounded retry is armed. If cleanup itself fails, preserve the original
    // initialization error and let the caller's loud failure path handle it.
    try {
      await cleanupFailedDbosLaunch(DBOS);
    } catch (cleanupErr) {
      console.warn(
        '[dbos] failed to clean up the transient launch executor; retry not armed:',
        cleanupErr instanceof Error ? cleanupErr.message : cleanupErr,
      );
      throw err;
    }

    console.warn(
      '[dbos] transient system-database lock timeout during launch; ' +
        'executor cleaned up and a bounded retry is armed',
    );
    armPgLaunchRetry('DBOS system-database initialization lock timeout');
    return;
  }
  G.__papercuspDbosStarted = true;
  wireCheckpointEligibilityWait();
  wireRepairAutoVerify();
  console.log(`[dbos] launched (schema=dbos, source=${source}, appVersion=${PINNED_APP_VERSION})`);

  // WI-10001739 link 3b — the hosted-lifecycle reconciler runs as `harness_app` and must read
  // `dbos.workflow_status` to tell "the executor died" from "the executor is busy". Migration
  // 1172 grants that, but it can only grant on a database where schema `dbos` ALREADY existed:
  // the SDK creates that schema at runtime, right here, which is strictly after migrations run.
  // So a freshly-migrated database would otherwise never receive the grant, and the reconciler
  // would silently fall back to recency forever. Re-applying it post-launch is what makes the
  // two paths converge in either order.
  //
  // Best-effort by design: a failure here is safe, because an unreadable probe is classified
  // `unknown` and degrades to exactly the pre-3b behaviour rather than reaping on absent
  // evidence. It must never fail boot.
  await grantDbosWorkflowStatusRead().catch((err) => {
    console.warn(
      '[dbos] could not grant harness_app read on dbos.workflow_status; the hosted-lifecycle ' +
        'reconciler will fall back to recency-only liveness:',
      err instanceof Error ? err.message : err,
    );
  });

  // EI-455 — start the dead-executor reaper: an immediate boot reap (clears dedup
  // wedges left by a prior crash/restart) plus a 2-min process-level sweep that runs
  // OUTSIDE the DBOS routine engine, so it un-wedges the scheduler even when the
  // routine engine is itself frozen. See dbos-executor-reaper.ts. Best-effort —
  // must not fail boot.
  try {
    const [{ startExecutorReaper }, { getOrgPg }] = await Promise.all([
      import('./dbos-executor-reaper'),
      import('@papercusp/db-org'),
    ]);
    startExecutorReaper(getOrgPg().sql);
    // EI-19451658870832332 — ARMING RECEIPT. The reaper is provably executing (its
    // dead-executor scan increments in pg_stat_statements on the 120s cadence) while
    // being ABSENT from every `listManaged()` read served by /api/internal/managed-timers
    // — including bg-host's own, the only host with PAPERCUSP_BACKGROUND_WORKERS=1.
    // Every EXTERNAL probe has been exhausted (see the work-item: kill-switch, registry
    // filtering, dual-package, --preserve-symlinks, unix-socket backends, and a
    // controlled experiment that FALSIFIED dynamic-import registry duplication).
    // Two live hypotheses remain and this ONE line discriminates them from inside the
    // process, which nothing outside it can:
    //   * line never appears  => the `await Promise.all([...])` above HUNG (a hang throws
    //     nothing, so the existing catch stays silent) and arming never ran — which would
    //     also explain why startGreenStallWatchdog below is missing from the same registry.
    //   * line appears with a count/flag that DISAGREES with what the route reports
    //     => two live instances of the scheduled-registry module in one process.
    // Deliberately logs the BOOT graph's own view so it can be diffed against the route's.
    const { listManaged } = await import('@papercusp/scheduled-registry');
    const armed = listManaged();
    console.log(
      `[dbos-executor-reaper] armed — boot-graph registry: ${armed.length} timer(s), ` +
        `reaperPresent=${armed.some((t) => t.name === 'dbos-executor-reaper')}`,
    );
  } catch (e) {
    console.warn('[dbos-executor-reaper] failed to start (non-fatal):', e instanceof Error ? e.message : e);
  }

  // WI-10004954 — a graceful restart must not spend an in-flight workflow's DBOS recovery
  // budget (every dequeue charges one; boot recovery re-dequeues). On SIGTERM/SIGINT this
  // writes a marker SYNCHRONOUSLY, ahead of the host's own drain (which may SIGKILL itself
  // within a second); the next boot credits the attempt back before DBOS.launch(). The
  // first version credited over PG inside the handler and was killed mid-flight
  // (2026-10-01 18:14:25Z). Crashes still count. Best-effort: a failure leaves the
  // pre-fix behaviour.
  try {
    const [{ armGracefulShutdownMarker }, { DBOS: DbosForCredit }] = await Promise.all([
      import('./graceful-shutdown-recovery-credit'),
      import('@dbos-inc/dbos-sdk'),
    ]);
    const executorId = DbosForCredit.executorID;
    armGracefulShutdownMarker({ executorId });
    console.log(`[dbos-graceful-credit] shutdown marker armed for executor ${executorId}`);
  } catch (e) {
    console.warn('[dbos-graceful-credit] failed to arm (non-fatal):', e instanceof Error ? e.message : e);
  }

  // EI-455 bug #2 — start the green-checkpoint silent-stall watchdog: a process-
  // level sweep (NOT a DBOS routine, same reason as the reaper) that alarms when an
  // ACTIVE green-checkpoint routine stops firing or stops producing greens. The
  // in-routine detector (trackGateStall) only runs when the routine fires, so it is
  // blind to the routine NOT firing — the actual EI-455 stall. See
  // release/green-stall-watchdog.ts. Best-effort — must not fail boot.
  try {
    const [{ startGreenStallWatchdog }, { getOrgPg }] = await Promise.all([
      import('../release/green-stall-watchdog'),
      import('@papercusp/db-org'),
    ]);
    startGreenStallWatchdog(getOrgPg().sql);
    // Sibling: git-sync FIRING-but-not-COMMITTING (the 2026-06-30 ~6h silent strand — DBOS
    // reaping stuck fires). Same process-level rationale; reads git-sync routine health.
    const { startGitSyncStallWatchdog } = await import('../release/git-sync-stall-watchdog');
    startGitSyncStallWatchdog(getOrgPg().sql);
    // Sibling (WI-5607, EI-13924 follow-up): the ONE class the above two watchdogs cannot
    // see — a BRIDGED hive whose member git-sync keeps advancing local HEAD every tick while
    // the bridge writer's egress to GitHub origin is actually stuck. Independent of the
    // bridge's own divergence classifier (which only fires on structured residues). Kill-
    // switch: PAPERCUSP_ORIGIN_FRESHNESS_WATCHDOG='0'.
    try {
      const { startOriginFreshnessWatchdog } = await import('../release/origin-freshness-watchdog');
      startOriginFreshnessWatchdog(getOrgPg().sql);
    } catch (e) {
      console.warn('[origin-freshness-watchdog] failed to start (non-fatal):', e instanceof Error ? e.message : e);
    }
    // Sibling (WI-757 part b): a federation VM whose swarm join keeps failing (e.g. gh auth
    // lost across a restart) silently stays local-only forever with nothing escalating it.
    // Reads the in-process boot-history ring only — no DB round-trip needed.
    try {
      const { startFederationJoinStallWatchdog } = await import('../sync/hyperbee/federation-join-stall-watchdog');
      startFederationJoinStallWatchdog();
    } catch (e) {
      console.warn('[federation-join-stall-watchdog] failed to start (non-fatal):', e instanceof Error ? e.message : e);
    }
    // Sibling (WI-3612, EI-8820 follow-up): a git worktree carrying uncommitted edits that
    // NO git-sync routine (or documented exclusion) covers — the class that stranded WI-3449
    // for hours (an agent worked inside a linked env-tree worktree git-sync never sees).
    // Cheap (no DB round-trip; shells `git worktree list` + `git status` per worktree) and
    // scoped to THIS repo's own canonical checkout. Kill-switch:
    // PAPERCUSP_WORKTREE_COVERAGE_WATCHDOG='0'.
    try {
      const { startWorktreeCoverageWatchdog } = await import('../release/worktree-coverage-watchdog');
      const { execFileSync } = await import('node:child_process');
      // Same resolution pattern as desktop-install/workspace-map.ts: ask git for the
      // canonical checkout root rather than trusting process.cwd() (which is wherever
      // this process happened to boot from, e.g. apps/operator/).
      let repoRoot: string;
      try {
        repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
          encoding: 'utf8',
          timeout: 5000,
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        repoRoot = process.cwd();
      }
      startWorktreeCoverageWatchdog(repoRoot);
    } catch (e) {
      console.warn('[worktree-coverage-watchdog] failed to start (non-fatal):', e instanceof Error ? e.message : e);
    }
    // Sibling (Layer 4, mcp-host-availability-resilience): a spawned bee working DARK (tool-less)
    // after a :3070 deploy restart — alive + generating output, but its tool-call-coupled presence
    // beat predates the restart, so it never re-attached its papercusp MCP. Same process-level
    // rationale. The safety net under Layers 1–3 (permanent URLs · sticky approval · the :9071
    // proxy). Kill-switch: PAPERCUSP_MCP_DARK_WATCHDOG='0'.
    const { startMcpDarkWatchdog } = await import('../system-health/mcp-dark-watchdog');
    startMcpDarkWatchdog(getOrgPg().sql);
    // WI-4663: Codex 0.144+ can keep a live process + history.jsonl fresh while
    // its rollout JSONL stops appending. Detect that silent transcript loss
    // outside DBOS so a scheduler wedge cannot hide the alarm.
    const { startCodexRolloutPersistenceWatchdog } =
      await import('../system-health/codex-rollout-persistence-watchdog');
    startCodexRolloutPersistenceWatchdog(getOrgPg().sql);
    // Sibling (agent-managed-compaction P-009): caches each limit-setting session's
    // context-size estimate on coord_presence (feeds the coord:inbox usage signal, P-007)
    // and logs sessions that ran past their own compaction_limit. Kill-switch:
    // PAPERCUSP_COMPACTION_WATCHDOG='0'.
    const { startCompactionComplianceWatchdog } = await import('../system-health/compaction-compliance-watchdog');
    startCompactionComplianceWatchdog(getOrgPg().sql);
    // EI-12755: escalate dropped/respawn-failed P-020 carry drills in real time
    // (the shared drill ledger is durable but was only read on demand — 2/2
    // silent failures sat unnoticed ~40min on 2026-07-15). Runtime gate:
    // FLAGS.CARRY_DRILL_DROP_WATCHER (default ON), checked per tick.
    const { startCarryDrillDropWatchdog } = await import('../system-health/carry-drill-drop-watchdog');
    startCarryDrillDropWatchdog();
    // EI-18741922664751805: alarm on the RATE at which the long-lived operator
    // units restart. :3170 ran ~10 restarts/hour through 2026-07-26 with nothing
    // watching, and a restart storm on papercup-dev-api is worse still — the
    // headless fleet children live in THAT unit's cgroup. Runtime gate:
    // FLAGS.SERVICE_RESTART_RATE_WATCHDOG (default ON), checked per tick.
    const { startServiceRestartRateWatchdog } = await import('../system-health/service-restart-rate-watchdog');
    startServiceRestartRateWatchdog();
    // cold-with-carry-activation-2026-07-20 (A2): the BOOTSTRAP for P-021 cold-by-default.
    // Grades prior respawned drills + starts ONE cold-boot drill per pass on an eligible
    // HEADLESS host until 'claude-headless' is drill-proven, so classDefaultColdForWake
    // finally engages for the headless fleet (EI-18133456688790756). Runtime gate:
    // FLAGS.COLD_BOOT_DRILL_AUTORUNNER (default ON); hard kill-switch:
    // PAPERCUSP_COLD_BOOT_DRILL_AUTORUNNER='0'.
    const { startColdBootDrillAutorunner } = await import('../system-health/cold-boot-drill-autorunner');
    startColdBootDrillAutorunner();
    // EI-18754773151573358: the sibling of dead-workflow-monitor for the OTHER silent
    // DBOS failure — a workflow DBOS keeps loyally RECOVERING forever because it hangs
    // inside a step (never reaches a terminal ERROR/MAX_RECOVERY_ATTEMPTS_EXCEEDED
    // state dead-workflow-monitor watches). Read-only; does not touch the reaper or
    // recovery logic. Kill-switch: PAPERCUSP_DBOS_HANG_WATCHDOG='0'.
    const { startDbosHangWatchdog } = await import('./dbos-hang-watchdog');
    startDbosHangWatchdog(getOrgPg().sql);
    // system-notices-on-its-own-2026-08-16 P-001: alarm on a status='active' goal
    // that nobody is working. The GOAL layer had NO detector at all — every layer
    // below it was watched — and on 2026-08-16, 4 of 6 active goals had a stale
    // agent_modes holder row and no live session behind it (two of them real
    // product goals, dark 2-5 days). Deliberately a process-level timer rather
    // than anything an agent must claim: the sibling failure it answers
    // (blender-steward-heartbeat D-005) is a recovery mechanism that could not run
    // during the outage it targeted, because its runs execute by claiming a
    // work-item and nobody was alive to claim one. Runtime gate:
    // FLAGS.GOAL_LIVENESS_WATCHDOG (default ON), checked per tick.
    const { startGoalHolderRespawner, startGoalLivenessWatchdog, startStandingGoalBootArm } =
      await import('../system-health/goal-liveness-watchdog');
    startGoalLivenessWatchdog(getOrgPg().sql);
    // goal-live-holder-guarantee-2026-08-18 P-009: a SEPARATE 60s actor for
    // goals that explicitly opt into holder.onLoss='respawn'. Its own
    // default-OFF owner-authority flag keeps report-only liveness enabled
    // without silently arming unattended agent spend.
    startGoalHolderRespawner(getOrgPg().sql);
    // work-on-everything-goal-2026-08-23 P-011 (retirement doc open loss #3):
    // the owner-armed operator-boot arm — a BOUNDED boot window (10 passes ×
    // 60s, then self-stop) that respawns the LOST holder of an active,
    // un-paused STANDING goal with holder.onLoss='respawn'. Dark
    // owner-authority flag STANDING_GOAL_BOOT_ARM; defers per-pass to
    // GOAL_HOLDER_RESPAWN whenever the runtime respawner is armed.
    startStandingGoalBootArm(getOrgPg().sql);
    // EI-19919820196426791 half 2: alarm on an issue that is simultaneously
    // `critical` and structurally UNCLAIMABLE (observation lane / needs-human)
    // past a 7-day floor. The write-time guard on set_priority/update covers the
    // STEERING case — you are told the moment your steer is a no-op — but it
    // cannot see an item NOBODY WRITES TO, which is precisely how the filed
    // instance hid for 19 days. A periodic sweep is the only thing that closes
    // the never-touched mis-file. Runtime gate:
    // FLAGS.UNSERVABLE_CRITICAL_WATCHDOG (default ON), checked per tick.
    const { startUnservableCriticalWatchdog } = await import('../system-health/unservable-critical-watchdog');
    startUnservableCriticalWatchdog(getOrgPg().sql);
    // system-notices-on-its-own-2026-08-16 P-002: alarm when a sustained share of
    // hybrid searches did not run at full strength. summariseLegs already judged
    // every search; observeLegs now retains those verdicts in a trailing window,
    // and this reads the rate. Armed HERE because the counter is in-process and
    // this is the process the agent-facing search paths run in. Runtime gate:
    // FLAGS.RETRIEVAL_DEGRADATION_WATCHDOG (default ON), checked per tick.
    const { startRetrievalDegradationWatchdog } = await import('../system-health/retrieval-degradation-watchdog');
    startRetrievalDegradationWatchdog();
    // WI-10002031: alarm when ~/.papercusp/hooks/cc (the copy that actually
    // executes on every agent turn) diverges from the canonical hooks under the
    // integration root. The class has recurred twice and was caught both times
    // only by an agent hand-diffing the two files, because a stale hook is a
    // valid script that merely lacks the fix and so fails silently. Hourly; it
    // escalates on a FAILED MEASUREMENT as well as on drift, since the detector
    // is fail-closed and a refusal would otherwise render as clean.
    const { startInstalledHookDriftWatchdog } = await import('../system-health/installed-hook-drift-watchdog');
    startInstalledHookDriftWatchdog();
    // WI-10006236 (#1309 prevention): Claude Code updates itself, and 2.1.289 silently
    // made 1M-default sessions run at 200k (WI-10006049). Once per new active build, and
    // once per boot, run that build headlessly through the gateway and escalate if a
    // 1M-default family is not served at 1M, or if the probe could not measure. Host
    // singleton only: each probe is a real model request.
    const { startClaudeUpdateCanary } = await import('../system-health/claude-update-canary');
    startClaudeUpdateCanary();
    // WI-10002060: alarm when a live session's identity activation cannot be
    // reconciled with its launch record, which makes the kernel refuse EVERY
    // tool. The denial is SELF-SEALING — a wedged session cannot file its own
    // bug, because filing one is a tool call — so the finding has to be raised
    // from outside the failure domain, which is what this sweep is for. Hourly,
    // and fail-closed: a failed read, or a scan that matched zero rows it should
    // have matched, escalates as NOT MEASURED rather than rendering as clean.
    const { startWedgedIdentityActivationWatchdog } = await import('../system-health/wedged-identity-activation-watchdog');
    startWedgedIdentityActivationWatchdog();
    // EI-21491088289861649: alarm when a search caller's query-embed p99
    // breaches THAT caller's own budget. The sibling above sees only leg
    // OUTCOMES, so a slow-but-succeeding embed (measured: 1.92s cold vs ~1ms
    // warm against a healthy sidecar — under search's 4000ms budget while
    // blowing mid-turn's 1200ms) never trips it. Armed HERE for the same
    // reason: the sampler is in-process and this is the process the
    // agent-facing search paths run in. Runtime gate:
    // FLAGS.EMBED_LATENCY_WATCHDOG (default ON), checked per tick.
    const { startEmbedLatencyWatchdog } = await import('../system-health/embed-latency-watchdog');
    startEmbedLatencyWatchdog();
    // EI-20581099901890760 half 2: alarm on a live-HELD goal missing the standing
    // drain fleet the GOAL contract requires. Sibling of the liveness watchdog
    // above, deliberately separate (its author's ruling): that one fires when
    // nobody is working a goal; this one fires only when somebody IS and the
    // drain fleet — the mechanism that makes never-implement livable — is absent
    // or dead. Runtime gate: FLAGS.GOAL_DRAIN_FLEET_WATCHDOG (default ON).
    const { startGoalDrainFleetWatchdog } = await import('../system-health/goal-drain-fleet-watchdog');
    startGoalDrainFleetWatchdog(getOrgPg().sql);
    // WI-42442: the present-but-unproductive sweep, generalised past goal holders
    // to EVERY agent. The goal legs above ask "is anyone alive on this goal?"; this
    // one asks the question that survives a yes — "is this session, which every
    // dispatcher reads as wakeable, actually producing anything?". Measured
    // 2026-08-27: 22 of 166 present sessions had never made an agent-origin call.
    // Escalates ONE correlated wave per (workspace, phase), report-only, never
    // respawns. Runtime gate: FLAGS.AGENT_PRODUCTIVITY_WATCHDOG (default ON).
    const { startAgentProductivityWatchdog } = await import(
      '../system-health/agent-productivity-watchdog'
    );
    startAgentProductivityWatchdog(getOrgPg().sql);
    // P-008 (EI-20581177540737568 half 2): near-real-time alarm on the FIRST
    // edit-claim by a goal-mode owner — the deterministic never-implements
    // instrument (edit_attribution_ledger x goal-mode agent_modes). A grader
    // sampling a run always loses to a violation between samples (28-min gap
    // measured, WI-39348); this sweep closes it to ≤~2 min and injects both the
    // subject and its graders. Runtime gate: FLAGS.GOAL_EDIT_CLAIM_WATCHDOG
    // (default ON), checked per tick.
    const { startGoalEditClaimWatchdog } = await import('../system-health/goal-edit-claim-watchdog');
    startGoalEditClaimWatchdog(getOrgPg().sql);
    // P-009: nudge a goal-mode owner whose ACTIVE goal has gone report-silent past
    // the 4h cadence floor — one directed wake per silence with the GOAL contract's
    // report skeleton (what moved / what it cost / what is owner-walled / what you
    // killed). The measured failure (WI-39348): exemplary reporting for 2.5h, then
    // 5h of silence including at goal-met. Fires only on a POSITIVELY-alive owner
    // (a dead one is the liveness watchdog's lane). Runtime gate:
    // FLAGS.GOAL_OWNER_REPORT_WATCHDOG (default ON), checked per tick.
    const { startGoalOwnerReportWatchdog } = await import('../system-health/goal-owner-report-watchdog');
    startGoalOwnerReportWatchdog(getOrgPg().sql);
    // goal-mode-design-intent-hardening-2026-08-16 P-005 (D-003): the goal spend
    // rollup tick — writes goals.metadata.spentCents platform-side from the cost
    // ledger (pot leg + subject/descendant session leg) so "actual spend
    // reported" is satisfiable without agent self-report. Same process-level
    // mechanism as the goal watchdogs above, same reason (EI-1622 workflow_status
    // bloat). Runtime gate: FLAGS.GOAL_SPEND_ROLLUP_TICK (default ON), per tick.
    const { startGoalSpendRollupTick } = await import('../goals/spend-rollup');
    startGoalSpendRollupTick(getOrgPg().sql);
  } catch (e) {
    console.warn('[stall-watchdog] failed to start (non-fatal):', e instanceof Error ? e.message : e);
  }

  // EI-1747 — structural-error verifier: a process-level sweep (NOT a DBOS routine, same
  // reason as the watchdogs above — EI-1622 workflow_status bloat) that AUTO-RESOLVES OPEN
  // watchdog structural-error EIs whose offending tool has emitted no error in the deployed
  // operator's live telemetry (tool_invocations) for a quiet window. The inverse of
  // completion-ref-verifier (presence-on-remote ↔ absence-on-deployed); stops already-fixed
  // items rotting open + agents re-investigating landed fixes.
  //
  // EI-19453017656411107: DEFAULT-ON since 2026-08-03; kill-switch is
  // PAPERCUSP_STRUCTURAL_ERROR_VERIFIER='0' (same polarity as the DBOS hang watchdog
  // above). It had been opt-IN ("DEFAULT-OFF until validated") and was consequently
  // NEVER ARMED on :3070 from the day it was written — measured dark on pid 621668 with
  // 0 log lines in 6h — so the waste it exists to prevent kept being paid by hand: on
  // 2026-08-03 alone, agents burned wakes re-investigating landed fixes on
  // EI-19452068575891376 and others. It IS validated (7/7 unit tests) and its decision is
  // deliberately conservative (resolve only when recurrences===0 AND the item is older
  // than the 6h window, ≤50/tick), and a wrongly-resolved item is re-filed by the
  // watchdog on the next recurrence. Best-effort — must not fail boot.
  if (process.env.PAPERCUSP_STRUCTURAL_ERROR_VERIFIER !== '0') {
    try {
      const { startStructuralErrorVerifier } = await import('../harness/structural-error-verifier');
      startStructuralErrorVerifier({ log: (m) => console.warn(m) });
    } catch (e) {
      console.warn('[structural-error-verifier] failed to start (non-fatal):', e instanceof Error ? e.message : e);
    }
  }

  if (dbosCurationActive()) {
    // Arm the event-driven urgent wake (curator-operator P2): coord_inbox →
    // immediate urgent-only curation tick, so escalations/blockers surface
    // without waiting for the cadence. Post-launch so the LISTEN is established
    // after DBOS is up. Best-effort — a wake-wiring failure must not fail boot.
    try {
      const { startCurationUrgentWake } = await import('../curation/urgent-wake');
      startCurationUrgentWake();
    } catch (e) {
      console.warn('[curation] failed to arm urgent wake:', e instanceof Error ? e.message : e);
    }
  }

  // Arm the D-003 per-turn auto-renewal of plan-item ACTIVITY claims
  // (plan-item-assignment-claim-liveness-2026-06-04): the activity bridge already
  // fires per completed turn → renew the reporting owner's shared-harness activity
  // claims, so they stay while the agent works and lapse when it goes idle. Host-only
  // (rides the agent_activity LISTEN); post-launch; best-effort — must not fail boot.
  try {
    const { startPlanItemActivityRenewal } = await import('../plan-items/activity-claim-renewal');
    startPlanItemActivityRenewal();
  } catch (e) {
    console.warn('[plan-item-claim] failed to arm activity renewal:', e instanceof Error ? e.message : e);
  }

  // Pre-warm the system-health cache so the FIRST Health/Overwatch tab open is
  // instant instead of cold-computing the 15-collector aggregation (incl. the
  // ~2.5s gateway probe) on the user's critical path (system-health-tab P-003
  // follow-up — the cold-cache 2-3s load). The scheduled systemHealthTick keeps
  // it warm thereafter; this closes the ~30s post-boot cold window. The pre-warm
  // is itself fire-and-forget per workspace + SYSTEM_HEALTH_TAB-gated, so this
  // returns immediately — best-effort, must not block/fail boot.
  try {
    const { preWarmSystemHealth } = await import('../system-health');
    const warmed = await preWarmSystemHealth();
    if (warmed > 0) console.log(`[system-health] boot pre-warm kicked off for ${warmed} workspace(s)`);
  } catch (e) {
    console.warn('[system-health] failed to arm boot pre-warm:', e instanceof Error ? e.message : e);
  }

  // Pre-warm the `coord.plans` sync query (WI-36179): the FIRST call after a
  // restart pays cold-start cost (module compile + an un-JIT'd parsePlan() sweep
  // across the whole plan corpus + a cold PG connection) that a warm call does
  // not, and that cost was measured to exceed the sync-resolver's 10s
  // RESOLVER_TIMEOUT_MS on `:3170` right after a restart — the CoordDashboard's
  // first post-restart load failed with a resolver timeout, then worked on an
  // immediate retry. Firing the same read once here pays that cost before any
  // user is waiting on it. Fire-and-forget (see preWarmCoordPlans); best-effort
  // — must not block/fail boot.
  try {
    const { preWarmCoordPlans } = await import('../endpoint-route/routes/coord');
    preWarmCoordPlans();
    console.log('[coord] boot pre-warm of coord.plans kicked off');
  } catch (e) {
    console.warn('[coord] failed to arm coord.plans boot pre-warm:', e instanceof Error ? e.message : e);
  }
}

/**
 * Grant `harness_app` read-only access to `dbos.workflow_status` (WI-10001739 link 3b).
 *
 * The hosted-lifecycle reconciler runs as `harness_app` and uses this relation to tell a dead
 * executor from a busy one; without it, a live workflow could be reaped and marked failed purely
 * for having a stale row. Migration 1172 applies the same grants, but it can only act on a
 * database where schema `dbos` already exists — the SDK creates that schema at runtime, strictly
 * AFTER migrations run, so a freshly-migrated database would never receive the grant from the
 * migration alone. Running it here too makes the two paths converge in either order.
 *
 * Idempotent: re-granting an existing privilege is a no-op in Postgres, so this is safe on every
 * boot. Callers treat failure as non-fatal — an unreadable probe classifies as `unknown` and
 * degrades to the pre-3b recency behaviour rather than reaping on evidence it does not have.
 */
export async function grantDbosWorkflowStatusRead(): Promise<void> {
  const { url } = getHarnessAdminUrlWithSource();
  const postgres = (await import('postgres')).default;
  const sql = postgres(url, { max: 1, connect_timeout: 5, prepare: false });
  try {
    await sql.unsafe('GRANT USAGE ON SCHEMA dbos TO harness_app');
    await sql.unsafe('GRANT SELECT ON dbos.workflow_status TO harness_app');
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
  }
}

/** Idempotent single launch. Safe across host bootstrap + retry timer/HMR. */
export function startDbos(): Promise<void> {
  if (G.__papercuspDbosStarted) return Promise.resolve();
  if (!dbosStartInFlight) {
    dbosStartInFlight = startDbosOnce().finally(() => {
      dbosStartInFlight = null;
    });
  }
  return dbosStartInFlight;
}

/**
 * WI-10004957: `/api/health` is pure liveness and answers while DBOS is still launching, so a
 * request that arrives in the first seconds after a bg-host restart found `dbosStarted()` false
 * and was refused 503 "provisioning workflow is unavailable" even though DBOS was a moment
 * away. A route may instead wait, bounded, for a launch that is ALREADY IN FLIGHT here. When no
 * launch is in flight (a request-only host, DBOS disabled, or a launch that already failed and
 * is waiting on its retry timer) this returns at once, so it never delays a host that will not
 * launch DBOS in the next few seconds. Never throws; resolves to the final `dbosStarted()`.
 */
export const DBOS_LAUNCH_IN_FLIGHT_WAIT_MS = 15_000;

export async function awaitDbosLaunchInFlight(timeoutMs: number = DBOS_LAUNCH_IN_FLIGHT_WAIT_MS): Promise<boolean> {
  if (dbosStarted()) return true;
  const inFlight = dbosStartInFlight;
  if (!inFlight || timeoutMs <= 0) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    inFlight.catch(() => undefined),
    new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
  ]);
  if (timer) clearTimeout(timer);
  return dbosStarted();
}
