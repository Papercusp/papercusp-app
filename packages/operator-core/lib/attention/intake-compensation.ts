/**
 * P-009 (observation-candidate-acceptance-promotion D-019) — the inverse of an
 * applied intake decision.
 *
 * Seat: compensateAttentionBulkRunItem (bulk-run-reversal.ts) calls this for an
 * `apply-intake` bulk item. It runs inside executeBulkRunItemReversal's
 * row-locked transaction, which reuses the existing exactly-once fence: the
 * receipt row is FOR UPDATE, `already_reverted` refuses a second undo, and
 * reverted_at is appended only after this returns. Every write goes through the
 * caller's TransactionSql, so a thrown step rolls the whole reversal back and is
 * reported to the caller. A failed inverse is never hidden.
 *
 * Inverse per recorded outcome (R-9):
 *  - promote/investigate, distinct: drop the promoted item, move its
 *    `intakePromotion` receipt to `intakePromotionReversed[]` (frees the
 *    migration-1298 unique key, so a later re-promotion executes fresh), and move
 *    the source's `intakeExecution` pointer to `intakeExecutionReversed[]`.
 *  - promote/investigate, in-place: readiness back to not-ready (the sealed
 *    contract is kept under `evidence.reversedAcceptance`), and `intakePromotion`
 *    / `intakeSource` move to `*Reversed[]`.
 *  - merge: reopen a source this merge closed as a duplicate, move its pointer
 *    to history, and mark the target's merged-source entry `reversed:true`.
 *    The merged evidence itself is never deleted.
 *  - retain/reject: `intakeDisposition` moves to `intakeDispositionReversed[]`.
 * A history entry for this run+item makes the inverse a no-op success, so it is
 * idempotent under retry.
 *
 * Ownership guard (R-30): an item is revocable only when it is open, was never
 * taken or claimed, has no checkpoint, and has no non-intake link edges created
 * since the decision applied. Anything else is never revoked or deleted: the
 * inverse appends a correction record to `intakeCorrections[]` and says so in
 * the returned note.
 */
import type { TransactionSql } from 'postgres';

import type { BulkIntakeDecision } from './bulk-dispositions';
import { INTAKE_LINK_RELS } from './intake-promotion';
import {
  createImplementationReadiness,
  readImplementationReadiness,
} from '../harness/improvements/agent-review-policy';

export interface IntakeCompensationItem {
  id: string;
  harnessSlug: string;
  status: string;
  takenBy: string | null;
  takenAt: string | null;
  firstClaimedAt: string | null;
  stateChangedAt: string | null;
  payload: Record<string, unknown>;
}

/** Transaction-scoped persistence for one reversal. Injected so units can drive every branch. */
export interface IntakeCompensationStore {
  /** Take the executor's per-source advisory locks (same keys as intake-promotion). */
  lockIntake(ids: readonly string[]): Promise<void>;
  /** Read one work item FOR UPDATE. Throws when the id is ambiguous across harnesses. */
  lockItem(id: string, harnessSlug: string | null): Promise<IntakeCompensationItem | null>;
  hasCheckpoint(item: IntakeCompensationItem): Promise<boolean>;
  /** Link edges touching the item, other than the intake rels, created at or after `since`. */
  downstreamLinkCount(id: string, since: string | null): Promise<number>;
  /** Shallow top-level payload merge after removing `unset`, in ONE update. */
  writePayload(item: IntakeCompensationItem, patch: Record<string, unknown>, unset: readonly string[]): Promise<void>;
  setStatus(item: IntakeCompensationItem, status: 'open' | 'dropped', reason: string): Promise<void>;
  now(): Date;
}

export type IntakeCompensationOutcome = 'reversed' | 'already-reversed' | 'correction-recorded';

export interface IntakeCompensationResult {
  outcome: IntakeCompensationOutcome;
  note: string;
}

export interface IntakeCompensationInput {
  sourceId: string;
  harnessSlug: string | null;
  runId: string;
  itemId: string;
  decision: BulkIntakeDecision | null;
}

const INTAKE_RELS: readonly string[] = Object.values(INTAKE_LINK_RELS);
const REVERSED_BY = 'bulk-run-reversal';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record) : [];
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function belongsTo(entry: Record<string, unknown>, input: IntakeCompensationInput): boolean {
  return entry.runId === input.runId && entry.itemId === input.itemId;
}

function reversedIn(item: IntakeCompensationItem, key: string, input: IntakeCompensationInput): boolean {
  return list(item.payload[key]).some((entry) => belongsTo(entry, input));
}

function withHistory(
  item: IntakeCompensationItem,
  key: string,
  entry: Record<string, unknown>,
  reversedAt: string,
): Record<string, unknown[]> {
  return { [key]: [...list(item.payload[key]), { ...entry, reversedAt, reversedBy: REVERSED_BY }] };
}

