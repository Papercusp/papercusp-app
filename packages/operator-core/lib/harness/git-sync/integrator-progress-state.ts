/**
 * integrator-progress-state — the COMPLETE persisted shape of
 * `routines.metadata.integrator_progress`, plus the one function allowed to
 * build it, plus the pure predicate that decides whether a stalled lease-holder
 * loses candidacy (EI-19442274898324113).
 *
 * ## Why this module exists
 *
 * The integrator election gates candidacy on `requiresRoutine: 'git-sync'` —
 * EXACT membership in a peer's published `shared_presence.active_routines`
 * (WI-6996). That proves THE ROUTINE IS ARMED. It does not prove the device is
 * actually advancing this pot's canonical ref. The gap is the same
 * declaration-vs-progress confusion as `heartbeatFresh` != "taking turns":
 * liveness plus claimed capability is not evidence of PROGRESS.
 *
 * It has bitten twice in two days, both times for ~5h, both times self-healing,
 * both times with every health surface reporting green:
 *   2026-08-02  lease held ~5h, origin/staging 70 commits behind
 *   2026-08-03  lease held 5.4h, origin/staging 28 commits behind
 * In each case the holder published `git-sync` legitimately and won the
 * election with a fresh heartbeat while canonical `refs/hive/staging` did not
 * move at all.
 *
 * ## Why the persisted state, and why it is a read-modify-write contract
 *
 * "Is the integrator making progress?" is NOT answerable from one tick. The
 * instantaneous namespace-ahead delta is nonzero on any busy pot almost always
 * — git-sync commits every few minutes, so there is nearly always SOMETHING
 * un-integrated. Thresholding on backlog alone therefore alarms (and here,
 * would PREEMPT) on a perfectly healthy pipeline. The verdict requires a
 * REMEMBERED canonical sha: backlog present AND canonical did not move. A
 * remembered value is what turns an instantaneous reading into a progress
 * verdict — the same trick `of_origin_sha` and `of_integrator_canonical_sha`
 * already use on the detector side.
 *
 * `patchRoutineMetadata` is:
 *
 * ```sql
 * SET metadata = COALESCE(metadata,'{}'::jsonb) || $3::jsonb
 * ```
 *
 * `||` is a TOP-LEVEL jsonb merge, so writing the `integrator_progress` key
 * REPLACES that whole object rather than deep-merging into it. Every write is
 * a read-modify-write contract and any field a writer omits is DELETED,
 * silently. `worktree-bridge-state.ts` documents what that costs: a writer
 * that omitted the accept-free census wiped the streak mid-freeze, so the
 * detector built to catch a stalled bridge went quiet during the stall it
 * existed to report. That failure mode is worse HERE, because this state does
 * not merely report — it gates a takeover. A writer that resets
 * `stalledSinceMs` every tick would make the preemption unreachable forever
 * while looking perfectly healthy.
 *
 * So, exactly as with `worktree_bridge`: obtain the value from
 * {@link nextIntegratorProgressState} and never spread extra keys at a call
 * site.
 *
 * ## Adding a field
 *
 * Add it to {@link IntegratorProgressState} and populate it in
 * {@link nextIntegratorProgressState}. Never at a call site.
 */

/** The complete persisted shape. Every field is written on every write. */
export interface IntegratorProgressState {
  /** Canonical `refs/hive/staging` as observed on this tick (null ⇒ unreadable). */
  canonicalSha: string | null;
  /**
   * When canonical was FIRST observed stuck at {@link canonicalSha} while there
   * was backlog to integrate. Null ⇒ not currently stalled (it advanced, or
   * there is nothing to integrate, or this is the first observation).
   */
  stalledSinceMs: number | null;
  /** Observation timestamp — makes a stale/absent writer visible in the row. */
  at: number;
}

/** The subset a prior row is read back as (all fields optional/loose — it is jsonb). */
export interface PriorIntegratorProgressState {
  canonicalSha?: string | null;
  stalledSinceMs?: number | null;
  at?: number | null;
}

export interface IntegratorProgressTickFacts {
  /** Canonical `refs/hive/staging` read this tick; null if unreadable. */
  canonicalSha: string | null;
  /** Commits the local namespace has that canonical lacks. Null/0 ⇒ nothing to integrate. */
  backlogCommits: number | null;
  nowMs: number;
}

/**
 * Whether a peer's namespace has work that makes it a useful integrator
 * candidate for the current canonical ref.
 *
 * Namespace presence proves only that the peer has participated in this repo;
 * it does not prove that the peer currently has anything to integrate. Keeping
 * an idle peer in the deterministic election can put the lease on a machine
 * whose namespace is at canonical while another peer's namespace is ahead.
 *
 * Measurement is deliberately fail-open: an unreadable canonical ref or an
 * unsuccessful ahead-count must not eject a capable peer from candidacy. A
 * readable namespace with a verified zero count is the only negative verdict.
 */
export function isIntegratorNamespaceBacklogged(input: {
  namespaceSha: string | null;
  canonicalSha: string | null;
  aheadCommits: number | null;
}): boolean {
  if (input.namespaceSha == null) return false;
  if (input.canonicalSha == null || input.aheadCommits == null) return true;
  return input.aheadCommits > 0;
}

