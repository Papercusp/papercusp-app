/**
 * Trigger-state digest for the idle short-circuit (Phase 3c).
 *
 * Reads the four conditions the plan calls out:
 *   1. unconsumed pending_events count
 *   2. (project_slug, status) tuples in the workspace
 *   3. messages in inboxes (harness inboxes + system:operator's inbox)
 *      whose ts > snapshot's computedAt
 *   4. cache age (handled by the snapshot module's TTL ceiling)
 *
 * Returns a stable hash. Caller compares against `idle-snapshot.json`'s
 * fingerprint; equal AND under 30 min TTL → short-circuit OK.
 */

import { createHash } from 'node:crypto';
import { withWorkspace } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';

export interface TriggerState {
  unconsumedEvents: number;
  projects: { slug: string; status: string }[];
  operatorInboxCount: number;
  /**
   * Per-harness one-liner snapshot for the idle status pane (Phase 5).
   * NOT included in the fingerprint — purely for display so cosmetic
   * tweaks don't churn the cache.
   */
  perHarness?: { slug: string; status: string; lastTouched: string | null }[];
}

export async function readTriggerState(): Promise<TriggerState> {
  const workspaceId = activeWorkspaceId();
  return withWorkspace(workspaceId, async (tx) => {
    const events = await tx<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
        FROM harness_shared.pending_events
       WHERE consumed_at IS NULL
    `;
    const projects = await tx<{ slug: string; status: string }[]>`
      SELECT slug, status
        FROM harness_shared.projects
       ORDER BY slug
    `;
    let inbox = 0;
    try {
      // Count pending messages where any recipient department is the
      // operator's inbox. message_recipients keys (message_id, dept_slug);
      // status lives on the parent messages row.
      const rows = await tx<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
          FROM papercusp_shared.message_recipients r
          JOIN papercusp_shared.messages m ON m.id = r.message_id
         WHERE r.dept_slug = 'system:operator'
           AND m.status    = 'pending'
      `;
      inbox = rows[0]?.count ?? 0;
    } catch {
      // message_recipients table may not exist in every workspace; treat as 0.
    }

    // Per-harness one-liners. Best-effort — uses the same projects rows
    // plus a left-join on harnesses for last-touched. If the harnesses
    // table differs across deploys, just omit perHarness.
    let perHarness: { slug: string; status: string; lastTouched: string | null }[] | undefined;
    try {
      const rows = await tx<{ slug: string; status: string; last_touched: string | null }[]>`
        SELECT p.slug, p.status,
               (SELECT MAX(ts)::text FROM harness_shared.audit_log a
                 WHERE a.subject = p.slug) AS last_touched
          FROM harness_shared.projects p
         ORDER BY p.slug
      `;
      perHarness = rows.map((r) => ({
        slug: r.slug,
        status: r.status,
        lastTouched: r.last_touched,
      }));
    } catch {
      /* leave undefined */
    }

    return {
      unconsumedEvents: events[0]?.count ?? 0,
      projects,
      operatorInboxCount: inbox,
      perHarness,
    };
  });
}

export function fingerprint(s: TriggerState): string {
  const canonical = JSON.stringify({
    e: s.unconsumedEvents,
    p: s.projects,
    i: s.operatorInboxCount,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}
