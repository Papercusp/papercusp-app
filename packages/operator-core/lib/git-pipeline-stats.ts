/**
 * git-pipeline-stats — the composite read behind the /admin Git tab.
 *
 * Stitches together the whole git-sync → green-checkpoint → release pipeline's
 * state + history from the places it actually lives:
 *   - `harness_shared.routines`           — the three routines (git-sync,
 *                                            green-checkpoint, release-trigger):
 *                                            active/cron/schedule + git-sync's
 *                                            latest metadata (last_status,
 *                                            last_resolver, head_sha, …).
 *   - `harness_shared.harness_escalations` — the currently-OPEN merge conflict
 *                                            (git-sync-conflict kind), if any.
 *   - `harness_shared.pipeline_events`     — the append-only history (mig 177):
 *                                            windowed counts + a recent timeline.
 *   - `devDeployState()`                   — the release-gate snapshot (main vs
 *                                            `ready` green pin vs deployed :3070).
 *
 * READ-ONLY: pure aggregation, mutates nothing. Resolves a best-effort snapshot
 * (sub-reads that fail degrade to null/empty) so the panel always renders.
 */
import { getOrgPg } from '@papercusp/db-org';
import { cellUnknown, type CellUnknown } from './cell-contract';
import { devDeployState, type DevDeployState } from './dev-deploy-state';
import { loadHarnessRegistry } from './harness-registry';
import {
  summarizePipelineWindow,
  recentPipelineEvents,
  type PipelineWindowSummary,
  type PipelineEventRow,
} from './harness/git-sync/pipeline-events';
import type { GitSyncSkippedPath } from './harness/git-sync/run-git-sync';
import { operatorHomeHarnessSlug } from './harness/operator-home-harness';
import { gatePausedBanner, readRoutinePause } from './harness/routines/release-pause-ttl';
import { evaluateGateVerdictFreshness, type GateVerdictFreshness } from './release/gate-verdict-freshness';
import { describeGateRedOwnership, gateFailureSignature, type GateRedOwnership } from './release/gate-red-ownership';
import { releaseFixerSpawnAlive } from './release/fixer-liveness';
import {
  describeUnreadableFrozenCandidateRepairQueue,
  diagnoseFrozenCandidateRepairQueue,
  buildFrozenRepairStatusIdentity,
  parseFrozenCandidateRepairQueue,
  parseFrozenCandidateRepairQueueRead,
  parseFrozenRepairConvergence,
  type FrozenCandidateRepairQueueRead,
  type FrozenRepairQueueDiagnostic,
  type StoredFrozenRepairConvergence,
} from './release/frozen-candidate-repair-queue';
import { parseInFlightRetriage, type StoredInFlightRetriage } from './release/in-flight-retriage';
import { parseTestPassReuseHealth, type TestPassReuseHealth } from './release/test-pass-reuse-report';
import { parseGateRoundPhases, type GateRoundPhases } from './release/gate-round-phases';
import { parseInFlightCandidate, type StoredInFlightCandidate } from './release/in-flight-candidate';
import { parseRepairTickLegs, type StoredRepairTickLegs } from './release/repair-tick-legs-snapshot';
import { readFreezeAndConverge, type FreezeAndConvergeGateHealth } from './release/freeze-disposition';
import { pipelineName } from './release/pipeline-name';
import { isAdmissionSyntheticCommitDate } from './release/admission-commit-date';
import {
  projectCheckpointQualificationState,
  type CheckpointQualificationState,
} from './release/checkpoint-qualification-transaction';
import { parseCandidateSnapshot, type CandidateSnapshot } from './release/candidate-snapshot';
import type { CheckpointProcessAuthorityReading, CheckpointSystemdProbe } from './release-checkpoint-launch';
import { highestRungCrossed } from './release/stall-escalation-ladder';

/** Compact read health projected beside the normalized queue diagnostic. */
export type FrozenRepairQueueReadProjection =
  | { status: 'value'; schemaVersion: number }
  | Exclude<FrozenCandidateRepairQueueRead, { status: 'value' }>;

/** The operator's own integration harness (its git-sync/release routines). */
const DEFAULT_SLUG = process.env.RELEASE_ROUTINE_SLUG ?? operatorHomeHarnessSlug();

export interface RoutineInfo {
  name: string;
  active: boolean;
  cron: string | null;
  lastFiredAtMs: number | null;
  nextFireAtMs: number | null;
  /** Routine group (WI-5018). `release` is the group whose pauses carry a finite TTL. */
  groupSlug: string | null;
  /** Deliberate pause provenance written by routines:set. Null when no hold is active. */
  pause: {
    reason: string | null;
    pausedBy: string | null;
    pausedAtMs: number | null;
    /**
     * P-004: the stamped auto-resume deadline for a release-group hold. Null means
     * NO auto-resume is scheduled — a distinct, louder fact than "not yet due", and
     * every renderer must keep them apart (release-pause-ttl.ts).
     */
    expiresAtMs: number | null;
  } | null;
}

export interface GitPipelineSnapshot {
  slug: string;
  generatedAtMs: number;

  routines: {
    gitSync: RoutineInfo | null;
    greenCheckpoint: RoutineInfo | null;
    releaseTrigger: RoutineInfo | null;
  };

  /** Latest git-sync tick (from routines.metadata — single newest state). */
  gitSync: {
    lastStatus: string | null;
    lastSyncedAtMs: number | null;
    consecutiveErrorTicks: number;
    headSha: string | null;
    lastPushed: string[];
    lastMerged: string[];
    lastConflicts: string[];
    lastErrors: string[];
    /** Live-lock paths that caused a whole repo commit group to defer. */
    skippedPaths?: GitSyncSkippedPath[];
    /**
     * The member's EFFECTIVE push mode this tick: `'push'`, or `'commit-only:<reason>'`
     * where reason is the hive git mode (`bridged` / `p2p-only`) or `config`.
     * `null` on rows written before git-sync recorded it — treat null as UNKNOWN, never
     * as "it pushes" (EI-18812945811758018).
     */
    pushMode: string | null;
    /**
     * EI-19341723994516667: the p2p own-head-publish leg's self-report
     * (`metadata.own_head_publish` on this SAME git-sync routine row) — the
     * mechanism that actually advances origin on a commit-only (bridged) member.
     * See `origin-freshness.ts` for the full model. Null fields = not recorded
     * (pre-WI-5738 routine rows, or a legacy non-bridged member that never writes
     * this key) — read as "unmeasured", never as healthy or faulted.
     */
    ownHeadPublish: {
      refused: string | null;
      backlogRemains: boolean | null;
      publishedSha: string | null;
      sha: string | null;
    } | null;
  };

  /** The merge-resolver (opus:xhigh) — model + last dispatch outcome. */
  resolver: {
    model: string;
    lastStatus: string | null;
    lastAtMs: number | null;
    lastExitCode: number | null;
    lastHttpStatus: number | null;
    lastTimedOut: boolean | null;
    lastScopes: string[];
  };

