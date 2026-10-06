/**
 * outcome-refresh-sweep.ts — autonomous-loop-prod-audit-2026-07-02 P-006
 * (SPOF 5, deferred items a+b from the WI-4626/AUDIT B follow-up comment):
 * decouple the Scout outcome-ledger refresh from Scout's own cadence, and
 * alert when routed ideas sit pending past a staleness threshold.
 *
 * THE GAP: {@link refreshScoutOutcomes} (routed-ledger.ts) previously ran
 * ONLY inside a Scout CYCLE (scout/scheduler.ts's `refreshOutcomes()` — called
 * once per successful cycle). An idle, backed-off (fire-gate circuit breaker),
 * or dead Scout therefore freezes EVERY routed idea's cached `outcome` at
 * whatever it was during the last cycle: the plan-rail / gym-rail / wi-rail
 * outcome ledger reads as stuck even when the underlying rail artifacts have
 * since resolved, and the per-lens weight learning (P-033) silently stops
 * updating. This mirrors the exact class of bug the signal-accumulator sweep
 * (blender-self-learning-2026-07-12 P-001) already fixed for cadence
 * counting — the fix here is the same shape: a routines-tick sweep
 * independent of the thing it used to be coupled to.
 *
 * (a) DECOUPLE: this sweep runs on its own in-process-throttled cadence
 *     (default 15min), wholly independent of whether Scout is cycling.
 * (b) FRONTIER: the canonical ungraded census is the priority phase. The sweep
 *     reserves a small verification slice even while that frontier is active,
 *     selected by value/age/id and resumed from a durable operator-settings
 *     checkpoint. New grading work keeps priority without starving outcomes.
 *     The existing routed ledger, authoritative Change-Feed joins, and lens
 *     weights remain the only outcome substrate — no parallel queue/store.
 * (c) ESCALATE: after a verification step, count routed ideas whose outcome is STILL
 *     NULL/'pending' with a stale (or absent) `outcome_checked_at` — a refresh
 *     running does not itself guarantee an idea resolves (e.g. an abandoned
 *     draft that never reached ANY rail terminal). When that count is > 0 and
 *     more than the threshold window has passed since the last such alert
 *     (the shared `hive_watchdog_fires` debounce ledger — mirrors
 *     rubric-staleness-watchdog.ts), open ONE escalation naming the count so a
 *     human/Mug investigates instead of the ledger quietly aging forever
 *     (the "12-day-dead-and-nobody-noticed" failure class this whole audit
 *     plan exists to close).
 *
 * Same watchdog-family chassis as signal-accumulator.ts (per-registered-Blender-scope
 * sweep, in-process throttle, workspace-wide corpus) and
 * rubric-staleness-watchdog.ts (fires-ledger debounce + escalation):
 * fail-soft throughout (a sweep must never fail the routines tick it rides),
 * env-tunable kill switches, injectable deps for DB-free unit tests.
 */
import {
  listBlenderMaintenanceScopes,
  listBlenderMaintenanceWorkspaceIds,
} from '../pot/started';
import { getOrgPg } from '@papercusp/db-org';
import {
  refreshScoutOutcomes,
  countStalePendingIdeas,
  readPendingOutcomeCandidates,
  type RefreshedIdeaOutcomeEvidence,
} from './routed-ledger';
import { readUngradedBreakdown, DEFAULT_UNGRADED_EPOCH_POLICY } from './ungraded-scope';
import {
  decodePortfolioFrontierCheckpoint,
  finishPortfolioFrontierStep,
  planPortfolioFrontierStep,
  type PortfolioFrontierCheckpoint,
} from './portfolio-frontier';
import { recentWatchdogFires, recordFire } from '../pot/watchdog';
import { openEscalation } from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';

// ── tunables (env-overridable, watchdog-family idiom) ─────────────────────────

/** In-process throttle between outcome-refresh sweeps — the routinesTick
 *  fires every ~30s; refreshing every tick buys nothing (a Change-Feed join
 *  + a batched UPDATE per workspace) and is needless PG load. Default 900s
 *  (15min — comfortably below Scout's own hourly cadence floor, so a
 *  cadence-starved Scout is never more than 15min stale). Env
 *  PAPERCUSP_SCOUT_OUTCOME_REFRESH_SEC; `<=0` DISABLES the sweep entirely
 *  (kill switch). */
export function scoutOutcomeRefreshIntervalSec(): number {
  const n = Number(process.env.PAPERCUSP_SCOUT_OUTCOME_REFRESH_SEC ?? 900);
  return Number.isFinite(n) ? n : 900;
}

