/**
 * backup:restore_clone_cleanup — preview or remove aged restore-to-clone
 * directories. Preview is the safe default; the caller must explicitly pass
 * dryRun:false after reviewing the preview.
 */

import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import {
  DEFAULT_RESTORED_CLONE_MAX_AGE_MS,
  sweepRestoredClones,
} from '../../backup';
import { activeWorkspaceId, workspacesRoot } from '../../workspace-registry';

const DAY_MS = 24 * 60 * 60 * 1000;

export default defineTool({
  name: 'backup:restore_clone_cleanup',
  profile: 'engineer',
  description:
    'Preview or remove aged restore-to-clone directories under .restored/<snapshot>/<slug>. ' +
    'Dry-run is the default; removal requires dryRun:false and is protected by restore-liveness ' +
    'and promotion-reference proofs.',
  capability: 'backup:write',
  guidance: {
    when: 'Clean up old restore-to-clone results after reviewing the preview.',
    notWhen: 'For recovery debris with .broken-* or .rolled-back-* names, use the scheduled recovery sweep.',
    chaining: 'backup:restore_clone_cleanup (dryRun:true) → review candidates/protected → dryRun:false.',
    seeAlso: ['backup:restore (create a clone)', 'backup:promote (promote a clone to live)'],
  },
  requirePrincipal: false,
  agentRoles: ['operator', 'debugger'],
  args: z.object({
    maxAgeDays: z.number().int().min(1).max(3650).default(30),
    dryRun: z.boolean().default(true),
  }),
  async handler(args) {
    const maxAgeDays = args.maxAgeDays ?? Math.round(DEFAULT_RESTORED_CLONE_MAX_AGE_MS / DAY_MS);
    const dryRun = args.dryRun ?? true;
    const result = await sweepRestoredClones(workspacesRoot(), {
      maxAgeMs: maxAgeDays * DAY_MS,
      dryRun,
    });
    return {
      data: {
        workspaceId: activeWorkspaceId(),
        maxAgeDays,
        ...result,
      },
    };
  },
});
