/**
 * condition-staleness-alarm — the periodic ACTOR for `coord:conditions` (WI-2965,
 * closing the EI-7347 signal-actor-registry waiver for the `coord-conditions` signal).
 *
 * `coord:conditions` (agent-tools/coordination/tools/conditions.ts, computeConditionStates)
 * folds condition-keyed severe-event broadcasts (severe-event-broadcast.ts) into current
 * open/resolved STATE, but is a pure READ — nothing periodically re-evaluates it and takes
 * action on a condition that stays open. This is the exact read-only-signal trap the
 * registry exists to catch (service-health-events.ts's own comment: "it never fires on a
 * transition").
 *
 * IMPORTANT — why this is NOT "escalate every open condition": every current condition
 * SOURCE (git-sync-stall-watchdog.ts, green-stall-watchdog.ts, mcp-dark-watchdog.ts,
 * embed-exhaustion-alert.ts) already fires an immediate owner `notifyAttention` the moment
 * its condition OPENS, alongside the `broadcastSevereEvent` that lands it in coord:conditions.
 * Re-alerting the owner at open-time here would double-fire on literally every condition.
 * The actual gap the waiver names is narrower: if that immediate alert goes unactioned and
 * the condition just... stays open, nobody ever escalates that it is STILL open. This tick
 * closes exactly that gap — nothing more:
 *
 *   A condition OPEN longer than `staleMs` gets ONE distinctly-keyed REMINDER escalation
 *   (`stale-condition:<condition_key>` — a signature namespace that can never collide with
 *   a source watchdog's own open-time signature), durably deduped + auto-resolved the moment
 *   `computeConditionStates` reports it resolved (or no longer stale), mirroring
 *   liveness-alarm.ts's EI-2146 dedup/auto-resolve/debounce architecture exactly so the two
 *   independent alarms never drift on shape.
 *
 * Best-effort + fail-soft: never throws, never blocks the request worker it runs on.
 */
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { getOrgPg } from '@papercusp/db-org';
import {
  computeConditionStates,
  readConditionEnvelopes,
  type ConditionState,
} from '../agent-tools/coordination/tools/conditions';
import {
  openEscalation,
  listEscalationsPaginated,
  resolveEscalation,
  type EscalationSeverity,
  type EscalationRecord,
} from '../agent-tools/coordination/escalations';
import type { AgentIdentity } from '../agent-tools/coordination/identity';
import { coordScopeWorkspace } from '../agent-tools/coordination/log';
import { SELF_RECONCILING_META_KEY } from '../attention/reconcile-escalations';
import { broadcastSevereEventResolvedMany } from '../severe-event-broadcast';
import {
  actionableConditionFor,
  reconcileConditions,
  resolveConditionHarness,
  type ConditionState as BridgeConditionState,
  type ReconcileSummary,
} from '../coord/condition-bridge';
import { operatorHomeHarnessSlug } from '../harness/operator-home-harness';
import {
  evaluateGitSyncStall,
  type GitSyncStallVerdict,
} from '../release/git-sync-stall-watchdog';
import {
  readRoutineEngineLiveness,
  type RoutineEngineLiveness,
} from '../release/routine-engine-liveness';
import { deriveGitSyncFreshness } from '../agent-tools/routines/list';
import type { SystemHealth } from './types';
import type { BeesLivenessContext } from './liveness-alarm';

export const CONDITION_STALENESS_IDENTITY: AgentIdentity = {
  ownerId: 'system:condition-staleness-alarm',
  ownerLabel: 'system · condition-staleness-alarm',
  source: 'principal',
  workspaceId: null,
  userId: null,
};

/** One "this condition has been open too long" reminder signal. */
export interface StaleConditionSignal {
  /** `stale-condition:<condition_key>` — the durable dedup/auto-resolve signature. */
  key: string;
  conditionKey: string;
  severity: EscalationSeverity;
  summary: string;
}

const DEFAULT_STALE_OPEN_MS = 45 * 60_000; // 45min: long enough that the source's own
// open-time notifyAttention has had a real chance to be seen/actioned before we nudge again.
const DEFAULT_DEBOUNCE_MS = 30 * 60_000; // re-nudge at most every 30min while still stale
const DEFAULT_INTERVAL_MS = 5 * 60_000;

// EI-15182: family-agnostic "has anyone actually observed this signal recently"
// threshold. Every source watchdog sweeps well under an hour (git-sync-stall
// 15min, single-primary-check 3min, the system-watchdog family ~10min per
// EI-15182's own evidence); embed-exhaustion is event-driven but still re-fires
// per outage window far more often than this. 2h gives every real watchdog
// several missed sweeps of margin before we treat its signal as gone quiet, while
// still being tiny next to the DAYS of staleness this bug actually produces.
const DEFAULT_SIGNAL_ABSENCE_MS = 2 * 60 * 60_000;

const GIT_SYNC_STALL_PREFIX = 'git-sync-stall:';

interface GitSyncHealthRow {
  install_slug: string;
  cron: string | null;
  last_synced_at: string | number | null;
  last_fired_ms: string | number | null;
  head_sha: string | null;
  wd_head_sha: string | null;
  wd_head_since_ms: string | number | null;
  last_status: string | null;
  local_sync_status: string | null;
  last_error: string | null;
  watchdog_alerted: boolean | null;
  reaped_count: number | null;
  wd_error_sweeps: number | null;
  git_sync_activity: unknown;
}

/**
 * A healthy-looking stall verdict is not enough to clear an open git-sync alarm:
 * the watchdog intentionally reports not-stalled while a new fire is still within
 * its observation window. Require the whole latest fire to have completed with a
 * successful outcome, and require that completion plus its last local-sync receipt
 * to fit inside the routine's canonical cadence-derived freshness window.
 */
