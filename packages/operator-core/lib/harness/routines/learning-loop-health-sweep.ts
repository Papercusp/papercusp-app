/**
 * learning-loop-health-sweep.ts — periodic ESCALATOR for the learning-loop
 * health classifier (blueprint/learning-loop-health.ts / learning-loop-read.ts).
 *
 * THE GAP THIS CLOSES (EI-19281872822982156, defect 2): `computeLearningLoopHealth`
 * has correctly classified an always-on singleton (scout/change-ledger/iq-battery)
 * paused via the Agents pane as `should-be-on-but-dark`, and a wedged active loop
 * as `stale`, since relight-self-learning-edges-2026-06-14 P-030 — but nothing
 * PERIODICALLY calls the classifier and acts on a bad verdict. It was PULL-only:
 * the `improvements:learning_loops` MCP tool and the Learning tab's Frontier grid
 * (`learning.frontier`), both requiring a human to think to look. Measured live:
 * `bp-singleton-scout-0` (the Scout blueprint singleton, cron, durable) sat
 * `active=false` via `metadata.pause = { reason: "Paused via the Agents pane",
 * pausedBy: "loopback" }` for ~5 days — a correct-but-unread `should-be-on-but-dark`
 * verdict sitting there the entire time, with no expiry / re-review prompt (the
 * DARK_FLAGS_REVIEW_BY pattern this ticket asked for an equivalent of).
 *
 * MECHANISM: the SAME watchdog-sweep house pattern `autoloop-chronic-failure.ts`
 * uses (WI-4632) — one improvements OBSERVATION per (workspace, loop) needing
 * attention, debounced 24h via the SAME `hive_watchdog_fires` ledger, under a
 * DISTINCT `source` tag ('learning-loop-health') so its debounce window can never
 * collide with the autoloop sweeps'. Fail-soft by contract.
 */
import { getOrgPg } from '@papercusp/db-org';
import { recentWatchdogFires, claimWatchdogFire } from '../../pot/watchdog';
import { activeWorkspaceId } from '../../workspace-registry';
import { readLearningLoopHealth } from '../../blueprint/learning-loop-read';
import type { LearningLoopHealth, LearningLoopStatus } from '../../blueprint/learning-loop-health';
import { isLikelyFreshInstallGap } from '../../startup/validate-home-harness';

export interface LearningLoopHealthEscalation {
  blueprintId: string;
  outcome: 'escalated' | 'debounced' | 'error';
  /** The classifier's verdict; 'collision' is reported here (a distinct field,
   *  `LearningLoopHealth.collision`) rather than as a member of LearningLoopStatus. */
  status: LearningLoopStatus | 'collision';
  reason: string;
}

export interface LearningLoopHealthCandidateEvidence extends LearningLoopHealth {
  /** Whether this exact classifier row was selected for the escalation pass. */
  selectedForEscalation: boolean;
}

export interface LearningLoopHealthSweepReport {
  schemaVersion: 'learning-loop-health-sweep/v1';
  /** The concrete partition read by this invocation; null only if scope resolution failed. */
  workspaceId: string | null;
  observedAtMs: number;
  processStartedAtMs: number;
  runStatus: 'completed' | 'deferred' | 'error';
  candidateCount: number;
  /** Classifier outputs plus the routine-row evidence used to produce each output. */
  candidates: LearningLoopHealthCandidateEvidence[];
  escalations: LearningLoopHealthEscalation[];
  error?: string;
}

/** PURE: which classified loops warrant an escalation. Mirrors
 *  `summarizeLearningLoopHealth`'s own `needsAttention` predicate exactly (kept
 *  as a separate exported selector, rather than only reading `needsAttention`
 *  off the summary, so this sweep's selection is directly unit-testable and
 *  cannot silently drift from the summary if one of the two is edited alone —
 *  a regression test below pins them equal). */
export function selectLearningLoopsNeedingEscalation(
  rows: readonly LearningLoopHealth[],
): LearningLoopHealth[] {
  return rows.filter(
    (r) =>
      // EI-19370236916382521: `pauseAcknowledged` means a human already re-affirmed this
      // exact pause via `routines:set { active:false, reviewBy }` — the "re-affirm it
      // explicitly rather than letting this alarm re-fire silently" remedy this sweep's own
      // `describeLoop` text asks for. Escalating it again anyway is exactly the silent daily
      // re-fire the ticket that added this sweep (EI-19281872822982156) was trying to stop.
      (r.status === 'should-be-on-but-dark' && !r.pauseAcknowledged) ||
      r.status === 'stale' ||
      (r.status === 'absent' && r.expectedMaterialized) ||
      r.collision,
  );
}

function describeLoop(r: LearningLoopHealth): string {
  if (r.collision) {
    return (
      `both a @singleton row AND a legacy row exist for '${r.blueprintId}' — the migration ` +
      `double-state (D-023). Retire the legacy row once the @singleton row is confirmed live.`
    );
  }
  switch (r.status) {
    case 'should-be-on-but-dark':
      return (
        `an ALWAYS-ON loop is inactive (paused, or never armed) with no expiry / re-review — ` +
        `an indefinite pause on this class of routine is how a system silently stops being a ` +
        `system (EI-19281872822982156). Resume it (routines:set { active:true }), or if the pause ` +
        `is deliberate, re-affirm it explicitly rather than letting this alarm re-fire silently.`
      );
    case 'stale': {
      const days = r.daysSinceFire ?? r.daysSinceActivity;
      return `active but has not fired${days != null ? ` in ${days}d` : ''} — a wedged loop, not a chosen pause. Investigate why it stopped advancing.`;
    }
    case 'absent':
      return `a routine row was expected but none was ever materialized — the seed/cutover never ran for this loop.`;
    default:
      return `needs attention (status: ${r.status}).`;
  }
}

