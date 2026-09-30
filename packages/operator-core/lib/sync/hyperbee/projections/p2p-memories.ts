/**
 * Hyperbee → PG projection for `harness_shared.memory_canonical` — SHAREABLE memories
 * federated as first-class Hive state (mem0-cross-machine-federation-2026-07-10,
 * mirroring agent_facts F1-1; D-005 H6, D-006 privacy).
 *
 * Mirrors projections/agent-facts.ts with key differences:
 *
 *   1. Memory identity: (workspace_id, id, source_hive) — keyed by the memory UUID.
 *      SOURCE PARTITIONING (H6): memories are OBSERVATIONS, not consensus. A remote
 *      memory is stored under `source_hive` = the RECEIVER-STAMPED author identity
 *      (provenance.authorPubkey), so every peer's version is stored side-by-side
 *      and can never clobber local (or another peer's) memories.
 *   2. Only SHAREABLE memories federate (mig 562-563 capture triggers fire
 *      WHEN shareable) — and the receive side ENFORCES it (EI-10393): a remote
 *      put whose payload does not affirmatively carry `shareable: true` applies
 *      as a RETRACTION of sharing (mig 563 deliberately captures the
 *      shareable→false flip as a put), deleting that peer's partition of the
 *      identity instead of storing the now-private content.
 *
 * LWW applies within one (identity × source) partition via fed_order_key() guard
 * (EI-1698 transitivity-fixed), matching the agent-facts pattern.
 */
import { getOrgPg } from '@papercusp/db-org';
import { FLAGS } from '@papercusp/flags';
import { getFlag } from '@papercusp/flags/server';
import type postgres from 'postgres';
import type { TableProjection, ProvenanceContext } from '../projection';
import { bumpFederationRefusedOp } from '../federation-refused-op-counter';