  /** The green-checkpoint gate health (P-004): the red streak + time since the
   *  last green + the last release-fixer dispatch — from the green-checkpoint
   *  routine metadata (`gate_health` + `last_fixer`). `stalled` is true once the
   *  red streak / age crossed the alert threshold. */
  gate: {
    consecutiveReds: number;
    /**
     * unified-agent-state-plane-2026-07-27 P-007, D-038 axis 2 — is `consecutiveReds`
     * above a MEASUREMENT, or the `?? 0` default standing in for one?
     *
     * `null` means measured. A `CellUnknown` means `gate_health.consecutiveReds` was
     * ABSENT or unparseable, so the `0` above is a DEFAULT — byte-identical to a
     * measured "no reds", and read by every consumer as "the gate is passing".
     *
     * ⚠ WHY THIS IS NOT ALREADY COVERED, because it looks like it should be. The gate
     * has TWO rich staleness models and BOTH are structurally blind here:
     *   · `fireStale` (WI-282) asks "is the routine FIRING?" — a wedged ticker. It does
     *     not ask whether the counter it produced exists.
     *   · `verdictStale` (WI-4489) asks "is the recorded verdict CURRENT?" — and
     *     `evaluateGateVerdictFreshness` opens with `if (consecutiveReds <= 0) return
     *     { stale: false }`, commented "Only a RED verdict can misdirect. A stale green
     *     is inert." That premise is TRUE of a stale green and FALSE of an unmeasured
     *     one: a green that was never measured is not inert, it is FABRICATED. The
     *     short-circuit lands on exactly the case this field exists to name.
     *
     * So a caller must not read `consecutiveReds === 0` as "green" without checking
     * this. The same value, hoisted to the result level where a hurried caller cannot
     * skip it, is `PipelinePosition.verdictUnknown`.
     */
    countersUnknown: CellUnknown | null;
    /**
     * EI-21462211894072863: how many CONSECUTIVE green-checkpoint ticks exited without producing
     * any verdict (status 'error' — no parseable result marker, and not a deadline-kill or an
     * external SIGTERM, which have their own statuses). `0` on a gate that is producing verdicts.
     *
     * ⚠ READ THIS ALONGSIDE `consecutiveReds`, which it deliberately does NOT feed. These ticks
     * used to be counted as reds, which is how a WEDGED gate presented as a merely-red one:
     * measured 2026-08-25, `consecutiveReds` reached 42 while the last real verdict predated the
     * last fire by 5.7h, and every surface offered a failing-test list that no run in that streak
     * had named. A non-zero value here means the counters beside it describe an OLDER run — the
     * last one that actually judged code — and that the question worth asking is why the runs are
     * DYING, not which test is red.
     *
     * Distinct from `verdictStale`, which asks whether the recorded verdict is still trustworthy:
     * this counts the ticks that produced nothing, so it is non-zero exactly when the gate is
     * failing to render verdicts AT ALL. A gate can be verdict-stale without being wedged (a
     * refire in flight), and this is what tells the two apart.
     */
    consecutiveNoVerdict: number;
    lastGreenAtMs: number | null;
    /**
     * EI-20706962612084953: the last verdict's OWN green-ness, as STATED by the writer
     * (`gate_health.lastVerdict`) rather than inferred from a side-effect field.
     * `consecutiveReds === 0` answers "is `main` stalled", NOT "was the last candidate
     * green" — the writer's `reset` class deliberately zeroes the streak for a genuinely
     * NOT-GREEN verdict whenever the release pin moved (main advancing via a path the
     * routine never saw). A reader that conflates the two reports GREEN for a run that
     * recorded red. `null` = a blob written before the writer stamped this, in which case
     * a consumer must degrade to its previous behaviour rather than assume either value.
     */
    recordedVerdict: 'green' | 'not-green' | null;
    firstRedAtMs: number | null;
    stalled: boolean | null;
    /** WI-282: the green-checkpoint routine's last fire (epoch ms) + a freshness
     *  verdict, so a WEDGED / non-firing ticker is VISIBLE even though it produces
     *  0 reds — the reds-based `stalled` is structurally blind to a checkpoint that
     *  never ran (it can't go red without running). `fireStale` reuses the
     *  green-stall-watchdog's pure logic (last-fire / last-green age). */
    lastFiredAtMs: number | null;
    fireStale: boolean;
    fireStaleReason: string | null;
    /** WI-4489: when the last REAL verdict was observed, and whether the recorded RED can still be
     *  trusted. `fireStale` asks "is the routine FIRING?"; this asks "is its VERDICT current?" —
     *  a `skipped-locked` fire refreshes `last_fired_at` while writing no verdict, so the routine
     *  can look perfectly healthy while `consecutiveReds` is hours stale. A stale red must never be
     *  reported as the gate's colour, nor dispatch anyone at the tests it names. */
    verdictObservedAtMs: number | null;
    verdictStale: boolean;
    verdictStaleReason: string | null;
    /** EI-18669342433807110: WHICH freshness rule fired (see GateVerdictFreshness.reasonCode) —
     *  lets a consumer distinguish `refire-in-flight` (a fresh verdict is imminent; do not even
     *  re-run the checkpoint) from the other stale reasons (which DO want a fresh run fired).
     *  Null whenever `verdictStale` is false. */
    verdictStaleReasonCode?: GateVerdictFreshness['reasonCode'];
    lastFixerStatus: string | null;
    lastFixerAtMs: number | null;
    lastFixerCandidate: string | null;
    /**
     * EI-22344736163383832: the single persisted candidate/failure/ownership
     * record produced by the green-checkpoint writer. A malformed, unknown, or
     * torn JSONB value is deliberately null; readers must not reconstruct this
     * authority by pairing unrelated gate_health keys.
     */
    candidateSnapshot: CandidateSnapshot | null;
    /** EI-18672078222841101: WHO, if anyone, already owns this red — the question every
     *  recipient of a gate-red alert asks first and that no read surface answered. The
     *  three `lastFixer*` fields above look like they answer it and do not: they are keyed
     *  by CANDIDATE, and while the gate is red staging advances hourly so every checkpoint
     *  is a new candidate. Only the SIGNATURE says whether the recorded fixer is on THIS
     *  failure, and only spawn liveness says whether it is still working. Both already
     *  existed (P-012 `last_fixer.signature`, `releaseFixerSpawnAlive`) and were used
     *  solely to suppress duplicate fixer dispatch — never shown to the agents who then
     *  duplicated the diagnosis by hand. `null` on a green gate. */
    redOwner: GateRedOwnership | null;
    /** P-009: workspaces that have flaked ≥3× in the gate (failed-then-passed-on-
     *  retry) — chronically flaky, quarantine candidates. */
    flakyWorkspaces: string[];
    /**
     * EI-19405864032365760: the gate ABORTED before judging, so the counters above describe an
     * OLDER run. Non-null ⇒ the last tick rendered no verdict at all and none is coming until the
     * named condition clears. Two statuses reach here: `'migrations-pending'` (the migration
     * preflight refusing to judge against a schema known to be behind the candidate) and
     * `'infra-inconclusive'` (EI-20767792192323374 — the suite ran, but the gate's own vite-node
     * module cache was deleted underneath it mid-run, so its failures are a HOST fault).
     *
     * ⚠ READ THIS BEFORE `consecutiveReds`. A preflight abort is deliberately NOT counted as a red
     * (EI-2615's reasoning: a tick that judged no code cannot be evidence of a broken build), which
     * left the counters frozen on the PREVIOUS verdict — so a red streak, its candidate and its
     * failing tests all keep rendering as current while the pipeline is actually wedged on
     * something else entirely. Measured 2026-08-03: ~2.5h of a fleet being told "Gate is RED — the
     * reds are yours to fix" and chasing test files, while the true blocker was one migration
     * failing to apply. When this is non-null the counters are STALE BY CONSTRUCTION; report the
     * abort, not the streak.
     *
     * Cleared the moment any real verdict lands (release-actions.ts sets it null on both the reset
     * and red paths), so a non-null value is always about the most recent tick.
     */
    inconclusive: {
      status: string;
      candidate: string | null;
      /** P-003: immutable queue pin, explicit even when `candidate` is a compatibility field. */
      frozenCandidate?: string | null;
      /** P-003: mutable repair progress head, never a frozen-pin verdict. */
      repairHead?: string | null;
      phase?: string | null;
      verdictProvenance?: Record<string, unknown> | null;
      detail: string | null;
      observedAtMs: number | null;
    } | null;
    /** EI-21433366079878122: normalized persisted queue state, including live-fixer and
     * exact-CAS retirement guidance. Null means the routine row carries no readable queue. */
    repairQueue?: FrozenRepairQueueDiagnostic | null;
    /**
     * P-025: whether the persisted queue was read, absent, or present-but-unreadable.
     * A newer schema must never disappear behind the compatibility `repairQueue: null`.
     */
    repairQueueRead?: FrozenRepairQueueReadProjection;
    /** P-007: one typed, routine-owned logical qualification view. */
    qualification?: CheckpointQualificationState;
    /**
     * WI-2141736 P-004: what the gate last did with freeze-and-converge, and WHY.
     *
     * Sits BESIDE `repairQueue` rather than inside it, because the dispositions worth
     * reading are exactly the ones with no queue: a retire clears the row and a
     * flag-suppressed red never opens one, so `repairQueue: null` covers "the owner
     * switched freeze-and-converge off", "the gate just discarded a frozen candidate" and
     * "nothing was frozen, all is well" with one indistinguishable value. Measured
     * 2026-09-02: 20 retirements and 0 resumes in a day, evidenced only by grepping
     * per-run checkpoint logs.
     *
     * Null means the routine row carries no readable disposition — NOT that the freeze is
     * healthy. Read `observedAtMs` before treating a value as current.
     */
    freezeAndConverge?: FreezeAndConvergeGateHealth['freezeAndConverge'] | null;
    /**
     * main-green-status-visible-2026-09-03 P-004: IS THE QUEUE CONVERGING — is the failing
     * set actually shrinking, how long has the freeze been open, and which round is it on?
     *
     * Sits beside `repairQueue`/`freezeAndConverge` as the third leg of the same subject:
     * the queue says WHICH sha is frozen, the disposition says WHETHER the mechanism is
     * acting, and this says WHETHER THAT ACTION IS WORKING. It was already DERIVED and
     * persisted by `buildFrozenRepairConvergenceGateHealth` on every queue write and simply
     * never projected here, so the one question the freeze exists to answer — "is this
     * converging or is it a treadmill?" — could only be answered by grepping run logs.
     *
     * ⚠ `converging` and `failingFirst` are deliberately TRI-STATE. `null` means NOT YET
     * KNOWABLE (fewer than two recorded rounds / no baseline), never "not converging" —
     * conflating those calls a healthy new cycle a treadmill and is why the reader rejects
     * a wrong-typed blob outright instead of coercing it.
     *
     * Null means the routine row carries no readable convergence record — NOT that the
     * queue is healthy, and NOT that it is stuck.
     */
    convergence?: StoredFrozenRepairConvergence | null;
    /**
     * P-013 (plan gate-file-level-test-reuse-2026-09-27): what per-test-file pass reuse did in
     * the latest gate round — files reused of candidates, a lower bound on test time saved, any
     * TEST_PASS_REUSE_ALARM, and why reuse was off where it was. `judgedSha` names the round.
     * Null means the routine row carries no readable reuse record (a runner predating the
     * field, or a malformed blob) — NOT that reuse saved nothing.
     */
    testPassReuse?: TestPassReuseHealth | null;
    /** P-013: where the latest gate round's wall-clock time went (stamped setup phases, the
     *  candidate suite, and `other`). Null = not measured this round, never "took no time". */
    roundPhases?: GateRoundPhases | null;
    /** Whether the sibling `failingTests` array came from a real code verdict.
     * `false` means the latest checkpoint ended before rendering one; `null` is a legacy or
     * malformed blob whose measurement state cannot be established. */
    failingTestsMeasured?: boolean | null;
    /** P-005 / D-002: WHICH of the four measurement states the sibling `failingTests` is in —
     * the axis `failingTestsMeasured` cannot express, because `carried` and `unknown` are both
     * `null` on it. See {@link GateFailingTestsProvenance}. Optional for old fixtures/snapshots. */
    failingTestsProvenance?: GateFailingTestsProvenance;
    /** EI-18832825158594027: true when `failingTests` was INHERITED from an earlier observation
     * of the same candidate (the monotonic fold in `mergeGateHealthMonotonic`) rather than
     * observed by the tick that produced this verdict. A reader must not treat those names as a
     * current blame list — that is what sends fixers at already-green code. Distinct from
     * `failingTestsMeasured`, which remains true: the names WERE measured, just not by this tick. */
    failingTestsCarriedForward?: boolean | null;
    /** WI-4533: the tests the gate ITSELF named in its last verdict (`gate_health.failingTests`)
     *  — the workspace(s) + file path(s) that actually redded it. The blob has carried these all
     *  along and NO read surfaced them, so every consumer asking "what is red?" fell back to
     *  why-chain's 2h `test_runs` heuristic — which, measured live on a red gate (2026-07-13),
     *  returned NOTHING while this field held all four culprits. First-hand evidence beats a
     *  time-windowed proxy: this is the gate's own answer to "which tests are failing".
     *  Empty on a green gate — and NEVER to be trusted when `verdictStale` (WI-4489: those names
     *  are what a phantom dispatch chases). */
    failingTests: string[];
    /** EI-17603 (follow-up to WI-4533): the short sha of the candidate THIS verdict's
     *  `failingTests` pertains to (`gate_health.observedCandidate`, recorded alongside
     *  `failingTests` since it was added but never surfaced here until now). Lets a
     *  consumer cross-check the gate's own named failures against first-hand ledger
     *  evidence (`harness_shared.test_runs`) for the EXACT commit under verdict, instead
     *  of trusting the recorded list blind — see `verifyGateVerdict` in why-chain.ts.
     *  Null on a blob predating this field, or when there is no candidate to attribute. */
    observedCandidate: string | null;
    /**
     * D-013/P-011: where main ended for THIS recorded verdict, written beside
     * `observedCandidate` by release-actions. This is the promotion operand; the staging
     * buffer is a separate relation and must never stand in for it.
     */
    lastMainPin: string | null;
    /** EI-13288: when THIS verdict's own stale-candidate re-triage already proved its named
     *  `failingTests` pass at a newer tip (auto-refire cap reached before a full suite could
     *  confirm that tip green), the short sha of that tip — feeds Rule 3 of
     *  gate-verdict-freshness.ts. Null when this red's retriage was real-red/unknown, or on a
     *  blob predating this field. */
    retriageStaleTip: string | null;
    /** Human-readable detail for `retriageStaleTip` (from the re-triage classifier), for a
     *  reader who wants the "why" without re-deriving it. Null alongside `retriageStaleTip`. */
    retriageDetail: string | null;
    /**
     * EI-19399662484764592 (read side of WI-7290): the gate's own re-triage verdict for the
     * CURRENT verdict's candidate — "did the gate already re-run these failing files at tip,
     * and what did it find?", which is the first question anyone triaging a red actually has.
     *
     * Distinct from `retriageStaleTip`/`retriageDetail` above ON PURPOSE. Those come from
     * `gate_health`, which records the re-triage ONLY when it classified `stale-candidate`
     * (release-actions.ts nulls them otherwise). That pairing is correct there — it exists so a
     * stale note cannot outlive the verdict that produced it — but it means the OTHER two
     * classifications, including `real-red`-at-tip (the gate's strongest statement that a red is
     * genuinely current), were readable nowhere. Sourced instead from the append-only pipeline
     * event, which since WI-7290 carries the verdict for every classification.
     *
     * ⚠ NULL MEANS NOT AVAILABLE — never "no re-triage happened". It is null when no matching
     * `green_checkpoint` event is inside the recent-events window, and for any verdict recorded
     * before WI-7290 landed. Reading a null as evidence about the gate's behaviour is precisely
     * the mistake this field exists to end (it cost three filings and one retracted MAJOR on the
     * night of 2026-08-02). When present, `candidate` is guaranteed to match `observedCandidate`
     * — a verdict from a DIFFERENT run is dropped rather than mis-attributed to this one.
     */
    retriageVerdict: RetriageVerdict | null;
    /** EI-18669342433807110: a stale-candidate auto-refire for THIS red is running RIGHT NOW
     *  (`gate_health.inFlightRetriage`, already freshness-checked by `parseInFlightRetriage`).
     *  Feeds Rule 4 of gate-verdict-freshness.ts. Null when no refire is in flight, or its
     *  marker is missing/abandoned. */
    inFlightRetriage?: StoredInFlightRetriage | null;
    /**
     * EI-19931692050586322: the run's OWN published answer to "which sha am I judging RIGHT
     * NOW" (`gate_health.inFlightCandidate`, already freshness-checked by
     * `parseInFlightCandidate`). Written on EVERY invocation — including a run's FIRST
     * candidate, which is the case `inFlightRetriage` structurally cannot cover, because that
     * marker only exists once a refire has happened (the uncommon case).
     *
     * Why it had to be threaded here: the producer was wired (green-checkpoint.ts:3512) but NO
     * reader ever consulted it, so `gitPipelinePosition()` could only ever answer
     * `candidateSource: 'run-probe'` — a value the tool itself labels NOT authoritative — while
     * the authoritative sha sat one key away in the routines row it had already loaded.
     *
     * ⚠ NULL IS NOT "no run in flight". The write is explicitly best-effort and swallows its
     * own errors, so a live run can legitimately publish nothing (measured 2026-08-09: present
     * for the 23:52Z run, absent for the 00:13Z one, both active). Consult
     * `checkpointRunInFlight.active` for liveness; this field answers only "did the run tell us
     * its candidate".
     */
    inFlightCandidate?: StoredInFlightCandidate | null;
    /**
     * WI-2143253: the repair queue's own per-leg non-test measurement (lint / perf /
     * desktop / delta) — `gate_health.repairTickLegs`, written by
     * `augmentWithRepairTickLegs` on every awaiting-fixer hold tick (see
     * `apps/operator/lib/release/green-checkpoint.ts`'s `RepairTickLegs` /
     * `RepairTickLegRecord`). This was already being WRITTEN; nothing ever read it back
     * into this snapshot, so `gate.candidateFailures` could only ever report a bare
     * `postSuiteMeasured` tri-state boolean and could never NAME which leg was failing
     * (P-003 has since deleted that field; `nonTestLegs.perLeg` is the named surface).
     * `null` when no repair queue is open, or one is open but has had no hold tick yet.
     */
    repairTickLegs?: StoredRepairTickLegs | null;
    /**
     * EI-19325520469216548: how stale the JUDGED CANDIDATE was at verdict time, in ms — the
     * SAME `evaluateGateVerdictFreshness` measurement that already decides `verdictStale`'s
     * `'candidate-fossil'` reason, but hoisted here so a reader can see the number even when
     * it falls short of that rule's threshold (the routine ~4min quiet-cut lag is normal and
     * will never trip 'candidate-fossil', yet a caller asking "might this red be about code
     * that's already fixed?" benefits from seeing the age directly). Null when it could not be
     * computed (a blob predating `candidateCommittedAt`, or clock skew) — never 0-as-fresh.
     */
    candidateAgeMs: number | null;
    /**
     * EI-19325520469216548: commits that landed on staging after the judged candidate was cut
     * (`gate_health.commitsBehindTip`, written alongside `candidateCommittedAt`) — the concrete
     * count behind the age above. This was already being RECORDED and already fed into
     * `evaluateGateVerdictFreshness` as an input, but discarded at the destructure site rather
     * than surfaced, so no reader of THIS snapshot (nor, transitively, of `dev:pipeline_position`,
     * which projects a subset of `gate`) could see it. A caller who just committed a fix and
     * sees this non-zero on a red gate has a concrete, first-hand reason to suspect the red
     * predates their fix, without needing to pass `paths` to `release:checkpoint-run` at all.
     * Null when unmeasured (a blob predating the field).
     */
    commitsBehindTip: number | null;
  };