export function hasFreshSuccessfulGitSyncCompletion(
  activityValue: unknown,
  freshness: Record<string, unknown>,
  now: number,
): boolean {
  if (!activityValue || typeof activityValue !== 'object' || Array.isArray(activityValue)) return false;
  const activity = activityValue as Record<string, unknown>;
  const completedAt = Number(activity.completed_at);
  const completionAgeMs = now - completedAt;
  const lastSyncAgeMs = freshness.age_ms;
  const staleAfterMs = freshness.stale_after_ms;
  return activity.active === false &&
    activity.phase === 'complete' &&
    Number.isFinite(completedAt) &&
    completionAgeMs >= 0 &&
    (activity.outcome_status === 'synced' || activity.outcome_status === 'nothing') &&
    freshness.status === 'fresh' &&
    typeof lastSyncAgeMs === 'number' &&
    Number.isFinite(lastSyncAgeMs) &&
    lastSyncAgeMs >= 0 &&
    typeof staleAfterMs === 'number' &&
    Number.isFinite(staleAfterMs) &&
    staleAfterMs > 0 &&
    completionAgeMs <= staleAfterMs &&
    lastSyncAgeMs <= staleAfterMs;
}

/**
 * Convert a git-sync stall verdict into an auto-clear decision only when the
 * routine engine is live enough to make that verdict meaningful.
 *
 * `evaluateGitSyncStall` deliberately suppresses its downstream signals when
 * the routine engine is stale: the engine freeze is the root cause, and a
 * quiet/old git-sync row cannot distinguish healthy from unevaluated. Treating
 * that suppressed `stalled:false` as healthy is a false all-clear, so stale or
 * unknown engine liveness must remain UNKNOWN (undefined) and fail open.
 */
export function verifiedGitSyncHealth(
  verdict: Pick<GitSyncStallVerdict, 'stalled'>,
  routineEngine: Pick<RoutineEngineLiveness, 'stale' | 'unknown'>,
  freshSuccessfulCompletion: boolean,
): boolean | undefined {
  if (routineEngine.unknown || routineEngine.stale || !freshSuccessfulCompletion) return undefined;
  return !verdict.stalled;
}

/**
 * Read the writer-backed git-sync state for open condition keys and reuse the
 * watchdog's pure verdict to decide whether the condition is healthy now.
 *
 * This is intentionally a READ-only companion to git-sync-stall-watchdog.ts.
 * The watchdog emits the recovery broadcast only on its next 15-minute sweep;
 * the condition actor runs every 5 minutes, so this closes the recovery-lag
 * window without duplicating the watchdog's alarm/write path. Missing rows or
 * an unreadable routine-engine clock stay UNKNOWN (no map entry), never healthy.
 */
async function defaultReadGitSyncHealth(
  openGitSyncKeys: readonly string[],
  now: number,
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  const installSlugs = [...new Set(
    openGitSyncKeys
      .filter((key) => key.startsWith(GIT_SYNC_STALL_PREFIX))
      .map((key) => key.slice(GIT_SYNC_STALL_PREFIX.length).trim())
      .filter(Boolean),
  )];
  if (installSlugs.length === 0) return out;

  try {
    const { sql } = getOrgPg();
    const [rows, routineEngine] = await Promise.all([
      sql<GitSyncHealthRow[]>`
        SELECT install_slug,
               trigger_config->>'cron' AS cron,
               metadata->>'last_synced_at' AS last_synced_at,
               extract(epoch from last_fired_at) * 1000 AS last_fired_ms,
               COALESCE(metadata->>'local_sync_head_sha', metadata->>'head_sha') AS head_sha,
               metadata->>'wd_head_sha' AS wd_head_sha,
               (metadata->>'wd_head_since_ms')::bigint AS wd_head_since_ms,
               metadata->>'last_status' AS last_status,
               metadata->>'local_sync_status' AS local_sync_status,
               metadata->>'last_error' AS last_error,
               COALESCE((metadata->>'watchdog_alerted')::boolean, false) AS watchdog_alerted,
               COALESCE((metadata->>'reaped_count')::int, 0) AS reaped_count,
               COALESCE((metadata->>'wd_error_sweeps')::int, 0) AS wd_error_sweeps,
               metadata->'git_sync_activity' AS git_sync_activity
          FROM harness_shared.routines
         WHERE target_role = 'system:git-sync'
           AND active = true
           AND workspace_id = ${coordScopeWorkspace()}
           AND install_slug = ANY(${installSlugs})`,
      readRoutineEngineLiveness(sql, { nowMs: now }),
    ]);

    // An unknown engine clock cannot prove that a healthy-looking routine is
    // actually live. Leave all keys unresolved so this backstop fails open.
    if (routineEngine.unknown) return out;

    for (const row of rows) {
      const headSinceMs = row.wd_head_since_ms == null ? null : Number(row.wd_head_since_ms);
      let headUnchangedMs: number | null;
      if (row.head_sha == null) {
        headUnchangedMs = null;
      } else if (row.wd_head_sha !== row.head_sha || headSinceMs == null) {
        // Match the watchdog's first-observation/HEAD-advanced behavior. The
        // next watchdog sweep will persist the new clock; this read must not.
        headUnchangedMs = 0;
      } else {
        headUnchangedMs = now - headSinceMs;
      }

      const activity = row.git_sync_activity && typeof row.git_sync_activity === 'object'
        ? row.git_sync_activity as Record<string, unknown>
        : null;
      const activeLocalSyncStartedAtMs = activity?.active === true && activity.phase === 'local-sync'
        ? Number(activity.started_at)
        : null;
      const hasError = typeof row.last_error === 'string' && row.last_error.trim().length > 0;
      const errorSweeps = hasError ? Math.max(1, Number(row.wd_error_sweeps ?? 0)) : 0;
      const verdict = evaluateGitSyncStall(
        {
          lastFiredMs: row.last_fired_ms == null ? null : Number(row.last_fired_ms),
          headUnchangedMs,
          lastError: row.last_error,
          errorSweeps,
          lastStatus: row.last_status,
          localSyncStatus: row.local_sync_status,
          watchdogAlerted: row.watchdog_alerted ?? false,
          reapedCount: Number(row.reaped_count ?? 0),
          routineEngineStale: routineEngine.stale,
          activeLocalSyncStartedAtMs: Number.isFinite(activeLocalSyncStartedAtMs)
            ? activeLocalSyncStartedAtMs
            : null,
        },
        now,
      );
      const freshness = deriveGitSyncFreshness(
        { last_synced_at: row.last_synced_at, git_sync_activity: row.git_sync_activity },
        row.cron,
        true,
        now,
      );
      const freshSuccessfulCompletion = hasFreshSuccessfulGitSyncCompletion(
        row.git_sync_activity,
        freshness,
        now,
      );
      const healthy = verifiedGitSyncHealth(verdict, routineEngine, freshSuccessfulCompletion);
      if (healthy !== undefined) {
        out.set(`${GIT_SYNC_STALL_PREFIX}${row.install_slug}`, healthy);
      }
    }
  } catch {
    // A read failure is unknown, never evidence that git-sync recovered.
  }
  return out;
}

