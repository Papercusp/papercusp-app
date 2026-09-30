import type { Sql } from 'postgres';

/**
 * A dispatched loop turn that repeatedly completes without one agent-authored tool call is
 * alive enough to consume wakes but not alive enough to advance its work. Three consecutive
 * turns is the default escalation boundary: one empty turn may be benign, while an unbounded
 * sequence is the silent-starvation failure this guard exists to stop.
 */
export const DEFAULT_ZERO_TOOL_ESCALATION_THRESHOLD = 3;
const MAX_ZERO_TOOL_ESCALATION_THRESHOLD = 100;

/** Parse the operator override without allowing an invalid or effectively-unbounded value to
 * disable the guard accidentally. The default is deliberately small; the cap is a safety rail,
 * not an expected operating value. */
export function zeroToolEscalationThreshold(raw = process.env.PAPERCUSP_LOOP_ZERO_TOOL_ESCALATION_THRESHOLD): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_ZERO_TOOL_ESCALATION_THRESHOLD;
  return Math.min(MAX_ZERO_TOOL_ESCALATION_THRESHOLD, Math.trunc(parsed));
}

export interface ZeroToolFireObservation {
  /** False when this exact fire token was already observed by an earlier reconcile pass. */
  counted: boolean;
  streak: number;
  toolCalls: number;
  fireToken: string;
  threshold: number;
  atThreshold: boolean;
}

interface ZeroToolFireObservationRow {
  streak: number | string;
  tool_calls: number | string;
  fire_token: string;
}

/**
 * Persist one dispatched fire's agent-tool-call verdict on the existing routine metadata row.
 *
 * The fire token makes the 30-second reconcile idempotent: the same parked fire can be scanned
 * repeatedly, but it increments the streak once. A productive turn resets the streak to zero.
 * The UPDATE merges flat keys into metadata so unrelated routine state is never replaced.
 *
 * When an earlier pass already counted the token, the follow-up SELECT returns the persisted
 * state. That lets a later pass finish a threshold escalation if the process died between the
 * metadata write and the pause, without incrementing the same fire again.
 */
export async function recordZeroToolFireObservation(
  sql: Sql,
  input: {
    routineId: string;
    fireToken: string;
    toolCalls: number;
    threshold?: number;
  },
): Promise<ZeroToolFireObservation | null> {
  const toolCalls = Math.max(0, Math.trunc(input.toolCalls));
  const threshold = input.threshold ?? zeroToolEscalationThreshold();

  const [updated] = await sql<ZeroToolFireObservationRow[]>`
    UPDATE harness_shared.routines AS r
       SET metadata = COALESCE(r.metadata, '{}'::jsonb)
                    || jsonb_build_object(
                         'loop_zero_tool_streak',
                         CASE
                           WHEN obs.tool_calls = 0 THEN
                             CASE
                               WHEN (COALESCE(r.metadata, '{}'::jsonb)->>'loop_zero_tool_streak') ~ '^[0-9]+$'
                                 THEN (COALESCE(r.metadata, '{}'::jsonb)->>'loop_zero_tool_streak')::int
                               ELSE 0
                             END + 1
                           ELSE 0
                         END,
                         'loop_zero_tool_last_fire_token', obs.fire_token,
                         'loop_zero_tool_last_tool_call_count', obs.tool_calls,
                         'loop_zero_tool_threshold', obs.threshold,
                         'loop_zero_tool_last_counted_at', now()::text
                       ),
           updated_at = now()
      FROM (
        SELECT ${toolCalls}::int AS tool_calls,
               ${threshold}::int AS threshold,
               ${input.fireToken}::text AS fire_token
      ) AS obs
     WHERE r.id = ${input.routineId}
       AND r.active = TRUE
       AND (COALESCE(r.metadata, '{}'::jsonb)->>'loop_zero_tool_last_fire_token')
             IS DISTINCT FROM obs.fire_token
    RETURNING (r.metadata->>'loop_zero_tool_streak')::int AS streak,
              (r.metadata->>'loop_zero_tool_last_tool_call_count')::int AS tool_calls,
              r.metadata->>'loop_zero_tool_last_fire_token' AS fire_token
  `;

  let row = updated;
  let counted = true;
  if (!row) {
    counted = false;
    const [existing] = await sql<ZeroToolFireObservationRow[]>`
      SELECT (metadata->>'loop_zero_tool_streak')::int AS streak,
             (metadata->>'loop_zero_tool_last_tool_call_count')::int AS tool_calls,
             metadata->>'loop_zero_tool_last_fire_token' AS fire_token
        FROM harness_shared.routines
       WHERE id = ${input.routineId}
         AND active = TRUE
         AND metadata->>'loop_zero_tool_last_fire_token' = ${input.fireToken}
       LIMIT 1
    `;
    row = existing;
  }

  if (!row) return null;
  const streak = Number(row.streak);
  const persistedToolCalls = Number(row.tool_calls);
  return {
    counted,
    streak,
    toolCalls: persistedToolCalls,
    fireToken: row.fire_token,
    threshold,
    atThreshold: persistedToolCalls === 0 && streak >= threshold,
  };
}
