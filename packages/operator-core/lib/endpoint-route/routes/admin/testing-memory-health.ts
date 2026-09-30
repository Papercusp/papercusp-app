/**
 * GET /api/admin/testing/memory/health — cheap status snapshot for the
 * /admin/testing?tab=memory header strip. No writes; safe to poll on a
 * timer.
 */
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { getMemoryClient, getResolvedMode } from '../../../memory/mem0-client';
import { readCredentials } from '../../../credentials';

interface HealthPayload {
  pgvector: boolean;
  mem0_ready: boolean;
  embedder_mode: ReturnType<typeof getResolvedMode>;
  has_anthropic_key: boolean;
  has_openai_key: boolean;
  entry_count_user: number | null;
  entry_count_workspace_shared: number | null;
  recent_feedback_24h: number;
  blocking_reason: string | null;
}

export default defineTool({
  method: 'GET',
  path: '/admin/testing/memory/health',
  auth: { trust: ['verified', 'trusted'] },
  async handler(): Promise<Response> {
    const { sql } = getOrgPg();

    // pgvector probe
    let pgvector = false;
    try {
      const rows = await sql<{ extname: string }[]>`
        SELECT extname FROM pg_extension WHERE extname = 'vector'
      `;
      pgvector = rows.length > 0;
    } catch { /* leave false */ }

    // mem0 client + embedder
    let mem0_ready = false;
    try {
      const client = await getMemoryClient();
      mem0_ready = client !== null;
    } catch { /* leave false */ }
    const embedder_mode = getResolvedMode();

    // credentials presence (masked check; never returns the keys)
    let has_anthropic_key = false;
    let has_openai_key = false;
    try {
      const creds = await readCredentials();
      has_anthropic_key = Boolean(creds.anthropic_api_key) || Boolean(process.env.ANTHROPIC_API_KEY);
      has_openai_key = Boolean(creds.openai_api_key) || Boolean(process.env.OPENAI_API_KEY);
    } catch {
      has_anthropic_key = Boolean(process.env.ANTHROPIC_API_KEY);
      has_openai_key = Boolean(process.env.OPENAI_API_KEY);
    }

    // Recent feedback events (cheap COUNT)
    let recent_feedback_24h = 0;
    try {
      const rows = await sql<{ n: string }[]>`
        SELECT COUNT(*)::text AS n
          FROM harness_shared.memory_feedback
         WHERE created_at >= now() - interval '24 hours'
      `;
      recent_feedback_24h = Number(rows[0]?.n ?? 0);
    } catch { /* table may not exist if migration 062 missing */ }

    // Best-effort mem0 entry counts (depends on mem0 having a client)
    let entry_count_user: number | null = null;
    let entry_count_workspace_shared: number | null = null;
    if (mem0_ready) {
      try {
        const client = await getMemoryClient();
        if (client) {
          // Counts are coarse — getAll is paginated at topK=5000 below.
          // We're after a "feels populated" signal, not a precise total.
          const ws = await client.getAll({ filters: { user_id: 'workspace:default' }, topK: 5000 });
          entry_count_workspace_shared = (ws.results ?? []).length;
        }
      } catch { /* leave null */ }
    }

    let blocking_reason: string | null = null;
    if (!pgvector) blocking_reason = 'pgvector extension missing from embedded PG';
    else if (embedder_mode === 'disabled' || embedder_mode === null) blocking_reason = 'no embedder available — add OpenAI key or install local transformers';
    else if (!mem0_ready) blocking_reason = 'mem0 client could not be constructed (PG or credentials)';

    const payload: HealthPayload = {
      pgvector,
      mem0_ready,
      embedder_mode,
      has_anthropic_key,
      has_openai_key,
      entry_count_user,
      entry_count_workspace_shared,
      recent_feedback_24h,
      blocking_reason,
    };
    return Response.json(payload);
  },
});
