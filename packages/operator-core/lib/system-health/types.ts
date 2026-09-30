/**
 * system-health/types — the SystemHealth snapshot contract
 * (system-health-tab-2026-06-15 P-001, D-001).
 *
 * ONE health model, TWO consumers (D-001): the read-only **Health tab** (the
 * full human view) and the autonomous **overwatch** role (overwatch-role-
 * 2026-06-15 C-1, whose `OverwatchBrief` is the *actionable subset* — panels +
 * anomalies + nudges). `computeSystemHealth` (compute.ts) is the single
 * substrate; `computeOverwatchBrief` (B-03) wraps it. Never two health models
 * that drift — so these types are a CONTRACT both sides build against.
 *
 * Each panel is a green/yellow/red status light + a few key counters, so a human
 * grasps "is the system healthy, and if not, which panel is red?" in two seconds
 * (D-003). A flaky source greys its card (`unknown`) — it never blanks the tab.
 */

import type { PerfVerdict } from './perf-budgets';
import type { PerfRegressionProducerHealth } from './perf-regression-rig';
import type { GitSyncFailingLeg } from '../harness/git-sync/git-sync-escalation';
import type { ScorecardFreshnessStatus } from '../scorecard-freshness';

/**
 * A panel's health light. `unknown` = the source could not be read this tick
 * (greyed, NOT a fabricated outage — fail-soft, mirroring learning-infra-health's
 * leg model). The status model lives in `./thresholds.ts` (one place, unit-tested).
 */
export type PanelStatus = 'ok' | 'warn' | 'crit' | 'unknown';

/** A single counter on a card. `tone` optionally colours the value. */
export interface HealthMetric {
  label: string;
  value: string | number;
  /** Optional per-metric tone (e.g. a non-zero failure count → 'crit'). */
  tone?: PanelStatus;
}

/** A drill-down link to the existing detail surface (the Queen pane, /admin/git, …). */
export interface HealthLink {
  label: string;
  href: string;
}

/** The 20 panels, in render order. `overwatch` is the autonomous
 *  supervisor's own loop health (overwatch-role-2026-06-15 #15, the
 *  who-watches-the-watcher card). `toolEfficiency` (WI-839) folds the 3
 *  measuring-code-run-adoption.mdx tool-usage metrics into one recurring card.
 *  `loops` / `coordination` / `memory` are the health-tab-v2-2026-07-12 legs
 *  (P-008/P-009/P-010) for the post-June platform machinery. */
export type PanelKey =
  | 'queen'
  | 'bees'
  | 'workItems'
  | 'workFeed'
  | 'loops'
  | 'tokens'
  | 'watchdog'
  | 'deploy'
  | 'plans'
  | 'escalations'
  | 'autonomy'
  | 'observations'
  | 'improvements'
  | 'infra'
  | 'suFleet'
  | 'coordination'
  | 'overwatch'
  | 'scout'
  | 'memory'
  | 'toolEfficiency'
  | 'contextInjection';

/** Canonical render order for the tab's status-card grid. */
export const PANEL_ORDER: readonly PanelKey[] = [
  'queen',
  'bees',
  'workItems',
  'workFeed',
  'loops',
  'tokens',
  'watchdog',
  'deploy',
  'plans',
  'escalations',
  'autonomy',
  'observations',
  'improvements',
  'infra',
  'suFleet',
  'coordination',
  'overwatch',
  'scout',
  'memory',
  'toolEfficiency',
  'contextInjection',
] as const;

export const PANEL_LABELS: Record<PanelKey, string> = {
  queen: 'Mug',
  bees: 'Cups / fleet',
  workItems: 'Work items',
  workFeed: 'Work-feed',
  loops: 'Engine loops',
  tokens: 'Tokens / gateway',
  watchdog: 'Watchdog',
  deploy: 'Git-sync / deploy',
  plans: 'Plans',
  escalations: 'Escalations',
  autonomy: 'Autonomy',
  observations: 'Observations',
  improvements: 'Improvements',
  infra: 'Infra',
  suFleet: 'SU fleet',
  coordination: 'Coordination',
  overwatch: 'Kettle',
  scout: 'Blender / ideation',
  memory: 'Memory',
  toolEfficiency: 'Tool efficiency',
  contextInjection: 'Context injection',
};

/**
 * An owner acknowledgement on a panel (health-tab-v2 P-004 / D-A). An acked
 * panel renders muted-with-badge and is EXCLUDED from `overall`. The ack covers
 * severities UP TO `status` (an ack at 'warn' does NOT mute a later 'crit' —
 * escalation re-alarms) and auto-clears when the panel recovers to ok or the
 * snooze expires.
 */
export interface PanelAck {
  /** The severity acked ('warn' | 'crit'). */
  status: Extract<PanelStatus, 'warn' | 'crit'>;
  reason: string;
  ackedBy: string;
  /** ms epoch. */
  ackedAt: number;
  /** ms epoch hard expiry, or null (= until recovery). */
  snoozeUntil: number | null;
}

/**
 * One status card. `data` carries the raw structured reading (what the overwatch
 * brief maps over + the card drills into); `metrics` is the glanceable subset the
 * card shows. `error` is set (and `status` = 'unknown') when the collector threw.
 * `ack` (P-004) marks an owner-acknowledged panel — muted in the UI, excluded
 * from the overall roll-up while the ack covers the current severity.
 */
export interface HealthPanel<T = unknown> {
  key: PanelKey;
  label: string;
  status: PanelStatus;
  /** One human line ("looping, last wake 4m ago" / "STALLED 47m — no wake armed"). */
  summary: string;
  metrics: HealthMetric[];
  link?: HealthLink;
  data: T | null;
  error?: string;
  ack?: PanelAck;
}

// ── per-panel data shapes ────────────────────────────────────────────────────

/** Queen loop health — the failure mode the tab exists for (origin 2026-06-15). */
export interface QueenHealth {
  potSlug: string | null;
  /** Is the colony meant to be running (getHiveStarted)? false = paused. */
  started: boolean;
  /** started && stale past the stall threshold && demand queued && not mid-turn. */
  stalled: boolean;
  /** A tracked hive turn is live right now (don't call a working Queen "stalled"). */
  midTurn: boolean;
  /** An active hive-wake routine with a next_fire_at exists. */
  armed: boolean;
  /** ms epoch of the last wake activity (launch fire or routine fire). */
  lastWakeAt: number | null;
  /** ms since the last wake activity (the stall clock). */
  staleForMs: number | null;
  /** ms epoch of the next armed wake. */
  nextFireAt: number | null;
  /** (armed || midTurn) && not stalled — the loop is keeping cadence (a fired,
   *  re-declaration-pending one-shot routine is momentarily unarmed but still on-cadence). */
  cadenceOk: boolean;
  /** Hive watchdog fallback fires in the last 24h (a forgot-to-declare signal). */
  watchdogFires24h: number;
  /** Standing demand a forgotten wake would strand. */
  demand: { todoItems: number; startedPlans: number };
  /** Governed decisions this window, auto vs gated (decision-ledger). */
  decisionsWindow: { total: number; auto: number; gated: number };
  /** Open placements the Queen is currently tracking to completion. */
  workingTracked: number;
}

/** Bees / fleet. */
export interface BeesHealth {
  /** Live `bee`-role nursery spawns (running / restarting). */
  running: number;
  alive: number;
  /** Running but presence-stale (wedged / dead). */
  stale: number;
  /** Active claims whose holder is gone/stale. */
  orphanedClaims: number;
  totalLoad: number;
  /** Recent autonomous-role spawns that failed before a turn because the selected model is unavailable/inaccessible. */
  invalidModelFailures: number;
  /** Open-placement dispositions (the completion watchdog). */
  placements: { recovering: number; cursed: number; stranded: number; workingTracked: number };
}