/**
 * PURE: which currently-OPEN conditions have been open longer than `staleMs`, as of `now`.
 * A condition already resolved (per computeConditionStates) never appears here, regardless
 * of how long it took to resolve — this alarm is only about conditions still stuck open.
 *
 * EI-10653: the "how long has it been open" clock anchors on `open_since` (the CURRENT open
 * episode's start), NOT `first_seen` (the first-ever alarm). For a FLAPPING condition —
 * one that fires, recovers, and re-fires repeatedly (e.g. `infra-liveness:panel:infra`) —
 * first_seen stays pinned at the very first alarm forever, so anchoring on it reported a
 * condition that had recovered many times and only just reopened as "OPEN for 1967m" — a
 * misleading stuck-condition reminder for what was really a fresh flap. open_since gives
 * the age of the current continuous open episode, so a freshly-reopened flap reads young
 * (below staleMs) and only a genuinely-stuck condition trips the reminder.
 */
export function evaluateStaleConditions(
  states: readonly ConditionState[],
  now: number,
  staleMs: number = DEFAULT_STALE_OPEN_MS,
  absenceMs: number = DEFAULT_SIGNAL_ABSENCE_MS,
): StaleConditionSignal[] {
  const out: StaleConditionSignal[] = [];
  for (const s of states) {
    if (!s.open) continue;
    // Anchor on the current episode's start; fall back to first_seen only when a
    // (legacy / partial) fold left open_since unset for an open condition.
    const openSinceMs = Date.parse(s.open_since ?? s.first_seen);
    if (!Number.isFinite(openSinceMs)) continue;
    const ageMs = now - openSinceMs;
    if (ageMs <= staleMs) continue;
    // EI-15182: never re-page about a condition nobody has actually re-observed
    // recently. A row stuck open:true forever because its source watchdog simply
    // stopped emitting (dead/quiet pot, a one-shot event that never got an
    // explicit RECOVERED broadcast) has nothing new to report — the SAME check
    // the resolve-on-absence reconciler (runConditionStalenessTick, below) uses
    // to actually close the row. This check is independent of whether that
    // reconciler's broadcast succeeded this tick — suppression never depends on
    // a network call landing.
    const lastSeenMs = Date.parse(s.last_seen);
    if (Number.isFinite(lastSeenMs) && now - lastSeenMs > absenceMs) continue;
    out.push({
      key: `stale-condition:${s.condition_key}`,
      conditionKey: s.condition_key,
      severity: 'advisory',
      summary:
        `condition '${s.condition_key}' has been OPEN for ${Math.round(ageMs / 60_000)}m` +
        `${s.category ? ` (${s.category})` : ''} — latest: ${s.latest_summary ?? '(no summary)'}. ` +
        `This is a follow-up REMINDER only (the source already alerted the owner when it opened) — ` +
        `check coord:conditions / the source watchdog if it is genuinely stuck.`,
    });
  }
  return out;
}

// ── EI-14072 guard #2: reconcile a stuck-open row against verified-healthy signal ──
//
// Guard #1 (conditions.ts's batched `resolves_conditions` handling) fixes the
// specific bug that STARTED this ticket, but a stuck-open condition row can also
// arise from any OTHER dropped/never-sent resolution (a broadcast that silently
// failed, a watchdog restart between resolve+broadcast, …) — the class the
// waiver's follow-up asked for, not just this one instance. This reconciler is
// the durable backstop: independent of whether a resolution broadcast ever
// arrived, if the underlying signal is VERIFIED healthy right now, the row gets
// cleared.
//
// Scope: the `infra-liveness:*` condition family (panel:overwatch, panel:bees,
// dead-routines, queen-dark, overwatch-dark, health-tick-stale, accounts-starved,
// pg-restarted, autoloop-fire-stale:*, and the panel:* catch-all) — every
// condition liveness-alarm.ts's own `evaluateLivenessAlarm` sources, so "is the
// signal healthy" is the SAME live computation the watchdog itself alarms from;
// this can never disagree with it. The `git-sync-stall:*` family is also checked
// against the active routine's writer-backed metadata using the source watchdog's
// `evaluateGitSyncStall` verdict. Other condition families remain fail-open until
// their own source-specific health computation exists.

const INFRA_LIVENESS_PREFIX = 'infra-liveness:';