/** How long a routed idea may sit outcome NULL/'pending' before the
 *  stale-pending alert fires. Default 24h — long enough that a normal
 *  in-flight idea (its rail artifact genuinely not yet terminal) never
 *  trips it, short enough to catch a truly-stuck one well before the
 *  12-day dead-cycle class this audit found. Env
 *  PAPERCUSP_SCOUT_OUTCOME_STALE_PENDING_SEC; `<=0` disables ONLY the
 *  stale-pending alert (the refresh half of the sweep still runs). */
export function scoutOutcomeStalePendingThresholdSec(): number {
  const n = Number(process.env.PAPERCUSP_SCOUT_OUTCOME_STALE_PENDING_SEC ?? 86_400);
  return Number.isFinite(n) ? n : 86_400;
}

/** Max routed ideas whose authoritative fate one drained wake may verify. */
export function scoutPortfolioFrontierItemBudget(): number {
  const n = Number(process.env.PAPERCUSP_SCOUT_PORTFOLIO_FRONTIER_ITEMS ?? 25);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 25;
}

/** Observable wall-clock budget for one outcome-verification batch. */
export function scoutPortfolioFrontierTimeBudgetMs(): number {
  const n = Number(process.env.PAPERCUSP_SCOUT_PORTFOLIO_FRONTIER_MS ?? 5_000);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 5_000;
}

export const SCOUT_PORTFOLIO_FRONTIER_CANDIDATE_CAP = 5_000;

/** Existing workspace-scoped KV store; no parallel portfolio/checkpoint table. */
export function portfolioFrontierCheckpointKey(workspaceId: string): string {
  return `scout_portfolio_frontier:${workspaceId}`;
}

