/**
 * system-health/compute — `computeSystemHealth`, the SINGLE aggregator
 * (system-health-tab-2026-06-15 P-002 / P-003, D-001).
 *
 * Reads the same operational sources the manual-overwatch loop hand-queried —
 * the Queen's wake liveness, the bees, the work-feed, tokens/gateway, plans,
 * escalations, autonomy, observations, improvements, infra, the SU fleet — and
 * folds them into ONE `SystemHealth` snapshot. The read-only Health tab renders
 * it; the overwatch brief (overwatch-role C-1) wraps it (D-001 — never two
 * health models that drift).
 *
 * FAIL-SOFT per panel (D-003 / the learning-infra-health stance): each collector
 * runs under `panelSafe`, so a flaky source greys ITS card (`unknown` + the
 * error) and never blanks the tab. `overall` is the worst non-`unknown` panel.
 *
 * Freshness mirrors learning-infra-health: a per-workspace module-singleton
 * cache, a `getSystemHealth` read surface that runs a live tick when stale (the
 * correctness floor — opening the tab always computes fresh), and the
 * in-process periodic `runSystemHealthTick` (dbos/in-process-periodic.ts) that
 * invalidates `health.snapshot` so an open tab stays SSE-live without writing a
 * DBOS workflow_status row.
 */
import { getOrgPg } from '@papercusp/db-org';
import { MODEL_CAPACITY_RE } from '@papercusp/papercusp-shared/agent';
import type { Sql } from 'postgres';
import type { ImprovementCandidate } from '../harness/improvements/policy';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gitSidecarEnabled, noteSidecarFallback, runGitViaSpawnerSidecar } from '../fleet/git-via-sidecar';
import { probeHttpReachable } from '../escalating-http-probe';
import { activeWorkspaceId, readRegistry } from '../workspace-registry';
import { ALWAYS_ON_SYSTEM_ROUTINE_NAMES, isReaffirmed } from '../harness/routines/bespoke-active-seeds-check';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import { notifySyncInvalidate } from '../sync-sse';
import { backgroundWorkersEnabled } from '../background-workers';
import { systemDistinctId } from '../flag-distinct-id';
import { readSharedSnapshot, writeSharedSnapshot } from '../derived-reads/shared-snapshot';
import type { RawGatewayStats } from '../inference-gateway/gateway-wedge';
import type { ClaudeAccount } from '../deployment/account-pool';
import type { ScorecardFreshnessStatus } from '../scorecard-freshness';
import { accountFull } from '../deployment/account-pool';
import { projectLiveEdgeThrottle } from '../deployment/account-pool-store';
import { dedupeInFlight } from '../dedupe-in-flight';
import type { LiveHealthReading, LiveHealthSignalKey, LiveHealthSnapshot } from '../resource-governor/live-health';
import type {
  SystemHealth,
  SystemHealthPanels,
  HealthPanel,
  HealthMetric,
  PanelKey,
  PanelStatus,
  QueenHealth,
  BeesHealth,
  WorkItemsHealth,
  WorkFeedHealth,
  DeadRoutineNameCoverage,
  TokensHealth,
  WatchdogHealth,
  DeployHealth,
  PlansHealth,
  EscalationsHealth,
  AutonomyHealth,
  ObservationsHealth,
  ImprovementsHealth,
  InfraHealth,
  SuFleetHealth,
  OverwatchPanelHealth,
  ScoutHealth,
  ToolEfficiencyHealth,
  ContextInjectionHealth,
  ContextInjectionClientRow,
  ContextInjectionPortRow,
  ToolEfficiencyRating,
  LoopsHealth,
  CoordinationHealth,
  MemoryPanelHealth,
  HostPressureSample,
} from './types';
import { PANEL_LABELS } from './types';
import { getPanelRefreshCoalescer } from './refresh-coalescer';
// EI-19275994927087666: ONE classifier shared by the escalation broadcast and this
// panel — they told the same lie independently, so they must now agree by construction.
import { classifyGitSyncFailingLeg, gitSyncLegPhrase } from '../harness/git-sync/git-sync-escalation';
import { isOperationalEscalation } from '../attention/adapters';
import {
  queenStatus,
  beesStatus,
  workItemsStatus,
  workFeedStatus,
  tokensStatus,
  watchdogStatus,
  deployStatus,
  plansStatus,
  escalationsStatus,
  autonomyStatus,
  improvementsStatus,
  infraStatus,
  infraSummary,
  evaluateHostPressure,
  diskBandWithHysteresis,
  isReaperWedged,
  overwatchStatus,
  worstStatus,
  deriveQueenAlive,
  loopsStatus,
  coordinationStatus,
  memoryStatus,
  classifyInjectionClient,
  worstInjectionVerdict,
  contextInjectionStatus,
  reconcilePausedQueen,
  QUEEN_STALL_MS,
  WATCHDOG_FIRES_WARN,
  MCP_PROXY_HARD_FAIL_CRIT,
  MCP_PROXY_CRITICAL_CONTINUATION_WAIT_CRIT_MS,
  DISK_USED_CRIT_PCT,
  DISK_USED_WARN_PCT,
  ADMISSION_STARVATION_IDLE_ACCOUNTS_MIN,
} from './thresholds';

const WINDOW_MS = 60 * 60_000; // the dashboard's "this window" lookback (1h)
const DEAD_ROUTINE_OVERDUE_MS = 10 * 60_000;
/**
 * WI-10005073: a FAST routine (observed cadence `next_fire_at - last_fired_at` <= 60 s) is dead
 * after LEAST(base, GREATEST(base * 0.5, 10 * cadence)) instead of the flat base. With the
 * 10 min base that is 5 min for anything every 30 s or faster, 10 x cadence between 30 and
 * 60 s; the checkpoint-widened base (20 min) doubles it. Why: a bg-host main thread pinned
 * after boot left every 1 s routine silent ~14 min, and the flat 10 min (20 min during a
 * checkpoint) let most of that pass unreported. Why not tighter: a NORMAL bg-host restart
 * (drain + boot + first tick) silenced the 1 s fleet-headcount-governor ~3.7 min on
 * 2026-10-02 04:19-04:23Z, so a 3 min floor would page on every deploy. The cadence is
 * derived from the row itself (the engine sets next_fire_at = cron-next at each fire), so a
 * new fast routine is covered without a registry; a never-fired row keeps the base.
 */
export const FAST_ROUTINE_MAX_CADENCE_SEC = 60;
export const FAST_ROUTINE_CADENCE_MULTIPLE = 10;
export const FAST_ROUTINE_BASE_FRACTION = 0.5;
/** WI-4310: the WIDENED dead-routine overdue threshold used only while a green-checkpoint
 *  run's known, self-recovering resource footprint (GREEN_CHECKPOINT_MAX_FORKS forked vitest
 *  workers sharing this box's PG pool + CPU with routinesTick) is active or just finished —
 *  see {@link deadRoutineOverdueMsForCiWindow}'s doc comment for the incident this addresses.
 *  Env-tunable to match this codebase's threshold convention (pool-pressure.ts,
 *  tick-load-shed.ts). Default 20min = 2x the base 10min: individual tick durations under
 *  checkpoint load were observed at 5-45s (historically up to 93s) against a 30s cadence —
 *  nowhere near even the BASE threshold on their own, so 2x leaves ample margin before a
 *  genuine engine freeze (which would blow well past either threshold) goes undetected. */
const DEAD_ROUTINE_OVERDUE_WIDENED_MS = Math.max(
  DEAD_ROUTINE_OVERDUE_MS,
  Number(process.env.PAPERCUSP_DEAD_ROUTINE_OVERDUE_WIDENED_MS) || 20 * 60_000,
);
/** WI-4310: trailing grace after the most recent `green_checkpoint` pipeline_event — the
 *  observed alarm lag ("a not-green checkpoint run landed ~2min before an infra-liveness
 *  dead-routines fire") means the residual contention can still be draining for a couple
 *  minutes AFTER the suite itself exits (freed forks, GC, git ops). 5min covers that with
 *  headroom without leaving the widened threshold in effect for long once the run is done. */
const DEAD_ROUTINE_CI_GRACE_MS = Math.max(0, Number(process.env.PAPERCUSP_DEAD_ROUTINE_CI_GRACE_MS) || 5 * 60_000);
const PLAN_STALE_MS = 24 * 60 * 60_000;
// WI-5839 / EI-18654017982759582 items 2+3: a paused (active:false) routine is
// invisible to readDeadRoutines (active=true only), no matter how long it stays
// paused. Release/deploy-critical routines get a MUCH shorter threshold — a
// paused deploy pipeline is the symptom that actually matters (main can go
// green+ahead for days with zero deploys), and it is trivially checkable.
const STALE_PAUSE_GENERAL_MS = 24 * 60 * 60_000; // 24h
const STALE_PAUSE_CRITICAL_MS = 4 * 60 * 60_000; // 4h
// EI-18718973731535914: a routine inactive for WEEKS is DECOMMISSIONED, not "paused" —
// e.g. a retired routine (hive-wake) whose every row has sat active=false for 15-48 days
// is not an unattributed/unexplained pause anyone needs to re-affirm; it is dead code that
// will never resume. Reporting it under the same signal as a genuine recent stale pause
// trains everyone to skim past a `blocker`-severity alarm meant for "the deploy pipeline
// may be silently stopped" — the exact false-alarm-desensitizes-the-real-alarm failure mode.
// A week is comfortably past even the 24h GENERAL threshold, so this never masks a real,
// still-live stale pause — only routines nobody has touched in a long time.
const STALE_PAUSE_DECOMMISSIONED_MS = 7 * 24 * 60 * 60_000; // 7d
const RELEASE_CRITICAL_ROUTINE_NAMES = new Set(['release-trigger', 'green-checkpoint']);
/**
 * EI-20045691451471399 — routines whose STOPPAGE is fleet-blocking, used to pick which
 * overdue routines the engine-starvation alarm NAMES. Derived from
 * `RELEASE_CRITICAL_ROUTINE_NAMES` so the two can never drift apart, plus `git-sync`.
 *
 * git-sync is deliberately NOT in the release-critical PAUSE set (whose meaning is "a
 * paused deploy pipeline") but IS fleet-blocking when DEAD: it is the routine that commits
 * the shared working tree, so while it is stopped nothing any agent writes reaches a commit
 * — and the green gate then re-judges a candidate that structurally CANNOT contain anyone's
 * fix. Both filed incidents (EI-20045691451471399, EI-20063652008382478) turned on exactly
 * that, so a dead git-sync must never be the member the alarm omits.
 */
export const FLEET_BLOCKING_ROUTINE_NAMES: ReadonlySet<string> = new Set([
  ...RELEASE_CRITICAL_ROUTINE_NAMES,
  'git-sync',
]);
/** How many overdue routines the alarm NAMES. Bounds the exemplar list ONLY — never the count. */
const DEAD_ROUTINE_EXEMPLAR_LIMIT = 6;
/**
 * Census fetch cap, deliberately decoupled from {@link DEAD_ROUTINE_EXEMPLAR_LIMIT}: the
 * display list is short, but the population it is drawn from must not be. Only ~144 rows are
 * in scope on this box, so this is a pathology backstop, not a working limit — and even when
 * it DOES bind, the reported COUNT stays exact because it comes from `count(*) OVER ()`
 * (computed before LIMIT), never from the length of the fetched rows.
 */
const DEAD_ROUTINE_CENSUS_LIMIT = 500;
const ESCALATION_AGING_MS = 6 * 60 * 60_000;
const execFileP = promisify(execFile);

/** Minimal open-escalation shape this panel needs (a superset of EscalationRecord). */
export interface EscalationAgingInput {
  from?: string | null;
  options?: readonly unknown[];
  severity: string;
  ts: string;
}

/**
 * PURE: the human-attention escalations health from the OPEN set.
 *
 * EI-1490: OPERATIONAL escalations (system sender, no options — placement-watchdog
 * cursed-placement / aging sweeps) are auto-GC'd duplicates of the derived
 * `placements.cursed` health metric, NOT human decisions. They flooded the open
 * lane (~13k live), so the old "count every open escalation older than the
 * threshold" reported an impossible "13,246 escalations aging past the attention
 * threshold" — perma-warning this panel and churning overwatch's Queen nudge
 * (escalation-aging) every cycle. This panel measures HUMAN-attention escalations,
 * so the operational flood is excluded from EVERY count here, exactly as the
 * attention reader demotes operational escalations out of "waiting on you"
 * (queue-pending-accuracy D-005, shared classifier `isOperationalEscalation`).
 */
export function computeEscalationsHealth(
  open: readonly EscalationAgingInput[],
  now: number,
  agingMs: number = ESCALATION_AGING_MS,
): EscalationsHealth {
  const bySeverity: Record<string, number> = {};
  let oldest: number | null = null;
  let aging = 0;
  let agingNew = 0;
  let humanOpen = 0;
  for (const e of open) {
    // Skip the operational flood — it is surfaced by the placements.cursed metric
    // and auto-reconciled, never a human decision aging in the attention queue.
    if (isOperationalEscalation(e.from, (e.options?.length ?? 0) > 0)) continue;
    humanOpen += 1;
    bySeverity[e.severity] = (bySeverity[e.severity] ?? 0) + 1;
    const t = new Date(e.ts).getTime();
    if (Number.isFinite(t)) {
      if (oldest === null || t < oldest) oldest = t;
      if (now - t > agingMs) {
        aging += 1;
        // P-003 (health-tab-v2): NEW aging = crossed the threshold within the
        // last 24h. The panel status keys on THIS subset — standing aging is a
        // muted metric, not a fresh alarm every tick.
        if (now - t <= agingMs + 24 * 60 * 60_000) agingNew += 1;
      }
    }
  }
  return {
    open: humanOpen,
    oldestAgeMs: oldest === null ? null : now - oldest,
    bySeverity,
    aging,
    agingNew,
  };
}
const GATEWAY_DEFAULT_PORT = 8788;

function gatewayPort(): number {
  const p = Number(process.env.PAPERCUSP_GATEWAY_PORT);
  return Number.isFinite(p) && p > 0 ? p : GATEWAY_DEFAULT_PORT;
}

/** ANY HTTP answer (incl. a 503 pacing pause) = the gateway process is alive;
 *  only an unreachable-on-EVERY-attempt is a real outage. EI-1693/WI-266: a
 *  single 2500ms probe FALSE-NEGATIVES under box load (the gateway answers <1ms
 *  but the timer fires under contention), so retry with an escalating, load-aware
 *  timeout. Delegates to the shared escalating-http-probe — keeps this in
 *  lock-step with learning-infra-health's gateway probe (WI-266: it had drifted).
 *  Exported for the retry test. */
export async function probeGatewayHealthz(timeouts: readonly number[] = [2500, 6000]): Promise<boolean> {
  return (await probeHttpReachable(`http://127.0.0.1:${gatewayPort()}/healthz`, { timeouts })).reachable;
}

interface HealthCtx {
  ws: string;
  now: number;
  potSlug: string | null;
  started: boolean;
  /** Shared open-placement read (best-effort; null if it failed). */
  openPlacements: { recovering: number; cursed: number; stranded: number; workingTracked: number } | null;
  /** Shared gateway reachability (null = gateway not in the egress path / flag off). */
  gatewayEnabled: boolean;
  gatewayReachable: boolean | null;
  /** Shared overwatch liveness (B-09): the SAME value feeds the Overwatch panel
   *  (#15) AND `crossMonitor.overwatchAlive` (D-004) — computed once, no drift.
   *  null = not-in-play (flag off / not started) or uncomputable (never a false dark). */
  overwatchAlive: boolean | null;
  /**
   * The ONE open-improvements read per tick (P-008, db-performance-remediation-2026-07-26).
   *
   * `collectWorkFeed` (auto-eligible-stuck) and `collectImprovements` each need the same
   * `readImprovementItems({ state: 'open', limit: 1000 })`, and they run CONCURRENTLY in
   * the same `Promise.all` — so without this the tick issues that read TWICE. Measured
   * 2026-08-01 it is the single most expensive statement in the tick: ~160 ms/call at
   * ~997 rows/call, and the duplicate alone accounted for ~0.12 DB-cores continuously
   * fleet-wide. Memoised on the ctx (which is per-tick by construction), so one tick pays
   * exactly one read and a single-panel `refreshHealthPanel` — which builds its own ctx —
   * still pays exactly one.
   *
   * The PROMISE is memoised, not the value: the two collectors start concurrently, so a
   * value-memo would still let both fire before either resolved.
   */
  openImprovements: () => Promise<ImprovementCandidate[]>;
}

/** The open-improvements window both collectors read. One place, so the two panels can
 *  never drift into reading different slices of the corpus. */
const OPEN_IMPROVEMENTS_READ = { state: 'open', limit: 1000 } as const;

/**
 * Build the per-tick memo backing {@link HealthCtx.openImprovements}. Deliberately
 * memoises the promise INCLUDING a rejection: both callers issue the identical query in
 * the same tick, so a failure would hit both anyway, and each keeps its own fail-soft
 * handling (collectWorkFeed leaves 0s, collectImprovements degrades via panelSafe).
 *
 * `read` is injected for the unit test (compute.test.ts is deliberately DB-free); the
 * default resolves the real reader lazily, matching every other collector's dynamic import.
 */
export function makeOpenImprovementsReader(
  read: () => Promise<ImprovementCandidate[]> = async () => {
    const { readImprovementItems } = await import('../harness/improvements/read-items');
    return readImprovementItems({ ...OPEN_IMPROVEMENTS_READ });
  },
): () => Promise<ImprovementCandidate[]> {
  let inFlight: Promise<ImprovementCandidate[]> | undefined;
  return () => (inFlight ??= read());
}

/** Run a collector, degrading its own failure to an `unknown` (greyed) panel —
 *  never a fabricated outage. The whole-snapshot correctness floor (D-003).
 *  Exported for the fail-soft unit test. */
export async function panelSafe<T>(
  key: PanelKey,
  run: () => Promise<Omit<HealthPanel<T>, 'key' | 'label' | 'error'>>,
): Promise<HealthPanel<T>> {
  try {
    const p = await run();
    return { key, label: PANEL_LABELS[key], ...p };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      key,
      label: PANEL_LABELS[key],
      status: 'unknown',
      summary: `unreadable — ${msg}`,
      metrics: [],
      data: null,
      error: msg,
    };
  }
}

function m(label: string, value: string | number, tone?: PanelStatus): HealthMetric {
  return tone ? { label, value, tone } : { label, value };
}

/**
 * Project the versioned live-health snapshot onto the small host-pressure sample
 * consumed by the SystemHealth thresholds. Only `measured` numeric readings are
 * evidence; unknown/stale readings remain null so the detector can report an
 * honest unknown instead of treating an unavailable signal as zero.
 */
export function hostPressureSampleFromLiveHealth(
  snapshot: Pick<LiveHealthSnapshot, 'sampledAtMs' | 'profile' | 'signals'> | null | undefined,
): HostPressureSample | null {
  if (!snapshot) return null;
  const measuredNumber = (key: LiveHealthSignalKey): number | null => {
    const reading: LiveHealthReading = snapshot.signals[key];
    return reading.state === 'measured' && typeof reading.value === 'number' && Number.isFinite(reading.value)
      ? reading.value
      : null;
  };
  return {
    sampledAtMs: snapshot.sampledAtMs,
    effectiveCores: snapshot.profile.effectiveCores,
    cpuPsiSomePct: measuredNumber('cpu.psiSomePct'),
    memoryPsiSomePct: measuredNumber('memory.psiSomePct'),
    memoryPsiFullPct: measuredNumber('memory.psiFullPct'),
    runnableCount: measuredNumber('scheduler.runnableCount'),
    blockedCount: measuredNumber('scheduler.blockedCount'),
  };
}

function agoMin(ms: number | null, now: number): string {
  if (ms === null) return 'never';
  const min = Math.max(0, (now - ms) / 60_000);
  if (min < 1) return 'just now';
  if (min < 90) return `${Math.round(min)}m ago`;
  return `${Math.round(min / 60)}h ago`;
}

type GitSyncFreshnessDeriver = (
  metadata: Record<string, unknown> | null,
  cron: string | null,
  active: boolean,
  nowMs: number,
) => Record<string, unknown>;

interface GitSyncRoutineRead {
  active: boolean;
  trigger_config: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}

/**
 * Apply the shared routines:list freshness verdict to the system-health headline.
 *
 * The routine writer's `last_status` is intentionally sticky across skipped fires, so
 * a raw `synced` value can outlive the completed-outcome proof that made it true. Keep
 * the derivation in routines:list as the single source of freshness semantics, but let
 * this collector choose the effective DeployHealth status without importing the whole
 * agent-tool module at system-health module load time.
 */
export function deriveSystemHealthGitSyncStatus(
  row: GitSyncRoutineRead,
  nowMs: number,
  deriveFreshness: GitSyncFreshnessDeriver,
): { status: DeployHealth['gitSyncStatus']; freshness: Record<string, unknown> } {
  const cron = typeof row.trigger_config?.cron === 'string' ? row.trigger_config.cron : null;
  const freshness = deriveFreshness(row.metadata, cron, row.active, nowMs);
  const rawStatus =
    typeof row.metadata?.last_status === 'string'
      ? (row.metadata.last_status as DeployHealth['gitSyncStatus'])
      : 'nothing';
  return {
    // A stale completed-outcome clock or a wedged in-flight fire is a distinct
    // derived state. Preserve the writer's raw outcome for every other verdict.
    status: freshness.status === 'degraded' ? 'degraded' : rawStatus,
    freshness,
  };
}

/** "in 4m" / "in 2h" for a future timestamp; "—" if null, "overdue" if past. */
function untilMin(ms: number | null, now: number): string {
  if (ms === null) return '—';
  const min = (ms - now) / 60_000;
  if (min < 0) return 'overdue';
  if (min < 1) return 'imminent';
  if (min < 90) return `in ${Math.round(min)}m`;
  return `in ${Math.round(min / 60)}h`;
}

// ── collectors ───────────────────────────────────────────────────────────────

async function collectQueen(ctx: HealthCtx): Promise<HealthPanel<QueenHealth>> {
  return panelSafe<QueenHealth>('queen', async () => {
    const { ws, now, potSlug, started } = ctx;
    if (!potSlug) {
      const data: QueenHealth = {
        potSlug: null, started: false, stalled: false, midTurn: false, armed: false,
        lastWakeAt: null, staleForMs: null, nextFireAt: null, cadenceOk: false,
        watchdogFires24h: 0, demand: { todoItems: 0, startedPlans: 0 },
        decisionsWindow: { total: 0, auto: 0, gated: 0 }, workingTracked: 0,
      };
      return { status: 'unknown', summary: 'no hive registered in this workspace', metrics: [], data };
    }
    const { sql } = getOrgPg();
    const { potLivenessCheck, potMidTurn, potDemandCheck, recentWatchdogFires } = await import('../pot/watchdog');
    const [live, midTurn, demand, watchdogFires24h] = await Promise.all([
      potLivenessCheck(sql, potSlug, { workspaceId: ws, now }),
      potMidTurn(potSlug).catch(() => false),
      potDemandCheck(ws).catch(() => ({ demand: false, todoItems: 0, startedPlans: 0 })),
      recentWatchdogFires(ws, potSlug).catch(() => 0),
    ]);
    let decisionsWindow = { total: 0, auto: 0, gated: 0 };
    try {
      const { summarizeDecisionLedger } = await import('../decision-ledger/read');
      const sum = await summarizeDecisionLedger(ws, { sinceMs: now - WINDOW_MS });
      decisionsWindow = {
        total: sum.total,
        auto: sum.byPosture?.auto ?? 0,
        gated: (sum.byPosture?.gated ?? 0) + (sum.byPosture?.proposed ?? 0),
      };
    } catch { /* ledger flag off / not yet populated — leave zeros */ }

    const nextFireAt = live.nextFireAt ? live.nextFireAt.getTime() : null;
    const lastWakeAt = live.staleForMs !== null ? now - live.staleForMs : null;
    const overdue = nextFireAt !== null && now - nextFireAt > 5 * 60_000;
    const hasDemand = demand.demand || demand.todoItems > 0 || demand.startedPlans > 0;
    const stalled =
      started && !midTurn && hasDemand &&
      ((live.staleForMs !== null && live.staleForMs > QUEEN_STALL_MS && !live.armed) || overdue);
    // A mid-turn Mug is on cadence even though her one-shot pot-wake routine has fired
    // and self-deactivated (re-declaration pending) — mirror the `stalled` line above,
    // which already excludes midTurn. Without this the Overwatch/Kettle brief false-
    // reports "cadence OFF" for an actively-working Mug (EI-12553).
    const cadenceOk = started && (live.armed || midTurn) && !stalled;

    const data: QueenHealth = {
      potSlug, started, stalled, midTurn, armed: live.armed,
      lastWakeAt, staleForMs: live.staleForMs, nextFireAt, cadenceOk,
      watchdogFires24h, demand: { todoItems: demand.todoItems, startedPlans: demand.startedPlans },
      decisionsWindow, workingTracked: ctx.openPlacements?.workingTracked ?? 0,
    };
    const status = queenStatus(data);
    const summary = !started
      ? 'paused — colony idle by choice'
      : stalled
        ? `STALLED ${agoMin(lastWakeAt, now)} — ${live.armed ? 'wake overdue' : 'no wake armed'}, demand queued`
        : midTurn
          ? 'working — turn live now'
          : `looping — last wake ${agoMin(lastWakeAt, now)}, next ${untilMin(nextFireAt, now)}`;
    return {
      status, summary, data,
      link: { label: 'Mug pane', href: '/adv?tab=harnesses' },
      metrics: [
        m('state', !started ? 'paused' : stalled ? 'stalled' : midTurn ? 'working' : 'looping', status),
        m('last wake', agoMin(lastWakeAt, now)),
        m('watchdog 24h', watchdogFires24h, watchdogFires24h >= 3 ? 'warn' : undefined),
        m('decisions', `${decisionsWindow.auto}a/${decisionsWindow.gated}g`),
        m('tracking', data.workingTracked),
      ],
    };
  });
}

