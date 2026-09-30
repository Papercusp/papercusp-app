/**
 * single-primary-check — the "exactly one background primary" guard
 * (infra-self-healing-supervision-2026-06-19, R4-2).
 *
 * The background machinery (DBOS routines / git-sync / substrate / the Queen
 * wake-loop) must run on EXACTLY ONE process. Two opposite failures both stem from
 * there being no enforcement:
 *   • 0 primaries — the silent routine-engine death (the BACKGROUND_WORKERS=0
 *     regression / bg-host down: routines, git-sync, Queen all stop, no alarm); and
 *   • >1 primaries — the documented catastrophe (bg-workers on two hosts vs one DB
 *     → DBOS appVersion war, a 102 GB substrate_outbox, plans rewritten 100k×).
 *
 * Each live DBOS executor holds PG connections tagged `dbos_transact_<vmid>_<appver>`
 * (observed in pg_stat_activity); a dead executor's connections are gone. So the
 * count of DISTINCT such application_names = the live background-primary count. This
 * guard runs on a :3070 REQUEST worker (independent of the primary it counts) and on
 * a sustained !=1 escalates to the owner — the request-path enforcement the plan's
 * D-001 calls for ("the watcher must not live in what it watches").
 *
 * HYSTERESIS + SELF-CLEAR (hive-loop-supervision, 2026-06-21): the guard escalates
 * only after a non-1 count PERSISTS `sustainTicks` consecutive checks — so a transient
 * 0 (a bg-host restart / journal-silence-watchdog bounce, or an idle/reconnect gap where
 * the DBOS executor briefly holds no PG connection) never fires a `blocker`. And when
 * the count returns to 1 it AUTO-RESOLVES its own open escalation (a sibling
 * `escalation_resolved`) instead of leaving a stale blocker in the owner's queue. Two
 * such false-positive blockers (09:26Z + 11:14Z 2026-06-21) reached the human while the
 * engine was demonstrably healthy (routines firing, bg-host-ticker alive) — the exact
 * watchdog-determinism drift ("alarms do not self-clear against live state") this guard
 * is supposed to embody, not commit. Read-only otherwise + debounced; env-killable
 * (PAPERCUSP_SINGLE_PRIMARY_GUARD=0).
 *
 * THE SELF-CLEAR IS DURABLE, NOT PER-PROCESS (WI-7291, 2026-08-03). This guard runs on
 * EVERY request worker, so the all-clear used to require the SAME process to both raise the
 * alarm and later observe the recovery — the `openAlarms` map is per-process. That coupling
 * holds only while the alarming process is also one that eventually sees a healthy count.
 *
 * Measured 2026-08-03 on `single-primary:no-primary`: 122 alarms since 2026-07-11 and 60
 * resolutions — but every resolution falls on or before 2026-07-21T01:19:53Z. Across the
 * ~13 days since, 40+ alarms produced zero all-clears, so the condition has been
 * continuously OPEN, which then feeds condition-staleness-alarm (59 re-escalations in one
 * 12h window). The evidence says the coupling worked until the alarming process stopped
 * being one that observes recovery; it does NOT identify why that changed on 2026-07-21,
 * and this fix does not depend on that answer.
 *
 * Note the existing backstop does NOT cover this: the condition-reconciler auto-resolves
 * conditions with no NEW alarm observations (it cleared `split-brain-primary` on
 * 2026-07-17, six days after its last alarm). A condition that keeps re-alarming every
 * ~30 min never qualifies, which is exactly the stuck case here.
 *
 * Recovery is therefore judged against the DURABLE condition fold
 * (openSinglePrimaryConditions), so whichever process sees a healthy count clears the
 * condition regardless of which one raised it.
 *
 * VERIFY THE CONSEQUENCE, DON'T ASSERT IT (EI-19388269294151851, 2026-08-03): a count of
 * 0 used to hardcode the summary "DBOS routines, git-sync, and the Mug wake-loop are all
 * down". That inference held when bg-host was the only process that could run them — and
 * is now false. Measured on 2026-08-03: this guard broadcast that blocker fleet-wide and
 * urgent-paged the owner "SUSTAINED over 72 consecutive checks" (~3.6h) while git-sync
 * committed 66 times in the same window (`git log --since='4 hours ago' | grep -c
 * git-sync`) and every active routine stayed current. Both readings were correct: bg-host
 * genuinely was absent (it restarted at ~00:02:30Z), AND a routines-enabled non-primary
 * host (PAPERCUSP_DBOS_ROUTINES=1, connecting through the ordinary `pcusp:org-*` pool,
 * which carries no `dbos_transact_%` application_name) kept serving the work.
 *
 * So the count alone can no longer name the consequence. The count-0 case is now split on
 * LIVE EVIDENCE — the most recent active-routine fire:
 *   • routines STALE      → the real `no-primary` blocker (unchanged text, unchanged paging);
 *   • routines FIRING     → `no-dedicated-primary`, an ADVISORY: redundancy is degraded and
 *     bg-host needs restoring, but background work is demonstrably not stopped;
 *   • routines UNOBSERVED → `no-primary-unverified` (WI-7317, see below).
 * A false blocker is not a harmless over-report: it trains every agent to discount this
 * alarm, which is exactly what a genuine routine-engine death cannot afford.
 *
 * ABSENCE OF EVIDENCE IS NOT EVIDENCE OF DEATH (WI-7317, 2026-08-03). The split above
 * initially routed a NULL age — "I could not observe routine liveness" — into the `no-primary`
 * blocker, on the stated reasoning that falling back to the count-only verdict was the
 * fail-safe direction. It is not, and the mistake is instructive: it treats the count as an
 * independent second opinion when it is not. `count` and the liveness age are read through the
 * SAME `getOrgPg().sql` handle, so a handle that misresolves poisons BOTH — yielding count 0
 * AND age null, i.e. exactly the input that produced the most severe, most assertive verdict.
 * The advisory downgrade never "failed" here; it was fed unobservable evidence.
 *
 * Sharper still: on any workspace with routine history a genuine engine death CANNOT produce
 * a null age — the `last_fired_at` timestamps simply freeze and the age grows without bound.
 * A null therefore means the read threw, or matched no rows for the judged workspace (a fresh
 * install — or a misresolved workspace id). None of those observe routines to be down.
 *
 * Measured live 2026-08-03 05:1x Z, which is what forced this: `papercusp-workspace` had 108
 * active routines with the most recent fire 0.7s earlier and exactly 1 live primary, while
 * this guard was broadcasting `no-primary` — "DBOS routines, git-sync, and the Mug wake-loop
 * are all down" — on a streak of 175 consecutive checks (~8.7h, monotonic across four
 * intervening `severe-event-resolved`s). A correct evidence read would have returned ~0s and
 * downgraded it to the advisory.
 *
 * The rule this encodes: BE CONSERVATIVE ABOUT SEVERITY, NEVER ABOUT ACCURACY. An unobserved
 * count-0 still pages as a `blocker` — an unreadable database must never silence a real
 * outage — but under its own key, saying what was and was not observed, and prescribing
 * VERIFY rather than "restart the bg-host". That remediation is why a false blocker here is
 * actively dangerous rather than merely noisy: acting on it kills in-flight routine work and
 * reaps headless children in that service's cgroup (EI-9748 class).
 *
 * THE CHEAP CROSS-CHECK THAT CRACKS THIS CLASS (EI-19408259798878394). A streak counter is
 * reset by definition when its condition clears. So a streak that RISES across an intervening
 * `severe-event-resolved` for the same `condition_key` is NOT a flapping condition — it is
 * arithmetic proof that the ALARMING reader and the RESOLVING reader are two observers
 * disagreeing about the world. It costs nothing: the streak is already in the broadcast body
 * and the resolutions are already rows in the same `harness_shared.coord_event_log`. Here it
 * sat uncomputed for 8.7h across three agent sessions, at a cost of several retracted claims
 * and a false fleet-wide blocker.
 *
 * The corollary is worth more than the check. A monotonic counter is a TIMESTAMP OF ONSET:
 * `first_alarm_ts − (streak × interval)` dates when the reader started being wrong. Here that
 * landed within ~2 ticks of the real onset, which is what separated "the reader was always
 * wrong" from "the reader was RIGHT at onset and then got STUCK" — different bugs, different
 * fixes, and only the second one is what happened.
 *
 * Measured 2026-08-31 over 28d of coord_event_log: 11 such contradictions, ALL inside the week
 * of 2026-08-03; max streak 273 that week, then 2 in every week since — that is the reset
 * above working, on an alarm that still fires. A standing detector was declined on that
 * evidence: exactly 1 of 23 `broadcastSevereEvent` emitters carries a streak at all, so a
 * "generic" rule would guard a class of one, keyed to one prose format. If a streak alarm ever
 * looks stuck again, run the cross-check by hand — and if you ADD a streak to another emitter,
 * this is the property to preserve.
 */