function sourceChanged(input: IntakeCompensationInput, item: IntakeCompensationItem, what: string): Error {
  return new Error(
    `intake reversal refused (source-changed): ${item.id} carries no ${what} from run ${input.runId} item ${input.itemId}; ` +
      'it was superseded or never applied, so nothing was reverted',
  );
}

interface Ownership {
  revocable: boolean;
  observed: Record<string, unknown>;
}

/** R-30: re-read ownership, checkpoint and downstream effects before any revoke. */
async function ownership(
  item: IntakeCompensationItem,
  since: string | null,
  store: IntakeCompensationStore,
): Promise<Ownership> {
  const checkpoint = await store.hasCheckpoint(item);
  const downstreamLinks = await store.downstreamLinkCount(item.id, since);
  const observed = {
    status: item.status,
    takenBy: item.takenBy,
    takenAt: item.takenAt,
    firstClaimedAt: item.firstClaimedAt,
    checkpoint,
    downstreamLinks,
  };
  const revocable =
    item.status === 'open' &&
    !item.takenBy &&
    !item.takenAt &&
    !item.firstClaimedAt &&
    !checkpoint &&
    downstreamLinks === 0;
  return { revocable, observed };
}

/** Record that an undo was requested for owned/active/delivered work, never revoking it. */
async function recordCorrection(
  item: IntakeCompensationItem,
  input: IntakeCompensationInput,
  disposition: string,
  observed: Record<string, unknown>,
  store: IntakeCompensationStore,
): Promise<IntakeCompensationResult> {
  const why =
    `undo requested for intake ${disposition} (run ${input.runId} item ${input.itemId}), but ${item.id} ` +
    'is owned, active, checkpointed or has downstream effects, so it was not revoked';
  if (!list(item.payload.intakeCorrections).some((entry) => belongsTo(entry, input))) {
    await store.writePayload(
      item,
      {
        intakeCorrections: [
          ...list(item.payload.intakeCorrections),
          {
            runId: input.runId,
            itemId: input.itemId,
            sourceId: input.sourceId,
            disposition,
            reason: why,
            observed,
            requestedAt: store.now().toISOString(),
          },
        ],
      },
      [],
    );
  }
  return { outcome: 'correction-recorded', note: `correction recorded, not revoked: ${why}` };
}

async function reverseDisposition(
  source: IntakeCompensationItem,
  input: IntakeCompensationInput,
  store: IntakeCompensationStore,
): Promise<IntakeCompensationResult> {
  if (reversedIn(source, 'intakeDispositionReversed', input)) {
    return { outcome: 'already-reversed', note: `intake disposition on ${source.id} already reversed` };
  }
  const stored = record(source.payload.intakeDisposition);
  if (!belongsTo(stored, input)) throw sourceChanged(input, source, 'intake disposition');
  const at = store.now().toISOString();
  await store.writePayload(source, withHistory(source, 'intakeDispositionReversed', stored, at), ['intakeDisposition']);
  return {
    outcome: 'reversed',
    note: `reopened intake ${String(stored.disposition)} decision on ${source.id}; it is back in intake`,
  };
}

async function reversePromotion(
  source: IntakeCompensationItem,
  input: IntakeCompensationInput,
  store: IntakeCompensationStore,
  disposition: string,
): Promise<IntakeCompensationResult> {
  const receipt = record(source.payload.intakePromotion);
  const pointer = record(source.payload.intakeExecution);
  const at = store.now().toISOString();

  if (receipt.mode === 'in-place' && belongsTo(receipt, input)) {
    const owned = await ownership(source, str(receipt.promotedAt), store);
    if (!owned.revocable) return recordCorrection(source, input, disposition, owned.observed, store);
    const readiness = readImplementationReadiness(source.payload);
    const { acceptance, ...evidence } = record(readiness?.evidence);
    await store.writePayload(
      source,
      {
        implementationReadiness: createImplementationReadiness({
          status: 'not-ready',
          source: 'agent-review',
          reason: 'intake-promotion-reversed',
          updatedAt: at,
          evidence: { ...evidence, ...(acceptance ? { reversedAcceptance: acceptance } : {}) },
        }),
        ...withHistory(source, 'intakePromotionReversed', receipt, at),
        ...withHistory(source, 'intakeSourceReversed', record(source.payload.intakeSource), at),
      },
      ['intakePromotion', 'intakeSource'],
    );
    return { outcome: 'reversed', note: `reversed in-place intake promotion of ${source.id}; readiness is not-ready again` };
  }

  if (
    (pointer.disposition === 'promote' || pointer.disposition === 'investigate') &&
    belongsTo(pointer, input) &&
    str(pointer.workItemId)
  ) {
    const promotedId = String(pointer.workItemId);
    await store.lockIntake([source.id, promotedId]);
    const promoted = await store.lockItem(promotedId, null);
    if (!promoted) throw new Error(`intake reversal failed: promoted item ${promotedId} no longer exists`);
    const promotedReceipt = record(promoted.payload.intakePromotion);
    const owned = await ownership(promoted, str(promotedReceipt.promotedAt) ?? str(pointer.at), store);
    if (!owned.revocable) return recordCorrection(promoted, input, disposition, owned.observed, store);
    await store.setStatus(promoted, 'dropped', `intake promotion reversed (run ${input.runId} item ${input.itemId})`);
    await store.writePayload(
      promoted,
      Object.keys(promotedReceipt).length ? withHistory(promoted, 'intakePromotionReversed', promotedReceipt, at) : {},
      ['intakePromotion'],
    );
    await store.writePayload(source, withHistory(source, 'intakeExecutionReversed', pointer, at), ['intakeExecution']);
    return {
      outcome: 'reversed',
      note: `revoked unclaimed promoted item ${promotedId} (dropped); ${source.id} is back in intake`,
    };
  }

  if (reversedIn(source, 'intakePromotionReversed', input) || reversedIn(source, 'intakeExecutionReversed', input)) {
    return { outcome: 'already-reversed', note: `intake promotion from ${source.id} already reversed` };
  }
  throw sourceChanged(input, source, 'intake promotion');
}

