/**
 * system-health/thresholds — the green/yellow/red status model, in ONE place
 * (system-health-tab-2026-06-15 P-001 / Phase 4, D-003).
 *
 * Pure functions: each takes a panel's data (+ `now`) and returns a PanelStatus.
 * No IO — so the boundaries (Queen stalled > 30m = crit, opus paused = crit,
 * dead routine = crit, sync-lag > 45m = warn, escalation aging > 6h = warn, …)
 * are unit-tested without a database. `computeSystemHealth` calls these; the
 * collectors never decide their own colour. A panel whose collector threw is
 * 'unknown' (greyed) — set by compute.ts, not here.
 */
import type {
  PanelStatus,
  ContextInjectionHealth,
  InjectionClientVerdict,
  QueenHealth,
  BeesHealth,
  WorkItemsHealth,
  WorkFeedHealth,
  TokensHealth,
  WatchdogHealth,
  DeployHealth,
  PlansHealth,
  EscalationsHealth,
  AutonomyHealth,
  ImprovementsHealth,
  InfraHealth,
  OverwatchPanelHealth,
  LoopsHealth,
  CoordinationHealth,
  MemoryPanelHealth,
  PanelAck,
  HostPressureHealth,
  HostPressureSample,
} from './types';

// ── tunable thresholds (the status boundaries) ───────────────────────────────

/** Queen stall: started + quiet this long (+ demand, not mid-turn) = crit. The
 *  failure mode the tab exists for (the watchdog's own fallback default is 30m). */
export const QUEEN_STALL_MS = 30 * 60_000;
/** Frequent watchdog fallback fires (a forgot-to-declare prompt bug) = warn. */
export const WATCHDOG_FIRES_WARN = 3;
/** Git-sync lag: no new staging commit in this long = warn (the firehose stalled). */
export const SYNC_LAG_WARN_MS = 45 * 60_000;
/** Live :3070 this many commits behind staging = warn (deploy pipeline stuck). */
export const DEPLOY_BEHIND_WARN = 80;
/** Open escalation older than this = warn (aging). */
export const ESCALATION_AGING_MS = 6 * 60 * 60_000;
/** Disk used% thresholds (health-tab-v2 P-011 — mirrors the fedplane disk script). */
export const DISK_USED_WARN_PCT = 90;
export const DISK_USED_CRIT_PCT = 95;
/** EI-19944041837110102 (disk-alarm-flap): hysteresis buffer, in percentage points, applied
 *  when a previous-tick band is available. Without it, usage oscillating within a couple of
 *  points of DISK_USED_CRIT_PCT/WARN_PCT (ordinary filesystem noise — log rotation, a
 *  git-sync sweep, a temp file) flips the band on every tick, firing + auto-resolving a
 *  `panel:infra` escalation within the same minute. Standard two-threshold ("Schmitt
 *  trigger") hysteresis: once a band is entered, usage must fall the buffer BELOW that
 *  band's own entry threshold to leave it — merely dropping back under the threshold is
 *  not enough. See `diskBandWithHysteresis` below. */
export const DISK_HYSTERESIS_BUFFER_PCT = 3;
/** Above this, or below DISK_CRIT_LOW_FREE_GB free, the crit summary keeps the urgent
 *  "writes are about to fail" wording; below it (but still >= DISK_USED_CRIT_PCT) the
 *  summary reads as "critically low" instead — 94-95% used with 100+G still free is a real
 *  warning, not an imminent-write-failure, and the message overstating it is itself part
 *  of EI-19944041837110102. */
export const DISK_CRIT_URGENT_PCT = 98;
/** See DISK_CRIT_URGENT_PCT — small absolute headroom is urgent regardless of %, e.g. a
 *  tiny partition sitting at 96% with 2G free really is about to fail writes. */
export const DISK_CRIT_URGENT_LOW_FREE_GB = 5;

/**
 * P-016: is the work-queue reaper WEDGED, or merely idle?
 *
 * `reaperStale` is a clock reading and nothing more (`age > threshold`). "WEDGED"
 * is a claim about CAUSE, and deriving one from the other overstates exactly the
 * way `DISK_CRIT_URGENT_PCT` above was added to stop the disk alarm overstating
 * ("writes are about to fail" at 95% used with 100+G free). Against a very large
 * queue the old form recurred on every tick and never resolved, which teaches the
 * reader to skip the line — the failure P-016 is about.
 *
 * The discriminator is the reaper's OWN job: `stuckTotal` (dead-held claims,
 * dead-assigned issues, stuck features). Stale WITH rows rotting is a real wedge.
 * Stale with a clean queue is a reaper that had nothing to do — still surfaced as
 * a `warn` by the plain `reaperStale` leg, just not shouted as a crit.
 *
 * `reaperAgeSec == null` means the last-run time was unreadable — an UNKNOWN, and
 * never upgraded to a cause claim (the same fail-open the callers use elsewhere).
 *
 * Pure so it is unit-testable, mirroring `diskBandWithHysteresis` below — the
 * other calibration fix in this file, extracted for the same reason.
 */
export function isReaperWedged(opts: {
  reaperStale: boolean | undefined;
  reaperAgeSec: number | null | undefined;
  stuckTotal: number;
}): boolean {
  return opts.reaperStale === true && opts.reaperAgeSec != null && opts.stuckTotal > 0;
}

/**
 * Classify a disk-used% reading against DISK_USED_WARN_PCT/DISK_USED_CRIT_PCT WITH
 * hysteresis: once a band is entered, usage must drop DISK_HYSTERESIS_BUFFER_PCT points
 * below that band's own entry threshold to leave it, rather than merely crossing back over
 * the raw threshold. Escalating to a WORSE band still happens immediately at the raw
 * threshold (only de-escalation is buffered) — a genuine fast fill must still page without
 * delay.
 *
 * `prevBand` is the SAME classification from the previous tick for this exact path (null =
 * no prior reading — cold start / a path just appeared — which falls back to a plain
 * threshold check, since there is nothing to be stable relative to yet).
 *
 * Pure + stateless itself (no IO, holds nothing): the caller (compute.ts's collectInfra)
 * supplies `prevBand` from whatever cross-tick memory it has, keeping this trivially
 * unit-testable and keeping `infraStatus` itself a pure function of InfraHealth alone.
 */
export function diskBandWithHysteresis(
  usedPct: number,
  prevBand: Extract<PanelStatus, 'ok' | 'warn' | 'crit'> | null,
): Extract<PanelStatus, 'ok' | 'warn' | 'crit'> {
  if (prevBand === 'crit' && usedPct >= DISK_USED_CRIT_PCT - DISK_HYSTERESIS_BUFFER_PCT) return 'crit';
  if (prevBand === 'warn' && usedPct >= DISK_USED_CRIT_PCT) return 'crit';
  if (prevBand === 'warn' && usedPct >= DISK_USED_WARN_PCT - DISK_HYSTERESIS_BUFFER_PCT) return 'warn';
  if (usedPct >= DISK_USED_CRIT_PCT) return 'crit';
  if (usedPct >= DISK_USED_WARN_PCT) return 'warn';
  return 'ok';
}

/** Worst disk `band` across every watched volume, honoring each volume's own
 *  hysteresis-classified `band` when the collector supplied one, else falling back to a
 *  plain (no-hysteresis) threshold check against that volume's raw `usedPct` — so a
 *  hand-built InfraHealth fixture that never set `band` behaves exactly as before. Shared
 *  by `infraStatus` and `infraSummary` so the two can never disagree on which volume/band
 *  is worst. */