  /** A currently-OPEN merge conflict (resolver still working / unresolved), or null. */
  openConflict: {
    scopes: string[];
    conflicts: { scope: string; files: string[] }[];
    emittedAtMs: number | null;
  } | null;

  /** Windowed counts from the append-only history (mig 177). */
  windows: { day: PipelineWindowSummary; week: PipelineWindowSummary };

  /** Recent pipeline events, newest first (the timeline). */
  recent: PipelineEventRow[];

  /** Release-gate snapshot (main vs `ready` vs deployed :3070). */
  deploy: DevDeployState;

  /** Root selected for the optional active-run probe. Null means its pipeline
   * mapping was unavailable; absent means this snapshot did not request the probe. */
  activeRunRoot?: string | null;

  /** overview-tab-expansion-2026-07-20 P-001: the LIVE green-checkpoint suite run
   *  (systemd probe via checkActiveCheckpointRun — the same self-healing check the
   *  launch path uses). `null` = NOT PROBED (the default: live callers — watchdogs,
   *  why-chain, position, tools — skip the systemctl fork); `{ active:false }` =
   *  probed and idle. Only the background derived-read producer (`dev.gitPipeline`)
   *  opts in, so the "judging vs idle" verdict reaches the UI with zero cost on
   *  every other snapshot read. */
  activeRun: {
    active: boolean;
    /** The live process was found through the shared checkpoint run-lock rather than
     * the manual systemd unit (normally the scheduled/cron runner). */
    heldExternally?: true;
    /** P-009: live pre-lock startup observed from gate authority env + exact root + cgroup. */
    preLockAuthority?: {
      workspace: string;
      harness: string;
      cgroupPath: string;
      pid: number;
    };
    /** The systemd probe itself failed. When heldExternally is also true, the
     * independent run-lock still proves a run is live; otherwise liveness is unknown. */
    probeFailed?: true;
    /** Exact probe failure returned by checkActiveCheckpointRun. */
    probeDetail?: string | null;
    /** Provenance of the systemd user-manager query behind this observation. */
    systemd?: {
      scope: CheckpointSystemdProbe['scope'];
      argv: string[];
      loadState: string | null;
      known: boolean | null;
      invocationId: string | null;
      /** False when active-run liveness came from the shared run-lock; the manual
       *  systemd unit probe does not describe that scheduled/external process. */
      appliesToActiveRun?: boolean;
    };
    /** Whether the checkpoint CLI emitted its own valid terminal result line. */
    terminalMarker?: boolean;
    /** EI-210996: systemd-owned terminal tuple, available even after SIGKILL/OOM. */
    terminalEvidence?: {
      source: 'systemd-exec-stop-post';
      candidate: string | null;
      serviceResult: string;
      exitCode: string;
      exitStatus: string;
      abnormal: boolean;
    };
    /** Stable symlink to the active manual run's log. Absent when the run was observed only
     *  through the shared lock and its output path is therefore unknown. */
    logPath?: string | null;
    /** Short/full sha the live run is judging — null if unreadable.
     *
     * EI-19327704778173646: this is the run's CURRENT candidate (the LAST
     * `checkpointing candidate` line in its log), not the one it started on. A single run
     * can legitimately re-candidate mid-flight: on a stale red, green-checkpoint recurses
     * in-process onto tip and re-pins its checkout, while pid/started_at stay fixed. So
     * this value CAN change between two reads of the same run, and a candidate newer than
     * `startedAtMs` is the expected signature of a healthy auto-refire — never read it as
     * corruption, and never fire a manual run over it (that discards the in-flight rescue
     * and costs a full suite). When it has moved, `initialCandidate`/`refireObserved` below
     * say so explicitly. */
    candidate: string | null;
    /** EI-19327704778173646: the candidate this run STARTED on, present only when it has
     *  since re-candidated. Provenance — never verify a fix against this sha. */
    initialCandidate?: string | null;
    /** EI-19327704778173646: true when the run demonstrably re-candidated mid-flight. A
     *  `false`/absent is NOT proof no refire happened, only that none was visible. */
    refireObserved?: boolean;
    startedAtMs: number | null;
    /** Latest advancing checkpoint heartbeat from the run log/phase, falling back to start time.
     * Optional for snapshots persisted before this field was introduced. */
    progressAtMs?: number | null;
    /** Current phase published by the active checkpoint run, when its phase marker is readable. */
    currentPhase?: string | null;
    elapsedSec: number | null;
  } | null;
}

/** The configured merge-resolver model spec (`AGENT_MODELS` → committed floor). */
/**
 * EI-19399662484764592: the gate's own re-triage verdict, as recorded on the append-only
 * pipeline event by WI-7290. See `GitPipelineSnapshot.gate.retriageVerdict` for what null means
 * (NOT AVAILABLE — never "no re-triage happened").
 */
export interface RetriageVerdict {
  /** `stale-candidate` = the named failing files PASS at tip, so this red is not current.
   *  `real-red` = they were re-run at tip and still fail — the gate's strongest statement that
   *  the red is genuine. `unknown` = it could not be measured; `detail` then names WHY. */
  classification: 'real-red' | 'stale-candidate' | 'unknown';
  /** The tip the failing files were re-run at (short sha), when there was one. */
  tip: string | null;
  /** When that tip measurement finished. Null for legacy or unmeasured verdicts. */
  tipObservedAtMs: number | null;
  /** The classifier's own sentence — for `unknown`, the "tip re-run SKIPPED: <why>" reason. */
  detail: string;
  /** The candidate this verdict pertains to. Always equal to the snapshot's `observedCandidate`
   *  (a non-matching event is dropped, never re-attributed). */
  candidate: string | null;
}

/**
 * A git-sync conflict escalation is refreshed by each actual conflict tick. Bound
 * the read-side claim so a dead writer or an old pre-fix row cannot assert that a
 * conflict is still open forever.
 */
export const GIT_SYNC_CONFLICT_MAX_AGE_MS = 30 * 60_000;

export interface GitSyncConflictCurrentnessInput {
  escalationMtimeMs: number | null;
  lastSyncedAtMs: number | null;
  lastMergeCompletedAtMs: number | null;
  lastMergeCompleted: readonly string[];
  nowMs?: number;
  maxAgeMs?: number;
}

/**
 * Pure read-side guard for the `git-sync-conflict` escalation.
 *
 * `last_merge_completed` is positive proof that the merge stage ran cleanly, but
 * only when its timestamp belongs to the current escalation and is no later than
 * the tick's `last_synced_at`. A stale/invalid proof is ignored. Independently,
 * the escalation row itself must have been refreshed within the bounded window;
 * later error ticks do not extend that window because they may fail before merge.
 */
export function isGitSyncConflictCurrent(input: GitSyncConflictCurrentnessInput): boolean {
  const rowAt = input.escalationMtimeMs;
  const now = input.nowMs ?? Date.now();
  const maxAge = input.maxAgeMs ?? GIT_SYNC_CONFLICT_MAX_AGE_MS;
  if (!Number.isFinite(rowAt) || !Number.isFinite(now) || !Number.isFinite(maxAge) || maxAge < 0) return false;

  const mergeProofAt = input.lastMergeCompletedAtMs;
  const proofScopes = input.lastMergeCompleted;
  const proofIsForThisRow =
    proofScopes.length > 0 &&
    Number.isFinite(mergeProofAt) &&
    (mergeProofAt as number) >= (rowAt as number) &&
    (input.lastSyncedAtMs == null ||
      (Number.isFinite(input.lastSyncedAtMs) && (mergeProofAt as number) <= input.lastSyncedAtMs));
  if (proofIsForThisRow) return false;

  return now - (rowAt as number) <= maxAge;
}

