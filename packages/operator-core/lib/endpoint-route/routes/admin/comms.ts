/**
 * /api/admin/comms/:kind/:verb — the GLOBAL communication-surface reads for the
 * /adv "Conversations" tab.
 *
 * The coordination Q&A substrate (coord_conversations) + the coord firehose
 * (coord_event_log) already have surfaces (/api/admin/coordination/* and the
 * `dev.coordFeed` sync observer). But the OTHER communication type the agents
 * produce had no global view — it's per-harness or archive-only:
 *
 *   - agent-chats — `agent_chats_consolidated`: every multi-turn agent chat
 *     session (scoper/architect/worker/… transcripts, with tokens + cost). The
 *     `agent_chats:*` MCP tools are PER-HARNESS (require a slug); this is the
 *     cross-harness roll-up the Conversations tab needs.
 *
 * (The work-item mail surface — `messages_consolidated` / messages:send /
 * messages:inbox — was retired; see retire-work-item-mail-surface-2026-07-26.)
 *
 * This is a read-only archive/consolidated table, so this is a focused admin
 * READ (one generic dispatcher), not a write surface — kept separate from the
 * MCP-re-dispatch in coordination.ts on purpose.
 */
import { defineTool, type RouteContext } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const t = await req.text();
    return t ? (JSON.parse(t) as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function clampLimit(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), 1000) : 200;
}

async function dispatch(req: Request, ctx: RouteContext): Promise<Response> {
  const kind = String(ctx.params.kind);
  const verb = String(ctx.params.verb);
  const body = await readBody(req);
  const limit = clampLimit(body.limit);
  const { sql } = getOrgPg();

  try {
    // ── agent chats — the per-feature/per-role multi-turn transcripts ──
    if (kind === 'agent-chats' && verb === 'list') {
      const harness = body.harness ? String(body.harness) : null;
      const role = body.role ? String(body.role) : null;
      // Capped list + a cheap COUNT over the SAME filter, so the rail can show
      // the TRUE total ("N of TOTAL") instead of the downloaded length.
      const [rows, totalRows] = await Promise.all([
        sql`
        SELECT id, harness_slug, role, feature_id, title,
               created_at, updated_at, archived_at,
               total_input_tokens, total_output_tokens, total_cost_usd_cents,
               jsonb_array_length(COALESCE(transcript, '[]'::jsonb)) AS turns
          FROM harness_shared.agent_chats_consolidated
         WHERE (${harness}::text IS NULL OR harness_slug = ${harness})
           AND (${role}::text IS NULL OR role = ${role})
         ORDER BY created_at DESC NULLS LAST
         LIMIT ${limit}`,
        sql<{ n: number }[]>`
        SELECT count(*)::int AS n
          FROM harness_shared.agent_chats_consolidated
         WHERE (${harness}::text IS NULL OR harness_slug = ${harness})
           AND (${role}::text IS NULL OR role = ${role})`,
      ]);
      return Response.json({ items: rows, total: totalRows[0]?.n ?? rows.length });
    }
    if (kind === 'agent-chats' && verb === 'get') {
      const id = String(body.id ?? '');
      const rows = await sql`
        SELECT id, harness_slug, role, feature_id, title, created_at, archived_at, transcript,
               total_input_tokens, total_output_tokens, total_cost_usd_cents
          FROM harness_shared.agent_chats_consolidated
         WHERE id = ${id}
         LIMIT 1`;
      return Response.json({ chat: rows[0] ?? null });
    }

    // ── deliberation threads — coord:thread / deliberate / vote posts, attached
    //    to an issue or a conversation (coord_threads + coord_thread_posts) ──
    if (kind === 'threads' && verb === 'list') {
      const [rows, totalRows] = await Promise.all([
        sql`
        SELECT thread_id, parent_kind, parent_ref, title, created_by, harness_slug,
               created_at, last_post_at, post_count
          FROM harness_shared.coord_threads
         ORDER BY last_post_at DESC NULLS LAST, created_at DESC NULLS LAST
         LIMIT ${limit}`,
        sql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.coord_threads`,
      ]);
      return Response.json({ items: rows, total: totalRows[0]?.n ?? rows.length });
    }
    if (kind === 'threads' && verb === 'get') {
      const threadId = String(body.thread_id ?? body.id ?? '');
      const [thread, posts] = await Promise.all([
        sql`SELECT thread_id, parent_kind, parent_ref, title, created_by, harness_slug,
                   created_at, last_post_at, post_count
              FROM harness_shared.coord_threads
             WHERE thread_id = ${threadId} LIMIT 1`,
        sql`SELECT id, author_id, body, created_at, harness_slug
              FROM harness_shared.coord_thread_posts
             WHERE thread_id = ${threadId}
             ORDER BY created_at ASC NULLS LAST
             LIMIT 1000`,
      ]);
      return Response.json({ thread: thread[0] ?? null, posts });
    }

  } catch (e) {
    // Fail-soft: a missing table / cold DB returns an empty set, never a 500 that
    // breaks the tab.
    return Response.json({ items: [], error: e instanceof Error ? e.message : String(e) });
  }

  return Response.json(
    { error: { code: 'unknown_verb', message: `comms verb '${kind}/${verb}' is not supported` } },
    { status: 404 },
  );
}

const route = defineTool({
  method: 'POST',
  path: '/admin/comms/:kind/:verb',
  // The admin Conversations UI runs as a verified loopback session.
  auth: { trust: ['verified', 'trusted'] },
  handler: dispatch,
});

export default [route];
