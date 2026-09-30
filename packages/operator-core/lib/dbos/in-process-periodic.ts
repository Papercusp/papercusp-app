/**
 * in-process-periodic.ts — lightweight in-process periodic checks (EI-1622).
 *
 * The SOURCE fix for the recurring routine-engine freeze: the high-frequency
 * ephemeral health-checks / sweeps below used to be modeled as DURABLE DBOS
 * scheduled workflows (periodic-workflows.ts), each persisting a permanent
 * `dbos.workflow_status` row every 30–60s. At ~200k rows/day the table grew to
 * 328k rows / 253MB, the DBOS executor starved (every dequeue scans it), and
 * `routinesTick` stalled → the hive-wake never fired → the Queen froze.
 *
 * These checks are EPHEMERAL + IDEMPOTENT — a missed fire is caught by the next
 * fire — so they do NOT need DBOS durability/recovery/a permanent execution
 * record. Modeling them as durable workflows was an over-generalization of
 * "everything is a DBOS workflow". Here they run as plain `setInterval` ticks:
 * zero workflow_status writes, so the table stays small and the daily GC (R4-5)
 * becomes a true backstop, not load-bearing. DBOS workflows are reserved for the
 * genuinely-recoverable units (the feature pipeline, durable-spawn, provision,
 * backup snapshot, plan render) and the low-frequency maintenance that is not the
 * bloat source (telemetryFlush, attentionReconcile, embedBackfill, the daily GCs).
 *
 * The scheduler is modeled on the out-of-band Red Queen engine-death sentinel
 * (red-queen/engine-death.ts): a plain unref'd interval, idempotent arm, an
 * injectable-deps seam so tests run without timers/PG. Armed ONCE from
 * host-bootstrap, gated on `backgroundWorkers` — exactly like the sentinel — so a
 * naive setInterval never runs N× across :3070 cluster request workers (the #1
 * gotcha: DBOS dedup'd by workflow-id; in-process does not).
 */
import { shouldShedHeavyTick } from './tick-load-shed';
import { createConnectionPressureGovernor } from '../connection-pressure-governor';
import nodeCluster from 'node:cluster';
import { managedSetInterval, type ManagedHandle, type TimerClassification } from '@papercusp/scheduled-registry';

/** One in-process periodic check. The tick must be idempotent — a throw is
 *  caught + logged and the next interval retries (no durable recovery). */
export interface PeriodicCheck {
  name: string;
  intervalMs: number;
  /** Heavy ticks (system-health, harness-status-sweep) shed a cycle under event-loop
   *  saturation / power-save. Light single-query probes do NOT shed — we want their
   *  signal precisely under load (parity with the DBOS version's shouldShedHeavyTick). */
  shed?: boolean;
  /** Also run ONCE immediately when armed (heal-on-startup), not only after the first
   *  interval. For self-heal sweeps that should converge on boot (e.g. epoch-key reconcile)
   *  rather than wait a full interval. Still subject to the shed-gate. */
  fireOnArm?: boolean;
  /** D-004 push-don't-poll classification (P-011, stop-discarded-dedup-and-audit-server-
   *  polling-2026-07-26) — REQUIRED here: this file is the one seam whose full 15/16-check
   *  surface was actually audited (lane C1, WI-6091/D-008), so unlike the generic
   *  `managedSetInterval` caller pool (grandfathered via lint:timer-classification's
   *  shrink-only BASELINE — see scripts/check-timer-classification.mjs) there is no excuse
   *  for a check here to go unclassified. Threaded into `armInProcessPeriodicChecks`'s
   *  `managedSetInterval` call so it also surfaces in schedule:inventory. */
  classification: TimerClassification;
  /**
   * Who runs this check when the host is a node CLUSTER (P-018,
   * db-performance-remediation-2026-07-26).
   *
   * `'host'` (DEFAULT) — the cluster PRIMARY only. Correct for every sweep that reads or
   * reconciles SHARED state: running it in each request worker just multiplies identical
   * work against one database.
   *
   * `'process'` — every process, primary and workers. ONLY for a check that maintains
   * PER-PROCESS state, where skipping a worker would leave that worker's own state unfed.
   *
   * ── Why this field exists ────────────────────────────────────────────────────
   * This is a LATENT-FOOTGUN GUARD, not a live performance fix. Be precise about what
   * it does and does not buy, because an earlier version of this comment got it wrong
   * and the correction is recorded as db-performance-remediation-2026-07-26 D-014.
   *
   * The soundness argument (this part holds): host-bootstrap arms this suite under
   * `backgroundWorkers && !utilityHost`, and that gate cannot express "once per HOST".
   * `backgroundWorkersEnabled()` reads only env (PAPERCUSP_BACKGROUND_WORKERS /
   * PAPERCUSP_HONO_PORT) and a forked cluster worker INHERITS its parent's env, so on a
   * host that is BOTH background-workers-enabled AND clustered it returns true in the
   * primary and in every worker alike — and each would independently run every
   * host-scoped sweep. `cluster.isPrimary` is the gate that actually answers the
   * question; the same file already uses it for exactly this class (the credential-sync
   * watcher, EI-3385), and this suite simply never got it.
   *
   * What it does NOT buy (the retracted claim): no host in the current deployment is
   * both clustered and background-workers-enabled, so this field is a no-op everywhere
   * today. The :3070 release cluster is forked 16-wide but every one of its 17 processes
   * carries PAPERCUSP_BACKGROUND_WORKERS=0, so `backgroundWorkersEnabled()` is FALSE and
   * this suite NEVER ARMS there at all (see background-workers.ts:66-69, which documents
   * that value as deliberate for the request workers). bg-host does run the suite but is
   * unclustered (PAPERCUSP_CLUSTER_WORKERS=0), so `isPrimary` is true and nothing is
   * skipped. An earlier comment here cited "~22.6 concurrent tickers" measured across
   * release-worker pids as this guard's motivation; those reads are real but are
   * REQUEST-DRIVEN traffic load-balanced across the workers, not N copies of the tick.
   * Sixteen workers each serving 1/16th of one request stream do the same total DB work
   * as one worker serving all of it — process count is not tick count.
   *
   * So: keep this guard (it makes an unsound gate sound, and the class has bitten before
   * — EI-312 leg 1, where vitest workers each ran a "host boot" check against the live
   * DB), but do not attribute a DB-load reduction to it, and do not close a performance
   * item on it.
   */
  scope?: 'host' | 'process';
  tick: () => Promise<void> | void;
}

/** Whether `check` should run in THIS process. Exported pure for the unit test. */
export function checkRunsInThisProcess(check: PeriodicCheck, isPrimary: boolean): boolean {
  return isPrimary || check.scope === 'process';
}

export interface RunCheckDeps {
  shouldShed?: (name: string) => boolean;
  log?: (msg: string) => void;
}

/**
 * One check pass: shed-gate (heavy ticks only), then the tick, NEVER throwing.
 * Returns whether the tick ran (false when shed or when it threw — the next
 * interval retries either way).
 */
export async function runPeriodicCheck(
  check: PeriodicCheck,
  deps: RunCheckDeps = {},
): Promise<{ ran: boolean; shed?: boolean }> {
  const log = deps.log ?? ((m: string) => console.warn(`[in-process-periodic] ${m}`));
  try {
    if (check.shed) {
      const shed = deps.shouldShed ?? shouldShedHeavyTick;
      if (shed(check.name)) return { ran: false, shed: true };
    }
    await check.tick();
    return { ran: true };
  } catch (e) {
    log(`${check.name} tick failed (next interval retries): ${e instanceof Error ? e.message : e}`);
    return { ran: false };
  }
}

// ── The default checks (the converted ex-DBOS-workflow set) ──────────────────
// Each tick body is the EXACT logic from its former DBOS scheduled workflow in
// periodic-workflows.ts (same flag gates, same side effects, same log strings);
// only the scheduler driving it changed (setInterval, no DBOS.runStep / no
// registerWorkflow → no persisted workflow_status row). Lazy imports inside the
// ticks keep boot light and defer the heavy module loads to first fire.

// A warning is one line per sampling interval while persistence stays broken;
// the ordinary 30-second health tick must not flood the journal.
const perfSnapshotWarningAt = new Map<string, number>();
function warnPerfSnapshot(workspaceId: string, message: string): void {
  const now = Date.now();
  const prior = perfSnapshotWarningAt.get(workspaceId);
  if (prior != null && now - prior < 15 * 60_000) return;
  perfSnapshotWarningAt.set(workspaceId, now);
  console.warn(`[perf-regression] ${message}`);
}

