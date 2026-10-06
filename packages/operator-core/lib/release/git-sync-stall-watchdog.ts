/**
 * git-sync-stall-watchdog — the sibling of green-stall-watchdog, for the OTHER silent
 * pipeline failure: git-sync FIRING but not COMMITTING.
 *
 * THE GAP (2026-06-30 incident): the papercusp git-sync routine kept firing every 3 min, but
 * its DBOS fires got STUCK ("routineFire produced no DBOS operation output; executor reaper
 * cancelled the stuck fire and requeued") — so no commit ever landed. Auto-commit of the main
 * staging tree died at 15:00 and NOTHING alarmed for ~6h while ~100 source files stranded
 * uncommitted (and thus un-deployable — a deploy ships only committed HEAD). The green-stall-
 * watchdog is blind to this: it only watches `system:green-checkpoint`. git-sync RECORDS its
 * health on the routine metadata (`head_sha` / `last_status` / `last_error`, set by
 * recordOutcome) — but nothing READ it. This does. The github-bridge leg runs after
 * recordOutcome and may overwrite top-level status/error, so the commit signal also
 * reads the stage-aware `local_sync_*` fields written by that local stage.
 *
 * Process-level (NOT a DBOS routine) for the same reason as green-stall-watchdog: a routine-based
 * watchdog queues on the very engine that wedges, so it can't fire when most needed.
 *
 * DETECTION — three signals, most-robust first:
 *   1. commit-staleness (PRIMARY) — the tree HEAD (`metadata.head_sha`) has not advanced in
 *      HEAD_STALE_MS while the routine is active. This is the robust signal: `last_error` is
 *      NOISY (git-sync NULLS it on any healthy/`nothing` tick, so it flips null between reaps —
 *      it was null when we first checked the live stall), but a FROZEN head directly means "no
 *      commit is landing." The watchdog tracks head movement itself (`wd_head_sha` /
 *      `wd_head_since_ms`), resetting the clock whenever head advances.
 *   2. fire-staleness — an ACTIVE routine whose `last_fired_at` is older than FIRE_STALE_MS
 *      (cron every 3 min, so 3h ⇒ the scheduler isn't running it).
 *   3. error persistence — `last_error` is non-null across ≥2 CONSECUTIVE watchdog sweeps
 *      (`wd_error_sweeps`, watchdog-tracked like the head clock). git-sync NULLS last_error on
 *      any healthy tick, so two 15-min sweeps both catching a fault ⇒ ~10 consecutive failed
 *      3-min runs — a real fault streak, not a blip. A SINGLE observed error never alarms:
 *      on 2026-07-02 a lone 240s submodule push timeout (self-recovered in 6 min) urgently
 *      paged the owner + broadcast "code is stranding" to the whole fleet — pure alarm noise.
 *
 * On alarm: an urgent owner `notifyAttention` + a durable `harness_escalations` row (its OWN
 * phase) + a fleet BROADCAST (severe-event-broadcast — every running agent sees it next turn,
 * inject-only, so someone claims it). Recovery (head advances again / routine fires) clears the
 * flag + escalation idempotently.
 *
 * Kill-switch: PAPERCUSP_GITSYNC_STALL_WATCHDOG='0'.
 */
import type { Sql } from 'postgres';
import { managedSetInterval, type ManagedHandle } from '@papercusp/scheduled-registry';
import { broadcastSevereEvent, broadcastSevereEventResolvedMany } from '../severe-event-broadcast';
import { readRoutineEngineLiveness } from './routine-engine-liveness';
import type { IneligibleReason } from '../harness/git-sync/git-sync-eligibility';
import { isLocalDiskFullError, localDiskFullClause } from '../harness/git-sync/git-fetch-headroom-refusal';

/** Tree HEAD unchanged this long while the routine is active ⇒ commits aren't landing.
 *  EI-7531: the papercusp tree stranded 2622 dirty paths for 10.5h while git-sync looked
 *  active. git-sync runs every 3 min; 30m is 10 missed commit opportunities and is late
 *  enough to avoid one-off push noise while still surfacing stranded work promptly. */
const DEFAULT_HEAD_STALE_MS = 30 * 60 * 1000; // 30m
/** An ACTIVE git-sync that hasn't FIRED in this long ⇒ the scheduler isn't running it. */
const DEFAULT_FIRE_STALE_MS = 3 * 60 * 60 * 1000; // 3h
/** WI-1416: this many CONSECUTIVE executor-reaper cancels (`metadata.reaped_count` —
 *  incremented per reap, reset by a completed fire) ⇒ the fire loop is thrashing:
 *  fires start (`fire_started_at` advances) but never complete a commit. Sturdier
 *  than last_error (which flips null on any healthy tick) for the WI-1415 loop. */
const DEFAULT_PERSISTENT_REAP_MIN = 3;
/** A fault must be observed on this many CONSECUTIVE watchdog sweeps before error-stall alarms
 *  (`wd_error_sweeps`). At the 15-min sweep cadence over a 3-min git-sync, 2 sweeps ⇒ the fault
 *  survived ~10 runs — persistent, not a transient push/fetch blip. */
const DEFAULT_ERROR_STALL_MIN_SWEEPS = 2;
/** EI-9030b: the overall stall verdict must hold across this many CONSECUTIVE watchdog sweeps
 *  before it BROADCASTS (`wd_stall_sweeps`). This is the missing edge-triggering half — the
 *  per-signal thresholds above judge one sweep, but a stall that self-heals within a sweep
 *  interval (2026-07-10: 6 hive harnesses each flapped a STALLED/RECOVERED pair for ~25min
 *  transient stalls — pure inbox noise) still paged the whole fleet. Requiring a second
 *  consecutive stalled sweep (~15min later) suppresses the transient; a genuine permanent
 *  stall still surfaces promptly (~one extra sweep vs the 6h silent strand this watchdog exists
 *  to catch). A never-confirmed transient never sets `watchdog_alerted`, so no recovery pair
 *  fires either. */
const DEFAULT_STALL_SUSTAIN_MIN_SWEEPS = 2;
/** How often the watchdog sweeps. git-sync is every 3 min; 15m is ample + matches green-stall. */
const DEFAULT_WATCHDOG_INTERVAL_MS = 15 * 60 * 1000; // 15 min
/** EI-1835: consecutive sweeps a routine must be observed eligibility-gate-skipped before the
 *  eligibility-loss alarm fires (mirrors DEFAULT_STALL_SUSTAIN_MIN_SWEEPS — a first-observed
 *  ineligible sweep alone never alarms, so a same-sweep-window registry blip self-heals silently). */
const DEFAULT_ELIGIBILITY_SUSTAIN_MIN_SWEEPS = 2;

const WATCHDOG_PHASE = 'git-sync-watchdog';
const WATCHDOG_KIND = 'git-sync-watchdog';
/** EI-1835: a DISTINCT harness_escalations phase from WATCHDOG_PHASE — the table's key is
 *  (harness_slug, phase), so a shared phase would let the two alert classes clobber each other. */
const ELIGIBILITY_WATCHDOG_PHASE = 'git-sync-eligibility-watchdog';
const ELIGIBILITY_WATCHDOG_KIND = 'git-sync-eligibility-watchdog';

/**
 * EI-1835: the P-008 eligibility-gate skip reasons (git-sync-eligibility.ts `IneligibleReason`) —
 * kept as a local exhaustive map (not a runtime export from that pure, import-light module) so a
 * union member added/removed there fails typecheck HERE instead of silently under/over-matching.
 * `metadata.last_skip_reason` is a SHARED field: a lock-contention skip ('locked-path') and an I/O
 * fail-closed skip ('live-lock-read-failed') write into it too, and neither is an eligibility
 * regression — both are already covered by the existing errorStall/commit-staleness signals. Only
 * these six literal reasons mean "the P-008 gate itself skipped this tick".
 */
