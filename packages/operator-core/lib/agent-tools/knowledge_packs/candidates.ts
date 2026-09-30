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
import { defineTool } from '@papercusp/agent-mcp';
import { FLAG_OFF, knowledgePacksEnabled, text } from './_shared';

export default defineTool({
  name: 'knowledge_packs:candidates',
  capability: 'memory:read',
  description:
    'List knowledge-pack item CANDIDATEs — cross-hive recurring lessons the recurrence-escalation loop staged (default: pending only). Most are auto-reviewed and auto-adopted/dismissed on a schedule; this lists whatever is still pending that sweep (or filter to adopted/dismissed to see the outcome). Each carries provenance: the friction signature, the scopes it recurred across, the recurrence count, and the source improvement-item ids.',
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
  }),
  async handler(args) {
    if (!(await knowledgePacksEnabled())) return text(FLAG_OFF);
    // Candidates are GLOBAL (P-002) — no workspace filter; the queue is fleet-wide.
    const { listKnowledgePackCandidates } = await import('../../knowledge-packs/candidates');
    const candidates = await listKnowledgePackCandidates({
      status: args.status ?? 'pending',
      ...(args.limit ? { limit: args.limit } : {}),
    });
    return text({ ok: true, count: candidates.length, candidates });
  },
});
