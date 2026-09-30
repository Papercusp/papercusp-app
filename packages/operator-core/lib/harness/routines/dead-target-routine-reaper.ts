/**
 * dead-target-routine-reaper — the PURE DECIDER for "this routine's target tree is dead".
 * (dead-target-routine-reaper-2026-08-30 P-001, from EI-19278517916030043.)
 *
 * THE GAP THIS CLOSES: a durable routine keeps firing against a target whose tree can no
 * longer be read, forever, and nothing reaps it. `ei669-repro-su-b621d` — an abandoned EI-669
 * reproduction pot in /tmp with an unrecoverable corrupt git object — burned ~2,400 doomed
 * `system:git-sync` ticks (646 consecutive error ticks), ~120 doomed `green-checkpoint` runs
 * and a `cross-hive-outbox-drain` every ~2min across 5 DAYS. Every one of them was hopeless
 * from the first attempt: the tree was unreadable and retrying cannot make an object exist.
 * It stopped only because a human noticed the alarm and paused the routines by hand. Those
 * 646 ticks are also what drove the fleet-wide deploy panel to crit for 32h (worst-wins), so
 * one dead scratch pot degraded a shared signal for the entire fleet.
 *
 * WHY A DIRECT STRUCTURAL PROBE, NOT A FAILURE STREAK (D-001). The source item proposed
 * parking "on N consecutive failures with a permanent-looking cause". We keep the cause
 * vocabulary and drop the counting, for three reasons in ascending order of force:
 *
 *   1. There is nothing to count. `harness_shared.routines` has 21 columns and NO generic
 *      consecutive-failure counter — each action rolls its own error bookkeeping into
 *      `metadata` instead (git-sync alone carries last_error, last_errors,
 *      consecutive_content_error_ticks, wd_error_sweeps, last_status, watchdog_alerted). A
 *      streak design therefore costs a shared-scheduler schema change, on the fire hot path,
 *      affecting every pot in the fleet, BEFORE one dead pot can be reaped.
 *   2. A streak is a STALE WATERMARK. This codebase has paid for that twice already, in the
 *      nearest analogous module: `autoloop-chronic-failure.ts` escalated already-paused rows
 *      forever because a count of past failures never says whether the thing is still failing
 *      (EI-6760/6761/6762), and an orphaned row whose count can never reset re-escalated every
 *      debounce cycle in perpetuity (EI-6765). Each needed a bolt-on guard. The four ei669
 *      rows are that exact shape TODAY: `active = false` since 2026-08-01, still carrying live
 *      error metadata.
 *   3. The streak is only ever a PROXY for the structural fact. "646 consecutive git-sync
 *      errors" is evidence that the tree is broken; the tree being broken is the thing we
 *      actually want to know, and it is directly observable. Measuring the proxy costs 646
 *      doomed fires and 5 days of latency to reach a conclusion available on tick one.
 *
 * WHY THIS FAILS CLOSED WHERE ITS SIBLING FAILS OPEN (D-002). `autoloop-chronic-failure.ts`
 * deliberately treats every unknown state as still-live and escalates anyway — correctly, for
 * IT: its action is FILING AN OBSERVATION, so acting on unknown costs a redundant ticket while
 * suppressing costs a missed alarm. Our action DISABLES EXECUTION, so the costs invert: acting
 * on unknown costs an outage. Copying that module's fail-open stance into a write-side reaper
 * would be a category error, so `unknown` here is a first-class fourth state rather than a
 * boolean, and ONLY the two positively-confirmed permanent states may ever park.
 *
 * WHY A SINGLE OBSERVATION NEVER PARKS (D-003). A pot home that is lazily materialized,
 * remote-mounted, or briefly unmounted would defeat a one-shot `stat()`. Rather than bet on
 * whether such a pot exists, `confirmPermanence` requires the SAME permanent verdict on two
 * sweeps separated by at least one interval: any root that materializes within the window is
 * seen present on the second look and never parks. The cost is one sweep interval of extra
 * latency on a genuinely dead pot, against five days of status quo.
 *
 * WHY THE RESOLUTION OUTCOME IS A TAGGED UNION AND NOT AN OPTIONAL PATH (D-003, the subtler
 * half — a live hazard, not a hypothetical). `resolveProject` returns `null` for BOTH "this
 * slug is not registered" AND "the registry could not be read": `findRegisteredProjectBySlug`
 * swallows its cross-workspace read error in a bare catch whose own comment says "registry
 * unreadable, fall through to null"
 * (harness-core.ts:246-260) and `resolveProject` returns that same null after its retired-slug
 * alias fallback also misses (:263-283). Collapsing those into one falsy check would let a
 * single transient registry read failure park every routine of every install it could not
 * resolve — precisely the fleet-wide outage D-002 exists to prevent, arriving through a path
 * D-002's own wording did not name. So `root-missing` is keyed on a POSITIVE observation only
 * (resolved, concrete path obtained, that path confirmed absent), and the caller must hand us
 * WHICH of the three resolution outcomes occurred rather than an optional string. This
 * codebase already draws the same distinction one function away: `resolveWorkspaceForHarnessSlug`
 * throws `RegistryReadUnavailableError` specifically so that "nothing was found" is not
 * returned as the same null a genuine absence returns (harness-core.ts:440-448).
 *
 * PURITY IS THE POINT: no I/O lives here, so every interesting case — and especially every
 * fail-closed one — is unit-testable without a populated operator, mirroring
 * `unclaimable-routine-detector.ts`'s `classifyClaimSkip`. The probe (P-002) and the sweep
 * (P-003) supply the facts; this module only decides.
 */

