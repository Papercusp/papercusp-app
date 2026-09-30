/**
 * monitor-standdown.ts — the SETTLEMENT half of the anti-babysitting monitor
 * contract (plan anti-babysitting-monitor-enforcement-2026-08-25, P-004, D-002 §3/§4).
 *
 * `monitor-policy.ts` decides whether a monitor may be ARMED. This module decides
 * whether an already-armed monitor may be RE-ARMED after one of its wakes settles,
 * and is the mechanism behind the persona rule "a non-owner's first no-delta wake is
 * terminal": the budget is enforced by the engine, so a monitor stands down even when
 * the agent forgets to call `loop:end`.
 *
 * TWO independent standdown triggers, checked in this order:
 *
 *  1. AUTHORITY LOST (D-002 §4) — the stored authority is re-validated before every
 *     re-arm, not only at arm time. A work-item that moved to a live, progressing peer;
 *     a fleet whose registered leader changed or went stale; a duplicate live monitor on
 *     the same predicate. These end the monitor immediately, whatever the budget says,
 *     because a budget only bounds waste while the watch is still legitimate.
 *
 *  2. NO-DELTA BUDGET EXHAUSTED (D-002 §3) — each settled fire that reported no delta
 *     decrements the persisted remaining budget by exactly one; reaching zero deactivates
 *     the loop instead of re-arming it. A delta reported since the fire RESETS the budget
 *     to its configured value, so the bound is on CONSECUTIVE quiet wakes, not lifetime
 *     ones. With the default budget of 1 this means exactly one quiet wake.
 *
 * FAIL-OPEN on an unreadable authority (`monitor_admission_unavailable`), matching
 * engine-loop-standdown.ts's convention: a transient database error must degrade to "keep
 * the monitor" — a missed standdown costs one throttled wake, while a wrong standdown
 * silently kills a legitimate owner's watch and there is nothing left to notice it.
 *
 * The budget decrement is NOT fail-open: it needs no external read, so an error there is
 * a real bug rather than an unreadable dependency.
 */
import type { Sql } from 'postgres';
import { recordLoopTransition } from './loop-transition-log';
import {
  admitMonitorArm,
  parsePersistedMonitorConfig,
  type MonitorAdmissionDependencies,
  type MonitorAdmissionResult,
  type PersistedMonitorConfig,
} from './monitor-policy';

/** Why a monitor loop was stood down, as recorded in routine metadata + transition history. */
export type MonitorStanddownCode =
  | 'no_delta_budget_exhausted'
  /** The stored authority no longer holds — the admission code is carried in `authorityCode`. */
  | 'authority_lost';

export interface MonitorStanddownVerdict {
  action: 'standdown';
  code: MonitorStanddownCode;
  /** The admission refusal code when `code === 'authority_lost'`; absent otherwise. */
  authorityCode?: string;
  reason: string;
  /** Budget as it stood when the standdown was decided (0 for an exhausted budget). */
  remainingNoDeltaBudget: number;
}

export interface MonitorRearmVerdict {
  action: 'rearm';
  /** The value to persist back onto `payload_template.monitor.remainingNoDeltaBudget`. */
  remainingNoDeltaBudget: number;
  /** True when the settled fire reported a delta, which reset the budget. */
  deltaObserved: boolean;
}

export type MonitorSettlementVerdict = MonitorRearmVerdict | MonitorStanddownVerdict;

/** The authority re-validation input, kept as a plain verdict so the decision stays pure. */
export type MonitorAuthorityRecheck =
  | { ok: true }
  /** A refusal that ends the monitor. */
  | { ok: false; code: string; message: string }
  /** The authority could not be READ. Fail-open: never a standdown reason. */
  | { ok: 'unknown'; message: string };

/**
 * PURE settlement decision for one settled monitor fire.
 *
 * Authority is evaluated BEFORE the budget: a monitor whose subject has been taken over
 * by a live progressing peer must end now, even on a wake that reported real work — the
 * work it reported was, by construction, duplicated supervision.
 */