/**
 * PURE (EI-15182 guard #3): of the currently-OPEN condition states, which
 * ones have gone SIGNAL-ABSENT — no new alarm observed (`last_seen`) in over
 * `absenceMs` — as of `now`. Unlike `selectReconcilableConditions` (guard #2,
 * infra-liveness-only, requires a live health re-check), this needs no
 * per-family knowledge: a source watchdog that is still actually observing a
 * problem re-alarms on every sweep, so a `last_seen` this stale means the
 * watchdog stopped emitting for this key altogether — dead/quiet pot, a one-shot
 * event that never got an explicit RECOVERED broadcast, or the process that used
 * to hit this code path simply stopped running.
 *
 * ⚠ WI-6228 — that premise holds ONLY for emitters that re-alarm. It was
 * originally written as "every source in this codebase sweeps well under an
 * hour", which conflated *sweeping* with *broadcasting*: the dominant convention
 * in the release/infra watchdogs is `if (alerted) continue; // one-shot until
 * recovery` (origin-freshness, green-stall ×4, git-sync-stall, gate-canary,
 * federation-join-stall — gate-canary-sweep-action.ts even documents it as "like
 * every sibling watchdog"). Such a watchdog sweeps every minute and stays
 * deliberately SILENT while the condition is continuously true, so its
 * `last_seen` freezes at the first alarm and this guard resolved it on a timer —
 * a false green that was GUARANTEED, not probabilistic, for any one-shot
 * condition outlasting `absenceMs`. Measured live 2026-07-26 during a fleet-wide
 * git egress freeze: `origin-freshness:papercusp` alarmed once at 21:13:41Z and
 * was auto-resolved at 23:13:48Z — 120m+7s later, to the second — while the
 * outage was still live and worsening (the real RECOVERED broadcast landed only
 * at 23:39:42Z, and ~19 commits were stranded meanwhile). A false green is worse
 * than a missing alarm: it actively retires the one signal a responder would act
 * on. So a state whose latest alarm declared `one_shot` is NEVER selected here —
 * its silence carries no information. Such a condition still closes the honest
 * ways: an explicit RECOVERED broadcast from its emitter, or guard #2's live
 * health re-check.
 *
 * Applies to EVERY condition family (git-sync-stall:*, single-primary:*,
 * embed-exhaustion:*, infra-liveness:*, …).
 */
export function selectAbsentConditions(
  states: readonly ConditionState[],
  now: number,
  absenceMs: number,
): string[] {
  const out: string[] = [];
  for (const s of states) {
    if (!s.open) continue;
    // WI-6228: a one-shot emitter's silence is by design, not evidence of recovery.
    if (s.one_shot === true) continue;
    const lastSeenMs = Date.parse(s.last_seen);
    if (!Number.isFinite(lastSeenMs)) continue;
    if (now - lastSeenMs > absenceMs) out.push(s.condition_key);
  }
  return out;
}

/**
 * PURE: of the currently-OPEN condition states, which ones have a VERIFIED-healthy
 * underlying signal right now, per `healthByKey` (already resolved by the caller).
 * A key absent from `healthByKey` (unknown / not a family this tick checked) is
 * left alone — fail-open, this must never falsely clear a condition it couldn't
 * verify. Exported so "healthy signal ⇒ reconciled" is unit-testable independent
 * of how health gets computed.
 */
export function selectReconcilableConditions(
  states: readonly ConditionState[],
  healthByKey: ReadonlyMap<string, boolean>,
): string[] {
  const out: string[] = [];
  for (const s of states) {
    if (!s.open) continue;
    if (healthByKey.get(s.condition_key) === true) out.push(s.condition_key);
  }
  return out;
}

/**
 * How old a shared SystemHealth snapshot may be and still ground a "verified
 * healthy" auto-clear (EI-22175580395708679).
 *
 * Deliberately far TIGHTER than `SHARED_SYSTEM_HEALTH_MAX_AGE_MS` (5min — the
 * bound `readSharedSystemHealthSnapshot` itself uses to decide whether a row
 * exists at all) and `liveness-alarm.ts`'s own `DEFAULT_SNAPSHOT_STALE_MS`
 * (6min — its tick-stale gate). This reconciler is not merely READING health,
 * it is asserting the underlying signal is healthy RIGHT NOW and using that
 * assertion to auto-CLOSE an open alarm — a materially stronger claim than "I
 * have some evidence", so it needs a materially tighter freshness bar.
 *
 * Measured incident: within a single ~3min window, `dev:why`'s pool-stage read
 * (computed live at query time) reported all 14 LLM pool accounts unavailable
 * while this reconciler's "verified healthy" clear fired for
 * `infra-liveness:accounts-starved` — both true for their own sampling instant,
 * but the reconciler's read came from a cross-process cache that can trail the
 * live pool state by up to the 5-6min bounds above, and `tk.accountsAvailable`
 * can read >0 from a moment just before a pool goes fully starved. ~3x the
 * ~30s health-tick cadence (see `readSharedSystemHealthSnapshot`'s own comment)
 * gives real margin for a normally-ticking writer while still refusing a
 * snapshot old enough to have missed a state change.
 */
const INFRA_LIVENESS_HEALTH_VERIFY_MAX_AGE_MS = 90_000;

/**
 * Default health source for the `infra-liveness:*` family: read a shared
 * SystemHealth snapshot recent enough to trust and re-run the exact
 * `evaluateLivenessAlarm` the source watchdog fires from (liveness-alarm.ts) —
 * so this reconciler can never disagree with "is this infra-liveness signal
 * actually firing right now". Any open `infra-liveness:<sig>` key whose `<sig>`
 * is NOT in the freshly-computed firing set is verified healthy. Fail-soft: a
 * read error, a missing snapshot, OR a snapshot older than
 * `INFRA_LIVENESS_HEALTH_VERIFY_MAX_AGE_MS` leaves every key unset (unknown),
 * never a false clear.
 */
