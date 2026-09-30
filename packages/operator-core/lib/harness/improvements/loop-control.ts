/**
 * loop-control — the Learning tab's header pause/resume + spend read
 * (learning-tab header control, WI-39501 [owner 2026-08-16]).
 *
 * ONE snapshot answering the three things the header chip renders:
 *   - is the learning loop RUNNING or PAUSED (the `self-improvement` routine
 *     group's active members);
 *   - what a resume would restore — the members whose `metadata.pause` carries
 *     THIS group's `groupPause` marker (stamped by `routines:group-set
 *     { active:false }`), i.e. the snapshot semantics: resume never revives a
 *     routine somebody paused deliberately outside the group pause;
 *   - what the loop's own thinking costs — cost over
 *     `agent_usage_samples` for the LOOP ROLES ONLY (scout / gym / llm-testing;
 *     owner-ruled 2026-08-16: cron auto-implement workers are NOT counted).
 *
 * Read-only; `runQuery` is injected (the insights load-tokens pattern) so the
 * resolver threads its workspace-routed tx in and tests thread a stub. Degrades
 * to an empty snapshot on a missing table/column — never a 500.
 */

export const LEARNING_ROUTINE_GROUP = 'self-improvement';

/** The loop's OWN roles — Scout ideation, Gym runs, llm-testing judges.
 *  Deliberately excludes cron-dispatched implement workers (owner scope ruling). */
export const LEARNING_SPEND_ROLES: readonly string[] = ['scout', 'gym', 'llm-testing'];

export interface LearningLoopSpendRole {
  role: string;
  todayUsd: number;
  weekUsd: number;
}

export interface LearningLoopControl {
  group: string;
  memberCount: number;
  activeCount: number;
  /** Inactive members held by THIS group's group-pause (what resume restores). */
  heldCount: number;
  status: 'running' | 'paused';
  /** Newest groupPause stamp among held members (ms epoch), null when none. */
  pausedAtMs: number | null;
  pausedBy: string | null;
  spend: {
    todayUsd: number;
    weekUsd: number;
    roles: readonly string[];
    byRole: LearningLoopSpendRole[];
  };
  evaluatedAt: number;
}

type RunQuery = <T>(query: string, params: unknown[]) => Promise<T[]>;

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC-midnight floor — the same day boundary the Tokens view buckets by. */
export function utcDayStart(nowMs: number): number {
  return Math.floor(nowMs / DAY_MS) * DAY_MS;
}

function num(v: unknown): number {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : 0;
  return Number.isFinite(n) ? n : 0;
}

export async function loadLearningLoopControl(opts: {
  workspaceId: string;
  runQuery: RunQuery;
  group?: string;
  nowMs?: number;
}): Promise<LearningLoopControl> {
  const group = opts.group ?? LEARNING_ROUTINE_GROUP;
  const now = opts.nowMs ?? Date.now();

  let memberCount = 0;
  let activeCount = 0;
  let heldCount = 0;
  let pausedAtMs: number | null = null;
  let pausedBy: string | null = null;
  try {
    const rows = await opts.runQuery<{ active: boolean; pause: Record<string, unknown> | null }>(
      `SELECT active, metadata -> 'pause' AS pause
         FROM harness_shared.routines
        WHERE workspace_id = $1 AND group_slug = $2`,
      [opts.workspaceId, group],
    );
    memberCount = rows.length;
    for (const r of rows) {
      if (r.active) {
        activeCount += 1;
        continue;
      }
      const pause = r.pause;
      if (pause && (pause as { groupPause?: unknown }).groupPause === group) {
        heldCount += 1;
        const at = num((pause as { pausedAtMs?: unknown }).pausedAtMs);
        if (at > 0 && (pausedAtMs === null || at > pausedAtMs)) {
          pausedAtMs = at;
          const by = (pause as { pausedBy?: unknown }).pausedBy;
          pausedBy = typeof by === 'string' ? by : pausedBy;
        }
      }
    }
  } catch {
    /* degrade to the empty snapshot — never a 500 */
  }

  const byRole: LearningLoopSpendRole[] = [];
  let todayUsd = 0;
  let weekUsd = 0;
  try {
    const dayStart = utcDayStart(now);
    const weekStart = now - 7 * DAY_MS;
    const rows = await opts.runQuery<{ role: string; today_usd: unknown; week_usd: unknown }>(
      `SELECT COALESCE(role, '') AS role,
              SUM(cost_usd) FILTER (WHERE ts >= $3) AS today_usd,
              SUM(cost_usd) AS week_usd
         FROM harness_shared.agent_usage_samples
        WHERE workspace_id = $1 AND ts >= $2 AND role = ANY($4)
        GROUP BY 1
        ORDER BY 3 DESC NULLS LAST`,
      [opts.workspaceId, weekStart, dayStart, [...LEARNING_SPEND_ROLES]],
    );
    for (const r of rows) {
      const entry = { role: r.role, todayUsd: num(r.today_usd), weekUsd: num(r.week_usd) };
      byRole.push(entry);
      todayUsd += entry.todayUsd;
      weekUsd += entry.weekUsd;
    }
  } catch {
    /* degrade — the chip renders state without spend rather than nothing */
  }

  return {
    group,
    memberCount,
    activeCount,
    heldCount,
    status: activeCount > 0 ? 'running' : 'paused',
    pausedAtMs,
    pausedBy,
    spend: { todayUsd, weekUsd, roles: LEARNING_SPEND_ROLES, byRole },
    evaluatedAt: now,
  };
}
