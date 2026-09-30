/**
 * The green-checkpoint run's OWN published answer to "which sha are you judging RIGHT NOW?".
 *
 * WHY THIS EXISTS — it is the same bug WI-4494 already fixed one level down, still open here.
 *
 * WI-4494 made the PRODUCER record its VERDICT, because everything else was
 * "reconciliation layers over a value that can be wrong". The owner's ruling on it
 * [owner 2026-07-11]: "this looks like just a bandaid, lets just make sure its right the
 * first time so that it doesn't need to get 're-verified' to begin with."
 *
 * That fixed the TERMINAL state. The IN-FLIGHT state was left exactly as it was: a run
 * publishes its candidate to stdout (`checkpointing candidate <sha>`) and nowhere else. For a
 * MANUAL run that stdout is redirected to /tmp and survives; a SCHEDULER-fired run writes no
 * such log at all, so on its first candidate it publishes its candidate NOWHERE. Until this
 * module, `gate_health.inFlightRetriage` was the only in-flight marker — and it only exists
 * once a REFIRE has happened, which is the uncommon case.
 *
 * So the commonest question asked of this gate ("is it judging my fix?") had no observation
 * behind it, only inference. Our own tooling says so out loud — checkpoint-run.ts's
 * `already_running` reply tells the caller the checkout-HEAD reading "is an INFERENCE about
 * which sha this run is judging, NOT an observation of it ... its candidate is genuinely
 * undetermined here". The documented fallbacks are all proxies that fail in DIFFERENT
 * directions, which is why careful readers reach contradictory conclusions from the same box:
 *
 *   - the checkpoint checkout's live HEAD   — moves between two reads; right only while pinned
 *   - `ls -t /tmp/...-manual-*.log`         — cron-blind, and happily returns an hours-old log
 *   - reconstructing the quiet-cut by hand  — arithmetic over mixed-offset git timestamps
 *   - comparing commit dates to started_at  — WRONG by construction: an in-process auto-refire
 *                                             advances the candidate while pid/started_at stay
 *                                             fixed, so "newer than started_at" is the healthy
 *                                             signature of a rescue, not corruption
 *
 * Measured cost of having only those: ~2h of fleet time and four contradictory conclusions on
 * 2026-08-02 (WI-7069's own header records the same archaeology, and the same day a verdict
 * that had already re-candidated was read as corrupt). This module removes the inference
 * instead of adding a fifth proxy to arbitrate between the other four.
 *
 * DIAGNOSTIC ONLY. Like `recordInFlightRetriage`, every write here is best-effort and swallows
 * its own errors: it rides alongside the real run and must never break or slow it.
 */
import { mergeGateHealth } from './gate-health-merge';
import type { GateVerdictTarget } from './gate-verdict-target';
import type { Sql } from 'postgres';
import {
  isCheckpointCandidateSource,
  type CheckpointCandidateSource,
} from './checkpoint-candidate-source';

/** Bounded by green-checkpoint.ts's `SELF_WATCHDOG_MS` (3h), matching
 *  {@link import('./in-flight-retriage').IN_FLIGHT_RETRIAGE_MAX_AGE_MS}: a run that hangs past
 *  that self-kills and writes a real verdict, so an older marker is an abandoned run's residue,
 *  never a genuinely long one. */
export const IN_FLIGHT_CANDIDATE_MAX_AGE_MS = 3 * 60 * 60_000;
/** Environment transport from the scheduled routine action into the checkpoint CLI. */
export const ROUTINE_FIRE_ROUTINE_ID_ENV = 'PAPERCUSP_ROUTINE_FIRE_ROUTINE_ID';
export const ROUTINE_FIRE_WORKFLOW_ID_ENV = 'PAPERCUSP_ROUTINE_FIRE_WORKFLOW_ID';

/** Read the scheduled routine identity as a pair; a partial transport is not safe to correlate. */
export function routineFireIdentityFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Pick<InFlightCandidateInfo, 'routineId' | 'routineFireWorkflowId'> {
  const routineId = env[ROUTINE_FIRE_ROUTINE_ID_ENV]?.trim();
  const routineFireWorkflowId = env[ROUTINE_FIRE_WORKFLOW_ID_ENV]?.trim();
  if (
    !routineId || routineId.length > 200 ||
    !routineFireWorkflowId || routineFireWorkflowId.length > 256
  ) {
    return {};
  }
  return { routineId, routineFireWorkflowId };
}

