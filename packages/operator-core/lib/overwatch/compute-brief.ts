/**
 * overwatch/compute-brief — B-03 of overwatch-role-2026-06-15.
 *
 * Two halves, by design (D-006: "one health aggregation, two consumers"):
 *
 *  1. THE ANOMALY→ACTION LAYER (this file, landed) — `detectAnomalies(brief)`:
 *     the pure detectors + suggested nudges/observations/escalations that turn a
 *     populated `OverwatchBrief` (C-1) into the actionable `Anomaly[]`. This is
 *     the part B-03 ADDS on top of the shared health model — it is pure logic
 *     over the C-1 types (B-02), so it unit-tests with no DB and is fully
 *     decoupled from the data-gathering half.
 *
 *  2. THE AGGREGATOR WRAPPER (pending) — `computeOverwatchBrief(workspaceId,
 *     potSlug)`: calls `computeSystemHealth(workspaceId)` (system-health-tab
 *     P-002, owned by the Health-tab brief — co-owned per D-006), maps its
 *     SystemHealth panels onto the `OverwatchBrief` actionable subset, then runs
 *     `detectAnomalies`. The mapping is a thin structural bind once
 *     `computeSystemHealth` + its `SystemHealth` type land; it is intentionally
 *     NOT built here against an unpublished type. We do NOT build a second
 *     health-gatherer (D-006). Awaiting `system-health:compute:ready`.
 *
 * The thresholds live HERE (not in the renderer): the renderer is a dumb
 * formatter; the JUDGMENT — what counts as a drift, how severe, what to do — is
 * this layer. Each detector is fail-independent: it reads only its own panel, so
 * a degraded panel (a flaky source greyed by the fail-soft aggregator) simply
 * doesn't trip its detector — it never throws the whole detection.
 */
import { emptyOverwatchBrief } from './brief-types';
import type { Anomaly, AnomalyKind, OverwatchBrief } from './brief-types';
import { computeSystemHealth, deriveQueenAlive, ADMISSION_STARVATION_IDLE_ACCOUNTS_MIN } from '../system-health';
import type { SystemHealth } from '../system-health/types';

/**
 * EI-13557 (escalate) / EI-15448 (every anomaly): the STABLE condition-identity
 * key for an anomaly `kind` — derived from the kind alone (a closed, count-free
 * enum), never from the live count/duration embedded in that anomaly's
 * `detail`/`message`. EVERY anomaly below carries this on its
 * `suggestedAction.conditionKey`, regardless of action type, so re-detections
 * of the SAME condition always coalesce: onto one open `coord:escalate` row for
 * an escalate action (EI-13557: the "N aging owner-attention escalations"
 * self-inflating advisory was this bug for `escalation-aging`), AND onto one
 * open `improvements:capture{lane:'observation'}` row for the D-003 companion
 * observation any action (nudge/observe/escalate) drops (EI-15448: that
 * companion observation had no key at all and is what actually flooded the
 * backlog to 7k+ open items for `escalation-aging` — its escalate side
 * coalesced fine the whole time). Applied uniformly to every anomaly rather
 * than one kind at a time, same rationale as the original EI-13557 fix.
 */
// Exported (EI-16151): escalation-aging-alarm.ts needs the SAME key
// `detectAnomalies` puts on the `escalation-aging` anomaly's `suggestedAction`, so
// its deterministic periodic actor and the LLM-Kettle's prompt-instructed escalate
// call always coalesce onto one open row, never fork on drift between the two.
export function anomalyConditionKey(kind: AnomalyKind): string {
  return `overwatch:${kind}`;
}

function newWorkPausedByOwnerSteering(brief: OverwatchBrief): boolean {
  return brief.ownerSteering.pauseNewWork && brief.ownerSteering.eligiblePlans.length === 0;
}

/**
 * EI-8524: a hive that was never started (or is deliberately paused —
 * `queen.started === false`, "paused ⇒ intentional" per deriveQueenAlive) has no
 * one placing work by design — its ready-but-unplaced frontier is NOT a drift, it's
 * the expected resting state of an idle/test/canary hive. Fold this into the same
 * "new work is intentionally not flowing" gate as the owner-steering pause so the
 * Queen-facing "place them" nudges (frontier-stuck, stranded-work) and the
 * zero-token placement-stall detector all stay quiet for a colony nobody started.
 */