export function decideMonitorSettlement(input: {
  config: PersistedMonitorConfig;
  /** Did the agent record a delta for this fire (loop:checkpoint { monitorDelta: true })? */
  deltaObserved: boolean;
  authority: MonitorAuthorityRecheck;
}): MonitorSettlementVerdict {
  const { config, deltaObserved, authority } = input;

  if (authority.ok === false) {
    return {
      action: 'standdown',
      code: 'authority_lost',
      authorityCode: authority.code,
      reason:
        `monitor standdown (${authority.code}): ${authority.message} ` +
        `Predicate '${config.predicateKey}' is no longer this session's to watch.`,
      remainingNoDeltaBudget: config.remainingNoDeltaBudget,
    };
  }

  // A delta RESETS the consecutive-quiet counter; it never grows the configured budget.
  if (deltaObserved) {
    return { action: 'rearm', remainingNoDeltaBudget: config.noDeltaBudget, deltaObserved: true };
  }

  const remaining = config.remainingNoDeltaBudget - 1;
  if (remaining <= 0) {
    return {
      action: 'standdown',
      code: 'no_delta_budget_exhausted',
      reason:
        `monitor standdown (no_delta_budget_exhausted): ${config.noDeltaBudget} consecutive quiet wake(s) ` +
        `produced no delta on predicate '${config.predicateKey}'. Stop condition was: ${config.stopCondition}`,
      remainingNoDeltaBudget: 0,
    };
  }
  return { action: 'rearm', remainingNoDeltaBudget: remaining, deltaObserved: false };
}

/**
 * Did the agent report a delta for the fire that just settled?
 *
 * The marker is a single timestamp (`metadata.monitor_delta_at`) stamped by
 * `loop:checkpoint { monitorDelta: true }`. It counts only when it is NEWER than the
 * fire being settled — a delta recorded during an EARLIER fire must not keep an idle
 * monitor alive forever, which is exactly the runaway this budget exists to stop.
 *
 * Per D-002 §3 both omission and an explicit `false` mean NO delta, so a missing marker
 * is a decision, not a gap.
 */
export function monitorDeltaObservedForFire(input: {
  monitorDeltaAt: string | Date | null | undefined;
  lastFiredAt: string | Date | null | undefined;
}): boolean {
  const delta = toMs(input.monitorDeltaAt);
  if (delta == null) return false;
  const fired = toMs(input.lastFiredAt);
  // No recorded fire yet (a freshly armed, never-fired loop) — any delta is current.
  if (fired == null) return true;
  return delta > fired;
}

function toMs(value: string | Date | null | undefined): number | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Read the persisted monitor policy off a routine's payload_template, or null for a work loop. */
export function readPersistedMonitorConfig(payloadTemplate: unknown): PersistedMonitorConfig | null {
  if (!payloadTemplate || typeof payloadTemplate !== 'object' || Array.isArray(payloadTemplate)) return null;
  const pt = payloadTemplate as Record<string, unknown>;
  if (pt.mode !== 'monitor') return null;
  return parsePersistedMonitorConfig(pt.monitor);
}

/**
 * Re-validate a stored monitor authority through the SAME admission policy that gated the
 * arm, so the two can never drift. The persisted `remainingNoDeltaBudget` is stripped
 * because the arm schema is strict and owns only the CONFIGURED budget; the returned
 * config is discarded here — only the verdict matters.
 */
export async function recheckMonitorAuthority(
  input: { ownerId: string; workspaceId: string; harness: string; config: PersistedMonitorConfig },
  deps?: MonitorAdmissionDependencies,
): Promise<MonitorAuthorityRecheck> {
  const result: MonitorAdmissionResult = await admitMonitorArm(
    {
      ownerId: input.ownerId,
      workspaceId: input.workspaceId,
      harness: input.harness,
      monitor: {
        predicateKey: input.config.predicateKey,
        stopCondition: input.config.stopCondition,
        noDeltaBudget: input.config.noDeltaBudget,
        authority: input.config.authority,
      },
    },
    deps,
  );
  if (result.allowed) return { ok: true };
  if (result.code === 'monitor_admission_unavailable') {
    return { ok: 'unknown', message: result.message };
  }
  return { ok: false, code: result.code, message: result.message };
}