/** Work items by lifecycle state. */
export interface WorkItemsHealth {
  total: number;
  byState: Record<string, number>;
  todo: number;
  inProgress: number;
  blocked: number;
  needsHuman: number;
  done: number;
  // Stuck-items recovery health (work-queue-stuck-item-recovery P-008 / P-009).
  // OPTIONAL — absent when the work-queue-health read failed this tick (the panel
  // still renders its base counts, fail-soft).
  /** Freed-but-non-dispatchable feature rows (should be ~0; any >0 is a real anomaly). */
  stuckFeatures?: number;
  /** Feature claims past grace still held by a dead holder (reaper backlog). */
  deadHeldClaims?: number;
  /** Open bug/change issues past grace still assigned to a dead holder. */
  deadAssignedIssues?: number;
  /** Active plan-item reservations past grace still held by a dead holder (EI-2535). */
  deadHeldAssignments?: number;
  /** Terminal proposed completions whose settlement proof has no residual paths.
   * The close proved its declared files were settled, but the authority upgrade
   * was rejected or reverted, so the completion is not retained as committed. */
  settlementAuthorityFailures?: number;
  /** Age of the stale-claim reaper's last recorded run, in seconds; null if never
   *  recorded (fresh boot / unknown). */
  reaperAgeSec?: number | null;
  /** The reaper hasn't run within its staleness window (likely wedged) — P-009. */
  reaperStale?: boolean;
}

/** Per-name routine coverage used to distinguish one late install from a routine-wide stop. */
export interface DeadRoutineNameCoverage {
  overdue: number;
  active: number;
  /**
   * WI-10002084 — the state of the RELEASE install's OWN row for this routine, i.e. the
   * install that owns the canonical shared checkout ({@link releaseInstallSlug}).
   *
   * `overdue` / `active` above are a ratio across EVERY install in the workspace, and most
   * of them are library submodules and toy pots (`hello-world`, `spoon-knife`,
   * `papercusp/libs/generic/*` — 67 git-sync rows across 67 installs, measured
   * 2026-09-20) that have nothing to do with the shared tree. A sentence about the shared
   * tree therefore cannot be licensed by that ratio; it has to be licensed by this row.
   *
   * THREE-VALUED ON PURPOSE. `'absent'` is not a variant of `'live'`: it means the release
   * install has no active row for this routine at all, so the per-install question was
   * NOT MEASURED. Collapsing it into a boolean is what lets an unmeasured leg read as a
   * measured one — see the consumer in `formatDeadRoutinesSummary` for which way that
   * ambiguity is allowed to resolve.
   */
  homeInstall?: 'overdue' | 'live' | 'absent';
}

/** Work-feed flow. */
export interface WorkFeedHealth {
  /** Ready-to-place frontier items (unblocked todo feature-family). */
  frontier: number;
  /** Of `frontier`, the count still unplaced past the stuck window
   *  (PAPERCUSP_FRONTIER_STUCK_HOURS, default 3h). An unblocked item the Queen
   *  leaves waiting for hours while she turns on cadence isn't fresh placeable
   *  work — it's gated on something she can't resolve (owner decision / live
   *  rig / fixture), i.e. correct idle. A frontier that is ALL stuck must NOT
   *  read as a placement stall (WI-3597). Subset of `frontier`; absent ⇒ 0. */
  frontierStuck?: number;
  /** Lanes held by unsatisfied blocked_by. */
  frontierBlocked: number;
  startedPlans: number;
  /** Auto-eligible, KEYED (payload.watchdogKey present) improvements stuck at
   *  attempts:0 — eligible but never dispatched (the EI-584 dead-feed signature:
   *  the feed isn't pumping ready work). EI-14223: keyless items are EXCLUDED
   *  here (see `keylessHumanReviewBacklog`) — bundling them in inflated this
   *  count with the ~5,600-item un-managed human-review pile, which is stuck at
   *  attempts:0 BY DESIGN (never auto-dispatched, per the keyless-EI policy
   *  P-014), not a genuine dispatcher stall. That inflation made this metric read
   *  as a permanently-growing trend and mis-triggered `@role:mug` nudges over a
   *  by-design backlog Mug cannot act on. */
  autoEligibleStuck: number;
  /** Auto-eligible KEYLESS (no payload.watchdogKey — human-filed/manual capture)
   *  improvements sitting at attempts:0. Per the keyless-EI policy (P-014) these
   *  are surfaced for HUMAN REVIEW (`improvements:keyless-digest`) and are NEVER
   *  auto-dispatched — this count is an owner/hygiene metric, NOT a Mug- or
   *  dispatcher-actionable signal, and must never be added into
   *  `autoEligibleStuck` or used to trigger a Mug nudge/escalation (EI-14223).
   *  Optional; absent ⇒ 0 (prior callers/fixtures unaffected). */
  keylessHumanReviewBacklog?: number;
  /** Acceptance-carry visibility (P-027). Counts are read from the same
   * harness_plans/work_items authorities used by the drain sweep; a missing
   * driver is durable backlog, not an absent plan. */
  acceptanceDrain?: {
    awaiting: number;
    withDriver: number;
    withoutDriver: number;
    escalated: number;
    oldestPlanUpdatedAt: string | null;
  };
  /** Active routines whose next_fire_at is long overdue (the dead-routine / EI-584 signal).
   *  ⚠ EI-20045691451471399: this is the UNCAPPED population count, NOT `deadRoutineNames.length`
   *  — the names are a bounded display list. Deriving the count from that list is what reported
   *  a measured 101-of-151 engine freeze as "20 dead routine(s)", pinned at the old fetch cap. */
  deadRoutines: number;
  /** Exemplars to NAME: fleet-blocking routines (git-sync / green-checkpoint / release-trigger)
   *  first, then most-overdue. A BOUNDED slice of `deadRoutines` — never its measure. */
  deadRoutineNames: string[];
  /** Active in-scope durable routines — the denominator that makes `deadRoutines` legible
   *  ("101 of 151" reads as an engine freeze; a bare "101" does not). Optional; absent ⇒
   *  unknown, in which case render the bare count rather than inventing a ratio. */
  deadRoutinesInScope?: number;
  /** Distinct routine NAMES overdue. `deadRoutines` counts ROWS and this table holds one row
   *  per install (git-sync alone is 59 rows here), so the two differ by a large factor — and
   *  `deadRoutineNames` is deduped, so any "+N more" must be computed against THIS, not the row
   *  count. Optional; absent ⇒ unknown. */
  deadRoutinesDistinct?: number;
  /** Every fleet-blocking routine among the overdue set, reported in FULL regardless of the
   *  exemplar cap — so a fleet-wide commit outage can never be announced under a bystander
   *  routine's name (the filed incident led with `pr-poll` and omitted `git-sync`). */
  deadRoutineCriticalNames?: string[];
  /** Per-name overdue/active row counts. A single routine name can have one row per install,
   * so a name appearing in `deadRoutineCriticalNames` is not by itself fleet-wide evidence. */
  deadRoutineCoverage?: Record<string, DeadRoutineNameCoverage>;
  /** `deadRoutineNames` was cut to the exemplar cap (more routines are overdue than are named).
   *  Optional; absent ⇒ the list is complete. Bounds the LIST only — `deadRoutines` stays exact. */
  deadRoutineNamesTruncated?: boolean;
  /** Currently-PAUSED (active:false) routines flagged stale (WI-5839 /
   *  EI-18654017982759582 items 2+3): an unattributed pause (no recorded
   *  metadata.pause.reason) is flagged immediately; a reasoned pause is flagged once
   *  it crosses its age threshold. `readDeadRoutines` above only ever looks at
   *  active=true rows, so a pause — deliberate or not — was otherwise invisible no
   *  matter how long it persisted (release-trigger sat paused ~4 days, twice, before
   *  a human happened to notice). Optional; absent ⇒ 0 (prior fixtures unaffected). */
  stalePausedRoutines?: number;
  stalePausedRoutineNames?: string[];
  /** Subset of `stalePausedRoutines` that are release/deploy-critical routines
   *  (release-trigger, green-checkpoint) — a paused deploy pipeline silently drops
   *  every agent's "shipped" work into a void, so this drives `crit` rather than
   *  `warn`. Optional; absent ⇒ 0. */
  stalePausedCriticalRoutines?: number;
  /** Currently stale-paused routines with a measured downstream backlog. */
  stalePausedBacklogRoutines?: number;
  /** Measured downstream backlog depth (deduplicated when several routine rows share a workspace queue). */
  stalePausedBacklogDepth?: number;
  /** EI-19462267124852221: the stale-paused read FAILED this tick (its fail-soft catch
   *  fired), so `stalePausedRoutines: 0` above means "NOT OBSERVED", not "observed zero".
   *  Without this flag the two are indistinguishable, and the liveness alarm's
   *  auto-resolve-on-recovery reads an unreadable tick as "condition recovered".
   *  ⚠ That conflation is real, but it is NOT established as the cause of the measured
   *  flap (5,303 strictly-alternating fire/resolve pairs in 30d, byte-identical summary,
   *  105 routines) — see the SCOPE note on `unobservableLivenessSignatures`. This flag
   *  exists chiefly because that sub-read's catch is otherwise INVISIBLE: it logs nothing
   *  and leaves no trace, so the hypothesis could not be tested at all.
   *  Optional; absent ⇒ the read succeeded (prior fixtures unaffected). */
  stalePausedRoutinesUnreadable?: boolean;
  /** The pot/workspace SURVEY failed this tick (collectWorkFeed's `catch` at the
   *  frontier read fired), so `frontier`/`frontierStuck`/`frontierBlocked`/
   *  `startedPlans` above are FABRICATED ZEROS meaning "NOT OBSERVED", not
   *  "observed zero". Same `unreadable ≠ clear` conflation as
   *  `stalePausedRoutinesUnreadable` — but on a load-bearing input, which is why
   *  it is not merely cosmetic: `cupPlaceableFrontier` (= frontier − frontierStuck)
   *  is the leg that DECIDES `beesIdleDecision`, measured over 08-04..08-07
   *  (workspace fact `panel-bees-deciding-leg-is-cup-placeable-frontier`: every
   *  suppressed panel:bees resolve read placeable=0 ⇒ `idle-by-design`, the one
   *  unsuppressed clear read placeable=1 ⇒ `cup-work-waiting`). So an unreadable
   *  survey fabricates a 0, which reads as "no cup work waiting", which SUPPRESSES
   *  the "bees are dead" alarm — the survey being broken silently buys silence
   *  about the thing the alarm exists to report.
   *  Optional; absent ⇒ the survey read succeeded (prior fixtures unaffected). */
  frontierUnreadable?: boolean;
}