function newWorkIntentionallyIdle(brief: OverwatchBrief): boolean {
  return newWorkPausedByOwnerSteering(brief) || brief.queen.started === false;
}

/**
 * Detect the system-health drifts in a populated brief and attach a suggested
 * action to each. Pure + deterministic — same brief in, same anomalies out (no
 * clock / random; order is the fixed detector order below, and the renderer
 * re-sorts by severity).
 *
 * The overwatch-side detectors (7 of the 8 `AnomalyKind`s — `overwatch-dark` is
 * Queen-side, raised in the Queen's brief by B-09, never in overwatch's own):
 *  - `queen-dark` / `queen-stalled` — liveness first, then cadence (dark wins).
 *  - `token-paused` — starvation (no fallback accounts) escalates; transient observes.
 *  - `work-feed-stuck` — a dead routine escalates (structural); placeable-but-stuck
 *    or stranded-on-a-resolved-constraint nudges the Queen.
 *  - `bees-churning` — churn / dead claims nudge the Queen to re-place.
 *  - `escalation-aging` — aging human-attention escalations surface to the owner.
 *  - `observation-dark` — a flat lane while the fleet runs is observed.
 */
export function detectAnomalies(brief: OverwatchBrief): Anomaly[] {
  const out: Anomaly[] = [];
  const { queen, bees, workFeed, tokens, plans, observations, crossMonitor } = brief;
  const newWorkPaused = newWorkIntentionallyIdle(brief);

  // ── Queen liveness + cadence ───────────────────────────────────────────────
  // Cross-monitor "dark" (no heartbeat) is the harder signal and takes precedence
  // over "stalled" (heartbeat present but past cadence) — never raise both.
  if (!crossMonitor.queenAlive) {
    out.push({
      kind: 'queen-dark',
      severity: 'critical',
      subject: 'mug',
      detail: 'Mug liveness has gone dark — no fresh heartbeat (who-watches-the-watcher, D-004).',
      suggestedAction: {
        type: 'nudge',
        target: 'mug',
        conditionKey: anomalyConditionKey('queen-dark'),
        message: 'Mug — you have gone dark. Waking you: re-derive your survey and resume placement. If this wake misses (woken:0), escalate — a Mug that will not wake is structural.',
      },
    });
  } else if (queen.stalled) {
    out.push({
      kind: 'queen-stalled',
      severity: 'critical',
      subject: 'mug',
      detail: `Mug last woke ${queen.lastWakeAt ?? 'unknown'} and is past her cadence` + `${queen.workingTracked > 0 ? ` with ${queen.workingTracked} placement(s) in flight` : ''}.`,
      suggestedAction: {
        type: 'nudge',
        target: 'mug',
        conditionKey: anomalyConditionKey('queen-stalled'),
        message: 'Mug — you have stalled past your cadence. Wake, clear your recovering placements, and declare a fresh wake.',
      },
    });
  }

  // ── Tokens / gateway ───────────────────────────────────────────────────────
  // A paused bucket WITH fallback accounts is usually transient RPM saturation —
  // observe. A paused bucket with ZERO accounts available is real starvation and
  // needs a structural fix overwatch cannot perform — escalate (D-002).
  if (tokens.pausedBuckets.length > 0) {
    const buckets = tokens.pausedBuckets.join(', ');
    if (tokens.accountsAvailable <= 0) {
      out.push({
        kind: 'token-paused',
        severity: 'critical',
        subject: 'token buckets',
        detail: `Paused buckets [${buckets}] AND no accounts available — the fleet is token-starved.`,
        suggestedAction: {
          type: 'escalate',
          target: 'owner',
          conditionKey: anomalyConditionKey('token-paused'),
          message: `All paused (${buckets}) with zero fallback accounts — a structural rate/account fix is needed ` + '(scale-out or rate config). Kettle cannot rebind the gateway or flip rate config.',
        },
      });
    } else {
      out.push({
        kind: 'token-paused',
        severity: 'warning',
        subject: 'token buckets',
        detail: `Paused buckets [${buckets}] with ${tokens.accountsAvailable} account(s) still available — likely transient RPM saturation.`,
        suggestedAction: {
          type: 'observe',
          conditionKey: anomalyConditionKey('token-paused'),
          message: `Bucket(s) ${buckets} paused on RPM saturation; ${tokens.accountsAvailable} account(s) available. Watching — escalate only if it persists across wakes.`,
        },
      });
    }
  }

  // ── Gateway wedge / sustained throttle (B-GW-5) ──────────────────────────────
  // The gateway watchdog auto-restarts a wedge SILENTLY; surfacing it here makes it VISIBLE +
  // escalable. A CONFIRMED wedge (slots pinned + a growing queue + a frozen counter) is a real
  // incident even after the watchdog bandaids it — a recurring wedge means opus demand > pool
  // capacity (the structural fix is scale-out / per-account egress IPs, which overwatch cannot do).
  if (tokens.gatewayWedged) {
    out.push({
      kind: 'gateway-wedge',
      severity: 'critical',
      subject: 'inference gateway',
      detail: 'Inference gateway WEDGED — every admission slot pinned with a growing queue and a frozen request counter. The watchdog auto-restarts it, but a recurring wedge is a capacity problem (opus demand exceeds the account pool).',
      suggestedAction: {
        type: 'escalate',
        target: 'owner',
        conditionKey: anomalyConditionKey('gateway-wedge'),
        message:
          'Gateway wedged (watchdog auto-restarting :8788). If this recurs, it is a structural capacity fix — scale out the account pool or provision per-account egress IPs (B-GW-3). Kettle cannot rebind the gateway or add capacity.',
      },
    });
  } else if (tokens.gatewaySustainedThrottle) {
    out.push({
      kind: 'gateway-throttle',
      severity: 'warning',
      subject: 'inference gateway',
      detail: 'Inference gateway sustained-throttling — AIMD has cut admission concurrency below its cap, or the pool is fail-fast shedding (all accounts throttled). Capacity pressure, not yet a wedge.',
      suggestedAction: {
        type: 'observe',
        conditionKey: anomalyConditionKey('gateway-throttle'),
        message: 'Gateway throttling under sustained upstream 429s (AIMD adapting). Watching — escalate if it persists across wakes or tips into a wedge.',
      },
    });
  } else if (tokens.gatewayAdmissionStarved && tokens.accountsAvailable > ADMISSION_STARVATION_IDLE_ACCOUNTS_MIN) {
    // WI-3565 (2026-07-09): the admission-STARVATION mode `gatewayWedged`/`gatewaySustainedThrottle`
    // both miss — a deep queue sitting BELOW the live ceiling (paced by a lower per-account/provider
    // floor) with idle healthy accounts unused. This is what let a 24-deep queue at maxConcurrent=2
    // run 50 real minutes with zero alarm. Escalate (not observe/nudge): the fix is a live config
    // change (operator:rate_limit_config) overwatch has no primitive to make itself (D-001).
    out.push({
      kind: 'gateway-admission-starved',
      severity: 'critical',
      subject: 'inference gateway',
      // EI-15912 (2026-07-18, 5 consecutive reported "false positives"): this signal is the
      // GATEWAY PROCESS's own internal admission queue (/stats admission.queued vs
      // admission.maxConcurrent, read via gateway:status) — a DIFFERENT layer than the fleet
      // rate-bucket governor dev:rate_governor_status reports (buildFleetRateStatus). The two
      // can legitimately diverge (e.g. fleet.inFlight:0/cap:16 clean while the gateway's own
      // admission queue is genuinely deep from other/Codex/cross-workspace traffic or a
      // temporarily AIMD-clamped ceiling), so a dev:rate_governor_status read alone NEITHER
      // confirms nor refutes this anomaly — every EI-15912 "verification" checked only that
      // tool and never gateway:status, so none of the 5 reports actually ruled the alarm in or
      // out. gateway:status's own guidance already says as much ("only once admission is RULED
      // OUT" via gateway:status first) — this detail line + message repeat it here so the next
      // responder doesn't rediscover the confusion from scratch.
      detail: `Inference gateway admission backlog sustained deep vs its live ceiling for ≥5min with ${tokens.accountsAvailable} idle healthy account(s) unused — the queue isn't draining even though the pool has spare capacity. This reads the GATEWAY's own admission queue (gateway:status), NOT the fleet rate-bucket governor (dev:rate_governor_status) — the two are different layers and can disagree; verify with gateway:status before treating a clean dev:rate_governor_status read as a refutation.`,
      suggestedAction: {
        type: 'escalate',
        target: 'owner',
        conditionKey: anomalyConditionKey('gateway-admission-starved'),
        message:
          `Admission starvation: ${tokens.accountsAvailable} idle account(s) available but the live admission ceiling is starving the queue. FIRST verify with gateway:status (the same admission.queued/admission.maxConcurrent this alarm reads) — a clean dev:rate_governor_status read does NOT rule this out, it reads a different subsystem (the fleet rate-bucket governor, not the gateway's own admission queue). If gateway:status confirms a deep queue below the ceiling, raise the provider floor: operator:rate_limit_config { providerFloors: { anthropic: { maxConcurrent: <higher> } } } (mirrors the 2026-07-09 manual mitigation). Kettle cannot flip live rate-limit config itself (D-001).`,
      },
    });
  }

  // ── Work feed ──────────────────────────────────────────────────────────────
  // A dead routine is structural (the feed stopped pumping — EI-584): escalate.
  if (workFeed.deadRoutines > 0) {
    out.push({
      kind: 'work-feed-stuck',
      severity: 'critical',
      subject: 'work feed',
      detail: `${workFeed.deadRoutines} dead work-feed routine(s) — auto-eligible work is not flowing (the EI-584 signature).`,
      suggestedAction: {
        type: 'escalate',
        target: 'owner',
        conditionKey: anomalyConditionKey('work-feed-stuck'),
        message: `${workFeed.deadRoutines} work-feed routine(s) dead; auto-eligible items are stranded. A routine restart is structural — overwatch cannot restart it.`,
      },
    });
  }
  // Placeable work not being placed while routines are alive — the Queen's to place.
  // EI-2357: key this off the genuinely Queen-PLACEABLE frontier (unblocked todo the
  // Queen actually places), NOT `autoEligibleStuck` — that count is the auto-IMPLEMENT
  // dispatcher's drain lane (code-bug improvements the DISPATCHER, not the Queen, drains).
  // A stalled dispatcher is surfaced separately (collectDispatcherStalenessSignals, wired
  // into the improvements watchdog). Keying the Queen nudge off the dispatcher lane caused
  // chronic false "Queen drove 0 placements" readings + recurring false HUMAN escalations
  // whenever the dispatcher backlog was non-empty while the frontier was 0 (the Queen had
  // nothing to place) — see EI-2357 / EI-2130 / EI-2238.
  // WI-3597: only FRESH frontier (ready AND not aged past the stuck window) is work
  // the Queen is failing to place. A frontier that is entirely long-stuck/gated
  // (owner decision / live rig / fixture) is correct idle — nudging "place them!"
  // there is the exact false "queen-workitem-selection broken" read this fixes.
  const frontierStuck = workFeed.frontierStuck ?? 0;
  const freshFrontier = workFeed.frontier - frontierStuck;
  if (!newWorkPaused && freshFrontier > 0 && workFeed.deadRoutines === 0) {
    out.push({
      kind: 'work-feed-stuck',
      severity: 'warning',
      subject: 'work feed',
      detail: `${freshFrontier} placeable frontier item(s) ready (unblocked todo) but unplaced, with the routines alive.` +
        (frontierStuck > 0 ? ` (${frontierStuck} more are long-stuck/gated — correct idle, excluded.)` : ''),
      suggestedAction: {
        type: 'nudge',
        target: 'mug',
        conditionKey: anomalyConditionKey('work-feed-stuck'),
        message: `Mug — ${freshFrontier} fresh frontier item(s) are ready to place; place them.`,
      },
    });
  }
  // Work blocked on a constraint that has since resolved — re-open it (the canonical nudge).
  if (!newWorkPaused && workFeed.blockedStranded > 0) {
    out.push({
      kind: 'work-feed-stuck',
      severity: 'warning',
      subject: 'stranded work',
      detail: `${workFeed.blockedStranded} item(s) blocked on an already-resolved constraint.`,
      suggestedAction: {
        type: 'nudge',
        target: 'mug',
        conditionKey: anomalyConditionKey('work-feed-stuck'),
        message: `Mug — ${workFeed.blockedStranded} item(s) are stranded blocked-on-a-resolved-constraint; re-open them so they re-enter the frontier.`,
      },
    });
  }

  // ── Bees ───────────────────────────────────────────────────────────────────
  if (bees.churning > 0 || bees.deadClaims > 0) {
    const parts: string[] = [];
    if (bees.churning > 0) parts.push(`${bees.churning} churning`);
    if (bees.deadClaims > 0) parts.push(`${bees.deadClaims} dead claim(s)`);
    out.push({
      kind: 'bees-churning',
      // A dead claim is abandoned work (worse than churn alone).
      severity: bees.deadClaims > 0 ? 'warning' : 'info',
      subject: 'bees',
      detail: `${parts.join(' · ')} (running ${bees.running}).`,
      suggestedAction: {
        type: 'nudge',
        target: 'mug',
        conditionKey: anomalyConditionKey('bees-churning'),
        message: `Mug — bees: ${parts.join(', ')}; re-place the abandoned unit(s) and check the churning bee(s) for a wedged loop.`,
      },
    });
  }
  if (bees.invalidModelFailures > 0) {
    out.push({
      kind: 'invalid-model-config',
      severity: 'critical',
      subject: 'agent model config',
      detail: `${bees.invalidModelFailures} recent autonomous-role spawn(s) failed before a turn because the selected model is unavailable or inaccessible.`,
      suggestedAction: {
        type: 'escalate',
        target: 'owner',
        conditionKey: anomalyConditionKey('invalid-model-config'),
        message:
          `${bees.invalidModelFailures} recent autonomous-role spawn(s) failed with "selected model" unavailable/access errors. ` +
          `Inspect /settings/agent role model overrides and tier menu; clear or replace unavailable model specs before placing more work.`,
      },
    });
  }

  // ── Escalations aging ──────────────────────────────────────────────────────
  if (!newWorkPaused && plans.agingEscalations > 0) {
    out.push({
      kind: 'escalation-aging',
      severity: 'warning',
      subject: 'escalations',
      detail: `${plans.agingEscalations} escalation(s) aging past the attention threshold.`,
      suggestedAction: {
        type: 'escalate',
        target: 'owner',
        // EI-13557: the count-free stable key — NOT `agingConditionKey` (that one is
        // per-watchdogKey and belongs to the unrelated known-open-aging code path,
        // EI-14854). This is the count-carrying advisory that was self-inflating.
        conditionKey: anomalyConditionKey('escalation-aging'),
        message: `${plans.agingEscalations} human-attention escalation(s) have aged past the attention threshold. Review the Planning Needs you queue and resolve, answer, or dismiss stale items; the Mug cannot clear owner-decision backlog by being nudged.`,
      },
    });
  }

  // ── Observation lane dark while the fleet is active ────────────────────────
  if (observations.laneCount === 0 && bees.running > 0) {
    out.push({
      kind: 'observation-dark',
      severity: 'info',
      subject: 'observation lane',
      detail: `Observation lane flat (0 this window) while ${bees.running} bee(s) run — the fleet has stopped recording sensor readings.`,
      suggestedAction: {
        type: 'observe',
        conditionKey: anomalyConditionKey('observation-dark'),
        message: `Observation lane flat while ${bees.running} bee(s) active — the turn-end reflection step may be getting skipped fleet-wide.`,
      },
    });
  }

  return out;
}