export async function readInfraLivenessHealthFromSharedSnapshot(
  openInfraKeys: readonly string[],
  deps: {
    readHealth?: (workspaceId: string) => Promise<SystemHealth | null>;
    readBeesLiveness?: (health: SystemHealth) => Promise<BeesLivenessContext | undefined>;
    workspaceId?: () => string;
    /** Injectable for tests; default `Date.now`. */
    now?: () => number;
  } = {},
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  if (openInfraKeys.length === 0) return out;
  try {
    const [{ evaluateLivenessAlarm, readBeesLivenessContext }, { activeWorkspaceId }] =
      await Promise.all([import('./liveness-alarm'), import('../workspace-registry')]);
    const workspaceId = deps.workspaceId ?? activeWorkspaceId;
    const readHealth =
      deps.readHealth ??
      (async (ws: string) => (await import('./compute')).readSharedSystemHealthSnapshot(ws));
    const health = await readHealth(workspaceId());
    // Missing shared evidence is UNKNOWN. Leave every key unset so this
    // reconciler cannot false-clear an open condition and cannot fall back to a
    // request-worker compute.
    if (!health) return out;
    // EI-22175580395708679: a snapshot `readSharedSystemHealthSnapshot` deems
    // "present" can still be several minutes old — too old to ground a
    // "verified healthy RIGHT NOW" claim used to auto-clear an open alarm.
    // Treat a too-old snapshot the SAME as a missing read (unknown, never a
    // false clear) rather than silently trusting it as current.
    const now = (deps.now ?? Date.now)();
    const snapshotAgeMs = now - health.evaluatedAt;
    if (!Number.isFinite(snapshotAgeMs) || snapshotAgeMs > INFRA_LIVENESS_HEALTH_VERIFY_MAX_AGE_MS) {
      return out;
    }
    // EI-15006: thread the SAME cup-placeable + capacity gate the source alarm
    // uses so this reconciler can never disagree with it on whether `panel:bees`
    // is firing — otherwise it would re-derive the pre-fix raw-frontier gate and
    // either falsely clear a genuine no-bees blocker or falsely keep a healthy
    // idle one open.
    const readBeesLiveness = deps.readBeesLiveness ?? readBeesLivenessContext;
    const beesLiveness = await readBeesLiveness(health).catch(() => undefined);
    // EI-22175580395708679: pass the REAL snapshot age, not `null` (which tells
    // evaluateLivenessAlarm "computed fresh this tick" — untrue for a
    // cross-process cache read, and previously disabled ITS OWN tick-stale
    // gate for this caller). Belt-and-suspenders with the explicit gate above.
    const firing = new Set(
      evaluateLivenessAlarm(health, snapshotAgeMs, { beesLiveness }).map((s) => s.key),
    );
    for (const key of openInfraKeys) {
      const sig = key.slice(INFRA_LIVENESS_PREFIX.length);
      out.set(key, !firing.has(sig));
    }
  } catch {
    // Unknown → leave unset (fail-open, never a false clear).
  }
  return out;
}

const SUMMARY_PREFIX = '[condition-stale] ';

/** Derive a legacy (no explicit signature) record's signature from its summary prefix. */
function deriveStaleSignatureFromSummary(summary: string): string | null {
  if (!summary?.startsWith(SUMMARY_PREFIX)) return null;
  const m = summary.match(/condition '([^']+)' has been OPEN/);
  return m ? `stale-condition:${m[1]}` : null;
}

/** The stable signature of an open escalation this alarm wrote (explicit meta, else derived). */
function staleConditionSignatureOf(rec: EscalationRecord): string | null {
  const explicit = (rec as Record<string, unknown>).conditionStalenessSignature;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  return deriveStaleSignatureFromSummary(rec.summary ?? '');
}

const lastAlertedAt = new Map<string, number>();
const OPEN_SCAN_WINDOW = 500;

/** Longest condition summary we will carry into a work-item title. */
const BRIDGE_TITLE_MAX = 160;

/**
 * Longest alarm BODY carried into the minted work-item's summary (P-007,
 * converge-frozen-candidate-by-fix-only-admission-2026-08-27).
 *
 * Bounded rather than unbounded because this text is read by every agent that opens
 * the item, so an emitter with a runaway body would tax every reader of every
 * condition. Sized to fit the bodies emitters actually write — the gate red-streak
 * broadcast, the largest live one, is well under this — and truncation is MARKED, so
 * a clipped body never reads as a complete one.
 */
const BRIDGE_BODY_MAX = 2000;

/**
 * PURE (P-003): project folded condition states onto the bridge's input shape,
 * keeping only the OPTED-IN keys whose owning harness can actually be established.
 *
 * Two independent filters, both fail-closed:
 *   1. `actionableConditionFor` — the opt-in catalog. A transient condition that
 *      opens and clears within a tick would otherwise mint and immediately close a
 *      work-item on every flap.
 *   2. `resolveConditionHarness` — `ConditionState` carries NO harness field, and
 *      the harness is NOT reliably recoverable from the key (`single-primary:` is
 *      suffixed with a verdict, not a slug). An unresolvable harness SKIPS the
 *      condition rather than guessing, because `createWorkItem` does not validate
 *      the harness and would happily file an unreachable row.
 *
 * Exported so "which conditions would this tick actually act on" is unit-testable
 * without writing a single row.
 */
export function toBridgeConditionStates(
  states: readonly ConditionState[],
  homeHarness: string,
): BridgeConditionState[] {
  const out: BridgeConditionState[] = [];
  for (const s of states) {
    const entry = actionableConditionFor(s.condition_key);
    if (!entry) continue;
    const harness = resolveConditionHarness(s.condition_key, homeHarness);
    if (!harness) continue;
    const latest = (s.latest_summary ?? '').trim();
    // P-007: carry the emitter's FULLER BODY — "evidence + the recommended first step"
    // (SevereEventInput.body) — onto the item a claimant actually opens. Before this,
    // the bridge folded only the one-line summary, so every emitter's evidence and
    // recommended first step was discarded for every condition family and the claimant
    // got boilerplate plus a headline. Truncation is marked so a clipped body is never
    // mistaken for the whole of what the emitter said.
    const body = (s.latest_body ?? '').trim();
    const bodyBlock = body
      ? `\n\nLatest alarm detail (from the emitter):\n${
          body.length > BRIDGE_BODY_MAX
            ? `${body.slice(0, BRIDGE_BODY_MAX)}\n…[truncated at ${BRIDGE_BODY_MAX} chars — read the full alarm via coord:inbox / the severe-event notification]`
            : body
        }`
      : '';
    out.push({
      conditionKey: s.condition_key,
      open: s.open,
      title: `[${s.condition_key}] ${latest || 'condition open'}`.slice(0, BRIDGE_TITLE_MAX),
      summary:
        `Owning work-item for condition '${s.condition_key}', minted by the condition bridge ` +
        `(P-003, gate-ownership-condition-singleton-2026-08-03). This item is the SINGLETON for ` +
        `this condition — the partial unique index on work_items.condition_key guarantees at most ` +
        `one open owner, so claim THIS rather than filing another.\n\n` +
        `Latest alarm: ${latest || '(no summary)'}\n` +
        `First seen: ${s.first_seen} · open since: ${s.open_since ?? '(unknown)'} · alarms: ${s.alarm_count}` +
        bodyBlock,
      harness,
      severity: entry.severity,
    });
  }
  return out;
}

