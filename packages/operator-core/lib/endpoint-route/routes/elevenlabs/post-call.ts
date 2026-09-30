/**
 * POST /api/elevenlabs/post-call — ElevenLabs post-call webhook receiver.
 * Ported from app/api/elevenlabs/post-call/route.ts. `auth: 'loopback'` (auth-tier Wave 1) —
 * authenticated by its own HMAC-SHA256 signature check.
 */
import crypto from 'node:crypto';
import { getOrgPg, generated } from '@papercusp/db-org';
import { eq } from 'drizzle-orm';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';

const ot = generated.operatorTurnsInHarnessShared;
const oc = generated.operatorConversationsInHarnessShared;

const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

function verifySignature(rawBody: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const [k, v] = p.split('=');
      return [k.trim(), v?.trim() ?? ''];
    }),
  );
  const tsStr = parts.t;
  const sig = parts.v0;
  if (!tsStr || !sig) return false;
  const tsMs = Number(tsStr) * 1000;
  if (!Number.isFinite(tsMs)) return false;
  if (Math.abs(Date.now() - tsMs) > TIMESTAMP_TOLERANCE_MS) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${tsStr}.${rawBody}`).digest('hex');
  if (sig.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(sig, 'utf8'), Buffer.from(expected, 'utf8'));
}

interface TranscriptionPayload {
  type: 'post_call_transcription';
  data: {
    conversation_id: string;
    status?: string;
    agent_id?: string;
    metadata?: { call_duration_secs?: number };
    has_audio?: boolean;
  };
}
type WebhookEvent = TranscriptionPayload | { type: string; data?: { conversation_id?: string } };

export default defineTool({
  method: 'POST',
  path: '/elevenlabs/post-call',
  auth: 'loopback',
  async handler(req) {
    const secret = process.env.ELEVENLABS_WEBHOOK_SECRET;
    const rawBody = await req.text();
    const sigHeader = req.headers.get('elevenlabs-signature');
    if (!secret) {
      console.error('[el-webhook] ELEVENLABS_WEBHOOK_SECRET not set — refusing to process');
      return Response.json({ error: 'webhook secret not configured' }, { status: 503 });
    }
    if (!verifySignature(rawBody, sigHeader, secret)) {
      console.warn('[el-webhook] invalid signature');
      return Response.json({ error: 'invalid signature' }, { status: 401 });
    }
    let event: WebhookEvent;
    try {
      event = JSON.parse(rawBody) as WebhookEvent;
    } catch {
      return Response.json({ error: 'invalid json' }, { status: 400 });
    }

    const { db, sql } = getOrgPg();
    const elConvId = (event as TranscriptionPayload).data?.conversation_id ?? null;
    if (!elConvId) return Response.json({ received: true, note: 'no conversation_id' });

    const found = await db
      .selectDistinct({ conversation_id: ot.conversationId })
      .from(ot)
      .where(eq(ot.elConvId, elConvId))
      .limit(1);
    if (found.length === 0) {
      return Response.json({ received: true, note: 'no matching conversation' });
    }
    const ourId = found[0].conversation_id;

    if (event.type === 'post_call_transcription') {
      const data = (event as TranscriptionPayload).data;
      await sql`
        UPDATE harness_shared.operator_conversations
           SET ended_at = COALESCE(ended_at, ${Date.now()}),
               el_conversation_ids =
                 CASE WHEN ${elConvId} = ANY(el_conversation_ids)
                      THEN el_conversation_ids
                      ELSE array_append(el_conversation_ids, ${elConvId})
                 END,
               has_audio = COALESCE(${data.has_audio ?? null}::boolean, has_audio)
         WHERE id = ${ourId}
      `;
      let durationSecs = Number(data.metadata?.call_duration_secs ?? 0);
      let durationSource: 'webhook' | 'estimated' | 'unknown' = 'webhook';
      if (!Number.isFinite(durationSecs) || durationSecs <= 0) {
        try {
          const rows = await sql`
            SELECT EXTRACT(EPOCH FROM (
              COALESCE(MAX(created_at), now()) - COALESCE(MIN(created_at), now())
            ))::int AS span_secs
            FROM harness_shared.operator_turns
            WHERE conversation_id = ${ourId} AND el_conv_id = ${elConvId}
          `;
          const span = Number(rows?.[0]?.span_secs ?? 0);
          if (Number.isFinite(span) && span > 0) {
            durationSecs = span;
            durationSource = 'estimated';
          }
        } catch {
          /* keep 0 */
        }
      }
      const workspaceId = activeWorkspaceId();
      try {
        await sql`
          INSERT INTO harness_shared.el_conv_calls
            (conversation_id, agent_id, workspace, duration_secs)
          VALUES (${elConvId}, ${data.agent_id ?? null}, ${workspaceId}, ${Math.max(0, durationSecs)})
          ON CONFLICT (conversation_id) DO NOTHING
        `;
        if (durationSource !== 'webhook') {
          console.warn(
            `[el-post-call] call_duration_secs missing/zero for ${elConvId}; ` +
              `wrote duration=${durationSecs}s from ${durationSource} source.`,
          );
        }
      } catch (err) {
        console.warn('[el-post-call] el_conv_calls insert failed', err);
      }
    } else if (event.type === 'post_call_audio') {
      await db.update(oc).set({ hasAudio: true }).where(eq(oc.id, ourId));
    }
    return Response.json({ received: true });
  },
});
