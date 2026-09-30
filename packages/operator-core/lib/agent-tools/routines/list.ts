/**
 * routines:list — read the scheduled system routines (live-configurability-audit P-002).
 *
 * The git-sync / green-checkpoint / release-trigger / improvement-watchdog (…) rows live in
 * harness_shared.routines; today the only way to see their cadence/active state is raw SQL. This
 * is the read half (the write half is routines:set).
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../../harness/operator-home-harness';
import { statePlaneForDoor } from '../state-plane-door';
import { formatIdleAge } from '../../format/relative-time';
// Pure, import-free module (see its header) — safe to pull into a tool without dragging the
// validator's pg/system-action-registry dependencies along.
import { ROUTINE_VALIDATION_METADATA_KEY } from '../../startup/routine-validation-episode';
import { WATCHDOG_HEALTH_METADATA_KEY } from '../../release/watchdog-health';
import { parseInFlightCandidate } from '../../release/in-flight-candidate';
import { isAdmissionSyntheticCommitDate } from '../../release/admission-commit-date';
import { gateAbortVintage } from '../../release/gate-abort-status';
import { computeNextFireAt } from '../../harness/routines/cron';
import { effectivePauseExpiryMs, readRoutinePause } from '../../harness/routines/release-pause-ttl';

const GIT_SYNC_FRESHNESS_INTERVALS = 3;

/**
 * The DELIBERATE-PAUSE record, read back out of `routines.metadata.pause`.
 *
 * EI-19336000265007219. `routines:set` has recorded { reason, pausedBy, pausedAtMs }
 * on every pause since EI-18654017982759582 — which existed precisely because "a
 * routine paused during an incident with no reason/owner recorded has TWICE stayed
 * silently paused for days ... nothing durable said WHO paused it or WHY, so a
 * responder could not tell a stuck bug from a deliberate hold".
 *
 * The write side landed. The READ side never did: this tool selected `active` and not
 * `metadata`, so the responder the record was written FOR still saw a bare
 * `active:false` — indistinguishable from a stall. It happened a third time
 * (improvement-implement, paused 2026-07-28T03:40Z via the Agents pane, noticed 5 days
 * later and filed as a suspected stall by an agent who correctly hedged "may be an
 * intentional pause ... not obviously documented anywhere I found"). The answer was
 * sitting in the same ROW they had queried, one column over.
 *
 * A durable record nobody can read is not a fix — it is the same silence with better
 * bookkeeping. Hence: surfaced here, and in the TRIMMED projection, which is what an
 * agent sees by default.
 */
function pauseOf(
  metadata: Record<string, unknown> | null,
  groupSlug: string | null = null,
): {
  reason: string | null;
  by: string | null;
  at: string | null;
  autoResumesAt: string | null;
  finite: boolean;
} | null {
  const p = metadata?.pause;
  if (!p || typeof p !== 'object') return null;
  const rec = p as Record<string, unknown>;
  const atMs = typeof rec.pausedAtMs === 'number' ? rec.pausedAtMs : null;
  // P-004 (gate-verdict-liveness-and-repair-reliability-2026-08-31): a deliberate
  // hold now has an END, and this is the read side of it. `finite:false` is the
  // loud case — nothing will re-arm the routine — and it is deliberately a
  // separate field from a null timestamp so a reader cannot mistake "no
  // auto-resume scheduled" for "the deadline is unknown".
  const parsed = readRoutinePause(p);
  const expiresAtMs = effectivePauseExpiryMs(parsed, { groupSlug });
  return {
    reason: typeof rec.reason === 'string' ? rec.reason : null,
    by: typeof rec.pausedBy === 'string' ? rec.pausedBy : null,
    at: atMs !== null && Number.isFinite(atMs) ? new Date(atMs).toISOString() : null,
    autoResumesAt: expiresAtMs !== null ? new Date(expiresAtMs).toISOString() : null,
    finite: expiresAtMs !== null,
  };
}

/**
 * The OPERATIONAL half of `routines.metadata` — read back out for the same
 * reason {@link pauseOf} exists, one field family over
 * (plan `sql-escape-tool-routing-2026-08-12`, P-002).
 *
 * ⚠ THIS IS THE THIRD TIME. Read {@link pauseOf}'s comment first: it was
 * written because this tool SELECTed `metadata` and projected none of it, so a
 * responder saw a bare `active:false` and could not tell a deliberate hold from
 * a stall — "a durable record nobody can read is not a fix". That fix surfaced
 * `metadata.pause` and stopped there, and `metadata.gate_health` then reproduced
 * the identical failure at scale.
 *
 * Measured 2026-08-12 (`harness_shared.tool_invocations`, 14d, workspace
 * `papercusp-workspace`): 112 distinct agents hand-wrote
 * `SELECT metadata->'gate_health'…FROM harness_shared.routines` — 722 calls,
 * the single largest cross-agent raw-SQL cluster in the whole audit. Every one
 * of them was querying a row THIS TOOL ALREADY FETCHES. Several variants guess
 * at the column name (`next_fire_at` / `next_run_at` / `next_due_at`), which is
 * what reverse-engineering a schema looks like from the outside.
 *
 * So this projects the family, not one more single field — a per-field fix here
 * is what guarantees a fourth instance. `gate_health` is the load-bearing one
 * (green-checkpoint's live verdict: in-flight retriage, observed candidate,
 * consecutive reds); the rest are the generic routine-health signals every
 * `routines` row can carry.
 *
 * EI-22499535458977879 — THE FIFTH INSTANCE, and the one that finally settles the
 * shape. The header above predicted a fourth and got it; appending a fifth literal
 * would predict a sixth. The measurement that ends the cycle: of the 121 distinct
 * metadata keys live on `harness_shared.routines`, exactly six are per-subsystem
 * health blobs, and every one of them is named `<subsystem>_health` or the bare
 * `health` — while NO non-health key among the other 115 matches that suffix. The
 * writers were already following a convention; only this reader was not. Four of
 * the six were being dropped on the floor (`gitnexus_health`,
 * `project_history_health`, `intake_health`, `health`), each one a subsystem that
 * records its own failure streak and then reads `health: null` to every agent —
 * the same "durable record nobody can read" failure, four times over, found only
 * because a grader happened to notice ONE of them.
 *
 * So health-record keys are now DERIVED from that convention
 * ({@link isHealthRecordKey}) rather than transcribed, which is the derived-truth
 * ladder's first rung: a new `<subsystem>_health` writer is projected the day it
 * ships, with no edit here and no sixth instance. The explicit list below stays for
 * the keys that do NOT follow the convention (`validation`, and the generic
 * per-row scalars), and keeps `gate_health`/`watchdog_health` pinned to their
 * imported constants so a writer-side rename still cannot drift past the reader.
 *
 * Returns null when the row carries none of them, so an ordinary routine's
 * payload is unchanged and the field stays cheap on the trimmed projection.
 * Measured when this landed: the four newly-projected blobs are 129–470 chars,
 * against the 6,755-char `gate_health` this already carried.
 */