function worstDiskBand(disk: InfraHealth['disk']): Extract<PanelStatus, 'ok' | 'warn' | 'crit'> | null {
  if (!disk || disk.length === 0) return null;
  const rank: Record<Extract<PanelStatus, 'ok' | 'warn' | 'crit'>, number> = { ok: 0, warn: 1, crit: 2 };
  let worst: Extract<PanelStatus, 'ok' | 'warn' | 'crit'> = 'ok';
  for (const v of disk) {
    const band = v.band ?? (v.usedPct >= DISK_USED_CRIT_PCT ? 'crit' : v.usedPct >= DISK_USED_WARN_PCT ? 'warn' : 'ok');
    if (rank[band] > rank[worst]) worst = band;
  }
  return worst;
}
/** No successful backup snapshot in this long = warn (P-011). */
export const BACKUP_STALE_MS = 48 * 60 * 60_000;
/** An unanswered DIRECTED message older than this warns the Coordination panel
 *  (P-009 — "your minutes are a blocked peer's hours"). */
export const UNANSWERED_DIRECTED_WARN_MS = 30 * 60_000;

/** WI-3565: idle healthy accounts strictly above this count, ALONGSIDE a confirmed
 *  `admissionStarved`, is what makes the starvation a crit (real spare capacity sitting unused
 *  behind an under-recovered admission ceiling) rather than routine full-pool pressure. */
export const ADMISSION_STARVATION_IDLE_ACCOUNTS_MIN = 2;

// ── per-panel status deciders ────────────────────────────────────────────────

/**
 * Queen. crit = STALLED (the origin failure mode) OR paused WITH demand queued (a
 * silent outage — autonomous-loop-canary-reliability P-003: the started-only
 * watchdog seams skip a paused hive, so nothing recovered the multi-day canary
 * stall and this panel only yellowed). warn = paused with nothing queued (idle by
 * choice), started-but-no-wake-armed with demand, or watchdog firing repeatedly.
 * ok = looping with cadence.
 */
export function queenStatus(d: QueenHealth): PanelStatus {
  if (d.stalled) return 'crit';
  // P-003: paused + demand = a silent outage → red it (was a benign yellow);
  // paused + nothing queued stays warn (intentionally idle).
  if (!d.started) {
    return d.demand.todoItems > 0 || d.demand.startedPlans > 0 ? 'crit' : 'warn';
  }
  if (!d.armed && !d.midTurn && (d.demand.todoItems > 0 || d.demand.startedPlans > 0)) return 'warn';
  if (d.watchdogFires24h >= WATCHDOG_FIRES_WARN) return 'warn';
  return 'ok';
}

/**
 * queenAlive — the who-watches-the-watcher LIVENESS signal (D-004), deliberately
 * DISTINCT from the `stalled` panel state so the overwatch's queen-stalled
 * detector isn't dead code (EI-623). DARK (false) ONLY when the loop is genuinely
 * gone: started AND no next wake armed AND stalled. A started-but-ARMED Queen is
 * alive even when stalled (the wake will fire / the watchdog re-arms — `armed`
 * absorbs a normal stall, so `stalled` flows to its OWN detector, not queen-dark).
 * A paused Queen (not started) is intentionally off → alive, never a false dark.
 * An unreadable queen (null) is conservatively alive (favour not-alarming, D-002).
 *
 * ONE definition, shared by the SystemHealth model (compute.ts) and the overwatch
 * brief mapper (overwatch/compute-brief.ts) so the two can never drift apart again
 * — the duplicated copies that DID drift were the EI-623 root cause.
 */
export function deriveQueenAlive(queen: QueenHealth | null): boolean {
  if (!queen) return true; // unreadable ⇒ conservatively alive (never a false dark)
  if (!queen.started) return true; // paused ⇒ intentional, alive
  return queen.armed || !queen.stalled; // started ⇒ dark only when unarmed AND stalled
}

/**
 * PURE: count the most-recent CONSECUTIVE Queen wakes that ran ZERO LLM tokens.
 * Samples are newest-first (as queenWakeEfficiency returns them). A 0-token wake =
 * the agent process launched but the LLM never executed (infra / rate-limit loss) —
 * DISTINCT from a healthy short wake, which still spends tokens deciding "nothing to
 * do". (hive-loop-supervision 2026-06-21 — D-009: the Queen's 0-token-no-op outage.)
 */
/** Bees. crit = a cursed placement (failed past the breaker, escalated). warn =
 *  orphaned claims / stranded / recovering placements. ok otherwise. */
export function beesStatus(d: BeesHealth): PanelStatus {
  if (d.placements.cursed > 0) return 'crit';
  if (d.orphanedClaims > 0 || d.invalidModelFailures > 0 || d.placements.stranded > 0 || d.placements.recovering > 0) return 'warn';
  return 'ok';
}

/** Work items. warn = a needs-human queue exists. (Backlog depth is not a health
 *  failure on its own — that's the work-feed / plans story.) */
export function workItemsStatus(d: WorkItemsHealth): PanelStatus {
  // The recovery-layer backlog the reaper is responsible for clearing: freed-but-
  // non-dispatchable rows + dead-held feature claims + dead-assigned issues + dead-
  // held plan-item reservations (P-008 / EI-2535).
  const stuckBacklog =
    (d.stuckFeatures ?? 0) +
    (d.deadHeldClaims ?? 0) +
    (d.deadAssignedIssues ?? 0) +
    (d.deadHeldAssignments ?? 0);

  // WI-1338072: a terminal proposed row with an explicit empty settlement
  // residualPaths array has already proved its declared files against a commit.
  // Remaining proposed authority therefore means the upgrade was rejected or
  // reverted, not that the item is merely waiting for git-sync. This is a
  // completion-integrity failure and must be red independently of reaper health.
  if ((d.settlementAuthorityFailures ?? 0) > 0) return 'crit';

  // P-009: a recorded-but-aged-out reaper is WEDGED — the most severe work-queue
  // failure (stuck items accumulate silently). A null age = never recorded (fresh
  // boot / unknown) → warn, not crit, to avoid alarming on the ~1 boot interval
  // before the first sweep stamps its heartbeat.
  //
  // P-016: ...but only when something is actually rotting. `reaperStale` is a
  // clock (`age > threshold`), and a reaper with an empty backlog has nothing it
  // failed to do — "stuck items accumulate silently" is the harm this crit names,
  // and with `stuckBacklog === 0` that harm is measurably absent. Without this the
  // crit recurred every tick against a very large queue and never resolved.
  //
  // Note this makes the branch CONSISTENT with the one immediately below: EI-2534
  // already decided that a stale reaper is crit-worthy only alongside a real
  // stranded backlog, and applied it to the null-age case. The same reasoning was
  // simply never carried to the known-age case. Shares `isReaperWedged` with the
  // summary wording in compute.ts so the panel's SEVERITY and its TEXT cannot
  // disagree — a crit that no longer says WEDGED would be the same alarm wearing a
  // quieter label, which is worse than either alone.
  if (isReaperWedged({ reaperStale: d.reaperStale, reaperAgeSec: d.reaperAgeSec, stuckTotal: stuckBacklog })) {
    return 'crit';
  }
  // EI-2534: a reaper that has NEVER recorded a run (null age) is normally a benign
  // fresh-boot blip (warn, below) — UNLESS a real dead-held backlog is already
  // stranded. A never-armed/dark sweep WITH stuck rows is not a boot blip; it is the
  // reclaim-lane-not-firing incident (claims sat ~3h reading as a passive warn while
  // the un-armed sweep never freed them). Surface it as crit so a stranded backlog
  // under a non-firing reaper is loud, not silently yellow.
  if (d.reaperStale && d.reaperAgeSec == null && stuckBacklog > 0) return 'crit';
  // P-008 / EI-2535: any genuinely stuck row, a dead-held claim backlog, a
  // dead-assigned issue, or a dead-held plan-item reservation (reaper alive →
  // transient backlog it is actively clearing → warn).
  if (stuckBacklog > 0) return 'warn';
  if (d.reaperStale) return 'warn';
  if (d.needsHuman > 0) return 'warn';
  return 'ok';
}