export interface ConditionStalenessDeps {
  readStates?: () => Promise<ConditionState[]>;
  escalate?: (input: {
    severity: EscalationSeverity;
    summary: string;
    body?: string;
    meta?: Record<string, unknown>;
  }) => Promise<unknown>;
  listOpen?: () => Promise<EscalationRecord[]>;
  resolve?: (msg_id: string, choice: string, note: string) => Promise<unknown>;
  now?: () => number;
  staleMs?: number;
  debounceMs?: number;
  /** EI-15182 guard #3: family-agnostic resolve-on-absence threshold — an open
   *  condition whose `last_seen` is older than this is treated as a signal that
   *  has gone quiet (no watchdog sweep has re-observed it) and is auto-resolved
   *  + never re-paged, regardless of which family sourced it. Default =
   *  DEFAULT_SIGNAL_ABSENCE_MS. */
  absenceMs?: number;
  /** EI-14072 guard #2: resolve the health of currently-open `infra-liveness:*`
   *  condition keys. Default = `readInfraLivenessHealthFromSharedSnapshot` (a
   *  fresh shared SystemHealth read + evaluateLivenessAlarm re-check). Injectable so tests
   *  never hit real I/O. */
  readHealthByKey?: (openInfraKeys: readonly string[]) => Promise<Map<string, boolean>>;
  /** EI-14072 guard #2: broadcast the reconciled keys' recovery so the NEXT
   *  computeConditionStates read (and every other reader) also sees them closed —
   *  not just this tick's local view. Default = the real
   *  `broadcastSevereEventResolvedMany`. */
  broadcastResolvedMany?: (input: { conditionKeys: string[]; summary: string }) => Promise<boolean>;
  /** EI-211981: read active git-sync routine metadata and return a health verdict
   * for each requested `git-sync-stall:<installSlug>` key. Missing/failed reads
   * must omit the key (unknown), never return true. */
  readGitSyncHealthByKey?: (
    openGitSyncKeys: readonly string[],
    now: number,
  ) => Promise<Map<string, boolean>>;
  /**
   * P-003: the condition→work-item bridge.
   *
   * ⚠ Defaults to a NO-OP, unlike every other dep here — and deliberately so.
   * This is the one dep that WRITES (it mints and settles work-items); the others
   * read or broadcast. A write-by-default would mean any bare
   * `runConditionStalenessTick()` mints real rows, and the existing unit tests
   * already use actionable keys (`single-primary:*`) against a box with a live
   * Postgres. The production entrypoint `startConditionStalenessAlarm()` passes
   * the real `reconcileConditions`, so the shipped behavior is ON — inert here
   * only for callers that never asked to write.
   */
  bridgeConditions?: (
    states: readonly BridgeConditionState[],
    opts: { workspaceId?: string },
  ) => Promise<ReconcileSummary>;
  /** P-003: ambient harness for condition keys that carry none (`single-primary:*`).
   *  Default = `operatorHomeHarnessSlug()`. */
  homeHarness?: () => string;
}

/**
 * One tick: fold current condition envelopes → state, RECONCILE any open
 * source-verifiable row (`infra-liveness:*` or `git-sync-stall:*`) whose
 * underlying signal is verified healthy right now (EI-14072 guard #2 plus
 * EI-211981 — the durable backstop for a dropped/never-sent resolution,
 * independent of guard #1's batched-resolution fix), RECONCILE any open row of
 * ANY family whose signal has gone quiet — no alarm re-observed in over
 * `absenceMs` (EI-15182 guard #3 — resolve-on-absence, the durable fix for a
 * condition whose source watchdog simply stopped emitting and never sent an
 * explicit RECOVERED), find conditions stuck open past `staleMs` (excluding any
 * that guard #3 has already ruled signal-absent, belt-and-suspenders), auto-
 * resolve any prior stale-reminder whose condition cleared (or is no longer
 * stale), and fire a durably-deduped + debounced reminder for every new stale
 * signature.
 */
