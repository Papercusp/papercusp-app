/**
 * GET /api/provision/stream?harness=&plugin=&runId=
 *
 * Server-Sent Events stream of audit-log entries for one (harness,
 * plugin) pair: on-connect PG backfill + live updates via the
 * in-process provision-audit-bus. Closes on a terminal kind for a
 * matching `runId`.
 *
 * Ported from app/api/provision/stream/route.ts. `auth: 'public'`;
 * `sampleRate: 0` — an SSE connection is one route-stack run, telemetry
 * on it carries little signal. The handler returns the streaming
 * `Response` immediately, so the route-stack's invoke-timeout never
 * fires against the long-lived stream (it's cleared once the stack
 * returns); the stream's own lifecycle is tied to `req.signal`.
 */
import { sseResponse } from '@papercusp/sse';
import { readAudit, type AuditEntry } from '../../../provision/audit-log';
import { subscribe as subscribeAudit } from '../../../provision-audit-bus';
import { defineTool } from '@papercusp/agent-mcp';

const DEFAULT_BACKFILL = 200;

const TERMINAL_KINDS = new Set([
  'setup-completed', 'setup-failed',
  'teardown-completed', 'teardown-failed',
  'verify-completed', 'verify-failed',
]);

interface Events {
  // Concrete event names are per-AuditEntry.kind — too dynamic for an
  // exact generic. The payload is an AuditEntry OR a small synthetic
  // record (`attached`, `done`); `unknown` covers both without forcing
  // every emit site to widen. Record-shaped keeps the API flexible.
  [eventName: string]: unknown;
}

export default defineTool({
  method: 'GET',
  path: '/provision/stream',
  auth: { trust: ['verified', 'trusted'] },
  sampleRate: 0,
  handler(req) {
    const url = new URL(req.url);
    const harness = url.searchParams.get('harness') ?? '';
    const plugin = url.searchParams.get('plugin') ?? '';
    const runId = url.searchParams.get('runId') ?? undefined;
    const since = url.searchParams.get('since') ?? undefined;
    if (!harness || !plugin) {
      return new Response('harness + plugin required', { status: 400 });
    }

    return sseResponse<Events>({
      signal: req.signal,
      heartbeatMs: 15_000,
      initialHeartbeat: false,
      setup: async (sink) => {
        // Backfill from PG. readAudit respects workspace scope + `since`.
        let entries: AuditEntry[] = [];
        try {
          entries = await readAudit(harness, plugin, {
            limit: since ? 5_000 : DEFAULT_BACKFILL * 4,
            sinceTs: since,
          });
          if (!since && entries.length > DEFAULT_BACKFILL) {
            entries = entries.slice(-DEFAULT_BACKFILL);
          }
        } catch { /* table missing or transient — empty backfill */ }

        for (const entry of entries) {
          if (runId && entry.runId && entry.runId !== runId) continue;
          sink.event(entry.kind, entry);
          if (entry.runId === runId && TERMINAL_KINDS.has(entry.kind)) {
            sink.event('done', { reason: 'terminal-during-backfill', kind: entry.kind });
            sink.close();
            return;
          }
        }

        sink.event('attached', { harness, plugin, runId });

        const sub = subscribeAudit(`${harness}:${plugin}`, (env) => {
          if (sink.closed) return;
          const entry = env.entry as AuditEntry;
          if (runId && entry.runId && entry.runId !== runId) return;
          sink.event(entry.kind, entry);
          if (entry.runId === runId && TERMINAL_KINDS.has(entry.kind)) {
            sink.event('done', { reason: 'terminal', kind: entry.kind });
            sink.close();
          }
        });
        sink.onClose(sub.unsubscribe);
      },
    });
  },
});
