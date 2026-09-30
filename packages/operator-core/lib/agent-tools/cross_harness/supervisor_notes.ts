/**
 * cross_harness:supervisor_notes — read supervisor notes for a harness.
 *
 * Mirrors GET /api/harness/:slug/supervisor-notes.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { readSupervisorNotes } from '../../cross-harness-data';
import { harnessRequiredResult, resolveConcreteHarnessSlug } from '../_harness-scope';

export default defineTool({
  name: 'cross_harness:supervisor_notes',
  profile: 'engineer',
  description: 'Read supervisor notes for a harness (id, body, source, created_at).',
  guidance: {
    when: 'You need the supervisor\'s annotations on a harness — context the supervisor logged that\'s not in audit_log.',
    notWhen: 'For escalation flags + raw notes from the on-disk files, use `harness:escalation`. supervisor_notes is the PG-backed view.',
    seeAlso: [
      'harness:escalation (escalation flags + raw notes from disk)',
      'cross_harness:recent_activity (cross-harness activity)',
    ],
  },
  capability: 'cross_harness:read',
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    slug: z.string().optional(),
    limit: z.number().int().positive().max(100).optional(),
  }),
  // Declarative precondition (adopt-event-rules-engines requires:-half): the
  // former in-handler `if (!slug) throw` guard, lifted.
  requires: [
    {
      id: 'harness-slug',
      when: {
        any: [{ 'args.slug': { truthy: true } }, { 'ctx.harnessSlug': { truthy: true } }],
      },
      error: 'cross_harness:supervisor_notes — slug required (passed or in spawn ctx)',
    },
  ],
  async handler(args, ctx) {
    // Precondition guarantees a slug arrived, but the operator `'*'` auto-default
    // is truthy and slips past it — route through the fail-loud resolver so `'*'`
    // is rejected, not read as a bogus `'*'` target harness (P-004).
    const slug = resolveConcreteHarnessSlug(args.slug, ctx);
    if (!slug) {
      return harnessRequiredResult('cross_harness:supervisor_notes');
    }
    const notes = await readSupervisorNotes(slug, args.limit);
    return { data: { slug, notes } };
  },
});