/** Work-feed. crit = a dead routine (EI-584 — a stalled routine starves the whole
 *  feed), OR a release/deploy-critical routine (release-trigger, green-checkpoint)
 *  sitting on a stale/unexplained pause (WI-5839 / EI-18654017982759582 items 2+3 —
 *  a paused deploy pipeline silently drops every agent's "shipped" work into a
 *  void). warn = auto-eligible work stuck at attempts:0 while routines are alive
 *  (ready work not flowing — mirrors the overwatch's work-feed-stuck nudge), or any
 *  OTHER routine on a stale/unexplained pause. ok otherwise (frontier depth alone
 *  is not unhealthy). */
export function workFeedStatus(d: WorkFeedHealth): PanelStatus {
  if (d.deadRoutines > 0) return 'crit';
  if ((d.stalePausedCriticalRoutines ?? 0) > 0) return 'crit';
  if (d.autoEligibleStuck > 0) return 'warn';
  if ((d.stalePausedRoutines ?? 0) > 0) return 'warn';
  return 'ok';
}

/**
 * Tokens / gateway. crit = full starvation (no account available), the gateway is in the egress
 * path but unreachable, OR the gateway is WEDGED (B-GW-5: the watchdog auto-restart signature —
 * every slot pinned + a growing queue + frozen totalRequests), OR a CONFIRMED sustained admission
 * backlog with idle healthy accounts sitting unused (WI-3565: the deep-queue-below-ceiling starvation
 * mode `saturated` cannot see — > ADMISSION_STARVATION_IDLE_ACCOUNTS_MIN idle accounts + a queue
 * persisted > ADMISSION_STARVATION_QUEUE_RATIO x the live ceiling for ≥5min). warn = the gateway is
 * saturated, sustained-throttling, or admission-starvation-AT-RISK (not yet 5min-confirmed), a paused
 * bucket (RPM-pacing), or a paused account. ok otherwise.
 */
export function tokensStatus(d: TokensHealth): PanelStatus {
  if (d.accountsTotal > 0 && d.accountsAvailable === 0) return 'crit';
  if (d.gatewayEnabled && d.gatewayReachable === false) return 'crit';
  // EI-19303809952284205 — the gateway is UP and serving but has lost its database. Every durable
  // account subsystem is inert: usage-window writes dropped (the Accounts tab freezes), the pool
  // cannot reload (the gateway falls back to ONE synthetic credential and ignores every account pin,
  // reporting healthyAccounts: 0), auto-scale-out dead. This ran for hours on 2026-08-01 with
  // `/healthz` reporting ok:true, and was found only because a human noticed a stale UI panel.
  if (d.gatewayDb?.ok === false) return 'crit';
  // The INDEPENDENT leg: the operator's own view of the projection. Fires when the gateway is dead
  // outright, or too old to report `gatewayDb` (the incident's gateway had been up 13.7 days — a
  // long-lived process is exactly what this condition afflicts, so the self-report cannot be the
  // only detector). Gated on real fleet spend so an idle box is never alarmed: `spendUsd` comes from
  // agent_usage_samples, a DIFFERENT writer than the account-pool projection, so "the fleet made
  // calls but the pool never moved" is a genuine cross-check rather than one signal grading itself.
  if (projectionWriteStalled(d, POOL_PROJECTION_STALE_CRIT_MS)) return 'crit';
  if (d.gateway?.wedge) return 'crit';
  // WI-3565: a confirmed, sustained starvation WITH idle healthy accounts sitting unused is crit —
  // it is exactly the "queue deep, pool idle, nothing alarmed" incident this detector exists to catch.
  // Without idle headroom the same deep queue is just normal full-pool pressure (the warn branch below).
  if (d.gateway?.admissionStarved && d.accountsAvailable > ADMISSION_STARVATION_IDLE_ACCOUNTS_MIN) return 'crit';
  // P-005/W3 (D-001): a leaked admission slot the valve can't reclaim is an early warn — the root-cause
  // signal that PRECEDES the wedge it would otherwise silently ride to (the wedge itself stays crit above).
  if (d.gateway?.saturated || d.gateway?.sustainedThrottle || d.gateway?.slotLeak) return 'warn';
  if (d.gateway?.admissionStarvationRisk) return 'warn';
  // Early warn on the same projection-stall signal, well before the crit floor — the fast leg
  // (`gatewayDb`) normally catches this within minutes, so reaching even the warn floor means the
  // gateway is not self-reporting and something is genuinely wrong with the write path.
  if (projectionWriteStalled(d, POOL_PROJECTION_STALE_WARN_MS)) return 'warn';
  if (d.pausedBuckets > 0 || d.accountsPaused > 0) return 'warn';
  return 'ok';
}

/**
 * Warn floor for "the gateway has landed no usage-window write in this long, despite fleet spend".
 * Comfortably past `DRAIN_UTIL_STALE_MS` (10min, where the drain selector already discounts a
 * reading) so the two signals don't fire on top of each other.
 */
export const POOL_PROJECTION_STALE_WARN_MS = 30 * 60_000;
/**
 * Crit floor for the same. Deliberately conservative: the projector only writes on a ≥0.03
 * utilization move or a window-reset roll, so under genuinely light traffic a legitimate gap can run
 * to tens of minutes and a tighter floor would cry wolf. The FAST leg (`gatewayDb.ok === false`,
 * ~3min) is what turns this class into a minute-one signal; this one is the backstop for a gateway
 * that cannot speak for itself, where being right matters more than being early.
 */
export const POOL_PROJECTION_STALE_CRIT_MS = 2 * 60 * 60_000;

/**
 * Has the usage-window write path stalled past `floorMs`? Pure, and shared by both the warn and crit
 * branches so the two can never drift apart.
 *
 * Requires `spendUsd > 0`: with no fleet LLM traffic in the lookback window there are no upstream
 * responses to observe, so an aged projection is CORRECT idleness, not a fault. Alarming on a quiet
 * box is how a detector teaches its reader to ignore it.
 */
export function projectionWriteStalled(d: TokensHealth, floorMs: number): boolean {
  if (d.poolProjectionFreshestAgeMs === null) return false; // nothing ever observed — a fresh pool
  if (d.spendUsd <= 0) return false; // no traffic to have produced a write
  return d.poolProjectionFreshestAgeMs >= floorMs;
}

/** Watchdog. warn = firing repeatedly (a prompt bug to fix); the watchdog firing
 *  at all is the safety net working, not a system failure — so never crit. */
export function watchdogStatus(d: WatchdogHealth): PanelStatus {
  if (d.fires24h >= WATCHDOG_FIRES_WARN) return 'warn';
  return 'ok';
}

/** Consecutive failed git-sync ticks that red the deploy panel — mirrors
 *  PUSH_FAILURE_ESCALATION_TICKS in git-sync-escalation.ts (EI-18: ~30 min of the
 *  push not reaching origin). Kept as a sibling constant so the standing health
 *  signal and the escalation fire on the same threshold. */
export const GIT_SYNC_PUSH_FAIL_CRIT = 3;

/** Grace after a deploy before a not-yet-restarted bg-host is a WARNING rather than
 *  a restart still in flight. A deploy legitimately leaves the old process up for a
 *  short window; warning inside it would flap on every healthy deploy, and a panel
 *  that is yellow after every deploy is wallpaper, not signal. Sized well above a
 *  normal restart and far below the 175-minute stall that motivated the check
 *  (WI-1258129), so the alarm means "this restart is not coming". */
