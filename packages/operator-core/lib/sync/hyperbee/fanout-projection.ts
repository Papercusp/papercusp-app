/**
 * fanout-projection — the LOCAL subscribe→inject fan-out, run as a consumer on
 * the EXISTING substrate_outbox drain (coordination-substrate-2026-06-03,
 * Phase 2). The drain already appends each captured change to the device's
 * Hypercore log for federation; this runs ALONGSIDE that (same drain, same row,
 * not a second consumer) to ALSO resolve the changed object's subscribers and
 * inject a notice into each subscriber's inbox.
 *
 * Source of truth: `substrate_outbox`. A change to a subscribable object
 * (feature / issue / plan / … — whatever has a capture trigger) lands one row;
 * `runFanoutForOutboxRow` maps it to an {kind, ref} ObjectRef via the registry
 * below, resolves direct + topic subscribers (capabilities/resolveObjectSubscribers),
 * and delivers per delivery_mode (full | digest | mention — D-006). Tables not in
 * the registry (claims, presence, usage, …) are a no-op.
 *
 * AT-LEAST-ONCE: the drain re-runs a row whose processing failed before it was
 * marked drained, so delivery is idempotent — each notify has a DETERMINISTIC
 * msg_id (`fan-<outbox_id>-<subscriber>`) inserted ON CONFLICT DO NOTHING against
 * the partial unique index (migration 126), so a redrain is a no-op not a dup.
 *
 * Federation registration of NEW objects (plans, conversations, engineer-issues)
 * is the companion plans' job (op-keys + a projection module). This file only
 * needs the table→ObjectRef MAPPING — companions call registerSubscribableTable
 * for their object so its changes fan out, without touching this file.
 *
 * POLICY vs DELIVERY (adopt-event-rules-engines D-005/D-006): the registry IS
 * the policy layer — a trigger-key-indexed rule table (`on: table_name → build
 * InjectEvent`). Its decision content is declarative: `notifyKind` a per-op data
 * map, `isResolution` a canonical `@papercusp/rules` DataCondition. The delivery
 * substrate below (idempotent ON CONFLICT insert, drain ordering, subscriber
 * resolution) stays imperative by design — the gate/substrate protects
 * correctness, only the policy is data.
 */

import type { Sql } from 'postgres';
import { evaluateDataCondition, type DataCondition } from '@papercusp/rules';
import { getOrgPg } from '@papercusp/db-org';
import {
  PgEntitySubscriptionStore,
  PgTaggableStore,
  PgTopicStore,
  resolveObjectSubscribers,
  type ObjectRef,
  type ResolvedSubscriber,
} from '@papercusp/coordination/capabilities';
import { coordScopeWorkspace } from '../../agent-tools/coordination/log';
import { buildInjectEnvelope, shouldDeliver, type InjectEvent, type InjectSink } from '../../agent-tools/coordination/fanout-delivery';

type OutboxOp = 'put' | 'del';

/**
 * How to turn a captured change to one table into a subscribable-object notice.
 *
 * The CONDITION parts of a mapping are declarative (adopt-event-rules-engines
 * D-005): `notifyKind` is a plain per-op data map, and `isResolution` is the
 * canonical `@papercusp/rules` `DataCondition` evaluated over the outbox change
 * `{ op, key, row }` — serializable, inspectable, the same `when` language as
 * the event-reaction rules + the blueprint spine. The string-TEMPLATING parts
 * (`ref`, `summary`) stay functions: they render row data, they don't decide
 * anything (the same boundary as the rules engine's own args function-form).
 */
export interface SubscribableMapping {
  /** ObjectRef.kind for this object (e.g. 'feature'). */
  kind: string;
  /** ObjectRef.ref from the outbox row's key (the capture key column) + jsonb row. */
  ref: (key: string, row: Record<string, unknown> | null) => string;
  /** One-line notice summary. */
  summary: (op: OutboxOp, row: Record<string, unknown> | null, ref: string) => string;
  /** notify_kind sub-type for rendering, per outbox op. */
  notifyKind: Record<OutboxOp, string>;
  /** Declarative resolution condition over `{ op, key, row }` — when it matches,
   *  the change is a lifecycle resolution (mention-mode also receives these).
   *  Omitted ⇒ never a resolution. */
  isResolution?: DataCondition;
}

const SUBSCRIBABLE_TABLES = new Map<string, SubscribableMapping>();

/** Register a table whose captured changes fan out to subscribers of the mapped
 *  object. Companions call this for their domain object (idempotent — last wins). */
export function registerSubscribableTable(tableName: string, mapping: SubscribableMapping): void {
  SUBSCRIBABLE_TABLES.set(tableName, mapping);
}

