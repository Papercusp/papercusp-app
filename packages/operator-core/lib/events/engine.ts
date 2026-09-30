/**
 * The event-reaction engine binding: the host's `postInvoke` handler.
 *
 * Flow per tool invocation (event-reaction-system D-001 → D-005):
 *   1. normalize the dispatcher's PostInvokeEvent → a ToolInvocationEvent;
 *   2. match it against the rule registry (pure, indexed — O(rules-for-tool),
 *      and instant when a tool has no rules, the overwhelmingly common case);
 *   3. hand the matched actions to the generic engine's `runReactions`, which
 *      applies the success gate + loop guard and schedules each reaction off the
 *      hot path (in-process, or a durable DBOS workflow when enabled).
 *
 * `handleToolInvoked` is synchronous up to the schedule point; the dispatcher
 * calls it without awaiting (see DispatchProjectedDeps.postInvoke), so a reaction
 * can never delay or break its trigger. The generic decision/scheduling logic
 * lives in `@papercusp/event-reaction`; this file injects the Papercusp ports —
 * the dispatcher (`fireReactionInProcess`) and the durable seam (`./durable`).
 */

import type { DispatchProjectedResult, PostInvokeEvent, UnifiedToolContext } from '@papercusp/agent-mcp';
import type { MatchedAction } from '@papercusp/rules';
import { runReactions } from '@papercusp/event-reaction';
import { surfaceReactionFailure } from './reaction-failure-surface';
import { checkContributorFireBudget } from './reaction-fire-budget';
import { matchReactions } from './registry';
import { fireReactionInProcess } from './dispatch-reaction';
import { runDurableReaction, durableReactionsEnabled } from './durable';
import type { ToolInvocationEvent } from './types';
import { activeWorkspaceId } from '../workspace-registry';