export async function runConditionStalenessTick(
  deps: ConditionStalenessDeps = {},
): Promise<{
  fired: StaleConditionSignal[];
  signals: StaleConditionSignal[];
  resolved: string[];
  reconciled: string[];
  /** P-003: what the condition→work-item bridge did this tick. */
  bridged: ReconcileSummary;
}> {
  const now = (deps.now ?? Date.now)();
  const readStates =
    deps.readStates ?? (async () => computeConditionStates(await readConditionEnvelopes()));
  const escalate = deps.escalate ?? ((input) => openEscalation(CONDITION_STALENESS_IDENTITY, input));
  const listOpen =
    deps.listOpen ??
    (async () => {
      // EI-19403159016550818 — READ SCOPED TO THIS ALARM, SERVER-SIDE.
      //
      // This used to read the newest/oldest OPEN_SCAN_WINDOW escalations
      // workspace-wide and filter `from` in JS. That is silently wrong the moment
      // the workspace-wide open set exceeds the window: the projection is ordered
      // OLDEST-first and this alarm's own rows are the NEWEST (it is the thing
      // actively minting them), so its rows are systematically the ones cut off —
      // and the more it mints, the further past the window they sit. Measured
      // 2026-08-03 on a 607-row open set: this alarm's 60 rows occupied positions
      // 501..607 against a 500-row window, so the JS filter returned EXACTLY 0 and
      // the auto-resolve leg below became a permanent no-op. 60 reminders for a
      // condition that had already recovered stayed open for hours, and nothing
      // anywhere reported a fault — an empty page and "nothing of mine is open"
      // are the same value.
      //
      // Passing `from` pushes the predicate into the projection query, so the read
      // is COMPLETE for this author regardless of workspace-wide backlog size.
      const { escalations, truncated, trueOpenTotal } = await listEscalationsPaginated({
        status: 'open',
        maxRecords: OPEN_SCAN_WINDOW,
        from: CONDITION_STALENESS_IDENTITY.ownerId,
      });
      if (truncated) {
        // Even author-scoped, a caller must never take a resolve decision from a
        // page it KNOWS is partial: "not in my page" would again read as "not
        // open". Surfacing it is the recurrence guard for the whole class — the
        // original defect was invisible precisely because this flag was returned
        // and discarded.
        console.warn(
          `[condition-staleness-alarm] open-escalation read TRUNCATED at ${OPEN_SCAN_WINDOW} ` +
            `(author-scoped rows: ${escalations.length}${
              typeof trueOpenTotal === 'number' ? `, author open total: ${trueOpenTotal}` : ''
            }). Auto-resolve this tick is INCOMPLETE — reminders outside the page cannot be closed.`,
        );
      }
      return escalations;
    });
  const resolve =
    deps.resolve ??
    ((msg_id, choice, note) =>
      resolveEscalation({ msg_id, choice, note, resolver: CONDITION_STALENESS_IDENTITY.ownerId }));
  const staleMs = deps.staleMs ?? DEFAULT_STALE_OPEN_MS;
  const debounceMs = deps.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const absenceMs = deps.absenceMs ?? DEFAULT_SIGNAL_ABSENCE_MS;
  const readHealthByKey = deps.readHealthByKey ?? readInfraLivenessHealthFromSharedSnapshot;
  const readGitSyncHealthByKey = deps.readGitSyncHealthByKey ?? defaultReadGitSyncHealth;
  const broadcastResolvedMany = deps.broadcastResolvedMany ?? broadcastSevereEventResolvedMany;

  let states: ConditionState[];
  try {
    states = await readStates();
  } catch {
    // A read failure must never crash the request worker nor look like "all clear".
    // The bridge is deliberately NOT run: with no trustworthy states, an "absent"
    // condition is indistinguishable from a resolved one, and bridging on that
    // reading would SETTLE every owning work-item on a transient DB blip.
    return { fired: [], signals: [], resolved: [], reconciled: [], bridged: { acquired: [], released: [], skipped: 0 } };
  }

  // Reconcile BEFORE staleness evaluation, so a condition we just healed this
  // tick never also earns a staleness reminder in the same pass.
  const reconciled: string[] = [];

  // ── EI-14072 guard #2: infra-liveness family, verified against a live health re-check ──
  const openInfraKeys = states
    .filter((s) => s.open && s.condition_key.startsWith(INFRA_LIVENESS_PREFIX))
    .map((s) => s.condition_key);
  const openGitSyncKeys = states
    .filter((s) => s.open && s.condition_key.startsWith(GIT_SYNC_STALL_PREFIX))
    .map((s) => s.condition_key);
  let infraHealthByKey = new Map<string, boolean>();
  try {
    infraHealthByKey = await readHealthByKey(openInfraKeys);
  } catch {
    infraHealthByKey = new Map();
  }
  let gitSyncHealthByKey = new Map<string, boolean>();
  try {
    gitSyncHealthByKey = await readGitSyncHealthByKey(openGitSyncKeys, now);
  } catch {
    gitSyncHealthByKey = new Map();
  }
  const healthByKey = new Map<string, boolean>([
    ...infraHealthByKey,
    ...gitSyncHealthByKey,
  ]);
  const toReconcileHealth = selectReconcilableConditions(states, healthByKey);
  if (toReconcileHealth.length > 0) {
    try {
      const ok = await broadcastResolvedMany({
        conditionKeys: toReconcileHealth,
        summary:
          `[condition-reconciler] ${toReconcileHealth.length} condition(s) cleared — underlying signal ` +
          `verified healthy (no matching resolution had landed): ${toReconcileHealth.join(', ')}.`,
      });
      if (ok) reconciled.push(...toReconcileHealth);
    } catch {
      /* a broadcast failure must never crash the request worker */
    }
    if (reconciled.length > 0) {
      const reconciledSet = new Set(reconciled);
      states = states.map((s) => (reconciledSet.has(s.condition_key) ? { ...s, open: false } : s));
    }
  }

  // ── EI-15182 guard #3: family-agnostic resolve-on-absence ──
  // Independent of guard #2 (no per-family health-check needed, and covers
  // every family, not just infra-liveness): an open condition whose last_seen
  // itself has gone stale beyond `absenceMs` means nobody has re-observed its
  // signal in a long time. Broadcast its resolution so every OTHER reader
  // (coord:conditions, a peer's own fold) also sees it closed durably, not
  // just suppressed in this tick's local view.
  const absentKeys = selectAbsentConditions(states, now, absenceMs);
  if (absentKeys.length > 0) {
    try {
      const ok = await broadcastResolvedMany({
        conditionKeys: absentKeys,
        summary:
          `[condition-reconciler] ${absentKeys.length} condition(s) auto-resolved — no new alarm ` +
          `observed in over ${Math.round(absenceMs / 60_000)}m (signal absence, EI-15182): ` +
          `${absentKeys.join(', ')}.`,
      });
      if (ok) {
        reconciled.push(...absentKeys);
        const absentSet = new Set(absentKeys);
        states = states.map((s) => (absentSet.has(s.condition_key) ? { ...s, open: false } : s));
      }
    } catch {
      /* a broadcast failure must never crash the request worker */
    }
  }

  // evaluateStaleConditions independently re-checks last_seen against
  // `absenceMs` (belt-and-suspenders): even if the broadcast above failed —
  // network hiccup, `ok:false` — an absent condition is NEVER re-paged this
  // tick regardless of whether the durable resolution landed.
  const signals = evaluateStaleConditions(states, now, staleMs, absenceMs);
  const currentSigs = new Set(signals.map((s) => s.key));

  let openBySig = new Map<string, EscalationRecord[]>();
  try {
    for (const rec of await listOpen()) {
      const sig = staleConditionSignatureOf(rec);
      if (!sig) continue;
      const list = openBySig.get(sig);
      if (list) list.push(rec);
      else openBySig.set(sig, [rec]);
    }
  } catch {
    openBySig = new Map();
  }

  // Auto-resolve every open stale-reminder whose condition is no longer open+stale.
  const resolved: string[] = [];
  for (const [sig, recs] of openBySig) {
    if (currentSigs.has(sig)) continue;
    for (const rec of recs) {
      try {
        await resolve(
          rec.msg_id,
          'auto-resolved',
          `condition-staleness signal '${sig}' cleared (condition resolved or no longer stale)`,
        );
        resolved.push(rec.msg_id);
      } catch {
        /* a resolve failure must never crash the request worker */
      }
    }
    lastAlertedAt.delete(sig);
  }

  // ── P-003: bridge conditions to owning work-items ──
  // Deliberately placed AFTER the guards above, so it reads the FINAL `states`:
  // a condition healed by guard #2/#3 this tick is already open:false here and so
  // closes its owning item in the same pass rather than a tick later.
  //
  // Reuses this tick rather than adding a third scheduler mechanism — it already
  // computes condition states on a 5-min cadence and is already the registered
  // acting consumer for `coord-conditions`.
  //
  // Fully fail-soft: bridging is additive bookkeeping, and no failure here may
  // affect the escalation verdict computed above.
  let bridged: ReconcileSummary = { acquired: [], released: [], skipped: 0 };
  if (deps.bridgeConditions) {
    try {
      const homeHarness = (deps.homeHarness ?? operatorHomeHarnessSlug)();
      // EI-19930875455827867: this opts object MUST carry a concrete workspaceId.
      // Without it `resolveWorkItemPot` short-circuits at its `if (!ws) return rawSlug`
      // guard and hands back the RAW member slug ('oddsmith') un-normalized — so the
      // ownership READ looks under 'oddsmith' while `createWorkItem` stored the holder
      // under the resolved pot ('oddsmith-hive'). The bridge then concludes the
      // condition is unowned, mints, loses the partial-unique-index race to the real
      // incumbent, and drops the row — ~150 junk work-items/hour, forever, and the
      // release path shares the defect so it can never self-heal. D-022's
      // `resolveStoredConditionHarness` normalization is correct and deployed; it was
      // simply INERT because its only production caller passed `{}`.
      bridged = await deps.bridgeConditions(toBridgeConditionStates(states, homeHarness), {
        workspaceId: coordScopeWorkspace(),
      });
    } catch {
      /* a bridge failure must never crash the request worker */
    }
  }

  // Fire each NEW stale signature — durably deduped, then in-memory cooldown-debounced.
  const fired: StaleConditionSignal[] = [];
  for (const s of signals) {
    if (openBySig.has(s.key)) continue;
    const prev = lastAlertedAt.get(s.key);
    if (prev !== undefined && now - prev < debounceMs) continue;
    lastAlertedAt.set(s.key, now);
    fired.push(s);
    try {
      await escalate({
        severity: s.severity,
        summary: `${SUMMARY_PREFIX}${s.summary}`,
        body:
          `Detected by the coord:conditions staleness actor (WI-2965) — a periodic re-evaluation ` +
          `of computeConditionStates(), NOT a duplicate of the source watchdog's open-time alert. ` +
          `Condition key: ${s.conditionKey}.`,
        // WI-7254 — `subjectSignature` is the field escalations.ts actually reads to
        // coalesce (escalationDedupIdentity: `input.meta?.subjectSignature`, else
        // normalizeSubjectSignature(summary)). This call passed ONLY
        // `conditionStalenessSignature`, so the explicit path never matched and the
        // signature fell back to the SUMMARY — which embeds the condition's age
        // ("has been OPEN for 267m"). A dedup key containing a monotonically
        // increasing number is unique by construction, so coalescing could never
        // fire. Measured 2026-08-03: 71 open rows, 71 distinct signatures, and only
        // 4 distinct once `open for <N>m` is normalized away — 5h45m of accumulation
        // where 4 rows were warranted. It also silently degraded dedupKind to
        // `severity` (observed: 'advisory') instead of CONDITION_KEY_DEDUP_KIND,
        // costing the severity-independent advisory→blocker coalesce EI-12546 added.
        //
        // BOTH keys are passed on purpose: `conditionStalenessSignature` is this
        // module's own self-identification, read back by staleConditionSignatureOf()
        // for the auto-resolve sweep, and dropping it would strand every open row.
        //
        // WI-36214: THREE keys now. This alarm gates its own re-fire on an open
        // row (`openBySig.has(s.key)` above) AND resolves its rows itself, so the
        // attention TTL sweep must not GC them — doing so re-arms the alarm on a
        // still-true condition. Not yet observed for THIS emitter (its rows did
        // not appear in the 14d idle-2d resolve set), but the gate is identical
        // to escalation-aging-alarm.ts:167, where it was measured 6 times.
        meta: {
          conditionStalenessSignature: s.key,
          subjectSignature: s.key,
          [SELF_RECONCILING_META_KEY]: true,
        },
      });
    } catch {
      /* an alarm-send failure must never crash the request worker */
    }
  }
  return { fired, signals, resolved, reconciled, bridged };
}