// Every 30s: whole-system Health snapshot (system-health-tab P-003/D-001).
// Recompute per-workspace SystemHealth + fire notifySyncInvalidate('health.snapshot')
// (inside runSystemHealthTick) so an open Health tab stays SSE-live. Flag-gated
// (SYSTEM_HEALTH_TAB); the resolver's on-demand recompute is the correctness floor,
// so this tick is the liveness bonus. HEAVY → sheds under saturation.
const systemHealthCheck: PeriodicCheck = {
  name: 'system-health',
  intervalMs: 30_000,
  shed: true,
  // D-004/D-008 (P-011): the ONE confirmed VIOLATION across all 104 audited timers —
  // recomputes PG-derived state that already fires notifySyncInvalidate, on a clock
  // rather than in reaction to the write. Lane B (P-006/P-012/P-013) is the authoritative
  // panel-level conversion; this classification records the system-level audit verdict,
  // not a promise this file itself converts it.
  classification: 'violation',
  tick: async () => {
    const { FLAGS } = await import('@papercusp/flags');
    const { getFlag } = await import('@papercusp/flags/server');
    if (!(await getFlag(FLAGS.SYSTEM_HEALTH_TAB, 'system'))) return;
    const { readRegistry } = await import('../workspace-registry');
    const { runSystemHealthTick } = await import('../system-health');
    for (const ws of readRegistry().workspaces.map((w) => w.id)) {
      await runSystemHealthTick(ws).catch((e) => {
        console.warn(`[system-health] tick failed for ${ws}: ${e instanceof Error ? e.message : e}`);
      });
      // The performance history used to ride only the owner-paused learning
      // watchdog. Reuse this active health sweep for its measurements without
      // re-arming that routine or dispatching its improvement signals.
      try {
        const { collectPerfRegressionWhenDue } = await import('../system-health/perf-regression-rig');
        const sample = await collectPerfRegressionWhenDue(ws);
        if (sample.overdue) {
          warnPerfSnapshot(ws, `producer overdue after health tick for ${ws}; lastCapturedAt=${sample.lastCapturedAt ?? 'never'}: ${sample.note ?? 'no snapshot persisted'}`);
        }
      } catch (e) {
        warnPerfSnapshot(ws, `health-tick sampling failed for ${ws}: ${e instanceof Error ? e.message : e}`);
      }
    }
  },
};

// Every 30s: harness_status / harness_lanes PID-liveness sweep (consolidation
// P-001). HEAVY → sheds under saturation. NB: the legacy ensureHarnessStatusSweep
// now stands down on backgroundWorkersEnabled() (not dbosTimersActive), so this
// in-process check is the single owner wherever background workers run.
const harnessStatusSweepCheck: PeriodicCheck = {
  name: 'harness-status-sweep',
  intervalMs: 30_000,
  shed: true,
  // D-004 (P-011): PID-liveness has no publisher — D-004's own MUST-SAMPLE example.
  classification: 'must-sample',
  tick: async () => {
    const { runHarnessStatusSweepOnce } = await import('../harness-status-sweep');
    await runHarnessStatusSweepOnce();
  },
};

// One per process (this tick runs only on the background-worker host, so the AIMD
// penalty fires once — not N× across the :3070 cluster). Closure-held debounce state.
const connectionPressureGovernor = createConnectionPressureGovernor();

// Every 30s: connection-pressure watch (backend-connection-scaling C5-1). pgHealth()
// reports server-wide saturation; warn LOUDLY past 85% with the top holders. LIGHT
// probe — NOT shed-on-loop-pressure (we want the signal precisely under load), but
// it DOES feed the connection-pressure governor (C5-1) which sheds agent concurrency
// via AIMD at critical saturation — the admission half that closes the loop.
const connectionPressureCheck: PeriodicCheck = {
  name: 'connection-pressure',
  intervalMs: 30_000,
  // D-004 (P-011): live server-wide PG connection saturation has no change-event source.
  classification: 'must-sample',
  // P-018: the ONE check that stays per-process. The READING is server-wide, but it feeds
  // `connectionPressureGovernor` — an IN-PROCESS AIMD governor that sheds THIS process's
  // agent concurrency. Primary-only would leave every worker's governor unfed and silently
  // disable its backpressure, which is a much worse failure than 16 extra cheap pgHealth()
  // probes. Cost asymmetry decides it: this is one light query (classification
  // 'must-sample', shed:false by design), whereas the host-scoped checks it sits beside
  // cost hundreds of ms of DB work each.
  scope: 'process',
  tick: async () => {
    const { pgHealth } = await import('../dev-data');
    const h = await pgHealth().catch(() => null);
    if (!h || h.maxConnections <= 0) return;

    // C5-1: close the loop — feed saturation into the AIMD concurrency governor so
    // critical PG saturation sheds agent concurrency (recovering as it falls).
    // Gated by CONNECTION_PRESSURE_GOVERNOR (default ON); fail-OPEN to the default-on
    // behavior so a flag-read error can't silently disable the backpressure. OFF ⇒
    // signal-only (just the warn below) — the operator's escape hatch.
    const { FLAGS } = await import('@papercusp/flags');
    const { getFlag } = await import('@papercusp/flags/server');
    const governorOn = await getFlag(
      FLAGS.CONNECTION_PRESSURE_GOVERNOR,
      'connection-pressure',
    ).catch(() => true);
    if (governorOn) connectionPressureGovernor.observe(h.saturationPct);

    if (h.saturationPct >= 85) {
      const top = h.byApplication
        .slice(0, 6)
        .map((a) => `${a.name}=${a.count}`)
        .join(' ');
      console.warn(
        `[pg-pressure] DANGER ${h.serverWideConnections}/${h.maxConnections} conns ` +
          `(${h.saturationPct}%). Top holders: ${top}. ` +
          `Remedy: raise the ceiling (npx tsx scripts/pg-autotune.ts --apply), lower ` +
          `PAPERCUSP_DB_POOL_MAX, or enable PgBouncer (PAPERCUSP_PGBOUNCER=1).`,
      );
    }
  },
};

// Every 30 min: does the live Postgres actually run the settings we derive?
// (EI-19314331871893219.) A GUC added to databaseTuningToSettings() reaches a
// NATIVE cluster only when someone runs `pg-autotune --apply`, and until this
// check existed nothing verified that they had — `max_slot_wal_keep_size` (the
// disk-fill-SPOF defense) and `shared_preload_libraries` were both found
// unapplied for weeks while the source and its tests said otherwise.
//
// Cheap (one pg_settings read) and slow-moving: the answer only changes when
// someone edits the config, so half-hourly is ample and the cost is noise.
const pgTuningDriftCheck: PeriodicCheck = {
  name: 'pg-tuning-drift',
  intervalMs: 30 * 60_000,
  // Fire on arm too: the drift this catches is a STANDING condition, not an
  // event — waiting 30 min to notice a cluster that has been misconfigured for
  // weeks would be a strange way to report it.
  fireOnArm: true,
  // D-004 (P-011): the live server's applied configuration has no change-event
  // source — a conf.d edit + SIGHUP happens entirely outside this process.
  classification: 'must-sample',
  tick: async () => {
    const { runPgTuningDriftCheckOnce, runPgHugePageBackingCheckOnce } = await import(
      '../storage/pg-tuning-drift'
    );
    await runPgTuningDriftCheckOnce();
    // Endgame D-052 (WI-10002573): the same standing-condition sample for a silent
    // huge_pages=try fallback to 4 KiB pages. Nothing else notices it after boot.
    await runPgHugePageBackingCheckOnce();
  },
};

// Every 10 min: sample unreclaimable kernel slab + dying memory cgroups into a
// per-boot series and escalate on a sustained climb (host-memory-reduction-
// 2026-09-27 P-010 / D-007). A 6.17 kernel leak reached 29.9 GiB of SUnreclaim
// over ~20 days with nothing measuring it; this surfaces the same rate in ~a day.
const kernelLeakCheck: PeriodicCheck = {
  name: 'kernel-leak-watchdog',
  intervalMs: 10 * 60_000,
  // A standing condition, like pg-tuning-drift: record a sample at boot rather
  // than 10 min later.
  fireOnArm: true,
  // D-004 (P-011): kernel memory has no change-event source.
  classification: 'must-sample',
  tick: async () => {
    const { runKernelLeakCheckOnce } = await import('../system-health/kernel-leak-watchdog');
    await runKernelLeakCheckOnce();
  },
};

// Every 60s: probe the dev endpoints + broadcast on each up/down TRANSITION
// (fleet-coordination-painpoints Phase 3b). External liveness has no event source,
// so this is the one irreducible poll; transition-only, never a per-tick firehose.
const serviceHealthCheck: PeriodicCheck = {
  name: 'service-health',
  intervalMs: 60_000,
  // D-004 (P-011): own comment already says it — "external liveness has no event source".
  classification: 'must-sample',
  tick: async () => {
    const { runServiceHealthTick } = await import('../service-health');
    await runServiceHealthTick();
  },
};

// Every 60s: poll completion_refs against the remote (git ls-remote), stamping
// verified/divergent. Per-feature backoff stays in the worker; a verifier is
// idempotent and a missed run catches up next tick.
const completionRefVerifyCheck: PeriodicCheck = {
  name: 'completion-ref-verify',
  intervalMs: 60_000,
  // D-004 (P-011): `git ls-remote` reads external repo state — no publisher exists.
  classification: 'must-sample',
  tick: async () => {
    const { runCompletionRefVerifierOnce } = await import('../harness/completion-ref-verifier');
    await runCompletionRefVerifierOnce();
  },
};

