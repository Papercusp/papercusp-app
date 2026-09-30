import { z } from 'zod';
import { defineTool, SU_ROLES } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { requireWorkspaceId, resolveAgentIdentity } from '../coordination/identity';
import { classifyCallOrigin } from '../../telemetry-call-origin';

const PROMPT_HASH = /^[a-f0-9]{64}$/;
const TTL_MS = 10 * 60 * 1000;

export default defineTool({
  name: 'sessions:record-prompt-origin',
  profile: 'engineer',
  capability: 'activity:report',
  description: 'Record a short-lived, hook-authenticated interactive prompt stamp for transcript ingest. Called by UserPromptSubmit hooks; model clients are refused.',
  guidance: {
    when: 'Only from a first-party UserPromptSubmit hook after classifying the submitted prompt as OWNER (interactive).',
    notWhen: 'Never call by hand or from a model client; this is an authenticated hook-to-ingest carrier.',
  },
  requirePrincipal: false,
  agentRoles: [...SU_ROLES],
  args: z.object({
    sessionId: z.string().min(1).max(256),
    sourceKind: z.enum(['claude', 'omp', 'codex']).default('claude'),
    promptHash: z.string().regex(PROMPT_HASH),
    submittedAtMs: z.number().int().positive(),
  }),
  async handler(args, ctx) {
    const origin = classifyCallOrigin({ requestOrigin: ctx.requestOrigin });
    if (origin.origin !== 'hook' || origin.source !== 'declared') {
      return { data: { ok: false, recorded: false, error: 'hook_origin_required' } };
    }
    const identity = resolveAgentIdentity(ctx);
    const workspaceId = requireWorkspaceId(identity, 'sessions:record-prompt-origin');
    const submittedAt = new Date(args.submittedAtMs);
    if (Number.isNaN(submittedAt.getTime())) {
      return { data: { ok: false, recorded: false, error: 'invalid_submitted_at' } };
    }
    const expiresAt = new Date(args.submittedAtMs + TTL_MS);
    const sql = getOrgPg().sql;
    await sql`
      INSERT INTO harness_shared.session_prompt_origin_stamps
        (workspace_id, source_kind, session_id, prompt_hash, submitted_at, expires_at)
      VALUES (${workspaceId}, ${args.sourceKind}, ${args.sessionId}, ${args.promptHash}, ${submittedAt}, ${expiresAt})
      ON CONFLICT DO NOTHING
    `;
    return { data: { ok: true, recorded: true, expiresAt: expiresAt.toISOString() } };
  },
});