/**
 * The structured gateway-internal metrics + the wedge/throttle verdict (B-GW-5). Sourced from the
 * gateway's own `/stats` (its admission queue + AIMD state), DISTINCT from the fleet rate-governor's
 * view (`fleetInFlight`/`fleetCap`). Makes the watchdog's silent auto-restart signature VISIBLE.
 * Null on `TokensHealth.gateway` when the gateway is unreachable / not in the egress path.
 */
export interface GatewayPanelMetrics {
  inFlight: number;
  queueDepth: number;
  /** Live effective admission cap (AIMD-adjusted). */
  maxConcurrent: number;
  /** Configured admission ceiling; null on a pre-AIMD gateway (deploy-skew). */
  concurrencyCap: number | null;
  shed429: number;
  shedAllThrottled: number;
  failovers: number;
  upstream429: number;
  utilizationPct: number | null;
  /** AIMD effective concurrency; null on a pre-AIMD gateway. */
  aimdEffective: number | null;
  /** AIMD ceiling; null on a pre-AIMD gateway. */
  aimdCap: number | null;
  /** CONFIRMED wedge: every slot pinned + a growing queue + totalRequests frozen (watchdog restarts on this). */
  wedge: boolean;
  /** Instantaneous wedge-RISK: at the slot ceiling with work queued (not yet confirmed frozen). */
  saturated: boolean;
  /** Sustained upstream throttle (AIMD cut concurrency, fail-fast shed, or backlog overflow). */
  sustainedThrottle: boolean;
  /** P-005/W3 (D-001): a leaked admission slot the self-heal valve could NOT reclaim (the gateway's own
   *  reconcile guard counted a mismatch) — surfaces the leak as a signal instead of a silent wedge/restart. */
  slotLeak: boolean;
  /** WI-3565: instantaneous risk — the admission backlog is deep vs the LIVE ceiling (distinct from
   *  `saturated`, which needs every slot pinned; a starved queue can sit below the ceiling). */
  admissionStarvationRisk: boolean;
  /** WI-3565: `admissionStarvationRisk` CONFIRMED sustained ≥5min — the alert-worthy signal (mirrors
   *  `wedge` confirming `saturated`). Combined with idle-account headroom in `tokensStatus` /
   *  `collectTokens` to produce the crit alert (a deep queue with NO idle capacity is just normal
   *  pressure; a deep queue WITH idle healthy accounts sitting unused is the starvation bug). */
  admissionStarved: boolean;
  /** Human reasons for any non-ok signal (surfaced on the panel + the overwatch anomaly). */
  reasons: string[];
}

/** Tokens / gateway — the two starvation modes (5h-exhaustion AND RPM-pacing) + the gateway wedge. */
export interface TokensHealth {
  gatewayEnabled: boolean;
  /** null when the gateway is not in the egress path (flag off) — not probed. */
  gatewayReachable: boolean | null;
  pausedBuckets: number;
  totalBuckets: number;
  fleetInFlight: number;
  fleetCap: number;
  /** $ spend over the lookback window. */
  spendUsd: number;
  windowMs: number;
  accountsTotal: number;
  /** Can actually serve right now: not rate-paused, not weekly/5h usage-walled
   *  (`accountFull`, WI-3310), and not live edge-throttled. NOT pause-only — an
   *  account with a lapsed/never-set pause but an exhausted usage window is still
   *  excluded (EI-15875: counting it as available fabricated a false "artificial
   *  ceiling" admission-starvation escalation). */
  accountsAvailable: number;
  /** `accountsTotal - accountsAvailable` — any account that cannot currently serve
   *  (paused, usage-walled, or edge-throttled), not merely rate-paused. */
  accountsPaused: number;
  /** The gateway's own admission/AIMD metrics + wedge/throttle verdict (B-GW-5). null = not read
   *  (gateway unreachable / flag off / /stats failed) — never fabricated. */
  gateway: GatewayPanelMetrics | null;
  /** EI-19303809952284205 — the gateway's SELF-REPORTED durable-path health, straight off its
   *  `stats().db`. This is the FAST leg: the gateway knows within ~3min that its Postgres is gone.
   *  null = unknown (unreachable, flag off, or a gateway build predating the field — a long-lived
   *  gateway being exactly the process this afflicts). Never read null as healthy. */
  gatewayDb: {
    ok: boolean;
    connectionLevel: boolean;
    failingOps: string[];
    unhealthyForMs: number | null;
    lastError: string | null;
  } | null;
  /** EI-19303809952284205 — age of the FRESHEST `rate.utilizationAt` across the whole pool, i.e. how
   *  long since the gateway last landed ANY usage-window write. This is the SLOW, INDEPENDENT leg: it
   *  is computed by the operator from the account-pool projection, so it still fires when the gateway
   *  is dead outright or too old to report `gatewayDb`.
   *
   *  FRESHEST, deliberately not oldest: a single account with no traffic reaching it legitimately goes
   *  stale (observed live 2026-08-01 — ownerhandle10 sat at an 18:26Z reading because its egress proxy was
   *  transport-failing, nothing to do with sync). Taking the max would alarm on that. The real
   *  condition is that NO account has been written recently, which is the write path itself being dead.
   *
   *  null = no account has ever been observed (a fresh pool) — not a fault. */
  poolProjectionFreshestAgeMs: number | null;
}