/** Wire-shape of a memory row — the federated subset. Defensive on every field. */
export interface MemoryWireRow {
  /** The Hive's home_slug — the per-harness projection guard key. */
  harness_slug: string;
  /** Memory UUID from the source */
  id: string;
  /** The payload JSONB (contains user_id, workspace_id, kind, shareable, etc.) */
  payload: Record<string, unknown>;
  /** ISO timestamps as text on the wire (PG casts on write). */
  created_at: string;
  updated_at: string;
  /** mig 578 temporal-lite validity — belief-time semantics are CONTENT, not
   *  per-machine lifecycle: a peer's recall must honor supersession/invalidity
   *  or it surfaces superseded memories as live. ISO text on the wire; ALL
   *  OPTIONAL — pre-578 history ops lack them (absent ⇒ NULL). */
  valid_at?: string | null;
  invalid_at?: string | null;
  /** UUID of the superseding memory (resolves on any peer that also received
   *  that memory's own federated row; dangling until then — same semantics as
   *  the local store). */
  superseded_by?: string | null;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function isMemoryWireRow(input: unknown): input is MemoryWireRow {
  if (!input || typeof input !== 'object') return false;
  const r = input as Record<string, unknown>;
  if (!isString(r.harness_slug) || r.harness_slug.length === 0) return false;
  if (!isString(r.id) || r.id.length === 0) return false;
  if (!isRecord(r.payload)) return false;
  if (!isString(r.created_at)) return false;
  if (!isString(r.updated_at)) return false;
  // mig 578 temporal-lite additions — optional (pre-578 ops omit them), but when
  // present they must be string|null or the op is refused as malformed.
  for (const k of ['valid_at', 'invalid_at', 'superseded_by'] as const) {
    const v = r[k];
    if (v !== undefined && v !== null && typeof v !== 'string') return false;
  }
  return true;
}

export interface MemoriesProjectionOpts {
  workspaceId: string;
  harnessSlug: string;
  /** Test/multi-peer seam — write to THIS client instead of getOrgPg().sql. */
  sql?: postgres.Sql;
  /** Test seam — the live dark gate (default: MEM0_FEDERATION_EGRESS). */
  isFlagOn?: () => Promise<boolean>;
}

/**
 * P-006/D-002: fail closed at the receive boundary too. A dark egress flag
 * that only rejects new local writes still lets already-captured/replayed peer
 * ops mutate PG, so OFF would not actually make memory federation inert.
 * Resolve per op so an operator flag flip takes effect without a restart.
 */
async function flagOn(opts: MemoriesProjectionOpts): Promise<boolean> {
  try {
    if (opts.isFlagOn) return (await opts.isFlagOn()) === true;
    return (await getFlag(FLAGS.MEM0_FEDERATION_EGRESS, 'system')) === true;
  } catch {
    return false;
  }
}

/** Matches memory_canonical federation identity: workspace_id/id */
function composeKey(row: MemoryWireRow): string {
  return `${row.id}`;
}

function decodeValue(raw: unknown): MemoryWireRow | null {
  return isMemoryWireRow(raw) ? raw : null;
}

/**
 * F1-4 / P-012: record a per-source refused-op counter when a FOREIGN shareable
 * memory op was declined at decode (malformed wire row from a buggy/hostile
 * sender's log). Only REMOTE ops carry an attributable source — a local decode
 * failure is a local bug, not peer spam, so it is not counted.
 */
function onRefusedOp(
  opts: MemoriesProjectionOpts,
  _raw: unknown,
  provenance: ProvenanceContext | undefined,
): Promise<void> | void {
  if (provenance?.origin !== 'remote') return;
  return bumpFederationRefusedOp(
    {
      workspaceId: opts.workspaceId,
      harnessSlug: opts.harnessSlug,
      sourceHive: provenance.authorPubkey,
      tableTag: 'p2p-memories-by-id',
      reason: 'malformed',
    },
    opts.sql,
  );
}

async function writeToPg(
  opts: MemoriesProjectionOpts,
  row: MemoryWireRow,
  provenance: ProvenanceContext,
): Promise<void> {
  if (!(await flagOn(opts))) return;
  if (row.harness_slug !== opts.harnessSlug) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const origin = provenance.origin;
  // The projection applies LOCAL echoes too (origin 'local' = our own op folding
  // back) — those rows already exist via memory:remember; the source-partitioned
  // upsert below is a no-op refresh for them (source_hive NULL partition).
  const authorPubkey = provenance?.authorPubkey ?? '';
  // H6: receiver-stamped source partition. Remote ⇒ the stamped author key
  // (unforgeable); local ⇒ NULL (the local partition memory:remember owns).
  const sourceHive = origin === 'remote' ? (authorPubkey || 'unknown-remote') : null;
  const fedTs = provenance?.ts ?? null;
  const fedHlc = provenance?.fedHlc ?? null;

  // D-006 retraction-of-sharing (EI-10393): mig 563 deliberately captures a
  // shareable true→false flip as a PUT carrying the now-private payload — the
  // receiver must APPLY it as a retraction, never store it. The same guard
  // refuses a hostile/buggy peer's never-shareable rows: any REMOTE put whose
  // payload is not affirmatively `shareable: true` deletes THAT peer's
  // partition of the identity only (never the NULL/local partition — H6),
  // under the same wall-clock LWW guard as deleteFromPg so a stale retraction
  // replay can never delete a newer re-share. Deliberately SILENT (no
  // refused-op bump): log replays re-apply retractions idempotently, and a
  // delete-miss is indistinguishable from an honest replay — counting would
  // frame well-behaved peers; genuinely broken rows still count via
  // onRefusedOp('malformed'). Local echoes are untouched: the local partition
  // belongs to memory:remember, and own-log ops replay-skip anyway.
  if (origin === 'remote' && row.payload.shareable !== true) {
    await sql`
      DELETE FROM harness_shared.memory_canonical
       WHERE workspace_id = ${opts.workspaceId}
         AND id = ${row.id} AND source_hive = ${sourceHive}
         AND (${fedTs}::bigint IS NULL
           OR harness_shared.fed_order_key(NULL, ${fedTs}::bigint) >= harness_shared.fed_order_key(NULL, fed_ts))`;
    return;
  }

  // NOTE: `workspace_id` is deliberately ABSENT from the column/VALUES list below.
  // Unlike agent_facts.workspace_id (a plain column), memory_canonical.workspace_id
  // is a GENERATED ALWAYS AS (payload->>'workspace_id') STORED column (mig 398,
  // pre-dates federation) — Postgres rejects an explicit value for a generated
  // column outright ("cannot insert a non-DEFAULT value into column
  // \"workspace_id\""), so an earlier version of this INSERT that listed it
  // unconditionally threw on every single write (never caught — no real-PG test
  // exercised this path until mem0-cross-machine-federation-2026-07-10 P-007).
  // The column derives correctly from `payload` once inserted, and the wire
  // row's payload already carries the memory's own `workspace_id` key (the
  // authoring agent's workspace, per mig 398 / remember.ts), which is what the
  // (workspace_id, id, coalesce(source_hive,'')) federation identity partitions
  // on — so no explicit value is needed OR possible here.
  //
  // Also note: `payload` is bound as `${JSON.stringify(row.payload)}::text::jsonb`
  // — the CANONICAL jsonb-write form for this codebase (see the
  // postgres-js-jsonb-binding agent-insight), correct under BOTH the operator
  // runtime client (getOrgPg, where a bare object or `sql.json()` THROWS) and the
  // testcontainer client this projection's own tests run against (where a bare
  // `${x}::jsonb` cast — no `::text` — double-encodes into a jsonb *string*
  // scalar instead of an object, silently breaking every payload->>'…' GENERATED
  // column). Do not "simplify" this to a bare object or drop the `::text`.
  await sql`
    INSERT INTO harness_shared.memory_canonical
      (id, payload, created_at, updated_at, harness_slug,
       author_pubkey, origin, fed_ts, source_hive,
       valid_at, invalid_at, superseded_by)
    VALUES
      (${row.id}, ${JSON.stringify(row.payload)}::text::jsonb, ${row.created_at}::timestamptz,
       ${row.updated_at}::timestamptz, ${row.harness_slug}, ${authorPubkey}, ${origin},
       ${fedTs}, ${sourceHive},
       ${row.valid_at ?? null}::timestamptz, ${row.invalid_at ?? null}::timestamptz,
       ${row.superseded_by ?? null}::uuid)
    ON CONFLICT (workspace_id, id, coalesce(source_hive, ''))
    DO UPDATE SET
      payload       = EXCLUDED.payload,
      updated_at    = EXCLUDED.updated_at,
      author_pubkey = EXCLUDED.author_pubkey,
      origin        = EXCLUDED.origin,
      fed_ts        = EXCLUDED.fed_ts,
      valid_at      = EXCLUDED.valid_at,
      invalid_at    = EXCLUDED.invalid_at,
      superseded_by = EXCLUDED.superseded_by
    WHERE harness_shared.fed_order_key(NULL, EXCLUDED.fed_ts)
      >= harness_shared.fed_order_key(NULL, harness_shared.memory_canonical.fed_ts)
  `;
  void fedHlc; // memory_canonical carries no fed_hlc column (wall-clock LWW within a source partition)
}

async function deleteFromPg(
  opts: MemoriesProjectionOpts,
  key: string,
  delTs?: number,
  delHlc?: string,
): Promise<void> {
  if (!(await flagOn(opts))) return;
  if (!key) return;
  const sql = opts.sql ?? getOrgPg().sql;
  const memoryId = key;
  if (!memoryId) return;
  const ts = delTs ?? null;
  const hlc = delHlc ?? null;
  void hlc;
  // A federated delete affects ONLY remote partitions of this identity — a
  // peer's delete must never remove the LOCAL partition (H6 again). Ordered by
  // the same wall-clock guard as the put path. For memories, we mark as deleted
  // by removing the row (no retraction column like agent_facts).
  await sql`
    DELETE FROM harness_shared.memory_canonical
     WHERE workspace_id = ${opts.workspaceId}
       AND id = ${memoryId} AND source_hive IS NOT NULL
       AND (${ts}::bigint IS NULL
         OR harness_shared.fed_order_key(NULL, ${ts}::bigint) >= harness_shared.fed_order_key(NULL, fed_ts))`;
}

/** The registered projection (register-all wires this per booted hive harness). */
export function buildMemoriesProjection(
  opts: MemoriesProjectionOpts,
): TableProjection<MemoryWireRow> {
  return {
    tableTag: 'p2p-memories-by-id',
    // EI-117: CDC-captured table (mig 562-563 triggers) — own-log ops are replays.
    skipOwnOps: true,
    composeKey,
    decodeValue,
    onRefusedOp: (raw, provenance) => onRefusedOp(opts, raw, provenance),
    writeToPg: (row, provenance) => writeToPg(opts, row, provenance),
    deleteFromPg: (key, delTs, delHlc) => deleteFromPg(opts, key, delTs, delHlc),
  };
}

export const _testing = { composeKey, decodeValue, isMemoryWireRow, onRefusedOp };
