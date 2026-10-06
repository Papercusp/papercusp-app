/**
 * knowledge_packs:candidates — the fleet→pack candidate queue
 * (self-improvement-consume-edges-2026-06-12 P-032, brief B-11; auto-adopt
 * reversal owner-auto-adopt-fleet-lessons-2026-07-19 / WI-5414).
 *
 * Candidates are staged by the recurrence-escalation cross-scope promotion (a
 * lesson recurring across ≥2 scopes). They do NOT wait for a human anymore: a
 * scheduled automated review (the improvement-triage cadence) judges every
 * pending candidate and auto-adopts or auto-dismisses it via a machine
 * identity — see knowledge-packs/candidates.ts's autoAdoptPendingCandidates.
 * This read still defaults to `status: 'pending'` (what's awaiting that
 * sweep) so an owner override via knowledge_packs:decide_candidate still has
 * an id to act on ahead of the automated review.
 */
import { z } from 'zod';
import { defineTool, entityRef } from '@papercusp/agent-mcp';
import { resolveConcreteWorkspaceId } from '../../workspace-registry';
import { FLAG_OFF, knowledgePacksEnabled, text } from './_shared';

export default defineTool({
  name: 'knowledge_packs:candidates',
  capability: 'memory:read',
  description:
    'List pending knowledge-pack candidates: global fleet lessons and explicit identity lessons from your workspace. Fleet lessons are auto-reviewed; identity lessons require an explicit adopt/dismiss decision. Filter by identityId or status. Each carries its source and target provenance.',
  guidance: {
    when:
      'Check what fleet lessons are pending the automated review, or before knowledge_packs:decide_candidate (the id comes from here) to override ahead of the sweep.',
    notWhen:
      "To read a hive's installed learnings (knowledge_packs:list / memory:list) or the pack catalog (knowledge_packs:list).",
    chaining:
      'knowledge_packs:decide_candidate { id, action } to adopt into the fleet-lessons pack or dismiss now, ahead of the automated sweep; after an adopt (auto or manual), hives pick the item up via knowledge_packs:install/upgrade.',
    seeAlso: [
      'knowledge_packs:decide_candidate (adopt or dismiss a candidate — mostly automated now)',
      'knowledge_packs:upgrade (hives pick up an adopted item)',
    ],
  },
  crossWorkspace: true,
  args: z.object({
    status: z
      .enum(['pending', 'adopted', 'dismissed'])
      .optional()
      .describe('Filter by status. Default pending (the review queue).'),
    limit: z.number().int().min(1).max(500).optional(),
    identityId: z.string().min(1).max(120).optional().describe('Only reviewed learning candidates for this identity in the calling workspace.'),
    workspace: entityRef('workspace', { soft: true, max: 120 }).optional(),
  }),
  async handler(args, ctx) {
    if (!(await knowledgePacksEnabled())) return text(FLAG_OFF);
    // Fleet candidates are global; identity lessons are visible only in their workspace.
    const { listKnowledgePackCandidates } = await import('../../knowledge-packs/candidates');
    const candidates = await listKnowledgePackCandidates({
      status: args.status ?? 'pending',
      ...(args.limit ? { limit: args.limit } : {}),
      workspaceId: resolveConcreteWorkspaceId(args.workspace, ctx.principal?.workspaceId),
      ...(args.identityId ? { identityId: args.identityId } : {}),
    });
    return text({ ok: true, count: candidates.length, candidates });
  },
});
