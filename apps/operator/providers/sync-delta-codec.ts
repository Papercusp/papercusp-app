/**
 * Operator-side SyncDeltaCodec (agent-tool-delta-client-rollout-2026-06-23 P-006).
 *
 * Backs the generic sync lib's delta SEAM (@papercusp/sync's setSyncDeltaCodec) with the tooldef
 * DeltaToolClient: it learns the `itemKeyField` the server conveys, merges deltas onto a cached
 * base, and verifies each merge against the server's full-view checksum — a mismatch returns
 * `refetchFull` so the batch fetcher re-requests a clean full (never a wrong view). Imported via
 * the pure `@papercusp/tooldef/delta-client` subpath (no server code in the client bundle).
 *
 * Injected ONLY when FLAGS.SYNC_RESOURCE_DELTA is ON (see HarnessSyncProvider) — OFF ⇒ no codec
 * ⇒ the batch fetcher serves full re-fetches, byte-identical to today.
 */
import { DeltaToolClient, type DeltaResponse, type DeltaChange } from '@papercusp/tooldef/delta-client';
import type { SyncDeltaCodec, SyncDeltaSlot, SyncDeltaMeta } from '@papercusp/sync';

/**
 * Sync resources that opt into the rows-delta protocol. MUST match the server's
 * resource-delta-config.ts (operator-core/lib/sync-resolver) — a resource the server doesn't
 * delta-negotiate simply never returns a delta envelope, so an extra name here is harmless
 * (the codec passes the full rows through), but keep them in sync for the win to land.
 *
 * ⚠ This is a LITERAL, not an import, on purpose: pulling operator-core in here would drag
 * server code into the client bundle (see the header note). That makes drift possible, and it
 * HAPPENED — the server gained `plans.byHive` (WI-7083) and `codeRecipes` (2026-08-02) while
 * this set sat unchanged from 2026-06-23, so neither delta could ever be negotiated: the client
 * gates first (`query-fetcher.ts:468` — no `enabled(name)` ⇒ no cursor ⇒ the server serves full).
 * Both had live subscribers the whole time (`PotContentPanel.tsx:88`, `RecipesClient.tsx:100`).
 * `sync-delta-codec.test.ts` asserts this set against the server's exported
 * `RESOURCE_DELTA_NAMES`, so adding one there without adding it here now fails a test.
 */
const DELTA_RESOURCES: ReadonlySet<string> = new Set([
  'plans.attention',
  'plans.list',
  'plans.byHive',
  'codeRecipes',
  // D-091: the /adv/harnesses route family's three fattest views, each of which was re-sending
  // in full on every 180s drift-repair tick. Keys measured unique on live rows, see the server
  // config's comments (`id`, `runId`, `featureId`).
  'workItems.byHarness',
  'agentRunsConsolidated.bySlug',
  'featuresConsolidated.bySlug',
  // D-092: the last two over-budget reads without a config. `conversations.agentMessageList`
  // is a sliding window, so its delta tracks message ARRIVAL RATE rather than corpus size.
  'coord.plans',
  'conversations.agentMessageList',
]);

/** Build a fresh codec — one DeltaToolClient + itemKeyField cache per provider lifetime. */
export function createSyncDeltaCodec(): SyncDeltaCodec {
  const client = new DeltaToolClient();
  const fieldByView = new Map<string, string>();

  return {
    enabled: (name) => DELTA_RESOURCES.has(name),
    viewKey: (name, args) => `${name}:${stableArgs(args)}`,
    cursorFor: (viewKey) => client.cursorFor(viewKey),
    decodeResult: (viewKey, slot) => {
      const meta = slot.delta;
      // No delta envelope (e.g. a non-delta resource or a fallback) — pass rows through.
      if (!meta) return { rows: slot.rows ?? [], refetchFull: false };
      if (meta.itemKeyField) fieldByView.set(viewKey, meta.itemKeyField);
      const field = fieldByView.get(viewKey);
      const itemKey = (row: unknown) => (field ? String((row as Record<string, unknown>)[field]) : '');
      const ing = client.ingest(viewKey, toDeltaResponse(meta, slot), itemKey);
      return { rows: ing.rows, refetchFull: ing.refetchFull };
    },
  };
}

/** Map a server slot ({rows|changes} + the `_meta.delta` envelope) into a DeltaResponse. */
function toDeltaResponse(meta: SyncDeltaMeta, slot: SyncDeltaSlot): DeltaResponse {
  if (meta.mode === 'delta') {
    return {
      mode: 'delta',
      cursor: meta.cursor,
      checksum: meta.checksum,
      changes: (slot.changes ?? []) as DeltaChange[],
      itemKeyField: meta.itemKeyField,
    };
  }
  if (meta.mode === 'not_modified') {
    return { mode: 'not_modified', cursor: meta.cursor };
  }
  return { mode: 'full', cursor: meta.cursor, rows: slot.rows ?? [], itemKeyField: meta.itemKeyField };
}

/** Stable JSON for the args object (sorted keys) so a view key doesn't churn on key order. */
function stableArgs(args: unknown): string {
  if (args == null || typeof args !== 'object') return JSON.stringify(args ?? null);
  const obj = args as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(obj).sort()) sorted[k] = obj[k];
  return JSON.stringify(sorted);
}