/** Watchdog liveness. */
export interface WatchdogHealth {
  /** Hive watchdog fallback fires in the last 24h. */
  fires24h: number;
  /** A wake is armed for the started hive. */
  livenessArmed: boolean;
  staleForMs: number | null;
  /** Recent error-level notifications (anomaly proxy). */
  recentErrors: number;
}

/** Git-sync / deploy pipeline. */
export interface DeployHealth {
  deployedShortSha: string | null;
  /** Commits the integration branch (staging) has that the live :3070 doesn't. */
  deployedBehindStaging: number | null;
  /** Commits staging has that the green pin (main) doesn't — not-yet-green buffer. */
  greenPinBehindStaging: number | null;
  /** Green & deployable but not yet deployed. */
  deployedBehindGreenPin: number | null;
  /** The green pin is exactly at the staging tip (fully caught up). */
  greenPinAtStagingHead: boolean | null;
  deployedAtMs: number | null;
  /** Integration-branch HEAD commit time — a git-sync lag proxy. */
  lastCommitAtMs: number | null;
  errors: string[];
  // ── git-sync UPSTREAM delivery (EI-18 routine metadata) ──────────────────────
  // The refs above measure the DOWNSTREAM half (staging→main→live). These measure
  // the UPSTREAM half: is the local tree's work actually reaching origin? New local
  // commits keep landing while a push FAILS, so `lastCommitAtMs` stays fresh and the
  // refs alone are blind to a stalled push — the EI-18 silent-failure class (a push
  // failed every tick for ~20h with zero fleet-visible signal). Read from the worst
  // active `system:git-sync` routine's metadata that git-sync-action.ts persists.
  /** Worst active git-sync routine's effective status, or null if none/unreadable.
   * `degraded` is a read-time freshness override when the raw writer outcome is stale
   * or an in-flight fire has exceeded the scheduled stale window. */
  gitSyncStatus: 'synced' | 'conflict' | 'error' | 'nothing' | 'skipped' | 'quarantined' | 'degraded' | null;
  /** Max consecutive FAILING git-sync ticks across active routines, whatever the
   *  failing leg was. EI-19275994927087666: this is NOT a push-failure counter —
   *  it counts commit failures, conflicts and push failures alike, and reading it
   *  as "commits are not reaching origin" is what let one abandoned scratch pot's
   *  corrupt-object COMMIT failure red-alarm the whole fleet for 32h. Use
   *  `gitSyncFailingLeg` to say WHAT failed and `gitSyncWorstInstallSlug` to say
   *  WHOSE. >= 3 is the EI-18 escalation threshold. */
  gitSyncConsecutiveErrorTicks: number;
  /** EI-19275994927087666: which install owns the worst-wins failure above, so a
   *  responder can tell "the release pipeline is broken" from "someone's dead
   *  scratch pot is broken". null when nothing is failing. */
  gitSyncWorstInstallSlug: string | null;
  /** EI-19275994927087666: which LEG of git-sync failed, classified from the
   *  routine's own `last_error` (plus `push_mode`, since a `commit-only:*` member
   *  cannot have a push failure by definition). Never render "push" / "not
   *  reaching origin" unless this is 'push'. null when nothing is failing. */
  gitSyncFailingLeg: GitSyncFailingLeg | null;
  /** Live superproject + submodule commits ahead of upstream. 0 proves a stale
   *  error counter no longer means commits are waiting to reach origin; null means
   *  the live git check was unavailable, so the metadata counter stays authoritative. */
  gitSyncPushBacklog: number | null;
  /** ms epoch of the freshest successful git-sync (metadata.last_synced_at), or null. */
  gitSyncLastSyncedAtMs: number | null;
  /** Oversized files git-sync EXCLUDED from the auto-commit (they will never push). */
  gitSyncOversizedCount: number;
  /** P-009 (ex-P-010, EI-22489500008234936): the most scheduler intervals any active git-sync install
   *  that is not failing (last_status not error/conflict, which the failure escalation already covers)
   *  has missed, from deriveGitSyncFreshness.missed_intervals. Optional: absent/null = not measured. */
  gitSyncMaxMissedIntervals?: number | null;
  /** The install that holds `gitSyncMaxMissedIntervals`. */
  gitSyncMissedIntervalsInstallSlug?: string | null;
  /** True when the git-sync routine read FAILED (the fail-soft catch fired), so a null
   *  `gitSyncMaxMissedIntervals` means "not observed", never "recovered". */
  gitSyncMissedIntervalsUnreadable?: boolean;
  // ── RUNNING-CODE freshness (WI-1258129) ──────────────────────────────────────
  // Every field above measures GIT POSITIONS (staging→main→live) or git-sync
  // delivery. None of them can see the distinct failure where the refs are all
  // healthy and a LONG-LIVED PROCESS is still executing code from before the
  // deploy: bg-host ran 175-minute-stale code while this panel read `ok`, and a
  // reconciler whose every write was reverted is indistinguishable from one that
  // works. The gap was found only by chasing an unrelated symptom, which is
  // exactly what a health panel exists to prevent.
  /** bg-host's ActiveEnterTimestamp (epoch ms) — when the long-lived host process
   *  last (re)started. Ground truth from systemd; null when unresolvable (unit not
   *  running, no systemd user session, non-Linux, timeout). */
  bgHostStartedAtMs: number | null;
  /** True when bg-host started BEFORE the currently-served deployment, so it cannot
   *  be executing the deployed code. `null` = NOT PROVEN EITHER WAY (an input was
   *  unresolvable) — deliberately not `false`, mirroring `RunningGeneration.staleHost`'s
   *  fail-toward-not-proven-fresh convention, so an unreadable host never renders a
   *  false all-clear. */
  bgHostCodeStale: boolean | null;
}

/** Plans. */
export interface PlansHealth {
  active: number;
  started: number;
  shipped: number;
  draft: number;
  itemsDone: number;
  itemsTotal: number;
  /** Started plans with no op update in the aging window. */
  stalledPlans: number;
  /** Plans force-STARTED while still status=draft — the queen-plan-selection
   *  anti-pattern the rubric flags ("does not force-start a draft"). Surfaced so the
   *  Overwatch can rate queen-plan-selection instead of 'unknown' (hive-loop-supervision
   *  2026-06-21). */
  startedDraft: number;
}

/** Escalations. */
export interface EscalationsHealth {
  open: number;
  oldestAgeMs: number | null;
  bySeverity: Record<string, number>;
  /** Open escalations older than the aging threshold. */
  aging: number;
  /** Of `aging`, those that CROSSED the threshold within the last 24h — the
   *  "new incident" subset the panel status keys on (health-tab-v2 P-003).
   *  Standing aging (aging - agingNew) is a muted metric, not an alarm: a
   *  month-old backlog re-warning every tick is banner blindness, not signal. */
  agingNew: number;
}