/** Extract a tool's return value from its MCP-shaped ToolResult (parse JSON when possible). */
function extractData(result: DispatchProjectedResult): unknown {
  const content = result.result?.content;
  const text = Array.isArray(content) ? (content[0] as { text?: unknown } | undefined)?.text : undefined;
  if (typeof text !== 'string') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Build the normalized event a rule matches against. */
export function normalizeEvent(pe: PostInvokeEvent): ToolInvocationEvent {
  return {
    tool: pe.toolName,
    args: pe.args,
    result: pe.result.ok
      ? { ok: true, data: extractData(pe.result) }
      : {
          ok: false,
          error: pe.result.error ? { code: pe.result.error.code, message: pe.result.error.message } : undefined,
        },
    ctx: pe.ctx,
    cause: pe.ctx.reactionCause,
  };
}

/** The host's `postInvoke` — match rules + schedule reactions. Never throws. */
export function handleToolInvoked(pe: PostInvokeEvent): void {
  let event: ToolInvocationEvent;
  try {
    event = normalizeEvent(pe);
  } catch (err) {
    // Normalization must never break the trigger. (Pure code; defensive.)
     
    console.warn(`[events] normalize failed for ${pe.toolName}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  matchAndRun(event);
}

/**
 * Feed a SYNTHETIC (non-tool) event into the same matcher + reaction scheduler
 * (event-reaction-system D-013: the dispatcher is the *primary* source, but the
 * one matcher accepts other sources normalized to the same shape).
 *
 * This is how non-tool fire-points — blueprint-spine step transitions, the
 * work_items lifecycle, plugin-emitted events — reach reaction rules
 * (plugin-system-hive-port D-003: new pipeline fire-points are event emissions
 * only). `tool` is the rule index key (e.g. `pipeline:step-done`); `data`
 * becomes `result.data` so the same data-matcher grammar applies. A minimal
 * system ctx scopes downstream reactions (workspace / harness inheritance).
 * Never throws.
 */
export function emitSystemEvent(opts: {
  /** The rule index key, e.g. `pipeline:step-done` or `myplugin.cache-warm`. */
  tool: string;
  /** Event payload — matched as both `args` and `result.data`. */
  args?: Record<string, unknown>;
  /** Scope for downstream reactions. Defaults to the active workspace, harness '*'. */
  workspaceId?: string;
  harnessSlug?: string;
  /** Cause-chain when the emission itself was caused by a reaction. */
  cause?: ToolInvocationEvent['cause'];
}): void {
  let event: ToolInvocationEvent;
  try {
    const ctx = {
      workspaceId: opts.workspaceId ?? activeWorkspaceId(),
      harnessSlug: opts.harnessSlug ?? '*',
      role: 'operator',
      featureId: null,
      chunkId: null,
      runId: globalThis.crypto.randomUUID(),
      spawnId: 'system-event',
      parentSpawnId: null,
      uiClientId: null,
      isSuperuser: false,
      profile: 'engineer',
      transport: 'in_process',
      log: () => {},
      progress: () => {},
      emit: () => {},
      signal: new AbortController().signal,
    } as unknown as UnifiedToolContext;
    event = {
      tool: opts.tool,
      args: opts.args ?? {},
      result: { ok: true, data: opts.args ?? {} },
      ctx,
      ...(opts.cause ? { cause: opts.cause } : {}),
    };
  } catch (err) {
     
    console.warn(`[events] system-event build failed for ${opts.tool}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  matchAndRun(event);
}

/**
 * D-007 (bulk-endpoint-standardization-2026-06-21) — fan a bulk-envelope event
 * out into one synthetic per-item event.
 *
 * A dual-arity verb (`{ id }` for n=1 OR `items:[…]`/`ids:[…]` for many) returns
 * the `_bulk.ts` keyed-array envelope `{ ok:true, results:[{ ok, <key>, … }],
 * counts }`. Dispatched as ONE event, its `args` is `{ items:[…] }` and its
 * `result.data` is the whole envelope — so every per-tool reaction rule + every
 * `emits:` desugar, all written to read the SINGULAR `e.args.id` /
 * `e.result.data.workItem`, has its `when()` fall false and SILENTLY does not fire
 * (stale rationale projection, missed plan-item reflect, dropped demand emit).
 *
 * The durable fix is HERE, at the single dispatch choke point, not in each of the
 * N rules: detect the envelope and synthesize one event per result item —
 * `args` reconstructed from `items[i]`/`ids[i]` (+ batch-level scalars) and
 * `result.data` set to `results[i]` (self-describing key + the same per-item
 * payload the single call returned: `workItem`, `completion`, …). Each synthetic
 * event then matches exactly as a single invocation would, so bulk-converting a
 * verb keeps EVERY downstream reaction with no rule edits. A single (n=1) call
 * fans out into exactly one per-item event — identical to the pre-bulk dispatch.
 * Non-bulk tools never match the shape and dispatch unchanged.
 */
interface BulkItemResultLike {
  ok?: unknown;
  id?: unknown;
  slug?: unknown;
  error?: unknown;
  [k: string]: unknown;
}

/** The strict `_bulk.ts` envelope: `ok:true` + `results:[{ ok, … }]` + numeric counts. */
function asBulkEnvelope(data: unknown): { results: BulkItemResultLike[] } | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as { ok?: unknown; results?: unknown; counts?: unknown };
  if (d.ok !== true || !Array.isArray(d.results)) return null;
  const counts = d.counts as { ok?: unknown; failed?: unknown } | undefined;
  if (!counts || typeof counts !== 'object') return null;
  if (typeof counts.ok !== 'number' || typeof counts.failed !== 'number') return null;
  // Every element a self-describing record with a boolean `ok` — this is what makes
  // the envelope unambiguous vs an incidental `{ results, counts }` payload.
  if (!d.results.every((r) => r && typeof r === 'object' && typeof (r as { ok?: unknown }).ok === 'boolean')) {
    return null;
  }
  return { results: d.results as BulkItemResultLike[] };
}

/** Reconstruct the args a single invocation of one item would have run with. */
function perItemArgs(bulkArgs: unknown, index: number, resultItem: BulkItemResultLike): Record<string, unknown> {
  const a = (bulkArgs && typeof bulkArgs === 'object' ? bulkArgs : {}) as Record<string, unknown>;
  // Batch-level scalars apply to every item (a shared `state`/`harness`/`topic`);
  // the list fields + the single-call `id` are replaced by the per-item key.
  const base: Record<string, unknown> = { ...a };
  delete base.items;
  delete base.ids;
  delete base.id;
  const item = Array.isArray(a.items) ? a.items[index] : undefined;
  const inputItem = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
  // The correlation key the result self-describes (D-001), else the positional
  // input id (ids[i] / the single id). work_items rules read `e.args.id`.
  const key =
    (typeof resultItem.id === 'string' ? resultItem.id : undefined) ??
    (typeof resultItem.slug === 'string' ? resultItem.slug : undefined) ??
    (Array.isArray(a.ids) ? (a.ids[index] as unknown) : undefined) ??
    (typeof a.id === 'string' ? a.id : undefined);
  return { ...base, ...inputItem, ...(key !== undefined ? { id: key } : {}) };
}

/**
 * Explode a bulk-envelope event into one synthetic event per result item, or
 * `null` when the event is not a bulk envelope (the overwhelmingly common case).
 * Exported for direct unit testing.
 */
export function fanOutBulkEvent(event: ToolInvocationEvent): ToolInvocationEvent[] | null {
  if (!event.result.ok) return null;
  const env = asBulkEnvelope(event.result.data);
  if (!env) return null;
  return env.results.map((ri, i) => ({
    tool: event.tool,
    args: perItemArgs(event.args, i, ri),
    // Per-item ok gates onlyOnSuccess exactly like a single call: a failed item's
    // reactions are skipped, a succeeded item's fire. `result.data` is the
    // self-describing item (carries workItem/completion/… for the rules to read).
    result:
      ri.ok === false
        ? {
            ok: false as const,
            data: ri,
            error: { code: 'bulk_item_failed', message: typeof ri.error === 'string' ? ri.error : 'item failed' },
          }
        : { ok: true as const, data: ri },
    ctx: event.ctx,
    ...(event.cause ? { cause: event.cause } : {}),
  }));
}

/** Shared match + schedule tail for both event sources. Never throws. */
function matchAndRun(event: ToolInvocationEvent): void {
  // D-007: a bulk-envelope result fans out into one synthetic event per item so
  // every per-item reaction rule + emits desugar fires exactly as for a single
  // call. The bulk-level event itself is NOT matched — it is a carrier, not an
  // invocation. Recursion terminates: a per-item `result.data` is a single item,
  // never itself an envelope.
  const perItem = fanOutBulkEvent(event);
  if (perItem) {
    for (const sub of perItem) matchAndRun(sub);
    return;
  }

  let actions: Array<MatchedAction<ToolInvocationEvent, string>>;
  try {
    actions = matchReactions(event);
  } catch (err) {
    // Matching must never break the trigger. (Pure code; defensive.)
     
    console.warn(`[events] match failed for ${event.tool}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (actions.length === 0) return;

  // Hand off to the generic engine. It owns success-gate + loop-guard + the
  // durable-vs-in-process scheduling (with in-process fallback); we inject the
  // Papercusp dispatcher + durable seam and map our event fields onto its ports.
  runReactions<ToolInvocationEvent, string>({
    actions,
    event,
    succeeded: event.result.ok,
    cause: event.cause,
    rootRunId: event.ctx.runId ?? null,
    fireInProcess: ({ fire, args, event: ev, cause, capability }) =>
      fireReactionInProcess({ fire, args, parentCtx: ev.ctx, cause, capability }),
    durable: { enabled: durableReactionsEnabled, run: (input) => runDurableReaction(input) },
    log: (msg) => console.warn(`[events] ${msg}`),
    // P-030 (b): a failed reaction used to be a console.warn and nothing else —
    // no durable record on the live route, and therefore nobody to tell. This
    // records it and alerts the owner when the cause is one they can fix (a
    // capability the wearer lacks, an unbound provider class, a missing tool).
    onFailure: (failure) => surfaceReactionFailure(failure),
    // P-030 (c): the depth cap bounds ONE cascade, so N shallow rules from one
    // third-party contributor were unbounded. This counts a contributor's fires
    // over a window and refuses past its budget. First-party rules are exempt
    // (they carry no contributor), and it FAILS OPEN — a budget is a fairness
    // control, not a kill-switch.
    budget: (req) => checkContributorFireBudget(req),
  });
}