import { execFileSync } from 'node:child_process';
import { getOrgPg } from '@papercusp/db-org';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { defaultIsUnitActive, readCutStatus } from '../release-cut-launch';
import {
  openEscalation,
  resolveEscalation,
  type EscalationSeverity,
} from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import { MESSAGE_GC_RETENTION_DAYS } from '../agent-tools/coordination/message-log-gc';
import { activeWorkspaceId } from '../workspace-registry';
import { notifyAttention } from '../attention-notify';
import { broadcastSevereEvent, broadcastSevereEventResolvedMany } from '../severe-event-broadcast';
import { readActiveAnnouncedQuiesce, type AnnouncedQuiesceEvidence } from './announced-quiesce';

/** The `announced-quiesce` subject this guard reads — see announced-quiesce.ts. Any agent
 *  registers under this exact subject via `supervision:announce-quiesce { subject: 'bg-host' }`. */
export const ANNOUNCED_QUIESCE_SUBJECT = 'bg-host';

export const SINGLE_PRIMARY_IDENTITY: AgentIdentity = {
  ownerId: 'system:single-primary-guard',
  ownerLabel: 'system · single-primary-guard',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

const DEFAULT_INTERVAL_MS = 3 * 60_000;
const DEFAULT_DEBOUNCE_MS = 30 * 60_000;
/** Consecutive non-1 checks required before escalating — the hysteresis that
 *  separates a real sustained outage from a transient idle/reconnect/bg-host-restart
 *  blip. At the default 3-min interval, 2 ⇒ the condition must hold ≥~3–6 min. A
 *  genuine routine-engine death persists; a reconnect gap does not. */
const DEFAULT_SUSTAIN_TICKS = 2;

/** How recently an active routine must have fired for background work to count as
 *  demonstrably ALIVE. Several system routines fire every ~30–60s and the slowest
 *  git-sync tier every ~10min, so this is deliberately generous: it must never call a
 *  genuinely dead engine "firing", which is the only direction that loses a real outage. */
const ROUTINE_FRESH_SEC = 10 * 60;

/**
 * D-026's restore leg is intentionally separate from the whole-cut unit. During the
 * protected Corestore window both units are active while bg-host is deliberately stopped;
 * treating the zero-primary reading as an outage in that interval tells operators to break
 * the lock containment. Keep this name aligned with the historical release-cut contract.
 */
export const D026_RESTORE_UNIT = 'papercup-release-cut-bg-restore-d026-v2.service';

/**
 * WHY the age reads the way it does — the distinction a bare `null` destroys.
 *   • `observed`    — the read ran and returned an age. The only status that can support a
 *                     claim ABOUT routine liveness, in either direction.
 *   • `absent`      — the read ran and matched nothing for the judged workspace. On a live
 *                     workspace this means the workspace id is wrong, not that routines died.
 *   • `unavailable` — the read FAILED. Nothing was observed, and the count (same DB handle)
 *                     is equally suspect.
 * Both non-`observed` statuses are "I could not look", never "I looked and saw nothing running".
 */
export type BackgroundEvidenceStatus = 'observed' | 'absent' | 'unavailable';

/**
 * Live evidence about whether background work is ACTUALLY running, gathered independently
 * of the primary count so a count-0 verdict can be checked rather than assumed.
 * `lastRoutineFireAgeSec: null` = NOT OBSERVED — see the header note: that is the absence of
 * evidence, not evidence of death, and it no longer renders the routine-engine-death text.
 * `status` is optional so no existing call site is stranded; omitted reads as "not gathered".
 */
export interface BackgroundActivityEvidence {
  lastRoutineFireAgeSec: number | null;
  status?: BackgroundEvidenceStatus;
}

/** The two independent systemd signals that authorize D-026 Corestore quiescence. */
export interface D026QuiescenceEvidence {
  /** The authoritative detached whole-cut unit is active/activating. */
  cutActive: boolean;
  /** The registered D-026 restore leg is active/activating. */
  restoreActive: boolean;
}

export interface D026QuiescenceReaderDeps {
  /** Injectable read-cut seam; production uses release:cut's read-only status reader. */
  readCutStatus?: typeof readCutStatus;
  /** Injectable systemd probe for the restore leg (kept strict — see readD026QuiescenceEvidence). */
  isUnitActive?: (unit: string) => boolean;
  /** Injectable systemd probe for the CUT unit specifically. Defaults to
   *  `defaultIsCutQuiescing` (also recognizes `deactivating`); falls back to `isUnitActive`
   *  when only that is supplied, so a caller/test injecting one shared probe for both units
   *  keeps working unchanged. */
  isCutActive?: (unit: string) => boolean;
}

/**
 * EI-20517156511202200 (2026-08-20): `defaultIsUnitActive` (and the plain `systemctl
 * --user is-active`) reports a unit as running only while its ActiveState is
 * `active`/`activating`. But the whole point of the D-026 handoff is the window AFTER
 * that — the cut's main script has exited and systemd has begun the stop sequence, while
 * an orphaned process left in the cut's cgroup still holds the Corestore device lock the
 * restore controller is explicitly waiting on. `systemctl is-active` reports that window
 * as `deactivating`, and `defaultIsUnitActive` treats `deactivating` identically to
 * `inactive`/`failed` (a non-zero exit is a non-zero exit) — so the cut reads as "not
 * running" at precisely the moment it is still doing the one thing D-026 exists to
 * protect. The reported incident measured the cut cgroup actively progressing during
 * that exact window (PID 1253600, 3.06s CPU over a 3s sample, 57 tasks) while
 * `cutActive` read false and the guard paged a `no-primary` blocker straight through an
 * authorized, actively-progressing restore.
 *
 * `deactivating` therefore ALSO counts as "the cut still holds the section" for D-026's
 * quiescence check — unlike `inactive`/`failed`/an unknown unit, where the cut is
 * genuinely gone and a lingering restore-unit reading as active would be stale residue,
 * not real protection. That is why ONLY the cut probe is widened here: the restore
 * unit's own check stays strict `active`/`activating` (readD026QuiescenceEvidence),
 * because a restore leg reading as `deactivating` means its EXIT trap has already fired
 * and bg-host is (or is about to be) restored — exactly the moment suppression should end.
 */
export function defaultIsCutQuiescing(unit: string): boolean {
  try {
    const out = execFileSync('systemctl', ['--user', 'is-active', unit], { encoding: 'utf8' }).trim();
    return out === 'active' || out === 'activating' || out === 'deactivating';
  } catch (err) {
    // `systemctl is-active` prints the ActiveState to stdout even on a non-zero exit (e.g.
    // exit 3 for `deactivating`) — execFileSync still captures it on the thrown error's
    // `.stdout` (encoding:'utf8' means it is already a string). Recover it instead of
    // collapsing every non-zero-exit state to "gone", which is the exact defect above.
    const stdout = (err as { stdout?: unknown } | null)?.stdout;
    const out = typeof stdout === 'string' ? stdout.trim() : '';
    return out === 'deactivating';
  }
}

export function readBackgroundPrimaryLoadState(
  unit = process.env.PAPERCUSP_BACKGROUND_SYSTEMD_UNIT ?? 'papercusp-bg-host.service',
): string | null {
  if (!unit.trim()) return null;
  try {
    const state = execFileSync('systemctl', ['--user', 'show', unit, '-p', 'LoadState', '--value'], {
      encoding: 'utf8',
    }).trim();
    return state || null;
  } catch {
    return null;
  }
}

/**
 * Read the authoritative release-cut + restore contract used by D-026.
 *
 * A single active unit is insufficient: an ordinary release cut does not authorize the
 * background primary to remain absent, and a restore unit without its owning cut is stale
 * residue. The guard therefore requires BOTH active signals before it downgrades a zero
 * primary. The read is fail-closed for suppression: systemd/read-cut failures become false
 * and the ordinary outage verdict remains in force.
 */
export function readD026QuiescenceEvidence(
  deps: D026QuiescenceReaderDeps = {},
): D026QuiescenceEvidence {
  const active = deps.isUnitActive ?? defaultIsUnitActive;
  const cutActiveProbe = deps.isCutActive ?? deps.isUnitActive ?? defaultIsCutQuiescing;
  const cut = (deps.readCutStatus ?? readCutStatus)({ isUnitActive: cutActiveProbe });
  return {
    cutActive: cut.running,
    restoreActive: active(D026_RESTORE_UNIT),
  };
}

/** PURE: only the complete cut+restore contract protects a zero-primary reading. */
export function d026QuiescenceIsActive(evidence?: D026QuiescenceEvidence): boolean {
  return evidence?.cutActive === true && evidence.restoreActive === true;
}

/** PURE: is background work demonstrably alive on this evidence? Unknown ⇒ false. */
export function routinesDemonstrablyFiring(evidence?: BackgroundActivityEvidence): boolean {
  const age = evidence?.lastRoutineFireAgeSec;
  return typeof age === 'number' && Number.isFinite(age) && age >= 0 && age <= ROUTINE_FRESH_SEC;
}

export interface PrimaryVerdict {
  count: number;
  ok: boolean;
  severity: EscalationSeverity | null;
  key: string | null;
  summary: string;
  /** WI-7317: what was actually OBSERVED about routine liveness, carried with the verdict so
   *  the durable escalation + fleet broadcast record the evidence behind the claim instead of
   *  only its conclusion. Reconstructing this after the fact cost hours on 2026-08-03: the
   *  alarm said "all down" and nothing anywhere recorded whether liveness was ever read.
   *  Optional — the healthy verdict gathers no evidence. */
  evidenceNote?: string;
  /** WI-7291: false when the COUNT ITSELF was never read (countBackgroundPrimaries returned
   *  null). Optional so no existing call site is stranded; absent means "the count was read".
   *  Distinct from `evidenceNote`, which reports what was observed about routine LIVENESS —
   *  the two reads fail independently and conflating them is what let an unread count page
   *  the fleet as a confirmed outage. */
  countObserved?: boolean;
}

/**
 * PURE: classify the live background-primary count against live activity evidence.
 * `evidence` is optional so no existing call site is stranded; omitting it preserves the
 * original count-only verdicts exactly.
 */
export function evaluatePrimaryCount(
  count: number | null,
  evidence?: BackgroundActivityEvidence,
  quiescence?: D026QuiescenceEvidence,
  announcedQuiesce?: AnnouncedQuiesceEvidence,
  backgroundUnitLoadState?: string | null,
): PrimaryVerdict {
  // WI-7291: the count was NOT READ. This is the absence of evidence, so it can never earn
  // the routine-engine-death text — but it still pages, on the same principle as the
  // unverified-liveness branch below: an unreadable database must never SILENCE a real
  // outage. Checked FIRST, before any liveness reasoning, because a successful liveness read
  // reporting a stale age would otherwise fall through to the `no-primary` death verdict on
  // a count nobody ever obtained.
  if (count === null) {
    return {
      count: 0,
      countObserved: false,
      ok: false,
      severity: 'blocker',
      key: 'no-primary-unverified',
      evidenceNote: 'NOT observed (count-unread): the background-primary COUNT query returned no usable row',
      summary:
        'background-primary count could NOT BE READ (the query returned no usable row) — this is NOT a report that zero primaries are running, and must not be read as "routines, git-sync and the Mug wake-loop are down". Nothing was observed either way. VERIFY BEFORE ACTING (restarting a healthy bg-host kills in-flight routine work): SELECT count(DISTINCT application_name) FROM pg_stat_activity WHERE application_name LIKE \'dbos_transact_%\', and check max(last_fired_at) in harness_shared.routines.',
    };
  }
  if (count === 1) {
    return { count, ok: true, severity: null, key: null, summary: 'exactly one background primary (healthy)' };
  }
  if (count === 0) {
    // D-026: an active whole cut plus its registered restore leg proves that the missing
    // primary is intentional Corestore quiescence. Reframe as an advisory and explicitly
    // prohibit the old remediation; do not let stale routine timestamps turn maintenance
    // into a restart recommendation. A partial/stale contract never suppresses the blocker.
    if (d026QuiescenceIsActive(quiescence)) {
      return {
        count,
        ok: false,
        severity: 'advisory',
        key: 'no-primary-quiesced',
        evidenceNote: `observed: ${D026_RESTORE_UNIT} active with the detached release cut`,
        summary:
          'background primary intentionally quiesced for the authorized D-026 Corestore release cut (cut + restore units are active). Do NOT start or restart bg-host while the cut-owned Corestore lock is held; wait for the restore leg to finish, then verify the primary and routine fires recover.',
      };
    }
    // EI-22040647386284200: a SECOND, broader suppression signal — a self-reported,
    // bounded-duration announcement (see announced-quiesce.ts) for an ad-hoc quiesce
    // (e.g. a manual kill + shell EXIT trap) that leaves no D-026 systemd trace at all.
    // Weaker evidence than D-026 (self-reported, not systemd-verified) so it is checked
    // second; still authorized to replace the dangerous "Start the bg-host" instruction,
    // because the alternative — asserting a crash the announcer explicitly ruled out —
    // is the exact defect this item was filed for.
    if (announcedQuiesce?.active) {
      const untilNote = announcedQuiesce.until ? ` until ${announcedQuiesce.until}` : '';
      const byNote = announcedQuiesce.by ? ` by ${announcedQuiesce.by}` : '';
      return {
        count,
        ok: false,
        severity: 'advisory',
        key: 'no-primary-announced-quiesce',
        evidenceNote: `observed: an announced quiesce is active for '${announcedQuiesce.subject}'${byNote}${untilNote}`,
        summary:
          `background primary intentionally quiesced — an ANNOUNCED maintenance window is active for '${announcedQuiesce.subject}'${byNote}${untilNote}. Reason: ${announcedQuiesce.reason ?? 'not given'}. ` +
          'Do NOT start or restart bg-host while this window is active (self-reported, not systemd-verified — trust it, but verify with the announcer if anything looks wrong); wait for it to end or expire, then verify the primary and routine fires recover.',
      };
    }
    const backgroundUnitRecovery =
      backgroundUnitLoadState === undefined || backgroundUnitLoadState === 'loaded'
        ? null
        : backgroundUnitLoadState === 'masked'
          ? 'systemd reports LoadState=masked. Do NOT start, restart, or unmask bg-host automatically; verify who masked it and whether the maintenance/release window is still active before restoring it.'
          : backgroundUnitLoadState === null
            ? 'systemd could not verify the bg-host LoadState. Do NOT start it from this alarm until the unit and any maintenance/mask reason are verified.'
            : `systemd reports bg-host LoadState=${backgroundUnitLoadState}. Do NOT start it from this alarm until the unit state and any maintenance/mask reason are verified.`;
    // The consequence is CHECKED, not asserted — see the header note. Routines still
    // firing means redundancy is degraded, not that background work has stopped.
    if (routinesDemonstrablyFiring(evidence)) {
      const age = Math.round(evidence?.lastRoutineFireAgeSec ?? 0);
      return {
        count,
        ok: false,
        severity: 'advisory',
        key: 'no-dedicated-primary',
        evidenceNote: `observed: an active routine fired ${age}s ago${backgroundUnitLoadState !== undefined ? `; bg-host LoadState=${backgroundUnitLoadState ?? 'unavailable'}` : ''}`,
        summary:
          `no dedicated background primary (bg-host) — but background work is NOT stopped: an active routine fired ${age}s ago, so a routines-enabled non-primary host is serving them. Degraded redundancy (bg-host down or restarting), NOT the routine-engine-death class. ${backgroundUnitRecovery ?? 'Restore the bg-host.'}`,
      };
    }

    const age = evidence?.lastRoutineFireAgeSec;
    // POSITIVE evidence that routines are NOT firing. This is the ONLY reading that earns the
    // routine-engine-death text — we looked, and background work really has stopped. A
    // NEGATIVE age is clock skew, not staleness, so it is not this branch either.
    if (typeof age === 'number' && Number.isFinite(age) && age >= 0) {
      return {
        count,
        ok: false,
        severity: 'blocker',
        key: 'no-primary',
        evidenceNote: `observed: no active routine has fired for ${Math.round(age)}s${backgroundUnitLoadState !== undefined ? `; bg-host LoadState=${backgroundUnitLoadState ?? 'unavailable'}` : ''}`,
        summary:
          `NO background primary running — DBOS routines, git-sync, and the Mug wake-loop are all down (the silent routine-engine-death class). ${backgroundUnitRecovery ?? 'Start the bg-host / restore a background worker.'}`,
      };
    }

    // Liveness was NOT observed (read failed, matched nothing, or was never gathered). Per the
    // header note this is the absence of evidence, so it must not render the death text — but
    // it still pages, because an unreadable database must never silence a real outage.
    const status = evidence?.status;
    const why =
      status === 'unavailable'
        ? 'the routine-liveness read FAILED'
        : status === 'absent'
          ? 'the routine-liveness read matched no active routine in the judged workspace (a fresh install — or a MISRESOLVED workspace id)'
          : 'no routine-liveness evidence was gathered';
    return {
      count,
      ok: false,
      severity: 'blocker',
      key: 'no-primary-unverified',
      evidenceNote: `NOT observed (${status ?? 'not-gathered'}): ${why}`,
      summary:
        `background primaries read as 0, but this is UNVERIFIED: ${why}. Do NOT read this as "routines, git-sync and the Mug wake-loop are down" — that was never observed. The count is read through the SAME database handle as the failed liveness read, so the 0 itself is equally unverified. VERIFY BEFORE ACTING (restarting a healthy bg-host kills in-flight routine work): SELECT count(DISTINCT application_name) FROM pg_stat_activity WHERE application_name LIKE 'dbos_transact_%', and check max(last_fired_at) in harness_shared.routines.${backgroundUnitRecovery ? ` ${backgroundUnitRecovery}` : ''}`,
    };
  }
  // >1 is a blocker on the COUNT alone — routine liveness neither confirms nor refutes a
  // split brain (both executors are firing routines; that is the catastrophe, not a mitigation).
  // The evidence is still recorded, because "what did the guard see" must never be lost again.
  const sbAge = evidence?.lastRoutineFireAgeSec;
  return {
    count,
    ok: false,
    severity: 'blocker',
    key: 'split-brain-primary',
    evidenceNote:
      typeof sbAge === 'number' && Number.isFinite(sbAge)
        ? `observed: an active routine fired ${Math.round(sbAge)}s ago (not exculpatory for >1)`
        : `NOT observed (${evidence?.status ?? 'not-gathered'}) — irrelevant to a split-brain verdict`,
    summary:
      `${count} background primaries on one DB — split-brain DBOS (appVersion war / 102GB-outbox / plans-rewritten-100k× class). Stop all but one immediately.`,
  };
}

type SqlLike = <T = unknown>(strings: TemplateStringsArray, ...values: unknown[]) => Promise<T>;

/**
 * Count DISTINCT live DBOS executors via their pg_stat_activity application_name.
 *
 * Returns `null` when the read produced NO USABLE ROW — which is categorically different
 * from observing zero executors, and must never be collapsed into one.
 *
 * WI-7291 (2026-08-03): this used to end `return rows[0]?.n ?? 0`, so a read that came back
 * empty rendered as the affirmative claim "there are zero background primaries" — and the
 * caller then paged the entire fleet with "DBOS routines, git-sync, and the Mug wake-loop are
 * all down". A `count(...)` aggregate ALWAYS returns exactly one row, so an empty result is
 * never a real zero; it means the read did not happen (unexpected driver shape, a degraded or
 * half-open pooled handle, a cancelled statement). That distinction is the whole point of the
 * guard: this is a health probe whose "I could not look" answer was indistinguishable from its
 * "everything is dead" answer.
 *
 * Note `?? null` (not `|| null`): a GENUINE zero is `0`, which `??` preserves and `||` would
 * destroy — turning the one real outage this guard exists to catch into "unverified".
 *
 * EI-19442084790376701 (2026-08-03): WI-7291 above closed the EMPTY-ROW form of "I could not
 * look". This closes the second, subtler form — an UNPRIVILEGED READER — which the empty-row
 * check cannot see because the read succeeds and returns a perfectly well-formed row.
 *
 * `pg_stat_activity` is ROLE-FILTERED: a role that is neither superuser nor a member of
 * `pg_read_all_stats` sees other roles' backends with `application_name` NULLED. Measured on
 * this box 2026-08-03: the 6 live DBOS backends are owned by `harness_admin`, which HAS
 * `pg_read_all_stats` and correctly reports 1 — while `harness_app` holds neither privilege, so
 * the same query matches nothing and `count(...)` returns a flawless `0`. That zero is a
 * VISIBILITY ARTIFACT, not an observation, and it is indistinguishable from a real outage:
 * deterministic, permanent for that process's whole life, and monotonic because the guard never
 * once reads healthy to reset its streak (L546). It is the exact shape of the ~10h false page
 * this item was filed for — one worker reporting 0 while peers concurrently read 1.
 *
 * The guard is a PROBE, so the honest answer to "am I allowed to see the thing I am counting?"
 * = no is `null` ("I could not look"), never `0` ("everything is dead"). Answering the
 * CAPABILITY question directly beats inferring blindness from the shape of the result, which is
 * how this class hides in the first place.
 */
/**
 * One-shot latch so the fail-open path below announces itself EXACTLY once per process
 * rather than on every 3-minute tick.
 */
let capabilityProbeAbsentWarned = false;

export async function countBackgroundPrimaries(sql: SqlLike): Promise<number | null> {
  const rows = await sql<Array<{ n: number; can_read_all_stats: boolean }>>`
    SELECT (SELECT count(DISTINCT application_name)::int
              FROM pg_stat_activity
             WHERE application_name LIKE 'dbos_transact_%') AS n,
           (pg_has_role(current_user, 'pg_read_all_stats', 'member')
            OR COALESCE((SELECT r.rolsuper FROM pg_roles r WHERE r.rolname = current_user), false))
             AS can_read_all_stats`;
  const row = rows[0];
  if (!row) return null;
  // Blind reader ⇒ the count is unanswerable, NOT zero. Checked before `n` so a stats-blind
  // process can never page "all background work is down" off its own missing permission.
  //
  // `=== false` (not `!`) is deliberate, and it is the SAFE direction here even though this is
  // a health probe. The flag is computed by the query above, so it is missing only if the
  // driver dropped the column — and treating THAT as "blind" would make the guard return null
  // forever, i.e. silently convert the probe into a permanent no-op that can never report a
  // real outage. Absent ⇒ behave exactly as before this change; only an affirmative `false`
  // (a reader that actually answered "I lack the privilege") suppresses the count.
  //
  // FAIL OPEN *AND ANNOUNCE* (su-4ca244e4, 2026-08-03). Fail-open alone has one real cost: if
  // the flag ever goes absent, the guard silently reverts to the exact pre-fix behaviour — a
  // restricted reader reporting a confident 0 — with nothing anywhere recording that the
  // protection evaporated. That is a fresh instance of this very defect class one level up: an
  // invisible state, inferred rather than observed. Announcing once makes "this guard is
  // currently running unprotected" an OBSERVABLE fact, for one line per process.
  if (row.can_read_all_stats === undefined && !capabilityProbeAbsentWarned) {
    capabilityProbeAbsentWarned = true;
    console.warn(
      '[single-primary] capability probe UNAVAILABLE — the pg_stat_activity read returned no ' +
        'can_read_all_stats column, so the unprivileged-reader protection (EI-19442084790376701) ' +
        'is NOT in effect and a restricted role would again report a confident 0. Failing OPEN ' +
        'deliberately: a probe that can never report an outage is a silent failure, not a safe one.',
    );
  }
  if (row.can_read_all_stats === false) return null;
  return row.n ?? null;
}

/**
 * Age in seconds of the most recent ACTIVE routine fire — the independent liveness signal
 * for "is background work actually happening", used to check a count-0 verdict instead of
 * asserting its consequence. Returns null when nothing has ever fired (a fresh install),
 * which reads as "unknown" and preserves the count-only blocker.
 */
export async function lastRoutineFireAgeSec(
  sql: SqlLike,
  workspaceId?: string,
): Promise<number | null> {
  // SCOPE TO THE WORKSPACE BEING JUDGED. harness_shared.routines is multi-tenant, and an
  // unscoped max() fails in the one direction that loses a real outage: another tenant's
  // healthy routines would mask this workspace's dead ones and silently downgrade a
  // genuine blocker to an advisory. Narrower evidence can only over-report the blocker,
  // which is the safe way to be wrong.
  const rows = workspaceId
    ? await sql<Array<{ age_sec: number | null }>>`
        SELECT EXTRACT(EPOCH FROM (now() - max(last_fired_at)))::float8 AS age_sec
          FROM harness_shared.routines
         WHERE active = true AND last_fired_at IS NOT NULL
           AND workspace_id = ${workspaceId}`
    : await sql<Array<{ age_sec: number | null }>>`
        SELECT EXTRACT(EPOCH FROM (now() - max(last_fired_at)))::float8 AS age_sec
          FROM harness_shared.routines
         WHERE active = true AND last_fired_at IS NOT NULL`;
  const age = rows[0]?.age_sec;
  return typeof age === 'number' && Number.isFinite(age) ? age : null;
}

/** The condition-key namespace this guard alarms under. Both keys it can emit
 *  (`no-primary`, `no-dedicated-primary`, `split-brain-primary`) are prefixed with it,
 *  so one prefix match finds every condition this guard owns. */
const CONDITION_PREFIX = 'single-primary:';

/**
 * The `single-primary:*` conditions that are OPEN right now, read from DURABLE state.
 *
 * A condition is open ⇔ its latest alarm is strictly newer than its latest resolution —
 * the same fold `coord:conditions` (computeConditionStates) applies, and the same
 * `condition_key` / `resolves_condition[s]` envelope shape severe-event-broadcast writes.
 *
 * WHY A LOCAL QUERY RATHER THAN reusing readConditionEnvelopes() + computeConditionStates():
 * those read through the coord seam (coordSql/coordWorkspaceId), which resolves the AMBIENT
 * workspace — but this guard is explicitly workspace-PARAMETERIZED and must judge the
 * workspace it was handed, or a multi-workspace process silently all-clears the wrong
 * tenant's alarm. This also stays narrow (one prefix, aggregates in PG) instead of folding
 * the whole condition stream in JS every 3 min in every process. The WHERE clause matches
 * `coord_event_log_conditions_idx` exactly so the read seeks that partial index.
 *
 * Bounded by the message-log GC retention window: a condition whose latest alarm AND
 * resolution both fall outside it no longer exists to all-clear. Errors are the CALLER's
 * to absorb — a failed read must degrade to "emit nothing", never to a false all-clear.
 *
 * ⚠ THE `workspaceId` FILTER IS LOAD-BEARING, NOT DEFENSIVE — and it is coupled to the
 * ROLE this runs as. `harness_shared.coord_event_log` has RLS enabled
 * (`coord_event_log_workspace_isolation`: `workspace_id = current_setting('app.workspace_id')`).
 * The caller passes `getOrgPg().sql`, i.e. the **harness_admin** role, which has
 * `rolbypassrls = true` — so RLS does NOT scope this query and the explicit predicate is the
 * ONLY thing keeping it inside one workspace. Two ways to break it, both silent:
 *   • drop/loosen the `workspace_id` predicate → the read spans EVERY workspace and one
 *     tenant's recovery all-clears another tenant's live alarm;
 *   • switch the caller to `getOrgPgApp()` (the harness_app role, which is SUBJECT to RLS)
 *     → without a `SET LOCAL app.workspace_id` this returns ZERO rows, so the guard simply
 *     stops all-clearing and the stuck-condition bug returns, looking exactly like "fixed".
 * Measured 2026-08-03: as harness_app with no `app.workspace_id`, the identical query
 * returns 0 rows (the index scan is never executed); with it set, 11,768 condition rows are
 * visible. Verifying this query as harness_admin therefore proves nothing about harness_app.
 */
export async function openSinglePrimaryConditions(
  sql: SqlLike,
  workspaceId: string,
): Promise<string[]> {
  const sinceIso = new Date(Date.now() - MESSAGE_GC_RETENTION_DAYS * 86_400_000).toISOString();
  const prefixLike = `${CONDITION_PREFIX}%`;
  const rows = await sql<Array<{ key: string }>>`
    WITH ev AS (
      SELECT ts, body
        FROM harness_shared.coord_event_log
       WHERE workspace_id = ${workspaceId}
         AND surface = 'messages'
         AND (body ? 'condition_key' OR body ? 'resolves_condition')
         AND ts >= ${sinceIso}
    ),
    alarms AS (
      SELECT body->>'condition_key' AS key, max(ts) AS at
        FROM ev
       WHERE body->>'condition_key' LIKE ${prefixLike}
         -- A resolution envelope carries condition_key TOO (severe-event-broadcast stamps
         -- both), so an alarm is defined by the ABSENCE of the resolve fields.
         AND NOT (body ? 'resolves_condition' OR body ? 'resolves_conditions')
       GROUP BY 1
    ),
    resolves AS (
      SELECT k AS key, max(ts) AS at
        FROM ev
        CROSS JOIN LATERAL jsonb_array_elements_text(
          CASE WHEN jsonb_typeof(body->'resolves_conditions') = 'array'
               THEN body->'resolves_conditions'
               ELSE jsonb_build_array(body->>'resolves_condition') END
        ) AS k
       WHERE (body ? 'resolves_condition' OR body ? 'resolves_conditions')
         AND k LIKE ${prefixLike}
       GROUP BY 1
    )
    SELECT a.key AS key
      FROM alarms a
      LEFT JOIN resolves r ON r.key = a.key
     WHERE r.at IS NULL OR a.at > r.at`;
  return rows.map((r) => r.key).filter((k): k is string => typeof k === 'string' && k.length > 0);
}

// ── check + hysteresis + debounce + self-clear + starter ─────────────────────────

const lastAlertedAt = new Map<string, number>();
// Consecutive non-1 streak per verdict key — the hysteresis input.
const consecutiveNon1 = new Map<string, number>();
// key → msg_id of the last fired-but-unresolved escalation, so a recovery
// (count back to 1) can SELF-CLEAR it rather than leave a stale blocker. This is
// per-process state (like the debounce): it self-clears the dominant case — a
// bg-host bounce while THIS :3070 worker stays up. If the worker itself restarts
// mid-alarm the msg_id is lost (the open row is then drained by the 14-day
// escalation GC / attention-reconcile sweep, not here).
const openAlarms = new Map<string, string>();

export interface PrimaryGuardDeps {
  count?: () => Promise<number>;
  /** Age in seconds of the most recent active-routine fire (null = unknown). The evidence
   *  that turns a count-0 blocker into an advisory when background work is demonstrably
   *  still running — see the header note. */
  routineFireAgeSec?: () => Promise<number | null>;
  /** D-026: active cut + restore evidence. Omitted in pure/unit callers; the scheduled
   * live guard wires readD026QuiescenceEvidence explicitly so tests never shell out. */
  d026Quiescence?: () => D026QuiescenceEvidence | Promise<D026QuiescenceEvidence>;
  /** EI-22040647386284200: the broader, self-reported announced-quiesce evidence (see
   *  announced-quiesce.ts). Omitted in pure/unit callers, exactly like d026Quiescence
   *  above; the scheduled live guard wires the real PG-backed reader explicitly. */
  announcedQuiescence?: () => AnnouncedQuiesceEvidence | Promise<AnnouncedQuiesceEvidence>;
  backgroundUnitLoadState?: () => string | null | Promise<string | null>;
  escalate?: (input: { severity: EscalationSeverity; summary: string; body?: string }) => Promise<unknown>;
  /** Resolve a previously-opened escalation by msg_id (self-clear on recovery). */
  resolve?: (input: { msg_id: string; choice: string; note?: string }) => Promise<unknown>;
  now?: () => number;
  debounceMs?: number;
  /** Consecutive non-1 checks required before escalating (default 2). */
  sustainTicks?: number;
  /** WI-4023: active paging for a sustained non-1 verdict (default: real notifyAttention +
   *  broadcastSevereEvent). Inject a no-op in tests — the default hits the REAL owner push
   *  + fleet broadcast, which a test exercising this path must never do. */
  page?: (verdict: PrimaryVerdict, streak: number, count: number, ws: string) => Promise<void>;
  /** WI-4023: the fleet all-clear when the guard self-clears (default: real
   *  broadcastSevereEventResolvedMany). Inject a no-op in tests for the same reason. */
  pageResolved?: (keys: string[]) => Promise<void>;
  /** WI-7291: the `single-primary:*` conditions currently OPEN in durable state — the
   *  input that lets ANY process all-clear a recovery, not only the one that alarmed.
   *  Default: the real workspace-scoped PG read. */
  openConditions?: () => Promise<string[]>;
}

async function defaultPage(verdict: PrimaryVerdict, streak: number, count: number, ws: string): Promise<void> {
  try {
    await notifyAttention({
      kind: 'intervention',
      title: 'Single-primary guard BLOCKER',
      body: verdict.summary,
      importance: 'urgent',
      workspaceId: ws,
      data: { key: verdict.key ?? '', count },
    });
  } catch {
    /* best-effort: never crash the request worker */
  }
  try {
    await broadcastSevereEvent({
      summary: `[single-primary] ${verdict.summary}`,
      body: `Detected by the request-path single-primary guard (R4-2), SUSTAINED over ${streak} consecutive checks. Live DBOS background primaries: ${count} (expected exactly 1). Routine-liveness evidence — ${verdict.evidenceNote ?? 'none recorded'}. Workspace: ${ws}. See harness_escalations for the durable record.`,
      category: 'severe-event',
      conditionKey: `single-primary:${verdict.key}`,
    });
  } catch {
    /* best-effort: never crash the request worker */
  }
}

async function defaultPageResolved(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await broadcastSevereEventResolvedMany({
      conditionKeys: keys.map((k) => `single-primary:${k}`),
      summary: `single-primary RECOVERED (${keys.join(', ')}) — exactly one background primary again.`,
    });
  } catch {
    /* best-effort: never crash the request worker */
  }
}