/**
 * Pick the re-triage verdict belonging to `observedCandidate` out of the recent pipeline events.
 *
 * Pure + total, and deliberately CONSERVATIVE in one direction: it returns null rather than a
 * verdict it cannot tie to the candidate under report. Mis-attributing an older run's re-triage
 * to the current red would be worse than saying nothing — that is the exact failure mode (a
 * plausible, well-formed, wrong answer) that this whole line of work exists to remove.
 *
 * Reads from `recent`, which the snapshot already fetched, so this adds no query to a hot path.
 */
export function pickRetriageVerdict(
  recent: readonly PipelineEventRow[],
  observedCandidate: string | null,
): RetriageVerdict | null {
  if (!observedCandidate) return null;
  for (const ev of recent) {
    if (ev.kind !== 'green_checkpoint') continue;
    const detail = ev.detail as Record<string, unknown> | null | undefined;
    if (!detail || typeof detail !== 'object') continue;
    const cand = typeof detail.candidate === 'string' ? detail.candidate : null;
    // Both sides are stored short (12), but compare by prefix either way so a full-length sha on
    // one side cannot silently defeat the match and downgrade a real verdict to "unavailable".
    if (!cand || !(cand.startsWith(observedCandidate) || observedCandidate.startsWith(cand))) continue;
    const r = detail.retriage as Record<string, unknown> | null | undefined;
    if (!r || typeof r !== 'object') continue;
    const classification = r.classification;
    if (classification !== 'real-red' && classification !== 'stale-candidate' && classification !== 'unknown') {
      continue;
    }
    return {
      classification,
      tip: typeof r.tip === 'string' ? r.tip : null,
      tipObservedAtMs:
        typeof r.tipObservedAtMs === 'number' && Number.isFinite(r.tipObservedAtMs)
          ? r.tipObservedAtMs
          : null,
      detail: typeof r.detail === 'string' ? r.detail : '',
      candidate: cand,
    };
  }
  return null;
}

export function resolverModel(): string {
  try {
    const raw = process.env.AGENT_MODELS;
    if (raw) {
      const m = JSON.parse(raw) as Record<string, unknown>;
      if (typeof m['merge-resolver'] === 'string' && m['merge-resolver'].trim()) return m['merge-resolver'];
    }
  } catch {
    /* malformed AGENT_MODELS — fall through to the committed default */
  }
  return 'opus:xhigh';
}

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * D-013/P-011: the gate writer's paired promotion identity.
 *
 * Both values come from the same gate_health blob. Keeping this as one projection prevents
 * readers from pairing a judged candidate with a separately sampled staging relation and
 * then calling that relation proof of promotion. Missing/malformed values remain null.
 */
export function projectGatePromotionIdentity(gateHealth: unknown): {
  observedCandidate: string | null;
  lastMainPin: string | null;
} {
  const row = gateHealth && typeof gateHealth === 'object' && !Array.isArray(gateHealth)
    ? (gateHealth as Record<string, unknown>)
    : {};
  const stringOrNull = (value: unknown): string | null =>
    typeof value === 'string' && value.trim().length > 0 ? value : null;
  return {
    observedCandidate: stringOrNull(row.observedCandidate),
    lastMainPin: stringOrNull(row.lastMainPin),
  };
}

/**
 * EI-22344736163383832: project the producer's canonical candidate snapshot
 * without falling back to the older disconnected gate_health fields.
 */
export function projectGateCandidateSnapshot(gateHealth: unknown): CandidateSnapshot | null {
  if (!gateHealth || typeof gateHealth !== 'object' || Array.isArray(gateHealth)) return null;
  return parseCandidateSnapshot((gateHealth as Record<string, unknown>).candidateSnapshot);
}

/**
 * P-025: project queue read health before diagnostics can collapse it to `null`.
 * Exported so the current-plus-one schema falsifier exercises the same mapping the live
 * git-pipeline snapshot uses, without needing a database fixture.
 */
export function projectFrozenRepairQueueRead(
  rawQueue: unknown,
  gateHealth: unknown,
  nowMs: number,
): {
  queue: ReturnType<typeof parseFrozenCandidateRepairQueue>;
  read: FrozenRepairQueueReadProjection;
  freezeAndConverge: FreezeAndConvergeGateHealth['freezeAndConverge'] | null;
} {
  const parsed = parseFrozenCandidateRepairQueueRead(rawQueue);
  const queue = parsed.status === 'value' ? parsed.queue : null;
  const read: FrozenRepairQueueReadProjection =
    parsed.status === 'value'
      ? { status: 'value', schemaVersion: parsed.queue.schemaVersion }
      : parsed;
  const stored = readFreezeAndConverge(gateHealth);
  const freezeAndConverge =
    parsed.status === 'unreadable'
      ? {
          enabled: stored?.enabled ?? true,
          state: 'unreadable' as const,
          reason:
            `${describeUnreadableFrozenCandidateRepairQueue(parsed)}; ` +
            'refusing to report the queue as absent or freeze state none',
          candidate: null,
          holdUntilMs: null,
          capacityRetryAtMs: null,
          observedAtMs: nowMs,
        }
      : stored;
  return { queue, read, freezeAndConverge };
}

export function currentGateInconclusive(
  value: unknown,
  repairQueue: unknown,
): GitPipelineSnapshot['gate']['inconclusive'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const inc = value as Record<string, unknown>;
  if (typeof inc.status !== 'string') return null;

  // EI-21226444968466505: repair holds are projections of the serialized repair
  // queue, not independent blockers. Queue cleanup used to leave the last
  // `gate_health.inconclusive` blob behind, so every release read kept routing
  // operators at a repair SHA that no longer had a queue, worktree, or fixer.
  // A malformed/non-null queue stays fail-closed; only an authoritatively absent
  // queue disproves these two queue-owned statuses.
  if (repairQueue == null && (inc.status === 'repair-in-progress' || inc.status === 'repair-staging-mismatch')) {
    return null;
  }

  const parsedRepairQueue = parseFrozenCandidateRepairQueue(repairQueue);
  const repairIdentity =
    parsedRepairQueue && (inc.status === 'repair-in-progress' || inc.status === 'repair-staging-mismatch')
      ? buildFrozenRepairStatusIdentity(parsedRepairQueue)
      : null;

  return {
    status: inc.status,
    // A repair-owned hold ran no suite. Its generic candidate is therefore the
    // immutable pin; repairHead is projected separately and cannot masquerade as it.
    candidate: repairIdentity?.frozenCandidate ?? (typeof inc.candidate === 'string' ? inc.candidate : null),
    frozenCandidate:
      repairIdentity?.frozenCandidate ?? (typeof inc.frozenCandidate === 'string' ? inc.frozenCandidate : null),
    repairHead: repairIdentity?.repairHead ?? (typeof inc.repairHead === 'string' ? inc.repairHead : null),
    phase: repairIdentity?.phase ?? (typeof inc.phase === 'string' ? inc.phase : null),
    verdictProvenance:
      repairIdentity?.verdictProvenance ??
      (inc.verdictProvenance && typeof inc.verdictProvenance === 'object' && !Array.isArray(inc.verdictProvenance)
        ? (inc.verdictProvenance as Record<string, unknown>)
        : null),
    detail: typeof inc.detail === 'string' ? inc.detail : null,
    observedAtMs: num(inc.observedAtMs),
  };
}
function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/**
 * HOW the `failingTests` list beside a gate verdict came to be what it is.
 *
 * main-green-status-visible-2026-09-03 P-005 / D-002. The reader's question is never
 * only "what is the list" — it is "may I believe it". A bare `[]` is indistinguishable
 * from "nothing is failing", and a bare list is indistinguishable from a fresh
 * measurement. `measured: boolean | null` cannot separate the four real states either,
 * because two of them are both `null`. This names which one you are holding.
 *
 * - `measured`     — a verdict measured this list on this reading. `[]` here really is
 *                    an all-clear.
 * - `carried`      — a real, NON-EMPTY list survives from an earlier reading while a
 *                    hold (`inconclusive`) is open, so its freshness is unproven. It is
 *                    reported WITH that caveat rather than erased.
 * - `not-measured` — nothing was measured and nothing is carried. `[]` here is a
 *                    positive statement of ignorance, never an all-clear.
 * - `unknown`      — there was nothing to go on at all.
 *
 * ⚠ Distinct from the sibling `failingTestsCarriedForward`, which marks a DIFFERENT
 * carrying: the monotonic fold inheriting names across ticks of the same candidate
 * (EI-18832825158594027). That one keeps `measured: true` — the names were measured,
 * just not by this tick. This one is about a hold suppressing the measurement entirely.
 */
export type GateFailingTestsProvenance = 'measured' | 'carried' | 'not-measured' | 'unknown';

/**
 * Preserve the distinction between an empty measured verdict and a checkpoint that never
 * produced a verdict. Older writers did not stamp the boolean, so the recorded inconclusive
 * marker is accepted as negative proof and an actual array as positive proof. Everything else
 * remains unknown rather than being promoted to a confident empty measurement.
 */
export function gateFailingTestsMeasurement(input: {
  failingTests: unknown;
  measured: unknown;
  inconclusive: GitPipelineSnapshot['gate']['inconclusive'];
}): { failingTests: string[]; measured: boolean | null; provenance: GateFailingTestsProvenance } {
  const rawFailingTests = input.failingTests;
  const hasArray = Array.isArray(rawFailingTests);
  const failingTests = hasArray
    ? rawFailingTests.filter((x: unknown): x is string => typeof x === 'string')
    : [];
  // WI-2143266: an EXPLICIT `measured:true` backed by a real array is the strongest
  // positive proof this function sees, and it must be checked BEFORE the inconclusive
  // fallback below — an open repair (a non-null `inconclusive`) does not retroactively
  // un-measure a verdict the writer already stamped and populated. Checking this first
  // preserves the list instead of erasing it: the failure mode this fixes is precisely
  // an agent needing to know which legs are red DURING an open repair, and the erased
  // list used to answer that question with a false "nothing failing".
  if (input.measured === true) {
    return hasArray
      ? { failingTests, measured: true, provenance: 'measured' }
      : { failingTests: [], measured: null, provenance: 'unknown' };
  }
  // An explicit `measured: false` is the WRITER'S OWN assertion that it rendered no
  // verdict, so names sitting beside it are INHERITED from an earlier blob rather than
  // evidence about now. Suppressing them is deliberate (EI-21561093776434695) and is NOT
  // the erasure D-002 names — there is no live measurement here to preserve, and sending
  // a fixer at a historical red is the failure that suppression exists to prevent.
  if (input.measured === false) {
    return { failingTests: [], measured: false, provenance: 'not-measured' };
  }
  if (input.inconclusive !== null) {
    // P-005 / D-002, the RESIDUAL half of the blanking. An UNSTAMPED writer that still
    // recorded a populated list, with a hold open, used to be flattened to
    // `{ [], measured: false }` — which renders as "nothing failing" during exactly the
    // window in which an agent needs the names. The list now SURVIVES, labelled: the
    // ruling is that a measured-but-possibly-stale list must be marked, not replaced.
    // `measured` stays NULL because we genuinely cannot claim this tick measured it —
    // `true` would overclaim and `false` is the false-green this whole plan exists to end.
    if (failingTests.length > 0) {
      return { failingTests, measured: null, provenance: 'carried' };
    }
    // Nothing to carry: the inconclusive marker stands as negative proof, as before.
    return { failingTests: [], measured: false, provenance: 'not-measured' };
  }
  return hasArray
    ? { failingTests, measured: true, provenance: 'measured' }
    : { failingTests: [], measured: null, provenance: 'unknown' };
}
/**
 * Parse git-sync's persisted `last_skipped_paths` back into its union type.
 *
 * WI-10006493: this used to accept ONLY the lock-holder shape (`owner` + `intent`), so every
 * guard deferral — a migration whose reservation was refused, or a superproject path held by
 * the migration dependency fence — was silently dropped here. dev:pipeline_position then saw
 * no reason the path was stuck and told the caller to force `git-sync:run`, which defers the
 * same path again on the next tick. Each variant is now validated on its own.
 */
