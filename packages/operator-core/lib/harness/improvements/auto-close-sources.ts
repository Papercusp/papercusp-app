/**
 * The auto-close-eligible watchdog SOURCE allowlist, in a LEAF module.
 *
 * WHY THIS IS NOT IN `auto-close.ts` (EI-20106946822538304): two subsystems need this set —
 * the auto-close sweep (which CLOSES a recovered item) and the issue-family self-select claim
 * floor (which must not OFFER one during its recovery window). Importing `auto-close.ts` from
 * `work-items.ts` is a cycle: `work-items.ts -> auto-close.ts -> issues-engineer.ts ->
 * work-items.ts`. This module imports NOTHING, so both sides can share the one definition
 * instead of forking a second copy that silently drifts — a forked allowlist would mean the
 * claim floor and the auto-close sweep disagreeing about which sources self-heal, which is
 * exactly the class of bug the shared-oracle discipline elsewhere in the claim path exists to
 * prevent (see `observationLaneExclusionSql`'s "ONE source of truth shared by the claim and
 * the miss diagnosis" note).
 *
 * `auto-close.ts` re-exports this symbol, so its public API is unchanged.
 */

/**
 * Sources where a signal's ABSENCE reliably means the problem resolved (the
 * collector runs every tick and would re-fire if it persisted). Conservative
 * allowlist — live-state/one-shot/ambiguous sources stay out so a quiet tick is
 * never mistaken for a resolution.
 */
