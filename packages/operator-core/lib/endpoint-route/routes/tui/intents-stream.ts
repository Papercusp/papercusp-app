/**
 * GET /api/tui/intents/stream?client_id=X — SSE stream of pending intents for a
 * pui instance. The TUI analogue of /api/ui/intents/stream.
 *
 * LISTEN/NOTIFY-driven (agent-tool-delta-protocol-2026-06-22, Lane D / P-010): `tui:dispatch`
 * fires `NOTIFY tui_intents` on insert; the tui-intents bus wakes this route, which drains
 * new pending rows since its cursor. NO polling (replaces the old 250ms `setTimeout` loop;
 * the D-003 "no polling in pui" invariant still holds — pui only holds this SSE connection).
 * The `status='pending'` filter IS the resume contract — pending intents redeliver until
 * processed, so a reconnecting client (cursor reset to 0) re-receives anything outstanding.
 *
 * `auth: 'public'` — loopback-gated inline.
 */
import { sseResponse } from '@papercusp/sse';
import { managedSetInterval } from '@papercusp/scheduled-registry';
import { getOrgPg } from '@papercusp/db-org';
import { isLoopbackRequest } from '../../../superuser-token';
import { onTuiIntent } from '../../../tui-intents-bus';
import { defineTool } from '@papercusp/agent-mcp';

type Events = {
  message: { id: number; intent: string; args: Record<string, unknown> };
};

const DRAIN_LIMIT = 50;
// NOTIFY is the primary, low-latency path; this slow re-drain is a SAFETY BACKSTOP so a
// missed notification (e.g. a dropped LISTEN connection) can never strand a pending intent
// on this critical dispatch path. ~12x less frequent than the old 250ms hot poll.
const BACKSTOP_MS = 3000;

export default defineTool({
  method: 'GET',
  path: '/tui/intents/stream',
  auth: 'public',
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
                FROM harness_shared.tui_intents
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
             
            console.warn('[tui-intents] drain error', e);
          } finally {
            draining = false;
          }
        };

        unsubscribe = onTuiIntent((notifiedClientId) => {
          if (notifiedClientId && notifiedClientId !== clientId) return;
          void drain();
        });
        void drain(); // initial: deliver intents already pending at connect
        // Safety backstop (see BACKSTOP_MS) — never strand a pending intent on a missed NOTIFY.
        const backstop = managedSetInterval('tui-intents-backstop', BACKSTOP_MS, () => drain(), {
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