export function skippedPathArr(v: unknown): GitSyncSkippedPath[] {
  if (!Array.isArray(v)) return [];
  const strings = (u: unknown): string[] | undefined =>
    Array.isArray(u) ? u.filter((s): s is string => typeof s === 'string') : undefined;
  const out: GitSyncSkippedPath[] = [];
  for (const x of v) {
    if (!x || typeof x !== 'object') continue;
    const r = x as Record<string, unknown>;
    if (typeof r.scope !== 'string' || typeof r.path !== 'string') continue;
    if (typeof r.owner === 'string' && typeof r.intent === 'string') {
      out.push({ scope: r.scope, path: r.path, owner: r.owner, intent: r.intent });
      continue;
    }
    if (typeof r.detail !== 'string') continue;
    if (r.reason === 'migration-reservation') {
      out.push({ scope: r.scope, path: r.path, reason: 'migration-reservation', detail: r.detail });
    } else if (r.reason === 'migration-dependency-fence') {
      const blockingMigrations = strings(r.blockingMigrations);
      const blockingAgents = strings(r.blockingAgents);
      const blockingWorkItems = strings(r.blockingWorkItems);
      out.push({
        scope: r.scope,
        path: r.path,
        reason: 'migration-dependency-fence',
        detail: r.detail,
        ...(blockingMigrations ? { blockingMigrations } : {}),
        ...(blockingAgents ? { blockingAgents } : {}),
        ...(blockingWorkItems ? { blockingWorkItems } : {}),
      });
    }
  }
  return out;
}
function dateMs(v: unknown): number | null {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') {
    const t = new Date(v).getTime();
    return Number.isFinite(t) ? t : null;
  }
  return null;
}

interface RoutineRow {
  name: string;
  active: boolean;
  trigger_config: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  last_fired_at: Date | string | null;
  next_fire_at: Date | string | null;
  /** Optional so an older/narrower SELECT still type-checks; absent reads as ungrouped. */
  group_slug?: string | null;
}

export function toRoutineInfo(r: RoutineRow | undefined): RoutineInfo | null {
  if (!r) return null;
  // P-004: parse through the shared reader so `expiresAtMs` (and the legacy-field
  // aliases) mean exactly one thing across every surface that renders a pause.
  const parsed = readRoutinePause(r.metadata?.pause);
  const pause = parsed.present
    ? {
        reason: parsed.reason,
        pausedBy: parsed.pausedBy,
        pausedAtMs: parsed.pausedAtMs,
        expiresAtMs: parsed.expiresAtMs,
      }
    : null;
  return {
    name: r.name,
    active: Boolean(r.active),
    cron: typeof r.trigger_config?.cron === 'string' ? (r.trigger_config.cron as string) : null,
    lastFiredAtMs: dateMs(r.last_fired_at),
    nextFireAtMs: dateMs(r.next_fire_at),
    groupSlug: r.group_slug ?? null,
    pause,
  };
}

/**
 * Narrow, execution-time reread of the release-trigger control row. Status uses the
 * already-loaded snapshot; the deploy chokepoint calls this again immediately before its
 * first mutation so a pause applied after detached launch still wins. Errors deliberately
 * propagate: an unreadable safety control is UNKNOWN and must fail the ordinary deploy closed.
 */
export async function readReleaseTriggerControl(slug: string = DEFAULT_SLUG): Promise<RoutineInfo | null> {
  const { sql } = getOrgPg();
  const rows = await sql<RoutineRow[]>`
    SELECT name, active, trigger_config, metadata, last_fired_at, next_fire_at, group_slug
      FROM harness_shared.routines
     WHERE install_slug = ${slug}
       AND name = 'release-trigger'
     LIMIT 1
  `;
  return toRoutineInfo(rows[0]);
}

/**
 * One fail-closed interpretation of the release-trigger control row, shared by
 * the status surface and the execution-time deploy guard. `null` means the
 * ordinary deploy path is enabled; any string is the exact refusal reason.
 */
export function releaseTriggerControlBlockReason(control: RoutineInfo | null): string | null {
  if (control?.active === true) return null;
  if (control?.pause?.reason) {
    return `release-trigger is deliberately paused: ${control.pause.reason}`;
  }
  return control
    ? 'release-trigger is inactive without deliberate-pause provenance'
    : 'release-trigger control is unavailable';
}

export interface RawGateCounters {
  consecutiveReds: number;
  stalled: boolean | null;
  failingTests: string[];
  firstRedAtMs: number | null;
}

export function deriveInRoutineGateStalled(input: {
  consecutiveReds: number | null;
  stallAgeMs: number | null;
  stallRedsThreshold: number;
  stallAgeThresholdMs: number;
}): boolean | null {
  const redCondition =
    input.consecutiveReds === null ||
    !Number.isFinite(input.consecutiveReds) ||
    !Number.isFinite(input.stallRedsThreshold) ||
    input.stallRedsThreshold <= 0
      ? null
      : highestRungCrossed(input.consecutiveReds, input.stallRedsThreshold) !== null;
  const ageCondition =
    input.stallAgeMs === null ||
    !Number.isFinite(input.stallAgeMs) ||
    !Number.isFinite(input.stallAgeThresholdMs) ||
    input.stallAgeThresholdMs <= 0
      ? null
      : highestRungCrossed(input.stallAgeMs, input.stallAgeThresholdMs) !== null;

  if (redCondition === true || ageCondition === true) return true;
  if (redCondition === false && ageCondition === false) return false;
  return null;
}

export function combineGateStallSignals(
  inRoutineStalled: boolean | null,
  watchdogStalled: boolean | null,
): boolean | null {
  if (inRoutineStalled === true || watchdogStalled === true) return true;
  if (inRoutineStalled === false && watchdogStalled === false) return false;
  return null;
}

/**
 * Project the green-checkpoint watchdog's combined verdict onto the
 * fire-specific fields exposed by the pipeline snapshot.
 *
 * `evaluateGreenStall().stalled` is intentionally the union of two different
 * signals: the routine stopped firing (`fireStale`) and no GREEN verdict was
 * observed (`verdictStale`).  The snapshot's `fireStale` field is consumed as
 * a direct answer to "is the routine firing?", so storing the union there
 * turns a healthy ticker with a stale verdict into a false "NOT FIRING".
 */
export function projectGreenCheckpointFireFreshness(verdict: { fireStale: boolean; reason: string | null }): {
  fireStale: boolean;
  fireStaleReason: string | null;
} {
  return {
    fireStale: verdict.fireStale,
    fireStaleReason: verdict.fireStale ? verdict.reason : null,
  };
}

/**
 * Project the green-checkpoint routine's deliberate pause onto the gate read.
 * An inactive routine with a pause record cannot produce a verdict, but it is
 * not an unexplained wedge: the record is the authoritative reason and exit
 * context. Active routines must not inherit stale pause metadata.
 *
 * P-004 (gate-verdict-liveness-and-repair-reliability-2026-08-31): the reason
 * text is now the SHARED standing banner — who held it, since when, and when it
 * auto-resumes (or that nothing will re-arm it). The 11-day red-gate audit found
 * 99h of deliberate pause across 14 windows that every status surface rendered as
 * an ordinary red, so the banner exists to make "the gate is OFF" impossible to
 * read as "the gate is FAILING". One builder, so the surfaces cannot drift.
 */
export function projectGreenCheckpointPause(
  routine: RoutineInfo | null,
  nowMs: number = Date.now(),
): {
  pause: RoutineInfo['pause'];
  fireStale: boolean;
  fireStaleReason: string | null;
} {
  const pause = routine?.active === false ? routine.pause : null;
  if (!pause) return { pause: null, fireStale: false, fireStaleReason: null };
  const banner = gatePausedBanner({
    routineName: routine?.name ?? 'green-checkpoint',
    groupSlug: routine?.groupSlug ?? null,
    pause: { ...pause, present: true, legacy: pause.expiresAtMs == null },
    nowMs,
  });
  return {
    pause,
    fireStale: true,
    fireStaleReason: banner,
  };
}

/**
 * EI-13714 — PURE: decide whether the raw cached gate counters (`consecutiveReds` / `stalled` /
 * `failingTests` / `firstRedAtMs`, straight off the `gate_health` blob) must be corrected before
 * being reported anywhere, given the verdict-freshness rule that fired (if any).
 *
 * ONLY `'pin-advance'` is hard proof a green happened since these counters were recorded — the
 * release pin only ever moves on a green checkpoint, so its advance past this verdict's base
 * PROVES the streak it was raised on has already ended. `'writer-starved'` and `'retriage-proven'`
 * only prove the cached verdict is UNVERIFIED, not that the gate is green (WI-4489's "unknown, not
 * green" stays correct for those) — so they, and a fresh (non-stale) verdict, leave the raw
 * counters untouched.
 *
 * This is the ONE place the correction is applied. Every consumer of `GitPipelineSnapshot.gate`
 * (git-pipeline-position, release-deploy-launch's `computeDeployStatus`, why-chain's `gateLabel`,
 * the `coord:orient` pipeline-health fold) reads these fields as-is, so deriving the corrected
 * value here — rather than each of those independently re-checking `verdictStale` — is what keeps
 * a `release:deploy{op:status}` reply from reporting `green:false, stalled:true` in the same
 * response that already proves (`verdictStale:true`, pin-advance reason) that it greened.
 *
 * Exported + pure so this decisive branch is unit-testable without a live Postgres (the full
 * `gitPipelineSnapshot` read is otherwise only exercised via integration test / live verification).
 */
export function pinProvenGateCorrection(
  reasonCode: GateVerdictFreshness['reasonCode'],
  raw: RawGateCounters,
): RawGateCounters {
  if (reasonCode !== 'pin-advance') return raw;
  return { consecutiveReds: 0, stalled: false, failingTests: [], firstRedAtMs: null };
}

