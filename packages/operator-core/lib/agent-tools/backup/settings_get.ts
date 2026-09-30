import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { mergeRepoStatsWithKopia, workspaceBackupFor } from '../../backup';
import { activeWorkspaceId } from '../../workspace-registry';

export default defineTool({
  name: 'backup:settings_get',
  profile: 'engineer',
  description: 'Read backup settings + repo stats for the active workspace.',
  capability: 'backup:read',
  guidance: {
    when: `Read backup configuration — schedule, retention, destinations.`,
    notWhen: `For runtime BACKUP state (last run, next run), check the destinations directly.`,
    seeAlso: [
      'backup:settings_set (change the schedule/policy)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({}),
  async handler() {
    const wb = workspaceBackupFor(activeWorkspaceId());
    const [settings, stats, kopiaStats] = await Promise.all([
      wb.getSettings(),
      wb.stats(),
      wb.kopiaContentStats().catch(() => null),
    ]);
    return { data: { settings, stats: mergeRepoStatsWithKopia(stats, kopiaStats) } };
  },
});