// Every 60s: reclaim orphaned spawn rows whose launching host died, so they stop
// counting forever against the global concurrency ceiling (unify-agent-spawn-
// chokepoint P-011). Freed slots → wake over-ceiling waiters (D-004).
const spawnReclaimSweepCheck: PeriodicCheck = {
  name: 'spawn-reclaim-sweep',
  intervalMs: 60_000,
  // D-004 (P-011): every leg is an elapsed-time-since-last-signal detector (stale
  // heartbeat / no-stream-activity proxy / silence past threshold) — TIMEOUT/REAPER.
  classification: 'timeout-reaper',
  tick: async () => {
    const { getOrgPg } = await import('@papercusp/db-org');
    const {
      reclaimOrphanedSpawns,
      reapTerminalSpawnResultArtifacts,
      reclaimWedgedSpawns,
      WEDGE_REAP_SILENT_MS,
      reclaimFirstOutputStalledSpawns,
      FIRST_OUTPUT_STALL_MS,
      reclaimCeilingJamDebits,
    } = await import('../fleet/spawn-reclaim');
    const sql = getOrgPg().sql;
    const { emitAwaitedEvent } = await import('../events/await/engine');
    const { spawnSlotEventKey } = await import('../fleet/operator-spawn');
    const announceFreed = async (workspaces: string[], summary: string) => {
      for (const ws of workspaces) {
        await emitAwaitedEvent({
          key: spawnSlotEventKey(ws),
          summary,
          source: 'spawn-reclaim-sweep',
          workspaceId: ws,
        }).catch(() => undefined);
      }
    };

    const r = await reclaimOrphanedSpawns(sql);
    if (r.reclaimed > 0) {
      console.warn(`[spawn-reclaim] freed ${r.reclaimed} orphaned spawn(s): ${r.spawnIds.join(', ')}`);
      try {
        await announceFreed(r.workspaces, `${r.reclaimed} orphaned spawn slot(s) reclaimed by the periodic sweep`);
      } catch {
        /* best-effort — waiters fall back to their await timeout */
      }
    }

    // EI-19425373640931996: terminal paths can leave their restart-safe result
    // artifact behind after the active-row harvest has stopped seeing them.
    // Keep seven days of forensic evidence, then reap the bounded backlog.
    try {
      const ar = await reapTerminalSpawnResultArtifacts(sql);
      if (ar.reaped > 0) {
        console.warn(
          `[spawn-reclaim] removed ${ar.reaped} terminal spawn result artifact(s): ${ar.spawnIds.join(', ')}`,
        );
      }
    } catch (err) {
      console.warn('[spawn-reclaim] terminal result artifact reaper failed (non-fatal — retries next tick):', err);
    }

    // EI-7204/EI-7197: the spawn-ceiling-jam class — a stale admission debit
    // whose heartbeat is being kept artificially fresh (reused-pid false-alive
    // on a long-lived, never-restarted operator), which the orphan sweep above
    // can never see (its own `heartbeat_at < stale` precondition never fires).
    // Reclaims the CEILING DEBIT ONLY, using the same no-stream-activity proxy
    // the watchdog's spawn-ceiling-jam signal already computes — unconditional
    // (no RECLAIM_STALLED gate: this never kills a process or a claim, see the
    // function doc), so the ceiling self-heals without an operator restart.
    try {
      const jr = await reclaimCeilingJamDebits(sql);
      if (jr.reclaimed > 0) {
        console.warn(
          `[spawn-reclaim] freed ${jr.reclaimed} spawn-ceiling-jam debit(s) (no stream activity, EI-7204): ${jr.spawnIds.join(', ')}`,
        );
        await announceFreed(
          jr.workspaces,
          `${jr.reclaimed} spawn-ceiling-jam admission debit(s) reclaimed by the periodic sweep (EI-7204)`,
        );
      }
    } catch (err) {
      console.warn('[spawn-reclaim] ceiling-jam debit sweep failed (non-fatal — retries next tick):', err);
    }

    // RECLAIM_STALLED: the "stalled, not just dead" half — durably reclaim WEDGED
    // spawns (supervised-LIVE but stream-silent past the action threshold) that the
    // orphan sweep above (stale-heartbeat only) can't see. Flag-gated OFF: killing a
    // live agent + freeing its slot is a hot-path placement change (D-003 attended).
    // The reap engine + threshold are the SAME as the in-memory `reapWedgedLocalSpawns`
    // fast path — this is the durable, DB-truth, restart-safe floor over it.
    try {
      const [{ getFlag }, { FLAGS }] = await Promise.all([
        import('@papercusp/flags/server'),
        import('@papercusp/flags'),
      ]);
      if (await getFlag(FLAGS.RECLAIM_STALLED, 'system')) {
        const { cancelSubtree } = await import('../fleet/nursery');
        const { abortLocalSpawn } = await import('../fleet/operator-spawn');
        const wr = await reclaimWedgedSpawns(sql, async (c) => {
          const silentMin = Math.round(c.silentMs / 60_000);
          // Durable cancel FIRST (releases claims/locks + flips the row with a
          // `reclaimed:`-prefixed reason → the placement watchdog reads it as an
          // infra reclaim, not item-pathology, WI-233), THEN SIGTERM the live child.
          // Idempotent: a row that just settled is `alreadyTerminal`, the abort no-ops.
          await cancelSubtree(sql, {
            workspaceId: c.workspaceId,
            rootSpawnId: c.spawnId,
            reason: `reclaimed: wedged — alive but stream-silent ${silentMin}min (> ${Math.round(
              WEDGE_REAP_SILENT_MS / 60_000,
            )}min, RECLAIM_STALLED durable reaper)`,
            actor: {
              ownerId: 'wedge-reclaim-sweep',
              ownerLabel: 'system · wedge-reclaim-sweep',
              source: 'signed-spawn',
              workspaceId: c.workspaceId,
              userId: null,
            },
          });
          abortLocalSpawn(c.spawnId);
          return true;
        });
        if (wr.reclaimed > 0) {
          console.warn(
            `[wedge-reclaim] durably reaped ${wr.reclaimed} wedged spawn(s): ${wr.spawnIds.join(', ')}`,
          );
          await announceFreed(
            wr.workspaces,
            `${wr.reclaimed} wedged spawn slot(s) reclaimed (RECLAIM_STALLED durable reaper)`,
          );
        }
      }
    } catch (err) {
      console.warn('[wedge-reclaim] sweep failed (non-fatal — retries next tick):', err);
    }

    // EI-7345: the "never even started, not just wedged" half — durably reclaim
    // spawns that are supervised-LIVE but have NEVER produced a single byte of
    // output past the (short) first-output threshold. reclaimWedgedSpawns above
    // deliberately excludes these ("absence of signal is not evidence of a
    // wedge" — that guard is about a row that HAS emitted before going quiet);
    // left alone, these previously rode 15-52min to whatever outer SIGTERM/budget
    // timeout finally killed them, burning wall-clock and a concurrency slot for
    // a spawn that never got a single model turn. Same RECLAIM_STALLED gate as
    // the wedge reap (killing a live process is the same risk class).
    try {
      const [{ getFlag }, { FLAGS }] = await Promise.all([
        import('@papercusp/flags/server'),
        import('@papercusp/flags'),
      ]);
      if (await getFlag(FLAGS.RECLAIM_STALLED, 'system')) {
        const { cancelSubtree } = await import('../fleet/nursery');
        const { abortLocalSpawn } = await import('../fleet/operator-spawn');
        const fr = await reclaimFirstOutputStalledSpawns(sql, async (c) => {
          const silentMin = Math.round(c.silentMs / 60_000);
          await cancelSubtree(sql, {
            workspaceId: c.workspaceId,
            rootSpawnId: c.spawnId,
            reason: `reclaimed: first-output stall — alive but produced zero output ${silentMin}min ` +
              `(> ${Math.round(FIRST_OUTPUT_STALL_MS / 60_000)}min, RECLAIM_STALLED durable reaper, EI-7345) ` +
              `— never got a model turn, no retry attempt charged`,
            actor: {
              ownerId: 'first-output-stall-reclaim-sweep',
              ownerLabel: 'system · first-output-stall-reclaim-sweep',
              source: 'signed-spawn',
              workspaceId: c.workspaceId,
              userId: null,
            },
          });
          abortLocalSpawn(c.spawnId);
          return true;
        });
        if (fr.reclaimed > 0) {
          console.warn(
            `[first-output-stall-reclaim] durably reaped ${fr.reclaimed} first-output-stalled spawn(s): ${fr.spawnIds.join(', ')}`,
          );
          await announceFreed(
            fr.workspaces,
            `${fr.reclaimed} first-output-stalled spawn slot(s) reclaimed (RECLAIM_STALLED durable reaper, EI-7345)`,
          );
        }
      }
    } catch (err) {
      console.warn('[first-output-stall-reclaim] sweep failed (non-fatal — retries next tick):', err);
    }
  },
};

