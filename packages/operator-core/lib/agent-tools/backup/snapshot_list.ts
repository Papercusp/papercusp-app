import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { workspaceBackupFor } from '../../backup';
import { activeWorkspaceId } from '../../workspace-registry';

export default defineTool({
  name: 'backup:snapshot_list',
  profile: 'engineer',
  description: 'List recent kopia snapshots for the active workspace, plus any backup session currently holding schema locks.',
  capability: 'backup:read',
  guidance: {
    when: `List backup snapshots — point-in-time captures of the workspace's PG + filesystem state.`,
    notWhen: `For publishable per-harness artifacts — this surface lists only full-workspace recovery snapshots, so use the artifact/catalog surface that owns the harness payload instead.`,
    seeAlso: [
      'backup:snapshot_create (create a new snapshot)',
      'backup:restore (apply a snapshot from the list)',
    ],
    chaining: `snapshots[] covers only THIS workspace's kopia-hook receipts in harness_shared.backup_snapshots. It cannot see the independent host-level pg_dump cron (EI-22064935119941678), so an empty snapshots[] is NOT an all-clear. Check liveBackupSessions[] too — it lists ANY currently-active pg_dump (host OR workspace) that can hold schema-blocking locks right now, regardless of receipt state.`,
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    limit: z.number().int().min(1).max(500).default(50),
  }),
  async handler(args) {
    const wb = workspaceBackupFor(activeWorkspaceId());
    const [snapshots, liveBackupSessions] = await Promise.all([
      wb.list(args.limit),
      wb.liveBackupSessions(),
    ]);
    return { data: { snapshots, liveBackupSessions } };
  },
});