/** Autonomy gate ceilings + tripwires. */
export interface AutonomyHealth {
  categories: number;
  locked: number;
  /** category → effectiveCeiling (the compact heatmap). */
  byCeiling: Record<string, number>;
  tripwiresArmed: number;
  tripwiresTripped: number;
  tripwiresReverted: number;
}

/** Observation lane (the pre-idea sensor readings). */
export interface ObservationsHealth {
  /** Open observations — the TRUE count (countIssues), not the sampled list
   *  length (health-tab-v2 P-002: the old read pinned at the 500 list cap). */
  laneCount: number;
  /** recentByRole/newestAt derive from a bounded sample (newest 500); true when
   *  laneCount exceeds the sample, so per-role counts are partial. */
  sampled?: boolean;
  recentByRole: Record<string, number>;
  newestAt: number | null;
}

/** Improvements queue. */
export interface ImprovementsHealth {
  open: number;
  autoEligible: number;
  humanQueue: number;
  byKind: Record<string, number>;
  bySeverity: Record<string, number>;
}

/**
 * MCP tool-call transport health — the resilient MCP proxy's windowed FAILURE summary
 * (backend-reliability-100pct-2026-07-03 W8 / P-008). Sourced from the proxy's durable
 * failure ledger (~/.papercusp/mcp-proxy-failures.jsonl, written by
 * apps/operator/lib/mcp-proxy/proxy.ts). These connection-level failures NEVER create a
 * `tool_invocations` row (they error at the HTTP layer, below tool dispatch), so the
 * agent-facing failure rate was under-counted and "transient errors" felt normal — this
 * is the SLO signal that ends that culture. Null on `InfraHealth.mcpProxy` when the
 * ledger is unreadable (greyed leg, never fabricated). Computed by
 * system-health/mcp-proxy-health.ts (`summarizeMcpProxyHealth`).
 */
export interface McpProxyHealth {
  /** The lookback window these counts cover (ms). */
  windowMs: number;
  /** All failure records in the window (hard + soft). */
  total: number;
  /** HARD failures — a real agent-facing tool-call error the proxy could NOT hide: the
   *  retry window exhausted (upstream refused the whole time → 503), a post-connect
   *  upstream error not safely retried (→ 502), or a forwarded non-2xx bearing the
   *  stale-socket-400 signature (W1.3 regression: status 400 + `connection: close`). The
   *  SLO number — sustained non-zero reds the Infra panel → operator_degraded → overall. */
  hardFailures: number;
  /**
   * SOFT terminal misses on cheap repeating beats (heartbeat, owner-presence, or scheduled
   * context injection). The replacement is already scheduled, so these records remain visible
   * in the summary but never inflate the hard-failure SLO.
   */
  softBeatFailures: number;
  /** SOFT: the proxy retried a refused upstream and RECOVERED (a deploy-restart window it
   *  absorbed; the agent saw success). Informational — elevated under deploy churn, never
   *  alarming (the resilience working as designed). */
  recovered: number;
  /** Forwarded non-2xx that were NOT the stale-socket signature NOR a benign probe (a
   *  genuine upstream 4xx/5xx). */
  otherNon2xx: number;
  /** P-006: benign probe/heartbeat non-2xx (408 heartbeat, GET-405 liveness probe) —
   *  explicitly separated so it can never inflate hardFailures/otherNon2xx or any alarm.
   *  Informational only. */
  benign: number;
  /** EI-12102/EI-12211: records from a NON-instance source (`listenPort: 0` — never a real
   *  listening proxy any client could route through; the desktop-sidecar-startup-race
   *  signature) — excluded from every alarm class above, counted here for forensic
   *  visibility only. Never alarming. */
  nonInstance: number;
  /**
   * WI-6740 upstream-SILENCE stalls on the control-plane handshake (`handshake_timeout_retry`),
   * i.e. :3070 accepted the connection and then sent no response headers within
   * `HANDSHAKE_UPSTREAM_TIMEOUT_MS`, so the proxy replayed the write-free batch.
   *
   * NOT a hard failure, and deliberately not folded into one: the replay is exactly WI-6740's
   * fix working, turning a stall into a slightly-slower connect. But it must never be silent
   * either, which is why it is its own field rather than a `byKind` tally. An MCP client
   * fetches the tool catalog ONCE, at connect — before the replay existed, a ~10s stall landing
   * on that handshake left the session tool-dark for its entire multi-hour life (269 stalls
   * 2026-07-10..08-01, every one logged `recovered`, unfixed for three weeks because, in
   * WI-6740's own words, "the severity is invisible to the layer that observes it").
   *
   * So read a sustained nonzero as: the session-fatal condition is RECURRING and is currently
   * being caught. It is the leading indicator for that outage class, not a health signal.
   */
  handshakeStalls: number;
  /**
   * EI-19305299022434394 admission-control sheds (`shed_max_in_flight`) — a request refused
   * with 429 BEFORE it ever opened an upstream socket, because the proxy already held
   * `maxInFlight` forwards. Agent-facing (the caller really did get a 429) but NOT a hard
   * failure: shedding is the bound working, and the alternative measured on 2026-08-01 was
   * 3,450 sockets held open simultaneously with 32-89 minute waits. Sustained nonzero means
   * :3070 is not draining — the congestion-collapse precursor.
   */
  shed: number;
  /** Count by raw `kind` — every kind the ledger carries, including ones no alarm class
   *  above consumes. Retained as the forensic catch-all, but note that a kind appearing
   *  ONLY here is a kind nothing can page on: if a new `recordProxyFailure` kind is
   *  agent-affecting, give it a field above rather than leaving it to this tally (that
   *  omission is what hid `handshake_timeout_retry`). */
  byKind: Record<string, number>;
  /** ms epoch of the newest failure record in the window, or null when none. */
  newestAt: number | null;
}

/**
 * Fresh host-pressure evidence folded from the resource-governor live-health
 * snapshot. The sample is deliberately separate from the verdict: a missing,
 * stale, or malformed reading is unknown, never a healthy zero.
 */
export interface HostPressureSample {
  sampledAtMs: number | null;
  effectiveCores: number | null;
  cpuPsiSomePct: number | null;
  memoryPsiSomePct: number | null;
  memoryPsiFullPct: number | null;
  runnableCount: number | null;
  blockedCount: number | null;
}

export interface HostPressureHealth {
  status: PanelStatus;
  summary: string;
  sampledAtMs: number | null;
  ageMs: number | null;
  effectiveCores: number | null;
  cpuPsiSomePct: number | null;
  memoryPsiSomePct: number | null;
  memoryPsiFullPct: number | null;
  runnableCount: number | null;
  blockedCount: number | null;
  runnablePerCore: number | null;
  blockedPerCore: number | null;
  /** Threshold reasons only; these describe pressure, not causality. */
  reasons: string[];
  /** Missing/stale/invalid inputs that prevented a healthy verdict. */
  unknown: string[];
}

/** Infra — PG + gateway reachability + fresh host pressure + the per-thread perf
 *  verdict (F1/P-030) + the MCP tool-call transport SLO (W8/P-008). */
