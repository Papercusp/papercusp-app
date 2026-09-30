/**
 * delta-client — the CLIENT side of the agent tool-result delta protocol (the inverse
 * of `negotiateDelta`). agent-tool-delta-protocol-2026-06-22 follow-up: the server has
 * always known how to SERVE a delta (parse `_meta.delta`, return changes), but nothing
 * SENDS one — no agent client tracks a cursor + reconstructs. This is that missing half.
 *
 * A consumer that re-reads the same tool VIEW (same tool + args + scope) keeps a base
 * row-set + a cursor per view. On a repeat it attaches the cursor as `_meta.delta`, and
 * folds the server's response back in:
 *   - `full`         → cache the rows + cursor, return the rows.
 *   - `not_modified` → return the cached base (the whole point: no replay), bump the cursor.
 *   - `delta`        → merge the changes onto the base (`applySemanticDelta`), VERIFY the
 *                      result against the server's `checksum`, and ONLY use it on a match;
 *                      on a mismatch (or no base) discard + signal a full refetch.
 *
 * This is the "harness-owns-base" half the protocol mandates — the MODEL never merges, so
 * a silently-wrong merge can't reach it (the checksum guard forces a full refetch instead).
 *
 * `itemKey` is supplied per call by the wiring layer (the response envelope does not convey
 * it). Assumes the server's default content-hash row revision (the checksum machinery the
 * adopted tools use); a tool declaring a custom `rowRevision` must convey it to the client.
 */
import { applySemanticDelta, computeViewChecksum, type DeltaChange } from './delta-protocol';
// Re-exported for the `@papercusp/tooldef/delta-client` client subpath (P-006): a client
// codec building a DeltaResponse from a server slot needs the DeltaChange shape.
export type { DeltaChange } from './delta-protocol';

/** A server delta response as the client observes it (parsed from `_meta.delta` + the body). */
export type DeltaResponse =
  | { mode: 'full'; cursor?: string; rows: unknown[]; itemKeyField?: string }
  | { mode: 'not_modified'; cursor?: string }
  | { mode: 'delta'; cursor?: string; checksum?: string; changes: DeltaChange[]; itemKeyField?: string };

export interface DeltaIngestResult {
  /** The full row-set to hand the consumer (reconstructed for a delta; the cached base for not_modified). */
  rows: unknown[];
  /** True when the response could NOT be safely used (checksum mismatch, or a delta/not_modified
   *  with no retained base) — the caller MUST re-request WITHOUT the cursor (a full refetch). */
  refetchFull: boolean;
}

interface View {
  cursor: string;
  rows: unknown[];
}

/**
 * Per-consumer cache of tool VIEWS for the delta protocol. One instance per agent
 * session / conversation; `viewKey` is a stable id for a logical view (e.g.
 * `"plans:list:" + canonicalArgs`). Not thread-safe; drive it from one tool-call loop.
 */
export class DeltaToolClient {
  private readonly views = new Map<string, View>();

  /** The cursor to attach as `_meta.delta` for `viewKey`, or undefined for a cold first read. */
  cursorFor(viewKey: string): string | undefined {
    return this.views.get(viewKey)?.cursor;
  }

  /** Fold a server response into the cache. Returns the full rows + whether a full refetch is needed. */
  ingest(viewKey: string, res: DeltaResponse, itemKey: (row: unknown) => string): DeltaIngestResult {
    if (res.mode === 'full') {
      this.views.set(viewKey, { cursor: res.cursor ?? '', rows: res.rows });
      return { rows: res.rows, refetchFull: false };
    }

    const prev = this.views.get(viewKey);
    if (!prev) {
      // not_modified / delta with no retained base — we can't reconstruct; refetch full.
      this.views.delete(viewKey);
      return { rows: [], refetchFull: true };
    }

    if (res.mode === 'not_modified') {
      if (res.cursor) prev.cursor = res.cursor;
      return { rows: prev.rows, refetchFull: false };
    }

    // mode === 'delta'
    const merged = applySemanticDelta(prev.rows, res.changes, itemKey);
    if (res.checksum != null && computeViewChecksum(merged, itemKey) !== res.checksum) {
      // The merged set diverged from the server's authoritative view — never hand a
      // possibly-wrong view to the model. Drop the base + force a clean full refetch.
      this.views.delete(viewKey);
      return { rows: prev.rows, refetchFull: true };
    }
    this.views.set(viewKey, { cursor: res.cursor ?? prev.cursor, rows: merged });
    return { rows: merged, refetchFull: false };
  }

  /** Drop a cached view (e.g. on a scope change or an explicit reset). */
  forget(viewKey: string): void {
    this.views.delete(viewKey);
  }

  /** Number of cached views (introspection / tests). */
  get size(): number {
    return this.views.size;
  }
}