/**
 * How the install slug resolved to an on-disk root. A tagged union rather than
 * `path?: string` on purpose — see the module header: `resolveProject` returns `null` for both
 * an unregistered slug and an unreadable registry, and only the CALLER is positioned to tell
 * them apart. Neither non-resolved case is evidence about the TREE, so both decide `unknown`.
 */
export type TargetResolution =
  /** The project registry resolved this slug to a concrete on-disk root. */
  | { kind: 'resolved'; path: string }
  /** The registry was read successfully and this slug is genuinely not registered. */
  | { kind: 'unresolvable' }
  /** The registry itself could not be read — we did not look, so we know nothing. */
  | { kind: 'read-failed'; detail?: string | null };

/** What the git object store looked like. `unknown` means we could not establish it. */
export type GitObjectStoreState = 'readable' | 'corrupt' | 'absent' | 'unknown';

/** The structural facts about one install's tree, gathered ONCE PER INSTALL (never per routine). */
export interface TargetProbe {
  installSlug: string;
  workspaceId: string;
  resolution: TargetResolution;
  /**
   * Did the resolved root exist? `true`/`false` are OBSERVATIONS; `null`/absent means the
   * check did not complete (timeout, EACCES, anything thrown) and must never read as absence.
   * Only meaningful when `resolution.kind === 'resolved'`.
   */
  rootExists?: boolean | null;
  /** Same three-valued semantics for the `.papercusp` directory under the root. */
  harnessDirExists?: boolean | null;
  gitObjectStore?: GitObjectStoreState;
  /** Verbatim git error text, when the store read failed — carried into the reason string. */
  gitError?: string | null;
  /** Anything thrown while probing. Present ⇒ the probe is untrustworthy in full ⇒ `unknown`. */
  probeError?: string | null;
}

export type TargetHealthState = 'ok' | 'root-missing' | 'git-corrupt' | 'unknown';

export interface TargetHealthVerdict {
  state: TargetHealthState;
  /**
   * `true` for exactly the two states that may park. Derived, never independently settable:
   * a caller must be unable to construct a verdict that parks on a non-permanent state.
   */
  permanent: boolean;
  /** Evidence a reader can act on, not a label — this lands in `metadata.health.dead_target`. */
  reason: string;
}

/** The two states that retrying cannot fix. Nothing else may ever park. */
const PERMANENT_STATES: ReadonlySet<TargetHealthState> = new Set(['root-missing', 'git-corrupt']);