export async function readPortfolioFrontierCheckpoint(
  workspaceId: string,
): Promise<PortfolioFrontierCheckpoint | null> {
  const { sql } = getOrgPg();
  const rows = await sql<Array<{ value: string | null }>>`
    SELECT value FROM harness_shared.operator_settings
     WHERE key = ${portfolioFrontierCheckpointKey(workspaceId)}
     LIMIT 1`;
  const raw = rows[0]?.value;
  if (!raw) return null;
  try {
    return decodePortfolioFrontierCheckpoint(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function writePortfolioFrontierCheckpoint(
  workspaceId: string,
  checkpoint: PortfolioFrontierCheckpoint,
): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.operator_settings
      (key, value, description, updated_at, workspace_id)
    VALUES
      (${portfolioFrontierCheckpointKey(workspaceId)}, ${JSON.stringify(checkpoint)},
       'Bounded Scout/Blender portfolio-frontier checkpoint', ${Date.now()}, ${workspaceId})
    ON CONFLICT (key) DO UPDATE SET
      value = EXCLUDED.value,
      description = EXCLUDED.description,
      updated_at = EXCLUDED.updated_at,
      workspace_id = EXCLUDED.workspace_id`;
}

export async function readPortfolioGradingBacklog(workspaceId: string): Promise<number> {
  const { sql } = getOrgPg();
  const breakdown = await readUngradedBreakdown(sql, {
    workspaceId,
    policy: DEFAULT_UNGRADED_EPOCH_POLICY,
  });
  return breakdown.actionable;
}

// ── pure decider (unit-tested with no DB) ──────────────────────────────────────

/** PURE: should the sweep run this tick? (in-process throttle, mirrors
 *  signal-accumulator's shouldSweepNow). `sweepSec <= 0` never runs (the kill
 *  switch — checked by the caller before this, but defensive here too). */
export function shouldRefreshNow(lastSweepAtMs: number | null, nowMs: number, sweepSec: number): boolean {
  if (sweepSec <= 0) return false;
  if (lastSweepAtMs == null) return true;
  return nowMs - lastSweepAtMs >= sweepSec * 1_000;
}

// ── the sweep ─────────────────────────────────────────────────────────────────

export interface OutcomeRefreshSweepResult {
  workspaceId: string;
  installSlug: string;
  outcome: 'refreshed' | 'error';
  /** Coverage of the registry-backed Blender population evaluated by this tick. */
  evaluatedWorkspaceCount: number;
  evaluatedScopeCount: number;
  eligibleBacklogCount: number;
  stalePendingCount: number;
  alerted: boolean;
  /** Persisted DBOS/operator-settings cold-resume state for this workspace. */
  frontier: PortfolioFrontierCheckpoint | null;
  reason: string;
}

let lastSweepAtMs: number | null = null;

/** Test seam: reset the in-process throttle. */
export function __resetOutcomeRefreshThrottleForTests(): void {
  lastSweepAtMs = null;
}

/** Synthetic identity for the background stale-pending escalation (mirrors
 *  the rubric-staleness watchdog's identity). */
const SCOUT_OUTCOME_STALE_IDENTITY: AgentIdentity = {
  ownerId: 'scout-outcome-refresh-sweep',
  ownerLabel: 'system · scout-outcome-refresh-sweep',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** Injectable seams so the sweep's orchestration is testable without PG. */
export interface OutcomeRefreshSweepDeps {
  listBlenderMaintenanceScopes?: typeof listBlenderMaintenanceScopes;
  listBlenderMaintenanceWorkspaceIds?: typeof listBlenderMaintenanceWorkspaceIds;
  refreshScoutOutcomes?: typeof refreshScoutOutcomes;
  countStalePendingIdeas?: typeof countStalePendingIdeas;
  readPendingOutcomeCandidates?: typeof readPendingOutcomeCandidates;
  readPortfolioGradingBacklog?: typeof readPortfolioGradingBacklog;
  readPortfolioFrontierCheckpoint?: typeof readPortfolioFrontierCheckpoint;
  writePortfolioFrontierCheckpoint?: typeof writePortfolioFrontierCheckpoint;
  recentWatchdogFires?: typeof recentWatchdogFires;
  recordFire?: typeof recordFire;
  openEscalation?: typeof openEscalation;
  /** Monotonic-enough wall clock for cooperative batch deadline enforcement. */
  clock?: () => number;
  now?: number;
}

/**
 * The decoupled, phase-aware outcome-refresh sweep. For each registered Blender
 * scope's WORKSPACE (de-duped — the corpus is workspace-wide, EI-10520): keep
 * grading work primary while reserving a bounded pending-outcome batch,
 * persist its checkpoint, then count+alert on stale-pending ideas. Never throws
 * — a sweep that crashes its host routine tick guards nothing. Kill switch:
 * PAPERCUSP_SCOUT_OUTCOME_REFRESH_SEC <= 0.
 */
export async function scoutOutcomeRefreshSweep(
  deps: OutcomeRefreshSweepDeps = {},
): Promise<OutcomeRefreshSweepResult[]> {
  const results: OutcomeRefreshSweepResult[] = [];
  const intervalSec = scoutOutcomeRefreshIntervalSec();
  if (intervalSec <= 0) return results; // kill switch
  const now = deps.now ?? Date.now();
  if (!shouldRefreshNow(lastSweepAtMs, now, intervalSec)) return results;
  lastSweepAtMs = now;

  const thresholdSec = scoutOutcomeStalePendingThresholdSec();

  try {
    const scopes = await (deps.listBlenderMaintenanceScopes ?? listBlenderMaintenanceScopes)();
    if (scopes.length === 0) {
      // A retired started-bit population can be empty while the retained
      // Blender ledger still has stale work. Probe workspace-wide pending rows
      // so an empty scope list is an alert only when it hides eligible work.
      let stalePendingCount = 0;
      if (thresholdSec > 0) {
        const workspaceIds =
          typeof (deps.listBlenderMaintenanceWorkspaceIds ?? listBlenderMaintenanceWorkspaceIds) === 'function'
            ? (deps.listBlenderMaintenanceWorkspaceIds ?? listBlenderMaintenanceWorkspaceIds)()
            : [];
        for (const workspaceId of workspaceIds) {
          stalePendingCount += await (deps.countStalePendingIdeas ?? countStalePendingIdeas)({
            workspaceId,
            staleBeforeMs: now - thresholdSec * 1_000,
          });
        }
      }
      if (stalePendingCount > 0) {
        const reason =
          `${stalePendingCount} eligible stale-pending routed idea(s) found, but no registered ` +
          'Blender scopes were evaluated';
        console.warn(`[scout-outcome-refresh] ALERT: ${reason}`);
        return [
          {
            workspaceId: '*',
            installSlug: '*',
            outcome: 'error',
            evaluatedWorkspaceCount: 0,
            evaluatedScopeCount: 0,
            eligibleBacklogCount: stalePendingCount,
            stalePendingCount,
            alerted: false,
            frontier: null,
            reason,
          },
        ];
      }
      return results;
    }
    const evaluatedWorkspaceCount = new Set(scopes.map(({ workspaceId }) => workspaceId)).size;
    const evaluatedScopeCount = scopes.length;
    const seenWorkspaces = new Set<string>();
    for (const { workspaceId, installSlug } of scopes) {
      if (seenWorkspaces.has(workspaceId)) continue;
      seenWorkspaces.add(workspaceId);
      try {
        const clock = deps.clock ?? Date.now;
        const startedAt = clock();
        const refresh = deps.refreshScoutOutcomes ?? refreshScoutOutcomes;
        const previous = await (
          deps.readPortfolioFrontierCheckpoint ?? readPortfolioFrontierCheckpoint
        )(workspaceId);
        const gradingBacklog = await (
          deps.readPortfolioGradingBacklog ?? readPortfolioGradingBacklog
        )(workspaceId);
        const pending = await (
          deps.readPendingOutcomeCandidates ?? readPendingOutcomeCandidates
        )({ workspaceId, limit: SCOUT_PORTFOLIO_FRONTIER_CANDIDATE_CAP });
        const itemBudget = scoutPortfolioFrontierItemBudget();
        const timeBudgetMs = scoutPortfolioFrontierTimeBudgetMs();
        // WI-10005247: rows never verified, or not verified within the same
        // window the stale-pending alert uses, jump the cursor so a new or
        // su-ideate route is not parked behind a ~5-day round-robin lap. A
        // disabled alert (`thresholdSec <= 0`) still gets the default window.
        const staleBeforeMs = now - (thresholdSec > 0 ? thresholdSec : 86_400) * 1_000;
        let planned = planPortfolioFrontierStep({
          gradingBacklog,
          pending,
          previous,
          itemBudget,
          timeBudgetMs,
          nowMs: now,
          staleBeforeMs,
        });

        // Re-read at the write boundary. A route can become grade-eligible
        // after the initial census but before the bounded batch starts; that
        // transition must narrow this very step to the reserved verification
        // slice, not wait for the next 15m cadence. The prior outcome cursor is
        // preserved by replanning from `previous` rather than the speculative
        // outcome checkpoint above.
        if (planned.selected.length > 0) {
          const latestGradingBacklog = await (
            deps.readPortfolioGradingBacklog ?? readPortfolioGradingBacklog
          )(workspaceId);
          if (latestGradingBacklog > 0) {
            planned = planPortfolioFrontierStep({
              gradingBacklog: latestGradingBacklog,
              pending,
              previous,
              itemBudget,
              timeBudgetMs,
              nowMs: now,
              staleBeforeMs,
            });
          }
        }

        const evidence: RefreshedIdeaOutcomeEvidence[] = [];
        if (planned.selected.length > 0) {
          // EI-20200291159802681: Scout and su-ideate are disjoint learning
          // partitions. Refresh one selected candidate at a time so the wall-clock
          // budget is an enforcement boundary, not checkpoint-only telemetry: once
          // an atomic authoritative refresh returns at/after the deadline, do not
          // start another. A single in-flight refresh may cross the deadline, but
          // no later candidate is launched. Rebase the cursor below to the last
          // candidate actually processed so a cold resume cannot skip deferred work.
          const selected = planned.selected;
          const processed = [] as typeof selected;
          for (const candidate of selected) {
            if (clock() - startedAt >= timeBudgetMs) break;
            const report = await refresh({
              workspaceId,
              harnessSlug: installSlug,
              ...(candidate.origin === 'su-ideate' ? { origin: 'su-ideate' as const } : {}),
              ideaIds: [candidate.ideaId],
            });
            processed.push(candidate);
            evidence.push(...(report.refreshed ?? []));
          }
          if (processed.length !== selected.length) {
            // Staleness-tier rows lead `selected` and never move the cursor;
            // rebase it only to the last ROUND-ROBIN row actually processed.
            const lastProcessed = processed.slice(planned.priorityCount).at(-1);
            planned = {
              selected: processed,
              priorityCount: Math.min(planned.priorityCount, processed.length),
              checkpoint: {
                ...planned.checkpoint,
                cursorIdeaId: lastProcessed?.ideaId ?? previous?.cursorIdeaId ?? null,
                cursorGrade: lastProcessed?.humanGrade ?? previous?.cursorGrade ?? null,
                cursorRoutedAtMs: lastProcessed?.routedAtMs ?? previous?.cursorRoutedAtMs ?? null,
                currentIdeaId: processed[0]?.ideaId ?? null,
                consumedItems: processed.length,
                evidenceSource:
                  processed.length === 0
                    ? (previous?.evidenceSource ?? null)
                    : planned.checkpoint.evidenceSource,
              },
            };
          }
        }

        const lastEvidence = evidence.at(-1);
        const frontier = finishPortfolioFrontierStep(planned.checkpoint, {
          elapsedMs: Math.max(0, clock() - startedAt),
          evidenceSource: lastEvidence
            ? {
                kind: lastEvidence.sourceKind,
                ref: lastEvidence.sourceRef ?? lastEvidence.routedRef,
              }
            : planned.checkpoint.evidenceSource,
          nowMs: clock(),
        });
        await (
          deps.writePortfolioFrontierCheckpoint ?? writePortfolioFrontierCheckpoint
        )(workspaceId, frontier);

        let stalePendingCount = 0;
        let alerted = false;
        if (thresholdSec > 0) {
          stalePendingCount = await (deps.countStalePendingIdeas ?? countStalePendingIdeas)({
            workspaceId,
            staleBeforeMs: now - thresholdSec * 1_000,
          });
          // Do not suppress this detector merely because grading is active.
          // The planner reserves an outcome slice under grading pressure, and
          // this alert is the independent guard for a stale cache if that
          // slice or the planner itself stops making progress.
          if (stalePendingCount > 0) {
            const windowHours = Math.max(1, Math.round(thresholdSec / 3_600));
            const firedRecently =
              (await (deps.recentWatchdogFires ?? recentWatchdogFires)(
                workspaceId,
                installSlug,
                windowHours,
                'scout-outcome-stale-pending',
              )) > 0;
            if (!firedRecently) {
              const phaseContext =
                frontier.gradingBacklog > 0
                  ? `while the grading frontier still has ${frontier.gradingBacklog} actionable item(s); ` +
                    'outcome verification is reserved under that pressure'
                  : 'after a bounded authoritative outcome-verification step';
              const reason =
                `${stalePendingCount} routed idea(s) in workspace '${workspaceId}' have sat ` +
                `outcome NULL/'pending' past the ${windowHours}h staleness threshold ${phaseContext} — ` +
                `their rail artifact likely never ` +
                `reaches a terminal (an abandoned/never-disposed draft), or the refresh itself is ` +
                `failing silently. Investigate via readRoutedIdeas / the ledger's outcome_checked_at.`;
              console.warn(`[scout-outcome-refresh] ALERT: ${reason}`);
              await (deps.recordFire ?? recordFire)({
                workspaceId,
                installSlug,
                source: 'scout-outcome-stale-pending',
                reason,
                wakeAt: null,
              });
              await (deps.openEscalation ?? openEscalation)(SCOUT_OUTCOME_STALE_IDENTITY, {
                severity: 'advisory',
                summary: `${stalePendingCount} Scout-routed idea(s) stuck pending past ${windowHours}h`,
                body: reason,
              });
              alerted = true;
            }
          }
        }
        results.push({
          workspaceId,
          installSlug,
          outcome: 'refreshed',
          evaluatedWorkspaceCount,
          evaluatedScopeCount,
          eligibleBacklogCount:
            frontier.gradingBacklog > 0 ? frontier.gradingBacklog : stalePendingCount,
          stalePendingCount,
          alerted,
          frontier,
          reason:
            frontier.gradingBacklog > 0 && frontier.phase === 'grading'
              ? `grading frontier has no available verification slice (${frontier.gradingBacklog} actionable)`
              : frontier.gradingBacklog > 0
                ? `${frontier.consumedItems} verified under grading pressure (${frontier.gradingBacklog} actionable); ` +
                  (stalePendingCount > 0
                    ? `${stalePendingCount} stale-pending${alerted ? ' (alerted)' : ' (debounced)'}`
                    : 'no stale-pending')
              : stalePendingCount > 0
                ? `${frontier.consumedItems} verified; ${stalePendingCount} stale-pending${alerted ? ' (alerted)' : ' (debounced)'}`
                : `${frontier.consumedItems} verified; no stale-pending`,
        });
      } catch (e) {
        results.push({
          workspaceId,
          installSlug,
          outcome: 'error',
          evaluatedWorkspaceCount,
          evaluatedScopeCount,
          eligibleBacklogCount: 0,
          stalePendingCount: 0,
          alerted: false,
          frontier: null,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }
  } catch (e) {
    console.warn(`[scout-outcome-refresh] sweep failed: ${e instanceof Error ? e.message : e}`);
  }
  return results;
}