export function getSubscribableMapping(tableName: string): SubscribableMapping | undefined {
  return SUBSCRIBABLE_TABLES.get(tableName);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

// ── Seed the pipeline objects that already federate (capture triggers exist /
//    are coming via the companion plans). Plans flow once mig 124/125 land. ──

registerSubscribableTable('harness_features_consolidated', {
  kind: 'feature',
  ref: (key) => key, // capture key = feature_id
  summary: (op, row, ref) =>
    op === 'del' ? `feature ${ref} removed` : `feature ${ref}${row?.status ? ` → ${str(row.status)}` : ''}${row?.title ? `: ${str(row.title)}` : ''}`,
  notifyKind: { put: 'feature_updated', del: 'feature_removed' },
  isResolution: { op: { notEquals: 'del' }, 'row.status': { in: ['passed', 'deprecated'] } },
});

registerSubscribableTable('harness_issues_consolidated', {
  kind: 'issue',
  ref: (key) => key, // capture key = issue_id
  summary: (op, row, ref) =>
    op === 'del' ? `issue ${ref} removed` : `issue ${ref}${row?.status ? ` → ${str(row.status)}` : ''}${row?.title ? `: ${str(row.title)}` : ''}`,
  notifyKind: { put: 'issue_updated', del: 'issue_removed' },
  isResolution: { op: { notEquals: 'del' }, 'row.status': { in: ['resolved', 'closed'] } },
});

registerSubscribableTable('harness_plans', {
  kind: 'plan',
  ref: (key) => key, // capture key = plan_slug (su-fcb0d confirmed)
  summary: (op, row, ref) =>
    op === 'del' ? `plan ${ref} removed` : `plan ${ref}${row?.status ? ` → ${str(row.status)}` : ''}${row?.title ? `: ${str(row.title)}` : ''}`,
  notifyKind: { put: 'plan_updated', del: 'plan_removed' },
  isResolution: { op: { notEquals: 'del' }, 'row.status': { equals: 'shipped' } },
});

// ── The runner ──────────────────────────────────────────────────────────────

export interface OutboxFanoutRow {
  id: string | number;
  table_name: string;
  op: OutboxOp;
  key: string;
  row: Record<string, unknown> | null;
}

export interface FanoutDeps {
  /** Resolve direct + topic subscribers of an object (capabilities). */
  resolve: (object: ObjectRef) => Promise<ResolvedSubscriber[]>;
  /** Idempotent delivery of one notify to one subscriber. Returns true if a row
   *  was written (false = deduped redelivery). */
  deliver: (outboxId: string, sub: ResolvedSubscriber, ev: InjectEvent) => Promise<boolean>;
}

/**
 * Fan one substrate_outbox row out to the changed object's subscribers. Returns
 * the count delivered. A table with no mapping (or an empty ref / no subscribers)
 * is a no-op. Pure over injected deps, so it is unit-testable without PG.
 */
export async function runFanoutForOutboxRow(outboxRow: OutboxFanoutRow, deps: FanoutDeps): Promise<number> {
  const mapping = SUBSCRIBABLE_TABLES.get(outboxRow.table_name);
  if (!mapping) return 0;
  const ref = mapping.ref(outboxRow.key, outboxRow.row);
  if (!ref) return 0;

  const object: ObjectRef = { kind: mapping.kind, ref };
  const subscribers = await deps.resolve(object);
  if (subscribers.length === 0) return 0;

  const ev: InjectEvent = {
    from: 'substrate',
    subject: `${mapping.kind}:${ref}`,
    summary: mapping.summary(outboxRow.op, outboxRow.row, ref),
    notify_kind: mapping.notifyKind[outboxRow.op],
    isResolution:
      mapping.isResolution != null &&
      evaluateDataCondition(mapping.isResolution, { op: outboxRow.op, key: outboxRow.key, row: outboxRow.row }),
  };

  let delivered = 0;
  for (const sub of subscribers) {
    if (!shouldDeliver(sub.delivery_mode, ev, sub.subscriber_id)) continue;
    if (await deps.deliver(String(outboxRow.id), sub, ev)) delivered += 1;
  }
  return delivered;
}

// ── Production wiring (PG singletons over the coord workspace) ────────────────

// P-004: resolve the coord workspace PER-OPERATION (flag-gated via
// coordScopeWorkspace — the SAME resolver coordLog + the reach paths now use) so
// the fan-out reads subscribers from, and writes notifies to, the SAME workspace a
// subscribe wrote. The old `workspaceId: DEFAULT_COORD_WORKSPACE` pin silently
// dropped deliveries under COORD_PER_WORKSPACE (subscribe→active-ws, fanout-read→default).
const storeOpts = { getSql: () => getOrgPg().sql, ensureSchema: async () => {}, getWorkspaceId: () => coordScopeWorkspace() };
const subscriptions = new PgEntitySubscriptionStore(storeOpts);
const tags = new PgTaggableStore(storeOpts);
const topics = new PgTopicStore(storeOpts);

/** Idempotent insert of one fan-out notify (deterministic msg_id + ON CONFLICT,
 *  migration 126). Mirrors PgCoordLog.appendLine's row shape so coord:inbox
 *  reads it identically. Exported for the integration test (driven against a
 *  test PG handle). */
export async function insertFanoutNotify(
  pg: Sql,
  outboxId: string,
  sub: ResolvedSubscriber,
  ev: InjectEvent,
): Promise<boolean> {
  const msgId = `fan-${outboxId}-${sub.subscriber_id}`;
  const env = buildInjectEnvelope(sub, ev, msgId);
  const rows = await pg<{ id: string }[]>`
    INSERT INTO harness_shared.coord_event_log (workspace_id, surface, writer_key, msg_id, body)
    VALUES (${coordScopeWorkspace()}, 'messages', ${sub.subscriber_id}, ${msgId}, ${JSON.stringify(env)}::text::jsonb)
    ON CONFLICT (workspace_id, msg_id) WHERE (surface = 'messages' AND (body ->> 'notify_kind') IS NOT NULL)
    DO NOTHING
    RETURNING id`;
  return rows.length > 0;
}

/** Deadline for the synchronous best-effort fan-out (fanoutForObject). Generous
 *  enough that a normal multi-subscriber fan-out never trips it, tight enough that
 *  a wedged query can't hang the caller's write. Override via PAPERCUSP_FANOUT_DEADLINE_MS. */
const FANOUT_DEADLINE_MS = Math.max(1000, Number(process.env.PAPERCUSP_FANOUT_DEADLINE_MS) || 10_000);

/**
 * Resolve `p`, but if it hasn't settled within `ms`, resolve to `fallback` so the
 * caller is never blocked longer than the deadline. The losing promise keeps
 * running (its result is ignored) — fine for an idempotent, best-effort fan-out
 * whose misses the at-least-once outbox drain redelivers. `p` never rejects here
 * (its body catches), so no unhandled rejection can escape the abandoned branch.
 */
export async function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    if (typeof timer?.unref === 'function') timer.unref();
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The production fan-out consumer the drain calls per outbox row. Best-effort at
 * the drain level is NOT used: errors propagate so the drain's at-least-once
 * retry re-runs (idempotent insert makes that safe). Returns count delivered.
 */
export async function fanoutOutboxRow(outboxRow: OutboxFanoutRow): Promise<number> {
  const pg = getOrgPg().sql;
  return runFanoutForOutboxRow(outboxRow, {
    resolve: (object) => resolveObjectSubscribers(object, { subscriptions, tags, topics }),
    deliver: (outboxId, sub, ev) => insertFanoutNotify(pg, outboxId, sub, ev),
  });
}

/**
 * The canonical synchronous fan-out seam for a change that does NOT flow through
 * the substrate_outbox drain — i.e. a LOCAL-only coordination object (conversation,
 * engineer_issue, thread post). Resolves the object's subscribers (direct ∪ the
 * subscribers of every topic it is tagged with — resolveObjectSubscribers) and
 * delivers per delivery_mode, optionally excluding the actor so an agent is never
 * notified of its own action. Uses a wall-clock msg_id (no redelivery → no
 * idempotency needed). Best-effort: a delivery failure cannot break the caller's
 * write.
 *
 * NB: this unions topic-tag subscribers (via resolveObjectSubscribers), so a
 * local object tagged with a topic DOES reach that topic's subscribers — the
 * concern that the local path only reaches direct subscribers is unfounded.
 * Both issues-engineer.ts and conversations-core.ts route through here (A6).
 *
 * `opts.stores` + `opts.sink` let a caller inject the subscriber stores + the
 * delivery sink (both default to the production getOrgPg singletons + coordLog).
 * conversations-core threads its fully-injected `deps` (subs/tags/topics over a
 * throwaway test container + an in-memory sink) so it can route through here
 * without losing the dependency injection its tests rely on (A6).
 */
export async function fanoutForObject(
  object: ObjectRef,
  ev: InjectEvent,
  opts: {
    excludeId?: string;
    sink?: InjectSink;
    stores?: Parameters<typeof resolveObjectSubscribers>[1];
  } = {},
): Promise<number> {
  // Best-effort means it must never break OR HANG the caller's write. The catch
  // already absorbs ERRORS; the deadline absorbs SLOWNESS — a stalled subscriber
  // resolve / appendLine (the admin pool has no default statement_timeout) must
  // not block the comment/issue/conversation write that triggered the fan-out.
  // On deadline we abandon the fan-out (returns 0) and let the caller proceed;
  // the at-least-once outbox drain redelivers anything genuinely missed.
  return withDeadline(
    (async () => {
      try {
        const subscribers = (
          await resolveObjectSubscribers(object, opts.stores ?? { subscriptions, tags, topics })
        ).filter((s) => opts.excludeId == null || s.subscriber_id !== opts.excludeId);
        const { deliverInjectMany } = await import('../../agent-tools/coordination/fanout-delivery');
        return await deliverInjectMany(subscribers, ev, opts.sink);
      } catch {
        return 0;
      }
    })(),
    FANOUT_DEADLINE_MS,
    0,
  );
}