/** PURE: is this state one that retrying cannot fix? */
export function isPermanentState(state: TargetHealthState): boolean {
  return PERMANENT_STATES.has(state);
}

function verdict(state: TargetHealthState, reason: string): TargetHealthVerdict {
  return { state, permanent: isPermanentState(state), reason };
}

/** The rendered identity of an install, ALWAYS carrying its workspace.
 *
 *  The workspace is not decoration. `harness_slug` is not unique across workspaces
 *  ('papercusp' exists in both `default` and `papercusp-workspace`), and a sibling sweep once
 *  filed "SILENTLY STOPPED autoloop role: director@papercusp" about a foreign tenant's row,
 *  textually indistinguishable from a live papercusp incident (EI-19372306666296664 /
 *  EI-19370235414830628). The sweep's SELECT is workspace-scoped, which is exactly why the
 *  scope is worth PRINTING: a scope that is enforced but invisible cannot be audited from its
 *  own output, so if the predicate is ever dropped the first alert says so. */
export function targetIdentity(probe: Pick<TargetProbe, 'installSlug' | 'workspaceId'>): string {
  return `${probe.installSlug} [${probe.workspaceId}]`;
}

/**
 * PURE: classify one install's tree from probed facts alone.
 *
 * Ordering is load-bearing. Trust is established before absence is believed, and absence of
 * the ROOT is decided before anything under it: a missing root makes every nested observation
 * meaningless, so it must not be reported as a git problem.
 */
export function classifyTargetHealth(probe: TargetProbe): TargetHealthVerdict {
  const who = targetIdentity(probe);

  // (1) The probe itself faulted. Nothing it reports is trustworthy, including its absences.
  if (probe.probeError) {
    return verdict('unknown', `${who}: probe did not complete (${probe.probeError}) — no conclusion about the tree`);
  }

  // (2) We never obtained a path. NEITHER non-resolved case is evidence about the tree, and
  //     they are kept distinct in the reason because they call for different human follow-up:
  //     an unregistered slug is a registration question, an unreadable registry is an outage.
  if (probe.resolution.kind === 'read-failed') {
    const detail = probe.resolution.detail ? `: ${probe.resolution.detail}` : '';
    return verdict('unknown', `${who}: the project registry could not be read${detail} — we did not look at the tree, so its state is unknown`);
  }
  if (probe.resolution.kind === 'unresolvable') {
    return verdict('unknown', `${who}: slug is not registered in this workspace. That is a registration fact, NOT evidence the tree is gone — registry lag would otherwise park a live install`);
  }

  const { path } = probe.resolution;

  // (3) Root absence — the only place a positive `false` becomes a permanent verdict.
  if (probe.rootExists === false) {
    return verdict('root-missing', `${who}: resolved root ${path} is confirmed absent — a routine cannot succeed against a tree that is not there`);
  }
  if (probe.rootExists !== true) {
    return verdict('unknown', `${who}: existence of resolved root ${path} could not be established — an unchecked path is never treated as a missing one`);
  }

  // (4) The root is there; ask about the object store.
  switch (probe.gitObjectStore) {
    case 'corrupt': {
      const detail = probe.gitError ? ` (${probe.gitError})` : '';
      return verdict('git-corrupt', `${who}: git object store under ${path} is unreadable${detail} — a corrupt object cannot be repaired by retrying the operation that reads it`);
    }
    case 'readable':
      return verdict('ok', `${who}: root present at ${path} and git object store readable`);
    case 'absent':
      // Present tree, no object store. NOT corruption (there is nothing to be corrupt), but
      // not a clean bill of health either — say so rather than pick a side we cannot support.
      return verdict('unknown', `${who}: root present at ${path} but no git object store found — nothing to declare corrupt, and nothing that establishes health`);
    default:
      return verdict('unknown', `${who}: root present at ${path} but the git object store could not be inspected`);
  }
}

/**
 * A prior sighting of a permanent verdict, as carried in
 * `metadata.health.dead_target` between sweeps.
 */