async function collectBees(ctx: HealthCtx): Promise<HealthPanel<BeesHealth>> {
  return panelSafe<BeesHealth>('bees', async () => {
    const { gatherLiveBees } = await import('../fleet/placement-gather');
    const bees = await gatherLiveBees(ctx.ws);
    const running = bees.length;
    const alive = bees.filter((b) => b.alive).length;
    const stale = running - alive;
    const orphanedClaims = bees.filter((b) => !b.alive && (b.load ?? 0) > 0).length;
    const totalLoad = bees.reduce((s, b) => s + (b.load ?? 0), 0);
    const op = ctx.openPlacements ?? { recovering: 0, cursed: 0, stranded: 0, workingTracked: 0 };
    let invalidModelFailures = 0;
    try {
      const { sql } = getOrgPg();
      const rows = await sql<{ error_message: string | null; output_tail: string | null }[]>`
        SELECT error_message, output_tail
          FROM harness_shared.spawned_agents
         WHERE workspace_id = ${ctx.ws}
           AND child_role IN ('cup', 'mug', 'kettle', 'blender')
           AND status = 'failed'
           AND started_at >= ${new Date(ctx.now - WINDOW_MS).toISOString()}
           AND (
             coalesce(error_message, '') ILIKE '%selected model%'
             OR coalesce(output_tail, '') ILIKE '%selected model%'
           )
           AND (
             coalesce(error_message, '') ILIKE '%not exist%'
             OR coalesce(error_message, '') ILIKE '%access%'
             OR coalesce(output_tail, '') ILIKE '%not exist%'
             OR coalesce(output_tail, '') ILIKE '%access%'
           )`;
      invalidModelFailures = countInvalidModelFailures(rows);
    } catch { /* fail-soft — a bad diagnostic read must not grey the fleet panel */ }
    const data: BeesHealth = {
      running, alive, stale, orphanedClaims, totalLoad, invalidModelFailures,
      placements: { recovering: op.recovering, cursed: op.cursed, stranded: op.stranded, workingTracked: op.workingTracked },
    };
    const status = beesStatus(data);
    return {
      status,
      summary: running === 0
        // EI-14091: this measures ONLY Mug-placed cups, not the whole SU/agent
        // fleet — a plain "no bees running" reads as whole-fleet-idle to a human
        // (it doesn't, e.g., an SU fleet can be busy while this panel is 0/crit).
        // Say so inline so the escalation carries its own scope, not just this
        // panel's tooltip / the Kettle brief's separate caveat.
        ? 'no Mug-placed cups running (does not measure the broader SU/agent fleet, which may still be busy)'
        : `${running} bee(s), ${alive} alive${stale > 0 ? `, ${stale} stale` : ''}${op.cursed > 0 ? `, ${op.cursed} cursed` : ''}${invalidModelFailures > 0 ? `, ${invalidModelFailures} invalid-model failure(s)` : ''}`,
      data,
      link: { label: 'Work', href: '/adv?tab=harnesses' },
      metrics: [
        m('running', running),
        m('alive', alive),
        m('stale', stale, stale > 0 ? 'warn' : undefined),
        m('orphaned', orphanedClaims, orphanedClaims > 0 ? 'warn' : undefined),
        m('invalid model', invalidModelFailures, invalidModelFailures > 0 ? 'warn' : undefined),
        m('cursed', op.cursed, op.cursed > 0 ? 'crit' : undefined),
      ],
    };
  });
}

export function countInvalidModelFailures(
  rows: readonly { error_message: string | null; output_tail: string | null }[],
): number {
  return rows.filter(({ error_message, output_tail }) =>
    !MODEL_CAPACITY_RE.test(`${error_message ?? ''} ${output_tail ?? ''}`),
  ).length;
}

async function collectWorkItems(ctx: HealthCtx): Promise<HealthPanel<WorkItemsHealth>> {
  return panelSafe<WorkItemsHealth>('workItems', async () => {
    // P-008 (db-performance-remediation-2026-07-26): this used to be
    // `listWorkItems({ limit: 2000 })` followed by a JS tally
    // (`for (const it of items) byState[it.state]++`). That materialised 2000 full
    // work-items — ~4.7MB of `body`+`payload` JSONB per call — to derive the handful
    // of integers below, and at 761k calls it was the single largest live consumer of
    // this database (22.6% of live DB time; measured by pg_stat_statements DELTA, not
    // lifetime totals — see plan decision D-007 for why that distinction matters).
    //
    // It was also WRONG: the 2000-row cap silently truncated the tally, so `total`
    // and every byState bucket reported the 2000 most recent rows out of ~51,869 —
    // off by ~26x. The aggregate has no cap to be wrong about.
    //
    // Measured, EXPLAIN (ANALYZE, SERIALIZE): 4734 kB / ~195 ms before vs 1 kB /
    // ~52 ms after. Note the fix is an AGGREGATE, not the column projection the plan
    // item first proposed — projection was unavailable because the row mappers
    // genuinely read body/payload (issueToWorkItem, issueToCandidate).
    const { countWorkItemsByState } = await import('../work-items');
    const byState = await countWorkItemsByState();
    const n = (s: string) => byState[s] ?? 0;
    const total = Object.values(byState).reduce((a, b) => a + b, 0);
    const inProgress = n('wip') + n('in-progress') + n('validating') + n('reviewing');
    // P-008 / P-009: stuck-items metric + reaper liveness (best-effort — a read
    // failure leaves the recovery fields undefined so the panel still renders).
    let recovery: Awaited<ReturnType<typeof import('../work-queue-health').readWorkQueueHealth>> | null = null;
    try {
      const { readWorkQueueHealth } = await import('../work-queue-health');
      recovery = await readWorkQueueHealth(getOrgPg().sql, { workspaceId: ctx.ws });
    } catch { /* leave recovery fields undefined — fail-soft */ }
    const data: WorkItemsHealth = {
      total, byState,
      todo: n('todo'), inProgress, blocked: n('blocked'),
      needsHuman: n('needs-human') + n('needs_human'), done: n('done') + n('passed') + n('resolved'),
      ...(recovery ? {
        stuckFeatures: recovery.stuckFeatures,
        deadHeldClaims: recovery.deadHeldFeatures,
        deadAssignedIssues: recovery.deadAssignedIssues,
        deadHeldAssignments: recovery.deadHeldAssignments,
        settlementAuthorityFailures: recovery.settlementAuthorityFailures,
        reaperAgeSec: recovery.reaperAgeMs == null ? null : Math.round(recovery.reaperAgeMs / 1000),
        reaperStale: recovery.reaperStale,
      } : {}),
    };
    const status = workItemsStatus(data);
    const stuckTotal =
      (data.stuckFeatures ?? 0) +
      (data.deadHeldClaims ?? 0) +
      (data.deadAssignedIssues ?? 0) +
      (data.deadHeldAssignments ?? 0);
    // P-016: WEDGED is a cause claim; `reaperStale` is only a clock. See
    // `isReaperWedged` for why the reaper's own backlog is the discriminator.
    const reaperWedged = isReaperWedged({
      reaperStale: data.reaperStale,
      reaperAgeSec: data.reaperAgeSec,
      stuckTotal,
    });
    const settlementAuthorityFailures = data.settlementAuthorityFailures ?? 0;
    return {
      status,
      summary: `${data.total} items — ${data.todo} todo, ${inProgress} in-flight, ${data.blocked} blocked${data.needsHuman > 0 ? `, ${data.needsHuman} need human` : ''}${stuckTotal > 0 ? `, ${stuckTotal} stuck` : ''}${settlementAuthorityFailures > 0 ? `, ${settlementAuthorityFailures} settlement authority failure(s)` : ''}${reaperWedged ? ' — REAPER WEDGED' : ''}`,
      data,
      link: { label: 'Work', href: '/adv?tab=harnesses' },
      metrics: [
        m('todo', data.todo),
        m('in-flight', inProgress),
        m('blocked', data.blocked, data.blocked > 0 ? 'warn' : undefined),
        m('needs-human', data.needsHuman, data.needsHuman > 0 ? 'warn' : undefined),
        m('done', data.done),
        ...(recovery ? [
          m('stuck', stuckTotal, stuckTotal > 0 ? 'warn' : undefined),
          m('settlement failures', settlementAuthorityFailures, settlementAuthorityFailures > 0 ? 'crit' : undefined),
          m('reaper age', data.reaperAgeSec == null ? '—' : `${data.reaperAgeSec}s`, reaperWedged ? 'crit' : data.reaperStale ? 'warn' : undefined),
        ] : []),
      ],
    };
  });
}

/** WI-3597: the age (hours) past which a ready-but-unplaced frontier item counts
 *  as "stuck/gated" rather than fresh placeable work. Env-tunable; default 3h —
 *  far beyond the Queen's ~minutes placement cadence, so a stuck item is one she
 *  has demonstrably chosen not to place (gated on owner/rig/fixture), not one she
 *  simply hasn't reached yet. */
function frontierStuckHours(): number {
  const raw = Number(process.env.PAPERCUSP_FRONTIER_STUCK_HOURS);
  return Number.isFinite(raw) && raw > 0 ? raw : 3;
}

/**
 * EI-15329: a frontier item requiring LIVE multi-machine / federation-rig
 * verification (real VMs, cross-device GH auth, a live P2P swarm) is not
 * Mug-placeable no matter how fresh it looks — no cup has a route to that
 * infra (the "cup-verification-wall", EI-13215). The AGE-based stuck window
 * above (WI-3597) misses this: an item the live SU fleet is actively working
 * reads as "touched recently" (ageDays low), so it never crosses the stuck
 * threshold and keeps counting as fresh placeable work — which is exactly
 * the false "0 placements = mechanism defect" reading EI-15329 diagnosed
 * (5 federation/live-rig bugs — WI-757/1534/2003/3501/5136 — read as a fresh
 * ready frontier while genuinely un-Mug-placeable).
 *
 * `payload.needs_2_machine_rig` ({@link crossMachineRigExclusionSql}) already
 * excludes a TAGGED rig-only item before it ever reaches the frontier — this
 * regex is the fallback for the common case an item was filed without that
 * tag (as WI-757/1534/2003 were): a title-level heuristic in the same spirit
 * as {@link EPHEMERAL_BENCHMARK_SLUG_SQL_RE} (a stable identifying string,
 * not a payload field, is the only signal available). Intentionally narrow —
 * false negatives (an untagged, unusually-worded rig item) just fall back to
 * the age-based window; false positives (a non-rig item that happens to
 * mention one of these terms) are the accepted cost of closing a live,
 * observed false-escalation class. Prefer tagging `needs_2_machine_rig`
 * at filing time when it's known.
 */
const LIVE_RIG_ONLY_TITLE_RE =
  /federat|fed_event|swarm-?join|hive[-_ ]?epoch|epoch-?key|cross-?machine|multi-?machine|\blive[- ]rig\b|hyperbee/i;

/** Pure (unit-tested): does this frontier candidate's title identify it as
 *  live-multi-machine/federation-rig-only work (see {@link LIVE_RIG_ONLY_TITLE_RE})? */
export function isLiveRigOnlyFrontierTitle(title?: string): boolean {
  return !!title && LIVE_RIG_ONLY_TITLE_RE.test(title);
}

/** Count ranked frontier candidates that are correctly excluded from "fresh
 *  placeable work": either aged past the stuck window (`ageDays`, pre-computed
 *  on every candidate by the survey — frontierRowToCandidate, WI-3597), OR
 *  identified as live-rig/federation-only by title (EI-15329, see
 *  {@link isLiveRigOnlyFrontierTitle}) regardless of age. Needs no extra query. */
export function countStuckFrontier(rows: ReadonlyArray<{ ageDays?: number; title?: string }>): number {
  const stuckDays = frontierStuckHours() / 24;
  let n = 0;
  for (const r of rows) if ((r.ageDays ?? 0) >= stuckDays || isLiveRigOnlyFrontierTitle(r.title)) n += 1;
  return n;
}

/**
 * Dead routines (EI-584): active CRON/rrule routines whose next_fire_at is long
 * overdue — the routinesTick that should claim+fire them isn't, so the feed
 * starves. `workFeedStatus` crits on this and the request-path liveness alarm
 * pages a fleet-wide "routine engine is starved" blocker, so it must mean exactly
 * that: the ENGINE is frozen.
 *
 * EI-11797 — EXCLUDE PURE LOOP routines (`reschedule_interval_sec` set, no
 * cron/rrule). A pure loop's period is (turn-duration + interval): it parks at
 * `next_fire_at='infinity'` while its turn runs, then the completion-rebase re-arms
 * it to `completed_at + interval`. A busy owner (an actively-running fleet loop) or
 * the transient window between that re-arm and the next claim legitimately leaves a
 * healthy loop's `next_fire_at` briefly past — which is NOT engine starvation. Yet
 * the old unfiltered query counted it, mis-firing the workFeed CRIT + the fleet
 * blocker page "while the active fleet loop is running" (the dead-routines flap,
 * 2026-07-11/12 — repeat_count up to 31). Loop overdue-ness is already a per-lane
 * WARN in the loops panel (collectLoops / loopsStatus, whose own comment notes "the
 * workFeed dead-routine crit already covers an engine-wide freeze"), and a
 * genuinely-dead loop is auto-paused by the loop reconcile's dead-owner terminal
 * guard — so a stalled loop never belongs in the engine-starvation crit.
 *
 * A cron+loop (BOTH a cron/rrule AND an interval) STAYS caught: it is a recurrence
 * (claimDueRoutine advances it to cron-next every tick, never parks it at infinity),
 * so an overdue cron+loop genuinely means the engine isn't advancing it. The
 * exclusion therefore matches claimDueRoutine's own PURE-loop definition
 * (`isLoop && !hasRecurrence`).
 */
export async function readDeadRoutines(
  sql: Sql,
  overdueMs: number,
  workspaceId: string,
  homeInstallSlug: string = releaseInstallSlug(),
): Promise<DeadRoutineCensus> {
  const rows = await sql<Array<{
    name: string;
    overdue_total: number;
    scope_total: number;
    overdue_name_total: number;
    active_name_total: number;
    home_active_total: number;
    home_overdue_total: number;
  }>>`
    WITH scope AS (
      SELECT name, install_slug, next_fire_at,
             (next_fire_at < now() - make_interval(secs => CASE
                WHEN last_fired_at IS NULL OR NOT isfinite(next_fire_at) OR next_fire_at <= last_fired_at
                  THEN ${overdueMs / 1000}::float8
                WHEN next_fire_at - last_fired_at <= make_interval(secs => ${FAST_ROUTINE_MAX_CADENCE_SEC}::float8)
                  THEN LEAST(
                    ${overdueMs / 1000}::float8,
                    GREATEST(
                      ${(overdueMs / 1000) * FAST_ROUTINE_BASE_FRACTION}::float8,
                      ${FAST_ROUTINE_CADENCE_MULTIPLE}::float8 * extract(epoch FROM next_fire_at - last_fired_at)::float8))
                ELSE ${overdueMs / 1000}::float8
              END)) AS is_overdue
        FROM harness_shared.routines
       WHERE active = true AND next_fire_at IS NOT NULL
         AND workspace_id = ${workspaceId}
         AND NOT ( reschedule_interval_sec IS NOT NULL
                   AND NOT jsonb_exists(trigger_config, 'cron')
                   AND NOT jsonb_exists(trigger_config, 'rrule') )
    )
    , scope_counts AS (
      SELECT name,
             count(*)::int AS active_name_total,
             count(*) FILTER (WHERE install_slug = ${homeInstallSlug})::int
               AS home_active_total,
             count(*) FILTER (WHERE install_slug = ${homeInstallSlug} AND is_overdue)::int
               AS home_overdue_total
        FROM scope
       GROUP BY name
    )
    , overdue AS (
      SELECT name, next_fire_at
        FROM scope
       WHERE is_overdue
    )
    SELECT overdue.name,
           count(*) OVER ()::int AS overdue_total,
           (SELECT count(*)::int FROM scope) AS scope_total,
           count(*) OVER (PARTITION BY overdue.name)::int AS overdue_name_total,
           scope_counts.active_name_total,
           scope_counts.home_active_total,
           scope_counts.home_overdue_total
      FROM overdue
      JOIN scope_counts ON scope_counts.name = overdue.name
     ORDER BY overdue.next_fire_at ASC
     LIMIT ${DEAD_ROUTINE_CENSUS_LIMIT}`;
  // Zero overdue rows ⇒ no alarm fires, so the denominator is never read; report a clean zero
  // rather than paying a second query for a scope count nothing will consume.
  if (rows.length === 0) {
    return {
      count: 0,
      distinctCount: 0,
      totalInScope: 0,
      names: [],
      criticalNames: [],
      routineCoverage: {},
      namesTruncated: false,
      censusTruncated: false,
    };
  }
  const routineCoverage: Record<string, DeadRoutineNameCoverage> = {};
  for (const row of rows) {
    // WI-10002084 — `home_active_total === 0` is NOT "the home install is fine": it means the
    // release install has no active row for this routine, so its state was never measured.
    // It gets its own variant so a consumer cannot read an unmeasured leg as a measured one.
    routineCoverage[row.name] = {
      overdue: row.overdue_name_total,
      active: row.active_name_total,
      homeInstall:
        row.home_active_total === 0 ? 'absent' : row.home_overdue_total > 0 ? 'overdue' : 'live',
    };
  }
  return summarizeDeadRoutines(rows.map((r) => r.name), {
    count: rows[0].overdue_total,
    totalInScope: rows[0].scope_total,
    censusTruncated: rows.length >= DEAD_ROUTINE_CENSUS_LIMIT,
  }, { routineCoverage });
}

/**
 * The engine-starvation census. Separates the two things the old `string[]` return
 * conflated — a BOUNDED display list and an UNBOUNDED population count.
 */
export interface DeadRoutineCensus {
  /**
   * TRUE number of overdue routines — from `count(*) OVER ()`, computed before LIMIT.
   * ⚠ Never `names.length`: that is what produced the measured misreport this type exists
   * to prevent (see {@link summarizeDeadRoutines}).
   */
  count: number;
  /**
   * Distinct routine NAMES overdue. `count` counts ROWS and the table holds one row per
   * install, so the two differ by a large factor here (git-sync alone is 59 rows). This is the
   * unit `names` is measured in, and therefore the unit any "+N more" must be computed in.
   */
  distinctCount: number;
  /** Active in-scope durable routines — the DENOMINATOR that turns a bare count into a ratio. */
  totalInScope: number;
  /** Exemplars to NAME, fleet-blocking first, then most-overdue. Capped; see `namesTruncated`. */
  names: string[];
  /** Every fleet-blocking routine implicated (git-sync / green-checkpoint / release-trigger). */
  criticalNames: string[];
  /** Per-name overdue/active row counts for every named overdue routine. */
  routineCoverage: Record<string, DeadRoutineNameCoverage>;
  /** `names` was cut to the exemplar cap. Bounds the LIST only — `count` remains exact. */
  namesTruncated: boolean;
  /** The census fetch itself hit `DEAD_ROUTINE_CENSUS_LIMIT`; `count` is still exact. */
  censusTruncated: boolean;
}

/**
 * PURE exemplar selection + boundedness accounting for the dead-routine alarm (no DB, no clock).
 *
 * ## Why this is not just formatting (EI-20045691451471399)
 *
 * The previous implementation returned `string[]` from a `LIMIT 20` query, and the panel then
 * set `deadRoutines: deadRoutineNames.length`. That made the reported COUNT a function of the
 * fetch cap: an engine freeze of ANY magnitude ≥20 reported exactly "20".
 *
 * That is not hypothetical. On 2026-08-10 the alarm broadcast **"20 dead routine(s) overdue
 * >10m … the routine engine is starved"** while **101 of 151** durable routines were actually
 * overdue (EI-20063652008382478) — a 5× understatement pinned precisely at the cap. The agent
 * triaging that broadcast read the 20 and wrote "The DETECTOR is fine", then spent the
 * investigation on the restart actuator instead. A saturated count is worse than a missing
 * one: it is indistinguishable from a real measurement, so it redirects triage rather than
 * inviting a second look.
 *
 * So `count` here is always the caller's uncapped total and is NEVER recomputed from `names`.
 *
 * ## Why order by consequence rather than by overdue-seconds
 *
 * The rows arrive most-overdue-first, which sounds like severity ordering and is not: it ranks
 * by how long ago a routine was DUE, which for a frozen engine is decided by cron phase — i.e.
 * essentially arbitrary. In the filed incident that put `pr-poll` first by SECONDS and buried
 * `git-sync`, so a fleet-wide commit outage was announced under its least consequential
 * member. Fleet-blocking names are hoisted so the cap can never bury the one that explains the
 * blast radius, and `criticalNames` is reported in full regardless of the exemplar cap.
 */
export function summarizeDeadRoutines(
  overdueMostOverdueFirst: readonly string[],
  totals: { count: number; totalInScope: number; censusTruncated?: boolean },
  opts: {
    exemplarLimit?: number;
    criticalNames?: ReadonlySet<string>;
    routineCoverage?: Readonly<Record<string, DeadRoutineNameCoverage>>;
  } = {},
): DeadRoutineCensus {
  const limit = opts.exemplarLimit ?? DEAD_ROUTINE_EXEMPLAR_LIMIT;
  const critical = opts.criticalNames ?? FLEET_BLOCKING_ROUTINE_NAMES;
  // DEDUPE FIRST — `harness_shared.routines` carries ONE ROW PER INSTALL, so a name repeats
  // once per pot. Measured live 2026-08-10: git-sync 59 rows, cross-hive-outbox-drain 24,
  // green-checkpoint 13. Without this, a total freeze fills every exemplar slot with the SAME
  // name ("git-sync, git-sync, git-sync, …") and hides every other routine — which would make
  // the consequence-ordering fix actively worse than the arbitrary ordering it replaced.
  // Preserves first-seen order, so the incoming most-overdue-first ordering survives.
  const distinct = [...new Set(overdueMostOverdueFirst)];
  const criticalNames = distinct.filter((n) => critical.has(n));
  const rest = distinct.filter((n) => !critical.has(n));
  const names = [...criticalNames, ...rest].slice(0, limit);
  return {
    count: totals.count,
    distinctCount: distinct.length,
    totalInScope: totals.totalInScope,
    names,
    criticalNames,
    routineCoverage: { ...(opts.routineCoverage ?? {}) },
    // Compared in the SAME UNIT as `names` (distinct names), never against the row count —
    // mixing the two would report "+134 more" when only 2 more distinct routines exist.
    // A truncated CENSUS also implies more names exist than were ever fetched, so it counts as
    // truncated even when the names that DID arrive happen to fit the cap.
    namesTruncated: distinct.length > names.length || (totals.censusTruncated ?? false),
    censusTruncated: totals.censusTruncated ?? false,
  };
}

/**
 * WI-4310 (green-checkpoint-vs-routinesTick residual contention, post EI-9935): PURE decision
 * for which `readDeadRoutines` overdue threshold to use THIS computation.
 *
 * EI-9935 already fixed the SEVERE failure (concurrent-tick pileup, repeat_count up to 63).
 * A much milder residual remained: green-checkpoint's own forked-vitest run shares this box's
 * PG pool + CPU with routinesTick, so individual tick durations elevate under its load
 * (5-45s vs the 30s cadence, historically up to 93s) — and at least twice, a not-green
 * checkpoint run landed ~2min before the workFeed's dead-routine (engine-starvation) alarm
 * fired. green-checkpoint.ts's own GREEN_CHECKPOINT_MAX_FORKS comment names the fix directly:
 * "a memory-aware gate-defer, not fewer forks" — this is that defer, applied to the ALARM
 * rather than the checkpoint run itself (option (a)/(c) of the item; NOT resource-isolating
 * the checkpoint's PG connections from the routine engine's pool (b), which is a genuine
 * capacity/topology change out of scope for a single item).
 *
 * Widened ONLY for a bounded, KNOWN window (the run itself + a short trailing grace) — every
 * other computation keeps the tight base threshold, so a GENUINE engine freeze is caught just
 * as fast as before. Exported for a fast pure unit test (no DB / no fs).
 */
export function deadRoutineOverdueMsForCiWindow(
  input: { checkpointActive: boolean; recentCheckpointEventAgeMs: number | null },
  opts: { baseMs?: number; widenedMs?: number; graceMs?: number } = {},
): number {
  const baseMs = opts.baseMs ?? DEAD_ROUTINE_OVERDUE_MS;
  const widenedMs = opts.widenedMs ?? DEAD_ROUTINE_OVERDUE_WIDENED_MS;
  const graceMs = opts.graceMs ?? DEAD_ROUTINE_CI_GRACE_MS;
  if (input.checkpointActive) return widenedMs;
  if (input.recentCheckpointEventAgeMs != null && input.recentCheckpointEventAgeMs <= graceMs) return widenedMs;
  return baseMs;
}