/**
 * Default stall budget before a non-advancing lease-holder loses candidacy: 2h.
 *
 * DERIVATION (not a guess — the shape of this number is the whole risk):
 *  • Healthy baseline is STRUCTURALLY minutes: a working integrator advances
 *    canonical every tick that has anything to merge, and git-sync commits on a
 *    ~10-minute jittered cron. Multi-hour non-advancement WITH backlog is not a
 *    slow tick, it is a stall.
 *  • The detector (DEFAULT_INTEGRATOR_BACKLOG_SWEEPS_MAX = 4 sweeps × ~15min)
 *    alerts at ~1h. Acting is strictly more consequential than alerting, so the
 *    preempt budget is deliberately 2× the alert budget: warn first, act at
 *    double. A window where we have alerted but not yet acted is intentional —
 *    it is the operator's chance to see it first.
 *  • Both measured incidents ran ~5h, so 2h fires with ~3h of margin while
 *    sitting far outside any plausible healthy variance.
 *
 * EXPRESSED IN TIME, NOT TICKS, ON PURPOSE. This runs in the integrator leg,
 * which ticks far more often than the 15-minute freshness sweep the detector
 * uses. A tick counter copied from the detector's sweep budget would fire in
 * ~24 minutes here, not 2 hours — the same number meaning something different
 * in two cadences. Time is cadence-independent and survives a cron change.
 */
export const DEFAULT_INTEGRATOR_STALL_PREEMPT_MS = 2 * 60 * 60 * 1000;

/**
 * The ONE sanctioned builder. Read-modify-write: pass the prior row verbatim.
 *
 * Transitions:
 *  • canonical unreadable      ⇒ carry the prior verdict unchanged. An IO blip
 *    must never look like progress (which would reset a real stall) NOR like a
 *    stall (which would preempt on a transient git failure).
 *  • canonical MOVED           ⇒ progress. Clear the stall.
 *  • canonical same, no backlog ⇒ healthy idle. Clear the stall: an integrator
 *    with nothing to merge is CORRECT to leave canonical alone, and counting
 *    that as a stall is precisely the false alarm that nearly shipped on the
 *    detector side.
 *  • canonical same, backlog>0 ⇒ stalled. Start the clock, or keep the existing
 *    start (never restart it — restarting is how a stall becomes unreachable).
 *  • first-ever observation    ⇒ never stalled. A guard must not fire on its own
 *    cold start; we have no evidence canonical stood still.
 */
export function nextIntegratorProgressState(
  prior: PriorIntegratorProgressState | null | undefined,
  tick: IntegratorProgressTickFacts,
): IntegratorProgressState {
  const priorSha = prior?.canonicalSha ?? null;
  const priorSince = prior?.stalledSinceMs ?? null;

  if (tick.canonicalSha == null) {
    // Unreadable this tick — carry the prior verdict verbatim.
    return { canonicalSha: priorSha, stalledSinceMs: priorSince, at: tick.nowMs };
  }

  // First-ever observation, or canonical advanced ⇒ progress.
  if (priorSha == null || tick.canonicalSha !== priorSha) {
    return { canonicalSha: tick.canonicalSha, stalledSinceMs: null, at: tick.nowMs };
  }

  // Same sha. Only counts as a stall if there is actually something to integrate.
  if ((tick.backlogCommits ?? 0) <= 0) {
    return { canonicalSha: tick.canonicalSha, stalledSinceMs: null, at: tick.nowMs };
  }

  return {
    canonicalSha: tick.canonicalSha,
    stalledSinceMs: priorSince ?? tick.nowMs,
    at: tick.nowMs,
  };
}

/**
 * Has the current lease-holder stalled long enough to lose candidacy?
 *
 * Pure so the decision is unit-testable independently of the election, the DB
 * and git — the same split that made `isIntegratorStalledThisSweep` testable
 * while the watchdog's wiring deliberately is not.
 *
 * SAFETY (why preempting is sound, from the leg's own contract): both
 * lock-authority selectors add SELF unconditionally AFTER the exclusion filter,
 * so excluding the holder degenerates to "self wins ⇒ this node integrates its
 * own repo", which git-sync-action.ts documents as "strictly better than
 * freezing". Two nodes briefly both integrating is the already-accepted risk of
 * this leg (FF-only + CAS + epoch fence, proven P-308). The worst case of a
 * WRONG preemption is therefore a redundant integration, not corruption.
 */
export function shouldPreemptStalledIntegrator(input: {
  state: IntegratorProgressState;
  backlogCommits: number | null;
  nowMs: number;
  /** Defaults to {@link DEFAULT_INTEGRATOR_STALL_PREEMPT_MS}. */
  stallMs?: number;
}): boolean {
  // Nothing to integrate ⇒ the holder is not failing at anything.
  if ((input.backlogCommits ?? 0) <= 0) return false;
  if (input.state.stalledSinceMs == null) return false;
  const stallMs = input.stallMs ?? DEFAULT_INTEGRATOR_STALL_PREEMPT_MS;
  return input.nowMs - input.state.stalledSinceMs >= stallMs;
}
