/**
 * Can the acceptance-grading-sweep recover a stalled acceptance grading RIGHT NOW?
 * (EI-24032136322947460)
 *
 * A ship refused as `acceptance_ungraded` / `self_graded_only` used to tell every
 * shipper that the grader recruiter's "lifecycle and the grading sweep own
 * dispatch/recovery" — unconditionally. The sweep had been deliberately paused
 * since 2026-09-15 (an owner hold on background LLM-spending loops, no auto-resume),
 * so that sentence sent implementers to wait on a recovery that could not happen,
 * and every plan deduped onto an unassigned grading request stalled silently.
 * This module reads the sweep's routine row so the refusal can say which it is.
 *
 * Reuse: the shared {@link readRoutinePause} parser and the same single indexed row
 * lookup (routines_install_slug_name_key) as `admissionPromoterStall` in
 * work-items-admission.ts. The install slug mirrors the seeder
 * (seed-acceptance-grading-sweep-routine.ts): ONE operator-home row serves every
 * workspace's plans.
 *
 * Fail-open: a missing or unreadable row is `unknown`, and callers leave the default
 * refusal untouched rather than asserting a pause they could not observe.
 */
import { getOrgPg } from '@papercusp/db-org';
import { operatorHomeHarnessSlug } from './harness/operator-home-harness';
import { readRoutinePause } from './harness/routines/release-pause-ttl';

export const ACCEPTANCE_GRADING_SWEEP_ROUTINE = 'acceptance-grading-sweep';

export type AcceptanceGradingSweepState =
  /** The routine is armed, so it re-dispatches and escalates stalled gradings. */
  | { status: 'running' }
  /** Deliberately held. Not a fault: it must not be re-armed to unblock one ship. */
  | {
      status: 'paused';
      reason: string | null;
      pausedBy: string | null;
      pausedAt: string | null;
      /** Finite expiry stamped by the pause writer; null = nothing re-arms it. */
      autoResumesAt: string | null;
    }
  /** Inactive with NO pause record: stopped, and nothing durable says why. */
  | { status: 'inactive' }
  /** Row missing or unreadable — say nothing rather than guess. */
  | { status: 'unknown'; detail: string };

/** The row shape {@link classifyAcceptanceGradingSweep} decides from. */
export interface AcceptanceGradingSweepRow {
  active: boolean | null;
  /** Raw `routines.metadata.pause` jsonb. */
  pause: unknown;
}

const iso = (ms: number | null): string | null => (ms == null ? null : new Date(ms).toISOString());

/**
 * The PURE decision. `active` is authoritative for whether recovery exists: an armed
 * routine fires regardless of a leftover pause record, so a stale record must not
 * make a refusal claim a hold the sweep is not under. Only an INACTIVE row is split
 * into a deliberate hold (pause record present) vs an unexplained stop.
 */
export function classifyAcceptanceGradingSweep(
  row: AcceptanceGradingSweepRow | null | undefined,
): AcceptanceGradingSweepState {
  if (!row) return { status: 'unknown', detail: 'routine row not found' };
  if (row.active !== false) return { status: 'running' };
  const pause = readRoutinePause(row.pause);
  if (!pause.present) return { status: 'inactive' };
  return {
    status: 'paused',
    reason: pause.reason,
    pausedBy: pause.pausedBy,
    pausedAt: iso(pause.pausedAtMs),
    autoResumesAt: iso(pause.expiresAtMs),
  };
}

export async function readAcceptanceGradingSweepState(): Promise<AcceptanceGradingSweepState> {
  const installSlug = process.env.ACCEPTANCE_GRADING_SWEEP_ROUTINE_SLUG ?? operatorHomeHarnessSlug();
  try {
    const { sql } = getOrgPg();
    const rows = await sql<{ active: boolean | null; pause: unknown }[]>`
      SELECT active, metadata->'pause' AS pause
        FROM harness_shared.routines
       WHERE install_slug = ${installSlug}
         AND name = ${ACCEPTANCE_GRADING_SWEEP_ROUTINE}
       LIMIT 1`;
    return classifyAcceptanceGradingSweep(rows[0]);
  } catch (err) {
    return { status: 'unknown', detail: (err instanceof Error ? err.message : String(err)).slice(0, 200) };
  }
}