export interface InfraHealth {
  pg: {
    version: string;
    total: number;
    active: number;
    idle: number;
    /** P-008: postmaster boot time, epoch MILLIS (null = unreadable). A change
     *  across ticks = a PG restart; the infra-liveness alarm watches it for drift. */
    postmasterStartMs: number | null;
  } | null;
  gatewayReachable: boolean | null;
  /** Fresh host-pressure observation from resource-governor live-health.
   *  `unknown` is an honest lack of current evidence, never a healthy zero.
   *  Optional for deploy-skew compatibility with older shared snapshots. */
  hostPressure?: HostPressureHealth | null;
  /** Per-thread perf-SLO verdict from Lane E's latest perf-signals-v1 capture
   *  (F1/P-030). null = no capture / E1 not running on this box; status 'unknown' =
   *  stale. Budgets are per-thread (worker CPU%, event-loop lag, CLOSE_WAIT,
   *  reachability) — never loadavg-absolute (128-core box; round-4 D-002 reframe). */
  perf: PerfVerdict | null;
  /** Persisted performance-history freshness, read independently of its producer.
   * Optional for older shared snapshots; unknown is never treated as a healthy sample. */
  performanceHistory?: PerfRegressionProducerHealth;
  /** MCP proxy windowed failure summary (W8/P-008). null = ledger unreadable this tick
   *  (greyed leg, fail-soft — never blanks the panel). Absent-file = a healthy zero. */
  mcpProxy: McpProxyHealth | null;
  /**
   * PG connection-pool acquisition pressure (P-006/W4). `probeMs` = the latency of this
   * tick's pgHealth() round-trip (a coarse but real acquire-latency proxy: pgHealth
   * acquires a connection + runs two pg_stat_activity aggregates); `band` classifies it
   * (elevated ⇒ contended, critical ⇒ starved — the routinesTick freeze mode). Measured
   * from THIS process, so it observes the shared PG server cross-process-safely (it does
   * NOT read the bg-host tick's in-process shed counter). OPTIONAL (deploy-skew-safe):
   * absent on an older projection ⇒ treated as no signal. null when PG is unreadable. */
  pool?: { probeMs: number; band: 'ok' | 'elevated' | 'critical' } | null;
  /** Disk pressure (health-tab-v2 P-011, mirrors the fedplane script's 90% warn):
   *  used% per watched mount (~/.papercusp + the repo volume, deduped by device).
   *  OPTIONAL + null when statfs is unavailable — never fabricated. */
  /** `freeGb` = free space in whole GB (rounded down), when statfs reports it — used to
   *  scale the crit summary's wording by real headroom, not just the raw %. `band` =
   *  this VOLUME's hysteresis-classified status (EI-19944041837110102 / disk-alarm-flap),
   *  computed by the collector from `diskBandWithHysteresis` against the PREVIOUS tick's
   *  band for the same path; optional so hand-built fixtures without it fall back to a
   *  plain (no-hysteresis) threshold check in `infraStatus`/`infraSummary`. */
  disk?: Array<{
    path: string;
    usedPct: number;
    freeGb?: number;
    band?: Extract<PanelStatus, 'ok' | 'warn' | 'crit'>;
  }> | null;
  /** Backup freshness (P-011): newest snapshot whose Kopia artifact AND
   *  pre-snapshot DB dump are both known-good. `lastDbDumpOk` is the explicit
   *  tri-state outcome of the newest row; null means legacy/unknown, never
   *  inferred as complete. null = tables unreadable/absent this tick. */
  backup?: {
    lastOkAtMs: number | null;
    ageMs: number | null;
    lastStatus: string | null;
    lastDbDumpOk?: boolean | null;
  } | null;
  /** Migration drift (P-011, the db:check_drift source): migrations on disk not
   *  yet recorded in schema_migrations. null = drift unreadable this tick. */
  migrationDrift?: { unapplied: number } | null;
  /**
   * Per-tool handler failure rate over a short window (EI-18798264517111160) — the
   * WRITE-PATH outage detector. `mcpProxy` above watches the TRANSPORT (can the call
   * be delivered); this watches the HANDLER (did the tool's own work succeed), which
   * is the gap that let facts:assert fail fleet-wide for ~3h on 2026-07-27 while every
   * liveness probe stayed green.
   *
   * Derived from `tool_invocations` — no synthetic traffic and no enumerated probe
   * list, so it covers every tool including ones added later. OPTIONAL
   * (deploy-skew-safe: absent on an older projection ⇒ no signal) and null when the
   * table is unreadable this tick (greyed leg, fail-soft — never blanks the panel).
   * See lib/tool-failure-rate.ts for the measured thresholds.
   */
  toolFailures?: ToolFailureVerdict | null;
}

/**
 * The Infra panel's carry of the tool-failure reading (EI-18798264517111160). Kept
 * deliberately small — the panel needs the verdict and enough to render/escalate it,
 * not the whole per-tool breakdown.
 */
export interface ToolFailureVerdict {
  rating: 'healthy' | 'degraded' | 'broken' | 'unknown';
  /** Human-readable one-liner naming the worst tool, its rate, and its error code. */
  evidence: string;
  /** Tools at or above the crit cutoff — what the escalation names. Empty unless broken. */
  brokenTools: string[];
  /** Minutes of lookback behind this reading. */
  windowMin: number;
  /** Worst failure percentage seen, or null when nothing breached the warn cutoff. */
  worstPct: number | null;
  /** System-attributable calls in the window (0 ⇒ rating 'unknown'). */
  totalCalls: number;
}

/** SU fleet (interactive collaborators) presence. */
export interface SuFleetHealth {
  total: number;
  live: number;
  stale: number;
  byRole: Record<string, number>;
}

/**
 * Engine loops (health-tab-v2 P-008) — the `loop:arm` self-wake mechanism's
 * health: active `loop-*` routines (armed), how many are overdue past the
 * dead-routine window, and recent failure streaks from `autoloop_state`.
 * Only RECENTLY-FIRED autoloop rows count (the table accretes one row per
 * historical loop owner — ~370 stale rows at v2 time — so raw counts lie).
 */
export interface LoopsHealth {
  /** Active loop-* routines (armed self-wakes). */
  armed: number;
  /** Of `armed`, next_fire_at overdue past the dead-routine window. */
  overdue: number;
  overdueNames: string[];
  /** autoloop_state loop-* rows fired in the last 24h with consecutive_errors >= 3. */
  failureStreaks: number;
  /** ms epoch of the newest loop-* fire in the last 24h, or null. */
  lastFireAt: number | null;
}

/**
 * Coordination health (health-tab-v2 P-009) — the fleet-coordination failure
 * modes the playbook treats as highest-priority, previously visible only via
 * coord:glance: unanswered DIRECTED messages (a blocked peer waiting on a
 * reply), sessions at critical context (about to force-compact), event-await
 * waiters with no expiry going stale (the "sleeps-forever" class), and fleets
 * with live members but NO live leader (the silent-mass-failure mode).
 */
export interface CoordinationHealth {
  /** Live sessions with >=1 unanswered directed message addressed to them. */
  unansweredAgents: number;
  /** Total unanswered directed messages across live sessions. */
  unansweredTotal: number;
  /** Age of the oldest unanswered directed message (ms), or null. */
  unansweredOldestMs: number | null;
  /** Live sessions past ~90% of their compaction limit. */
  criticalContext: number;
  /** Live sessions past ~75% of their compaction limit. */
  highContext: number;
  /** Active event_awaits (fired_at/cancelled_at null). */
  activeAwaits: number;
  /** Active awaits with NO expiry older than 24h — likely stranded waiters. */
  staleAwaits: number;
  /** Fleets with >=1 live member and no live leader. */
  leaderlessFleets: number;
  /** Distinct fleets with >=1 live member. */
  liveFleets: number;
  /** Active claims whose holder is DEAD (ended/heartbeat-stale) — abandoned work
   *  awaiting reclaim (WI-4460; same derivation as coord:glance's orphaned_claims). */
  orphanedClaims: number;
  /** Active claims whose holder is ALIVE but not advancing the item — the
   *  live-but-not-progressing reclaimable set. NB: unlike the claim-integrity
   *  watchdog (EI-10125), this count does NOT suppress checkpoint-documented
   *  holds, so it can legitimately sit >0 on a deliberately-parked lane. */
  stalledClaims: number;
  /** Plan-item deliverables held by >1 principal via the work-item↔plan-item
   *  coverage edge (EI-6074) — the cross-claim-table duplicate that reads as
   *  orphaned:0/stalled:0 while two live agents run the same work. */
  coverageCollisions: number;
  /** Live members deliberately parked on a non-inbox events:await key — benched
   *  by design (idle-but-healthy), NOT stalled/abandoned. Informational only. */
  parkedMembers: number;
}