/**
 * Persist a surviving monitor's decremented (or reset) budget — EXACTLY ONCE per settled
 * fire, whatever the reconcile pass does.
 *
 * `fireToken` identifies the fire being settled (its `last_fired_at`). The write records it
 * and refuses to run twice for the same one, which is what makes "decrement once per settled
 * fire" true rather than merely intended: the reconcile SELECT is deliberately unlocked, so
 * two overlapping passes can both read the SAME pre-decrement snapshot and would otherwise
 * each subtract one — halving a monitor's budget for reasons an operator could never
 * reconstruct. Guarding on parked-at-infinity would NOT cover this (a cron+loop monitor is
 * never parked), so the guard is keyed on the fire itself.
 *
 * Also guarded on the routine still being an active monitor, so a concurrent standdown or a
 * `loop:end` cannot be silently resurrected by a late settlement pass.
 *
 * Returns true when this call wrote the budget (or when it was already written for this
 * exact fire — an idempotent no-op is a success, not a failure).
 */
export async function persistMonitorNoDeltaBudget(
  sql: Sql,
  routineId: string,
  remainingNoDeltaBudget: number,
  fireToken: string,
): Promise<boolean> {
  const rows = await sql<Array<{ id: string }>>`
    UPDATE harness_shared.routines
       SET payload_template = jsonb_set(
             payload_template,
             '{monitor,remainingNoDeltaBudget}',
             to_jsonb(${remainingNoDeltaBudget}::int),
             true
           ),
           metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object('monitor_budget_fire_at', ${fireToken}::text),
           updated_at = now()
     WHERE id = ${routineId}
       AND active = TRUE
       AND payload_template->>'mode' = 'monitor'
       AND payload_template ? 'monitor'
       AND (metadata->>'monitor_budget_fire_at') IS DISTINCT FROM ${fireToken}::text
    RETURNING id`;
  return rows.length > 0 || (await budgetAlreadySettledForFire(sql, routineId, fireToken));
}

/** Distinguish "another pass already settled THIS fire" (fine) from "the row is gone / no
 *  longer an active monitor" (do not re-arm on a stale budget). */
async function budgetAlreadySettledForFire(sql: Sql, routineId: string, fireToken: string): Promise<boolean> {
  const rows = await sql<Array<{ id: string }>>`
    SELECT id FROM harness_shared.routines
     WHERE id = ${routineId}
       AND active = TRUE
       AND payload_template->>'mode' = 'monitor'
       AND (metadata->>'monitor_budget_fire_at') = ${fireToken}::text
     LIMIT 1`;
  return rows.length > 0;
}

/**
 * ATOMIC standdown: deactivate the monitor loop and record WHY, in one statement.
 *
 * Deliberately one write rather than "flip active, then annotate": the re-arm path this
 * replaces is itself a single UPDATE, so a two-step standdown leaves a window in which a
 * concurrent reconcile pass sees an active monitor with no remaining budget and re-arms it.
 *
 * The canonical `metadata.pause` shape is written alongside the typed `monitor_standdown`
 * object because `readStalePausedRoutines` reads ONLY `pause.reason` + `pause.pausedAtMs`;
 * omitting it would report every stood-down monitor as an unexplained stale pause
 * (the EI-19479519679704136 mismatch).
 *
 * Returns true when THIS call performed the standdown (the row crossed active TRUE→FALSE),
 * so a caller can log exactly once and a re-pass is a silent no-op.
 */
