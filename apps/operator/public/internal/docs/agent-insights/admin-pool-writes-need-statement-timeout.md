# A coordination WRITE tool hangs forever — the admin pool has no statement_timeout
URL: /internal/docs/agent-insights/admin-pool-writes-need-statement-timeout

When work_items:comment (or any getOrgPg()-based mutating tool) HANGS indefinitely instead of failing, the cause is that the harness_admin pool has a role-default lock_timeout (15s) but NO statement_timeout — so a query that stalls for any non-lock reason runs unbounded. A JS/AbortController watchdog can't cancel an in-flight postgres-js query; only a DB-side statement_timeout can. Fix interactive admin-pool writes with boundedOrgTxn (SET LOCAL statement_timeout + atomic txn); leave migrations unbounded.

import { Aside } from '@astrojs/starlight/components';

## Symptom

An agent reports a coordination **write** tool — `work_items:comment` is the one that
surfaced this — **hung** (never returned), then **timed out on a bounded retry**, and a
follow-up `work_items:get detail:true` shows **no new row landed**. It reads like a
flaky transport; it is not. It is an *unbounded database query* on a write path that has
no per-statement time budget.

## Root cause

`work_items:comment` → `commentWorkItem` → `commentIssue` (issue family) or the feature
branch of `commentWorkItem` runs its queries (`getIssue`, `getOrCreateThread`, `addPost`,
the fan-out) directly on the **`harness_admin`** pool (`getOrgPg().sql`).

That pool's role defaults are:

```
harness_admin → lock_timeout=15s, idle_in_transaction_session_timeout=60s
```

There is **deliberately NO `statement_timeout`** — migrations and long maintenance tooling
share this same pool and must be allowed to run unbounded (see `connection.ts`; the GUC is
set per-session, not on the role). The cost of that omission falls on *interactive* writes:

* A query that **lock-waits** fails at 15s (`55P03`) — slow, but bounded.
* A query that stalls for **any non-lock reason** — a CPU-starved / event-loop-blocked
  operator, a slow scan, a buffer wait — runs **UNBOUNDED** and hangs the MCP call until
  the client transport gives up.

The route stack arms a 30s `AbortController` watchdog (`route-stack.ts`), but **postgres-js
does not cancel an in-flight query when the signal aborts** — the 408 only materializes once
the handler finally returns. The ONLY thing that actually unblocks a wedged query is a
DB-side `statement_timeout` (PG `57014`). Reach for the DB timeout, not a `Promise.race`.

Two aggravating factors on the same path:

1. **Non-atomic durable write.** `PgThreadStore.addPost` did `INSERT … coord_thread_posts`
   then a *separate* `UPDATE coord_threads SET post_count = post_count + 1` as two
   auto-commit statements. A stall between them half-writes; worse, if the INSERT commits
   and the call then appears to fail, a client retry **duplicates** the comment.
2. **Best-effort fan-out that could still hang.** `fanoutForObject` was documented
   "best-effort — a delivery failure cannot break the caller's write" and caught *errors*,
   but did not bound *slowness*: a stalled subscriber-resolve / `appendLine` hung the caller.

## Fix — `boundedOrgTxn` + atomic write + bounded fan-out

`packages/operator-core/lib/pg-bounded-txn.ts` adds `boundedOrgTxn(fn, opts)` — the
interactive-WRITE counterpart to `pg-read-query`'s bounded READ ONLY txn, and a lighter
sibling of `locks/inWorkspaceTxn` (no per-workspace advisory lock). It wraps a unit of
admin-pool writes in ONE transaction with `SET LOCAL statement_timeout` (15s) +
`lock_timeout` (8s), so the work is:

* **ATOMIC** — partial writes can't half-land and a post-stall retry can't duplicate; and
* **BOUNDED** — a stall surfaces as a typed `OrgTxnTimeoutError` (mapped from PG
  `57014`/`55P03`) that the caller turns into a clean `{ ok:false, error }` (bulk tools get
  this for free via `runBulk`), instead of an indefinite hang.

`commentIssue` and the feature comment path now run get-or-create-thread + add-post inside
`boundedOrgTxn` via a **tx-bound `PgThreadStore`** (`new PgThreadStore({ ...coordOpts,
getSql: () => tx })`) — reusing the exact tested store SQL, atomic and bounded. The fan-out
runs *after* the durable write commits and is wrapped in a wall-clock `withDeadline` so the
best-effort contract holds for slowness, not just errors. Migrations keep calling
`getOrgPg()` directly and stay unbounded.

`createIssue` (`issues-engineer.ts`) was also converted: its `nextIssueId` advisory-lock read +
INSERT now run together in a single `boundedOrgTxn` — id allocation and row creation are atomic
(no half-write a retry would duplicate) and bounded by the same 15s statement\_timeout.

`conversations:post` / `conversations:answer` carried the **same class** and are now closed
the same way (WI-766). Because `appendPost` lives in a **pure core** (`conversations-core.ts`)
over injected deps — not a binding-layer function like `commentIssue` — the tx-bound store is
threaded through a `threadTxn` seam on `ConversationDeps`: prod binds
`threadTxn: (fn) => boundedOrgTxn((tx) => fn(new PgThreadStore({ ...storeOpts, getSql: () => tx })))`,
and the PG integration tests bind the *same* `boundedOrgTxn` over their throwaway client so the
real atomic path is asserted (`post_count` never drifts from the row count). The seam pattern is
the reusable way to bound a pure-core write without coupling the core to `getOrgPg` /
`PgThreadStore`.

## When you hit this again

* A `getOrgPg()`-based **mutating** tool that can hang → route its durable write through
  `boundedOrgTxn` (don't reach for `getOrgPg().sql` raw on an interactive write path).
* Don't try to fix a DB hang with an `AbortController` / `Promise.race` alone — add the
  `SET LOCAL statement_timeout`. The JS race is only a secondary guard for best-effort,
  fire-and-forget work (like a fan-out).
* A pure **core** (deps-injected, no `getOrgPg`) that needs a bounded write → add a
  `threadTxn`-style seam to its deps and bind `boundedOrgTxn` + a tx-bound store in the
  binding layer (see `conversations-core.ts` ↔ `conversations.ts`). Don't import `getOrgPg`
  into the core — it breaks the integration-test-without-prod-singletons split.
* The known per-tool offenders are now closed (`work_items:comment`, `conversations:post` /
  `conversations:answer`, `issues:create`). **WI-832** landed a DI seam in `connection.ts`
  (`setAdminPoolStatementTimeoutProvider`) — **now wired** at boot by
  `packages/operator-core/lib/agent-tools/locks/configure.ts` →
  `adminPoolStatementTimeoutMs()` from `txn-timeouts-config.ts`. The default is **0 (no
  timeout)**: the admin pool stays deliberately unbounded unless a non-zero value is set at
  runtime via the `db:txn-timeouts` tool (`adminPoolStatementTimeoutMs` field; kill-switch:
  `papercusp-txn-timeouts-config`). When set to a non-zero value, every new pooled connection
  gets that per-statement cap, bounding the whole interactive-write class at the source; the
  migration runner opts out per-txn (`SET LOCAL statement_timeout = 0`). Until
  `adminPoolStatementTimeoutMs` is configured to a non-zero value, wrap any new interactive
  admin-pool write in `boundedOrgTxn` yourself.