/**
 * Memory-system health (health-tab-v2 P-010) — folds the SAME readMemoryHealth
 * the Learning tab's MemoryHealthCard renders (D-C: reuse the computer, never a
 * second derivation). `entityRows` is the EI-366 fragment-leak canary's input;
 * the card links to the Learning tab for the full view.
 */
export interface MemoryPanelHealth {
  /** REAL memories (entity rows excluded — the honest count). */
  totalMemories: number;
  /** Segregated mem0 entity-linking rows sharing the canonical table. */
  entityRows: number;
  /** memory_feedback events in the trailing 30 days — the loop's pulse. */
  feedback30d: number;
  /** Recall zero-hit rate (0..1) when the telemetry exposes one, else null. */
  zeroHitRate: number | null;
  /**
   * Recalls RECORDED in the trailing 7 days — the denominator `zeroHitRate` is
   * computed over, and the reason it must travel with it (EI-10625). The rate
   * alone cannot distinguish "no recall ever missed" from "no recall was ever
   * RECORDED": `readRecallHealth` computes `recalls > 0 ? zeroHit/recalls : 0`,
   * so a dark telemetry pipeline yields 0.0 — the *best* possible reading.
   */
  recalls7d: number;
  /**
   * False when the recall-telemetry read itself FAILED (the aggregate degraded
   * to zeros). Absence of signal is not health: without this the panel cannot
   * tell a healthy store from an unreadable one, and reports the healthy answer.
   */
  recallTelemetryOk: boolean;
}

/**
 * Overwatch — the autonomous system-health supervisor's OWN loop health (panel
 * #15, overwatch-role-2026-06-15 / D-004 who-watches-the-watcher). Sourced from
 * B-07's control state + B-09's liveness + the `papercusp-overwatch` flag — NOT a
 * second aggregation (D-006). `flagEnabled === false` is the role's intended-dark
 * default (greyed, not a failure); a started loop that has gone `alive === false`
 * is the supervisor itself dying (crit).
 */
export interface OverwatchPanelHealth {
  /** The `papercusp-overwatch` activation flag (D-009). false = intentionally dark. */
  flagEnabled: boolean;
  /** The persisted `overwatch_started` bit (B-07). true = the loop should be running. */
  started: boolean;
  /** Liveness (B-09 isOverwatchAlive): true = alive, false = dark, null = not-in-play/uncomputable. */
  alive: boolean | null;
  /** A live `overwatch-wake` routine with a next fire exists (B-09). */
  armed: boolean;
  /** The configured wake cadence in seconds (B-07; default 600). */
  cadenceSec: number;
  /** ms epoch of the last overwatch wake fire, or null (never fired). */
  lastWakeAt: number | null;
  /** ms epoch of the next armed wake, or null. */
  nextFireAt: number | null;
  /** ms since the last wake fire (the stall clock), or null. */
  staleForMs: number | null;
  /** Overwatch watchdog fallback fires in the last 24h (a forgot-to-declare signal). */
  watchdogFires24h: number;
  /**
   * Monitor-the-monitor (hive-loop-supervision 2026-06-21): the emission freshness of
   * the every-wake pot-coordination-health scorecard, checked SINCE the Overwatch's
   * ACTUAL last wake. null when not applicable (paused / never-woke / flag-off / read
   * error). `fresh` = a COMPLETE scorecard landed since the last wake.
   */
  scorecardEmission: {
    status: ScorecardFreshnessStatus;
    lastCompleteAt: string | null;
    missingCount: number;
  } | null;
  /**
   * True when the Overwatch is alive+started, its last wake has SETTLED past the grace,
   * and that wake emitted no COMPLETE scorecard — the Owner-#1 every-wake mandate was
   * skipped. The time-sensitive grace lives in compute.ts (where `now` is available) so
   * the liveness alarm stays a pure read over the snapshot.
   */
  scorecardSkipped: boolean;
}

/** Scout ideation health (`scout_ticks`) — surfaced so the Overwatch can rate
 *  ideation-quality instead of 'unknown' (hive-loop-supervision 2026-06-21). */
export interface ScoutHealth {
  /** ms epoch of the newest tick (any status), or null when none. */
  lastTickAt: number | null;
  /** ms epoch of the newest RAN tick (a full cycle), or null. */
  lastRanAt: number | null;
  /** Ideas generated by the most recent RAN tick. */
  ideasLastRun: number;
  /** Total ideas generated across RAN ticks in the window. */
  ideasInWindow: number;
  /** RAN ticks (full cycles) in the window. */
  ranInWindow: number;
  /** Transport-death: cycles RAN in-window but generated ZERO ideas (a transport
   *  failure / dead ideator path, NOT low quality). False when no cycle ran (idle,
   *  not dead) or ideas > 0. The plan's "Scout 0 ideas/24h" signal. */
  transportDeath: boolean;
  /** su-ideate partition (WI-4465): origin='su-ideate' passes ride the same
   *  scout_ticks ledger (migration 571) but are deliberately excluded from the
   *  Scout cadence/health verdict above — surfaced here as their own leg.
   *  Informational only (never affects status); null = read unavailable. */
  suIdeate: {
    /** su-ideate passes recorded in the 24h window. */
    passesInWindow: number;
    /** Ideas filed/routed by those passes (ideas_routed ← ideasFiled mapping). */
    ideasFiled: number;
    /** ms epoch of the newest su-ideate pass (any window), or null. */
    lastPassAt: number | null;
  } | null;
  /** Routed-idea grading loop (scout_routed_ideas, migration 234): is anyone
   *  closing the feedback loop on routed ideas? Informational only; null = read
   *  unavailable.
   *
   *  P-010: there is deliberately NO field called `ungraded`. That name meant three
   *  different populations on three surfaces (15 / 1,103 / "1,082 su filings" — the
   *  last a scout count wearing an su label). Read `actionable` for the drainable
   *  backlog and `allUngraded` only WITH its label; see scout/ungraded-scope.ts. */
  grading: {
    gradedInWindow: number;
    /** Ungraded + artifact still open + at/after that origin's epoch floor, all origins. */
    actionable: number;
    /** The same, split by producer — su-ideate and scout drain differently. */
    actionableByOrigin: Record<string, number>;
    /** Every ungraded row, any origin/outcome/age. Never render this unlabelled. */
    allUngraded: number;
    /**
     * D-014: the forward-only floor APPLIED to each origin in this census. Published
     * because the counts above are meaningless without it — scout's actionable backlog
     * drops from 592 to a handful the day its own floor lands, and a reader without the
     * floor cannot tell that from a producer that stopped filing or a broken query.
     */
    epochMsByOrigin: Record<string, number>;
  } | null;
  /**
   * Learning-loop authorship provenance divergence (WI-6338): how far apart the
   * three independent "the learning loop produced this" records — `payload.sourceRole
   * = 'Scout'`, the `improvement-source:Scout` topic tag, and a `scout_routed_ideas`
   * row — have drifted, as a fraction of their union (harness/improvements/loop-output.ts
   * `provenanceDivergence`; 0 = perfect agreement, 1 = no id recorded by all three).
   * A ~50% divergence went unnoticed for a long time precisely because nothing ever
   * computed or surfaced it — this leg is the recurrence guard. `crossesWarnThreshold`
   * mirrors `scoutDivergenceStatus`'s own threshold so the Health tab and any other
   * consumer agree on when it matters. Read failure ⇒ null (never fabricate 0).
   */
  provenanceDivergence: {
    value: number;
    counts: { bySourceRole: number; byTopic: number; byRoutedIdea: number; union: number };
    crossesWarnThreshold: boolean;
  } | null;
}