/**
 * EI-20258981691947730: the install slug of the RELEASE pipeline — the install whose
 * `green-checkpoint` / `release-trigger` routine rows and `green_checkpoint`
 * pipeline_events this operator owns.
 *
 * Deliberately the SAME resolver those routines are REGISTERED under
 * (`release-checkpoint-launch.ts`'s `operatorHomeHarnessSlug()`), so the identity used
 * to WRITE a routine row is by construction the identity used to READ it back. It is
 * sync + env-pure, so unlike the pot-registry read it can never throw and leave the
 * caller with a null identity.
 *
 * This is NOT `potSlug` (the Queen panel's "first STARTED pot, else hives[0].slug"),
 * which answers a different question and measured `'sb-devboard-hive'` on this install
 * at 2026-08-12T14:50:44Z. Passing that as the release identity broke the WI-5839
 * stale-paused protection BOTH ways:
 *   - FALSE NEGATIVE (armed, not yet fired): should the release install's OWN
 *     green-checkpoint / release-trigger ever be paused, it would fail the install-match
 *     and be demoted from critical to advisory — i.e. the one alarm this protection
 *     exists to raise was disarmed for the only install it matters on. Not observed
 *     firing because papercusp's green-checkpoint happened to be active throughout
 *     (measured 2026-08-12T15:15:33Z, next 16:15Z); the disarm is structural, not latent
 *     on a condition.
 *   - FALSE POSITIVE (intermittent): when the pot-registry read threw, `potSlug` went
 *     null, `installKnown` went false, and {@link computeStalePausedRoutines}' DELIBERATE
 *     fail-open (compute.test.ts "falls back to…", do not tighten it) paged OTHER pots'
 *     abandoned green-checkpoints as ours — observed 2026-08-12T13:57Z as a BLOCKER
 *     "deploy pipeline may be silently stopped" about `ei665-verify-x1` /
 *     `ei669-repro-su-b621d`, neither of which is this install.
 *
 * Independently corroborated from the data side (su-b207479d, 2026-08-12T15:18Z): of the
 * 17 `green-checkpoint`/`release-trigger` rows in this workspace, EXACTLY ONE carries a
 * `release-trigger` — install_slug='papercusp', active — and the only two INACTIVE
 * green-checkpoints are the decommissioned repro installs this alarm was paging about.
 * That agrees with `operatorHomeHarnessSlug()`, which is preferred here because it is the
 * WRITE-side identity (an invariant by construction) rather than a currently-true
 * uniqueness property of the rows.
 *
 * Note a registry-liveness filter is NOT an alternative fix: `ei669-repro-su-b621d` is
 * still REGISTERED despite being abandoned, so "exclude installs that no longer exist"
 * catches only half the offenders. Identity, not liveness, is the discriminator.
 */
export function releaseInstallSlug(): string {
  return operatorHomeHarnessSlug();
}

/**
 * DB-reading wrapper around {@link deadRoutineOverdueMsForCiWindow}: resolves BOTH probes
 * (the cheap file-based run-lock check + the most recent `green_checkpoint` pipeline_event)
 * and folds them into the threshold `readDeadRoutines` should use right now.
 *
 * FULLY FAIL-SOFT (mirrors poolPressure()/pool-pressure.ts's contract): any probe error —
 * an unreadable lock file, a missing `release-checkpoint-launch`/`release-deploy-launch`
 * module in a stripped test bundle, a failed query — falls back to the tight BASE threshold,
 * never the widened one. Absence of a clean "checkpoint is active" signal must never SUPPRESS
 * the dead-routine alarm; it can only fail to widen it.
 */
export async function resolveDeadRoutineOverdueMs(sql: Sql, installSlug: string | null, now: number): Promise<number> {
  try {
    const [{ integrationRoot }, { isCheckpointRunLockHeldCheap }] = await Promise.all([
      import('../release-deploy-launch'),
      import('../release-checkpoint-launch'),
    ]);
    const lock = isCheckpointRunLockHeldCheap(integrationRoot());
    let recentCheckpointEventAgeMs: number | null = null;
    if (!lock.held && installSlug) {
      const rows = await sql<Array<{ created_at: Date }>>`
        SELECT created_at FROM harness_shared.pipeline_events
         WHERE kind = 'green_checkpoint' AND install_slug = ${installSlug}
         ORDER BY created_at DESC LIMIT 1`;
      if (rows[0]) recentCheckpointEventAgeMs = Math.max(0, now - new Date(rows[0].created_at).getTime());
    }
    return deadRoutineOverdueMsForCiWindow({ checkpointActive: lock.held, recentCheckpointEventAgeMs });
  } catch {
    return DEAD_ROUTINE_OVERDUE_MS;
  }
}

/** Minimal per-routine shape {@link computeStalePausedRoutines} needs — the pure
 *  split from its DB read below, so the threshold/attribution logic is directly
 *  unit-testable with plain fixtures (no PG). */
export interface StalePausedRoutineInput {
  name: string;
  /** metadata.pause.pausedAtMs — set by routines:set whenever a pause goes through
   *  the reason-required path (EI-18654017982759582 #1). Absent ⇒ either a legacy
   *  pause that predates that guard, or one written by a path that bypassed it. */
  pausedAtMs?: number | null;
  /** metadata.pause.reason, if recorded. */
  pauseReason?: string | null;
  /** metadata.pause.reviewBy — the RE-AFFIRMATION contract borrowed from the
   *  learning-loop-health sweep (EI-19370236916382521): a dated future value means
   *  "someone has looked at this pause again and it is still deliberate". Nothing
   *  writes it for system routines today, which is exactly why an always-on routine
   *  must not be allowed to age out silently — see the doc comment below. */
  pauseReviewBy?: string | null;
  /** Fallback age anchor (the row's updated_at) for when pausedAtMs is absent —
   *  so an unattributed legacy pause still gets a reportable age instead of none. */
  updatedAtMs?: number | null;
  /** EI-18694769501553335: the row's install_slug. green-checkpoint/release-trigger
   *  are legitimately seeded PER-INSTALL (one per repo-backed hive, seedHiveReleaseRoutines),
   *  so a paused one on a DIFFERENT install (a throwaway repro/verify harness, a sibling
   *  hive) does not block THIS install's own deploy pipeline — only escalate to `critical`
   *  when it matches `opts.currentInstallSlug`. Omit when unknown (falls back to
   *  name-only matching, preserving pre-fix behavior for callers that don't have it yet). */
  installSlug?: string | null;
  /** Measured downstream work waiting behind this paused routine, when applicable. */
  backlogDepth?: number | null;
}

export interface StalePausedRoutine {
  name: string;
  /** Milliseconds since the pause was recorded (or, lacking that, since the row was
   *  last updated). `Infinity` when neither timestamp is readable — still flagged,
   *  just with no meaningful age to report. */
  ageMs: number;
  /** No metadata.pause.reason was recorded — an unattributed pause is itself the
   *  bug class this guards against, regardless of age, so it is ALWAYS flagged. */
  reasonMissing: boolean;
  /** A release/deploy-critical routine (release-trigger, green-checkpoint). */
  critical: boolean;
  /** EI-18137248342636257: an ALWAYS-ON system routine (a `BESPOKE_ACTIVE_SEEDS`
   *  registry name) whose pause has never been re-affirmed, reported past the
   *  decommissioned-age cutoff that would otherwise have silenced it. Distinguishes
   *  "this survived the exemption on purpose" from an ordinary in-window row, so the
   *  alarm text can say WHY a 13-day-old pause is still being reported. */
  alwaysOnUnreaffirmed: boolean;
  /** Present only when the routine has a non-empty measured downstream backlog. */
  backlogDepth?: number;
}

/**
 * Pure (WI-5839 / EI-18654017982759582 items 2+3): which currently-PAUSED routines
 * have sat long enough — unexplained or not — to warrant a standing alarm.
 * `readDeadRoutines` above only ever looks at active=true rows, so a pause is
 * otherwise invisible no matter how long it persists — the exact shape that let
 * release-trigger silently sit paused ~4 days, twice (2026-06-18, 2026-07-21→25).
 *
 * A routine with NO recorded pause reason (paused before the reason-required guard
 * landed, or via a path that bypasses routines:set) is ALWAYS flagged, regardless
 * of age — an unattributed pause is exactly the bug class. A routine WITH a
 * recorded reason is flagged only once it crosses its threshold; release/deploy-
 * critical routines get a much shorter one (see module-level constants).
 *
 * EI-18694769501553335: `critical` additionally requires the row's `installSlug` to
 * match `opts.currentInstallSlug` (when both are known) — green-checkpoint/release-
 * trigger are legitimately seeded ONE-PER-INSTALL (each repo-backed hive gets its own,
 * seedHiveReleaseRoutines), so a paused one belonging to a DIFFERENT install (a
 * throwaway repro/verify harness, a sibling hive) does not mean THIS install's deploy
 * pipeline is stopped. Group (metadata.group_slug) is NOT a safe discriminator here: the
 * one-time 617 backfill assigned every green-checkpoint/release-trigger row to the
 * 'release' group by NAME across every install_slug ("deliberately install_slug-agnostic"
 * per its own comment), and no ongoing path assigns group_slug to a freshly-seeded row —
 * so a legitimate PRODUCTION install's row can equally read group:null.
 *
 * EI-18718973731535914: a NON-critical row whose age is past `opts.decommissionedMs`
 * (default 7d) is excluded ENTIRELY — even an unattributed (`reasonMissing`) one. Past
 * that age this is no longer a "pause someone forgot to explain", it is a routine
 * nobody has touched in a week+ (a decommissioned/retired routine, e.g. `hive-wake`) —
 * reporting it as a fresh stale-pause alarm indefinitely is itself the false-alarm bug.
 *
 * EI-18137248342636257: that decommissioned reading is right for an ANONYMOUS routine
 * (`hive-wake`) and empirically WRONG for an always-on one. Measured 2026-08-23: twelve
 * `cross-hive-outbox-drain` rows — a `BESPOKE_ACTIVE_SEEDS` registry routine — had sat
 * dark 13.6d carrying the reason "Owner directive 2026-08-09 (Avi, interactive): pause
 * p2p work - machine churning. **Reversible; resume with active:true**", every one with
 * `reviewBy: null`. A pause that names its own reversal is the opposite of decommissioned,
 * and this cutoff had silenced all twelve since day 7 — the very outage class this
 * subsystem exists to catch, reproduced under the exemption meant to quiet it.
 *
 * So an always-on system routine escapes the cutoff UNLESS its pause is re-affirmed
 * (`metadata.pause.reviewBy` in the future — the learning-loop sweep's contract,
 * EI-19370236916382521, via the shared `isReaffirmed`, which fails CLOSED). This is a
 * REACH fix to an existing exemption, not a fourth aging mechanism — plan decision D-007
 * (silent-halt-detection-and-owner-rails-2026-08-08) forbids the latter, and D-006 forbids
 * the other intuitive remedy (tightening the pause-reason validator). Note the discriminator
 * is deliberately NOT `reasonMissing`: all twelve live instances are fully ATTRIBUTED, so
 * keying on missing attribution would have caught exactly none of them while re-breaking
 * the retired-routine case above. The escape hatch stays bounded to the ~28 registry names,
 * so a genuinely retired non-registry routine still ages out exactly as before.
 *
 * This cutoff deliberately does NOT apply when `critical` is true (release-critical-
 * named AND install-matching): the whole POINT of the critical path is to keep
 * flagging a paused release-trigger/green-checkpoint no matter how long it sits —
 * that is the literal WI-5839 motivating incident (release-trigger silently paused
 * ~4 days, twice). A 7d cutoff that also silenced critical rows would make an 8+ day
 * critical pause LESS visible than the original bug this subsystem exists to catch —
 * exactly the failure mode a peer's reconciliation ask (EI-18718973731535914 follow-up)
 * surfaced: don't let a fix for one false-alarm class quietly weaken the true-positive
 * path it shares code with.
 */
export function computeStalePausedRoutines(
  rows: ReadonlyArray<StalePausedRoutineInput>,
  now: number,
  opts: { generalMs?: number; criticalMs?: number; decommissionedMs?: number; criticalNames?: ReadonlySet<string>; alwaysOnNames?: ReadonlySet<string>; currentInstallSlug?: string | null } = {},
): StalePausedRoutine[] {
  const generalMs = opts.generalMs ?? STALE_PAUSE_GENERAL_MS;
  const criticalMs = opts.criticalMs ?? STALE_PAUSE_CRITICAL_MS;
  const decommissionedMs = opts.decommissionedMs ?? STALE_PAUSE_DECOMMISSIONED_MS;
  const criticalNames = opts.criticalNames ?? RELEASE_CRITICAL_ROUTINE_NAMES;
  const alwaysOnNames = opts.alwaysOnNames ?? ALWAYS_ON_SYSTEM_ROUTINE_NAMES;
  const out: StalePausedRoutine[] = [];
  for (const r of rows) {
    // isReleaseCriticalNamed drives the THRESHOLD (a release routine deserves the
    // shorter fuse regardless of whose install it's on); `critical` (the field that
    // escalates liveness-alarm severity to `blocker`) additionally requires the
    // install to match — see the doc comment above.
    const isReleaseCriticalNamed = criticalNames.has(r.name);
    const installKnown = opts.currentInstallSlug != null && r.installSlug != null;
    const installMatches = !installKnown || r.installSlug === opts.currentInstallSlug;
    const critical = isReleaseCriticalNamed && installMatches;
    const backlogDepth = Math.max(0, r.backlogDepth ?? 0);
    const hasBacklog = backlogDepth > 0;
    const backlogField = hasBacklog ? { backlogDepth } : {};
    const reasonMissing = r.pausedAtMs == null || !r.pauseReason;
    const anchorMs = r.pausedAtMs ?? r.updatedAtMs ?? null;
    if (anchorMs == null) {
      // No timestamp readable at all — can't judge decommissioned-vs-paused, so err
      // toward still flagging (the pre-existing, unchanged behavior for this case).
      out.push({ name: r.name, ageMs: Number.POSITIVE_INFINITY, reasonMissing: true, critical, alwaysOnUnreaffirmed: false, ...backlogField });
      continue;
    }
    const ageMs = Math.max(0, now - anchorMs);
    // EI-18137248342636257: an always-on system routine outruns the decommissioned cutoff
    // unless someone has RE-AFFIRMED the pause. isReaffirmed fails closed, so a missing or
    // unparseable reviewBy keeps the row reported rather than silently exempting it.
    const alwaysOnUnreaffirmed = alwaysOnNames.has(r.name) && !isReaffirmed(r.pauseReviewBy ?? null, now);
    const decommissioned = ageMs >= decommissionedMs;
    if (!critical && !alwaysOnUnreaffirmed && !hasBacklog && decommissioned) continue; // decommissioned, not a live stale-pause signal (critical + unreaffirmed always-on rows are NEVER exempted this way — see doc comment)
    const threshold = isReleaseCriticalNamed ? criticalMs : generalMs;
    if (reasonMissing || hasBacklog || ageMs >= threshold) {
      out.push({ name: r.name, ageMs, reasonMissing, critical, alwaysOnUnreaffirmed: alwaysOnUnreaffirmed && decommissioned, ...backlogField });
    }
  }
  // Critical first (the symptom that matters most), then oldest first within each group.
  return out.sort((a, b) => (a.critical !== b.critical ? (a.critical ? -1 : 1) : b.ageMs - a.ageMs));
}

/** DB-reading wrapper (thin — the logic lives in the pure split above). Mirrors
 *  readDeadRoutines's shape/placement but queries the COMPLEMENT (active=false).
 *  `currentInstallSlug` (EI-18694769501553335) is this health-check's OWN install
 *  (e.g. `ctx.potSlug`) — passed through so `critical` only fires for a stale pause
 *  on THIS install's own release routine, not any sibling hive's / throwaway repro
 *  harness's paused copy of a same-named routine.
 *
 *  EI-18718973731535914: two more root causes, fixed at the SQL layer (a fake-sql unit
 *  test can't prove these — see the paired integration test):
 *   1. `workspaceId` (e.g. `ctx.ws`) scopes the scan to the LIVE workspace/tenant — the
 *      same bare-filter multi-tenant trap `dev:pg_query`'s own advisory warns about
 *      (a filter with no workspace predicate can match another tenant's rows and read
 *      as stale/diverged state that has nothing to do with this install).
 *   2. A `NOT EXISTS` sibling check excludes an inactive row when an ACTIVE row already
 *      exists for the same (workspace, install_slug, name) — i.e. judge a named routine
 *      by whether ANY live row for it is firing on schedule, not by the mere presence of
 *      an inactive row. Without this, one orphaned/duplicate dead row (left behind by a
 *      reseed, or belonging to a decommissioned install with a recycled slug) can outvote
 *      every one of its healthy, currently-firing siblings and false-alarm a live pipeline. */
export async function readStalePausedRoutines(sql: Sql, currentInstallSlug?: string | null, workspaceId?: string | null): Promise<StalePausedRoutine[]> {
  const rows = await sql<Array<{ name: string; metadata: Record<string, unknown> | null; updated_at: Date | null; install_slug: string | null; backlog_depth: number | null }>>`
    SELECT r.name, r.metadata, r.updated_at, r.install_slug,
           CASE WHEN r.name = 'acceptance-grading-sweep' THEN (
             SELECT count(*)::int
               FROM harness_shared.harness_plans p
              WHERE p.workspace_id = r.workspace_id
                AND p.status = 'awaiting-acceptance'
                AND p.template IS DISTINCT FROM 'rubric'
                AND p.archived = FALSE
           ) ELSE NULL END AS backlog_depth
      FROM harness_shared.routines r
     WHERE r.active = false
       AND (${workspaceId ?? null}::text IS NULL OR r.workspace_id = ${workspaceId ?? null})
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.routines r2
          WHERE r2.active = true
            AND r2.name = r.name
            AND r2.workspace_id = r.workspace_id
            AND r2.install_slug IS NOT DISTINCT FROM r.install_slug
       )`;
  const inputs: StalePausedRoutineInput[] = rows.map((r) => {
    const pause = (r.metadata?.pause ?? null) as { reason?: unknown; pausedAtMs?: unknown; reviewBy?: unknown } | null;
    const pausedAtMs = typeof pause?.pausedAtMs === 'number' ? pause.pausedAtMs : null;
    const pauseReason = typeof pause?.reason === 'string' && pause.reason.length > 0 ? pause.reason : null;
    const pauseReviewBy = typeof pause?.reviewBy === 'string' && pause.reviewBy.length > 0 ? pause.reviewBy : null;
    return {
      name: r.name,
      pausedAtMs,
      pauseReason,
      pauseReviewBy,
      updatedAtMs: r.updated_at ? new Date(r.updated_at).getTime() : null,
      installSlug: r.install_slug,
      backlogDepth: r.backlog_depth,
    };
  });
  return computeStalePausedRoutines(inputs, Date.now(), { currentInstallSlug });
}

/** P-027: one bounded projection for the drained acceptance carry ledger. The
 * plan row is the population; an active keyed acceptance filing is the driver.
 * A left join keeps "no active driver" visible instead of allowing the plan to
 * disappear when a filing was never created or was prematurely closed. */
/** WI-10002538: the LATERAL probe runs once per awaiting-acceptance plan, so it
 *  MUST be index-served (migration 1199, work_items_acceptance_drain_plan_idx).
 *  Without it every probe seq-scanned work_items: 223 plans x 225k rows kept one
 *  instance running 86.9s on the tower. The `IS NOT NULL` line restates the partial
 *  index's predicate. The planner already proves it from the strict equality below
 *  (EXPLAIN-probed 2026-09-23), so the line is belt-and-braces; what actually pins
 *  index service is acceptance-drain-visibility.integration.test.ts, which EXPLAINs
 *  this exported text against migration 1199. $1 = workspace id. */
export const ACCEPTANCE_DRAIN_VISIBILITY_SQL = `
    SELECT count(*)::text AS awaiting,
           count(*) FILTER (WHERE d.feature_id IS NOT NULL)::text AS with_driver,
           count(*) FILTER (WHERE d.feature_id IS NULL)::text AS without_driver,
           count(*) FILTER (WHERE d.payload->>'escalation' = 'due')::text AS escalated,
           min(p.updated_at) AS oldest_plan_updated_at
      FROM harness_shared.harness_plans p
      LEFT JOIN LATERAL (
        SELECT wi.feature_id, wi.payload
          FROM harness_shared.work_items wi
         WHERE wi.workspace_id = p.workspace_id
           AND (wi.payload->>'acceptanceDrainPlan') IS NOT NULL
           AND wi.payload->>'acceptanceDrainPlan' = (p.workspace_id || '/' || p.harness_slug || '/' || p.plan_slug)
           AND wi.status = ANY(ARRAY['open','todo','wip','in_progress','blocked','needs-human','validating','failing'])
         ORDER BY wi.created_ts, wi.feature_id
         LIMIT 1
      ) d ON TRUE
     WHERE p.workspace_id = $1
       AND p.status = 'awaiting-acceptance'
       AND p.template IS DISTINCT FROM 'rubric'
       AND p.archived = FALSE`;

export async function readAcceptanceDrainVisibility(sql: Sql, workspaceId: string): Promise<NonNullable<WorkFeedHealth['acceptanceDrain']>> {
  const rows = await sql.unsafe<Array<{
    awaiting: string;
    with_driver: string;
    without_driver: string;
    escalated: string;
    oldest_plan_updated_at: Date | null;
  }>>(ACCEPTANCE_DRAIN_VISIBILITY_SQL, [workspaceId]);
  const row = rows[0];
  return {
    awaiting: Number(row?.awaiting ?? 0),
    withDriver: Number(row?.with_driver ?? 0),
    withoutDriver: Number(row?.without_driver ?? 0),
    escalated: Number(row?.escalated ?? 0),
    oldestPlanUpdatedAt: row?.oldest_plan_updated_at ? new Date(row.oldest_plan_updated_at).toISOString() : null,
  };
}

/** The minimal ScoredItem projection this split needs (pure/unit-testable). */
export interface AutoEligibleStuckInput {
  attempts?: number;
  watchdogKey?: string;
}

/**
 * Pure (EI-14223): split the auto-eligible, attempts:0 (never-dispatched) queue
 * into the genuine KEYED dispatcher-stuck signal (`autoEligibleStuck`) vs the
 * KEYLESS human-review backlog (`keylessHumanReviewBacklog`). A keyless item
 * (no `payload.watchdogKey`) is never auto-dispatched by design (P-014), so
 * sitting at attempts:0 is expected steady-state for it, not a feed-pumping
 * stall — bundling it into `autoEligibleStuck` inflated that metric with the
 * ~5,600-item un-managed backlog and made it read as a permanently-growing
 * trend, mis-triggering `@role:mug` nudges over a by-design condition Mug
 * cannot act on.
 */
export function splitAutoEligibleStuck(autoEligible: AutoEligibleStuckInput[]): {
  autoEligibleStuck: number;
  keylessHumanReviewBacklog: number;
} {
  let autoEligibleStuck = 0;
  let keylessHumanReviewBacklog = 0;
  for (const i of autoEligible) {
    if ((i.attempts ?? 0) !== 0) continue;
    if (i.watchdogKey) autoEligibleStuck += 1;
    else keylessHumanReviewBacklog += 1;
  }
  return { autoEligibleStuck, keylessHumanReviewBacklog };
}