export const BG_HOST_STALE_CODE_GRACE_MS = 20 * 60_000;

/**
 * Deploy. crit = git-sync push FAILING (>= GIT_SYNC_PUSH_FAIL_CRIT consecutive ticks:
 * local commits are NOT reaching origin — the EI-18 silent-failure class, the one
 * deploy condition severe enough to red the system; the ref-based checks below are
 * blind to it because new local commits keep `lastCommitAtMs` fresh). unknown = no
 * refs resolved (a box without the release checkout). warn = git-sync erroring or
 * excluding oversized blobs, git-sync lag (no recent staging commit), the live host
 * far behind staging, or bg-host still running PRE-DEPLOY code past the grace window.
 * ok otherwise.
 */
export function deployStatus(d: DeployHealth, now: number): PanelStatus {
  if (d.gitSyncConsecutiveErrorTicks >= GIT_SYNC_PUSH_FAIL_CRIT && d.gitSyncPushBacklog !== 0) return 'crit';
  if (d.deployedShortSha === null && d.lastCommitAtMs === null) return 'unknown';
  if (
    d.gitSyncStatus === 'error' ||
    d.gitSyncStatus === 'degraded' ||
    d.gitSyncStatus === 'quarantined' ||
    d.gitSyncOversizedCount > 0
  ) return 'warn';
  if (d.lastCommitAtMs !== null && now - d.lastCommitAtMs > SYNC_LAG_WARN_MS) return 'warn';
  if (d.deployedBehindStaging !== null && d.deployedBehindStaging > DEPLOY_BEHIND_WARN) return 'warn';
  // WI-1258129: the refs above can ALL be healthy while a long-lived process runs
  // pre-deploy code. Strictly `=== true`, never a truthiness test: `null` means the
  // host was unreadable (not proven stale) and must not warn.
  if (
    d.bgHostCodeStale === true &&
    d.deployedAtMs !== null &&
    now - d.deployedAtMs > BG_HOST_STALE_CODE_GRACE_MS
  ) {
    return 'warn';
  }
  return 'ok';
}

/** Plans. warn = a started plan has gone stale (no op update in the aging window). */
export function plansStatus(d: PlansHealth): PanelStatus {
  if (d.stalledPlans > 0) return 'warn';
  return 'ok';
}

/** Escalations. warn = an open blocker, or any open escalation aging past the
 *  threshold (needs a human — but the system itself isn't broken, so not crit). */
export function escalationsStatus(d: EscalationsHealth): PanelStatus {
  // health-tab-v2 P-003: status keys on NEW aging (crossed the threshold in the
  // last 24h) + open blockers. STANDING aging (a weeks-old acknowledged backlog)
  // renders as a muted metric instead of re-warning every tick — a panel that is
  // yellow for a month is wallpaper, not signal.
  if (d.agingNew > 0 || (d.bySeverity.blocker ?? 0) > 0) return 'warn';
  return 'ok';
}

/** Autonomy. warn = a tripped tripwire (a guard fired — may auto-revert, worth a
 *  glance). Locked categories are intentional config, not a failure. */
export function autonomyStatus(d: AutonomyHealth): PanelStatus {
  if (d.tripwiresTripped > 0) return 'warn';
  return 'ok';
}

/** Improvements. Informational — a backlog is not a health failure. ok. */
export function improvementsStatus(_d: ImprovementsHealth): PanelStatus {
  return 'ok';
}

/**
 * MCP tool-call transport SLO (backend-reliability-100pct-2026-07-03 W8 / P-008): HARD
 * MCP-proxy failures in the window at/above this count RED the Infra panel (→
 * operator_degraded → the overall system light → a page). Calibrated for the "transient
 * is NOT normal" mandate: normal deploy restarts are ABSORBED by the proxy's retry window
 * (they log as SOFT `recovered`, not hard failures), so a hard-failure stream this size is
 * a genuine regression (a >retry-window outage, a post-connect error storm, or the W1.3
 * stale-socket-400 class returning) — never routine churn. ANY hard failure (>0) is a
 * WARN (visible), ending the culture of dismissing tool-call errors as normal. */
export const MCP_PROXY_HARD_FAIL_CRIT = 10;

/**
 * Fresh host-pressure thresholds. CPU/memory PSI are stall percentages; the
 * scheduler counters are normalized by the resource profile's effective cores
 * so the same detector works on a 2-core guest and a 128-core host. These are
 * observation thresholds, not resource-governor admission limits.
 */
export const HOST_PRESSURE_MAX_AGE_MS = 15_000;
export const HOST_PRESSURE_CPU_PSI_WARN_PCT = 20;
export const HOST_PRESSURE_CPU_PSI_CRIT_PCT = 85;
export const HOST_PRESSURE_MEMORY_PSI_SOME_WARN_PCT = 10;
export const HOST_PRESSURE_MEMORY_PSI_FULL_CRIT_PCT = 5;
export const HOST_PRESSURE_RUNNABLE_WARN_PER_CORE = 1.5;
export const HOST_PRESSURE_RUNNABLE_CRIT_PER_CORE = 3;
export const HOST_PRESSURE_BLOCKED_WARN_PER_CORE = 0.25;
export const HOST_PRESSURE_BLOCKED_CRIT_PER_CORE = 1;

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function formatPressureNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/**
 * Pure detector for the resource-governor's current host-pressure sample.
 *
 * A stale snapshot is not thresholded at all. Missing/invalid individual legs
 * remain explicit unknowns; a measured pressure leg may still surface warn/crit
 * rather than being hidden by an unavailable corroborator. If no pressure leg
 * is measurable, any unknown required leg keeps the result unknown instead of
 * fabricating a healthy `ok`.
 */