/**
 * One guard tick: count primaries; escalate on a SUSTAINED non-1 verdict (debounced),
 * and SELF-CLEAR an open escalation when the count recovers to 1.
 */
export async function runSinglePrimaryCheck(
  workspaceId?: string,
  deps: PrimaryGuardDeps = {},
): Promise<{ fired: boolean; verdict: PrimaryVerdict; selfCleared: boolean }> {
  const ws = workspaceId ?? activeWorkspaceId();
  const now = (deps.now ?? Date.now)();
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const sustainTicks = Math.max(1, deps.sustainTicks ?? DEFAULT_SUSTAIN_TICKS);
  const escalate = deps.escalate ?? ((input) => openEscalation(SINGLE_PRIMARY_IDENTITY, input));
  const resolve =
    deps.resolve ??
    ((input) => resolveEscalation({ ...input, resolver: SINGLE_PRIMARY_IDENTITY.ownerId }));
  // WI-4023: paging defaults to a NO-OP here — see the liveness-alarm.ts sibling fix's
  // comment for why (a bare tick call, i.e. every unit test, must never page for real;
  // the live scheduled loop below wires the real default explicitly).
  const page = deps.page ?? (async () => {});
  const pageResolved = deps.pageResolved ?? (async () => {});
  const count = deps.count ? await deps.count() : await countBackgroundPrimaries(getOrgPg().sql as SqlLike);
  // Gather the activity evidence ONLY when the count is non-1 — the healthy path stays a
  // single query. A failure here degrades to `null` (unknown), which preserves the
  // historical count-only verdict rather than silently softening a real outage.
  let evidence: BackgroundActivityEvidence | undefined;
  if (count !== 1) {
    try {
      const age = deps.routineFireAgeSec
        ? await deps.routineFireAgeSec()
        : await lastRoutineFireAgeSec(getOrgPg().sql as SqlLike, ws);
      // WI-7317: a null here is the read finding NOTHING, which is categorically different
      // from the read FAILING below — and both are different from observing a stale age.
      // Collapsing all three into a bare null is what let "I could not look" render as
      // "routines are down".
      evidence = { lastRoutineFireAgeSec: age, status: age === null ? 'absent' : 'observed' };
    } catch {
      evidence = { lastRoutineFireAgeSec: null, status: 'unavailable' };
    }
  }
  let quiescence: D026QuiescenceEvidence | undefined;
  if (count === 0 && deps.d026Quiescence) {
    try {
      quiescence = await deps.d026Quiescence();
    } catch {
      // Suppression is fail-closed: an unreadable maintenance signal must not soften an
      // ordinary no-primary blocker.
      quiescence = undefined;
    }
  }
  let announcedQuiesce: AnnouncedQuiesceEvidence | undefined;
  if (count === 0 && deps.announcedQuiescence) {
    try {
      announcedQuiesce = await deps.announcedQuiescence();
    } catch {
      // Same fail-closed rule as D-026 above: an unreadable announcement store must
      // never be read as "quiesced".
      announcedQuiesce = undefined;
    }
  }
  let backgroundUnitLoadState: string | null | undefined;
  if (count === 0 && deps.backgroundUnitLoadState) {
    try {
      backgroundUnitLoadState = await deps.backgroundUnitLoadState();
    } catch {
      backgroundUnitLoadState = null;
    }
  }
  const verdict = evaluatePrimaryCount(count, evidence, quiescence, announcedQuiesce, backgroundUnitLoadState);

  // ── Healthy (exactly one primary): reset hysteresis + self-clear open alarms ──
  if (verdict.ok || !verdict.key) {
    consecutiveNon1.clear();
    let selfCleared = false;

    // Resolve the ESCALATION rows this process opened. Still keyed off the in-process
    // map because resolveEscalation needs a msg_id only the opener holds — and unlike the
    // condition all-clear below, this path is not the leak: openEscalation dedups, and a
    // row orphaned by a worker restart is drained by the 14-day escalation GC.
    for (const [key, msgId] of [...openAlarms]) {
      try {
        await resolve({
          msg_id: msgId,
          choice: 'auto-resolved-recovered',
          note: `single-primary count returned to 1 (healthy) — the ${key} alarm self-cleared against live state.`,
        });
        selfCleared = true;
      } catch {
        /* best-effort: never crash the request worker */
      }
    }
    openAlarms.clear();

    // WI-7291 (root-cause fix, 2026-08-03): the fleet all-clear is driven by DURABLE
    // condition state, NOT by the per-process `openAlarms` map above.
    //
    // THE BUG THIS REPLACES: `pageResolved` used to fire only when THIS process's map was
    // non-empty, so an all-clear required the SAME process to both alarm and observe the
    // recovery. A guard runs on every request worker (:3070, :3170, the desktop sidecar at
    // :3270, …), and the process that alarms is routinely not the one that later sees a
    // healthy count — so the all-clear was skipped by exactly the processes able to send
    // it. Measured 2026-08-03: `single-primary:no-primary` had 122 alarms since 2026-07-11
    // and ZERO resolutions EVER; `single-primary:split-brain-primary` had been open 23 days
    // after plainly recovering. A permanently-open condition then feeds
    // condition-staleness-alarm, which re-escalates it every ~30 min (59 escalations in one
    // 12h window) — a false blocker that trains every agent to discount this alarm, which
    // is precisely what a genuine routine-engine death cannot afford.
    //
    // EDGE-TRIGGERED BY CONSTRUCTION: the read returns a key only while its latest alarm is
    // newer than its latest resolution, so a recovery emits ONE all-clear and then reads
    // clean — a peer still alarming re-opens the condition and earns exactly one more. This
    // deliberately lets a process with direct evidence the count is 1 all-clear an alarm
    // raised by a process that saw 0: the healthy reading is the falsifiable one, and the
    // disagreement then shows up as a visible re-alarm rather than a stuck blocker.
    //
    // Fail-safe: a read error degrades to emitting nothing (the old behaviour), never to a
    // false all-clear — the only direction that could hide a real outage.
    let durablyOpen: string[] = [];
    try {
      durablyOpen = deps.openConditions
        ? await deps.openConditions()
        : await openSinglePrimaryConditions(getOrgPg().sql as SqlLike, ws);
    } catch {
      durablyOpen = [];
    }
    if (durablyOpen.length > 0) {
      selfCleared = true;
      // pageResolved re-prefixes, so hand it BARE keys — the durable read returns them
      // already namespaced.
      await pageResolved(durablyOpen.map((k) => k.slice(CONDITION_PREFIX.length)));
    }
    return { fired: false, verdict, selfCleared };
  }

  // ── Non-1 verdict: count a streak; a class change (no-primary↔split-brain) resets ──
  for (const k of [...consecutiveNon1.keys()]) if (k !== verdict.key) consecutiveNon1.delete(k);
  const streak = (consecutiveNon1.get(verdict.key) ?? 0) + 1;
  consecutiveNon1.set(verdict.key, streak);
  // Hysteresis: require the condition to PERSIST before alarming. A single transient
  // sample (idle/reconnect/bg-host bounce) never reaches the owner.
  if (streak < sustainTicks) return { fired: false, verdict, selfCleared: false };

  // Debounce repeated escalations of the same sustained condition. NOTE this debounce
  // (like `consecutiveNon1`/`openAlarms`) is IN-PROCESS state — and this guard runs on
  // EVERY request worker (:3070's ~16 reusePort cluster workers, :3170 staging, the
  // desktop sidecar at :3270, …), each with its OWN independent copy of this Map. So this
  // check alone only throttles repeats FROM THIS ONE PROCESS; it cannot stop N other
  // processes from independently reaching their own streak threshold and each paging
  // moments apart. The `repeatCount` check below (EI-19400981259017885, root-cause fix
  // for the split-out-of-WI-7291 "false alarm" investigation) is what closes that gap —
  // see its comment for the measured evidence.
  const prev = lastAlertedAt.get(verdict.key);
  if (prev !== undefined && now - prev < debounceMs) return { fired: false, verdict, selfCleared: false };
  // Whether THIS process has already paged this condition at least once. Captured before the
  // overwrite below, and the input to the outlier check that follows.
  const pagedBefore = prev !== undefined;
  lastAlertedAt.set(verdict.key, now);

  // EI-19442084790376701: THE PAGE-LOOP. Two individually-correct fixes compose into an
  // unbounded page storm, and only their INTERACTION is wrong:
  //   1. this process pages;
  //   2. WI-7291 has a peer that reads a healthy count all-clear it ~2min later, RESOLVING
  //      the escalation row;
  //   3. `findOpenDuplicate` folds `{ status: 'open' }` (escalations.ts), so a RESOLVED row is
  //      invisible to it and the next `escalate()` returns `repeatCount = 1`;
  //   4. `alreadyPagedByPeer` below is therefore false → this process pages AGAIN, every
  //      `debounceMs`, forever.
  // Measured 2026-08-03: a single stuck reader paged the fleet every 30min for ~10h, each
  // alarm followed ~2min later by a peer's all-clear (09:43:46→09:45:21, 09:13:46→09:15:46,
  // 08:43:46→08:44:54, 08:13:46→08:15:46), streak climbing monotonically past 266.
  //
  // The all-clear comment above states the intended design: a disagreement should surface as
  // "a visible re-alarm rather than a stuck blocker". That intent is preserved here — what is
  // removed is only the URGENT PAGE, exactly the advisory/blocker split made below. The
  // escalation row is still written on every cycle, so the disagreement stays visible and
  // durable; it simply stops waking the whole fleet on a reading a peer has already falsified.
  //
  // Keyed on an OBSERVED RESOLUTION (we paged, and the condition is no longer open), never on
  // "not currently open" alone — the latter is also true of a real outage nobody has reported
  // yet, and would suppress the genuine FIRST page this guard exists to send.
  let peerFalsifiedOurReading = false;
  if (pagedBefore) {
    try {
      const stillOpen = deps.openConditions
        ? await deps.openConditions()
        : await openSinglePrimaryConditions(getOrgPg().sql as SqlLike, ws);
      peerFalsifiedOurReading = !stillOpen.includes(`${CONDITION_PREFIX}${verdict.key}`);
    } catch {
      // Fail OPEN: a failed read must never suppress a page. Suppression requires positive
      // evidence that a peer resolved us, never the mere absence of a successful read.
      peerFalsifiedOurReading = false;
    }
  }
  // Default true so a failed/unclear escalate() (caught below) still pages — the
  // historical best-effort behavior; only a CONFIRMED durable duplicate suppresses it.
  let alreadyPagedByPeer = false;
  try {
    const rec = await escalate({
      severity: verdict.severity ?? 'blocker',
      summary: `[single-primary] ${verdict.summary}`,
      body: `Detected by the request-path single-primary guard (R4-2), SUSTAINED over ${streak} consecutive checks. Live DBOS background primaries: ${count} (expected exactly 1). Routine-liveness evidence — ${verdict.evidenceNote ?? 'none recorded'}. Workspace: ${ws}.${
        peerFalsifiedOurReading
          ? ` ⚠ OUTLIER READER (EI-19442084790376701): a peer process observed a HEALTHY count and all-cleared this condition after our last page, so our reading is contradicted by a falsifiable observation. Recorded durably, urgent page SUPPRESSED. This process (pid ${process.pid}) has now read non-1 ${streak} consecutive times without ever reading healthy — if that continues, THIS process is the fault, not the background primaries.`
          : ''
      }`,
    });
    // Remember the open escalation's msg_id so a later recovery can self-clear it.
    const msgId = (rec as { msg_id?: string } | undefined)?.msg_id;
    if (typeof msgId === 'string') openAlarms.set(verdict.key, msgId);
    // EI-19400981259017885: `escalate()` (openEscalation) already DEDUPS durably by the
    // condition's subject signature — a call while an OPEN escalation for the SAME
    // condition already exists returns that existing record with `repeatCount` bumped
    // rather than creating a fresh row (escalations.ts's `findOpenDuplicate`). Since every
    // one of the N independent guard processes reaches this same summary text for the
    // same verdict.key, that dedup identity is IDENTICAL across processes — so
    // `repeatCount > 1` here means SOME process (this one on an earlier streak, or a
    // fully independent peer process) has already opened — and, per the `blocker` branch
    // below, already actively PAGED — this exact still-open condition. Re-paging on every
    // peer's own independently-timed streak is the measured root cause of the "false
    // alarm" pattern this item was filed to explain: on 2026-08-03 the same
    // `single-primary:no-primary` condition alarmed+self-cleared roughly every 30min for
    // 4+ hours (00:01, 00:34, 01:04, ... 04:10, 04:40), including one pair only 1.8s apart
    // (04:40:45.783 alarm → 04:40:47.615 resolve) — impossible from a single process's own
    // 3min-interval/2-tick hysteresis, but expected from ~18 independently-phased
    // processes (confirmed live: 16 :3070 cluster workers + :3170 staging + the :3270
    // desktop/DBOS-primary sidecar, each running `startSinglePrimaryGuard()` — by design,
    // per the R4-2 comment at its hono-host.ts call site, for freeze resilience — with its
    // OWN in-memory `consecutiveNon1`/`lastAlertedAt` Maps). The "wrong database/cluster"
    // hypothesis this item was filed to test is REFUTED: every process's admin URL
    // (checked live across the desktop sidecar, all 16 release-cluster workers, and
    // staging) resolves to the identical `localhost:5432/papercusp`, and DBOS's own
    // systemDatabaseUrl bypasses PgBouncer entirely by design (LISTEN/NOTIFY needs a
    // session-bound connection) — so a genuine, if brief, per-process read of a live
    // (if momentarily reconnecting) DBOS pool is plausible, but it is FLEET-WIDE
    // uncoordinated paging — not the count itself — that turns rare per-process blips into
    // a rate the owner reasonably tunes out. Grounding this gate in the SAME durable dedup
    // `openConditions`/self-clear already uses (WI-7291) closes it without inventing a new
    // cross-process coordination mechanism.
    const repeatCount = (rec as { repeatCount?: number } | undefined)?.repeatCount;
    alreadyPagedByPeer = typeof repeatCount === 'number' && repeatCount > 1;
  } catch {
    /* best-effort: never crash the request worker */
  }
  // WI-4023 (root-cause fix, 2026-07-11): verified live that this guard already
  // detects a no-primary outage almost immediately (fired at 20:39:15, ~1min after
  // the 20:38 incident) — but until now that only reached `openEscalation`, a
  // durable PG row with no active push. Nobody noticed for ~40min because nothing
  // paged. Mirror git-sync-stall-watchdog.ts's active paging so a sustained
  // no-primary/split-brain verdict reaches the owner + fleet immediately, not just
  // the escalation log.
  // Page ONLY for a blocker, and ONLY the first process to open this condition. An
  // advisory (`no-dedicated-primary`) is recorded durably as an escalation row but must
  // never urgent-page the owner or fire an "everything is down" fleet broadcast — that
  // false urgency is the whole defect this split fixes. `alreadyPagedByPeer` closes the
  // SAME class of false urgency for the multi-process re-page case (EI-19400981259017885).
  // WI-7291: page the VERDICT's count, not the raw read. They differ in exactly one case —
  // an unread count, where the raw value is `null` and the verdict reports 0 alongside
  // `countObserved: false`. The pager also receives the whole verdict, so it can render
  // "could not be read" honestly instead of asserting a zero nobody observed.
  // `peerFalsifiedOurReading` (EI-19442084790376701) closes the THIRD route to the same false
  // urgency: `alreadyPagedByPeer` only suppresses while the escalation is still OPEN, and a
  // peer's all-clear closes it — which is precisely what re-arms this line every debounce
  // window. See the derivation above the escalate() call.
  if (verdict.severity === 'blocker' && !alreadyPagedByPeer && !peerFalsifiedOurReading) {
    await page(verdict, streak, verdict.count, ws);
  }
  return { fired: true, verdict, selfCleared: false };
}

