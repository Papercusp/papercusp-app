/**
 * base-presence — the HARNESS half of the tool-result delta base-presence contract (D-006,
 * `agent-insights/tool-delta-base-presence-contract.mdx`). `delta-client.ts` (DeltaToolClient)
 * holds the cursor + base ROWS and does the merge; this tracks whether the base SNAPSHOT is
 * still in the MODEL's context, so the harness asks a tool for `not_modified`/`delta` (the
 * no-replay token win) ONLY when it can prove the model still holds the base — and falls back
 * to `full` otherwise.
 *
 * Why a separate object from DeltaToolClient: the server validates the cursor/view/scope but
 * CANNOT see the model's context; only the harness — which owns the turn wrapper + the message
 * array — knows whether the base is still present. The client's cached rows and the model's
 * in-context base diverge precisely on compaction: the client still has its copy (so it would
 * happily serve a `not_modified` from cache), but the MODEL lost the snapshot, so re-confirming
 * "nothing changed" would leave the model with a gap. This tracker is the guard that forces a
 * `full` after compaction, re-establishing the base in both. Mirrors coord's
 * `coord_watermarks` + `snapshot_rebootstrap_pending` (see the contract doc).
 *
 * Storage-free + generic (no I/O, no imports beyond a shared type) — one instance per agent
 * session / conversation; drive it from one tool-call loop (not thread-safe). The integration
 * seam is the OMP/psu turn-wrapper that owns the message array — NOT the operator's
 * `runAgentChat`, which only OBSERVES a child agent process's event stream and owns no message
 * array (see the P-003 scoping note in the plan).
 */

import { DeltaToolClient, type DeltaDispatch, type DeltaDispatchResult } from './delta-client';

/** The mode a delta-capable tool served — mirrors the client-observed `_meta.delta.mode`. */
export type DeltaMode = 'full' | 'not_modified' | 'delta';

export interface BasePresenceOptions {
  /**
   * Master scope guard (contract §"Scope: only harnesses Papercusp's turn-wrapper controls").
   * When `false`, the tracker NEVER asserts base-presence — every negotiation resolves to
   * `full`, every `record` is a no-op. Set `false` for harnesses whose turn wrapper Papercusp
   * does NOT control (external Claude Code / Codex), where base-presence can't be guaranteed.
   * Defaults to `true` (an in-scope OMP/psu harness).
   */
  enabled?: boolean;
}

interface BaseEntry {
  cursor: string;
}

/**
 * Per-conversation tracker of which tool VIEWS still have their base snapshot in the model's
 * context. `viewKey` is the stable id for a logical view (e.g. `"plans:attention:" +
 * canonicalArgsHash`) — the SAME key the DeltaToolClient caches rows under, so the two compose.
 */
export class BasePresenceTracker {
  private readonly bases = new Map<string, BaseEntry>();
  private readonly enabled: boolean;

  constructor(opts: BasePresenceOptions = {}) {
    this.enabled = opts.enabled ?? true;
  }

  /**
   * Rule 2 (`haveBase`): is the base snapshot for `viewKey` provably still in the model's
   * context? `false` when disabled (out-of-scope harness), cold, or post-compaction.
   */
  haveBase(viewKey: string): boolean {
    return this.enabled && this.bases.has(viewKey);
  }

  /**
   * Rule 2: the `_meta.delta` wire value to attach for a read. `'full'` whenever the base is
   * not provably in context (so the model always has data to act on); otherwise the cursored
   * negotiation. `wantSemantic` chooses `auto~<cursor>` (eligible for a semantic-delta body)
   * over `not_modified~<cursor>` (ETag-only). The cursor is opaque/base64url (never contains
   * `~`), so the single-`~` split the server expects is unambiguous.
   */
  negotiationFor(viewKey: string, wantSemantic = false): string {
    const entry = this.enabled ? this.bases.get(viewKey) : undefined;
    if (!entry) return 'full';
    return `${wantSemantic ? 'auto' : 'not_modified'}~${entry.cursor}`;
  }

  /** Rule 5: a `full` response (re)establishes the base + cursor for this view. */
  onFull(viewKey: string, cursor: string | undefined): void {
    if (!this.enabled) return;
    this.bases.set(viewKey, { cursor: cursor ?? '' });
  }

  /** Rule 4: `not_modified` keeps the base (it was never re-read off the wire); refresh cursor. */
  onNotModified(viewKey: string, cursor: string | undefined): void {
    const entry = this.bases.get(viewKey);
    if (entry && cursor != null) entry.cursor = cursor;
  }

