/**
 * watchdog.ts — the HARD feed-in of the self-improvement loop
 * (close-the-self-improvement-loop-2026-06-05, D-003).
 *
 * Before this, the capture feed was agent-discretion only (the SU-prompt nudge +
 * the scheduled scan agent) — the backlog filled only when an agent remembered to
 * file. The watchdog fills it from SIGNALS: on a cadence it sweeps the operator's
 * own telemetry for things that are observably broken and auto-captures each as a
 * `kind=bug` improvement through the SAME `captureImprovement` core the tool uses
 * (so search-first dedup + the topic tagging + the kind column all hold).
 *
 * v1 signal sources (each one is a real "something is RED" surface that already
 * exists — no new instrumentation):
 *   - **red-test**            — `harness_shared.test_runs`: a test file that
 *                               failed repeatedly in the window AND is still
 *                               failing on its latest run (not a one-off dev red).
 *                               Carries the file path → feeds the protected-path gate.
 *   - **smoke-fail**          — `harness_shared.harness_smoke_test` rows with
 *                               status='fail' (the same signal plans:attention surfaces).
 *   - **repeated-tool-error** — `harness_shared.tool_invocations`: one tool
 *                               erroring/timing out ≥ threshold times in the window.
 *   - **service-down**        — the service-health monitor's last probe results
 *                               (a watched dev endpoint currently DOWN).
 *
 * Anti-flood (the plan's over-capture risk): `planWatchdogCaptures` is pure and
 * caps captures per tick (severity-ranked); cross-tick/cross-history dedup rides
 * the capture core's search-first with `dedupScope:'open'` (an OPEN duplicate
 * declines the re-file; a RESOLVED one means the problem regressed → re-file).
 */

import postgres from 'postgres';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join as pathJoin, isAbsolute as pathIsAbsolute } from 'node:path';
import { getOrgPg } from '@papercusp/db-org';
import { isInProcessLaunchIdentity } from '../../fleet/spawn-row-class';
import { getHarnessAdminUrl } from '../../embedded-pg-discovery';
import { DEFAULT_COORD_WORKSPACE } from '@papercusp/coordination/event-log';
import { lastServiceHealth, lastServiceHealthAt, probeAll, recordProbeResults, type ProbeResult } from '../../service-health';
import { STALE_PLAN_CLAIM_GRACE_MS } from '../../plan-items/stale-claims';
import { checkMigrationDrift } from '../../migration-drift';
import {
  checkSchemaObjectDrift,
  describeSchemaObjectDrift,
  type SchemaObjectDriftResult,
} from '../../schema-object-drift';
import { findIssuesByWatchdogKeys } from '../../issues-engineer';
import { captureImprovement, type CaptureImprovementResult, type ImprovementKind } from './capture-core';
// WI-38327: the threshold the bridge's own alarm decider debounces on. Imported so the
// guard cannot drift from the thing it guards (github-divergence.ts has 4 static imports,
// all types/pg — no cycle, no import-graph cost).
import { GITHUB_BRIDGE_NEEDS_OWNER_MIN_SWEEPS } from '../../sync/pot-git/github-divergence';
import { sourceFilesWorkItem } from './signal-lane';
import { effectiveOrigin, type SignalOrigin } from './provenance';
import {
  processKnownOpenAging,
  agingOptionsFromTick,
  type KnownOpenAgingInput,
  type KnownOpenAgingOutcome,
  type KnownOpenAgingTickTunables,
} from './known-open-aging';
import { processAutoClose as runAutoCloseSweep, type AutoCloseOutcome } from './auto-close';
import {
  classifyToolError,
  toolErrorSignalKey,
  toolErrorClassSqlCase,
  toolErrorFingerprintSqlCase,
  type ToolErrorClass,
} from './tool-error-classifier';
import type { ImprovementSeverity } from './policy';
import type { LearningSloOptions } from './learning-slo';
// Type-only (erased at runtime, so no import cycle with engagement.ts, which
// type-imports CollectorResult/WatchdogSignal from here).
import type { EngagementCollectorOptions } from '../../endpoint-ipc/engagement';
import { isLoopArmOwnerRole } from '../routines/autoloop-chronic-failure';
import { SESSION_END_MARKER } from '../../agent-tools/activity/lifecycle-markers';

export type WatchdogSource =
  | 'red-test' | 'smoke-fail' | 'repeated-tool-error' | 'service-down'
  | 'dream-quality'
  // P-010 blind-source collectors (watchdog-robustness):
  | 'migration-drift' | 'routine-failure' | 'stuck-plan' | 'failed-spawn' | 'expired-lease' | 'unresolved-escalation'
  // WI-918476: index objects that exist in the LIVE database but that no migration
  // produces (or vice versa) — the third direction, and the one neither
  // 'migration-drift' nor 'schema-ahead-of-code' can see, because both of those read
  // the migration LEDGER and an object created outside the migration set leaves no
  // trace in it. See collectSchemaObjectDriftSignals.
  | 'schema-object-drift'
  // a role fire-path in error-backoff (autoloop_state.consecutive_errors):
  | 'fire-circuit-open'
  // an engine LOOP (loop:arm) parked at 'infinity' far past its fire with NO completion
  // marker + no session activity — its wake turn likely died silently (e.g. a 429 during a
  // rate-limit storm) and only the ≥30min stuck-park backstop will recover it. The early,
  // visible signal for the loop-wake-rate-limit-robustness class (P1b — agent-insights/
  // loop-wake-turn-deaths-recorded-as-delivered):
  | 'loop-stalled'
  // an ACTIVE agent-insight runbook citing repo files that no longer exist
  // (learning-system-audit P-051 — insight-staleness.ts):
  | 'insight-staleness'
  // hive-loop invariant monitors (hive-loop-e2e-testing-2026-06-10 P-010):
  | 'stalled-feature' | 'orphaned-spawn' | 'escalation-spike'
  // WI-38327: git-sync's GitHub bridge has marked its OWN state owner-gated
  // (`github_bridge.needs_owner`) and no owner-rail notification carrying that
  // condition key exists. The recurrence guard for the ~26h/899-commit egress
  // block — see collectBridgeNeedsOwnerSignals for why the falsifier is the
  // attention_notifications audit row and not the escalation's own latch.
  | 'bridge-needs-owner-unalerted'
  // agent-activity-liveness-truth-2026-06-21 P-007 (D-001/D-004, folds EI-2311):
  // a work-item CLAIM held by a LIVE holder that has made NO item-scoped progress
  // for far past the window (fleet_assignment.stalled). The LOUD recurrence guard
  // for the incident — a claim is not progress; this fires even while the
  // RECLAIM_STALLED reconciler leg is dark, so stalled work is never silently
  // "covered". Distinct from stalled-feature (an UNCLAIMED dispatchable feature
  // sitting idle) and orphaned-spawn (a DEAD nursery row): this is a live holder
  // not advancing its claim.
  | 'stalled-claim'
  // the spawn-admission ceiling is consumed by rows that aren't actually
  // streaming — stale debits jamming `maxSimultaneousAgents` so NO bee can be
  // placed even though ~nothing is alive (EI-2186 — host-restart class). The
  // orphaned-spawn collector misses this because the jammed rows can carry a
  // FRESH heartbeat (a reused-pid false-alive bump); this reads stream activity
  // (last_output_at), which a dead process cannot fake:
  | 'spawn-ceiling-jam'
  // links 5–6 flow assertion (hive-loop-e2e-testing-2026-06-10 P-011 — ship-link.ts):
  | 'ship-link-stuck'
  // an auto-implement dispatch whose worker died without ever calling
  // improvements:resolve (consume-edges P-011 — orphaned-dispatch.ts):
  | 'orphaned-dispatch'
  // the auto-implement DISPATCHER itself has stopped firing while armed work
  // waits — `lastDispatchAt` stale despite an eligible queue (EI-2150 —
  // dispatcher-staleness.ts). The orphaned-dispatch collector only sees DEAD
  // WORKERS on open rows; this sees NO dispatches at all:
  | 'dispatcher-staleness'
  // learning-system SLO sensors (self-learning-frontier P-047 / FB-21 —
  // learning-slo.ts; flag-gated dark per D-001 until the P-001 arming gate):
  | 'triage-entropy' | 'capture-consume-imbalance' | 'mttsh-regression'
  | 'governor-starvation' | 'memory-zero-hit'
  // context-injection-audit-2026-07-28 P-013 (D-024): the PER-POOL slice of recall
  // health, which the blended 'memory-zero-hit' aggregate above cannot express. The
  // push path fuses three independently-budgeted pools into ONE recorded row, so a
  // pool returning nothing on EVERY call is invisible in the blend while its
  // siblings fill the block — measured live: `claim`'s user pool at 18/18 zero
  // while the `claim` surface itself reported 0.0%. Fires on a starved pool
  // (gate-2) or one that always fills its budget (gate-4). Both are COUNT-based,
  // never score-based: a push-path top_score is a post-fusion RRF rank and cannot
  // be compared to the cosine floor (D-023, the retracted D-001 class):
  | 'memory-recall-pool'
  // a single memory INJECTION POOL that is starved (returns nothing on nearly every
  // recall — the unmigrated-scope-key signature) or saturated (fills its budget every
  // call). Deliberately per-POOL: both shapes are invisible to the blended
  // 'memory-zero-hit' SLO above by construction, since that aggregates the whole table
  // and a surface whose other pools answer normally reads healthy throughout
  // (learning-slo.ts). WORKSPACE-GLOBAL — not in HARNESS_SCOPED_WATCHDOG_SOURCES:
  | 'memory-recall-pool'
  // context-injection-audit-2026-07-28 P-037 (F-G) gate-5: a recorded
  // `score_scale` label that its own top_score makes arithmetically impossible
  // (an rrf row above the rrf ceiling, a cosine row below the admission floor).
  // NOT a retrieval-quality signal — it says the DISCRIMINATOR every scale-aware
  // reader trusts is lying, silently reinstating the D-001 mixing bug for all of
  // them. Deliberately has no rate floor or minimum sample, unlike the count
  // SLOs above: a contradiction is impossible rather than merely unusual.
  // WORKSPACE-GLOBAL — not in HARNESS_SCOPED_WATCHDOG_SOURCES:
  | 'memory-recall-scale'
  // context-injection-audit-2026-07-28 P-014 (D-025): the desktop IPC bridge is
  // LISTENING but carrying nothing while clients reach this host over the HTTP
  // transport it exists to replace. The generalised "shipped but not engaged"
  // class — a mechanism installed, connected to nothing, every half individually
  // correct and unit-tested, with nothing comparing installed-ness to
  // utilisation. Judged on the LIFETIME accept count (a live gauge cannot answer
  // a question about history) AND on positive evidence that a client exists to
  // carry, so a box with no desktop running stays silent (endpoint-ipc/
  // engagement.ts). WORKSPACE-GLOBAL — process-local state, not harness-scoped:
  | 'endpoint-ipc-engagement'
  // the perf/reliability REGRESSION RIG (infra-perf-reliability-audit-round4 P-013 —
  // system-health/perf-regression-rig.ts; flag-gated on papercusp-perf-regression-rig,
  // DEFAULT ON). Snapshots four reliability SLO metrics (event-loop-lag p95, PG
  // connection saturation %, the dispatch-orphan rate that silently regressed to 91%,
  // the coord open-escalation backlog) to harness_shared.perf_regression_snapshots and
  // FILES on a budget breach so the round-2/3/4 perf gains can't silently regress:
  | 'perf-regression'
  // the routines ENGINE itself is dead — every active routine overdue at once
  // (the 06-12 DBOS incident class). Detected OUT-OF-BAND by lib/red-queen/
  // engine-death.ts (P-031 / FB-20) since the watchdog rides the engine it
  // would be watching:
  | 'routine-engine-death'
  // a STARTED+eligible plan with open plan-items but ZERO work-items — plan→work-item
  // promotion silently stopped producing placeable work (the recurrence guard for the
  // unified-work-item-ledger P-003 silent-zero class; detector zero-promotion-detect.ts,
  // gated by papercusp-plan-workitem-promotion so it is inert while promotion is dark):
  | 'zero-promotion'
  // a feature work-item marked DONE (terminal/passed) that still carries requires_test
  // VAL(s) with NO passing covering test — the "claimed done, no framework test"
  // recurrence (enforce-system-on-generic-work P-009; detector done-without-test-detect.ts).
  // Naturally inert where the inline-VAL flow is dark (no requires_test assertions ⇒
  // nothing to flag), so it needs no flag gate. Per-harness: count = flagged items:
  | 'done-without-test'
  // the DARK_FLAGS allowlist approaching its review-by date OR at/near its size
  // watermark — the operator-scoped recurrence guard so the dark set is re-reviewed
  // BEFORE the production-defaults CI guard goes red (enforce-system-on-generic-work
  // P-013; detector dark-flag-age-detect.ts). WORKSPACE-GLOBAL (one operator-scoped
  // finding, NOT in HARNESS_SCOPED_WATCHDOG_SOURCES); no flag gate (a healthy allowlist
  // emits nothing):
  | 'dark-flag-age'
  // EI-9136: the release pin sat deployable-but-not-live for 12h+ (owner-facing
  // rubrics UI invisible) and nobody was paged — release-deploy-staleness-watchdog.ts
  // (WI-1623) already computes this correctly but only console.warns + records a
  // separate ledger row, never reaching the improvement queue. This wires that
  // existing pure decider into a fleet-visible finding (detector
  // release-deploy-staleness-detect.ts). WORKSPACE-GLOBAL (one release pipeline, NOT
  // in HARNESS_SCOPED_WATCHDOG_SOURCES); no flag gate of its own (the underlying
  // sweep's PAPERCUSP_DEPLOY_STALENESS_THRESHOLD_SEC<=0 kill switch already makes
  // this inert when disabled):
  | 'release-deploy-staleness'
  // EI-18835078701597295: the CAUSE-side companion to 'release-deploy-staleness' above.
  // That one alarms on the downstream symptom (green pin deployable-but-not-live) at 3h;
  // this one counts CONSECUTIVE COALESCED deploy attempts, which is the same outage
  // visible on the second failed acquire. The dead-holder reclaim only fires for a holder
  // with a parseable, verifiably-gone host-local pid — a wedged-but-live holder, an owner
  // string with no pid, or a recycled pid all coalesce forever with nothing paging.
  // WORKSPACE-GLOBAL (one release pipeline, NOT in HARNESS_SCOPED_WATCHDOG_SOURCES); its
  // own PAPERCUSP_DEPLOY_COALESCE_STREAK_THRESHOLD<=0 kill switch makes it inert:
  | 'deploy-coalesce-stall'
  // EI-13022: a PROTECTIVE HOLD (pot pauseNewWork / kettle:pause) left standing
  // against a work-COMMANDING steering directive — the 2026-07-15 incident class:
  // the palette paused pot+kettle 6min after a kettle model-pin death, the pin was
  // already reconciled, nobody resumed, and the loop sat dark 31h with every
  // component "working as designed". A hold is a legit owner control, so this
  // NEVER auto-resumes — it pages, coalesced, once the hold is provably stale
  // (work-commanding directive + evidence of harm for >= minHoldHours):
  | 'stale-protective-hold'
  // EI-10869: an awaitable event key (harness_shared.event_awaits) whose live real-fire
  // rate is degenerate AND independently witnessed as a lost wake (the condition fired,
  // the wake didn't — EI-10800's class, detector lost-wake-detect.ts). WORKSPACE-GLOBAL
  // (the await log lives in one coord workspace, NOT per-harness); no flag gate (a healthy
  // await log emits nothing, and an unwitnessed suspect never pages — see the detector's
  // module doc for why the witness leg is required):
  | 'lost-wake'
  // EI-18787755090726525: the live DB carries a migration NEWER than anything this
  // running process's code tree ships — the opposite direction from `migration-drift`
  // (which fires when code is ahead of the DB). An index-SHAPE-changing migration
  // (e.g. mig 689 turning a unique index partial) applies to the shared DB the INSTANT
  // it runs, while the matching code lags behind git-sync → green-checkpoint → deploy
  // by minutes-to-hours; every process still running the stale code can fail on EVERY
  // write in the interim (facts:assert fleet-wide down ~25min, 2026-07-27) with an
  // error that names neither the table nor the cause. `checkMigrationDrift`'s existing
  // `schemaAhead` field already computes this (WI-5050); it was previously surfaced
  // ONLY as a boot-time console warning (db-boot-migrate.ts), which is silent for the
  // exact failure window — a process that does not reboot never re-checks. Wiring it
  // into the periodic (~15min) watchdog turns a ~25min silent fleet-wide outage into a
  // paged, tracked finding within one tick, on every table, not just agent_facts:
  | 'schema-ahead-of-code';

export interface WatchdogSignal {
  source: WatchdogSource;
  /** Stable per-signal identity within a tick (dedup key). */
  key: string;
  /** STABLE capture title — no counts/timestamps, so search-first dedup matches across ticks. */
  title: string;
  /** Detail: counts, samples, timestamps live here, not in the title. */
  body: string;
  severity: ImprovementSeverity;
  /**
   * Improvement kind to file this as (P-008 / D-009). Default 'bug'. A caller/DX
   * signal (a tool repeatedly rejecting caller input) files as 'change' — a
   * schema/gate refinement, not a papercusp bug.
   */
  kind?: ImprovementKind;
  /** Repo-relative paths involved, when the signal knows them (feeds the path gate). */
  paths?: string[];
  /**
   * Capture scope — 'operator' (default) or 'harness:<slug>' when the signal is
   * about one Hive. Passed through to the capture so the D-005 triage taxonomy
   * can key off it (consume-edges P-021).
   */
  scope?: string;
  /**
   * Newest evidence timestamp (ISO) backing this signal (watchdog-audit P-005 /
   * D-002). Windowed/aggregate collectors set it (red-test, tool-error,
   * failed-spawn, smoke-fail, expired-lease) so a RESOLVED duplicate re-files
   * only when the evidence post-dates the resolution. Live-state collectors
   * (service-down, migration-drift, …) omit it — their firing means the problem
   * exists NOW, so a re-file after resolve is always legitimate.
   */
  latestAt?: string;
  /**
   * OLDEST evidence timestamp (ISO) backing this signal, when the collector
   * knows the span (EI-10102: the red-test debounce needs BOTH ends of the
   * failure window, not just the newest, to ask "was the file being edited
   * anywhere across the whole run of failures"). Omitted by collectors that
   * never window a span.
   */
  earliestAt?: string;
  /**
   * (EI-19363804802198172) red-test only: the COMMIT dimension the wall-clock
   * window flattens. Carried on the signal (not just rendered into `body`) so the
   * debounce can ask the one question that decides whether the evidence is live:
   * has a DESCENDANT of every failing sha already passed this same test?
   */
  redTest?: {
    /** Distinct failing shas in the window, newest first. */
    failShas: string[];
    /**
     * (WI-39890) EVERY distinct passing sha in the window, newest first — not
     * just the newest one. Supersession is an ANCESTRY question, so the
     * candidate set has to be ancestry-COMPLETE: run shas are not monotonic in
     * time on this tree (concurrent runners, pinned/retreated checkouts), so the
     * newest pass BY WALL-CLOCK is routinely an ANCESTOR of a failing sha while
     * some older-by-clock pass is its DESCENDANT. Sampling a single candidate
     * re-imports the very wall-clock ordering `isSupersededByPassingDescendant`
     * exists to reject — see that function for the measured case.
     */
    passShas: string[];
    /**
     * Newest passing sha in the window, if any. RENDERING/CONTEXT ONLY — the
     * supersession DECISION reads `passShas`; deciding off this field is the
     * WI-39890 bug.
     */
    lastPassSha?: string;
    /** Newest passing run's timestamp (ISO), if any. */
    lastPassAt?: string;
    /**
     * (WI-10929) Did ONE sha both pass and fail in the window? If so the commit
     * does not determine this test's verdict, so the redness is not attributable
     * to code and bisecting it is wasted work. Computed by
     * `hasSameShaVerdictFlip` — see it for why this is kept rather than dropped.
     */
    sameShaFlip?: boolean;
  };
  /**
   * Resolution cooldown (ms). When set, a signal whose key matches only RESOLVED
   * dups is suppressed (→ `staleResolved`) if the newest resolution landed within
   * this window before the signal's `latestAt`. For collectors whose SCANNED tree
   * lags the source-of-truth tree by a deploy window — insight-staleness scans the
   * release/green checkout, behind staging — so a resolve-then-still-stale re-file
   * is a deploy-lag artifact, not a regression (EI-427). Omitted by every other
   * collector (a fast resolve→refail there IS a real regression worth re-filing).
   */
  resolutionCooldownMs?: number;
  /**
   * Learning-signal provenance (frontier P-002/D-002): organic (default) | drill
   * | replay | shadow. A drill harness's collectors tag their planted frictions
   * so the capture rides the drill lane end-to-end while staying out of organic
   * learners. Key-dup matching is origin-scoped: a drill signal never reads an
   * organic open item as its duplicate, and vice versa.
   */
  origin?: SignalOrigin;
  /**
   * Machine-readable finding class (frontier P-044/D-008): a stable
   * `<family>:<shape>` slug stamped into `payload.findingClass` so the
   * graduation tracker counts clean passes per class. Collectors should set
   * it; absent, graduation falls back to `<source>:unclassified`
   * (graduation/core.ts findingClassOf).
   */
  findingClass?: string;
}

/** `${source}:${key}` — the stable cross-tick identity of a signal (P-004 / D-001). */
export function watchdogKeyOf(s: Pick<WatchdogSignal, 'source' | 'key'>): string {
  return `${s.source}:${s.key}`;
}

/**
 * Per-collector outcome for one tick (watchdog-robustness P-001). Persisted in the
 * tick record so the watchdog can detect its OWN broken collector (P-002): an
 * element with `ok:false` is a collector that threw this tick.
 */
export interface CollectorStatus {
  name: string;
  ok: boolean;
  /** Signals the collector produced (0 when it failed). */
  signalCount: number;
  /** Error message when `ok:false`. */
  error?: string;
  /** Non-error note (e.g. a deliberate skip — `service-down` on a stale snapshot, P-004). */
  note?: string;
  /**
   * (WI-40769) FALSE ⇒ this tick produced NO TRUSTWORTHY OBSERVATION of the
   * collector's condition, so its silence must NOT be read as "the condition
   * cleared". Absent/true ⇒ the collector genuinely evaluated its predicate.
   *
   * This is the difference between the two ways a collector can emit zero
   * signals, which are otherwise INDISTINGUISHABLE in the tick record:
   *   - evaluated the predicate and found nothing wrong  → absence IS evidence
   *   - could not evaluate at all (skipped / probe threw) → absence is NOTHING
   *
   * Persisted inside the existing `watchdog_ticks.collectors` jsonb, so this
   * needs no migration. The auto-close sweep subtracts unobserved ticks from
   * its absence-evidence count (`recentRanTickKeys`), which is what lets a
   * source whose collector CAN go blind still be absence-closed safely: it
   * simply waits for enough ticks where the collector actually looked.
   */
  observed?: boolean;
  /**
   * (WI-40769) The watchdog SOURCE whose condition went unobserved. Required
   * whenever `observed:false`, because the sweep discounts absence evidence
   * PER SOURCE — a blind service-down tick must not also excuse migration-drift.
   * Declared by the collector rather than derived from its `name`, so the
   * mapping cannot drift as collectors are renamed.
   */
  unobservedSource?: WatchdogSource;
}

/**
 * A collector may return a bare signal array OR this richer shape to carry a
 * non-error `note` (watchdog-robustness P-004 — e.g. the service-down collector
 * skipping a stale service-health snapshot). `collectWatchdogSignalsDetailed`
 * normalizes both.
 */
export interface CollectorResult {
  signals: WatchdogSignal[];
  note?: string;
  /** (WI-40769) See `CollectorStatus.observed` — false ⇒ silence proves nothing. */
  observed?: boolean;
  /** (WI-40769) See `CollectorStatus.unobservedSource` — required when `observed:false`. */
  unobservedSource?: WatchdogSource;
}

/** One durable watchdog-tick record (watchdog-robustness P-001 / D-002). */
export interface WatchdogTickRecord {
  workspaceId: string;
  installSlug?: string | null;
  /** 'ran' = swept + captured; 'skipped' = another host held the cross-host lock (P-003). */
  status: 'ran' | 'skipped';
  signals: number;
  captured: string[];
  declinedDuplicates: number;
  deferred: number;
  /** `${source}:${key}` of each signal the anti-flood cap deferred this tick (P-009). */
  deferredKeys?: string[];
  /** Keys the P-004 pre-filter dropped as already-filed OPEN improvements (audit D-001). */
  knownOpenKeys?: string[];
  /** Keys dropped as resolved-with-stale-evidence — not regressions (audit P-005 / D-002). */
  staleResolvedKeys?: string[];
  /**
   * EVERY `${source}:${key}` observed this tick, whatever the partition decided
   * (watchdog-churn-delta-gate-2026-07-25 P-002). This is the ledger the NEXT tick's delta
   * gate diffs against — a key present here is, next tick, a standing condition rather than
   * a new detection. Recorded for all signals (not just filed ones) precisely because the
   * churn case is a signal whose item no longer exists.
   */
  seenKeys?: string[];
  /** Keys the P-003 delta gate suppressed as standing (already seen last tick). */
  standingKeys?: string[];
  collectors: CollectorStatus[];
  /** Improvement ids the watchdog filed ABOUT ITSELF this tick (P-002). */
  selfEscalations: string[];
}

const SEVERITY_RANK: Record<ImprovementSeverity, number> = { critical: 3, major: 2, minor: 1, nit: 0 };

export interface WatchdogPlanOptions {
  /** Max captures per tick (global anti-flood). Default 3. */
  maxPerTick?: number;
  /**
   * Max captures per SOURCE per tick (watchdog-robustness P-009 / D-010). Stops one
   * noisy source (a backlog of `major` red-tests) from monopolizing every slot and
   * starving tool-error / health / structural signals — the second half of why the
   * memory:search structural signal never landed even when it fired. Default 2.
   */
  perSourceCap?: number;
  /**
   * Keys (`${source}:${key}`) deferred on recent ticks (P-009 deferred-escalation).
   * A signal that keeps losing a slot is ranked one severity higher so a
   * persistent-but-minor signal eventually lands instead of ageing out forever.
   */
  priorDeferredKeys?: readonly string[];
}

export interface WatchdogPlan {
  toCapture: WatchdogSignal[];
  /** Signals dropped by the per-tick cap (still visible next tick if they persist). */
  deferred: WatchdogSignal[];
}

/**
 * Pure (close-loop D-003 + watchdog-robustness P-009 / D-010): dedupe, then admit
 * captures under TWO bounds so no single source starves the rest:
 *   1. PER-SOURCE cap (default 2) — a flood of `major` red-tests can take at most
 *      `perSourceCap` slots, leaving room for tool-error / health / structural signals.
 *   2. global `maxPerTick` cap (default 3) — the overall ceiling; any budget left
 *      after the per-source pass is filled from the leftover by rank (never wasted).
 * Deferred-escalation: a signal whose key was deferred on a recent tick
 * (`priorDeferredKeys`) ranks one severity higher, so a persistent-but-minor signal
 * climbs and eventually lands instead of being starved every tick.
 */