/** Runs ONE tool read with a given delta cursor and returns the client's view of the response.
 *  The wiring layer supplies this — in-process it sets `ctx.requestedDelta = cursor`, dispatches,
 *  and adapts the structured result into a {@link DeltaResponse}. */
export type DeltaDispatch = (requestedDelta: string | undefined) => Promise<DeltaResponse>;

export interface DeltaDispatchResult {
  /** The full reconstructed view (the harness-owned base) — the consumer's authoritative rows. */
  rows: unknown[];
  /** The response MODE to surface into the LLM context: `full` → the rows; `delta` → only the
   *  changes (the token win); `not_modified` → nothing new (the base is already in context). */
  mode: 'full' | 'delta' | 'not_modified';
}

/**
 * One delta-negotiated read for a view. Sends the cached cursor, ingests the response, and —
 * if the delta can't be safely applied (checksum mismatch / no base) — re-dispatches WITHOUT
 * the cursor for a clean full, so the consumer (and the model) NEVER sees a wrong/partial view.
 * Pure orchestration over an abstract {@link DeltaDispatch}; the wiring layer provides the
 * concrete dispatch + the registry-resolved `itemKey`.
 */
export async function dispatchWithDelta(
  client: DeltaToolClient,
  viewKey: string,
  itemKey: (row: unknown) => string,
  dispatch: DeltaDispatch,
): Promise<DeltaDispatchResult> {
  const cursor = client.cursorFor(viewKey);
  let res = await dispatch(cursor);
  let ingested = client.ingest(viewKey, res, itemKey);
  if (ingested.refetchFull && cursor !== undefined) {
    // The server sent a delta/not_modified we can't apply (evicted base, checksum mismatch).
    // Re-request a FULL (drop the cursor) — correctness over tokens; never a wrong merge.
    res = await dispatch(undefined);
    ingested = client.ingest(viewKey, res, itemKey);
  }
  return { rows: ingested.rows, mode: res.mode };
}

/**
 * OUT-OF-PROCESS variant of {@link dispatchWithDelta} for a client (the MCP proxy) that
 * has NO access to the tool's `itemKey` FUNCTION (it can't cross a process boundary). It
 * LEARNS the itemKey FIELD NAME from the `itemKeyField` the server conveys on a full/delta
 * response, caches it per view in `fieldByView` (one map per proxy session), and merges via
 * `row[field]`. Same checksum→refetch-full guard — a delta it can't key (no field yet) or a
 * mismatched merge degrades to a clean full, never a wrong view.
 *
 * SCOPE (P-004 terminal disposition): this is the buildable, reusable half of the
 * out-of-process delta proxy — usable only by an out-of-process consumer whose turn wrapper
 * Papercusp STILL controls (so base-presence can be paired with a {@link BasePresenceTracker}
 * configured `enabled:true`). It must NOT drive LLM-facing `not_modified`/`delta` for an
 * EXTERNAL Claude Code / Codex session: the base-presence contract (D-006,
 * `agent-insights/tool-delta-base-presence-contract.mdx` §Scope) forbids it — the proxy
 * cannot see the external client's compaction, so it can't guarantee the base is in context.
 * For those, the proxy reconstructs the full view (a localhost wire saving only, no model-token
 * win) or simply serves `full`. That contract boundary — not a missing build — is why P-004
 * stops here: the merge LOGIC ships; the Claude-Code-facing compact-delta delivery is by-design
 * absent.
 */
export async function dispatchWithConveyedDelta(
  client: DeltaToolClient,
  fieldByView: Map<string, string>,
  viewKey: string,
  dispatch: DeltaDispatch,
): Promise<DeltaDispatchResult> {
  // Dynamic itemKey — re-reads the learned field, so a relearn after a refetch takes effect.
  const itemKey = (row: unknown): string => {
    const f = fieldByView.get(viewKey);
    return f ? String((row as Record<string, unknown>)[f]) : '';
  };

  const cursor = client.cursorFor(viewKey);
  let res = await dispatch(cursor);
  learnConveyedField(fieldByView, viewKey, res);

  // A delta with no conveyed key yet is unmergeable — refetch a full to learn the key + base.
  if (res.mode === 'delta' && !fieldByView.has(viewKey)) {
    res = await dispatch(undefined);
    learnConveyedField(fieldByView, viewKey, res);
  }

  let ingested = client.ingest(viewKey, res, itemKey);
  if (ingested.refetchFull && cursor !== undefined) {
    res = await dispatch(undefined);
    learnConveyedField(fieldByView, viewKey, res);
    ingested = client.ingest(viewKey, res, itemKey);
  }
  return { rows: ingested.rows, mode: res.mode };
}

function learnConveyedField(fieldByView: Map<string, string>, viewKey: string, res: DeltaResponse): void {
  if ((res.mode === 'full' || res.mode === 'delta') && res.itemKeyField) {
    fieldByView.set(viewKey, res.itemKeyField);
  }
}
