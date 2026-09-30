/**
 * POST /api/operator/conversations/:id/silence-nudge
 *
 * Synthetic Ready card from the 30s silence-after-question timer.
 * Session-auth + 30 RPS (shared with /card-response).
 *
 * Ported from app/api/operator/conversations/[id]/silence-nudge/route.ts.
 * `auth: 'loopback'` (auth-tier Wave 1) — session check inline.
 */
import { z } from 'zod';
import { openRun, registerCard } from '@papercusp/agent-mcp';
import { getSessionUserOrLocalDefault } from '../../session-or-local';
import { cardResponseRateAllow } from '../../../card-response-rate-limit';
import { defineTool } from '@papercusp/agent-mcp';

interface Body {
  workspaceId: string;
  voiceActive: boolean;
  wakeword?: string;
}

const READY_OPTION = { id: 'ready', label: 'Ready' } as const;

function buildFallbackText(voiceActive: boolean, wakeword: string | undefined): string {
  if (!voiceActive) return 'Click Ready when you want to continue.';
  const phrase = (wakeword ?? '').trim() || 'ready';
  return `When you're ready, click Ready or say ${phrase}.`;
}

export default defineTool({
  method: 'POST',
  path: '/operator/conversations/:id/silence-nudge',
  auth: 'loopback',
  async handler(req) {
    // WI-5044: session user OR (loopback-only) the seeded default user — the
    // desktop webview has no session cookie; the silence-nudge Ready card was
    // unmintable on the shipping product.
    const user = await getSessionUserOrLocalDefault(req);
    if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 });

    const body = (await req.json().catch(() => null)) as Body | null;
    if (
      !body ||
      typeof body.workspaceId !== 'string' ||
      body.workspaceId.length === 0 ||
      typeof body.voiceActive !== 'boolean' ||
      (body.wakeword !== undefined && typeof body.wakeword !== 'string')
    ) {
      return Response.json(
        { error: 'workspaceId (string), voiceActive (bool) required; wakeword optional string' },
        { status: 400 },
      );
    }

    if (!cardResponseRateAllow(user.id)) {
      return Response.json({ error: 'rate limit: 30 RPS per user' }, { status: 429 });
    }

    const runId = `silence-nudge-${crypto.randomUUID()}`;
    openRun({ workspaceId: body.workspaceId, runId });

    const timeoutMs = 120_000;
    const fallbackText = buildFallbackText(body.voiceActive, body.wakeword);

    const { correlationId } = registerCard({
      workspaceId: body.workspaceId,
      runId,
      spec: {
        prompt: 'Ready when you are.',
        dataSchema: z.object({
          picks: z.tuple([z.enum([READY_OPTION.id])]),
        }),
        presentation: {
          kind: 'radio',
          options: [READY_OPTION],
          voiceAnswerable: true,
        },
        fallbackText,
        allowDecline: false,
        timeoutMs,
      },
    });

    return Response.json({ correlationId, runId });
  },
});
