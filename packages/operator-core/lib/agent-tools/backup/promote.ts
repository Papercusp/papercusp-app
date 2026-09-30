/**
 * backup:promote — promote a restored clone to live.
 * Atomic rename: live → .broken-<ts>/, clone → live. Reversible by
 * renaming the .broken-* dir back.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { triggerSnapshotEvent } from '../../backup';
import { durablePromoteRestore } from '../../backup/durable-ops';
import { activeWorkspaceId } from '../../workspace-registry';

const PROMOTE_ROLES = ['operator', 'debugger'] as const;

export default defineTool({
  name: 'backup:promote',
  profile: 'engineer',
  description:
    'Promote a restored clone to live by atomic rename. ' +
    'Live dir becomes .broken-<ts>-<name>/. Reversible by renaming back. ' +
    'Auto-snapshots before promotion as belt-and-suspenders.',
  capability: 'backup:write',
  guidance: {
    when: `Promote a backup to active (roll forward to it without rolling back). Used after testing a restore.`,
    notWhen: `For UNDOING to an earlier state, use \`backup:rollback\`. promote moves forward; rollback moves back.`,
    seeAlso: [
      'backup:rollback (undo to an earlier state — promote moves forward)',
    ],
  },
  requirePrincipal: false,
  agentRoles: [...PROMOTE_ROLES],
  args: z.object({
    restoredPath: z.string().min(1),
    liveTarget: z.string().min(1).optional(),
  }),
  async handler(args) {
    const ws = activeWorkspaceId();
    await triggerSnapshotEvent(ws, 'pre_destructive', { op: 'promote_restore', restoredPath: args.restoredPath })
      .catch(() => { /* non-fatal */ });
    const result = await durablePromoteRestore(ws, args);
    // { data } over hand-rolled inline JSON: the framework owns wire encoding (incl.
    // auto-TOON on the MCP transport). tool-data-shape-ratchet.test.ts counts the
    // legacy self-serialized content shape and is shrink-only. Do NOT spell that
    // shape's literal token in this file — the ratchet scans source, so a comment
    // quoting it self-matches and the migration reads as a no-op.
    return { data: result };
  },
});