const ELIGIBILITY_SKIP_REASON_MAP: Record<IneligibleReason, true> = {
  ephemeral_debris: true,
  hive_home: true,
  remote_hive_view: true,
  no_path: true,
  non_local_deployment: true,
  not_a_git_repo: true,
};
const ELIGIBILITY_SKIP_REASONS = new Set<string>(Object.keys(ELIGIBILITY_SKIP_REASON_MAP));

export interface GitSyncStallThresholds {
  headStaleMs?: number;
  fireStaleMs?: number;
  /** WI-1416: consecutive reaps that count as a persistent reap-loop (default 3). */
  persistentReapMin?: number;
  /** consecutive watchdog sweeps a fault must persist before error-stall alarms (default 2). */
  errorStallMinSweeps?: number;
  /** EI-9030b: consecutive stalled sweeps required before the alarm BROADCASTS (default 2). */
  stallSustainMinSweeps?: number;
  /** EI-1835: consecutive eligibility-gate-skipped sweeps required before the eligibility-loss
   *  alarm fires (default DEFAULT_ELIGIBILITY_SUSTAIN_MIN_SWEEPS). A separate knob from
   *  stallSustainMinSweeps — a different alert class, same edge-triggering shape. */
  eligibilitySustainMinSweeps?: number;
}

/** The bits of one git-sync routine the verdict is computed from. */
export interface GitSyncStallSnapshot {
  /** epoch ms of the routine's last fire (`last_fired_at`), or null if never fired. */
  lastFiredMs: number | null;
  /** ms the tree HEAD has been UNCHANGED (watchdog-tracked), or null if it just moved / first
   *  observation (⇒ never commit-stale this pass). */
  headUnchangedMs: number | null;
  /** last recorded error/reap message (`metadata.last_error`) — NULL on a healthy tick. */
  lastError: string | null;
  /** consecutive watchdog sweeps (INCLUDING this one) that observed a fault
   *  (`metadata.wd_error_sweeps`, maintained by checkGitSyncStall). Absent with a
   *  present lastError reads as 1 — a first observation, below the alarm bar. */
  errorSweeps?: number;
  /** The top-level routine status, which a later bridge leg may overwrite with an egress error. */
  lastStatus?: string | null;
  /** The status recorded by the local git-sync stage before any bridge leg runs. This is the
   *  authoritative status for commit-staleness: 'nothing' = clean idle and 'skipped' = the
   *  eligibility gate no-opped the fire, so neither means a commit was attemptable. */
  localSyncStatus?: string | null;
  /** the watchdog's own dedup flag (`metadata.watchdog_alerted`). */
  watchdogAlerted: boolean;
  /** WI-1416: consecutive executor-reaper cancels since the last COMPLETED fire
   *  (`metadata.reaped_count`; the reaper increments it, recordOutcome resets it).
   *  Optional — absent reads as 0. */
  reapedCount?: number;
  /** The root routine engine is stale; infra-liveness owns this root-cause alarm. */
  routineEngineStale?: boolean;
  /** Start time of a writer-backed, currently-active `local-sync` phase. A fresh fire gets one
   *  bounded attempt window before frozen-HEAD becomes actionable; stale markers never exempt it. */
  activeLocalSyncStartedAtMs?: number | null;
}

export interface GitSyncStallVerdict {
  stalled: boolean;
  /** the tree HEAD has not advanced in headStaleMs while the routine is active (PRIMARY). */
  commitStale: boolean;
  /** the routine is active but hasn't fired in fireStaleMs (the scheduler is wedged). */
  fireStale: boolean;
  /** git-sync recorded a fault on ≥ errorStallMinSweeps CONSECUTIVE sweeps (a persistent fault
   *  streak — a single observed error is transient and never alarms). */
  errorStall: boolean;
  /** WI-1416: the executor reaper has cancelled ≥ persistentReapMin consecutive fires —
   *  fires start but never complete (the WI-1415 reap→requeue→restart loop). */
  persistentReap: boolean;
  /** human reason for the alarm body, or null when not stalled. */
  reason: string | null;
  /** One actionable line selected from a multiline last_error for the alert headline. */
  errorHeadline: string | null;
}

const hrs = (ms: number): number => Math.round(ms / 3_600_000);

const ERROR_HEADLINE_MAX_CHARS = 240;
const ERROR_CONTEXT_MAX_CHARS = 600;

/**
 * Pick the terminal cause from a noisy command log. Build tools commonly print many success
 * lines before the failing assertion; taking `last_error.slice(0, n)` hid the actual failure in
 * the fleet alert. Prefer explicit failure markers anywhere in the log, then fall back to its
 * final non-empty line.
 */
function gitSyncErrorHeadline(raw: string): string | null {
  // WI-10004397: a disk-full refusal sits behind git-sync's ~110-char generic fetch prefix, so a
  // head-of-line cut dropped the only actionable words. Lead with the disk clause itself.
  const diskFull = localDiskFullClause(raw);
  if (diskFull) {
    return diskFull.length <= ERROR_HEADLINE_MAX_CHARS
      ? diskFull
      : `${diskFull.slice(0, ERROR_HEADLINE_MAX_CHARS - 1)}…`;
  }
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  const priorities = [
    /^(?:FAIL|ERROR):/,
    /^(?:fatal:|panic(?:ked)?\b)/i,
    /^make(?:\[\d+\])?: \*\*\*/i,
    /^✗\s/,
    /^error:/i,
  ];
  let headline = lines.at(-1)!;
  for (const pattern of priorities) {
    const match = [...lines].reverse().find((line) => pattern.test(line));
    if (match) {
      headline = match;
      break;
    }
  }
  return headline.length <= ERROR_HEADLINE_MAX_CHARS
    ? headline
    : `${headline.slice(0, ERROR_HEADLINE_MAX_CHARS - 1)}…`;
}

/** Keep the end of a multiline failure for the detailed diagnosis, starting on a line boundary. */
function gitSyncErrorContext(raw: string): string {
  const normalized = raw.replace(/\r/g, '').trim();
  if (normalized.length <= ERROR_CONTEXT_MAX_CHARS) return normalized;
  const tail = normalized.slice(-ERROR_CONTEXT_MAX_CHARS);
  const firstLineEnd = tail.indexOf('\n');
  return `…${firstLineEnd >= 0 ? tail.slice(firstLineEnd + 1) : tail}`;
}

/**
 * Pure: does this verdict mean COMMITS ARE NOT LANDING (code strands uncommitted + un-deployable),
 * or only that git-sync recorded a persistent FAULT while HEAD kept advancing?
 *
 * A frozen HEAD / dead fire / reap-loop strands code. A pure error STREAK does not: one lane can
 * fail every tick — e.g. a single submodule whose merge is refused — while the superproject
 * commits and pushes normally. The two need opposite first moves, so conflating them sends the
 * reader after an engine wedge that is not there.
 *
 * Live miss this exists to stop (2026-08-02, papercusp): a 39-sweep (~10h) streak of
 * `libs/generic/{cache,chat-protocol}: merge failed … refusing to merge unrelated histories`
 * paged the whole fleet as "code is stranding … likely a DBOS executor reaping stuck git-sync
 * fires" while origin/staging advanced every ~5 min and the GitHub bridge reported
 * `divergence: clear`. Every remedy the page named (rescue-commit the tree, chase the engine)
 * was for a stall that was not happening; the actual failing leg was submodule reconcile.
 */