/** What a running green-checkpoint publishes about the candidate it is judging. */
export interface InFlightCandidateInfo {
  /** The sha being judged, full length. THE field this module exists to publish. */
  candidate: string;
  /** Provenance of the candidate this run is judging. */
  candidateSource: CheckpointCandidateSource;
  /** The green pin this candidate would advance from (`lastReady`), or null on a first run. */
  base: string | null;
  /** WI-7069's stamp: the instant the candidate became FINAL. Everything after it (setupTree,
   *  preflights, the ~40-55min suite) runs with the candidate PINNED, so `now - selectedAtMs`
   *  separates "the candidate was already old when chosen" from "age accumulated while judging"
   *  — the exact question that cost ~2h of hand-archaeology. */
  selectedAtMs: number;
  /** True when the 240s quiet cut stepped BACK from the tip. The single most misread thing about
   *  this gate: a fresh commit is deliberately NOT judged, so "my commit is missing" is usually
   *  the quiet cut working, not a fault. Publishing it kills the hand-reconstruction. */
  quietCutApplied: boolean;
  /** The tip at selection time — what `candidate` would have been without the quiet cut. Lets a
   *  reader see the excluded window directly instead of recomputing it from git timestamps. */
  tipAtSelection: string | null;
  /**
   * 0 for a run's first candidate; N for the Nth in-process auto-refire.
   *
   * This is what makes a MOVING candidate readable as healthy. A refire re-enters
   * `runGreenCheckpoint` recursively in the SAME process, so pid and started_at stay FIXED while
   * the candidate advances — the signature that has repeatedly been mistaken for a corrupt field.
   * A reader seeing `refireDepth > 0` knows the movement is a rescue in progress.
   */
  refireDepth: number;
  /** The OS pid of the run, so a reader can confirm the marker belongs to a process that is
   *  still alive rather than trusting the age bound alone. */
  pid: number;
  /** Scheduled routine row that launched this checkpoint; absent for manual/detached runs. */
  routineId?: string;
  /** Exact DBOS workflow_status.workflow_uuid for the scheduled routineFire. */
  routineFireWorkflowId?: string;
}

/** The persisted shape — {@link InFlightCandidateInfo} plus the write-time stamp a reader needs
 *  to judge freshness. */
export interface StoredInFlightCandidate extends InFlightCandidateInfo {
  observedAtMs: number;
  /**
   * EI-20427717764878875: the instant THIS run published its verdict for THIS candidate, or
   * `null` while it is genuinely still deciding.
   *
   * Deliberately on the STORED shape and not on {@link InFlightCandidateInfo}: the publisher
   * writes at candidate-FINAL time, when no verdict can exist yet, so a run never supplies this
   * — it is stamped later by {@link stampInFlightVerdictWritten}.
   *
   * WHY IT IS WORTH A FIELD. A green-checkpoint run does NOT exit when it decides: after writing
   * its verdict it continues into the longest-clean-prefix salvage, and the marker stays live
   * through that (`green-checkpoint.ts:11408` — "the in-flight marker is retired for every
   * terminal path at the outer CLI seam", which runs after the run returns). So the honest state
   * "decided 16 minutes ago, still salvaging" was indistinguishable from "68 minutes and still no
   * verdict", because `elapsedSec` measures the process, not the decision. Two agents spent ~1h on
   * 2026-08-14 reasoning about a settled run, and the natural response to an apparently-overdue
   * run is to fire `release:checkpoint-run` — the one action CLAUDE.md forbids, because it
   * discards an in-flight rescue and costs a full suite. The surface manufactured exactly the
   * impulse the docs then have to talk you out of.
   *
   * With this, elapsed-vs-verdict is COMPUTABLE instead of guessable: `null` means genuinely
   * undecided, a number means the deciding is over whatever the process is still doing.
   */
  verdictWrittenAtMs: number | null;
}