export async function standDownMonitorLoop(
  sql: Sql,
  routineId: string,
  verdict: MonitorStanddownVerdict,
): Promise<boolean> {
  const rows = await sql<
    Array<{
      workspace_id: string;
      install_slug: string;
      name: string | null;
      target_role: string | null;
      target_owner_id: string | null;
      reschedule_interval_sec: number | null;
      prev_next_fire_at: string | null;
    }>
  >`
    UPDATE harness_shared.routines AS r
       SET active = FALSE,
           next_fire_at = NULL,
           payload_template = jsonb_set(
             payload_template,
             '{monitor,remainingNoDeltaBudget}',
             to_jsonb(${verdict.remainingNoDeltaBudget}::int),
             true
           ),
           metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object(
                         'monitor_standdown', jsonb_build_object(
                           'code', ${verdict.code}::text,
                           'authorityCode', ${verdict.authorityCode ?? null}::text,
                           'reason', ${verdict.reason}::text,
                           'atMs', (extract(epoch from now()) * 1000)::bigint
                         ),
                         'pause', jsonb_build_object(
                           'reason', ${verdict.reason}::text,
                           'pausedAtMs', (extract(epoch from now()) * 1000)::bigint
                         ),
                         'loop_paused_reason', ${verdict.reason}::text,
                         'loop_paused_at', now()::text,
                         'loop_paused_next_fire_at', to_jsonb(next_fire_at::text)
                       ),
           updated_at = now()
      FROM (
        SELECT id AS prev_id, next_fire_at::text AS prev_next_fire_at
          FROM harness_shared.routines
         WHERE id = ${routineId}
      ) AS prev
     WHERE r.id = prev.prev_id
       AND r.active = TRUE
    RETURNING r.workspace_id, r.install_slug, r.name, r.target_role, r.target_owner_id,
              r.reschedule_interval_sec, prev.prev_next_fire_at`;

  const row = rows[0];
  if (!row) return false;

  // Evidence, never an input to scheduling — fire-and-forget, exactly as the other
  // disarm paths do it (loop-transition-log.ts's invariant).
  void recordLoopTransition(sql, {
    workspaceId: row.workspace_id,
    installSlug: row.install_slug,
    routineId,
    routineName: row.name,
    targetRole: row.target_role,
    targetOwnerId: row.target_owner_id,
    event: 'disarmed',
    actor: 'monitor-standdown',
    newNextFireAt: null,
    intervalSec: row.reschedule_interval_sec,
    detail: {
      reason: verdict.reason,
      standdownCode: verdict.code,
      ...(verdict.authorityCode ? { authorityCode: verdict.authorityCode } : {}),
      pausedNextFireAt: row.prev_next_fire_at,
    },
  });
  return true;
}

/**
 * Stamp the delta marker for the CURRENT fire — the write behind
 * `loop:checkpoint { monitorDelta: true }`.
 *
 * Scoped to the owner's active monitor loop: a work loop has no budget to reset, and
 * saying "delta" on one is meaningless rather than an error, so this is a no-op there.
 * Returns the number of routine rows stamped (0 when the caller has no active monitor).
 */
export async function recordMonitorDelta(
  sql: Sql,
  input: { ownerId: string; workspaceId: string },
): Promise<number> {
  const rows = await sql<Array<{ id: string }>>`
    UPDATE harness_shared.routines
       SET metadata = COALESCE(metadata, '{}'::jsonb)
                    || jsonb_build_object('monitor_delta_at', now()::text),
           updated_at = now()
     WHERE workspace_id = ${input.workspaceId}
       AND target_owner_id = ${input.ownerId}
       AND active = TRUE
       AND reschedule_interval_sec IS NOT NULL
       AND payload_template->>'mode' = 'monitor'
    RETURNING id`;
  return rows.length;
}

/** The typed standdown record exposed on loop:status. */
export interface MonitorStanddownRecord {
  code: string;
  authorityCode: string | null;
  reason: string;
  atMs: number | null;
}

/** Parse `metadata.monitor_standdown` for status surfaces; null when never stood down. */
export function readMonitorStanddownRecord(metadata: unknown): MonitorStanddownRecord | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const raw = (metadata as Record<string, unknown>).monitor_standdown;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if (typeof rec.code !== 'string' || typeof rec.reason !== 'string') return null;
  return {
    code: rec.code,
    authorityCode: typeof rec.authorityCode === 'string' ? rec.authorityCode : null,
    reason: rec.reason,
    atMs: typeof rec.atMs === 'number' ? rec.atMs : null,
  };
}