export function isStrandingVerdict(verdict: GitSyncStallVerdict): boolean {
  return verdict.commitStale || verdict.fireStale || verdict.persistentReap;
}

/**
 * Pure: the reader-facing diagnosis for a stall verdict — what is wrong, why it matters, and the
 * first move — DERIVED from which signals fired rather than assumed. Single source for the fleet
 * broadcast, the owner notification and the escalation row, so the three can never disagree about
 * the same verdict (they did: only `summary` branched, three other strings asserted stranding
 * unconditionally).
 */
export function gitSyncStallDiagnosis(
  verdict: GitSyncStallVerdict,
  installSlug: string,
): { summary: string; title: string; why: string } {
  const cause = verdict.errorHeadline ? ` Cause: ${verdict.errorHeadline}` : '';
  // WI-10004397: a full local disk strands commits too, but the engine is healthy. Naming the
  // executor reaper here (as the generic stranding text does) sent readers after a wedge that
  // did not exist while every superproject commit on the box was refused for want of space.
  if (isStrandingVerdict(verdict) && isLocalDiskFullError(verdict.errorHeadline)) {
    return {
      summary: `git-sync STALLED on ${installSlug} — LOCAL DISK FULL: fetches are refused below the headroom reserve, so nothing commits and code is stranding.${cause}`,
      title: 'git-sync STALLED — local disk below the fetch-headroom reserve',
      why:
        `Why it matters: a deploy ships only COMMITTED HEAD, and git-sync will not fetch or commit ` +
        `while the filesystem named in the cause is at or under its critical write reserve. The ` +
        `root cause is DISK SPACE, not the engine, the network or credentials: a restart, a lock ` +
        `or a rescue-commit will not help. Free space on that filesystem (find the GROWER, not just ` +
        `the biggest stock); git-sync resumes on its own at the next tick once free space clears ` +
        `the reserve.`,
    };
  }
  if (isStrandingVerdict(verdict)) {
    return {
      summary: `git-sync STALLED on ${installSlug} — firing but NOT committing; code is stranding uncommitted + un-deployable.${cause}`,
      title: 'git-sync STALLED — commits not landing, code stranding',
      why:
        `Why it matters: a deploy ships only COMMITTED HEAD, so stranded edits can't reach :3070 ` +
        `until git-sync commits them. Common root: a DBOS executor reaping stuck git-sync fires ` +
        `(engine wedge — a lock/restart won't fix it). Claim it: inspect metadata.last_error on ` +
        `the ${installSlug} git-sync routine, and rescue-commit the tree if the strand is urgent.`,
    };
  }
  // Pure error streak: HEAD is still advancing — say so, or the reader chases a phantom stall.
  return {
    summary: `git-sync FAULTING on ${installSlug} — a persistent fault streak; HEAD is still advancing, so this is a FAILING LEG, not a commit stall.${cause}`,
    title: 'git-sync FAULTING — a persistent failing leg (commits still landing)',
    why:
      `Why it matters: git-sync has recorded the SAME fault on consecutive sweeps, so one leg is ` +
      `reliably failing — but HEAD is advancing, so this is NOT the code-stranding stall and a ` +
      `rescue-commit is the WRONG move. Read metadata.last_error on the ${installSlug} git-sync ` +
      `routine FIRST and fix the leg it names (a submodule that cannot merge, a rejected push, a ` +
      `failing bridge). Verify before assuming a strand: compare the tree HEAD against ` +
      `origin/<branch> — if origin is current, nothing is stranded.`,
  };
}

/**
 * Pure: was a commit NOT even attemptable on the tick that recorded this status?
 * 'nothing' = clean idle (nothing to commit), 'skipped'/'skipped-locked' = the eligibility
 * gate no-opped the fire. The SAME predicate gates the commitStale verdict (a frozen HEAD
 * across non-attemptable ticks is definitional, not a stall) AND the sweep-side head-clock
 * re-arm in checkGitSyncStall (WI-41567) — shared so the two can never drift apart.
 * The bridge leg can overwrite the top-level status after a clean local result, so the
 * stage-aware local status wins, with the top-level value as the pre-EI-20315742298217655
 * fallback.
 */
export function isCommitNotAttemptableStatus(
  localSyncStatus: string | null | undefined,
  lastStatus: string | null | undefined,
): boolean {
  const status = localSyncStatus ?? lastStatus;
  return status === 'nothing' || status === 'skipped' || status === 'skipped-locked';
}

/**
 * EI-1835: the bits of one git-sync routine the ELIGIBILITY-LOSS verdict is computed from — a
 * separate, sibling detector to the stall verdict above. THE GAP: `evaluateGitSyncStall`'s own
 * commit-staleness signal deliberately EXEMPTS an eligibility-gate 'skipped' tick
 * (isCommitNotAttemptableStatus) — a frozen HEAD across skips is definitional, not a stall — so a
 * previously-active repo that goes ineligible (a registry flag flip, a moved/vanished path, a
 * hive-home reclassification) freezes origin/staging SILENTLY: no signal here ever fires for it
 * (the 2026-06-20 incident this whole file's header incident narrative describes — ~1h of blocked
 * fleet deploys before three agents pieced it together by hand). This closes exactly that gap.
 */
export interface GitSyncEligibilityLossSnapshot {
  /** true iff the LAST recorded tick was a P-008 eligibility-gate skip — `last_status === 'skipped'`
   *  AND `last_skip_reason` is one of the six ELIGIBILITY_SKIP_REASONS (never a lock/IO skip, which
   *  are a different, already-covered signal). */
  currentlyIneligible: boolean;
  /** "prior-active" evidence (per the design this closes): has this routine EVER actually landed a
   *  commit (`head_sha`/`local_sync_head_sha` non-null, sticky once set)? A routine that never had
   *  a chance to commit going ineligible is not a regression — nothing to page about. */
  everActive: boolean;
  /** consecutive sweeps (INCLUDING this one) this routine has been observed ineligible
   *  (watchdog-tracked `wd_ineligible_sweeps`) — resets to 0 the instant it's eligible again. */
  ineligibleSweeps: number;
  /** the watchdog's own dedup flag for THIS alert class (`eligibility_alerted`) — a separate flag
   *  from the stall detector's `watchdog_alerted`, so the two alarm classes never clobber each
   *  other's one-shot-until-recovery state. */
  eligibilityAlerted: boolean;
}

export interface GitSyncEligibilityLossVerdict {
  /** fire the eligibility-loss alarm THIS sweep: ineligible, prior-active, sustained across
   *  `minSustainSweeps` consecutive sweeps, and not already alerted (one-shot until recovery). */
  shouldAlarm: boolean;
  /** the routine is eligible again AND a prior alarm for it is still flagged — resolve/supersede it. */
  shouldResolve: boolean;
}

/**
 * Pure: EI-1835 eligibility-loss edge detector. Mirrors the stall detector's shape deliberately
 * (sustain-gated, dedup-flagged, edge-triggered) — reusing a mechanism this codebase has already
 * hardened against false alarms three times (2026-07-02, 2026-07-03, EI-9030b) is safer than
 * inventing a fourth alerting shape for a class of change the original 2026-07-18 triage flagged
 * as "delicate, false-alarm-sensitive" for fleet-wide observability.
 *
 * "No per-tick spam": callers persist `ineligibleSweeps`/`eligibilityAlerted` once per sweep and
 * flip the dedup flag on the SAME cross-process exactly-once UPDATE...WHERE pattern the stall
 * detector uses (see checkGitSyncStall) — this function only decides, never persists.
 */