/**
 * Start the alarm on a request-worker loop, mirroring startInfraLivenessAlarm's shape
 * (unref'd timer, env-killable, interval overridable). Wire alongside
 * startInfraLivenessAlarm() in bin/hono-host.ts.
 */
export function startConditionStalenessAlarm(opts: { intervalMs?: number } = {}): { stop(): void } {
  if (process.env.PAPERCUSP_CONDITION_STALENESS_ALARM === '0') return { stop() {} };
  const envMs = Number(process.env.PAPERCUSP_CONDITION_STALENESS_ALARM_MS);
  const intervalMs = opts.intervalMs ?? (Number.isFinite(envMs) && envMs > 0 ? envMs : DEFAULT_INTERVAL_MS);
  const timer = managedSetInterval(
    'condition-staleness-alarm',
    intervalMs,
    () =>
      // P-003: THIS is what turns the condition→work-item bridge on. The tick
      // defaults it off (it is the one write-side dep — see ConditionStalenessDeps);
      // the production loop opts in, so the shipped behavior is ON.
      runConditionStalenessTick({ bridgeConditions: reconcileConditions }).then(
        () => undefined,
        () => undefined,
      ),
    { category: 'watchdog' },
  );
  return {
    stop() {
      timer.stop();
    },
  };
}

/** Test-only — clear the per-signature debounce. */
export function _resetConditionStalenessDebounce(): void {
  lastAlertedAt.clear();
}
