/**
 * SyncDeltaCodec — the configure SEAM for the sync rows-delta CLIENT
 * (agent-tool-delta-client-rollout-2026-06-23 P-006).
 *
 * The generic sync lib stays DOMAIN-FREE and tooldef-free: it knows HOW to send a per-query
 * cursor and hand a server slot to a codec, but the codec IMPL — the cursor cache, the merge,
 * the host flag, and the per-query opt-in — is injected by the host (operator), which backs it
 * with the tooldef `DeltaToolClient` + `dispatchWithConveyedDelta`. With NO codec set (the
 * default) the batch fetcher behaves exactly as before: no `delta` field is sent and full rows
 * are returned — byte-identical to today. So this whole surface is inert until the host opts in.
 *
 * Correctness is the same structural guarantee as the tool path: `decodeResult` verifies a
 * merge against the server's full-view checksum and returns `refetchFull: true` on any mismatch
 * (or a missing base), so the batch fetcher re-requests a clean full — never a wrong view.
 */
export interface SyncDeltaMeta {
  mode: 'full' | 'delta' | 'not_modified';
  cursor?: string;
  checksum?: string;
  itemKeyField?: string;
}

/** A single batch-result slot as the codec observes it (the server's full|delta response). */
export interface SyncDeltaSlot {
  rows?: unknown[];
  changes?: unknown[];
  version?: string;
  delta?: SyncDeltaMeta;
}

export interface SyncDeltaCodec {
  /** Per-query opt-in: this queryName is delta-capable AND the host flag is on. */
  enabled(name: string): boolean;
  /** Stable per-view key (queryName + canonical args). */
  viewKey(name: string, args: unknown): string;
  /** The cursor to send for a view, or undefined for a cold first read. */
  cursorFor(viewKey: string): string | undefined;
  /** Fold a server slot into the cache; returns the full rows + whether a full refetch is needed
   *  (checksum mismatch / no retained base) — the no-wrong-view guard. */
  decodeResult(viewKey: string, slot: SyncDeltaSlot): { rows: unknown[]; refetchFull: boolean };
}

let codec: SyncDeltaCodec | null = null;

/** Host injects the delta codec (operator, backed by DeltaToolClient). Pass null to disable. */
export function setSyncDeltaCodec(c: SyncDeltaCodec | null): void {
  codec = c;
}

/** The active codec, or null → the batch fetcher serves full (today's behavior). */
export function getSyncDeltaCodec(): SyncDeltaCodec | null {
  return codec;
}