/** A rating shared by the three tool-efficiency metrics (mirrors each metric
 *  module's own Grade shape — limit-failure-rate.ts / orient-dedup-rate.ts /
 *  code-run-adoption.ts). */
export interface ToolEfficiencyRating {
  rating: 'healthy' | 'degraded' | 'broken' | 'unknown';
  evidence: string;
}

/**
 * Tool efficiency (panel #17, WI-839) — the canonical
 * measuring-code-run-adoption.mdx SQL metrics folded into one recurring card,
 * so a regression (a tight new validation cap, the code:run nudge losing
 * effect, agents re-calling what coord:orient already returned) surfaces
 * without a manual audit. Each leg is read + graded by its own already
 * pure+unit-tested module (limit-failure-rate.ts / code-run-adoption.ts /
 * orient-dedup-rate.ts / empty-result-rate.ts); this panel only folds their outputs.
 *
 * EI-10892 added metric #4, and it is the one that closes the panel's blind spot.
 * Metrics #1-#3 all grade failures that ANNOUNCE themselves — a hard rejection, a
 * ratio, a redundant call. The dominant waste mode announces nothing: a call that
 * SUCCEEDS and returns rows with every field blank, because the caller mapped the
 * response shape wrong. Measured on the 2026-07-13 agent-DX audit: 178 tool calls,
 * ONE recorded failure, and ~30% of authored round-trips wasted — every one ok:true,
 * with this panel reporting healthy the whole time.
 */
export interface ToolEfficiencyHealth {
  /** Metric #1 — too-long-string tool-arg validation failures, last 14d. */
  limitFailure: ToolEfficiencyRating & { totalErrs: number };
  /** Metric #2 — code:run/recipes:run adoption among batchable-opportunity spawns, last 7d. */
  codeRunAdoption: ToolEfficiencyRating & { adoptionRatePct: number | null };
  /** Metric #3 — of coord:orient spawns, % that also re-called a subsumed tool, last 24h. */
  orientDedup: ToolEfficiencyRating & { pctRedundant: number | null };
  /**
   * Metric #4 (EI-10892) — % of code:run calls returning ok-but-every-field-blank
   * rows (a MIS-MAPPED response shape, not an empty result set), last 7d.
   * `pctEmpty` is null when the window holds too few runs to grade (→ 'unknown').
   */
  emptyResult: ToolEfficiencyRating & { pctEmpty: number | null; totalEmptyRuns: number };
}

/**
 * Per-client context-injection DELIVERY (codex-context-injection-parity-2026-08-09
 * P-005). Answers "is client X actually being asked for per-turn context at all?",
 * which was unanswerable from outside for months — the gap this plan closes was
 * invisible precisely because "injected nothing" and "was never asked" look
 * identical once both have written nothing.
 *
 * DISTINCT from the `memory` panel, deliberately (D-006): that one asks whether
 * the CORPUS can answer; this one asks whether anybody ASKED. A regression in
 * either is invisible in the other.
 */
export type InjectionClientVerdict =
  /** Injection ran and produced context. */
  | 'ok'
  /** No sessions for this client in the window — not in play, nothing to judge. */
  | 'idle'
  /** It fired, but a tool is absent from the shared vocabulary. Actionable. */
  | 'drift'
  /** Sessions ran, nothing recorded, and this client has NO baseline — a known
   *  gap, NOT a regression, and explicitly not pageable (see thresholds). */
  | 'never-observed'
  /** Sessions ran, nothing recorded, and this client HAS a baseline. Real. */
  | 'regressed';

/**
 * One (client, port) cell of the panel — the grain an outage is visible at.
 *
 * A per-client total cannot express "turn-start is dead but mid-turn is fine":
 * the working port's traffic keeps `events` healthy and the dead one never
 * surfaces. That masking is why a real turn-start failure
 * (EI-20001110634702380) closed cause-undetermined, and why the row carries its
 * own `everObserved` — a port with no baseline is a known gap, never a page.
 */
export interface ContextInjectionPortRow {
  port: string;
  events: number;
  everObserved: boolean;
  verdict: InjectionClientVerdict;
}

export interface ContextInjectionClientRow {
  client: string;
  sessions: number;
  events: number;
  recalled: number;
  unknownTool: number;
  driftTools: string[];
  everObserved: boolean;
  /**
   * This client's verdict, rolled up as the WORST of its ports (and its own
   * client-level reading). Rolling up rather than reporting the client total
   * directly is what makes a single dead port able to move the panel at all.
   */
  verdict: InjectionClientVerdict;
  /** One entry per injection port, always present — see ContextInjectionPortRow. */
  ports: ContextInjectionPortRow[];
}

export interface ContextInjectionHealth {
  windowHours: number;
  clients: ContextInjectionClientRow[];
  totalEvents: number;
  /**
   * True when EVERY client holding a baseline recorded nothing this window. Three
   * independent hook layers failing at once is far less likely than the one
   * recording path they share having broken, so the summary must point there
   * instead of blaming three clients with the wrong cause.
   */
  recordingPathSuspect: boolean;
}

/**
 * Who-watches-the-watcher (overwatch-role C-1 / D-004). `overwatchAlive` is null
 * until the overwatch role lands (overwatch-role-2026-06-15). The Health tab
 * surfaces it; the overwatch brief raises an anomaly when a counterpart goes dark.
 */
export interface CrossMonitor {
  queenAlive: boolean;
  overwatchAlive: boolean | null;
}

/** The keyed panel set — heterogeneous data per key. */
export interface SystemHealthPanels {
  queen: HealthPanel<QueenHealth>;
  bees: HealthPanel<BeesHealth>;
  workItems: HealthPanel<WorkItemsHealth>;
  workFeed: HealthPanel<WorkFeedHealth>;
  loops: HealthPanel<LoopsHealth>;
  tokens: HealthPanel<TokensHealth>;
  watchdog: HealthPanel<WatchdogHealth>;
  deploy: HealthPanel<DeployHealth>;
  plans: HealthPanel<PlansHealth>;
  escalations: HealthPanel<EscalationsHealth>;
  autonomy: HealthPanel<AutonomyHealth>;
  observations: HealthPanel<ObservationsHealth>;
  improvements: HealthPanel<ImprovementsHealth>;
  infra: HealthPanel<InfraHealth>;
  suFleet: HealthPanel<SuFleetHealth>;
  coordination: HealthPanel<CoordinationHealth>;
  overwatch: HealthPanel<OverwatchPanelHealth>;
  scout: HealthPanel<ScoutHealth>;
  memory: HealthPanel<MemoryPanelHealth>;
  toolEfficiency: HealthPanel<ToolEfficiencyHealth>;
  contextInjection: HealthPanel<ContextInjectionHealth>;
}

/**
 * The whole-system health snapshot. `overall` is the worst non-`unknown` panel
 * status (an unread source greys its card but never reds the system, D-003 / the
 * fail-soft stance). Read by the `health.snapshot` sync resolver (SSE-live) and
 * wrapped by the overwatch brief.
 */
export interface SystemHealth {
  workspaceId: string;
  /** ms epoch of this evaluation. */
  evaluatedAt: number;
  overall: PanelStatus;
  crossMonitor: CrossMonitor;
  panels: SystemHealthPanels;
  /** Panels excluded from `overall` by an active owner ack (P-004). */
  ackedCount?: number;
}
