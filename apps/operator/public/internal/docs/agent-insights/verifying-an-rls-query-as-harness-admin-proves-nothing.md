# Verifying an RLS query as harness_admin proves nothing
URL: /internal/docs/agent-insights/verifying-an-rls-query-as-harness-admin-proves-nothing

dev:pg_query and `psql -U harness_admin` run as a role with rolbypassrls=true; the operator's app path runs as harness_app, which does not. So the standard way an agent 'verifies the real SQL against live PG' cannot detect the one failure that matters — an RLS-scoped query returning ZERO rows, which reads as 'no matching state' rather than as an error. Includes which helper uses which role, the two silent failure directions, and the two-role drill that actually falsifies.

## The trap

You write a query for operator code, then verify it the normal way — `dev:pg_query`, or
`psql` against the admin URL. It returns exactly the rows you expect. You ship it.

That verification is worthless for any table with RLS, because **the two roles disagree and
the disagreement is silent**:

| role                                                      | `rolbypassrls` | sees RLS-protected rows?         |
| --------------------------------------------------------- | -------------- | -------------------------------- |
| `harness_admin` (what `dev:pg_query` / the admin URL use) | **true**       | always                           |
| `harness_app` (the operator's app path)                   | **false**      | only with `app.workspace_id` set |

Measured 2026-08-03 on `harness_shared.coord_event_log`, policy
`coord_event_log_workspace_isolation` → `workspace_id = current_setting('app.workspace_id', true)`:

```
as harness_admin                              -> rows (RLS bypassed entirely)
as harness_app, no app.workspace_id           -> 0 rows
as harness_app, SET app.workspace_id='…'      -> 11,768 rows
```

Note the shape of the failure. It is not an error, a permission denial, or a wrong answer —
it is an **empty result**, which every caller reads as "there is no such state right now."
The EXPLAIN is the tell: the index scan reports `never executed` / `Index Searches: 0`,
because RLS reduced the predicate to something provably false.

## Which helper uses which role

Both in `libs/papercusp/libs/db/src/connection.ts`:

* **`getOrgPg()` → `harness_admin`, BYPASSES RLS.** Its own docstring: *"use `getOrgPg()` only
  for migrations and tooling that intentionally spans workspaces."*
* **`getOrgPgApp()` → `harness_app`, SUBJECT to RLS.** The workspace-scoping contract is
  `withWorkspace()`, which opens a transaction on that client and issues
  `SET LOCAL app.workspace_id`.

## The two silent failure directions

Because a lot of system code runs on `getOrgPg()`, both mistakes are easy and neither
announces itself:

1. **On `getOrgPg()`, an explicit `workspace_id = $1` predicate is LOAD-BEARING, not
   defensive.** RLS is not scoping you. Drop or loosen it — or let a refactor "simplify" it
   away because "RLS handles that" — and the read silently spans **every tenant**. For a
   watchdog that resolves alarms, that means one workspace's recovery all-clears another
   workspace's live alarm.

2. **Switching such code to `getOrgPgApp()` without `withWorkspace()` returns zero rows.**
   This looks like the *safer, more correct* change — use the least-privileged role — and it
   is exactly the change that breaks it. A guard whose durable read returns empty simply
   stops acting, forever, while every test still passes and the code still looks right.

Direction 2 is the nastier one: it converts a working guard into a no-op that is
indistinguishable from a quiet, healthy system.

## The drill

Before trusting any verification of a query against an RLS table, run it **as both roles**,
and as `harness_app` run it **both with and without** the setting:

```bash
# convention creds, hardcoded in connection.ts
PGPASSWORD=harness_app_pwd psql -X -U harness_app -h localhost -p 5432 -d papercusp -At \
  -c "SELECT count(*) FROM harness_shared.coord_event_log WHERE workspace_id='papercusp-workspace'"
# -> 0   (no app.workspace_id: this is what your code would actually see)

PGPASSWORD=harness_app_pwd psql -X -U harness_app -h localhost -p 5432 -d papercusp -At \
  -c "SET app.workspace_id='papercusp-workspace'; SELECT count(*) FROM harness_shared.coord_event_log"
# -> 11768
```

Check whether a table even has RLS before assuming it doesn't:

```sql
SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid='harness_shared.coord_event_log'::regclass;
SELECT polname, pg_get_expr(polqual, polrelid) FROM pg_policy WHERE polrelid='harness_shared.coord_event_log'::regclass;
```

## The general rule

**A probe that runs under different privileges, scope, or window than the real code cannot
falsify the real code's behaviour.** RLS is one instance; the same session that produced this
doc hit another the same hour — a claim of "this has NEVER happened" derived from a query
with a 7-day `ts >` bound, which was wrong because the last occurrence was 13 days back.

Both errors share one shape: *the probe could not have detected the failure it was being used
to rule out.* When a verification comes back clean, the question to ask is not "did it pass?"
but **"under what conditions did it run, and are they the real ones?"**