async function collectWorkFeed(ctx: HealthCtx): Promise<HealthPanel<WorkFeedHealth>> {
  return panelSafe<WorkFeedHealth>('workFeed', async () => {
    const { ws, potSlug } = ctx;
    let frontier = 0, frontierStuck = 0, frontierBlocked = 0, startedPlans = 0;
    // The catch below must RECORD that it fired — same rule the stale-paused read
    // 20-odd lines down states ("unreadable ≠ clear"), which this read violated.
    // Here it is load-bearing rather than cosmetic: `cupPlaceableFrontier`
    // (frontier − frontierStuck) is the leg that DECIDES beesIdleDecision, so a
    // fabricated 0 reads as "no cup work waiting" and SUPPRESSES the bees-dead
    // alarm. A broken survey would silently buy silence about zero running bees.
    let frontierUnreadable = false;
    if (potSlug) {
      try {
        // K1 (workspace-scoped-coordination P-003 / D-002): the ONE central-dispatcher
        // Queen's work-feed spans ALL the workspace's hives when WORKSPACE_COORDINATION
        // is ON — so the Health/Overwatch work-feed counts the cross-hive backlog, not
        // one representative hive. OFF (the dark default) ⇒ the single-hive surveyPot,
        // byte-identical to today.
        const { isWorkspaceCoordinationOn } = await import('../workspace-brain-scope');
        if (await isWorkspaceCoordinationOn()) {
          const { surveyWorkspace } = await import('../pot/survey');
          const ws_survey = await surveyWorkspace(ws, { fallbackHome: potSlug });
          frontier = ws_survey.crossPot.frontier.length;
          frontierStuck = countStuckFrontier(ws_survey.crossPot.frontier);
          frontierBlocked = ws_survey.crossPot.frontierBlocked;
          startedPlans = ws_survey.crossPot.plans.length;
        } else {
          const { surveyPot } = await import('../pot/survey');
          const survey = await surveyPot(ws, potSlug);
          frontier = survey.frontier.length;
          frontierStuck = countStuckFrontier(survey.frontier);
          frontierBlocked = survey.frontierBlocked;
          startedPlans = survey.plans.length;
        }
      } catch {
        /* survey unreadable — leave zeros, dead-routine signal still computes — but
           FLAG it, so downstream can tell a fabricated 0 from an observed 0. */
        frontierUnreadable = true;
      }
    }
    // Dead routines (EI-584): active CRON/rrule routines whose next_fire_at is long
    // overdue — the routinesTick that should claim+fire them isn't, so the feed
    // starves. EI-11797: PURE loop routines are excluded (see readDeadRoutines) —
    // a healthy running fleet loop legitimately sits briefly overdue and must not
    // mis-fire the engine-starvation crit + fleet blocker page.
    const { sql } = getOrgPg();
    // WI-4310: widen the overdue window while a green-checkpoint run's known, self-recovering
    // resource footprint is active or just finished — see resolveDeadRoutineOverdueMs's doc
    // comment. Fail-soft: any probe error keeps the tight base threshold (never suppresses).
    // EI-20258981691947730: the RELEASE install, not the Queen panel's potSlug — see
    // releaseInstallSlug() for why passing potSlug read this install as 'sb-devboard-hive'.
    const deadRoutineOverdueMs = await resolveDeadRoutineOverdueMs(sql, releaseInstallSlug(), ctx.now);
    const deadCensus = await readDeadRoutines(sql, deadRoutineOverdueMs, ctx.ws);
    const deadRoutineNames = deadCensus.names;
    // WI-5839 / EI-18654017982759582 items 2+3: stale/unexplained PAUSED routines —
    // the complement readDeadRoutines can never see (it only looks at active=true).
    // Best-effort/fail-soft: never let a metadata-shape surprise sink the whole panel.
    // EI-19462267124852221: the catch must RECORD that it fired. Leaving `stalePaused`
    // empty is correct for the panel (one metadata-shape surprise must not sink it), but
    // an empty array is indistinguishable from a genuine zero — and downstream the
    // liveness alarm reads "no signal firing" as "condition recovered" and auto-resolves
    // the open escalation. That conflation is the whole defect: unreadable ≠ clear.
    let stalePaused: StalePausedRoutine[] = [];
    let stalePausedUnreadable = false;
    try {
      stalePaused = await readStalePausedRoutines(sql, releaseInstallSlug(), ctx.ws);
    } catch {
      stalePausedUnreadable = true; /* leave empty — the dead-routine signal above still computes */
    }
    const stalePausedRoutineNames = stalePaused.map((r) => r.name);
    const stalePausedCriticalRoutines = stalePaused.filter((r) => r.critical).length;
    const stalePausedBacklogDepth = stalePaused.reduce(
      (total, routine) => total + (routine.backlogDepth ?? 0),
      0,
    );
    const stalePausedBacklogRoutines = stalePaused.filter((routine) => (routine.backlogDepth ?? 0) > 0).length;
    // Auto-eligible-stuck (EI-584): KEYED improvements that ARE auto-eligible but
    // sit at attempts:0 — eligible yet never dispatched (the feed isn't pumping
    // them). EI-14223: split off the KEYLESS human-review backlog (attempts:0 by
    // design, never a feed-pumping signal) via splitAutoEligibleStuck, so it can
    // never inflate this metric into a false growing-trend alarm. Read the same
    // digest collectImprovements uses; independent + fail-soft (leave 0s).
    let autoEligibleStuck = 0;
    let keylessHumanReviewBacklog = 0;
    try {
      const { buildDigest } = await import('../harness/improvements/digest');
      // P-008: the SHARED per-tick read (see HealthCtx.openImprovements) — collectImprovements
      // needs the identical rows, and this tick must not pay for them twice.
      const items = await ctx.openImprovements();
      // P-001/P-003: this panel reads only digest.autoEligible (a scalar rollup) —
      // it never touches likelyDuplicates, so skip the O(n²) near-dup pass the
      // health tick was paying for and discarding outright (D-001).
      const digest = buildDigest(items, { nowMs: ctx.now, nearDuplicates: false });
      ({ autoEligibleStuck, keylessHumanReviewBacklog } = splitAutoEligibleStuck(digest.autoEligible));
    } catch { /* improvements unreadable — leave 0s (the dead-routine signal still computes) */ }
    let acceptanceDrain: WorkFeedHealth['acceptanceDrain'] | undefined;
    try {
      acceptanceDrain = await readAcceptanceDrainVisibility(sql, ws);
    } catch {
      // The work-feed panel remains usable when this additive visibility leg is
      // unavailable; omission is explicit and never treated as an empty queue.
      acceptanceDrain = undefined;
    }
    const data: WorkFeedHealth = {
      frontier, frontierStuck, frontierBlocked, startedPlans, autoEligibleStuck,
      // EI-20045691451471399: the TRUE overdue count, not `deadRoutineNames.length` — the names
      // are a capped display list, and reading their length as the count is what reported a
      // 101-routine freeze as "20 dead routine(s)".
      keylessHumanReviewBacklog, deadRoutines: deadCensus.count, deadRoutineNames,
      deadRoutinesInScope: deadCensus.totalInScope,
      deadRoutinesDistinct: deadCensus.distinctCount,
      deadRoutineCriticalNames: deadCensus.criticalNames,
      deadRoutineCoverage: deadCensus.routineCoverage,
      ...(deadCensus.namesTruncated ? { deadRoutineNamesTruncated: true } : {}),
      stalePausedRoutines: stalePaused.length, stalePausedRoutineNames, stalePausedCriticalRoutines,
      ...(stalePausedBacklogRoutines > 0 ? { stalePausedBacklogRoutines } : {}),
      ...(stalePausedBacklogDepth > 0 ? { stalePausedBacklogDepth } : {}),
      ...(stalePausedUnreadable ? { stalePausedRoutinesUnreadable: true } : {}),
      ...(frontierUnreadable ? { frontierUnreadable: true } : {}),
      ...(acceptanceDrain ? { acceptanceDrain } : {}),
    };
    const status = workFeedStatus(data);
    return {
      status,
      summary: data.deadRoutines > 0
        ? `DEAD ROUTINE(S) ${data.deadRoutines}/${deadCensus.totalInScope}: ${deadRoutineNames.slice(0, 3).join(', ')}${deadCensus.count > 3 ? ', …' : ''}`
        : stalePausedCriticalRoutines > 0
          ? `STALE PAUSE on release-critical routine(s): ${stalePausedRoutineNames.slice(0, 3).join(', ')} — deploy pipeline may be silently stopped`
          : `${frontier} ready${frontierStuck > 0 ? ` (${frontierStuck} long-stuck/gated)` : ''}, ${frontierBlocked} blocked, ${startedPlans} started plan(s)${autoEligibleStuck > 0 ? `, ${autoEligibleStuck} auto-stuck` : ''}${keylessHumanReviewBacklog > 0 ? `, ${keylessHumanReviewBacklog} keyless human-review` : ''}${stalePaused.length > 0 ? `, ${stalePaused.length} stale-paused routine(s): ${stalePausedRoutineNames.slice(0, 3).join(', ')}` : ''}${stalePausedUnreadable ? ', paused routine/backlog unreadable' : stalePausedBacklogDepth > 0 ? `, paused acceptance backlog ${stalePausedBacklogDepth}` : ''}${acceptanceDrain ? `, acceptance carry ${acceptanceDrain.awaiting} (${acceptanceDrain.withoutDriver} without active driver${acceptanceDrain.escalated > 0 ? `, ${acceptanceDrain.escalated} escalated` : ''})` : ''}`,
      data,
      link: { label: 'Work', href: '/adv?tab=harnesses' },
      metrics: [
        m('frontier', frontier),
        m('stuck', frontierStuck),
        m('blocked', frontierBlocked),
        m('started plans', startedPlans),
        m('auto-stuck', autoEligibleStuck, autoEligibleStuck > 0 ? 'warn' : undefined),
        m('keyless human-review', keylessHumanReviewBacklog),
        m('dead routines', data.deadRoutines, data.deadRoutines > 0 ? 'crit' : undefined),
        m('stale-paused routines', stalePaused.length, stalePausedCriticalRoutines > 0 ? 'crit' : stalePaused.length > 0 ? 'warn' : undefined),
        m('paused acceptance backlog', stalePausedUnreadable ? 'unreadable' : stalePausedBacklogDepth, stalePausedBacklogDepth > 0 ? 'warn' : undefined),
        ...(acceptanceDrain ? [
          m('acceptance awaiting', acceptanceDrain.awaiting),
          m('acceptance without driver', acceptanceDrain.withoutDriver, acceptanceDrain.withoutDriver > 0 ? 'warn' : undefined),
          m('acceptance escalated', acceptanceDrain.escalated, acceptanceDrain.escalated > 0 ? 'warn' : undefined),
        ] : []),
      ],
    };
  });
}

/**
 * "Available" for the tokens/starvation panel means CAN ACTUALLY SERVE NOW — mirroring
 * `accountStatus()`'s `available` (WI-3310), not merely "not rate-paused". A weekly-usage-walled
 * account (`accountFull`'s 5h/7d `effectiveDrainUtil` check) can read pause-CLEAR — its bounded
 * pause lapsed, or a pause was never set — while still being unable to serve a single request
 * until its usage window resets. Counting such an account as "idle healthy unused" is exactly
 * what fabricated a false "artificial ceiling" admission-starvation escalation to the owner on
 * 2026-07-18 (EI-15875): 5 accounts sitting at util7d 0.97-0.99 read as spare capacity, while the
 * queue was actually starved by a genuine weekly usage wall — raising the concurrency ceiling
 * (the escalation's proposed fix) would only have admitted more requests that then failed over
 * across already-walled accounts.
 *
 * `accountFull` folds in BOTH the rate-limit pause and the 5h/7d usage-wall (its own JSDoc: "Is
 * this account effectively FULL for fresh load"). A live Cloudflare/per-IP edge-throttle cooldown
 * is a THIRD, separate non-servable state the gateway reports out-of-band (never persisted on
 * `a.rate`, only visible via `gatewayStatsRaw.edgeThrottleByAccount`), so it is excluded here too.
 * Pure — same `splitAutoEligibleStuck` / `tallyPlans` testable-helper shape as this file's other
 * collectors' decision logic.
 */
export function computeAccountsAvailable(
  accounts: readonly ClaudeAccount[],
  gatewayStatsRaw: RawGatewayStats | null,
  now: number,
): { accountsTotal: number; accountsAvailable: number; accountsPaused: number } {
  const accountsTotal = accounts.length;
  const accountsAvailable = accounts.filter((a) => {
    if (accountFull(a, now)) return false;
    if (projectLiveEdgeThrottle(a.id, gatewayStatsRaw).edgeThrottled) return false;
    return true;
  }).length;
  return { accountsTotal, accountsAvailable, accountsPaused: accountsTotal - accountsAvailable };
}

/**
 * How long since the gateway landed ANY usage-window write, i.e. the age of the FRESHEST
 * `rate.utilizationAt` in the pool (EI-19303809952284205). null when no account has ever been
 * observed — a fresh pool is not a fault.
 *
 * FRESHEST, not oldest, and that choice is the whole point. Per-account staleness is normal and
 * benign: an account whose egress proxy is transport-failing simply receives no traffic, so its
 * reading ages while the write path is perfectly healthy (observed live 2026-08-01 — ownerhandle10 sat
 * on an 18:26Z reading for exactly that reason). Taking the max would alarm on that every time.
 * What is NOT normal is nothing anywhere moving: that is the write path itself being dead, which is
 * the condition this exists to catch.
 *
 * Pure — same testable-helper shape as `computeAccountsAvailable` above.
 */
export function computeProjectionFreshestAgeMs(accounts: readonly ClaudeAccount[], now: number): number | null {
  let freshest: number | null = null;
  for (const a of accounts) {
    const at = a.rate?.utilizationAt;
    if (typeof at !== 'number') continue;
    if (freshest === null || at > freshest) freshest = at;
  }
  return freshest === null ? null : Math.max(0, now - freshest);
}

async function collectTokens(ctx: HealthCtx): Promise<HealthPanel<TokensHealth>> {
  return panelSafe<TokensHealth>('tokens', async () => {
    const { buildFleetRateStatus } = await import('../fleet-rate-status');
    const rate = await buildFleetRateStatus(WINDOW_MS);
    const pausedBuckets = rate.buckets.filter((b) => b.paused).length;
    // Gateway-internal wedge/throttle metrics (B-GW-5): read the gateway's OWN /stats (admission
    // queue + AIMD state) and run the wedge detector. Makes the watchdog's silent auto-restart
    // signature VISIBLE. Fetched FIRST (not just for the wedge card): the raw snapshot is also the
    // ONLY source of live per-account edge-throttle signals (never persisted on `a.rate`), needed
    // below to compute account availability correctly (EI-15875). Only when the gateway is in the
    // egress path AND reachable; fail-soft to null (greyed) otherwise — never blanks the panel.
    let gateway: TokensHealth['gateway'] = null;
    let gatewayStatsRaw: RawGatewayStats | null = null;
    if (ctx.gatewayEnabled && ctx.gatewayReachable) {
      try {
        const { fetchGatewayStatsRaw } = await import('../inference-gateway/observability');
        const { summarizeGatewayMetrics } = await import('../inference-gateway/gateway-wedge');
        const { readGatewayWedge } = await import('./gateway-sample-cache');
        gatewayStatsRaw = await fetchGatewayStatsRaw();
        if (gatewayStatsRaw) {
          const gm = summarizeGatewayMetrics(gatewayStatsRaw);
          const v = readGatewayWedge(gm, ctx.now);
          gateway = {
            inFlight: gm.inFlight, queueDepth: gm.queueDepth, maxConcurrent: gm.maxConcurrent,
            concurrencyCap: gm.concurrencyCap, shed429: gm.shed429, shedAllThrottled: gm.shedAllThrottled,
            failovers: gm.failovers, upstream429: gm.upstream429, utilizationPct: gm.utilizationPct,
            aimdEffective: gm.aimdEffective, aimdCap: gm.aimdCap,
            wedge: v.wedge, saturated: v.saturated, sustainedThrottle: v.sustainedThrottle, slotLeak: v.slotLeak,
            admissionStarvationRisk: v.admissionStarvationRisk, admissionStarved: v.admissionStarved,
            reasons: v.reasons,
          };
        }
      } catch { /* /stats unreadable — leave gateway null (greyed), panel still renders */ }
    }
    let accountsTotal = 0, accountsAvailable = 0, accountsPaused = 0;
    let poolProjectionFreshestAgeMs: number | null = null;
    try {
      const { loadAccountPool } = await import('../deployment/account-pool-store');
      const pool = await loadAccountPool(ctx.ws);
      ({ accountsTotal, accountsAvailable, accountsPaused } =
        computeAccountsAvailable(pool.accounts, gatewayStatsRaw, ctx.now));
      // EI-19303809952284205: the independent leg — how long since the gateway landed ANY
      // usage-window write. Read here because we already have the pool in hand.
      poolProjectionFreshestAgeMs = computeProjectionFreshestAgeMs(pool.accounts, ctx.now);
    } catch { /* no account pool configured — single bound credential */ }
    // EI-19303809952284205: the gateway's own durable-path verdict. `undefined` on a gateway build
    // that predates the field stays null = UNKNOWN, never healthy.
    const rawDb = gatewayStatsRaw?.db;
    const gatewayDb: TokensHealth['gatewayDb'] =
      rawDb && typeof rawDb.ok === 'boolean'
        ? {
            ok: rawDb.ok,
            connectionLevel: rawDb.connectionLevel === true,
            failingOps: rawDb.failingOps ?? [],
            unhealthyForMs: rawDb.unhealthyForMs ?? null,
            lastError: rawDb.lastError ?? null,
          }
        : null;
    const data: TokensHealth = {
      gatewayEnabled: ctx.gatewayEnabled,
      gatewayReachable: ctx.gatewayReachable,
      pausedBuckets, totalBuckets: rate.buckets.length,
      fleetInFlight: rate.fleet.inFlight, fleetCap: rate.fleet.cap,
      spendUsd: rate.usage.spendUsd, windowMs: rate.usage.windowMs,
      accountsTotal, accountsAvailable, accountsPaused,
      gateway,
      gatewayDb,
      poolProjectionFreshestAgeMs,
    };
    const status = tokensStatus(data);
    const spend = `$${data.spendUsd.toFixed(2)}`;
    // The gateway wedge/throttle takes the headline summary when present (the loud signal).
    const starvationCrit = gateway?.admissionStarved && accountsAvailable > ADMISSION_STARVATION_IDLE_ACCOUNTS_MIN;
    const gwSummary = gateway?.wedge
      ? `GATEWAY WEDGED — ${gateway.reasons[0] ?? `inFlight ${gateway.inFlight}/${gateway.maxConcurrent}`} (watchdog auto-restarts)`
      : starvationCrit
      // WI-3565: name the exact lever (matches the manual mitigation that resolved the 2026-07-09 incident)
      // so an agent reading this panel doesn't have to re-derive it.
      ? `ADMISSION STARVED — ${gateway!.queueDepth} queued at ceiling ${gateway!.maxConcurrent} for ≥5min with ${accountsAvailable} idle healthy account(s) — raise the floor: operator:rate_limit_config { providerFloors: { anthropic: { maxConcurrent: <higher> } } }`
      : gateway?.slotLeak
      ? `gateway SLOT LEAK — ${gateway.reasons.find((r) => r.includes('slot-leak')) ?? 'a held admission slot the self-heal valve cannot reclaim'}`
      : gateway?.sustainedThrottle
        ? `gateway throttling — ${gateway.reasons.find((r) => r.includes('AIMD') || r.includes('throttled')) ?? gateway.reasons[0] ?? 'sustained upstream 429s'}`
        : gateway?.saturated
          ? `gateway saturated — inFlight ${gateway.inFlight}/${gateway.maxConcurrent}, ${gateway.queueDepth} queued`
          : gateway?.admissionStarvationRisk
            ? `gateway admission backlog deep vs ceiling — ${gateway.reasons.find((r) => r.includes('starvation risk')) ?? `${gateway.queueDepth} queued at ${gateway.maxConcurrent}`} (watching for sustain)`
            : null;
    return {
      status,
      summary: status === 'crit'
        ? (gateway?.wedge || starvationCrit
            ? gwSummary!
            : (accountsTotal > 0 && accountsAvailable === 0 ? 'all accounts paused — starved' : 'gateway unreachable'))
        : gwSummary
          ?? `${data.fleetInFlight}/${data.fleetCap} in flight, ${spend}/${Math.round(data.windowMs / 60000)}m${pausedBuckets > 0 ? `, ${pausedBuckets} paused bucket(s)` : ''}`,
      data,
      link: { label: 'rate-governor', href: '/adv?tab=overview' },
      metrics: [
        m('in flight', `${data.fleetInFlight}/${data.fleetCap}`),
        m('paused buckets', pausedBuckets, pausedBuckets > 0 ? 'warn' : undefined),
        m('gateway', ctx.gatewayEnabled ? (ctx.gatewayReachable ? 'up' : 'down') : 'direct', ctx.gatewayEnabled && ctx.gatewayReachable === false ? 'crit' : undefined),
        ...(gateway ? [
          m('gw queue', `${gateway.inFlight}/${gateway.maxConcurrent}+${gateway.queueDepth}`, gateway.wedge ? 'crit' : gateway.saturated ? 'warn' : undefined),
          ...(gateway.wedge ? [m('WEDGE', 'yes', 'crit')]
            : gateway.sustainedThrottle ? [m('throttle', 'sustained', 'warn')] : []),
          ...(gateway.slotLeak ? [m('slot leak', 'yes', 'warn')] : []),
          ...(gateway.admissionStarved ? [m('starved', 'yes', starvationCrit ? 'crit' : 'warn')]
            : gateway.admissionStarvationRisk ? [m('starving?', 'watching', 'warn')] : []),
          ...(gateway.shed429 + gateway.shedAllThrottled > 0 ? [m('shed', gateway.shed429 + gateway.shedAllThrottled, 'warn')] : []),
          ...(gateway.failovers > 0 ? [m('failovers', gateway.failovers)] : []),
        ] : []),
        m('accounts', accountsTotal > 0 ? `${accountsAvailable}/${accountsTotal}` : 'n/a', accountsTotal > 0 && accountsAvailable === 0 ? 'crit' : undefined),
        m('spend', spend),
      ],
    };
  });
}

async function collectWatchdog(ctx: HealthCtx): Promise<HealthPanel<WatchdogHealth>> {
  return panelSafe<WatchdogHealth>('watchdog', async () => {
    const { ws, potSlug, now } = ctx;
    let fires24h = 0, livenessArmed = false, staleForMs: number | null = null;
    if (potSlug) {
      const { sql } = getOrgPg();
      const { potLivenessCheck, recentWatchdogFires } = await import('../pot/watchdog');
      const [live, fires] = await Promise.all([
        potLivenessCheck(sql, potSlug, { workspaceId: ws, now }),
        recentWatchdogFires(ws, potSlug).catch(() => 0),
      ]);
      fires24h = fires;
      livenessArmed = live.armed;
      staleForMs = live.staleForMs;
    }
    let recentErrors = 0;
    try {
      const { listToasts } = await import('../toast-log-data');
      const { toasts } = await listToasts({ limit: 200 });
      recentErrors = toasts.filter((t) => t.level === 'error' && now - t.createdAt < 24 * 60 * 60_000).length;
    } catch { /* toast log unavailable */ }
    const data: WatchdogHealth = { fires24h, livenessArmed, staleForMs, recentErrors };
    const status = watchdogStatus(data);
    return {
      status,
      summary: `${fires24h} fallback wake(s)/24h, ${recentErrors} error notif(s), ${livenessArmed ? 'armed' : 'unarmed'}`,
      data,
      link: { label: 'notifications', href: '/adv?tab=overview' },
      metrics: [
        m('fallback wakes', fires24h, fires24h >= 3 ? 'warn' : undefined),
        m('error notifs', recentErrors, recentErrors > 0 ? 'warn' : undefined),
        m('liveness', livenessArmed ? 'armed' : 'unarmed'),
      ],
    };
  });
}