/** Options for `gitPipelineSnapshot` (overview-tab-expansion P-001). */
export interface GitPipelineSnapshotOpts {
  /**
   * Permit the release-gate git read to lazily boot the spawner sidecar. Pure
   * diagnostic compositions pass false so a standalone read never creates an
   * agent-spawn transport; omitted preserves the existing default behavior.
   */
  useSpawnerSidecar?: boolean;
  /** Probe the live green-checkpoint systemd unit ("judging vs idle") into `activeRun`.
   *  Default FALSE — the probe forks systemctl, so only the background derived-read
   *  producer opts in; live callers stay fork-free. */
  includeActiveRun?: boolean;
  /** Test seam: the probe fn (defaults to release-checkpoint-launch's
   *  checkActiveCheckpointRun, dynamic-imported only when opted in). */
  probeActiveRun?: (root: string) => {
    active: boolean;
    systemd?: CheckpointSystemdProbe;
    terminal_marker?: boolean;
    terminal_evidence?: {
      source: 'systemd-exec-stop-post';
      candidate: string | null;
      service_result: string;
      exit_code: string;
      exit_status: string;
      abnormal: boolean;
    };
    log_path?: string | null;
    candidate?: string | null;
    started_at?: string | null;
    progress_at?: string | null;
    current_phase?: string | null;
    elapsed_sec?: number | null;
  };
  /** P-009 test seam for pre-lock process authority. When probeActiveRun is injected
   * and this seam is omitted, no real procfs scan is performed. */
  probeProcessAuthority?: (
    root: string,
  ) => CheckpointProcessAuthorityReading | PromiseLike<CheckpointProcessAuthorityReading>;
}

/** PURE (P-001): map a checkActiveCheckpointRun probe result onto the snapshot's
 *  `activeRun` shape (systemd timestamp → epoch ms; absent fields → null). */
export function mapActiveRun(r: {
  active: boolean;
  held_externally?: boolean;
  probe_failed?: boolean;
  probe_detail?: string | null;
  systemd?: CheckpointSystemdProbe;
  terminal_marker?: boolean;
  terminal_evidence?: {
    source: 'systemd-exec-stop-post';
    candidate: string | null;
    service_result: string;
    exit_code: string;
    exit_status: string;
    abnormal: boolean;
  };
  log_path?: string | null;
  candidate?: string | null;
  // EI-19327704778173646: refire provenance from the probe, carried through so a caller
  // can tell a candidate that legitimately MOVED from a field that looks unstable.
  initial_candidate?: string | null;
  refire_observed?: boolean;
  started_at?: string | null;
  progress_at?: string | null;
  current_phase?: string | null;
  elapsed_sec?: number | null;
}): NonNullable<GitPipelineSnapshot['activeRun']> {
  const startedAtMs = r.started_at ? Date.parse(r.started_at) : NaN;
  const progressAtMs = r.progress_at ? Date.parse(r.progress_at) : NaN;
  return {
    active: r.active,
    ...(r.held_externally ? { heldExternally: true as const } : {}),
    ...(r.probe_failed
      ? { probeFailed: true as const, probeDetail: r.probe_detail ?? null }
      : {}),
    ...(r.systemd
      ? {
          systemd: {
            scope: r.systemd.scope,
            argv: [...r.systemd.argv],
            loadState: r.systemd.load_state,
            known: r.systemd.known,
            invocationId: r.systemd.invocation_id,
            appliesToActiveRun: r.active && !r.held_externally,
          },
        }
      : {}),
    ...(r.terminal_marker === undefined ? {} : { terminalMarker: r.terminal_marker }),
    ...(r.terminal_evidence
      ? {
          terminalEvidence: {
            source: r.terminal_evidence.source,
            candidate: r.terminal_evidence.candidate,
            serviceResult: r.terminal_evidence.service_result,
            exitCode: r.terminal_evidence.exit_code,
            exitStatus: r.terminal_evidence.exit_status,
            abnormal: r.terminal_evidence.abnormal,
          },
        }
      : {}),
    ...(r.log_path ? { logPath: r.log_path } : {}),
    candidate: r.candidate ?? null,
    // Emitted ONLY on an actual refire, so the common reply shape is unchanged.
    ...(r.refire_observed ? { initialCandidate: r.initial_candidate ?? null, refireObserved: true } : {}),
    startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : null,
    // An externally-held (normally scheduled) run has no manual-unit heartbeat. If no
    // phase heartbeat was recorded, its start time is not evidence of progress; preserve
    // the unknown reading as null rather than making a long healthy run look stalled.
    progressAtMs: Number.isFinite(progressAtMs)
      ? progressAtMs
      : r.held_externally
        ? null
        : Number.isFinite(startedAtMs)
          ? startedAtMs
          : null,
    ...(r.current_phase === undefined ? {} : { currentPhase: r.current_phase ?? null }),
    elapsedSec: r.elapsed_sec ?? null,
  };
}

/** P-009: overlay the live pre-lock process authority onto the systemd/run-lock
 * snapshot. Pure so the dangerous transition (`active:false` → active setup with
 * no candidate) has a direct behavioural guard rather than existing only in the
 * production wiring. */
export function applyCheckpointProcessAuthority(
  activeRun: GitPipelineSnapshot['activeRun'],
  authority: CheckpointProcessAuthorityReading | null | undefined,
): GitPipelineSnapshot['activeRun'] {
  if (
    !authority?.active ||
    authority.pid === null ||
    !authority.cgroupPath ||
    !authority.workspace ||
    !authority.harness
  ) {
    return activeRun;
  }
  return {
    ...activeRun,
    active: true,
    preLockAuthority: {
      workspace: authority.workspace,
      harness: authority.harness,
      cgroupPath: authority.cgroupPath,
      pid: authority.pid,
    },
    candidate: null,
    startedAtMs: authority.startedAtMs,
    // EI-22129511435526580: `'materializing'` + `progressAtMs === startedAtMs` is the
    // correct reading ONLY when this is genuinely the pre-lock "just started, no candidate
    // yet" transition — the case every existing caller exercises (`activeRun` was idle, so
    // it has no phase/progress of its own to lose). But this same overlay ALSO fires later,
    // whenever the systemd-unit probe's OWN tracking goes stale (its `loadState` reads
    // "not-found" once systemd forgets a long-running manual unit) while `activeRun` is
    // otherwise still describing the SAME live run — `mapActiveRun` (called just before this,
    // against the same resolved root) already carries the real `currentPhase`/`progressAtMs`
    // whenever the underlying probe reported them. Unconditionally overwriting those with the
    // startup placeholder threw away a genuine "deep in the affected-test sweep, log mtime
    // seconds old" signal and reported it back as "stuck materializing for 53 minutes" — the
    // exact false-positive-for-a-stall / false-negative-for-a-real-wedge failure mode the
    // ticket describes. Prefer whatever `activeRun` already knows; fall back to the pre-lock
    // placeholder only when it has nothing better (activeRun was null/idle, matching every
    // existing caller/test unchanged).
    progressAtMs: activeRun?.progressAtMs ?? authority.startedAtMs,
    currentPhase: activeRun?.currentPhase ?? 'materializing',
    elapsedSec: authority.elapsedSec,
  };
}

/**
 * Resolve the checkout whose checkpoint unit belongs to `pipeline`.
 *
 * A pipeline is the sanitized integration-root basename, not a harness slug. The
 * registry is therefore the only safe cross-harness mapping available here. An
 * ambiguous registry match is deliberately unprobeable: guessing would attach one
 * harness's live candidate and progress clock to another harness's wait. The legacy
 * deploy root remains a fallback only for the operator's own default pipeline.
 */
export function selectActiveCheckpointRoot(input: {
  pipeline: string;
  projectPaths: readonly string[];
  defaultPipeline: string;
  defaultRoot: string;
  canonicalRoot?: string;
}): string | null {
  // A staging operator serves from a mirror but the manual checkpoint unit and run-lock
  // belong to the canonical edit tree. Hashing the mirror path probes a different unit and
  // can report idle while the canonical checkpoint is active. Keep the registry out of this
  // default-pipeline choice: it may contain several worktrees with the same basename.
  if (input.pipeline === input.defaultPipeline) return input.canonicalRoot?.trim() || input.defaultRoot;
  const matchingRoots = [...new Set(input.projectPaths.filter((root) => pipelineName(root) === input.pipeline))];
  if (matchingRoots.length === 1) return matchingRoots[0] ?? null;
  return null;
}

