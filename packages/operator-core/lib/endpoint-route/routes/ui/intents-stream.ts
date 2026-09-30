/**
 * GET /api/ui/intents/stream?client_id=X — SSE stream of pending UI intents.
 *
 * LISTEN/NOTIFY-driven (agent-tool-delta-protocol-2026-06-22, Lane D / P-010): `ui:dispatch`
 * fires `NOTIFY ui_intents` on insert; the ui-intents bus wakes this route, which drains
 * new pending rows since its cursor. NO polling (replaces the old 250ms `setTimeout` loop).
 * The `status='pending'` filter IS the resume contract — a pending intent is redelivered
 * until it's processed, so a reconnecting client (cursor reset to 0) re-receives anything
 * still outstanding.
 *
 * Ported from app/api/ui/intents/stream/route.ts. `auth: 'public'` — loopback inline.
 */
import { sseResponse } from '@papercusp/sse';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { getOrgPg } from '@papercusp/db-org';
import { isLoopbackRequest } from '../../../superuser-token';
import { onUiIntent } from '../../../ui-intents-bus';
import { defineTool } from '@papercusp/agent-mcp';
import type { UiIntentMessage } from '../../../cross-boundary-event-contracts';

type Events = {
  message: UiIntentMessage;
}

const DRAIN_LIMIT = 50;
// NOTIFY is the primary, low-latency path; this slow re-drain is a SAFETY BACKSTOP so a
// missed notification (e.g. a dropped LISTEN connection) can never strand a pending intent
// on this critical dispatch path. ~12x less frequent than the old 250ms hot poll.
const BACKSTOP_MS = 3000;

export default defineTool({
  method: 'GET',
  path: '/ui/intents/stream',
  auth: 'public',
  // SSE — one route-stack run per long-lived connection; a route_invocations
  // row per connect carries little signal (RFC Q7). Don't record it.
  sampleRate: 0,
  async handler(req) {
    if (!isLoopbackRequest(req.headers)) {
      return Response.json({ error: 'loopback_required' }, { status: 403 });
    }
    const url = new URL(req.url);
    const clientId = (url.searchParams.get('client_id') ?? '').trim();
    if (!clientId) return Response.json({ error: 'client_id_required' }, { status: 400 });

    const { sql } = getOrgPg();

    return sseResponse<Events>({
      signal: req.signal,
      heartbeatMs: 15_000,
      initialHeartbeat: true,
      setup: (sink) => {
        let lastId = 0;
        let draining = false;
        let dirty = false;
        let unsubscribe: (() => void) | null = null;

        const drain = async (): Promise<void> => {
          if (sink.closed) return;
          if (draining) { dirty = true; return; } // coalesce concurrent wakes
          draining = true;
          try {
            do {
              dirty = false;
              const rows = await sql<Array<{ id: number; intent: string; args: Record<string, unknown> }>>`
                SELECT id, intent, args
                FROM harness_shared.ui_intents
                WHERE client_id = ${clientId}
                  AND status = 'pending'
                  AND id > ${lastId}
                ORDER BY id ASC
                LIMIT ${DRAIN_LIMIT}
              `;
              for (const row of rows) {
                if (sink.closed) return;
                const rid = Number(row.id);
                sink.event('message', { id: rid, intent: row.intent, args: row.args });
                if (rid > lastId) lastId = rid;
              }
              if (rows.length === DRAIN_LIMIT) dirty = true; // full page — keep draining
            } while (dirty && !sink.closed);
          } catch (e) {
             
            console.warn('[ui-intents] drain error', e);
          } finally {
            draining = false;
          }
        };

        // Wake on every ui:dispatch NOTIFY for THIS client; drain new pending rows.
        unsubscribe = onUiIntent((notifiedClientId) => {
          if (notifiedClientId && notifiedClientId !== clientId) return;
          void drain();
        });
        // Initial drain: deliver intents already pending at connect (and any inserted
        // in the window between connect and the subscribe above).
        void drain();
        // Safety backstop (see BACKSTOP_MS) — never strand a pending intent on a missed NOTIFY.
        const backstop = managedSetInterval('ui-intents-backstop', BACKSTOP_MS, () => drain(), {
          category: 'lifecycle',
          instanced: true,
        });

        sink.onClose(() => {
          backstop.stop();
          if (unsubscribe) unsubscribe();
        });
      },
    });
  },
});