function epochMs(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric >= 0) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isoAt(value: number | null): string | null {
  if (value === null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function sameCandidate(a: string, b: string): boolean {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  return left.length > 0 && right.length > 0 && (left === right || left.startsWith(right) || right.startsWith(left));
}

/**
 * Add read-time provenance to the cached gate verdict without pretending that the
 * current checkout is the candidate the gate judged. The writer already persists
 * these fields, but the raw metadata blob leaves a reader to subtract epoch-ms values
 * by hand and offers no visible age beside `failingTests`.
 *
 * Pure and injectable for a deterministic regression test. Unknown or malformed
 * gate-health values pass through unchanged: an attestation must never erase the
 * underlying evidence it failed to understand.
 */
export function attestGateHealth(value: unknown, nowMs: number = Date.now()): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const gateHealth = value as Record<string, unknown>;
  const observedAtMs = epochMs(gateHealth.observedAt);
  // A repair-queue admission commit carries a fixed sentinel date, so a `repairHead` blob reports
  // `2000-01-01` — a constant, not a measurement. Attesting an age derived from it would publish
  // a ~26.7-year candidate age for a commit made minutes ago (WI-10002121). Unavailable, not wrong.
  const candidateCommittedAtMs = isAdmissionSyntheticCommitDate(
    gateHealth.candidateCommittedAt as string | number | null | undefined,
  )
    ? null
    : epochMs(gateHealth.candidateCommittedAt);
  const snapshotAgeMs = observedAtMs === null ? null : Math.max(0, nowMs - observedAtMs);
  const candidateAgeAtObservationMs =
    observedAtMs !== null && candidateCommittedAtMs !== null && observedAtMs >= candidateCommittedAtMs
      ? observedAtMs - candidateCommittedAtMs
      : null;
  const commitsBehindTip =
    typeof gateHealth.commitsBehindTip === 'number' && Number.isFinite(gateHealth.commitsBehindTip)
      ? gateHealth.commitsBehindTip
      : null;
  const observedCandidate =
    typeof gateHealth.observedCandidate === 'string' && gateHealth.observedCandidate.trim()
      ? gateHealth.observedCandidate
      : null;
  const inFlightCandidate = parseInFlightCandidate(gateHealth.inFlightCandidate, nowMs)?.candidate ?? null;
  const hasFailingTests =
    Array.isArray(gateHealth.failingTests) && gateHealth.failingTests.some((test) => typeof test === 'string' && test.length > 0);
  const failingTestsStaleAgainstInFlight = !hasFailingTests
    ? false
    : observedCandidate && inFlightCandidate
      ? !sameCandidate(observedCandidate, inFlightCandidate)
      : null;

  // WI-1752145: the abort record's OWN vintage. `readAttestation.snapshotAgeMs` below is
  // derived from the top-level `observedAt`, which an aborting tick does NOT advance (it
  // writes `inconclusive` through a scoped jsonb_set on purpose), so that age describes the
  // VERDICT and never the abort sitting beside it — measured drift between the two on live
  // rows: +4s to +5.7 DAYS. `inconclusive.status` is the field a reader acts on, and until
  // now the only vintage for it was a raw epoch-ms buried in the same block.
  const inconclusiveBlock =
    gateHealth.inconclusive && typeof gateHealth.inconclusive === 'object' && !Array.isArray(gateHealth.inconclusive)
      ? (gateHealth.inconclusive as Record<string, unknown>)
      : null;
  const inconclusiveStatus =
    inconclusiveBlock && typeof inconclusiveBlock.status === 'string' ? inconclusiveBlock.status : null;
  const abortVintage =
    inconclusiveStatus === null
      ? null
      : gateAbortVintage({
          status: inconclusiveStatus,
          observedAtMs: epochMs(inconclusiveBlock?.observedAtMs),
          nowMs,
        });
  const inconclusiveAttestation =
    inconclusiveStatus === null || abortVintage === null
      ? null
      : {
          status: inconclusiveStatus,
          observedAt: isoAt(abortVintage.observedAtMs),
          ageMs: abortVintage.ageMs,
          age: abortVintage.age === null ? null : `${abortVintage.age} ago`,
          stale: abortVintage.stale,
          warning: abortVintage.warning,
        };

  return {
    ...gateHealth,
    // WI-1752145: candidate-bound provenance's sibling for the ABORT record — same shape, same
    // reason. Null when there is no abort to describe; a FRESH abort keeps `warning: null` so a
    // disclosure that fires on every read never trains a reader to skip it, and `stale: null`
    // (blob predating the stamp) is reported as unknown rather than as a clean `false`.
    inconclusiveAttestation,
    // EI-21546055972045422: `failingTests` belongs to the last TERMINAL verdict, while
    // `inFlightCandidate` names the run executing RIGHT NOW. Returning the array without this
    // candidate-bound sibling made a prior verdict read as the active run's failures whenever
    // those candidates differed. Keep the raw array for compatibility, but make the mismatch
    // explicit and adjacent so a reader never has to infer it from two unrelated fields.
    failingTestsAttestation: {
      candidate: observedCandidate,
      inFlightCandidate,
      staleAgainstInFlight: failingTestsStaleAgainstInFlight,
      warning:
        failingTestsStaleAgainstInFlight === true
          ? `These failingTests describe terminal verdict ${observedCandidate}, not the active run ${inFlightCandidate}; do not triage them as current-run failures.`
          : null,
    },
    readAttestation: {
      // `snapshotAge` is deliberately alongside the cached failing-test list, so a
      // reader cannot mistake an old red for a current one without seeing its age.
      snapshotObservedAt: isoAt(observedAtMs),
      snapshotAgeMs,
      snapshotAge: snapshotAgeMs === null ? null : `${formatIdleAge(snapshotAgeMs / 1000)} ago`,
      observedCandidate,
      candidateCommittedAt: isoAt(candidateCommittedAtMs),
      candidateAgeAtObservationMs,
      commitsBehindTip,
    },
  };
}

/**
 * The naming convention every per-subsystem health writer on `harness_shared.routines`
 * already follows: `<subsystem>_health`, or the bare `health`.
 *
 * This is deliberately a CONVENTION test and not a second allowlist — the whole point of
 * EI-22499535458977879 is that a reader which enumerates writers goes stale the moment a
 * writer ships. Verified against the live population when it landed: it selects all six
 * health blobs (`gate_health`, `watchdog_health`, `gitnexus_health`,
 * `project_history_health`, `intake_health`, `health`) and none of the other 115 keys, so
 * it is neither under- nor over-inclusive on real data. The bare `health` case is included
 * because a routine that owns the whole row uses it (the admission canary); `_health` alone
 * is rejected as a degenerate name with no subsystem.
 *
 * Exported for the guard test, which asserts an INVENTED `<subsystem>_health` key is
 * projected with no edit here — the property that makes a sixth instance impossible.
 */
export function isHealthRecordKey(key: string): boolean {
  return key === 'health' || (key.endsWith('_health') && key.length > '_health'.length);
}

function healthOf(metadata: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!metadata) return null;
  const OPERATIONAL_KEYS = [
    'gate_health',
    // EI-20747395137280903 — THE FOURTH INSTANCE this header predicted. `metadata.validation`
    // carries the routine-validation episode marks, and `unregistered-system-action` is the
    // one that matters: an ACTIVE routine whose `system:` handler is registered NOWHERE fires
    // on schedule and does NOTHING, forever. Its detector has always worked and always written
    // this key; it just had no reader, so the only witness was a console.error in journalctl.
    // Measured when this was added: 4 routines live in that state (consult-expiry-sweep 97
    // skipped fires, idle-backend-reaper 54, project-history-refresh 34, coverage-census 25) —
    // every one reporting active:true with nextFireAt advancing. Imported, not re-typed, so
    // the projection cannot drift from the writer (see the constant's own comment).
    ROUTINE_VALIDATION_METADATA_KEY,
    // EI-21297913810967409 — the same shape as the key above, one subsystem over. The five
    // release watchdogs (green-stall, stranded-pause, main-behind-staging, and both
    // release-trigger guards) each swallow their own failure as a `console.warn (non-fatal)`,
    // so a guard that CANNOT RUN and a guard that ran and found nothing are indistinguishable
    // from outside — both are silence. One had been dead for as long as it had existed
    // (a nonexistent column; EI-21291109975568717) with no witness but a console line.
    // Each pass now records { lastError, lastErrorAt, consecutiveFailures } on the routine row
    // it WATCHES and clears it on the next clean pass, so a broken watcher surfaces in the tool
    // an agent already reaches for. Imported, not re-typed, so reader and writer cannot drift.
    WATCHDOG_HEALTH_METADATA_KEY,
    'last_status',
    'last_error',
    'last_errors',
    'consecutive_error_ticks',
    'consecutive_content_error_ticks',
    'fire_count',
    'armed_at',
    'fire_started_at',
    'last_synced_at',
    // `git-sync:run` timeout continuations use this reader to inspect the
    // writer-backed commit head without reaching into routine metadata directly.
    'head_sha',
    // EI-21049559233457671: git-sync writes this while its local stage and
    // bridged/P2P post-legs are active. `last_status: synced` is local-stage
    // evidence only until this marker reaches { active:false, phase:'complete' }.
    'git_sync_activity',
  ] as const;
  const out: Record<string, unknown> = {};
  const emit = (k: string): void => {
    const value = metadata[k];
    if (value === undefined || value === null) return;
    out[k] = k === 'gate_health' ? attestGateHealth(value) : value;
  };
  // The explicit keys first, in declaration order, so `gate_health` keeps its position at
  // the head of the projection and this change is a pure ADDITION for every existing row.
  for (const k of OPERATIONAL_KEYS) emit(k);
  // Then anything the writers named by the health convention that the list above did not
  // already cover. Sorted so the payload is deterministic regardless of jsonb key order.
  for (const k of Object.keys(metadata).sort()) {
    if (!(k in out) && isHealthRecordKey(k)) emit(k);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Derive git-sync health from the age of the last completed local-sync outcome.
 *
 * A scheduled fire can legitimately return `skipped` before `recordOutcome` runs
 * (for example while the exclusive git-sync resource is held). Those skips still
 * advance `last_fired_at`, but they deliberately do not overwrite the last real
 * outcome. Consequently `last_status:'synced'` can remain green for hours while no
 * synchronization has completed. `last_synced_at` is the writer-backed timestamp
 * that distinguishes those states: every completed outcome, including `nothing`,
 * refreshes it; a pre-outcome skip does not.
 *
 * Keep this a read-time derivation rather than another mutable counter. That makes
 * every new skip reason subject to the same detector and avoids a second writer
 * whose state can drift from the underlying proof.
 */
export function deriveGitSyncFreshness(
  metadata: Record<string, unknown> | null,
  cron: string | null,
  active: boolean,
  nowMs: number = Date.now(),
): Record<string, unknown> {
  const lastSyncedAtMs = epochMs(metadata?.last_synced_at);
  const first = cron ? computeNextFireAt(cron, new Date(nowMs)) : null;
  const second = first ? computeNextFireAt(cron!, new Date(first.getTime())) : null;
  const cadenceMs = first && second ? second.getTime() - first.getTime() : null;
  const staleAfterMs = cadenceMs && cadenceMs > 0 ? cadenceMs * GIT_SYNC_FRESHNESS_INTERVALS : null;
  const ageMs = lastSyncedAtMs === null ? null : Math.max(0, nowMs - lastSyncedAtMs);

  // EI-21807573331912223 — the IN-FLIGHT leg, which the completed-outcome clock above
  // cannot see. `last_synced_at` only moves when a fire COMPLETES, so one fire wedged
  // mid-run freezes it exactly like a run of skipped ticks does, and the age test alone
  // reports the two as the same 'degraded'. They are not the same incident and they do
  // not have the same remedy: skipped ticks mean the lock is held elsewhere or the
  // engine is not firing, while a wedged fire means there is a live process to look at
  // right now. Measured 2026-08-29: ONE fire held the git-sync lock from 16:24:33Z to
  // 16:58:24Z (~34 min against a 63-second healthy baseline); every scheduled tick in
  // that window skipped, 19 paths of finished work sat uncommitted, and the only field
  // naming the actual fault — a fire that started half an hour ago and has not returned
  // — was an epoch integer inside `git_sync_activity` that every reader had to subtract
  // by hand. Decompose it here, once, rather than in each reader.
  const activityRaw = metadata?.git_sync_activity;
  const activity =
    activityRaw && typeof activityRaw === 'object' ? (activityRaw as Record<string, unknown>) : null;
  const inFlightActive = activity?.active === true;
  const inFlightStartedAtMs = inFlightActive ? epochMs(activity?.started_at) : null;
  const inFlightAgeMs = inFlightStartedAtMs === null ? null : Math.max(0, nowMs - inFlightStartedAtMs);
  // The writer heartbeats `updated_at` from the liveness guard's onProgress callback.
  // Prefer the explicit last_progress_at field when a newer writer provides it, then
  // use the existing updated_at heartbeat, and finally fall back to started_at for
  // legacy markers that predate progress heartbeats. The total run age remains separate
  // so a long-running but healthy fire is observable without being called stuck.
  const inFlightLastProgressAtMs = inFlightActive
    ? epochMs(activity?.last_progress_at ?? activity?.updated_at ?? activity?.started_at)
    : null;
  const inFlightProgressAgeMs =
    inFlightLastProgressAtMs === null ? null : Math.max(0, nowMs - inFlightLastProgressAtMs);
  // Deliberately the SAME threshold as the completed-outcome clock: a fire still running
  // after the window in which three ticks should have completed is over budget by the
  // only yardstick this routine has, and inventing a second constant would let the two
  // halves of one verdict drift apart.
  const inFlightStuck =
    inFlightProgressAgeMs !== null && staleAfterMs !== null && inFlightProgressAgeMs > staleAfterMs;
  const inFlightPhase = typeof activity?.phase === 'string' ? activity.phase : null;

  const status = !active
    ? 'inactive'
    : // A wedged fire is degraded on its own evidence, including in the window where the
      // last COMPLETED outcome is still recent enough to read fresh. Widening the existing
      // verdict rather than adding a fourth enum value keeps every reader that already
      // branches on 'degraded' correct for this case without being rewritten.
      inFlightStuck
      ? 'degraded'
      : ageMs === null || staleAfterMs === null
        ? 'unknown'
        : ageMs > staleAfterMs
          ? 'degraded'
          : 'fresh';

  // WI-10002019 — the COMPOSITION defect, and the reason the two legs below exist.
  // `status` above answers "is this routine healthy?" and deliberately reads
  // 'degraded' for two incidents whose remedies are OPPOSITE: a scheduler that is
  // not firing (restarting the operator is harmless, and is often the fix) and a
  // fire that is LIVE right now (restarting destroys its in-flight work and drops
  // the exclusive git-sync lock mid-write). The dangerous overlap is not
  // hypothetical — it is the 2026-08-29 incident recorded above: a long fire
  // freezes `last_synced_at`, so the SCHEDULER leg reads stale precisely BECAUSE
  // the EXECUTION leg is busy, and the single scalar then indicates exactly the
  // action that causes the damage. Decompose the verdict and answer the
  // destructive question directly rather than leaving every reader to infer it.
  const executionStatus: 'idle' | 'in-flight' | 'stuck' | 'unknown' =
    activity === null ? 'unknown' : !inFlightActive ? 'idle' : inFlightStuck ? 'stuck' : 'in-flight';

  const schedulerStatus: 'firing' | 'not-firing' | 'inactive' | 'unknown' = !active
    ? 'inactive'
    : ageMs === null || staleAfterMs === null
      ? 'unknown'
      : ageMs > staleAfterMs
        ? 'not-firing'
        : 'firing';

  const executionLive = executionStatus === 'in-flight' || executionStatus === 'stuck';

  // The whole point of splitting the legs: say out loud when the scheduler leg's
  // staleness is EXPLAINED by a live fire rather than by a stalled engine.
  const stalledBehindInFlightFire = schedulerStatus === 'not-firing' && executionLive;

  // Locks are reported only if a writer names them; `[]` must never be readable as
  // "holds no locks" when nobody measured. Deliberately NOT inferred from
  // `active:true` — the lock a fire holds is a fact a writer owns, not one this
  // read-time derivation may assert on its behalf.
  const locksRaw = Array.isArray(activity?.locks) ? (activity.locks as unknown[]) : null;
  const holdsExclusiveLocks = locksRaw
    ? locksRaw.filter((entry): entry is string => typeof entry === 'string')
    : [];

  // HARD INVARIANT (WI-10002019): a live fire makes a restart destructive HOWEVER
  // stale the scheduler leg looks, so this is derived from the execution leg ALONE
  // and never from `status` or the scheduler leg. 'unknown' is deliberately unsafe:
  // a false "safe" destroys a peer's in-flight work irrecoverably, while a false
  // "unsafe" only declines a restart. The asymmetry decides the default.
  const safeToRestart = executionStatus === 'idle';

  // Computed once and shared by the roll-up and the scheduler leg, so the two can
  // never drift into disagreeing about the same quantity.
  const missedIntervals =
    ageMs !== null && cadenceMs && cadenceMs > 0 ? Math.floor(ageMs / cadenceMs) : null;

  const mins = (ms: number | null): string => (ms === null ? 'an unknown duration' : `${Math.round(ms / 60_000)}m`);

  const safeToRestartReason =
    executionStatus === 'idle'
      ? 'No git-sync fire is in flight (the activity marker reports active:false), so a restart cannot interrupt one.'
      : executionStatus === 'unknown'
        ? 'This row carries no git_sync_activity marker, so whether a fire is in flight is UNMEASURED — reported unsafe by default, because a wrong "safe" destroys in-flight work irrecoverably while a wrong "unsafe" only declines a restart.'
        : executionStatus === 'stuck'
          ? `A git-sync fire has been in flight for ${mins(inFlightAgeMs)} with no recorded progress for ${mins(inFlightProgressAgeMs)}. There is a LIVE process holding the exclusive git-sync lock — inspect it (processes:list) rather than restarting blind; a restart drops that lock mid-write.`
          : `A git-sync fire has been in flight for ${mins(inFlightAgeMs)} and is still recording progress. Restarting would drop the exclusive git-sync lock mid-write and destroy its uncommitted work.`;

  return {
    status,
    measured_at: isoAt(nowMs),
    last_synced_at: isoAt(lastSyncedAtMs),
    age_ms: ageMs,
    cadence_ms: cadenceMs,
    stale_after_ms: staleAfterMs,
    missed_intervals: missedIntervals,
    raw_last_status: typeof metadata?.last_status === 'string' ? metadata.last_status : null,
    // WI-10002019 — the two INDEPENDENT legs that `status` composes, plus the direct
    // answer to the one question whose wrong answer is destructive. Read
    // `safe_to_restart`, never `status`, before restarting or killing git-sync.
    scheduler: {
      status: schedulerStatus,
      last_completed_at: isoAt(lastSyncedAtMs),
      age_ms: ageMs,
      cadence_ms: cadenceMs,
      stale_after_ms: staleAfterMs,
      missed_intervals: missedIntervals,
      stalled_behind_in_flight_fire: stalledBehindInFlightFire,
    },
    execution: {
      status: executionStatus,
      phase: inFlightPhase,
      started_at: isoAt(inFlightStartedAtMs),
      age_ms: inFlightAgeMs,
      last_progress_at: isoAt(inFlightLastProgressAtMs),
      progress_age_ms: inFlightProgressAgeMs,
      holds_exclusive_locks: holdsExclusiveLocks,
      locks_reported: locksRaw !== null,
    },
    safe_to_restart: safeToRestart,
    safe_to_restart_reason: safeToRestartReason,
    in_flight: activity
      ? {
          active: inFlightActive,
          phase: inFlightPhase,
          started_at: isoAt(inFlightStartedAtMs),
          age_ms: inFlightAgeMs,
          long_running_age_ms: inFlightAgeMs,
          last_progress_at: isoAt(inFlightLastProgressAtMs),
          progress_age_ms: inFlightProgressAgeMs,
          stuck: inFlightStuck,
        }
      : null,
    warning:
      status !== 'degraded'
        ? null
        : inFlightStuck
        ? `A git-sync fire has been in flight for ${mins(inFlightAgeMs)}` +
            `${inFlightPhase ? ` (phase '${inFlightPhase}')` : ''}; its last recorded progress was ` +
            `${mins(inFlightProgressAgeMs)} ago. Scheduled ticks skip while it holds ` +
            'the git-sync lock, so nothing is being committed and the raw last_status still describes ' +
            'the tick before it. There IS a live process holding that lock: inspect it before any ' +
            'restart (safe_to_restart is false).'
          : executionStatus === 'in-flight'
            ? // WI-10002019: the stale completed-outcome clock is EXPLAINED by a live fire.
              // The generic "nothing has completed" wording below reads as a dead scheduler
              // and points a reader straight at the one action that destroys the live fire.
              `No completed git-sync outcome for more than ${GIT_SYNC_FRESHNESS_INTERVALS} scheduled intervals, ` +
              `but a fire IS in flight (${mins(inFlightAgeMs)}` +
              `${inFlightPhase ? `, phase '${inFlightPhase}'` : ''}) and is still recording progress. ` +
              'The stale clock is explained by that live fire, NOT by a stalled scheduler: do not restart ' +
              'or kill git-sync (safe_to_restart is false — a restart drops the exclusive git-sync lock ' +
              'mid-write and destroys its uncommitted work).'
            : `No completed git-sync outcome for more than ${GIT_SYNC_FRESHNESS_INTERVALS} scheduled intervals; ` +
              'the raw last_status may describe an older successful tick.',
  };
}

/** Bound the path samples below; the COUNTS beside them stay the true totals. */
const GIT_SYNC_EXCLUSION_SAMPLE = 10;

function stringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Surface the exclusion evidence git-sync already writes and this reader dropped
 * (EI-21900560691158244).
 *
 * `recordOutcome` persists `last_skipped_paths` / `last_skip_reason` / `last_oversized`
 * for an explicitly stated reason — its own comment keeps the paths "even when the
 * unlocked remainder synced: partial progress is useful evidence and is exactly the case
 * where a holder otherwise cannot tell that their file is still stranded." The `healthOf`
 * allowlist then omitted all three, so the one reader an agent actually calls discarded
 * the evidence the writer recorded for them.
 *
 * The consequence is indirect enough to be misread as the agent's own fault: a skipped
 * path is in no commit, therefore in no green-checkpoint candidate, so `work_items:complete`
 * lands `completionAuthority:'proposed'` because the server cannot prove worktree blob ==
 * HEAD blob. The item stays owned by its closer and off burn-down, which reads as a defect
 * in the work rather than a sweep that never included the file.
 *
 * Emitted on EVERY git-sync row, including when nothing was excluded. A block that appeared
 * only when non-empty would make "nothing was skipped" and "this reader does not report
 * skips" the same shape — which is the defect being repaired here, one level up.
 *
 * Deliberately NOT folded into the `last_status` headline the way `git_sync_freshness` is.
 * Excluding a locked path is normal and continuous on this tree (agents hold locks
 * constantly), so a headline that degraded on every skip would be permanently red and
 * therefore ignored — the same end state as the silence it replaced, reached from the
 * other direction. A skip is not a contradiction of `synced`; it is missing attribution
 * for one path, so it is reported as evidence and carries its own `warning`.
 */
export function deriveGitSyncExclusions(
  metadata: Record<string, unknown> | null,
  freshness: Record<string, unknown> | null = null,
  nowMs: number = Date.now(),
): Record<string, unknown> {
  const skipped = stringList(metadata?.last_skipped_paths);
  const oversized = stringList(metadata?.last_oversized);
  const bulkExcluded = stringList(metadata?.last_bulk_excluded);
  const skippedAtMs = epochMs(metadata?.last_skipped_at);
  const exclusionAtMs = epochMs(metadata?.last_exclusions_at);
  const lastSyncedAtMs = epochMs(metadata?.last_synced_at);
  const hasByteExclusions = oversized.length > 0 || bulkExcluded.length > 0;
  const exclusionStampMatchesSweep =
    exclusionAtMs !== null && lastSyncedAtMs !== null && exclusionAtMs === lastSyncedAtMs;
  const sweepStale =
    hasByteExclusions &&
    (!exclusionStampMatchesSweep || freshness?.status === 'degraded');
  const parts: string[] = [];
  const remedies: string[] = [];
  if (skipped.length > 0) {
    const reason = typeof metadata?.last_skip_reason === 'string' ? metadata.last_skip_reason : 'unknown';
    parts.push(`${skipped.length} path(s) excluded from the last completed sweep (${reason})`);
    remedies.push('release the corresponding file lock(s)');
  }
  if (hasByteExclusions) {
    if (sweepStale) {
      parts.push(
        'byte-exclusion data is from a stale or unknown sweep vintage; do not treat these paths as current',
      );
    } else {
      if (oversized.length > 0) {
        parts.push(`${oversized.length} per-file oversized blob(s) excluded`);
        remedies.push('gitignore or remove the per-file oversized blob(s)');
      }
      if (bulkExcluded.length > 0) {
        parts.push(`${bulkExcluded.length} file(s) excluded by the cumulative commit-size limit`);
        remedies.push('raise the cumulative limit or reduce/split the dirty set');
      }
      parts.push(
        `${oversized.length + bulkExcluded.length} byte-excluded path(s) are in no commit and therefore in no ` +
          'green-checkpoint candidate',
      );
    }
  }
  const warningParts = [...parts];
  if (hasByteExclusions && !sweepStale) {
    warningParts.push(remedies.join('; '));
  }
  return {
    skip_reason: typeof metadata?.last_skip_reason === 'string' ? metadata.last_skip_reason : null,
    skipped_at: isoAt(skippedAtMs),
    skipped_count: skipped.length,
    skipped_sample: skipped.slice(0, GIT_SYNC_EXCLUSION_SAMPLE),
    skipped_sample_truncated: skipped.length > GIT_SYNC_EXCLUSION_SAMPLE,
    oversized_count: oversized.length,
    oversized_sample: oversized.slice(0, GIT_SYNC_EXCLUSION_SAMPLE),
    oversized_sample_truncated: oversized.length > GIT_SYNC_EXCLUSION_SAMPLE,
    bulk_excluded_count: bulkExcluded.length,
    bulk_excluded_sample: bulkExcluded.slice(0, GIT_SYNC_EXCLUSION_SAMPLE),
    bulk_excluded_sample_truncated: bulkExcluded.length > GIT_SYNC_EXCLUSION_SAMPLE,
    sweep_at: isoAt(exclusionAtMs),
    sweep_age_ms: exclusionAtMs === null ? null : Math.max(0, nowMs - exclusionAtMs),
    sweep_stale: sweepStale,
    warning:
      warningParts.length === 0
        ? null
        : `${warningParts.join('; ')}${
            hasByteExclusions && sweepStale
              ? '. Wait for a fresh completed sweep before taking byte-exclusion action'
              : ', so work_items:complete on it can land completionAuthority:\'proposed\''
          }.`,
  };
}

/**
 * Let the derived verdict OVERRIDE the headline `last_status` (EI-21807573331912223).
 *
 * `last_status` is written by the last tick that produced an outcome, and a skipped tick
 * deliberately does not overwrite it. That is correct as a writer contract and misleading
 * as a headline: it is the first field an agent reads, it says `synced`, and it goes on
 * saying `synced` for as long as the fault lasts. Filed after the routine reported success
 * on every tick for ~35 minutes while committing nothing.
 *
 * A sibling field that disagrees does not fix this — `git_sync_freshness` already carried
 * the correct `degraded` verdict during that incident and was simply not the field anyone
 * read. So the headline itself is replaced, and the writer-backed value is preserved (and
 * documented) at `git_sync_freshness.raw_last_status`: nothing is lost, and the value that
 * remains cannot be mistaken for success.
 *
 * Scoped to this tool's response. The `harness_shared.routines.metadata.last_status` column
 * is untouched, so the writer and every direct reader of the raw column are unaffected.
 */
/**
 * EI-22702954391733746 — surface the ORIGIN-freshness watchdog's latch on this row.
 *
 * `git_sync_freshness` measures whether the LOCAL COMMIT stage completed on schedule. On a
 * `bridged` hive the member is commit-only BY DESIGN and the bridge writer owns egress, so a
 * healthy local stage is fully compatible with origin being arbitrarily stale — the two are
 * independent by construction, not merely in practice. Measured 2026-09-08: this surface read
 * `last_status:'synced'`, `git_sync_freshness:'fresh'`, `warning:null` for ~8h while origin
 * sat 26 commits behind and canonical was frozen solid.
 *
 * The verdict for THAT question is already computed — by `origin-freshness-watchdog`, which
 * latches it onto this very row as `of_alerted` / `of_alerted_cause`. It simply never reached
 * any reader: `healthOf`'s allowlist drops every `of_*` key, so the one field that knew origin
 * was frozen was invisible to the surface an agent actually reads. Same shape as the
 * EI-21900560691158244 exclusion fields directly above.
 *
 * Read-only projection of what the watchdog already wrote — this computes no verdict of its
 * own and issues no git calls. Returns null when the row carries no origin-freshness state
 * (a legacy/p2p pot the watchdog does not judge), which is an absent MEASUREMENT and is
 * deliberately not rendered as health.
 */
export function deriveOriginFreshness(metadata: unknown): Record<string, unknown> | null {
  const m = (metadata ?? {}) as Record<string, unknown>;
  const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(m, k);
  if (!has('of_alerted') && !has('of_origin_sha')) return null;
  const num = (k: string): number | null => {
    const n = Number.parseInt(String(m[k] ?? ''), 10);
    return Number.isFinite(n) ? n : null;
  };
  const alerted = String(m.of_alerted ?? '') === 'true';
  return {
    alerted,
    cause: (m.of_alerted_cause as string | null) ?? null,
    tracked_origin_sha: (m.of_origin_sha as string | null) ?? null,
    stall_sweeps: num('of_stall_sweeps'),
    integrator_backlog_sweeps: num('of_integrator_backlog_sweeps'),
    publish_refused_sweeps: num('of_publish_refused_sweeps'),
    publish_backlog_sweeps: num('of_publish_backlog_sweeps'),
  };
}

export function applyDerivedGitSyncHeadline(
  health: Record<string, unknown>,
  freshness: Record<string, unknown>,
  originFreshness?: Record<string, unknown> | null,
): Record<string, unknown> {
  // EI-22702954391733746: an ORIGIN-freshness alarm outranks a healthy local-commit verdict.
  // Checked FIRST because the whole point is that `freshness` reads perfectly fresh during
  // this class of outage — gating on `freshness.status === 'degraded'` would reproduce the
  // exact silence being fixed.
  if (originFreshness?.alerted === true) {
    const raw = typeof health.last_status === 'string' ? health.last_status : null;
    const cause = typeof originFreshness.cause === 'string' ? originFreshness.cause : 'origin-stale';
    return {
      ...health,
      last_status:
        `degraded (derived — origin-freshness ALARMING: ${cause}; commits are NOT reaching origin` +
        `${raw === null ? '' : `; raw: ${raw}`})`,
    };
  }
  if (freshness.status !== 'degraded') return health;
  const raw = typeof health.last_status === 'string' ? health.last_status : null;
  return {
    ...health,
    last_status: `degraded (derived — see git_sync_freshness${raw === null ? '' : `; raw: ${raw}`})`,
  };
}

export default defineTool({
  name: 'routines:list',
  profile: 'engineer',
  description:
    'List the scheduled system routines in this workspace (git-sync, green-checkpoint, release-trigger, improvement-watchdog, …): name, install slug, cron, target role, active flag, next/last fire, group, and `paused` (a deliberate hold, so it is distinguishable from a stall). The acceptance-grading-sweep row also carries `acceptanceBacklog` with the current non-rubric awaiting-acceptance depth and oldest plan timestamp, so a spend pause is distinguishable from an empty queue. Read-only. Pass `installSlug` (or the compatibility alias `harness`) to scope one install, `group` to filter one routine group, `limit` to cap rows (count keeps the true total), or `rollup:true` for a per-group aggregate (count/active/pausedCount/last-fire) instead of raw rows (WI-5018 — the routines table is unbounded, so a flat list stops scaling; group first).',
  capability: 'operator:read',
  guidance: {
    // Arg guidance and the `paused` semantics are deliberately NOT restated here:
    // `description` already carries the args and `returns` carries `paused` in full.
    // Those two fields are the same words a third time, and `when` is prompt-weight
    // budgeted while `returns` is free — which is what put this tool 184 over the cap.
    when: 'See the system routines and their cadence/active state before retuning or pausing one (e.g. inspect the git-sync / green-checkpoint / release-trigger schedule). Before calling a routine stalled, read `paused` and `health` — see returns.',
    notWhen: 'To CHANGE a routine, use routines:set. For a harness blueprint autoloop, use autoloop:status. To manage group metadata or bulk pause/resume a group, use routines:group-set (also routines:list { rollup:true } for the group view).',
    chaining: 'routines:set to retune or pause a routine you find here (use its exact name + installSlug). The routines:list compatibility alias is harness.',
    // EI-20206183390542424 (+ its independent re-filing EI-22367587259064593 three
    // weeks later). Measured in harness_shared.tool_invocations: 13 calls from 11
    // DISTINCT agents passed `workspace` and got a bare unrecognized-key rejection.
    //
    // The rejection message is already good — it names the accepted keys verbatim —
    // and agents re-offend anyway, because the key was never a typo: this tool reads
    // its workspace AMBIENTLY (activeWorkspaceId()), so a caller reasoning from the
    // catalog's workspace-scoped tools guesses a parameter that has no counterpart
    // here. Naming the accepted keys cannot teach that; only saying where the scope
    // actually comes from can. Same borrowed-shape family as `mode` on locks:acquire
    // (EI-21988514956470475) and `path` on locks:queue (EI-20206554322712742), and
    // argRedirects is the family's ratified remedy: it reaches the caller on the
    // FAILURE path and costs nothing against the prompt-weight budget.
    // ⚠ D-004 (tool-contract-repair-2026-09-05). Every target below is authored
    // `declaredKey — explanation`, or as an explicit corrective CALL. The three RENAME
    // entries were previously written the other way round — prose first, the key inside
    // it ("this tool spells that `installSlug` (camelCase) — RENAME…") — and that is not
    // a style difference: `splitLocalSchemaTarget` tests only the text BEFORE the first
    // ` — ` against the path regex, so a prose head fails it, the redirect classifies
    // CROSS-TOOL, and it rendered "`install_slug` is not an arg of this tool — it is
    // written by <the whole sentence>". That tells a caller who used the wrong key on
    // the RIGHT tool that some other tool owns their data, which is the exact
    // misattribution EI-21119949290826530 fixed for bare targets. Keep the declared key
    // first; put the teaching after the separator, where it renders outside the
    // backticks. Pinned by list-arg-redirect.test.ts.
    argRedirects: {
      // No local destination exists for a workspace VALUE (the scope is ambient), so a
      // `key — …` string would render "pass it as `key` instead" over an id that would
      // then be rejected again. The self-referential corrective call says the true
      // remedy — the same tool, with the key gone.
      workspace: {
        tool: 'routines:list',
        args: {},
        note:
          'this tool has NO `workspace` arg and needs none — it already reads the workspace AMBIENTLY from your session scope, so the rows you get back are that workspace\'s. DROP the key. To narrow WITHIN it use `installSlug` (one install), `group` (one routine group), `name`/`q` (one routine or a substring), or `limit`. There is no cross-workspace listing: to read another workspace, run in a session scoped to it',
      },
      install_slug:
        'installSlug — RENAME the key rather than dropping it (this tool spells it camelCase and does not accept the snake_case form), or the filter is silently lost and you read every install. `harness` is its accepted compatibility alias.',
      slug:
        'installSlug — `slug` is ambiguous here: RENAME to `installSlug` for the install that owns the routine (its compatibility alias is `harness`), or to `name` for the routine itself. Dropping it widens the read to every routine in the workspace.',
      routine:
        'name — RENAME the key: `name` is the exact routine name, e.g. "git-sync". Use `q` instead for a case-insensitive substring match over name OR install slug.',
    },
    // P-002: response documentation lives HERE, not in `when`/`description` —
    // those are prompt-weight budgeted and this tool is already near the cap
    // (the budget guard refused the first attempt to put it in `when`).
    returns: [
      'Each row: { installSlug, name, triggerKind, cron, targetRole, active, nextFireAt, lastFiredAt, group, paused, acceptanceBacklog, health }.',
      '`paused` — non-null means a DELIBERATE hold, carrying { reason, by, at }. Read it before calling a routine stalled; a bare active:false with paused:null is the one worth investigating.',
      '`acceptanceBacklog` — on `acceptance-grading-sweep`, { depth, oldestPlanUpdatedAt }; depth counts active non-rubric plans in `awaiting-acceptance`. A paused routine with depth > 0 is not an empty pause; do not re-arm it automatically because grading spends LLM budget.',
      '`health` — the operational half of the routine row, null when the row carries none of it. Carries EVERY `<subsystem>_health` record the row holds, derived from the key name rather than an allowlist, so a new writer is readable the day it ships (`gate_health` on green-checkpoint: the live in-flight-retriage marker, observed candidate and consecutive-red count; `gitnexus_health` on gitnexus-reindex: embeddings coverage, DB utilization, failure streak), plus last_status / last_error / consecutive_error_ticks / fire_count / armed_at where present. For git-sync, `health.git_sync_freshness` is the read-time verdict derived from last_synced_at, the in-flight fire and the cron cadence: degraded means either no completed outcome for more than three scheduled intervals, or one fire in flight longer than that same window. `health.git_sync_activity` is the writer-backed whole-fire marker: while `active:true`, `last_status` describes only the local stage; wait for `phase:"complete"` before treating the fire as terminal.',
      '⚠ git-sync `health.last_status` is DERIVED-OVERRIDDEN, not raw (EI-21807573331912223). When git_sync_freshness is degraded it reads `degraded (derived — see git_sync_freshness; raw: <writer value>)`, because the writer-backed headline reported `synced` on every tick for ~35 minutes while committing nothing — a skipped tick deliberately does not overwrite the last real outcome. The writer value is preserved at `git_sync_freshness.raw_last_status`; the `harness_shared.routines.metadata.last_status` column is untouched.',
      '⚠ `health.origin_freshness` — whether commits are REACHING ORIGIN, which `git_sync_freshness` cannot tell you (EI-22702954391733746): { alerted, cause, tracked_origin_sha, stall_sweeps, integrator_backlog_sweeps, publish_refused_sweeps, publish_backlog_sweeps }, null on a pot the origin watchdog does not judge. Read it as the SEPARATE question it is: `git_sync_freshness` measures whether the LOCAL COMMIT stage ran on schedule, and on a `bridged` pot the member is commit-only BY DESIGN, so `fresh` + `synced` is fully compatible with origin being arbitrarily stale — measured 2026-09-08, this surface read a clean bill for ~8h while origin sat 26 commits behind. When `alerted:true` the `last_status` headline is derived-overridden to say so.',
      '⚠ `health.git_sync_exclusions` — what the last completed sweep LEFT OUT (EI-21900560691158244/WI-2141747): { skip_reason, skipped_at, skipped_count, skipped_sample, oversized_count, oversized_sample, bulk_excluded_count, bulk_excluded_sample, +_truncated markers, sweep_at, sweep_age_ms, sweep_stale, warning }. `oversized_*` is only the per-file blob guard; `bulk_excluded_*` is the cumulative commit-size guard and has a different remedy. Counts are true totals; samples are bounded. `sweep_stale:true` (including legacy rows with no stamp, or a degraded git-sync freshness verdict) suppresses byte-exclusion action advice until a fresh completed sweep is measured. Always present on a git-sync row, so zero counts are measurements, not missing fields.',
      '`health.git_sync_freshness.in_flight` — the wedged-fire decomposition: { active, phase, started_at, age_ms, long_running_age_ms, last_progress_at, progress_age_ms, stuck }, null when the row carries no git_sync_activity. `age_ms`/`long_running_age_ms` measure total fire duration; `progress_age_ms` measures time since the writer heartbeat. `stuck:true` means progress has been absent for longer than three scheduled intervals, which is a DIFFERENT incident from ticks being skipped (there is a live process to look at) even though both read `degraded`. Legacy active markers without a progress timestamp fall back to started_at.',
      '⛔ `health.git_sync_freshness.safe_to_restart` IS THE RESTART/KILL DECISION — never `status` (WI-10002019). `status:\'degraded\'` COMPOSES two legs whose remedies are opposite, so it indicates the destructive action in exactly the case that must not take it: a long fire freezes `last_synced_at`, so `scheduler.status` reads `not-firing` BECAUSE `execution.status` is `in-flight`, and a restart then drops the exclusive git-sync lock mid-write and destroys the sweep\'s uncommitted work. The legs are independent — `scheduler` { status: firing|not-firing|inactive|unknown, last_completed_at, age_ms, cadence_ms, stale_after_ms, missed_intervals, stalled_behind_in_flight_fire } and `execution` { status: idle|in-flight|stuck|unknown, phase, started_at, age_ms, last_progress_at, progress_age_ms, holds_exclusive_locks, locks_reported }. `stalled_behind_in_flight_fire:true` is the giveaway that a stale scheduler leg is EXPLAINED by a live fire rather than by a stalled engine.',
      '`health.git_sync_freshness.safe_to_restart` is derived from the EXECUTION leg ALONE and is true only for a provably idle one; `execution.status:\'unknown\'` (the row carries no git_sync_activity marker) reports UNSAFE on purpose, because a wrong "safe" destroys in-flight work irrecoverably while a wrong "unsafe" only declines a restart. `safe_to_restart_reason` names which case you are in, and `holds_exclusive_locks` is writer-reported only — `locks_reported:false` means UNMEASURED, never "holds no locks".',
      '`health.gate_health.readAttestation` — read-time provenance for the cached verdict: snapshotObservedAt, snapshotAge/snapshotAgeMs, the judged candidate, candidateCommittedAt, candidateAgeAtObservationMs, and commitsBehindTip. The raw gate-health fields remain unchanged; null attestation fields mean the older writer did not provide that evidence.',
      '`health.gate_health.failingTestsAttestation` — candidate-bound provenance for the raw `failingTests` array: the terminal-verdict candidate, the live in-flight candidate (when the run published one), `staleAgainstInFlight`, and a warning when the arrays belong to a prior candidate. A null stale marker means the comparison was unavailable; never read it as false.',
      'THIS IS THE GATE-HEALTH READ: `health.gate_health` is what 112 agents were hand-writing `SELECT metadata->\'gate_health\' FROM harness_shared.routines` for. No raw SQL needed. For the deploy-position question ("is my change live, what is blocking it") use dev:pipeline_position instead — different question.',
      '⚠ `health.validation[\'unregistered-system-action\']` means that routine is SILENTLY DEAD: its `system:` handler is registered nowhere, so it fires on cadence and does nothing. active/nextFireAt still read healthy — this key is the only tell. Fix is a missing side-effect import in register-system-actions.ts.',
    ].join(' '),
    seeAlso: [
      'routines:set (retune / pause a routine)',
      'routines:list (rollup:true — group metadata + review-due rollup)',
      'routines:group-set (bulk pause/resume a whole group)',
      'autoloop:status (a harness blueprint autoloop instead)',
    ],
  },
  requirePrincipal: false,
  // EI-21924434989535557: an acceptance-rubric grader launches as `judge` and this
  // is the read-only routine/gate-health surface a "RE-MEASURE, never quote"
  // criterion calls to check a routine's live state (e.g. is it active, when did
  // it last fire, is the gate health degraded). Same rationale as the sibling
  // dev:pg_query widening — a read-only measurement tool, not a write-capable one.
  agentRoles: [...SU_ROLES, 'judge'],
  rolesQuota: { operator: { perRun: 60 } },
  args: z.object({
    installSlug: z.string().max(120).optional().describe('Filter to one install slug.'),
    harness: z.string().max(120).optional().describe('Compatibility alias for installSlug; pass installSlug or harness, not both.'),
    name: z.string().max(200).optional().describe('Filter to one routine name.'),
    q: z
      .string()
      .max(200)
      .optional()
      .describe('Free-text filter — case-insensitive substring match against name OR install slug.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe(
        'Max routine rows returned, applied AFTER installSlug/harness/name/q/group. Bounds routines[] only — `count` still reports the true total, so a narrowed read is never mistaken for a smaller fleet. Ignored with rollup:true (that path already returns one row per group).',
      ),
    group: z
      .string()
      .max(120)
      .optional()
      .describe('Filter to one routine group slug (WI-5018). Pass "" (empty string) to see UNGROUPED routines only.'),
    rollup: z
      .boolean()
      .optional()
      .describe('Return a per-group aggregate (count, active/inactive, most-recent last-fire) instead of raw rows. Ignores installSlug/harness/name/q; group still narrows to one group.'),
  }).superRefine((args, issue) => {
    if (args.installSlug && args.harness && args.installSlug !== args.harness) {
      issue.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['harness'],
        message: 'Pass installSlug (the canonical filter) OR harness (its compatibility alias), not conflicting values in both.',
      });
    }
  }),
  result: z
    .object({
      count: z.number().int().nonnegative().optional(),
      routines: z.array(z.unknown()).optional(),
      rollup: z.array(z.unknown()).optional(),
      installSlug: z.string().optional(),
      name: z.string().optional(),
      triggerKind: z.string().nullable().optional(),
      cron: z.string().nullable().optional(),
      targetRole: z.string().nullable().optional(),
      active: z.boolean().optional(),
      nextFireAt: z.string().nullable().optional(),
      lastFiredAt: z.string().nullable().optional(),
      group: z.string().nullable().optional(),
      paused: z.unknown().nullable().optional(),
      acceptanceBacklog: z.unknown().nullable().optional(),
      health: z.unknown().nullable().optional(),
      plane: z.unknown().optional(),
    })
    .passthrough(),
  // context-trimming-tiers P-023: rows are already lean scalars, so the CAP=60 row
  // cap plus a loud notice row IS the size control (count keeps the true total);
  // standard falls through to full.
  //
  // This comment used to say trimmed "drops the two rarely-read columns". It was
  // wrong when written (four were dropped) and stayed wrong through two fixes —
  // which is how the third instance survived. The allowlist below now emits every
  // field `returns` promises and drops NONE; the contract check enforces that, so
  // this sentence can no longer drift from the code without a red test.
  shape: {
    // EI-20803112372029993: opt this allowlist into the contract check
    // (`../trimmed-contract.ts`). The FIELD LIST is not repeated here on
    // purpose — it is derived from the `returns` promise above, so the sentence
    // agents read and the check that enforces it are one artifact. This tool
    // shipped the drop-a-promised-field bug three times; the third (triggerKind
    // + targetRole) was found BY this guard.
    contract: { rows: 'routines' },
    trimmed: (data) => {
      const d = data as { count?: number; routines?: unknown[]; rollup?: unknown[] } | null;
      if (!d) return data;
      if (Array.isArray(d.rollup)) return data; // rollup output is already a small aggregate — no trimming needed
      if (!Array.isArray(d.routines)) return data;
      const CAP = 60;
      const rows = d.routines.slice(0, CAP).map((row) => {
        const r = (row ?? {}) as Record<string, unknown>;
        return {
          installSlug: r.installSlug ?? null,
          name: r.name ?? null,
          // EI-20803112372029993: the THIRD instance of this allowlist dropping a
          // field `returns` promises — found by the contract check declared above,
          // not by a reader hitting it. `triggerKind` separates a cron routine from
          // an event-triggered one, which is the first thing "why has this not
          // fired?" turns on; `targetRole` says who it runs as. Both were promised
          // and both were unreachable on the default tier.
          triggerKind: r.triggerKind ?? null,
          cron: r.cron ?? null,
          targetRole: r.targetRole ?? null,
          active: r.active === true,
          nextFireAt: r.nextFireAt ?? null,
          group: r.group ?? null,
          // EI-19336000265007219: kept in the TRIMMED tier deliberately. A bare
          // `active:false` is exactly what makes a deliberate hold read as a stall, and
          // trimmed is the tier an agent sees by default — dropping `paused` here would
          // reinstate the whole bug for every default call.
          paused: r.paused ?? null,
          acceptanceBacklog: r.acceptanceBacklog ?? null,
          // EI-20503768406496801: the SAME bug as `paused` above, one field over.
          // This allowlist REBUILDS the row, so a field added to the mapper does not
          // arrive here — it is dropped silently, and only on the tier agents actually
          // get by default. Both of these were promised by this tool's own `returns`
          // block while being unreachable on the default path:
          //
          //   • `lastFiredAt` — "has it fired?" is half of every routine question, and
          //     nextFireAt alone cannot answer it: a stalled routine keeps advancing
          //     nextFireAt while lastFiredAt stays put. That divergence IS the stall
          //     signal, and dropping one side of it made the pair unreadable.
          //   • `health` — carries `gate_health` (the green-checkpoint gate's
          //     consecutive-red count, observed candidate and in-flight-retriage
          //     marker) and `validation['unregistered-system-action']` (the ONLY tell
          //     that an active routine's handler is registered nowhere and it has been
          //     firing into the void). `returns` calls this "THE GATE-HEALTH READ ...
          //     No raw SQL needed", and CLAUDE.md's tool-routing table sends agents
          //     here instead of hand-writing SELECT metadata->'gate_health'. With it
          //     trimmed away, the documented answer was absent and the only way back
          //     was the raw SQL this tool exists to replace — which is exactly what the
          //     reporter of EI-20503768406496801 was forced into.
          //
          // COST: `healthOf` already returns null unless the row carries one of the
          // operational keys (see its header, which states it is shaped this way so the
          // field "stays cheap on the trimmed projection" — written on the assumption it
          // was IN this tier). Ordinary rows therefore add one null; only genuinely
          // unhealthy rows and the gate rows carry a body. The CAP=60 row cap is
          // untouched and remains the real size control.
          lastFiredAt: r.lastFiredAt ?? null,
          health: r.health ?? null,
          ...(r.plane ? { plane: r.plane } : {}),
        };
      });
      if (d.routines.length > CAP) {
        rows.push({
          installSlug: '(truncated)',
          name: `showing ${CAP} of ${d.routines.length} — narrow with installSlug/name/group/limit, rollup:true, or payloadTier:"full"`,
          triggerKind: null,
          cron: null,
          targetRole: null,
          active: false,
          nextFireAt: null,
          group: null,
          paused: null,
          acceptanceBacklog: null,
          // Keep this notice row the SAME SHAPE as a real row above: a sentinel
          // missing keys its siblings have reads as "this routine has no health"
          // rather than "this is not a routine".
          lastFiredAt: null,
          health: null,
        });
      }
      return { count: d.count ?? d.routines.length, routines: rows };
    },
  },
  async handler(args, ctx) {
    const { sql } = getOrgPg();
    const ws = activeWorkspaceId();
    const iso = (d: Date | null): string | null =>
      d && !Number.isNaN(new Date(d).getTime()) ? new Date(d).toISOString() : null;

    // group:"" means "ungrouped only" (group_slug IS NULL); group:undefined means "no filter".
    const groupFilterActive = args.group !== undefined;
    const groupIsNull = args.group === '';
    const groupVal = groupIsNull ? null : (args.group ?? null);

    if (args.rollup) {
      const rows = await sql<
        Array<{
          group_slug: string | null;
          description: string | null;
          steward: string | null;
          review_cadence: string | null;
          last_reviewed_at: Date | null;
          count: string;
          active_count: string;
          paused_count: string;
          most_recent_fire: Date | null;
        }>
      >`
        SELECT r.group_slug,
               g.description,
               g.steward,
               g.review_cadence,
               g.last_reviewed_at,
               count(*)::text AS count,
               count(*) FILTER (WHERE r.active)::text AS active_count,
               -- EI-19336000265007219: split the INACTIVE population. "Deliberately
               -- paused (has a metadata.pause record)" and "inactive with no pause
               -- record" (never-armed, one-shot spent, or genuinely dropped) are
               -- different conditions that a single inactiveCount fuses into one
               -- number — which is what sends a responder to raw SQL. Measured here
               -- 2026-08-02: 128 active / 19 paused / 129 inactive-no-record.
               count(*) FILTER (WHERE NOT r.active AND r.metadata ? 'pause')::text AS paused_count,
               max(r.last_fired_at) AS most_recent_fire
          FROM harness_shared.routines r
          LEFT JOIN harness_shared.routine_groups g
            ON g.workspace_id = r.workspace_id AND g.slug = r.group_slug
         WHERE r.workspace_id = ${ws}
           AND (NOT ${groupFilterActive}::boolean OR (${groupIsNull}::boolean AND r.group_slug IS NULL) OR r.group_slug = ${groupVal})
         GROUP BY r.group_slug, g.description, g.steward, g.review_cadence, g.last_reviewed_at
         ORDER BY r.group_slug NULLS LAST`;
      const rollup = rows.map((r) => {
        const reviewDue = (() => {
          if (!r.review_cadence || !r.last_reviewed_at) return null;
          const m = /^(\d+)d$/.exec(r.review_cadence.trim());
          if (!m) return null;
          const dueAt = new Date(r.last_reviewed_at).getTime() + Number(m[1]) * 86_400_000;
          return dueAt < Date.now();
        })();
        return {
          group: r.group_slug,
          description: r.description,
          steward: r.steward,
          reviewCadence: r.review_cadence,
          lastReviewedAt: iso(r.last_reviewed_at),
          reviewDue,
          count: Number(r.count),
          activeCount: Number(r.active_count),
          inactiveCount: Number(r.count) - Number(r.active_count),
          /** Of `inactiveCount`, how many were DELIBERATELY paused (carry a
           *  metadata.pause record). The remainder are inactive with no recorded
           *  reason — never-armed, spent one-shots, or genuinely dropped. */
          pausedCount: Number(r.paused_count),
          mostRecentFire: iso(r.most_recent_fire),
        };
      });
      return { data: { count: rollup.length, rollup } };
    }

    const slug = args.installSlug ?? args.harness ?? null;
    const name = args.name ?? null;
    const q = args.q ?? null;
    const qLike = q ? `%${q}%` : null;
    const rows = await sql<
      Array<{
        install_slug: string;
        name: string;
        trigger_kind: string;
        trigger_config: Record<string, unknown> | null;
        target_role: string;
        active: boolean;
        next_fire_at: Date | null;
        last_fired_at: Date | null;
        group_slug: string | null;
        metadata: Record<string, unknown> | null;
      }>
    >`
      SELECT install_slug, name, trigger_kind, trigger_config, target_role, active, next_fire_at, last_fired_at, group_slug, metadata
        FROM harness_shared.routines
       WHERE workspace_id = ${ws}
         AND (${slug}::text IS NULL OR install_slug = ${slug})
         AND (${name}::text IS NULL OR name = ${name})
         AND (${qLike}::text IS NULL OR name ILIKE ${qLike} OR install_slug ILIKE ${qLike})
         AND (NOT ${groupFilterActive}::boolean OR (${groupIsNull}::boolean AND group_slug IS NULL) OR group_slug = ${groupVal})
       ORDER BY install_slug, name`;
    const home = operatorHomeHarnessSlug();
    let acceptanceBacklog: { depth: number; oldestPlanUpdatedAt: string | null } | null = null;
    if (rows.some((r) => r.name === 'acceptance-grading-sweep')) {
      const backlog = await sql<Array<{ depth: string; oldest_plan_updated_at: Date | null }>>`
        SELECT count(*)::text AS depth, min(updated_at) AS oldest_plan_updated_at
          FROM harness_shared.harness_plans
         WHERE workspace_id = ${ws}
           AND status = 'awaiting-acceptance'
           AND template IS DISTINCT FROM 'rubric'
           AND archived = FALSE`;
      acceptanceBacklog = {
        depth: Number(backlog[0]?.depth ?? 0),
        oldestPlanUpdatedAt: iso(backlog[0]?.oldest_plan_updated_at ?? null),
      };
    }
    const routines = rows.map((r) => {
      const cron = (r.trigger_config as { cron?: string } | null)?.cron ?? null;
      let health: Record<string, unknown> | null;
      if (r.target_role === 'system:git-sync') {
        const freshness = deriveGitSyncFreshness(r.metadata, cron, r.active);
        const originFreshness = deriveOriginFreshness(r.metadata);
        // The derived verdict replaces the headline it contradicts, rather than sitting
        // beside it hoping to be read (EI-21807573331912223). Raw value preserved at
        // git_sync_freshness.raw_last_status.
        health = applyDerivedGitSyncHeadline(
          {
            ...(healthOf(r.metadata) ?? {}),
            git_sync_freshness: freshness,
            // EI-21900560691158244: the writer records which paths it excluded so a
            // holder can tell their file is stranded; the healthOf allowlist dropped
            // every one of those fields. Always present on a git-sync row, so zero is
            // an affirmative measurement rather than an absent field.
            git_sync_exclusions: deriveGitSyncExclusions(r.metadata, freshness),
            // EI-22702954391733746: the origin-freshness watchdog's own latch. Local-commit
            // freshness cannot see a frozen egress on a bridged pot, so without this the
            // surface reports a clean bill through the entire outage.
            origin_freshness: originFreshness,
          },
          freshness,
          originFreshness,
        );
      } else {
        health = healthOf(r.metadata);
      }
      const routine = {
        installSlug: r.install_slug,
        name: r.name,
        triggerKind: r.trigger_kind,
        cron,
        targetRole: r.target_role,
        active: r.active,
        nextFireAt: iso(r.next_fire_at),
        lastFiredAt: iso(r.last_fired_at),
        group: r.group_slug,
        paused: pauseOf(r.metadata, r.group_slug),
        ...(r.name === 'acceptance-grading-sweep' && acceptanceBacklog
          ? { acceptanceBacklog }
          : {}),
        health,
      };
      // Only the operator-home row backs the operator pipeline cells. Other installs
      // may use the same routine name but have independent gates; stamping them with
      // Papercusp's cell would turn a correct value into a cross-harness misattribution.
      const plane = r.install_slug === home ? statePlaneForDoor(routine, 'routines:list', args, ctx) : null;
      return { ...routine, ...(plane ? { plane } : {}) };
    });
    // {data} envelope so the payload-tier shaper applies.
    // `limit` bounds the rows only; `count` stays the true total so a narrowed read
    // is never mistaken for a smaller fleet (same contract as locks:list registryCount).
    const limited = typeof args.limit === 'number' ? routines.slice(0, args.limit) : routines;
    return { data: { count: routines.length, routines: limited } };
  },
});