export async function collectDeploy(ctx: HealthCtx): Promise<HealthPanel<DeployHealth>> {
  return panelSafe<DeployHealth>('deploy', async () => {
    const { devDeployState } = await import('../dev-deploy-state');
    const s = await devDeployState();
    // git-sync UPSTREAM delivery (EI-18): the worst active `system:git-sync` routine's
    // last push outcome. The deploy refs above are blind to a FAILING push — new local
    // commits keep landing so `lastCommitAtMs` stays fresh — so read the metadata
    // git-sync-action.ts persists. Fail-soft: leave the delivery fields at safe
    // defaults (never-crit) when the routine metadata is unreadable.
    let gitSyncStatus: DeployHealth['gitSyncStatus'] = null;
    let gitSyncConsecutiveErrorTicks = 0;
    let gitSyncPushBacklog: number | null = null;
    let gitSyncLastSyncedAtMs: number | null = null;
    let gitSyncOversizedCount = 0;
    let gitSyncWorstInstallSlug: string | null = null;
    let gitSyncFailingLeg: DeployHealth['gitSyncFailingLeg'] = null;
    let gitSyncMaxMissedIntervals: number | null = null;
    let gitSyncMissedIntervalsInstallSlug: string | null = null;
    let gitSyncMissedIntervalsUnreadable = false;
    try {
      const { sql } = getOrgPg();
      const { deriveGitSyncFreshness } = await import('../agent-tools/routines/list');
      const rows = await sql<Array<GitSyncRoutineRead & { install_slug: string }>>`
        SELECT install_slug, trigger_config, metadata FROM harness_shared.routines
         WHERE target_role = 'system:git-sync' AND active = true AND workspace_id = ${ctx.ws}`;
      for (const r of rows) {
        const md = (r.metadata ?? {}) as Record<string, unknown>;
        const derived = deriveSystemHealthGitSyncStatus(r, ctx.now, deriveGitSyncFreshness);
        const rawEt = Number(md.consecutive_error_ticks ?? 0) || 0;
        const backlog = rawEt > 0 ? await liveGitSyncPushBacklog(r.install_slug) : null;
        if (backlog !== null) gitSyncPushBacklog = Math.max(gitSyncPushBacklog ?? 0, backlog);
        const et = backlog === 0 ? 0 : rawEt;
        // worst-wins: the most-failing routine drives the panel status.
        if (
          gitSyncStatus === null ||
          et > gitSyncConsecutiveErrorTicks ||
          (et === gitSyncConsecutiveErrorTicks && derived.status === 'degraded' && gitSyncStatus !== 'degraded')
        ) {
          gitSyncStatus = derived.status;
          gitSyncConsecutiveErrorTicks = et;
          // EI-19275994927087666: carry WHOSE failure won worst-wins and WHICH leg
          // failed. Guard on et > 0 — the `gitSyncStatus === null` arm above also
          // fires for the FIRST row even when it is perfectly healthy, so attributing
          // unconditionally would name an innocent install as the offender.
          gitSyncWorstInstallSlug = et > 0 ? r.install_slug : null;
          gitSyncFailingLeg =
            et > 0
              ? classifyGitSyncFailingLeg(
                  typeof md.last_error === 'string' ? md.last_error : null,
                  typeof md.push_mode === 'string' ? md.push_mode : null,
                )
              : null;
        }
        const ls =
          typeof derived.freshness.last_synced_at === 'number'
            ? derived.freshness.last_synced_at
            : typeof derived.freshness.last_synced_at === 'string'
              ? Date.parse(derived.freshness.last_synced_at)
              : NaN;
        if (!Number.isNaN(ls) && (gitSyncLastSyncedAtMs === null || ls > gitSyncLastSyncedAtMs)) gitSyncLastSyncedAtMs = ls;
        if (Array.isArray(md.last_oversized)) gitSyncOversizedCount += md.last_oversized.length;
        // P-009 (ex-P-010): cadence-relative starvation. A failing install is excluded because
        // the push-failure escalation already owns it; this measure is for 'not firing at all'.
        const missed = typeof derived.freshness.missed_intervals === 'number' ? derived.freshness.missed_intervals : null;
        const lastStatus = typeof md.last_status === 'string' ? md.last_status : null;
        if (
          missed !== null &&
          lastStatus !== 'error' &&
          lastStatus !== 'conflict' &&
          (gitSyncMaxMissedIntervals === null || missed > gitSyncMaxMissedIntervals)
        ) {
          gitSyncMaxMissedIntervals = missed;
          gitSyncMissedIntervalsInstallSlug = r.install_slug;
        }
      }
    } catch {
      /* routine metadata unreadable — leave git-sync delivery fields at defaults */
      gitSyncMissedIntervalsUnreadable = true;
    }
    // WI-1258129: every ref above is a GIT position; none can see a long-lived
    // process still executing pre-deploy code. bg-host's systemd ActiveEnterTimestamp
    // is the ground truth for when it last (re)started — reused from the scout
    // generation-watermark module (WI-5397) rather than re-deriving it here.
    // Best-effort and fail-toward-not-proven-fresh: any unresolvable input leaves
    // `bgHostCodeStale` NULL (unknown), never false, so an unreadable host cannot
    // render a false all-clear.
    let bgHostStartedAtMs: number | null = null;
    try {
      const { readBgHostActiveEnterMs } = await import('../scout/generation-watermark');
      bgHostStartedAtMs = await readBgHostActiveEnterMs();
    } catch {
      /* systemd/unit unreadable — stays null, reported as unknown */
    }
    const bgHostCodeStale =
      bgHostStartedAtMs !== null && s.deployedAtMs !== null ? bgHostStartedAtMs < s.deployedAtMs : null;
    const data: DeployHealth = {
      deployedShortSha: s.deployed?.shortSha ?? null,
      deployedBehindStaging: s.deployedBehindStaging,
      greenPinBehindStaging: s.greenPinBehindStaging,
      deployedBehindGreenPin: s.deployedBehindGreenPin,
      greenPinAtStagingHead: s.greenPinAtStagingHead,
      deployedAtMs: s.deployedAtMs,
      lastCommitAtMs: s.stagingHead?.committedAtMs ?? null,
      errors: s.errors,
      gitSyncStatus,
      gitSyncConsecutiveErrorTicks,
      gitSyncPushBacklog,
      gitSyncLastSyncedAtMs,
      gitSyncOversizedCount,
      gitSyncWorstInstallSlug,
      gitSyncFailingLeg,
      gitSyncMaxMissedIntervals,
      gitSyncMissedIntervalsInstallSlug,
      gitSyncMissedIntervalsUnreadable,
      bgHostStartedAtMs,
      bgHostCodeStale,
    };
    const status = deployStatus(data, ctx.now);
    // EI-19275994927087666: a crit here means SOME git-sync leg is failing on SOME
    // install — not that a push failed, and not that it was this workspace's primary
    // pot. The old comment here claimed "deployStatus reds ONLY on git-sync
    // push-failure", which is false and is what the summary below was built on.
    const syncFailing = status === 'crit';
    const syncMetricTone: PanelStatus | undefined =
      syncFailing ||
      data.gitSyncStatus === 'degraded' ||
      data.gitSyncStatus === 'quarantined' ||
      data.gitSyncOversizedCount > 0
        ? syncFailing ? 'crit' : 'warn'
        : undefined;
    return {
      status,
      summary: syncFailing
        ? `git-sync FAILING ${data.gitSyncConsecutiveErrorTicks} ticks on ` +
          `${data.gitSyncWorstInstallSlug ?? 'an unnamed install'} — ${gitSyncLegPhrase(data.gitSyncFailingLeg)}`
        : status === 'unknown'
        ? 'release refs unreadable on this host'
        : `live ${data.deployedShortSha ?? '?'}, ${data.deployedBehindStaging ?? '?'} behind staging, sync ${agoMin(data.lastCommitAtMs, ctx.now)}`,
      data,
      link: { label: '/admin/git', href: '/admin/git' },
      metrics: [
        m('behind live', data.deployedBehindStaging ?? '?', (data.deployedBehindStaging ?? 0) > 80 ? 'warn' : undefined),
        m('not-green', data.greenPinBehindStaging ?? '?'),
        m('last sync', agoMin(data.lastCommitAtMs, ctx.now)),
        m('green tip', data.greenPinAtStagingHead === null ? '?' : data.greenPinAtStagingHead ? 'yes' : 'no'),
        // Label is 'git-sync', not 'git-sync push' — the metric covers every leg.
        m('git-sync', syncFailing ? `${data.gitSyncFailingLeg ?? 'error'} FAILING ${data.gitSyncConsecutiveErrorTicks}t` : data.gitSyncPushBacklog === 0 ? 'caught up' : (data.gitSyncStatus ?? 'n/a'), syncMetricTone),
        m('failing install', data.gitSyncWorstInstallSlug ?? '—'),
        // WI-1258129: names WHY the panel warned. '?' is a real reading (host
        // unreadable = not proven fresh), deliberately distinct from 'restarted'.
        m(
          'bg-host code',
          data.bgHostCodeStale === null ? '?' : data.bgHostCodeStale ? 'PRE-DEPLOY' : 'restarted',
          data.bgHostCodeStale === true ? 'warn' : undefined,
        ),
      ],
    };
  });
}

/**
 * WI-7160: this collector fans out to several `git` execs per health tick
 * (fetch + 2× rev-parse/rev-list PER repo/submodule via {@link gitAheadCount}),
 * and a live profile attributed 20.8% of a stalled main thread's spawn time to
 * it. `fork()`'s parent-side cost scales with the PARENT's RSS and is charged
 * as synchronous main-thread system time (EI-18808838427010743) — the exact
 * mechanism `git-via-sidecar.ts` exists to remove by routing the exec through
 * a small long-lived sidecar process instead. `dev-deploy-state.ts`'s `git()`
 * already does this for the sibling git-heavy health source (same profile,
 * 79% of spawn time); this mirrors that pattern (own explicit opt-in var, same
 * shared primitives — reuse-first, not a new implementation) rather than
 * leaving this call site as the one with NO offload option at all.
 *
 * Falls back to a local spawn on ANY sidecar problem (unset flag, unreachable,
 * a real git error) — a sidecar fault degrades performance, never correctness.
 */
export function systemHealthGitSidecarEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return gitSidecarEnabled('PAPERCUSP_SYSTEM_HEALTH_SPAWN_SIDECAR', env);
}

/** A REAL non-zero git exit (not a sidecar fault) — must not trigger a local retry. */
class SystemHealthGitExitError extends Error {}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const argv = ['-C', cwd, ...args];
  if (systemHealthGitSidecarEnabled()) {
    try {
      const r = await runGitViaSpawnerSidecar(argv, process.cwd(), 10_000, process.env);
      if (r.code !== 0) {
        throw new SystemHealthGitExitError(`git ${argv.join(' ')} exited ${r.code}: ${r.stderr.trim()}`);
      }
      return r.stdout.trim();
    } catch (e) {
      // A non-zero git exit is a REAL result, not a sidecar fault — rethrow it
      // rather than counting it as one and re-running locally.
      if (e instanceof SystemHealthGitExitError) throw e;
      noteSidecarFallback('system-health', e);
    }
  }
  const { stdout } = await execFileP('git', argv, { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 });
  return String(stdout).trim();
}