/**
 * Return a copy of the brief with its `anomalies` populated by `detectAnomalies`.
 * The aggregator wrapper (and tests) use this so detection is applied in exactly
 * one place. Pure — does not mutate the input.
 */
export function withAnomalies(brief: OverwatchBrief): OverwatchBrief {
  return { ...brief, anomalies: detectAnomalies(brief) };
}

/* ────────────────────────────────────────────────────────────────────────────
 * THE AGGREGATOR WRAPPER — `computeSystemHealth` → `OverwatchBrief` (D-006).
 *
 * The overwatch brief is the ACTIONABLE SUBSET of the shared `SystemHealth`
 * model — we WRAP the single Health-tab aggregator and never build a second
 * health-gatherer (D-006). `mapSystemHealthToBrief` is the pure structural bind
 * (SystemHealth panels → the OverwatchBrief panels); `computeOverwatchBrief` is
 * the thin async wrapper that gathers + maps + detects.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Format an ms-epoch as ISO-8601, or null. Pure given the input ms (no clock). */
function msToIso(ms: number | null): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

/**
 * Map a `SystemHealth` snapshot (system-health-tab P-001/P-002) onto the
 * actionable `OverwatchBrief` subset (C-1). Pure + deterministic — no I/O, no
 * clock — so it unit-tests against fixtures with no DB.
 *
 * FAIL-SOFT BY CONSTRUCTION (the B-03 requirement): start from
 * `emptyOverwatchBrief` (everything healthy + zeroed) and fill each section ONLY
 * from a panel whose `data` is present. `computeSystemHealth` greys an unreadable
 * source to `status:'unknown'` + `data:null`; such a panel keeps the neutral
 * default here, so one flaky source degrades that field instead of fabricating an
 * anomaly (mirrors the SystemHealth "unknown is never a fabricated outage" stance).
 *
 * Mapping notes where the shared model and the C-1 subset don't line up 1:1:
 *  - `bees.churning`  ← `bees.stale` (running-but-presence-stale = the churn signal);
 *    `bees.deadClaims` ← `bees.orphanedClaims` (active claim, dead holder).
 *  - `workFeed.blockedStranded` ← `bees.placements.stranded` — su-3b017 sourced the
 *    stranded-on-a-resolved-constraint count there in response to the B-03 co-shape
 *    flag (it is NOT `workFeed.frontierBlocked`, which is blocked-on-UNsatisfied).
 *  - `crossMonitor.queenAlive` is the SHARED `deriveQueenAlive` derivation (in
 *    system-health/thresholds) — the SAME function `computeSystemHealth` uses, so
 *    this mapper and the Health tab can't disagree. It is liveness-only, kept
 *    DISTINCT from `stalled` so the detector's `queen-stalled` path stays live:
 *    dark = the loop is gone (started, no next wake armed, AND stale); a started-
 *    but-armed Queen is alive even when stalled; a paused (not-started) Queen is
 *    intentional, never dark. EI-623 was the earlier drift — the shared model and
 *    this mapper each carried their OWN copy and the shared one lagged on
 *    `started && !stalled`; the one shared helper removes that whole drift class.
 *
 * Known degraded-to-default fields until the shared model exposes them (each is
 * renderer-context only OR fail-soft-quiet for its detector, never a wrong alarm):
 *  - `tokens.pausedBuckets` is a COUNT in `TokensHealth`, not bucket NAMES; we
 *    surface a count descriptor so the detector still trips (length>0) and reads
 *    informatively. (`gatewayFailovers` / `gw429s` / `gatewayWedged` ARE now sourced
 *    from the gateway's own /stats — B-GW-5 wired `tokens.gateway`.)
 *  - `bees.completed` (no per-window completed count in `BeesHealth`) and
 *    `workFeed.autoEligibleStuck` (su-3b017 adds the attempts:0 count when wiring)
 *    default to 0.
 */