/**
 * Publish the candidate this run is judging into `gate_health.inFlightCandidate`.
 *
 * Called at candidate-FINAL time on EVERY invocation — including each recursive auto-refire, so
 * the field always names the sha actually under judgement rather than the one the run started
 * with. Best-effort: never throws.
 */
export async function recordInFlightCandidate(target: GateVerdictTarget, info: InFlightCandidateInfo): Promise<void> {
  // `verdictWrittenAtMs: null` is load-bearing on the REFIRE path, not just boilerplate for the
  // first publish. An auto-refire re-publishes over its own marker with a NEW candidate, and that
  // candidate has not been decided yet — so resetting to null is what stops a previous candidate's
  // verdict timestamp being read as if it belonged to the sha now under judgement.
  const stored: StoredInFlightCandidate = { ...info, observedAtMs: Date.now(), verdictWrittenAtMs: null };
  await mergeGateHealth(target, { inFlightCandidate: stored });
}

/**
 * Clear the marker once the run reaches a terminal verdict, so a completed run never looks live.
 *
 * Freshness alone cannot do this job: the 3h bound is deliberately generous (a real run can
 * legitimately take ~55min and refire twice), so without an explicit clear a finished run's
 * marker would read as in-flight for hours — the precise failure mode that makes a stale
 * `/tmp` log dangerous. Best-effort: never throws.
 */
export async function clearInFlightCandidate(target: GateVerdictTarget): Promise<void> {
  await mergeGateHealth(target, { inFlightCandidate: null });
}

/**
 * Clear a dead run's marker only while the exact marker we inspected is still current.
 *
 * The process-level watchdog can prove a checkpoint pid is gone at the same instant a
 * replacement run is publishing its own marker. A plain {@link clearInFlightCandidate}
 * after that race would erase the replacement and turn a healthy run back into an
 * unobservable one. Candidate + pid + observation time form the marker generation; the
 * conditional UPDATE makes losing the race a harmless `false` instead of a stale clear.
 *
 * Unlike the diagnostic writers above, callers need the boolean because it distinguishes
 * "retired the dead generation" from "a newer run already owns the field". Database
 * uncertainty therefore returns false (unknown), never a fabricated success.
 */
export async function clearInFlightCandidateIfUnchanged(
  target: GateVerdictTarget,
  expected: Pick<StoredInFlightCandidate, 'candidate' | 'pid' | 'observedAtMs'>,
): Promise<boolean> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const result = await sql.unsafe(
      `UPDATE harness_shared.routines
          SET metadata = jsonb_set(
                COALESCE(metadata, '{}'::jsonb),
                '{gate_health}',
                COALESCE(metadata->'gate_health', '{}'::jsonb) || '{"inFlightCandidate":null}'::jsonb,
                true
              ),
              updated_at = now()
        WHERE install_slug = $1
          AND workspace_id = $2
          AND target_role = 'system:green-checkpoint'
          AND metadata->'gate_health'->'inFlightCandidate'->>'candidate' = $3
          AND metadata->'gate_health'->'inFlightCandidate'->>'pid' = $4
          AND metadata->'gate_health'->'inFlightCandidate'->>'observedAtMs' = $5`,
      [
        target.installSlug,
        target.workspaceId,
        expected.candidate,
        String(expected.pid),
        String(expected.observedAtMs),
      ],
    );
    return result.count === 1;
  } catch {
    return false;
  }
}

