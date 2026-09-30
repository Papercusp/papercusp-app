/**
 * GET /api/operator/state-snapshot → text/event-stream
 *
 * SSE stream of state-channel snapshots for the active workspace
 * (chat:ask_choice card rendering).
 *
 * Ported from app/api/operator/state-snapshot/route.ts. `auth: 'public'` —
 * session-cookie check inline (preserves the 401 response shape).
 */
import { sseResponse } from '@papercusp/sse';
import {
  snapshotWorkspace,
  subscribeWorkspace,
  chooseSnapshotEmission,
  type VersionedSnapshot,
  type SnapshotDelta,
} from '@papercusp/agent-mcp';
import { getSessionUserOrLocalDefault } from '../../session-or-local';
import { activeWorkspaceId } from '../../../workspace-registry';
import { defineTool } from '@papercusp/agent-mcp';
import { getFlag } from '@papercusp/flags/server';
import { FLAGS } from '@papercusp/flags';

type StateSnapshotVocabulary = {
  /** Full per-run snapshot — the baseline on connect, and the fallback when a delta
   *  can't be computed (P-009 agent-tool-delta-protocol). */
  snapshot: VersionedSnapshot;
  /** Per-run data-carrying delta vs the last emitted snapshot — only to clients that
   *  opt in with `?delta=1` (backward-compatible: others always get full snapshots). */
  delta: SnapshotDelta;
}

export default defineTool({
  method: 'GET',
  path: '/operator/state-snapshot',
  auth: 'public',
  // Long-lived SSE — exempt from the route-stack watchdog (EI-110: the 30s
  // default 408'd healthy streams).
  timeoutSec: null,
  // SSE — one route-stack run per long-lived connection; a route_invocations
  // row per connect carries little signal (RFC Q7). Don't record it.
  sampleRate: 0,
  async handler(req) {
    // WI-5044: session user OR (loopback-only) the seeded default user — the
    // desktop webview has no session cookie, and a strict cookie check left
    // the whole live-card channel dead on the shipping product.
    const user = await getSessionUserOrLocalDefault(req);
    if (!user) {
      return new Response('unauthorized', { status: 401 });
    }
    const workspaceId = activeWorkspaceId();
    // P-009 opt-in: a delta-aware client requests `?delta=1`, but the flag (default
    // OFF) is the cutover kill-switch — read once per connection. OFF ⇒ full snapshots
    // exactly as before, regardless of the param. The client always advertises ?delta=1.
    const wantsDelta =
      new URL(req.url).searchParams.get('delta') === '1' &&
      (await getFlag(FLAGS.STATE_SNAPSHOT_DELTAS, 'system'));

    return sseResponse<StateSnapshotVocabulary>({
      signal: req.signal,
      heartbeatMs: 15_000,
      initialHeartbeat: true,
      setup: async (sink) => {
        // Last snapshot emitted per run — the base a delta is computed against.
        const lastByRun = new Map<string, VersionedSnapshot>();
        const emit = (vs: VersionedSnapshot): void => {
          if (sink.closed) return;
          const out = chooseSnapshotEmission(lastByRun.get(vs.runId), vs, wantsDelta);
          if (out.event === 'delta') sink.event('delta', out.data);
          else sink.event('snapshot', out.data);
          lastByRun.set(vs.runId, vs);
        };
        for (const vs of snapshotWorkspace(workspaceId)) emit(vs);
        const off = subscribeWorkspace(workspaceId, (vs) => emit(vs));
        sink.onClose(off);
      },
    });
  },
});
