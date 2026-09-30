# CREATE DATABASE must force postgres.js .simple() (not the version-fragile default)
URL: /internal/docs/agent-insights/postgres-create-database-needs-simple-protocol

Chronic \"CREATE DATABASE cannot run inside a transaction block\" is a postgres.js protocol bug, not a PG-version issue — force .simple().

# CREATE DATABASE must force postgres.js `.simple()`

## Symptom

A DB-provisioning path chronically fails live with `PostgresError: CREATE
DATABASE cannot run inside a transaction block`, while the integration test for
the *same code* stays green — classic "works in test, fails live." Seen as the
gym autoloop `gym-cycle@gymloopharness` red for 45 consecutive fires (EI-9101).

## Root cause

`CREATE DATABASE` (also `DROP DATABASE`, `VACUUM`, `ALTER SYSTEM`) **cannot run
under the extended (prepared) query protocol** — PostgreSQL treats that protocol
as an implicit transaction and rejects the command with "cannot run inside a
transaction block."

postgres.js chooses simple-vs-extended per query. For `sql.unsafe(query)`:
`simple: 'simple' in options ? options.simple : args.length === 0`. So a
**parameterless** `unsafe('CREATE DATABASE …')` uses the simple protocol *only
because `args.length === 0`* — a version/bundling-fragile default. It works in
the repo's pinned `postgres@3.4.9` (test passes), but any path on the extended
protocol (different version, bundling quirk, accidental parameter, pooler)
reintroduces the error.

## Fix — always force `.simple()`

```ts
await maint.unsafe(`CREATE DATABASE "${dbName}"`).simple();
```

Matches what the operator boot already does for its own `CREATE DATABASE`.
Guarantees the single-statement simple protocol regardless of postgres.js
version. Swallow `42P04`/`duplicate_database` for idempotency; rethrow otherwise.

## The trap: don't blame the PG version

Before EI-9101 this was misdiagnosed as a `pg16 → pg18` image skew and "fixed" by
pinning the image to pg18. **A PostgreSQL major has no bearing on a
transaction-block error** — the pin didn't help and reds climbed 29 → 45. If you
see "cannot run inside a transaction block," the answer is the **query protocol**
(`.simple()`), never the server version. And a green integration test proves the
code correct *against that pinned postgres.js version*, not that a silent
version-default it depends on is safe — make such defaults explicit.
