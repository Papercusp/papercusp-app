/**
 * platform:dogfood_verify — assert the internal fork→PR dogfood loop round-tripped
 * (PLAN pr-system-completion-dogfood, PR-5 item 2 — the "Done" witness, made
 * owner-invokable).
 *
 * The runnable surface for `verifyDogfoodRoundTrip` (lib/pr-host/dogfood-roundtrip.ts):
 * given a contributed PR url, it reads each plane and reports which legs of the loop
 * completed — prTracked (PR-4 producer wrote the WI↔PR row), reviewed (PR-2 emitted a
 * report), merged, shipped (completion_ref stamped), linked — and whether the loop is
 * `ok` (every REQUIRED leg passed). Read-only; no side effects. PR-2's report reader
 * is wired in (`defaultReadReviewReport`) so the optional `reviewed` leg is checked.
 *
 * This is the one-call check for "did my fork→PR member contribution actually make it
 * to canonical, with the WI shown shipped + linked?" — the brief's success criterion.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import {
  verifyDogfoodRoundTrip,
  defaultReadReviewReport,
} from '../../pr-host/dogfood-roundtrip';
import { PLATFORM_SELF_POT_SLUG } from '../../pot/enable-platform-mode';

const text = (payload: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
});

export default defineTool({
  name: 'platform:dogfood_verify',
  profile: 'engineer',
  description:
    "Assert the internal fork→PR dogfood loop round-tripped for a contributed PR: reads the WI↔PR producer row, the agent-review report, the merged state, and the completion_ref ship-stamp, and returns {ok, stages, featureId, gaps}. `ok` is true iff every required leg (prTracked, merged, shipped, linked) passed; the agent-review leg is optional. Read-only.",
  guidance: {
    when: 'After a member fork→PR contribution (platform:contribute) has been reviewed + merged, to confirm the whole loop closed — the WI shows shipped + linked PR. The brief\'s Done check.',
    notWhen:
      'Opening the PR — platform:contribute. Listing PRs — the PRs tab. Tidying forks — platform:fork_gc.',
    chaining:
      'platform:enable → platform:contribute {kind:\'pr\'} → (the system:pr-poll daemon reviews/merges) → platform:dogfood_verify { prUrl } to assert ok:true.',
    seeAlso: [
      'platform:contribute (open the PR this verifies)',
      'platform:fork_gc (tidy the fork after)',
    ],
  },
  capability: 'harness:read',
  crossWorkspace: true,
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    prUrl: z
      .string()
      .min(1)
      .max(500)
      .describe('Full PR URL on the host (e.g. https://github.com/Papercusp/papercup/pull/42).'),
    harnessSlug: z
      .string()
      .min(1)
      .max(150)
      .optional()
      .describe(`The member harness the PR contributes to (default the self-hive member ${PLATFORM_SELF_POT_SLUG}).`),
    workspace: z.string().max(120).optional().describe('Workspace id (default: active workspace).'),
  }),
  async handler(args, ctx) {
    const workspaceId =
      args.workspace ?? ctx?.workspaceId ?? ctx?.principal?.workspaceId ?? activeWorkspaceId();
    const harnessSlug = args.harnessSlug ?? PLATFORM_SELF_POT_SLUG;
    try {
      const verdict = await verifyDogfoodRoundTrip({
        workspaceId,
        harnessSlug,
        prUrl: args.prUrl,
        readReviewReport: defaultReadReviewReport,
      });
      return text({ harnessSlug, prUrl: args.prUrl, ...verdict });
    } catch (e) {
      return text({
        ok: false,
        error: 'dogfood_verify_failed',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  },
});