export function evaluateGitSyncEligibilityLoss(
  s: GitSyncEligibilityLossSnapshot,
  minSustainSweeps: number = DEFAULT_ELIGIBILITY_SUSTAIN_MIN_SWEEPS,
): GitSyncEligibilityLossVerdict {
  if (!s.currentlyIneligible) {
    // Eligible again: resolve iff WE alarmed before (nothing to supersede otherwise).
    return { shouldAlarm: false, shouldResolve: s.eligibilityAlerted };
  }
  if (!s.everActive) return { shouldAlarm: false, shouldResolve: false }; // never committed — not a regression
  if (s.eligibilityAlerted) return { shouldAlarm: false, shouldResolve: false }; // one-shot until recovery
  if (s.ineligibleSweeps < minSustainSweeps) return { shouldAlarm: false, shouldResolve: false }; // not sustained yet
  return { shouldAlarm: true, shouldResolve: false };
}

/** Pure: reader-facing diagnosis for an eligibility-loss alarm — single source for the fleet
 *  broadcast, the owner notification, and the escalation row (mirrors gitSyncStallDiagnosis). */
export function gitSyncEligibilityLossDiagnosis(
  installSlug: string,
  skipReason: string | null,
): { summary: string; title: string; why: string } {
  const reasonText = skipReason ?? 'unknown reason';
  return {
    summary:
      `git-sync went INELIGIBLE on ${installSlug} (${reasonText}) after previously committing — ` +
      `origin/staging will freeze SILENTLY unless this is intentional.`,
    title: 'git-sync ELIGIBILITY LOST — a previously-active repo stopped syncing',
    why:
      `Why it matters: this routine landed commits before, then the P-008 eligibility gate started ` +
      `skipping every tick (reason: ${reasonText}) — origin freezes exactly like the 2026-06-20 ` +
      `incident (EI-1835) and nothing else pages for it (the stall detector deliberately exempts ` +
      `gated 'skipped' ticks). Claim it: confirm whether this is INTENTIONAL (the repo was ` +
      `retired/merged/moved — clear this git-sync routine) or a REGRESSION (a registry flag flipped ` +
      `unexpectedly, e.g. hive_home/remote_hive_view/no_path/not_a_git_repo — inspect the ` +
      `harness_registry entry for ${installSlug} and restore eligibility before the tree strands).`,
  };
}

/** Pure: the `harness_escalations` body for a watchdog-detected eligibility-loss (mirrors
 *  gitSyncStallEscalationBody — a separate phase/kind, never confused with a stall escalation). */
export function gitSyncEligibilityLossEscalationBody(opts: {
  installSlug: string;
  skipReason: string | null;
  ineligibleSweeps: number;
  nowMs: number;
}): string {
  return JSON.stringify({
    kind: ELIGIBILITY_WATCHDOG_KIND,
    harness_slug: opts.installSlug,
    skipReason: opts.skipReason,
    ineligibleSweeps: opts.ineligibleSweeps,
    emitted_at: opts.nowMs,
    detail: `git-sync eligibility lost (watchdog): ${
      gitSyncEligibilityLossDiagnosis(opts.installSlug, opts.skipReason).why
    }`,
  });
}

/** One sweep's pure head-movement-clock decision (WI-41567): whether to (re)write
 *  `wd_head_sha`/`wd_head_since_ms` and what `headUnchangedMs` this sweep should judge. */
export interface HeadClockDecision {
  /** persist `wd_head_sha = headSha`, `wd_head_since_ms = now` this sweep. */
  reset: boolean;
  /** why the clock reset (null when it didn't). */
  resetReason: 'head-advanced' | 'commit-not-attemptable' | null;
  /** the headUnchangedMs the stall verdict should see this sweep (null = no head recorded). */
  headUnchangedMs: number | null;
}

/**
 * Pure: maintain the head-movement clock for one sweep (WI-41567 false-STRANDING fix).
 *
 * The stranding clock must measure time-since-FAULT-ONSET, not time-since-last-commit: an
 * idle install legitimately freezes HEAD across clean 'nothing' / gated 'skipped' ticks, so
 * those sweeps RE-ARM the clock instead of letting idle time accumulate. Without this, a
 * long-idle install whose NEXT tick hits a LOCAL-stage fetch/push error (local_sync_status
 * = 'error' ⇒ attemptable) read hours of idle headUnchangedMs as fault-frozen and paged the
 * STRANDING verdict ("code strands uncommitted") on a CLEAN tree — the 2026-08-25
 * papercusp-public-site false alarm. The prior fix (EI-20625652898058188) exempted
 * bridge-leg errors via localSyncStatus but was blind when the local stage itself errors.
 * With the re-arm, an idle→error transition yields headUnchangedMs ≈ one sweep interval
 * (< headStaleMs), so commitStale stays false and the persistent-fault streak (errorStall,
 * ≥2 sweeps) fires the correct FAULTING (non-stranding) diagnosis instead.
 *
 * A TRUE stall (EI-7531: dirty tree, statuses continuously attemptable) never matches the
 * re-arm branch, so its clock still accumulates from fault onset and alarms as before.
 */
export function decideHeadClock(
  s: {
    /** the tree HEAD git-sync last recorded (`local_sync_head_sha` / `head_sha`). */
    headSha: string | null;
    /** the watchdog's own tracked head (`wd_head_sha`). */
    wdHeadSha: string | null;
    /** epoch ms the tracked head has been unchanged since (`wd_head_since_ms`). */
    wdHeadSinceMs: number | null;
    /** the local-stage status of the last tick (authoritative for attemptability). */
    localSyncStatus: string | null;
    /** the top-level status (pre-stage-record fallback). */
    lastStatus: string | null;
  },
  now: number,
): HeadClockDecision {
  if (s.headSha == null) {
    return { reset: false, resetReason: null, headUnchangedMs: null }; // no head yet ⇒ can't judge
  }
  if (s.wdHeadSha !== s.headSha || s.wdHeadSinceMs == null) {
    // HEAD advanced (or first observation) ⇒ record it + (re)start the clock.
    return { reset: true, resetReason: 'head-advanced', headUnchangedMs: 0 };
  }
  if (isCommitNotAttemptableStatus(s.localSyncStatus, s.lastStatus)) {
    // Idle/gated tick: frozen HEAD is definitional here — keep the clock armed at "now" so
    // it only starts accumulating once a tick where a commit WAS attemptable freezes HEAD.
    return { reset: true, resetReason: 'commit-not-attemptable', headUnchangedMs: 0 };
  }
  return { reset: false, resetReason: null, headUnchangedMs: now - s.wdHeadSinceMs };
}

/**
 * Pure: decide whether one ACTIVE git-sync routine is in a silent stall. Exported for unit
 * testing (the DB wiring + head-movement tracking is in checkGitSyncStall / integration-covered).
 *
 * A never-fired routine (`lastFiredMs === null`) is a fresh seed — never alarms on fire-staleness.
 */
