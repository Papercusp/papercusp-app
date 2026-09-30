/**
 * Read helpers for mobile feed surfaces (notifications, recent actions).
 *
 * Both queries go through `withWorkspace()` so RLS enforces the workspace
 * boundary using the same GUC contract as the rest of harness_shared.
 */
import { withWorkspace } from '@papercusp/db-org';

export interface ToastRow {
  id: number;
  level: string;
  message: string;
  description: string | null;
  harness_slug: string | null;
  created_at: number;
  action_label: string | null;
  action_href: string | null;
}

export interface AuditRow {
  id: string;
  ts: number;
  actor: string;
  action: string;
  subject: string;
  details: unknown;
}

export async function recentToasts(workspaceId: string, limit = 50): Promise<ToastRow[]> {
  return withWorkspace(workspaceId, async (tx) => {
    return tx<ToastRow[]>`
      SELECT id, level, message, description,
             harness_slug, created_at,
             action_label, action_href
      FROM harness_shared.toast_log
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
  });
}

export async function lastActivityAt(workspaceId: string): Promise<number | null> {
  return withWorkspace(workspaceId, async (tx) => {
    const rows = await tx<{ ts: number | null }[]>`
      SELECT GREATEST(
        COALESCE((SELECT MAX(ts) FROM harness_shared.audit_log), 0),
        COALESCE((SELECT MAX(created_at) FROM harness_shared.toast_log), 0)
      ) AS ts
    `;
    const ts = rows[0]?.ts;
    return ts && ts > 0 ? Number(ts) : null;
  });
}

export async function recentAuditEntries(workspaceId: string, limit = 50): Promise<AuditRow[]> {
  return withWorkspace(workspaceId, async (tx) => {
    return tx<AuditRow[]>`
      SELECT id, ts, actor, action, subject, details
      FROM harness_shared.audit_log
      ORDER BY ts DESC
      LIMIT ${limit}
    `;
  });
}

export interface RunningScan {
  id: number;
  started_at: number;
  request_text: string | null;
  cost_usd: number;
}

export interface RunningHarnessPhase {
  harness_slug: string;
  phase: string;
  status: string;
  iteration: number;
  total_features: number;
  passed_count: number;
  todo_count: number;
  blocked_count: number;
  last_active_ts: number | null;
  active_roles: string[];
}

export async function currentlyRunning(workspaceId: string): Promise<{
  scan: RunningScan | null;
  harnesses: RunningHarnessPhase[];
}> {
  return withWorkspace(workspaceId, async (tx) => {
    // Operator scans are retired (unify-agent-launches-as-blueprints D-005
    // scanner teardown, 2026-06-05) — `harness_shared.operator_scans` no
    // longer exists. The device contract keeps `scan: RunningScan | null`
    // (mobile models Option<RunningScan>), so always report "no scan
    // running"; harness phases + lanes below are the real fleet data.
    const harnesses = await tx<Omit<RunningHarnessPhase, 'active_roles'>[]>`
      SELECT harness_slug, phase, status, iteration,
             total_features, passed_count, todo_count, blocked_count,
             last_active_ts
      FROM harness_shared.harness_status
      WHERE status IN ('running', 'iterating', 'planning', 'reviewing')
      ORDER BY last_active_ts DESC NULLS LAST
      LIMIT 20
    `;

    // Pull lane roles per (slug, phase) so the screen can show "worker on F-FOO".
    const lanes = await tx<{ harness_slug: string; phase: string; role: string }[]>`
      SELECT harness_slug, phase, role
      FROM harness_shared.harness_lanes
    `;
    const roleMap = new Map<string, string[]>();
    for (const l of lanes) {
      const k = `${l.harness_slug}::${l.phase}`;
      if (!roleMap.has(k)) roleMap.set(k, []);
      roleMap.get(k)!.push(l.role);
    }

    return {
      scan: null,
      harnesses: harnesses.map((h) => ({
        ...h,
        active_roles: roleMap.get(`${h.harness_slug}::${h.phase}`) ?? [],
      })),
    };
  });
}