/** Start the guard on a request-worker loop. Env-killable; timer is `unref`'d. */
export function startSinglePrimaryGuard(opts: { intervalMs?: number } = {}): { stop(): void } {
  if (process.env.PAPERCUSP_SINGLE_PRIMARY_GUARD === '0') return { stop() {} };
  const envMs = Number(process.env.PAPERCUSP_SINGLE_PRIMARY_GUARD_MS);
  const intervalMs = opts.intervalMs ?? (Number.isFinite(envMs) && envMs > 0 ? envMs : DEFAULT_INTERVAL_MS);
  const timer = managedSetInterval(
    'single-primary-check',
    intervalMs,
    () => {
      // managedSetInterval's callback is `() => void | Promise<void>` — runSinglePrimaryCheck()
      // resolves a richer { fired, verdict, selfCleared } shape, so discard it via a block body
      // (no return) rather than an expression-bodied arrow, which would leak the resolved type.
      void runSinglePrimaryCheck(undefined, {
        page: defaultPage,
        pageResolved: defaultPageResolved,
        d026Quiescence: readD026QuiescenceEvidence,
        announcedQuiescence: () => readActiveAnnouncedQuiesce(ANNOUNCED_QUIESCE_SUBJECT, Date.now()),
        backgroundUnitLoadState: readBackgroundPrimaryLoadState,
      }).catch(() => {});
    },
    { category: 'watchdog' },
  );
  return {
    stop() {
      timer.stop();
    },
  };
}

/** Test-only — clear the per-key debounce, streak, and open-alarm state. */
export function _resetSinglePrimaryDebounce(): void {
  lastAlertedAt.clear();
  consecutiveNon1.clear();
  openAlarms.clear();
  // The fail-open announce latches once per PROCESS, which in a test runner means once per
  // FILE — so without this reset the first absent-flag read anywhere silently consumes the
  // warning and a later test asserting it would pass vacuously.
  capabilityProbeAbsentWarned = false;
}
