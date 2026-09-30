/**
 * GET /api/backups  — { settings, stats } for active workspace.
 * PUT /api/backups  — replace settings (validated).
 *
 * Ported from app/api/backups/route.ts. `auth: 'public'`.
 */
import { z } from 'zod';
import { mergeRepoStatsWithKopia, workspaceBackupFor, getKopiaDetection } from '../../../backup';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

const RetentionSchema = z.object({
  keepLatest: z.number().int().min(1),
  keepHourly: z.number().int().min(0),
  keepDaily: z.number().int().min(0),
  keepWeekly: z.number().int().min(0),
  keepMonthly: z.number().int().min(0),
});

const SettingsSchema = z.object({
  enabled: z.boolean(),
  cadenceMode: z.enum(['event', 'interval', 'both']),
  cadenceMinutes: z.number().int().min(60).max(1440),
  retentionPreset: z.enum(['aggressive', 'default', 'conservative', 'custom']),
  retentionCustom: RetentionSchema.nullable(),
  eventTriggers: z.array(z.enum([
    'manual', 'interval', 'pre_destructive', 'post_run',
    'plugin_install', 'secret_change', 'startup',
  ])),
  excludedPaths: z.array(z.string()),
});

const get = defineTool({
  method: 'GET',
  path: '/backups',
  auth: 'public',
  async handler() {
    try {
      const ws = activeWorkspaceId();
      const wb = workspaceBackupFor(ws);
      const [settings, stats, kopiaStats] = await Promise.all([
        wb.getSettings(),
        wb.stats(),
        wb.kopiaContentStats().catch(() => null),
      ]);
      const merged = mergeRepoStatsWithKopia(stats, kopiaStats);
      // Surface binary availability so the wizard/settings can render an
      // "unavailable in this runtime" state instead of a raw error (the
      // Windows WSL runtime shipped without kopia until 2026-06-11).
      return Response.json({ workspaceId: ws, settings, stats: merged, kopia: getKopiaDetection() });
    } catch (err) {
      return Response.json({ error: String(err instanceof Error ? err.message : err) }, { status: 500 });
    }
  },
});

const put = defineTool({
  method: 'PUT',
  path: '/backups',
  auth: 'loopback',
  async handler(req) {
    try {
      const body = await req.json();
      const parsed = SettingsSchema.parse(body);
      const wb = workspaceBackupFor(activeWorkspaceId());
      const next = await wb.updateSettings(parsed);
      return Response.json({ settings: next });
    } catch (err) {
      return Response.json({ error: String(err instanceof Error ? err.message : err) }, { status: 400 });
    }
  },
});

export default [get, put];