export function evaluateGitSyncStall(
  s: GitSyncStallSnapshot,
  now: number,
  opts: GitSyncStallThresholds = {},
): GitSyncStallVerdict {
  const headStaleMs = opts.headStaleMs ?? DEFAULT_HEAD_STALE_MS;
  const fireStaleMs = opts.fireStaleMs ?? DEFAULT_FIRE_STALE_MS;
  const persistentReapMin = opts.persistentReapMin ?? DEFAULT_PERSISTENT_REAP_MIN;
  const errorStallMinSweeps = opts.errorStallMinSweeps ?? DEFAULT_ERROR_STALL_MIN_SWEEPS;

  // FALSE-ALARM FIX (2026-07-02): an idle hive legitimately never moves HEAD — its
  // git-sync fires and records status 'nothing' (clean tree, nothing to commit).
  // Alarming "commits are NOT landing; code is stranding" on a CLEAN tree cried wolf
  // on 5 stopped hives simultaneously (hiveloop/hive-canary/shared-hive-test/
  // hello-world/spoon-knife, each 12×'nothing'/2h, working trees verified clean).
  // A head-stale verdict now requires evidence of WORK: the last sync status must
  // NOT be the clean-tree 'nothing'. Fire-stale / error / reap stalls are
  // status-independent and unchanged (a dead engine can't report anything).
  //
  // FALSE-ALARM FIX (2026-07-03, same class via 'skipped'): a fire the P-008
  // eligibility gate SKIPS (no_path / hive_home / remote_hive_view / …) never
  // even runs the pipeline, so HEAD frozen across skips is definitional, not a
  // stall. Live incident: a federation test rig teardown deleted the
  // hello-world/spoon-knife lane clones; their routines kept firing 'skipped'/
  // no_path and the frozen HEAD urgently paged "code is stranding" for checkouts
  // that no longer EXISTED. Commit-staleness therefore requires a status where a
  // commit was ATTEMPTABLE — not clean-idle 'nothing', not gated 'skipped' (the
  // skip stays loud in metadata.last_skip_reason / schedule:inventory).
  // EI-2994: if routinesTick itself is stale, git-sync fire/commit staleness is
  // a downstream symptom of the background engine freeze. The request-path
  // infra-liveness alarm owns the single root-cause escalation and auto-resolve;
  // this watchdog should not add a second "git-sync failing" page/broadcast for
  // the same incident. Unknown liveness is fail-open.
  const rootEngineStale = s.routineEngineStale === true;
  // The bridge leg can promote a remote egress failure into top-level `lastStatus: error`
  // after a clean local `nothing`/`synced` result — the shared predicate prefers the local
  // stage record for this commit-only decision (fallback pre-EI-20315742298217655).
  const commitNotAttemptable = isCommitNotAttemptableStatus(s.localSyncStatus, s.lastStatus);
  // EI-21154752873591799 / WI-40600: the HEAD clock can already be stale when a new, healthy
  // local-sync fire begins. The colliding cron tick then records `skipped-locked` while the
  // real fire holds the writer-backed `git_sync_activity` marker, and the watchdog used to page
  // before that fire had any chance to commit. Give only a FRESH local-sync one normal stall
  // window. A killed/stuck fire leaves the original started_at behind and becomes actionable
  // once the same threshold elapses; fire/error/reaper signals remain independent below.
  const activeLocalSyncAgeMs = s.activeLocalSyncStartedAtMs == null
    ? null
    : Math.max(0, now - s.activeLocalSyncStartedAtMs);
  const freshLocalSync = activeLocalSyncAgeMs != null && activeLocalSyncAgeMs <= headStaleMs;
  const commitStale = !rootEngineStale
    && !freshLocalSync
    && !commitNotAttemptable
    && s.headUnchangedMs != null
    && s.headUnchangedMs > headStaleMs;
  const fireStale = !rootEngineStale && s.lastFiredMs != null && now - s.lastFiredMs > fireStaleMs;
  // FALSE-ALARM FIX (2026-07-02, second class): a fault observed on a SINGLE sweep is
  // transient (a push/fetch blip git-sync clears on its next healthy 3-min tick) — it must
  // persist across consecutive sweeps before it alarms. commitStale stays the backstop for
  // faults that genuinely freeze HEAD (2026-07-02 hiveloop: 2.5h frozen head still alarms).
  const hasError = typeof s.lastError === 'string' && s.lastError.trim().length > 0;
  const errorSweeps = hasError ? (s.errorSweeps ?? 1) : 0;
  const errorStall = !rootEngineStale && errorSweeps >= errorStallMinSweeps;
  const errorHeadline = hasError ? gitSyncErrorHeadline(s.lastError!) : null;
  const persistentReap = !rootEngineStale && (s.reapedCount ?? 0) >= persistentReapMin;
  const stalled = commitStale || fireStale || errorStall || persistentReap;

  let reason: string | null = null;
  if (stalled) {
    const parts: string[] = [];
    if (commitStale && s.headUnchangedMs != null) {
      parts.push(
        `the tree HEAD has not advanced in ~${hrs(s.headUnchangedMs)}h while the routine is active — commits are NOT landing (code strands uncommitted + un-deployable)`,
      );
    }
    if (fireStale && s.lastFiredMs != null) {
      parts.push(`the routine has not FIRED in ~${hrs(now - s.lastFiredMs)}h (active, cron every 3 min) — the scheduler/engine is not running it`);
    }
    if (persistentReap) {
      parts.push(
        `the DBOS executor reaper has cancelled ${s.reapedCount} consecutive git-sync fire(s) — fires start but never complete a commit (reap→requeue→restart loop; WI-1415)`,
      );
    }
    if (errorStall) {
      parts.push(
        `git-sync has recorded a FAULT on ${errorSweeps} consecutive watchdog sweeps (persistent, not a blip): "${gitSyncErrorContext(s.lastError!)}"`,
      );
    }
    reason = parts.join('; ');
  }
  return { stalled, commitStale, fireStale, errorStall, persistentReap, reason, errorHeadline };
}

/**
 * Pure: given the raw stall verdict and the consecutive-stalled-sweep count (INCLUDING the
 * current sweep), decide whether the stall has SUSTAINED long enough to broadcast (EI-9030b).
 * A first-observed stall (`stallSweeps === 1`) is held back for one more sweep so a transient
 * that self-heals within the sweep interval never pages. Exported for the debounce-edge test.
 */
export function shouldAlarmSustained(
  stalled: boolean,
  stallSweeps: number,
  minSweeps: number = DEFAULT_STALL_SUSTAIN_MIN_SWEEPS,
): boolean {
  return stalled && stallSweeps >= minSweeps;
}

/** Pure: the next consecutive-stalled-sweep counter — increment while stalled, reset to 0 on a
 *  healthy sweep. Mirrors the `wd_error_sweeps` streak accounting (EI-9030b). */
export function nextStallSweeps(stalled: boolean, prevStallSweeps: number): number {
  return stalled ? prevStallSweeps + 1 : 0;
}

/** Pure: the `harness_escalations` body for a watchdog-detected git-sync stall (testable). */
export function gitSyncStallEscalationBody(opts: {
  installSlug: string;
  verdict: GitSyncStallVerdict;
  lastFiredMs: number | null;
  headUnchangedMs: number | null;
  lastStatus: string | null;
  nowMs: number;
}): string {
  return JSON.stringify({
    kind: WATCHDOG_KIND,
    harness_slug: opts.installSlug,
    commitStale: opts.verdict.commitStale,
    fireStale: opts.verdict.fireStale,
    errorStall: opts.verdict.errorStall,
    persistentReap: opts.verdict.persistentReap,
    lastFiredAt: opts.lastFiredMs != null ? new Date(opts.lastFiredMs).toISOString() : null,
    headUnchangedHrs: opts.headUnchangedMs != null ? hrs(opts.headUnchangedMs) : null,
    lastStatus: opts.lastStatus,
    emitted_at: opts.nowMs,
    /** Which failure MODE this is — a stranding stall vs a failing leg with HEAD still advancing.
     *  Consumers should branch on this rather than re-deriving it from the four signal flags. */
    stranding: isStrandingVerdict(opts.verdict),
    detail: `git-sync ${isStrandingVerdict(opts.verdict) ? 'silent stall' : 'persistent fault streak'} (watchdog): ${
      opts.verdict.reason
    }. ${gitSyncStallDiagnosis(opts.verdict, opts.installSlug).why}`,
  });
}