export interface PermanenceRecord {
  state: TargetHealthState;
  /** Epoch ms of the FIRST sighting in the current unbroken run. */
  firstSeenAtMs: number;
  /** Epoch ms of the most recent sighting. */
  lastSeenAtMs: number;
  /** How many consecutive sweeps have now agreed. */
  confirmations: number;
}

export interface PermanenceDecision {
  /** The ONLY field the sweep may act on. `true` ⇒ park. */
  park: boolean;
  /** The record to persist for the next sweep. `null` ⇒ clear any stored record. */
  record: PermanenceRecord | null;
  reason: string;
}

/** Default spacing between the two agreeing sightings (D-003). Env-overridable; <=0 disables
 *  the spacing requirement but NOT the two-sighting requirement — a single observation must
 *  never park, and no configuration may make it do so. */
export function permanenceMinSpacingMs(): number {
  const n = Number(process.env.PAPERCUSP_DEAD_TARGET_MIN_SPACING_MS ?? 10 * 60 * 1000);
  return Number.isFinite(n) ? n : 10 * 60 * 1000;
}

/**
 * PURE: turn a verdict plus the previous sweep's record into a park decision (D-003).
 *
 * A permanent verdict is necessary but NOT sufficient: the same state must be seen again,
 * at least `minSpacingMs` later. A transiently-absent root is therefore seen present on the
 * second look and never parks, without this module needing to know whether lazily-materialized
 * pot homes exist. Any non-permanent verdict RESETS the run — a tree that came back has not
 * been dead continuously, and letting a stale record survive an `ok` reading would recreate
 * the stale-watermark bug (EI-6765) this design exists to avoid.
 */
export function confirmPermanence(
  v: TargetHealthVerdict,
  prior: PermanenceRecord | null | undefined,
  nowMs: number,
  minSpacingMs: number = permanenceMinSpacingMs(),
): PermanenceDecision {
  if (!v.permanent) {
    return {
      park: false,
      record: null,
      reason: prior
        ? `verdict is '${v.state}' — the previous permanent run (${prior.confirmations} sighting(s)) is cleared, not carried`
        : `verdict is '${v.state}' — nothing to confirm`,
    };
  }

  // A DIFFERENT permanent state is a different condition: start its run over rather than
  // letting sightings of one failure mode confirm another.
  if (!prior || prior.state !== v.state) {
    return {
      park: false,
      record: { state: v.state, firstSeenAtMs: nowMs, lastSeenAtMs: nowMs, confirmations: 1 },
      reason: prior
        ? `first sighting of '${v.state}' (previous run tracked '${prior.state}') — a single observation never parks`
        : `first sighting of '${v.state}' — a single observation never parks`,
    };
  }

  const spacing = nowMs - prior.firstSeenAtMs;
  const confirmations = prior.confirmations + 1;
  const record: PermanenceRecord = {
    state: v.state,
    firstSeenAtMs: prior.firstSeenAtMs,
    lastSeenAtMs: nowMs,
    confirmations,
  };

  if (minSpacingMs > 0 && spacing < minSpacingMs) {
    return {
      park: false,
      record,
      reason: `'${v.state}' seen ${confirmations}× but only ${Math.round(spacing / 1000)}s apart — needs ${Math.round(minSpacingMs / 1000)}s between first and confirming sighting`,
    };
  }

  return {
    park: true,
    record,
    reason: `'${v.state}' confirmed ${confirmations}× over ${Math.round(spacing / 1000)}s — permanent and stable`,
  };
}

/**
 * PURE: the R3 hard guard. The active workspace's own home harness is NEVER parked, whatever
 * the verdict says, because parking papercusp's own git-sync and green-checkpoint would take
 * down the fleet's pipeline. This is deliberately independent of the verdict path so that a
 * bug in classification cannot reach it: the sweep consults this BEFORE it acts, not after.
 */
export function isProtectedInstall(installSlug: string, homeInstallSlug: string | null | undefined): boolean {
  if (!installSlug) return true; // an unidentifiable install is never a safe park target
  if (!homeInstallSlug) return false;
  return installSlug === homeInstallSlug;
}