export function planWatchdogCaptures(signals: WatchdogSignal[], opts: WatchdogPlanOptions = {}): WatchdogPlan {
  const maxPerTick = Math.max(0, opts.maxPerTick ?? 3);
  const perSourceCap = Math.max(1, opts.perSourceCap ?? 2);
  const deferredSet = new Set(opts.priorDeferredKeys ?? []);

  // Dedupe by source:key.
  const seen = new Set<string>();
  const unique: WatchdogSignal[] = [];
  for (const s of signals) {
    const k = `${s.source}:${s.key}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(s);
  }

  // Effective rank = severity, +1 if this key was recently deferred (P-009 escalation).
  const rankOf = (s: WatchdogSignal): number =>
    SEVERITY_RANK[s.severity] + (deferredSet.has(`${s.source}:${s.key}`) ? 1 : 0);
  const byRankDesc = (a: WatchdogSignal, b: WatchdogSignal): number => {
    const d = rankOf(b) - rankOf(a);
    if (d !== 0) return d;
    // Tie → a recently-deferred signal goes first (it has waited longest).
    const ad = deferredSet.has(`${a.source}:${a.key}`) ? 1 : 0;
    const bd = deferredSet.has(`${b.source}:${b.key}`) ? 1 : 0;
    return bd - ad;
  };

  // Pass 1 — per-source cap (highest-ranked first; a noisy source can't take >cap).
  const perSourceCount = new Map<WatchdogSource, number>();
  const admitted: WatchdogSignal[] = [];
  const leftover: WatchdogSignal[] = [];
  for (const s of [...unique].sort(byRankDesc)) {
    const used = perSourceCount.get(s.source) ?? 0;
    if (used < perSourceCap && admitted.length < maxPerTick) {
      perSourceCount.set(s.source, used + 1);
      admitted.push(s);
    } else {
      leftover.push(s);
    }
  }
  // Pass 2 — fill any remaining global budget from leftover by rank (don't waste it).
  for (const s of leftover.sort(byRankDesc)) {
    if (admitted.length >= maxPerTick) break;
    admitted.push(s);
  }

  const admittedSet = new Set(admitted);
  const deferred = unique.filter((s) => !admittedSet.has(s));
  return { toCapture: admitted, deferred };
}

// ── P-004/P-005 key-based pre-filter (watchdog-audit-2026-06-09) ─────────────

/** An existing improvement matched by `payload.watchdogKey` (the dedup feed). */
export interface WatchdogKeyDup {
  watchdogKey: string;
  state: string;
  /** ISO `updated_at` — for a resolved item, the resolution recency bound (D-002). */
  updatedAt: string;
  /** The item's signal_origin (frontier P-002) — dup matching is origin-scoped.
   *  Absent = organic (legacy rows / pre-column readers). */
  signalOrigin?: string;
  /** Observation-lane tool-failure probation rows are corroboration candidates,
   * not already-filed work; the collector must be allowed to promote them. */
  probation?: boolean;
}

/** The pre-filter's split of collected signals (P-004 / D-001 + P-005 / D-002). */
export interface SignalPartition {
  /** No matching key on file → genuinely new, goes to planning. */
  fresh: WatchdogSignal[];
  /** Key matches an OPEN improvement → standing, already filed. Never consumes budget. */
  knownOpen: WatchdogSignal[];
  /**
   * Key matches only RESOLVED improvements AND the signal's newest evidence
   * pre-dates the resolution → stale lookback-window evidence, not a regression.
   */
  staleResolved: WatchdogSignal[];
  /**
   * DELTA GATE (watchdog-churn-delta-gate-2026-07-25 P-003 / D-001): the key was already
   * seen in the PREVIOUS `ran` tick, so this is a STANDING condition the watchdog just
   * detected — not a new detection. Suppressed instead of re-filed.
   *
   * This is the bucket that fixes the churn. `knownOpen` / `staleResolved` only catch a
   * signal while an item EXISTS for it: a live-state collector omits `latestAt`, so once a
   * separate subsystem retires the item (improvement-hygiene dup-close, watchdog-auto-close,
   * watchdog-green-resolve) the resolved-dup guard is skipped entirely and the signal falls
   * through to `fresh` and re-files — every 15 min, forever (60 copies of one stalled-claim
   * key in 7d). Diffing against the prior tick's `seenKeys` closes that hole without
   * depending on the item's lifecycle at all.
   */
  standing: WatchdogSignal[];
}

/**
 * Pure (P-004 / D-001 + P-005 / D-002): split collected signals against the
 * existing improvements that carry their `watchdogKey`:
 *   - an OPEN match → `knownOpen` (already filed; do not burn a capture slot);
 *   - only RESOLVED matches + `latestAt` <= the newest resolution `updatedAt`
 *     → `staleResolved` (pre-fix window evidence, not a regression);
 *   - only RESOLVED matches + the signal opted into `resolutionCooldownMs` and
 *     the newest resolution is within that window before `latestAt`
 *     → `staleResolved` (fix landed, still propagating — EI-427 deploy lag);
 *   - the key was seen in the PREVIOUS `ran` tick → `standing` (the delta gate,
 *     P-003 / D-001: a condition the watchdog just detected is not a NEW
 *     detection). Checked AFTER `knownOpen` so a filed item keeps feeding
 *     known-open aging, and before the resolution checks so it also covers the
 *     live-state hole those checks structurally miss;
 *   - otherwise → `fresh` (genuinely new, or a real regression with fresh
 *     evidence — including a live-state signal with no `latestAt`, whose firing
 *     means the problem exists NOW).
 * Unparseable timestamps fail open (fresh): a phantom re-file beats a
 * suppressed real regression. `priorSeenKeys` empty/omitted likewise fails open
 * (no prior tick, or pre-migration rows) → byte-identical to the old behaviour.
 */
export function partitionSignalsByKnownKeys(
  signals: WatchdogSignal[],
  dups: WatchdogKeyDup[],
  priorSeenKeys: readonly string[] = [],
  refileEligibleKeys: ReadonlySet<string> = EMPTY_REFILE_ELIGIBLE,
): SignalPartition {
  const seenLastTick = new Set(priorSeenKeys);
  const byKey = new Map<string, WatchdogKeyDup[]>();
  for (const d of dups) {
    const list = byKey.get(d.watchdogKey);
    if (list) list.push(d);
    else byKey.set(d.watchdogKey, [d]);
  }
  const out: SignalPartition = { fresh: [], knownOpen: [], staleResolved: [], standing: [] };
  for (const s of signals) {
    // Origin-scoped matching (frontier P-002/D-002): a dup only counts when its
    // signal_origin matches the signal's — an organic open item must not absorb
    // a drill signal (the drill would silently never file), nor a drill row an
    // organic signal (a synthetic row suppressing a real one).
    const matches = (byKey.get(watchdogKeyOf(s)) ?? []).filter(
      (m) => effectiveOrigin(m.signalOrigin) === effectiveOrigin(s.origin),
    );
    const openMatches = matches.filter((m) => m.state === 'open');
    if (openMatches.some((m) => !m.probation)) {
      out.knownOpen.push(s);
      continue;
    }
    if (openMatches.some((m) => m.probation)) {
      out.fresh.push(s);
      continue;
    }
    // DELTA GATE (P-003 / D-001): this exact key already fired on the previous ran tick, so
    // the condition is STANDING — the watchdog is re-detecting what it just detected, not
    // finding something new. Suppress. The churn this exists to stop happens when another
    // subsystem retired the item between ticks, which is the case the item-state checks
    // below cannot see.
    //
    // ⚠ KNOWN COST, measured and deliberately NOT fixed here (EI-20847917368795366):
    // because this gate has no time bound, a key that fires on EVERY tick is suppressed
    // FOREVER once nothing open matches it — it never reaches the resolution checks below,
    // so it can never re-file. Measured 2026-08-19: 11 keys standing with no item tracking
    // them, 8 on all 48 ticks of a 12h window, including `ship-link-stuck:staging->main`
    // (main WAS frozen at the time) and `routine-failure:routine:git-sync`. Two variants:
    // 7 retired-then-still-firing, and 4 NEVER FILED AT ALL (deferred by the per-tick
    // capture cap — seenKeys records deferred signals too, so they are seenLastTick on the
    // very next tick and suppressed before they could be filed once).
    //
    // ⛔ Do NOT "fix" this by time-bounding the suppression or by letting a no-match signal
    // through. That was tried and reverted: the churn incident this gate was built for had
    // NO dup row to match on (the item was retired by another subsystem as fast as it was
    // filed — see the delta-gate tests, which pin exactly that shape), so "file once, then
    // knownOpen catches it" does not hold and the 60-copies-of-one-key storm returns.
    // Any real fix must bound the RE-FILE RATE from watchdog-owned state (tick history),
    // not relax the gate — that keeps churn bounded AND stops the permanent blackout.
    if (seenLastTick.has(watchdogKeyOf(s))) {
      // RE-FILE RATE LIMIT (EI-20847917368795366). Suppression stays the DEFAULT — the
      // escape hatch opens only for a key `computeRefileEligibleKeys` has measured as
      // standing, unbroken, for >= WATCHDOG_REFILE_AFTER_MS of watchdog-owned tick history.
      // An eligible key falls through to the resolution checks below (NOT straight to
      // `fresh`), so `staleResolved` still applies and this can only ever ADD one filing.
      //
      // Why this bounds the churn instead of restoring it: letting the key through means it
      // is NOT in this tick's `standingKeys`, which BREAKS the consecutive run that made it
      // eligible. The run has to rebuild from zero, so the eligibility clock IS the rate
      // limit — max one filing per key per window, with no dependence on item rows (the
      // 60-copy incident proves another subsystem can retire those at will). An empty set
      // (no history, injected fakes, the 3-arg callers) is byte-identical to the old gate.
      if (!refileEligibleKeys.has(watchdogKeyOf(s))) {
        out.standing.push(s);
        continue;
      }
    }
    if (matches.length > 0 && s.latestAt) {
      const evidenceMs = Date.parse(s.latestAt);
      const newestResolutionMs = Math.max(...matches.map((m) => Date.parse(m.updatedAt)));
      if (Number.isFinite(evidenceMs) && Number.isFinite(newestResolutionMs)) {
        // (a) evidence pre-dates the resolution → stale lookback-window evidence.
        const evidencePreResolution = newestResolutionMs >= evidenceMs;
        // (b) resolution cooldown (EI-427): the fix resolved within the cooldown
        //     BEFORE this scan → suppress the re-file and let it propagate. Only
        //     for collectors that opt in via `resolutionCooldownMs` (the scanned
        //     tree lags the source-of-truth tree by a deploy window).
        const sinceResolutionMs = evidenceMs - newestResolutionMs;
        const withinCooldown =
          s.resolutionCooldownMs != null &&
          sinceResolutionMs >= 0 &&
          sinceResolutionMs <= s.resolutionCooldownMs;
        if (evidencePreResolution || withinCooldown) {
          out.staleResolved.push(s);
          continue;
        }
      }
    }
    out.fresh.push(s);
  }
  return out;
}

/** Shared empty set so the 3-arg gate callers allocate nothing (and cannot mutate a default). */
const EMPTY_REFILE_ELIGIBLE: ReadonlySet<string> = new Set<string>();

/**
 * How long a key must have been CONTINUOUSLY suppressed as `standing` before the delta
 * gate lets it re-file once (EI-20847917368795366).
 *
 * The two failure modes are OPPOSITE, so this number is the whole design: too large and a
 * real untracked condition stays invisible (measured blackout: 11 keys standing with no
 * item, 8 of them on all 48 ticks of a 12h window, including `ship-link-stuck:staging->main`
 * while main WAS frozen); too small and the gate stops bounding the churn it exists to stop
 * (60 copies of one key in 7d ≈ 8.6/day). 12h caps a pathological key at 2 filings/day —
 * ~4x below the incident rate — while guaranteeing no condition can hide for a whole day.
 *
 * Note this bound only ever applies when NOTHING open matches the key: an open item sends
 * the signal to `knownOpen` (untouched by this), where known-open aging escalates it.
 */
export const WATCHDOG_REFILE_AFTER_MS = 12 * 60 * 60 * 1000;

/** Cap on ran-ticks read for the re-file window — 240 covers 12h down to a 3-min cadence. */
export const WATCHDOG_REFILE_HISTORY_LIMIT = 240;

/**
 * Pure (EI-20847917368795366): which currently-standing keys have earned ONE re-file.
 *
 * A key qualifies when it is suppressed as `standing` on the newest ran tick AND has NOT
 * FILED on any consecutive ran tick back to one at least `refileAfterMs` old — where "has
 * not filed" means it appears in that tick's `standing_keys` OR its `deferred_keys`. That
 * consecutive run is the measure, and it is deliberately read from watchdog-owned tick
 * state no other subsystem can mutate, rather than from item rows, whose disappearance is
 * exactly what caused the churn incident the delta gate exists to stop.
 *
 * FAILS CLOSED everywhere (the inverse of the delta gate's fail-OPEN on empty history):
 * no ticks, no `standingKeys`, an unparseable `tickAt`, or a run that breaks all return
 * "not eligible" = keep suppressing = today's behaviour. A truncated read horizon can only
 * UNDER-estimate a run's age, so it too errs toward suppression. That asymmetry is what
 * lets this be added without weakening the gate: the escape hatch needs positive evidence,
 * and absence of evidence is never mistaken for it.
 */
export function computeRefileEligibleKeys(
  ticksNewestFirst: readonly RecentTick[],
  opts: { nowMs: number; refileAfterMs?: number },
): Set<string> {
  const eligible = new Set<string>();
  const refileAfterMs = opts.refileAfterMs ?? WATCHDOG_REFILE_AFTER_MS;
  if (!Number.isFinite(opts.nowMs) || !(refileAfterMs > 0)) return eligible;
  const newest = ticksNewestFirst[0];
  if (!newest) return eligible;

  // Only a key suppressed on the NEWEST tick can be standing right now; anything else
  // already broke its run and is not in a blackout.
  const candidates = newest.standingKeys ?? [];
  if (candidates.length === 0) return eligible;

  const standingSets = ticksNewestFirst.map((t) => new Set(t.standingKeys ?? []));
  // A DEFERRED tick CONTINUES the run: the measure is "has not FILED", not "was suppressed".
  // Without this, a release the per-tick capture cap swallowed (planCap defaults to 3, and
  // 6 keys were measured eligible at once on 2026-08-19) would break its own run and cost
  // the key another whole window without ever filing — which is precisely how the 4
  // never-filed keys went dark: deferred on their first tick, then suppressed forever.
  const deferredSets = ticksNewestFirst.map((t) => new Set(t.deferredKeys ?? []));
  const notFiledOn = (i: number, key: string): boolean => standingSets[i].has(key) || deferredSets[i].has(key);
  for (const key of new Set(candidates)) {
    let runStartMs: number | null = null;
    for (let i = 0; i < ticksNewestFirst.length; i += 1) {
      if (!notFiledOn(i, key)) break; // filed, or stopped firing → this episode ended
      const ms = Date.parse(ticksNewestFirst[i].tickAt ?? '');
      // An unusable stamp stops the walk and keeps the last good start — a SHORTER measured
      // run, i.e. conservative. If it is the newest tick, runStartMs stays null → skip.
      if (!Number.isFinite(ms)) break;
      runStartMs = ms;
    }
    if (runStartMs !== null && opts.nowMs - runStartMs >= refileAfterMs) eligible.add(key);
  }
  return eligible;
}

/**
 * Default key-dup reader: one indexed lookup over `payload.watchdogKey`
 * (engineer_issues_watchdog_key_idx). Injectable via `WatchdogDeps`.
 */
export async function readWatchdogKeyDups(keys: string[]): Promise<WatchdogKeyDup[]> {
  if (keys.length === 0) return [];
  const issues = await findIssuesByWatchdogKeys(keys);
  return issues.map((i) => ({
    watchdogKey: String((i.payload as Record<string, unknown> | null)?.watchdogKey ?? ''),
    state: i.state,
    updatedAt: i.updatedAt,
    signalOrigin: i.signalOrigin,
    probation:
      (i.payload as Record<string, unknown> | null)?.lane === 'observation' &&
      ((i.payload as Record<string, unknown> | null)?.toolFailureProbation as { state?: unknown } | undefined)?.state === 'probation',
  }));
}

// ── signal collectors (IO) ───────────────────────────────────────────────────

/**
 * Collector bars + windows for one tick. Extends the FB-21 learning-SLO
 * tunables (learning-slo.ts LEARNING_SLO_DEFAULTS) so the five SLO sensors
 * tune from the same routine payload as every other collector.
 */
export interface CollectOptions extends LearningSloOptions, EngagementCollectorOptions {
  /** Lookback for the red-test sweep. Default 6h. */
  redTestWindowHours?: number;
  /** Minimum fail count in the window (and the latest run must be a fail). Default 3. */
  redTestMinFails?: number;
  /** Lookback for the repeated-tool-error CLASS sweep (P-008 / D-009). Default 24h. */
  toolErrorWindowHours?: number;
  /** Structural tool-error fires at this many occurrences in the window. Default 2 (deterministic bugs recur identically — few = real). */
  structuralMinCount?: number;
  /** Structural tool-error: OR fire when error-rate ≥ this over ≥ structuralMinCallsForRate calls. Default 0.5. */
  structuralMinRate?: number;
  /** Min calls before the structural error-RATE test applies. Default 3. */
  structuralMinCallsForRate?: number;
  /** Transient tool-error (timeout/load) volume bar. Default 15 (raised — timeouts are noisy). */
  transientMinCount?: number;
  /**
   * Shared-resource timeout correlation window. A burst of transient failures from
   * several tools and coordination owners in this window is filed once as a
   * shared-resource incident instead of once per tool. Default 5 minutes.
   */
  sharedStallWindowMinutes?: number;
  /** Minimum distinct tools in a shared-resource timeout burst. Default 3. */
  sharedStallMinTools?: number;
  /** Minimum distinct coordination owners in a shared-resource timeout burst. Default 2. */
  sharedStallMinSessions?: number;
  /** Minimum timeout rows in a shared-resource burst. Default 3. */
  sharedStallMinFailures?: number;
  /**
   * Calls at or above this duration are candidates even when a transport records
   * them as a generic error rather than status='timeout'. Default 25 seconds.
   */
  sharedStallDurationMs?: number;
  /** Bound the raw candidate read used by shared-stall correlation. Default 2000. */
  sharedStallMaxRows?: number;
  /** Caller/DX tool-error (invalid_args / role-denied) sustained-pattern bar. Default 10. */
  callerMinCount?: number;
  /** Soft-failure outcome current consecutive-run bar. Default 10. */
  softFailureMinRun?: number;
  /** External-rate-limit tool-error (provider 429 / TPM) volume bar. Default 8 — sustained, not a one-off spike (P-002). */
  rateLimitMinCount?: number;
  /** External-rate-limit fires MAJOR (vs minor) at this many occurrences in the window. Default 30. */
  rateLimitMajorCount?: number;
  /** Max age of the service-health snapshot to trust for service-down (P-004). Default 2× the 60s probe interval. */
  serviceHealthMaxStaleMs?: number;
  /** smoke-fail recency gate (audit P-007): only a failure recorded within this many hours fires. Default 48. */
  smokeFailRecentHours?: number;
  /** expired-lease recency window (audit P-006): count only leases expired within this many days. Default 7. */
  expiredLeaseWindowDays?: number;
  /** expired-lease fire threshold. Default 15. */
  expiredLeaseMinCount?: number;
  /** expired-lease grace (EI-530): only count claims lapsed > this long, matching the
   *  reclaim sweep's grace — so a claim the sweep hasn't yet had a chance to reap
   *  isn't double-reported as abandoned. Default STALE_PLAN_CLAIM_GRACE_MS (10 min). */
  expiredLeaseGraceMs?: number;
  /** failed-spawn lookback window. Default 6h. */
  failedSpawnWindowHours?: number;
  /** failed-spawn fire threshold (total failures in the window). Default 5. */
  failedSpawnMinCount?: number;
  /** stalled-feature: a dispatchable feature untouched this long fires. Default 12h. */
  stalledFeatureHours?: number;
  /** orphaned-spawn: a running row this much past the reclaim threshold fires. Default 15min (3× RECLAIM_STALE_MS). */
  orphanedSpawnStaleMinutes?: number;
  /** stalled-claim: a work-item claim held by a LIVE holder with no item-scoped progress
   *  for this long fires (agent-activity-liveness-truth P-007). Default 30min — well past
   *  the 10-min view `stalled` threshold, so only genuinely-stuck (not just-crossed) claims
   *  raise the loud signal. */
  stalledClaimMinutes?: number;
  /** spawn-ceiling-jam: a running row older than this with NO recent stream output counts as a
   *  suspected stale debit (EI-2186). Gives the "for > N minutes" semantics. Default 15min. */
  ceilingJamMinAgeMinutes?: number;
  /** spawn-ceiling-jam: a running row whose last_output_at is within this window is treated as
   *  genuinely live (a dead process cannot advance stream output). Default 15min. */
  ceilingJamSilentMinutes?: number;
  /** spawn-ceiling-jam: tolerate up to this many old, non-streaming rows before firing — absorbs
   *  a couple of legitimately quiet bees. Default 2. */
  ceilingJamSlack?: number;
  /** escalation-spike lookback window. Default 6h. */
  escalationSpikeWindowHours?: number;
  /** escalation-spike fire threshold (escalations in the window). Default 3. */
  escalationSpikeMinCount?: number;
  /** dispatcher-staleness: hours the auto-implement dispatcher may go silent (while armed
   *  work waits) before the lane is flagged stalled (EI-2150). Default 6. */
  dispatcherStalenessThresholdHours?: number;
}

/**
 * Re-read file-backed red-test evidence immediately before the watchdog files it.
 * The initial collector read can go stale while the tick plans other signals, so
 * this seam lets the tick replace a signal with current evidence or suppress it
 * when the subject is green now.
 */
export type RedTestRedetect = (paths: string[], opts: CollectOptions) => Promise<WatchdogSignal[]>;

type Sql = ReturnType<typeof getOrgPg>['sql'];

/**
 * Pure: normalize a `test_runs.file_path` to its REPO-RELATIVE form so one broken
 * test has ONE identity. Runs from the green-checkpoint (or any sibling
 * `papercupai-workspace/<tree>/`) checkout record prefixed paths — the same test
 * the canonical tree records as `packages/...` — which used to file DUPLICATE
 * improvements (EI-36/EI-143, EI-157/EI-163). Returns null for paths to drop
 * entirely: synthetic fixture tests (`__synthetic__`) are loop probes, not bugs;
 * retired trees (`_retired/`) are preserved history, not active test suites.
 */
export function normalizeRedTestPath(filePath: string): string | null {
  const normalized = filePath.replace(/^.*papercupai-workspace\/[^/]+\//, '');
  if (normalized.includes('__synthetic__')) return null;
  if (normalized.startsWith('_retired/') || normalized.includes('/_retired/')) return null;
  return normalized;
}

interface RedTestRow {
  file_path: string;
  framework: string;
  fails: number;
  sample: string | null;
  latest_fail_at?: string | Date | null;
  /** Oldest fail in the window (EI-10102 debounce span). */
  earliest_fail_at?: string | Date | null;
  /**
   * (EI-19363804802198172) The `commit_sha` of every failing run in the window,
   * newest first. The window is a WALL-CLOCK slice of a shared tree that several
   * runners test CONCURRENTLY and OUT OF ORDER, so "5 failures" routinely means
   * "one sha failed 4× and another 1×" — often a sha that was already superseded
   * before the first of those runs. Collapsing that dimension is what makes the
   * signal read as one live recurring bug.
   */
  fail_shas?: (string | null)[] | null;
  /**
   * (WI-39890) The `commit_sha` of every PASSING run in the window, newest
   * first — the ancestry-complete candidate set for supersession. The same
   * out-of-order-runners property documented above for `fail_shas` applies to
   * passes, so the newest pass by wall-clock is NOT reliably the newest by
   * ancestry and cannot stand in for the set.
   */
  pass_shas?: (string | null)[] | null;
  /** Newest PASSING run's sha in the window, if any. Rendering/context only. */
  last_pass_sha?: string | null;
  /** Newest PASSING run's timestamp in the window, if any. */
  last_pass_at?: string | Date | null;
}

/** ISO-or-undefined from a pg timestamp value (Date under postgres.js, string in tests). */
function toIsoOrUndefined(v: string | Date | null | undefined): string | undefined {
  if (v == null) return undefined;
  if (v instanceof Date) return v.toISOString();
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/**
 * Pure: red-test aggregate rows → signals, keyed by the NORMALIZED repo-relative
 * path. Rows whose paths normalize to the same test (canonical + checkpoint tree)
 * merge into one signal (fail counts summed, newest failure timestamp kept)
 * instead of two captures.
 */
export function redTestSignalsFromRows(rows: RedTestRow[], windowHours: number): WatchdogSignal[] {
  const byPath = new Map<string, RedTestRow>();
  for (const r of rows) {
    const path = normalizeRedTestPath(r.file_path);
    if (path == null) continue;
    const prev = byPath.get(path);
    if (prev) {
      prev.fails += r.fails;
      if (!prev.sample) prev.sample = r.sample;
      const a = toIsoOrUndefined(prev.latest_fail_at);
      const b = toIsoOrUndefined(r.latest_fail_at);
      // Canonical and checkpoint rows represent the same test. Keep the tail
      // belonging to the newest failure across both rows; otherwise a stale
      // checkpoint tail can be filed as the current cause.
      if (b && (!a || b > a)) prev.sample = r.sample;
      prev.latest_fail_at = a && b ? (a >= b ? a : b) : (a ?? b ?? null);
      const ea = toIsoOrUndefined(prev.earliest_fail_at);
      const eb = toIsoOrUndefined(r.earliest_fail_at);
      prev.earliest_fail_at = ea && eb ? (ea <= eb ? ea : eb) : (ea ?? eb ?? null);
      // The commit dimension merges too: the canonical and checkpoint trees test
      // the same shas, so the union is what "which commits failed" means here.
      prev.fail_shas = [...(prev.fail_shas ?? []), ...(r.fail_shas ?? [])];
      // (WI-39890) The PASS set unions for the same reason: the canonical and
      // checkpoint trees test the same shas, and supersession needs every
      // candidate either tree saw green — dropping one tree's passes is exactly
      // how a passing descendant goes missing.
      prev.pass_shas = [...(prev.pass_shas ?? []), ...(r.pass_shas ?? [])];
      const pa = toIsoOrUndefined(prev.last_pass_at);
      const pb = toIsoOrUndefined(r.last_pass_at);
      if (pb && (!pa || pb > pa)) {
        prev.last_pass_at = pb;
        prev.last_pass_sha = r.last_pass_sha;
      } else {
        prev.last_pass_at = pa ?? pb ?? null;
      }
    } else {
      byPath.set(path, { ...r, file_path: path });
    }
  }
  return [...byPath.values()].map((r) => {
    const failShaCounts = countFailShas(r.fail_shas);
    const lastPassSha = r.last_pass_sha ?? undefined;
    const lastPassAt = toIsoOrUndefined(r.last_pass_at);
    const failShas = failShaCounts.map(([sha]) => sha);
    // (WI-39890) Distinct passing shas, newest first — the ancestry-complete
    // candidate set. `countFailShas` is a misnomer here but is exactly the
    // dedupe+order we want, and reusing it keeps ONE normalization for shas.
    //
    // `last_pass_sha` is UNIONED IN rather than trusted as the whole set: a
    // producer that has not populated `pass_shas` then degrades to exactly the
    // OLD single-candidate behaviour instead of silently yielding an EMPTY set,
    // which would disable supersession AND the same-sha flip together. That is
    // the fail-safe direction — the widened set can only ever suppress more
    // correctly and disattribute more flakes, never fewer. (Not hypothetical:
    // this change passed through precisely that state while the SQL projection
    // below was still unlanded, and it typechecked clean throughout.)
    const passShas = countFailShas([...(r.pass_shas ?? []), r.last_pass_sha ?? null]).map(
      ([sha]) => sha,
    );
    const sameShaFlip = hasSameShaVerdictFlip(failShas, passShas);
    const latestFailAt = toIsoOrUndefined(r.latest_fail_at);
    return {
      source: 'red-test' as const,
      key: r.file_path,
      title: `Test failing repeatedly: ${r.file_path}`,
      body:
        `Watchdog signal (red-test): ${r.file_path} (${r.framework}) failed ${r.fails}× in the last ` +
        `${windowHours}h and its latest run is still red.\n` +
        renderRedTestCommitContext(failShaCounts, lastPassSha, lastPassAt, sameShaFlip) +
        `\nFailure tail AS OF ${latestFailAt ?? 'the latest recorded failing run'} — the specific failing assertion may have changed; re-run this file before acting on the assertion below.\n` +
        `${(r.sample ?? '').slice(-1500) || '(no output captured)'}`,
      severity: 'major' as const,
      paths: [r.file_path],
      latestAt: latestFailAt,
      earliestAt: toIsoOrUndefined(r.earliest_fail_at),
      redTest: {
        failShas,
        passShas,
        ...(lastPassSha ? { lastPassSha } : {}),
        ...(lastPassAt ? { lastPassAt } : {}),
        ...(sameShaFlip ? { sameShaFlip } : {}),
      },
    };
  });
}

/**
 * Pure: failing shas → `[sha, count]` pairs, most failures first, nulls/blanks
 * dropped. Preserves first-seen order among equal counts (rows arrive newest
 * first), so the head of the list is the most recent heaviest offender.
 */
function countFailShas(shas: (string | null)[] | null | undefined): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const s of shas ?? []) {
    const sha = (s ?? '').trim();
    if (!sha) continue;
    counts.set(sha, (counts.get(sha) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/**
 * (WI-10929) Pure: did ONE sha both PASS and FAIL inside the window?
 *
 * This is the strongest disattribution signal the aggregate carries, and it is
 * decidable from data the collector already fetched — no git, no fs, unlike
 * every other debounce leg. If the same commit produced both verdicts then the
 * commit does not determine the verdict, so the redness is caused by something
 * OUTSIDE the sha: on this tree, overwhelmingly a test that reads the WORKING
 * TREE (git-sync commits on a schedule, so tree ≠ HEAD is the normal state, and
 * a peer's uncommitted edit flips such a test at an unchanged HEAD), otherwise a
 * genuine flake (ordering, timing, shared state).
 *
 * It deliberately does NOT suppress the signal — non-determinism is real and
 * worth filing (see `isSupersededByPassingDescendant`). It changes what the
 * filing SAYS, so a triager stops bisecting a sha that cannot be the cause.
 *
 * ONE home for the fact: both the renderer and the supersession check call this
 * rather than re-deriving the intersection locally.
 *
 * (WI-39890) Takes the whole PASS SET, not one sha. A flip is a property of the
 * window, so asking it about only the newest-by-wall-clock pass under-reports:
 * a sha that failed AND passed earlier in the window is just as unattributable,
 * and missing it would let the supersession check below suppress a genuinely
 * non-deterministic test. Widening it can only ever KEEP more signals.
 */
export function hasSameShaVerdictFlip(
  failShas: readonly string[],
  passShas: readonly string[] | string | undefined,
): boolean {
  if (!passShas) return false;
  const passes = typeof passShas === 'string' ? [passShas] : passShas;
  return failShas.some((sha) => passes.includes(sha));
}

/**
 * Pure: the two lines that turn "failed 5× in 6h" from a claim about TIME into a
 * claim about CODE. Both are single-column reads the aggregate already has; both
 * were absent, and their absence cost real investigation time twice in one day
 * (EI-19362285834938726 / EI-19365113150061623 — see this ticket).
 *
 * Rendered as `''` when the aggregate carried no sha data (a framework that
 * doesn't record `commit_sha`, or older rows), so the body degrades to exactly
 * its previous form rather than growing empty scaffolding.
 *
 * (WI-10929) When ONE sha both passed and failed, the ancestry advice below is
 * not merely unhelpful but MISDIRECTING — it asks the reader to compare the pass
 * sha against the fail shas when the answer is "they are the same sha", which
 * reads as inconclusive rather than as the decisive fact it is. That case gets
 * its own line instead.
 */
function renderRedTestCommitContext(
  failShaCounts: Array<[string, number]>,
  lastPassSha: string | undefined,
  lastPassAt: string | undefined,
  sameShaFlip: boolean,
): string {
  const lines: string[] = [];
  if (failShaCounts.length > 0) {
    const rendered = failShaCounts.map(([sha, n]) => `${sha.slice(0, 10)} ×${n}`).join(', ');
    lines.push(
      failShaCounts.length === 1
        ? `Failures all on ONE commit: ${rendered}`
        : `Failures span ${failShaCounts.length} commits: ${rendered}` +
          ` — these may be DIFFERENT causes, or runs against an already-superseded tree.`,
    );
  }
  if (sameShaFlip && lastPassSha) {
    lines.push(
      `Last PASS in window: ${lastPassAt ?? 'unknown time'} (${lastPassSha.slice(0, 10)})` +
        ` — SAME SHA as a failing run.`,
      `⚠ SAME-SHA VERDICT FLIP: ${lastPassSha.slice(0, 10)} both PASSED and FAILED here, so this commit` +
        ` does NOT determine the verdict and the redness is not attributable to code at that sha.` +
        ` DO NOT BISECT. Triage the two causes that survive: (1) the test reads state outside the` +
        ` commit — most often the WORKING TREE (a readdir/glob/file-scan census), which flips on a` +
        ` peer's uncommitted edit at an unchanged HEAD because git-sync commits on a schedule; or` +
        ` (2) a genuine flake (ordering, timing, shared fixture state). Re-run it at HEAD first:` +
        ` a pass there tells you which, and costs seconds.`,
    );
  } else {
    lines.push(
      lastPassSha || lastPassAt
        ? `Last PASS in window: ${lastPassAt ?? 'unknown time'}` +
          `${lastPassSha ? ` (${lastPassSha.slice(0, 10)})` : ''}` +
          ` — check it against the failing shas before bisecting; a pass on a DESCENDANT sha means the failures judged superseded code.`
        : `Last PASS in window: none — this test has not passed once in the window.`,
    );
  }
  return `\n${lines.join('\n')}\n`;
}

/**
 * (EI-10102) Callback shape for "did this path have a git commit in [sinceIso,
 * untilIso]?" — dependency-injected so the debounce DECISION logic below is
 * unit-testable without a real git checkout. `wasFilePathCommittedInRange` is
 * the real IO implementation wired in by `collectRedTestSignals`.
 */
export type GitEditCheck = (filePath: string, sinceIso: string, untilIso: string) => Promise<boolean>;

/**
 * EI-18145972782668210: esbuild/transform-class failure signatures — the
 * hallmark of vitest/tsx catching a file mid-WRITE by a concurrent
 * (UNCOMMITTED) peer edit on this heavily-parallel shared tree, as opposed to
 * a genuine assertion failure. Confirmed live: re-reading
 * `outbox-drain.ts` moments apart during triage showed a backtick pair
 * appear-then-vanish inside a SQL template literal (a torn read of a peer's
 * in-flight, uncommitted write) — the matching failure class ("Transform
 * failed with N error", esbuild's "Expected \")\" but found …") is exactly
 * what a transform step reports when it parses a file mid-write. Deliberately
 * narrow (transform/parse-time signatures only, NOT e.g. "Cannot find
 * module" — a missing import is very often a REAL break, not a torn read) so
 * this only fires on the class of failure a torn read actually produces.
 */
export const TRANSFORM_FAILURE_RE =
  /Transform failed with \d+ error|SyntaxError: |Unexpected token|Expected ".*?" but found|Unterminated string|Unterminated template/i;

/** Pure: does this failure's output read like a transform/parse-time crash
 *  (as opposed to a real assertion failure)? */
export function isLikelyTransientTransformFailure(outputTail: string | null | undefined): boolean {
  return TRANSFORM_FAILURE_RE.test(outputTail ?? '');
}

/** Callback shape for "does `filePath` parse/transform cleanly RIGHT NOW?" —
 *  dependency-injected so the debounce DECISION logic stays unit-testable
 *  without touching the real filesystem/esbuild. `doesFileCurrentlyParseCleanly`
 *  below is the real IO implementation wired in by `collectRedTestSignals`. */
export type FileParsesCleanlyCheck = (filePath: string) => Promise<boolean>;

/**
 * Pure-ish (the two IO side-effects — git + optionally a live re-parse — are
 * fully behind the injected callbacks):
 *
 *   1. A file that failed repeatedly WHILE ALSO being actively git-committed
 *      across that same span is far more likely a concurrent-refactor
 *      artifact (the test harness catching the file mid-edit —
 *      transform/resolve failures) than a real regression (EI-10102 /
 *      EI-10065).
 *   2. (EI-18145972782668210) An in-flight, still-UNCOMMITTED edit produces
 *      NO commit in range at all (git-sync commits on a schedule, not per
 *      keystroke), so check #1 alone misses it. When the failure itself
 *      LOOKS like a transform/parse crash (`isLikelyTransientTransformFailure`)
 *      and an (optional) live re-parse of the file's CURRENT on-disk content
 *      succeeds, the earlier failure was near-certainly a torn read of a
 *      peer's in-flight write, not a regression — debounce it too.
 *   3. A file that does not exist on disk RIGHT NOW, and was never a git
 *      commit either — a scratch/transient test file (e.g. an ad-hoc probe
 *      run locally to check a hypothesis) that failed repeatedly, then was
 *      deleted before the next git-sync sweep ever captured it. Check #1
 *      correctly reports "no commit in range" here (there is no commit,
 *      ever), so it does NOT debounce this case, and the failure is rarely a
 *      transform/parse crash so check #2 doesn't apply either — without this
 *      third check the signal survives forever as an unfixable bug ticket
 *      (there is no file left to fix). Unlike #2, this applies to EVERY
 *      failure kind, not just transform-class ones — a missing file makes
 *      any failure equally moot.
 *
 * Either way, debounce = drop the signal entirely for this tick; a genuine
 * regression keeps failing in a LATER tick once the file has settled, so this
 * only delays, never permanently suppresses, a real red test.
 *
 * Fails OPEN throughout: any signal missing a path/earliestAt/latestAt (a
 * collector that doesn't window a span), a `checkEdited`/`checkExists` that
 * throws, a failure that doesn't read as a transform crash, no
 * `checkParsesCleanly`/`checkExists` wired, or a `checkParsesCleanly` that
 * throws/returns false, is all KEPT — neither a git hiccup, a filesystem
 * hiccup, nor a re-parse hiccup may silently swallow a real signal.
 */
export async function debounceRedTestSignals(
  signals: WatchdogSignal[],
  checkEdited: GitEditCheck,
  bufferMs = 10 * 60 * 1000,
  checkParsesCleanly?: FileParsesCleanlyCheck,
  checkExists?: FileExistsCheck,
  checkAncestry?: GitAncestryCheck,
): Promise<WatchdogSignal[]> {
  const kept: WatchdogSignal[] = [];
  for (const s of signals) {
    const path = s.paths?.[0];
    if (s.source !== 'red-test' || !path || !s.earliestAt || !s.latestAt) {
      kept.push(s);
      continue;
    }
    // (EI-19363804802198172) Every failing sha already superseded by a sha that
    // PASSED this test → the evidence describes code that no longer exists and
    // has been proven green since. Checked FIRST: it is the cheapest way to be
    // certain the signal is moot, and unlike the checks below it does not depend
    // on the file's current on-disk state at all.
    if (checkAncestry && (await isSupersededByPassingDescendant(s, checkAncestry))) continue;
    if (checkExists) {
      let exists = true;
      try {
        exists = await checkExists(path);
      } catch {
        exists = true; // fail open — never suppress a real signal on an unverifiable check
      }
      if (!exists) continue;
    }
    const since = new Date(new Date(s.earliestAt).getTime() - bufferMs).toISOString();
    const until = new Date(new Date(s.latestAt).getTime() + bufferMs).toISOString();
    let edited = false;
    try {
      edited = await checkEdited(path, since, until);
    } catch {
      edited = false; // fail open — never let a git error silently eat a real signal
    }
    if (edited) continue;
    if (checkParsesCleanly && isLikelyTransientTransformFailure(s.body)) {
      let parsesCleanly = false;
      try {
        parsesCleanly = await checkParsesCleanly(path);
      } catch {
        parsesCleanly = false; // fail open — an unverifiable re-parse never eats a real signal
      }
      if (parsesCleanly) continue;
    }
    kept.push(s);
  }
  return kept;
}

let cachedRedTestRepoRoot: string | null = null;

/** `git rev-parse --show-toplevel`, memoized (same pattern as agent-tools/plans/git-history.ts). */
function resolveRedTestRepoRoot(): string {
  if (cachedRedTestRepoRoot) return cachedRedTestRepoRoot;
  try {
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 5000,
    }).trim();
    cachedRedTestRepoRoot = top || process.cwd();
  } catch {
    cachedRedTestRepoRoot = process.cwd();
  }
  return cachedRedTestRepoRoot;
}

// Lazily promisified (NOT `const execFileP = promisify(execFile)` at module scope): this
// module sits behind a long, easy-to-hit transitive import chain (e.g.
// release-actions.test.ts → blueprint-run-action → blueprint-steps/index →
// ops/red-queen-drill → red-queen/run → red-queen/sandbox → here) reached by test files
// that narrowly mock `node:child_process` with only `{ spawn }` for their OWN subprocess
// assertions — under that mock the `execFile` import binding resolves to `undefined`, and
// eagerly calling `promisify(undefined)` at module-eval time threw
// "No 'execFile' export is defined on the 'node:child_process' mock" for every such
// suite, even ones that never call `wasFilePathCommittedInRange`. Deferring the promisify
// to first actual call (memoized, same pattern as `resolveRedTestRepoRoot` above) means a
// transitive importer that never exercises this function never pays the cost — only a
// suite that ACTUALLY calls it needs to mock `execFile` too.
type ExecFileP = (
  file: string,
  args: string[],
  opts: Record<string, unknown>,
) => Promise<{ stdout: string; stderr: string }>;
let cachedExecFileP: ExecFileP | null = null;
function execFileP(file: string, args: string[], opts: Record<string, unknown>): Promise<{ stdout: string; stderr: string }> {
  if (!cachedExecFileP) cachedExecFileP = promisify(execFile) as unknown as ExecFileP;
  return cachedExecFileP(file, args, opts);
}

/**
 * Real IO `GitEditCheck`: does `filePath` have ≥1 commit whose author date
 * falls in [sinceIso, untilIso]? Shell-less (execFile); a git failure (not a
 * repo, path never committed, git missing) resolves to `false` (no debounce)
 * rather than throwing, so a git hiccup degrades to today's behavior.
 */
