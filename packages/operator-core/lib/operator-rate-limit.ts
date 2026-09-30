/**
 * Per-workspace rate limit + 503 circuit breaker (Phase 3e/3f of the v5
 * operator plan) — PG-backed (migration 031).
 *
 * Was previously a process-local Map<string, WorkspaceRate>. Restart
 * reset the counter (a soft bypass for abusers); multi-instance deploys
 * couldn't share state. Now a single JSONB row per workspace in
 * `harness_shared.operator_rate_limit`.
 *
 * Defaults:
 *   - 2 background scans / min / workspace
 *   - 5 consecutive PG 503s → pause for 10 min
 *
 * Each call is a single transactional read-modify-write to defeat
 * concurrent-call interleaving. Manual rescans bypass this layer per
 * §4 decision 3 (the route handler simply doesn't call checkRate).
 */

import { getOrgPg, generated } from '@papercusp/db-org';
import { eq, sql } from 'drizzle-orm';

const t = generated.operatorRateLimitInHarnessShared;

const RATE_WINDOW_MS = 60_000;
const DEFAULT_RATE_LIMIT = 2;
const BREAKER_FAIL_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 10 * 60_000;

interface WorkspaceRate {
  recent: number[]; // ms timestamps
  consecutive503: number;
  breakerUntilMs: number;
}

const EMPTY: WorkspaceRate = { recent: [], consecutive503: 0, breakerUntilMs: 0 };

async function readState(workspaceId: string): Promise<WorkspaceRate> {
  const { db } = getOrgPg();
  const rows = await db
    .select({ payload: t.payload })
    .from(t)
    .where(eq(t.workspaceId, workspaceId))
    .limit(1);
  if (rows.length === 0) return { ...EMPTY };
  const p = rows[0].payload as Partial<WorkspaceRate> | null;
  return {
    recent: Array.isArray(p?.recent) ? p.recent : [],
    consecutive503: typeof p?.consecutive503 === 'number' ? p.consecutive503 : 0,
    breakerUntilMs: typeof p?.breakerUntilMs === 'number' ? p.breakerUntilMs : 0,
  };
}

async function writeState(workspaceId: string, s: WorkspaceRate): Promise<void> {
  const { db } = getOrgPg();
  await db
    .insert(t)
    .values({ workspaceId: workspaceId, payload: s, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: t.workspaceId,
      set: { payload: sql`EXCLUDED.payload`, updatedAt: sql`EXCLUDED.updated_at` },
    });
}

async function transact<T>(
  workspaceId: string,
  mutator: (s: WorkspaceRate) => { state: WorkspaceRate; result: T },
): Promise<T> {
  const { sql } = getOrgPg();
  return await sql.begin(async (tx) => {
    const rows = await tx<{ payload: WorkspaceRate }[]>`
      SELECT payload FROM harness_shared.operator_rate_limit
       WHERE workspace_id = ${workspaceId}
       FOR UPDATE
    `;
    const cur = rows.length > 0
      ? {
          recent: Array.isArray(rows[0].payload?.recent) ? rows[0].payload.recent : [],
          consecutive503: typeof rows[0].payload?.consecutive503 === 'number' ? rows[0].payload.consecutive503 : 0,
          breakerUntilMs: typeof rows[0].payload?.breakerUntilMs === 'number' ? rows[0].payload.breakerUntilMs : 0,
        }
      : { ...EMPTY };
    const { state: next, result } = mutator(cur);
    const payload = JSON.stringify(next);
    await tx`
      INSERT INTO harness_shared.operator_rate_limit (workspace_id, payload, updated_at)
      VALUES (${workspaceId}, ${payload}::text::jsonb, ${Date.now()})
      ON CONFLICT (workspace_id) DO UPDATE
        SET payload = EXCLUDED.payload, updated_at = EXCLUDED.updated_at
    `;
    return result;
  }) as T;
}

export interface RateCheck {
  allowed: boolean;
  reason?: 'rate-limit' | 'circuit-breaker';
  retryAfterSec?: number;
}

/** Check whether a *background* scan can proceed. Manual scans skip this. */
export async function checkRate(workspaceId: string, limit = DEFAULT_RATE_LIMIT): Promise<RateCheck> {
  return transact<RateCheck>(workspaceId, (cur) => {
    const now = Date.now();
    if (cur.breakerUntilMs > now) {
      return {
        state: cur,
        result: {
          allowed: false,
          reason: 'circuit-breaker',
          retryAfterSec: Math.ceil((cur.breakerUntilMs - now) / 1000),
        },
      };
    }
    const recent = cur.recent.filter((t) => now - t < RATE_WINDOW_MS);
    if (recent.length >= limit) {
      const oldest = recent[0];
      return {
        state: { ...cur, recent },
        result: {
          allowed: false,
          reason: 'rate-limit',
          retryAfterSec: Math.ceil((RATE_WINDOW_MS - (now - oldest)) / 1000),
        },
      };
    }
    recent.push(now);
    return { state: { ...cur, recent }, result: { allowed: true } };
  });
}

/** Note a 503 from a downstream dep (PG, claude-bridge). Trips the breaker on N consecutive. */
export async function record503(workspaceId: string): Promise<void> {
  await transact<void>(workspaceId, (cur) => {
    const consecutive503 = cur.consecutive503 + 1;
    const breakerUntilMs =
      consecutive503 >= BREAKER_FAIL_THRESHOLD
        ? Date.now() + BREAKER_COOLDOWN_MS
        : cur.breakerUntilMs;
    return { state: { ...cur, consecutive503, breakerUntilMs }, result: undefined };
  });
}

/** Note a successful scan — resets the consecutive-503 counter. */
export async function recordSuccess(workspaceId: string): Promise<void> {
  await transact<void>(workspaceId, (cur) => ({
    state: { ...cur, consecutive503: 0 },
    result: undefined,
  }));
}

/** Manual reset (used by /api/agent-mcp/operator-circuit-breaker for ops escapes). */
export async function resetBreaker(workspaceId: string): Promise<void> {
  await writeState(workspaceId, { recent: [], consecutive503: 0, breakerUntilMs: 0 });
}

export async function inspectState(workspaceId: string): Promise<WorkspaceRate> {
  return readState(workspaceId);
}
