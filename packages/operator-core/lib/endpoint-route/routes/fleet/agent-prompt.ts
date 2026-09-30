/**
 * GET /api/fleet/agent-prompt — the prompt an agent is RUNNING ON (the dock's
 * prompt-pane, owner ask 2026-06-11 generalizing the brief-pane).
 *
 * Two sources, labeled so the pane can say which it shows:
 *   - `recorded` — a fleet spawn (`s-…` owner): the EXACT prompt_body its
 *     latest run was invoked with (harness_shared.harness_run_output,
 *     PG-canonical since Phase 4), plus the nursery row's brief/model/tier.
 *     The brief rides separately so the pane can lead with it — it's the
 *     per-agent signal; the rest of the prompt is mostly cross-bee boilerplate.
 *   - `rendered` — a non-spawn agent (the interactive queen, su sessions) has
 *     no recorded run prompt; with a `role` hint we render the role's
 *     workspace-level persona through the SAME assembler its launcher uses —
 *     what a fresh session of this role gets, not a transcript of the live one.
 *
 * Loopback-only (fleet-pane convention): a prompt can carry
 * project substrate + briefs; the only consumer is the local pui pane.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from '../../../workspace-registry';
import { assembleWorkspaceRolePrompt } from '../../../role-launch-spec';

const JSON_HEADERS = { 'content-type': 'application/json' } as const;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export default defineTool({
  method: 'GET',
  path: '/fleet/agent-prompt',
  auth: 'loopback',
  // Polled by an open prompt pane (slow tick; the body is launch-static).
  sampleRate: 0,
  async handler(req) {
    const u = new URL(req.url);
    const owner = u.searchParams.get('owner')?.trim();
    const role = u.searchParams.get('role')?.trim();
    if (!owner && !role) return json({ error: 'missing owner or role' }, 400);

    // Fleet spawn → the recorded prompt of its newest run.
    if (owner && owner.startsWith('s-')) {
      const { sql } = getOrgPg();
      const rows = (await sql`
        SELECT workspace_id, harness_slug, run_id, brief, model_spec, model_tier, status
        FROM harness_shared.spawned_agents
        WHERE session_owner = ${owner}
        ORDER BY started_at DESC
        LIMIT 1
      `) as Array<{
        workspace_id: string;
        harness_slug: string;
        run_id: string;
        brief: string | null;
        model_spec: string | null;
        model_tier: string | null;
        status: string;
      }>;
      const spawn = rows[0];
      if (!spawn) return json({ ok: true, owner, source: 'none' });
      const out = (await sql`
        SELECT prompt_body FROM harness_shared.harness_run_output
        WHERE harness_slug = ${spawn.harness_slug} AND run_id = ${spawn.run_id}
        LIMIT 1
      `) as Array<{ prompt_body: string | null }>;
      const prompt = out[0]?.prompt_body ?? null;
      return json({
        ok: true,
        owner,
        source: 'recorded',
        status: spawn.status,
        brief: spawn.brief,
        model: spawn.model_spec,
        tier: spawn.model_tier,
        prompt,
        chars: prompt?.length ?? 0,
      });
    }

    // Non-spawn agent with a role hint → live render of the role persona.
    if (role && /^[a-z0-9_-]{1,64}$/i.test(role)) {
      try {
        const ws = activeWorkspaceId();
        const rendered = assembleWorkspaceRolePrompt({ role, workspaceId: ws });
        return json({
          ok: true,
          owner: owner ?? null,
          source: 'rendered',
          role,
          prompt: rendered.text,
          promptFile: rendered.promptFile,
          chars: rendered.text.length,
        });
      } catch (e) {
        return json({ ok: true, owner: owner ?? null, source: 'none', error: (e as Error).message });
      }
    }

    return json({ ok: true, owner: owner ?? null, source: 'none' });
  },
});
