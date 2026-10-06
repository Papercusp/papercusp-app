/**
 * git-sync:send-green — on-demand "send what's green now" for a working-copy (review) pot
 * (plan pot-review-integration-mode-2026-10-05 P-020, D-007). Opens or updates the standing
 * PR from the working copy's main to the main repository without waiting for the next gate
 * promotion. It pushes no code: the working copy's main only ever holds commits the pot's
 * green gate already promoted, so this can only send tested work.
 */
import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { activeWorkspaceId } from '../../workspace-registry';
import { operatorHomeHarnessSlug } from '../../harness/operator-home-harness';
import { projectDirForSlug } from '../../operator-notes';
import {
  createDefaultSendStandingPrNowDeps,
  sendStandingPrNow,
} from '../../harness/git-sync/promotion-push-target';

function textResult(payload: Record<string, unknown>) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] };
}

export default defineTool({
  name: 'git-sync:send-green',
  profile: 'engineer',
  description:
    "Working-copy pots: open or update the standing PR from the working copy's main (gate-promoted commits only) to the main repository now.",
  capability: 'operator:write',
  guidance: {
    when: 'A review-mode pot has green work on its working copy and you want the standing PR refreshed now.',
    notWhen: 'Direct-mode pots (no standing PR), or to ship untested commits: it only sends what the gate promoted.',
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES, 'cup', 'release-fixer', 'release-manager'],
  rolesQuota: { operator: { perRun: 10 } },
  args: z.object({
    installSlug: z.string().max(120).optional().describe('Pot install slug (default: the operator home harness).'),
    harness: z.string().max(120).optional().describe('Alias for installSlug.'),
  }),
  async handler(args) {
    const slug = args.installSlug ?? args.harness ?? operatorHomeHarnessSlug();
    const workspaceId = activeWorkspaceId();
    const repoDir = await projectDirForSlug(slug, workspaceId);
    if (!repoDir) {
      return textResult({ ok: false, slug, error: `No repository path is registered for install "${slug}".` });
    }
    const log: string[] = [];
    try {
      const deps = await createDefaultSendStandingPrNowDeps((line) => log.push(line));
      const outcome = await sendStandingPrNow({ repoPath: repoDir, workspaceId, ref: 'main' }, deps);
      const ok = outcome.kind !== 'sent' || outcome.standingPr.ok;
      return textResult({ ok, slug, ...outcome, log });
    } catch (e) {
      return textResult({ ok: false, slug, error: e instanceof Error ? e.message : String(e), log });
    }
  },
});