async function reverseMerge(
  source: IntakeCompensationItem,
  input: IntakeCompensationInput,
  store: IntakeCompensationStore,
): Promise<IntakeCompensationResult> {
  if (reversedIn(source, 'intakeExecutionReversed', input)) {
    return { outcome: 'already-reversed', note: `intake merge of ${source.id} already reversed` };
  }
  const pointer = record(source.payload.intakeExecution);
  const targetId = str(pointer.workItemId);
  if (pointer.disposition !== 'merge' || !belongsTo(pointer, input) || !targetId) {
    throw sourceChanged(input, source, 'intake merge');
  }
  await store.lockIntake([source.id, targetId]);
  const target = await store.lockItem(targetId, null);
  if (!target) throw new Error(`intake reversal failed: merge target ${targetId} no longer exists`);
  const at = store.now().toISOString();

  // Keep every merged-evidence entry; only mark this merge's entry reversed.
  const merged = list(target.payload.intakeMergedSources);
  if (merged.some((entry) => entry.sourceId === source.id && belongsTo(entry, input) && entry.reversed !== true)) {
    await store.writePayload(
      target,
      {
        intakeMergedSources: merged.map((entry) =>
          entry.sourceId === source.id && belongsTo(entry, input) ? { ...entry, reversed: true, reversedAt: at } : entry,
        ),
      },
      [],
    );
  }

  // Reopen only a close this merge made: a non-observation, no distinct remedy,
  // dropped at or after the merge applied. An earlier or unrelated close stays.
  const pointerAt = str(pointer.at);
  const closedByMerge =
    source.status === 'dropped' &&
    pointer.distinctRemedy == null &&
    source.payload.lane !== 'observation' &&
    pointerAt !== null &&
    source.stateChangedAt !== null &&
    Date.parse(source.stateChangedAt) >= Date.parse(pointerAt);
  if (closedByMerge) {
    await store.setStatus(source, 'open', `intake merge reversed (run ${input.runId} item ${input.itemId})`);
  }
  await store.writePayload(source, withHistory(source, 'intakeExecutionReversed', pointer, at), ['intakeExecution']);
  return {
    outcome: 'reversed',
    note:
      `reversed intake merge of ${source.id} into ${targetId}` +
      (closedByMerge ? `; reopened ${source.id}` : '') +
      `; merged evidence on ${targetId} kept and marked reversed`,
  };
}

/** Execute the inverse of one applied intake decision inside the caller's transaction. */
export async function compensateIntakeDecision(
  input: IntakeCompensationInput,
  store: IntakeCompensationStore,
): Promise<IntakeCompensationResult> {
  const disposition = input.decision?.disposition;
  if (!disposition) throw new Error(`intake reversal failed: ${input.itemId} has no recorded intake decision`);
  await store.lockIntake([input.sourceId]);
  const source = await store.lockItem(input.sourceId, input.harnessSlug);
  if (!source) throw new Error(`intake reversal failed: source ${input.sourceId} no longer exists`);

  switch (disposition) {
    case 'retain':
    case 'reject':
      return reverseDisposition(source, input, store);
    case 'promote':
    case 'investigate':
      return reversePromotion(source, input, store, disposition);
    case 'merge':
      return reverseMerge(source, input, store);
    default:
      throw new Error(`intake reversal cannot invert disposition '${disposition}'`);
  }
}

// ── default (transaction-scoped Postgres) store ───────────────────────────────