// Every 60s: release work-item / issue / plan-item claims held by DEAD agents
// (alias-aware liveness). Companion to spawn-reclaim: that frees the dead spawn's
// CONCURRENCY slot, this frees its CLAIMS. Also stamps a liveness heartbeat
// (recordSweepRun) so the system-health reader can detect a WEDGED scheduler.
const staleClaimSweepCheck: PeriodicCheck = {
  name: 'stale-claim-sweep',
  intervalMs: 60_000,
  // D-004 names "stale-claim sweep" as its own canonical TIMEOUT/REAPER example.
  classification: 'timeout-reaper',
  tick: async () => {
    const { getOrgPg } = await import('@papercusp/db-org');
    const sql = getOrgPg().sql;

    const { reclaimStaleWorkItemClaims, reclaimStaleIssueClaims, reconcileStrandedWipWorkItems } = await import(
      '../work-items-stale-claims'
    );
    // live-configurability-audit P-014: apply the stale-claim reclaim overrides (undefined ⇒ baked default).
    const { readCoordLivenessConfig } = await import('../coord-liveness-config');
    const livenessCfg = await readCoordLivenessConfig();
    // agent-activity-liveness-truth P-003 (D-003): the STALLED leg (free a LIVE but
    // non-progressing holder) is flag-gated OFF by default — a live-placement change
    // on a hot path. The DEAD + confirmed-terminal-spawn legs always run.
    const [{ getFlag }, { FLAGS }] = await Promise.all([
      import('@papercusp/flags/server'),
      import('@papercusp/flags'),
    ]);
    const includeStalled = await getFlag(FLAGS.RECLAIM_STALLED, 'system');
    const r = await reclaimStaleWorkItemClaims(sql, {
      graceMs: livenessCfg.reclaimGraceMs,
      parkedGraceMs: livenessCfg.reclaimParkedGraceMs,
      requeueCap: livenessCfg.reclaimRequeueCap,
      includeStalled,
    });
    if (r.released.length > 0) {
      const byAction = r.released.reduce<Record<string, number>>((acc, c) => {
        acc[c.action] = (acc[c.action] ?? 0) + 1;
        return acc;
      }, {});
      const byReason = r.released.reduce<Record<string, number>>((acc, c) => {
        acc[c.reason] = (acc[c.reason] ?? 0) + 1;
        return acc;
      }, {});
      console.warn(
        `[stale-claims] released ${r.released.length} work-item claim(s) ` +
          `(reasons: ${Object.entries(byReason).map(([a, n]) => `${a}:${n}`).join(', ')}; ` +
          `${Object.entries(byAction).map(([a, n]) => `${a}:${n}`).join(', ')}): ` +
          r.released.map((c) => `${c.harness_slug}/${c.feature_id}<-${c.former_taken_by} [${c.former_status}->${c.new_status} ${c.reason}]`).join(', '),
      );
      // Broadcast ONLY dead-letters: poison items that exhausted the requeue cap and
      // parked in `blocked`, which DO need human/Queen attention (D-006).
      const deadLettered = r.released.filter((c) => c.action === 'dead-lettered');
      if (deadLettered.length > 0) {
        try {
          const { sendMessage } = await import('../agent-tools/coordination/messages');
          await sendMessage(
            {
              ownerId: 'stale-claim-sweep',
              ownerLabel: 'system · stale-claim-sweep',
              source: 'signed-spawn',
              workspaceId: null,
              userId: null,
            },
            {
              to: ['*'],
              summary:
                `stale-claim sweep: ${deadLettered.length} work item(s) dead-lettered to [blocked] ` +
                `(stale-reclaim-exhausted — requeued past the cap by repeatedly-dying holders, needs attention): ` +
                deadLettered.map((c) => `${c.harness_slug}/${c.feature_id} (requeued ${c.requeue_count}x)`).join(', '),
            },
          );
        } catch {
          /* best-effort — the console.warn above is the floor */
        }
      }
      // EI-18676518990229124: notify the FORMER HOLDER directly, for every reclaimed
      // row (not just dead-letters) — the console.warn above lands only in the server
      // log, which no agent reads. Without this, a claim can be reclaimed out from
      // under a holder (a false-positive DEAD verdict, or a genuinely-dead session that
      // later resumes from a checkpoint) with zero signal to the one party who most
      // needs to know: the reporter's own repro showed a holder re-claiming the same
      // item three times across 45 minutes with no idea its claim kept vanishing. A
      // dead holder simply never reads this (harmless no-op); a live-but-falsely-reaped
      // holder sees it on its next inbox check and can re-claim deliberately instead of
      // discovering the loss by chance re-read. Best-effort per-row so one bad ownerId
      // never blocks the rest of the sweep.
      try {
        const { sendMessage } = await import('../agent-tools/coordination/messages');
        for (const c of r.released) {
          if (!c.former_taken_by) continue;
          try {
            await sendMessage(
              {
                ownerId: 'stale-claim-sweep',
                ownerLabel: 'system · stale-claim-sweep',
                source: 'signed-spawn',
                workspaceId: null,
                userId: null,
              },
              {
                to: [c.former_taken_by],
                harnessSlug: c.harness_slug,
                summary:
                  `Your claim on ${c.feature_id} was reclaimed (reason: ${c.reason}, ` +
                  `${c.former_status}->${c.new_status}). If you are still actively working it, ` +
                  `re-claim it now — this can be a false positive if your recent activity was ` +
                  `mostly native tool calls the liveness sweep didn't see.`,
              },
            );
          } catch {
            /* best-effort — one bad recipient must never block the others */
          }
        }
      } catch {
        /* best-effort — notification is never load-bearing for the sweep itself */
      }
    }

    // WI-6039: the GENERAL backstop for a work_items row ALREADY stuck at
    // status='wip' with taken_by NULL/empty — the residual state the reclaim SQL
    // above (pre-fix) could leave behind, or that any OTHER writer might still
    // produce. Unlike the reclaim above, no liveness decision is needed here:
    // taken_by is already empty, so the row is unconditionally not "in progress".
    // A non-zero, RECURRING result here (beyond the one-time historical backlog
    // WI-6039 reconciled directly) means some writer other than the fixed reclaim
    // path is still creating these — logged loudly precisely so that's noticed,
    // since a stuck-wip row is invisible to every other orphan/stall detector
    // (confirmed live: it hid a 6-day autonomous-loop canary outage).
    try {
      const stranded = await reconcileStrandedWipWorkItems(sql);
      if (stranded.length > 0) {
        console.warn(
          `[stranded-wip-reconcile] WI-6039: found + reopened ${stranded.length} work-item(s) stuck at ` +
            `status='wip' with no holder (unclaimable + undetectable until now): ` +
            stranded.map((s) => `${s.harness_slug}/${s.feature_id}`).join(', '),
        );
      }
    } catch (e) {
      console.warn(
        `[stranded-wip-reconcile] WI-6039 sweep failed (non-fatal — retries next tick): ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // ── P-017 (cross-machine-coord-parity-and-trust-2026-07-01): the LEASE-table
    // backstops the WORKITEM_CLAIM_LEASE flag (DEFAULT ON since WI-597) shipped
    // without. (a) GC: sweep lapsed harness_shared.work_item_claims rows — until
    // now nothing ever deleted them (steal-on-acquire was the only consumer).
    // (b) DIVERGENCE DETECTION: a live lease whose holder disagrees with the
    // work item's denorm `taken_by` is the post-failover double-claim signature —
    // ANNOTATE loudly, don't auto-mutate (the liveness model's own rule; full
    // cross-machine reconcile rides the federated claims read model, later).
    try {
      const { sweepLapsedClaims } = await import('../work-item-claims');
      const wsRows = await sql<{ workspace_id: string }[]>`
        SELECT DISTINCT workspace_id FROM harness_shared.work_item_claims
        WHERE expires_ts <= clock_timestamp()`;
      let swept = 0;
      for (const w of wsRows) swept += await sweepLapsedClaims(w.workspace_id);
      if (swept > 0) console.warn(`[claim-lease] swept ${swept} lapsed lease row(s) (P-017 GC)`);
      const diverged = await sql<
        { workspace_id: string; harness_slug: string; work_item_id: string; owner: string; taken_by: string | null }[]
      >`
        SELECT c.workspace_id, c.harness_slug, c.work_item_id, c.owner, f.taken_by
        FROM harness_shared.work_item_claims c
        JOIN harness_shared.harness_features_consolidated f
          ON f.workspace_id = c.workspace_id
         AND f.harness_slug = c.harness_slug
         AND f.feature_id = c.work_item_id
        WHERE c.expires_ts > clock_timestamp()
          AND COALESCE(f.taken_by, '') <> c.owner
        LIMIT 20`;
      if (diverged.length > 0) {
        console.warn(
          `[claim-lease] ${diverged.length} lease/denorm DIVERGENCE(s) — post-failover double-claim ` +
            `signature; lease is the authority-arbitrated fact (annotate-only, P-017): ` +
            diverged
              .map((d) => `${d.harness_slug}/${d.work_item_id} lease=${d.owner} taken_by=${d.taken_by ?? '∅'}`)
              .join(', '),
        );
      }
    } catch (e) {
      console.warn(
        `[claim-lease] P-017 backstop tick failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // The issue-family reaper — clear dead holders off OPEN bug/change issues
    // (same alias-aware liveness), returning them to the open pool (P-005 / D-009).
    // WI-2689: thread the SAME reclaim overrides the feature reaper gets (this path
    // previously took none, so the configurable grace + parked-grace churn fix never
    // reached issue-family claims — WI-2118-class change items).
    const ir = await reclaimStaleIssueClaims(sql, {
      graceMs: livenessCfg.reclaimGraceMs,
      parkedGraceMs: livenessCfg.reclaimParkedGraceMs,
    });
    if (ir.released.length > 0) {
      console.warn(
        `[stale-claims] reaped ${ir.released.length} issue-family claim(s) from dead holders ` +
          `(returned to the open pool): ` +
          ir.released.map((c) => `${c.issue_id}[${c.kind}]<-${c.former_assignee}`).join(', '),
      );
      // EI-18676518990229124: same per-former-holder notification as the feature-family
      // reaper above — this leg previously notified NOBODY (console.warn only), so a
      // holder whose bug/change assignment was reclaimed had zero signal it happened.
      try {
        const { sendMessage } = await import('../agent-tools/coordination/messages');
        for (const c of ir.released) {
          if (!c.former_assignee) continue;
          try {
            await sendMessage(
              {
                ownerId: 'stale-claim-sweep',
                ownerLabel: 'system · stale-claim-sweep',
                source: 'signed-spawn',
                workspaceId: null,
                userId: null,
              },
              {
                to: [c.former_assignee],
                summary:
                  `Your assignment on ${c.issue_id} [${c.kind}] was reclaimed as a dead-holder ` +
                  `stale claim and returned to the open pool. If you are still actively working ` +
                  `it, re-claim it now — this can be a false positive if your recent activity was ` +
                  `mostly native tool calls the liveness sweep didn't see.`,
              },
            );
          } catch {
            /* best-effort — one bad recipient must never block the others */
          }
        }
      } catch {
        /* best-effort — notification is never load-bearing for the sweep itself */
      }
    }
    // EI-6480: the sweep also cleared orphaned per-Hive claim leases (stale leases surviving a
    // taken_by-clear that made an unclaimed issue fail lease arbitration for every new claimer).
    if (ir.orphanLeasesCleared > 0) {
      console.warn(
        `[stale-claims] cleared ${ir.orphanLeasesCleared} orphaned issue-family claim lease(s) ` +
          `(EI-6480 stale-lease class — item was unclaimed yet lease-poisoned)`,
      );
    }

    // P-003 agent-operability: one owner-batched transaction terminates EVERY active
    // loop and lifts EVERY expired hold for owners unreachable past grace. This runs
    // before the generic hold sweep, which remains the backstop for dead holders that
    // never owned a loop.
    try {
      const { sweepDeadOwnerControlState } = await import('../dead-owner-control-sweep');
      const dead = await sweepDeadOwnerControlState(sql, {
        graceMs: livenessCfg.reclaimGraceMs,
        parkedGraceMs: livenessCfg.reclaimParkedGraceMs,
        holdOpenGraceMs: livenessCfg.holdOpenGraceMs,
      });
      if (dead.owners.length > 0) {
        console.warn(
          `[dead-owner-control] swept ${dead.owners.length} owner(s) in one transaction: ` +
            `${dead.loopsTerminated} loop(s) terminated, ${dead.holdsLifted} expired hold(s) lifted ` +
            `(${dead.owners.join(', ')})`,
        );
      }
    } catch (e) {
      console.warn(`[dead-owner-control] sweep failed (non-fatal — retries next tick): ${e instanceof Error ? e.message : String(e)}`);
    }

    // WI-4531 — the HOLD-OPEN reaper. A hold (payload.held_open_by) is a STRONGER block than
    // a claim: it excludes the item from self-select AND refuses a terminal transition by
    // anyone but the holder. It had no TTL and no liveness check, so it outlived its holder
    // forever — measured live before this shipped: 64 holds, 50 of them non-terminal (items
    // silently starved out of the claimable pool) across 21 holders, only ONE of which still
    // existed in coord_presence. Same liveness fragments as the claim reapers above (they can
    // never diverge); a LIVE holder's hold is never touched, however old.
    try {
      const { reclaimStaleHoldOpens } = await import('../work-items-hold-open');
      const hr = await reclaimStaleHoldOpens(sql, {
        graceMs: livenessCfg.reclaimGraceMs,
        parkedGraceMs: livenessCfg.reclaimParkedGraceMs,
        holdOpenGraceMs: livenessCfg.holdOpenGraceMs,
      });
      if (hr.expired.length > 0) {
        console.warn(
          `[hold-open] lifted ${hr.expired.length} EXPIRED hold-open(s) from dead holders ` +
            `(item returns to normal self-select + terminal transition): ` +
            hr.expired
              .map((h) => `${h.harness_slug}/${h.feature_id}[${h.status}]<-${h.former_holder}`)
              .join(', '),
        );
        // Broadcast ONLY the non-terminal ones: those are the items that were actually being
        // starved (a hold on an already-resolved row is inert residue — clearing it is
        // housekeeping nobody needs to hear about).
        const starved = hr.expired.filter((h) => !['resolved', 'closed', 'passed', 'deprecated', 'done', 'dropped'].includes(h.status));
        if (starved.length > 0) {
          try {
            const { sendMessage } = await import('../agent-tools/coordination/messages');
            await sendMessage(
              {
                ownerId: 'hold-open-sweep',
                ownerLabel: 'system · hold-open-sweep',
                source: 'signed-spawn',
                workspaceId: null,
                userId: null,
              },
              {
                to: ['*'],
                summary:
                  `🔓 hold-open sweep: lifted ${starved.length} EXPIRED hold(s) whose holder is no longer live ` +
                  `— these items were excluded from claim_next/scheduler and could not be closed by anyone but a ` +
                  `dead agent (WI-4531). Normal lifecycle resumes: ` +
                  starved.map((h) => `${h.feature_id} (was held by ${h.former_holder})`).join(', '),
                // EI-18183171615661851: this fires on EVERY 60s stale-claim-sweep tick that
                // finds a newly-expired hold, so on a busy fleet where holds trickle in one at
                // a time it produced a run of near-identical "lifted 1 EXPIRED hold(s)"
                // broadcasts (5 in a single wake's digest was the reported case) — each with a
                // DIFFERENT feature_id in its summary, so coalesceRepeatedBroadcasts' exact-text
                // match (coord:inbox's ×N-row fold) can never merge them. `category` was simply
                // never stamped on this call, unlike every sibling system-routine broadcast
                // (service-health, doc-drift, agent-governor, resource-locks — see
                // coord:inbox's AMBIENT_CATEGORIES). Tagging it 'service-health' (the same
                // category service-health.ts / db-boot-migrate.ts / inference-gateway use for
                // routine status housekeeping) makes coord:inbox default-EXCLUDE it as ambient
                // — nobody but the sweep itself needs to see every single lift in real time —
                // while `include_ambient` still surfaces it for anyone auditing WI-4531.
                category: 'service-health',
                extra: { auto: true, lifecycle: 'hold_open_expired' },
              },
            );
          } catch {
            /* best-effort — the console.warn above is the floor */
          }
        }
      }
    } catch (e) {
      console.warn(
        `[hold-open] sweep failed (non-fatal — retries next tick): ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    // The PLAN-ITEM analog (EI-179): delete claims whose lease lapsed past grace AND
    // whose holder is gone. The durable ASSIGNMENT (mig 140) is untouched HERE — the
    // assignment reaper below handles it.
    const {
      reclaimExpiredPlanItemClaims,
      reclaimStaleDeadHolderPlanItemAssignments,
      reclaimStalledLivePlanItemAssignments,
    } = await import('../plan-items/stale-claims');
    const pr = await reclaimExpiredPlanItemClaims(sql);
    if (pr.released.length > 0) {
      console.warn(
        `[stale-claims] released ${pr.released.length} EXPIRED plan-item claim(s) from dead holders ` +
          `(lease lapsed past grace, no live presence): ` +
          pr.released
            .map((c) => `${c.harness_slug}/${c.plan_slug}#${c.item_id}<-${c.former_owner}`)
            .join(', '),
      );
    }

    // The dead-holder ASSIGNMENT reaper (EI-2535): soft-release durable plan-item
    // RESERVATIONS whose name-aware holder is dead past grace (a one-shot session-id
    // assignee never re-adopts, so its reservation strands forever — the leases above
    // never touched it). Returns the item to the unassigned pool.
    const ar = await reclaimStaleDeadHolderPlanItemAssignments(sql, {
      graceMs: livenessCfg.assignmentReclaimGraceMs,
    });
    if (ar.released.length > 0) {
      console.warn(
        `[stale-claims] soft-released ${ar.released.length} dead-holder plan-item assignment(s) ` +
          `(reserved past grace, no live presence): ` +
          ar.released
            .map((c) => `${c.harness_slug}/${c.plan_slug}#${c.item_id}<-${c.former_assignee}`)
            .join(', '),
      );
    }

    // The STALLED-but-ALIVE assignment leg (stale-ownership-activity-truth): release a
    // durable assignment whose holder is process-ALIVE (heartbeating) but has done no
    // GENUINE activity (last_active_at) within the window — the "agent wandered off but
    // its process lingers, so the item still reads as assigned/handled" gap. Gated by
    // RECLAIM_STALLED (same switch as the work-item stalled leg) — a live-placement
    // change D-003 ships behind that flag.
    let sar = { released: [] as typeof ar.released };
    if (includeStalled) {
      sar = await reclaimStalledLivePlanItemAssignments(sql);
      if (sar.released.length > 0) {
        console.warn(
          `[stale-claims] soft-released ${sar.released.length} STALLED-but-alive plan-item assignment(s) ` +
            `(holder heartbeating but genuinely idle past the activity window): ` +
            sar.released
              .map((c) => `${c.harness_slug}/${c.plan_slug}#${c.item_id}<-${c.former_assignee}`)
              .join(', '),
        );
      }
    }

    // P-009 heartbeat — record this run (always, even when nothing was freed) so the
    // system-health reader can detect a WEDGED scheduler (last-run aged out).
    try {
      const { recordSweepRun, STALE_CLAIM_SWEEP_NAME } = await import('../work-queue-health');
      await recordSweepRun(
        sql,
        STALE_CLAIM_SWEEP_NAME,
        r.released.length + ir.released.length + pr.released.length + ar.released.length + sar.released.length,
      );
    } catch {
      /* best-effort heartbeat */
    }
  },
};

// Every 60s: resolve DUE `work_items:request_release` deadlines (WI-5974) — the
// "announced consequence" rail. A request left unanswered past its deadline fires the
// ANNOUNCED onSilence action (reclaim/escalate/nothing); one that was resolved early
// (holder released or declined — release.ts / decline_release_request.ts) never reaches
// here (findDueReleaseRequests only returns unresolved rows). CAS-guarded per row
// (resolveWorkItemReleaseRequest), so a row raced by a concurrent holder-response is
// silently skipped, never double-fired.
const releaseRequestSweepCheck: PeriodicCheck = {
  name: 'release-request-sweep',
  intervalMs: 60_000,
  // A host can restart after a request's deadline has already passed. Reconcile once
  // on arm so the durable deadline is not delayed by another full interval; the
  // resolver and liveness guard remain the authority for whether a consequence fires.
  fireOnArm: true,
  // D-004 (P-011): resolves DUE deadlines — deadline-passing is the trigger by
  // construction (the "announced consequence" rail).
  classification: 'timeout-reaper',
  tick: async () => {
    const { getOrgPg } = await import('@papercusp/db-org');
    const sql = getOrgPg().sql;
    const { findDueReleaseRequests, hasWorkItemProgressAfterReleaseRequest, resolveWorkItemReleaseRequest } = await import('../work-items-release-request');
    const { releaseWorkItem, setWorkItemClaimHold, commentWorkItem } = await import('../work-items');
    const { releaseReclaimedWorkItemLocks } = await import('../work-item-lock-release');
    const { assessForceRelease } = await import('../agent-tools/work_items/release-force-guard');
    const { sendMessage } = await import('../agent-tools/coordination/messages');
    const { notifyAttention } = await import('../attention-notify');

    const due = await findDueReleaseRequests(sql, { nowMs: Date.now() });
    for (const row of due) {
      const { request: req } = row;
      const resolution =
        req.onSilence === 'reclaim' ? 'consequence-reclaim' : req.onSilence === 'escalate' ? 'consequence-escalate' : 'consequence-nothing';
      if (req.onSilence === 'reclaim') {
        const holder = row.holderNow ?? req.holder;
        if (holder === req.holder && hasWorkItemProgressAfterReleaseRequest(req, row.lastProgressAt)) {
          const responded = await resolveWorkItemReleaseRequest(row.id, {
            harness: row.harness ?? undefined,
            resolution: 'holder-progressed',
            expectedBy: req.by,
            expectedHolder: req.holder,
            expectedDeadlineAt: req.deadlineAt,
            expectedLastProgressAt: row.lastProgressAt,
          }).catch(() => null);
          if (!responded) continue;
          if (responded.resolution === 'superseded') continue;
          await commentWorkItem(
            row.id,
            `✅ Release request from ${req.by} resolved without reclaim: the holder recorded item progress after the request.`,
            'release-request-sweep',
            { harness: row.harness ?? undefined },
          ).catch(() => {});
          console.warn(`[release-request-sweep] ${row.id}: reclaim suppressed because the holder made progress after the request`);
          continue;
        }
        // EI-21377805080867612: a durable request is not proof its holder saw it.
        // A Codex session can spend the whole deadline inside one long turn while
        // making tool calls; the pty host safely defers mid-turn injection, so the
        // inbox message reaches the agent only after the turn settles. Re-check the
        // shared force guard NOW, before resolving the request CAS: recent tool
        // activity keeps the claim live and postpones the announced consequence;
        // once the holder truly goes idle/dead, the same still-unresolved request is
        // eligible on a later sweep. Caller authority remains a separate valid basis.
        const releaseVerdict = await assessForceRelease({
          callerOwnerId: req.by,
          holderOwnerId: holder,
          workspaceId: row.workspaceId,
          itemLastProgressAt: row.lastProgressAt,
          releaseRequest: req,
        }).catch(() => null);
        if (!releaseVerdict?.allowed) {
          console.warn(
            `[release-request-sweep] ${row.id}: reclaim deferred — ${holder} still has live/progress evidence; ` +
              'the unresolved request will be reconsidered after activity stops',
          );
          continue;
        }
      }
      // CAS FIRST — only the tick that wins the compare-and-resolve acts. A row a peer
      // resolved (holder released/declined) in the same window is a no-op here.
      const resolved = await resolveWorkItemReleaseRequest(row.id, {
        harness: row.harness ?? undefined,
        resolution,
        expectedBy: req.by,
        expectedHolder: req.holder,
        expectedDeadlineAt: req.deadlineAt,
        expectedLastProgressAt: row.lastProgressAt,
      }).catch(() => null);
      if (!resolved) continue;

      // The resolver can win the request CAS after the item has already settled. In
      // that case it marks the request superseded, but the announced consequence is
      // moot: do not release locks, mutate the item, or notify anyone with a false
      // RECLAIMED/ESCALATED outcome (EI-21205403365070536).
      if (resolved.resolution === 'superseded') {
        console.warn(`[release-request-sweep] ${row.id}: consequence suppressed because the item is already terminal`);
        continue;
      }

      const deadlineIso = new Date(resolved.deadlineAt).toISOString();
      const noteBody =
        `⏰ Release request from ${resolved.by} → ${resolved.holder} EXPIRED unanswered ` +
        `(deadline ${deadlineIso}) — announced onSilence:"${resolved.onSilence}" fired: ${resolution}. ` +
        `Original reason: ${resolved.reason}`;
      await commentWorkItem(row.id, noteBody, 'release-request-sweep', { harness: row.harness ?? undefined }).catch(() => {});
      console.warn(`[release-request-sweep] ${row.id}: ${resolution} (requested by ${resolved.by}, holder ${resolved.holder})`);

      if (req.onSilence === 'reclaim') {
        // The announcement + expired deadline is necessary but no longer sufficient:
        // the live/progress guard above proves the holder actually reached an idle/dead
        // state (or the requester has independent force authority) before this mutation.
        // Release the former holder's declared touch-set BEFORE returning the
        // work-item to the claim pool. This is deliberately targeted: all_mine
        // would strand unrelated work owned by the same agent. A lock-plane
        // failure is fail-open and the file-lock lease remains the backstop.
        const lockRelease = await releaseReclaimedWorkItemLocks({
          ownerId: row.holderNow ?? resolved.holder,
          paths: row.paths,
          goalRef: row.id,
        });
        if (lockRelease.failures > 0) {
          console.warn(
            `[release-request-sweep] ${row.id}: targeted lock release had ${lockRelease.failures} failure(s); reclaim continues with lease fallback`,
          );
        }
        // The due-row read is the holder snapshot that authorized this consequence. Keep
        // both mutations tied to it: a successor that claims between the scan and release
        // must not be released, and its lease must not be cleared. When the row is already
        // unassigned, the resolved request holder still lets us lift the stale lease left
        // by the reclaimed holder.
        const reclaimHolder = row.holderNow ?? resolved.holder;
        const released = await releaseWorkItem(row.id, {
          harness: row.harness ?? undefined,
          expectedAssignee: reclaimHolder,
        }).catch(() => null);
        if (released) {
          await setWorkItemClaimHold(row.id, false, {
            harness: row.harness ?? undefined,
            leaseOnly: true,
            expectedLeaseHolder: reclaimHolder,
          }).catch(() => null);
        }
        await sendMessage(
          { ownerId: 'release-request-sweep', ownerLabel: 'system · release-request-sweep', source: 'signed-spawn', workspaceId: row.workspaceId, userId: null },
          {
            to: [resolved.holder, resolved.by],
            summary: `${row.id}: release request went unanswered past its deadline — RECLAIMED per the announced consequence (requested by ${resolved.by}).`,
            harnessSlug: row.harness ?? undefined,
            extra: { auto: true, lifecycle: 'release_request_consequence', work_item: row.id, resolution },
          },
        ).catch(() => {});
        if (!released) console.warn(`[release-request-sweep] ${row.id}: reclaim fired but release itself failed (already free / raced)`);
      } else if (req.onSilence === 'escalate') {
        await notifyAttention({
          kind: 'intervention',
          title: `release request timed out — ${row.id}`,
          body: `${resolved.by} requested ${resolved.holder} release ${row.id} (reason: ${resolved.reason}) — no response by the deadline. Escalating per the announced consequence.`,
          importance: 'high',
          harnessSlug: row.harness ?? undefined,
          data: { workItem: row.id, holder: resolved.holder, requestedBy: resolved.by },
        }).catch(() => {});
        await sendMessage(
          { ownerId: 'release-request-sweep', ownerLabel: 'system · release-request-sweep', source: 'signed-spawn', workspaceId: row.workspaceId, userId: null },
          {
            to: [resolved.holder, resolved.by],
            summary: `${row.id}: release request went unanswered past its deadline — ESCALATED per the announced consequence (item stays with ${resolved.holder}).`,
            harnessSlug: row.harness ?? undefined,
            extra: { auto: true, lifecycle: 'release_request_consequence', work_item: row.id, resolution },
          },
        ).catch(() => {});
      } else {
        await sendMessage(
          { ownerId: 'release-request-sweep', ownerLabel: 'system · release-request-sweep', source: 'signed-spawn', workspaceId: row.workspaceId, userId: null },
          {
            to: [resolved.holder, resolved.by],
            summary: `${row.id}: release request went unanswered past its deadline — no consequence configured (onSilence:"nothing"); item stays with ${resolved.holder}.`,
            harnessSlug: row.harness ?? undefined,
            extra: { auto: true, lifecycle: 'release_request_consequence', work_item: row.id, resolution },
          },
        ).catch(() => {});
      }
    }
  },
};

// Every 2min: composite learning-infra health tick (consume-edges P-003/D-002) —
// LLM-spine + runner spawn + gym circuit → ONE status; owner notification on the
// transition to offline. Flag-gated (LEARNING_INFRA_HEALTH); transition-only.
const learningInfraHealthCheck: PeriodicCheck = {
  name: 'learning-infra-health',
  intervalMs: 120_000,
  // D-004 (P-011): the binding llm-spine leg requires a live HTTP probe — no publisher.
  classification: 'must-sample',
  tick: async () => {
    const { FLAGS } = await import('@papercusp/flags');
    const { getFlag } = await import('@papercusp/flags/server');
    if (!(await getFlag(FLAGS.LEARNING_INFRA_HEALTH, 'learning-infra-health'))) return;
    const { runLearningInfraHealthTick } = await import('../harness/improvements/learning-infra-health');
    const { health, transition } = await runLearningInfraHealthTick();
    if (transition) {
      console.warn(`[learning-infra-health] ${transition === 'offline' ? 'OFFLINE' : 'recovered'} — ${health.reason}`);
    }
  },
};

// Every 5min: the multi-Queen steering-churn tripwire sweep (hive-network-surface
// P-010 / D-004). Find backlog items re-steered by >= 2 distinct writers in the
// window and raise a debounced owner escalate above the flip threshold.
const steeringChurnSweepCheck: PeriodicCheck = {
  name: 'steering-churn-sweep',
  intervalMs: 300_000,
  // D-004/lane-C1 (P-011): a threshold-over-a-time-window computation, not a
  // single-value recompute of a store with an existing change event — MUST-SAMPLE
  // per the C1/P-008 verdict (borderline; flagged, not reclassified VIOLATION).
  classification: 'must-sample',
  tick: async () => {
    const { sweepSteeringChurn, pruneSteeringChurnEvents } = await import('../steering-churn');
    const r = await sweepSteeringChurn();
    if (r.escalated > 0) {
      console.warn(`[steering-churn] swept ${r.checked} churned item(s); escalated ${r.escalated} to the owner`);
    }
    await pruneSteeringChurnEvents();
  },
};

// Every 5min: federation-drain reconcile (WI-254 / EI-1618 item 2). Flags a LIVE
// booted harness whose substrate_outbox is undrained past 60s (content captured but
// NOT federating — the EI-681 silent-stall class) and files a DEDUPED improvement —
// the proactive half of EI-1618's on-read drain-health surface, so a silent stall is
// caught without a reader. Composes with substrate-outbox-backstop-gc (alert@60s vs
// its GC@48h — a huge no-race margin). Lives here (NOT a DBOS workflow) per EI-1622:
// an ephemeral health check on a durable workflow is the workflow_status-bloat that
// froze the routine engine. Flag-gated (FEDERATION_DRAIN_RECONCILE); DEFAULT ON (not
// in DARK_FLAGS — the code ships ready + tested, so per repo policy it ships live,
// not parked dark pending review; verified live 2026-07-19). Was previously an
// ad-hoc `process.env.PAPERCUSP_FEDERATION_DRAIN_RECONCILE` gate (banned pattern,
// lint:env-feature-gates) — replaced with this FLAGS entry. HEAVY (substrate_outbox
// group-scan) → sheds under saturation; a stall persists, so a shed tick is caught
// next interval.
const federationDrainReconcileCheck: PeriodicCheck = {
  name: 'federation-drain-reconcile',
  intervalMs: 300_000,
  shed: true,
  // D-004 (P-011): flags an undrained outbox past an elapsed-time threshold — a
  // stall detector, same shape as spawn-reclaim/stale-claim.
  classification: 'timeout-reaper',
  tick: async () => {
    const { FLAGS } = await import('@papercusp/flags');
    const { getFlag } = await import('@papercusp/flags/server');
    if (!(await getFlag(FLAGS.FEDERATION_DRAIN_RECONCILE, 'system'))) return;
    const { runDrainReconcileOnce } = await import('../sync/hyperbee/run-drain-reconcile');
    await runDrainReconcileOnce();
  },
};

// WI-887 self-heal: owner-side epoch-key reconcile. A shared-hive member that went stuck without the
// CURRENT epoch key (it federated in around an epoch advance, or was missed while papercusp-hive-rekey
// was dark) cannot decrypt current content, so its plans/work_items silently never materialize (the
// live federation gap, plan shared-hive-member-content-federation D-018; the owner's Mac join hits
// this). The onMemberApplied hook heals the moment a membership op applies; this sweep heals a hive
// whose members are ALREADY applied (no fresh op coming) — e.g. on app restart / on the flag flip.
// GAP-AWARE: it does NO crypto on an intact hive (only reconciles a hive with a member missing the
// current key), owner-gated (reconcile no-ops where this box lacks the hive key), and flag-gated.
const hiveEpochKeyReconcileCheck: PeriodicCheck = {
  name: 'pot-epoch-key-reconcile',
  intervalMs: 600_000,
  // NOT shed: gap-aware (does no crypto on an intact hive), so it stays cheap under load and the
  // fireOnArm heal-on-startup runs even during the busy boot window (a shed tick would skip it).
  shed: false,
  fireOnArm: true, // heal stuck members on app startup, not only after the first 10m interval
  // D-004 names "epoch-key reconcile" as its own canonical TIMEOUT/REAPER example.
  classification: 'timeout-reaper',
  tick: async () => {
    const { isHiveRekeyEnabled, reconcileOwnedHiveEpochKeys } = await import(
      '../sync/hyperbee/hive-epoch-boundary-wiring'
    );
    const enabled = await isHiveRekeyEnabled();
    if (!enabled) return; // re-key dark ⇒ no epoch-key distribution to reconcile
    await reconcileOwnedHiveEpochKeys({ enabled });
  },
};

// Every 5min: FEDERATED presence reaper (cross-machine-coord-parity-and-trust
// P-057 / M8, audit D-013). shared_presence / shared_session_presence are
// gossip-published liveness beats with NO retention — a crashed device's rows are
// immortal, and a member can rotate the sender-controlled machine_label / owner_id
// to leak fresh rows forever (the writer's full-set-replace prune covers only a
// device's CURRENT label set). This tick drops rows past the TTL (well beyond every
// reader's 40m staleness window) and caps rows per signing device. PURELY LOCAL: no
// capture trigger on these tables, so the DELETEs never federate. Cheap (small,
// bounded tables) so NOT shed — the security bound should hold under load too.
const sharedPresenceReaperCheck: PeriodicCheck = {
  name: 'shared-presence-reaper',
  intervalMs: 300_000,
  shed: false,
  // D-004 names "presence reaper" as its own canonical TIMEOUT/REAPER example.
  classification: 'timeout-reaper',
  tick: async () => {
    const { reapStaleSharedPresence } = await import('../sync/hyperbee/shared-presence-reaper');
    const r = await reapStaleSharedPresence();
    const total = r.presenceTtlReaped + r.sessionTtlReaped + r.presenceCapReaped + r.sessionCapReaped;
    if (total > 0) {
      console.warn(
        `[shared-presence-reaper] reaped ${total} federated presence row(s) — ` +
          `TTL: presence=${r.presenceTtlReaped} session=${r.sessionTtlReaped}; ` +
          `per-device cap: presence=${r.presenceCapReaped} session=${r.sessionCapReaped}`,
      );
    }
  },
};

// Every 10min: rubric-emission floor pulse (WI-2374 adoption step 1) + the
// cadence-miss ESCALATION (WI-3777). The FLOOR files the deterministic
// pot-coordination-health floor when NO scorecard (agent or floor) landed in the last
// hour — the data layer no longer dies with a stopped/dead overwatch (the turn-end
// backstop only fires when an overwatch turn ENDS). The ESCALATION adds the teeth a
// floor lacks: a loop that is enabled+started but silently STOPS emitting complete
// cards (a wedge, as on 2026-07-10 08:32Z) is raised as ONE debounced owner advisory,
// while a benign stopped/paused supervisor stays floor-only. Both run on THIS
// in-process seam, independent of the routinesTick pool-shed path that froze the loop.
// Zero LLM tokens. The two legs are gated on DIFFERENT flags and that is deliberate
// (D-015): the PULSE gates on its own `papercusp-scorecard-emission-pulse` so the
// deterministic floor survives a stopped/dead/RETIRED supervisor, while the WEDGE check
// keeps gating on `papercusp-overwatch` because an alive-but-not-emitting loop cannot
// exist once the loop is gone. A live overwatch makes
// both a cheap freshness read + no-op. HEAVY when the floor fires (computeSystemHealth)
// → sheds under saturation; a shed cycle just delays the floor/check 10min.
const scorecardEmissionPulseCheck: PeriodicCheck = {
  name: 'scorecard-emission-pulse',
  intervalMs: 600_000,
  shed: true,
  // D-004 (P-011): both legs are absence/silence-past-threshold detectors — same
  // class as the spawn/claim/federation-drain sweeps above.
  classification: 'timeout-reaper',
  tick: async () => {
    const { readRegistry } = await import('../workspace-registry');
    const { runScorecardEmissionPulse, checkOverwatchEmissionWedge } = await import(
      '../scorecard-emission-pulse'
    );
    for (const ws of readRegistry().workspaces.map((w) => w.id)) {
      const r = await runScorecardEmissionPulse({ workspaceId: ws });
      if (r.outcome === 'filed') {
        console.warn(`[scorecard-emission-pulse] ${ws}: ${r.reason}`);
      }
      // WI-3777: escalate a loop-alive-but-not-emitting WEDGE (a floor is not an alarm).
      const w = await checkOverwatchEmissionWedge({ workspaceId: ws });
      if (w.outcome === 'escalated') {
        console.warn(`[scorecard-emission-pulse] ${ws}: WEDGE — ${w.reason}`);
      }
    }
  },
};

// Every 1h: poll-suspect scan (EI-7428 — the ANNOUNCE half of the EI-7029 read-time
// detector). flagPollSuspects only fires when someone happens to call dev:telemetry;
// this proactively runs the same detector cross-workspace and toasts (notifications:recent
// + the /dev Telemetry tab banner) any NEW poll-shaped tool (dedup: 24h per tool_name, see
// poll-suspect-alarm.ts). LIGHT (one rollup query over a 3h window) → not shed.
const pollSuspectScanCheck: PeriodicCheck = {
  name: 'poll-suspect-scan',
  intervalMs: 3600_000,
  // D-004/lane-C1 (P-011): a trailing-window rate aggregate over an append-only table,
  // not a reaction to one row's change — MUST-SAMPLE (borderline, same class as #10).
  classification: 'must-sample',
  tick: async () => {
    const { runPollSuspectScanOnce } = await import('../poll-suspect-alarm');
    const { alerted } = await runPollSuspectScanOnce();
    if (alerted.length > 0) {
      console.warn(
        `[poll-suspect-scan] alerted ${alerted.length} new poll-shaped tool(s): ` +
          alerted.map((s) => `${s.tool_name} (${s.calls_per_hour}/hr, ${s.callers} caller(s))`).join(', '),
      );
    }
  },
};

// Every 10min: timer-REGISTRATION scan (P-010 — stop-discarded-dedup-and-audit-
// server-polling-2026-07-26). The sibling of pollSuspectScanCheck above, but for
// server-side timers instead of agent tool calls: alerts (via the same toast sink)
// on any `managedSetInterval`/in-process/external-process timer NAME never seen in
// a prior scan — a proxy for "never classified per D-004" until P-011 lands a hard
// declared-classification requirement at registration. fireOnArm so a fresh install
// seeds its known-set immediately rather than waiting 10min (mirrors
// hiveEpochKeyReconcileCheck's fireOnArm rationale). LIGHT (one schedule-inventory
// read + a Set diff) → not shed.
const timerRegistrationScanCheck: PeriodicCheck = {
  name: 'timer-registration-scan',
  intervalMs: 600_000,
  fireOnArm: true,
  // Same shape as poll-suspect-scan above: a diff against a known-set snapshot, not a
  // reaction to a single change event — MUST-SAMPLE. (This check IS part of P-011's own
  // enforcement story — see the file comment above it — but the check itself still needs
  // its own D-004 classification like every other entry in this array.)
  classification: 'must-sample',
  tick: async () => {
    const { runTimerRegistrationScanOnce } = await import('../poll-suspect-alarm');
    const { alerted, seeded } = await runTimerRegistrationScanOnce();
    if (seeded) {
      console.log(`[timer-registration-scan] seeded the known-timer set (first run)`);
    } else if (alerted.length > 0) {
      console.warn(
        `[timer-registration-scan] ${alerted.length} new unclassified timer(s): ` +
          alerted.map((t) => `${t.name} (${t.source})`).join(', '),
      );
    }
  },
};

/** The converted ex-DBOS-workflow set. */
export function buildDefaultChecks(): PeriodicCheck[] {
  return [
    systemHealthCheck,
    harnessStatusSweepCheck,
    connectionPressureCheck,
    pgTuningDriftCheck,
    kernelLeakCheck,
    serviceHealthCheck,
    completionRefVerifyCheck,
    spawnReclaimSweepCheck,
    staleClaimSweepCheck,
    releaseRequestSweepCheck,
    learningInfraHealthCheck,
    steeringChurnSweepCheck,
    federationDrainReconcileCheck,
    hiveEpochKeyReconcileCheck,
    sharedPresenceReaperCheck,
    scorecardEmissionPulseCheck,
    pollSuspectScanCheck,
    timerRegistrationScanCheck,
  ];
}

// ── The scheduler (idempotent, unref'd, never keeps the process alive) ────────

interface ArmedCheck {
  name: string;
  handle: ManagedHandle;
}

let armed: ArmedCheck[] | null = null;
/**
 * The checks this process is ELIGIBLE to run (post cluster-scope filter), retained across the
 * process lifetime so the arm-state reconciler can re-start one it previously stopped. Without
 * this, a disarm would be one-way until the next host boot — a switch you can only turn off is
 * not a switch (EI-19294826146331487).
 */
let eligibleChecks: PeriodicCheck[] | null = null;
let armDeps: RunCheckDeps | undefined;

/** Arm ONE check on the shared registry. The single place the registration options are built. */
function armOneCheck(check: PeriodicCheck): ArmedCheck {
  return {
    name: check.name,
    // Return the tick's PROMISE to the registry — `() => void runPeriodicCheck(...)` discarded it, which
    // made every tick look SYNCHRONOUS to managedSetInterval, so its re-entrancy guard released before the
    // async tick finished and a slow tick could fire concurrently (the re-entrancy-guard test caught this;
    // gate-red 2026-07-01). runPeriodicCheck never rejects (it catches internally).
    handle: managedSetInterval(check.name, check.intervalMs, () => runPeriodicCheck(check, armDeps).then(() => undefined), {
      category: 'global-sweep',
      shed: check.shed,
      fireOnArm: check.fireOnArm,
      classification: check.classification,
    }),
  };
}

/**
 * Arm the in-process periodic checks. Idempotent (a second call is a no-op).
 * Call ONCE from host-bootstrap gated on `backgroundWorkers` — never per cluster
 * request worker.
 *
 * P-005 (schedule-inventory-and-ephemeral-tier-2026-06-26): each check now rides
 * `managedSetInterval` from @papercusp/scheduled-registry — the ONE in-process
 * scheduling mechanism (D-006), shared with the ephemeral blueprint cadence tier.
 * The registry supplies the unref'd timer, the per-check re-entrancy guard (a slow
 * tick never piles up a second concurrent run — parity with DBOS's workflow-id
 * dedup), the fireOnArm heal-on-startup setTimeout(0), AND per-check
 * armed/last-fire/last-error tracking so every sweep is VISIBLE in schedule:inventory
 * (category 'global-sweep'). The tick body is still `runPeriodicCheck`, so the
 * shed-gate (shouldShedHeavyTick) + never-throw behavior is byte-identical; the
 * registry's own shed-gate stays disabled (default shouldShed = false) to avoid
 * double-shedding — the `shed` flag is carried only so the inventory can show which
 * checks are shed-eligible.
 */
export function armInProcessPeriodicChecks(
  opts: { checks?: PeriodicCheck[]; deps?: RunCheckDeps; isPrimary?: boolean } = {},
): { stop: () => void } {
  if (armed) return { stop: disarmInProcessPeriodicChecks };
  const all = opts.checks ?? buildDefaultChecks();
  // P-018: in a node cluster, only the PRIMARY runs the host-scoped sweeps — see
  // PeriodicCheck.scope for why `backgroundWorkersEnabled()` never actually provided this.
  // `isPrimary` is injectable so the test can exercise the worker branch without forking.
  const isPrimary = opts.isPrimary ?? nodeCluster.isPrimary;
  const checks = all.filter((c) => checkRunsInThisProcess(c, isPrimary));
  const skipped = all.length - checks.length;
  // EI-19294826146331487: arm EVERYTHING first, unconditionally and with no database read on the
  // boot path, exactly as before. The durable arm state is applied afterwards by the reconciler
  // (`applyInProcessSweepArmState`), so a slow or wedged database can never delay host boot, and
  // the worst case is one reconcile interval of an already-running sweep.
  eligibleChecks = checks;
  armDeps = opts.deps;
  armed = checks.map(armOneCheck);
  console.log(
    `[in-process-periodic] armed ${checks.length} in-process check(s)` +
      `${isPrimary ? '' : ` (cluster WORKER — ${skipped} host-scoped check(s) left to the primary, P-018)`}` +
      `: ${checks.map((c) => c.name).join(', ')}`,
  );
  return { stop: disarmInProcessPeriodicChecks };
}

/** Disarm all in-process checks (tests; graceful shutdown). Deregisters them from the inventory. */
export function disarmInProcessPeriodicChecks(): void {
  if (!armed) return;
  for (const a of armed) a.handle.stop();
  armed = null;
  eligibleChecks = null;
  armDeps = undefined;
}

/** Whether the in-process checks are currently armed (tests). */
export function inProcessPeriodicChecksArmed(): boolean {
  return armed !== null;
}

/**
 * The checks this process is eligible to run, with their cadence — the arm-state layer's view of
 * the declared population (EI-19294826146331487). Empty until the suite has been armed once,
 * because eligibility depends on the cluster-scope filter applied at arm time.
 */
export function inProcessPeriodicEligibleChecks(): Array<{ name: string; intervalMs: number }> {
  return (eligibleChecks ?? []).map((c) => ({ name: c.name, intervalMs: c.intervalMs }));
}

/** The check names armed in THIS process right now. */
export function inProcessPeriodicArmedNames(): string[] {
  return armed ? armed.map((a) => a.name) : [];
}

/**
 * Apply a reconcile plan from the durable arm state: stop the sweeps an operator turned off,
 * re-start the ones they turned back on. Returns what it ACTUALLY changed, which is not
 * necessarily what was asked — a name that is not eligible in this process, or that is already
 * in the requested state, is silently skipped rather than trusted.
 *
 * A no-op (and an empty result) whenever the suite is not armed here: a process that never armed
 * the sweeps has nothing to reconcile, and starting one from a reconcile would arm a sweep on a
 * host that the boot gate deliberately excluded.
 */
export function applyInProcessSweepArmState(plan: {
  toStop: readonly string[];
  toStart: readonly string[];
}): { toStop: string[]; toStart: string[] } {
  const stopped: string[] = [];
  const started: string[] = [];
  if (!armed || !eligibleChecks) return { toStop: stopped, toStart: started };
  for (const name of plan.toStop) {
    const idx = armed.findIndex((a) => a.name === name);
    if (idx < 0) continue;
    armed[idx]!.handle.stop();
    armed.splice(idx, 1);
    stopped.push(name);
  }
  for (const name of plan.toStart) {
    if (armed.some((a) => a.name === name)) continue;
    const check = eligibleChecks.find((c) => c.name === name);
    if (!check) continue;
    armed.push(armOneCheck(check));
    started.push(name);
  }
  return { toStop: stopped, toStart: started };
}