export async function learningLoopHealthSweepWithEvidence(): Promise<LearningLoopHealthSweepReport> {
  const observedAtMs = Date.now();
  const processStartedAtMs = observedAtMs - process.uptime() * 1_000;
  let workspaceId: string | null = null;
  const escalations: LearningLoopHealthEscalation[] = [];
  let candidates: LearningLoopHealthCandidateEvidence[] = [];
  try {
    const { sql } = getOrgPg();
    workspaceId = activeWorkspaceId();
    // A pristine packaged desktop has no project to own learning-loop rows yet. The
    // asynchronous first-boot hive bootstrap may still be materializing that project when
    // this periodic sweep fires; treating every expected singleton as absent would create
    // improvement noise before onboarding can possibly complete. Keep the exception narrow
    // to the same desktop + empty-registry predicate used by startup validation, and resume
    // normal alarms as soon as provisioning registers a project.
    if (process.env.PAPERCUSP_DESKTOP === '1' && (await isLikelyFreshInstallGap(workspaceId))) {
      console.log(
        '[learning-loop-health-sweep] sweep deferred — fresh packaged install has no ' +
          'registered project yet; retry after first-boot hive provisioning',
      );
      return {
        schemaVersion: 'learning-loop-health-sweep/v1',
        workspaceId,
        observedAtMs,
        processStartedAtMs,
        runStatus: 'deferred',
        candidateCount: 0,
        candidates: [],
        escalations,
      };
    }
    // This sweep runs in the bg-host process; the pull-only health surfaces deliberately
    // omit process start so they continue to expose overdue routines without startup masking.
    const rows = await readLearningLoopHealth(sql, workspaceId, { processStartedAtMs });
    const needing = selectLearningLoopsNeedingEscalation(rows);
    const needingSet = new Set(needing);
    candidates = rows.map((row) => ({ ...row, selectedForEscalation: needingSet.has(row) }));
    for (const loop of needing) {
      const status: LearningLoopStatus | 'collision' = loop.collision ? 'collision' : loop.status;
      try {
        const source = 'learning-loop-health' as const;
        const installSlug = `learning-loop::${loop.blueprintId}`;
        const alreadyFired = (await recentWatchdogFires(workspaceId, installSlug, 24, source)) > 0;
        if (alreadyFired) {
          escalations.push({
            blueprintId: loop.blueprintId,
            outcome: 'debounced',
            status,
            reason: 'escalated within 24h',
          });
          continue;
        }
        const reason = `learning loop '${loop.blueprintId}': ${describeLoop(loop)}`;
        // Single-flight: atomically re-check + claim the debounce slot right before the
        // one-time escalation side effect (mirrors autoloop-chronic-failure.ts's EI-6777 fix).
        const claimedFire = await claimWatchdogFire({ workspaceId, installSlug, source, windowHours: 24, reason, wakeAt: null });
        if (!claimedFire) {
          escalations.push({
            blueprintId: loop.blueprintId,
            outcome: 'debounced',
            status,
            reason: 'escalated within 24h (raced)',
          });
          continue;
        }
        const { captureImprovement } = await import('../improvements/capture-core');
        await captureImprovement({
          title: `LEARNING LOOP needs attention: ${loop.blueprintId} (${status})`,
          kind: 'bug',
          severity: loop.alwaysOn ? 'major' : 'minor',
          body:
            `${reason}\n\nlastFiredAt=${loop.lastFiredAt ?? 'never'}, daysSinceFire=${loop.daysSinceFire ?? 'n/a'}, ` +
            `activitySource=${loop.activitySource ?? 'none'}` +
            (loop.activityDetail ? `, activityDetail: ${loop.activityDetail}` : '') +
            `. This classification (computeLearningLoopHealth) already ` +
            `existed — the gap was that nothing periodically ran it and acted on a bad verdict ` +
            `(EI-19281872822982156); \`improvements:learning_loops\` is the same read, pull-only until now.`,
          // Omit scope: a workspace-singleton concern, not tied to one harness — auto-homes to
          // the workspace platform Pot (capture-core.ts CaptureImprovementInput.scope doc).
          foundDuring: 'learning-loop-health sweep (routines tick)',
        });
        escalations.push({ blueprintId: loop.blueprintId, outcome: 'escalated', status, reason });
      } catch (e) {
        escalations.push({
          blueprintId: loop.blueprintId,
          outcome: 'error',
          status,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.warn(`[learning-loop-health-sweep] sweep failed: ${error}`);
    return {
      schemaVersion: 'learning-loop-health-sweep/v1',
      workspaceId,
      observedAtMs,
      processStartedAtMs,
      runStatus: 'error',
      candidateCount: 0,
      candidates: [],
      escalations,
      error,
    };
  }
  return {
    schemaVersion: 'learning-loop-health-sweep/v1',
    workspaceId,
    observedAtMs,
    processStartedAtMs,
    runStatus: 'completed',
    candidateCount: candidates.length,
    candidates,
    escalations,
  };
}

/** Backward-compatible escalation-only view for direct callers. */
export async function learningLoopHealthSweep(): Promise<LearningLoopHealthEscalation[]> {
  return (await learningLoopHealthSweepWithEvidence()).escalations;
}