/** Compute the full pipeline snapshot for `slug` (defaults to the operator's own). */
export async function gitPipelineSnapshot(
  slug: string = DEFAULT_SLUG,
  opts: GitPipelineSnapshotOpts = {},
): Promise<GitPipelineSnapshot> {
  const { sql } = getOrgPg();

  // EI-21544761852770720: every read below is independent.  Starting the
  // routines read, conflict read, window summaries, and deploy snapshot in
  // separate phases made their queueing latency additive on a busy host.  The
  // state-cell caller has a 10s totality bound, so an otherwise healthy set of
  // reads could intermittently cross it.  Start the complete fan-out before
  // consuming any result; the derivation below still observes exactly one
  // settled result from each source and retains every existing fail-soft path.
  const routineRowsPromise = sql<RoutineRow[]>`
    SELECT name, active, trigger_config, metadata, last_fired_at, next_fire_at, group_slug
      FROM harness_shared.routines
     WHERE install_slug = ${slug}
       AND name IN ('git-sync', 'green-checkpoint', 'release-trigger')
  `.catch(() => [] as RoutineRow[]);
  const openConflictRowsPromise = sql<
    {
      escalation: Record<string, unknown>;
      mtime_ms: unknown;
    }[]
  >`
    SELECT escalation, mtime_ms
      FROM harness_shared.harness_escalations
     WHERE harness_slug = ${slug}
       AND escalation IS NOT NULL
       AND (escalation::jsonb ->> 'kind') = 'git-sync-conflict'
     ORDER BY mtime_ms DESC
     LIMIT 1
  `.catch(() => []);
  const dayPromise = summarizePipelineWindow(slug, 24 * 60 * 60);
  const weekPromise = summarizePipelineWindow(slug, 7 * 24 * 60 * 60);
  const recentPromise = recentPipelineEvents(slug, 25);
  const deployPromise = devDeployState({ useSpawnerSidecar: opts.useSpawnerSidecar });

  // The three pipeline routines + git-sync's latest metadata, in one read.
  const routineRows = await routineRowsPromise;
  const byName = (n: string) => routineRows.find((r) => r.name === n);
  const gitSyncRow = byName('git-sync');
  const meta = (gitSyncRow?.metadata ?? {}) as Record<string, unknown>;
  const lastResolver = (meta.last_resolver ?? null) as Record<string, unknown> | null;
  // P-004: green-checkpoint gate health (red streak + last release-fixer).
  const gcMeta = (byName('green-checkpoint')?.metadata ?? {}) as Record<string, unknown>;
  const qualification = projectCheckpointQualificationState(gcMeta.qualificationTransaction);
  const gateHealth = (gcMeta.gate_health ?? {}) as Record<string, unknown>;
  const gatePromotionIdentity = projectGatePromotionIdentity(gateHealth);
  const candidateSnapshot = projectGateCandidateSnapshot(gateHealth);
  const lastFixer = (gcMeta.last_fixer ?? null) as Record<string, unknown> | null;
  const flakeHistory = (gcMeta.flake_history ?? {}) as Record<string, { flakes?: number }>;

  // WI-282: a wedged / non-firing green-checkpoint produces 0 reds (it never ran to
  // go red), so the reds-based `stalled` stays false while `main` silently freezes.
  // Reuse the green-stall-watchdog's pure freshness verdict (last-fire / last-green
  // age) so the gate READ surfaces a wedge too — independent of the red streak.
  const gcRow = byName('green-checkpoint');
  const greenCheckpoint = toRoutineInfo(gcRow);
  const pauseProjection = projectGreenCheckpointPause(greenCheckpoint);
  const gcLastFiredMs = dateMs(gcRow?.last_fired_at);
  let gcFireStale = pauseProjection.fireStale;
  let gcFireStaleReason: string | null = pauseProjection.fireStaleReason;
  let gcWatchdogStalled: boolean | null = null;
  if (gcRow?.active === true) {
    try {
      const { evaluateGreenStall } = await import('./release/green-stall-watchdog');
      const v = evaluateGreenStall(
        {
          lastFiredMs: gcLastFiredMs,
          lastGreenAt: num(gateHealth.lastGreenAt),
          lastVerdictAtMs: num(gateHealth.observedAt),
          watchdogAlerted: gateHealth.watchdogAlerted === true,
        },
        Date.now(),
      );
      gcWatchdogStalled = v.suppressed ? null : v.stalled;
      const fireFreshness = projectGreenCheckpointFireFreshness(v);
      gcFireStale = fireFreshness.fireStale;
      gcFireStaleReason = fireFreshness.fireStaleReason;
    } catch {
      // best-effort — a freshness probe must never break the snapshot read.
    }
  }

  // The currently-open merge conflict (git-sync-conflict escalation), if any.
  let openConflict: GitPipelineSnapshot['openConflict'] = null;
  try {
    const escRows = await openConflictRowsPromise;
    const esc = escRows[0]?.escalation;
    const escMtimeMs = num(escRows[0]?.mtime_ms);
    const lastMergeCompleted = strArr(meta.last_merge_completed);
    const lastMergeCompletedAtMs = num(meta.last_merge_completed_at);
    if (
      esc &&
      isGitSyncConflictCurrent({
        escalationMtimeMs: escMtimeMs,
        lastSyncedAtMs: num(meta.last_synced_at),
        lastMergeCompletedAtMs,
        lastMergeCompleted,
      })
    ) {
      const conflicts = Array.isArray(esc.conflicts)
        ? (esc.conflicts as Array<Record<string, unknown>>).map((c) => ({
            scope: String(c.scope ?? ''),
            files: strArr(c.conflicted_files),
          }))
        : [];
      openConflict = {
        scopes: conflicts.map((c) => c.scope).filter(Boolean),
        conflicts,
        emittedAtMs: num(esc.emitted_at),
      };
    }
  } catch {
    openConflict = null;
  }

  // EI-19399662484764592: derived from `recent` BELOW — no extra query. See pickRetriageVerdict.
  const [day, week, recent, deploy] = await Promise.all([
    dayPromise,
    weekPromise,
    recentPromise,
    deployPromise,
  ]);

  // WI-4489: is the recorded RED still trustworthy? The green pin is the ground truth (it only
  // advances on a green checkpoint); `gate_health` is a cache of it that a starved writer can
  // freeze indefinitely. Needs `deploy.greenPinSha`, so it is derived here rather than above.
  const verdictObservedAtMs = num(gateHealth.observedAt);
  const retriageStaleTip = typeof gateHealth.retriageStaleTip === 'string' ? gateHealth.retriageStaleTip : null;
  const retriageDetail = typeof gateHealth.retriageDetail === 'string' ? gateHealth.retriageDetail : null;
  // EI-18669342433807110 — Rule 4: a stale-candidate auto-refire for the cached red running RIGHT
  // NOW, already freshness-checked (missing/malformed/abandoned ⇒ null).
  const inFlightRetriage = parseInFlightRetriage(gateHealth.inFlightRetriage);
  // EI-19931692050586322 — the SIBLING marker, and the one that covers the common case. Same
  // freshness contract (missing/malformed/abandoned ⇒ null), same "already in hand" property:
  // `gateHealth` is the object we have already loaded, so this is a second key off it, never a
  // second query. Deliberately parsed even when `inFlightRetriage` is non-null — the consumer
  // decides precedence (a refire supersedes the original candidate), not this line.
  const inFlightCandidate = parseInFlightCandidate(gateHealth.inFlightCandidate);
  // WI-2143253: the read-side half of the gap — `gate_health.repairTickLegs` was already
  // written on every awaiting-fixer hold tick; nothing ever parsed it back out. Same
  // "already in hand" property as its siblings above: a second key off `gateHealth`,
  // never a second query.
  const repairTickLegs = parseRepairTickLegs(gateHealth.repairTickLegs);
  /**
   * EI-19346660748445728 — Rule 5 input. `gate_health.candidateCommittedAt` is written by
   * `release-actions.ts` as an ISO STRING (`git show -s --format=%cI`), unlike its sibling
   * `observedAt`, which is epoch ms from `Date.now()`. Parsing is therefore NOT symmetric with the
   * `num()` above and must not be made to look like it: a `num()` on the ISO string yields NaN,
   * which would silently disable the rule while looking wired.
   *
   * Both shapes are accepted anyway — a number passes through — so a writer that ever switches to
   * epoch ms cannot quietly turn the rule off. An unparseable value degrades to null (rule
   * unavailable), never to 0, which would date the candidate to 1970 and make EVERY verdict a
   * fossil — the loudest possible false positive.
   */
  const candidateCommittedAtMs = ((): number | null => {
    const raw = gateHealth.candidateCommittedAt;
    // The one bad value that PARSES. A repair-queue admission commit carries a fixed sentinel
    // date (so preview and confirmed write hash alike), so a `repairHead` reports `2000-01-01` —
    // a constant, not a measurement. The writer stopped recording it, but blobs written before
    // that fix still carry it, and reading one as a real date is precisely the "EVERY verdict is
    // a fossil" false positive the `?? 0` guard above exists to prevent (WI-10002121).
    if (isAdmissionSyntheticCommitDate(raw as string | number | null | undefined)) return null;
    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
    if (typeof raw !== 'string' || raw.trim() === '') return null;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  })();
  /**
   * P-007 (D-038 axis 2). The `?? 0` below is load-bearing for every downstream
   * consumer — they all expect a number — but the fallback DESTROYS the distinction
   * between "the gate ran and recorded no reds" and "no counter was recorded at all",
   * and those read identically as a passing gate. Capture which one it was BEFORE the
   * default is applied; it is unrecoverable afterwards.
   */
  // EI-19325520469216548: captured under its own name BEFORE it is handed to
  // evaluateGateVerdictFreshness as an input — it was already being computed for that call and
  // then discarded, which is exactly the "computed but never surfaced" gap this closes.
  const rawCommitsBehindTip = num(gateHealth.commitsBehindTip);
  const measuredConsecutiveReds = num(gateHealth.consecutiveReds);
  const countersUnknown: CellUnknown | null =
    measuredConsecutiveReds == null
      ? cellUnknown(
          'resolver-failed',
          'the green-checkpoint routine metadata (`gate_health.consecutiveReds`) carried no readable red-streak counter, so the reported 0 is a DEFAULT and not a measurement — do not read it as a passing gate',
        )
      : null;
  const rawConsecutiveReds = measuredConsecutiveReds ?? 0;
  const lastGreenAtMs = num(gateHealth.lastGreenAt);
  // Keep the release override reader out of this module's import graph. Pot
  // wake tools import pipeline types transitively and must perform no DB I/O
  // merely by loading their definitions.
  const { releaseCheckpointConfig, releaseCheckpointConfigReady } = await import('./release-checkpoint-config');
  await releaseCheckpointConfigReady;
  const stallConfig = releaseCheckpointConfig();
  const inRoutineStalled = deriveInRoutineGateStalled({
    consecutiveReds: measuredConsecutiveReds,
    stallAgeMs: lastGreenAtMs === null ? null : Date.now() - lastGreenAtMs,
    stallRedsThreshold: stallConfig.stallReds,
    stallAgeThresholdMs: stallConfig.stallAgeMs,
  });
  const {
    stale: gcVerdictStale,
    reason: gcVerdictStaleReason,
    reasonCode: gcVerdictStaleReasonCode,
    // EI-19325520469216548: this was already being computed by the function below and
    // discarded at this very destructure — never assigned to a name, never returned. See the
    // `candidateAgeMs` field on `GitPipelineSnapshot.gate` for why that mattered.
    candidateAgeMs: gcCandidateAgeMs,
  } = evaluateGateVerdictFreshness({
    consecutiveReds: rawConsecutiveReds,
    observedAtMs: verdictObservedAtMs,
    observedFromPin: typeof gateHealth.lastFrom === 'string' ? gateHealth.lastFrom : null,
    // The release ("ready") pin — the green-checkpoint's own durable verdict, in git.
    currentGreenPinSha: deploy.greenPin?.sha ?? null,
    lastFiredAtMs: gcLastFiredMs,
    // EI-13288 — Rule 3: this verdict's own re-triage evidence, when it has any.
    retriageStaleTip,
    // EI-18669342433807110 — Rule 4: an in-flight refire for this exact red, when one is running.
    inFlightRetriage,
    // EI-19346660748445728 — Rule 5: how old the JUDGED COMMIT already was when this verdict was
    // written. Both fields were being recorded here long before anything read them; this is the
    // read side, and it is what makes a 10h-stale red announce itself instead of presenting as
    // current (measured 2026-08-02: a 651-min-fossil verdict cost ~2h of fleet time and produced
    // four contradictory conclusions, because `stale` came back false).
    candidateCommittedAtMs,
    commitsBehindTip: rawCommitsBehindTip,
    // EI-20571364274022293 — Rule 1 ORDERING. Whether `lastFrom` above was READ LIVE by the run
    // that wrote this verdict, or merely carried forward because that run could not resolve the
    // pin. Only the first makes a pin difference proof of a green SINCE this red. Absent on a
    // blob predating the field ⇒ null ⇒ rule 1 degrades to 'pin-advance-unordered', which
    // deliberately does NOT reset the counters below.
    observedFromPinFresh:
      typeof (gateHealth as { lastFromFresh?: unknown }).lastFromFresh === 'boolean'
        ? ((gateHealth as { lastFromFresh?: boolean }).lastFromFresh as boolean)
        : null,
  });
  const gateInconclusive = currentGateInconclusive(gateHealth.inconclusive, gcMeta.repair_queue);
  const failingTestsMeasurement = gateFailingTestsMeasurement({
    failingTests: gateHealth.failingTests,
    measured: gateHealth.failingTestsMeasured,
    inconclusive: gateInconclusive,
  });
  const effectiveGate = pinProvenGateCorrection(gcVerdictStaleReasonCode, {
    consecutiveReds: rawConsecutiveReds,
    stalled: inRoutineStalled,
    failingTests: failingTestsMeasurement.failingTests,
    firstRedAtMs: num(gateHealth.firstRedAt),
  });
  const gateStalled = combineGateStallSignals(effectiveGate.stalled, gcWatchdogStalled);

  // EI-18672078222841101: resolve WHO owns this red, from state the system already keeps.
  // Only for an actually-red gate — a green gate has no ownership question, and asking one
  // would put a misleading "UNOWNED" on every healthy read.
  //
  // The liveness query runs ONLY when the recorded fixer holds the CURRENT signature: a
  // mismatch is already decisive ('stale-signature' — that fixer is on a different failure),
  // so the round-trip would buy nothing. On a green gate it never runs at all. Failure is
  // soft: `null` renders as 'owned-unknown' (presumed covered), the same assumption the
  // dispatcher makes for a record it cannot resolve — never a fabricated liveness value.
  let redOwner: GateRedOwnership | null = null;
  if (effectiveGate.consecutiveReds > 0) {
    const currentSignature = gateFailureSignature(
      effectiveGate.failingTests,
      gatePromotionIdentity.observedCandidate,
    );
    const ownerSignature = typeof lastFixer?.signature === 'string' ? lastFixer.signature : null;
    const spawnId = typeof lastFixer?.spawnId === 'string' ? lastFixer.spawnId : null;
    let fixerAlive: boolean | null = null;
    if (!gcVerdictStale && ownerSignature && currentSignature && ownerSignature === currentSignature) {
      fixerAlive = await releaseFixerSpawnAlive(sql, spawnId).catch(() => null);
    }
    redOwner = describeGateRedOwnership({
      ownerSignature,
      currentSignature,
      dispatchedAtMs: num(lastFixer?.at),
      spawnId,
      fixerAlive,
      verdictStale: gcVerdictStale,
      nowMs: Date.now(),
    });
  }

  const repairQueueProjection = projectFrozenRepairQueueRead(
    gcMeta.repair_queue,
    gateHealth,
    Date.now(),
  );
  const persistedRepairQueue = repairQueueProjection.queue;
  const repairQueueRead = repairQueueProjection.read;
  let repairQueueFixerAlive: boolean | null | undefined;
  if (persistedRepairQueue?.fixerSpawnId) {
    repairQueueFixerAlive = await releaseFixerSpawnAlive(
      sql,
      persistedRepairQueue.fixerSpawnId,
    ).catch(() => null);
  }
  const repairQueue = diagnoseFrozenCandidateRepairQueue(persistedRepairQueue, {
    nowMs: Date.now(),
    fixerAlive: repairQueueFixerAlive,
  });
  const freezeAndConverge = repairQueueProjection.freezeAndConverge;

  // P-001: "judging vs idle" — probe the live checkpoint unit ONLY when opted in
  // (the dev.gitPipeline derived-read producer; see the interface note). Best-effort:
  // a probe failure yields null (not probed), never a broken snapshot.
  let activeRun: GitPipelineSnapshot['activeRun'] = null;
  let resolvedActiveRunRoot: string | null = null;
  if (opts.includeActiveRun) {
    try {
      // release:deploy and the operator-home derived read always target the default pipeline.
      // Use its explicit integration root directly so registry ambiguity/availability cannot
      // turn a live run-lock into a false null. Non-default pipelines still require the
      // registry mapping to avoid attaching one harness's checkpoint process to another.
      if (slug === DEFAULT_SLUG) {
        resolvedActiveRunRoot = selectActiveCheckpointRoot({
          pipeline: slug,
          projectPaths: [],
          defaultPipeline: DEFAULT_SLUG,
          defaultRoot: deploy.integrationRoot,
          canonicalRoot: process.env.PAPERCUSP_CANONICAL_TREE,
        });
      } else {
        const registry = await loadHarnessRegistry();
        resolvedActiveRunRoot = selectActiveCheckpointRoot({
          pipeline: slug,
          projectPaths: registry.projects.map((project) => project.path),
          defaultPipeline: DEFAULT_SLUG,
          defaultRoot: deploy.integrationRoot,
        });
      }
      if (resolvedActiveRunRoot) {
        // WI-10005268: the real probe runs off the event loop (checkActiveCheckpointRunAsync).
        activeRun = mapActiveRun(
          opts.probeActiveRun
            ? opts.probeActiveRun(resolvedActiveRunRoot)
            : await (await import('./release-checkpoint-launch')).checkActiveCheckpointRunAsync(resolvedActiveRunRoot),
        );
        const authorityProbe =
          opts.probeProcessAuthority ??
          (opts.probeActiveRun
            ? null
            : (await import('./release-checkpoint-launch')).readCheckpointProcessAuthorityCheap);
        const authority = authorityProbe ? await authorityProbe(resolvedActiveRunRoot) : null;
        activeRun = applyCheckpointProcessAuthority(activeRun, authority);
      }
    } catch {
      activeRun = null;
    }
  }

  return {
    slug,
    generatedAtMs: Date.now(),
    routines: {
      gitSync: toRoutineInfo(gitSyncRow),
      greenCheckpoint,
      releaseTrigger: toRoutineInfo(byName('release-trigger')),
    },
    gitSync: {
      lastStatus: typeof meta.last_status === 'string' ? meta.last_status : null,
      lastSyncedAtMs: num(meta.last_synced_at),
      consecutiveErrorTicks: num(meta.consecutive_error_ticks) ?? 0,
      headSha: typeof meta.head_sha === 'string' ? meta.head_sha : null,
      lastPushed: strArr(meta.last_pushed),
      lastMerged: strArr(meta.last_merged),
      lastConflicts: strArr(meta.last_conflicts),
      lastErrors: strArr(meta.last_errors),
      skippedPaths: skippedPathArr(meta.last_skipped_paths),
      // EI-18812945811758018: 'push' | 'commit-only:<reason>' | null (older rows, before
      // git-sync recorded it). NEVER default this to 'push' — an absent mode is UNKNOWN,
      // and guessing "it pushes" is what made an empty lastPushed read as a fault.
      pushMode: typeof meta.push_mode === 'string' ? meta.push_mode : null,
      ownHeadPublish: ((): GitPipelineSnapshot['gitSync']['ownHeadPublish'] => {
        const ohp = meta.own_head_publish;
        if (ohp === null || typeof ohp !== 'object') return null;
        const rec = ohp as Record<string, unknown>;
        return {
          refused: typeof rec.refused === 'string' ? rec.refused : null,
          backlogRemains: typeof rec.backlogRemains === 'boolean' ? rec.backlogRemains : null,
          publishedSha: typeof rec.publishedSha === 'string' ? rec.publishedSha : null,
          sha: typeof rec.sha === 'string' ? rec.sha : null,
        };
      })(),
    },
    resolver: {
      model: resolverModel(),
      lastStatus: typeof lastResolver?.status === 'string' ? lastResolver.status : null,
      lastAtMs: num(lastResolver?.at),
      lastExitCode: num(lastResolver?.exitCode),
      lastHttpStatus: num(lastResolver?.httpStatus),
      lastTimedOut: typeof lastResolver?.timedOut === 'boolean' ? lastResolver.timedOut : null,
      lastScopes: strArr(lastResolver?.scopes),
    },
    gate: {
      // EI-13714: reset to 0 when a pin advance PROVES a green happened since this count was
      // recorded — never left as a stale, alarm-triggering streak (see `pinProvenGateCorrection`).
      consecutiveReds: effectiveGate.consecutiveReds,
      countersUnknown,
      lastGreenAtMs,
      // EI-20706962612084953: pass the writer's own verdict marker through UNCHANGED — it is
      // the one field here that is a statement rather than an inference. Anything other than
      // the two known values (including absent, i.e. a blob predating the marker) is `null`,
      // so a consumer can tell "recorded not-green" from "not recorded" and degrade honestly.
      recordedVerdict:
        gateHealth.lastVerdict === 'green' || gateHealth.lastVerdict === 'not-green' ? gateHealth.lastVerdict : null,
      firstRedAtMs: effectiveGate.firstRedAtMs,
      // EI-21462211894072863: read straight off the blob and deliberately NOT routed through
      // `pinProvenGateCorrection` above. That correction zeroes a RED streak once a pin-advance
      // proves a green happened since — reasoning that does not transfer: a pin that moved is
      // evidence about the CODE, never evidence that this gate's runs started producing verdicts.
      // Zeroing this on that basis would hide a wedged writer behind someone else's green.
      consecutiveNoVerdict: num(gateHealth.consecutiveNoVerdict) ?? 0,
      // A stalled-streak alert can't survive proof the streak it was raised on has already ended.
      stalled: gateStalled,
      lastFiredAtMs: gcLastFiredMs,
      fireStale: gcFireStale,
      fireStaleReason: gcFireStaleReason,
      verdictObservedAtMs,
      verdictStale: gcVerdictStale,
      verdictStaleReason: gcVerdictStaleReason,
      verdictStaleReasonCode: gcVerdictStaleReasonCode,
      lastFixerStatus: typeof lastFixer?.status === 'string' ? lastFixer.status : null,
      lastFixerAtMs: num(lastFixer?.at),
      lastFixerCandidate: typeof lastFixer?.candidate === 'string' ? lastFixer.candidate : null,
      candidateSnapshot,
      redOwner,
      // WI-4533: the gate's OWN verdict about what is failing (see the type's note) — never the
      // names behind a streak already proven reset (they'd misdirect a fixer at passing tests).
      failingTests: effectiveGate.failingTests,
      failingTestsMeasured:
        gcVerdictStaleReasonCode === 'pin-advance' ? true : failingTestsMeasurement.measured,
      // P-005: the same override, on the provenance axis. A PROVEN pin-advance wiped
      // `failingTests` to `[]` above because the streak is genuinely reset — so that empty
      // list is a real all-clear (`measured`), not the ignorance `not-measured` would claim.
      failingTestsProvenance:
        gcVerdictStaleReasonCode === 'pin-advance' ? 'measured' : failingTestsMeasurement.provenance,
      // EI-18832825158594027: forward the writer's inherited-list marker. A proven pin-advance
      // has already wiped `failingTests` to `[]` above, so there is nothing inherited left to
      // label — report false rather than letting a stale true ride a now-empty list.
      failingTestsCarriedForward:
        gcVerdictStaleReasonCode === 'pin-advance' ? false : gateHealth.failingTestsCarriedForward === true,
      // Not part of `RawGateCounters`/`pinProvenGateCorrection`: a proven pin-advance already
      // wipes `failingTests` to `[]` above, which alone makes `verifyGateVerdict`'s file-shaped
      // check a no-op — no separate reset needed for the candidate it was attributed to.
      observedCandidate: gatePromotionIdentity.observedCandidate,
      lastMainPin: gatePromotionIdentity.lastMainPin,
      retriageStaleTip,
      retriageDetail,
      // EI-19399662484764592: the re-triage verdict for EVERY classification, from the
      // append-only event rather than the stale-candidate-only gate_health pair above.
      // Candidate-matched against the verdict we are reporting, so it can never attribute a
      // different run's re-triage to this red.
      retriageVerdict: pickRetriageVerdict(
        recent,
        gatePromotionIdentity.observedCandidate,
      ),
      inFlightRetriage,
      inFlightCandidate,
      repairTickLegs,
      candidateAgeMs: gcCandidateAgeMs ?? null,
      commitsBehindTip: rawCommitsBehindTip,
      flakyWorkspaces: Object.entries(flakeHistory)
        .filter(([, v]) => (v?.flakes ?? 0) >= 3)
        .map(([ws]) => ws),
      // EI-19405864032365760: see the type's note — non-null means the counters above are stale
      // by construction. Shape-checked rather than cast: a blob predating this field, or one
      // written by a version that shaped it differently, must read as "no abort recorded" rather
      // than as a half-populated abort a consumer would render with empty fields.
      inconclusive: gateInconclusive,
      repairQueue,
      repairQueueRead,
      qualification,
      // P-004: shape-checked by the reader, never cast — a blob predating this field, or one
      // written by a version that shaped it differently, must read as "not measured" rather
      // than as a half-populated disposition a consumer would render as fact.
      freezeAndConverge,
      // P-004: same shape-checked discipline as the disposition above. The writer CLEARS
      // this to JSON null when a cycle retires, so an absent/null/unrecognized blob must
      // read as "not measured" rather than as a convergence summary with holes in it.
      convergence: parseFrozenRepairConvergence(gateHealth['convergence']),
      // P-013: same shape-checked discipline — an absent or wrong-typed blob reads as null.
      testPassReuse: parseTestPassReuseHealth(gateHealth['testPassReuse']),
      roundPhases: parseGateRoundPhases(gateHealth['roundPhases']),
    },
    openConflict,
    windows: { day, week },
    recent,
    deploy,
    activeRun,
    ...(opts.includeActiveRun ? { activeRunRoot: resolvedActiveRunRoot } : {}),
  };
}
