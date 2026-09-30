/**
 * harness:escalation — read escalation + supervisor-notes for a harness.
 *
 * Reads from harness_escalations (PG-canonical, written by TS orchestrator
 * + bash run.sh), then harness_text_artifacts, then disk fallback.
 * Calls getEscalation() in lib/harness-readers.ts.
 */

import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getEscalation } from '../../harness-readers';

// + overwatch (overwatch-role-2026-06-15 B-01): reads aging escalations to nudge/escalate.
const ALL_ROLES = [...SU_ROLES, 'papercup', 'papercup-deep', 'kettle', 'release-fixer'] as const;

export default defineTool({
  name: 'harness:escalation',
  profile: 'engineer',
  description: 'Read escalation + supervisor-notes for a harness (PG-canonical; falls back to disk).',
  guidance: {
    when: 'User asks "what\'s flagged?", "what got escalated to the supervisor?", or you need to see the supervisor\'s notes on a harness.',
    notWhen: 'For general "what\'s wrong with X" (open issues), use `work_items:list`. Escalation files are a specific, narrower view than the issue list.',
    seeAlso: [
      'work_items:list (general open issues — the broader view)',
      'cross_harness:supervisor_notes (the PG-backed supervisor view)',
    ],
  },
  capability: 'harness:read',
  requirePrincipal: false,
  agentRoles: [...ALL_ROLES],
  args: z
    .object({
      slug: z.string().min(1).optional().describe('Harness slug (alias: harness).'),
      // EI-7146: this tool's id-arg was `slug`-only while the common cross-tool
      // convention for a harness-scoped call (docs:*, plans:*, work_items:list,
      // harness:overview's own `harness` param) is `harness` — a caller guessing
      // the dominant name got a bare zod validation error. Accept both; `slug`
      // stays primary (matches the sibling harness:status/pot:get bulk-id
      // convention this tool was built to mirror).
      harness: z.string().min(1).optional().describe('Harness slug — alias for `slug`.'),
      phase: z.string().optional(),
    })
    .refine((a) => Boolean(a.slug || a.harness), { message: 'pass `slug` (or `harness`)' }),
  async handler(args) {
    const slug = (args.slug ?? args.harness) as string;
    const result = await getEscalation(slug, args.phase);
    if (!result.ok) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              hasEscalation: false,
              escalation: null,
              supervisorNotes: null,
              mtimeMs: null,
            }),
          },
        ],
      };
    }
    const { escalation, supervisorNotes, mtimeMs } = result.data;
    const hasEscalation = !!(escalation && String(escalation).trim());
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ hasEscalation, escalation, supervisorNotes, mtimeMs }),
        },
      ],
    };
  },
});
