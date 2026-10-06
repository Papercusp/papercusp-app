# Advisory lock key registry

Papercusp uses PG advisory locks for cross-transaction coordination
in several places. To prevent silent collisions between features that
happen to hash to the same single-arg key, we use the **two-arg form**:

```sql
pg_advisory_xact_lock(<feature_key>, <within-feature key>)
```

Each feature reserves a unique integer for its `<feature_key>`.

| `feature_key` | Feature             | Source                                                     | `<within-feature key>` |
|---------------|---------------------|------------------------------------------------------------|------------------------|
| `101`         | SU agent file locks | `packages/locks/src/in-workspace-txn.ts`                   | `hashtext('su:' \|\| coordination_domain)` — EXCLUSIVE for domain-global work; path-scoped work takes it SHARED plus `hashtext('su:' \|\| coordination_domain \|\| ':' \|\| path)` |
| `101`         | SU named-resource shared ops | `packages/locks/src/sql/030-resource-scoped-shared-ops.sql` (`resource_scope_lock`) | `hashtext('su:' \|\| coordination_domain)` SHARED, then `hashtext('su-resource:' \|\| coordination_domain \|\| ':' \|\| resource)` EXCLUSIVE. Shared acquires on different resources no longer serialize each other; any domain-global (exclusive domain key) transaction still excludes them. The `su-resource:` prefix keeps the key text distinct from every domain and path key. |

## Adding a new feature

1. Pick the next unused integer ≥ 100 (1–99 reserved for system).
2. Add a row here.
3. Use `pg_advisory_xact_lock(<key>, hashtext('<feature>:' || <scope>))`.

The `hashtext` of a feature-scoped string keeps collisions within a
feature (e.g. two workspaces under SU-locks hashing to the same value)
isolated from cross-feature collisions.