export async function wasFilePathCommittedInRange(
  filePath: string,
  sinceIso: string,
  untilIso: string,
): Promise<boolean> {
  const repoRoot = resolveRedTestRepoRoot();
  try {
    const { stdout } = await execFileP(
      'git',
      ['log', `--since=${sinceIso}`, `--until=${untilIso}`, '--pretty=format:%H', '--', filePath],
      { cwd: repoRoot, timeout: 5000, maxBuffer: 64 * 1024 },
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * (EI-18145972782668210) Real IO `FileParsesCleanlyCheck`: does `filePath`
 * parse/transform cleanly RIGHT NOW? Uses esbuild's `transform` — the same
 * transform engine vitest/tsx run under the hood — against the file's CURRENT
 * on-disk content: a fast syntax-level check, no type-check, no module
 * resolution. Any failure (file missing, a genuine syntax error still present,
 * esbuild unavailable) resolves to `false`. Note this function fails CLOSED on
 * purpose (unlike the debounce call site around it, which fails OPEN): a
 * `false` here just means "don't debounce this signal", never "suppress a
 * real one" — the caller only ever uses `true` to drop a signal.
 */
export async function doesFileCurrentlyParseCleanly(filePath: string): Promise<boolean> {
  try {
    const repoRoot = resolveRedTestRepoRoot();
    const abs = pathIsAbsolute(filePath) ? filePath : pathJoin(repoRoot, filePath);
    const source = await readFile(abs, 'utf8');
    const { transform } = await import('esbuild');
    const loader = /\.tsx$/.test(filePath)
      ? 'tsx'
      : /\.ts$/.test(filePath)
        ? 'ts'
        : /\.jsx$/.test(filePath)
          ? 'jsx'
          : 'js';
    await transform(source, { loader, sourcefile: filePath });
    return true;
  } catch {
    return false;
  }
}

/** Callback shape for "does `filePath` exist on disk RIGHT NOW?" — dependency-injected
 *  so the debounce decision stays unit-testable without touching the real filesystem.
 *  `doesFileExistOnDisk` below is the real IO implementation wired in by
 *  `collectRedTestSignals`. */
export type FileExistsCheck = (filePath: string) => Promise<boolean>;

/**
 * (EI-19363804802198172) Callback shape for "is `ancestorSha` an ancestor of
 * `descendantSha`?" — dependency-injected so the supersession DECISION stays
 * unit-testable without a real git history. `isShaAncestorOf` is the real IO
 * implementation wired in by `collectRedTestSignals`.
 */
export type GitAncestryCheck = (ancestorSha: string, descendantSha: string) => Promise<boolean>;

/**
 * Real IO `GitAncestryCheck`: `git merge-base --is-ancestor a b` — exit 0 means
 * a is an ancestor of b. Any other exit (not an ancestor, unknown sha, shallow
 * clone, git missing) resolves to `false`, i.e. "cannot show supersession", so a
 * git hiccup can never suppress a real signal.
 */
export async function isShaAncestorOf(ancestorSha: string, descendantSha: string): Promise<boolean> {
  if (!ancestorSha || !descendantSha) return false;
  if (ancestorSha === descendantSha) return false; // a sha does not supersede itself
  const repoRoot = resolveRedTestRepoRoot();
  try {
    await execFileP('git', ['merge-base', '--is-ancestor', ancestorSha, descendantSha], {
      cwd: repoRoot,
      timeout: 5000,
      maxBuffer: 16 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pure-ish decision (the git call is behind the injected `checkAncestry`): are
 * ALL of this signal's failing shas ancestors of a sha that has since PASSED the
 * same test? If so the failures judged code that has been superseded AND proven
 * green, and the signal is a false positive by construction.
 *
 * Why ancestry and not timestamps: several runners test this shared tree
 * CONCURRENTLY and OUT OF ORDER, so a fail can land at 18:00 for a sha that was
 * already superseded by a sha which passed at 17:51. Ordering the runs by
 * wall-clock makes that look like "still red, and flaky"; ordering them by
 * ancestry shows it is neither. The live case behind this ticket had exactly
 * that shape, which is why the simpler "is the last PASS newer than the last
 * FAIL" rule would NOT have caught it.
 *
 * (WI-39890) And for the same reason the CANDIDATE SET must be every passing
 * sha in the window, not the newest one. This function used to test against
 * `lastPassSha` alone — a sha selected by newest WALL-CLOCK, i.e. by the exact
 * ordering the paragraph above rejects — so a window that contained a passing
 * descendant still filed. Measured 2026-08-19: fail sha df89e330a7 vs a chosen
 * `lastPassSha` of 7481dd033e that was committed three days EARLIER and is an
 * ANCESTOR of it, while 6 of the 8 other passes in the window were descendants
 * — one of which had passed this same test 37 minutes BEFORE the first failure.
 * Three `major` items were filed for a test that had been green for 13h.
 *
 * Fails CLOSED on suppression (= keeps the signal) throughout: no pass shas, no
 * fail shas, an unknown sha, or a throwing check all mean "cannot show
 * supersession", and a signal is only ever dropped when EVERY failing sha is an
 * ancestor of SOME passing sha.
 */
export async function isSupersededByPassingDescendant(
  signal: WatchdogSignal,
  checkAncestry: GitAncestryCheck,
): Promise<boolean> {
  const meta = signal.redTest;
  // (WI-39890) The candidate set is EVERY pass in the window. `lastPassSha` is
  // deliberately not consulted here: it is a wall-clock pick, and a wall-clock
  // pick is what this predicate exists to avoid depending on.
  const passShas = meta?.passShas ?? [];
  if (!meta || passShas.length === 0 || meta.failShas.length === 0) return false;
  // A pass on a sha that itself failed is not supersession — it is flakiness on
  // one commit, which is a real signal and must survive. (WI-10929: the SAME
  // predicate, via the shared helper so the fact has one home — the body's
  // SAME-SHA VERDICT FLIP line is rendered off it too, instead of this branch
  // silently discarding the strongest disattribution evidence in the row.)
  if (hasSameShaVerdictFlip(meta.failShas, passShas)) return false;
  for (const failSha of meta.failShas) {
    let superseded = false;
    for (const passSha of passShas) {
      try {
        if (await checkAncestry(failSha, passSha)) {
          superseded = true;
          break;
        }
      } catch {
        // fail open — a git error on ONE candidate never suppresses a real
        // signal, and never disqualifies the remaining candidates either.
      }
    }
    if (!superseded) return false;
  }
  return true;
}

/**
 * Real IO `FileExistsCheck`: does `filePath` exist on disk right now (resolved against
 * the repo root, same as `doesFileCurrentlyParseCleanly`)? A synchronous check is fine
 * here — no size/content is read, just a stat.
 */
export async function doesFileExistOnDisk(filePath: string): Promise<boolean> {
  const repoRoot = resolveRedTestRepoRoot();
  const abs = pathIsAbsolute(filePath) ? filePath : pathJoin(repoRoot, filePath);
  return existsSync(abs);
}

/**
 * The raw `test_runs` aggregate fetch behind `collectRedTestSignals`, split out
 * (EI-18767688096795873) so the SQL — in particular the `is_scratch_config`
 * exclusion — is integration-testable against a real Postgres WITHOUT also
 * exercising the git-commit / disk-exists debounce IO that follows it (those are
 * already covered by `debounceRedTestSignals`'s own unit tests with injected fakes).
 */
export async function fetchRedTestRows(
  sql: Sql,
  opts: CollectOptions = {},
  paths?: readonly string[],
): Promise<RedTestRow[]> {
  const windowHours = opts.redTestWindowHours ?? 6;
  const minFails = opts.redTestMinFails ?? 3;
  const normalizedPaths = paths === undefined
    ? []
    : [...new Set(paths.map(normalizeRedTestPath).filter((p): p is string => p != null))];
  const pathFilter = paths === undefined
    ? sql`TRUE`
    : normalizedPaths.length === 0
      ? sql`FALSE`
      : sql`regexp_replace(file_path, '^.*papercupai-workspace/[^/]+/', '') = ANY(${normalizedPaths})`;
  return sql<RedTestRow[]>`
    WITH recent AS (
      SELECT file_path, framework, status, output_tail, started_at, commit_sha,
             row_number() OVER (PARTITION BY file_path ORDER BY started_at DESC) AS rn
        FROM harness_shared.test_runs
       WHERE started_at > now() - make_interval(hours => ${windowHours})
         AND status IN ('pass', 'fail', 'error')
         AND source <> 'mutation-probe'
         -- Only plausible repo paths: the test-runner's own test suites record
         -- synthetic fixture rows ('b', 'fail', 'no-such-bin') into test_runs;
         -- a real run always carries a repo-relative path with a separator.
         AND file_path LIKE '%/%'
         AND ${pathFilter}
         -- EI-18767688096795873: a run whose vitest config resolved OUTSIDE the repo
         -- tree (a throwaway/mutation-testing config synthesized under /tmp, aliasing
         -- in a deliberately-broken module and asserting the suite goes red) is not a
         -- real regression signal — exclude it from BOTH the fail count and the
         -- "latest run" freshness check (rn=1) below, since the mutant run's file path
         -- is identical to the real test's and would otherwise mask which run is
         -- actually the newest genuine one.
         AND is_scratch_config = false
         -- EI-20770395938680312: a run that died on the RUNNER'S OWN vite-node
         -- transform cache under /tmp never executed the test at all — that is an
         -- infra fault, not a code signal. When one such cache dir is wiped
         -- mid-run every subsequent file instantly zero-duration-"fails" with an
         -- identical tail: on 2026-08-18 that poisoned 9,246 rows across 4,963
         -- files in a single 45-minute run and manufactured four bogus
         -- "Test failing repeatedly" majors against files that were green both
         -- before and after. Excluded from BOTH the fail count and the "latest
         -- run" freshness check (rn=1) for the same reason as scratch-config
         -- above: the poisoned row shares the real test's path, so leaving it in
         -- would mask which run is actually the newest genuine one.
         --
         -- BOTH conjuncts are load-bearing, and each is measured over 30d of
         -- test_runs — do not simplify this to either half alone:
         --   * duration_ms = 0 alone would also swallow 648 real rows across 440
         --     files whose tail is an ordinary env break ('afterAll is not defined');
         --   * the ENOENT tail alone would suppress 3 real assertion failures
         --     across 2 files whose output merely quotes that string.
         AND NOT (
           status IN ('fail', 'error')
           AND duration_ms = 0
           AND output_tail LIKE '%ENOENT: no such file or directory, open ''/tmp/%'
         )
    )
    SELECT file_path,
           max(framework) AS framework,
           count(*) FILTER (WHERE status IN ('fail', 'error'))::int AS fails,
           -- The tail must follow the newest failure, not lexical MAX(output_tail).
           -- A failing file can carry unrelated tails across a mid-edit window.
           (array_agg(output_tail ORDER BY started_at DESC)
             FILTER (WHERE status IN ('fail', 'error')))[1] AS sample,
           max(started_at) FILTER (WHERE status IN ('fail', 'error')) AS latest_fail_at,
           min(started_at) FILTER (WHERE status IN ('fail', 'error')) AS earliest_fail_at,
           -- (EI-19363804802198172) The COMMIT dimension. 'fail_shas' keeps one entry
           -- per failing RUN (not per distinct sha) so the per-sha counts are
           -- recoverable.
           --
           -- (WI-39890) 'pass_shas' is the WHOLE green set, and it is what decides
           -- whether those failures are still live evidence. This used to project
           -- only [1] -- the newest pass BY WALL-CLOCK -- and discard the rest of
           -- the array. Run shas are not monotonic in time here, so that single
           -- candidate is routinely an ANCESTOR of a failing sha while an
           -- older-by-clock pass is its DESCENDANT, and the supersession check
           -- then misses a real supersession. 'last_pass_*' is RENDERING ONLY.
           array_agg(commit_sha ORDER BY started_at DESC)
             FILTER (WHERE status IN ('fail', 'error')) AS fail_shas,
           array_agg(commit_sha ORDER BY started_at DESC)
             FILTER (WHERE status = 'pass') AS pass_shas,
           (array_agg(commit_sha ORDER BY started_at DESC)
             FILTER (WHERE status = 'pass'))[1] AS last_pass_sha,
           max(started_at) FILTER (WHERE status = 'pass') AS last_pass_at
      FROM recent
     GROUP BY file_path
    HAVING count(*) FILTER (WHERE status IN ('fail', 'error')) >= ${minFails}
       AND max(CASE WHEN rn = 1 THEN status END) IN ('fail', 'error')
     LIMIT 20`;
}

/**
 * red-test: a test file that failed ≥ N times in the window AND whose LATEST run
 * in the window is still a fail — i.e. repeatedly red and currently red, not a
 * one-off dev iteration. Carries the file path (→ the protected-path gate).
 *
 * Workspace scoping (audit P-013): `test_runs` has NO workspace column, so this
 * collector is inherently BOX-GLOBAL — every workspace's tick sees the same
 * red tests. Acceptable on a one-box install; on a multi-workspace host the
 * cross-host tick lock + key dedup keep it to one filed item regardless.
 */
export async function collectRedTestSignals(
  sql: Sql,
  opts: CollectOptions = {},
  paths?: readonly string[],
): Promise<WatchdogSignal[]> {
  const windowHours = opts.redTestWindowHours ?? 6;
  const rows = await fetchRedTestRows(sql, opts, paths);
  const signals = redTestSignalsFromRows(rows, windowHours);
  // EI-10102: drop signals for files that were being actively git-committed
  // across their own failure window — a mid-refactor artifact, not a real
  // regression. A genuine break re-fires next tick once the file settles.
  // EI-18145972782668210: ALSO drop a transform/parse-class failure when the
  // file parses cleanly right now — catches the UNCOMMITTED-edit case the
  // git check above can't see (git-sync commits on a schedule, not per write).
  // (this ticket): ALSO drop any signal whose file no longer exists on disk —
  // catches a scratch/transient test file that failed repeatedly and was
  // deleted before ever being committed (neither debounce above can see it:
  // there's no commit to find, and it's rarely a transform-class failure).
  // (EI-19363804802198172): ALSO drop any signal whose failing shas have ALL been
  // superseded by a sha that has since PASSED this test — concurrent runners test
  // this shared tree out of order, so a "latest run is still red" can be a run
  // against a commit that was already fixed and proven green.
  return debounceRedTestSignals(
    signals,
    wasFilePathCommittedInRange,
    undefined,
    doesFileCurrentlyParseCleanly,
    doesFileExistOnDisk,
    isShaAncestorOf,
  );
}

interface SmokeFailRow { harness_slug: string; failure_content: string | null; mtime_ms: number | string | null }

/**
 * Pure (audit P-007): smoke-fail rows → signals, RECENCY-GATED via `mtime_ms`
 * (the table has no timestamp column). Only a failure recorded within
 * `smokeFailRecentHours` (default 48h) fires — a never-re-run failing smoke from
 * weeks ago must not re-file forever. A row with NO mtime is treated as stale
 * (we cannot show the failure is current). The mtime also feeds `latestAt`
 * (P-005 regression gating).
 */
export function smokeFailSignalsFromRows(
  rows: SmokeFailRow[],
  opts: { recentHours?: number; nowMs?: number } = {},
): WatchdogSignal[] {
  const recentHours = opts.recentHours ?? 48;
  const nowMs = opts.nowMs ?? Date.now();
  const cutoffMs = nowMs - recentHours * 3_600_000;
  const out: WatchdogSignal[] = [];
  for (const r of rows) {
    const mtime = r.mtime_ms == null ? NaN : Number(r.mtime_ms);
    if (!Number.isFinite(mtime) || mtime < cutoffMs) continue;
    out.push({
      source: 'smoke-fail' as const,
      key: r.harness_slug,
      title: `Smoke test failing in harness ${r.harness_slug}`,
      body: `Watchdog signal (smoke-fail): the ${r.harness_slug} smoke test is RED.\n\n${(r.failure_content ?? '').slice(0, 2000) || '(no failure content recorded)'}`,
      severity: 'major' as const,
      // Origin scope (P-032): a smoke fail is attributable to ONE harness.
      scope: `harness:${r.harness_slug}`,
      latestAt: new Date(mtime).toISOString(),
    });
  }
  return out;
}

/** smoke-fail: a harness smoke test currently failing (the plans:attention signal), recency-gated (P-007). */
export async function collectSmokeFailSignals(sql: Sql, workspaceId: string, opts: CollectOptions = {}): Promise<WatchdogSignal[]> {
  const rows = await sql<SmokeFailRow[]>`
    SELECT harness_slug, failure_content, mtime_ms
      FROM harness_shared.harness_smoke_test
     WHERE workspace_id = ${workspaceId}
       AND status = 'fail'
     LIMIT 20`;
  return smokeFailSignalsFromRows(rows, { recentHours: opts.smokeFailRecentHours });
}

/**
 * Tool-failure CLASS (watchdog-robustness P-008 / D-009). The collector detects
 * by CLASS, not raw count: a deterministic config bug recurs identically, so it
 * deserves a LOW bar; a transient timeout needs VOLUME to be worth filing.
 *   - structural — a real bug/misconfig (the tool itself, a missing table, a
 *     workspace-scoping gap). Fires on FEW occurrences OR a high error-rate.
 *   - transient  — timeout / load / network. Volume-gated, lower severity.
 *   - caller     — the CALLER sent bad input or lacks a role (invalid_args /
 *     role-denied). A sustained pattern = a DX/schema problem → kind=change.
 *   - rate-limit — an EXTERNAL provider rate-limit / quota (OpenAI embedding TPM,
 *     a 429, "rate limit reached"). NOT a code bug and NOT a structural defect —
 *     it's capacity. Volume-gated, kind=change, routed to infra/owner, never the
 *     auto-implement lane. (watchdog-embed-resilience-and-dedup-2026-06-17 P-002:
 *     a sustained OpenAI embed-429 used to fall through to `structural` and file
 *     as a deterministic tool bug, masked under an unrelated scoping EI.)
 */
// The ToolErrorClass type, the classifier (TS fn + the SQL CASE generator), the
// error-shape patterns, and the fingerprint helpers all moved to
// ./tool-error-classifier (watchdog-and-exposed-systems-improvement-2026-06-18
// P-011) so the TS fn and the SQL CASE are GENERATED from one ordered rule table
// and can no longer drift. `classifyToolError` + `ToolErrorClass` are re-exported
// for the existing import sites (watchdog.test.ts); the rest is imported above
// for internal use, or imported directly from the module by new callers.
export { classifyToolError, type ToolErrorClass };

interface ClassifiedToolErrorRow {
  tool_name: string;
  /** SQL alias `class`; one of ToolErrorClass. */
  class: ToolErrorClass;
  /**
   * Normalized error-shape fingerprint (P-003): SQL-computed for the `structural`
   * class only (first 6 alpha tokens of the digit/punct-stripped message), null
   * otherwise. Appended to the structural dedup key so two genuinely DIFFERENT
   * deterministic failure modes under the same tool don't collapse onto one key
   * (the 2026-06-17 embed-429-masked-by-EI-630 class of bug).
   */
  fingerprint?: string | null;
  /** Failures of this class for this tool in the window. */
  n: number;
  /** Total calls (any status) for this tool in the window — the rate denominator. */
  total: number;
  sample: string | null;
  /** Newest failure timestamp in the window (P-005 latestAt). */
  latest_at?: string | Date | null;
}

/**
 * One timeout-class telemetry row used by the shared-resource correlation leg.
 *
 * `coord_owner_id` is the session boundary: `spawn_id` is deliberately not used
 * here because it is a per-request label in some transports and can collapse or
 * split a real session. Rows returned by the collector carry `class='transient'`;
 * the status/duration fallback keeps this pure seam useful for fixtures and for
 * older telemetry rows that predate the classifier stamp.
 */
export interface SharedToolStallTelemetryRow {
  tool_name: string;
  coord_owner_id?: string | null;
  invoked_at?: string | Date | null;
  status?: string | null;
  duration_ms?: number | string | null;
  class?: ToolErrorClass | null;
}

export interface SharedToolStallAnalysis {
  signals: WatchdogSignal[];
  /** Tool names whose transient per-tool signal is subsumed by a shared incident. */
  correlatedToolNames: ReadonlySet<string>;
}

function sharedStallTimestamp(row: SharedToolStallTelemetryRow): number | null {
  if (!row.invoked_at) return null;
  const ms = new Date(row.invoked_at).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function sharedStallOwner(row: SharedToolStallTelemetryRow): string | null {
  const owner = typeof row.coord_owner_id === 'string' ? row.coord_owner_id.trim() : '';
  return owner || null;
}

function isSharedStallCandidate(row: SharedToolStallTelemetryRow, durationMs: number): boolean {
  if (row.class != null) return row.class === 'transient';
  if (row.status === 'timeout') return true;
  const duration = typeof row.duration_ms === 'string' ? Number(row.duration_ms) : row.duration_ms;
  return Number.isFinite(duration) && Number(duration) >= durationMs;
}

/**
 * Pure shared-resource discriminator (EI-22404438789516379).
 *
 * A timeout is treated as shared only when a bounded temporal window contains
 * enough failures from distinct tools AND distinct coordination owners. This
 * avoids turning a single slow tool into an infra incident while collapsing the
 * characteristic "many innocent tools fail together" shape into one stable
 * watchdog signal. Multiple qualifying windows in one sweep intentionally merge
 * into one signal/key; the capture core already owns cross-tick deduplication.
 */
export function analyzeSharedToolStallsFromRows(
  rows: SharedToolStallTelemetryRow[],
  opts: CollectOptions = {},
): SharedToolStallAnalysis {
  const windowMs = Math.max(1, opts.sharedStallWindowMinutes ?? 5) * 60_000;
  const minTools = Math.max(2, opts.sharedStallMinTools ?? 3);
  const minSessions = Math.max(2, opts.sharedStallMinSessions ?? 2);
  const minFailures = Math.max(minTools, opts.sharedStallMinFailures ?? 3);
  const durationMs = Math.max(1, opts.sharedStallDurationMs ?? 25_000);
  const candidates = rows
    .map((row, index) => ({ row, index, at: sharedStallTimestamp(row) }))
    .filter(({ row, at }) =>
      at != null &&
      !isImprovementLoopTool(row.tool_name) &&
      isSharedStallCandidate(row, durationMs),
    )
    .sort((a, b) => (a.at! - b.at!) || (a.index - b.index));

  if (candidates.length < minFailures) {
    return { signals: [], correlatedToolNames: new Set() };
  }

  const correlatedIndexes = new Set<number>();
  for (let start = 0; start < candidates.length; start += 1) {
    const firstAt = candidates[start]!.at!;
    const window = [];
    for (let end = start; end < candidates.length; end += 1) {
      if (candidates[end]!.at! - firstAt > windowMs) break;
      window.push(candidates[end]!);
    }
    if (window.length < minFailures) continue;
    const tools = new Set(window.map(({ row }) => row.tool_name.trim()).filter(Boolean));
    const sessions = new Set(
      window
        .map(({ row }) => sharedStallOwner(row))
        .filter((owner): owner is string => owner != null),
    );
    if (tools.size < minTools || sessions.size < minSessions) continue;
    for (const entry of window) correlatedIndexes.add(entry.index);
  }

  if (correlatedIndexes.size === 0) {
    return { signals: [], correlatedToolNames: new Set() };
  }

  const correlatedRows = candidates
    .filter(({ index }) => correlatedIndexes.has(index))
    .map(({ row }) => row);
  const tools = [...new Set(correlatedRows.map((row) => row.tool_name.trim()).filter(Boolean))].sort();
  const sessions = [...new Set(
    correlatedRows
      .map((row) => sharedStallOwner(row))
      .filter((owner): owner is string => owner != null),
  )].sort();
  const timestamps = correlatedRows
    .map(sharedStallTimestamp)
    .filter((at): at is number => at != null)
    .sort((a, b) => a - b);
  const latestAt = timestamps.length > 0 ? new Date(timestamps[timestamps.length - 1]!).toISOString() : undefined;
  const earliestAt = timestamps.length > 0 ? new Date(timestamps[0]!).toISOString() : undefined;
  const samples = correlatedRows
    .slice()
    .sort((a, b) => (sharedStallTimestamp(b) ?? 0) - (sharedStallTimestamp(a) ?? 0))
    .map((row) => `${row.tool_name}${row.status ? ` [${row.status}]` : ''}`)
    .filter((sample, index, all) => all.indexOf(sample) === index)
    .slice(0, 8);
  const spanSeconds = timestamps.length > 1
    ? Math.round((timestamps[timestamps.length - 1]! - timestamps[0]!) / 1000)
    : 0;

  return {
    correlatedToolNames: new Set(tools),
    signals: [{
      source: 'repeated-tool-error',
      key: 'shared-resource-stall',
      title: 'Multiple tools timing out together (shared-resource stall)',
      body:
        `Watchdog signal (shared-resource stall): ${correlatedRows.length} transient timeout-class ` +
        `failures from ${tools.length} distinct tools and ${sessions.length} distinct sessions ` +
        `within a ${Math.max(1, opts.sharedStallWindowMinutes ?? 5)}-minute window ` +
        `(observed span ${spanSeconds}s). This shape points to a shared dependency/resource ` +
        `rather than ${tools.length} independent tool defects; per-tool transient captures ` +
        `for these tools were suppressed.\n\nTools: ${tools.join(', ') || '(unknown)'}` +
        `\nSamples: ${samples.join(', ') || '(none)'}`,
      severity: 'major',
      kind: 'bug',
      latestAt,
      earliestAt,
      findingClass: 'shared-resource-stall',
    }],
  };
}

/** Pure signal-only façade for callers that do not need the suppression set. */
export function sharedToolStallSignalsFromRows(
  rows: SharedToolStallTelemetryRow[],
  opts: CollectOptions = {},
): WatchdogSignal[] {
  return analyzeSharedToolStallsFromRows(rows, opts).signals;
}

/** One complete call row used to detect a CURRENT consecutive soft-failure run. */
export interface SoftFailureTelemetryRow {
  tool_name: string;
  coord_owner_id?: string | null;
  invoked_at?: string | Date | null;
  result_outcome?: string | null;
  soft_failure_reason?: string | null;
}

/** One current run, aggregated in SQL after the tool+owner partition walk. */
export interface SoftFailureRunRow {
  tool_name: string;
  coord_owner_id?: string | null;
  reason: string;
  run_length: number;
  latest_at?: string | Date | null;
}

/** Compact, deterministic identity for a bounded soft-failure reason. */
export function softFailureSignalKey(toolName: string, reason: string): string {
  const normalized = reason.trim().slice(0, 512);
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  return `${toolName}:soft-failure:${digest}`;
}

/**
 * Pure detector for effect-level failures. Rows must include every call in the
 * lookback (not only soft failures): the first non-soft/non-identical call ends
 * the current run. Runs are partitioned by tool + coordination owner and then
 * collapsed by tool + reason so one broken effect creates one actionable signal.
 */
export function softFailureSignalsFromRows(
  rows: SoftFailureTelemetryRow[],
  opts: CollectOptions = {},
): WatchdogSignal[] {
  const minRun = opts.softFailureMinRun ?? 10;
  if (!(minRun > 0)) return [];
  const groups = new Map<string, SoftFailureTelemetryRow[]>();
  for (const row of rows) {
    if (isImprovementLoopTool(row.tool_name)) continue;
    const owner = row.coord_owner_id ?? '<unattributed>';
    const key = `${row.tool_name}\u0000${owner}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  const currentRuns: SoftFailureRunRow[] = [];
  for (const group of groups.values()) {
    const ordered = [...group].sort((a, b) => {
      const am = a.invoked_at ? new Date(a.invoked_at).getTime() : Number.NEGATIVE_INFINITY;
      const bm = b.invoked_at ? new Date(b.invoked_at).getTime() : Number.NEGATIVE_INFINITY;
      return bm - am;
    });
    const first = ordered[0];
    if (!first || first.result_outcome !== 'soft-failure' || typeof first.soft_failure_reason !== 'string') continue;
    const reason = first.soft_failure_reason.trim().slice(0, 512);
    if (!reason) continue;
    let count = 0;
    let latestAt: string | undefined;
    for (const row of ordered) {
      const rowReason = typeof row.soft_failure_reason === 'string' ? row.soft_failure_reason.trim().slice(0, 512) : '';
      if (row.result_outcome !== 'soft-failure' || rowReason !== reason) break;
      count += 1;
      if (!latestAt && row.invoked_at) latestAt = toIsoOrUndefined(row.invoked_at);
    }
    if (count < minRun) continue;
    currentRuns.push({
      tool_name: first.tool_name,
      coord_owner_id: first.coord_owner_id,
      reason,
      run_length: count,
      latest_at: latestAt,
    });
  }
  return softFailureSignalsFromRunRows(currentRuns, opts);
}

/** Pure signal shaping + tool/reason dedupe for SQL-aggregated current runs. */
export function softFailureSignalsFromRunRows(
  rows: SoftFailureRunRow[],
  opts: CollectOptions = {},
): WatchdogSignal[] {
  const minRun = opts.softFailureMinRun ?? 10;
  if (!(minRun > 0)) return [];
  const byReason = new Map<string, {
    toolName: string;
    reason: string;
    runs: Array<{ owner: string; count: number; latestAt?: string }>;
    latestAt?: string;
    maxRun: number;
  }>();
  for (const row of rows) {
    if (isImprovementLoopTool(row.tool_name) || row.run_length < minRun) continue;
    const reason = row.reason.trim().slice(0, 512);
    if (!reason) continue;
    const owner = row.coord_owner_id ?? '<unattributed>';
    const latestAt = toIsoOrUndefined(row.latest_at);
    const key = `${row.tool_name}\u0000${reason}`;
    const existing = byReason.get(key);
    const run = { owner, count: row.run_length, ...(latestAt ? { latestAt } : {}) };
    if (existing) {
      existing.runs.push(run);
      existing.maxRun = Math.max(existing.maxRun, row.run_length);
      if (latestAt && (!existing.latestAt || latestAt > existing.latestAt)) existing.latestAt = latestAt;
    } else {
      byReason.set(key, {
        toolName: row.tool_name,
        reason,
        runs: [run],
        latestAt,
        maxRun: row.run_length,
      });
    }
  }
  return [...byReason.values()].map((entry) => ({
    source: 'repeated-tool-error',
    key: softFailureSignalKey(entry.toolName, entry.reason),
    title: `Tool ${entry.toolName} repeatedly reports an unsuccessful effect`,
    body:
      `Watchdog signal (soft-failure outcome): ${entry.toolName} returned ok:false with reason ` +
      `"${entry.reason}" in a current consecutive run (threshold ${minRun}). ` +
      `Runs by owner: ${entry.runs.map((run) => `${run.owner}×${run.count}`).join(', ')}.`,
    severity: entry.maxRun >= minRun * 2 ? 'major' : 'minor',
    kind: 'change',
    ...(entry.latestAt ? { latestAt: entry.latestAt } : {}),
  }));
}

/**
 * Pure (watchdog-robustness P-006 / D-006): a tool name belonging to the
 * self-improvement loop ITSELF — the watchdog must never file a tool-error
 * capture about its own capture path (a self-amplifying loop: it would file a
 * bug about the very tool it files bugs through). The loop's own health is the
 * self-escalation's job (P-002), not a self-captured tool-error.
 */
export function isImprovementLoopTool(toolName: string): boolean {
  return /^improvements:/.test(toolName) || /^system:improvement-/.test(toolName);
}

/**
 * Pure (P-006/D-006 + P-008/D-009): per-(tool,class) aggregate rows → signals,
 * excluding the loop's own tools. Each class has its own FIRE bar + severity + kind:
 *   - structural: n ≥ structuralMinCount (2) OR (total ≥ structuralMinCallsForRate
 *     AND n/total ≥ structuralMinRate) → major, kind=bug. THIS is what catches the
 *     low-frequency structural failures the old absolute ≥5/60min threshold missed.
 *   - transient:  n ≥ transientMinCount (15) → minor (major at ≥50), kind=bug.
 *   - caller:     n ≥ callerMinCount (10) → minor, kind=change.
 */
export function toolErrorSignalsFromRows(
  rows: ClassifiedToolErrorRow[],
  opts: CollectOptions = {},
  correlatedTransientTools: ReadonlySet<string> = new Set(),
): WatchdogSignal[] {
  const structuralMin = opts.structuralMinCount ?? 2;
  const structuralRate = opts.structuralMinRate ?? 0.5;
  const structuralRateCalls = opts.structuralMinCallsForRate ?? 3;
  const transientMin = opts.transientMinCount ?? 15;
  const callerMin = opts.callerMinCount ?? 10;
  const rateLimitMin = opts.rateLimitMinCount ?? 8;
  const rateLimitMajor = opts.rateLimitMajorCount ?? 30;

  const out: WatchdogSignal[] = [];
  for (const r of rows) {
    if (isImprovementLoopTool(r.tool_name)) continue;
    const rate = r.total > 0 ? r.n / r.total : 0;
    const pct = Math.round(rate * 100);
    const sample = (r.sample ?? '').slice(0, 800) || '(no message)';
    const latestAt = toIsoOrUndefined(r.latest_at);
    // The dedup key: tool:class[:fingerprint]. The fingerprint sharpens the key for
    // the FINGERPRINTED classes — structural + caller + transient (P-003 + P-012) —
    // so two genuinely DIFFERENT same-class modes under one tool don't collapse onto
    // one key and mask each other; rate-limit stays COARSE (one capacity concern).
    // toolErrorSignalKey is the single source (tool-error-classifier.ts), also used by
    // the post-deploy key-migration backfill so a migrated key matches this exactly.
    // `fp` (title display) tracks r.fingerprint, which the SQL already nulls for rate-limit.
    const fp = r.fingerprint ?? null;
    const key = toolErrorSignalKey(r.tool_name, r.class, r.fingerprint);

    if (r.class === 'structural') {
      if (!(r.n >= structuralMin || (r.total >= structuralRateCalls && rate >= structuralRate))) continue;
      out.push({
        source: 'repeated-tool-error',
        key,
        title: `Tool ${r.tool_name} returns a structural error${fp ? ` (${fp})` : ''}`,
        body:
          `Watchdog signal (structural tool-error): ${r.tool_name} returned a deterministic error ${r.n}× ` +
          `(${pct}% of ${r.total} calls) in the window — the shape that recurs identically (a bug/misconfig), ` +
          `not transient load.\n\nSample error: ${sample}`,
        severity: 'major',
        kind: 'bug',
        latestAt,
      });
    } else if (r.class === 'transient') {
      if (correlatedTransientTools.has(r.tool_name)) continue;
      if (r.n < transientMin) continue;
      out.push({
        source: 'repeated-tool-error',
        key,
        title: `Tool ${r.tool_name} timing out repeatedly${fp ? ` (${fp})` : ''}`,
        body:
          `Watchdog signal (transient tool-error): ${r.tool_name} timed out / errored transiently ${r.n}× ` +
          `(${pct}% of ${r.total} calls) recently.\n\nSample: ${sample}`,
        severity: r.n >= 50 ? 'major' : 'minor',
        kind: 'bug',
        latestAt,
      });
    } else if (r.class === 'rate-limit') {
      // EXTERNAL provider rate-limit / quota (OpenAI embed TPM 429). Volume-gated
      // like transient; filed as kind=change (capacity / infra, not an auto-fixable
      // code bug). P-002 (watchdog-embed-resilience-and-dedup-2026-06-17).
      if (r.n < rateLimitMin) continue;
      out.push({
        source: 'repeated-tool-error',
        key,
        title: `Tool ${r.tool_name} failing on an external provider rate-limit`,
        body:
          `Watchdog signal (external rate-limit): ${r.tool_name} failed ${r.n}× ` +
          `(${pct}% of ${r.total} calls) in the window with a provider rate-limit / quota error ` +
          `(e.g. OpenAI embedding TPM saturation). This is EXTERNAL CAPACITY, not a code bug — route ` +
          `to infra/owner (a separate key/quota, throttling, or the account pool), NOT the ` +
          `auto-implement lane.\n\nSample: ${sample}`,
        severity: r.n >= rateLimitMajor ? 'major' : 'minor',
        kind: 'change',
        latestAt,
        findingClass: `external-rate-limit:${r.tool_name}`,
      });
    } else {
      if (r.n < callerMin) continue;
      out.push({
        source: 'repeated-tool-error',
        key,
        title: `Tool ${r.tool_name} repeatedly rejecting caller input${fp ? ` (${fp})` : ''}`,
        body:
          `Watchdog signal (caller/DX tool-error): ${r.tool_name} rejected caller input ${r.n}× ` +
          `(${pct}% of ${r.total} calls) — a sustained pattern suggests a confusing schema or a ` +
          `mis-scoped gate, not a tool bug.\n\nSample: ${sample}`,
        severity: 'minor',
        kind: 'change',
        latestAt,
      });
    }
  }
  return out;
}

/**
 * repeated-tool-error (P-008 / D-009): per-(tool,class) failure aggregates over a
 * 24h window, classified IN SQL (the CASE mirrors `classifyToolError`). The
 * per-class FIRE bar lives in `toolErrorSignalsFromRows` (pure + unit-tested). The
 * loop's own tools are excluded in SQL (efficient) and re-excluded in the pure fn
 * (defense-in-depth + the test seam).
 *
 * Workspace scoping (audit P-013): when `workspaceId` is given, the sweep covers
 * that workspace PLUS the box-global buckets — `'*'` (unscoped SU sessions, the
 * bulk of real traffic) and the coord workspace (DEFAULT_COORD_WORKSPACE) — so a
 * tick scoped to workspace W no longer counts another workspace's errors, without
 * going dark on the unscoped traffic where most signal lives.
 */
export async function collectToolErrorSignals(sql: Sql, opts: CollectOptions = {}, workspaceId?: string): Promise<WatchdogSignal[]> {
  const windowHours = opts.toolErrorWindowHours ?? 24;
  const scopes = workspaceId ? [...new Set([workspaceId, '*', DEFAULT_COORD_WORKSPACE])] : null;
  const rows = await sql<ClassifiedToolErrorRow[]>`
    WITH fail AS (
      SELECT tool_name,
        -- Classified by the GENERATED CASE from the shared TOOL_ERROR_RULES table
        -- (tool-error-classifier.ts) — the SAME ordered table classifyToolError walks,
        -- so the in-DB SQL and the TS fn CANNOT drift (P-011). The per-class FIRE bars
        -- live in toolErrorSignalsFromRows; the loop's own tools are excluded below.
        ${toolErrorClassSqlCase(sql)} AS class,
        error_message,
        invoked_at
        FROM harness_shared.tool_invocations
       WHERE status IN ('error', 'timeout')
         AND invoked_at > now() - make_interval(hours => ${windowHours})
         AND ${scopes ? sql`workspace_id = ANY(${scopes}::text[])` : sql`TRUE`}
         AND tool_name NOT LIKE 'improvements:%'
         AND tool_name NOT LIKE 'system:improvement-%'
    ),
    tot AS (
      SELECT tool_name, count(*)::int AS total
        FROM harness_shared.tool_invocations
       WHERE invoked_at > now() - make_interval(hours => ${windowHours})
         AND ${scopes ? sql`workspace_id = ANY(${scopes}::text[])` : sql`TRUE`}
         AND tool_name NOT LIKE 'improvements:%'
         AND tool_name NOT LIKE 'system:improvement-%'
       GROUP BY tool_name
    ),
    -- P-003 + P-012 fingerprint: the normalized error-shape skeleton (first 6 alpha
    -- tokens of the digit/punct-stripped message), computed by the GENERATED CASE from
    -- FINGERPRINTED_TOOL_ERROR_CLASSES (tool-error-classifier.ts). structural + caller +
    -- transient are fingerprinted, so distinct same-class modes under one tool split into
    -- separate keys instead of masking each other; rate-limit stays coarse (one capacity
    -- concern). toolErrorFingerprint() mirrors this exact arithmetic in TS for the
    -- key-migration backfill — parity proven by the integration test.
    tagged AS (
      SELECT tool_name, class, error_message, invoked_at,
        ${toolErrorFingerprintSqlCase(sql)} AS fingerprint
        FROM fail
    )
    SELECT tagged.tool_name, tagged.class, tagged.fingerprint, count(*)::int AS n,
           COALESCE(tot.total, count(*))::int AS total,
           max(tagged.error_message) AS sample,
           max(tagged.invoked_at) AS latest_at
      FROM tagged LEFT JOIN tot ON tot.tool_name = tagged.tool_name
     GROUP BY tagged.tool_name, tagged.class, tagged.fingerprint, tot.total
     ORDER BY count(*) DESC
      LIMIT 30`;
  let sharedStall: SharedToolStallAnalysis = { signals: [], correlatedToolNames: new Set() };
  try {
    const sharedStallRows = await sql<SharedToolStallTelemetryRow[]>`
      WITH candidates AS (
        SELECT tool_name, coord_owner_id, invoked_at, status, duration_ms,
          ${toolErrorClassSqlCase(sql)} AS class
          FROM harness_shared.tool_invocations
         WHERE status IN ('error', 'timeout')
           AND invoked_at > now() - make_interval(hours => ${windowHours})
           AND ${scopes ? sql`workspace_id = ANY(${scopes}::text[])` : sql`TRUE`}
           AND tool_name NOT LIKE 'improvements:%'
           AND tool_name NOT LIKE 'system:improvement-%'
           -- The covering index carries status + duration_ms. Keep this candidate
           -- read narrow: generic errors only enter when they actually ran long,
           -- while status='timeout' remains eligible regardless of duration.
           AND (status = 'timeout' OR duration_ms >= ${opts.sharedStallDurationMs ?? 25_000})
      )
      SELECT tool_name, coord_owner_id, invoked_at, status, duration_ms, class
        FROM candidates
       WHERE class = 'transient'
       ORDER BY invoked_at DESC
       LIMIT ${opts.sharedStallMaxRows ?? 2000}`;
    sharedStall = analyzeSharedToolStallsFromRows(sharedStallRows, opts);
  } catch (error) {
    // Correlation is a guard against false filing, not a reason to make the whole
    // watchdog blind when an older/partial telemetry schema cannot supply it.
    console.warn(
      `[improvement-watchdog] shared timeout correlation unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const softMinRun = opts.softFailureMinRun ?? 10;
  const softRows = await sql<SoftFailureRunRow[]>`
    WITH ordered AS (
      SELECT id, tool_name, coord_owner_id, invoked_at,
             metadata_json->>'resultOutcome' AS result_outcome,
             metadata_json->>'softFailureReason' AS soft_failure_reason,
             row_number() OVER (
               PARTITION BY tool_name, coord_owner_id ORDER BY invoked_at DESC, id DESC
             ) AS rn,
             lag(metadata_json->>'resultOutcome') OVER (
               PARTITION BY tool_name, coord_owner_id ORDER BY invoked_at DESC, id DESC
             ) AS previous_outcome,
             lag(metadata_json->>'softFailureReason') OVER (
               PARTITION BY tool_name, coord_owner_id ORDER BY invoked_at DESC, id DESC
             ) AS previous_reason
        FROM harness_shared.tool_invocations
       WHERE invoked_at > now() - make_interval(hours => ${windowHours})
         AND ${scopes ? sql`workspace_id = ANY(${scopes}::text[])` : sql`TRUE`}
         AND coord_owner_id IS NOT NULL
         AND tool_name NOT LIKE 'improvements:%'
         AND tool_name NOT LIKE 'system:improvement-%'
    ), grouped AS (
      SELECT *,
             sum(CASE
               WHEN rn = 1 THEN 0
               WHEN result_outcome IS DISTINCT FROM previous_outcome
                 OR soft_failure_reason IS DISTINCT FROM previous_reason THEN 1
               ELSE 0
             END) OVER (
               PARTITION BY tool_name, coord_owner_id
               ORDER BY invoked_at DESC, id DESC ROWS UNBOUNDED PRECEDING
             ) AS run_id
        FROM ordered
    )
    SELECT tool_name, coord_owner_id,
           max(soft_failure_reason) AS reason,
           count(*)::int AS run_length,
           max(invoked_at) AS latest_at
      FROM grouped
     WHERE run_id = 0
       AND result_outcome = 'soft-failure'
       AND nullif(btrim(soft_failure_reason), '') IS NOT NULL
     GROUP BY tool_name, coord_owner_id
    HAVING count(*) >= ${softMinRun}
     ORDER BY count(*) DESC
     LIMIT 100`;
  return [
    ...toolErrorSignalsFromRows(rows, opts, sharedStall.correlatedToolNames),
    ...sharedStall.signals,
    ...softFailureSignalsFromRunRows(softRows, opts),
  ];
}

/** service-down: a watched dev endpoint currently DOWN per the service-health monitor. */
export function collectServiceDownSignals(
  results = lastServiceHealth(),
): WatchdogSignal[] {
  return results
    .filter((r) => !r.up && r.present !== false)
    .map((r) =>
      // EI-19465075959589134: a WEDGE gets its OWN key, so it files and dedupes
      // as a distinct condition instead of merging into whatever long-standing
      // "Service X is down" noise already exists — the two need opposite
      // responses, and the wedge is the one nothing else on the box can see.
      // This detection runs in a DIFFERENT process from the wedged one (the
      // :3070 probe observing :3170), which is the point: an in-process guard
      // rides the same blocked loop it is meant to police.
      r.wedged
        ? {
            source: 'service-down' as const,
            key: `${r.name}:wedged`,
            title: `Service ${r.name} is WEDGED (listening, not accepting)`,
            body:
              `Watchdog signal (service-down): "${r.name}" is still LISTENING but is not accepting connections` +
              (r.acceptQueue ? ` — ${r.acceptQueue.pending} queued unaccepted of a ${r.acceptQueue.backlog} backlog` : '') +
              '. Its event loop is blocked, so every other liveness signal still reads healthy: the unit is active, the pid is alive, and a TCP connect succeeds (the kernel completes the handshake without the process). ' +
              'A restart RECOVERS it but destroys the evidence — capture logs and RSS FIRST, or the cause survives the restart.' +
              (r.note ? ` Probe note: ${r.note}` : ''),
            severity: 'major' as const,
          }
        : {
            source: 'service-down' as const,
            key: r.name,
            title: `Service ${r.name} is down`,
            body:
              `Watchdog signal (service-down): the service-health monitor reports "${r.name}" DOWN` +
              (r.status ? ` (HTTP ${r.status})` : ' (no response)') +
              (r.note ? ` — ${r.note}` : '') +
              '.',
            severity: 'major' as const,
          },
    );
}

/**
 * The service-health probe runs every 60s (a DBOS scheduled workflow). The
 * `lastServiceHealth()` snapshot is a module singleton — if the probe workflow
 * has STOPPED (or the host just restarted), it goes stale and would feed the
 * watchdog phantom up/down data. Default freshness window = 2× the probe
 * interval (watchdog-robustness P-004 / D-004).
 */
export const DEFAULT_SERVICE_HEALTH_MAX_STALE_MS = 2 * 60_000;

/** Pure: is the service-health snapshot too old (or never populated) to trust? (P-004) */
export function isServiceHealthStale(at: number | null, now: number, maxStaleMs: number): boolean {
  if (at == null) return true; // never probed this process
  return now - at > maxStaleMs;
}

/**
 * Inline-probe-on-stale toggle (infra-self-healing R4-7). DEFAULT ON: when the
 * snapshot is stale the collector probes the endpoints FRESH inline rather than
 * skipping — so a real DOWN is still caught exactly when the periodic probe
 * workflow has stalled under load (the moment service-down matters most). The
 * inline probe is bounded by `probeAll`'s 3s-per-endpoint timeout. Set
 * `PAPERCUSP_WATCHDOG_SERVICE_HEALTH_INLINE_PROBE=0` to fall back to the prior
 * skip-with-note behavior if the inline probe ever proves costly.
 */
export function inlineProbeOnStaleEnabled(): boolean {
  return process.env.PAPERCUSP_WATCHDOG_SERVICE_HEALTH_INLINE_PROBE !== '0';
}

/**
 * The default `service-down` collector with the P-004 freshness gate. On a
 * FRESH snapshot it maps the cached probe results to signals as before. On a
 * STALE (or never-populated) snapshot the collector NO LONGER goes blind:
 *
 *  - inline-probe ON (default): run a fresh, bounded `probeAll()` inline and
 *    emit signals off THAT (infra-self-healing R4-7) — the periodic writer may
 *    be stalled, but a real DOWN is still caught. Carries a `stale-service-health
 *    (fresh inline probe)` note so the tick record shows the fallback fired. If
 *    the inline probe itself throws, emit a single DEGRADED/unknown signal so the
 *    collector never produces both zero signals AND no note.
 *  - inline-probe OFF: the prior P-004 behavior — emit nothing, carry a
 *    `stale-service-health` skip note.
 *
 * Async because the stale path may do I/O (the inline probe).
 */
export async function serviceDownCollectorResult(opts: {
  results?: ProbeResult[];
  at?: number | null;
  now?: number;
  maxStaleMs?: number;
  /** Inject the fresh-probe (tests); defaults to the real bounded `probeAll`. */
  probe?: () => Promise<ProbeResult[]>;
  /** Override the inline-probe toggle (tests); defaults to the env-gated flag. */
  inlineProbe?: boolean;
} = {}): Promise<CollectorResult> {
  const at = opts.at ?? lastServiceHealthAt();
  const now = opts.now ?? Date.now();
  const maxStaleMs = opts.maxStaleMs ?? DEFAULT_SERVICE_HEALTH_MAX_STALE_MS;
  if (isServiceHealthStale(at, now, maxStaleMs)) {
    const ageMs = at == null ? null : now - at;
    const ageDesc = ageMs == null ? 'never populated' : `is ${Math.round(ageMs / 1000)}s old`;
    const inline = opts.inlineProbe ?? inlineProbeOnStaleEnabled();
    if (!inline) {
      // Legacy fallback (PAPERCUSP_WATCHDOG_SERVICE_HEALTH_INLINE_PROBE=0): skip.
      // WI-40769: this is THE blind tick — zero signals because nothing was
      // probed, not because every service is up. Declared unobserved so the
      // auto-close sweep cannot read the silence as a recovery.
      return {
        signals: [],
        observed: false,
        unobservedSource: 'service-down',
        note:
          `stale-service-health: snapshot ${ageDesc} ` +
          `(> ${Math.round(maxStaleMs / 1000)}s) — skipping service-down collection (the probe workflow may have stopped)`,
      };
    }
    // Inline fresh probe — the periodic writer stalled, so probe NOW (bounded).
    try {
      const probe = opts.probe ?? (() => probeAll());
      const fresh = await probe();
      // Route through the SAME confirm-ticks debounce the periodic 60s tick uses
      // (recordProbeResults) — a raw single fresh probe fed straight to
      // collectServiceDownSignals would bypass DOWN_CONFIRM_TICKS entirely and
      // reintroduce the single-tick flap class WI-6146 damped staging-api/
      // desktop/oddsmith-sidecar against (see recordProbeResults' doc comment).
      const debounced = recordProbeResults(fresh);
      return {
        signals: collectServiceDownSignals(debounced),
        note:
          `stale-service-health: snapshot ${ageDesc} ` +
          `(> ${Math.round(maxStaleMs / 1000)}s) — ran a fresh inline probe (the periodic probe workflow may have stalled)`,
      };
    } catch (e) {
      // The inline probe itself failed: don't go blind — surface a single
      // DEGRADED/unknown signal so a stale-and-unprobeable monitor is visible.
      const msg = e instanceof Error ? e.message : String(e);
      return {
        signals: [{
          source: 'service-down' as const,
          key: 'service-health-monitor',
          title: 'Service-health monitor is degraded',
          body:
            `Watchdog signal (service-down): the service-health snapshot ${ageDesc} ` +
            `(> ${Math.round(maxStaleMs / 1000)}s) AND the fresh inline probe failed (${msg}) — ` +
            `service-down detection is degraded; the periodic probe workflow may have stalled.`,
          severity: 'major' as const,
          findingClass: 'service-down:monitor-degraded',
        }],
        // WI-40769: the DEGRADED signal above is about the MONITOR, not about
        // any individual service — every per-service condition went unobserved
        // this tick. Without this, a monitor outage would look like "every
        // service recovered" and could auto-close a genuine open outage row.
        observed: false,
        unobservedSource: 'service-down',
        note: `stale-service-health: snapshot ${ageDesc} — inline probe failed (${msg})`,
      };
    }
  }
  return { signals: collectServiceDownSignals(opts.results ?? lastServiceHealth()) };
}

// ── P-010 blind-source collectors (watchdog-robustness) ──────────────────────
// The watchdog watched only 4 surfaces; whole classes of failure (schema drift, a
// silently-failing background routine, stuck plans, failed spawns, abandoned work)
// were invisible. Each collector below is a CONSERVATIVE is-broken query; they all
// land behind the P-009 per-source budget + search-first dedup so a steady backlog
// can't flood the capture feed. Pure row→signal mappers are exported for unit tests.

/**
 * migration-drift: on-disk migrations the live DB has NOT applied — runtime code that
 * expects those columns/tables fails until the operator restarts (boot-apply). Rare +
 * catastrophic → critical, any drift fires. Wires the existing `checkMigrationDrift`
 * (injectable for tests).
 *
 * WI-6037: `missing` alone over-fires. `resolveSqlDir()` is cwd-RELATIVE while the org
 * DB is SHARED, so the staging operator (cwd = the staging checkout, legitimately AHEAD
 * of release) and the green operator (cwd = papercup-release) disagree about the SAME
 * database — every migration that lands on staging reads as `missing` (and fired
 * `critical`) to the staging operator for the entire normal staging→deploy window, up to
 * an hour+, consuming fleet claim capacity on noise. `missingDeployed` (present on disk
 * in the DEPLOYED/release tree, per checkMigrationDrift's own classification) is the
 * genuinely actionable subset — this collector now keys firing on THAT, not on the raw
 * `missing`. `missingPendingDeploy` (missing here, absent from the deployed tree) is
 * always self-healing on the next deploy and never fires — not even at a lower severity —
 * so it stops consuming claim capacity entirely, per the filed bug's complaint.
 */
export async function collectMigrationDriftSignals(
  check: () => Promise<{
    missing: string[];
    sqlDir?: string | null;
    /** Present on disk in the deployed/release tree — the actionable subset.
     *  Omitted (older/simpler injected checks) falls back to the raw `missing`,
     *  preserving today's fire-on-any-missing behavior for those callers. */
    missingDeployed?: string[];
  }> = checkMigrationDrift,
): Promise<WatchdogSignal[]> {
  let drift: { missing: string[]; sqlDir?: string | null; missingDeployed?: string[] };
  try { drift = await check(); } catch { return []; }
  const missingDeployed = drift.missingDeployed ?? drift.missing;
  if (!missingDeployed?.length) return [];
  // Naming the scanned dir is what makes the resulting bug actionable — without it the
  // reader cannot tell a genuine un-applied migration from the normal
  // staging-ahead-of-release window, and has to re-derive the tree by hand
  // (EI-18700750726210390).
  const scanned = drift.sqlDir ? `\n\nScanned sql dir: ${drift.sqlDir}` : '';
  return [{
    source: 'migration-drift',
    key: 'migration-drift',
    title: 'Schema drift: migrations on disk are not applied to the live DB',
    body:
      `Watchdog signal (migration-drift): ${missingDeployed.length} migration file(s) exist on disk in the ` +
      `DEPLOYED tree but are NOT applied to the live database — runtime code expecting those columns/tables ` +
      `will fail until the operator restarts (boot-apply).\n\nUnapplied: ${missingDeployed.slice(0, 20).join(', ')}${scanned}`,
    severity: 'critical',
    kind: 'bug',
    paths: ['libs/papercusp/libs/db/sql'],
  }];
}

/**
 * schema-ahead-of-code (EI-18787755090726525): the OPPOSITE direction from
 * `collectMigrationDriftSignals` above. That collector fires when code ships migrations
 * the live DB hasn't applied yet; this one fires when the live DB has APPLIED a
 * migration numbered higher than anything this running code tree ships — i.e. a
 * migration landed on the shared DB (instantly, the moment it runs) before the code
 * that depends on its new shape reached this process (which rides git-sync →
 * green-checkpoint → deploy, and can lag by minutes to hours).
 *
 * For an ordinary additive migration (a new column/table) that gap is harmless: old
 * code simply doesn't use the new shape yet. It is NOT harmless for an identity-INDEX
 * shape change — Postgres infers an `ON CONFLICT` target by matching a live index, so
 * a partial-index migration (e.g. mig 689 adding `WHERE superseded_at IS NULL`) makes
 * every write from a still-running, pre-migration process fail at PLAN time with
 * "no unique or exclusion constraint matching the ON CONFLICT specification" — an
 * error that names neither the table nor the migration. That took `facts:assert` down
 * fleet-wide for ~25min on 2026-07-27, self-healing only once the matching code
 * deployed, with nothing paging in the interim.
 *
 * `checkMigrationDrift`'s `schemaAhead` field already computes exactly this set (added
 * for WI-5050, a different incident — a stale dev-source tree serving a newer-migrated
 * DB); it was previously surfaced ONLY as a `console.warn` on operator BOOT
 * (db-boot-migrate.ts), which cannot catch a process that is already running through
 * the gap — the exact window this bug describes. Wiring it into the periodic watchdog
 * (~15min cadence) turns a silent, fleet-wide, minutes-to-hours-long outage into a
 * paged, tracked finding within one tick, generalized past agent_facts to any table.
 */
export async function collectSchemaAheadSignals(
  check: () => Promise<{ schemaAhead: string[]; sqlDir?: string | null }> = checkMigrationDrift,
): Promise<WatchdogSignal[]> {
  let drift: { schemaAhead: string[]; sqlDir?: string | null };
  try { drift = await check(); } catch { return []; }
  if (!drift.schemaAhead?.length) return [];
  const scanned = drift.sqlDir ? `\n\nThis tree's sql dir: ${drift.sqlDir}` : '';
  return [{
    source: 'schema-ahead-of-code',
    key: 'schema-ahead-of-code',
    title: 'Schema AHEAD of code: the live DB has applied migrations this running tree does not ship',
    body:
      `Watchdog signal (schema-ahead-of-code): ${drift.schemaAhead.length} migration(s) are applied to the ` +
      `live database but numbered higher than anything this process's code tree ships. If any of them changed ` +
      `an identity INDEX's shape (e.g. adding a partial-index predicate), every ON CONFLICT write that infers ` +
      `its target against the OLD index shape fails at plan time until the matching code deploys — a ` +
      `fleet-wide, table-wide outage with an error that names neither the table nor the cause (EI-18787755090726525` +
      `; ~25min facts:assert outage, 2026-07-27). Update/redeploy this process's code tree.\n\n` +
      `DB-side migrations unknown to this tree: ${drift.schemaAhead.slice(0, 20).join(', ')}${scanned}`,
    severity: 'critical',
    kind: 'bug',
    paths: ['libs/papercusp/libs/db/sql'],
  }];
}

/**
 * schema-object-drift: index objects that exist in the LIVE database but that the
 * migration set does not produce — so a FRESH INSTALL will not have them.
 *
 * The third direction, and the one neither collector above can see. Both of them
 * read the migration LEDGER (`schema_migrations` vs the `sql/` dir), and an index
 * created outside the migration set leaves no trace in the ledger at all: every
 * migration can be applied, byte-identical, and the live schema still carry
 * objects users never get. Measured on the dev database 2026-08-29 (WI-918476):
 * `plugin_configs_plugin_idx` and `plugin_enables_plugin_idx` exist here and in
 * no migration. Every query plan tuned against them here is tuned against
 * something that is not shipped.
 *
 * `referenceOnly` — an index the migrations produce that is MISSING live — is
 * reported too, but only when NO migration is pending. That condition is what
 * separates the two readings of the same evidence:
 *
 *   - migrations pending  -> the index is missing because its migration has not
 *     run yet. `collectMigrationDriftSignals` already says so, more precisely,
 *     and firing here as well would just double the claim capacity one unapplied
 *     migration consumes (the WI-6037 complaint). Suppressed.
 *   - nothing pending     -> every migration ran, and the index is still absent.
 *     No ledger-based check can see this: the migration is recorded as applied,
 *     so `migration-drift` is silent and `schema-ahead-of-code` is silent. Real,
 *     and reportable only here.
 *
 * The second case is not hypothetical — it is what commissioned this gate.
 * Measured on the dev database 2026-08-29: `code_recipes_runcount_idx`,
 * `decision_ledger_ws_posture_idx` and `test_runs_branch_idx` are absent while
 * all four creating migrations applied months ago, no `DROP INDEX` for them
 * exists anywhere in the corpus, and every column they reference still exists.
 * (At least one has a plausible mechanism: migration 378 creates
 * `code_recipes_runcount_idx` inside a conditional `IF EXISTS(...) THEN` branch,
 * which a fresh install takes and an upgraded database may not — so a fresh
 * install and an upgrade legitimately end up with different schemas.)
 *
 * The pending-migration probe FAILS CLOSED: if it cannot be read, `referenceOnly`
 * is suppressed. A missed finding is recoverable on the next tick; a finding that
 * fires on every normal staging-ahead-of-release window is how a source gets
 * discounted.
 *
 * Severity `major`, not `critical`. Nothing is broken right now — the live schema
 * is a superset — so this is a fidelity finding, and paging it as an outage would
 * teach the reader to discount the source.
 *
 * Deliberately NOT in `auto-close-sources.ts`, and do not add it. Auto-close reads
 * a quiet tick as "the condition cleared", which is only sound for a collector that
 * degrades LOUD (see the `migration-drift` entry there, which qualifies precisely
 * because an unreachable tracker still FIRES). This one degrades QUIET: a failed
 * live census returns no signals, so its silence means "could not look" just as
 * often as "nothing to find". A stale open finding is the cheaper mistake than
 * auto-closing a real divergence nobody fixed. It IS in `INFRA_SIGNAL_SOURCES`,
 * because one of the two remedies is a DROP INDEX against the shared live database
 * and that is not a call to hand an auto-implement worker.
 */
export async function collectSchemaObjectDriftSignals(
  check: () => Promise<SchemaObjectDriftResult> = checkSchemaObjectDrift,
  /** Pending-migration probe — see the `referenceOnly` note above. Injectable for tests. */
  migrationCheck: () => Promise<{ missing: string[] }> = checkMigrationDrift,
): Promise<WatchdogSignal[]> {
  let result: SchemaObjectDriftResult;
  try { result = await check(); } catch { return []; }

  if (!result.drift) {
    // An UNAVAILABLE check is not a clean one, and a guard that can never speak
    // is worse than no guard — so an ungenerated manifest is itself the finding.
    // A live-census failure is NOT: the database being unreachable is transient
    // and already covered by the service-health collectors.
    if (result.unavailableReason?.includes('manifest')) {
      return [{
        source: 'schema-object-drift',
        key: 'schema-object-drift-unavailable',
        title: 'The migration-derived index manifest has never been generated',
        body:
          `Watchdog signal (schema-object-drift): the live-vs-migration index guard cannot run, so index drift ` +
          `is currently UNDETECTED rather than absent.\n\n${result.unavailableReason}`,
        severity: 'major',
        kind: 'bug',
        paths: ['packages/operator-core/lib/db-schema-reference/index-manifest.ts'],
      }];
    }
    return [];
  }

  // Fails closed: an unreadable probe suppresses referenceOnly rather than
  // guessing that nothing is pending.
  let migrationsPending = true;
  try { migrationsPending = ((await migrationCheck()).missing ?? []).length > 0; } catch { /* stays true */ }

  const { liveOnly, definitionMismatch } = result.drift;
  const referenceOnly = migrationsPending ? [] : result.drift.referenceOnly;
  if (liveOnly.length === 0 && definitionMismatch.length === 0 && referenceOnly.length === 0) return [];

  // What the finding RENDERS, with referenceOnly already gated — so the body can
  // never name something the gate above decided not to report.
  const reportable = { ...result.drift, referenceOnly };

  const stamp = result.manifestGeneratedAt
    ? `\n\nReference manifest generated: ${result.manifestGeneratedAt}. If these objects were added by a migration NEWER than that, the manifest is stale — regenerate it (PAPERCUSP_UPDATE_INDEX_MANIFEST=1 npm run test:file -- apps/operator/test/schema-object-drift.integration.test.ts) before treating them as drift.`
    : '';

  return [{
    source: 'schema-object-drift',
    key: 'schema-object-drift',
    title: 'Live schema carries index objects no migration produces',
    body:
      `Watchdog signal (schema-object-drift): the live database's index set does not match the one the ` +
      `migrations build, so this database is NOT what a fresh install gets. Query plans validated here are ` +
      `validated against indexes users may not have.\n\n${describeSchemaObjectDrift(reportable)}\n\n` +
      `Compared ${result.drift.liveIndexCount} live indexes against ${result.drift.referenceIndexCount} ` +
      `migration-derived ones across: ${result.drift.schemasCompared.join(', ')}. Not compared (no migration ` +
      `builds them): ${result.drift.schemasNotCompared.join(', ') || 'none'}.${stamp}\n\n` +
      `Remedy for an object that exists only HERE: add a migration that creates it (so every install gets it) ` +
      `or drop it (so this database matches what ships). For one that exists only in the MIGRATIONS: find out ` +
      `why applying them did not produce it here — a conditional DDL branch that a fresh install takes and an ` +
      `upgrade does not is the usual mechanism. Leaving either is the one option that keeps a shipped install ` +
      `and this database permanently different.`,
    severity: 'major',
    kind: 'bug',
    paths: ['libs/papercusp/libs/db/sql'],
  }];
}

/** The dbos-executor-reaper's stamped `metadata.last_error_source` — a self-heal
 *  requeue, not a genuine wedge (EI-5302). Mirrors REAPER_LAST_ERROR_SOURCE in
 *  dbos/dbos-executor-reaper.ts (duplicated as a literal to avoid a cross-module
 *  import cycle in this pure-signal file; keep in sync if that constant changes). */
const REAPER_SELF_HEAL_ERROR_SOURCE = 'dbos-executor-reaper';

interface RoutineFailureRow {
  name: string;
  last_error: string | null;
  /** true for a `loop:arm` interval-loop routine (`reschedule_interval_sec IS NOT NULL`). */
  is_loop?: boolean;
  /** `metadata.last_error_source` — identifies WHO stamped the error. */
  last_error_source?: string | null;
  /** The routine's next scheduled fire. For a non-loop routine, a concrete FUTURE
   *  timestamp proves `claimDueRoutine` already rescheduled it after the reaper's
   *  requeue (EI-6172) — i.e. the fire that produced the stale error already
   *  succeeded in being re-armed, distinct from a genuinely wedged routine whose
   *  next_fire_at stays null/past. NOT a useful signal for a loop routine, whose
   *  next_fire_at is 'infinity' while healthily parked awaiting its next wake —
   *  that's why loops keep their own dedicated loop-stalled collector instead. */
  next_fire_at?: string | Date | null;
  /** Last successful fire. A RECENT value is direct, non-racy proof the routine
   *  fired again since the reaper's self-heal requeue — unlike `next_fire_at`,
   *  it can't be caught mid-cadence between "just fired" and "scheduler hasn't
   *  advanced next_fire_at past now() yet" (WI-3098 / EI-7771: cross-hive-outbox-drain
   *  read next_fire_at <= now() for ~10/16 harnesses at the collection instant despite
   *  every one being genuinely healthy — active, last_fired_at within minutes, cycling
   *  on its normal ~4-6min cadence). */
  last_fired_at?: string | Date | null;
}
/** WI-3098: generous fixed window (not cadence-relative — cadence isn't always
 *  known here) within which a `last_fired_at` counts as proof of recovery. */
const RECENT_FIRE_PROOF_MS = 30 * 60 * 1000;
/**
 * Pure: routines carrying a recorded error → signals — EXCEPT a self-heal requeue
 * stamped by the dbos-executor-reaper (EI-5302 / EI-6172): that is the reaper
 * recovering a stuck fire (working as designed), not a persistent failure.
 *   - A LOOP routine's reaper-tagged error is ALWAYS suppressed here — a real
 *     wedge is already surfaced by the separate loop-stalled collector (which
 *     reads parked_secs, since a loop's next_fire_at sits at 'infinity' whether
 *     healthy or stuck and so can't disambiguate).
 *   - A NON-loop routine's reaper-tagged error is suppressed when EITHER:
 *     (a) `next_fire_at` is a concrete FUTURE timestamp — proof the routine was
 *     already successfully rescheduled since the error, or (b) `last_fired_at`
 *     is within the last `RECENT_FIRE_PROOF_MS` — proof it actually fired again
 *     since the requeue. (a) alone raced against the collection instant for a
 *     routine caught between "just fired" and "scheduler hasn't advanced
 *     next_fire_at past now() yet" in its normal cadence — exactly what let
 *     EI-7771 fire as a false positive for cross-hive-outbox-drain despite the
 *     routine being fully healthy (WI-3098). `last_fired_at` recency is a
 *     strictly more direct signal and isn't racy against that instant.
 *     (EI-6172: bp-singleton-iq-battery-0 / bp-singleton-prompt-ablation-0 /
 *     hive-eval-battery all recorded a reaper self-heal yet were confirmed
 *     healthy — active, on-cadence, next_fire_at weeks out — and still churned
 *     the improvement queue as phantom bugs).
 * Flagging either case as a MAJOR bug double-reports self-healed routines,
 * churning the auto-implement queue with noise (27 live loop instances observed
 * 2026-06-30; 67 open `routine-failure:routine:%` issues observed 2026-07-01,
 * several confirmed phantoms of this exact non-loop shape).
 */
export function routineFailureSignalsFromRows(rows: RoutineFailureRow[]): WatchdogSignal[] {
  return rows
    .filter((r) => (r.last_error ?? '').trim().length > 0)
    .filter((r) => {
      if (r.last_error_source !== REAPER_SELF_HEAL_ERROR_SOURCE) return true;
      if (r.is_loop) return false;
      const nextFireAt = r.next_fire_at ? new Date(r.next_fire_at) : null;
      const isConcreteFuture = !!nextFireAt && !Number.isNaN(nextFireAt.getTime()) && nextFireAt.getTime() > Date.now();
      const lastFiredAt = r.last_fired_at ? new Date(r.last_fired_at) : null;
      const firedRecently =
        !!lastFiredAt && !Number.isNaN(lastFiredAt.getTime()) && Date.now() - lastFiredAt.getTime() < RECENT_FIRE_PROOF_MS;
      return !(isConcreteFuture || firedRecently);
    })
    .map((r) => ({
      source: 'routine-failure' as const,
      key: `routine:${r.name}`,
      title: `Background routine "${r.name}" is failing`,
      body:
        `Watchdog signal (routine-failure): the background routine "${r.name}" recorded an error and may be ` +
        `silently wedged (the underlying cause varies by routine — check metadata.last_error_source).\n\n` +
        `Last error: ${(r.last_error ?? '').slice(0, 600)}`,
      severity: 'major' as const,
      kind: 'bug' as const,
    }));
}
/** routine-failure: an ACTIVE background routine with a recorded `metadata.last_error`,
 *  excluding a reaper self-heal requeue already proven recovered (EI-5302 / EI-6172 —
 *  see routineFailureSignalsFromRows). */
export async function collectRoutineFailureSignals(sql: Sql): Promise<WatchdogSignal[]> {
  const rows = await sql<RoutineFailureRow[]>`
    SELECT name, metadata->>'last_error' AS last_error,
           (reschedule_interval_sec IS NOT NULL) AS is_loop,
           metadata->>'last_error_source' AS last_error_source,
           next_fire_at,
           last_fired_at
      FROM harness_shared.routines
     WHERE active = true AND COALESCE(metadata->>'last_error', '') <> ''
     -- EI-19417016857494865: this LIMIT previously had NO ORDER BY, so which routines
     -- got reported was nondeterministic whenever more than the cap carried an error —
     -- a still-failing routine could drop out of the reported set on one tick and
     -- reappear on the next. That is exactly the property that makes an ABSENCE-based
     -- auto-close unsound, and it is why every other auto-close-eligible collector
     -- (loop-stalled, stuck-plan, orphaned-spawn, stalled-claim) orders before its cap.
     -- Oldest error first, so the longest-standing failure is never crowded out; the
     -- name column is a total-order tiebreak so membership is stable across ticks.
     -- NOTE: never put a backtick character in this comment — it lives inside a tagged
     -- SQL template literal, so a backtick TERMINATES the template and breaks the whole
     -- module (it crash-looped :3170 fleet-wide once, 2026-08-03). The cap sits
     -- above the total active-routine count (191 live 2026-08-03), so truncation cannot
     -- occur in practice — an absent key means recovered, never merely crowded out.
     ORDER BY metadata->>'last_error_at' ASC NULLS FIRST, name ASC
     LIMIT 200`;
  return routineFailureSignalsFromRows(rows);
}

interface LoopStalledRow {
  id: string;
  name: string;
  install_slug: string;
  target_owner_id: string;
  interval_sec: number;
  parked_secs: number;
}
/** Pure: loop-stalled rows → signals (one per stalled loop, keyed by install_slug:name). */
export function loopStalledSignalsFromRows(rows: LoopStalledRow[]): WatchdogSignal[] {
  return rows.map((r) => {
    const mins = Math.round(r.parked_secs / 60);
    return {
      source: 'loop-stalled' as const,
      key: `loop-stalled:${r.install_slug}:${r.name}`,
      title: `Engine loop ${r.name} stalled (parked, no completion)`,
      body:
        `Watchdog signal (loop-stalled): loop '${r.name}' (owner ${r.target_owner_id}, harness ${r.install_slug}, ` +
        `interval ${r.interval_sec}s) has been parked at 'infinity' for ~${mins}min with NO post-fire completion ` +
        `marker and no session activity. Its re-wake turn likely DIED silently (the classic case: a 429 during an ` +
        `account-wide rate-limit storm killed the detached resume turn) — the delivery was recorded 'delivered' on ` +
        `spawn, so nothing observed the death. Only the ≥30min stuck-park backstop will recover it. ` +
        `See agent-insights/loop-wake-turn-deaths-recorded-as-delivered.`,
      severity: 'major' as const,
      kind: 'bug' as const,
      // Origin scope (P-032): a loop belongs to ONE harness (its install_slug).
      scope: `harness:${r.install_slug}`,
    };
  });
}

/**
 * loop-stalled (P1b): an engine loop (loop:arm — `reschedule_interval_sec` + `target_owner_id`)
 * parked at 'infinity' (its turn in flight) for ≥ max(30min, 4×interval) past its fire, with NO
 * post-fire lifecycle 'ended' marker AND no genuine session activity since the fire — i.e. its
 * wake turn died/never-delivered, not a legitimately long turn (which keeps producing activity).
 * The same predicate the reconcile stuck-park backstop recovers on; here it is SURFACED as a
 * visible signal (the doc's P1b — the loop otherwise goes quiet with no observability). Read-only
 * + conservative.
 */
export async function collectLoopStalledSignals(sql: Sql, stuckParkSec = 1800): Promise<WatchdogSignal[]> {
  const rows = await sql<LoopStalledRow[]>`
    SELECT r.id,
           r.name,
           r.install_slug,
           r.target_owner_id,
           r.reschedule_interval_sec AS interval_sec,
           EXTRACT(EPOCH FROM (now() - r.last_fired_at))::float8 AS parked_secs
      FROM harness_shared.routines r
     WHERE r.active = true
       AND r.reschedule_interval_sec IS NOT NULL
       AND r.target_owner_id IS NOT NULL
       AND r.next_fire_at = 'infinity'::timestamptz
       AND r.last_fired_at IS NOT NULL
       AND r.last_fired_at < now() - make_interval(secs => GREATEST(${stuckParkSec}::int, 4 * r.reschedule_interval_sec))
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.agent_activity a
          WHERE a.owner_id = r.target_owner_id
            AND a.kind = 'lifecycle'
            AND a.summary = ${SESSION_END_MARKER}
            AND a.created_at > r.last_fired_at)
       -- WI-6639: the exemption for "the session is still working" must be judged against
       -- now(), not against last_fired_at. The original form (presence <= last_fired_at)
       -- compares two PAST instants, so a session that emitted a single presence beat after
       -- its final fire and then died was exempted FOREVER — measured live, that hid 12 loops
       -- parked at 'infinity' for 49h–160h from this signal permanently. A genuinely long
       -- turn keeps its beat fresh and is still exempt via the recency term.
       AND COALESCE(
             (SELECT max(p.last_active_at) FROM harness_shared.coord_presence p WHERE p.owner_id = r.target_owner_id),
             'epoch'::timestamptz
           ) < now() - make_interval(secs => GREATEST(${stuckParkSec}::int, 4 * r.reschedule_interval_sec))
     ORDER BY r.last_fired_at ASC
     LIMIT 20`;
  return loopStalledSignalsFromRows(rows);
}

// ── stale-protective-hold (EI-13022) ─────────────────────────────────────────

/** One pot's hold/direction facts, assembled by the collector (pure-testable input). */
export interface StaleProtectiveHoldCandidate {
  installSlug: string;
  /** pot-level hard gate active: pauseNewWork or a live pausedUntil (isPausedNow). */
  potHeld: boolean;
  /** the kettle/overwatch started control bit (kettle:pause clears it). */
  kettleStarted: boolean;
  /** directiveSuggestsResume(directive) — explicit resume OR a work-commanding directive. */
  workCommanded: boolean;
  /** Whether the pot has ANY steering directive text at all (EI-18653608066559541).
   *  Distinct from `workCommanded`, which is a keyword heuristic OVER that text:
   *  `workCommanded:false` conflates two opposite situations — a directive that
   *  asserts the pause is intentional ("in force until lifted"), and NO directive,
   *  which documents nothing. Only the second is undetectable drift. */
  directivePresent: boolean;
  /** first ~140 chars of the directive, for the body. */
  directiveHead: string;
  /** newest tick's frontier depth. */
  frontierDepth: number;
  /** hours since the last tick with placements>0 (null = none in the 24h window). */
  hoursSinceLastPlacement: number | null;
  /** how many hours of tick history the window actually covers (age gate input). */
  windowHours: number;
  /** hours since the kettle autoloop last fired (null = no kettle row for this pot). */
  kettleHoursSinceFire: number | null;
}

/** Pure: stale-hold candidates → signals. A hold is an OWNER control, so this only
 *  PAGES (never auto-resumes), and only when the hold is provably stale: the
 *  directive commands work AND the harmed leg has been dark >= minHoldHours. */
export function staleProtectiveHoldSignalsFromCandidates(
  cands: StaleProtectiveHoldCandidate[],
  minHoldHours = 2,
): WatchdogSignal[] {
  const signals: WatchdogSignal[] = [];
  for (const c of cands) {
    // EI-18653608066559541: this gate used to be a bare `if (!c.workCommanded) continue`,
    // which made the whole detector blind to the failure it exists to catch. Every
    // input to `workCommanded` is a keyword heuristic over the directive TEXT
    // (directiveSuggestsResume), and `directiveSuggestsResume(null) === false` on
    // its first line — so a pot held with NO directive at all was skipped here
    // before any evidence (frontier depth, hours since placement, kettle silence)
    // was ever weighed. That is precisely the pause-that-outlived-its-author shape
    // (EI-16537 class): the LESS a hold documents itself, the more certainly the
    // old gate ignored it.
    //
    // An UNDOCUMENTED hold is therefore its own entry condition. Note the two are
    // mutually exclusive by construction — a null directive can never be
    // work-commanding — so this widens the detector without double-reporting.
    // A directive that asserts the pause is intentional ("in force until lifted")
    // still yields workCommanded:false WITH directivePresent:true, and is still
    // correctly ignored: that hold documents itself.
    const undocumentedHold = !c.directivePresent;
    if (!c.workCommanded && !undocumentedHold) continue;
    const potStale =
      c.potHeld &&
      c.frontierDepth > 0 &&
      c.windowHours >= minHoldHours &&
      (c.hoursSinceLastPlacement == null || c.hoursSinceLastPlacement >= minHoldHours);
    // kettle-only leg requires an EXISTING kettle row gone stale — a pot that never
    // ran a kettle is a different (setup) problem, not a stale hold.
    const kettleStale =
      !c.kettleStarted &&
      c.kettleHoursSinceFire != null &&
      c.kettleHoursSinceFire >= minHoldHours;
    if (!potStale && !kettleStale) continue;
    const holdKind = potStale && kettleStale ? 'pot+kettle' : potStale ? 'pot-pause' : 'kettle-pause';
    const evidence =
      `Evidence: frontier_depth=${c.frontierDepth}, ` +
      `last placement ${c.hoursSinceLastPlacement == null ? 'none in 24h' : `~${Math.round(c.hoursSinceLastPlacement)}h ago`}, ` +
      `kettle last fired ${c.kettleHoursSinceFire == null ? 'never/no row' : `~${Math.round(c.kettleHoursSinceFire)}h ago`}.`;
    // The undocumented-hold leg gets its OWN key and wording: the original text
    // asserts the hold "contradicts its work-commanding directive", which would be
    // a plain falsehood here — there is no directive to contradict. A separate key
    // also keeps the two legs deduping independently in the signal store.
    signals.push({
      source: 'stale-protective-hold' as const,
      key: undocumentedHold
        ? `stale-protective-hold:${c.installSlug}:undocumented-${holdKind}`
        : `stale-protective-hold:${c.installSlug}:${holdKind}`,
      title: undocumentedHold
        ? `Stale UNDOCUMENTED hold on pot ${c.installSlug} (${holdKind}) — no directive records why it exists`
        : `Stale protective hold on pot ${c.installSlug} (${holdKind}) contradicts its work-commanding directive`,
      body: undocumentedHold
        ? `Watchdog signal (stale-protective-hold, EI-18653608066559541 class): pot "${c.installSlug}" has a standing ` +
          `hold (${holdKind}: potHeld=${c.potHeld}, kettleStarted=${c.kettleStarted}) with NO steering directive at all, ` +
          `so nothing on record says who paused it, when, or why — and work is visibly piling up behind it. ${evidence} ` +
          `This is the pause-that-outlived-its-author shape (EI-16537 class), which the older text-matching gate could ` +
          `not see: with no directive there is no wording to contradict. A hold is a legit owner control — do NOT ` +
          `auto-resume. Reconcile deliberately, EITHER lift it (pot:set-steering { pauseNewWork:false } / kettle:start) ` +
          `OR document it (pot:set-steering { directive: "<why this pause stands>" }) — documenting it is what stops ` +
          `this signal, so an intentional long-lived pause silences it by becoming accountable rather than by being ignored.`
        : `Watchdog signal (stale-protective-hold, EI-13022 class): pot "${c.installSlug}" has a standing hold ` +
          `(${holdKind}: potHeld=${c.potHeld}, kettleStarted=${c.kettleStarted}) while its steering directive commands ` +
          `active work ("${c.directiveHead}"). ${evidence} ` +
          `A hold is a legit owner control — do NOT auto-resume; reconcile deliberately: either lift it ` +
          `(pot:set-steering { pauseNewWork:false } / kettle:start) or update the directive to say the pause is intended.`,
      severity: 'major' as const,
      kind: 'bug' as const,
      scope: `harness:${c.installSlug}`,
      paths: ['packages/operator-core/lib/owner-steering.ts', 'packages/operator-core/lib/harness/improvements/watchdog.ts'],
    });
  }
  return signals;
}

/** stale-protective-hold: pots with tick history whose hold contradicts a
 *  work-commanding directive for >= minHoldHours (default 2h). Fail-soft per pot. */
export async function collectStaleProtectiveHoldSignals(
  sql: Sql,
  workspaceId: string,
  opts: { minHoldHours?: number } = {},
): Promise<WatchdogSignal[]> {
  const minHoldHours = opts.minHoldHours ?? 2;
  interface Row {
    slug: string;
    frontier_depth: number | null;
    hours_since_placement: number | null;
    window_hours: number | null;
    kettle_hours_since_fire: number | null;
  }
  const rows = await sql<Row[]>`
    WITH pots AS (
      SELECT pot_slug AS slug,
             max(tick_at) FILTER (WHERE placements > 0) AS last_placement_at,
             min(tick_at) AS oldest_tick,
             (array_agg(frontier_depth ORDER BY tick_at DESC))[1] AS frontier_depth
        FROM harness_shared.pot_throughput_ticks
       WHERE workspace_id = ${workspaceId}
         AND tick_at > now() - interval '24 hours'
       GROUP BY 1)
    SELECT p.slug,
           p.frontier_depth,
           EXTRACT(EPOCH FROM (now() - p.last_placement_at)) / 3600.0 AS hours_since_placement,
           EXTRACT(EPOCH FROM (now() - p.oldest_tick)) / 3600.0 AS window_hours,
           EXTRACT(EPOCH FROM (now() - k.last_fired_at)) / 3600.0 AS kettle_hours_since_fire
      FROM pots p
      LEFT JOIN harness_shared.autoloop_state k
        ON k.workspace_id = ${workspaceId} AND k.harness_slug = p.slug AND k.role = 'kettle'
     LIMIT 10`;
  const { getOwnerSteering, directiveSuggestsResume, isPausedNow } = await import('../../owner-steering');
  const { getOverwatchStarted } = await import('../../overwatch/control-state');
  const cands: StaleProtectiveHoldCandidate[] = [];
  for (const r of rows) {
    try {
      const steering = await getOwnerSteering(workspaceId, r.slug);
      const started = await getOverwatchStarted(workspaceId, r.slug);
      cands.push({
        installSlug: r.slug,
        potHeld: isPausedNow(steering, Date.now()),
        kettleStarted: started,
        workCommanded: directiveSuggestsResume(steering.directive),
        // getOwnerSteering already normalizes a blank/whitespace directive to null,
        // so this is a true "is there any recorded reason for the hold" bit.
        directivePresent: steering.directive != null,
        directiveHead: (steering.directive ?? '').slice(0, 140),
        frontierDepth: Number(r.frontier_depth ?? 0),
        hoursSinceLastPlacement: r.hours_since_placement == null ? null : Number(r.hours_since_placement),
        windowHours: Number(r.window_hours ?? 0),
        kettleHoursSinceFire: r.kettle_hours_since_fire == null ? null : Number(r.kettle_hours_since_fire),
      });
    } catch {
      /* fail-soft per pot — a broken steering read never kills the sweep */
    }
  }
  return staleProtectiveHoldSignalsFromCandidates(cands, minHoldHours);
}

interface StuckPlanRow { harness_slug: string; plan_slug: string; status: string; stale_hours: number }
/** Pure: stuck-plan rows → signals. */
export function stuckPlanSignalsFromRows(rows: StuckPlanRow[]): WatchdogSignal[] {
  return rows.map((r) => ({
    source: 'stuck-plan' as const,
    key: `stuck-plan:${r.harness_slug}:${r.plan_slug}`,
    title: `Plan ${r.plan_slug} appears stuck`,
    body:
      `Watchdog signal (stuck-plan): plan "${r.plan_slug}" (harness ${r.harness_slug}) has been '${r.status}' with ` +
      `no status update for ~${Math.round(r.stale_hours)}h — its run may be hung.`,
    severity: 'major' as const,
    kind: 'bug' as const,
    // Origin scope (P-032): a stuck plan belongs to ONE harness.
    scope: `harness:${r.harness_slug}`,
  }));
}
/** stuck-plan: a plan 'started'/'paused' with no update for > staleHours (default 24h). */
export async function collectStuckPlanSignals(sql: Sql, workspaceId: string, staleHours = 24): Promise<WatchdogSignal[]> {
  const rows = await sql<StuckPlanRow[]>`
    SELECT harness_slug, plan_slug, status,
           EXTRACT(EPOCH FROM (now() - updated_at)) / 3600.0 AS stale_hours
      FROM harness_shared.harness_plan_status
     WHERE workspace_id = ${workspaceId}
       AND status IN ('started', 'paused')
       AND updated_at < now() - make_interval(hours => ${staleHours})
     ORDER BY updated_at ASC
     LIMIT 10`;
  return stuckPlanSignalsFromRows(rows);
}

/**
 * Pure (audit P-008): classify one spawn failure message into a coarse cause
 * class. The single global `failed-spawns` key conflated unrelated causes — a
 * resolved timeout-storm item would mask a new auth breakage. Keying the signal
 * by DOMINANT class gives one capture per diagnosable problem.
 */
export type SpawnErrorClass =
  | 'backpressure'
  | 'reclaimed'
  | 'context-overflow'
  | 'timeout'
  | 'infra-loss'
  | 'network'
  | 'auth'
  | 'missing-file'
  | 'config'
  | 'other';
export function classifySpawnError(message: string | null | undefined): SpawnErrorClass {
  const m = message ?? '';
  // Fleet infra-reclaim (EI-6018): a `running` row settled `failed` by the spawn-reclaim floor —
  // the boot reconcile ('reclaimed at operator boot: …', EI-2186), the orphan sweep
  // ('reclaimed: … heartbeat stale / child process confirmed dead / prior operator incarnation',
  // EI-85), or the wedge reaper ('reclaimed: …', WI-233). All are EXPECTED housekeeping that FREES
  // the concurrency ceiling after a host/process restart or a hung child — NOT a spawn failure the
  // loop can fix. They are all `reclaimed`-prefixed by construction. Checked FIRST (alongside
  // backpressure) so the message never falls through to 'other' — the 15/29 "other" rows that
  // re-filed this non-actionable bug every cadence (mirrors the EI-5485 backpressure exclusion).
  if (/^\s*reclaimed[\s:]/i.test(m)) return 'reclaimed';
  // Admission-ceiling rejection (D-004 backpressure): `spawn rejected: N … already running
  // (fleet ceiling … — owner maxBees/maxSimultaneousAgents) … events:await spawn-slot:freed …`.
  // Recorded as a `failed` row for queue+await durability, but it is EXPECTED, working-as-designed
  // backpressure — NOT a spawn failure. Checked FIRST so its message never falls through to a real
  // failure class (and so failedSpawnSignalsFromRows can exclude it — EI-5485).
  if (/fleet ceiling|spawn-slot:freed|max(?:Bees|SimultaneousAgents)|already running \(fleet/i.test(m)) return 'backpressure';
  // EI-8051: no-turn spawn diagnostics can carry the more specific context-window
  // death in rawStdoutTail ("Autocompact is thrashing", "Prompt is too long", etc.).
  // Keep these out of the generic 'other' bucket: they are launch/prompt-size bugs,
  // not gateway capacity, host loss, or wall-clock timeouts.
  if (
    /autocompact(?:ion)? is thrashing/i.test(m) ||
    /prompt is too long/i.test(m) ||
    /input (?:length )?is too long/i.test(m) ||
    /\bcontext[_ -]?length[_ -]?exceeded\b/i.test(m) ||
    /maximum context length/i.test(m) ||
    /input length and `?max_tokens`? exceed/i.test(m) ||
    /exceeds? the (?:model'?s )?maximum (?:context|(?:number of )?(?:input )?tokens)/i.test(m) ||
    /reduce the length of (?:the )?(?:messages|prompt|input)/i.test(m)
  ) return 'context-overflow';
  // EI-7520: EVERY no-turn diagnostic (invoke-outcome.ts `agentProducedTurn`) embeds a
  // literal `timedOut=<bool>` token. The generic `timed?\s*out` alternative below matches
  // the camelCase substring `timedOut`, so a `timedOut=false` death — a mid-turn gateway
  // stall / infra_loss, NOT a timeout — was mis-bucketed as 'timeout' (34/79 of the class
  // in a sampled 24h window), inflating it and CONFLATING it with real wall-clock timeouts
  // (the exact class-mixing that keying-by-cause exists to avoid — see the header comment).
  // A `timedOut=true` IS a genuine wall-clock kill → timeout; a `timedOut=false` must
  // classify by its real cause. So treat `=true` as a positive signal, and take the
  // diagnostic token out of the word-match so it can never false-positive on `=false`.
  if (/\btimed\s*out\s*=\s*true\b/i.test(m)) return 'timeout';
  const mNoTimedOutDiag = m.replace(/\btimed\s*out\s*=\s*(?:true|false)\b/gi, ' ');
  if (/timed?\s*out|timeout/i.test(mNoTimedOutDiag)) return 'timeout';
  // EI-8667: a no-turn INFRA-LOSS death (invoke-outcome.ts `infra_loss`) — the agent
  // reached the launcher, bootstrapped PG, then died BEFORE emitting a turn: a launcher-host
  // loss OR (more often) an upstream gateway stall / `API Error: Request rejected` / 429-storm
  // killing it mid-turn. invoke-outcome PREFIXES the persisted error `infra_loss:` and its
  // detail reads "returned HTTP <n> but the agent produced no turn". These are a DISTINCT,
  // diagnosable class — an infra/gateway problem — but with `timedOut=false` they matched NO
  // specific rule and fell through to 'other', re-filing this bug as "(other)" and conflating a
  // gateway-stall storm with genuinely-unknown failures (defeating the key-by-cause design).
  // Classify them explicitly so the signal keys `failed-spawns:infra-loss` with a self-diagnosing
  // title. Placed AFTER the timeout checks so a genuine `timedOut=true` wall-clock kill still
  // classifies 'timeout' (EI-7520); context-overflow/auth/usage get their OWN invoke-outcome
  // prefix (never `infra_loss:`) and are matched earlier, so nothing real is masked here.
  if (
    /^\s*infra_loss[\s:]/i.test(m) ||
    /returned HTTP \d+ but the agent produced no turn/i.test(m) ||
    /\bAPI Error:\s*Request rejected\b/i.test(m)
  ) return 'infra-loss';
  if (/econnrefused|econnreset|enotfound|socket|network|fetch failed/i.test(m)) return 'network';
  if (/auth|credential|api.?key|401|403|unauthorized|forbidden/i.test(m)) return 'auth';
  if (/enoent|no such file|file not found/i.test(m)) return 'missing-file';
  if (/invalid|config|schema|parse|json/i.test(m)) return 'config';
  return 'other';
}

interface FailedSpawnRow {
  error_message: string | null;
  started_at: string | Date | null;
  harness_slug?: string | null;
  workspace_id?: string | null;
}

/**
 * Pure (audit P-008 + P-005): failed-spawn rows → at most ONE signal, keyed by the
 * DOMINANT error class (`failed-spawns:<class>`), with the full per-class
 * breakdown in the body and `latestAt` = the newest failure. A different dominant
 * cause next week gets a DIFFERENT key — a resolved timeout item no longer
 * swallows a fresh auth breakage.
 */
export function failedSpawnSignalsFromRows(
  rows: FailedSpawnRow[],
  opts: { windowHours?: number; minCount?: number } = {},
): WatchdogSignal[] {
  const windowHours = opts.windowHours ?? 6;
  const minCount = opts.minCount ?? 5;
  // Drop EXPECTED, non-actionable rows so they never inflate the signal or mask a genuine cause:
  //  • backpressure — an admission-ceiling rejection recorded as a `failed` row for D-004
  //    queue+await durability; the caller awaits spawn-slot:freed and retries (EI-5485: 57/69
  //    "other" were ceiling rejections).
  //  • reclaimed — a fleet infra-reclaim (boot reconcile / orphan sweep / wedge reaper) that FREES
  //    the ceiling after a host restart or hung child; expected housekeeping, not a spawn failure
  //    the loop can fix (EI-6018: 15/29 "other" were `reclaimed`-prefixed boot-reconcile rows,
  //    re-filing this non-actionable bug every cadence).
  //  • ephemeral-benchmark / test-fixture harness — a torn-down benchmark instance (P-006) OR the
  //    literal `test-harness` fixture slug used by `agent-chats-messages.test.ts` (EI-8890: a
  //    not-fully-pinned test-isolation leak occasionally lets a real run of that suite write a
  //    LIVE row here carrying its hardcoded fixture error string, instead of staying inside its
  //    mocked chat-spawn-tracking). This is a MITIGATION for `test-harness`, not the underlying
  //    fix — the leak itself is still unresolved and still writes the row; we just stop it from
  //    re-triggering this watchdog. Never broadens to any REAL harness slug.
  const failures = rows.filter((r) => {
    const cls = classifySpawnError(r.error_message);
    return cls !== 'backpressure' && cls !== 'reclaimed' && !isEphemeralBenchmarkHarnessSlug(r.harness_slug);
  });
  if (failures.length < minCount) return [];
  const byClass = new Map<SpawnErrorClass, { n: number; sample: string | null }>();
  let latestAt: string | undefined;
  for (const r of failures) {
    const cls = classifySpawnError(r.error_message);
    const agg = byClass.get(cls) ?? { n: 0, sample: null };
    agg.n += 1;
    if (!agg.sample && r.error_message) agg.sample = r.error_message;
    byClass.set(cls, agg);
    const iso = toIsoOrUndefined(r.started_at);
    if (iso && (!latestAt || iso > latestAt)) latestAt = iso;
  }
  const ranked = [...byClass.entries()].sort((a, b) => b[1].n - a[1].n);
  const [dominantClass, dominant] = ranked[0];
  const breakdown = ranked.map(([cls, v]) => `${cls}: ${v.n}`).join(', ');
  return [{
    source: 'failed-spawn',
    key: `failed-spawns:${dominantClass}`,
    title: `Agent spawns are failing repeatedly (${dominantClass})`,
    body:
      `Watchdog signal (failed-spawn): ${failures.length} agent spawn(s) failed in the last ${windowHours}h; ` +
      `the dominant cause class is "${dominantClass}" (${dominant.n}/${failures.length}).\n\n` +
      `Class breakdown: ${breakdown}\n\nSample (${dominantClass}): ${(dominant.sample ?? '').slice(0, 600) || '(none captured)'}`,
    severity: failures.length >= 20 ? 'major' : 'minor',
    kind: 'bug',
    latestAt,
  }];
}

/** failed-spawn: AGGREGATE — agent spawns that failed in the window, keyed by dominant cause class (P-008). */
export async function collectFailedSpawnSignals(sql: Sql, opts: CollectOptions = {}): Promise<WatchdogSignal[]> {
  const windowHours = opts.failedSpawnWindowHours ?? 6;
  const rows = await sql<FailedSpawnRow[]>`
    SELECT error_message, started_at, harness_slug, workspace_id
      FROM harness_shared.spawned_agents
     WHERE status = 'failed' AND started_at > now() - make_interval(hours => ${windowHours})
     ORDER BY started_at DESC
     LIMIT 500`;
  return failedSpawnSignalsFromRows(rows, { windowHours, minCount: opts.failedSpawnMinCount });
}

interface ExpiredLeaseRow { expires_ts: string | Date }

/**
 * Pure (audit P-006 + P-005): expired-lease rows → at most ONE signal, counting
 * only leases that expired within the RECENCY WINDOW (default 7 days). Before
 * this the count was all-time, so a pile of ancient leases made the signal fire
 * forever and the filed item perpetually re-file after resolve. `latestAt` = the
 * newest expiry, so post-resolve re-files need a lease that expired AFTER the
 * resolution (D-002). The collector DETECTS; stale-claim GC belongs to the
 * plan-item lifecycle, not here.
 */
export function expiredLeaseSignalsFromRows(
  rows: ExpiredLeaseRow[],
  opts: { windowDays?: number; minCount?: number; nowMs?: number } = {},
): WatchdogSignal[] {
  const windowDays = opts.windowDays ?? 7;
  const minCount = opts.minCount ?? 15;
  const nowMs = opts.nowMs ?? Date.now();
  const cutoffMs = nowMs - windowDays * 86_400_000;
  const recent: number[] = [];
  for (const r of rows) {
    const ms = r.expires_ts instanceof Date ? r.expires_ts.getTime() : Date.parse(r.expires_ts);
    if (Number.isFinite(ms) && ms >= cutoffMs && ms <= nowMs) recent.push(ms);
  }
  if (recent.length < minCount) return [];
  const oldestHours = Math.round((nowMs - Math.min(...recent)) / 3_600_000);
  return [{
    source: 'expired-lease',
    key: 'expired-leases',
    title: 'Many plan-item claims have expired (abandoned work piling up)',
    body:
      `Watchdog signal (expired-lease): ${recent.length} plan-item claim(s) expired within the last ${windowDays}d ` +
      `(the holder died/vanished without releasing). The oldest recent expiry is ~${oldestHours}h stale — a sign ` +
      `lease cleanup or agent liveness needs attention.`,
    severity: 'minor',
    kind: 'bug',
    latestAt: new Date(Math.max(...recent)).toISOString(),
  }];
}

/**
 * expired-lease: AGGREGATE — plan-item claims whose lease expired RECENTLY and
 * whose holder is genuinely GONE (P-006 window).
 *
 * EI-530: the old query counted EVERY expired-but-present claim, regardless of
 * holder liveness — so a long-lived session that's still heartbeating but let a
 * lease lapse (which the reclaim sweep CORRECTLY skips) was falsely counted as
 * "the holder died/vanished", firing this signal forever. The watchdog now joins
 * the SAME alias-aware liveness rule + grace the reclaim sweep uses
 * (`reclaimExpiredPlanItemClaims`, plan-items/stale-claims.ts), so it counts ONLY
 * the set the sweep targets but hasn't reaped — i.e. genuine abandonment the GC
 * is failing to clean. If the sweep is healthy this is ~0; a sustained non-zero
 * count is the real "lease GC / liveness needs attention" signal the body
 * describes. Live-holder lapses are a claim-discipline concern (EI-483), not this.
 */
export async function collectExpiredLeaseSignals(sql: Sql, opts: CollectOptions = {}): Promise<WatchdogSignal[]> {
  const windowDays = opts.expiredLeaseWindowDays ?? 7;
  const graceSec = Math.max(1, Math.round((opts.expiredLeaseGraceMs ?? STALE_PLAN_CLAIM_GRACE_MS) / 1000));
  const rows = await sql<ExpiredLeaseRow[]>`
    WITH live_holder AS (
      -- Mirror reclaimExpiredPlanItemClaims's mig-225 alias-aware liveness join:
      -- fresh coord_presence rows…
      SELECT owner_id AS alias
        FROM harness_shared.coord_presence
       WHERE heartbeat_at IS NOT NULL
         AND (now() - heartbeat_at) < make_interval(secs => ${graceSec})
      UNION
      -- …plus every alias of a RUNNING nursery row with a fresh heartbeat.
      SELECT a.alias
        FROM harness_shared.spawned_agents n
        CROSS JOIN LATERAL (VALUES (n.spawn_id), (n.session_owner), (n.run_id)) AS a(alias)
       WHERE n.status IN ('running', 'restarting')
         AND n.heartbeat_at IS NOT NULL
         AND (now() - n.heartbeat_at) < make_interval(secs => ${graceSec})
         AND a.alias IS NOT NULL AND a.alias <> ''
    )
    SELECT c.expires_ts
      FROM harness_shared.plan_item_claims c
     WHERE c.expires_ts < now() - make_interval(secs => ${graceSec})
       AND c.expires_ts > now() - make_interval(days => ${windowDays})
       AND NOT EXISTS (SELECT 1 FROM live_holder h WHERE h.alias = c.owner)
     ORDER BY c.expires_ts DESC
     LIMIT 500`;
  return expiredLeaseSignalsFromRows(rows, { windowDays, minCount: opts.expiredLeaseMinCount });
}

interface EscalationRow { harness_slug: string; phase: string | null }
/** Pure: unresolved-escalation rows → signals. */
export function escalationSignalsFromRows(rows: EscalationRow[]): WatchdogSignal[] {
  return rows.map((r) => ({
    source: 'unresolved-escalation' as const,
    key: `escalation:${r.harness_slug}:${r.phase ?? ''}`,
    title: `Unresolved escalation in harness ${r.harness_slug}`,
    body:
      `Watchdog signal (unresolved-escalation): harness ${r.harness_slug}` +
      (r.phase ? ` (phase ${r.phase})` : '') +
      ` has a recorded escalation with no supervisor resolution yet.`,
    severity: 'major' as const,
    kind: 'bug' as const,
    // Origin scope (P-032): an escalation is attributable to ONE harness.
    scope: `harness:${r.harness_slug}`,
  }));
}
/** The two green-checkpoint-gate escalation phases (release-actions.ts's in-routine
 *  `GATE_STALL_PHASE` + green-stall-watchdog.ts's standalone `WATCHDOG_PHASE`) — the
 *  ONLY phases whose clear path keys on a LIVE `system:green-checkpoint` routine
 *  (EI-8396), so they're the only ones this dead-install guard applies to.
 *  EXPORTED (EI-9205): the escalation/resolve endpoint (supervisor-actions.ts) fans a
 *  triage note out to every phase in this group when the requested phase is one of
 *  them — the two phases represent the SAME conceptual condition but are collected
 *  independently by collectEscalationSignals below, so annotating only one left the
 *  other free to re-fire a near-duplicate unresolved-escalation work-item minutes
 *  later (observed: EI-9197 → EI-9203). */
export const GREEN_CHECKPOINT_ESCALATION_PHASES = ['green-checkpoint-stall', 'green-checkpoint-watchdog'];

/** unresolved-escalation: a harness escalation with no supervisor_notes (unaddressed).
 *  EI-8396: a green-checkpoint-{stall,watchdog} escalation row is cleared by
 *  trackGateStall / green-stall-watchdog.ts matching `harness_slug = ctx.installSlug`
 *  (release-actions.ts) — so a row that survives an install-slug RENAME (e.g. the
 *  papercup → papercusp rename left a row keyed under the dead `papercup` slug) can
 *  NEVER be cleared by the live install and re-fires this collector every tick
 *  forever, re-dispatching an auto-implement worker each time (EI-7690 and the
 *  EI-7557/7569/7575 storm). A dead install-slug has no LIVE `system:green-checkpoint`
 *  routine (the rename leaves the row un-migrated) — skip exactly those two phases
 *  when that's true, so a genuinely dead install-slug's stale escalation can't loop
 *  forever; every OTHER phase (and a live install's green-checkpoint escalation) is
 *  untouched. */
export async function collectEscalationSignals(sql: Sql, workspaceId: string): Promise<WatchdogSignal[]> {
  const rows = await sql<EscalationRow[]>`
    SELECT e.harness_slug, e.phase
      FROM harness_shared.harness_escalations e
     WHERE e.workspace_id = ${workspaceId}
       AND COALESCE(e.escalation, '') <> ''
       AND COALESCE(e.supervisor_notes, '') = ''
       AND NOT (
         e.phase = ANY(${GREEN_CHECKPOINT_ESCALATION_PHASES})
         AND NOT EXISTS (
           SELECT 1 FROM harness_shared.routines r
            WHERE r.workspace_id = ${workspaceId}
              AND r.install_slug = e.harness_slug
              AND r.name = 'green-checkpoint'
              AND r.active
         )
       )
     LIMIT 10`;
  return escalationSignalsFromRows(rows);
}

/**
 * WI-38327 — the RECURRENCE GUARD for the github-bridge owner-gated egress block.
 *
 * THE INCIDENT: git-sync recorded a hard, permanent push rejection perfectly
 * (`github_bridge.needs_owner = true`, machine-readable, correct) and told nobody.
 * 899 commits — the whole fleet's ~17h of work — existed only on one box for ~26h,
 * because the escalation was written to `harness_shared.harness_escalations` and
 * NOTHING pages off that table. The fix (github-divergence.ts) added the two
 * missing rails: notifyAttention + broadcastSevereEvent beside the row. This is
 * the invariant that makes the fix STAY fixed.
 *
 * ── WHY THIS IS NOT `unresolved-escalation` ───────────────────────────────────
 * `collectEscalationSignals` above fires on ANY escalation row lacking supervisor
 * notes, and it asks a TRIAGE question ("has a human written a note?"). It fires
 * identically whether or not an owner-facing alarm was ever raised, and it clears
 * the moment someone adds a note even if no alarm ever existed. This collector
 * asks the DELIVERY question — did the owner rail actually receive this? — which
 * is the one the incident turned on and the one nothing else can answer.
 *
 * ── THE FALSIFIER IS THE OWNER RAIL, NOT THE LATCH ────────────────────────────
 * A guard that only read `needs_owner_alerted` back out of the escalation body
 * would be self-referential: `recordDivergenceVerdict` persists that latch and
 * THEN delivers, with both delivery legs in their own try/catch (deliberately —
 * see WI-38327's design note 1). So a latch reading `alerted: true` is the
 * writer's INTENT, not evidence of delivery. The real evidence is the
 * `harness_shared.attention_notifications` audit row, which `notifyAttention`
 * records BEFORE attempting either channel (WI-36644) and which therefore exists
 * iff the owner rail was genuinely reached. Matching on the CAUSE as well as the
 * conditionKey is what lets this work with no time window at all: the cause
 * string is stable for the life of one episode, so a three-week block matches its
 * own three-week-old notification instead of ageing out into a false violation.
 *
 * ── FAIL-CLOSED ON A MISSING LATCH, DELIBERATELY ──────────────────────────────
 * A `needs_owner: true` row carrying NO latch fields at all is treated as past
 * the threshold rather than as "not yet debounced". That is the pre-fix shape
 * (and, more importantly, the shape a future regression would reintroduce by
 * dropping the latch), so reading it as benign is exactly how this guard would
 * fail open — silent precisely when the thing it guards has been removed. The
 * cost of the other direction is one early capture during a deploy window.
 */
export const BRIDGE_NEEDS_OWNER_CONDITION_PREFIX = 'github-bridge-needs-owner:';

interface BridgeNeedsOwnerRow {
  harness_slug: string;
  /** `escalation.needs_owner_cause` — null when the row predates the latch. */
  cause: string | null;
  /** `escalation.needs_owner_sweeps` — null when the row predates the latch. */
  sweeps: number | string | null;
  /** `escalation.needs_owner_alerted` — the writer's INTENT, not proof of delivery. */
  alerted: boolean | null;
  /** Did the owner rail actually record this alarm? The load-bearing column. */
  owner_alerted: boolean;
}

/** Pure: un-paged owner-gated bridge blocks → signals. */
export function bridgeNeedsOwnerSignalsFromRows(rows: BridgeNeedsOwnerRow[]): WatchdogSignal[] {
  return rows
    .filter((r) => !r.owner_alerted)
    .filter((r) => {
      // No latch at all ⇒ fail closed (see the header). With a latch, debounce on it.
      if (r.sweeps == null) return true;
      const sweeps = typeof r.sweeps === 'string' ? Number.parseInt(r.sweeps, 10) : r.sweeps;
      return Number.isFinite(sweeps) && sweeps >= GITHUB_BRIDGE_NEEDS_OWNER_MIN_SWEEPS;
    })
    .map((r) => ({
      source: 'bridge-needs-owner-unalerted' as const,
      key: `bridge-needs-owner:${r.harness_slug}`,
      title: `GitHub bridge is owner-gated on ${r.harness_slug} with no owner-facing alarm`,
      body:
        `Watchdog signal (bridge-needs-owner-unalerted): git-sync's GitHub bridge for harness ` +
        `${r.harness_slug} has recorded needs_owner=true — it has named its OWN state as ` +
        `owner-gated — but no owner-rail notification carrying condition key ` +
        `"${BRIDGE_NEEDS_OWNER_CONDITION_PREFIX}${r.harness_slug}" was ever recorded in ` +
        `harness_shared.attention_notifications.\n\n` +
        `Nothing reaches the one party who can clear this, so commits accumulate locally with ` +
        `no second copy anywhere (WI-38327: 899 commits / ~17h of fleet work, unseen for ~26h).\n\n` +
        `Latch state on the escalation row: alerted=${r.alerted ?? '(absent)'}, ` +
        `sweeps=${r.sweeps ?? '(absent)'}, cause=${r.cause ?? '(absent)'}.\n` +
        (r.sweeps == null
          ? `The latch fields are ABSENT — either this row predates the WI-38327 fix, or that ` +
            `fix has regressed and recordDivergenceVerdict is no longer maintaining the latch.\n`
          : r.alerted
            ? `The latch says it DID alert, so the alarm decision fired and the delivery leg ` +
              `swallowed its failure — check notifyAttention's rail, not the decider.\n`
            : `The latch says it has NOT alerted despite passing the ` +
              `${GITHUB_BRIDGE_NEEDS_OWNER_MIN_SWEEPS}-sweep threshold — the decider itself is not firing.\n`),
      severity: 'critical' as const,
      kind: 'bug' as const,
      scope: `harness:${r.harness_slug}`,
      findingClass: 'egress-alarm:owner-gated-unpaged',
    }));
}

/**
 * bridge-needs-owner-unalerted: a github-bridge escalation the routine ITSELF marked
 * owner-gated, with no matching owner-rail notification. Zero rows == satisfied.
 */
export async function collectBridgeNeedsOwnerSignals(sql: Sql, workspaceId: string): Promise<WatchdogSignal[]> {
  const rows = await sql<BridgeNeedsOwnerRow[]>`
    -- MATERIALIZED is load-bearing, not a hint: escalation is a TEXT column and only
    -- SOME phases put JSON in it (the escalation-spike path writes plain prose, and a
    -- non-JSON row exists on this box today). A cast in the same query level as its own
    -- IS JSON guard can be evaluated BEFORE that guard — SQL predicates are unordered —
    -- and one such row would abort the whole collector. A collector that throws is a
    -- guard that is silent, which is the exact failure this invariant exists to catch,
    -- so the fence keeps the cast strictly downstream of the rows that survive the test.
    WITH parseable AS MATERIALIZED (
      SELECT e.harness_slug, e.mtime_ms, e.escalation
        FROM harness_shared.harness_escalations e
       WHERE e.workspace_id = ${workspaceId}
         AND e.phase = 'github-bridge'
         AND e.escalation IS JSON OBJECT
    ),
    gated AS (
      SELECT p.harness_slug,
             p.mtime_ms,
             (p.escalation::jsonb)->>'needs_owner_cause' AS cause,
             (p.escalation::jsonb)->>'needs_owner_sweeps' AS sweeps,
             ((p.escalation::jsonb)->>'needs_owner_alerted')::boolean AS alerted
        FROM parseable p
       WHERE ((p.escalation::jsonb)->>'needs_owner') = 'true'
    )
    SELECT g.harness_slug, g.cause, g.sweeps, g.alerted,
           EXISTS (
             SELECT 1
               FROM harness_shared.attention_notifications n
              WHERE n.workspace_id = ${workspaceId}
                AND n.data->>'conditionKey' = ${BRIDGE_NEEDS_OWNER_CONDITION_PREFIX} || g.harness_slug
                -- Cause-matched, so ONE episode matches its own alarm however old it is,
                -- and a NEW cause (a different owner-actionable signal) is not covered by
                -- the previous episode's page. A latch-less row cannot cause-match, so it
                -- falls back to the conditionKey alone rather than firing on that basis.
                AND (g.cause IS NULL OR n.data->>'cause' = g.cause)
           ) AS owner_alerted
      FROM gated g
     -- Deterministic membership under the cap (EI-19417016857494865): oldest first, slug
     -- as a total-order tiebreak, so a still-violating harness can never drop out of one
     -- tick and reappear the next — the property an absence-based auto-close depends on.
     ORDER BY g.mtime_ms ASC, g.harness_slug ASC
     LIMIT 50`;
  return bridgeNeedsOwnerSignalsFromRows(rows);
}

interface CircuitOpenRow {
  harness_slug: string;
  role: string;
  consecutive_errors: number;
  last_status: string | null;
  /** The matching `harness_shared.routines.active` for this (workspace, role) — from a LEFT
   *  JOIN, so `null` means no matching routine row exists (a fixed system role, not a
   *  loop:arm-materialized routine). `false` = the routine engine already auto-paused this
   *  fire path (a resolved condition, not a live one) — the ONLY value that suppresses. */
  routine_active?: boolean | null;
  /** The matching `harness_shared.routines.target_owner_id` — non-null marks an EPHEMERAL
   *  `loop:arm` OWNER loop (`loop-su-<uuid>` role, `target_role = system:loop-wake`) that is
   *  owner-witnessed AND auto-terminated by the reconcile dead-owner guard with its OWN
   *  escalation. `null`/absent = a fixed system role (director/gym-cycle/overwatch/…). */
  routine_target_owner_id?: string | null;
}
/** Pure: is this row a stuck-fire-path we must NOT re-escalate — because the routine engine has
 *  already RESOLVED it (auto-paused, `routine_active === false`) or because it is an EPHEMERAL
 *  `loop:arm` OWNER loop managed end-to-end by the reconcile dead-owner guard? A loop:arm loop is
 *  identified by EITHER a populated `routine_target_owner_id` (the JOIN marker) OR a `loop-`-prefixed
 *  role (`isLoopArmOwnerRole` — the join-independent structural marker that ALSO catches an ORPHANED
 *  row whose routine was GC'd, EI-7220: the target_owner_id JOIN goes NULL and the owner-id marker
 *  alone fails OPEN, so a dead `loop-su-<uuid>` row leaks a "stuck in error-backoff" EI). Mirrors
 *  `selectChronicFailures` (autoloop-chronic-failure) so BOTH watchdogs stop flooding the same dead
 *  `loop-su-<uuid>` row with duplicate tickets (EI-6721: a dead, auto-paused loop:arm loop kept
 *  re-firing EIs the chronic sweep already suppressed but this collector did not). A fixed system
 *  role (`routine_active: null`, no owner-id, non-`loop-` name) is NOT suppressed — fail-open, never
 *  silently drop an unknown state. */
export function isResolvedFirePath(
  r: Pick<CircuitOpenRow, 'routine_active' | 'routine_target_owner_id'> & { role?: string | null },
): boolean {
  const isLoopArmOwner =
    (r.routine_target_owner_id != null && r.routine_target_owner_id !== '') || isLoopArmOwnerRole(r.role);
  return r.routine_active === false || isLoopArmOwner;
}
/** Pure: error-backoff fire-state rows → signals. Rows the routine engine has already resolved
 *  (auto-paused) or that are ephemeral loop:arm owner loops are dropped (see `isResolvedFirePath`). */
export function circuitOpenSignalsFromRows(rows: CircuitOpenRow[]): WatchdogSignal[] {
  return rows
    .filter((r) => !isResolvedFirePath(r))
    .map((r) => ({
      source: 'fire-circuit-open' as const,
      key: `circuit:${r.harness_slug}:${r.role}`,
      title: `Role fire-path for ${r.harness_slug}/${r.role} is stuck in error-backoff`,
      body:
        `Watchdog signal (fire-circuit-open): the autoloop fire path for ${r.harness_slug}/${r.role} has failed ` +
        `${r.consecutive_errors} consecutive times — the fire gate is backing it off, so this role is effectively ` +
        `not running on its cadence until the underlying error is fixed (or autoloop:control reset-errors).` +
        `\n\nLast status: ${(r.last_status ?? '').slice(0, 400) || '(none recorded)'}`,
      severity: 'major' as const,
      kind: 'bug' as const,
      // Origin scope (P-032): a stuck role fire-path belongs to ONE harness.
      scope: `harness:${r.harness_slug}`,
    }));
}
/**
 * fire-circuit-open: a role fire-path (a role-target routine or autoloop trigger)
 * whose `autoloop_state.consecutive_errors` shows it repeatedly failing — the
 * fire gate (autoloop P-009) backs it off, so the role silently stops running on
 * its cadence. The `recordFire` error path was otherwise invisible to the
 * watchdog: `routine-failure` only sees system-action `metadata.last_error`.
 * Recency-gated so a long-dead historical row doesn't fire forever.
 *
 * EI-6721: LEFT JOIN `harness_shared.routines` and DROP a row whose routine is already
 * auto-paused (`active = false`) or is an ephemeral `loop:arm` OWNER loop (`target_owner_id`
 * non-null). Both are managed by the reconcile dead-owner guard, which fires its OWN escalation
 * — so re-filing "stuck in error-backoff" here is a duplicate that floods the queue for a dead
 * `loop-su-<uuid>` session (EI-6864/6912/6994/7127/7257/7386 all re-created for ONE dead loop).
 * This mirrors the exclusions `autoloop-chronic-failure`'s `selectChronicFailures` already applies.
 * EI-7220: the `target_owner_id` JOIN goes NULL once the routine row is GC'd, so an ORPHANED
 * `loop-<uuid>` autoloop_state row fails OPEN and leaks a signal — the `s.role NOT LIKE 'loop-%'`
 * clause (and `isLoopArmOwnerRole` in `circuitOpenSignalsFromRows`) is the join-independent belt.
 */
export async function collectCircuitOpenSignals(
  sql: Sql,
  workspaceId: string,
  opts: { minConsecutiveErrors?: number; recentHours?: number } = {},
): Promise<WatchdogSignal[]> {
  const minErrors = opts.minConsecutiveErrors ?? 5;
  const recentHours = opts.recentHours ?? 24;
  const rows = await sql<CircuitOpenRow[]>`
    SELECT s.harness_slug, s.role, s.consecutive_errors::int, s.last_status,
           r.active AS routine_active, r.target_owner_id AS routine_target_owner_id
      FROM harness_shared.autoloop_state s
 LEFT JOIN harness_shared.routines r
        ON r.name = s.role AND r.workspace_id = s.workspace_id
     WHERE s.workspace_id = ${workspaceId}
       AND s.consecutive_errors >= ${minErrors}
       AND s.last_fired_at > now() - make_interval(hours => ${recentHours})
       AND (r.active IS DISTINCT FROM false)
       AND (r.target_owner_id IS NULL OR r.target_owner_id = '')
       AND s.role NOT LIKE 'loop-%'
     ORDER BY s.consecutive_errors DESC
     LIMIT 10`;
  return circuitOpenSignalsFromRows(rows);
}

// ── hive-loop invariant monitors (hive-loop-e2e-testing-2026-06-10 P-010) ────
// The loop's liveness/hygiene oracles as standing monitors. Each is a
// CONSERVATIVE is-broken read over the loop's own state; violations file
// through the same captureImprovement core (tagged + cross-tick deduped) —
// the plan's "issues:create (tagged, deduped)" sink, on the improvements
// surface the papercusp-internal loop already routes to.

interface StalledFeatureRow {
  harness_slug: string;
  feature_id: string;
  updated_ts: number | string;
  /** SQL supplies this; omitted by older pure callers for backwards compatibility. */
  blueprint_wired?: boolean;
}
/** Pure: stalled dispatchable features → ONE aggregate signal per harness. */
export function stalledFeatureSignalsFromRows(
  rows: StalledFeatureRow[],
  opts: { staleHours?: number; nowMs?: number } = {},
): WatchdogSignal[] {
  const staleHours = opts.staleHours ?? 12;
  const nowMs = opts.nowMs ?? Date.now();
  const byHarness = new Map<string, { ids: string[]; oldestMs: number }>();
  for (const r of rows) {
    // A harness with no projected blueprint has no autonomous dispatch path.
    // Its backlog is expected manual/fleet work, not a stalled pipeline.
    if (r.blueprint_wired === false) continue;
    const g = byHarness.get(r.harness_slug) ?? { ids: [], oldestMs: nowMs };
    g.ids.push(r.feature_id);
    const ms = Number(r.updated_ts);
    if (Number.isFinite(ms) && ms < g.oldestMs) g.oldestMs = ms;
    byHarness.set(r.harness_slug, g);
  }
  return [...byHarness.entries()].map(([slug, g]) => ({
    source: 'stalled-feature' as const,
    key: `stalled:${slug}`,
    title: `Dispatchable work in harness ${slug} is not being picked up`,
    body:
      `Watchdog signal (stalled-feature): ${g.ids.length} dispatchable feature(s) in ${slug} have had no ` +
      `pipeline turn for > ${staleHours}h (oldest ~${Math.round((nowMs - g.oldestMs) / 3_600_000)}h): ` +
      `${g.ids.slice(0, 5).join(', ')}${g.ids.length > 5 ? ', …' : ''}. No live pipeline owns them, so the ` +
      `autonomous loop (routine tick → blueprint-run → dispatch) is not reaching this harness — check ` +
      `autoloop:status, the harness's bp-schedule routine, and the orchestrator scope env.`,
    severity: 'major' as const,
    kind: 'bug' as const,
    // Origin scope (P-032): one aggregate signal per harness — attributable to it.
    scope: `harness:${slug}`,
  }));
}
/**
 * stalled-feature: an UNCLAIMED feature the dispatcher SHOULD be running —
 * NEEDS_WORK status, kind=feature, plan-gate satisfied, no assignee — untouched
 * for N hours with no live (PENDING/ENQUEUED) pipeline owning it. The loop's
 * liveness oracle ("an unclaimed queued feature reaches a terminal state") as a
 * standing monitor. The dbos-schema guard mirrors durableOwnedFeatureIdsPg:
 * schema absent → no live-pipeline carve-out (every stalled row reports).
 *
 * EI-8781: a feature with a live `taken_by` assignee is EXCLUDED here — a
 * claimed-but-non-progressing feature is the separate stalled-claim collector's
 * domain (below); without this exclusion an owner-directed claim (e.g. a human
 * session working a feature directly) double-counted as "the autonomous loop
 * isn't reaching this harness", which is false — the loop deliberately does not
 * auto-dispatch a claimed feature.
 */
export async function collectStalledFeatureSignals(
  sql: Sql,
  workspaceId: string,
  opts: CollectOptions = {},
): Promise<WatchdogSignal[]> {
  const staleHours = opts.stalledFeatureHours ?? 12;
  const reg = await sql<{ t: string | null }[]>`SELECT to_regclass('dbos.workflow_status') AS t`;
  const hasDbos = Boolean(reg[0]?.t);
  const rows = await sql<StalledFeatureRow[]>`
    SELECT w.harness_slug, w.feature_id, w.updated_ts,
           EXISTS (
             SELECT 1 FROM harness_shared.blueprints b
              WHERE b.workspace_id = w.workspace_id
                AND b.harness_slug = w.harness_slug
           ) AS blueprint_wired
      FROM harness_shared.work_items w
     WHERE w.workspace_id = ${workspaceId}
       AND w.item_kind = 'feature'
       -- work-item-status-full-unify P-007: the unified claimable token 'open' joins the
       -- stalled-detector set (feature 'todo'/'failing'->'open'); legacy spellings kept tolerant.
       AND w.status IN ('open', 'todo', 'failing', 'pending', 'failed')
       AND w.updated_ts < (extract(epoch from now()) * 1000 - ${staleHours} * 3600000)
       AND w.taken_by IS NULL
       AND (
         (w.metadata->>'source_plan') IS NULL
         OR (w.metadata->>'source_plan') IN (
           SELECT plan_slug FROM harness_shared.harness_plans
            WHERE workspace_id = ${workspaceId} AND harness_slug = w.harness_slug
              AND op_status = 'started'
         )
       )
       ${hasDbos
         ? sql`AND NOT EXISTS (
             SELECT 1 FROM dbos.workflow_status d
              WHERE d.workflow_uuid LIKE 'pipeline:' || w.harness_slug || ':' || w.feature_id || ':e%'
                AND d.status IN ('PENDING', 'ENQUEUED'))`
         : sql``}
     ORDER BY w.updated_ts ASC
     LIMIT 100`;
  return stalledFeatureSignalsFromRows(rows, { staleHours });
}

interface OrphanedSpawnRow { spawn_id: string; harness_slug: string | null; heartbeat_at: string | Date | null; started_at: string | Date }
/** Pure: lingering past-reclaim 'running' rows → ONE aggregate signal. */
export function orphanedSpawnSignalsFromRows(
  rows: OrphanedSpawnRow[],
  opts: { staleMinutes?: number } = {},
): WatchdogSignal[] {
  if (rows.length === 0) return [];
  const staleMinutes = opts.staleMinutes ?? 15;
  const sample = rows.slice(0, 5).map((r) => r.spawn_id).join(', ');
  return [{
    source: 'orphaned-spawn',
    key: 'orphaned-running-rows',
    title: 'Orphaned running nursery rows are evading the heartbeat reclaim',
    body:
      `Watchdog signal (orphaned-spawn): ${rows.length} spawned_agents row(s) are status='running'/'restarting' ` +
      `with a heartbeat > ${staleMinutes} min stale — well past the reclaim threshold, so the stale-heartbeat ` +
      `sweep (spawn-reclaim) is apparently not running or not freeing them. They poison the concurrency ceiling ` +
      `until reclaimed. Sample: ${sample}${rows.length > 5 ? ', …' : ''}.`,
    severity: 'major',
    kind: 'bug',
  }];
}
/**
 * orphaned-spawn: 'running' nursery rows whose heartbeat is stale far beyond
 * RECLAIM_STALE_MS (default 3×). The reclaim runs in-line on every spawn
 * attempt and on getSpawnHeadroom — rows lingering past the threshold mean the
 * hygiene path itself is broken (the loop's hygiene oracle as a monitor).
 * Distinct from failed-spawn (failure VOLUME) — this is reclaim NON-EXECUTION.
 */
export async function collectOrphanedSpawnSignals(
  sql: Sql,
  workspaceId: string,
  opts: CollectOptions = {},
): Promise<WatchdogSignal[]> {
  const staleMinutes = opts.orphanedSpawnStaleMinutes ?? 15;
  const rows = await sql<OrphanedSpawnRow[]>`
    SELECT spawn_id, harness_slug, heartbeat_at, started_at
      FROM harness_shared.spawned_agents
     WHERE workspace_id = ${workspaceId}
       AND status IN ('running', 'restarting')
       AND COALESCE(heartbeat_at, started_at) < now() - make_interval(mins => ${staleMinutes})
     ORDER BY COALESCE(heartbeat_at, started_at) ASC
     LIMIT 50`;
  return orphanedSpawnSignalsFromRows(rows, { staleMinutes });
}

interface StalledClaimRow {
  work_item_id: string | null;
  agent_id: string | null;
  harness_slug: string | null;
  detail: string | null;
  stalled_minutes: number | string | null;
  /**
   * EI-14763: the holder emitted native tool / lifecycle (agent_activity) or
   * coord/MCP (tool_invocations) activity within the stall window. A claim with
   * no item-scoped STATE transition in 30 min is NOT a stall when its holder is
   * demonstrably working (long-horizon su lanes hold a claim for hours while
   * running bash / sending coord). Such rows are dropped from the signal — a
   * heartbeat alone (holder_alive) is too weak; genuine abandonment is the
   * separate orphaned-claim case (dead/absent holder). Absent ⇒ not-active
   * (older callers behave exactly as before).
   */
  holder_active?: boolean | null;
  /**
   * EI-18633753937712900 (WI-3669 recurrence): the item is deliberately PARKED —
   * a `blocked` status, or payload._claimHold=true (WI-2797) — a considered
   * "nothing to do right now" disposition, NOT an abandoned/stuck claim, so
   * re-picking it is futile (a blocked item stays blocked). Such rows are dropped
   * from the signal. The SQL fetch also excludes these (one rule, two enforcement
   * points — mirrors holder_active). Absent ⇒ not-parked (older callers behave
   * exactly as before).
   */
  parked?: boolean | null;
}
/**
 * Pure (agent-activity-liveness-truth P-007, D-001): live-holder-but-no-progress
 * work-item claims → ONE aggregate signal. The recurrence guard for the incident
 * (a claim is not progress; a dead/stalled holder must never read as "covered").
 * Folds EI-2311 — re-dispatch-of-dead-holder: the durable cure is that the
 * RECONCILER frees these (P-003) AND this fires loudly while that leg is dark.
 */
export function stalledClaimSignalsFromRows(
  rows: StalledClaimRow[],
  opts: { minMinutes?: number } = {},
): WatchdogSignal[] {
  // EI-14763: a holder that is alive AND actively emitting tool/coord activity in
  // the window is not stalled (a claim is not progress, but neither is "no state
  // event in 30 min" a stall when the holder is demonstrably working). Genuine
  // abandonment (dead/absent holder) is the orphaned-claim case, covered
  // elsewhere. Drop active holders before the signal is built.
  rows = rows.filter((r) => r.holder_active !== true);
  // EI-18633753937712900 (WI-3669 recurrence): a deliberately PARKED claim — a
  // `blocked` status, or payload._claimHold=true (WI-2797) — is a considered
  // "nothing to do right now" disposition, not a stall to re-pick (re-picking a
  // blocked item is futile). Drop it defensively; the SQL fetch also excludes
  // these (one rule, two enforcement points — mirrors holder_active). This is the
  // regression guard the SQL-only _claimHold exclusion previously lacked.
  rows = rows.filter((r) => r.parked !== true);
  if (rows.length === 0) return [];
  const minMinutes = opts.minMinutes ?? 30;
  const sample = rows
    .slice(0, 5)
    .map((r) => `${r.work_item_id ?? '?'}<-${r.agent_id ?? '?'} (${Math.round(Number(r.stalled_minutes ?? 0))}m)`)
    .join(', ');
  return [{
    source: 'stalled-claim',
    key: 'stalled-work-item-claims',
    title: 'Work-item claims held by a live agent are not progressing (stalled)',
    body:
      `Watchdog signal (stalled-claim): ${rows.length} work-item claim(s) are held by a LIVE holder ` +
      `that has recorded NO item-scoped progress (a state transition / checkpoint) for > ${minMinutes} min ` +
      `— a claim is not progress (agent-activity-liveness-truth D-001). The holder is heartbeating but the ` +
      `work is not advancing, so the item reads as "covered" while actually stuck. The RECLAIM_STALLED ` +
      `reconciler leg auto-frees these when armed (default OFF — a live-placement change); until then this ` +
      `is the loud signal so the work is re-picked, not silently blocked (folds EI-2311). ` +
      `Sample: ${sample}${rows.length > 5 ? ', …' : ''}.`,
    severity: 'major',
    kind: 'bug',
    findingClass: 'coordination:stalled-claim',
  }];
}
/**
 * stalled-claim: work-item claims whose holder is ALIVE (fresh presence/nursery
 * heartbeat) but whose last_progress_at is far past the window — reads straight
 * off the reconciled fleet_assignment view's `stalled` column (migration 358),
 * the SAME truth the reconciler + every reader use, with a longer min-age so only
 * genuinely-stuck claims raise the loud aggregate signal.
 *
 * EI-10125: a claim with NO fleet_assignment-tracked progress can still be a
 * legitimately-documented hold (owner-pause, owner-gated wait, blocked-on-root-
 * cause) recorded via work_items:checkpoint — which does NOT touch
 * last_progress_at. Suppress a row whose work-item has a checkpoint
 * (harness_shared.carry_notes, scope `workitem:<harness>:<id>`, mig 472/494 —
 * the successor to the dropped work_item_checkpoints table) written more
 * recently than `minMinutes` ago: a fresh checkpoint IS progress, just not the
 * fleet_assignment-visible kind. Modeled on the same carry_notes join
 * work-item-claims.ts#listActiveClaimFreshnessForOwner already uses (scope-only
 * join, cross-workspace-safe, `note IS NOT NULL` so a cleared checkpoint reads
 * as no-checkpoint).
 *
 * (bug-drain-200k live find, 2026-07-21) A `payload._claimHold: true` row (WI-2797
 * "held open" — the holder deliberately parked the item, e.g. `state:'blocked'`
 * pending a live-rig / owner decision, via {@link setWorkItemClaimHold}) is a
 * CONSIDERED disposition, not an abandoned claim: the holder already decided there
 * is no more work to do right now, and the item is durably excluded from
 * claim_next/scheduler:get_next self-select for exactly that reason
 * ({@link claimHoldExclusionSql}). Without this exclusion the signal re-flags the
 * SAME held item forever (it never gets a checkpoint/state update again by design),
 * so every stalled-claim sweep re-serves it as a fresh "bug" to whichever agent
 * pulls it next — burning a full investigate-and-rediscover cycle each time
 * (confirmed live: WI-3669, held+blocked ~20h earlier, resurfaced verbatim). Join
 * back to the base `work_items` row (fleet_assignment doesn't expose `payload`)
 * and drop it, mirroring {@link isClaimHoldParked}'s JS-side check.
 */
export async function collectStalledClaimSignals(
  sql: Sql,
  workspaceId: string,
  opts: CollectOptions = {},
): Promise<WatchdogSignal[]> {
  const minMinutes = opts.stalledClaimMinutes ?? 30;
  const rows = await sql<StalledClaimRow[]>`
    SELECT fa.work_item_id, fa.agent_id, fa.harness_slug, fa.detail,
           EXTRACT(epoch FROM (now() - COALESCE(fa.last_progress_at, fa.claim_acquired_ts))) / 60 AS stalled_minutes,
           -- EI-14763: the holder is demonstrably WORKING within the window — a
           -- native tool call / lifecycle turn (agent_activity) or a coord/MCP
           -- dispatch (tool_invocations). A live, active holder is not stalled
           -- even with no item-scoped STATE transition; only a heartbeating-but-
           -- idle holder (or the dead-holder orphaned case) should raise this.
           (EXISTS (
              SELECT 1 FROM harness_shared.agent_activity aa
               WHERE aa.owner_id = fa.agent_id
                 AND aa.created_at > now() - make_interval(mins => ${minMinutes})
            ) OR EXISTS (
              SELECT 1 FROM harness_shared.tool_invocations ti
               WHERE ti.coord_owner_id = fa.agent_id
                 AND ti.invoked_at > now() - make_interval(mins => ${minMinutes})
            ))                                              AS holder_active,
           -- EI-18633753937712900 (WI-3669 recurrence): the item is deliberately
           -- PARKED — a blocked status, or payload._claimHold=true (WI-2797) —
           -- a considered disposition, not a stuck claim. Exposed for the pure
           -- signal's defensive drop (one rule, two enforcement points).
           (fa.status = 'blocked' OR EXISTS (
              SELECT 1 FROM harness_shared.work_items wi2
               WHERE wi2.workspace_id = fa.workspace_id
                 AND wi2.harness_slug = fa.harness_slug
                 AND wi2.feature_id = fa.work_item_id
                 AND COALESCE(wi2.payload, '{}'::jsonb) ->> '_claimHold' = 'true'
            ))                                              AS parked
      FROM harness_shared.fleet_assignment fa
     WHERE fa.source = 'work_item_claim'
       AND fa.stalled IS TRUE
       AND fa.workspace_id = ${workspaceId}
       AND (now() - COALESCE(fa.last_progress_at, fa.claim_acquired_ts)) > make_interval(mins => ${minMinutes})
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.carry_notes cn
          WHERE cn.scope IN (
                  'workitem:' || fa.harness_slug || ':' || fa.work_item_id,
                  'workitem:*:' || fa.work_item_id)
            AND cn.note IS NOT NULL
            AND cn.updated_ts > (extract(epoch from now()) * 1000)::bigint - (${minMinutes}::int * 60000)
       )
       -- Suppress live, actively-working holders directly in the fetch so genuine
       -- stalls are never crowded out of the LIMIT (the pure signal also drops
       -- holder_active rows defensively — one rule, two enforcement points).
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.agent_activity aa
          WHERE aa.owner_id = fa.agent_id
            AND aa.created_at > now() - make_interval(mins => ${minMinutes})
       )
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.tool_invocations ti
          WHERE ti.coord_owner_id = fa.agent_id
            AND ti.invoked_at > now() - make_interval(mins => ${minMinutes})
       )
       -- (bug-drain-200k / EI-18633753937712900, WI-3669 recurrence) a
       -- deliberately PARKED item is a considered "nothing more to do right now"
       -- disposition, not an abandoned/stuck claim — never raise it. Two shapes:
       --   (a) a blocked status (re-picking a blocked item is futile), and
       --   (b) payload._claimHold = true (WI-2797) — explicitly held out of pool.
       AND fa.status IS DISTINCT FROM 'blocked'
       AND NOT EXISTS (
         SELECT 1 FROM harness_shared.work_items wi
          WHERE wi.workspace_id = fa.workspace_id
            AND wi.harness_slug = fa.harness_slug
            AND wi.feature_id = fa.work_item_id
            AND COALESCE(wi.payload, '{}'::jsonb) ->> '_claimHold' = 'true'
       )
     ORDER BY COALESCE(fa.last_progress_at, fa.claim_acquired_ts) ASC
     LIMIT 50`;
  return stalledClaimSignalsFromRows(rows, { minMinutes });
}

interface CeilingJamRow {
  spawn_id: string;
  harness_slug: string | null;
  started_at: string | Date;
  last_output_at: string | Date | null;
  /** The nursery run_id — used only to identify in-process loopback launches
   *  (`launch-*`), which never populate `last_output_at`. Optional so the pure
   *  classifier can be exercised with bee-spawn rows alone. */
  run_id?: string | null;
}

/**
 * Is this a nursery row for an IN-PROCESS loopback launch (a durable-spawn
 * worker, a `launch-*` launch-blueprint — doc-steward / release cadence /
 * git-sync — or a Mug/overwatch wake) rather than a supervised invoke-once
 * bee child? DELEGATES to `fleet/spawn-row-class`'s `isInProcessLaunchIdentity` —
 * the one implementation of this boundary (EI-21344971525195182).
 *
 * This function used to carry its own copy of the prefix test and a docblock
 * claiming it "mirrors spawn-reclaim.ts's `kind` classifier (the single source of
 * truth)". It did not: that classifier grew an `invoke-*` short-circuit which moved
 * 71% of the `durable-spawn:*` population to the other side of the boundary, while
 * this copy stayed ids-only. Note the delegation target is the IDENTITY predicate,
 * not `spawnRowKind` — for this detector the ids-only answer is the correct one, and
 * that distinction is exactly what the old "mirrors the kind classifier" sentence
 * got wrong.
 *
 * WHY THE CEILING-JAM DETECTOR MUST EXCLUDE THESE (EI-7215). `last_output_at` is
 * stamped ONLY by the child-process stdout supervisor (`operator-spawn.ts` →
 * `heartbeatSpawns(…, outputAtMs)`). An in-process launch runs via `/invoke`, not
 * as a stdout-streaming child, so its heartbeat path never passes `outputAtMs`
 * and `last_output_at` stays NULL for the row's ENTIRE life — even while the
 * launch is demonstrably alive and working. The jam signal's stream-recency
 * liveness proxy is therefore structurally inapplicable to this class: counting
 * it flags every live in-process launch (durable-spawn worker, launch-blueprint,
 * Mug) as a "stale debit", firing a false-positive `spawn-ceiling-jam` whenever
 * ≥`slack` such launches run concurrently. Their liveness + genuine stale-debit
 * reclaim are owned by the boot-id-aware reclaim sweep / boot reconcile
 * (spawn-reclaim.ts), not this DB-only detector.
 */
export function isInProcessLaunchRow(row: { spawn_id: string; run_id?: string | null }): boolean {
  return isInProcessLaunchIdentity(row);
}
/**
 * Pure: classify the workspace's `running`/`restarting` nursery rows into
 * genuinely-live (streamed output within `silentMinutes`) vs. suspected stale
 * debits (older than `minAgeMinutes` AND not streaming), and emit ONE aggregate
 * signal when the admission ceiling is consumed by the latter (EI-2186).
 *
 * Why stream output and not heartbeat: a host restart kills the launcher before
 * its admission-release runs, so the row jams `maxSimultaneousAgents` forever, and
 * the periodic reclaim cannot clear it — a stale `launch` row's reused pid reads as
 * "alive" and its HEARTBEAT gets bumped each sweep (a false-alive). `last_output_at`
 * is NOT touched by that bump path, and a dead process cannot advance it, so it is
 * the one liveness proxy the jam cannot fake. The fire condition is conservative —
 * the suspect rows must OUTNUMBER the live-streaming ones and clear the slack — so a
 * busy fleet (many streaming bees) and a couple of quiet/long-tool-call bees never trip it.
 *
 * SCOPE — supervised bee spawns only (EI-7215). `last_output_at` is populated ONLY
 * for invoke-once bee children (whose stdout the supervisor observes). In-process
 * loopback launches — durable-spawn workers, `launch-*` launch-blueprints,
 * Mug/overwatch wakes — never stream it, so this proxy is meaningless for them and
 * they are EXCLUDED from the classification (see isInProcessLaunchRow). Counting them
 * treated every live in-process launch as a stale debit and fired a false-positive
 * jam on any healthy fleet of ≥`slack` such launches; their reclaim is the
 * boot-id-aware sweep / boot reconcile's job (spawn-reclaim.ts), not this signal's.
 */
export function ceilingJamSignalsFromRows(
  rows: CeilingJamRow[],
  opts: { ceiling?: number; minAgeMinutes?: number; silentMinutes?: number; slack?: number; now?: number } = {},
): WatchdogSignal[] {
  const minAgeMinutes = opts.minAgeMinutes ?? 15;
  const silentMinutes = opts.silentMinutes ?? 15;
  const slack = opts.slack ?? 2;
  const now = opts.now ?? Date.now();
  const ms = (v: string | Date | null): number | null => {
    if (v == null) return null;
    const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
    return Number.isNaN(t) ? null : t;
  };
  let running = 0;
  let streamingLive = 0;
  const jammed: string[] = [];
  for (const r of rows) {
    // EI-7215: in-process loopback launches never populate `last_output_at`, so
    // this stream-recency detector cannot evaluate them — skip them entirely
    // (neither counted as running, streaming, nor jammed). See isInProcessLaunchRow.
    if (isInProcessLaunchRow(r)) continue;
    running++;
    const outAt = ms(r.last_output_at);
    const streamedRecently = outAt != null && now - outAt <= silentMinutes * 60_000;
    if (streamedRecently) {
      streamingLive++;
      continue;
    }
    const startedAt = ms(r.started_at);
    const oldEnough = startedAt != null && now - startedAt > minAgeMinutes * 60_000;
    if (oldEnough) jammed.push(r.spawn_id);
  }
  // Fire only when the stale-suspect rows clear the slack AND outnumber the live
  // streamers — i.e. the ceiling is consumed by rows that aren't actually working.
  if (jammed.length <= slack || jammed.length <= streamingLive) return [];
  const sample = jammed.slice(0, 5).join(', ');
  const ceilingNote = opts.ceiling != null ? ` (fleet ceiling maxSimultaneousAgents=${opts.ceiling})` : '';
  return [{
    source: 'spawn-ceiling-jam',
    key: 'spawn-ceiling-jam',
    title: 'Spawn-admission ceiling jammed by non-streaming rows — stale debits blocking placement',
    body:
      `Watchdog signal (spawn-ceiling-jam): ${running} spawned_agents row(s) are status='running'/'restarting'${ceilingNote}, ` +
      `but only ${streamingLive} have streamed output in the last ${silentMinutes} min — ${jammed.length} have been running ` +
      `> ${minAgeMinutes} min with NO stream activity. That is the EI-2186 class: a host/process restart left admission ` +
      `debits that never released, so the concurrency ceiling reads full while ~nothing is alive and NO bee can be placed. ` +
      `The heartbeat-based reclaim misses these (a reused-pid false-alive keeps their heartbeat fresh); the boot reconcile ` +
      `(reconcileSpawnAdmissionOnBoot) clears them at the next operator restart. Sample: ${sample}${jammed.length > 5 ? ', …' : ''}.`,
    severity: 'critical',
    kind: 'bug',
  }];
}
/**
 * spawn-ceiling-jam: the recurrence guard for EI-2186. Distinct from orphaned-spawn
 * (which keys on a STALE heartbeat — and the jam's signature is a FRESH heartbeat
 * from the false-alive bump): this keys on stream-output recency, which a dead row
 * cannot fake. Box-global ceiling, workspace-scoped rows (matching admission's
 * per-workspace `countRunning`).
 */
export async function collectCeilingJamSignals(
  sql: Sql,
  workspaceId: string,
  opts: CollectOptions = {},
): Promise<WatchdogSignal[]> {
  const minAgeMinutes = opts.ceilingJamMinAgeMinutes ?? 15;
  const rows = await sql<CeilingJamRow[]>`
    SELECT spawn_id, harness_slug, started_at, last_output_at, run_id
      FROM harness_shared.spawned_agents
     WHERE workspace_id = ${workspaceId}
       AND status IN ('running', 'restarting')
     ORDER BY started_at ASC
     LIMIT 200`;
  let ceiling: number | undefined;
  try {
    const { getCachedRateLimitConfig } = await import('../../rate-limit-config');
    ceiling = getCachedRateLimitConfig().maxSimultaneousAgents;
  } catch {
    /* best-effort — the signal stands without the ceiling number in its body */
  }
  return ceilingJamSignalsFromRows(rows, {
    ceiling,
    minAgeMinutes,
    silentMinutes: opts.ceilingJamSilentMinutes,
    slack: opts.ceilingJamSlack,
  });
}

interface EscalationSpikeRow { harness_slug: string; mtime_ms: number | string }
/** Pure: recent-escalation rows → ONE spike signal when ≥ minCount in the window. */
export function escalationSpikeSignalsFromRows(
  rows: EscalationSpikeRow[],
  opts: { windowHours?: number; minCount?: number } = {},
): WatchdogSignal[] {
  const windowHours = opts.windowHours ?? 6;
  const minCount = opts.minCount ?? 3;
  if (rows.length < minCount) return [];
  const byHarness = new Map<string, number>();
  for (const r of rows) byHarness.set(r.harness_slug, (byHarness.get(r.harness_slug) ?? 0) + 1);
  const breakdown = [...byHarness.entries()].map(([s, n]) => `${s}×${n}`).join(', ');
  return [{
    source: 'escalation-spike',
    key: 'escalation-rate',
    title: 'Escalation rate spike across the hive',
    body:
      `Watchdog signal (escalation-spike): ${rows.length} escalation(s) recorded in the last ${windowHours}h ` +
      `(threshold ${minCount}) — ${breakdown}. A burst of ESCALATE terminals means pipelines are systematically ` +
      `failing to complete (validator rejections, broken roles, or a poisoned harness), not one-off hard features.`,
    severity: 'major',
    kind: 'bug',
  }];
}
/**
 * escalation-spike: the RATE complement to unresolved-escalation (presence).
 * Escalations written within the window (mtime_ms — the table's only
 * timestamp) at ≥ threshold volume = the loop is systematically escalating.
 */
export async function collectEscalationSpikeSignals(
  sql: Sql,
  workspaceId: string,
  opts: CollectOptions = {},
): Promise<WatchdogSignal[]> {
  const windowHours = opts.escalationSpikeWindowHours ?? 6;
  const rows = await sql<EscalationSpikeRow[]>`
    SELECT harness_slug, mtime_ms
      FROM harness_shared.harness_escalations
     WHERE workspace_id = ${workspaceId}
       AND COALESCE(escalation, '') <> ''
       AND mtime_ms > (extract(epoch from now()) * 1000 - ${windowHours} * 3600000)
     LIMIT 200`;
  return escalationSpikeSignalsFromRows(rows, { windowHours, minCount: opts.escalationSpikeMinCount });
}

/** (P-011) Collector definition: a pluggable source of watchdog signals for a target. */
export interface WatchdogCollector {
  /** Collector name (e.g., 'papercusp-red-test', 'my-project-integration-test'). */
  name: string;
  /**
   * (WI-40769) The watchdog SOURCE this collector owns. Declaring it makes a
   * FAILED tick attributable: when `collect()` throws, the collector observed
   * NOTHING, and without a source the sweep cannot tell which source's absence
   * evidence to discount — so it would silently count the blind tick as
   * "condition cleared", the exact misread this field exists to prevent.
   *
   * OPTIONAL because it only matters for a source in `AUTO_CLOSE_ELIGIBLE_SOURCES`
   * (nothing else reads absence as evidence). A collector whose source is not
   * auto-close eligible is unaffected by omitting it. `service-down` declares it
   * because WI-40769 admits that source to the allowlist; a guard test pins the
   * pairing so a future admission cannot forget it.
   */
  source?: WatchdogSource;
  /**
   * Collect signals. May return a bare array or a `CollectorResult` to carry a
   * non-error note (P-004). Errors are caught + logged by collectWatchdogSignalsDetailed.
   */
  collect: () => Promise<WatchdogSignal[] | CollectorResult>;
}

/** Injectable collector seam (the routine handler uses the default; tests inject). */
export interface WatchdogDeps {
  collect: () => Promise<WatchdogSignal[]>;
  capture: typeof captureImprovement;
  /** Tick-record sink (P-001). Defaults to the PG writer; tests inject. */
  recordTick: (rec: WatchdogTickRecord) => Promise<void>;
  /**
   * Recent-ticks reader for self-escalation (P-002) + the deferred-escalation
   * boost. `filter.status` narrows to ticks of one status — the deferred-keys
   * read uses `{ status: 'ran' }` so a 'skipped' tick (cross-host lock loser,
   * which records an empty deferred list) cannot wipe the boost (audit P-011).
   */
  readRecentTicks: (workspaceId: string, limit: number, filter?: { status?: 'ran' | 'skipped' }) => Promise<RecentTick[]>;
  /** Cross-host tick lock (P-003). Defaults to the PG advisory lock; tests inject. */
  withTickLock: <T>(workspaceId: string, fn: () => Promise<T>) => Promise<TickLockOutcome<T>>;
  /** Key-dup feed for the P-004/P-005 pre-filter. Defaults to the indexed PG lookup; tests inject. */
  readKeyDups: (keys: string[]) => Promise<WatchdogKeyDup[]>;
  /** Tick-retention prune (audit P-009). Best-effort, never aborts the tick; tests inject. */
  pruneTicks: (workspaceId: string, olderThanDays: number) => Promise<void>;
  /**
   * Known-open AGING (consume-edges P-020 / EI-363): turn persistent known-open
   * firing into escalation pressure. Defaults to `processKnownOpenAging`; tests inject.
   */
  processAging: (workspaceId: string, knownOpen: readonly KnownOpenAgingInput[], opts: WatchdogTickOptions) => Promise<KnownOpenAgingOutcome[]>;
  /**
   * AUTO-CLOSE (P-009): retire watchdog-sourced EIs whose signal stopped firing for N
   * ran-ticks. Defaults to `processAutoClose` (DEFAULT-OFF flag-gated); tests inject.
   */
  processAutoClose?: (workspaceId: string, opts: WatchdogTickOptions) => Promise<AutoCloseOutcome[]>;
  /** Re-detect file-backed red tests immediately before capture; fails open on read errors. */
  redetectRedTests?: RedTestRedetect;
}

/** (P-011) Default papercusp collectors: red-test, smoke-fail, repeated-tool-error, service-down.
 *  `opts.installSlug` (carried on the WatchdogTickOptions the tick passes through) is threaded
 *  to the dispatcher-staleness collector so it mirrors the dispatcher's runner/flag resolution
 *  (EI-2150). */
export async function defaultPapercuspCollectors(
  workspaceId: string,
  opts: CollectOptions & { installSlug?: string | null } = {},
): Promise<WatchdogCollector[]> {
  return [
    {
      name: 'papercusp-dream-quality',
      source: 'dream-quality',
      collect: () => import('../../dream/dream-quality').then(m => m.collectDreamQualitySignals(getOrgPg().sql, workspaceId)),
    },
    {
      name: 'papercusp-red-test',
      collect: () => collectRedTestSignals(getOrgPg().sql, opts),
    },
    {
      name: 'papercusp-smoke-fail',
      collect: () => collectSmokeFailSignals(getOrgPg().sql, workspaceId, opts),
    },
    {
      name: 'papercusp-repeated-tool-error',
      collect: () => collectToolErrorSignals(getOrgPg().sql, opts, workspaceId),
    },
    {
      name: 'papercusp-invocation-friction',
      collect: async () => {
        const { recoverInvocationFriction } = await import('./invocation-friction');
        // D-010 backfill: fold pre-signature per-build rows onto their signature
        // row. Bounded per tick; runs before recovery so its failure is visible
        // in the note without blocking pending deliveries.
        const { foldLegacyToolFailureRows } = await import('./tool-failure-signature-fold');
        const fold = await foldLegacyToolFailureRows(workspaceId).catch((error: unknown) => ({
          error: error instanceof Error ? error.message : String(error),
        }));
        const foldNote = 'error' in fold
          ? `signature-fold error=${fold.error}`
          : `signature-fold scanned=${fold.scanned} folded=${fold.folded} rekeyed=${fold.rekeyed} failedGroups=${fold.failedGroups}`;
        const result = await recoverInvocationFriction(workspaceId);
        return { signals: [], note: `friction delivered=${result.delivered}, locked-pending=${result.pending}; ${foldNote}` };
      },
    },
    {
      name: 'papercusp-service-down',
      // WI-40769: declared so a THROWN tick is attributable to this source and
      // discounted from absence evidence (service-down is auto-close eligible).
      source: 'service-down',
      collect: () => serviceDownCollectorResult({ maxStaleMs: opts.serviceHealthMaxStaleMs }),
    },
    // P-010 blind-source collectors (each conservative + behind the P-009 per-source budget).
    { name: 'papercusp-migration-drift', collect: () => collectMigrationDriftSignals() },
    { name: 'papercusp-schema-ahead-of-code', collect: () => collectSchemaAheadSignals() },
    { name: 'papercusp-schema-object-drift', collect: () => collectSchemaObjectDriftSignals() },
    { name: 'papercusp-routine-failure', collect: () => collectRoutineFailureSignals(getOrgPg().sql) },
    { name: 'papercusp-stuck-plan', collect: () => collectStuckPlanSignals(getOrgPg().sql, workspaceId) },
    { name: 'papercusp-failed-spawn', collect: () => collectFailedSpawnSignals(getOrgPg().sql, opts) },
    { name: 'papercusp-expired-lease', collect: () => collectExpiredLeaseSignals(getOrgPg().sql, opts) },
    { name: 'papercusp-unresolved-escalation', collect: () => collectEscalationSignals(getOrgPg().sql, workspaceId) },
    // WI-38327 recurrence guard: the GitHub bridge marked itself owner-gated and the
    // owner rail has no record of it. Distinct from unresolved-escalation above, which
    // asks a triage question (are there supervisor notes?) rather than a delivery one.
    {
      name: 'papercusp-bridge-needs-owner-unalerted',
      collect: () => collectBridgeNeedsOwnerSignals(getOrgPg().sql, workspaceId),
    },
    { name: 'papercusp-fire-circuit-open', collect: () => collectCircuitOpenSignals(getOrgPg().sql, workspaceId) },
    // loop-wake-rate-limit-robustness P1b: an engine loop parked-stalled with a dead/undelivered
    // wake turn (the early, visible signal before the ≥30min stuck-park backstop recovers it).
    { name: 'papercusp-loop-stalled', collect: () => collectLoopStalledSignals(getOrgPg().sql) },
    // EI-13022: a protective hold (pot pauseNewWork / kettle:pause) left standing against a
    // work-commanding directive — pages (never auto-resumes) once provably stale.
    { name: 'papercusp-stale-protective-hold', collect: () => collectStaleProtectiveHoldSignals(getOrgPg().sql, workspaceId) },
    // Hive-loop invariant monitors (hive-loop-e2e-testing-2026-06-10 P-010):
    // liveness (stalled dispatchable work), hygiene (reclaim non-execution),
    // safety (systematic ESCALATE volume).
    { name: 'papercusp-stalled-feature', collect: () => collectStalledFeatureSignals(getOrgPg().sql, workspaceId, opts) },
    { name: 'papercusp-orphaned-spawn', collect: () => collectOrphanedSpawnSignals(getOrgPg().sql, workspaceId, opts) },
    // agent-activity-liveness-truth P-007: a LIVE holder sitting on a non-progressing
    // work-item claim (fleet_assignment.stalled) — the loud recurrence guard so stalled
    // work is re-picked even while the RECLAIM_STALLED reconciler leg is dark.
    { name: 'papercusp-stalled-claim', collect: () => collectStalledClaimSignals(getOrgPg().sql, workspaceId, opts) },
    // EI-2186: the spawn-ceiling-jam recurrence guard — admission ceiling consumed by
    // non-streaming rows (stale debits from a host restart). Keys on stream activity,
    // not heartbeat, so it catches the jam orphaned-spawn misses (fresh false-alive heartbeat).
    { name: 'papercusp-spawn-ceiling-jam', collect: () => collectCeilingJamSignals(getOrgPg().sql, workspaceId, opts) },
    { name: 'papercusp-escalation-spike', collect: () => collectEscalationSpikeSignals(getOrgPg().sql, workspaceId, opts) },
    // P-051 (learning-system-audit): active insights citing missing repo files →
    // kind=change review captures (fs-only, no PG; lazy import keeps boot cheap).
    {
      name: 'papercusp-insight-staleness',
      collect: () => import('./insight-staleness').then((m) => m.collectInsightStalenessSignals()),
    },
    // Links 5–6 flow assertion (hive-loop-e2e P-011): unshipped staging work
    // older than the lag bar = the ship link is silently stuck (git-only; skips
    // with a note off the release host).
    // Consume-edges P-011: auto-implement dispatches whose worker died without
    // resolving — drives the open ledger row terminal ('orphaned') and signals
    // per affected item. Skips with a note until migration 238 is applied.
    {
      name: 'papercusp-orphaned-dispatch',
      collect: () => import('./orphaned-dispatch').then((m) => m.collectOrphanedDispatchSignals(workspaceId)),
    },
    // EI-2150: the DISPATCHER-STALL detector — the dispatcher itself stopped firing
    // (lastDispatchAt stale) while armed, never-dispatched work waits. The sibling
    // orphaned-dispatch collector only catches DEAD WORKERS on open rows; this catches
    // the lane going dark entirely. Skips with a note while disarmed / env-paused / the
    // ledger is absent (migration 238).
    {
      name: 'papercusp-dispatcher-staleness',
      collect: () =>
        import('./dispatcher-staleness').then((m) =>
          m.collectDispatcherStalenessSignals(workspaceId, {
            dispatcherStalenessThresholdHours: opts.dispatcherStalenessThresholdHours,
            // Mirror the dispatcher's armed inputs (EI-2150): without the install slug the
            // collector reads the runner env-only and skips as "disarmed" in the env-unset
            // config that caused the incident — going dark in the scenario it exists to watch.
            installSlug: opts.installSlug,
          }),
        ),
    },
    {
      name: 'papercusp-ship-link',
      collect: () => import('./ship-link').then((m) => m.collectShipLinkSignals()),
    },
    // Audit-as-sensors (self-learning-frontier P-047 / FB-21): the learning
    // system's own health KPIs as standing SLO collectors — a breach files
    // into the very queue it measures, kinds per FB-18's fidelity rules.
    // All five ride ONE flag (papercusp-learning-slo-sensors), default ON —
    // NOT a D-001 dark-shipped flag (EI-18886519654229938: this comment used
    // to claim it was; the flag was never added to DARK_FLAGS, so it has
    // always derived live default-ON, and the P-001 arming gate for this
    // exact wave-1 zero-spend sensor closed 2026-06-13 anyway, D-010). It
    // remains a normal operator kill-switch (each collector reports a 'dark'
    // note while OFF); all five are SQL-only, and read their thresholds from
    // LEARNING_SLO_DEFAULTS / this tick's payload tunables.
    {
      name: 'papercusp-triage-entropy',
      collect: () => import('./learning-slo').then((m) => m.triageEntropyCollector(workspaceId, opts)),
    },
    {
      name: 'papercusp-capture-consume-flow',
      collect: () => import('./learning-slo').then((m) => m.captureConsumeFlowCollector(workspaceId, opts)),
    },
    {
      name: 'papercusp-mttsh-regression',
      collect: () => import('./learning-slo').then((m) => m.mttshRegressionCollector(opts)),
    },
    {
      name: 'papercusp-governor-starvation',
      collect: () => import('./learning-slo').then((m) => m.governorStarvationCollector(workspaceId, opts)),
    },
    {
      name: 'papercusp-memory-recall-zero-hit',
      collect: () => import('./learning-slo').then((m) => m.memoryZeroHitCollector(opts)),
    },
    // P-013 (D-024): the per-POOL sibling of the collector above. Separate sensor
    // rather than an extra branch inside it because the two answer different
    // questions over different aggregates — that one asks whether recall as a
    // whole degraded against its own history, this one asks whether ONE pool of a
    // fused push-path block is contributing nothing (or only ever its budget)
    // while the blend reads healthy. Reads the existing readRecallHealthByPool /
    // readRecallHealthBySurface aggregates; no new SQL:
    {
      name: 'papercusp-memory-recall-pool',
      collect: () => import('./learning-slo').then((m) => m.recallPoolCollector(opts)),
    },
    // P-037 (F-G) gate-5: the SCORE-side sibling of the two above. Separate
    // sensor for the same reason they are separate from the blended one — those
    // ask whether a pool's COUNTS are healthy, this asks whether the score
    // SCALE label every scale-aware reader trusts is telling the truth. A
    // contradiction there silently reinstates the D-001 mixing bug for all of
    // them, so it is a different failure with a different fix. One aggregate
    // pass; quiet by construction (it reads 0 across every surface today):
    {
      name: 'papercusp-memory-recall-scale',
      collect: () => import('./learning-slo').then((m) => m.recallScaleCollector(opts)),
    },
    // P-014 (D-025): the "shipped but not engaged" detector. Compares the IPC
    // bridge's LIFETIME accept count against live HTTP SSE stream clients — i.e.
    // installed-ness against utilisation, the comparison whose absence let
    // WI-6512 run invisibly. Process-local state only; no SQL, no flag.
    {
      name: 'papercusp-endpoint-ipc-engagement',
      collect: () =>
        import('../../endpoint-ipc/engagement').then((m) => m.endpointIpcEngagementCollector(opts)),
    },
    // infra-perf-reliability-audit-round4 P-013: the perf/reliability regression rig —
    // snapshots four reliability SLO metrics (event-loop-lag p95, PG connection
    // saturation %, the dispatch-orphan rate that silently regressed to 91%, coord
    // open-escalation backlog) to harness_shared.perf_regression_snapshots and files on
    // a budget breach. Flag-gated on papercusp-perf-regression-rig (DEFAULT ON — reports
    // a 'disabled' note while OFF); SQL + in-memory only, additive + read-mostly,
    // dormant-tolerant (a missing table/metric is a note, never a throw).
    {
      name: 'papercusp-perf-regression',
      collect: () =>
        import('../../system-health/perf-regression-rig').then((m) => m.collectPerfRegressionSnapshot(workspaceId)),
    },
    // unified-work-item-ledger P-009: the recurrence guard for the P-003 silent-zero
    // promotion class — a started+eligible plan with open items but ZERO work-items.
    // Gated by papercusp-plan-workitem-promotion (reports a 'dark' note while OFF so it
    // is inert while promotion is dark). SQL-only, one workspace-scoped query.
    {
      name: 'papercusp-zero-promotion',
      collect: () => import('./zero-promotion-detect').then((m) => m.collectZeroPromotionSignals(workspaceId)),
    },
    // enforce-system-on-generic-work P-009: the "done without test" recurrence guard —
    // a feature work-item marked done (terminal/passed) that still carries requires_test
    // VAL(s) with no passing covering test. SQL-only (three workspace-scoped reads), no
    // flag gate (naturally inert where the inline-VAL flow is dark). One finding per
    // harness, count = number of flagged items.
    {
      name: 'papercusp-done-without-test',
      collect: () => import('./done-without-test-detect').then((m) => m.collectDoneWithoutTestSignals(workspaceId)),
    },
    // enforce-system-on-generic-work P-013: the dark-flag-age guard — surfaces the
    // DARK_FLAGS allowlist for owner review BEFORE its review-by lands / its size
    // watermark is hit (the same two invariants production-defaults.test.ts enforces at
    // test time). OPERATOR-scoped (workspace-global): no workspaceId, no PG, no flag
    // gate; a healthy allowlist emits nothing.
    {
      name: 'papercusp-dark-flag-age',
      collect: () => import('./dark-flag-age-detect').then((m) => m.collectDarkFlagAgeSignals()),
    },
    // EI-9136: the release pin sat deployable-but-not-live for 12h+ with nobody paged —
    // wires the existing WI-1623 pure decider into a fleet-visible finding. OPERATOR-scoped
    // (workspace-global): no workspaceId, no PG of its own (reads git-pipeline state); a
    // healthy (non-stale) pipeline emits nothing, and the underlying threshold's own kill
    // switch already makes this inert when PAPERCUSP_DEPLOY_STALENESS_THRESHOLD_SEC<=0.
    {
      name: 'papercusp-release-deploy-staleness',
      collect: () =>
        import('./release-deploy-staleness-detect').then((m) =>
          m.collectReleaseDeployStalenessSignals({ installSlug: opts.installSlug ?? undefined }),
        ),
    },
    // EI-18835078701597295: the CAUSE-side companion to the staleness collector above.
    // Counts consecutive coalesced deploy attempts from the pipeline history the deploy CLI
    // now writes on every coalesce. OPERATOR-scoped (workspace-global); a pipeline where any
    // attempt is completing emits nothing, and its own threshold kill switch makes it inert
    // when PAPERCUSP_DEPLOY_COALESCE_STREAK_THRESHOLD<=0.
    {
      name: 'papercusp-deploy-coalesce-stall',
      collect: () =>
        import('./deploy-coalesce-stall-detect').then((m) =>
          m.collectDeployCoalesceStallSignals({ installSlug: opts.installSlug ?? undefined }),
        ),
    },
    // EI-10869: the lost-wake recurrence guard — a rate scan over harness_shared.event_awaits
    // (which awaitable keys are settling almost entirely by 'timeout' instead of 'event')
    // promoted to a page ONLY when an independent witness confirms the underlying condition
    // actually occurred (EI-10800's class: a real green-checkpoint verdict landed while the
    // wake silently never fired). An unwitnessed suspect never pages — see lost-wake-detect.ts.
    {
      name: 'papercusp-lost-wake',
      collect: () => import('./lost-wake-detect').then((m) => m.collectLostWakeSignals()),
    },
  ];
}

/**
 * Collect signals AND the per-collector status (watchdog-robustness P-001). The
 * status array is what makes a forever-failing collector visible — before this
 * the only trace of a rejected collector was a `console.warn` nobody tails.
 */
/**
 * Ephemeral benchmark / throwaway harness instances — the xbench fleet
 * (`xbench-su-*`, `xbq…` hive hashes), `*-DELETEME` memory-capacity probes, hive-loop
 * e2e harnesses, gym-eval sandboxes — spin up, churn, and are torn down constantly.
 * Their stalled features, unresolved git-sync escalations, and saturated-fleet governor
 * signals are TEST DEBRIS, not improvements: on 2026-06-17 they were ~94% of open
 * stalled-feature and 100% of open unresolved-escalation EIs, drowning the real signal.
 * Conservative pattern (only unmistakable throwaway markers) so a real harness slug —
 * papercup, papercup-org, papercup-hive, sheets, … — never matches.
 * (watchdog-embed-resilience-and-dedup-2026-06-17 P-006.)
 *
 * `^test-harness$` (EI-8890): the exact fixture slug hardcoded by
 * `agent-chats-messages.test.ts` (its `SLUG`/`CHAT` constants) — a not-fully-pinned
 * test-isolation leak occasionally lets a real run of that suite write a LIVE row to
 * `harness_shared.spawned_agents` with the test's fixture error string. Anchored exact
 * match only, so it can never shadow a real harness slug that merely contains "test".
 */
export const EPHEMERAL_BENCHMARK_SLUG_RE =
  /(^|[^a-z0-9])(xbench|xbq[a-z0-9]{6}|hiveloop|memcap|memrun)|-instance[_-]|_instance[_-]|deleteme|^e2e-imp|^sb-gym|gym-eval|^bench-|smoke-p[0-9]|^test-harness$/i;

export function isEphemeralBenchmarkHarnessSlug(slug: string | null | undefined): boolean {
  return !!slug && EPHEMERAL_BENCHMARK_SLUG_RE.test(slug);
}

/** Per-harness watchdog sources whose signal is meaningless for a torn-down benchmark
 *  instance. Global code-health sources (red-test, repeated-tool-error, migration-drift,
 *  service-down, insight-staleness, …) are NEVER filtered — they are not per-harness. */
const HARNESS_SCOPED_WATCHDOG_SOURCES: ReadonlySet<WatchdogSource> = new Set([
  'dream-quality',
  'stalled-feature', 'unresolved-escalation', 'escalation-spike', 'orphaned-spawn',
  'failed-spawn', 'stuck-plan', 'smoke-fail', 'fire-circuit-open', 'ship-link-stuck',
  'governor-starvation',
  // bridge-needs-owner-unalerted is per-harness (scope harness:<slug>): a torn-down
  // benchmark instance's un-paged bridge block is test debris, not an improvement.
  'bridge-needs-owner-unalerted',
  // zero-promotion is per-plan/per-harness: a torn-down benchmark instance's
  // started plan firing is test debris, not an improvement (P-006 dedup class).
  'zero-promotion',
  // done-without-test is per-harness (scope harness:<slug>): a torn-down benchmark
  // instance's done-without-test items are test debris, not an improvement.
  'done-without-test',
  // stale-protective-hold is per-pot (scope harness:<slug>): a torn-down benchmark
  // pot's leftover pause is test debris, not an improvement.
  'stale-protective-hold',
]);

/** A signal is ephemeral-benchmark debris when it is a per-harness source AND any slug it
 *  carries (scope `harness:<slug>`, key, or title) matches the benchmark pattern. */
export function isEphemeralBenchmarkSignal(s: WatchdogSignal): boolean {
  if (!HARNESS_SCOPED_WATCHDOG_SOURCES.has(s.source)) return false;
  const slugFromScope = s.scope?.startsWith('harness:') ? s.scope.slice('harness:'.length) : '';
  return [slugFromScope, s.key, s.title].some((c) => isEphemeralBenchmarkHarnessSlug(c));
}

// ── P-008: the FIRST-CLASS ephemeral flag (harness_shared.projects.ephemeral) ──────
// The principled successor to the P-006 slug-regex: a harness explicitly marked
// ephemeral (set at creation / backfilled by migration 309) is debris regardless of
// its slug. The regex stays as the fallback for un-flagged rows.

/** The harness slug a per-harness signal is about (from scope `harness:<slug>`), or null. */
export function ephemeralSignalSlug(s: WatchdogSignal): string | null {
  if (!HARNESS_SCOPED_WATCHDOG_SOURCES.has(s.source)) return null;
  return s.scope?.startsWith('harness:') ? s.scope.slice('harness:'.length) : null;
}

/** Pure: a signal is ephemeral when the slug-regex matches (P-006) OR its harness slug is
 *  FLAGGED ephemeral in projects (P-008). The flag is authoritative; the regex is fallback. */
export function isEphemeralSignal(s: WatchdogSignal, ephemeralSlugs: ReadonlySet<string>): boolean {
  if (isEphemeralBenchmarkSignal(s)) return true;
  const slug = ephemeralSignalSlug(s);
  return slug != null && ephemeralSlugs.has(slug);
}

/** P-008 fail-soft IO: which of the candidate harness slugs are flagged ephemeral in PG.
 *  Returns empty on ANY error (incl. the `ephemeral` column not existing before migration
 *  309 lands) — so the filter degrades to the regex (P-006 behavior) until then. */
export async function readEphemeralFlaggedSlugs(slugs: string[]): Promise<Set<string>> {
  const unique = [...new Set(slugs.filter(Boolean))];
  if (unique.length === 0) return new Set();
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ slug: string }[]>`
      SELECT slug FROM harness_shared.projects
       WHERE ephemeral = true AND slug = ANY(${unique}::text[])`;
    return new Set(rows.map((r) => r.slug));
  } catch {
    return new Set(); // pre-migration column-missing / DB blip → regex-only fallback
  }
}

export async function collectWatchdogSignalsDetailed(
  workspaceId: string,
  opts: CollectOptions = {},
  collectors?: WatchdogCollector[],
): Promise<{ signals: WatchdogSignal[]; collectors: CollectorStatus[] }> {
  // (P-011) Use provided collectors or default to papercusp
  const activeCollectors = collectors ?? (await defaultPapercuspCollectors(workspaceId, opts));

  const settled = await Promise.allSettled(activeCollectors.map((c) => c.collect()));
  const signals: WatchdogSignal[] = [];
  const statuses: CollectorStatus[] = [];
  for (let i = 0; i < settled.length; i++) {
    const s = settled[i];
    const name = activeCollectors[i]?.name ?? `collector[${i}]`;
    if (s.status === 'fulfilled') {
      // Normalize a bare array or the richer { signals, note } shape (P-004).
      const out = Array.isArray(s.value) ? { signals: s.value } : s.value;
      signals.push(...out.signals);
      statuses.push({
        name,
        ok: true,
        signalCount: out.signals.length,
        ...(out.note ? { note: out.note } : {}),
        // WI-40769: carry the blind-tick declaration through to the persisted
        // tick record. Only stamped when the collector actually declared itself
        // unobserved, so every existing collector's status shape is unchanged.
        ...(out.observed === false
          ? { observed: false, ...(out.unobservedSource ? { unobservedSource: out.unobservedSource } : {}) }
          : {}),
      });
    } else {
      const error = s.reason instanceof Error ? s.reason.message : String(s.reason);
      console.warn(`[improvement-watchdog] collector "${name}" failed: ${error}`);
      // WI-40769: a collector that THREW evaluated nothing, so this tick is not
      // absence evidence for its source either. Same reasoning as the deliberate
      // skip above — the two are indistinguishable downstream, and both were
      // previously counted as "the condition cleared".
      const threwSource = activeCollectors[i]?.source;
      statuses.push({
        name,
        ok: false,
        signalCount: 0,
        error,
        observed: false,
        ...(threwSource ? { unobservedSource: threwSource } : {}),
      });
    }
  }
  // P-006/P-008: drop ephemeral benchmark-instance debris (xbench / *-DELETEME / gym-eval /
  // hive-loop) from the per-harness sources — torn-down test churn, not improvements. The
  // first-class projects.ephemeral flag (P-008) is authoritative; the slug-regex (P-006) is
  // the fallback. Fail-soft: a missing column (pre-migration-309) / DB blip degrades to the
  // regex. Counted into a synthetic collector status so the drop is visible, never silent.
  const ephemeralFlagged = await readEphemeralFlaggedSlugs(
    signals.map(ephemeralSignalSlug).filter((s): s is string => s != null),
  );
  const kept: WatchdogSignal[] = [];
  let benchmarkDropped = 0;
  for (const sig of signals) {
    if (isEphemeralSignal(sig, ephemeralFlagged)) benchmarkDropped++;
    else kept.push(sig);
  }
  if (benchmarkDropped > 0) {
    statuses.push({
      name: 'ephemeral-benchmark-filter',
      ok: true,
      signalCount: 0,
      note: `dropped ${benchmarkDropped} ephemeral-benchmark harness signal(s) — projects.ephemeral flag (P-008) + slug-regex (P-006) debris`,
    });
  }
  return { signals: kept, collectors: statuses };
}

/** Back-compat: signals only (delegates to the detailed collector). */
export async function collectWatchdogSignals(workspaceId: string, opts: CollectOptions = {}, collectors?: WatchdogCollector[]): Promise<WatchdogSignal[]> {
  return (await collectWatchdogSignalsDetailed(workspaceId, opts, collectors)).signals;
}

// ── P-013: signal-to-noise rollup for improvements:watchdog-status ────────────────
// Surfaces how much the ephemeral-benchmark filter dropped (P-006/P-008) and the
// per-class repeated-tool-error spread, so a classification regression (a class
// suddenly ballooning) or a noise spike is VISIBLE in the status tool, not buried in
// raw ticks. Pure — unit-tested. (watchdog-and-exposed-systems-improvement-2026-06-18.)
export interface WatchdogRollupTick {
  collectors?: Array<{ name: string; note?: string }>;
  knownOpenKeys?: string[];
}
export interface WatchdogRollup {
  /** Ephemeral-benchmark signals the filter dropped across the ticks (P-006/P-008). */
  benchmarkDropped: number;
  /** OPEN repeated-tool-error keys by class — structural | transient | caller | rate-limit | other. */
  toolErrorByClass: Record<string, number>;
}
export function rollupWatchdogTicks(ticks: readonly WatchdogRollupTick[]): WatchdogRollup {
  let benchmarkDropped = 0;
  const toolErrorByClass: Record<string, number> = {};
  for (const t of ticks) {
    for (const c of t.collectors ?? []) {
      if (c.name === 'ephemeral-benchmark-filter' && c.note) {
        const m = /dropped (\d+)/.exec(c.note);
        if (m) benchmarkDropped += Number(m[1]);
      }
    }
    for (const k of t.knownOpenKeys ?? []) {
      if (!k.startsWith('repeated-tool-error:')) continue;
      const cls = /:rate-limit$/.test(k)
        ? 'rate-limit'
        : /:transient$/.test(k)
          ? 'transient'
          : /:caller$/.test(k)
            ? 'caller'
            : /:structural$/.test(k) || /:structural:/.test(k)
              ? 'structural'
              : 'other';
      toolErrorByClass[cls] = (toolErrorByClass[cls] ?? 0) + 1;
    }
  }
  return { benchmarkDropped, toolErrorByClass };
}

/**
 * Default tick-record sink (watchdog-robustness P-001): one row per tick into
 * `harness_shared.watchdog_ticks`. Injectable via `WatchdogDeps.recordTick` so
 * unit tests observe the record without PG. The caller swallows its errors — a
 * bookkeeping failure must never abort the tick.
 */
export async function recordWatchdogTick(rec: WatchdogTickRecord): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    INSERT INTO harness_shared.watchdog_ticks
      (workspace_id, install_slug, status, signals, captured, declined_duplicates, deferred, deferred_keys,
       known_open_keys, stale_resolved_keys, seen_keys, standing_keys, collectors, self_escalations)
    VALUES (${rec.workspaceId}, ${rec.installSlug ?? null}, ${rec.status}, ${rec.signals},
            ${rec.captured}::text[], ${rec.declinedDuplicates}, ${rec.deferred}, ${rec.deferredKeys ?? []}::text[],
            ${rec.knownOpenKeys ?? []}::text[], ${rec.staleResolvedKeys ?? []}::text[],
            ${rec.seenKeys ?? []}::text[], ${rec.standingKeys ?? []}::text[],
            ${JSON.stringify(rec.collectors)}::text::jsonb, ${rec.selfEscalations}::text[])
  `;
}

/**
 * Tick-retention prune (audit P-009): drop tick rows older than `olderThanDays`
 * for this workspace. Called best-effort at the end of each tick (same
 * swallow-errors contract as recordTick) — the table grew ~96 rows/day/host
 * unbounded with no GC before this.
 */
export async function pruneWatchdogTicks(workspaceId: string, olderThanDays: number): Promise<void> {
  const { sql } = getOrgPg();
  await sql`
    DELETE FROM harness_shared.watchdog_ticks
     WHERE workspace_id = ${workspaceId}
       AND tick_at < now() - make_interval(days => ${olderThanDays})`;
}

/** A prior tick, as read for the self-escalation streak (P-002). Newest-first. */
export interface RecentTick {
  status: 'ran' | 'skipped';
  collectors: CollectorStatus[];
  /** Keys deferred on that tick (P-009) — fed back as the escalation history. */
  deferredKeys?: string[];
  /**
   * Every key OBSERVED on that tick (P-002) — the delta gate's diff basis. Optional so
   * injected test fakes and pre-migration rows read as `[]`, which fails the gate OPEN.
   */
  seenKeys?: string[];
  /**
   * When that tick ran, ISO-8601 (EI-20847917368795366). The re-file rate limit measures a
   * consecutive-standing RUN in wall-clock, so it needs the stamp, not just the ordering.
   * Optional → `computeRefileEligibleKeys` fails CLOSED (keeps suppressing).
   */
  tickAt?: string;
  /**
   * Keys the delta gate suppressed as `standing` on that tick (EI-20847917368795366) — the
   * re-file window's evidence. Optional → fails CLOSED, as above.
   */
  standingKeys?: string[];
}

/**
 * Default recent-ticks reader (P-002): the last `limit` ticks for a workspace,
 * newest-first. `filter.status` narrows to one status — the deferred-keys boost
 * reads `{ status: 'ran' }` so a skipped tick can't wipe it (audit P-011).
 */
export async function readRecentWatchdogTicks(
  workspaceId: string,
  limit: number,
  filter: { status?: 'ran' | 'skipped' } = {},
): Promise<RecentTick[]> {
  if (limit <= 0) return [];
  const { sql } = getOrgPg();
  const rows = await sql<
    {
      status: 'ran' | 'skipped';
      collectors: CollectorStatus[];
      deferred_keys: string[];
      seen_keys: string[];
      tick_at: Date | string;
      standing_keys: string[];
    }[]
  >`
    SELECT status, collectors, deferred_keys, seen_keys, tick_at, standing_keys
      FROM harness_shared.watchdog_ticks
     WHERE workspace_id = ${workspaceId}
       AND ${filter.status ? sql`status = ${filter.status}` : sql`TRUE`}
     ORDER BY tick_at DESC
     LIMIT ${limit}`;
  return rows.map((r) => ({
    status: r.status,
    collectors: Array.isArray(r.collectors) ? r.collectors : [],
    deferredKeys: Array.isArray(r.deferred_keys) ? r.deferred_keys : [],
    // P-002: pre-migration rows have no column value → [] → the delta gate fails OPEN.
    seenKeys: Array.isArray(r.seen_keys) ? r.seen_keys : [],
    // EI-20847917368795366: the re-file window's evidence. Absent/unparseable → the rate
    // limit fails CLOSED (keeps suppressing), the opposite of the delta gate's fail-open.
    tickAt: r.tick_at instanceof Date ? r.tick_at.toISOString() : String(r.tick_at ?? ''),
    standingKeys: Array.isArray(r.standing_keys) ? r.standing_keys : [],
  }));
}

/** One full tick row for the observability surface (audit P-010). */
export interface WatchdogTickStatusRow {
  tickAt: string;
  installSlug: string | null;
  status: 'ran' | 'skipped';
  signals: number;
  captured: string[];
  declinedDuplicates: number;
  deferred: number;
  deferredKeys: string[];
  knownOpenKeys: string[];
  staleResolvedKeys: string[];
  /** Keys the P-003/D-001 delta gate suppressed as standing this tick (EI-18638773146465036). */
  standingKeys: string[];
  collectors: CollectorStatus[];
  selfEscalations: string[];
}

/**
 * Observability read (audit P-010): the last `limit` tick rows IN FULL — the
 * data backing `improvements:watchdog-status`. Before this the only consumer of
 * `watchdog_ticks` was the watchdog itself; diagnosing it took raw psql.
 */
export async function readWatchdogStatus(workspaceId: string, limit = 10): Promise<WatchdogTickStatusRow[]> {
  const { sql } = getOrgPg();
  const rows = await sql<{
    tick_at: Date | string;
    install_slug: string | null;
    status: 'ran' | 'skipped';
    signals: number;
    captured: string[];
    declined_duplicates: number;
    deferred: number;
    deferred_keys: string[];
    known_open_keys: string[];
    stale_resolved_keys: string[];
    standing_keys: string[];
    collectors: CollectorStatus[];
    self_escalations: string[];
  }[]>`
    SELECT tick_at, install_slug, status, signals, captured, declined_duplicates, deferred,
           deferred_keys, known_open_keys, stale_resolved_keys, standing_keys, collectors, self_escalations
      FROM harness_shared.watchdog_ticks
     WHERE workspace_id = ${workspaceId}
     ORDER BY tick_at DESC
     LIMIT ${Math.min(Math.max(1, limit), 200)}`;
  return rows.map((r) => ({
    tickAt: r.tick_at instanceof Date ? r.tick_at.toISOString() : String(r.tick_at),
    installSlug: r.install_slug,
    status: r.status,
    signals: r.signals,
    captured: r.captured ?? [],
    declinedDuplicates: r.declined_duplicates,
    deferred: r.deferred,
    deferredKeys: r.deferred_keys ?? [],
    knownOpenKeys: r.known_open_keys ?? [],
    staleResolvedKeys: r.stale_resolved_keys ?? [],
    standingKeys: r.standing_keys ?? [],
    collectors: Array.isArray(r.collectors) ? r.collectors : [],
    selfEscalations: r.self_escalations ?? [],
  }));
}

/**
 * Pure (watchdog-robustness P-002 / D-003): which collectors have failed for
 * `failStreakToEscalate` CONSECUTIVE ticks (this tick + the most-recent priors),
 * and so should self-escalate. A tick counts toward a collector's streak only when
 * it OBSERVED that collector failing (`ok:false`); an absent collector or a
 * 'skipped' tick (no sweep) breaks the streak — we never saw it fail there.
 * `priorTicks` must be newest-first (the `readRecentWatchdogTicks` order).
 */
export function planSelfEscalations(
  thisTick: CollectorStatus[],
  priorTicks: RecentTick[],
  opts: { failStreakToEscalate?: number } = {},
): string[] {
  const need = Math.max(1, opts.failStreakToEscalate ?? 3);
  const escalate: string[] = [];
  for (const c of thisTick) {
    if (c.ok) continue;
    let streak = 1; // this tick observed it failing
    for (const t of priorTicks) {
      const prior = t.collectors.find((x) => x.name === c.name);
      if (prior && !prior.ok) streak += 1;
      else break;
    }
    if (streak >= need) escalate.push(c.name);
  }
  return escalate;
}

/**
 * The outcome of attempting to run the tick under the cross-host lock (P-003):
 * `{ ran:true, value }` when we held the lock (or fail-open ran unlocked), or
 * `{ ran:false }` when another host held it and we deferred the sweep.
 */
export type TickLockOutcome<T> = { ran: true; value: T } | { ran: false };

/**
 * The DIRECT (non-pooled) URL the tick lock connects on. Deliberately
 * `getHarnessAdminUrl()` — which does NOT route through `maybePgbouncer` — so the
 * lock NEVER rides the PgBouncer transaction pooler, even under PAPERCUSP_PGBOUNCER=1.
 * Exported so the P-001 regression test can assert this invariant (transaction
 * pooling would silently break a session-level advisory lock; see below).
 */
export function watchdogTickLockUrl(): string {
  return getHarnessAdminUrl();
}

/**
 * Dedicated DIRECT `max:1` admin connection for the cross-host tick lock
 * (backend-connection-scaling-2026-06-17 P-001).
 *
 * The tick mutex is a SESSION-level `pg_advisory_lock` whose acquire and release
 * MUST hit the same backend. Under PgBouncer transaction pooling
 * (PAPERCUSP_PGBOUNCER=1) `getOrgPg().sql` routes through the pooler, where each
 * statement is its own transaction and consecutive statements (lock → … → unlock)
 * can land on DIFFERENT server backends → the `pg_advisory_unlock` misses, the lock
 * LEAKS on the original backend, and every subsequent tick fails to acquire →
 * `{ ran:false }` forever → the watchdog SILENTLY STOPS SWEEPING. So the lock rides
 * its OWN dedicated direct connection (bypasses `maybePgbouncer`, exactly like the
 * LISTEN buses do), pinning one stable backend for the lock's whole lifetime.
 *
 * Cost: ONE extra direct backend per process, lazily opened only on hosts that
 * actually run the watchdog (bg-host / :3070) — it does NOT reintroduce the
 * org-pool bloat that C2 cures. `idle_timeout:0` keeps the session alive between
 * ticks (an idle-closed session would drop the lock). Correct in BOTH modes: a
 * direct connection always has a stable session, so there is no PgBouncer-on/off
 * behavioral fork.
 */
let _tickLockSql: Sql | null = null;
function tickLockSql(): Sql {
  if (!_tickLockSql) {
    _tickLockSql = postgres(watchdogTickLockUrl(), {
      onnotice: () => {},
      max: 1,
      idle_timeout: 0, // never idle-close: an idle-closed session drops the advisory lock
      connection: {
        application_name: `pcusp:watchdog-ticklock:p${process.pid}`.slice(0, 63),
      },
    });
  }
  return _tickLockSql;
}

/** Test-only — close + drop the dedicated tick-lock connection between cases. */
export async function _closeWatchdogTickLockForTests(): Promise<void> {
  if (_tickLockSql) {
    await _tickLockSql.end({ timeout: 1 }).catch(() => {});
    _tickLockSql = null;
  }
}

/**
 * Run `fn` while holding the cross-host watchdog advisory lock (watchdog-robustness
 * P-003 / D-004). Two operator hosts (`:3070` + `:3170`, or a deploy overlap) can
 * fire `system:improvement-watchdog` against the ONE shared DB; without this they
 * both sweep and the capture core's search-then-create races into duplicate
 * captures. We hold a SESSION advisory lock on a reserved connection for the whole
 * tick (the captures themselves run on the pool — the lock is just the mutex).
 *
 * The lock connection is a dedicated DIRECT (non-pooled) admin connection — see
 * `tickLockSql()` for WHY (a session advisory lock breaks under PgBouncer
 * transaction pooling; backend-connection-scaling-2026-06-17 P-001).
 *
 * `{ ran:false }` ⇒ another host owns this tick → the caller records a skipped tick.
 * FAIL-OPEN: if the lock plumbing itself errors (can't reserve / lock query fails),
 * run `fn` unlocked — a missed mutex is better than a missed sweep. A `fn` error is
 * NEVER swallowed or double-run; it propagates cleanly.
 */
export async function withWatchdogTickLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<TickLockOutcome<T>> {
  let reserved: Awaited<ReturnType<ReturnType<typeof tickLockSql>['reserve']>>;
  try {
    reserved = await tickLockSql().reserve();
  } catch (e) {
    console.warn(`[improvement-watchdog] could not reserve a connection for the tick lock, running unlocked (fail-open): ${e instanceof Error ? e.message : e}`);
    return { ran: true, value: await fn() };
  }

  let acquired = false;
  let lockErrored = false;
  try {
    try {
      const rows = await reserved<{ ok: boolean }[]>`
        SELECT pg_try_advisory_lock(hashtext('improvement-watchdog'), hashtext(${workspaceId})) AS ok`;
      if (rows[0]?.ok) acquired = true;
    } catch (e) {
      lockErrored = true;
      console.warn(`[improvement-watchdog] advisory-lock query failed, running unlocked (fail-open): ${e instanceof Error ? e.message : e}`);
    }
    if (lockErrored) return { ran: true, value: await fn() };
    if (!acquired) return { ran: false };
    return { ran: true, value: await fn() };
  } finally {
    if (acquired) {
      await reserved`SELECT pg_advisory_unlock(hashtext('improvement-watchdog'), hashtext(${workspaceId}))`.catch(() => {});
    }
    reserved.release();
  }
}

export interface WatchdogTickResult {
  /** 'ran' = swept + captured; 'skipped' = another host held the cross-host lock (P-003). */
  status: 'ran' | 'skipped';
  signals: number;
  captured: string[];
  declinedDuplicates: number;
  deferred: number;
  /** `${source}:${key}` of each deferred signal this tick (P-009 deferred-escalation). */
  deferredKeys?: string[];
  /** Signals dropped pre-plan: their key matches an OPEN improvement (audit P-004 / D-001). */
  knownOpen: number;
  knownOpenKeys: string[];
  /** Signals dropped pre-plan: resolved dup + evidence pre-dating the resolution (audit P-005 / D-002). */
  staleResolved: number;
  staleResolvedKeys: string[];
  /**
   * Signals dropped by the P-003 DELTA GATE: the key already fired on the previous ran tick,
   * so this is a standing condition rather than a new detection. The churn fix's headline
   * counter — a healthy steady state has a high `standing` and a near-zero `captured`.
   */
  standing: number;
  standingKeys: string[];
  /**
   * Keys the RE-FILE RATE LIMIT (EI-20847917368795366) released from `standing` this tick,
   * having measured them continuously suppressed for >= WATCHDOG_REFILE_AFTER_MS. Normally
   * EMPTY: a non-empty value means a condition had gone untracked for half a day, so this is
   * the counter that makes the escape hatch auditable instead of invisible.
   */
  refileEligibleKeys: string[];
  /** Signals dropped by the P-006 METRIC LANE: a statistic, routed to the Blender rather than filed. */
  metricSuppressed: number;
  metricSuppressedKeys: string[];
  /** Every key observed this tick (P-002) — persisted as the NEXT tick's delta basis. */
  seenKeys: string[];
  /** Per-collector outcomes this tick (P-001) — the read path for self-escalation (P-002). */
  collectors: CollectorStatus[];
  /** Improvement ids the watchdog filed about its OWN broken collectors (P-002). */
  selfEscalations: string[];
  /**
   * Issue ids escalated by known-open AGING this tick (consume-edges P-020 /
   * EI-363). Not persisted on the tick row — the durable trace is the item's
   * `payload.knownOpenAging` stamp + the coord escalation record + the comment.
   */
  agingEscalations: string[];
}

/** Options the tick accepts beyond planning/collection (P-001 install slug). */
export interface WatchdogTickOptions extends WatchdogPlanOptions, CollectOptions, KnownOpenAgingTickTunables {
  /** The routine's install slug, recorded on the tick (observability only). */
  installSlug?: string | null;
  /** Consecutive failing ticks before a collector self-escalates (P-002). Default 3. */
  failStreakToEscalate?: number;
  /** Max self-escalations filed per tick (P-002, anti-flood). Default 1. */
  maxSelfEscalationsPerTick?: number;
  /** Tick rows older than this are pruned at the end of each tick (audit P-009). Default 14. */
  tickRetentionDays?: number;
}

/** The collect/capture/record deps a tick body runs with, already resolved. */
interface ResolvedTickDeps {
  capture: typeof captureImprovement;
  recordTick: (rec: WatchdogTickRecord) => Promise<void>;
  readRecentTicks: (workspaceId: string, limit: number, filter?: { status?: 'ran' | 'skipped' }) => Promise<RecentTick[]>;
  readKeyDups: (keys: string[]) => Promise<WatchdogKeyDup[]>;
  pruneTicks: (workspaceId: string, olderThanDays: number) => Promise<void>;
  processAging: (workspaceId: string, knownOpen: readonly KnownOpenAgingInput[], opts: WatchdogTickOptions) => Promise<KnownOpenAgingOutcome[]>;
  processAutoClose: (workspaceId: string, opts: WatchdogTickOptions) => Promise<AutoCloseOutcome[]>;
  redetectRedTests?: RedTestRedetect;
  collect?: () => Promise<WatchdogSignal[]>;
  collectors?: WatchdogCollector[];
}

/**
 * One watchdog tick: collect → plan (cap) → capture each through the shared core
 * (`dedupScope:'open'` — an open duplicate declines; a resolved one re-files the
 * regression) → self-escalate a persistently-failing collector (P-002) → record
 * the tick (P-001, best-effort). The cross-host lock (P-003) wraps this — see
 * `runWatchdogTick`.
 */
async function runWatchdogTickBody(
  workspaceId: string,
  opts: WatchdogTickOptions,
  deps: ResolvedTickDeps,
): Promise<WatchdogTickResult> {
  const { capture, recordTick, readRecentTicks, readKeyDups, pruneTicks } = deps;

  // Collect signals + per-collector status. When a test injects `collect` we lose
  // per-collector granularity (the seam returns signals only), so synthesize one
  // 'injected' status so the tick record is still coherent.
  let signals: WatchdogSignal[];
  let collectors: CollectorStatus[];
  if (deps.collect) {
    signals = await deps.collect();
    collectors = [{ name: 'injected', ok: true, signalCount: signals.length }];
  } else {
    const detailed = await collectWatchdogSignalsDetailed(workspaceId, opts, deps.collectors);
    signals = detailed.signals;
    collectors = detailed.collectors;
  }

  // P-004 / D-001 pre-filter: ONE indexed lookup over payload.watchdogKey drops
  // signals that are already filed (OPEN dup) or whose evidence pre-dates the
  // matching resolution (P-005 / D-002) BEFORE planning — so a standing signal
  // never consumes the per-tick capture budget (live evidence: every slot burned
  // on declined title-dups for a whole 24h window). Best-effort: a read failure
  // degrades to the old behavior (everything planned, title net catches dups).
  // The previous `ran` tick, read ONCE and shared by the P-003 delta gate (its `seenKeys`)
  // and the P-009 deferred-escalation boost below (its `deferredKeys`) — one indexed read per
  // tick rather than one per consumer. Best-effort: on failure both consumers degrade to
  // their no-history behaviour, which is exactly today's semantics.
  // EI-20847917368795366: the SAME read now returns the re-file window (still one indexed
  // read per tick — `limit` widened from 1). ticks[0] remains the prior tick the delta gate
  // and the deferred boost consume; the tail is the consecutive-standing history that
  // decides whether a permanently-suppressed key has earned its one re-file.
  let recentTicks: RecentTick[] = [];
  if (signals.length > 0) {
    try {
      recentTicks = await readRecentTicks(workspaceId, WATCHDOG_REFILE_HISTORY_LIMIT, { status: 'ran' });
    } catch {
      /* no prior-tick history this tick: delta gate off (fails open), deferred boost empty,
         re-file rate limit off (fails CLOSED — an empty set suppresses nothing extra) */
    }
  }
  const priorTick: RecentTick | undefined = recentTicks[0];
  const priorSeenKeys = priorTick?.seenKeys ?? [];
  const refileEligible = computeRefileEligibleKeys(recentTicks, { nowMs: Date.now() });

  let partition: SignalPartition = { fresh: signals, knownOpen: [], staleResolved: [], standing: [] };
  if (signals.length > 0) {
    try {
      const dups = await readKeyDups([...new Set(signals.map(watchdogKeyOf))]);
      partition = partitionSignalsByKnownKeys(signals, dups, priorSeenKeys, refileEligible);
    } catch (e) {
      console.warn(`[improvement-watchdog] key-dup pre-filter failed (degrading to title dedup): ${e instanceof Error ? e.message : e}`);
      // The dup pre-filter is gone, but the delta gate is independent of it and is the
      // load-bearing anti-churn guard — apply it alone rather than re-filing everything.
      if (priorSeenKeys.length > 0) partition = partitionSignalsByKnownKeys(signals, [], priorSeenKeys, refileEligible);
    }
  }

  // Known-open AGING (consume-edges P-020 / EI-363): the pre-filter above is
  // correct dedup, but it made persistence FREE — a known-open key could fire
  // every tick for days with zero added pressure. Continuous firing past the
  // aging threshold bumps the open item's severity once and coord:escalate's
  // the owner (infra-class keys on the short threshold per D-002; re-escalation
  // capped weekly). Best-effort — an aging failure never aborts the tick; a
  // tick with no known-open signals does zero extra reads.
  let agingEscalations: string[] = [];
  if (partition.knownOpen.length > 0) {
    try {
      // EI-19920080383279759: pass the RE-MEASURED body, not just the key. A
      // known-open signal declines its capture (`dedupScope:'open'`), so the
      // filed item's body is frozen at first-fire while this tick's signal —
      // same key, possibly a completely different offender set and remedy —
      // is discarded. Handing the body to the aging path is what lets an
      // escalation show live evidence instead of a fossil.
      const outcomes = await deps.processAging(
        workspaceId,
        partition.knownOpen.map((s) => ({ key: watchdogKeyOf(s), evidence: s.body })),
        opts,
      );
      agingEscalations = outcomes.map((o) => o.issueId);
    } catch (e) {
      console.warn(`[improvement-watchdog] known-open aging failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  // P-009 (auto-close lifecycle): retire watchdog-sourced EIs whose signal cleared
  // (absent from the recent ran-ticks' known-open keys). DEFAULT-OFF flag-gated inside;
  // best-effort — an auto-close failure never aborts the tick.
  try {
    await deps.processAutoClose(workspaceId, opts);
  } catch (e) {
    console.warn(`[improvement-watchdog] auto-close failed: ${e instanceof Error ? e.message : e}`);
  }

  // P-009 deferred-escalation: feed the last RAN tick's deferred keys so a signal
  // that keeps losing a slot is boosted until it lands. Reading status='ran'
  // specifically means a 'skipped' tick (cross-host lock loser, empty deferred
  // list) cannot wipe the boost (audit P-011). Only when there is CONTENTION
  // (more fresh signals than the cap can admit) is the boost meaningful — so a
  // healthy/quiet tick still does zero PG reads (the P-002 no-read-when-healthy
  // invariant). Best-effort — a read failure just means no escalation this tick.
  // P-006 / D-002 METRIC LANE: a throughput/coordination measurement (stalled claims,
  // unanswered escalations, spawn-failure rates, SLO moves) is not a defect a code-writing
  // worker can patch — filing it as a `bug` dispatches a worker at a condition no edit
  // fixes. Those signals stay fully collected and are still written to watchdog_ticks, so
  // they continue to reach ideation via scout/watchdog-health-lane.ts (the Blender corpus
  // digest); they simply never mint a work item. Defect-lane signals are unaffected.
  const fileable = partition.fresh.filter((s) => sourceFilesWorkItem(s.source));
  const metricSuppressed = partition.fresh.filter((s) => !sourceFilesWorkItem(s.source));

  const planCap = Math.max(0, opts.maxPerTick ?? 3);
  // Reuses the single prior-tick read above (P-011: `ran` only, so a skipped tick can't wipe
  // the boost) instead of issuing a second identical query.
  const priorDeferredKeys = fileable.length > planCap ? (priorTick?.deferredKeys ?? []) : [];
  const plan = planWatchdogCaptures(fileable, { ...opts, priorDeferredKeys });
  let plannedForCapture = plan.toCapture;
  // EI-21219920316907087: the collector can observe a red test, then a peer can
  // fix it while this tick is planning other signals. Re-read only the planned
  // red-test paths immediately before filing. A missing current signal means its
  // latest run no longer meets the red predicate, so suppress this stale capture;
  // any re-detect failure keeps the original signal (fail open).
  if (deps.redetectRedTests) {
    const redTestPaths = [...new Set(
      plan.toCapture
        .filter((s) => s.source === 'red-test')
        .flatMap((s) => s.paths ?? []),
    )];
    if (redTestPaths.length > 0) {
      try {
        const current = await deps.redetectRedTests(redTestPaths, opts);
        const currentByKey = new Map(current.map((s) => [watchdogKeyOf(s), s]));
        plannedForCapture = plan.toCapture.flatMap((s) => {
          if (s.source !== 'red-test') return [s];
          const fresh = currentByKey.get(watchdogKeyOf(s));
          return fresh ? [fresh] : [];
        });
      } catch (e) {
        console.warn(`[improvement-watchdog] red-test re-detect failed (keeping initial evidence): ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  const captured: string[] = [];
  let declinedDuplicates = 0;
  for (const s of plannedForCapture) {
    let res: CaptureImprovementResult;
    try {
      res = await capture({
        title: s.title,
        kind: s.kind ?? 'bug',
        body: s.body,
        severity: s.severity,
        paths: s.paths,
        // Explicit scope (consume-edges P-021): the D-005 triage taxonomy keys off it.
        // allow-scope-default: 'operator' is the explicit top-level improvement scope (not a workspace).
        scope: s.scope ?? 'operator',
        foundDuring: 'improvement-watchdog',
        createdBy: 'system:improvement-watchdog',
        sourceRole: 'system',
        source: 'su',
        dedupScope: 'open',
        // P-004: the stable identity the NEXT tick's pre-filter matches on.
        watchdogKey: watchdogKeyOf(s),
        // P-005: the title net's resolved dups also gate on evidence recency.
        evidenceAt: s.latestAt,
        // Frontier P-002: provenance rides from the signal into the row (default organic).
        origin: s.origin,
        // Frontier P-044: the taxonomy slug graduation counts clean passes by.
        findingClass: s.findingClass,
      });
    } catch (e) {
      console.warn(`[improvement-watchdog] capture failed for ${s.source}:${s.key}: ${e instanceof Error ? e.message : e}`);
      continue;
    }
    if (res.created && res.issue) {
      captured.push(res.issue.id);
      // P-002 (silent-intake-central-resolution-2026-09-01, D-001): the search-first
      // decline is retired — a would-be duplicate now FILES, carrying the verdict as
      // payload.dedupVerdict. The metric keeps its meaning (duplicate-classified
      // captures this tick) by counting the annotation instead of the decline.
      const verdict = (res.issue.payload as Record<string, unknown> | undefined)?.dedupVerdict;
      if (verdict === 'likely-duplicate' || verdict === 'stale-evidence') declinedDuplicates += 1;
    }
  }

  // P-002: the watchdog watches itself. If a collector is failing THIS tick, check
  // whether it has now failed `failStreakToEscalate` consecutive ticks and, if so,
  // file ONE kind=bug capture about it through the same core (a forever-failing
  // collector is exactly the kind of broken-thing the watchdog exists to surface).
  // Skipped entirely when nothing failed this tick — no PG read in the healthy case.
  const selfEscalations: string[] = [];
  if (collectors.some((c) => !c.ok)) {
    const failStreak = Math.max(1, opts.failStreakToEscalate ?? 3);
    const maxSelf = Math.max(0, opts.maxSelfEscalationsPerTick ?? 1);
    try {
      const priors = failStreak > 1 ? await readRecentTicks(workspaceId, failStreak - 1) : [];
      const toEscalate = planSelfEscalations(collectors, priors, { failStreakToEscalate: failStreak }).slice(0, maxSelf);
      for (const name of toEscalate) {
        const failed = collectors.find((c) => c.name === name);
        try {
          const res = await capture({
            title: `Watchdog collector "${name}" is failing`,
            kind: 'bug',
            body:
              `The self-improvement watchdog collector "${name}" has failed ${failStreak} consecutive ticks — ` +
              `its signal feed is dark until it is fixed.\n\nLatest error: ${failed?.error ?? '(none captured)'}`,
            severity: 'major',
            paths: ['packages/operator-core/lib/harness/improvements/watchdog.ts'],
            foundDuring: 'improvement-watchdog',
            createdBy: 'system:improvement-watchdog',
            sourceRole: 'system',
            source: 'su',
            dedupScope: 'open',
            watchdogKey: `watchdog-self:${name}`,
          });
          if (res.created && res.issue) selfEscalations.push(res.issue.id);
        } catch (e) {
          console.warn(`[improvement-watchdog] self-escalation capture failed for ${name}: ${e instanceof Error ? e.message : e}`);
        }
      }
    } catch (e) {
      console.warn(`[improvement-watchdog] self-escalation skipped (recent-ticks read failed): ${e instanceof Error ? e.message : e}`);
    }
  }

  const result: WatchdogTickResult = {
    status: 'ran',
    signals: signals.length,
    captured,
    declinedDuplicates,
    deferred: plan.deferred.length,
    deferredKeys: plan.deferred.map((s) => `${s.source}:${s.key}`),
    knownOpen: partition.knownOpen.length,
    knownOpenKeys: partition.knownOpen.map(watchdogKeyOf),
    staleResolved: partition.staleResolved.length,
    staleResolvedKeys: partition.staleResolved.map(watchdogKeyOf),
    standing: partition.standing.length,
    standingKeys: partition.standing.map(watchdogKeyOf),
    // Only the keys the limit actually RELEASED — intersect with what fired this tick, so a
    // stale eligibility never reads as a filing that happened.
    refileEligibleKeys: [...new Set(signals.map(watchdogKeyOf))].filter((k) => refileEligible.has(k)),
    metricSuppressed: metricSuppressed.length,
    metricSuppressedKeys: metricSuppressed.map(watchdogKeyOf),
    // P-002: EVERY key observed this tick — the next tick's delta basis. Deliberately the
    // full signal set, not just the filed ones: the churn case is a signal whose item was
    // retired between ticks, so a filed-only ledger would miss exactly the keys that matter.
    seenKeys: [...new Set(signals.map(watchdogKeyOf))],
    collectors,
    selfEscalations,
    agingEscalations,
  };

  // P-001: record the tick (best-effort — a bookkeeping failure never aborts it).
  try {
    await recordTick({
      workspaceId,
      installSlug: opts.installSlug ?? null,
      status: result.status,
      signals: result.signals,
      captured: result.captured,
      declinedDuplicates: result.declinedDuplicates,
      deferred: result.deferred,
      deferredKeys: result.deferredKeys,
      knownOpenKeys: result.knownOpenKeys,
      staleResolvedKeys: result.staleResolvedKeys,
      seenKeys: result.seenKeys,
      standingKeys: result.standingKeys,
      collectors: result.collectors,
      selfEscalations: result.selfEscalations,
    });
  } catch (e) {
    console.warn(`[improvement-watchdog] tick record failed: ${e instanceof Error ? e.message : e}`);
  }

  // P-009 (audit): prune old tick rows — best-effort, same swallow-errors
  // contract as recordTick; a GC failure must never abort the tick.
  try {
    await pruneTicks(workspaceId, Math.max(1, opts.tickRetentionDays ?? 14));
  } catch (e) {
    console.warn(`[improvement-watchdog] tick prune failed: ${e instanceof Error ? e.message : e}`);
  }

  return result;
}

/**
 * Run one watchdog tick under the cross-host advisory lock (P-003). If another
 * host holds the lock this tick is SKIPPED (a `skipped` tick is recorded) so the
 * two hosts can't double-sweep and race the capture core into duplicate captures.
 * (P-011) Accepts optional collectors for per-target-project sources.
 */
export async function runWatchdogTick(
  workspaceId: string,
  opts: WatchdogTickOptions = {},
  deps?: Partial<WatchdogDeps> & { collectors?: WatchdogCollector[] },
): Promise<WatchdogTickResult> {
  const capture = deps?.capture ?? captureImprovement;
  const recordTick = deps?.recordTick ?? recordWatchdogTick;
  const readRecentTicks = deps?.readRecentTicks ?? readRecentWatchdogTicks;
  const withLock = deps?.withTickLock ?? withWatchdogTickLock;
  const readKeyDups = deps?.readKeyDups ?? readWatchdogKeyDups;
  const pruneTicks = deps?.pruneTicks ?? pruneWatchdogTicks;
  const processAging = deps?.processAging
    ?? ((ws: string, knownOpen: readonly KnownOpenAgingInput[], o: WatchdogTickOptions) =>
      processKnownOpenAging(ws, knownOpen, agingOptionsFromTick(o)));
  const processAutoClose = deps?.processAutoClose
    ?? ((ws: string, _o: WatchdogTickOptions) => runAutoCloseSweep(ws));
  // The built-in collector path gets a targeted ledger re-read. Injected
  // collectors/tests must opt into the seam explicitly so unit ticks never
  // open an unexpected database connection.
  const redetectRedTests = deps?.redetectRedTests
    ?? (!deps?.collect && !deps?.collectors
      ? ((paths: string[], o: CollectOptions) => collectRedTestSignals(getOrgPg().sql, o, paths))
      : undefined);

  const outcome = await withLock(workspaceId, () =>
    runWatchdogTickBody(workspaceId, opts, {
      capture,
      recordTick,
      readRecentTicks,
      readKeyDups,
      pruneTicks,
      processAging,
      processAutoClose,
      redetectRedTests,
      collect: deps?.collect,
      collectors: deps?.collectors,
    }),
  );
  if (outcome.ran) return outcome.value;

  // Another host owns this tick — record a skipped tick and return (P-003).
  const skipped: WatchdogTickResult = {
    status: 'skipped',
    signals: 0,
    captured: [],
    declinedDuplicates: 0,
    deferred: 0,
    knownOpen: 0,
    knownOpenKeys: [],
    staleResolved: 0,
    staleResolvedKeys: [],
    standing: 0,
    standingKeys: [],
    // A skipped tick suppressed nothing, so it released nothing. It is also excluded from
    // the re-file window by the `status:'ran'` filter, so it cannot break a standing run.
    refileEligibleKeys: [],
    metricSuppressed: 0,
    metricSuppressedKeys: [],
    // A skipped tick observed nothing. Safe for the delta gate because it reads the most
    // recent `ran` tick only — an empty skipped row can never wipe the diff basis (the same
    // reasoning as the P-011 deferred-keys boost).
    seenKeys: [],
    collectors: [],
    selfEscalations: [],
    agingEscalations: [],
  };
  try {
    await recordTick({ workspaceId, installSlug: opts.installSlug ?? null, ...skipped });
  } catch (e) {
    console.warn(`[improvement-watchdog] skipped-tick record failed: ${e instanceof Error ? e.message : e}`);
  }
  return skipped;
}

// ── P-012 (audit): routine-tunable options ───────────────────────────────────

/** The numeric tick options tunable from the routine's `payload_template` (audit P-012).
 *  Exported so the `improvements:set-watchdog-tunables` control tool
 *  (live-configurability-audit P-004) validates writes against the same whitelist. */
export const PAYLOAD_TUNABLE_KEYS = [
  // planning caps
  'maxPerTick', 'perSourceCap',
  // collector bars (CollectOptions)
  'redTestWindowHours', 'redTestMinFails', 'toolErrorWindowHours', 'structuralMinCount',
  'structuralMinRate', 'structuralMinCallsForRate', 'transientMinCount', 'callerMinCount',
  'softFailureMinRun',
  'serviceHealthMaxStaleMs', 'smokeFailRecentHours', 'expiredLeaseWindowDays',
  'expiredLeaseMinCount', 'failedSpawnWindowHours', 'failedSpawnMinCount',
  // dispatcher-staleness (EI-2150): hours the auto-implement dispatcher may go silent
  // while armed work waits before the lane is flagged stalled
  'dispatcherStalenessThresholdHours',
  // self-escalation + retention
  'failStreakToEscalate', 'maxSelfEscalationsPerTick', 'tickRetentionDays',
  // known-open aging (consume-edges P-020 — D-004 PROPOSED defaults, tunable here
  // so the ratified values land via the routine payload without a deploy)
  'agingGeneralThresholdHours', 'agingInfraThresholdHours', 'agingReescalateDays',
  'agingContinuityGapMinutes', 'maxAgingEscalationsPerTick',
  // learning-SLO sensor thresholds (frontier P-047 / FB-21 — defaults in
  // learning-slo.ts LEARNING_SLO_DEFAULTS; tunable here so SLO tuning never
  // needs a deploy)
  'triageEntropyWindowDays', 'triageEntropyMinSample', 'triageEntropyMinNormalized',
  'flowWindowDays', 'flowMinInflow', 'flowMaxRatio',
  'mttshRecentDays', 'mttshBaselineDays', 'mttshMinSamples', 'mttshMaxRegressionFactor',
  'governorStarvationFloorUsd',
  'memoryZeroHitRecentHours', 'memoryZeroHitBaselineDays', 'memoryZeroHitMinRecalls',
  'memoryZeroHitMaxRate', 'memoryZeroHitSpikeFactor',
] as const;

/**
 * Pure (audit P-012): extract the numeric tick tunables from a routine's
 * `payload_template`, so collector bars + caps tune from the routines admin
 * WITHOUT a deploy. Whitelisted keys only; non-numeric values are ignored
 * (collector defaults hold). Env (`PAPERCUSP_IMPROVEMENT_WATCHDOG_MAX_PER_TICK`)
 * still wins over the payload for maxPerTick — env is the emergency override,
 * the payload is the standing config.
 */
export function watchdogOptionsFromPayload(payload: Record<string, unknown> | null | undefined): Partial<WatchdogTickOptions> {
  const out: Record<string, number> = {};
  if (!payload) return out;
  for (const k of PAYLOAD_TUNABLE_KEYS) {
    const v = payload[k];
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    if (Number.isFinite(n)) out[k] = n;
  }
  return out as Partial<WatchdogTickOptions>;
}