export function mapSystemHealthToBrief(health: SystemHealth, potSlug: string): OverwatchBrief {
  const brief = emptyOverwatchBrief(potSlug);
  const panels = health.panels;

  const queen = panels.queen.data;
  if (queen) {
    brief.queen = {
      started: queen.started,
      lastWakeAt: msToIso(queen.lastWakeAt),
      stalled: queen.stalled,
      midTurn: queen.midTurn,
      cadenceOk: queen.cadenceOk,
      workingTracked: queen.workingTracked,
      nextFireAt: msToIso(queen.nextFireAt),
      // Resolved by the async computeOverwatchBrief wrapper (needs DB) — the pure
      // mapper leaves it null; SystemHealth.QueenHealth has no coord owner.
      coordOwner: null,
    };
  }

  const bees = panels.bees.data;
  if (bees) {
    brief.bees = {
      running: bees.running,
      completed: 0, // no per-window completed count in BeesHealth — fail-soft default (renderer-only).
      churning: bees.stale,
      deadClaims: bees.orphanedClaims,
      invalidModelFailures: bees.invalidModelFailures,
    };
  }

  const workFeed = panels.workFeed.data;
  // Surface each work-feed field from its own source (independent fail-soft): the
  // frontier/dead-routine counts from the workFeed panel, the stranded count from
  // the bees panel's placement dispositions (see mapping notes above).
  brief.workFeed = {
    frontier: workFeed?.frontier ?? 0,
    frontierStuck: workFeed?.frontierStuck ?? 0, // WI-3597: long-unplaced/gated subset
    autoEligibleStuck: workFeed?.autoEligibleStuck ?? 0, // now wired from WorkFeedHealth — activates the work-feed-stuck detector
    keylessHumanReviewBacklog: workFeed?.keylessHumanReviewBacklog ?? 0, // EI-14223: the by-design, non-Mug-actionable keyless backlog, kept separate
    deadRoutines: workFeed?.deadRoutines ?? 0,
    blockedStranded: bees?.placements.stranded ?? 0,
  };

  const tokens = panels.tokens.data;
  if (tokens) {
    brief.tokens = {
      // TokensHealth exposes a COUNT, not names; surface a descriptor so the
      // detector trips (length>0) and the nudge reads informatively until names land.
      pausedBuckets: tokens.pausedBuckets > 0 ? [`${tokens.pausedBuckets} of ${tokens.totalBuckets} bucket(s)`] : [],
      // Gateway telemetry now sourced from the gateway's own /stats (B-GW-5). null = gateway
      // unreachable / not in the egress path → fail-soft defaults (no false alarm).
      gatewayFailovers: tokens.gateway?.failovers ?? 0,
      gw429s: tokens.gateway ? tokens.gateway.shed429 + tokens.gateway.shedAllThrottled : 0,
      accountsAvailable: tokens.accountsAvailable,
      gatewayWedged: tokens.gateway?.wedge ?? false,
      gatewaySustainedThrottle: tokens.gateway?.sustainedThrottle ?? false,
      gatewayAdmissionStarved: tokens.gateway?.admissionStarved ?? false,
    };
  }

  // Plans + escalations are two SystemHealth panels feeding the one C-1 plan panel.
  const plans = panels.plans.data;
  const escalations = panels.escalations.data;
  brief.plans = {
    active: plans?.active ?? 0,
    stalledItems: plans?.stalledPlans ?? 0,
    agingEscalations: escalations?.aging ?? 0,
  };

  const observations = panels.observations.data;
  if (observations) {
    brief.observations = {
      laneCount: observations.laneCount,
      recentByRole: { ...observations.recentByRole }, // copy — don't alias the source.
    };
  }

  // Cross-monitor (D-004). queenAlive = the shared liveness-only derivation
  // (deriveQueenAlive) — the SAME function the shared SystemHealth model uses, so
  // the brief and the Health tab can't disagree (EI-623: they used to be duplicated
  // copies that drifted). overwatchAlive defaults true on its own brief (it is
  // computing → alive); B-09 wires the real reverse leg into the shared model.
  const queenAlive = deriveQueenAlive(queen);
  brief.crossMonitor = {
    queenAlive,
    overwatchAlive: health.crossMonitor.overwatchAlive ?? true,
  };

  return brief;
}