async function gitAheadCount(cwd: string): Promise<number | null> {
  try {
    await runGit(cwd, ['fetch', '--quiet']);
    const upstream = await runGit(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
    if (!upstream) return null;
    const out = await runGit(cwd, ['rev-list', '--count', `${upstream}..HEAD`]);
    const n = Number(out);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function gitSubmodulePaths(repoRoot: string): Promise<string[]> {
  try {
    const out = await runGit(repoRoot, ['config', '--file', '.gitmodules', '--get-regexp', 'path']);
    return out.split('\n').map((line) => line.trim().split(/\s+/)[1]).filter(Boolean);
  } catch {
    return [];
  }
}

async function liveGitSyncPushBacklog(slug: string): Promise<number | null> {
  try {
    const { projectDirForSlug } = await import('../operator-notes');
    const repoRoot = await projectDirForSlug(slug);
    if (!repoRoot) return null;
    const rootAhead = await gitAheadCount(repoRoot);
    if (rootAhead === null) return null;
    let total = rootAhead;
    for (const rel of await gitSubmodulePaths(repoRoot)) {
      const ahead = await gitAheadCount(`${repoRoot}/${rel}`);
      if (ahead === null) return null;
      total += ahead;
    }
    return total;
  } catch {
    return null;
  }
}

/**
 * PURE: tally plan-index rows into PlansHealth. `startedDraft` = plans force-STARTED
 * while still DRAFT — the queen-plan-selection anti-pattern the rubric flags ("does not
 * force-start a draft"). Surfaced so the Overwatch can rate queen-plan-selection instead
 * of 'unknown' (hive-loop-supervision 2026-06-21).
 */
export function tallyPlans(
  rows: ReadonlyArray<{
    archived?: boolean | null;
    status?: string | null;
    opStatus?: string | null;
    opUpdatedAt?: string | number | Date | null;
    items?: ReadonlyArray<{ status?: string | null }> | null;
  }>,
  nowMs: number,
  staleMs: number = PLAN_STALE_MS,
): PlansHealth {
  let active = 0, started = 0, shipped = 0, draft = 0, itemsDone = 0, itemsTotal = 0, stalledPlans = 0, startedDraft = 0;
  for (const r of rows) {
    if (r.archived) continue;
    if (r.status === 'active') active++;
    if (r.status === 'shipped') shipped++;
    if (r.status === 'draft') draft++;
    if (r.opStatus === 'started') {
      started++;
      if (r.status === 'draft') startedDraft++;
      const upd = r.opUpdatedAt ? new Date(r.opUpdatedAt).getTime() : 0;
      if (upd > 0 && nowMs - upd > staleMs) stalledPlans++;
    }
    for (const it of r.items ?? []) {
      if (it.status === 'done') { itemsDone++; itemsTotal++; }
      else if (['todo', 'wip', 'blocked', 'needs-human'].includes(it.status ?? '')) itemsTotal++;
    }
  }
  return { active, started, shipped, draft, itemsDone, itemsTotal, stalledPlans, startedDraft };
}

async function collectPlans(ctx: HealthCtx): Promise<HealthPanel<PlansHealth>> {
  return panelSafe<PlansHealth>('plans', async () => {
    const { listPlanIndexRowsCached } = await import('../agent-tools/plans/index-cache');
    const rows = await listPlanIndexRowsCached({ workspaceId: ctx.ws });
    const data = tallyPlans(rows, ctx.now);
    const status = plansStatus(data);
    return {
      status,
      summary: `${data.started} started, ${data.active} active, ${data.itemsDone}/${data.itemsTotal} items${data.stalledPlans > 0 ? `, ${data.stalledPlans} stalled` : ''}${data.startedDraft > 0 ? `, ${data.startedDraft} force-started DRAFT` : ''}`,
      data,
      link: { label: 'Create', href: '/adv?tab=plans' },
      metrics: [
        m('started', data.started),
        m('active', data.active),
        m('items', `${data.itemsDone}/${data.itemsTotal}`),
        m('stalled', data.stalledPlans, data.stalledPlans > 0 ? 'warn' : undefined),
        m('force-started draft', data.startedDraft, data.startedDraft > 0 ? 'warn' : undefined),
      ],
    };
  });
}

async function collectEscalations(ctx: HealthCtx): Promise<HealthPanel<EscalationsHealth>> {
  return panelSafe<EscalationsHealth>('escalations', async () => {
    const { listEscalations } = await import('../agent-tools/coordination/escalations');
    const open = await listEscalations({ status: 'open' });
    // EI-1490: human-attention escalations only — the operational flood
    // (placement-watchdog cursed placements / aging sweeps) is excluded so the
    // panel/`aging` count reflects real open decisions, not the ~13k auto-GC'd
    // duplicates of the placements.cursed metric.
    const data = computeEscalationsHealth(open, ctx.now);
    const { open: openCount, oldestAgeMs, bySeverity, aging, agingNew } = data;
    const oldest = oldestAgeMs === null ? null : ctx.now - oldestAgeMs;
    const standing = aging - agingNew;
    const status = escalationsStatus(data);
    return {
      status,
      summary: openCount === 0
        ? 'no open escalations'
        : `${openCount} open${agingNew > 0 ? `, ${agingNew} newly aging` : ''}${standing > 0 ? `, ${standing} standing` : ''}, oldest ${agoMin(oldest, ctx.now)}`,
      data,
      link: { label: 'Needs you', href: '/adv?tab=plans' },
      metrics: [
        m('open', openCount, openCount > 0 ? 'warn' : undefined),
        m('blockers', bySeverity.blocker ?? 0, (bySeverity.blocker ?? 0) > 0 ? 'warn' : undefined),
        m('new aging', agingNew, agingNew > 0 ? 'warn' : undefined),
        m('standing', standing, standing > 0 ? 'unknown' : undefined),
        m('oldest', agoMin(oldest, ctx.now)),
      ],
    };
  });
}

async function collectAutonomy(ctx: HealthCtx): Promise<HealthPanel<AutonomyHealth>> {
  return panelSafe<AutonomyHealth>('autonomy', async () => {
    const { sql } = getOrgPg();
    const { readAutonomyPolicy } = await import('../autonomy/policy-store');
    const policy = await readAutonomyPolicy(sql, ctx.ws);
    const byCeiling: Record<string, number> = {};
    let locked = 0;
    for (const p of policy) {
      // The owner-set ceiling (the cap) is the heatmap's cell; the locked count
      // captures the "nothing auto-runs here" categories separately.
      byCeiling[p.ceiling] = (byCeiling[p.ceiling] ?? 0) + 1;
      if (p.locked) locked++;
    }
    let tripwiresArmed = 0, tripwiresTripped = 0, tripwiresReverted = 0;
    try {
      const { listRecentTripwires } = await import('../autonomy/tripwire/store');
      const tw = await listRecentTripwires(sql, ctx.ws, { limit: 200 });
      for (const t of tw) {
        if (t.status === 'armed') tripwiresArmed++;
        else if (t.status === 'tripped') tripwiresTripped++;
        else if (t.status === 'reverted') tripwiresReverted++;
      }
    } catch { /* tripwire table not yet present */ }
    const data: AutonomyHealth = {
      categories: policy.length, locked, byCeiling, tripwiresArmed, tripwiresTripped, tripwiresReverted,
    };
    const status = autonomyStatus(data);
    return {
      status,
      summary: `${policy.length} categories, ${locked} locked, ${tripwiresArmed} armed${tripwiresTripped > 0 ? `, ${tripwiresTripped} tripped` : ''}`,
      data,
      link: { label: 'Autonomy', href: '/settings/autonomy' },
      metrics: [
        m('categories', policy.length),
        m('locked', locked),
        m('armed', tripwiresArmed),
        m('tripped', tripwiresTripped, tripwiresTripped > 0 ? 'warn' : undefined),
      ],
    };
  });
}

/**
 * The attributable ROLE of an observation row, for the brief's per-role panel.
 * Reads the filer role stamped at capture (payload.filedByRole, close-observation-
 * attribution-gap 2026-06-21), then the narrow sourceRole, then the signal origin,
 * else 'unknown'. Pure (testable without PG). PRIOR BUG: the panel read
 * `it.sourceRole ?? it.origin` — NEITHER field exists on an EngineerIssue row (it
 * carries `payload` + `signalOrigin`), so every observation bucketed as 'unknown',
 * blinding the per-role rubric criteria.
 */
export function observationRole(it: {
  payload?: unknown;
  sourceRole?: string | null;
  signalOrigin?: string | null;
}): string {
  const p = it.payload && typeof it.payload === 'object' ? (it.payload as Record<string, unknown>) : undefined;
  const filed = p?.filedByRole;
  if (typeof filed === 'string' && filed) return filed;
  if (it.sourceRole) return it.sourceRole;
  if (it.signalOrigin) return it.signalOrigin;
  return 'unknown';
}

async function collectObservations(ctx: HealthCtx): Promise<HealthPanel<ObservationsHealth>> {
  return panelSafe<ObservationsHealth>('observations', async () => {
    const { listIssues, countIssues } = await import('../issues-engineer');
    // P-006/D-031: select the observation population by the `lane` COLUMN, not the
    // topic join — the join is fenced to coordScopeWorkspace() and under-reads it.
    const { OBSERVATION_LANE } = await import('../harness/improvements/read-items');
    const filter = { lane: OBSERVATION_LANE, state: 'open' as const };
    // P-002 (health-tab-v2): the TRUE open count — the old read reported the
    // sampled list length, which silently PINNED at the 500 cap.
    const [items, total] = await Promise.all([
      listIssues({ ...filter, limit: 500 }) as Promise<Array<{
        createdAt?: string; payload?: unknown; sourceRole?: string | null; signalOrigin?: string | null;
      }>>,
      countIssues(filter),
    ]);
    const recentByRole: Record<string, number> = {};
    let newestAt: number | null = null;
    for (const it of items) {
      const role = observationRole(it);
      recentByRole[role] = (recentByRole[role] ?? 0) + 1;
      const t = it.createdAt ? new Date(it.createdAt).getTime() : NaN;
      if (Number.isFinite(t) && (newestAt === null || t > newestAt)) newestAt = t;
    }
    const laneCount = Math.max(total, items.length);
    const sampled = laneCount > items.length;
    const data: ObservationsHealth = { laneCount, sampled, recentByRole, newestAt };
    const roles = Object.entries(recentByRole).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([r, n]) => `${r}:${n}${sampled ? '*' : ''}`).join(', ');
    return {
      status: 'ok',
      summary: laneCount === 0 ? 'no open observations' : `${laneCount} open${roles ? ` (${roles})` : ''}, newest ${agoMin(newestAt, ctx.now)}`,
      data,
      link: { label: 'Learning', href: '/adv?tab=learning' },
      metrics: [
        m('open', laneCount),
        m('newest', agoMin(newestAt, ctx.now)),
        m('roles', Object.keys(recentByRole).length),
      ],
    };
  });
}

async function collectImprovements(ctx: HealthCtx): Promise<HealthPanel<ImprovementsHealth>> {
  return panelSafe<ImprovementsHealth>('improvements', async () => {
    const { buildDigest } = await import('../harness/improvements/digest');
    const { readOwnerFullAutonomyGrant } = await import('../harness/improvements/full-autonomy-grant');
    // P-008: the SHARED per-tick read (see HealthCtx.openImprovements) — collectWorkFeed's
    // auto-eligible-stuck rollup needs the identical rows. Only the buildDigest OPTIONS
    // differ between the two (ownerFullAutonomy here), so the rows are shared, not the digest.
    const items = await ctx.openImprovements();
    // The OWNER FULL-AUTONOMY grant (Phase 2): keep the auto/human rollup counts honest —
    // when the grant is on, protected-surface bugs move into the auto lane.
    const ownerFullAutonomy = await readOwnerFullAutonomyGrant(ctx.ws);
    // P-001/P-003: this panel reads only scalar rollups (open, autoEligible.length,
    // humanQueue.length, byKind, bySeverity) — it never touches likelyDuplicates, so
    // skip the O(n²) near-dup pass the health tick was paying for and discarding
    // outright (D-001).
    const digest = buildDigest(items, { nowMs: ctx.now, ownerFullAutonomy, nearDuplicates: false });
    const data: ImprovementsHealth = {
      open: digest.window.open,
      autoEligible: digest.autoEligible.length,
      humanQueue: digest.humanQueue.length,
      byKind: digest.window.byKind,
      bySeverity: digest.window.bySeverity,
    };
    const status = improvementsStatus(data);
    return {
      status,
      summary: `${data.open} open — ${data.autoEligible} auto, ${data.humanQueue} human`,
      data,
      link: { label: 'Learning', href: '/adv?tab=learning' },
      metrics: [
        m('open', data.open),
        m('auto', data.autoEligible),
        m('human', data.humanQueue),
      ],
    };
  });
}

async function collectInfra(ctx: HealthCtx): Promise<HealthPanel<InfraHealth>> {
  return panelSafe<InfraHealth>('infra', async () => {
    let pg: InfraHealth['pg'] = null;
    let pool: InfraHealth['pool'] = null;
    try {
      const { pgHealth } = await import('../dev-data');
      const { classifyPoolPressure } = await import('../dbos/pool-pressure');
      // Pool-starvation fold (P-006/W4): time pgHealth()'s own round-trip — it acquires
      // a connection + runs two pg_stat_activity aggregates, so its latency is a real (if
      // coarse) proxy for org-pool acquisition pressure, observed from THIS process (a
      // request worker) against the shared PG server (cross-process-safe; no new query).
      const t0 = Date.now();
      const h = await pgHealth();
      const probeMs = Date.now() - t0;
      pg = { version: h.version, total: h.totalConnections, active: h.activeConnections, idle: h.idleConnections, postmasterStartMs: h.postmasterStartMs };
      // Bands are LOOSER than the tick's SELECT-1 probe because this query is heavier:
      // elevated ≥1.5s, critical ≥4s (a healthy pgHealth returns in tens of ms).
      pool = { probeMs, band: classifyPoolPressure(probeMs, 1500, 4000) };
    } catch { /* PG unreadable — collector still returns (gateway leg) */ }
    // Fresh host-pressure evidence from the resource-governor monitor. The reader
    // validates the atomic snapshot and rejects missing, malformed, future, or
    // stale files; the pure detector then preserves unknown signal states rather
    // than turning them into healthy zeroes.
    let hostPressure: InfraHealth['hostPressure'] = null;
    try {
      const { readLiveHealthSnapshot } = await import('../resource-governor/live-health-monitor');
      const snapshot = await readLiveHealthSnapshot(undefined, ctx.now);
      hostPressure = evaluateHostPressure(hostPressureSampleFromLiveHealth(snapshot), ctx.now);
    } catch { /* live-health unavailable — leave this optional leg absent */ }
    // Per-thread perf-SLO verdict from Lane E's latest perf-signals-v1 capture (F1/
    // P-030). Fail-soft: no capture / E1 not running on this box ⇒ perf null ⇒ infra
    // behaves exactly as before. Per-thread budgets (worker CPU%, event-loop lag,
    // CLOSE_WAIT, reachability) — NEVER loadavg-absolute (128-core box; D-002 reframe).
    let perf: InfraHealth['perf'] = null;
    try {
      const { readLatestPerfSignals, evaluatePerfSignals } = await import('./perf-budgets');
      const sig = await readLatestPerfSignals();
      if (sig) {
        // EI-12302: suppress the operator-unreachable crit when it's a sanctioned
        // deploy restart, not a real wedge — deploy.ts's withDrain holds the
        // 'dev-server' resource lock exclusive for the whole restart window, so
        // "currently held" IS the deploy-in-progress signal (reuse, don't invent a
        // new deploy-state marker). Fail-soft: an unreadable lock store just means
        // no suppression (the crit still pages — never silently swallow a real one).
        let deployInProgress = false;
        try {
          const { getTxPool, readResourceQueue } = await import('../agent-tools/locks/su-lock-store');
          // EI-18676514870990022: 'dev-server' is a HOST-GLOBAL resource
          // (HOST_GLOBAL_RESOURCES) — deploy-deps.ts's withDrain acquires it
          // under the fixed hostGlobalLockDomain(), not the caller-tree-scoped
          // lockCoordinationDomain() this used to read. Reading the wrong domain
          // here silently reports `holders: []` during a genuine deploy (the
          // exact EI-18674647773291145 Defect 2 symptom), producing a false
          // operator-unreachable crit instead of suppressing it.
          const { resourceLockDomain } = await import('../agent-tools/locks/coordination-domain');
          const { holders } = await readResourceQueue(getTxPool(), {
            coordinationDomain: resourceLockDomain('dev-server'),
            resource: 'dev-server',
          });
          deployInProgress = holders.some((h) => h.mode === 'exclusive');
        } catch { /* lock store unreadable — do not suppress */ }
        perf = evaluatePerfSignals(sig, ctx.now, undefined, deployInProgress);
      }
    } catch { /* perf-signals unreadable — leave null */ }
    // This reader runs even when the sampling routine has stopped. Reuse Infra's
    // existing status/metrics surface instead of relying on a producer-side log.
    const { readPerfRegressionProducerHealth } = await import('./perf-regression-rig');
    const performanceHistory = await readPerfRegressionProducerHealth(ctx.ws);
    // MCP tool-call-transport SLO (W8/P-008): read the resilient MCP proxy's failure
    // ledger tail and summarize the windowed hard/soft failure counts. Fail-soft — an
    // unreadable ledger leaves mcpProxy null (greyed leg), an absent ledger is a healthy
    // zero. Makes the previously-invisible connection-level MCP failures (stale-socket
    // 400s, deploy-window drops, post-connect errors) a first-class page-on-regression.
    let mcpProxy: InfraHealth['mcpProxy'] = null;
    try {
      const { readMcpProxyFailureTail, summarizeMcpProxyHealth } = await import('./mcp-proxy-health');
      const recs = readMcpProxyFailureTail();
      if (recs !== null) mcpProxy = summarizeMcpProxyHealth(recs, ctx.now);
    } catch { /* proxy ledger unreadable — leave null (fail-soft) */ }
    // Disk pressure (health-tab-v2 P-011 — the fedplane script's 90% signal,
    // in-process): used% on ~/.papercusp + the working tree, deduped by device.
    let disk: InfraHealth['disk'] = null;
    try {
      const raw = await readDiskPressure();
      if (raw) {
        // EI-19944041837110102 (disk-alarm-flap): classify each volume's band WITH
        // hysteresis against ITS OWN band from the previous tick (matched by path — a
        // path can drop out/appear between ticks, e.g. the working-tree cwd, so this is
        // a lookup, not a positional zip). `cache` (declared below in this file) is the
        // SAME in-process previous-snapshot store `runSystemHealthTickUncached` already
        // reads as `prev` for its own edge-detection (see the infra-crit incident-capture
        // trigger a few lines below in that function) — reusing it here keeps this at the
        // same level of cross-tick rigor already trusted elsewhere in this file, with no
        // new migration/table. A cold tick host hydrates its local cache from the prior
        // shared snapshot in runSystemHealthTickUncached, so a worker restart or a
        // different tick host does not discard the previous band and turn 94↔95 boundary
        // noise back into a recovery/re-fire pair. If the shared snapshot is unavailable,
        // the cold start still falls back to a plain threshold check (see
        // `diskBandWithHysteresis`'s `prevBand: null` case) rather than inventing state.
        const prevDisk = cache.get(ctx.ws)?.panels?.infra?.data?.disk ?? null;
        disk = raw.map((v) => {
          const prevBand = prevDisk?.find((p) => p.path === v.path)?.band ?? null;
          return { ...v, band: diskBandWithHysteresis(v.usedPct, prevBand) };
        });
      }
    } catch { /* statfs unavailable — leave null */ }
    // Backup freshness (P-011): newest snapshot whose Kopia artifact AND
    // pre-snapshot database dump are explicitly known-good + last outcome.
    let backup: InfraHealth['backup'] = null;
    try {
      const { sql } = getOrgPg();
      const [ok, last] = await Promise.all([
        // NB: this client returns timestamptz as ISO STRINGS and rejects Date
        // params — always .toISOString() in, new Date(row) out (loops-panel
        // "Received an instance of Date" incident, 2026-07-12).
        sql<Array<{ finished_at: string }>>`
          SELECT finished_at FROM harness_shared.backup_snapshots
           WHERE workspace_id = ${ctx.ws}
             AND status = 'ok'
             AND kopia_snapshot_id IS NOT NULL
             AND db_dump_ok IS TRUE
             AND finished_at IS NOT NULL
           ORDER BY finished_at DESC LIMIT 1`,
        sql<Array<{ status: string; db_dump_ok: boolean | null }>>`
          SELECT status, db_dump_ok FROM harness_shared.backup_snapshots
           WHERE workspace_id = ${ctx.ws}
           ORDER BY started_at DESC LIMIT 1`,
      ]);
      const lastOkAtMs = ok[0]?.finished_at ? new Date(ok[0].finished_at).getTime() : null;
      backup = {
        lastOkAtMs,
        ageMs: lastOkAtMs === null ? null : ctx.now - lastOkAtMs,
        lastStatus: last[0]?.status ?? null,
        lastDbDumpOk: typeof last[0]?.db_dump_ok === 'boolean' ? last[0].db_dump_ok : null,
      };
    } catch { /* backup tables unreadable/absent — leave null */ }
    // Per-tool HANDLER failure rate (EI-18798264517111160) — the write-path outage
    // detector. mcpProxy above covers the transport; this covers the tool's own work.
    // Deliberately computed INLINE rather than via the derived-reads substrate the
    // toolEfficiency panel uses: those aggregates scan 7-14d and are precomputed for
    // cost, whereas this is a 15-min index-only range scan on
    // tool_invocations_invoked_at_cov_idx — cheap enough to run every tick, and a
    // snapshot TTL would add exactly the detection latency this exists to remove.
    // Fail-soft: unreadable ⇒ null (greyed leg), never blanks the panel.
    let toolFailures: InfraHealth['toolFailures'] = null;
    try {
      const { readToolFailureRate, gradeToolFailures } = await import('../tool-failure-rate');
      const { sql } = getOrgPg();
      const roll = await readToolFailureRate(
        async <T = unknown>(q: string, params: unknown[]): Promise<T[]> =>
          (await sql.unsafe(q, params as never)) as unknown as T[],
        { workspaceId: ctx.ws },
      );
      const grade = gradeToolFailures(roll);
      toolFailures = {
        rating: grade.rating,
        evidence: grade.evidence,
        brokenTools: grade.brokenTools,
        windowMin: roll.windowMin,
        worstPct: roll.failing[0]?.failPct ?? null,
        totalCalls: roll.totalCalls,
      };
    } catch { /* tool_invocations unreadable — leave null (fail-soft) */ }
    // Migration drift (P-011): on-disk migrations the live DB hasn't applied.
    let migrationDrift: InfraHealth['migrationDrift'] = null;
    try {
      const { checkMigrationDrift } = await import('../migration-drift');
      const d = await checkMigrationDrift();
      migrationDrift = { unapplied: d.missing.length };
    } catch { /* drift unreadable — leave null */ }
    const data: InfraHealth = {
      pg,
      gatewayReachable: ctx.gatewayReachable,
      hostPressure,
      perf,
      performanceHistory,
      mcpProxy,
      pool,
      disk,
      backup,
      migrationDrift,
      toolFailures,
    };
    const status = infraStatus(data);
    const perfCrit = perf?.status === 'crit';
    const toolsCrit = toolFailures?.rating === 'broken';
    const mcpHard = mcpProxy?.hardFailures ?? 0;
    const mcpCrit = mcpHard >= MCP_PROXY_HARD_FAIL_CRIT;
    const mcpQueueStalls = mcpProxy?.criticalContinuationQueueStalls ?? 0;
    const mcpQueueCrit = mcpQueueStalls > 0;
    const mcpWarn = mcpHard > 0 && !mcpCrit;
    const worstDisk = disk && disk.length > 0 ? Math.max(...disk.map((v) => v.usedPct)) : null;
    const hostPressureTone =
      hostPressure?.status === 'crit' ? 'crit' : hostPressure?.status === 'warn' ? 'warn' : undefined;
    return {
      status,
      summary: infraSummary(data, ctx.gatewayEnabled),
      data,
      link: { label: 'Tests', href: '/adv?tab=testing' },
      metrics: [
        m('pg conns', pg ? `${pg.active}/${pg.total}` : '?', pg === null ? 'unknown' : undefined),
        m('pg pool', pool ? (pool.band === 'ok' ? `${pool.probeMs}ms` : `${pool.band} (${pool.probeMs}ms)`) : 'n/a', pool?.band === 'critical' ? 'warn' : undefined),
        m('gateway', ctx.gatewayEnabled ? (ctx.gatewayReachable ? 'up' : 'down') : 'direct', ctx.gatewayEnabled && ctx.gatewayReachable === false ? 'crit' : undefined),
        m('mcp-proxy', mcpProxy ? (mcpQueueCrit ? `${mcpQueueStalls} critical continuation wait(s) ≥${MCP_PROXY_CRITICAL_CONTINUATION_WAIT_CRIT_MS / 60_000}m observed in the last hour (max ${Math.round(mcpProxy.criticalContinuationQueueMaxWaitMs / 1000)}s)` : mcpHard > 0 ? `${mcpHard} fail/1h` : (mcpProxy.recovered > 0 ? `ok (${mcpProxy.recovered} recov)` : 'ok')) : 'n/a', mcpCrit || mcpQueueCrit ? 'crit' : mcpWarn ? 'warn' : undefined),
        m('worker cpu', perf?.worstWorkerCpuPct != null ? `${Math.round(perf.worstWorkerCpuPct)}%` : 'n/a'),
        m('host', perf ? (perf.stale ? 'stale' : (perf.hostState ?? '?')) : 'n/a', perfCrit ? 'crit' : (perf?.status === 'warn' ? 'warn' : undefined)),
        m('host pressure', hostPressure?.status ?? 'n/a', hostPressureTone),
        m('performance history', performanceHistory.note,
          performanceHistory.status === 'disabled' ? undefined : performanceHistory.status),
        m('disk', worstDisk === null ? 'n/a' : `${worstDisk}%`, worstDisk === null ? undefined : worstDisk >= DISK_USED_CRIT_PCT ? 'crit' : worstDisk >= DISK_USED_WARN_PCT ? 'warn' : undefined),
        m(
          'backup',
          backup?.ageMs == null ? 'n/a' : agoMin(backup.lastOkAtMs, ctx.now),
          backup && (
            backup.lastDbDumpOk === false ||
            backup.lastStatus === 'degraded' ||
            backup.lastStatus === 'failed' ||
            (backup.ageMs !== null && backup.ageMs > 48 * 60 * 60_000)
          ) ? 'warn' : undefined,
        ),
        m('drift', migrationDrift ? migrationDrift.unapplied : 'n/a', (migrationDrift?.unapplied ?? 0) > 0 ? 'warn' : undefined),
        m(
          'tool failures',
          toolFailures == null || toolFailures.rating === 'unknown'
            ? 'n/a'
            : toolFailures.worstPct === null
              ? 'ok'
              : `${toolFailures.brokenTools[0] ?? toolFailures.evidence.split(' ')[0]} ${toolFailures.worstPct}%/${toolFailures.windowMin}m`,
          toolsCrit ? 'crit' : toolFailures?.rating === 'degraded' ? 'warn' : undefined,
        ),
        // EI-12302: surface a suppressed reachability crit instead of leaving it
        // silently invisible (per PerfVerdict.suppressedReasons's own contract) —
        // 'n/a' when nothing was suppressed this tick (the common case).
        ...(perf?.suppressedReasons?.length ? [m('deploy', 'in progress (suppressed unreachable)', undefined)] : []),
      ],
    };
  });
}

/** health-tab-v2 P-011: used% per watched volume (~/.papercusp, the working
 *  tree, and the process temp root), deduped by filesystem identity. The temp
 *  root matters because agent/tool output is written there and it can be a
 *  separate mount from the operator's home (as on the dev box, where /tmp is
 *  backed by /mnt/data). null when statfs is unavailable. */
export async function readDiskPressure(): Promise<Array<{ path: string; usedPct: number; freeGb: number }> | null> {
  const { statfs } = await import('node:fs/promises');
  const { homedir, tmpdir } = await import('node:os');
  const paths = [`${homedir()}/.papercusp`, process.cwd(), tmpdir()];
  const seen = new Set<string>();
  const out: Array<{ path: string; usedPct: number; freeGb: number }> = [];
  for (const p of paths) {
    try {
      const s = await statfs(p);
      const total = Number(s.blocks) * Number(s.bsize);
      if (!Number.isFinite(total) || total <= 0) continue;
      const free = Number(s.bavail) * Number(s.bsize);
      const fsKey = `${s.type}:${s.blocks}:${s.bfree}`; // same-device dedupe (coarse but effective)
      if (seen.has(fsKey)) continue;
      seen.add(fsKey);
      // freeGb: rounded DOWN (Math.floor) so the crit-summary's absolute-headroom check
      // (EI-19944041837110102) never rounds a near-empty disk up into looking safer.
      out.push({ path: p, usedPct: Math.round((1 - free / total) * 100), freeGb: Math.floor(free / 1024 ** 3) });
    } catch { /* path missing — skip */ }
  }
  return out.length > 0 ? out : null;
}

async function collectSuFleet(ctx: HealthCtx): Promise<HealthPanel<SuFleetHealth>> {
  return panelSafe<SuFleetHealth>('suFleet', async () => {
    const { listPresence } = await import('../agent-tools/coordination/presence');
    const presence = await listPresence({ workspaceId: ctx.ws });
    const live = presence.filter((p) => !p.stale).length;
    const byRole: Record<string, number> = {};
    for (const p of presence) {
      const role = p.agentRole ?? 'unknown';
      byRole[role] = (byRole[role] ?? 0) + 1;
    }
    const data: SuFleetHealth = { total: presence.length, live, stale: presence.length - live, byRole };
    return {
      status: 'ok',
      summary: `${presence.length} present, ${live} live`,
      data,
      link: { label: 'Work', href: '/adv?tab=harnesses' },
      metrics: [
        m('present', presence.length),
        m('live', live),
        m('stale', data.stale, data.stale > 0 ? 'warn' : undefined),
      ],
    };
  });
}

/**
 * Engine loops (health-tab-v2 P-008) — the `loop:arm` self-wake mechanism.
 * `armed` = active `loop-*` routines; `overdue` = armed loops whose next fire is
 * past the dead-routine window (the engine isn't firing them); `failureStreaks`
 * = RECENTLY-FIRED autoloop rows with >=3 consecutive errors (the fire-gate
 * about to pause them). autoloop_state accretes one row per historical loop
 * owner (~370 stale rows at v2 time), so ONLY rows fired in the last 24h count.
 */
async function collectLoops(ctx: HealthCtx): Promise<HealthPanel<LoopsHealth>> {
  return panelSafe<LoopsHealth>('loops', async () => {
    const { sql } = getOrgPg();
    // NB: timestamptz round-trips as ISO STRINGS on this client (a Date param
    // throws "Received an instance of Date") — string in, new Date(row) out.
    const [routines, streakRows, lastFireRows] = await Promise.all([
      sql<Array<{ name: string; next_fire_at: string | null }>>`
        SELECT name, next_fire_at FROM harness_shared.routines
         WHERE active = true AND name LIKE 'loop-%'`,
      sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM harness_shared.autoloop_state
         WHERE role LIKE 'loop-%'
           AND last_fired_at >= ${new Date(ctx.now - 24 * 60 * 60_000).toISOString()}
           AND consecutive_errors >= 3`,
      sql<Array<{ last: string | null }>>`
        SELECT max(last_fired_at) AS last FROM harness_shared.autoloop_state
         WHERE role LIKE 'loop-%'`,
    ]);
    const overdueRows = routines.filter(
      (r) => r.next_fire_at !== null && ctx.now - new Date(r.next_fire_at).getTime() > DEAD_ROUTINE_OVERDUE_MS,
    );
    const data: LoopsHealth = {
      armed: routines.length,
      overdue: overdueRows.length,
      overdueNames: overdueRows.slice(0, 5).map((r) => r.name),
      failureStreaks: streakRows[0]?.n ?? 0,
      lastFireAt: lastFireRows[0]?.last ? new Date(lastFireRows[0].last).getTime() : null,
    };
    const status = loopsStatus(data);
    return {
      status,
      summary: data.armed === 0
        ? 'no engine loops armed'
        : data.overdue > 0
          ? `${data.overdue}/${data.armed} armed loop(s) OVERDUE (${data.overdueNames.slice(0, 2).join(', ')})`
          : `${data.armed} armed, last fire ${agoMin(data.lastFireAt, ctx.now)}${data.failureStreaks > 0 ? `, ${data.failureStreaks} failure-streak` : ''}`,
      data,
      link: { label: 'Work', href: '/adv?tab=harnesses' },
      metrics: [
        m('armed', data.armed),
        m('overdue', data.overdue, data.overdue > 0 ? 'warn' : undefined),
        m('failure streaks', data.failureStreaks, data.failureStreaks > 0 ? 'warn' : undefined),
        m('last fire', agoMin(data.lastFireAt, ctx.now)),
      ],
    };
  });
}

/**
 * Coordination (health-tab-v2 P-009) — the fleet-coordination failure modes the
 * playbook ranks highest, previously visible only in coord:glance: unanswered
 * DIRECTED messages (a peer blind-waiting on a reply), sessions at critical
 * context (about to force-compact), no-expiry event-await waiters gone stale
 * (the sleeps-forever class), and fleets with live members but NO live leader
 * (the silent-mass-failure mode). REUSES the assignments decorator for the
 * unanswered read (D-C — never a second derivation).
 *
 * WI-4460 (deferred scope, now landed): also surfaces the claim-health smells
 * coord:glance derives — orphaned claims (dead holder), stalled claims (live
 * holder, no progress), coverage collisions (EI-6074: two principals on one
 * deliverable), and benched members (parked on a real events:await key —
 * idle-by-design, informational only).
 */
async function collectCoordination(ctx: HealthCtx): Promise<HealthPanel<CoordinationHealth>> {
  return panelSafe<CoordinationHealth>('coordination', async () => {
    const { listPresence } = await import('../agent-tools/coordination/presence');
    const presence = await listPresence({ workspaceId: ctx.ws });
    const live = presence.filter((p) => !p.stale);
    let highContext = 0;
    let criticalContext = 0;
    const fleets = new Map<string, { members: number; leaders: number }>();
    for (const p of live) {
      const row = p as unknown as {
        contextTokens?: number | null; compactionLimit?: number | null;
        fleetSlug?: string | null; fleetRole?: string | null;
      };
      const ct = row.contextTokens;
      const lim = row.compactionLimit;
      if (typeof ct === 'number' && typeof lim === 'number' && lim > 0) {
        const ratio = ct / lim;
        if (ratio >= 0.9) criticalContext += 1;
        else if (ratio >= 0.75) highContext += 1;
      }
      if (row.fleetSlug) {
        const f = fleets.get(row.fleetSlug) ?? { members: 0, leaders: 0 };
        f.members += 1;
        if (row.fleetRole === 'leader') f.leaders += 1;
        fleets.set(row.fleetSlug, f);
      }
    }
    // Unanswered DIRECTED messages — reuse the fleet-assignments decorator.
    let unansweredAgents = 0;
    let unansweredTotal = 0;
    let unansweredOldestMs: number | null = null;
    try {
      const { decorateUnansweredDirected } = await import('../agent-tools/fleet/assignments');
      const rows = live.map((p) => ({ agentId: (p as unknown as { ownerId: string }).ownerId }));
      await decorateUnansweredDirected(rows as unknown as Parameters<typeof decorateUnansweredDirected>[0]);
      for (const r of rows as Array<{ unanswered?: { count?: number; oldestAgeMs?: number | null } }>) {
        const u = r.unanswered;
        const count = u?.count ?? 0;
        if (count > 0) {
          unansweredAgents += 1;
          unansweredTotal += count;
          const oldest = u?.oldestAgeMs ?? null;
          if (oldest !== null && (unansweredOldestMs === null || oldest > unansweredOldestMs)) {
            unansweredOldestMs = oldest;
          }
        }
      }
    } catch { /* decorator unavailable — leave zeros (the other legs still compute) */ }
    // Claim-health (WI-4460, deferred scope from health-tab-v2): orphaned/stalled
    // claims + coverage collisions — the SAME derivations coord:glance /
    // fleet:assignments report (D-C: reuse the computer, never a second one).
    // Each leg fail-soft: a read hiccup leaves zeros, the panel still renders.
    let orphaned = 0;
    let stalledCount = 0;
    let collisionCount = 0;
    try {
      const fa = await import('../fleet/assignments');
      const claimRows = await fa.listFleetAssignments({ workspaceId: ctx.ws });
      orphaned = fa.orphanedClaims(claimRows).length;
      stalledCount = fa.stalledClaims(claimRows).length;
    } catch { /* claim read unavailable — leave zeros */ }
    try {
      const cov = await import('../plan-item-coverage');
      const covMap = await cov.getAllPlanItemCoverage();
      collisionCount = cov.coverageCollisions([...covMap.values()]).length;
    } catch { /* coverage read unavailable — leave zeros */ }
    // Benched members (idle-by-design): live sessions parked on a real (non-
    // inbox-wake, non-announce) events:await key — informational, never alarming.
    let parkedMembers = 0;
    try {
      const { listParkedAwaitsForSubscribers } = await import('../events/await/store');
      const ownerIds = live
        .map((p) => (p as unknown as { ownerId?: string }).ownerId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0);
      const parkedRows = await listParkedAwaitsForSubscribers(ownerIds);
      parkedMembers = new Set(parkedRows.map((r) => r.subscriberId)).size;
    } catch { /* awaits read unavailable — leave zero */ }
    const { sql } = getOrgPg();
    const awaitRows = await sql<Array<{ active: number; stale: number }>>`
      SELECT count(*)::int AS active,
             (count(*) FILTER (WHERE expires_ts IS NULL AND created_at < now() - interval '24 hours'))::int AS stale
        FROM harness_shared.event_awaits
       WHERE fired_at IS NULL AND cancelled_at IS NULL AND workspace_id = ${ctx.ws}`;
    const data: CoordinationHealth = {
      unansweredAgents,
      unansweredTotal,
      unansweredOldestMs,
      criticalContext,
      highContext,
      activeAwaits: awaitRows[0]?.active ?? 0,
      staleAwaits: awaitRows[0]?.stale ?? 0,
      leaderlessFleets: [...fleets.values()].filter((f) => f.leaders === 0).length,
      liveFleets: fleets.size,
      orphanedClaims: orphaned,
      stalledClaims: stalledCount,
      coverageCollisions: collisionCount,
      parkedMembers,
    };
    const status = coordinationStatus(data, ctx.now);
    const problems: string[] = [];
    if (data.unansweredTotal > 0) problems.push(`${data.unansweredTotal} unanswered directed (oldest ${agoMin(data.unansweredOldestMs === null ? null : ctx.now - data.unansweredOldestMs, ctx.now)})`);
    if (data.leaderlessFleets > 0) problems.push(`${data.leaderlessFleets} leaderless fleet(s)`);
    if (data.staleAwaits > 0) problems.push(`${data.staleAwaits} stale waiter(s)`);
    if (data.criticalContext > 0) problems.push(`${data.criticalContext} at critical context`);
    if (data.orphanedClaims > 0) problems.push(`${data.orphanedClaims} orphaned claim(s)`);
    if (data.stalledClaims > 0) problems.push(`${data.stalledClaims} stalled claim(s)`);
    if (data.coverageCollisions > 0) problems.push(`${data.coverageCollisions} coverage collision(s)`);
    return {
      status,
      summary: problems.length > 0 ? problems.join(', ') : `quiet — ${data.activeAwaits} parked waiter(s), ${data.parkedMembers} benched, ${data.liveFleets} live fleet(s)`,
      data,
      link: { label: 'Coord', href: '/coord' },
      metrics: [
        m('unanswered', data.unansweredTotal, data.unansweredTotal > 0 ? 'warn' : undefined),
        m('crit context', data.criticalContext, data.criticalContext > 0 ? 'warn' : undefined),
        m('stale waiters', data.staleAwaits, data.staleAwaits > 0 ? 'warn' : undefined),
        m('leaderless', data.leaderlessFleets, data.leaderlessFleets > 0 ? 'warn' : undefined),
        m('orphaned', data.orphanedClaims, data.orphanedClaims > 0 ? 'warn' : undefined),
        m('stalled', data.stalledClaims, data.stalledClaims > 0 ? 'warn' : undefined),
        m('collisions', data.coverageCollisions, data.coverageCollisions > 0 ? 'warn' : undefined),
        m('benched', data.parkedMembers),
        m('live fleets', data.liveFleets),
      ],
    };
  });
}

/**
 * Memory system (health-tab-v2 P-010) — folds the SAME readMemoryHealth the
 * Learning tab's MemoryHealthCard renders (D-C). The zero-hit probe is
 * defensive: RecallHealth's field layout has churned, so we accept any numeric
 * zero-hit reading it exposes and normalize to 0..1 (null when absent).
 */
async function collectMemory(ctx: HealthCtx): Promise<HealthPanel<MemoryPanelHealth>> {
  return panelSafe<MemoryPanelHealth>('memory', async () => {
    const { readMemoryHealth } = await import('../memory/knowledge-read');
    const mem = await readMemoryHealth(getOrgPg().sql);
    const loose = mem as unknown as Record<string, unknown>;
    const rawZero = [loose.zeroHitRate, loose.zeroHitRatePct, loose.zeroHitRate7d]
      .find((v): v is number => typeof v === 'number' && Number.isFinite(v));
    const zeroHitRate = rawZero === undefined ? null : rawZero > 1 ? rawZero / 100 : rawZero;
    const data: MemoryPanelHealth = {
      totalMemories: mem.totalMemories,
      entityRows: mem.entityRows,
      feedback30d: mem.feedback30d,
      zeroHitRate,
      recalls7d: mem.recalls7d,
      recallTelemetryOk: mem.recallTelemetryOk,
    };
    const status = memoryStatus(data);
    // EI-10625: a rate computed over ZERO observations is not 0% — it is UNKNOWN,
    // and it must not render as the healthiest possible value. Say which of the two
    // blind states we are in, and carry the denominator so the reading is auditable.
    const blind = !data.recallTelemetryOk
      ? 'telemetry unreadable'
      : data.recalls7d === 0
        ? 'no recalls recorded'
        : null;
    const zeroHitDisplay = blind !== null
      ? 'n/a'
      : zeroHitRate === null
        ? 'n/a'
        : `${Math.round(zeroHitRate * 100)}%`;
    return {
      status,
      summary:
        `${data.totalMemories} memories, ${data.feedback30d} feedback/30d` +
        (blind !== null
          ? `, zero-hit UNKNOWN (${blind})`
          : zeroHitRate !== null
            ? `, ${Math.round(zeroHitRate * 100)}% zero-hit`
            : ''),
      data,
      link: { label: 'Learning', href: '/adv?tab=learning' },
      metrics: [
        m('memories', data.totalMemories),
        m('entity rows', data.entityRows),
        m('feedback 30d', data.feedback30d),
        m('recalls 7d', data.recalls7d, blind !== null && data.totalMemories > 100 ? 'warn' : undefined),
        m(
          'zero-hit',
          zeroHitDisplay,
          (blind !== null && data.totalMemories > 100) || (zeroHitRate !== null && zeroHitRate >= 0.9)
            ? 'warn'
            : undefined,
        ),
      ],
    };
  });
}

/**
 * PURE: did a SETTLED Overwatch wake skip its mandated scorecard? (monitor-the-monitor,
 * hive-loop-supervision 2026-06-21). True when the supervisor is alive, its last wake is
 * older than the grace (so the turn — whose END emits the scorecard — has completed),
 * and no COMPLETE pot-coordination-health scorecard landed since that wake. The grace
 * kills the mid-turn false positive (a just-woken Overwatch hasn't emitted yet).
 */
export function overwatchScorecardSkipped(args: {
  alive: boolean | null;
  lastWakeAt: number | null;
  now: number;
  freshnessStatus: ScorecardFreshnessStatus;
  graceMs?: number;
}): boolean {
  const grace = args.graceMs ?? 5 * 60_000;
  if (args.alive === false || args.lastWakeAt == null) return false;
  if (args.now - args.lastWakeAt <= grace) return false; // turn may still be in flight
  if (args.freshnessStatus === 'unknown-rubric') return false; // invalid reference is not a skipped wake
  return args.freshnessStatus !== 'fresh';
}

/**
 * PURE: derive Scout ideation health from recent tick rows (newest-first, as
 * readScoutTicks returns). Transport-death = cycles RAN in-window but produced ZERO
 * ideas (a transport failure, not low quality) — the plan's "Scout 0 ideas/24h"
 * signal. Surfaced so the Overwatch can rate ideation-quality instead of 'unknown'.
 */
export function scoutHealthVerdict(
  ticks: ReadonlyArray<{ status: string; ideasGenerated?: number; tickAt: string }>,
  nowMs: number,
  windowMs: number = 24 * 60 * 60 * 1000,
): Omit<ScoutHealth, 'suIdeate' | 'grading' | 'provenanceDivergence'> {
  const ms = (t: { tickAt: string }) => Date.parse(t.tickAt);
  const inWin = ticks.filter((t) => Number.isFinite(ms(t)) && nowMs - ms(t) <= windowMs);
  const ran = inWin.filter((t) => t.status === 'ran');
  const ideasInWindow = ran.reduce((s, t) => s + (t.ideasGenerated ?? 0), 0);
  const newestRan = ran[0]; // filter preserves the newest-first order
  const newest = ticks[0];
  return {
    lastTickAt: newest && Number.isFinite(ms(newest)) ? ms(newest) : null,
    lastRanAt: newestRan ? ms(newestRan) : null,
    ideasLastRun: newestRan?.ideasGenerated ?? 0,
    ideasInWindow,
    ranInWindow: ran.length,
    transportDeath: ran.length > 0 && ideasInWindow === 0,
  };
}

/**
 * PURE: fold the su-ideate partition (origin='su-ideate' ticks, WI-4465) into
 * the ScoutHealth.suIdeate leg. Every ideate-pass row is written status='ran'
 * with ideasRouted ← ideasFiled (see blender:ideate-pass-record), but filter on
 * status anyway so a future non-ran row can't inflate the pass count.
 */
export function suIdeateVerdict(
  ticks: ReadonlyArray<{ status: string; ideasRouted?: number; tickAt: string }>,
  nowMs: number,
  windowMs: number = 24 * 60 * 60 * 1000,
): NonNullable<ScoutHealth['suIdeate']> {
  const ms = (t: { tickAt: string }) => Date.parse(t.tickAt);
  const ran = ticks.filter((t) => t.status === 'ran' && Number.isFinite(ms(t)));
  const inWin = ran.filter((t) => nowMs - ms(t) <= windowMs);
  return {
    passesInWindow: inWin.length,
    ideasFiled: inWin.reduce((s, t) => s + (t.ideasRouted ?? 0), 0),
    lastPassAt: ran.length > 0 ? ms(ran[0]) : null, // newest-first order
  };
}

/**
 * WI-6338: the divergence fraction (loop-output.ts `provenanceDivergence`) past
 * which the three learning-loop authorship records disagree enough to matter.
 * Chosen well below the ~0.49 that went unnoticed live (2026-07-27 measurement:
 * 422/825 agreed everywhere ⇒ divergence ≈ 0.49) so the Health tab flags drift
 * long before it reaches that scale again.
 */
export const PROVENANCE_DIVERGENCE_WARN_THRESHOLD = 0.15;

/** PURE: does this divergence fraction cross the WI-6338 warn threshold? */
export function crossesProvenanceDivergenceThreshold(
  divergence: number,
  threshold: number = PROVENANCE_DIVERGENCE_WARN_THRESHOLD,
): boolean {
  return Number.isFinite(divergence) && divergence > threshold;
}

async function collectScout(ctx: HealthCtx): Promise<HealthPanel<ScoutHealth>> {
  return panelSafe<ScoutHealth>('scout', async () => {
    const { readScoutTicks } = await import('../scout/tick-ledger');
    const ticks = await readScoutTicks({ workspaceId: ctx.ws, limit: 200 });
    // WI-4465: the su-ideate partition + the routed-idea grading loop — each
    // fail-soft (null = leg unavailable; the Scout-cycle verdict still renders).
    let suIdeate: ScoutHealth['suIdeate'] = null;
    try {
      const suTicks = await readScoutTicks({ workspaceId: ctx.ws, limit: 200, origin: 'su-ideate' });
      suIdeate = suIdeateVerdict(suTicks, ctx.now);
    } catch { /* su-partition read unavailable */ }
    let grading: ScoutHealth['grading'] = null;
    try {
      const { sql } = getOrgPg();
      // P-010: this surface used to publish a bare `ungraded` counted with NO origin,
      // terminality or epoch filter — 1,103 against an actionable backlog of 15. It now
      // reads the ONE definition (scout/ungraded-scope.ts), which cannot hand back an
      // unlabelled scalar.
      const { readUngradedBreakdown, DEFAULT_UNGRADED_EPOCH_POLICY, epochMsForOrigin } =
        await import('../scout/ungraded-scope');
      // Lazy, matching this block's existing style — compute.ts takes no static
      // scout imports, and the exclusion vocabulary module is dependency-free.
      const { SHADOW_VARIANT_ORIGIN } = await import('../scout/shadow-variant-origin');
      const rows = await sql<Array<{ graded: number }>>`
        SELECT (count(*) FILTER (WHERE graded_at IS NOT NULL AND graded_at > now() - interval '24 hours'))::int AS graded
          FROM harness_shared.scout_routed_ideas
         WHERE workspace_id = ${ctx.ws}
           -- counterfactual-critique-lab D-001: the shadow trial blind-grades 40
           -- rows (20 pairs) in one sitting, which would land here as a 24h
           -- grading-activity spike and read as "the grading loop is healthy"
           -- during a window when it may not be. A health signal inflated by a
           -- measurement's own artifacts is a false reading, not a harmless
           -- over-count -- the trial must not be able to certify the system it
           -- is running inside.
           AND origin <> ${SHADOW_VARIANT_ORIGIN}`;
      // D-014: the floor is per-origin. This surface used to pass the su-ideate floor
      // for EVERY origin — the reason scout showed a 592-row "actionable" backlog
      // against a line chosen for a different producer's corpus.
      const breakdown = await readUngradedBreakdown(sql, {
        workspaceId: ctx.ws,
        policy: DEFAULT_UNGRADED_EPOCH_POLICY,
      });
      grading = {
        gradedInWindow: rows[0]?.graded ?? 0,
        actionable: breakdown.actionable,
        actionableByOrigin: breakdown.actionableByOrigin,
        allUngraded: breakdown.allUngraded,
        // Name the floor beside the count, per origin actually present in the census.
        epochMsByOrigin: Object.fromEntries(
          Object.keys(breakdown.actionableByOrigin).map((origin) => [
            origin,
            epochMsForOrigin(breakdown.policy, origin),
          ]),
        ),
      };
    } catch { /* grading read unavailable */ }
    // WI-6338: the recurrence guard — compute + surface the three-record
    // authorship divergence so it can never again drift to ~50% unnoticed.
    let provenanceDivergence: ScoutHealth['provenanceDivergence'] = null;
    try {
      const { readLoopOutputIds, provenanceDivergence: divergenceOf } = await import('../harness/improvements/loop-output');
      const { counts } = await readLoopOutputIds();
      const value = divergenceOf(counts);
      provenanceDivergence = { value, counts, crossesWarnThreshold: crossesProvenanceDivergenceThreshold(value) };
    } catch { /* provenance-divergence read unavailable */ }
    const data: ScoutHealth = { ...scoutHealthVerdict(ticks, ctx.now), suIdeate, grading, provenanceDivergence };
    // 'warn' (not 'crit') on transport-death OR a crossed provenance-divergence
    // threshold: this panel exists to make Scout OBSERVABLE so the Overwatch can
    // rate ideation-quality + escalate per judgment — not to auto-fire an infra
    // BLOCKER via the liveness catch-all (neither condition wedges the running
    // system; both stall/corrupt R&D signal quietly if nobody notices).
    const status: PanelStatus =
      data.transportDeath || data.provenanceDivergence?.crossesWarnThreshold
        ? 'warn'
        : data.lastRanAt == null
          ? 'unknown'
          : 'ok';
    const suNote =
      data.suIdeate && data.suIdeate.passesInWindow > 0
        ? ` · su-ideate: ${data.suIdeate.passesInWindow} pass(es)/24h (${data.suIdeate.ideasFiled} filed)`
        : '';
    const divergenceNote = data.provenanceDivergence?.crossesWarnThreshold
      ? ` · WI-6338 provenance divergence ${(data.provenanceDivergence.value * 100).toFixed(0)}% (sourceRole/topic/routedIdea disagree)`
      : '';
    const summary =
      (data.lastRanAt == null
        ? data.lastTickAt == null
          ? 'no scout ticks recorded'
          : `no full cycle in 24h — last tick ${agoMin(data.lastTickAt, ctx.now)} (gated/idle)`
        : data.transportDeath
          ? `TRANSPORT-DEATH — ${data.ranInWindow} cycle(s) ran in 24h but 0 ideas generated (a transport failure, not low quality)`
          : `${data.ideasInWindow} idea(s)/24h over ${data.ranInWindow} cycle(s); last run ${agoMin(data.lastRanAt, ctx.now)} (${data.ideasLastRun} ideas)`) + suNote + divergenceNote;
    return {
      status,
      summary,
      data,
      link: { label: 'Learning', href: '/adv?tab=learning' },
      metrics: [
        m('ideas 24h', data.ideasInWindow, data.transportDeath ? 'warn' : undefined),
        m('cycles 24h', data.ranInWindow),
        m('last run', agoMin(data.lastRanAt, ctx.now)),
        m('last tick', agoMin(data.lastTickAt, ctx.now)),
        // WI-4465: informational partitions — omitted (not zeroed) when a leg's
        // read was unavailable, so absence is honest rather than a fake 0.
        ...(data.suIdeate
          ? [m('su passes 24h', data.suIdeate.passesInWindow), m('su filed 24h', data.suIdeate.ideasFiled)]
          : []),
        ...(data.grading
          ? [
              m('graded 24h', data.grading.gradedInWindow),
              // P-010: labelled on purpose. "ungraded 1103" read as a grading crisis
              // when the drainable backlog was 15; the rest is the deliberately-excluded
              // pre-epoch scout corpus. The label is the fix.
              m('ungraded (actionable)', data.grading.actionable),
            ]
          : []),
        // WI-6338: same omit-not-zero contract as the two legs above.
        ...(data.provenanceDivergence
          ? [
              m(
                'provenance divergence',
                `${(data.provenanceDivergence.value * 100).toFixed(0)}%`,
                data.provenanceDivergence.crossesWarnThreshold ? 'warn' : undefined,
              ),
            ]
          : []),
      ],
    };
  });
}

/**
 * PURE: fold the 3 tool-efficiency leg ratings into one panel status. `crit` if
 * ANY leg is 'broken' (a real regression), `warn` if any is 'degraded', `unknown`
 * only when EVERY leg is 'unknown' (all windows too small to grade), else `ok`.
 * Exported + unit-tested directly (mirrors scoutHealthVerdict / overwatchStatus).
 */
export function toolEfficiencyStatus(ratings: readonly ToolEfficiencyRating['rating'][]): PanelStatus {
  if (ratings.some((r) => r === 'broken')) return 'crit';
  if (ratings.some((r) => r === 'degraded')) return 'warn';
  if (ratings.every((r) => r === 'unknown')) return 'unknown';
  return 'ok';
}

async function collectToolEfficiency(ctx: HealthCtx): Promise<HealthPanel<ToolEfficiencyHealth>> {
  return panelSafe<ToolEfficiencyHealth>('toolEfficiency', async () => {
    // WI-839: the 3 measuring-code-run-adoption.mdx metrics, each already a pure +
    // unit-tested read/grade module — this collector only runs them + folds the result.
    // Dynamic imports (mirrors collectScout/collectOverwatch) keep this niche panel's
    // dependencies out of compute.ts's module-load path.
    // EI-10892: the 4th axis (empty-result rate) is the one that measures the DOMINANT
    // waste mode. The other three grade failures that announce themselves; a mis-mapped
    // response shape returns ok:true, so the panel could report "tool efficiency healthy"
    // while ~30% of a session's authored round-trips came back blank (measured, 2026-07-13).
    // P-010/P-011 (decision D-008): these four aggregates are PRECOMPUTED by the
    // `health.toolEfficiency` derived-read producer. Running them inline here was
    // the single most expensive read-path offender on the box — a live
    // pg_stat_statements delta caught the three heaviest advancing in lockstep
    // (+93/+94/+94 calls in one 3.6-min window, ~0.28 DB-cores burned
    // continuously) because ~49 agent processes each recomputed the same
    // fleet-wide numbers with no coordination. See system-health/tool-efficiency.ts
    // for the measurement and derived-reads/producers.ts for the ttl rationale.
    //
    // D-003: a reader NEVER computes. A missing snapshot (first boot, or right
    // after a producerVersion bump) warms in the background and reports 'unknown'
    // for one routine tick rather than silently reintroducing the inline scans.
    // When the PRECOMPUTE_DERIVED_READS flag is OFF, readDerivedSnapshot itself
    // falls back to inline compute — the pre-fix behavior, kept as the escape
    // hatch — so that path stays live without a branch here.
    const { readDerivedSnapshot } = await import('../derived-reads/registry');
    await import('../derived-reads/producers');
    const snapshot = await readDerivedSnapshot<ToolEfficiencyHealth>('health.toolEfficiency');
    const data = snapshot.payload;
    if (!data) {
      return {
        status: 'unknown',
        summary: 'tool-efficiency metrics precomputing — no snapshot yet (health.toolEfficiency)',
        data: null,
        link: { label: 'Learning', href: '/adv?tab=learning' },
        metrics: [],
      };
    }
    const { limitFailure, codeRunAdoption, orientDedup, emptyResult } = data;
    const adoptionRatePct = codeRunAdoption.adoptionRatePct;
    const status = toolEfficiencyStatus([
      limitFailure.rating,
      codeRunAdoption.rating,
      orientDedup.rating,
      emptyResult.rating,
    ]);
    const summary =
      `limit-failures ${limitFailure.rating} (${limitFailure.totalErrs}/14d) · ` +
      `code:run adoption ${codeRunAdoption.rating}${adoptionRatePct !== null ? ` (${adoptionRatePct}%)` : ''} · ` +
      `orient-dedup ${orientDedup.rating}${orientDedup.pctRedundant !== null ? ` (${orientDedup.pctRedundant}%)` : ''} · ` +
      `ok-but-empty ${emptyResult.rating}${emptyResult.pctEmpty !== null ? ` (${emptyResult.pctEmpty}%)` : ''}`;
    const toneOf = (r: ToolEfficiencyRating['rating']): PanelStatus | undefined =>
      r === 'broken' ? 'crit' : r === 'degraded' ? 'warn' : undefined;
    return {
      status,
      summary,
      data,
      link: { label: 'Learning', href: '/adv?tab=learning' },
      metrics: [
        m('limit-failures 14d', limitFailure.totalErrs, toneOf(limitFailure.rating)),
        m('code:run adoption', adoptionRatePct !== null ? `${adoptionRatePct}%` : 'n/a', toneOf(codeRunAdoption.rating)),
        m('orient-dedup', orientDedup.pctRedundant !== null ? `${orientDedup.pctRedundant}%` : 'n/a', toneOf(orientDedup.rating)),
        m('ok-but-empty', emptyResult.pctEmpty !== null ? `${emptyResult.pctEmpty}%` : 'n/a', toneOf(emptyResult.rating)),
      ],
    };
  });
}

async function collectOverwatch(ctx: HealthCtx): Promise<HealthPanel<OverwatchPanelHealth>> {
  return panelSafe<OverwatchPanelHealth>('overwatch', async () => {
    const { ws, now, potSlug } = ctx;
    // Reuse B-08's read surface (D-006 — never a second aggregation): the persisted
    // started bit + cadence (B-07) + the wake liveness (B-09) + the activation flag.
    const { getOverwatchControlState } = await import('../overwatch/snapshot');
    const cs = await getOverwatchControlState({ workspaceId: ws, potSlug: potSlug ?? undefined });
    let watchdogFires24h = 0;
    if (cs.potSlug) {
      try {
        const { recentOverwatchWatchdogFires } = await import('../overwatch/watchdog');
        watchdogFires24h = await recentOverwatchWatchdogFires(ws, cs.potSlug);
      } catch { /* fires table unreadable — leave 0 */ }
    }
    const lastWakeAt = cs.lastWakeAt ? new Date(cs.lastWakeAt).getTime() : null;
    const nextFireAt = cs.nextWakeAt ? new Date(cs.nextWakeAt).getTime() : null;
    // Monitor-the-monitor (hive-loop-supervision 2026-06-21): is the Overwatch actually
    // emitting its every-wake pot-coordination-health scorecard? Check freshness SINCE
    // its last wake (not a generic lookback). Best-effort — a read error leaves emission
    // null + skipped false, never blocking the panel.
    let scorecardEmission: OverwatchPanelHealth['scorecardEmission'] = null;
    let scorecardSkipped = false;
    if (cs.started && cs.flagEnabled && lastWakeAt != null) {
      try {
        const { checkScorecardFreshness } = await import('../scorecard-freshness');
        const f = await checkScorecardFreshness({
          rubricRef: 'pot-coordination-health',
          sourceHive: cs.potSlug ?? undefined,
          since: new Date(lastWakeAt).toISOString(),
        });
        scorecardEmission = { status: f.status, lastCompleteAt: f.lastCompleteAt, missingCount: f.latestMissingKeys.length };
        scorecardSkipped = overwatchScorecardSkipped({
          alive: ctx.overwatchAlive,
          lastWakeAt,
          now,
          freshnessStatus: f.status,
        });
      } catch { /* freshness unreadable — leave null/false, never block the panel */ }
    }
    const data: OverwatchPanelHealth = {
      flagEnabled: cs.flagEnabled,
      started: cs.started,
      alive: ctx.overwatchAlive,
      armed: cs.armed,
      cadenceSec: cs.cadenceSec,
      lastWakeAt,
      nextFireAt,
      staleForMs: cs.staleForMs,
      watchdogFires24h,
      scorecardEmission,
      scorecardSkipped,
    };
    const status = overwatchStatus(data);
    const stateLabel = !cs.flagEnabled
      ? cs.started ? 'pre-armed' : 'disabled'
      : !cs.started
        ? 'paused'
        : data.alive === false
          ? 'dark'
          : 'looping';
    const summary = !cs.flagEnabled
      ? cs.started
        ? 'pre-armed — started bit set, awaiting the papercusp-overwatch flip (B-12)'
        : 'disabled — papercusp-overwatch flag off (default-off until proven, B-12)'
      : !cs.started
        ? 'paused — supervisor idle by choice'
        : data.alive === false
          ? `DARK ${agoMin(lastWakeAt, now)} — supervisor loop gone, no wake armed`
          : `looping — last wake ${agoMin(lastWakeAt, now)}, next ${untilMin(nextFireAt, now)}`;
    return {
      status, summary, data,
      link: { label: 'Kettle', href: '/adv?tab=overwatch' },
      metrics: [
        m('state', stateLabel, status === 'crit' ? 'crit' : status === 'warn' ? 'warn' : undefined),
        m('cadence', `${Math.round(cs.cadenceSec / 60)}m`),
        m('last wake', agoMin(lastWakeAt, now)),
        m('next wake', untilMin(nextFireAt, now)),
        m('watchdog 24h', watchdogFires24h, watchdogFires24h >= WATCHDOG_FIRES_WARN ? 'warn' : undefined),
      ],
    };
  });
}

/**
 * Context-injection delivery coverage (codex-context-injection-parity-2026-08-09
 * P-005) — "is each client actually being asked for per-turn context?"
 *
 * The panel `data` IS P-005's exposure requirement and the panel STATUS drives
 * its alarm: liveness-alarm's catch-all turns any panel reporting `crit` into a
 * `panel:<key>` blocker signal, so no new alarm mechanism is needed. The
 * never-alarm-without-a-baseline rule lives in `classifyInjectionClient`, which
 * carries the reasoning.
 */
async function collectContextInjection(ctx: HealthCtx): Promise<HealthPanel<ContextInjectionHealth>> {
  return panelSafe<ContextInjectionHealth>('contextInjection', async () => {
    const { readInjectionDeliveryCoverage } = await import('../memory/injection-delivery-coverage');
    const reading = await readInjectionDeliveryCoverage({ workspaceId: ctx.ws });

    const clients: ContextInjectionClientRow[] = reading.clients.map((c) => {
      const unknownTool = c.byOutcome['unknown-tool'];
      // Classify each PORT with the same rule as a client — the question is
      // identical ("sessions ran; did this thing record anything, and has it
      // ever?"), only the denominator differs. Reusing the classifier keeps the
      // never-alarm-without-a-baseline guarantee true per port for free.
      const ports: ContextInjectionPortRow[] = c.ports.map((p) => ({
        port: p.port,
        events: p.events,
        everObserved: p.everObserved,
        verdict: classifyInjectionClient({
          sessions: c.sessions,
          events: p.events,
          unknownTool: p.byOutcome['unknown-tool'],
          everObserved: p.everObserved,
        }),
      }));
      const clientVerdict = classifyInjectionClient({
        sessions: c.sessions,
        events: c.events,
        unknownTool,
        everObserved: c.everObserved,
      });
      return {
        client: c.client,
        sessions: c.sessions,
        events: c.events,
        recalled: c.byOutcome.recalled,
        unknownTool,
        driftTools: c.driftTools,
        everObserved: c.everObserved,
        // WORST of the client reading and every port. Without this roll-up a
        // client whose turn-start port is dead still reports 'ok' on the
        // strength of its mid-turn traffic — the masking this panel existed
        // for a day without noticing.
        verdict: worstInjectionVerdict([clientVerdict, ...ports.map((p) => p.verdict)]),
        ports,
      };
    });

    // Three hook layers do not fail in the same tick; the one recording path they
    // share does. Require >1 baselined client so a single client's genuine
    // regression is never re-attributed to the recorder.
    const baselined = clients.filter((c) => c.everObserved);
    const recordingPathSuspect = baselined.length > 1 && baselined.every((c) => c.events === 0);

    const data: ContextInjectionHealth = {
      windowHours: reading.windowHours,
      clients,
      totalEvents: reading.totalEvents,
      recordingPathSuspect,
    };
    const status = contextInjectionStatus(data);

    // Name the PORT when only some of a client's ports carry the verdict. A bare
    // "claude stopped delivering context" while claude's mid-turn is perfectly
    // healthy points the reader at the wrong layer, and the whole reason this
    // panel now reads per-port is that one dead port used to be unsayable.
    const label = (c: ContextInjectionClientRow, verdict: string): string => {
      const hit = c.ports.filter((p) => p.verdict === verdict).map((p) => p.port);
      return hit.length > 0 && hit.length < c.ports.length ? `${c.client} (${hit.join(', ')})` : c.client;
    };

    const regressed = clients.filter((c) => c.verdict === 'regressed').map((c) => label(c, 'regressed'));
    const drifting = clients.filter((c) => c.verdict === 'drift');
    const never = clients
      .filter((c) => c.verdict === 'never-observed')
      .map((c) => label(c, 'never-observed'));

    let summary: string;
    if (recordingPathSuspect) {
      summary =
        `${regressed.join(', ')} all silent at once — suspect the shared recording path, not ${regressed.length} hooks`;
    } else if (regressed.length > 0) {
      summary = `${regressed.join(', ')} stopped delivering context (was working, now 0 rows)`;
    } else {
      const parts: string[] = [];
      if (drifting.length > 0) {
        const tools = [...new Set(drifting.flatMap((c) => c.driftTools))].slice(0, 3);
        parts.push(
          `${drifting.map((c) => c.client).join(', ')} vocabulary drift` +
            (tools.length > 0 ? ` (${tools.join(', ')})` : ''),
        );
      }
      if (never.length > 0) parts.push(`${never.join(', ')} never observed (known gap, not a regression)`);
      const working = clients.filter((c) => c.verdict === 'ok').map((c) => c.client);
      if (parts.length === 0) {
        parts.push(working.length > 0 ? `${working.join(', ')} delivering` : 'no client sessions in window');
      }
      summary = parts.join('; ');
    }

    return {
      status,
      summary: `${summary} (${reading.windowHours}h)`,
      data,
      link: { label: 'Learning', href: '/adv?tab=learning' },
      metrics: clients.map((c) =>
        m(
          c.client,
          c.verdict === 'idle' ? 'idle' : `${c.events} ev / ${c.sessions} sess`,
          c.verdict === 'regressed' ? 'crit' : c.verdict === 'drift' || c.verdict === 'never-observed' ? 'warn' : undefined,
        ),
      ),
    };
  });
}

// ── the aggregator ───────────────────────────────────────────────────────────

/**
 * Build the whole-system health snapshot for a workspace. Flag-agnostic (the
 * tab/resolver/tick gate on SYSTEM_HEALTH_TAB; the overwatch brief wraps this
 * regardless). Resolves the hive + the shared open-placement + gateway reads
 * once, then runs every panel collector in parallel under `panelSafe`.
 */
export async function computeSystemHealth(workspaceId?: string): Promise<SystemHealth> {
  const ws = workspaceId ?? activeWorkspaceId();
  const now = Date.now();

  // Resolve the hive (prefer a started one) + the shared best-effort reads.
  let potSlug: string | null = null;
  let started = false;
  try {
    const { listPots } = await import('../agent-tools/pot/_resolve');
    const { getPotStarted } = await import('../pot/started');
    const hives = await listPots(ws);
    for (const h of hives) {
      if (await getPotStarted(ws, h.slug).catch(() => false)) { potSlug = h.slug; started = true; break; }
    }
    if (!potSlug && hives.length > 0) potSlug = hives[0].slug;
  } catch { /* registry unreadable — queen/work-feed degrade to 'unknown' */ }

  let openPlacements: HealthCtx['openPlacements'] = null;
  if (potSlug) {
    try {
      const { summarizeOpenPlacements } = await import('../pot/placement-watchdog');
      // K1 (workspace-scoped-coordination P-003 / D-006): the one workspace Queen
      // drives placements across ALL the workspace's hives, so when
      // WORKSPACE_COORDINATION is ON the open-placement panel SPANS every hive
      // (summed) rather than just the representative one. OFF (the dark default) ⇒
      // the single representative hive, byte-identical to today.
      const { isWorkspaceCoordinationOn } = await import('../workspace-brain-scope');
      const on = await isWorkspaceCoordinationOn();
      let scopeSlugs = [potSlug];
      if (on) {
        try {
          const { listPots } = await import('../agent-tools/pot/_resolve');
          const all = (await listPots(ws)).map((h) => h.slug);
          if (all.length > 0) scopeSlugs = all;
        } catch { /* registry unreadable → fall back to the representative hive */ }
      }
      const sums = await Promise.all(scopeSlugs.map((slug) => summarizeOpenPlacements(ws, slug)));
      openPlacements = sums.reduce(
        (acc, op) => ({
          recovering: acc.recovering + op.recovering,
          cursed: acc.cursed + op.cursed,
          stranded: acc.stranded + op.stranded,
          workingTracked: acc.workingTracked + op.workingTracked,
        }),
        { recovering: 0, cursed: 0, stranded: 0, workingTracked: 0 },
      );
    } catch { /* leave null — queen.workingTracked + bees.placements degrade to 0 */ }
  }

  let gatewayEnabled = false;
  let gatewayReachable: boolean | null = null;
  try {
    gatewayEnabled = await getFlag(FLAGS.INFERENCE_GATEWAY, 'system');
    if (gatewayEnabled) gatewayReachable = await probeGatewayHealthz();
  } catch { /* flag IO hiccup — treat as direct egress */ }

  // Overwatch liveness (B-09 / D-004) — resolved ONCE here so the SAME value feeds
  // both the Overwatch panel (#15, collectOverwatch) and `crossMonitor.overwatchAlive`
  // (the who-watches-the-watcher reverse leg); two copies of this DID drift once
  // (EI-623, the queenAlive sibling). `null` = not-in-play (flag off / not started)
  // or uncomputable — never a false dark. Dynamic import + fail-soft so the
  // overwatch module can never break the shared health aggregation.
  let overwatchAlive: boolean | null = null;
  if (potSlug) {
    try {
      const { isOverwatchAlive } = await import('../overwatch/cross-monitor');
      overwatchAlive = await isOverwatchAlive(ws, potSlug, { now });
    } catch {
      /* leave null — overwatch liveness not computable; null = not-computed (D-004) */
    }
  }

  const ctx: HealthCtx = {
    ws, now, potSlug, started, openPlacements, gatewayEnabled, gatewayReachable, overwatchAlive,
    openImprovements: makeOpenImprovementsReader(),
  };

  const [
    queen, bees, workItems, workFeed, tokens, watchdog, deploy,
    plans, escalations, autonomy, observations, improvements, infra, suFleet, overwatch, scout,
    toolEfficiency, loops, coordination, memory, contextInjection,
  ] = await Promise.all([
    collectQueen(ctx), collectBees(ctx), collectWorkItems(ctx), collectWorkFeed(ctx),
    collectTokens(ctx), collectWatchdog(ctx), collectDeploy(ctx), collectPlans(ctx),
    collectEscalations(ctx), collectAutonomy(ctx), collectObservations(ctx),
    collectImprovements(ctx), collectInfra(ctx), collectSuFleet(ctx), collectOverwatch(ctx),
    collectScout(ctx), collectToolEfficiency(ctx), collectLoops(ctx), collectCoordination(ctx),
    collectMemory(ctx), collectContextInjection(ctx),
  ]);

  // P-001 (health-tab-v2): the paused-Mug cry-wolf fix — reconcile the queen
  // panel's paused-crit against the work-feed's PLACEABLE frontier, so a pot
  // paused with only unplaceable residue reads warn ("idle by choice"), while
  // paused-with-placeable-demand stays a crit silent outage. The summary now
  // AGREES with the status either way.
  const reconciled = reconcilePausedQueen(queen, workFeed);
  if (reconciled) {
    queen.status = reconciled.status;
    queen.summary = reconciled.summary;
    if (queen.metrics[0]?.label === 'state') {
      queen.metrics[0] = { label: 'state', value: 'paused', tone: reconciled.status };
    }
  }

  const panels: SystemHealthPanels = {
    queen, bees, workItems, workFeed, loops, tokens, watchdog, deploy,
    plans, escalations, autonomy, observations, improvements, infra, suFleet, coordination,
    overwatch, scout, memory, toolEfficiency, contextInjection,
  };
  const overall = worstStatus(Object.values(panels).map((p) => p.status));
  // queenAlive — the who-watches-the-watcher LIVENESS signal (D-004), kept DISTINCT
  // from `stalled` (EI-623). ONE shared definition (deriveQueenAlive) so the shared
  // model and the overwatch brief mapper can never drift apart again.
  const queenAlive = deriveQueenAlive(queen.data);

  const snapshot: SystemHealth = {
    workspaceId: ws,
    evaluatedAt: now,
    overall,
    crossMonitor: { queenAlive, overwatchAlive },
    panels,
  };

  // P-004 (health-tab-v2): apply owner acks — covered panels are muted and
  // excluded from `overall`. Fail-soft: an unreadable ack table (migration 585
  // pending) leaves the snapshot exactly as computed above.
  try {
    const { readHealthAcks, applyHealthAcks } = await import('./acks');
    applyHealthAcks(snapshot, await readHealthAcks(ws), now);
  } catch { /* acks unreadable — un-acked snapshot stands */ }

  return snapshot;
}

// ── cache + tick + read surface (mirrors learning-infra-health) ──────────────

/** Shared-snapshot key/version/max-age for the P-001 cross-process cache. Bump the
 *  version when `SystemHealth`'s shape changes so a reader never maps a stale shape. */
const SYSTEM_HEALTH_SNAPSHOT_KEY = 'system.health';
const SYSTEM_HEALTH_SNAPSHOT_VERSION = 1;
/** A reader accepts a shared snapshot up to this old. Comfortably above the 30s
 *  tick cadence so a healthy writer keeps it fresh, but bounded so a dead writer
 *  produces UNKNOWN instead of letting request workers act on stale evidence. A
 *  tick host may still choose its own explicit local-refresh path. */
export const SHARED_SYSTEM_HEALTH_MAX_AGE_MS = 5 * 60_000;

const cache = new Map<string, SystemHealth>();

/**
 * Select the predecessor for a health tick. The local cache is authoritative when present;
 * a cold tick host may safely use the recent shared snapshot so cross-worker/restart health
 * transitions retain per-volume disk hysteresis state. A missing shared row remains a true
 * cold start and deliberately returns null.
 */
export function selectPreviousHealthSnapshot(
  local: SystemHealth | null,
  shared: SystemHealth | null,
): SystemHealth | null {
  return local ?? shared;
}

/** The precompute kill-switch, fail-OPEN to enabled (the correct behavior on the
 *  shipping target — never silently fall back to a slow inline recompute). */
async function precomputeSharedHealthEnabled(): Promise<boolean> {
  try {
    return await getFlag(FLAGS.PRECOMPUTE_DERIVED_READS, systemDistinctId());
  } catch {
    return true;
  }
}

/**
 * Serve `SystemHealth` from the cross-process SHARED snapshot the tick writes,
 * NEVER a local aggregation (P-001). Used by reader processes that don't run the
 * tick, and on any host's cold-cache path. On a hit it also refreshes the
 * in-process cache so `lastSystemHealth()` stays coherent for this process.
 * Returns null on a miss / version mismatch / too-stale row / flag off. Request-
 * worker callers must treat null as unknown; only the dedicated tick host may
 * explicitly choose to compute.
 */
export async function readSharedSystemHealthSnapshot(
  ws: string,
  maxAgeMs = SHARED_SYSTEM_HEALTH_MAX_AGE_MS,
): Promise<SystemHealth | null> {
  if (!(await precomputeSharedHealthEnabled())) return null;
  const shared = await readSharedSnapshot<SystemHealth>(
    SYSTEM_HEALTH_SNAPSHOT_KEY,
    ws,
    SYSTEM_HEALTH_SNAPSHOT_VERSION,
    maxAgeMs,
  ).catch(() => null);
  if (!shared) return null;
  cache.set(ws, shared.payload);
  return shared.payload;
}

/**
 * The host-aware SystemHealth resolve, WITHOUT the SYSTEM_HEALTH_TAB gate (that
 * gate belongs to `getSystemHealth`; the Overwatch brief deliberately does not
 * apply it). Stale-while-revalidate, but the REVALIDATE differs by host role:
 *   - a tick host (bg workers on) refreshes LOCALLY via `runSystemHealthTick`;
 *   - a reader host re-reads the SHARED snapshot the tick writes, so it never runs
 *     the ~15-collector aggregation on its own event loop (the P-001 fix).
 * A cold cache tries the shared snapshot first; only a tick host may fall back
 * to a blocking recompute when that snapshot is absent.
 */
export async function resolveSystemHealth(
  ws: string,
  maxAgeMs = 30_000,
): Promise<SystemHealth | null> {
  const isTickHost = backgroundWorkersEnabled();
  const cached = cache.get(ws);
  if (cached) {
    if (Date.now() - cached.evaluatedAt > maxAgeMs) {
      if (isTickHost) void runSystemHealthTick(ws).catch(() => {});
      else void readSharedSystemHealthSnapshot(ws).catch(() => {});
    }
    return cached;
  }
  // Cold cache — a shared SELECT before a blocking recompute.
  const shared = await readSharedSystemHealthSnapshot(ws);
  if (shared) return shared;
  // A reader host has no tick owner and must never turn a shared-snapshot miss
  // back into the expensive inline aggregation. The next writer tick will
  // publish the snapshot; until then the read surface correctly reports no
  // snapshot rather than recreating the cold-load stampede.
  if (!isTickHost) return null;
  return runSystemHealthTick(ws);
}

/** Last computed snapshot for a workspace, or null. */
export function lastSystemHealth(workspaceId?: string): SystemHealth | null {
  return cache.get(workspaceId ?? activeWorkspaceId()) ?? null;
}

/**
 * Generic per-key single-flight de-dup (EI-19303672371455669) — extracted to
 * `../dedupe-in-flight` (EI-22091013068319789) so `sync-resolver/adv-roster-read.ts`
 * can reuse it without importing this whole module graph. Re-exported here (not
 * just imported) so every existing importer of `dedupeInFlight` from `./compute`
 * is unaffected.
 */
export { dedupeInFlight };

/** Per-workspace in-flight store for the tick's full aggregation (EI-19303672371455669).
 *  Concurrent callers racing into a cold cache — `resolveSystemHealth`'s cold path, the
 *  periodic scheduler, and the explicit post-ack/unack refresh (ack.ts/unack.ts) — can all
 *  legitimately land here within the same ~1.6-2.0s window, and previously each ran their
 *  own full ~20-collector recompute (measured live: one booting host sustained ~40x its
 *  expected tick rate for minutes). Wired through `dedupeInFlight` below. */
const tickInFlight = new Map<string, Promise<SystemHealth>>();

/**
 * One health tick: recompute + cache + invalidate `health.snapshot` so an open
 * Health tab refreshes (SSE-live). Driven by the in-process periodic scheduler;
 * also run on-demand by `getSystemHealth` when the cache is stale. Single-flighted per
 * workspace (see `tickInFlight` above) — N concurrent callers pay for exactly ONE
 * aggregation.
 */
export async function runSystemHealthTick(workspaceId?: string): Promise<SystemHealth> {
  const ws = workspaceId ?? activeWorkspaceId();
  return dedupeInFlight(tickInFlight, ws, () => runSystemHealthTickUncached(ws));
}

/**
 * Publish the queue census to the canonical governor snapshot as an optional
 * health-tick side effect. System-health has no authoritative controller or
 * recovery decision, so those fields intentionally remain unknown here; the
 * queue reader is the only durable governor signal this tick owns.
 *
 * The bridge is fail-soft in both directions. A census/read failure must not
 * hide the regular health snapshot, and a snapshot write failure must not make
 * the tick fail after its in-process cache has been computed.
 */
export async function publishGovernorStateSnapshot(
  workspaceId: string,
  observedAtMs: number,
): Promise<void> {
  try {
    const [{ readGovernorQueuePopulation }, { GOVERNOR_STATE_MAX_AGE_MS, GovernorStateSnapshotWriter }] =
      await Promise.all([
        import('../resource-governor/queue'),
        import('../resource-governor/state-snapshot'),
      ]);
    const queueByClass = await readGovernorQueuePopulation(getOrgPg().sql, workspaceId, observedAtMs);
    await new GovernorStateSnapshotWriter(workspaceId).publish({
      observedAtMs,
      validUntilMs: observedAtMs + GOVERNOR_STATE_MAX_AGE_MS,
      queueByClass,
    });
  } catch {
    // Governor telemetry is an enrichment leg; a missing/failed leg stays unknown
    // instead of breaking the health tick or fabricating a healthy zero queue.
  }
}

async function runSystemHealthTickUncached(ws: string): Promise<SystemHealth> {
  const localPrev = cache.get(ws) ?? null;
  // Hydrate a cold tick host from the cross-process snapshot before computing the next
  // health payload. collectInfra reads the predecessor's disk bands from this cache while
  // classifying the new statfs sample; without this read, a host restart loses hysteresis
  // and a 94→95 boundary can falsely resolve/re-fire infra-liveness.
  const sharedPrev = localPrev ? null : await readSharedSystemHealthSnapshot(ws).catch(() => null);
  const prev = selectPreviousHealthSnapshot(localPrev, sharedPrev);
  const health = await computeSystemHealth(ws);
  // P-004 (health-tab-v2): auto-clear acks whose panel recovered / snooze
  // expired, and re-apply the survivors. Fail-soft — never breaks the tick.
  try {
    const { sweepHealthAcks } = await import('./acks');
    await sweepHealthAcks(health, Date.now());
  } catch { /* ack sweep unavailable (migration pending) — snapshot stands */ }
  // P-005 (health-tab-v2): persist status history — transition rows for every
  // panel that changed vs the previous tick + the compact per-tick statuses row
  // (14d retention). Fail-soft — history must never break the tick.
  try {
    const { recordHealthHistory } = await import('./history');
    await recordHealthHistory(prev, health);
  } catch { /* history unavailable (migration pending) — tick proceeds */ }
  // EI-12982: preserve a forensic perf-signals-v1 snapshot the moment the infra
  // panel edge-transitions into `crit` (covers the "PER-THREAD WEDGE" verdict).
  // The routine capture-perf-signals.sh rotation only keeps ~30 min of scheduled
  // captures, so a flap investigated later (the common case — watchdog pages,
  // root-cause happens on a later backlog pass) otherwise finds no evidence.
  // Edge-triggered (not on every tick while it stays crit) + fail-soft.
  try {
    if (health.panels.infra?.status === 'crit' && prev?.panels?.infra?.status !== 'crit') {
      const { preserveIncidentCapture } = await import('./perf-budgets');
      await preserveIncidentCapture('infra-crit');
    }
  } catch { /* incident-capture preservation must never break the tick */ }
  // EI-219699: make the complete durable queue census visible to the canonical
  // governor state resolver. No process-local admission/recovery verdict is
  // available to this health tick, so publish only queue evidence.
  await publishGovernorStateSnapshot(ws, health.evaluatedAt);
  cache.set(ws, health);
  // P-001 (precompute-sync-reads-phase2): publish the freshly-computed snapshot to
  // the cross-process SHARED store so a reader process that never runs this tick
  // (the :3170 staging operator, a utility host, or any process in the ~30s window
  // right after boot) can serve overwatch.snapshot / health.snapshot from a plain
  // SELECT instead of paying the full ~15-collector aggregation on the read path.
  // Fire-and-forget + fail-soft: the in-process cache above is authoritative on
  // THIS host, so a shared-write hiccup only forgoes the cross-process benefit; it
  // must never slow or break the tick.
  if (await precomputeSharedHealthEnabled()) {
    void writeSharedSnapshot(SYSTEM_HEALTH_SNAPSHOT_KEY, ws, health, SYSTEM_HEALTH_SNAPSHOT_VERSION).catch(
      (e) => console.warn(`[system-health] shared-snapshot write failed for ${ws}: ${e instanceof Error ? e.message : e}`),
    );
  }
  await notifySyncInvalidate('health.snapshot', undefined).catch(() => {});
  await notifySyncInvalidate('health.history', undefined).catch(() => {});
  // The Overwatch pane (B-08) reads the SAME SystemHealth as its brief snapshot
  // (overwatch.snapshot, D-006 "one aggregation, two consumers"), so invalidate it
  // on the same tick — the pane stays SSE-live without a second aggregation. Safe
  // no-op when no overwatch pane is subscribed.
  await notifySyncInvalidate('overwatch.snapshot', undefined).catch(() => {});
  // P-059: the sibling `mugBrief.floorView` invalidation is gone with the query
  // itself — its client (the chat sidebar's pot-status panel) was stripped by
  // WI-37654 and the Mug brief it projected retired with the tier. Invalidating
  // an unregistered key is a silent no-op, so leaving this call would have cost
  // nothing visible and told the next reader the query still exists.
  return health;
}

/**
 * Merge freshly-recomputed panel(s) into a cached snapshot IN PLACE (P-013 /
 * D-007, stop-discarded-dedup-and-audit-server-polling-2026-07-26) — the
 * push-on-write counterpart to the whole-snapshot `computeSystemHealth`.
 * Re-derives `overall` from the FULL merged panel set (never just the updated
 * ones), so a partial merge can't blind the aggregator to a worse, untouched
 * panel's status. Stamps `evaluatedAt` to `now` so the tab treats the snapshot
 * as fresh. Mutates AND returns `snap` (same reference) — exported for the
 * unit test + for `refreshHealthPanel` below.
 */
export function mergeHealthPanels(
  snap: SystemHealth,
  updates: Partial<Record<PanelKey, HealthPanel<unknown>>>,
  now: number,
): SystemHealth {
  Object.assign(snap.panels, updates);
  snap.overall = worstStatus(Object.values(snap.panels).map((p) => p.status));
  snap.evaluatedAt = now;
  return snap;
}

/**
 * Push-on-write refresh for ONE panel (P-013 / D-007): recompute a single
 * collector and merge its result into the cached snapshot immediately, instead
 * of waiting up to 30s for the next whole-snapshot tick to notice the write.
 * Called fire-and-forget from the write path — capture-core/decay/triage-core/
 * hygiene for observations+improvements, autonomy policy-store/tripwire-store
 * for autonomy — never throws (a write must never fail because the health
 * cache couldn't be refreshed). A cold cache (no tick has run yet for this
 * workspace) is a safe no-op: the first `getSystemHealth` call / periodic tick
 * populates it from scratch, evaluating every panel including this one fresh.
 */
export async function refreshHealthPanel(
  panel: 'observations' | 'improvements' | 'autonomy',
  workspaceId?: string,
): Promise<void> {
  try {
    const ws = workspaceId ?? activeWorkspaceId();
    // WI-6980: coalesce per (workspace, panel). The LEADING edge still runs
    // immediately — so a single write refreshes the panel just as promptly as
    // before, and an `await refreshHealthPanel(...)` still observes the result —
    // while a BURST of writes collapses into one trailing refresh instead of one
    // refresh each. Measured before this change: the observations panel's
    // list+count pair ran at ~18.6 calls/min (~11.3% of a CPU core) purely from
    // unthrottled write-path refreshes. See refresh-coalescer.ts for why the
    // obvious alternative (trimming the SELECT list) is measured-useless here.
    await getPanelRefreshCoalescer().request(ws, panel, () => performPanelRefresh(panel, ws));
  } catch {
    /* fire-and-forget from a write path — never throw */
  }
}

/** The actual single-panel recompute, run on the coalescer's leading/trailing edge. */
async function performPanelRefresh(
  panel: 'observations' | 'improvements' | 'autonomy',
  ws: string,
): Promise<void> {
  try {
    if (!(await getFlag(FLAGS.SYSTEM_HEALTH_TAB, 'system'))) return;
    const prev = cache.get(ws);
    if (!prev) return; // nothing to merge into yet — the next full tick seeds the cache
    const now = Date.now();
    // A minimal ctx: none of these three collectors read potSlug/started/
    // openPlacements/gatewayEnabled/gatewayReachable/overwatchAlive — those
    // exist only for the OTHER ~17 collectors this single-panel refresh
    // deliberately skips (the whole point is avoiding their cost).
    const ctx: HealthCtx = {
      // P-008: its own memo, so a single-panel refresh pays exactly one improvements
      // read — and never shares rows across two refreshes that are minutes apart.
      openImprovements: makeOpenImprovementsReader(),
      ws, now, potSlug: null, started: false, openPlacements: null,
      gatewayEnabled: false, gatewayReachable: null, overwatchAlive: null,
    };
    const fresh = panel === 'observations' ? await collectObservations(ctx)
      : panel === 'improvements' ? await collectImprovements(ctx)
      : await collectAutonomy(ctx);
    const merged = mergeHealthPanels(prev, { [panel]: fresh }, now);
    cache.set(ws, merged);
    if (await precomputeSharedHealthEnabled()) {
      void writeSharedSnapshot(SYSTEM_HEALTH_SNAPSHOT_KEY, ws, merged, SYSTEM_HEALTH_SNAPSHOT_VERSION).catch(() => {});
    }
    await notifySyncInvalidate('health.snapshot', undefined).catch(() => {});
  } catch {
    /* fire-and-forget from a write path — never throw */
  }
}

/**
 * Pre-warm the per-workspace cache once at boot — the cold-cache perf fix
 * (system-health-tab-2026-06-15 P-003 follow-up). The in-process periodic tick
 * keeps the cache warm in steady state, but for the ~30s after a boot/deploy the
 * cache is EMPTY, so the FIRST Health tab
 * (`getSystemHealth`) or Overwatch pane (`getOverwatchSnapshot`) open
 * cold-computes the 15-collector aggregation (incl. the ~2.5s gateway probe) ON
 * the user's critical path (the 2-3s load the owner saw). Called once right after
 * boot: it kicks one tick per registered workspace FIRE-AND-FORGET (never
 * blocks/fails boot) and is gated on the SAME `SYSTEM_HEALTH_TAB` flag as the
 * periodic tick + the read surface. Returns the number of workspaces whose
 * warm-up was kicked off (0 when the flag is off).
 *
 * `tick` is injectable for unit testing; production passes the real
 * `runSystemHealthTick`.
 */
export async function preWarmSystemHealth(
  tick: (ws: string) => Promise<unknown> = runSystemHealthTick,
): Promise<number> {
  if (!(await getFlag(FLAGS.SYSTEM_HEALTH_TAB, 'system'))) return 0;
  const workspaces = readRegistry().workspaces.map((w) => w.id);
  for (const ws of workspaces) {
    void Promise.resolve(tick(ws)).catch((e) => {
      console.warn(`[system-health] boot pre-warm failed for ${ws}: ${e instanceof Error ? e.message : e}`);
    });
  }
  return workspaces.length;
}

/**
 * Read surface for the `health.snapshot` resolver. Stale-while-revalidate: a
 * present snapshot is served INSTANTLY (the Health tab opens with no spinner);
 * when it's past `maxAgeMs` we ALSO kick a background refresh (the tick
 * invalidates `health.snapshot`, so the open tab updates over SSE). Only a COLD
 * cache blocks on a live tick — the one-time correctness floor. Returns null when
 * the feature flag is off.
 */
export async function getSystemHealth(maxAgeMs = 30_000, workspaceId?: string): Promise<SystemHealth | null> {
  if (!(await getFlag(FLAGS.SYSTEM_HEALTH_TAB, 'system'))) return null;
  const ws = workspaceId ?? activeWorkspaceId();
  // Host-aware SWR + cross-process shared-snapshot cold read (P-001): a reader
  // process serves from the shared snapshot instead of a 1.6-2.0s local recompute.
  return resolveSystemHealth(ws, maxAgeMs);
}

/** Test-only — clear the per-workspace cache. */
export function _resetSystemHealthCache(): void {
  cache.clear();
}
