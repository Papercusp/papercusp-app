/**
 * GET /api/zero-harness/sse → text/event-stream
 *
 * SSE push endpoint for the harness sync layer. Heartbeat + update +
 * invalidate events; Last-Event-ID replay from 60s ring buffer.
 *
 * ⚠ NOT RETIRED — despite the name, THIS ROUTE is the LIVE desktop sync transport
 * (apps/operator/providers/HarnessSyncProvider.tsx). The retired surface is the
 * defunct `libs/zero-harness` PACKAGE (the Zero ZQL schema), NOT this endpoint.
 * Don't conflate the two (agent-tool-delta-protocol-2026-06-22, Lane D / P-010).
 *
 * Ported from app/api/zero-harness/sse/route.ts. `auth: 'public'`.
 */
import { sseResponse, parseLastEventId, type SyncSseEventVocabulary } from '@papercusp/sse';
import { subscribe, backfillSince, type SyncEvent } from '../../../sync-sse';
import {
  INTEREST_PARAM,
  MAX_DECLARED_QUERY_NAMES,
  parseInterestDeclaration,
  type InterestDeclaration,
  type InterestDisposition,
} from '@papercusp/sync/server';
import { pinModuleState } from '@papercusp/module-singleton';
import { defineTool } from '@papercusp/agent-mcp';

function payloadFor(ev: SyncEvent): {
  name: string;
  args?: unknown;
  data?: unknown[];
  tsMs: number;
} {
  const out: { name: string; args?: unknown; data?: unknown[]; tsMs: number } = {
    name: ev.name,
    tsMs: ev.ts,
  };
  if (ev.args !== undefined) out.args = ev.args;
  if (ev.data !== undefined) out.data = ev.data;
  return out;
}

/**
 * The interest-declaration wire contract lives in `@papercusp/sync` because
 * BOTH halves of this feature depend on it agreeing exactly: the client builds
 * the param with `withInterestParam`, this route reads it back. A second copy
 * of the name here would fail SILENTLY when it drifted — the server would
 * simply see no declaration and fan out everything, which looks like the
 * feature is off rather than broken.
 */
export { INTEREST_PARAM, MAX_DECLARED_QUERY_NAMES };

/**
 * Parse a client interest declaration into a name-membership predicate.
 *
 * Returns `undefined` — meaning NO filtering, i.e. exactly today's full
 * fan-out — for every ambiguous input, per D-002. The cases that matter:
 *
 *   - param absent          -> undefined. An un-upgraded client, or one
 *                              mid-handshake, is never degraded.
 *   - param present but the
 *     parsed set is EMPTY   -> undefined, NOT "send nothing". This is the
 *                              single most dangerous misreading available
 *                              here: read as an empty allow-list it would
 *                              silently starve the client completely, and the
 *                              symptom (a UI that never updates) looks like a
 *                              dead connection rather than a filter bug.
 *   - more than the cap     -> undefined (see MAX_DECLARED_QUERY_NAMES).
 *   - malformed URL / throw -> undefined.
 *
 * A client that genuinely wants nothing simply does not open the stream.
 */
export function interestFilterFor(url: string): ((e: SyncEvent) => boolean) | undefined {
  const { names } = interestDeclarationFor(url);
  if (names === undefined) return undefined;
  return (ev: SyncEvent) => names.has(ev.name);
}

/**
 * Counters for how connections' declarations actually resolved.
 *
 * Every fail-open case delivers the same OBSERVABLE behaviour — full fan-out —
 * so from the outside `over-cap` (a client that asked for filtering and did
 * not get it) is indistinguishable from `absent` (a client that never asked)
 * and from the feature being switched off entirely. That is a silent
 * reversion: the system is doing the pre-feature thing, correctly and
 * deliberately, and nothing anywhere says so. These counters are the one place
 * the difference is recorded.
 *
 * Pinned to `globalThis` because operator-core is reached under several loader
 * seams here (tsx's CJS preflight beside the ESM loader, bare specifier vs
 * relative path, the symlinked `node_modules/@papercusp/*`); an unpinned
 * module-scoped counter splits per module record and under-reports without
 * erroring — the exact shape of wrongness this counter exists to catch.
 */
