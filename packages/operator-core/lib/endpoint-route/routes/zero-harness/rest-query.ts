/**
 * GET /api/zero-harness/rest-query?name=...&args=<json>
 *
 * Single-query REST endpoint with gzip when accepted. This is THE sync read
 * path: every `useSyncQuery` / prefetch / `fetchSyncQuery` lands here, one
 * request per query, bounded by the client's concurrency gate
 * (libs/generic/sync/src/transports/polling/concurrency-gate.ts).
 *
 * `auth: 'loopback'` (drop-sync-batcher-2026-07-25 P-001). It was `'public'`
 * while the since-removed `rest-query-batch` — which carried all real sync
 * traffic — was `'loopback'`; moving every consumer onto this route at
 * `'public'` would have silently downgraded the whole sync surface from
 * loopback-gated to public.
 * Nothing legitimate lost access: the desktop webview reaches the sidecar over
 * Tauri IPC (loopback), the dev browser is `localhost:3055`, and the mobile
 * client uses the separately device-authed `/device/rest-query`.
 *
 * Ported from app/api/zero-harness/rest-query/route.ts.
 */
import { resolveNamedQueryV2, NAME_NOT_FOUND } from '../../../sync-resolver';
import { observeResolve } from '../../../sync-resolver/resolve-observability';
import { resourceDeltaConfig } from '../../../sync-resolver/resource-delta-config';
import {
  diagnoseStaleOperatorModuleLink,
  STALE_OPERATOR_MODULE_LINK_CODE,
} from '../../../stale-operator-error';
import { negotiateRowsDelta } from '@papercusp/tooldef';
import { defineTool } from '@papercusp/agent-mcp';
import { serializeJsonResponse } from '../../../cpu-task-worker';