  /** A `delta` response: the client merged it onto the base, which still stands; refresh cursor. */
  onDelta(viewKey: string, cursor: string | undefined): void {
    const entry = this.bases.get(viewKey);
    if (entry && cursor != null) entry.cursor = cursor;
  }

  /** Rule 6 (`supported:false`): the endpoint isn't delta-capable — stop tracking a base for it. */
  onUnsupported(viewKey: string): void {
    this.bases.delete(viewKey);
  }

  /**
   * Rule 3: the turn wrapper compacted history or resumed a session — prior tool snapshots may
   * be gone, so EVERY base is now suspect. Clear them: the next read for each view negotiates
   * `full` and re-establishes the base. The `snapshot_rebootstrap_pending` move; O(views).
   */
  onCompaction(): void {
    this.bases.clear();
  }

  /**
   * The single entry the wiring calls after each delta-negotiated read: applies the served
   * `mode`/`cursor` to the tracked base. `supported:false` untracks the view (rule 6); a
   * `not_modified`/`delta` for an untracked view is a no-op (defensive — the DeltaToolClient
   * independently forces a full refetch in that case, so the next read re-establishes the base).
   */
  record(viewKey: string, mode: DeltaMode, cursor: string | undefined, supported = true): void {
    if (!this.enabled) return;
    if (!supported) {
      this.onUnsupported(viewKey);
      return;
    }
    switch (mode) {
      case 'full':
        this.onFull(viewKey, cursor);
        break;
      case 'not_modified':
        this.onNotModified(viewKey, cursor);
        break;
      case 'delta':
        this.onDelta(viewKey, cursor);
        break;
    }
  }

  /** Drop one tracked base (scope change / explicit reset). */
  forget(viewKey: string): void {
    this.bases.delete(viewKey);
  }

  /** Number of views with a believed-present base (introspection / tests). */
  get size(): number {
    return this.bases.size;
  }

  /** Whether base-presence assertion is active for this harness (the scope guard). */
  get isEnabled(): boolean {
    return this.enabled;
  }
}

/**
 * One base-presence-guarded delta read — the turn-wrapper integration in a SINGLE call,
 * composing a {@link BasePresenceTracker} (is the base still in the model's context?) with a
 * {@link DeltaToolClient} (the rows + the checksum-guarded merge). This is the seam an OMP/psu
 * turn-wrapper invokes per delta-capable tool read so adoption is a one-liner; the returned
 * `mode` tells the wrapper what to put in the model's context — `full` → inject the rows;
 * `delta` → inject only the changes (the token win); `not_modified` → inject NOTHING, the base
 * already stands.
 *
 * Safety: it asks the tool for `not_modified`/`delta` ONLY when `haveBase` (so the model can
 * never lose its base across a compaction — call {@link BasePresenceTracker.onCompaction} from
 * the wrapper's compaction hook), and forces a clean `full` whenever the client can't safely
 * reconstruct (evicted base / checksum mismatch). An out-of-scope wrapper (external Claude Code
 * / Codex) constructs the tracker with `{ enabled: false }` ⇒ every read is `full`, byte-identical
 * to today.
 *
 * Contract: `dispatch(requested)` must set the MCP `_meta.delta` to `requested` VERBATIM — the
 * full wire value (`"not_modified~<cursor>"` | `"auto~<cursor>"`) — or omit `_meta.delta` when
 * `requested === undefined` (a cold/forced full). `itemKey` is the registry-resolved row id for
 * the view. On a `supported:false` view the wrapper should additionally call
 * {@link BasePresenceTracker.onUnsupported} (the {@link DeltaResponse} the client observes does
 * not convey `supported`).
 */
export async function dispatchWithBasePresence(
  tracker: BasePresenceTracker,
  client: DeltaToolClient,
  viewKey: string,
  itemKey: (row: unknown) => string,
  dispatch: DeltaDispatch,
  opts: { wantSemantic?: boolean } = {},
): Promise<DeltaDispatchResult> {
  // Ask for a delta ONLY when the base is provably in the model's context; else force full.
  const wire = tracker.negotiationFor(viewKey, opts.wantSemantic ?? false);
  const requested = wire === 'full' ? undefined : wire;
  let res = await dispatch(requested);
  let ingested = client.ingest(viewKey, res, itemKey);
  if (ingested.refetchFull && requested !== undefined) {
    // The client couldn't reconstruct (evicted base / checksum mismatch) — re-request a clean
    // full so neither the client cache nor the model is left with a wrong/partial view.
    res = await dispatch(undefined);
    ingested = client.ingest(viewKey, res, itemKey);
  }
  // Fold the SERVED mode into base-presence (what the server actually returned, not what we asked).
  tracker.record(viewKey, res.mode, res.cursor);
  return { rows: ingested.rows, mode: res.mode };
}