export function evaluateHostPressure(
  sample: HostPressureSample | null | undefined,
  nowMs: number,
  maxAgeMs = HOST_PRESSURE_MAX_AGE_MS,
): HostPressureHealth {
  const empty: HostPressureHealth = {
    status: 'unknown',
    summary: 'HOST PRESSURE UNKNOWN — no current live-health evidence',
    sampledAtMs: null,
    ageMs: null,
    effectiveCores: null,
    cpuPsiSomePct: null,
    memoryPsiSomePct: null,
    memoryPsiFullPct: null,
    runnableCount: null,
    blockedCount: null,
    runnablePerCore: null,
    blockedPerCore: null,
    reasons: [],
    unknown: [],
  };
  if (!sample) {
    return { ...empty, unknown: ['live-health snapshot unavailable'] };
  }

  const unknown: string[] = [];
  const sampledAtMs = finiteNumber(sample.sampledAtMs) ? sample.sampledAtMs : null;
  if (sampledAtMs === null) {
    unknown.push('live-health sampledAtMs is missing or invalid');
  }
  if (!finiteNumber(nowMs)) {
    unknown.push('health evaluation time is invalid');
  }
  if (!finiteNumber(maxAgeMs) || maxAgeMs < 0) {
    unknown.push('live-health freshness bound is invalid');
  }
  const ageMs = sampledAtMs !== null && finiteNumber(nowMs) ? nowMs - sampledAtMs : null;
  if (ageMs !== null && ageMs < 0) {
    unknown.push('live-health snapshot is from the future');
  } else if (ageMs !== null && finiteNumber(maxAgeMs) && ageMs > maxAgeMs) {
    unknown.push(`live-health snapshot is ${ageMs}ms old, beyond the ${maxAgeMs}ms freshness bound`);
  }
  // Do not threshold any values from an expired/future snapshot.
  if (unknown.some((reason) => reason.includes('sampledAtMs') || reason.includes('evaluation time') || reason.includes('freshness') || reason.includes('from the future') || reason.includes('old,'))) {
    return {
      ...empty,
      sampledAtMs,
      ageMs,
      unknown,
    };
  }

  const effectiveCores =
    finiteNumber(sample.effectiveCores) && sample.effectiveCores > 0 ? sample.effectiveCores : null;
  if (effectiveCores === null) unknown.push('effectiveCores is missing, non-positive, or invalid');

  const readPct = (value: unknown, label: string): number | null => {
    if (value === null || value === undefined) {
      unknown.push(`${label} is unavailable`);
      return null;
    }
    if (!finiteNumber(value) || value < 0 || value > 100) {
      unknown.push(`${label} is invalid`);
      return null;
    }
    return value;
  };
  const readCount = (value: unknown, label: string): number | null => {
    if (value === null || value === undefined) {
      unknown.push(`${label} is unavailable`);
      return null;
    }
    if (!finiteNumber(value) || value < 0) {
      unknown.push(`${label} is invalid`);
      return null;
    }
    return value;
  };

  const cpuPsiSomePct = readPct(sample.cpuPsiSomePct, 'cpu.psiSomePct');
  const memoryPsiSomePct = readPct(sample.memoryPsiSomePct, 'memory.psiSomePct');
  const memoryPsiFullPct = readPct(sample.memoryPsiFullPct, 'memory.psiFullPct');
  const runnableCount = readCount(sample.runnableCount, 'scheduler.runnableCount');
  const blockedCount = readCount(sample.blockedCount, 'scheduler.blockedCount');
  const runnablePerCore = effectiveCores !== null && runnableCount !== null ? runnableCount / effectiveCores : null;
  const blockedPerCore = effectiveCores !== null && blockedCount !== null ? blockedCount / effectiveCores : null;

  const criticalReasons: string[] = [];
  const warningReasons: string[] = [];
  if (cpuPsiSomePct !== null) {
    if (cpuPsiSomePct >= HOST_PRESSURE_CPU_PSI_CRIT_PCT) {
      criticalReasons.push(
        `CPU PSI some avg60 ${formatPressureNumber(cpuPsiSomePct)} ≥ ${HOST_PRESSURE_CPU_PSI_CRIT_PCT} — host CPU starvation pressure`,
      );
    } else if (cpuPsiSomePct >= HOST_PRESSURE_CPU_PSI_WARN_PCT) {
      warningReasons.push(
        `CPU PSI some avg60 ${formatPressureNumber(cpuPsiSomePct)} ≥ ${HOST_PRESSURE_CPU_PSI_WARN_PCT} — host CPU starvation pressure`,
      );
    }
  }
  if (memoryPsiFullPct !== null && memoryPsiFullPct >= HOST_PRESSURE_MEMORY_PSI_FULL_CRIT_PCT) {
    criticalReasons.push(
      `memory PSI full avg60 ${formatPressureNumber(memoryPsiFullPct)} ≥ ${HOST_PRESSURE_MEMORY_PSI_FULL_CRIT_PCT} — host memory reclaim pressure`,
    );
  }
  if (memoryPsiSomePct !== null && memoryPsiSomePct >= HOST_PRESSURE_MEMORY_PSI_SOME_WARN_PCT) {
    warningReasons.push(
      `memory PSI some avg60 ${formatPressureNumber(memoryPsiSomePct)} ≥ ${HOST_PRESSURE_MEMORY_PSI_SOME_WARN_PCT} — host memory reclaim pressure`,
    );
  }
  if (runnablePerCore !== null) {
    if (runnablePerCore >= HOST_PRESSURE_RUNNABLE_CRIT_PER_CORE) {
      criticalReasons.push(
        `scheduler runnable ${formatPressureNumber(runnableCount!)} / ${formatPressureNumber(effectiveCores!)} effective cores = ${formatPressureNumber(runnablePerCore)} per core ≥ ${HOST_PRESSURE_RUNNABLE_CRIT_PER_CORE} — host run-queue pressure`,
      );
    } else if (runnablePerCore >= HOST_PRESSURE_RUNNABLE_WARN_PER_CORE) {
      warningReasons.push(
        `scheduler runnable ${formatPressureNumber(runnableCount!)} / ${formatPressureNumber(effectiveCores!)} effective cores = ${formatPressureNumber(runnablePerCore)} per core ≥ ${HOST_PRESSURE_RUNNABLE_WARN_PER_CORE} — host run-queue pressure`,
      );
    }
  }
  if (blockedPerCore !== null) {
    if (blockedPerCore >= HOST_PRESSURE_BLOCKED_CRIT_PER_CORE) {
      criticalReasons.push(
        `scheduler blocked ${formatPressureNumber(blockedCount!)} / ${formatPressureNumber(effectiveCores!)} effective cores = ${formatPressureNumber(blockedPerCore)} per core ≥ ${HOST_PRESSURE_BLOCKED_CRIT_PER_CORE} — host blocked-task pressure`,
      );
    } else if (blockedPerCore >= HOST_PRESSURE_BLOCKED_WARN_PER_CORE) {
      warningReasons.push(
        `scheduler blocked ${formatPressureNumber(blockedCount!)} / ${formatPressureNumber(effectiveCores!)} effective cores = ${formatPressureNumber(blockedPerCore)} per core ≥ ${HOST_PRESSURE_BLOCKED_WARN_PER_CORE} — host blocked-task pressure`,
      );
    }
  }

  const reasons = [...criticalReasons, ...warningReasons];
  const status: PanelStatus =
    criticalReasons.length > 0 ? 'crit' : warningReasons.length > 0 ? 'warn' : unknown.length > 0 ? 'unknown' : 'ok';
  const summary =
    status === 'crit' || status === 'warn'
      ? `HOST PRESSURE: ${reasons.join('; ')}`
      : status === 'unknown'
        ? `HOST PRESSURE UNKNOWN — ${unknown.join('; ')}`
        : `host pressure normal — CPU PSI ${formatPressureNumber(cpuPsiSomePct!)}%, memory PSI some/full ${formatPressureNumber(memoryPsiSomePct!)}%/${formatPressureNumber(memoryPsiFullPct!)}%, run queue ${formatPressureNumber(runnablePerCore!)} per effective core`;
  return {
    status,
    summary,
    sampledAtMs,
    ageMs,
    effectiveCores,
    cpuPsiSomePct,
    memoryPsiSomePct,
    memoryPsiFullPct,
    runnableCount,
    blockedCount,
    runnablePerCore,
    blockedPerCore,
    reasons,
    unknown,
  };
}

/** Infra. crit = a per-thread perf WEDGE (operator unreachable / event-loop-lag /
 *  CLOSE_WAIT storm — F1/P-030), a sustained MCP tool-call-transport failure stream
 *  (W8/P-008, ≥ MCP_PROXY_HARD_FAIL_CRIT hard failures/window), a tool HANDLER failing
 *  fleet-wide (EI-18798264517111160 — the transport is fine, the tool's own work is
 *  not), or the gateway is enabled
 *  but unreachable (the spine is down). unknown = PG unreadable. warn = a per-thread perf
 *  warn (hot worker / RSS / gateway flap) or ANY MCP-proxy hard failure in the window
 *  (visible, sub-page). ok otherwise. A null/stale perf verdict — and a null (unreadable)
 *  mcpProxy leg — contribute nothing (fail-soft). */