/**
 * Stamp "I have published my verdict" onto this run's OWN live marker.
 *
 * WHY A CONDITIONAL UPDATE AND NOT A RE-PUBLISH. Re-publishing the whole marker through
 * {@link recordInFlightCandidate} would need the run to still hold its original info object, and
 * it would happily overwrite a REPLACEMENT run's marker in the same race
 * {@link clearInFlightCandidateIfUnchanged} exists to survive. Updating the single key under a
 * generation guard cannot clobber a stranger's marker, cannot resurrect a cleared one (the guard
 * simply matches nothing), and needs no read-modify-write two runs could interleave.
 *
 * The guard is candidate + pid — the marker generation minus `observedAtMs`, which deliberately
 * moves when a refire re-publishes. So this stamps the marker for THIS candidate from THIS
 * process and no other.
 *
 * FIRST WRITE WINS, via `->>'verdictWrittenAtMs' IS NULL`: the field records the instant the
 * verdict was published, so a retried or duplicated call must not move it later. (`->>` yields
 * SQL NULL for both an absent key and a JSON null, which is exactly the "not yet stamped" set.)
 *
 * Returns whether a marker was stamped. `false` is a legitimate, expected outcome — the marker
 * was already retired, a newer run owns the field, or it was stamped before — and never an error
 * to escalate. Best-effort like every write in this module: a diagnostic must never break or slow
 * the run it observes, so database uncertainty returns false rather than throwing.
 */
export async function stampInFlightVerdictWritten(
  target: GateVerdictTarget,
  stamp: { candidate: string; pid: number; verdictWrittenAtMs?: number },
): Promise<boolean> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const result = await sql.unsafe(
      `UPDATE harness_shared.routines
          SET metadata = jsonb_set(
                COALESCE(metadata, '{}'::jsonb),
                '{gate_health,inFlightCandidate,verdictWrittenAtMs}',
                to_jsonb($5::bigint),
                true
              ),
              updated_at = now()
        WHERE install_slug = $1
          AND workspace_id = $2
          AND target_role = 'system:green-checkpoint'
          AND metadata->'gate_health'->'inFlightCandidate'->>'candidate' = $3
          AND metadata->'gate_health'->'inFlightCandidate'->>'pid' = $4
          AND metadata->'gate_health'->'inFlightCandidate'->>'verdictWrittenAtMs' IS NULL`,
      [
        target.installSlug,
        target.workspaceId,
        stamp.candidate,
        String(stamp.pid),
        String(stamp.verdictWrittenAtMs ?? Date.now()),
      ],
    );
    return result.count === 1;
  } catch {
    return false;
  }
}

/**
 * PURE: interpret the raw `gate_health.inFlightCandidate` value. Returns null for anything not
 * trustworthy right now — missing, malformed, or older than
 * {@link IN_FLIGHT_CANDIDATE_MAX_AGE_MS}. Unit-testable without PG.
 *
 * ⚠ Like `parseInFlightRetriage`, this returns an EXPLICIT object literal, so a field added to
 * {@link InFlightCandidateInfo} is silently DROPPED unless it is also carried here. That exact
 * omission is what left `charged`/`totalRefires`/`absoluteCeiling` persisted-but-unread on the
 * sibling marker (EI-19343516395023183), so every consumer rendered a budget it could not see
 * the ceiling of. Add a field to the interface ⇒ add it here.
 */
export function parseInFlightCandidate(raw: unknown, nowMs: number = Date.now()): StoredInFlightCandidate | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const candidate = typeof r.candidate === 'string' && r.candidate ? r.candidate : null;
  const candidateSource =
    r.candidateSource === undefined
      ? ('tip' as const)
      : isCheckpointCandidateSource(r.candidateSource)
        ? r.candidateSource
        : null;
  const selectedAtMs = typeof r.selectedAtMs === 'number' ? r.selectedAtMs : null;
  const observedAtMs = typeof r.observedAtMs === 'number' ? r.observedAtMs : null;
  const routineId =
    typeof r.routineId === 'string' && r.routineId.trim() === r.routineId && r.routineId.length <= 200
      ? r.routineId
      : undefined;
  const routineFireWorkflowId =
    typeof r.routineFireWorkflowId === 'string' &&
    r.routineFireWorkflowId.trim() === r.routineFireWorkflowId &&
    r.routineFireWorkflowId.length <= 256
      ? r.routineFireWorkflowId
      : undefined;
  if (!candidate || !candidateSource || selectedAtMs == null || observedAtMs == null) return null;
  if (nowMs - observedAtMs > IN_FLIGHT_CANDIDATE_MAX_AGE_MS) return null; // abandoned — see doc above.
  return {
    candidate,
    candidateSource,
    base: typeof r.base === 'string' ? r.base : null,
    selectedAtMs,
    quietCutApplied: r.quietCutApplied === true,
    tipAtSelection: typeof r.tipAtSelection === 'string' ? r.tipAtSelection : null,
    refireDepth: typeof r.refireDepth === 'number' ? r.refireDepth : 0,
    pid: typeof r.pid === 'number' ? r.pid : 0,
    observedAtMs,
    ...(routineId ? { routineId } : {}),
    ...(routineFireWorkflowId ? { routineFireWorkflowId } : {}),
    // Carried per the ⚠ above: this literal is exhaustive, so omitting it here would persist the
    // stamp and never read it back — the precise shape of EI-19343516395023183.
    verdictWrittenAtMs: typeof r.verdictWrittenAtMs === 'number' ? r.verdictWrittenAtMs : null,
  };
}