export default defineTool({
  method: 'GET',
  path: '/zero-harness/rest-query',
  auth: 'loopback',
  // Pure sync-transport, polled ~every 3s — exempt from route_invocations
  // telemetry so the table doesn't flood (plan Q7: sampleRate 0 for pure
  // sync transports).
  sampleRate: 0,
  async handler(req) {
    const u = new URL(req.url);
    const name = u.searchParams.get('name');
    if (!name) {
      return Response.json({ error: 'missing name' }, { status: 400 });
    }
    const argsJson = u.searchParams.get('args') ?? '{}';
    let args: unknown;
    try {
      args = JSON.parse(argsJson);
    } catch {
      return Response.json({ error: 'invalid args (not JSON)' }, { status: 400 });
    }
    if (req.signal.aborted) {
      return new Response(null, { status: 499 });
    }
    const startedMs = Date.now();
    let resolverFailureObserved = false;
    try {
      // P-022 cutover (2026-05-25): all 53 live queryNames are in the
      // v2 dispatcher; the legacy ZQL resolver fall-through has been
      // removed. NAME_NOT_FOUND now surfaces as 400 instead of falling
      // through to a Zero compilation that no longer exists.
      // Timed so a SLOW read is visible server-side. This route sets
      // sampleRate: 0 (a ~3s-polled transport must not flood route_invocations)
      // and its catch below returns a bare 500, so without this a read that
      // hung for ten seconds and failed left no trace anywhere — see
      // resolve-observability.ts (EI-19375505819043214).
      let v2: Awaited<ReturnType<typeof resolveNamedQueryV2>>;
      try {
        v2 = await resolveNamedQueryV2(name, args);
      } catch (err) {
        resolverFailureObserved = true;
        observeResolve({
          name,
          argsJson,
          elapsedMs: Date.now() - startedMs,
          error: err,
        });
        throw err;
      }
      const resolverCompletedAtMs = Date.now();
      observeResolve({ name, argsJson, elapsedMs: resolverCompletedAtMs - startedMs });
      if (v2 === NAME_NOT_FOUND) {
        return Response.json(
          { error: `unknown queryName: ${name}`, name },
          { status: 400 },
        );
      }
      const rows = v2;
      if (req.signal.aborted) {
        return new Response(null, { status: 499 });
      }
      // P-006 (the ~327GB sync win): rows-delta for a DELTA-AWARE client — one that sent
      // `&delta=<cursor>` (or `&delta=` cold to opt in). Absent → today's exact full path,
      // byte-identical; a resource with no delta config also serves full. The full-view
      // checksum lets the client verify its merge + refetch on any mismatch, so a wrong/stale
      // key can only cost a refetch (no win), never a wrong view. Inert until a client opts in.
      //
      // infra-perf-reliability-audit-round3 P-011 / round4 P-002: offload
      // JSON.stringify to the cpu-task worker so it does not block the main
      // event loop. serializeJsonResponse handles the BigInt replacer on the worker.
      // The response is NOT compressed — this is a loopback desktop sidecar
      // (see host-handler.ts §1); do not re-add gzip here.
      const deltaParam = u.searchParams.get('delta');
      const dcfg = deltaParam !== null ? resourceDeltaConfig(name) : undefined;
      const timing = {
        unit: 'ms' as const,
        resolverStartedAtMs: startedMs,
        resolverCompletedAtMs,
        resolverMs: Math.max(0, resolverCompletedAtMs - startedMs),
      };
      let responseValue: unknown;
      let itemCount: number;
      if (dcfg && Array.isArray(rows)) {
        const field = dcfg.itemKeyField;
        const neg = negotiateRowsDelta({
          cursor: deltaParam || undefined,
          rows,
          itemKey: (r) => String((r as Record<string, unknown>)[field]),
          itemKeyField: field,
          schemaVersion: dcfg.schemaVersion,
          // no-http-anywhere-2026-07-28 P-024. Identity of THIS view, which unlocks the
          // large-view path: above DELTA_MAX_DIGEST_ENTRIES the row digest cannot ride
          // the cursor, so it is parked server-side under this key and only an id
          // travels. Without it `plans.list` (933 rows) could never delta and re-sent
          // the full ~822 KB on EVERY warm poll (~52 MB/hour per open window) while
          // `plans.attention` (165 rows) got 83x on this same code path.
          //
          // It must include the ARGS, not just the name: two callers of the same query
          // with different args are different views, and the key is what stops one from
          // reading back the other's digest (diffFromDigest reports `removed` ids). The
          // raw args JSON is the string the caller was already keyed by upstream.
          viewKey: `${name}:${argsJson}`,
        });
        // `fullReason` rides along so a client that keeps getting `full` can tell a recoverable
        // miss (`digest_expired` — next poll deltas) from a structural one (`no_digest` — this
        // view will never delta as wired). Omitting it is how a silent full-forever regression
        // hides: this route served 933 rows / ~822 KB on every warm poll and said nothing.
        const meta = {
          mode: neg.mode,
          cursor: neg.cursor,
          checksum: neg.checksum,
          itemKeyField: neg.itemKeyField,
          ...(neg.fullReason ? { fullReason: neg.fullReason } : {}),
        };
        if (neg.mode === 'delta') {
          responseValue = { changes: neg.changes, version: String(Date.now()), delta: meta, timing };
          itemCount = neg.changes?.length ?? 0;
        } else {
          responseValue = { rows: neg.rows, version: String(Date.now()), delta: meta, timing };
          itemCount = neg.rows?.length ?? 0;
        }
      } else {
        responseValue = { rows, version: String(Date.now()), timing };
        itemCount = Array.isArray(rows) ? rows.length : 1;
      }
      const body = await serializeJsonResponse(responseValue, itemCount);
      return new Response(body, {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      // The inner catch records resolver failures. Everything after a
      // successful resolve (delta negotiation, JSON worker serialization,
      // response assembly) reaches only this boundary. Record that distinct
      // phase too, without double-counting an error already observed above.
      if (!resolverFailureObserved) {
        observeResolve({
          name,
          argsJson,
          elapsedMs: Date.now() - startedMs,
          error: new Error(`post-resolve response failed: ${msg}`),
        });
      }
      // ESM link failures happen before the optional resolver module evaluates,
      // so a try/catch inside that leg cannot protect this boundary. Diagnose
      // the stale-process class here, where every sync query already converges.
      const staleDiagnosis = diagnoseStaleOperatorModuleLink(name, err);
      return Response.json(
        staleDiagnosis
          ? {
              error: staleDiagnosis.message,
              name,
              code: STALE_OPERATOR_MODULE_LINK_CODE,
              staleOperator: true,
            }
          : { error: msg, name },
        { status: 500 },
      );
    }
  },
});