export function infraStatus(d: InfraHealth): PanelStatus {
  if (d.perf?.status === 'crit') return 'crit';
  // A real, agent-facing tool-call failure stream OUTRANKS a greyed PG leg: a crit
  // MCP-proxy SLO breach reds Infra even if PG is momentarily unreadable this tick.
  if ((d.mcpProxy?.hardFailures ?? 0) >= MCP_PROXY_HARD_FAIL_CRIT) return 'crit';
  // A tool whose HANDLER is failing for the whole fleet (EI-18798264517111160). Same
  // precedence reasoning as the MCP-proxy breach directly above — an agent-facing
  // failure stream outranks a greyed PG leg, so it must sit BEFORE the `pg === null`
  // unknown branch or a write-path outage could be masked by one unreadable PG tick.
  // This is the signal that was missing when facts:assert failed fleet-wide for ~3h.
  if (d.toolFailures?.rating === 'broken') return 'crit';
  // Disk pressure (health-tab-v2 P-011, thresholds mirror the fedplane script):
  // >=95% used on any watched volume is a crit (writes are about to fail), WITH
  // hysteresis against boundary noise (EI-19944041837110102) via `worstDiskBand`.
  const diskBand = worstDiskBand(d.disk);
  if (diskBand === 'crit') return 'crit';
  if (d.hostPressure?.status === 'crit') return 'crit';
  if (d.pg === null) return 'unknown';
  if (d.gatewayReachable === false) return 'crit';
  if (d.perf?.status === 'warn') return 'warn';
  if (d.performanceHistory?.status === 'warn') return 'warn';
  if ((d.mcpProxy?.hardFailures ?? 0) > 0) return 'warn';
  // A partial/ramping handler failure — visible, sub-page (EI-18798264517111160).
  if (d.toolFailures?.rating === 'degraded') return 'warn';
  if (d.hostPressure?.status === 'warn') return 'warn';
  if (diskBand === 'warn') return 'warn';
  // Unapplied migrations = every deploy is one restart away from surprise DDL (P-011).
  if ((d.migrationDrift?.unapplied ?? 0) > 0) return 'warn';
  // Backup integrity/freshness: an explicit failed DB dump or a legacy
  // success-shaped row without a known-good dump must never read as healthy.
  // `lastDbDumpOk === null` is not itself a failure when the newest row is
  // unknown, so it remains visible as `n/a` until an explicit complete
  // snapshot lands. Explicitly failed/degraded rows remain visible.
  if (d.backup && (
    d.backup.lastDbDumpOk === false ||
    d.backup.lastStatus === 'degraded' ||
    d.backup.lastStatus === 'failed' ||
    (d.backup.ageMs !== null && d.backup.ageMs > BACKUP_STALE_MS)
  )) return 'warn';
  // P-006/W4: PG-pool starvation is the routinesTick freeze mode — warn (not crit: the
  // pgHealth-latency proxy is coarse, matching P-005 slotLeak → warn, so one slow tick
  // doesn't red the panel; a sustained freeze still crits via the dead-routine detector).
  if (d.pool?.band === 'critical') return 'warn';
  if (d.performanceHistory?.status === 'unknown') return 'unknown';
  return 'ok';
}

/**
 * The Infra panel's one-line summary — deliberately co-located with `infraStatus`
 * above, because the two are a PAIR: this string is what the liveness-alarm
 * catch-all copies into the escalation it pages a human with, so every crit
 * branch of `infraStatus` must have a branch here that NAMES its cause.
 *
 * It did not, and that is why this function exists. `infraStatus` crits on disk
 * (`worstDiskPct >= DISK_USED_CRIT_PCT`) but the chain had no disk branch, so a
 * "writes are about to fail" page fell through to the PG line and rendered as
 * `PG 57 active / 273 conns, gateway up` — two HEALTHY subsystems named, the
 * actual condition named nowhere, and nothing in the escalation to act on.
 * Measured 2026-08-08 on `papercusp`: ~15 of the last 6 days' `panel:infra`
 * escalations carried that unnamed shape (the named ones lead `PER-THREAD
 * WEDGE:` / `MCP PROXY FAILING:`). Disk was the only crit whose cause never
 * reached the reader — every other one either leads this chain or appends to
 * the PG line (`, gateway down`).
 *
 * Keep the crit branches here in the same precedence order as `infraStatus`, and
 * when you add a crit branch there, add one here — `infra-summary-names-every-crit`
 * in the sibling test fails if a crit renders a summary that names nothing.
 */
export function infraSummary(d: InfraHealth, gatewayEnabled: boolean): string {
  const toolsCrit = d.toolFailures?.rating === 'broken';
  const mcpHard = d.mcpProxy?.hardFailures ?? 0;
  const mcpCrit = mcpHard >= MCP_PROXY_HARD_FAIL_CRIT;
  const mcpWarn = mcpHard > 0 && !mcpCrit;
  const perfCrit = d.perf?.status === 'crit';
  const worstDiskVol = d.disk && d.disk.length > 0 ? d.disk.reduce((a, b) => (b.usedPct > a.usedPct ? b : a)) : null;
  const worstDisk = worstDiskVol?.usedPct ?? null;
  const diskCrit = worstDiskBand(d.disk) === 'crit';
  const hostPressureCrit = d.hostPressure?.status === 'crit';
  const hostPressureWarn = d.hostPressure?.status === 'warn';
  const poolNote = d.pool?.band === 'critical' ? ', POOL STARVATION' : d.pool?.band === 'elevated' ? ', pool elevated' : '';
  // A disk WARN has no branch of its own (the panel is only `warn` overall), but it
  // still belongs in the line — it is the leading indicator of the crit above.
  const diskNote = worstDisk !== null && worstDisk >= DISK_USED_WARN_PCT && !diskCrit ? `, disk ${worstDisk}%` : '';
  if (toolsCrit) {
    // Leads the summary: names the tool, the rate and the error code — enough to
    // act on without running a query first.
    return `TOOL FAILING FLEET-WIDE: ${d.toolFailures!.evidence}`;
  }
  if (mcpCrit) return `MCP PROXY FAILING: ${mcpHard} hard tool-call failure(s)/1h (transient-is-normal regression — pages)`;
  if (perfCrit) {
    const reason = d.perf!.reasons[0] ?? 'operator degraded';
    // D-022: memory PSI is sampled from the host's /proc/pressure/memory, so it
    // cannot by itself attribute the stall to an operator thread. Keep the
    // per-thread verdict for operator-local signals (event-loop lag, CLOSE_WAIT,
    // reachability, etc.) while naming host memory pressure on its own scale.
    const verdict = reason.startsWith('PSI memory ') ? 'HOST MEMORY PRESSURE' : 'PER-THREAD WEDGE';
    return `${verdict}: ${reason}`;
  }
  if (diskCrit) {
    // EI-19944041837110102: "writes are about to fail" overstates 94-95% used with a real
    // 100+G buffer still free — scale the wording by actual headroom (both the % and, when
    // known, the absolute free space), not just the raw threshold crossing.
    const freeGb = worstDiskVol!.freeGb;
    const freeNote = freeGb !== undefined ? ` (${freeGb}G free)` : '';
    const urgent = worstDisk! >= DISK_CRIT_URGENT_PCT || (freeGb !== undefined && freeGb < DISK_CRIT_URGENT_LOW_FREE_GB);
    const verdict = urgent ? 'writes are about to fail' : 'critically low — reclaim space soon';
    return `DISK ${worstDisk}% used on ${worstDiskVol!.path}${freeNote} — ${verdict}`;
  }
  if (hostPressureCrit) return d.hostPressure!.summary;
  if (!d.pg) return 'PG unreadable';
  const gatewayNote = gatewayEnabled ? `, gateway ${d.gatewayReachable ? 'up' : 'down'}` : '';
  const mcpNote = mcpWarn ? `, MCP proxy ${mcpHard} fail/1h` : '';
  const perfNote = d.perf?.status === 'warn' ? `, perf warn (${d.perf.reasons[0] ?? ''})` : '';
  const hostPressureNote = hostPressureWarn ? `, ${d.hostPressure!.summary}` : '';
  const historyNote = d.performanceHistory && ['warn', 'unknown'].includes(d.performanceHistory.status)
    ? `, ${d.performanceHistory.note}` : '';
  return `PG ${d.pg.active} active / ${d.pg.total} conns${poolNote}${diskNote}${gatewayNote}${mcpNote}${perfNote}${hostPressureNote}${historyNote}`;
}