/**
 * Human/agent-readable one-liner for a live marker — the sentence a reader would otherwise
 * assemble by hand from four proxies. Pure.
 */
export function describeInFlightCandidate(marker: StoredInFlightCandidate, nowMs: number = Date.now()): string {
  const age = Math.max(0, Math.round((nowMs - marker.selectedAtMs) / 1000));
  const refire = marker.refireDepth > 0 ? ` (auto-refire #${marker.refireDepth} — the candidate MOVED in-process, pid/started_at did not)` : '';
  const quiet =
    marker.quietCutApplied && marker.tipAtSelection
      ? ` — quiet cut stepped back from tip ${marker.tipAtSelection.slice(0, 8)}, so commits newer than this candidate are deliberately NOT judged`
      : '';
  const source = marker.candidateSource === 'pinned' ? 'pinned diagnostic' : marker.candidateSource;
  // EI-20427717764878875: say the DECISION state out loud. Without this the sentence describes a
  // decided run and an undecided one identically, and the reader's next move differs completely.
  const decided =
    marker.verdictWrittenAtMs != null
      ? ` — VERDICT ALREADY WRITTEN ${Math.max(0, Math.round((nowMs - marker.verdictWrittenAtMs) / 60_000))}m ago;` +
        ` the process is still alive (post-verdict salvage), so elapsed time is NOT time spent deciding.` +
        ` Do NOT fire a manual re-run: it would discard an in-flight rescue and cost a full suite`
      : '';
  return `judging ${marker.candidate.slice(0, 12)} (source=${source}), selected ${age}s ago${refire}${quiet}${decided}`;
}

/**
 * The READ twin. Scopes BOTH `install_slug` AND `workspace_id` — `harness_shared.routines` is
 * multi-tenant and an unscoped read returns some other harness's gate: well-formed, confident,
 * wrong (measured 2026-08-02, when `papercusp` was not even in the top five rows by
 * `last_fired_at`).
 */
export async function readInFlightCandidate(
  installSlug: string,
  workspaceId?: string,
): Promise<StoredInFlightCandidate | null> {
  try {
    const { getOrgPg } = await import('@papercusp/db-org');
    const { sql } = getOrgPg();
    const rows = workspaceId
      ? await sql.unsafe(
          `SELECT metadata->'gate_health'->'inFlightCandidate' AS marker
             FROM harness_shared.routines
            WHERE install_slug = $1 AND workspace_id = $2 AND target_role = 'system:green-checkpoint'
            LIMIT 1`,
          [installSlug, workspaceId],
        )
      : await sql.unsafe(
          `SELECT metadata->'gate_health'->'inFlightCandidate' AS marker
             FROM harness_shared.routines
            WHERE install_slug = $1 AND target_role = 'system:green-checkpoint'
            LIMIT 1`,
          [installSlug],
        );
    return parseInFlightCandidate((rows as Array<{ marker?: unknown }>)[0]?.marker ?? null);
  } catch {
    return null; // best-effort diagnostic read — never surface an infra error as a gate fact
  }
}

