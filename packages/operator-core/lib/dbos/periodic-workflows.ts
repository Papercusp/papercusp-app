/**
 * Phase 2 of `dbos-durable-jobs-2026-05-31` — the simple periodic background
 * timers as DBOS scheduled workflows (default **skip-missed** mode, D-009 — no
 * backfill storm after a long-closed desktop). Replaces the `setInterval`
 * workers in `telemetry-flush.ts` and `scratch-gc.ts`.
 *
 * Flag-gated by `PAPERCUSP_DBOS_TIMERS=1` — registered only when `bootstrap.ts`
 * imports this module. Each legacy `start*()` worker stands down when the flag
 * is set (guard in its own file), so exactly one implementation runs (D-011 A/B,
 * instant revert by un-setting the flag).
 *
 * The tick bodies are the EXISTING, already-tested single-run functions
 * (`flushTelemetry`, `runScratchGc`) — this only swaps the scheduler driving
 * them, with DBOS step retries + a recovery cap (P-006). The remaining timers
 * (memory cleanup, completion-ref verifier, operator scanner, embeddings,
 * backups) follow this exact shape per the P-008 / D-016 classification.
 */
import { DBOS } from '@dbos-inc/dbos-sdk';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pinModuleState } from '@papercusp/module-singleton';
import { idempotentRegisterWorkflow } from './idempotent-register-workflow';
import type { PgssBaseline } from '../system-health/hot-seq-scan-detector';
import { flushTelemetry } from '../telemetry-flush';
import { runScratchGc } from '../scratch-gc';
import { runEmbedBackfillOnce } from '../search/embed-backfill';
import { runEmbedSpaceSelfCheckTick } from '../search/embed-space-self-check';
import { runDeadWorkflowMonitorOnce } from './dead-workflow-monitor';
import { runBackupSchedulerTick } from '@papercusp/backup';
import { gcOldNotifies } from '../agent-tools/coordination/notify-gc';
import {
  gcOldCoordMessages,
  gcOldPlanEvents,
  gcTerminalHandoffFamilies,
} from '../agent-tools/coordination/message-log-gc';
import { gcResolvedEscalationFamilies } from '../agent-tools/coordination/escalation-log-gc';
import { expireStaleAdvisoryEscalations } from '../agent-tools/coordination/escalations';
import { gcOldPlanRevisions } from '../agent-tools/plans/revisions-gc';
import { gcOldDecisionLedgerRows } from '../agent-tools/coordination/decision-ledger-gc';
import { gcOldOperatorTurns } from '../operator-turns-gc';
import { runFleetLogsGc, runLaunchContextGc, runPapercuspWorkdirGc } from '../fleet-logs-gc';
import { listLiveSessionRenders } from '../stale-prompt-render-sweep';
import { gcLedgerDir } from '../turn-provenance/turn-provenance';
import { readRegistry } from '../workspace-registry';
import { loadHarnessRegistry, resolveHarnessContentPath } from '../harness-registry';
import { sweepOrphanSnapshots, sweepRecoveryDebrisTick, sweepRestoredClonesTick } from '@papercusp/backup';
import { gcScheduledPlanRuns } from '../harness/routines/gc-plan-runs';
import { refreshAll as refreshPushCredentials } from '../device-push-credentials';
import { getOrgPg } from '@papercusp/db-org';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS, type FlagKey } from '@papercusp/flags';
import { reapEndedPresenceRows } from '../agent-tools/coordination/presence-reaper';
import { runSubstrateOutboxBackstopGc } from '../substrate-outbox-backstop-gc';
import { runDbosWorkflowGcOnce } from './dbos-workflow-gc';
import { gcGovernorReceipts } from '../resource-governor/receipt-gc';
import { PgAdmissionCutoverQueueStore } from '../resource-governor/admission-cutover-store';
import {
  reconcileStaleEscalationsOnce,
  reconcileUnanswerableEscalationsOnce,
  rerouteUnackedEscalationsOnce,
} from '../attention/reconcile-escalations';
import { reconcileStalePendingHandoffsOnce, reconcileHandoffRepingsOnce } from '../reconcile-handoffs';
import { runReplyDeadlineSweepOnce } from '../agent-tools/coordination/reply-deadline-sweep';
import { runAllPotBroadcastSweepOnce } from '../agent-tools/coordination/allpot-broadcast-sweep';
import { runDeliveryLadderSweepOnce, DELIVERY_LADDER_OWNER } from '../agent-tools/coordination/delivery-ladder-sweep';
import { runStorageGrowthAlarmOnce } from '../storage/storage-growth-alarm';
import { runReplicationSlotAlarmOnce } from '../storage/replication-slot-alarm';
import { runTestDesktopReaperOnce } from '../test-desktop-reaper';
import { runDiskSpaceAlarmOnce } from '../storage/disk-space-alarm';
import { emitCoverageToast, runEmbedCoverageAlarmOnce } from '../search/embed-coverage';
import { assessInjectionReach, formatInjectionReachToast } from '../memory/injection-coverage';
import { runWalCheckpointSweep } from '../storage/localstorage-wal-guard';
import { runMemoryAnchorAuditOnce } from '../memory/audit-memory-anchors';
import { runDesktopPerfScheduledRun } from '../system-health/desktop-perf-scheduled-run';
import { runGuiE2eSurfaceScheduledRun } from '../system-health/gui-e2e-surface-scheduled-run';
// EI-1622: the high-frequency EPHEMERAL periodic checks (systemHealth,
// harnessStatusSweep, connectionPressure, serviceHealth, completionRefVerify,
// spawnReclaimSweep, staleClaimSweep, learningInfraHealth, steeringChurnSweep) were
// converted from durable DBOS scheduled workflows → lightweight in-process intervals
// (in-process-periodic.ts, armed from host-bootstrap). They wrote ~200k
// dbos.workflow_status rows/day with no durability need — the source of the recurring
// routine-engine freeze. The shed policy they shared with the kept heavy ticks below
// now lives in tick-load-shed.ts.
import { shouldShedHeavyTick } from './tick-load-shed';

// storage-settings-page-2026-06-15 P-006: a pre-existing background prune is
// skipped when the owner disables its STORAGE_RETAIN_* flag from the Storage page
// (D-001 keep-all). FAIL-SAFE: getFlag already returns the flag's default (true)
// on any read error, and we default true on an unexpected throw — so this can
// never silently STOP a prune.
async function retentionEnabled(flag: FlagKey): Promise<boolean> {
  try {
    return await getFlag(flag, 'system:retention');
  } catch {
    return true;
  }
}