/**
 * Compute the overwatch's wake brief for one hive: gather the shared
 * `SystemHealth` (D-006), map it onto the actionable `OverwatchBrief` subset, and
 * run the anomaly→action detector. The async entry point B-04's wake-launch calls
 * (it then renders the result via `renderOverwatchBrief`).
 *
 * FAIL-SOFT: `computeSystemHealth` is itself per-panel fail-soft (a flaky source
 * greys its card), so a partial snapshot already degrades gracefully through the
 * mapper. The try/catch here covers the catastrophic case (the whole aggregator
 * throws) — we return the neutral `emptyOverwatchBrief` (healthy + no anomalies)
 * so the wake still fires with a coherent, non-alarming brief rather than failing
 * the launch (mirrors `computeQueenWakeBrief`'s graceful degradation).
 */
export async function computeOverwatchBrief(workspaceId: string, potSlug: string, opts: { wokeBy?: string } = {}): Promise<OverwatchBrief> {
  const wokeBy = opts.wokeBy?.trim();
  try {
    const health = await computeSystemHealth(workspaceId);
    const brief = mapSystemHealthToBrief(health, potSlug);
    if (wokeBy) brief.wokeBy = wokeBy;
    // Fold owner steering before anomaly detection so an intentional full
    // pause suppresses "Queen should place/triage" nudges while structural
    // alarms (dead routines, token starvation, gateway wedge, etc.) stay live.
    try {
      const { getOrgPg } = await import('@papercusp/db-org');
      const { getOwnerSteering, isPausedNow } = await import('../owner-steering');
      const { sql } = getOrgPg();
      const steering = await getOwnerSteering(workspaceId, potSlug, sql);
      brief.ownerSteering = {
        pauseNewWork: isPausedNow(steering, Date.now()),
        pausedUntil: steering.pausedUntil,
        eligiblePlans: [...steering.eligiblePlans],
      };
    } catch (e) {
      console.warn(`[overwatch-brief] could not read owner steering for '${potSlug}' — pause-aware anomaly suppression disabled:`, e instanceof Error ? e.message : e);
    }
    // Resolve the Queen's coord owner so the overwatch can address a nudge to her
    // (it lands in her next wake brief's inbox — the SAME resolveMugOwner the
    // Queen's own brief reads, so addressing it delivers). Fail-soft: any error
    // leaves coordOwner null → the persona escalates Queen-drift instead of nudging.
    try {
      const { getOrgPg } = await import('@papercusp/db-org');
      const { resolveMugOwner } = await import('../pot/placement-watchdog');
      const { sql } = getOrgPg();
      brief.queen.coordOwner = await resolveMugOwner(sql, workspaceId, potSlug);
    } catch (e) {
      console.warn(`[overwatch-brief] could not resolve the Mug coord owner for '${potSlug}' — nudges will escalate:`, e instanceof Error ? e.message : e);
    }
    // Pre-fold the overwatch's OWN coord inbox (mirrors the Queen's brief) so it sees
    // replies / owner directives without a separate coord:inbox call. The owner is the
    // latest `overwatch · <slug>/…` session's coord_owner_id; the read is workspace-ALS
    // scoped (the coord log is workspace-keyed). Fail-soft: any error leaves inbox unset.
    try {
      const { getOrgPg } = await import('@papercusp/db-org');
      const { readInbox } = await import('../agent-tools/coordination/messages');
      const { runWithWorkspace } = await import('../workspace-als');
      const { sql } = getOrgPg();
      const ownerRows = await sql<{ coord_owner_id: string }[]>`
        SELECT coord_owner_id FROM harness_shared.adv_sessions
         WHERE workspace_id = ${workspaceId}
           AND label LIKE ${'overwatch · ' + potSlug + '/%'}
           AND coord_owner_id IS NOT NULL
         ORDER BY started_at DESC LIMIT 1`;
      const owner = ownerRows[0]?.coord_owner_id ?? null;
      if (owner) {
        // Bounded read (EI-19323045109346905): only the newest few entries survive
        // the fold, so the unbounded ~20k-row scan was pure waste here.
        //
        // The stopping rule MUST count entries that survive THIS caller's own
        // `!e.category` filter, not the raw visible ones. Ambient service-health /
        // governor broadcasts are exactly what that filter drops, and they arrive in
        // long runs — so a rule of `entries.length >= FOLD` would be satisfied by a
        // page of pure ambient noise and under-fill the fold to zero.
        const FOLD = 10;
        const all = await runWithWorkspace(workspaceId, () =>
          readInbox(owner, {}, { enough: (entries) => entries.filter((e) => !e.category).length >= FOLD }),
        );
        const items = all
          .filter((e) => !e.category) // drop ambient (service-health / governor) like coord:inbox default
          .slice(-FOLD)
          .reverse() // newest-first
          .map((e) => ({
            kind: e.kind,
            from: e.from,
            summary: (e.summary ?? e.body ?? '').slice(0, 200),
          }));
        if (items.length > 0) brief.inbox = items;
      }
    } catch (e) {
      console.warn(`[overwatch-brief] could not fold the overwatch inbox for '${potSlug}':`, e instanceof Error ? e.message : e);
    }
    return withAnomalies(brief);
  } catch (err) {
    console.warn(`[overwatch-brief] computeSystemHealth failed for hive '${potSlug}' — returning the neutral fail-soft brief:`, err instanceof Error ? err.message : err);
    const fallback = emptyOverwatchBrief(potSlug);
    if (wokeBy) fallback.wokeBy = wokeBy;
    return fallback;
  }
}