/**
 * ── THE LOSS THIS MODULE COULD ALWAYS SEE AND NEVER REPORTED ──────────────────────────────
 *
 * `pid` above has always carried the comment "so a reader can confirm the marker belongs to a
 * process that is still alive rather than trusting the age bound alone". NO consumer ever did:
 * {@link parseInFlightCandidate} copies it through and tests only the 3h age bound. A comment
 * describing a safeguard is not the safeguard.
 *
 * What that cost, measured 2026-08-17 (agent-insights/green-checkpoint-refire-lost-to-bg-host-restart):
 * a not-green verdict at 22:39:56.909Z spawned an auto-refire onto f16fa1c7030d (refireDepth 1,
 * pid 763041) which published its marker at 22:39:59.590Z and then produced NOTHING — no verdict,
 * no checkpoint log, no `routines.last_error`. The bg-host was stopped and restarted at 22:48:14Z
 * (`NRestarts=0` — external, not a crash-loop) about 8 minutes in. A refire re-enters
 * `runGreenCheckpoint` RECURSIVELY IN THE SAME PROCESS, so it dies with its bg-host generation and
 * no code path records that it ever existed. The marker then sat naming a dead pid for the rest of
 * its 3h window, and a peer agent claimed the gate work-item to "check the f16fa1c7 rescue-run
 * verdict" — a verdict that was never going to come.
 *
 * Two readings of an uncleared marker are indistinguishable without this: "a run is judging that
 * sha right now" and "a run died judging that sha and nobody noticed". The first is the healthy
 * common case, so an unaided reader defaults to it and waits.
 *
 * ⚠ THIS DOES NOT PREVENT THE LOSS — it makes it LOUD. Giving a refire a lifetime independent of
 * the bg-host generation is the real fix and is design work; guarding the restart against the
 * run-lock is the middle option. Detection is the cheapest of the three and the only one that also
 * covers losses from causes nobody has enumerated yet.
 */

/** Why a pre-existing marker is (or is not) an abandoned run's residue. */
export type AbandonedInFlightVerdict =
  | { abandoned: false; reason: 'no-marker' | 'own-run' | 'pid-alive' | 'pid-unknown' }
  | {
      abandoned: true;
      /** `dead-pid` — the OS has no such process. `predates-host-generation` — the marker was
       *  written before the CURRENT host process started, so whatever wrote it cannot still be
       *  running regardless of what the pid now resolves to. */
      reason: 'dead-pid' | 'predates-host-generation';
      marker: StoredInFlightCandidate;
      /** How long the lost run's marker had been sitting unclaimed when we caught it. */
      ageMs: number;
    };

/**
 * PURE: judge whether a pre-existing marker belongs to a run that is GONE.
 *
 * Check ORDER is load-bearing, and the two subtleties are the whole reason this is a separate
 * function rather than an `if` at the call site:
 *
 * 1. `own-run` FIRST. An in-process auto-refire re-enters `runGreenCheckpoint` recursively and
 *    re-publishes over its OWN marker with the same pid. Judged by liveness alone that marker is
 *    perfectly alive — but judged as a stranger's it would be reported as a loss on every single
 *    refire, which is the healthy case. A detector that cries wolf on the rescue path would be
 *    turned off within a day.
 *
 * 2. `predates-host-generation` BEFORE `dead-pid`. PID wrap happens roughly daily on this box
 *    under fleet load (the repo guide warns about exactly this for `processes:kill`), so a dead
 *    run's pid can be REUSED by an unrelated process and read back as alive. The generation stamp
 *    does not care what the pid now resolves to, so when a caller can supply it, it is the
 *    stronger evidence and must not be masked by a false `pid-alive`.
 *
 * `pidAlive: null` (unknown — the probe could not tell) deliberately yields NOT-abandoned: this
 * writes a loud durable record, and an instrument that cannot see must never manufacture a loss.
 * That is the same discipline as the absence-claim rule in the repo guide — a failed probe reads
 * identically to a clean result unless you refuse to interpret it.
 */