const interestObservationState = pinModuleState(
  '@papercusp/operator-core.zero-harness-sse.interest-observations',
  () => ({
    counts: {
      declared: 0,
      absent: 0,
      empty: 0,
      'over-cap': 0,
      unreadable: 0,
    } as Record<InterestDisposition, number>,
    lastOverCap: null as { atMs: number; declaredCount: number } | null,
  }),
);

/** Snapshot of how declarations have resolved on this process. */
export function interestObservations(): {
  counts: Record<InterestDisposition, number>;
  lastOverCap: { atMs: number; declaredCount: number } | null;
} {
  return {
    counts: { ...interestObservationState.counts },
    lastOverCap: interestObservationState.lastOverCap,
  };
}

/** Reset the counters. Test-only seam; production never needs it. */
export function resetInterestObservations(): void {
  interestObservationState.counts = {
    declared: 0,
    absent: 0,
    empty: 0,
    'over-cap': 0,
    unreadable: 0,
  };
  interestObservationState.lastOverCap = null;
}

/**
 * Resolve a connection's declaration AND record how it resolved.
 *
 * `interestFilterFor` is derived from this, so the recorded disposition can
 * never disagree with the filter the connection actually got.
 */
export function interestDeclarationFor(url: string): InterestDeclaration {
  let decl: InterestDeclaration;
  try {
    decl = parseInterestDeclaration(new URL(url).searchParams.get(INTEREST_PARAM));
  } catch {
    // Unparseable URL -> unfiltered, never starved.
    decl = { disposition: 'unreadable', declaredCount: 0, failsOpen: true };
  }
  interestObservationState.counts[decl.disposition] += 1;
  if (decl.disposition === 'over-cap') {
    interestObservationState.lastOverCap = {
      atMs: Date.now(),
      declaredCount: decl.declaredCount,
    };
    // Loud on purpose: this is the only fail-open case where the client wanted
    // filtering, is entitled to it, and silently did not get it.
    console.warn(
      `[sync-sse] interest declaration OVER CAP — ${decl.declaredCount} names > ${MAX_DECLARED_QUERY_NAMES}; this connection reverts to FULL FAN-OUT`,
    );
  }
  return decl;
}

export default defineTool({
  method: 'GET',
  path: '/zero-harness/sse',
  auth: 'public',
  // Long-lived SSE — exempt from the route-stack watchdog (EI-110: the 30s
  // default 408'd healthy streams).
  timeoutSec: null,
  // Pure sync-transport — exempt from route_invocations telemetry so the
  // table doesn't flood (plan Q7: sampleRate 0 for pure sync transports).
  sampleRate: 0,
  async handler(req) {
    const lastEventId = parseLastEventId(req);
    const filter = interestFilterFor(req.url);

    return sseResponse<SyncSseEventVocabulary>({
      signal: req.signal,
      lastEventId,
      heartbeatMs: 15_000,
      initialHeartbeat: true,
      // NOTE: replay is deliberately NOT filtered. Sending a reconnecting
      // client more than it asked for is safe; sending it less is the silent
      // staleness this whole change is built to avoid, and the reconnect path
      // is exactly where a stale interest set is most likely (the client
      // reconnects precisely because its view just changed). Narrowing replay
      // is a separate, later decision with its own evidence.
      replay: () => {
        if (lastEventId == null || lastEventId <= 0) return [];
        return backfillSince(lastEventId).map((ev) => ({
          name: ev.data !== undefined ? ('update' as const) : ('invalidate' as const),
          data: payloadFor(ev),
          id: ev.id,
        }));
      },
      setup: async (sink) => {
        const handle = await subscribe(
          (ev) => {
            if (sink.closed) return;
            const name = ev.data !== undefined ? 'update' : 'invalidate';
            sink.event(name, payloadFor(ev), { id: ev.id });
          },
          filter ? { filter } : undefined,
        );
        sink.onClose(handle.close);
      },
    });
  },
});
