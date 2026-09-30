# SU agent file-lock coordination

Cross-process file claim coordination for engineer-collaborator agents
(Claude Code, OMP, Codex, Gemini) reaching Papercusp via `papercusp-su`.

**Plan:** [`apps/operator/docs/plans/su-agent-coordination-v3-2026-05-14.md`](../../../docs/plans/su-agent-coordination-v3-2026-05-14.md)

## Current lock surfaces

The lock family has three deliberately different scopes. Choose the narrowest
surface that matches the thing being protected:

| Tool | Scope and behavior |
|---|---|
| `locks:acquire` | Exclusive locks for a deliberate set of repository files (or authorized current-user home/XDG-runtime files). Supports an immediate result, a same-turn `wait.max_sec` drain, or `wake_on_grant:true` for a queued one-shot wake. |
| `locks:release` | Release selected file-lock sets by `lock_id`/`lock_ids`, release the caller's active rows for requested `paths` across all coordination domains, or release all of the caller's locks with `all_mine:true`. Path-only requests group rows by `lock_id` and release only the requested paths. |
| `locks:heartbeat` | Extend a held file-lock lease; `extended:false` means the lock is gone, stolen, expired, or not found in the requested domain. |
| `locks:cancel_wait` | Cancel a queued `locks:acquire` waiter ticket. If a grant raced, cancel returns false and the caller must release the lock it received. |
| `locks:queue` | Read-only inspection of file locks and pending waiters; use it to recover a lost `lock_id`. |
| `locks:acquire_granular` | Multi-granularity intention lock on a file, directory/subtree, or harness root. `X` owns the subtree; `S` reads it; `SIX` reads it while writing one node. This is a separate domain and does **not** exclude classic `locks:acquire` file locks. |
| `locks:release_granular` | Release the complete granular lock-set returned by `locks:acquire_granular`. |
| `locks:acquire_resource` | Lock a registered named resource such as `dev-server` or `db-schema`: `shared` means use it; `exclusive` means restart/mutate it and drain existing shared holders. |
| `locks:release_resource` | Release a named-resource lock by `lock_id`, resource name, or a selected batch. |
| `locks:heartbeat_resource` | Extend a long-held named-resource lease before its TTL expires. |

### Lease and wait bounds

- All lock leases default to `ttl_sec=1200` (20 minutes) and cap at
  `ttl_sec=3600` (1 hour). `ttl_sec=0` is invalid; it is not a request for
  an immediate expiry.
- `locks:acquire` accepts up to 50 total file entries across `paths` and
  `external_paths` (home files map to `@external/home/*`; XDG runtime files
  map to `@external/runtime/*`); `intent` is capped at 1000 characters. Its blocking
  `wait.max_sec` is capped at 300 seconds (larger values are clamped). For a
  longer wait, use `wake_on_grant:true` and end the turn.
- `locks:acquire_resource` accepts only registered resource names. Its
  exclusive `wait.max_drain_sec` is 0–300 seconds; discover the exact name and
  policy with `locks:list` first. `reason` is capped at 2000 characters.
- `locks:acquire_granular` uses a repo-relative node (or the empty string for
  the harness root), the same 1-hour lease cap, and a 1000-character `intent`.

The server-side `LISTEN/NOTIFY` wait path, waiter cap, progress events, and
configured automatic edit hooks are shipped. A session without hook coverage
must use `locks:acquire` explicitly for a deliberate multi-file hold; do not
manually wrap every incidental edit in a hooked session.

## Storage

- **Database:** `papercusp_su` (separate from `papercusp` main db, same
  embedded PG instance, same `harness_admin` role).
- **Bootstrap:** Lazy on first `locks:*` call. Creates the db if absent,
  applies SQL migrations from `@papercusp/locks`'s
  `packages/locks/src/sql/NNN-*.sql` under
  `LOCK TABLE su_meta IN SHARE UPDATE EXCLUSIVE MODE` to serialize
  concurrent migration runners.
- **Schema:** `agent_file_locks`, `agent_lock_waiters`, both with
  aggressive per-table autovacuum settings (5% bloat threshold).

### One-time install prereqs

The bootstrap needs `harness_admin` to be able to `CREATE DATABASE`.
Granted once per machine:

```bash
sudo -u postgres psql -c "ALTER ROLE harness_admin CREATEDB;"
```

For query-level perf monitoring (optional), enable `pg_stat_statements`
as superuser after the database exists:

```bash
sudo -u postgres psql -d papercusp_su -c "CREATE EXTENSION pg_stat_statements;"
```

## Concurrency model

```ts
inWorkspaceTxn(workspaceId, ownerId, async (tx) => {
  // SET LOCAL application_name = 'papercusp-su:' || ownerId
  // SET LOCAL lock_timeout = '5s'
  // SET LOCAL statement_timeout = '5s'  (per-op override in handler)
  // Path-scoped file claims take the shared workspace gate plus one
  // pg_advisory_xact_lock(101, hashtext('su:' || workspaceId || ':' || path))
  // per canonical path, sorted for multi-path deadlock safety. Global
  // operations keep pg_advisory_xact_lock(101, hashtext('su:' || workspaceId)).
  // ...tool body runs serialized within this workspace...
});
```