export const AUTO_CLOSE_ELIGIBLE_SOURCES: ReadonlySet<string> = new Set([
  // ⛔ 'red-test' is DELIBERATELY ABSENT — do not re-add it (template-supply-chain-repair
  // 2026-08-10 P-003). It is the one source whose input is a LOG OF EXTERNALLY-TRIGGERED
  // EVENTS (`harness_shared.test_runs`) rather than a live re-derivation of the condition.
  // Every other entry here re-evaluates its own predicate each tick (a DB query, a claim
  // table, a routine's `active` flag), so a quiet tick genuinely means "the condition is
  // gone". For red-test a quiet tick means only "nobody RAN this test" — the collector
  // cannot distinguish a test that was fixed from one that was dropped from its suite,
  // renamed, left un-owned by any vitest config, or whose checkout disappeared.
  //
  // Measured case (EI-11141, templates/papercusp-app/checks/composition-integrity
  // .test.ts): last run 2026-07-27, `resolved` 2026-08-02, and ZERO 'pass' rows in ALL of
  // test_runs history — the named import (@papercusp/template-kit) was still unresolvable
  // when the item was closed, and stayed broken for another 8 days. Its runs stopped
  // because NO vitest config owns templates/**/checks/*.test.ts (testing:run answers
  // TEST_FILE_ROUTE_ERROR), not because anything was fixed.
  //
  // Removing it costs nothing: red-test is also the ONLY source with a POSITIVE-evidence
  // resolution path (`resolveProvenGreenRedTests`, P-007), which resolves a genuinely-fixed
  // test on N consecutive recorded greens and attaches them as real completion evidence.
  // Absence-closing it was strictly the weaker, unfalsifiable half of that pair.
  // ⛔ 'repeated-tool-error' is DELIBERATELY ABSENT. A quiet error-observation window
  // only proves that the failing call was not observed; it does not prove that the
  // underlying deployed tool schema or handler changed. In particular, traffic can
  // stop after a schema rejection, making absence indistinguishable from an idle
  // monitor. Require positive verification (or an explicit fix/deploy reference)
  // before retiring this source; absence-only auto-close is unsafe here.
  'stalled-feature',
  'unresolved-escalation',
  'failed-spawn',
  'smoke-fail',
  'escalation-spike',
  'fire-circuit-open',
  // P-011: per-harness sources whose absence reliably means resolution (a torn-down
  // benchmark hive's saturation/orphan/stuck signal simply stops). Added so auto-close
  // retires the full benchmark-debris set (governor-starvation was the gap — 27 EIs).
  'governor-starvation',
  'orphaned-spawn',
  'stuck-plan',
  'ship-link-stuck',
  // agent-activity-liveness-truth P-007: a live-state collector — when the claim
  // progresses (or is freed/reclaimed) the stalled signal simply stops, so its
  // absence reliably means resolution.
  'stalled-claim',
  // WI-38327: collectBridgeNeedsOwnerSignals re-derives its whole predicate from PG every
  // tick (the escalation row's needs_owner flag JOINed against the attention_notifications
  // audit) and caches/latches nothing, so a quiet tick means one of the two genuine
  // resolutions: the block cleared, or the owner rail now holds a record of it. The second
  // is permanent — the EXISTS is cause-matched with no time window, so once the alarm
  // lands it keeps matching for the life of that episode rather than ageing back into a
  // violation. A THROWING tick is not an absent one: the sweep counts ran-ticks only.
  'bridge-needs-owner-unalerted',
  // EI-5994: collectLoopStalledSignals filters `r.active = true` — once the dead-owner
  // reaper (loop-unreachable-guard / autoPauseLoopRoutine) deactivates the routine, this
  // signal STOPS firing immediately and unconditionally (not just recency-gated), so its
  // absence reliably means the underlying loop is gone/paused, not merely quiet.
  'loop-stalled',
  // EI-1760: collectMigrationDriftSignals re-derives `missing` from a live DB query
  // EVERY tick (never caches/latches) and, unlike service-down's freshness-gated probe
  // skip, degrades LOUD not silent on failure — checkMigrationDrift's own internal
  // catch treats an unreachable schema_migrations tracker as "report all on-disk as
  // missing", so a query outage still FIRES the signal rather than going quiet. A quiet
  // tick therefore reliably means every on-disk migration is applied (the common case:
  // the operator restarted and boot-apply caught up) — the exact condition this EI was
  // filed to auto-resolve instead of leaving self-cleared criticals polluting the queue.
  'migration-drift',
  // EI-18143028205990222 class: perf-regression-rig.ts's `consider()` re-derives EVERY
  // metric (loop-lag-p95, conn-saturation, dispatch-orphan-rate, coord-open-escalations,
  // adv-tab-switch-median, adv-fcp) from a LIVE query/read each tick — none of them cache
  // or latch a stale verdict — so a quiet tick reliably means the metric has dropped back
  // under budget, the same reasoning as `migration-drift` above. Without this, a SLO
  // breach whose root cause is already fixed elsewhere (e.g. dispatch-orphan-rate reading
  // a trailing 24h window full of PRE-FIX orphan rows — verified zero new orphans for 4h+
  // after durable-spawn.ts's EI-18118495431535177 fix landed) has NO path back to closed:
  // the collector keeps re-deriving the same true-but-stale elevated number every tick
  // until the window ages the old rows out (hours), and nothing ever retires the EI in
  // the meantime — every future transient perf-regression breach would hit the same dead
  // end. dispatchOrphanRate/connSaturationPct/etc. dropping below budget on a later tick
  // is exactly the "signal absent from known-open keys" condition this sweep exists for.
  'perf-regression',
  // EI-19417016857494865: collectRoutineFailureSignals re-derives from a LIVE query every
  // tick (`active = true AND metadata->>'last_error' <> ''`) and never caches or latches —
  // the same reasoning as `loop-stalled` and `migration-drift` above. The routine RUNNER
  // deletes `last_error`/`last_error_at`/`last_error_source` on its success path
  // (routines-workflow.ts, source-scoped to 'runner'), so the signal stops the moment a
  // routine fires cleanly again; deactivation also stops it unconditionally via the
  // `active = true` filter. A quiet tick therefore reliably means the routine recovered.
  // Without this, an instantaneous self-clearing failure (e.g. git-sync hitting one
  // transient GitHub `Connection reset by peer` on a ~2min cadence) is escalated to a
  // PERSISTENT claimable MAJOR bug that nothing ever retires: measured 2026-08-03, the
  // `routine:git-sync` key alone re-filed 3× in 3 days and 12 such EIs since 07-11 were
  // each hand-drained by a separate agent burning a full claim cycle on an
  // already-recovered routine. The open-dup guard only suppresses a re-file WHILE one is
  // open, so draining one merely clears the way for the next.
  'routine-failure',
  // WI-40769: ADMITTED, and the two things that previously made it unsafe are now
  // both closed. Before this, service-down could be RAISED but never LOWERED —
  // measured 2026-08-23: `service-down:operator` (EI-20100362973577553) open 12
  // days asserting nothing is listening while the operator answered 200 in 86ms,
  // and `service-down:staging-api` (EI-19478400954666484) open 19 days. Three of
  // the five non-terminal service-down rows all-time were stale in exactly this
  // way. Note the defect was never OVER-FILING — `payload.watchdogKey` dedup works
  // (one open row per service, not a flood); it was that a filed row had no path
  // back to closed, so a self-clearing outage became permanent claimable backlog.
  //
  // 1. THE COLLECTOR NO LONGER GOES BLIND SILENTLY. `serviceDownCollectorResult`
  //    used to skip collection on a stale service-health snapshot (the P-004
  //    freshness gate), which is what the `migration-drift` entry above cites as
  //    the disqualifier. It now runs a fresh bounded `probeAll()` INLINE on a
  //    stale snapshot and emits off that, and if the inline probe itself throws it
  //    emits a LOUD `service-down:monitor-degraded` signal. So it degrades loud,
  //    not silent — the same property that qualified migration-drift. Measured
  //    over 3 days: 288 ran-ticks, 286 clean, 2 on the inline-probe fallback, 0 on
  //    the legacy skip.
  // 2. THE REMAINING BLIND PATHS ARE NOW DECLARED, NOT INFERRED. The legacy skip
  //    (PAPERCUSP_WATCHDOG_SERVICE_HEALTH_INLINE_PROBE=0) and the inline-probe
  //    failure both return `observed:false, unobservedSource:'service-down'`, and
  //    `decideAutoClose` subtracts those ticks from the absence evidence. So a
  //    monitor outage can no longer read as "every service recovered" — the sweep
  //    waits for ticks where the collector actually looked.
  //
  // ⚠ Do NOT re-add a source here on the strength of (1) alone. It is (2) that
  // makes a can-go-blind collector safe: without a declared unobserved tick, a
  // quiet tick and a blind tick are INDISTINGUISHABLE in the tick record.
  'service-down',
]);

/** The same evidence window used by the auto-close sweep and its claim floor. */
export const AUTO_CLOSE_DEFAULT_MIN_TICKS = 6;
