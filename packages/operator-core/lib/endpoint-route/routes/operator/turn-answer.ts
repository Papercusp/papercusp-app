/**
 * POST /api/operator/conversations/:id/turn-answer
 *
 * Historical-replay surface for chat:ask_choice cards persisted before
 * the bespoke-card-improvements migration. Atomic answered-mark + user-turn
 * append in one PG transaction.
 *
 * Ported from app/api/operator/conversations/[id]/turn-answer/route.ts. `auth: 'loopback'` (auth-tier Wave 1).
 */
import { getOrgPg } from '@papercusp/db-org';
import { askChoiceOptionIds } from '../../../ask-choice-options';
import { canonicalToolName } from '../../../operator-mcp-tools';
import { notifySyncInvalidate } from '../../../sync-sse';
import { activeWorkspaceId } from '../../../workspace-registry';
import { getConversationById } from '../../../operator-conversations';
import { defineTool } from '@papercusp/agent-mcp';

interface Body {
  assistantSeq: number;
  toolIndex: number;
  picks?: Array<{ option_id: string; label: string }>;
  declined?: boolean;
}

export default defineTool({
  method: 'POST',
  path: '/operator/conversations/:id/turn-answer',
  auth: 'loopback',
  async handler(req, ctx) {
    const conversationId = ctx.params.id as string;
    if (!(await getConversationById(conversationId))) {
      return Response.json({ error: 'conversation not found' }, { status: 404 });
    }
    const body = (await req.json().catch(() => null)) as Body | null;
    const picks = Array.isArray(body?.picks) ? body.picks : [];
    const declined = body?.declined === true;
    const validPicks =
      picks.length >= 1 &&
      picks.length <= 6 &&
      picks.every(
        (p) =>
          p &&
          typeof p.option_id === 'string' &&
          p.option_id.length > 0 &&
          typeof p.label === 'string' &&
          p.label.length > 0,
      );
    if (
      !body ||
      typeof body.assistantSeq !== 'number' ||
      typeof body.toolIndex !== 'number' ||
      body.toolIndex < 0 ||
      (declined ? picks.length !== 0 : !validPicks)
    ) {
      return Response.json(
        {
          error:
            'assistantSeq:number, toolIndex:number, and either picks:[{option_id, label}, ...] (1..6) or declined:true required',
        },
        { status: 400 },
      );
    }

    const { sql } = getOrgPg();
    const now = Date.now();
    const answeredJson = JSON.stringify({
      picks,
      ...(declined ? { declined: true } : {}),
      at: now,
    });
    const joinedLabels = declined ? 'Skipped' : picks.map((p) => p.label).join(' · ');

    try {
      const result = await sql.begin(async (tx) => {
        const rows = (await tx.unsafe(
          `SELECT id, tools FROM harness_shared.operator_turns
            WHERE conversation_id = $1 AND seq = $2 AND role = 'assistant'
            FOR UPDATE`,
          [conversationId, body.assistantSeq],
        )) as Array<{ id: string; tools: unknown }>;

        if (rows.length === 0) return { kind: 'not_found' as const };
        const tools = Array.isArray(rows[0].tools)
          ? (rows[0].tools as Array<Record<string, unknown>>)
          : [];
        const tool = tools[body.toolIndex];
        if (!tool || typeof tool !== 'object') return { kind: 'bad_index' as const };
        // WI-4949: a row persisted before the ingest-side canonicalization fix
        // (or one the read-side normalization in operator-conversations.ts
        // hasn't touched, since this query bypasses that helper for an atomic
        // FOR UPDATE read) may still carry the Claude-sanitized `chat_ask_choice`
        // name. Un-sanitize before comparing so an old card's click doesn't 400
        // as "wrong_tool" even though the card rendered correctly.
        const toolName = typeof tool.name === 'string' ? canonicalToolName(tool.name) : tool.name;
        if (toolName !== 'chat:ask_choice') {
          return { kind: 'wrong_tool' as const, name: toolName };
        }
        if (tool.answered) {
          return { kind: 'already_answered' as const, answered: tool.answered };
        }
        // WI-5175: `options` is the model's RAW input and may be a JSON STRING
        // rather than an array. The previous `(args?.options ?? []).map(...)`
        // assumed an array — `??` only catches null/undefined, so a string fell
        // through and `.map` threw, 500ing the click as
        // "turn-answer failed: ((intermediate value) ?? []).map is not a function".
        // askChoiceOptionIds coerces (shared with the render path, so the two
        // can't drift apart again) and returns an empty set when the payload is
        // unusable — which the size check below already treats as "can't
        // validate", never as "reject the pick".
        const args = (tool.input ?? tool.args) as { options?: unknown } | undefined;
        const knownIds = askChoiceOptionIds(args?.options);
        if (knownIds.size > 0) {
          const unknown = picks.filter((p) => !knownIds.has(p.option_id)).map((p) => p.option_id);
          if (unknown.length > 0) {
            return { kind: 'unknown_option' as const, validIds: [...knownIds], unknownIds: unknown };
          }
        }

        await tx.unsafe(
          `UPDATE harness_shared.operator_turns
              SET tools = jsonb_set(
                COALESCE(tools, '[]'::jsonb),
                ARRAY[$1::text, 'answered'],
                $2::jsonb,
                true
              )
            WHERE conversation_id = $3 AND seq = $4`,
          [String(body.toolIndex), answeredJson, conversationId, body.assistantSeq],
        );

        const nextSeq = (await tx.unsafe(
          `SELECT COALESCE(MAX(seq), -1) + 1 AS s
             FROM harness_shared.operator_turns
            WHERE conversation_id = $1`,
          [conversationId],
        )) as Array<{ s: number }>;
        const userSeq = Number(nextSeq[0].s);
        const inserted = (await tx.unsafe(
          `INSERT INTO harness_shared.operator_turns
             (conversation_id, seq, role, text, source, created_at, workspace_id)
           VALUES ($1, $2, 'user', $3, 'card_pick', $4, $5)
           RETURNING id, seq`,
          [conversationId, userSeq, joinedLabels, now, activeWorkspaceId()],
        )) as Array<{ id: string; seq: number }>;

        return { kind: 'ok' as const, userSeq, userId: inserted[0].id };
      });

      if (result.kind === 'not_found') {
        return Response.json({ error: 'assistant turn not found' }, { status: 404 });
      }
      if (result.kind === 'bad_index') {
        return Response.json({ error: 'toolIndex out of range' }, { status: 400 });
      }
      if (result.kind === 'wrong_tool') {
        return Response.json(
          { error: `tool at index is "${result.name}", not chat:ask_choice` },
          { status: 400 },
        );
      }
      if (result.kind === 'already_answered') {
        return Response.json(
          { error: 'already answered', answered: result.answered },
          { status: 409 },
        );
      }
      if (result.kind === 'unknown_option') {
        return Response.json(
          {
            error: 'unknown option_id(s) — not present in args.options',
            unknownIds: result.unknownIds,
            validIds: result.validIds,
          },
          { status: 400 },
        );
      }

      // The answer mutates an existing assistant row and appends a user row.
      // One invalidation now covers both consumers: since P-025 the live tail
      // and the reload bootstrap are the SAME `operatorTurns.page` query (the
      // separate `operatorTurns.byConversation` name was removed), so the
      // former two-name fan-out would be a duplicate of itself.
      void notifySyncInvalidate('operatorTurns.page', { conversationId })
        .catch(() => { /* best-effort */ });

      return Response.json({
        ok: true,
        userSeq: result.userSeq,
        userId: result.userId,
        answeredAt: now,
      });
    } catch (err) {
      return Response.json(
        { error: `turn-answer failed: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 },
      );
    }
  },
});