export interface GitSyncStallWatchdogResult {
  alarmed: string[];
  recovered: string[];
  /** EI-1835: install_slugs the eligibility-loss detector alarmed on THIS sweep — a separate alert
   *  class from `alarmed` (stall), additive so existing readers of `alarmed`/`recovered` alone are
   *  unaffected. */
  eligibilityAlarmed: string[];
  /** EI-1835: install_slugs whose eligibility-loss alarm RESOLVED (eligible again) this sweep. */
  eligibilityRecovered: string[];
}

/**
 * One watchdog pass: scan every ACTIVE git-sync routine, maintain the head-movement clock, alarm
 * once per stall transition (cross-process exactly-once via a conditional flag flip), broadcast
 * to the fleet, and clear the flag + escalation on recovery. Never throws.
 */
export async function checkGitSyncStall(
  sql: Sql,
  opts: GitSyncStallThresholds = {},
): Promise<GitSyncStallWatchdogResult> {
  const out: GitSyncStallWatchdogResult = {
    alarmed: [],
    recovered: [],
    eligibilityAlarmed: [],
    eligibilityRecovered: [],
  };
  try {
    const rows = await sql<
      {
        install_slug: string;
        workspace_id: string;
        last_fired_ms: string | number | null;
        head_sha: string | null;
        wd_head_sha: string | null;
        wd_head_since_ms: string | number | null;
        last_status: string | null;
        local_sync_status: string | null;
        last_error: string | null;
        last_skip_reason: string | null;
        watchdog_alerted: boolean | null;
        reaped_count: number | null;
        wd_error_sweeps: number | null;
        wd_stall_sweeps: number | null;
        wd_ineligible_sweeps: number | null;
        eligibility_alerted: boolean | null;
        git_sync_activity: unknown;
      }[]
    >`
      SELECT install_slug,
             workspace_id,
             extract(epoch from last_fired_at) * 1000 AS last_fired_ms,
             COALESCE(metadata->>'local_sync_head_sha', metadata->>'head_sha') AS head_sha,
             metadata->>'wd_head_sha' AS wd_head_sha,
             (metadata->>'wd_head_since_ms')::bigint AS wd_head_since_ms,
             metadata->>'last_status' AS last_status,
             metadata->>'local_sync_status' AS local_sync_status,
             metadata->>'last_error' AS last_error,
             metadata->>'last_skip_reason' AS last_skip_reason,
             COALESCE((metadata->>'watchdog_alerted')::boolean, false) AS watchdog_alerted,
             COALESCE((metadata->>'reaped_count')::int, 0) AS reaped_count,
             COALESCE((metadata->>'wd_error_sweeps')::int, 0) AS wd_error_sweeps,
             COALESCE((metadata->>'wd_stall_sweeps')::int, 0) AS wd_stall_sweeps,
             COALESCE((metadata->>'wd_ineligible_sweeps')::int, 0) AS wd_ineligible_sweeps,
             COALESCE((metadata->>'eligibility_alerted')::boolean, false) AS eligibility_alerted,
             metadata->'git_sync_activity' AS git_sync_activity
        FROM harness_shared.routines
       WHERE target_role = 'system:git-sync'
         AND active = true`;

    const now = Date.now();
    const routineEngine = await readRoutineEngineLiveness(sql, { nowMs: now });
    const stallSustainMinSweeps = opts.stallSustainMinSweeps ?? DEFAULT_STALL_SUSTAIN_MIN_SWEEPS;
    const eligibilitySustainMinSweeps =
      opts.eligibilitySustainMinSweeps ?? DEFAULT_ELIGIBILITY_SUSTAIN_MIN_SWEEPS;
    // EI-9030b: harnesses that recovered from OUR alarm THIS sweep — broadcast ONE
    // coalesced all-clear after the loop instead of one message per harness.
    const recoveredForBroadcast: string[] = [];
    // EI-1835: same coalescing, for the separate eligibility-loss alert class.
    const eligibilityRecoveredForBroadcast: string[] = [];
    for (const row of rows) {
      const lastFiredMs = row.last_fired_ms != null ? Number(row.last_fired_ms) : null;
      const wdHeadSinceMs = row.wd_head_since_ms != null ? Number(row.wd_head_since_ms) : null;
      const watchdogAlerted = row.watchdog_alerted ?? false;
      const activity = row.git_sync_activity && typeof row.git_sync_activity === 'object'
        ? row.git_sync_activity as Record<string, unknown>
        : null;
      const activeLocalSyncStartedAtMs = activity?.active === true && activity.phase === 'local-sync'
        ? Number(activity.started_at)
        : null;

      // ── Head-movement clock: reset when HEAD advances (or first observation), AND on any
      // commit-not-attemptable tick (WI-41567: idle frozen HEAD is definitional — the clock
      // must accumulate from FAULT ONSET, not from the last commit; see decideHeadClock). ──
      const clock = decideHeadClock(
        {
          headSha: row.head_sha,
          wdHeadSha: row.wd_head_sha,
          wdHeadSinceMs,
          localSyncStatus: row.local_sync_status,
          lastStatus: row.last_status,
        },
        now,
      );
      if (clock.reset) {
        await sql`
          UPDATE harness_shared.routines
             SET metadata = COALESCE(metadata, '{}'::jsonb)
                   || jsonb_build_object('wd_head_sha', ${row.head_sha}::text, 'wd_head_since_ms', ${now}::bigint),
                 updated_at = now()
           WHERE install_slug = ${row.install_slug}
             AND target_role = 'system:git-sync'`;
      }
      const headUnchangedMs = clock.headUnchangedMs;

      // ── Fault-persistence streak: consecutive sweeps observing a fault (incl. this one).
      // git-sync NULLS last_error on any healthy tick, so a fault still present a full sweep
      // interval later has survived ~5+ runs — persistent. Reset to 0 the moment it clears.
      const hasError = typeof row.last_error === 'string' && row.last_error.trim().length > 0;
      const prevErrorSweeps = row.wd_error_sweeps != null ? Number(row.wd_error_sweeps) : 0;
      const errorSweeps = hasError ? prevErrorSweeps + 1 : 0;
      if (errorSweeps !== prevErrorSweeps) {
        await sql`
          UPDATE harness_shared.routines
             SET metadata = COALESCE(metadata, '{}'::jsonb)
                   || jsonb_build_object('wd_error_sweeps', ${errorSweeps}::int),
                 updated_at = now()
           WHERE install_slug = ${row.install_slug}
             AND target_role = 'system:git-sync'`;
      }

      const verdict = evaluateGitSyncStall(
        {
          lastFiredMs,
          headUnchangedMs,
          lastError: row.last_error,
          errorSweeps,
          lastStatus: row.last_status,
          localSyncStatus: row.local_sync_status,
          watchdogAlerted,
          reapedCount: row.reaped_count != null ? Number(row.reaped_count) : 0,
          routineEngineStale: routineEngine.stale,
          activeLocalSyncStartedAtMs: Number.isFinite(activeLocalSyncStartedAtMs)
            ? activeLocalSyncStartedAtMs
            : null,
        },
        now,
        opts,
      );

      // ── EI-9030b sustain streak: consecutive sweeps the verdict has been stalled (incl. this
      // one). Persisted (like wd_error_sweeps) so it survives across the 15-min process-level
      // sweeps and across the several hosts that run this watchdog. Reset to 0 the moment healthy.
      const prevStallSweeps = row.wd_stall_sweeps != null ? Number(row.wd_stall_sweeps) : 0;
      const stallSweeps = nextStallSweeps(verdict.stalled, prevStallSweeps);
      if (stallSweeps !== prevStallSweeps) {
        await sql`
          UPDATE harness_shared.routines
             SET metadata = COALESCE(metadata, '{}'::jsonb)
                   || jsonb_build_object('wd_stall_sweeps', ${stallSweeps}::int),
                 updated_at = now()
           WHERE install_slug = ${row.install_slug}
             AND target_role = 'system:git-sync'`;
      }

      // ── EI-1835: eligibility-loss edge detector — a SIBLING signal to the stall verdict above,
      // not a branch of it. Placed BEFORE the stall block's `continue`s below so it always runs
      // for every row regardless of which path the (independent) stall verdict takes this sweep.
      const currentlyIneligible =
        row.last_status === 'skipped' &&
        typeof row.last_skip_reason === 'string' &&
        ELIGIBILITY_SKIP_REASONS.has(row.last_skip_reason);
      const everActive = row.head_sha != null;
      const prevIneligibleSweeps = row.wd_ineligible_sweeps != null ? Number(row.wd_ineligible_sweeps) : 0;
      const ineligibleSweeps = currentlyIneligible ? prevIneligibleSweeps + 1 : 0;
      if (ineligibleSweeps !== prevIneligibleSweeps) {
        await sql`
          UPDATE harness_shared.routines
             SET metadata = COALESCE(metadata, '{}'::jsonb)
                   || jsonb_build_object('wd_ineligible_sweeps', ${ineligibleSweeps}::int),
                 updated_at = now()
           WHERE install_slug = ${row.install_slug}
             AND target_role = 'system:git-sync'`;
      }
      const eligibilityAlerted = row.eligibility_alerted ?? false;
      const eligVerdict = evaluateGitSyncEligibilityLoss(
        { currentlyIneligible, everActive, ineligibleSweeps, eligibilityAlerted },
        eligibilitySustainMinSweeps,
      );
      if (currentlyIneligible) {
        if (eligVerdict.shouldAlarm) {
          // Cross-process exactly-once: only the writer that flips eligibility_alerted false→true alarms.
          const eligFlip = await sql`
            UPDATE harness_shared.routines
               SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"eligibility_alerted":true}'::jsonb,
                   updated_at = now()
             WHERE install_slug = ${row.install_slug}
               AND target_role = 'system:git-sync'
               AND COALESCE((metadata->>'eligibility_alerted')::boolean, false) = false`;
          if (eligFlip.count === 1) {
            const diagnosis = gitSyncEligibilityLossDiagnosis(row.install_slug, row.last_skip_reason);
            try {
              const { notifyAttention } = await import('../attention-notify');
              await notifyAttention({
                kind: 'intervention',
                title: diagnosis.title,
                body: `git-sync (${row.install_slug}): ${diagnosis.summary}`,
                importance: 'urgent',
                workspaceId: row.workspace_id,
                data: { skipReason: row.last_skip_reason, ineligibleSweeps },
              });
            } catch (e) {
              console.warn(
                `[git-sync-stall-watchdog] eligibility-loss notify failed: ${e instanceof Error ? e.message : e}`,
              );
            }
            // Same fleet-broadcast shape as the stall alarm: inject-only (wake=false), one-shot
            // until the paired recovery below (our silence is deliberate, never evidence it re-admitted).
            await broadcastSevereEvent({
              summary: diagnosis.summary,
              body: diagnosis.why,
              category: 'severe-event',
              conditionKey: `git-sync-eligibility-loss:${row.install_slug}`,
              oneShot: true,
            });
            try {
              await sql`
                INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
                VALUES (${row.install_slug}, ${ELIGIBILITY_WATCHDOG_PHASE}, ${gitSyncEligibilityLossEscalationBody({
                  installSlug: row.install_slug,
                  skipReason: row.last_skip_reason,
                  ineligibleSweeps,
                  nowMs: now,
                })}, ${now}, ${row.workspace_id})
                ON CONFLICT (harness_slug, phase)
                DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`;
            } catch (e) {
              console.warn(
                `[git-sync-stall-watchdog] eligibility-loss escalation write failed: ${e instanceof Error ? e.message : e}`,
              );
            }
            out.eligibilityAlarmed.push(row.install_slug);
            console.warn(
              `[git-sync-stall-watchdog] ELIGIBILITY-LOSS ALARM ${row.install_slug}: ${row.last_skip_reason}`,
            );
          }
        }
        // else: ineligible but not (yet) alarming — never active, already alerted, or not yet
        // sustained across eligibilitySustainMinSweeps. Deliberately touches NOTHING else: while
        // an alarm is live (eligibilityAlerted:true) the escalation row must stay in place, so the
        // convergence step below is scoped to the ELIGIBLE branch only (mirrors the stall detector).
      } else {
        // Eligible this sweep — converge the escalation row unconditionally (not only when OUR
        // flag is set), same multi-host-race defense the stall detector uses above.
        const eligCleared = await sql`
          UPDATE harness_shared.harness_escalations
             SET escalation = NULL, mtime_ms = ${now}
           WHERE harness_slug = ${row.install_slug}
             AND phase = ${ELIGIBILITY_WATCHDOG_PHASE}
             AND escalation IS NOT NULL`;
        if (eligVerdict.shouldResolve) {
          await sql`
            UPDATE harness_shared.routines
               SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"eligibility_alerted":false}'::jsonb,
                   updated_at = now()
             WHERE install_slug = ${row.install_slug}
               AND target_role = 'system:git-sync'`;
          eligibilityRecoveredForBroadcast.push(row.install_slug);
          out.eligibilityRecovered.push(row.install_slug);
        } else if (eligCleared.count > 0) {
          console.warn(
            `[git-sync-stall-watchdog] cleared a STRANDED eligibility-loss escalation for ${row.install_slug} (alerted flag was already false — flag/escalation divergence, likely a multi-host race)`,
          );
        }
      }

      if (verdict.stalled) {
        if (watchdogAlerted) continue; // already alarmed; one-shot until recovery
        // EI-9030b: hold back a not-yet-SUSTAINED stall — a transient that self-heals before the
        // next sweep confirms it never pages (and so never emits a paired recovery notice). The
        // per-signal thresholds judged ONE sweep; this requires the verdict to persist across
        // consecutive sweeps, the edge-triggering the fleet's 6 flapping hive stalls lacked.
        if (!shouldAlarmSustained(verdict.stalled, stallSweeps, stallSustainMinSweeps)) continue;
        // Cross-process exactly-once: only the writer that flips watchdog_alerted false→true alarms.
        const flip = await sql`
          UPDATE harness_shared.routines
             SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"watchdog_alerted":true}'::jsonb,
                 updated_at = now()
           WHERE install_slug = ${row.install_slug}
             AND target_role = 'system:git-sync'
             AND COALESCE((metadata->>'watchdog_alerted')::boolean, false) = false`;
        if (flip.count !== 1) continue; // another process won the flip

        // Say what the verdict actually is: a frozen-HEAD/fire/reap stall strands code; a pure
        // persistent-fault streak is a FAILING LEG with HEAD still advancing. One derivation
        // feeds the broadcast, the notification and the escalation row so they cannot disagree.
        const diagnosis = gitSyncStallDiagnosis(verdict, row.install_slug);
        const summary = diagnosis.summary;
        try {
          const { notifyAttention } = await import('../attention-notify');
          await notifyAttention({
            kind: 'intervention',
            title: diagnosis.title,
            body: `git-sync (${row.install_slug}): ${verdict.reason}. ${diagnosis.why}`,
            importance: 'urgent',
            workspaceId: row.workspace_id,
            data: { commitStale: verdict.commitStale, fireStale: verdict.fireStale, errorStall: verdict.errorStall, persistentReap: verdict.persistentReap },
          });
        } catch (e) {
          console.warn(`[git-sync-stall-watchdog] notify failed: ${e instanceof Error ? e.message : e}`);
        }
        // Fleet broadcast (owner-requested): inject-only (wake=false) so every running agent sees
        // it next turn and someone can claim it, without a wake storm.
        await broadcastSevereEvent({
          summary,
          body: `${verdict.reason}\n\n${diagnosis.why}`,
          category: 'severe-event',
          // WI-1444 condition lifecycle: recovery below broadcasts the matching
          // resolution, so late inbox readers see this alarm annotated resolved.
          conditionKey: `git-sync-stall:${row.install_slug}`,
          // WI-6228: one-shot until recovery (`watchdogAlerted` above) — our
          // silence is deliberate, never evidence git-sync started committing.
          oneShot: true,
        });
        try {
          await sql`
            INSERT INTO harness_shared.harness_escalations (harness_slug, phase, escalation, mtime_ms, workspace_id)
            VALUES (${row.install_slug}, ${WATCHDOG_PHASE}, ${gitSyncStallEscalationBody({
              installSlug: row.install_slug,
              verdict,
              lastFiredMs,
              headUnchangedMs,
              lastStatus: row.last_status,
              nowMs: now,
            })}, ${now}, ${row.workspace_id})
            ON CONFLICT (harness_slug, phase)
            DO UPDATE SET escalation = EXCLUDED.escalation, mtime_ms = EXCLUDED.mtime_ms`;
        } catch (e) {
          console.warn(`[git-sync-stall-watchdog] escalation write failed: ${e instanceof Error ? e.message : e}`);
        }
        out.alarmed.push(row.install_slug);
        console.warn(`[git-sync-stall-watchdog] ALARM ${row.install_slug}: ${verdict.reason}`);
      } else {
        // Healthy. ALWAYS converge the escalation row — not only when OUR flag is set.
        // Multiple hosts run this watchdog concurrently (bg-host / staging / release
        // bootstraps), on DIFFERENT code versions during the staging→release lag; a
        // raced or wiped `watchdog_alerted` flag used to strand a non-null escalation
        // forever (observed live 2026-07-02: shared-hive-test carried a 4h-old cleared-
        // alarm escalation with alerted=false — the `else if (alerted)` gate meant no
        // healthy sweep could ever null it). The UPDATE is idempotent + row-scoped, so
        // running it on every healthy sweep is a no-op unless something is stranded.
        const cleared = await sql`
          UPDATE harness_shared.harness_escalations
             SET escalation = NULL, mtime_ms = ${now}
           WHERE harness_slug = ${row.install_slug}
             AND phase = ${WATCHDOG_PHASE}
             AND escalation IS NOT NULL`;
        if (watchdogAlerted) {
          // Recovered from OUR alarm: clear the flag + supersede the fleet broadcast.
          await sql`
            UPDATE harness_shared.routines
               SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"watchdog_alerted":false}'::jsonb,
                   updated_at = now()
             WHERE install_slug = ${row.install_slug}
               AND target_role = 'system:git-sync'`;
          // WI-1444 + EI-9030b: supersede the fleet alarm, but COALESCED — collect this
          // recovery and emit ONE all-clear after the loop (a shared root-cause, e.g. a DBOS
          // engine wedge, recovers many harnesses in the same sweep; one message per harness
          // was the inbox noise the retro flagged). coord:inbox still annotates every prior
          // `git-sync-stall:<slug>` broadcast resolved via the message's `resolves_conditions`.
          recoveredForBroadcast.push(row.install_slug);
          out.recovered.push(row.install_slug);
        } else if (cleared.count > 0) {
          console.warn(
            `[git-sync-stall-watchdog] cleared a STRANDED escalation for ${row.install_slug} (alerted flag was already false — flag/escalation divergence, likely a multi-host race)`,
          );
        }
      }
    }
    // EI-9030b: ONE coalesced all-clear for every harness that recovered this sweep, carrying
    // all their condition keys so coord:inbox supersedes each prior stall alarm. (0 → no-op.)
    if (recoveredForBroadcast.length > 0) {
      const list = recoveredForBroadcast.join(', ');
      await broadcastSevereEventResolvedMany({
        conditionKeys: recoveredForBroadcast.map((slug) => `git-sync-stall:${slug}`),
        summary:
          recoveredForBroadcast.length === 1
            ? `git-sync RECOVERED on ${list} — commits are landing again; the earlier stall alarm is stale.`
            : `git-sync RECOVERED on ${recoveredForBroadcast.length} harnesses (${list}) — commits are landing again; the earlier stall alarms are stale.`,
      });
    }
    // EI-1835: ONE coalesced all-clear for every harness whose eligibility-loss alarm resolved
    // this sweep — the sibling of the stall coalesced broadcast above, separate condition-key
    // namespace so it never supersedes/confuses a stall alarm.
    if (eligibilityRecoveredForBroadcast.length > 0) {
      const list = eligibilityRecoveredForBroadcast.join(', ');
      await broadcastSevereEventResolvedMany({
        conditionKeys: eligibilityRecoveredForBroadcast.map((slug) => `git-sync-eligibility-loss:${slug}`),
        summary:
          eligibilityRecoveredForBroadcast.length === 1
            ? `git-sync ELIGIBILITY RESTORED on ${list} — syncing again; the earlier eligibility-loss alarm is stale.`
            : `git-sync ELIGIBILITY RESTORED on ${eligibilityRecoveredForBroadcast.length} harnesses (${list}) — syncing again; the earlier eligibility-loss alarms are stale.`,
      });
    }
    return out;
  } catch (e) {
    console.warn(`[git-sync-stall-watchdog] pass failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    return out;
  }
}

let watchdogTimer: ManagedHandle | null = null;

/**
 * Start the watchdog: an immediate boot check + a recurring process-level sweep. Idempotent.
 * Kill-switch: PAPERCUSP_GITSYNC_STALL_WATCHDOG='0'.
 */
export function startGitSyncStallWatchdog(
  sql: Sql,
  opts: GitSyncStallThresholds & { intervalMs?: number } = {},
): void {
  if (process.env.PAPERCUSP_GITSYNC_STALL_WATCHDOG === '0') return;
  const intervalMs = opts.intervalMs ?? DEFAULT_WATCHDOG_INTERVAL_MS;

  const run = (): void => {
    void checkGitSyncStall(sql, opts).then((r) => {
      if (r.alarmed.length > 0) {
        console.warn(`[git-sync-stall-watchdog] alarmed on: ${r.alarmed.join(', ')}`);
      }
    });
  };

  run(); // boot check
  if (watchdogTimer) watchdogTimer.stop();
  watchdogTimer = managedSetInterval('git-sync-stall-watchdog', intervalMs, run, { category: 'watchdog' });
}