// Hourly: drain the telemetry ring buffer → archive, forward to PostHog (gated),
// enforce retention. A transient PostHog failure already degrades to retry-next,
// so a light step retry covers PG hiccups.
async function telemetryFlushTick(): Promise<void> {
  // NB: the telemetry RETENTION (30d archive delete) is gated inside flushTelemetry
  // itself (STORAGE_RETAIN_TELEMETRY) — NOT here, so disabling retention still lets
  // the flush archive + forward telemetry; only the delete-old step is skipped.
  await DBOS.runStep(() => flushTelemetry(), {
    name: 'flush-telemetry',
    retriesAllowed: true,
    maxAttempts: 2,
    intervalSeconds: 30,
  });
}
const telemetryFlushWorkflow = idempotentRegisterWorkflow('telemetryFlush', () =>
  DBOS.registerWorkflow(telemetryFlushTick, {
    name: 'telemetryFlush',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(telemetryFlushWorkflow, { name: 'telemetryFlush', crontab: '0 0 * * * *' });

// Daily 03:00: scratch-storage GC sweep (retention + dead-workspace + quota).
async function scratchGcTick(): Promise<void> {
  if (!(await retentionEnabled(FLAGS.STORAGE_RETAIN_SCRATCH))) return;
  await DBOS.runStep(
    async () => {
      const workspaceRegistry = readRegistry().workspaces.map((w) => w.id);
      runScratchGc({ workspaceRegistry });
    },
    { name: 'scratch-gc' },
  );
}
const scratchGcWorkflow = idempotentRegisterWorkflow('scratchGc', () =>
  DBOS.registerWorkflow(scratchGcTick, {
    name: 'scratchGc',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(scratchGcWorkflow, { name: 'scratchGc', crontab: '0 0 3 * * *' });

// (The 6-hourly mem0 ephemeral-TTL sweep was removed — the `ephemeral` kind is
// retired, so nothing carries expires_at; ephemeral state lives in coord now.
// docs-and-memory-as-projections-2026-06-05 D-006.)

// Every 5min: embed-backfill sweep (battery-aware). The sweep's own batching
// is the rate limit on the embedding API (P-010).
async function embedBackfillTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      if (shouldShedHeavyTick('embed-backfill')) return;
      try {
        await runEmbedBackfillOnce();
      } catch (err) {
        // F1/F4 (infra-perf-reliability-audit-2026-06-19): a transient embedder
        // failure (embedder_disabled / openai_api_key_missing / a gateway or HTTP
        // error) must NOT throw out of the scheduled step. DBOS would retry, then
        // mark the workflow permanently dead (exceeded maxRecoveryAttempts) — which
        // silently STOPS all future backfill (the cosine/embedding leg that mem0
        // search depends on). This was the observed failure: `embedBackfill` dead,
        // memory:search degraded to ~50% errors / 19.5s p95. Log + skip; the next
        // 5-min tick retries once the embedder recovers.
        console.warn(`[embed-backfill] sweep skipped (non-fatal): ${(err as Error).message}`);
      }
    },
    { name: 'embed-backfill' },
  );
}
const embedBackfillWorkflow = idempotentRegisterWorkflow('embedBackfill', () =>
  DBOS.registerWorkflow(embedBackfillTick, {
    name: 'embedBackfill',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(embedBackfillWorkflow, { name: 'embedBackfill', crontab: '0 */5 * * * *' });

// Every 15min: embedding-space self-check (EI-8913 detector half, WI-3644).
// Cheap (one read + at most one embed call) relative to the backfill sweep,
// so a longer cadence is fine — this only needs to catch a desync well
// before it silently degrades search, not react to it instantly.
async function embedSpaceSelfCheckTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      if (shouldShedHeavyTick('embed-space-self-check')) return;
      try {
        await runEmbedSpaceSelfCheckTick();
      } catch (err) {
        // Same rationale as embedBackfillTick just above: a transient failure
        // (embedder unavailable, a PG hiccup) must never throw out of the
        // scheduled step, or DBOS retries it into permanent-dead territory and
        // silently stops the detector for good.
        console.warn(`[embed-space-self-check] tick skipped (non-fatal): ${(err as Error).message}`);
      }
    },
    { name: 'embed-space-self-check' },
  );
}
const embedSpaceSelfCheckWorkflow = idempotentRegisterWorkflow('embedSpaceSelfCheck', () =>
  DBOS.registerWorkflow(embedSpaceSelfCheckTick, {
    name: 'embedSpaceSelfCheck',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(embedSpaceSelfCheckWorkflow, { name: 'embedSpaceSelfCheck', crontab: '0 */15 * * * *' });

// Every minute: backup cadence tick — fires kopia snapshots for any workspace
// whose interval cadence is due (per-workspace dueness + in-flight dedup + PG
// cadence floor are inside the tick). P-011.
async function backupTick(): Promise<void> {
  await DBOS.runStep(() => runBackupSchedulerTick(), { name: 'backup-cadence' });
}
const backupWorkflow = idempotentRegisterWorkflow('backupCadence', () =>
  DBOS.registerWorkflow(backupTick, {
    name: 'backupCadence',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(backupWorkflow, { name: 'backupCadence', crontab: '0 * * * * *' });

// Daily 04:00: GC the coord `notify` firehose (D-002 de-noise). Notify is
// opt-in + low-value, so drop rows past the retention window — bounded growth
// even though the dominant source (lock_acquired) is already removed.
async function coordNotifyGcTick(): Promise<void> {
  await DBOS.runStep(() => gcOldNotifies(3), { name: 'coord-notify-gc' });
}
const coordNotifyGcWorkflow = idempotentRegisterWorkflow('coordNotifyGc', () =>
  DBOS.registerWorkflow(coordNotifyGcTick, {
    name: 'coordNotifyGc',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(coordNotifyGcWorkflow, { name: 'coordNotifyGc', crontab: '0 0 4 * * *' });

// Daily 04:05 (after notify-gc, before escalation-gc): physical retention cap
// for coord history. Messages use BOTH scopes on their own horizons —
// operator-scope at 30d, harness-scoped (FEDERATED) at 7d. Rooted message
// threads are deleted only when the whole thread is fully aged and unreferenced
// by coord_thread_posts (WI-401). The same bounded tick also sweeps the
// unthreaded plan-events tail at 30d and terminal operator-scope handoff
// families at 30d; open or federated handoffs remain protected.
//
// The federated half is the D-010 mechanism (plan memory-corpus-hygiene-and-
// release-distribution-2026-08-03, WI-8490): each DELETE of a local-origin
// harness-scoped row emits a `del` op via mig-150's capture trigger, which
// tombstones on peers and GCs out of the snapshot after the 14d tombstone horizon.
// That is what keeps coord HISTORY out of a release seed; live federation is
// untouched.
async function coordMessagesGcTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      await gcOldCoordMessages();
      await gcOldPlanEvents();
      await gcTerminalHandoffFamilies();
    },
    { name: 'coord-messages-gc' },
  );
}
const coordMessagesGcWorkflow = idempotentRegisterWorkflow('coordMessagesGc', () =>
  DBOS.registerWorkflow(coordMessagesGcTick, {
    name: 'coordMessagesGc',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(coordMessagesGcWorkflow, { name: 'coordMessagesGc', crontab: '0 5 4 * * *' });

// Daily 04:15 (off the 04:00 notify-gc / 04:30 dbos-gc stampede): physical retention
// GC for the coord_event_log `escalations` surface — the dominant growth driver
// (~35k rows, operational raise+resolve churn). Deletes RESOLVED, fully-aged,
// operator-scope escalation FAMILIES atomically (the existing archiveResolvedEscalations
// is a logical archive that only ADDS rows). infra-fail-fast C3/P-011. Safety rationale
// in escalation-log-gc.ts (family-atomic, resolved-only, fully-aged, harness_slug NULL).
async function coordEscalationGcTick(): Promise<void> {
  await DBOS.runStep(() => gcResolvedEscalationFamilies(), { name: 'coord-escalation-gc' });
}
const coordEscalationGcWorkflow = idempotentRegisterWorkflow('coordEscalationGc', () =>
  DBOS.registerWorkflow(coordEscalationGcTick, {
    name: 'coordEscalationGc',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(coordEscalationGcWorkflow, { name: 'coordEscalationGc', crontab: '0 15 4 * * *' });

// Hourly at :20 — the session-archive RECONCILER (session-db-archive-retire-dirs
// -2026-07-10 P-006, owner Q4): the backstop for sessions that ended without the
// markAdvSessionEnded fast path firing (kill -9 / OOM / host crash — the
// idle-session-reaper ghost class applied to archival). Bounded batches
// (50 adv rows + 100 dirs/tick), idempotent, protected-set-guarded (the same
// EI-311 liveness rule as session-dir-gc). Gated by the same
// SESSION_ARCHIVE_AT_END kill-switch as the fast path. This sweep is also the
// engine that drains the pre-plan backlog (P-011). Never throws out of the
// step (D-016 classification: skip-missed periodic).
/**
 * EI-20419472483823685 — emit the codex-home config.toml invariant on its OWN
 * line, UNCONDITIONALLY, including a clean `0/N`.
 *
 * ⚠ Never fold this into the reconciler's activity summary. That line is gated
 * on something having HAPPENED, so a quiet tick prints nothing at all — the
 * precise ambiguity that let WI-38706's damage sit unnoticed, because the
 * absence of a clause could not be told apart from "checked, all healthy".
 * The absence of THIS line must mean the check did not run.
 */
function logCodexHomeInvariant(
  missing: number | null,
  scanned: number | null,
  missingDirs: string[],
  error?: string,
): void {
  const head = '[session-archive-reconciler] codex-home config.toml invariant';
  if (error || missing === null || scanned === null) {
    console.warn(`${head}: UNKNOWN — ${error ?? 'not evaluated'}`);
    return;
  }
  const line = `${head}: ${missing}/${scanned} missing`;
  // A missing config.toml makes `codex resume` die with "Model provider
  // papercusp-codex-gateway not found" — warn so it reaches supervision.
  if (missing > 0) console.warn(`${line}${missingDirs.length ? ` — ${missingDirs.join(', ')}` : ''}`);
  else console.log(line);
}

/** How long an ended-but-unarchived row may persist before the live-skip
 *  invariant stops reading as "the guard working" and starts reading as "an adv
 *  row wrongly marked ended under a live owner".
 *
 *  The reconciler ticks hourly, and a legitimately-just-ended session clears on
 *  the next tick once its transcript passes LIVE_TRANSCRIPT_GRACE_MS (10 min).
 *  12h is therefore far outside any normal skip and well inside the window in
 *  which the original incident (a live transcript deleted at 00:03Z, noticed by
 *  the owner hours later) would have been surfaced by a machine instead. */
const LIVE_SKIP_STUCK_MS = 12 * 60 * 60 * 1000;

/**
 * INVARIANT (EI-22126624550252124, fix direction 4) — ALWAYS emitted, like
 * {@link logCodexHomeInvariant}.
 *
 * The liveness guard that stops the archiver deleting a live session's
 * transcript is silent by design: refusing a pass is a non-event. That is
 * correct per tick and wrong over time, because the one shape it must not hide
 * looks identical to it — a row wrongly marked `ended` under a live owner is
 * refused EVERY tick, so it is never archived and never stamped, and no per-tick
 * count can tell the two apart. Age can: a stuck row holds `ended_at` old while
 * `archived_at` stays NULL.
 *
 * `null` age means the scan set was EMPTY (nothing pending), which is the
 * healthy reading — deliberately distinct from "not evaluated".
 */
function logLiveSkipInvariant(skippedLive: number, oldestAgeMs: number | null): void {
  const head = '[session-archive-reconciler] live-skip invariant';
  if (oldestAgeMs === null) {
    console.log(`${head}: ${skippedLive} live-skipped, nothing ended-unarchived pending`);
    return;
  }
  const hours = (oldestAgeMs / 3_600_000).toFixed(1);
  const line = `${head}: ${skippedLive} live-skipped, oldest ended-unarchived ${hours}h`;
  if (oldestAgeMs > LIVE_SKIP_STUCK_MS) {
    console.warn(
      `${line} — STUCK past ${LIVE_SKIP_STUCK_MS / 3_600_000}h. An adv row is marked ended while its owner reads live: the guard is correctly refusing to delete the transcript, but nothing clears ended_at, so it will never archive. Investigate the row rather than the archiver.`,
    );
  } else console.log(line);
}

async function sessionArchiveReconcileTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      try {
        const { runSessionArchiveReconcileOnce, runCodexHomeConfigInvariant } =
          await import('../session-archive-reconciler');
        const enabled = await getFlag(FLAGS.SESSION_ARCHIVE_AT_END, 'system').catch(() => false);
        if (!enabled) {
          // The invariant is READ-ONLY and detects damage that OUTLIVES the
          // archiver, so it must NOT be gated on the archiver's own flag —
          // doing so reproduces WI-38706's actual failure (nobody noticing) for
          // exactly as long as the flag is off, and it demonstrably has been off.
          try {
            const only = await runCodexHomeConfigInvariant();
            logCodexHomeInvariant(only.missing, only.scanned, only.missingDirs);
          } catch (e) {
            logCodexHomeInvariant(null, null, [], (e as Error)?.message ?? String(e));
          }
          return;
        }
        const s = await runSessionArchiveReconcileOnce();
        if (
          s.dbArchived ||
          s.diskSessionsArchived ||
          s.ompFilesArchived ||
          s.dbStampedEmpty ||
          s.dbFailed ||
          s.diskFailed ||
          s.diskSkippedFresh ||
          s.skippedDisk ||
          // EI-22126624550252124: dbSkippedLive was PRINTED in the line below but
          // was not one of the conditions that decided whether to print it, so a
          // tick whose only event was "we refused to archive a LIVE session"
          // emitted nothing at all. The guard's own evidence was invisible unless
          // some unrelated counter happened to be non-zero in the same tick —
          // which is the same shape as the incident itself, where every safety net
          // went dark at once and only the owner noticed.
          s.dbSkippedLive
        ) {
          console.log(
            `[session-archive-reconciler] db: ${s.dbArchived} archived / ${s.dbStampedEmpty} stamped-empty / ${s.dbSkippedLive} live-skipped / ${s.dbFailed} failed (${s.endedUnarchivedRemaining} remaining); disk: ${s.diskSessionsArchived} archived + ${s.diskLeftoversDeleted} leftovers${s.diskLeftoversRetained ? ` (+${s.diskLeftoversRetained} shared-state RETAINED)` : ''} across ${s.diskDirsScanned} dirs (${s.diskSkippedFresh} fresh-skipped${s.skippedDisk ? `; SWEEP SKIPPED: ${s.skippedDisk}` : ''}); omp: ${s.ompFilesArchived}`,
          );
        }
        // INVARIANT (EI-22126624550252124) — always emitted, see the helper.
        logLiveSkipInvariant(s.dbSkippedLive, s.oldestEndedUnarchivedAgeMs);
        // INVARIANT (EI-20419472483823685) — always emitted, see the helper.
        logCodexHomeInvariant(
          s.codexHomesMissingConfig,
          s.codexHomesScanned,
          s.codexHomesMissingConfigDirs,
          s.codexHomeInvariantError,
        );
      } catch (e) {
        console.warn(`[session-archive-reconciler] tick failed: ${(e as Error)?.message ?? e}`);
      }
    },
    { name: 'session-archive-reconcile' },
  );
}
const sessionArchiveReconcileWorkflow = idempotentRegisterWorkflow('sessionArchiveReconcile', () =>
  DBOS.registerWorkflow(sessionArchiveReconcileTick, {
    name: 'sessionArchiveReconcile',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(sessionArchiveReconcileWorkflow, { name: 'sessionArchiveReconcile', crontab: '0 20 * * * *' });

// Hourly @:50 — the session-dir GC (session-db-archive-retire-dirs P-012). The
// isolation-dir janitor existed since EI-155 but its seeded ROUTINE was never
// armed (seeded inactive, bring-up never happened) — the root cause of the
// 17k+ dead session-claude dirs that fed the 2026-07-09 inotify/fs-watch
// meltdown. Registering it HERE makes the cadence code-owned and deploy-armed,
// immune to the "seeded but never enabled" failure class. Retention picks by
// the archive kill-switch: archive ON → 2h (deletion is lossless, dirs live in
// session_archives; the gate is only a materialization-race guard); archive
// OFF → the legacy 7d window (deletion is lossy again). The manual
// `system:session-dir-gc` routine action remains as an admin lever.
//
// Cadence + retention are chosen TOGETHER: the steady-state dir population is
// `live + retention-window churn` once cadence <= retention, so a daily sweep
// with a 24h window floored this box at ~900 dirs. Hourly @:50 (offset from the
// reconciler's @:20 so the archiver has committed the last hour's endings
// before the janitor looks) with a 2h window floors it at ~tens — the P-013
// goal. The sweep is cheap: a 23,671-dir scan measured 7s.
async function sessionDirGcTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      try {
        const { runSessionDirGc, DEFAULT_RETENTION_MS, LEGACY_RETENTION_MS } = await import('../session-dir-gc');
        const archiveOn = await getFlag(FLAGS.SESSION_ARCHIVE_AT_END, 'system').catch(() => false);
        const retentionMs = archiveOn ? DEFAULT_RETENTION_MS : LEGACY_RETENTION_MS;
        // archiveGuard tracks the flag: with the archive ON, a dir is deleted only
        // once its sessions are committed to session_archives (the 24h retention
        // is a race guard, NOT the safety net). With it OFF there is no archive to
        // verify against and the legacy 7d window is the only protection.
        const r = await runSessionDirGc({ retentionMs, archiveGuard: archiveOn });
        console.log(
          `[session-dir-gc] scanned ${r.scanned} dir(s) → removed ${r.removed.length}, ` +
            `kept ${r.keptProtected} live/resumable + ${r.keptFresh} within retention` +
            (r.keptUnarchived ? ` + ${r.keptUnarchived} not-yet-archived` : '') +
            (r.errors.length ? `, ${r.errors.length} error(s)` : '') +
            ` (retention ${Math.round(retentionMs / 3_600_000)}h, archive ${archiveOn ? 'on' : 'off'})`,
        );
      } catch (e) {
        console.warn(`[session-dir-gc] tick failed: ${(e as Error)?.message ?? e}`);
      }
    },
    { name: 'session-dir-gc' },
  );
  await dependencyGenerationRetentionTick();
}
const sessionDirGcWorkflow = idempotentRegisterWorkflow('sessionDirGc', () =>
  DBOS.registerWorkflow(sessionDirGcTick, {
    name: 'sessionDirGc',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(sessionDirGcWorkflow, { name: 'sessionDirGc', crontab: '0 50 * * * *' });

// Reuse the already-armed hourly filesystem janitor cadence. Dependency
// generations used to run retention only during checkout/prewarm, leaving a
// quiet hive's dead selector leases and old generations stranded indefinitely.
// The script's --prune-only path shares the publisher lock and never builds.
async function dependencyGenerationRetentionTick(): Promise<void> {
  await DBOS.runStep(async () => {
    try {
      const { resolveIntegrationRoot } = await import('../harness/routines/release-actions');
      const script = join(resolveIntegrationRoot(), 'apps/operator/bin/release/dependency-generation.sh');
      if (!existsSync(script)) return;
      const roots = new Set<string>();
      for (const workspace of readRegistry().workspaces) {
        try {
          const registry = await loadHarnessRegistry(workspace.id);
          for (const project of registry.projects) {
            const root = resolveHarnessContentPath(registry, project.slug);
            if (root && existsSync(join(root, '.papercusp/dependency-generations'))) roots.add(root);
          }
        } catch (error) {
          console.warn(`[dependency-generation-retention] workspace ${workspace.id}: ${(error as Error).message}`);
        }
      }
      const run = promisify(execFile);
      for (const root of roots) {
        try {
          await run('bash', [script, '--integration', root, '--prune-only'], { timeout: 120_000 });
        } catch (error) {
          console.warn(`[dependency-generation-retention] ${root}: ${(error as Error).message}`);
        }
      }
    } catch (error) {
      console.warn(`[dependency-generation-retention] tick failed: ${(error as Error).message}`);
    }
  }, { name: 'dependency-generation-retention' });
}

// Daily 04:45 (off the 04:00/04:15/04:30 GC stampede): per-plan retention cap for
// the plan_revisions spine — keep the newest N revisions per plan, delete the older
// tail. Every plans:* write appends a full content_snapshot, so a hot plan would
// otherwise grow unbounded. infra-fail-fast C4/P-012. Safety (current state always
// preserved, no federation trigger) in revisions-gc.ts.
async function planRevisionsGcTick(): Promise<void> {
  await DBOS.runStep(() => gcOldPlanRevisions(), { name: 'plan-revisions-gc' });
}
const planRevisionsGcWorkflow = idempotentRegisterWorkflow('planRevisionsGc', () =>
  DBOS.registerWorkflow(planRevisionsGcTick, {
    name: 'planRevisionsGc',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(planRevisionsGcWorkflow, { name: 'planRevisionsGc', crontab: '0 45 4 * * *' });

// Daily 04:50 (off the 04:00-04:45 GC stampede): physical retention GC for
// harness_shared.decision_ledger — an append-mostly governed-action + Queen-disposition
// ledger with NO prior scheduled retention (WI-417, follow-up from WI-406's autovacuum
// tuning, which reclaims dead tuples but never caps total size). Flat delete-by-age
// (no cross-row fold to corrupt, unlike escalations); the retention window is held
// ≥ the queen-autonomy graduation lookback (90d) by an in-function assertion so this
// can never silently destroy graduation evidence. Safety detail in decision-ledger-gc.ts.
async function decisionLedgerGcTick(): Promise<void> {
  await DBOS.runStep(() => gcOldDecisionLedgerRows(), { name: 'decision-ledger-gc' });
}
const decisionLedgerGcWorkflow = idempotentRegisterWorkflow('decisionLedgerGc', () =>
  DBOS.registerWorkflow(decisionLedgerGcTick, {
    name: 'decisionLedgerGc',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(decisionLedgerGcWorkflow, { name: 'decisionLedgerGc', crontab: '0 50 4 * * *' });

// Hourly @:05: retention GC for the `fleet-logs/` directories headless-spawn
// launch paths write to (WI-224710 cause #2 — "fleet-logs grows without
// bound"). Measured live 2026-08-30: 25G / 2,946 files in ONE such directory
// on a filesystem at 98% used with only ~46.5G of the required 2%-floor
// headroom left — the single biggest lever on the disk-headroom risk that
// makes green-checkpoint fail closed with `green:null` (no verdict at all,
// regardless of code). Age (3d) + a 10 GiB per-directory ceiling, both
// enforced every tick rather than once daily, because the ceiling — not the
// age window — is what actually binds at this growth rate; a once-daily
// cadence would let a burst of spawns push the disk past the headroom floor
// between sweeps. Pure FS housekeeping (fleet-logs-gc.ts), no LLM, no
// owner-authority surface — same class as gc-plan-runs / decision-ledger-gc.
async function fleetLogsGcTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      const result = runFleetLogsGc();
      const totalScanned = result.dirs.reduce((s, d) => s + d.scanned, 0);
      const totalRemovedAge = result.dirs.reduce((s, d) => s + d.removedByAge, 0);
      const totalRemovedCeiling = result.dirs.reduce((s, d) => s + d.removedByCeiling, 0);
      const totalBytesFreed = result.dirs.reduce((s, d) => s + d.bytesFreed, 0);
      const totalErrors = result.dirs.reduce((s, d) => s + d.errors.length, 0);
      console.log(
        `[fleet-logs-gc] scanned ${totalScanned} file(s) across ${result.dirs.length} dir(s) → ` +
          `removed ${totalRemovedAge} by age + ${totalRemovedCeiling} by ceiling, freed ` +
          `${Math.round(totalBytesFreed / (1024 * 1024))}MB` +
          (totalErrors ? `, ${totalErrors} error(s)` : ''),
      );

      // Second half of the same disk-headroom concern (WI-10002015): the sweep
      // above bounds fleet-logs, a flat directory of FILES with known writers.
      // It never touched the one-off working DIRECTORIES ad-hoc tooling leaves
      // directly under ~/.papercusp, which had no owner and no retention at
      // all — measured 2026-09-20, 188 top-level dirs, several multi-GB, the
      // oldest 100+ days, on a filesystem oscillating ~16 GiB above the
      // 37.51 GiB reserve the gate needs to render a verdict. Same tick because
      // it is the same lever on the same failure; only mktemp-suffixed names
      // are eligible and the age bound is the RECURSIVE newest mtime, never the
      // directory's own (see fleet-logs-gc.ts for why that distinction is
      // load-bearing rather than pedantic).
      const workdirs = runPapercuspWorkdirGc();
      const skipped = workdirs.candidates.filter((c) => !c.removed);
      console.log(
        `[papercusp-workdir-gc] considered ${workdirs.scanned} mktemp dir(s) → ` +
          `removed ${workdirs.removed}, freed ` +
          `${Math.round(workdirs.bytesFreed / (1024 * 1024))}MB` +
          (skipped.length
            ? `, kept ${skipped.length} (${skipped.map((c) => c.skipped ?? 'unknown').join(',')})`
            : ''),
      );

      // Third and last of the ~/.papercusp accumulations (WI-10002015). The two
      // sweeps above leave a hole exactly the shape of `launch-context`: the
      // first reaps files but only under a directory named `fleet-logs`; the
      // second sweeps directories but only mktemp-suffixed ones, and holds
      // `launch-context` in its protected set — rightly, as the directory must
      // survive. A stable, named directory whose CONTENTS grow without bound
      // therefore had no owner. Measured 2026-09-20: 769 MB over 14,920 renders,
      // oldest 2026-05-31, 94% of it past three days old.
      //
      // The live-render set is read here rather than inside the GC so that
      // fleet-logs-gc.ts stays a pure fs unit. It MUST be uncapped: the default
      // SWEEP_SESSION_CAP is a bound on a notifier's work, but here it is an
      // exclusion set, and a truncated one silently turns live sessions' personas
      // into deletion candidates. Absent the set entirely the GC refuses outright
      // — a render's mtime records when its session STARTED, so age alone would
      // reap the persona out from under a long-lived agent.
      const liveRenderPaths = new Set(
        listLiveSessionRenders('/proc', Number.MAX_SAFE_INTEGER).map((r) => r.promptFile),
      );
      const renders = runLaunchContextGc({ liveRenderPaths });
      console.log(
        renders.refused
          ? `[launch-context-gc] refused (${renders.refused}) — nothing removed`
          : `[launch-context-gc] scanned ${renders.scanned} render(s) → removed ` +
              `${renders.removed}, freed ${Math.round(renders.bytesFreed / (1024 * 1024))}MB, ` +
              `held ${renders.liveHeld} in use by live session(s)`,
      );
    },
    { name: 'fleet-logs-gc' },
  );
}
const fleetLogsGcWorkflow = idempotentRegisterWorkflow('fleetLogsGc', () =>
  DBOS.registerWorkflow(fleetLogsGcTick, {
    name: 'fleetLogsGc',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(fleetLogsGcWorkflow, { name: 'fleetLogsGc', crontab: '0 5 * * * *' });

// Hourly at :12 (off the :00 telemetry and :05 fleet-logs ticks): turn-provenance
// ledger GC. turn-provenance-owner-vs-agent-2026-07-11 P-001 shipped gcLedgerDir
// with unit tests but never wired a caller, so nothing ever reclaimed the dir:
// appendLedgerRow only compacts the ONE file it is appending to, and only past
// LEDGER_COMPACT_BYTES, so a file stops being touched the moment its session ends
// and then lives forever. Measured 2026-08-30 before this fix: 34,560 .jsonl files
// / 63MB under ~/.papercusp/turn-provenance/, oldest dated 2026-07-11 (the day
// P-001 landed), growing ~690 files/day. Pure machine-local FS housekeeping
// (D-001: the ledger is a machine-local short-TTL file, not PG), no LLM, no
// owner-authority surface — same class as fleet-logs-gc.
//
// ⚠ CORRECTION (plan D-007). This comment first justified the sweep with
// "deleting a fully-expired file cannot change a verdict: classify() returns
// `unverified-claim` for BOTH an expired row and a missing row". That is true
// only on the ENVELOPE branch. On the envelope-LESS hash-match branch an
// expired row returns `unverified-claim` while a MISSING one falls through to
// the affirmative OWNER default — so deleting it PROMOTES a machine turn to an
// owner stamp, the exact failure this plan exists to prevent. The claim was
// accidentally true when written (the pre-D-006 classifier sent both to OWNER)
// and the D-006 fix falsified it. gcLedgerDir now retains rows for
// LEDGER_GC_GRACE_MS past their TTL, which is what makes deletion
// verdict-neutral; the invariant and its guard live with that constant.
async function turnProvenanceGcTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      const { filesRemoved, rowsDropped } = gcLedgerDir();
      console.log(
        `[turn-provenance-gc] removed ${filesRemoved} dead ledger file(s), dropped ${rowsDropped} expired row(s)`,
      );
    },
    { name: 'turn-provenance-gc' },
  );
}
const turnProvenanceGcWorkflow = idempotentRegisterWorkflow('turnProvenanceGc', () =>
  DBOS.registerWorkflow(turnProvenanceGcTick, {
    name: 'turnProvenanceGc',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(turnProvenanceGcWorkflow, {
  name: 'turnProvenanceGc',
  crontab: '0 12 * * * *',
});

// Daily 04:55 (off the 04:00-04:50 GC stampede): physical retention GC for
// harness_shared.operator_turns — the operator-chat transcript table (158MB,
// append-mostly), the SAME unbounded-growth shape as decision_ledger with no
// prior scheduled retention (WI-1637, follow-up split from WI-417). Unlike
// decision_ledger, a turn also backs human-facing chat history, so the GC
// additionally requires the turn to already be folded into its conversation's
// rolling compaction summary (seq <= summary_through_seq) before it's eligible
// for age-based deletion — the compaction boundary is this table's analog of
// decision_ledger's 90d graduation-lookback floor. Safety detail in operator-turns-gc.ts.
async function operatorTurnsGcTick(): Promise<void> {
  await DBOS.runStep(() => gcOldOperatorTurns(), { name: 'operator-turns-gc' });
}
const operatorTurnsGcWorkflow = idempotentRegisterWorkflow('operatorTurnsGc', () =>
  DBOS.registerWorkflow(operatorTurnsGcTick, {
    name: 'operatorTurnsGc',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(operatorTurnsGcWorkflow, { name: 'operatorTurnsGc', crontab: '0 55 4 * * *' });

// Every 6h: global substrate_outbox backstop GC — sweeps orphaned/old
// federation-queue rows the per-harness inline GC never reaches. An un-booted or
// mis-routed (workspace, harness) has no drain, so its captures accumulate
// unbounded (the EI-126 102 GB class; observed 5.3 GB on 2026-06-15). The
// conservative 48h-undrained / 24h-drained windows preserve every in-flight row.
// P-012 / operator-memory-and-psu-resilience-2026-06-14 D-016.
async function outboxBackstopGcTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      if (shouldShedHeavyTick('substrate-outbox-backstop-gc')) return;
      // WI-1634 (WI-900 M3 residual): exempt currently-started hives' undrained rows
      // from the 48h orphan reap — a started hive's drain may be legitimately halted
      // on a recoverable cause (e.g. an epoch key not yet local), not truly orphaned.
      const { listStartedPots } = await import('../pot/started');
      await runSubstrateOutboxBackstopGc({ startedHives: await listStartedPots() });
    },
    { name: 'substrate-outbox-backstop-gc' },
  );
}
const outboxBackstopGcWorkflow = idempotentRegisterWorkflow('outboxBackstopGc', () =>
  DBOS.registerWorkflow(outboxBackstopGcTick, {
    name: 'outboxBackstopGc',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(outboxBackstopGcWorkflow, { name: 'outboxBackstopGc', crontab: '0 0 */6 * * *' });

// Daily 04:30 (after coordNotifyGc 04:00, off the stampede): prune old TERMINAL
// dbos.workflow_status + operation_outputs rows (R4-5 / EI-1607 defense-in-depth) —
// 325k+ workflow rows accrue with no DBOS-native retention, bloating the system DB +
// the scheduler/recovery scans that walk it. NO-OP unless PAPERCUSP_DBOS_WORKFLOW_GC=1
// (a DELETE on DBOS's own system tables is arm-deliberately); only terminal statuses,
// batched, NEVER in-flight (PENDING/ENQUEUED) rows. Heavy DELETE → shed under loop pressure.
async function dbosWorkflowGcTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      if (shouldShedHeavyTick('dbos-workflow-gc')) return;
      const r = await runDbosWorkflowGcOnce();
      if (!r.skipped && (r.deletedWorkflows > 0 || r.deletedOutputs > 0)) {
        console.log(
          `[dbos-workflow-gc] pruned ${r.deletedWorkflows} terminal workflow(s) + ${r.deletedOutputs} operation_output(s) (${r.batches} batch(es), cutoff ${r.cutoffMs})`,
        );
      }
    },
    { name: 'dbos-workflow-gc' },
  );
}
const dbosWorkflowGcWorkflow = idempotentRegisterWorkflow('dbosWorkflowGc', () =>
  DBOS.registerWorkflow(dbosWorkflowGcTick, {
    name: 'dbosWorkflowGc',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(dbosWorkflowGcWorkflow, { name: 'dbosWorkflowGc', crontab: '0 30 4 * * *' });

// Hourly (:20, off the :00 stampede): reconcile the attention queue — auto-resolve
// stale OPERATIONAL escalations (placement-watchdog cursed placements / aging
// sweeps: system sender, no options) idle past the TTL. They are redundant
// duplicates of the derived placements.cursed health metric, emitted en masse and
// never resolved (~7000 open / ~135 resolved), so without this they accumulate
// forever in the alert tier. Genuine human-decision escalations are never touched.
// Batch-limited (500/tick) to drain a large backlog without a coord-log write
// burst. queue-pending-accuracy-and-drift P-003/P-005.
async function attentionReconcileTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      if (shouldShedHeavyTick('attention-reconcile')) return;
      await reconcileStaleEscalationsOnce();
    },
    { name: 'attention-reconcile' },
  );
  // EI-19411323991062966: the sweep above deliberately never touches
  // NON-operational escalations, so an ask whose AUTHOR no longer exists is
  // unanswerable AND unclosable — 365 of 550 open rows, 304 past 48h, oldest
  // 2026-06-15. Own step so a failure here can never abort the operational
  // reconcile above (and vice versa), and best-effort for the same reason the
  // sibling drain is: a reconcile miss must degrade, never break the tick.
  // WI-7397: every exit from this step is now ANNOUNCED. It previously had
  // three silent ones — shed, the reaper's fail-safe abort, and a genuine
  // no-op — and the result was discarded, so a permanently-degraded reaper was
  // indistinguishable from a healthy idle one. Best-effort is still the right
  // policy here; being QUIET about it was not.
  await DBOS.runStep(
    async () => {
      if (shouldShedHeavyTick('attention-reconcile-unanswerable')) {
        console.log('[attention-reconcile-unanswerable] shed: heavy-tick budget — no pass this tick');
        return;
      }
      try {
        const r = await reconcileUnanswerableEscalationsOnce();
        if (r.outcome === 'aborted') {
          console.warn(
            '[attention-reconcile-unanswerable] ABORTED (non-fatal): a liveness/presence read threw, so ' +
              `0 of ${r.scanned} scanned were resolved. The backlog is NOT draining — this is not an idle tick.`,
          );
        } else {
          console.log(
            `[attention-reconcile-unanswerable] ${r.outcome}: scanned=${r.scanned} stale=${r.stale} ` +
              `resolved=${r.resolved}${r.truncated ? ' (truncated — more next tick)' : ''}`,
          );
        }
      } catch (e) {
        // best-effort: next tick retries
        console.warn(
          `[attention-reconcile-unanswerable] pass failed (non-fatal): ${e instanceof Error ? e.message : e}`,
        );
      }
    },
    { name: 'attention-reconcile-unanswerable' },
  );
}
const attentionReconcileWorkflow = idempotentRegisterWorkflow('attentionReconcile', () =>
  DBOS.registerWorkflow(attentionReconcileTick, {
    name: 'attentionReconcile',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(attentionReconcileWorkflow, { name: 'attentionReconcile', crontab: '0 20 * * * *' });

// Hourly (:32, off the :20 reconcile tick): expire stale OPEN advisory
// escalations. These are the lowest-severity band, so once they age past the
// TTL they are backlog noise, not durable human decisions. Blocker/question rows
// are never auto-expired.
async function advisoryEscalationExpiryTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      if (shouldShedHeavyTick('advisory-escalation-expiry')) return;
      await expireStaleAdvisoryEscalations();
    },
    { name: 'advisory-escalation-expiry' },
  );
}
const advisoryEscalationExpiryWorkflow = idempotentRegisterWorkflow('advisoryEscalationExpiry', () =>
  DBOS.registerWorkflow(advisoryEscalationExpiryTick, {
    name: 'advisoryEscalationExpiry',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(advisoryEscalationExpiryWorkflow, { name: 'advisoryEscalationExpiry', crontab: '0 32 * * * *' });

// Every 30 min (:26 + :56, off the :00/:20/:23 stampede): the coord-handoff
// invariant passes. (1) F-FIX-037 EXPIRE — auto-expire handoffs left pending past
// the 12h TTL: a handoff is an immutable coord_event_log offer of work; an
// unaccepted one sits `open` forever and misleads successors ("pick up the open
// handoff" chases a stale offer). The sweep writes a sibling 'handoff_expired'
// record (never mutates the original) so the fold drops it from `open`. (2)
// coord-dispatch-reliability P-003 RE-PING — an open, un-acked handoff older than
// ~30m (but < the 12h expire TTL) re-pings the OFFERER once (sibling
// 'handoff_repinged' + a coord message + a fail-soft wake) so they can follow up /
// reassign before the expire backstop. The :56 tick is why the cadence is 30min —
// the re-ping is only useful if it fires promptly; the 12h expire pass in the same
// tick is idempotent + batch-limited (500) so running it twice an hour is harmless.
// Both passes are independently fail-soft; one failing never blocks the other.
async function handoffReconcileTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      if (shouldShedHeavyTick('handoff-reconcile')) return;
      // live-configurability-audit P-014 + P-003: apply the handoff TTL / re-ping
      // overrides (undefined ⇒ baked defaults: 12h expire, 30m re-ping).
      const { readCoordLivenessConfig } = await import('../coord-liveness-config');
      const livenessCfg = await readCoordLivenessConfig();
      // EXPIRE pass (12h backstop) — unchanged.
      await reconcileStalePendingHandoffsOnce({ ttlMs: livenessCfg.handoffTtlMs });
      // RE-PING pass (~30m offerer nudge) — isolated so an expire failure never skips
      // it and vice versa.
      try {
        await reconcileHandoffRepingsOnce({
          repingMs: livenessCfg.handoffRepingMs,
          ttlMs: livenessCfg.handoffTtlMs,
        });
      } catch (e) {
        console.warn(`[handoff-reconcile] re-ping pass failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    { name: 'handoff-reconcile' },
  );
}
const handoffReconcileWorkflow = idempotentRegisterWorkflow('handoffReconcile', () =>
  DBOS.registerWorkflow(handoffReconcileTick, {
    name: 'handoffReconcile',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(handoffReconcileWorkflow, { name: 'handoffReconcile', crontab: '0 26,56 * * * *' });

// Every 5 minutes: coord:send { replyDeadlineSec } backstop (EI-8986) — the
// "nudge if silent" dual of coord-wake-on-reply. Finds every message whose
// reply deadline has passed with no reply yet and nudges the ORIGINAL sender
// once (a coord message, which doubles as the idempotency marker — see
// reply-deadline-sweep.ts's module docstring — + a fail-soft wake). Cheap,
// indexed, opt-in-only query; runs far more often than the daily GC ticks
// above because a deadline nudge is only useful if it's prompt.
async function replyDeadlineSweepTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      if (shouldShedHeavyTick('reply-deadline-sweep')) return;
      await runReplyDeadlineSweepOnce();
      // EI-7024: a human escalation may still need a live agent to drive its
      // operational next step. Keep this leg fail-soft so a liveness/marker read
      // failure never turns the established reply-deadline backstop red.
      try {
        await rerouteUnackedEscalationsOnce();
      } catch (e) {
        console.warn(`[escalation-sla-reroute] pass failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    { name: 'reply-deadline-sweep' },
  );
}
const replyDeadlineSweepWorkflow = idempotentRegisterWorkflow('replyDeadlineSweep', () =>
  DBOS.registerWorkflow(replyDeadlineSweepTick, {
    name: 'replyDeadlineSweep',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(replyDeadlineSweepWorkflow, { name: 'replyDeadlineSweep', crontab: '0 */5 * * * *' });

// Every 5 minutes (:45s, off the reply-deadline stampede): the H5b non-queen
// hive-wide broadcast DETECTOR (coord-authority-hardening-2026-07-11 P-010 /
// WI-4175, the EI-9501 class). The send-path guards down-scope/refuse a
// fleet-authority '*' blast (tools/send.ts + messages.ts H5a), but every
// incident is a detector failure too — a path the guards miss must still be
// SEEN. Finds every persisted CONSCIOUSLY-CLAIMED hive-wide broadcast (the
// allHiveBroadcast envelope stamp — NOT every literal '*', which is routine
// solo-agent traffic) whose sender is neither hive-queen-stamped nor a
// platform principal, writes an audit row + a one-line owner notice (which
// doubles as the per-msg idempotency marker — see allpot-broadcast-sweep.ts).
// Cheap: the query rides the mig-576 partial index.
async function allPotBroadcastSweepTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      if (shouldShedHeavyTick('allpot-broadcast-sweep')) return;
      await runAllPotBroadcastSweepOnce();
    },
    { name: 'allpot-broadcast-sweep' },
  );
}
const allPotBroadcastSweepWorkflow = idempotentRegisterWorkflow('allPotBroadcastSweep', () =>
  DBOS.registerWorkflow(allPotBroadcastSweepTick, {
    name: 'allPotBroadcastSweep',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(allPotBroadcastSweepWorkflow, { name: 'allPotBroadcastSweep', crontab: '45 */5 * * * *' });

// Every 2 minutes (:30s, off the reply-deadline stampede): the coord delivery
// ESCALATION LADDER (coord-delivery-residual-gaps-2026-07-11 P-004, WI-4160) —
// a DIRECTED message unread past TTL (default 5m; recipient LIVE per
// wakeable+liveTurn) auto-fires that recipient's standing inbox-wake,
// storm-capped 1/recipient/10m via the ladder's own marker message. Closes the
// "sender assumed delivery, live recipient never read it" gap (mid-long-exec
// deafness / hook drift / non-enrolled runtimes). Kill-switch flag
// COORD_DELIVERY_LADDER (default ON) is checked here per tick so a runtime
// flip takes effect on the next tick; fail-safe like retentionEnabled (a flag
// read error runs the sweep — its default is ON).
async function deliveryLadderSweepTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      if (shouldShedHeavyTick('delivery-ladder-sweep')) return;
      let enabled = true;
      try {
        enabled = await getFlag(FLAGS.COORD_DELIVERY_LADDER, DELIVERY_LADDER_OWNER);
      } catch {
        enabled = true;
      }
      if (!enabled) return;
      await runDeliveryLadderSweepOnce();
    },
    { name: 'delivery-ladder-sweep' },
  );
}
const deliveryLadderSweepWorkflow = idempotentRegisterWorkflow('deliveryLadderSweep', () =>
  DBOS.registerWorkflow(deliveryLadderSweepTick, {
    name: 'deliveryLadderSweep',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(deliveryLadderSweepWorkflow, { name: 'deliveryLadderSweep', crontab: '30 */2 * * * *' });

// Hourly (:23, off the stampede): surface silently-dead DBOS workflows
// (MAX_RECOVERY_ATTEMPTS_EXCEEDED / ERROR) — the embedBackfill/systemHealth class the
// infra audit (F4) found dying with ZERO alerting (185 dead + 229 errored instances).
// READ-ONLY (SELECTs dbos.workflow_status) and never throws, so the monitor can't
// affect the workflows it watches. Logs a WARN summary; not a per-instance human
// escalation (round-1 D-005: don't flood the human channel with operational noise).
async function deadWorkflowMonitorTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      await runDeadWorkflowMonitorOnce();
    },
    { name: 'dead-workflow-monitor' },
  );
}
const deadWorkflowMonitorWorkflow = idempotentRegisterWorkflow('deadWorkflowMonitor', () =>
  DBOS.registerWorkflow(deadWorkflowMonitorTick, {
    name: 'deadWorkflowMonitor',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(deadWorkflowMonitorWorkflow, { name: 'deadWorkflowMonitor', crontab: '0 23 * * * *' });

// Every 5min: backup orphan-snapshot sweep (consolidation P-002). REVIVES the
// job — its only legacy start site was the dead instrumentation-node, so this
// both ports it to DBOS and re-activates it (D-003).
async function orphanCleanupTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      await sweepOrphanSnapshots();
    },
    { name: 'backup-orphan-cleanup' },
  );
}
const orphanCleanupWorkflow = idempotentRegisterWorkflow('backupOrphanCleanup', () =>
  DBOS.registerWorkflow(orphanCleanupTick, {
    name: 'backupOrphanCleanup',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(orphanCleanupWorkflow, { name: 'backupOrphanCleanup', crontab: '0 */5 * * * *' });

// Once daily (04:00): reap on-disk recovery-debris directories (EI-1032) — the
// timestamped `<name>.broken-*` / `.zz-recover-*` / `.half-restored-*` /
// `.audit-wipe-*` / `.rolled-back-*` copies a restore/rollback/corruption-audit
// leaves behind under each workspace root. It also runs the restore-clone
// retention sweep for aged `.restored/<snapshot>/<slug>` directories. The two
// sweeps share this daily DBOS cadence, but the clone sweep has its own explicit
// age policy and fail-closed liveness/reference proof. policy.ts's
// SELF_EXCLUSION_RULES stops kopia from re-snapshotting either kind of scratch;
// this is the complementary sweep that reclaims disk space.
async function recoveryDebrisCleanupTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      await sweepRecoveryDebrisTick();
      await sweepRestoredClonesTick();
    },
    { name: 'backup-recovery-debris-cleanup' },
  );
}
const recoveryDebrisCleanupWorkflow = idempotentRegisterWorkflow('backupRecoveryDebrisCleanup', () =>
  DBOS.registerWorkflow(recoveryDebrisCleanupTick, {
    name: 'backupRecoveryDebrisCleanup',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(recoveryDebrisCleanupWorkflow, { name: 'backupRecoveryDebrisCleanup', crontab: '0 0 4 * * *' });

// Once daily (05:10): retention GC for terminal scheduled-plan runs (EI-1389).
// gcScheduledPlanRuns (gc-plan-runs.ts) was implemented + tested but had ZERO
// callers anywhere in the repo, so old scheduled-run artifacts (instance plan,
// transcript, run-scoped work_items) would accumulate unbounded once the
// scheduled-plans feature is used at volume — only the `plan_runs` ledger row
// itself is kept forever (cheap; the Runs-tab history). Pure retention hygiene
// with generous limits (last-50-per-template / 90-day) and ≈0 current usage, so
// a dedicated low-cadence daily workflow — not a fold into the 30s routinesTick
// (per the bug's own fix-sketch reasoning: a per-tick ranked scan there would be
// wasteful for a sweep this infrequent).
async function scheduledPlanRunsGcTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      await gcScheduledPlanRuns();
    },
    { name: 'scheduled-plan-runs-gc' },
  );
}
const scheduledPlanRunsGcWorkflow = idempotentRegisterWorkflow('scheduledPlanRunsGc', () =>
  DBOS.registerWorkflow(scheduledPlanRunsGcTick, {
    name: 'scheduledPlanRunsGc',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(scheduledPlanRunsGcWorkflow, { name: 'scheduledPlanRunsGc', crontab: '0 10 5 * * *' });

// Every 30min: refresh APNs/FCM push credentials (consolidation P-003). Replaces
// the legacy 50min setInterval (which stands down on dbosTimersActive); 30min is
// comfortably inside the 60min token TTL.
async function pushCredentialsTick(): Promise<void> {
  await DBOS.runStep(() => refreshPushCredentials(), { name: 'push-credentials-refresh' });
}
const pushCredentialsWorkflow = idempotentRegisterWorkflow('pushCredentialsRefresh', () =>
  DBOS.registerWorkflow(pushCredentialsTick, {
    name: 'pushCredentialsRefresh',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(pushCredentialsWorkflow, { name: 'pushCredentialsRefresh', crontab: '0 */30 * * * *' });

// Daily 04:17 UTC: test_runs retention prune (consolidation P-009). Replaces the
// papercup-test-runs-prune systemd-user timer; calls harness_shared.prune_test_runs(50)
// (migration 083 — keep 50 rows per file_path/branch). Fail-soft inside the SQL fn.
async function testRunsPruneTick(): Promise<void> {
  if (!(await retentionEnabled(FLAGS.STORAGE_RETAIN_TEST_RUNS))) return;
  await DBOS.runStep(
    async () => {
      const { sql } = getOrgPg();
      await sql`SELECT harness_shared.prune_test_runs(50)`;
    },
    { name: 'test-runs-prune' },
  );
}
const testRunsPruneWorkflow = idempotentRegisterWorkflow('testRunsPrune', () =>
  DBOS.registerWorkflow(testRunsPruneTick, {
    name: 'testRunsPrune',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(testRunsPruneWorkflow, { name: 'testRunsPrune', crontab: '0 17 4 * * *' });

// Every 6h (:50, off the :00 stampede + after the outbox backstop GC at :00):
// storage growth alarm (infra-perf-reliability-audit-round4 P-017 — the EI-126
// 102 GB silent-growth guard). READ-ONLY catalog-size check (sizesOnly, no row
// scan); emits a notifications:recent toast if any PG storage category crosses
// its absolute ceiling. Default ON; kill-switch PAPERCUSP_STORAGE_GROWTH_ALARM=0.
// Never throws → can't affect what it watches. Shed under loop pressure.
async function storageGrowthAlarmTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      if (process.env.PAPERCUSP_STORAGE_GROWTH_ALARM === '0') return;
      if (shouldShedHeavyTick('storage-growth-alarm')) return;
      const r = await runStorageGrowthAlarmOnce();
      if (r.breaches.length > 0) {
        console.log(
          `[storage-growth-alarm] ${r.breaches.length} categor(y/ies) over ceiling: ${r.breaches.map((b) => `${b.id}=${(b.bytes / 1024 ** 3).toFixed(1)}GB`).join(', ')}`,
        );
      }
      if (r.undeclared.length > 0) {
        console.log(
          `[storage-growth-alarm] ${r.undeclared.length} table(s) over floor with NO retention decision: ${r.undeclared.map((u) => `${u.table}=${Math.round(u.bytes / 1024 ** 2)}MB`).join(', ')}`,
        );
      }
    },
    { name: 'storage-growth-alarm' },
  );
}
const storageGrowthAlarmWorkflow = idempotentRegisterWorkflow('storageGrowthAlarm', () =>
  DBOS.registerWorkflow(storageGrowthAlarmTick, {
    name: 'storageGrowthAlarm',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(storageGrowthAlarmWorkflow, { name: 'storageGrowthAlarm', crontab: '0 50 */6 * * *' });

// Hourly (:40, off the :00/:50 stampede): replication-slot WAL-retention alarm
// (infra-perf-reliability-audit-round4 P-009 / D-004). READ-ONLY pg_replication_slots
// check; emits a notifications:recent toast when a slot pins WAL past its ceiling —
// the silent disk-fill SPOF, since max_slot_wal_keep_size=-1 means PG never caps an
// abandoned slot (a dropped federation subscriber / stale retired-Zero slot). Silent
// on the normal 0-slot steady state. Default ON; kill-switch
// PAPERCUSP_REPLICATION_SLOT_ALARM=0. Never throws → can't affect what it watches.
async function replicationSlotAlarmTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      if (process.env.PAPERCUSP_REPLICATION_SLOT_ALARM === '0') return;
      if (shouldShedHeavyTick('replication-slot-alarm')) return;
      const r = await runReplicationSlotAlarmOnce();
      if (r.breaches.length > 0) {
        console.log(
          `[replication-slot-alarm] ${r.breaches.length} slot(s) over WAL ceiling: ${r.breaches.map((b) => `${b.slotName}=${(b.retainedWalBytes / 1024 ** 3).toFixed(1)}GB/${b.reason}`).join(', ')}`,
        );
      }
    },
    { name: 'replication-slot-alarm' },
  );
}
const replicationSlotAlarmWorkflow = idempotentRegisterWorkflow('replicationSlotAlarm', () =>
  DBOS.registerWorkflow(replicationSlotAlarmTick, {
    name: 'replicationSlotAlarm',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(replicationSlotAlarmWorkflow, { name: 'replicationSlotAlarm', crontab: '0 40 * * * *' });

// Every 15min (:07/:22/:37/:52, off the :00 stampede): runaway/leaked TEST-desktop
// + zombie alarm (infra-perf-reliability-audit-round4 P-006 — the host-CPU drain
// from killed/wedged E2E webviews leaking and pegging a core). READ-ONLY /proc
// scan; CPU-samples only the handful of positively-identified test desktops, never
// the live user desktop (fail-safe classifier); emits a notifications:recent toast
// on a runaway desktop or a zombie pile. Detection-ONLY — auto-reap of a non-agent
// host process is a separate owner-gated kill path. Default ON; kill-switch
// PAPERCUSP_TEST_DESKTOP_REAPER=0. Never throws → can't affect what it watches.
// Shed under loop pressure.
async function testDesktopReaperTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      if (process.env.PAPERCUSP_TEST_DESKTOP_REAPER === '0') return;
      if (shouldShedHeavyTick('test-desktop-reaper')) return;
      const r = await runTestDesktopReaperOnce();
      if (r.alarmed) {
        console.log(
          `[test-desktop-reaper] alarmed: ${r.candidates.filter((c) => c.reason === 'runaway-test-desktop').length} runaway desktop(s), ${r.candidates.filter((c) => c.reason === 'zombie').length} zombie(s) (sampled ${r.sampled})`,
        );
      }
    },
    { name: 'test-desktop-reaper' },
  );
}
const testDesktopReaperWorkflow = idempotentRegisterWorkflow('testDesktopReaper', () =>
  DBOS.registerWorkflow(testDesktopReaperTick, {
    name: 'testDesktopReaper',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(testDesktopReaperWorkflow, { name: 'testDesktopReaper', crontab: '0 7,22,37,52 * * * *' });

// Every 30min (:13/:43, off the :00 stampede): disk/inode low-free-space tripwire
// (infra-fail-fast-build-integrity P-018 / D5 — a full FS silently wedges the
// single-Node operator behind a green health check; only one-time prunes existed).
// READ-ONLY statfs probe of the watched filesystems; emits a notifications:recent
// toast when free bytes/% or free inodes fall below a floor. Default ON; kill-switch
// PAPERCUSP_DISK_SPACE_ALARM=0. Never throws → can't affect what it watches. Shed
// under loop pressure.
async function diskSpaceAlarmTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      if (process.env.PAPERCUSP_DISK_SPACE_ALARM === '0') return;
      if (shouldShedHeavyTick('disk-space-alarm')) return;
      const r = await runDiskSpaceAlarmOnce();
      if (r.breaches.length > 0) {
        const crit = r.breaches.filter((b) => b.severity === 'critical').length;
        console.log(
          `[disk-space-alarm] ${r.breaches.length} filesystem(s) low${crit > 0 ? ` (${crit} CRITICAL${r.escalated ? ', escalated' : ', within cooldown'})` : ''}: ${r.breaches.map((b) => `${b.path}=${(b.freePct * 100).toFixed(1)}%`).join(', ')}`,
        );
      }
    },
    { name: 'disk-space-alarm' },
  );
}
const diskSpaceAlarmWorkflow = idempotentRegisterWorkflow('diskSpaceAlarm', () =>
  DBOS.registerWorkflow(diskSpaceAlarmTick, {
    name: 'diskSpaceAlarm',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(diskSpaceAlarmWorkflow, { name: 'diskSpaceAlarm', crontab: '0 13,43 * * * *' });

// Every 30min (:21/:51, off the :00 stampede and off the other alarms): embedding
// fingerprint-coverage alarm (semantic-search-fingerprint-coverage-2026-08-03
// P-008/P-027/P-006, WI-7469).
//
// The guarded failure is UNIQUE among the alarms in this file in one respect: it has no
// outward symptom at all. A full disk wedges the process, a runaway table shows up in
// storage sizes — but semantic search over a 1%-populated vector index answers quickly,
// with plausible-looking results, and looks exactly like a healthy one. It surfaced only
// because a human noticed their own recent work was unfindable, weeks in. Everything
// here is downstream of that: the detector's ABSENCE was the root defect.
//
// Three signals per surface, all measured over ELIGIBLE rows (rows a surface's own
// bodySql excludes by design are never counted against it — a total-coverage alarm on
// raw row counts is unsatisfiable for session_turns and would be muted within a week):
// corpus coverage, 24h-new-row coverage (the recurrence catcher), and the P-006
// drain-rate>write-rate invariant across consecutive samples.
//
// 30min rather than 5min because the counting scan is a real seq scan (~3.2s on the
// 422k-row session_turns, measured 2026-08-03) and none of the three signals moves
// meaningfully faster than that. Default ON; kill-switch PAPERCUSP_EMBED_COVERAGE_ALARM=0.
// Never throws → can't affect what it watches. Shed under loop pressure.
async function embedCoverageAlarmTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      if (process.env.PAPERCUSP_EMBED_COVERAGE_ALARM === '0') return;
      if (shouldShedHeavyTick('embed-coverage-alarm')) return;
      const r = await runEmbedCoverageAlarmOnce();
      if (r.breaches.length > 0) {
        console.log(
          `[embed-coverage] ${r.breaches.length} breach(es): ` +
            r.breaches.map((b) => `${b.surface}/${b.kind}`).join(', '),
        );
      }

      // P-004 (context-injection-retrieval-reach-and-visibility-2026-08-03): the same
      // pass, re-read for ONE consumer — the pre-turn context block. It re-measures
      // nothing and re-derives no floor; it filters the verdicts above to the surfaces
      // the injection corpus leg actually reads, with union-aware (best-leg) semantics.
      //
      // It rides HERE, not on the query-time coverage snapshot, because the recurrence
      // signal (`settledCoverage`) is evaluated instantaneously and is never persisted to
      // embed_coverage_samples — inside this pass is the only place it exists.
      try {
        const reach = assessInjectionReach(r.surfaces, r.breaches);
        if (reach.breaches.length > 0) {
          console.log(
            `[injection-coverage] ${reach.breaches.length} breach(es): ` +
              reach.breaches.map((b) => `${b.source ?? 'corpus'}/${b.kind}`).join(', '),
          );
          await emitCoverageToast(formatInjectionReachToast(reach));
        }
      } catch (err) {
        // Never let the derived read affect the alarm it derives from.
        console.warn(`[injection-coverage] skipped (non-fatal): ${(err as Error)?.message ?? String(err)}`);
      }
    },
    { name: 'embed-coverage-alarm' },
  );
}
const embedCoverageAlarmWorkflow = idempotentRegisterWorkflow('embedCoverageAlarm', () =>
  DBOS.registerWorkflow(embedCoverageAlarmTick, {
    name: 'embedCoverageAlarm',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(embedCoverageAlarmWorkflow, { name: 'embedCoverageAlarm', crontab: '0 21,51 * * * *' });

// Hourly (:08, off the other stampedes): WebKit localStorage WAL checkpoint
// guard (WI-4189 follow-on — localstorage-wal-guard.ts). The 2026-07-11
// root-disk-100% incident's single dominant leak was NOT any PG/disk store
// this file already GCs — it was the desktop webview's WebKit localStorage
// backing store: a ~5MB logical db carrying a ~34GB WAL because a long-lived
// WebKitNetworkProcess reader pins old frames and nothing ever checkpoints
// them back down. `TRUNCATE`-mode `wal_checkpoint` is non-blocking on readers
// (best-effort — commits what it can, never corrupts, never hangs; see the
// module doc + tests for the exact SQLite semantics this relies on), so it is
// safe to run unattended against a db the live desktop app has open. Default
// ON; kill-switch PAPERCUSP_WAL_GUARD=0. Never throws. Shed under loop pressure.
async function localstorageWalGuardTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      if (process.env.PAPERCUSP_WAL_GUARD === '0') return;
      if (shouldShedHeavyTick('localstorage-wal-guard')) return;
      const r = runWalCheckpointSweep();
      if (r.overThreshold > 0) {
        console.log(
          `[localstorage-wal-guard] ${r.checkpointed}/${r.overThreshold} over-threshold WAL(s) checkpointed, ` +
            `~${(r.bytesReclaimed / 1024 ** 2).toFixed(0)}MB reclaimed` +
            (r.errors.length ? `, ${r.errors.length} error(s): ${r.errors.map((e) => e.dbPath).join(', ')}` : ''),
        );
      }
    },
    { name: 'localstorage-wal-guard' },
  );
}
const localstorageWalGuardWorkflow = idempotentRegisterWorkflow('localstorageWalGuard', () =>
  DBOS.registerWorkflow(localstorageWalGuardTick, {
    name: 'localstorageWalGuard',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(localstorageWalGuardWorkflow, { name: 'localstorageWalGuard', crontab: '0 8 * * * *' });

// Daily 05:00 (after the 03:00–04:30 GC/prune cluster, off the :00 stampede): the
// Layer-1 memory-anchor audit (papercusp-su-memory-2026-05-25 P-019). Re-checks
// every harness_shared.memory_anchors row structurally — file anchors via the
// repo basename-resolve + external-skip checker (audit-anchors.fileChecker), plus
// plan/migration/feature — stamps last_checked_at + last_check_ok and flips
// memory_canonical.state broken_anchor⇄active. This is the job that gives the
// EI-2032 anchor-rooting cleanup LIVE effect: until it ran, the residue was purely
// latent (the checker was never scheduled). SKIPS cleanly on a source-less host
// (detectPapercupRoot()→null) so a packaged install never false-flags. It WRITES,
// but broken_anchor does NOT affect recall (canonical recall filters only
// state='archived') → low blast radius. Default ON; kill-switch
// PAPERCUSP_MEMORY_ANCHOR_AUDIT=0. Never throws (mirrors embed-backfill: a thrown
// step → DBOS marks the workflow permanently dead → silent stop forever) → can't
// poison the scheduler. Shed under loop pressure (git ls-files + N UPDATEs).
async function memoryAnchorAuditTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      if (process.env.PAPERCUSP_MEMORY_ANCHOR_AUDIT === '0') return;
      if (shouldShedHeavyTick('memory-anchor-audit')) return;
      try {
        const r = await runMemoryAnchorAuditOnce();
        console.log(`[memory-anchor-audit] ${r.skipped ? `skipped: ${r.reason ?? 'no-op'}` : (r.summary ?? 'done')}`);
      } catch (err) {
        console.warn(`[memory-anchor-audit] run skipped (non-fatal): ${(err as Error).message}`);
      }
    },
    { name: 'memory-anchor-audit' },
  );
}
const memoryAnchorAuditWorkflow = idempotentRegisterWorkflow('memoryAnchorAudit', () =>
  DBOS.registerWorkflow(memoryAnchorAuditTick, {
    name: 'memoryAnchorAudit',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(memoryAnchorAuditWorkflow, { name: 'memoryAnchorAudit', crontab: '0 0 5 * * *' });

// Daily 05:20 UTC (just after the memory anchor audit, inside the same quiet
// window): the SPEC TRIAD auto-file sweep (okf-frontmatter-adoption H(b)).
// `plans:items` holds an in-scope plan's items back from `actionable` when the
// plan owes `## Requirements` / `## Design`; this is the EXIT from that gate —
// it files one claimable work item per owing plan so the gate resolves through
// the ordinary queue instead of waiting for a person. Without this tick the
// gate is a wall, which is exactly the failure the design was corrected to
// avoid. Bounded (≤25 filings/run), idempotent (payload.specTriadPlan), and
// fail-closed on an unreadable flag since it WRITES. Default ON via the
// SPEC_TRIAD_REQUIRED flag; kill-switch PAPERCUSP_SPEC_TRIAD_SWEEP=0. Never
// throws (a thrown step → DBOS marks the workflow permanently dead → silent
// stop forever). Shed under loop pressure (a scan + N inserts).
async function specTriadSweepTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      if (process.env.PAPERCUSP_SPEC_TRIAD_SWEEP === '0') return;
      if (shouldShedHeavyTick('spec-triad-sweep')) return;
      try {
        const { runSpecTriadSweepOnce } = await import('../agent-tools/plans/spec-triad-sweep');
        const r = await runSpecTriadSweepOnce();
        console.log(`[spec-triad-sweep] ${r.summary}`);
      } catch (err) {
        console.warn(`[spec-triad-sweep] run skipped (non-fatal): ${(err as Error).message}`);
      }
    },
    { name: 'spec-triad-sweep' },
  );
}
const specTriadSweepWorkflow = idempotentRegisterWorkflow('specTriadSweep', () =>
  DBOS.registerWorkflow(specTriadSweepTick, {
    name: 'specTriadSweep',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(specTriadSweepWorkflow, { name: 'specTriadSweep', crontab: '0 20 5 * * *' });

// Weekly (Sun 05:30 UTC, off the daily 03:00–05:00 GC/prune cluster): code-recipes
// hygiene (recipes-reuse-activation-2026-06-22 P-003). There was NO scheduled automation
// for the recipe corpus — recipes:sweep / recipes:candidates were manual su-only tools —
// so the never-reused one-off tail accumulated unbounded (the audit found the corpus was
// already mostly trivial dogfood noise). This (1) RETIRES the stale long-tail via
// sweepRecipes (a reversible status flip that NEVER touches hot / promoted / merged /
// NULL-last-run recipes) and (2) LOGS the current promote/merge worklist for visibility
// (the Queen still pulls recipes:candidates live; this is a passive heartbeat so a
// Queen-less window still surfaces what's graduating), and (3) PROMOTES persistent
// tool-sequence graduates into work-items (okf-frontmatter §D) — the one non-passive
// leg, because §D's point is that a worklist nobody reads is where real findings go to
// wait. Default ON; kill-switches PAPERCUSP_RECIPE_HYGIENE=0 (whole routine) and
// PAPERCUSP_TOOL_SEQUENCE_PROMOTION=off (the filing leg only). Never throws → can't
// poison the scheduler. Shed under load.
async function recipeHygieneTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      if (process.env.PAPERCUSP_RECIPE_HYGIENE === '0') return;
      if (shouldShedHeavyTick('recipe-hygiene')) return;
      try {
        const { runRecipeHygieneOnce } = await import('../recipe-hygiene');
        const { captureImprovement } = await import('../harness/improvements/capture-core');
        const { sql } = getOrgPg();
        const r = await runRecipeHygieneOnce(sql, {
          sequenceDeps: {
            capture: captureImprovement,
            log: (m) => console.warn(`[recipe-hygiene] ${m}`),
          },
        });
        if (r.sweptIds.length > 0 || r.promoteCandidates > 0 || r.mergeClusters > 0) {
          console.log(
            `[recipe-hygiene] retired ${r.sweptIds.length} stale one-off recipe(s); ` +
              `${r.promoteCandidates} promote candidate(s), ${r.mergeClusters} merge cluster(s) awaiting Mug review`,
          );
        }
        if (r.sequenceError) {
          console.warn(`[recipe-hygiene] tool-sequence promotion failed (non-fatal): ${r.sequenceError}`);
        } else if (r.sequences && (r.sequences.filed > 0 || r.sequences.graduated > 0)) {
          console.log(
            `[recipe-hygiene] tool-sequences: ${r.sequences.graduated} graduated across ` +
              `${r.sequences.targets.length} workspace(s) → filed ${r.sequences.filed}, ` +
              `coalesced ${r.sequences.coalesced}, suppressed ${r.sequences.suppressed} nested prefix candidate(s), ` +
              `${r.sequences.heldForEvidence} still accruing evidence`,
          );
        }
        // Say it whether or not anything graduated: a truncated read makes a degraded
        // sweep look like a quiet week, which is the one failure that hides itself.
        if (r.sequences?.truncated) {
          console.warn(
            '[recipe-hygiene] tool-sequence read hit its row ceiling — this sweep judged a SHORTER ' +
              'span than configured; raise maxRows (see DEFAULT_MAX_ROWS in tool-sequence-patterns.ts)',
          );
        }
      } catch (err) {
        console.warn(`[recipe-hygiene] run skipped (non-fatal): ${(err as Error).message}`);
      }
    },
    { name: 'recipe-hygiene' },
  );
}
const recipeHygieneWorkflow = idempotentRegisterWorkflow('recipeHygiene', () =>
  DBOS.registerWorkflow(recipeHygieneTick, {
    name: 'recipeHygiene',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(recipeHygieneWorkflow, { name: 'recipeHygiene', crontab: '0 30 5 * * 0' });

// Daily (04:25 UTC, in the 04:xx GC cluster): sweep orphaned replication-liveness
// stall EIs (found triaging the papercusp open-bug backlog, 2026-07-20). A filed
// stall EI (P-004 / WI-1840, WI-183 class) auto-resolves ONLY when a live process
// later re-observes its EXACT (workspace, harness, log) recover or explicitly drops
// that log's tracking — both require a process alive under the target harness's
// identity. A renamed/deleted harness can never again satisfy that, so its open
// stall EIs sit forever as major-severity noise (confirmed: the papercup→papercusp
// rename alone orphaned 30 open EIs). See replication-stall-orphan-sweep.ts for the
// full root-cause writeup + the (conservative — existence-only, never time-based)
// resolution rule. Default ON; kill-switch PAPERCUSP_REPLICATION_ORPHAN_SWEEP=0.
// Never throws → can't poison the scheduler. Shed under load.
async function replicationStallOrphanSweepTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      if (process.env.PAPERCUSP_REPLICATION_ORPHAN_SWEEP === '0') return;
      if (shouldShedHeavyTick('replication-stall-orphan-sweep')) return;
      try {
        const { runReplicationStallOrphanSweepOnce } = await import('../sync/hyperbee/replication-stall-orphan-sweep');
        const r = await runReplicationStallOrphanSweepOnce();
        // WI-37499: log UNCONDITIONALLY with the skip census. This used to log only
        // when it resolved something, so "ran, saw 45 rows, none orphaned" and "saw
        // nothing because its selector was blind" were byte-identical from outside —
        // and the sweep ran daily for weeks in the second state. A checked=0 line is
        // the signal that matters most here, so it must not be the silent case.
        console.log(
          `[replication-stall-orphan-sweep] checked ${r.checked} open stall EI(s): ` +
            `resolved ${r.resolvedIds.length} across ${r.orphanedTargets.length} no-longer-existing target(s), ` +
            `skipped ${r.skipped.targetExists} (target still exists) + ` +
            `${r.skipped.unparseableTarget} (unparseable target)` +
            `${r.errors > 0 ? `, ${r.errors} resolve error(s)` : ''}`,
        );
      } catch (err) {
        console.warn(`[replication-stall-orphan-sweep] run skipped (non-fatal): ${(err as Error).message}`);
      }
      // WI-6986: same topic, same cadence — collapse DUPLICATE open stall EIs
      // (several open rows carrying one stable title) down to a single survivor.
      // Distinct from the orphan sweep above: that retires EIs whose TARGET is
      // gone, this retires redundant ROWS for a target that may still be live.
      // Measured 2026-08-02: 88 open replication-liveness EIs covering only 48
      // distinct conditions — 40 pure duplicates, minted by the cross-machine
      // file() race that no pre-read can win (see collapseDuplicateOpenEis).
      try {
        const { collapseDuplicateOpenEis } = await import('../escalation/episodic-ei');
        const { REPLICATION_LIVENESS_TOPIC, REPLICATION_STALL_EI_TITLE_PREFIX } =
          await import('../sync/hyperbee/replication-stall-ei');
        const c = await collapseDuplicateOpenEis(
          REPLICATION_LIVENESS_TOPIC,
          'duplicate open EI for an identical stable title — collapsed to the oldest row for this ' +
            'condition (WI-6986). No signal lost: the condition itself is still represented by the survivor.',
          undefined,
          // WI-37499: see the sweep above — the duplicates were concentrated in the
          // rows the topic tag misses (measured: all 12 rows in duplicate groups
          // were untagged), so a topic-only read could not collapse any of them.
          { titlePrefix: REPLICATION_STALL_EI_TITLE_PREFIX },
        );
        if (c.collapsedIds.length > 0 || c.skippedUnmutable > 0) {
          console.log(
            `[episodic-ei-duplicate-collapse] collapsed ${c.collapsedIds.length} duplicate open EI(s) ` +
              `across ${c.duplicatedTitles} title(s) (checked ${c.checked}` +
              `${c.skippedUnmutable > 0 ? `, ${c.skippedUnmutable} peer-authored left to their author` : ''})`,
          );
        }
      } catch (err) {
        console.warn(`[episodic-ei-duplicate-collapse] run skipped (non-fatal): ${(err as Error).message}`);
      }
    },
    { name: 'replication-stall-orphan-sweep' },
  );
}
const replicationStallOrphanSweepWorkflow = idempotentRegisterWorkflow('replicationStallOrphanSweep', () =>
  DBOS.registerWorkflow(replicationStallOrphanSweepTick, {
    name: 'replicationStallOrphanSweep',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(replicationStallOrphanSweepWorkflow, {
  name: 'replicationStallOrphanSweep',
  crontab: '0 25 4 * * *',
});

// Daily (04:40 UTC, in the 04:xx GC cluster, offset from the orphan sweep above): the
// WIDER, flag-gated staleness sweep for still-registered-but-abandoned harnesses
// (WI-5563 proposal #1 — the orphan sweep above only covers a renamed/deleted target;
// this covers a target harness that still exists but has recorded no activity for a
// long window). Default OFF (FLAGS.REPLICATION_LIVENESS_STALENESS_AUTO_CLOSE,
// owner-authority) — the sweep itself checks the flag per target workspace and is a
// pure no-op everywhere until the owner enables it. Never throws → can't poison the
// scheduler. Shed under load.
async function replicationLivenessStalenessSweepTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      if (shouldShedHeavyTick('replication-liveness-staleness-sweep')) return;
      try {
        const { runReplicationLivenessStalenessSweepOnce } =
          await import('../sync/hyperbee/replication-liveness-staleness-sweep');
        const r = await runReplicationLivenessStalenessSweepOnce();
        // Log UNCONDITIONALLY, including the per-reason skip census (WI-5563). This
        // used to log only when it resolved something, which made "the sweep cannot
        // fire" and "the sweep correctly found nothing" byte-identical from outside —
        // and the sweep then no-op'd for 13 days after the flag went on without
        // emitting one line. A daily census is the cheapest thing that tells the two
        // apart: `resolved=0 unknown-activity-fail-closed=15` is a broken activity
        // source, `resolved=0 ei-too-new=15` is a healthy sweep with nothing to do.
        const census = Object.entries(r.skipped)
          .filter(([, n]) => n > 0)
          .map(([reason, n]) => `${reason}=${n}`)
          .join(' ');
        console.log(
          `[replication-liveness-staleness-sweep] resolved=${r.resolvedIds.length} checked=${r.checked}` +
            `${r.errors > 0 ? ` errors=${r.errors}` : ''}${census ? ` | skipped: ${census}` : ''}`,
        );
      } catch (err) {
        console.warn(`[replication-liveness-staleness-sweep] run skipped (non-fatal): ${(err as Error).message}`);
      }
    },
    { name: 'replication-liveness-staleness-sweep' },
  );
}
const replicationLivenessStalenessSweepWorkflow = idempotentRegisterWorkflow('replicationLivenessStalenessSweep', () =>
  DBOS.registerWorkflow(replicationLivenessStalenessSweepTick, {
    name: 'replicationLivenessStalenessSweep',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(replicationLivenessStalenessSweepWorkflow, {
  name: 'replicationLivenessStalenessSweep',
  crontab: '0 40 4 * * *',
});

// Every 2min (offset :30s — off the :00 minute-tick stampede): session-transcript
// ingest (session-search-scope-2026-07-05 P-003). Tails claude/omp/codex JSONL +
// agent_chats_consolidated transcripts into harness_shared.session_turns — the
// episodic verbatim index behind search:* scope 'session_turn' + sessions:search.
// BOUNDED per tick (file/turn/byte caps inside runSessionIngestOnce) and
// flag-gated (SESSION_SEARCH, default ON). Never throws (the embedBackfill
// lesson: a thrown step marks the workflow permanently dead → silent stop
// forever). Shed under loop pressure. Freshness note: a 2-min lag is fine —
// the read-time self live-tail (ingestFileNow) covers the last-seconds window
// for compaction recovery (compaction-context-loss D-002).
async function sessionIngestTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      if (shouldShedHeavyTick('session-ingest')) return;
      try {
        const { runSessionIngestOnce } = await import('../search/session-ingest');
        const r = await runSessionIngestOnce();
        // `parts` is in BOTH the predicate and the line on purpose
        // (session-turn-storage-2026-07-28 P-001). The faithful-parts writer is
        // best-effort by contract — a parts failure is swallowed so it can never
        // cost the recall index — which means a silently-zero parts count is
        // indistinguishable from a healthy sweep unless the number is printed.
        // It went unnoticed for a full night exactly this way: bg-host was
        // running a pre-parts build, wrote 0 parts on every tick, and logged a
        // perfectly healthy-looking "+N turn(s)" each time.
        const parts = r.partsInserted ?? 0;
        if (!r.skipped && (r.turnsInserted > 0 || parts > 0 || r.errors > 0)) {
          console.log(
            `[session-ingest] +${r.turnsInserted} turn(s) +${parts} part(s) from ${r.filesIngested} file(s) ` +
              `+ ${r.chatsIngested} chat turn(s) (${r.filesScanned} scanned, ${r.errors} error(s), ${r.durationMs}ms)`,
          );
        }
      } catch (err) {
        console.warn(`[session-ingest] sweep skipped (non-fatal): ${(err as Error).message}`);
      }
    },
    { name: 'session-ingest' },
  );
}
const sessionIngestWorkflow = idempotentRegisterWorkflow('sessionIngest', () =>
  DBOS.registerWorkflow(sessionIngestTick, {
    name: 'sessionIngest',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(sessionIngestWorkflow, { name: 'sessionIngest', crontab: '30 */2 * * * *' });

// Every 5min (offset :45s — clear of the :30s session-ingest tick above and the
// :00 minute stampede): turn-provenance re-derivation (WI-38135). Re-classifies
// session_turns rows the CURRENT machine-surface catalogue has not seen — those
// never classified (version IS NULL) and those stamped by an older catalogue
// (version < CURRENT).
//
// WHY THIS TICK IS NOT OPTIONAL. `turn_origin_verdict = 'owner-typed'` is the
// RESIDUAL of a versioned deny-list — "no rule matched", NOT positive evidence
// the owner spoke. So every pattern added to the catalogue silently invalidates
// past verdicts, and without this lane those rows keep asserting the owner said
// something he did not, with a stored column's authority behind it
// (EI-20135573616431912). The sweep existed and was correct but had ZERO call
// sites, so it never ran: 370,478 rows (96% of the table) sat unclassified.
// Bumping MACHINE_SURFACE_CATALOGUE_VERSION only makes stale rows FINDABLE —
// this is what makes them repaired.
//
// Bounded per tick (PASSES_PER_TICK × PROVENANCE_BACKFILL_BATCH), shed under
// loop pressure, and never throws — same contract as the ingest tick above.
async function turnProvenanceBackfillTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      if (shouldShedHeavyTick('turn-provenance-backfill')) return;
      try {
        const { runTurnProvenanceBackfillOnce } = await import('../search/session-ingest');
        const r = await runTurnProvenanceBackfillOnce();
        if (r.updated > 0) {
          console.log(
            `[turn-provenance-backfill] re-derived ${r.updated} turn(s) ` +
              `(${r.scanned} scanned${r.more ? ', more pending' : ', backlog drained'})`,
          );
        }
      } catch (err) {
        console.warn(`[turn-provenance-backfill] sweep skipped (non-fatal): ${(err as Error).message}`);
      }
    },
    { name: 'turn-provenance-backfill' },
  );
}
const turnProvenanceBackfillWorkflow = idempotentRegisterWorkflow('turnProvenanceBackfill', () =>
  DBOS.registerWorkflow(turnProvenanceBackfillTick, {
    name: 'turnProvenanceBackfill',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(turnProvenanceBackfillWorkflow, {
  name: 'turnProvenanceBackfill',
  crontab: '45 */5 * * * *',
});

// Daily 05:20 (after the 03:00–05:00 GC cluster): session_turns retention prune —
// the index stays bounded (~45d window); the JSONL files remain the archive.
async function sessionTurnsPruneTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      try {
        const { pruneSessionTurnsOnce } = await import('../search/session-ingest');
        const r = await pruneSessionTurnsOnce();
        if (r.deleted > 0 || r.partsDeleted > 0) {
          console.log(`[session-turns-prune] pruned ${r.deleted} indexed turn(s), ${r.partsDeleted} faithful part(s)`);
        }
      } catch (err) {
        console.warn(`[session-turns-prune] run skipped (non-fatal): ${(err as Error).message}`);
      }
    },
    { name: 'session-turns-prune' },
  );
}
const sessionTurnsPruneWorkflow = idempotentRegisterWorkflow('sessionTurnsPrune', () =>
  DBOS.registerWorkflow(sessionTurnsPruneTick, {
    name: 'sessionTurnsPrune',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(sessionTurnsPruneWorkflow, { name: 'sessionTurnsPrune', crontab: '0 20 5 * * *' });

// Hourly at :12 (off the daily 03:00-05:00 GC/prune cluster + no collision with any
// other slot above): the coord_presence RETENTION reaper (presence-coord-unification-
// 2026-07-01 P-004, WI-1347). Evicts coord_presence rows that are BOTH (a) `ended`
// (no live coord:inbox-wake await — presence-wakeability.ts's exact wakeable
// predicate; a `parked` row is NEVER reaped, however stale its heartbeat) AND (b)
// past the TTL since their last heartbeat (presenceReaperTtlMs override, default 4h —
// coord-liveness-config.ts). History is not lost: named-fleet membership survives via
// the append-only fleet_membership_events ledger (WI-1345 / migration 430) and session
// lifecycle survives via adv_sessions — only the live-roster row is removed. Gated by
// the standard retention flag (default ON — finished, additive hygiene); the flag-read
// fail-safe means a hiccup NEVER silently stops the reap. Never throws (mirrors the
// other retention ticks): a thrown step would mark the workflow permanently dead.
async function coordPresenceReaperTick(): Promise<void> {
  if (!(await retentionEnabled(FLAGS.COORD_PRESENCE_REAPER))) return;
  await DBOS.runStep(
    async () => {
      try {
        const r = await reapEndedPresenceRows({});
        if (r.reaped > 0) {
          console.log(`[coord-presence-reaper] reaped ${r.reaped} ended coord_presence row(s) (${r.skipped} skipped)`);
        }
      } catch (err) {
        console.warn(`[coord-presence-reaper] run skipped (non-fatal): ${(err as Error).message}`);
      }
    },
    { name: 'coord-presence-reaper' },
  );
}
const coordPresenceReaperWorkflow = idempotentRegisterWorkflow('coordPresenceReaper', () =>
  DBOS.registerWorkflow(coordPresenceReaperTick, {
    name: 'coordPresenceReaper',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(coordPresenceReaperWorkflow, { name: 'coordPresenceReaper', crontab: '0 12 * * * *' });

// Daily (04:50 UTC, tail of the 04:xx GC cluster — deliberately AFTER the retention
// sweeps that CREATE the bloat): rebuild btree indexes that continuous retention churn
// has inflated into mostly-empty pages (db-performance-remediation-2026-07-26 P-004).
// VACUUM marks emptied index pages reusable but never returns them, so a pruned
// high-churn table's indexes grow monotonically — route_invocations was measured at
// 5.1 GB of index on 711 MB of heap before the first sweep, one index being 4117 MB at
// 2122 bytes/row (it rebuilt to 99 MB in 5s). REINDEX ... CONCURRENTLY only, so reads and
// writes keep running; the body additionally skips under a long-open transaction (which
// would merely park the rebuild) or low disk, and drops orphaned *_ccnew duplicates left
// behind by an interrupted reindex. Never throws (mirrors the other retention ticks): a
// thrown step would mark the workflow permanently dead.
async function dbIndexBloatReindexTick(): Promise<void> {
  if (!(await retentionEnabled(FLAGS.DB_INDEX_BLOAT_REINDEX))) return;
  await DBOS.runStep(
    async () => {
      if (shouldShedHeavyTick('db-index-bloat-reindex')) return;
      try {
        const { runIndexBloatReindexOnce } = await import('../db-index-bloat-reindex');
        const { sql } = getOrgPg();
        const r = await runIndexBloatReindexOnce(sql);
        if (r.skipped) {
          console.log(`[db-index-bloat-reindex] skipped: ${r.skipped}`);
          return;
        }
        const okCount = r.reindexed.filter((x) => !x.error).length;
        const failCount = r.reindexed.length - okCount;
        if (okCount > 0 || r.orphansDropped.length > 0 || failCount > 0) {
          const mb = (r.bytesReclaimed / (1024 * 1024)).toFixed(0);
          console.log(
            `[db-index-bloat-reindex] rebuilt ${okCount} index(es), reclaimed ${mb} MB` +
              `${r.orphansDropped.length > 0 ? `, dropped ${r.orphansDropped.length} orphan(s)` : ''}` +
              `${failCount > 0 ? `, ${failCount} failed` : ''}` +
              `${r.truncated ? ' (truncated by budget)' : ''}`,
          );
        }
      } catch (err) {
        console.warn(`[db-index-bloat-reindex] run skipped (non-fatal): ${(err as Error).message}`);
      }
    },
    { name: 'db-index-bloat-reindex' },
  );
}
const dbIndexBloatReindexWorkflow = idempotentRegisterWorkflow('dbIndexBloatReindex', () =>
  DBOS.registerWorkflow(dbIndexBloatReindexTick, {
    name: 'dbIndexBloatReindex',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(dbIndexBloatReindexWorkflow, { name: 'dbIndexBloatReindex', crontab: '0 50 4 * * *' });

// pg_stat_statements has no DROP DATABASE hook: entries keyed to a dropped dbid are
// retained forever, and backups/dumps run against TRANSIENT databases, so every dump
// permanently consumes entry slots. Measured 2026-08-03: 3,303 of 9,791 entries (33.7%)
// belonged to 23 databases that no longer exist, pinning the cap at 97.9% — and Postgres
// evicts by LOW USAGE, so it was discarding REAL application statistics at 13.5/day. An
// evicted-then-recreated entry's next delta reads as a PHANTOM SPIKE, so this leak
// corrupts the very delta measurements db-performance-remediation-2026-07-26 depends on
// (D-033). Only ever targets a dbid absent from pg_database, and NEVER passes dbid=0 —
// zero means "ALL databases" to pg_stat_statements_reset. Never throws (mirrors the other
// retention ticks): a thrown step would mark the workflow permanently dead.
async function dbPgssOrphanStatsReclaimTick(): Promise<void> {
  if (!(await retentionEnabled(FLAGS.DB_PGSS_ORPHAN_STATS_RECLAIM))) return;
  await DBOS.runStep(
    async () => {
      if (shouldShedHeavyTick('db-pgss-orphan-stats-reclaim')) return;
      try {
        const { reclaimOrphanPgssStatsOnce } = await import('../db-pgss-orphan-stats-reclaim');
        const { sql } = getOrgPg();
        const r = await reclaimOrphanPgssStatsOnce(sql);
        if (r.skipped) {
          // 'no-privilege' is the one worth saying out loud: it means migration 756's GRANT
          // did not take, so the sweep is inert and the residue is still growing.
          const how = r.skipped === 'no-privilege' ? console.warn : console.log;
          how(
            `[db-pgss-orphan-stats-reclaim] skipped: ${r.skipped}` +
              (r.skipped === 'no-privilege'
                ? ' — run: GRANT EXECUTE ON FUNCTION pg_stat_statements_reset(oid,oid,bigint,boolean) TO harness_admin;'
                : ''),
          );
          return;
        }
        const okCount = r.reclaimed.filter((x) => !x.error).length;
        const failCount = r.reclaimed.length - okCount;
        if (okCount > 0 || failCount > 0) {
          const pct = r.capMax > 0 ? ((r.entriesAfter / r.capMax) * 100).toFixed(1) : '?';
          console.log(
            `[db-pgss-orphan-stats-reclaim] reclaimed ${r.entriesReclaimed} entr(ies) from ` +
              `${okCount} dropped database(s); ${r.entriesBefore} -> ${r.entriesAfter}/${r.capMax} (${pct}% full)` +
              `${failCount > 0 ? `, ${failCount} failed` : ''}` +
              `${r.truncated ? ' (truncated by per-run cap)' : ''}`,
          );
        }
        if (r.capStillPressured) {
          // The sweep must not MASK an undersized cap by partially relieving it.
          // pg_stat_statements.max is postmaster-context, so raising it needs a restart.
          console.warn(
            `[db-pgss-orphan-stats-reclaim] cap STILL pressured after sweep ` +
              `(${r.entriesAfter}/${r.capMax}) — eviction will keep discarding live ` +
              `statistics; raising pg_stat_statements.max requires a postmaster restart.`,
          );
        }
      } catch (err) {
        console.warn(`[db-pgss-orphan-stats-reclaim] run skipped (non-fatal): ${(err as Error).message}`);
      }
    },
    { name: 'db-pgss-orphan-stats-reclaim' },
  );
}
const dbPgssOrphanStatsReclaimWorkflow = idempotentRegisterWorkflow('dbPgssOrphanStatsReclaim', () =>
  DBOS.registerWorkflow(dbPgssOrphanStatsReclaimTick, {
    name: 'dbPgssOrphanStatsReclaim',
    maxRecoveryAttempts: 5,
  }),
);
// 05:20 UTC daily — clear of the :00 backup tick, the 04:xx GC cluster and the 04:50
// index-bloat sweep.
DBOS.registerScheduled(dbPgssOrphanStatsReclaimWorkflow, { name: 'dbPgssOrphanStatsReclaim', crontab: '0 20 5 * * *' });

// EI-19312743681026041: the HOT-STATEMENT SEQ-SCAN detector. Two migrations in two days
// (717/WI-6839, 718/WI-6850) fixed the same read-many-return-few defect — a filter cheap
// to WRITE with no index behind it, over a table with a fat TOASTed column, called on a
// tick — and BOTH were found only because an agent ranked live pg_stat_statements deltas
// by hand. 718 had been burning ~27% of all live database time at ~171 calls/min. The
// class is invisible to code review (the SQL is correct, just unindexed) and to tests
// (fixtures are small enough that a seq scan is free), so the live database is the only
// place it can be caught. This tick is that missing detector.
//
// The detector needs TWO samples to compute a rate, so the first run after a restart only
// samples and reports `no-baseline` — that is correct, not a failure. Ranking on lifetime
// totals instead would invert the answer outright (D-007): the 718 statements were 26.98%
// of LIVE database time but 0.2% of lifetime.
//
// Read-only. EXPLAIN runs without ANALYZE inside a READ ONLY transaction, so statements
// are PLANNED and never executed — verified against an UPDATE — and the only writes this
// tick makes are log lines.
const __hotSeqScanState = pinModuleState<{ baseline: PgssBaseline | null }>(
  '@papercusp/operator-core.hotSeqScanDetectorBaseline',
  () => ({ baseline: null }),
);
async function dbHotSeqScanDetectorTick(): Promise<void> {
  if (!(await retentionEnabled(FLAGS.DB_HOT_SEQ_SCAN_DETECTOR))) return;
  await DBOS.runStep(
    async () => {
      if (shouldShedHeavyTick('db-hot-seq-scan-detector')) return;
      try {
        const { runHotSeqScanDetectionOnce, describeFinding } = await import('../system-health/hot-seq-scan-detector');
        const { sql } = getOrgPg();
        const r = await runHotSeqScanDetectionOnce(sql, { baseline: __hotSeqScanState.baseline });
        // Carry the sample forward even on a skip: 'window-too-short' deliberately returns
        // the ORIGINAL baseline so the delta keeps accumulating instead of the clock
        // resetting every tick and never reaching a measurable window.
        __hotSeqScanState.baseline = r.nextBaseline;

        if (r.skipped) {
          // 'extension-absent' is the one worth saying out loud: without pg_stat_statements
          // the detector is permanently inert, and an inert detector that says nothing is
          // indistinguishable from a working one that found nothing.
          if (r.skipped === 'extension-absent') {
            console.warn(
              '[db-hot-seq-scan-detector] inert: pg_stat_statements is not installed — ' +
                'this defect class is unmonitored until it is.',
            );
          }
          return;
        }

        if (r.findings.length === 0) return;
        console.warn(
          `[db-hot-seq-scan-detector] ${r.findings.length} hot statement(s) seq-scanning a ` +
            `large relation over a ${(r.windowMs / 60_000).toFixed(1)}min window ` +
            `(${r.examined} of ${r.candidates} candidates planned` +
            `${r.explainFailures > 0 ? `, ${r.explainFailures} unplannable` : ''}` +
            `${r.resetEntriesSkipped > 0 ? `, ${r.resetEntriesSkipped} reset entries skipped` : ''}):`,
        );
        for (const f of r.findings) console.warn(`[db-hot-seq-scan-detector]   ${describeFinding(f)}`);
      } catch (err) {
        console.warn(`[db-hot-seq-scan-detector] run skipped (non-fatal): ${(err as Error).message}`);
      }
    },
    { name: 'db-hot-seq-scan-detector' },
  );
}
const dbHotSeqScanDetectorWorkflow = idempotentRegisterWorkflow('dbHotSeqScanDetector', () =>
  DBOS.registerWorkflow(dbHotSeqScanDetectorTick, {
    name: 'dbHotSeqScanDetector',
    maxRecoveryAttempts: 5,
  }),
);
// Every 15 minutes: long enough that a window is a meaningful rate rather than whatever
// happened to run, short enough that a statement which turns hot is caught the same hour
// rather than the next day.
DBOS.registerScheduled(dbHotSeqScanDetectorWorkflow, { name: 'dbHotSeqScanDetector', crontab: '0 */15 * * * *' });

// 3x/day (02:40, 10:40, 18:40 UTC — off the :00 backup tick and the 04:xx GC
// cluster): the desktop-perf release gate's missing PRODUCER (WI-6538).
// `harness_shared.desktop_perf_runs` was written ONLY by a human clicking Run
// in the admin testing UI and nobody ever had, so the gate's `maxAgeMs` (24h)
// freshness window never had a run to evaluate — every deploy cleared it
// without measuring anything. Three runs/day gives ~2x margin inside that
// window even if one run fails outright. `shouldShedHeavyTick` applies here
// too (this is one of the heaviest ticks in this file — a real packaged
// desktop boot under Xvfb) so it backs off exactly like the other heavy
// ticks under event-loop pressure / power-save. Never throws: an infra miss
// (spawn failure) is logged, not raised, mirroring the other best-effort
// ticks in this file — retrying via DBOS's `maxRecoveryAttempts` would only
// re-run the whole 10-minute suite, which is not what an infra hiccup needs.
async function desktopPerfScheduledRunTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      if (shouldShedHeavyTick('desktop-perf-scheduled-run')) return;
      try {
        const r = await runDesktopPerfScheduledRun();
        if (!r.ran) {
          console.log(`[desktop-perf-scheduled-run] skipped: ${r.skippedReason}`);
        } else if (r.timedOut) {
          console.warn(`[desktop-perf-scheduled-run] timed out after ${r.durationMs}ms`);
        } else {
          console.log(`[desktop-perf-scheduled-run] ran in ${r.durationMs}ms, wdio exit ${r.exitCode}`);
        }
      } catch (err) {
        console.warn(`[desktop-perf-scheduled-run] run skipped (non-fatal): ${(err as Error).message}`);
      }
    },
    { name: 'desktop-perf-scheduled-run' },
  );
}
const desktopPerfScheduledRunWorkflow = idempotentRegisterWorkflow('desktopPerfScheduledRun', () =>
  DBOS.registerWorkflow(desktopPerfScheduledRunTick, {
    name: 'desktopPerfScheduledRun',
    maxRecoveryAttempts: 3,
  }),
);
DBOS.registerScheduled(desktopPerfScheduledRunWorkflow, {
  name: 'desktopPerfScheduledRun',
  crontab: '0 40 2,10,18 * * *',
});

// Daily (03:15, clear of scratchGc's 03:00): the SCHEDULED PRODUCER for the
// GUI E2E Tauri surface-verification suite (gui-e2e-tauri-surface-
// verification-2026-08-27 P-008 — see gui-e2e-surface-scheduled-run.ts's
// module doc). Runs scripts/tauri-surface-verify-suite.sh — 8 sequential
// live, Tauri-driven, regression-failing DOM-assertion legs — so they stop
// running "only by hand"; one of them already caught a real, always-
// reproducing bug (WI-64726's /dev/gym crash) that a grep-based coverage
// census and a mismatched unit-test mock both missed. `shouldShedHeavyTick`
// applies here too — this is one of the heaviest ticks in this file, 8
// sequential real Xvfb+VirtualGL+full-app boots. Never throws: a leg
// failure is reported via the shared alarm-attention rail (escalateAlarm,
// cooldown-gated), not the release/green-checkpoint gate — WI-40086 owns
// that gate separately and this plan deliberately never touches it.
async function guiE2eSurfaceScheduledRunTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      if (shouldShedHeavyTick('gui-e2e-surface-scheduled-run')) return;
      try {
        const r = await runGuiE2eSurfaceScheduledRun();
        if (!r.ran) {
          console.log(`[gui-e2e-surface-scheduled-run] skipped: ${r.skippedReason}`);
        } else if (r.timedOut) {
          console.warn(`[gui-e2e-surface-scheduled-run] timed out after ${r.durationMs}ms`);
        } else {
          console.log(
            `[gui-e2e-surface-scheduled-run] ran in ${r.durationMs}ms, exit ${r.exitCode}, ` +
              `${(r.legs ?? []).length} leg(s) parsed, escalated=${r.escalated ?? false}`,
          );
        }
      } catch (err) {
        console.warn(`[gui-e2e-surface-scheduled-run] run skipped (non-fatal): ${(err as Error).message}`);
      }
    },
    { name: 'gui-e2e-surface-scheduled-run' },
  );
}
const guiE2eSurfaceScheduledRunWorkflow = idempotentRegisterWorkflow('guiE2eSurfaceScheduledRun', () =>
  DBOS.registerWorkflow(guiE2eSurfaceScheduledRunTick, {
    name: 'guiE2eSurfaceScheduledRun',
    maxRecoveryAttempts: 3,
  }),
);
DBOS.registerScheduled(guiE2eSurfaceScheduledRunWorkflow, {
  name: 'guiE2eSurfaceScheduledRun',
  crontab: '0 15 3 * * *',
});

// HOURLY at :20 — retention for the dedicated resource-governor admission ledger.
//
// HOURLY, not daily, is the whole point. These rows arrive at ~24k/hour, so a daily
// sweep would let ~576k of them accumulate between runs — which IS the collapse this
// exists to prevent, just arriving on a slower clock. The cadence has to beat the
// write rate, not merely bound it eventually.
//
// Each tick is bounded (GOVERNOR_RECEIPT_GC_BATCH_LIMIT) and takes the oldest first,
// so a neglected table converges over successive runs instead of emitting one
// unbounded delete burst. Retention is now keyed to terminal updated_at_ms in
// resource_governor_admissions; work_items is outside this routine's delete path.
async function governorReceiptGcTick(): Promise<void> {
  const deleteTerminalReceipts = await retentionEnabled(FLAGS.STORAGE_RETAIN_GOVERNOR_RECEIPTS);
  await DBOS.runStep(
    async () => {
      // Targeted gateway admissions reconcile their namespace before leasing, but
      // an entirely idle namespace has no admission edge to drive that cleanup.
      // Reuse the existing hourly receipt-maintenance tick as the backstop instead
      // of creating another timer/supervisor.
      const reconciled = await new PgAdmissionCutoverQueueStore().reconcileExpiredAll();
      if (reconciled.total > 0) {
        console.log(
          `[governor-receipt-gc] reconciled ${reconciled.requeued} expired lease(s), ` +
            `${reconciled.expired} overdue receipt(s) and ` +
            `${reconciled.abandoned} abandoned no-deadline receipt(s)`,
        );
      }
      if (!deleteTerminalReceipts) return;
      const gc = await gcGovernorReceipts();
      if (gc.deleted > 0) {
        console.log(
          `[governor-receipt-gc] deleted ${gc.deleted} terminal admission receipt(s) in ${gc.batches} batch(es)`,
        );
      }
      if (gc.exhausted) {
        console.warn(
          `[governor-receipt-gc] BUDGET EXHAUSTED after ${gc.batches} full batch(es): terminal receipts past ` +
            'retention remain, so the ledger is outgrowing its hourly sweep',
        );
      }
    },
    { name: 'governor-receipt-gc' },
  );
}
const governorReceiptGcWorkflow = idempotentRegisterWorkflow('governorReceiptGc', () =>
  DBOS.registerWorkflow(governorReceiptGcTick, {
    name: 'governorReceiptGc',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(governorReceiptGcWorkflow, {
  name: 'governorReceiptGc',
  crontab: '0 20 * * * *',
});

// Every 2h: cloud-resource-obligation sweep (closes EI-21915296593490861).
//
// P-046 agents repeatedly create real, metered GCP infra (custom networks, subnets,
// Cloud Routers, Cloud NATs) because the project default network has no NAT and a
// clean-room/Packer guest cannot reach the internet without one. Until this routine
// existed the teardown obligation was recorded ONLY as prose in a work-item checkpoint
// ("TEARDOWN OWED — standing GCP cost"). Nothing enforced or detected it, and prose
// does not survive the creating agent's death: WI-40474 measured three successive
// holders dying/stalling in sequence while the obligation sat undischarged in
// checkpoint text across every handoff.
//
// harness_shared.cloud_resource_obligations (migration 1040) makes the obligation a
// ROW, not a paragraph, and THIS tick is the owner-independent sweep the issue calls
// for: it runs on the DBOS scheduler's own process, so detection no longer depends on
// any agent's session surviving. Past-grace obligations are escalated via
// captureImprovement with a stable watchdogKey, so a re-nudge coalesces onto the same
// work-item (bumping repeatCount) instead of filing a sibling every tick. This sweep
// never calls a cloud-provider API itself (no working GCP credential is assumed to be
// available in-process) — teardown remains a human/infra-owner action taken against
// the escalation it files. Never throws (mirrors every other retention/sweep tick
// here): a per-candidate capture failure is recorded in the result and skipped, not
// allowed to poison the whole scheduled step.
async function cloudResourceObligationSweepTick(): Promise<void> {
  await DBOS.runStep(
    async () => {
      if (shouldShedHeavyTick('cloud-resource-obligation-sweep')) return;
      try {
        const { runCloudResourceObligationSweepOnce } = await import('../workspace-host/cloud-resource-obligations');
        const { captureImprovement, WATCHDOG_AUTO_CLOSE_OWNER } = await import('../harness/improvements/capture-core');
        const { commentIssue, setIssueState } = await import('../issues-engineer');
        const { sql } = getOrgPg();
        const r = await runCloudResourceObligationSweepOnce(sql, {
          capture: captureImprovement,
          // WI-10003512: a discharged obligation retires its escalation. Resolved under the
          // watchdog auto-close owner so an exact-key recurrence reopens THIS row (capture-core
          // P-004); skipCompletionGate because a ledger discharge is a lifecycle marker, not a
          // completion of work on the escalation.
          resolveEscalation: async ({ workspaceId, workItemId, reason }) => {
            await commentIssue(
              workItemId,
              `🟢 Resolved by the cloud-resource-obligation sweep: ${reason}. If this resource leaks ` +
                `again under the same name, the next escalation reopens this item.`,
              'system:cloud-resource-obligation-sweep',
              { workspaceId },
            );
            await setIssueState(workItemId, 'resolved', WATCHDOG_AUTO_CLOSE_OWNER, undefined, {
              skipCompletionGate: true,
            });
          },
        });
        if (r.candidates > 0 || r.errors.length > 0 || (r.resolved ?? 0) > 0) {
          console.log(
            `[cloud-resource-obligation-sweep] ${r.candidates} past-grace obligation(s), ` +
              `${r.escalated} escalated, ${r.resolved ?? 0} discharged escalation(s) resolved` +
              (r.errors.length > 0 ? `, ${r.errors.length} failure(s): ${JSON.stringify(r.errors)}` : ''),
          );
        }
      } catch (err) {
        console.warn(`[cloud-resource-obligation-sweep] tick skipped (non-fatal): ${(err as Error).message}`);
      }
    },
    { name: 'cloud-resource-obligation-sweep' },
  );
}
const cloudResourceObligationSweepWorkflow = idempotentRegisterWorkflow('cloudResourceObligationSweep', () =>
  DBOS.registerWorkflow(cloudResourceObligationSweepTick, {
    name: 'cloudResourceObligationSweep',
    maxRecoveryAttempts: 5,
  }),
);
DBOS.registerScheduled(cloudResourceObligationSweepWorkflow, {
  name: 'cloudResourceObligationSweep',
  crontab: '0 30 */2 * * *',
});