/**
 * EI-21025158485847408 — is this infra `crit` caused ONLY by ambient host pressure
 * (D-007's `ambientHost` attribution — e.g. multi-tenant PSI memory/cpu pressure
 * from peer agents sharing the box) with NO operator-defect leg and no OTHER
 * independently-crit infra leg (MCP transport, a broken tool handler, disk, an
 * unreachable gateway)?
 *
 * `infraStatus` ORs several independent crit conditions and short-circuits on the
 * first true one, so its boolean return alone can never say WHICH leg(s) fired —
 * this walks every leg explicitly instead (kept in the same precedence/leg set as
 * `infraStatus`/`infraSummary` above, so the three can never silently disagree
 * about what a `crit` verdict means).
 *
 * WI-38449/D-007 already drew this exact distinction for the DEPLOY gate
 * (`evaluatePerfGate`'s `critAttribution` split, so ambient host load never holds
 * a release). The infra-liveness ALARM (system-health/liveness-alarm.ts) never
 * inherited it: its catch-all pages a `blocker` escalation for ANY `crit` infra
 * panel, so ordinary multi-tenant RAM pressure — which recurs by design under
 * fleet load and was never the operator's to fix (measured 2026-08-16: the SOLE
 * crit reason on a live capture, "nothing wrong with any candidate") — repeatedly
 * opens/resolves a `panel:infra` blocker as PSI oscillates across the threshold.
 * That oscillation is the "PSI thrashing" EI-21025158485847408 reports recurring
 * even after WI-5471 (a DIFFERENT bug — bg-host event-loop/PG-pool starvation)
 * was fixed: the two were never the same failure, and this alarm had no way to
 * tell an ambient reading apart from a genuine operator defect.
 *
 * FAIL-SAFE: a `perf` verdict with no `critAttribution` at all (an older
 * projection, or a hand-built fixture that never called `evaluatePerfSignals`)
 * is treated as NOT ambient-only — the expensive direction (still pages) — per
 * the same fail-safe stance `evaluatePerfSignals` itself documents for this split.
 */
export function infraCritAmbientOnly(d: InfraHealth): boolean {
  const perfCrit = d.perf?.status === 'crit';
  const hostPressureCrit = d.hostPressure?.status === 'crit';
  if (!perfCrit && !hostPressureCrit) return false;
  if (perfCrit) {
    const attribution = d.perf!.critAttribution;
    if (!attribution || attribution.operatorDefect.length > 0) return false;
  }
  if ((d.mcpProxy?.hardFailures ?? 0) >= MCP_PROXY_HARD_FAIL_CRIT) return false;
  if (d.toolFailures?.rating === 'broken') return false;
  if (worstDiskBand(d.disk) === 'crit') return false;
  // Mirrors infraStatus's own gatewayReachable leg, which it only reaches once PG
  // is readable (pg === null short-circuits to 'unknown' before this leg) — so a
  // genuine gateway-down condition alongside an ambient perf crit must still page.
  if (d.pg !== null && d.gatewayReachable === false) return false;
  return true;
}

/**
 * Overwatch (#15) — the autonomous supervisor's OWN loop health (the
 * who-watches-the-watcher panel, D-004). The role ships default-OFF until proven
 * (D-009), so flag-off — and an owner-paused proven loop — are the INTENDED-dark
 * states, greyed (`unknown`), never a red/yellow alarm (and `unknown` never reds
 * the overall, so a not-yet-activated overwatch can't make the dashboard look
 * sick). Once live (flag on + started): crit = DARK (the supervisor loop itself
 * died — B-09 liveness false, the failure D-004 exists to catch); warn = repeated
 * watchdog fallback fires (a forgot-to-declare-next-wake bug); ok = looping.
 */
export function overwatchStatus(d: OverwatchPanelHealth): PanelStatus {
  if (!d.flagEnabled) return 'unknown'; // intentionally dark (default-off, D-009)
  if (!d.started) return 'unknown'; // proven-but-paused by the owner — idle by choice
  if (d.alive === false) return 'crit'; // started + dark = the supervisor itself died (D-004)
  if (d.watchdogFires24h >= WATCHDOG_FIRES_WARN) return 'warn';
  return 'ok';
}

// ── overall roll-up ──────────────────────────────────────────────────────────

/**
 * The system's overall light = the worst NON-`unknown` panel (D-003 / fail-soft):
 * a greyed (unreadable) panel never reds the whole system. Only when EVERY panel
 * is unknown does the overall go unknown.
 */
export function worstStatus(statuses: readonly PanelStatus[]): PanelStatus {
  if (statuses.some((s) => s === 'crit')) return 'crit';
  if (statuses.some((s) => s === 'warn')) return 'warn';
  if (statuses.some((s) => s === 'ok')) return 'ok';
  return 'unknown';
}

// ── health-tab-v2 (2026-07-12) additions ─────────────────────────────────────

/** Numeric severity for ack-coverage comparison (P-004). ok/unknown = 0. */
export function statusSeverity(s: PanelStatus): number {
  return s === 'crit' ? 2 : s === 'warn' ? 1 : 0;
}

/**
 * Does an ack COVER a panel's current status? (P-004 / D-A). An ack mutes
 * severities up to the acked one — an ack taken at 'warn' does NOT mute a later
 * 'crit' (escalation re-alarms); an expired snooze covers nothing. ok/unknown
 * need no coverage (the ack is cleared by the sweep instead).
 */
export function ackCovers(ack: Pick<PanelAck, 'status' | 'snoozeUntil'>, current: PanelStatus, now: number): boolean {
  if (statusSeverity(current) === 0) return false;
  if (ack.snoozeUntil !== null && now > ack.snoozeUntil) return false;
  return statusSeverity(current) <= statusSeverity(ack.status);
}

/**
 * P-001 — the paused-Mug cry-wolf fix. queenStatus() crits a paused colony with
 * ANY queued todo, but a paused pot whose queue is entirely UNPLACEABLE (the
 * work-feed frontier is empty or long-stuck/gated) is idle BY CHOICE — reddening
 * the whole tab for weeks over unplaceable residue is how the dashboard became
 * wallpaper. Reconciles the queen panel against the work-feed's PLACEABLE
 * frontier: paused + placeable demand stays crit (a genuine silent outage);
 * paused + only unplaceable residue downgrades to warn with a summary that
 * AGREES with the status. Returns null when no adjustment applies (not paused,
 * not crit, or the work-feed was unreadable this tick — fail-soft keeps the
 * conservative crit).
 */
export function reconcilePausedQueen(
  queen: { status: PanelStatus; data: QueenHealth | null },
  workFeed: { data: WorkFeedHealth | null },
): { status: PanelStatus; summary: string } | null {
  const q = queen.data;
  if (!q || q.started || queen.status !== 'crit') return null;
  const wf = workFeed.data;
  // Frontier unreadable ⇒ keep the conservative crit, exactly as this function's doc
  // contract promises. `!wf` alone did NOT deliver that: it catches only a MISSING
  // panel, while a survey that THREW leaves `wf` present with a fabricated
  // `frontier: 0` — which reads as "nothing placeable" and falls through to the warn
  // downgrade below, silencing a genuine silent-outage crit on a number nobody
  // measured. The two cases were indistinguishable until `frontierUnreadable` existed
  // (see WorkFeedHealth.frontierUnreadable); this is the same conflation the bees gate
  // carried, with the fail direction pointing at a DOWNGRADE instead of a suppression.
  if (!wf || wf.frontierUnreadable) return null;
  const placeable = Math.max(0, wf.frontier - (wf.frontierStuck ?? 0));
  if (placeable > 0 || wf.startedPlans > 0) {
    return {
      status: 'crit',
      summary: `paused — ${placeable > 0 ? `${placeable} placeable item(s)` : `${wf.startedPlans} started plan(s)`} queued (silent outage)`,
    };
  }
  const residue = q.demand.todoItems;
  return {
    status: 'warn',
    summary: residue > 0
      ? `paused — idle by choice (${residue} queued item(s), none placeable)`
      : 'paused — colony idle by choice',
  };
}

