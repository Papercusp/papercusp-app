# PgBouncer rejects statement_timeout as a startup param — fleet-wide plans:* write flakiness
URL: /internal/docs/agent-insights/pgbouncer-rejects-statement-timeout-startup-param

When the org pools route through PgBouncer (transaction pooling), sending statement_timeout / idle_in_transaction_session_timeout as postgres-js `connection:` STARTUP parameters makes PgBouncer 502 the connection: 'unsupported startup parameter: statement_timeout'. It surfaces as intermittent plans:* (org-pool) write failures fleet-wide. Fix: omit those GUCs at startup on POOLED connections and enforce them per-transaction via SET LOCAL. Immediate kill-switch: flip papercusp-txn-timeouts-config OFF — the D-010 flag cache refreshes event-driven on flag changes (immediate in-process via onFlagChange); restart is the deterministic fallback if the flag event doesn't propagate.

## Symptom

Intermittent `plans:*` write failures fleet-wide; the operator journal fills with
`[pot-survey] plan read failed for '<pot>' — skipped: unsupported startup parameter: statement_timeout`
(13k+ in 30 min during the 2026-06-25 incident). No work is lost — the connection is refused, the
query is retried/skipped — but the org-pool write class degrades.

## Root cause

`buildClient` in `connection.ts` builds the postgres-js client with a `connection: {}` block. Those
keys are sent in the **libpq STARTUP packet**. When the org pools route through **PgBouncer**
(`pgbouncerEnabled()` is default-ON for server-class hosts → `maybePgbouncer` reroutes to `:6432`),
PgBouncer **rejects any startup parameter it isn't told to ignore**:

* `application_name` — allowed by default.
* `search_path` — must be in PgBouncer's `ignore_startup_parameters` (it is, on the host).
* `idle_in_transaction_session_timeout` — same (host ignores it).
* **`statement_timeout`** — NOT in the host's ignore list → **`unsupported startup parameter`**.

`statement_timeout` is only sent when WI-832's `adminPoolStatementTimeoutMs` provider returns > 0
(behind the `papercusp-txn-timeouts-config` flag). Once that config is non-zero (it was 30000), every
NEW pooled backend establishment fails — hence the **intermittent** nature (cached pool connections
keep working; only fresh connects fail). Under transaction pooling a connect-time GUC doesn't even
persist across the pool, so the startup param was non-functional *and* fatal.

## The durable fix (connection.ts)

Extract `buildConnectionOptions({ ..., pooled })` and **omit `statement_timeout` +
`idle_in_transaction_session_timeout` from the startup block when `pooled`**. Thread `pooled =
pgbouncerEnabled()` from the org-pool builders (`getOrgPg`/`getOrgPgApp`); the per-harness pool stays
direct (`pooled=false`). Under pooling the real enforcement is **per-transaction `SET LOCAL`**
(`in-workspace-txn.ts` re-applies statement\_timeout + search\_path per tx) and PgBouncer's own
`idle_transaction_timeout`. Direct connections (the Tauri desktop's embedded PG) keep both GUCs.
Guarded by `connection-helpers.test.ts` + `connection-statement-timeout.test.ts` (assert pooled ⇒ no
timeout startup params).

> General rule: **never send a non-standard GUC as a startup parameter on a pooled connection.** Apply
> it per-transaction with `SET LOCAL`, or it'll either be rejected or silently dropped by the pooler.

## Immediate kill-switch (no deploy)

Flip **`papercusp-txn-timeouts-config` OFF** → `adminPoolStatementTimeoutMs()` returns 0 → no
`statement_timeout` startup param. SAFE when the config holds only `adminPoolStatementTimeoutMs` (no
lock/stmt override) — it reverts `inWorkspaceTxn` to the baked 5s/5s defaults and removes only the bug
trigger.

The flag is read through a module-level D-010 sync cache (`txn-timeouts-config.ts`) with three refresh
triggers: **(a)** event-driven via `onFlagChange` — fires immediately when `papercusp-txn-timeouts-config`
is flipped in PostHog, refreshing the in-process cache without a restart; **(b)** same-process immediate
on any `db:txn-timeouts set` / `reset` write (all three ops — `get`, `set`, `reset` — are deployed);
**(c)** a \~60s `.unref()`'d periodic timer for bounded cross-process + restart freshness.

**Flipping the flag OFF propagates to a running process immediately via (a).** If the flag event
doesn't propagate (flag service unreachable, cold-start race), the deterministic fallback is
**`systemctl --user restart papercup-dev-api.service`** (the `:3070` release operator boots with
`cachedEnabled=false`). A restart is always safe (same release code, picks up the flag); 0 errors
after confirms it. Re-enable the flag once the code fix is deployed (the admin-pool cap becomes
pooler-safe — applied per-tx / on direct connections only).
