# Runbook — capless governor receipts and cancellation
URL: /internal/docs/agent-insights/capless-governor-receipt-and-cancellation-runbook

Runbook: how a durable admission receipt is issued, looked up, replayed and cancelled under the capless resource governor — and why a receipt replaces retrying.

## What a receipt is

When productive capacity is pressured the governor **queues**; it never rejects accepted work (D-001). The thing you get back is a **durable receipt**, not a held-open request and not a retry hint (D-005).

* The receipt is a real `harness_shared.work_items` row. Its `receiptId` **is** the canonical work-item id (`WI-…`), and the governor's own record lives under the row's `payload->'resource_governor'` key.
* Identity is the caller's `idempotencyKey`, enforced by a partial unique index. Two processes admitting the same key concurrently converge on **one** receipt.
* A request whose key matches an existing receipt but whose *fingerprint* differs is a programming error, not a duplicate: it raises `AdmissionIdempotencyConflictError`.

```
outcome.kind === 'queued'  → { receipt: { receiptId, idempotencyKey, state, enqueuedAtMs, decisionGeneration } }
outcome.kind === 'admitted' → started now; carries the AdmissionContext
outcome.kind === 'bypass'   → a registry-owned bypass key; unknown keys fail closed
```

## Look one up

Through the driver (preferred — it applies the namespace and the real state machine):

```ts
const status = await driver.status(idempotencyKey);
// { idempotencyKey, state, receipt?, context?, resultRef? }
```

`state` is one of `queued | eligible | leased | running | completed | cancelled | superseded | expired`, or `unknown` when no row matches.

Ad-hoc, from SQL — remember the tenant predicate:

```sql
-- sql-snippet-justified: reads payload->'resource_governor' JSONB fields and filters on a
-- payload-> predicate — a shape no work_items:* tool projects; the routing table itself routes
-- payload-> predicates to SQL.
SELECT feature_id,
       payload->'resource_governor'->>'state'          AS state,
       payload->'resource_governor'->>'idempotencyKey' AS key,
       payload->'resource_governor'->>'namespace'      AS namespace
  FROM harness_shared.work_items
 WHERE workspace_id = '<workspace>'
   AND payload->'resource_governor'->>'namespace' = '<namespace>';
```

## Replay is the recovery path, not retry

Re-issuing the **identical** request after a crash, a failover, or a rolled-back deploy is safe and is the intended recovery: it returns the same `receiptId` and creates no second row. That property is guarded by
`p017-profile-matrix.integration.test.ts` (restart/failover, every profile) and
`p018-rollback-drill.integration.test.ts` (replay after a rollback).

**Do not** wrap admission in a retry loop. A retry loop re-derives what the receipt already guarantees, and under real pressure it is how a queue turns into a stampede.

## Cancel

```ts
const result = await driver.cancel(idempotencyKey, 'why');
// { idempotencyKey, cancelled: boolean, state: 'cancelled' }
```

Cancellation is a **state transition, never a delete**. The row stays, auditable, with its receipt id intact — which is what makes an ordered exit from a rollback possible. `cancelled: false` means the row was already cancelled (the call is idempotent), not that cancellation failed.

## What never to do

* Never `DELETE` a queue row to "clear" a backlog. You destroy the receipt a caller is holding, and the audit trail with it. Cancel it.
* Never re-introduce a numeric admission ceiling to shed load. Pressure queues; a cap is what this architecture removed (D-002).
* Never treat `state: 'unknown'` as "not queued" without checking the namespace — a wrong namespace answers `unknown` for a receipt that exists.