export function judgeAbandonedInFlightCandidate(
  marker: StoredInFlightCandidate | null,
  probe: {
    /** The pid of the process doing the judging — its OWN marker is never a loss. */
    selfPid: number;
    /** Result of {@link isPidAlive} for `marker.pid`; `null` = could not determine. */
    pidAlive: boolean | null;
    /** Start of the current host process generation, if the caller can observe it. */
    hostStartedAtMs?: number | null;
    nowMs?: number;
  },
): AbandonedInFlightVerdict {
  if (!marker) return { abandoned: false, reason: 'no-marker' };
  if (marker.pid === probe.selfPid) return { abandoned: false, reason: 'own-run' };
  const nowMs = probe.nowMs ?? Date.now();
  const ageMs = Math.max(0, nowMs - marker.observedAtMs);
  if (probe.hostStartedAtMs != null && marker.observedAtMs < probe.hostStartedAtMs) {
    return { abandoned: true, reason: 'predates-host-generation', marker, ageMs };
  }
  if (probe.pidAlive === false) return { abandoned: true, reason: 'dead-pid', marker, ageMs };
  if (probe.pidAlive === null) return { abandoned: false, reason: 'pid-unknown' };
  return { abandoned: false, reason: 'pid-alive' };
}

/**
 * Does this pid exist? `true` / `false` / `null` when genuinely undeterminable.
 *
 * `process.kill(pid, 0)` sends no signal — it is the standard existence probe. EPERM means the
 * process EXISTS but belongs to another user, which is ALIVE, not absent; conflating the two would
 * report every cross-user run as lost. Note this cannot distinguish a reused pid from the original
 * process, which is why {@link judgeAbandonedInFlightCandidate} prefers the generation stamp.
 */
export function isPidAlive(pid: number): boolean | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return null;
  }
}

/** Pure: the loud one-liner for a detected loss. Says what died, what it was judging, and — the
 *  part that actually saves a reader's hour — that no verdict is coming for that sha. */
export function describeAbandonedInFlightCandidate(verdict: AbandonedInFlightVerdict): string | null {
  if (!verdict.abandoned) return null;
  const { marker, ageMs, reason } = verdict;
  const mins = Math.round(ageMs / 60_000);
  const why =
    reason === 'dead-pid'
      ? `its pid ${marker.pid} no longer exists`
      : `it was published before the current host generation started (pid ${marker.pid})`;
  const refire =
    marker.refireDepth > 0
      ? ` It was auto-refire #${marker.refireDepth}, which runs RECURSIVELY IN THE SAME PROCESS and therefore dies with its host generation.`
      : '';
  return (
    `LOST GATE RUN — the previous run judging ${marker.candidate.slice(0, 12)} never reached a verdict: ${why}, ` +
    `and its marker sat uncleared for ${mins}m.${refire} NO VERDICT IS COMING FOR ${marker.candidate.slice(0, 12)} — ` +
    `do not wait on one, and do not read its absence as "still running". (reason=${reason})`
  );
}

/**
 * Persist the detected loss into `gate_health.lastLostRun` so it outlives this run's log.
 *
 * Deliberately a single field written through {@link mergeGateHealth}, not an appended history:
 * that helper is THE one write path for this blob by design, and an append would need a
 * read-modify-write that two concurrent runs could interleave. Recurrence is already recoverable
 * from `pipeline_events` and the checkpoint logs; what was missing was any durable record AT ALL.
 * Best-effort, like every other write in this module.
 */
export async function recordLostGateRun(
  target: GateVerdictTarget,
  verdict: Extract<AbandonedInFlightVerdict, { abandoned: true }>,
  detectedByPid: number = process.pid,
  transaction?: Pick<Sql, 'unsafe'>,
): Promise<void> {
  await mergeGateHealth(target, {
    lastLostRun: {
      candidate: verdict.marker.candidate,
      base: verdict.marker.base,
      pid: verdict.marker.pid,
      refireDepth: verdict.marker.refireDepth,
      observedAtMs: verdict.marker.observedAtMs,
      selectedAtMs: verdict.marker.selectedAtMs,
      ...(verdict.marker.routineId ? { routineId: verdict.marker.routineId } : {}),
      ...(verdict.marker.routineFireWorkflowId
        ? { routineFireWorkflowId: verdict.marker.routineFireWorkflowId }
        : {}),
      detectedAtMs: Date.now(),
      detectedByPid,
      reason: verdict.reason,
      ageMs: verdict.ageMs,
      note: describeAbandonedInFlightCandidate(verdict),
    },
  }, transaction, Boolean(transaction));
}