/** Engine loops (P-008). Overdue armed loops / recent failure streaks = warn —
 *  a dead loop stalls ITS lane, not the running system (the workFeed dead-routine
 *  crit already covers an engine-wide freeze). */
export function loopsStatus(d: LoopsHealth): PanelStatus {
  if (d.overdue > 0 || d.failureStreaks > 0) return 'warn';
  return 'ok';
}

/**
 * Coordination (P-009). Deliberately WARN-max for its burn-in period (D-D:
 * a brand-new panel must not red the overall tab until its thresholds have
 * survived contact with reality — the exact cry-wolf failure P-001 fixes).
 */
export function coordinationStatus(d: CoordinationHealth, now?: number): PanelStatus {
  void now;
  if (d.leaderlessFleets > 0) return 'warn';
  if (d.staleAwaits > 0) return 'warn';
  if (d.criticalContext > 0) return 'warn';
  if (d.unansweredOldestMs !== null && d.unansweredOldestMs > UNANSWERED_DIRECTED_WARN_MS) return 'warn';
  // Claim-health (WI-4460): a dead holder's claim is abandoned work; a coverage
  // collision is two live principals on one deliverable — both real smells.
  if (d.orphanedClaims > 0) return 'warn';
  if (d.coverageCollisions > 0) return 'warn';
  // Stalled = alive-but-not-progressing. Unlike the watchdog this count doesn't
  // suppress checkpoint-documented holds (see types.ts), so warn only — and
  // parkedMembers (benched-by-design) never affects status at all.
  if (d.stalledClaims > 0) return 'warn';
  return 'ok';
}

/**
 * Memory (P-010). Warn on a degraded recall signal over a real store — an
 * empty/new store is not a failure, and the store size itself is informational.
 *
 * ABSENCE OF SIGNAL IS NOT HEALTH (EI-10625). `zeroHitRate` is
 * `zeroHit/recalls` with a `: 0` fallback, so it reports a PERFECT 0% in exactly
 * two states it cannot distinguish from perfection: the telemetry read FAILED,
 * or NOTHING WAS RECORDED AT ALL. Both are blind spots, not clean bills of
 * health — and both are reachable: `recordRecallStats`'s own comment documents a
 * stale surface CHECK that silently rejected every write for hours. A rate over
 * zero observations is not a low rate; it is no rate. Check the denominator
 * BEFORE trusting the ratio (the Learning tab's MemoryHealthCard already does —
 * this panel, the one that actually drives the alarm, did not).
 */
export function memoryStatus(d: MemoryPanelHealth): PanelStatus {
  // Only meaningful over a real store: a new/empty workspace records no recalls
  // for the honest reason, and must not be alarmed at.
  if (d.totalMemories > 100) {
    // The telemetry is unreadable — we know nothing, which is not "fine".
    if (!d.recallTelemetryOk) return 'warn';
    // A live store with 10k memories and ZERO recorded recalls in 7 days means the
    // recall-stats pipeline is dark, not that recall is flawless.
    if (d.recalls7d === 0) return 'warn';
    if (d.zeroHitRate !== null && d.zeroHitRate >= 0.9) return 'warn';
  }
  return 'ok';
}

/**
 * Context-injection delivery (codex-context-injection-parity-2026-08-09 P-005).
 *
 * ── A CRIT REQUIRES A BASELINE. THIS IS THE WHOLE DESIGN. ──
 * P-005 specified the firing condition as "a client with no turn-start/mid-turn
 * rows at all". Shipped literally, that alarm fires for a client in FOUR
 * distinguishable situations, only one of which is the fault it means to catch:
 *
 *   1. the hook never fired                         ← the actual target
 *   2. the SERVER-side recorder is not deployed on the port that client talks to
 *   3. the client ran no sessions at all
 *   4. the table is new and nobody has written to it yet
 *
 * Measured on this box the day it was written (2026-08-09): claude had 385
 * sessions/24h and ZERO coverage rows; omp had 10 and zero. Both for reason 2 —
 * the recorder was live only on staging. A literal implementation would have
 * paged for two of the three clients on its first tick, with a confidently wrong
 * cause, which is precisely the false-alarm trap D-005 §3 caught one level down.
 *
 * So: a client may only reach `crit` if it has been observed working BEFORE —
 * `everObserved`. Absence of a baseline is absence of evidence that this client's
 * recording path is even deployed, and a detector must not convert "I have never
 * seen this work" into "this broke". It is the same principle memoryStatus
 * applies to a rate over zero observations (EI-10625): no denominator is not a
 * good score, it is NO score.
 *
 * The cost is deliberate and worth naming: a client whose hook has NEVER worked
 * cannot page. That is correct — a permanently-red alarm for a known-open gap is
 * noise, not signal, and the gap is still fully VISIBLE in the panel (verdict
 * 'never-observed', with its session count). Fixing that gap is the plan's job;
 * the alarm's job is to catch it REGRESSING once fixed.
 */
export function classifyInjectionClient(c: {
  sessions: number;
  events: number;
  unknownTool: number;
  everObserved: boolean;
}): InjectionClientVerdict {
  // Not in play this window — no sessions means nothing to conclude, in either
  // direction. Never alarm on a client nobody ran.
  if (c.sessions <= 0) return 'idle';
  if (c.events <= 0) return c.everObserved ? 'regressed' : 'never-observed';
  // It fired and recorded. Drift is the one actionable outcome left: the hook
  // reached us but the tool is outside the shared vocabulary, so that call
  // contributed nothing and nothing else would have said so.
  if (c.unknownTool > 0) return 'drift';
  return 'ok';
}

/**
 * Severity order for rolling several verdicts (a client's own, plus one per
 * port) into the one the panel shows.
 *
 * `idle` sits BELOW `ok` deliberately: it means "no sessions, nothing to
 * conclude", so it must never win over a port that actually reported. `drift`
 * outranks `never-observed` because drift is actionable now, whereas a
 * never-observed port is a known gap someone is already expected to close.
 */
const INJECTION_VERDICT_SEVERITY: Record<InjectionClientVerdict, number> = {
  idle: 0,
  ok: 1,
  'never-observed': 2,
  drift: 3,
  regressed: 4,
};

/**
 * The worst of several injection verdicts. Empty input is `idle` — no verdicts
 * is no evidence, which is the same reading as no sessions and must not
 * degrade to a confident `ok`.
 */
export function worstInjectionVerdict(
  verdicts: readonly InjectionClientVerdict[],
): InjectionClientVerdict {
  let worst: InjectionClientVerdict = 'idle';
  for (const v of verdicts) {
    if (INJECTION_VERDICT_SEVERITY[v] > INJECTION_VERDICT_SEVERITY[worst]) worst = v;
  }
  return worst;
}

export function contextInjectionStatus(d: ContextInjectionHealth): PanelStatus {
  let worst: PanelStatus = 'ok';
  for (const c of d.clients) {
    if (c.verdict === 'regressed') return 'crit';
    if (c.verdict === 'drift' || c.verdict === 'never-observed') worst = 'warn';
  }
  return worst;
}
