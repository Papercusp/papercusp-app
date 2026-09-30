import type { Sql } from 'postgres';

const DEFAULT_ROUTINE_ENGINE_STALE_MS = 6 * 60_000;

export interface RoutineEngineLiveness {
  stale: boolean;
  unknown: boolean;
  lastTickMs: number | null;
  staleMs: number | null;
}

export function evaluateRoutineEngineLiveness(
  lastTickMs: number | null,
  nowMs: number,
  opts: { staleMs?: number } = {},
): RoutineEngineLiveness {
  if (lastTickMs == null || !Number.isFinite(lastTickMs)) {
    return { stale: false, unknown: true, lastTickMs: null, staleMs: null };
  }
  const staleMs = nowMs - lastTickMs;
  return {
    stale: staleMs > (opts.staleMs ?? DEFAULT_ROUTINE_ENGINE_STALE_MS),
    unknown: false,
    lastTickMs,
    staleMs,
  };
}

export async function readRoutineEngineLiveness(
  sql: Sql,
  opts: { staleMs?: number; nowMs?: number } = {},
): Promise<RoutineEngineLiveness> {
  try {
    const rows = await sql<Array<{ last_tick_ms: string | number | null }>>`
       SELECT MAX(tick.completed_at) AS last_tick_ms
        FROM dbos.workflow_status tick
       WHERE tick.name = 'routinesTick'
         AND tick.status = 'SUCCESS'
         AND tick.completed_at IS NOT NULL
         AND EXISTS (
           SELECT 1
             FROM dbos.operation_outputs operation
            WHERE operation.workflow_uuid = tick.workflow_uuid
              AND operation.function_name = 'list-due-routines'
              AND operation.completed_at_epoch_ms IS NOT NULL
              AND operation.error IS NULL
         )`;
    const raw = rows[0]?.last_tick_ms;
    const lastTickMs = raw == null ? null : Number(raw);
    return evaluateRoutineEngineLiveness(lastTickMs, opts.nowMs ?? Date.now(), opts);
  } catch {
    return { stale: false, unknown: true, lastTickMs: null, staleMs: null };
  }
}