interface ItemRow {
  feature_id: string;
  harness_slug: string;
  status: string;
  taken_by: string | null;
  taken_at: Date | string | null;
  first_claimed_at: Date | string | null;
  state_changed_at: Date | string | null;
  payload: Record<string, unknown> | null;
  lane: string | null;
}

function iso(value: Date | string | null): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function sqlIntakeCompensationStore(sql: TransactionSql, workspaceId: string): IntakeCompensationStore {
  return {
    async lockIntake(ids) {
      for (const id of [...new Set(ids)].sort()) {
        await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`intake-exec:${id}`}, 0))`;
      }
    },
    async lockItem(id, harnessSlug) {
      const rows = await sql<ItemRow[]>`
        SELECT feature_id, harness_slug, status, taken_by, taken_at, first_claimed_at,
               state_changed_at, payload, lane
          FROM harness_shared.work_items
         WHERE workspace_id = ${workspaceId}
           AND feature_id = ${id}
           ${harnessSlug ? sql`AND harness_slug = ${harnessSlug}` : sql``}
         FOR UPDATE
      `;
      if (rows.length > 1) {
        throw new Error(`intake reversal refused: ${id} is ambiguous across ${rows.length} harnesses`);
      }
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.feature_id,
        harnessSlug: row.harness_slug,
        status: row.status,
        takenBy: row.taken_by,
        takenAt: iso(row.taken_at),
        firstClaimedAt: iso(row.first_claimed_at),
        stateChangedAt: iso(row.state_changed_at),
        payload: { ...(row.payload ?? {}), ...(row.lane === 'observation' ? { lane: 'observation' } : {}) },
      };
    },
    async hasCheckpoint(item) {
      const rows = await sql<Array<{ present: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM harness_shared.carry_notes
           WHERE workspace_id = ${workspaceId}
             AND scope = ${`workitem:${item.harnessSlug}:${item.id}`}
             AND btrim(COALESCE(note, '')) <> ''
        ) AS present
      `;
      return rows[0]?.present === true;
    },
    async downstreamLinkCount(id, since) {
      const rows = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n
          FROM harness_shared.coord_links
         WHERE workspace_id = ${workspaceId}
           AND (src_ref = ${id} OR dst_ref = ${id} OR dst_ref LIKE ${`%:${id}`} OR src_ref LIKE ${`%:${id}`})
           AND rel <> ALL(${INTAKE_RELS as string[]}::text[])
           ${since ? sql`AND created_at >= ${since}::timestamptz` : sql``}
      `;
      return rows[0]?.n ?? 0;
    },
    async writePayload(item, patch, unset) {
      if (!Object.keys(patch).length && !unset.length) return;
      const updated = await sql`
        UPDATE harness_shared.work_items
           SET payload = (COALESCE(payload, '{}'::jsonb) - ${[...unset]}::text[]) || ${sql.json(patch as never)},
               updated_ts = (extract(epoch FROM clock_timestamp()) * 1000)::bigint
         WHERE workspace_id = ${workspaceId}
           AND harness_slug = ${item.harnessSlug}
           AND feature_id = ${item.id}
      `;
      if (updated.count !== 1) throw new Error(`intake reversal failed: payload write on ${item.id} matched ${updated.count} rows`);
      const keep = Object.fromEntries(Object.entries(item.payload).filter(([key]) => !unset.includes(key)));
      item.payload = { ...keep, ...patch };
    },
    async setStatus(item, status, reason) {
      const updated =
        status === 'dropped'
          ? await sql`
              UPDATE harness_shared.work_items
                 SET status = 'dropped',
                     terminal_reason = ${reason},
                     closed_ts = (extract(epoch FROM clock_timestamp()) * 1000)::bigint,
                     state_changed_at = clock_timestamp(),
                     updated_ts = (extract(epoch FROM clock_timestamp()) * 1000)::bigint
               WHERE workspace_id = ${workspaceId}
                 AND harness_slug = ${item.harnessSlug}
                 AND feature_id = ${item.id}
                 AND status = ${item.status}
            `
          : await sql`
              UPDATE harness_shared.work_items
                 SET status = 'open',
                     terminal_reason = NULL,
                     terminal_owner = NULL,
                     terminal_completion_ref = NULL,
                     closed_ts = NULL,
                     state_changed_at = clock_timestamp(),
                     updated_ts = (extract(epoch FROM clock_timestamp()) * 1000)::bigint
               WHERE workspace_id = ${workspaceId}
                 AND harness_slug = ${item.harnessSlug}
                 AND feature_id = ${item.id}
                 AND status = ${item.status}
            `;
      if (updated.count !== 1) {
        throw new Error(`intake reversal failed: ${item.id} could not move ${item.status} -> ${status} (${reason})`);
      }
      item.status = status;
    },
    now: () => new Date(),
  };
}
