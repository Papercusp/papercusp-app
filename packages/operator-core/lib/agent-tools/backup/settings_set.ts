import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { workspaceBackupFor } from '../../backup';
import { activeWorkspaceId } from '../../workspace-registry';

const RetentionSchema = z.object({
  keepLatest: z.number().int().min(1),
  keepHourly: z.number().int().min(0),
  keepDaily: z.number().int().min(0),
  keepWeekly: z.number().int().min(0),
  keepMonthly: z.number().int().min(0),
});

export default defineTool({
  name: 'backup:settings_set',
  profile: 'engineer',
  description: 'Patch backup settings for the active workspace. All fields optional; missing keys preserve existing values.',
  capability: 'backup:write',
  guidance: {
    when: `Update backup configuration. Confirm the change out loud first — affects automated backups going forward.`,
    notWhen: `For one-shot backup creation, use \`backup:snapshot_create\`. settings_set is for the schedule/policy.`,
    seeAlso: [
      'backup:settings_get (read the current schedule/policy)',
      'backup:snapshot_create (a one-shot backup instead of scheduling)',
    ],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'debugger'],
  args: z.object({
    enabled: z.boolean().optional(),
    cadenceMode: z.enum(['event', 'interval', 'both']).optional(),
    cadenceMinutes: z.number().int().min(60).max(1440).optional(),
    retentionPreset: z.enum(['aggressive', 'default', 'conservative', 'custom']).optional(),
    retentionCustom: RetentionSchema.nullable().optional(),
    eventTriggers: z.array(z.enum([
      'manual', 'interval', 'pre_destructive', 'post_run',
      'plugin_install', 'secret_change', 'startup',
    ])).optional(),
    excludedPaths: z.array(z.string()).optional(),
  }),
  async handler(args) {
    const wb = workspaceBackupFor(activeWorkspaceId());
    const next = await wb.updateSettings(args);
    return {
      content: [{ type: 'text', text: JSON.stringify({ settings: next }) }],
    };
  },
});