The advisory key `101` is reserved for SU locks in
[`packages/locks/src/sql/advisory-lock-keys.md`](../../../../../packages/locks/src/sql/advisory-lock-keys.md).
Two-arg form prevents collision with any future feature using advisory
locks.

## Canonical-path contract

A lock key is `hashtext('su:' || coordination_domain || ':' || path)`. Two
callers contend **iff** they pass the byte-identical `path` string —
so every caller MUST pass the same canonical form for the same file,
or the lock silently provides nothing.

`normalizePaths()` (`su-lock-store.ts`) enforces the contract on every
`locks:acquire`. It runs `validatePath()` on the **raw** path, then
`canonicalizePath()`:

| Rule | Example in → out |
|---|---|
| Strip leading `./` | `./apps/foo.ts` → `apps/foo.ts` |
| Collapse repeated `/` | `apps//foo.ts` → `apps/foo.ts` |
| Drop `/./` segments | `apps/./foo.ts` → `apps/foo.ts` |
| Strip trailing `/` | `apps/foo.ts/` → `apps/foo.ts` |

Rejected outright (`InvalidPathError`, never normalized):

- **Absolute** paths (`/etc/passwd`) — paths must be repo-relative.
- **`..` traversal** (`../x`, `a/../b`, bare `..`).
- **Backslashes** (`apps\foo.ts`) — POSIX forward slashes only.
- **NULL bytes**, empty, or anything that canonicalizes to empty.

**Symlinks are the caller's responsibility.** The operator does not
share the agent's working directory, so it cannot `realpath` a
symlink. A caller that locks a symlink and another that locks its
target will NOT contend. Resolve symlinks to their real path before
calling `locks:acquire`. (The OMP enforcement hook refuses to acquire
on a symlink — see `scripts/hooks/`.)

## Inspection

```bash
# Find SU PG db (URL is reused from the main embedded-pg).
PSQL_URL="postgresql://harness_admin:harness_admin_pwd@localhost:5432/papercusp_su"

# Active locks + waiters
psql "$PSQL_URL" -c "SELECT path, owner_label, intent, expires_ts FROM agent_file_locks ORDER BY expires_ts;"
psql "$PSQL_URL" -c "SELECT ticket_id, owner_label, paths, status, queued_ts FROM agent_lock_waiters WHERE status='waiting';"

# Per-agent activity (which connections are doing what)
psql "$PSQL_URL" -c "SELECT pid, application_name, state, query_start, query FROM pg_stat_activity WHERE application_name LIKE 'papercusp-su:%';"

# Query stats
psql "$PSQL_URL" -c "SELECT calls, total_exec_time, mean_exec_time, query FROM pg_stat_statements WHERE query LIKE '%agent_file_locks%' ORDER BY total_exec_time DESC LIMIT 10;"
```

## Troubleshooting

### Stuck advisory lock — kill a wedged connection

If a connection is hung inside a `papercusp-su` transaction (bug in a
tool, network partition, infinite loop), `idle_in_transaction_session_timeout`
(30s, set at db level) handles the idle case. For an actively-spinning
backend that won't release:

```sql
SELECT pid, application_name, state, query
  FROM pg_stat_activity
 WHERE application_name LIKE 'papercusp-su:%'
   AND state IN ('active', 'idle in transaction')
   AND state_change < now() - interval '1 minute';

-- After confirming the offending pid:
SELECT pg_terminate_backend(<pid>);
```

### Reset all lock state

The separate-database design makes nuclear reset trivial:

```sql
\c papercusp
DROP DATABASE papercusp_su;
-- Next locks:* call recreates it.
```

### Lock survived an agent crash

By design — TTL is the only way agents are guaranteed to lose a held
lock. Default TTL is 20 minutes; another agent's next `locks:acquire`
silently steals the expired lock. To force-release immediately:

```sql
DELETE FROM agent_file_locks WHERE owner_label LIKE '%<some-substring>%';
```

## Manual smoke test

```
# Terminal A
omp
> use locks:acquire { paths: ['apps/operator/lib/foo.ts'], ttl_sec: 60, intent: 'hold foo.ts for smoke test' }

# Terminal B (within 60s)
omp
> use locks:acquire { paths: ['apps/operator/lib/foo.ts'], intent: 'contend for foo.ts' }

# Expect: B sees ok=false, busy=[{path: 'apps/operator/lib/foo.ts', owner_label: '...', expires_ts: '...'}]
# After 60s of waiting on B + re-trying: should succeed.
```

## Divergence from the v3.3 plan

Two pragmatic adjustments:

1. **Same `harness_admin` role, not a new `papercusp_su` role.**
   Embedded PG has no external network surface; the grant-isolation
   benefit doesn't justify the password-file complexity.
2. **Migrations live with the package at `packages/locks/src/sql/`**
   (moved there from `apps/operator/lib/agent-tools/locks/sql/` in the
   P-010 extraction), not `libs/papercusp/libs/db/sql/su-locks/`. Keeps
   the feature self-contained; the main DB's migration system targets a
   different database anyway.

Everything else follows the v3.3 plan.
