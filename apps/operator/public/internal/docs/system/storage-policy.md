# Storage policy — Postgres by default
URL: /internal/docs/system/storage-policy

When to put state in Postgres vs. when a file is the right answer. Default is PG; the exceptions are short and specific.

# Storage policy

**New durable state goes in Postgres by default.** Files are reserved for
specific cases listed below.

## Why this is a policy and not a preference

Across rounds 1-14 of the file→PG migration we've moved \~30 distinct surfaces
out of files / in-memory `Map`s into PG. The same drift pattern keeps
recurring:

1. Someone "temporarily" stores state in a JSON file or a module-local Map.
2. It works fine on a single-process desktop.
3. A second consumer reads it (settings UI vs. runtime, mobile vs. desktop,
   restart vs. live process) and now there's drift between two sources of
   the same data.
4. A later session has to migrate it under load, often after a real bug.

The migrations are mechanical and the cleanup is consistent. Better to land
new state in PG from day one.

## Two axes: runtime store-of-record vs sync authority

Harness state has **two orthogonal questions**, and the word "canonical" has been
used for both — which is the root of a long-running confusion. This policy retires
the bare word; always name the axis:

| Axis                   | Term                        | Question                                                             | Values                                                                                                                |
| ---------------------- | --------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Local store**        | **runtime store-of-record** | What does the operator *on this machine* read/write at runtime?      | **PG** (decided — below)                                                                                              |
| **Cross-machine sync** | **sync authority**          | What resolves merges & propagates a *shared* table between machines? | `none` (local-only) · `git` (committed `.papercusp/state/` files, GitHub-merged) · `peer-log` (Hyperbee/Model-B, LWW) |

**Decision (`harness-state-storage-unification-2026-06-01`, D-002): the runtime
store-of-record is PG for every harness table.** Cross-machine sharing is a
projection layer on top of PG — git-export for human-document tables, peer-log for
live machine-row tables. Per-harness PG schemas are retired in favor of slug-keyed
consolidated tables; config/settings are workspace-owned (keyed by
`(workspace, harness, role)`).

**Do not write "X is canonical."** Write "X is the **runtime store-of-record**"
(store axis) or "X is the **sync authority**" (sync axis). When an older doc says
"canonical," resolve which axis it meant first:

* **dogfood §7 / `papercusp-dogfood-*` D-001/D-020** said "git-canonical" to mean
  **git vs Hyperbee** — a *sync authority* choice for document-shaped shared state.
  That decision stands (git is the sync authority for documents); it was never a
  claim about git vs Postgres.
* **un-hardcode / harnesses-across-workspaces** said "canonical" to mean
  **PG vs `.papercusp/state/` files** — a *runtime store-of-record* choice. Under the
  decision above, that's PG, uniformly.

## Default: Postgres

For per-workspace single-row-per-key state, the helper is
`packages/operator-core/lib/operator-state-pg.ts`:

```ts
import { readOperatorState, writeOperatorState } from '@papercusp/operator-core/lib/operator-state-pg';

const cur = await readOperatorState<MyShape>('my_table');
await writeOperatorState('my_table', { /* … */ });
```

Steps to add a new piece of state:

1. Write a SQL migration at `libs/papercusp/libs/db/sql/<NNN>-<slug>.sql` —
   typical shape is `(workspace_id TEXT PK, payload JSONB, updated_at BIGINT)`.
2. Add the table name to the `StateTable` union in `operator-state-pg.ts`.
3. Use `readOperatorState` / `writeOperatorState` / `updateOperatorState` from
   your module.
4. If the data is sensitive (API keys, bearers, signing fingerprints), add
   the table to `ENCRYPTED_TABLES` in `packages/operator-core/lib/db-encryption.ts`.
   Migration `027-pgcrypto-credentials.sql` is the cipher pattern to copy — but it
   is **archived** (squashed into `000-baseline`, now living under
   `libs/papercusp/libs/db/sql/archive/`), so read it for reference and do **not**
   edit it. Enabling encryption on a new table needs a fresh forward migration that
   adds a `payload_ct BYTEA` column. The symmetric key is auto-bootstrapped on first
   use (32 random bytes, base64, mode `0600`) at `~/.papercusp/db-encryption-key`,
   overridable via `PAPERCUSP_DB_ENCRYPTION_KEY` — losing it makes the encrypted
   rows unrecoverable. See the runbook in
   `/internal/docs/system/credentials-encryption` for the full key-bootstrap and
   recovery behavior.

For compound-key tables (per-harness, per-feature, append-only audit logs),
write a focused module that runs SQL directly via `getOrgPg()`. See
`packages/operator-core/lib/operator-notes.ts` (compound key) or
`packages/operator-core/lib/provision/audit-log.ts` (append-only) for examples.

**Read cache (opt-in, hot read-mostly tables).** `readOperatorState` has a
small per-`(table, workspace)` TTL cache, gated by an allowlist
(`CACHEABLE_STATE_TABLES` in `operator-state-pg.ts` — currently just
`harness_registry`, which is read on hot paths but written rarely). Default TTL
is 2s; set `PAPERCUSP_OPSTATE_CACHE_MS=0` to disable it entirely (kill-switch).
Same-process writes self-invalidate, so write-then-read in one process is never
stale; cross-process staleness is bounded by the TTL. Encrypted tables are
deliberately **never** cached (no in-process plaintext caching of secrets). If
you add a hot read-mostly table and want this, add it to the allowlist — but
only if a couple seconds of cross-process staleness is acceptable for it.

## Schema is migrations-only — NO runtime DDL

The `harness_shared` (+ `papercup_shared`) schema is defined **entirely by SQL
migrations** — a single squashed `libs/papercusp/libs/db/sql/000-baseline.sql`
plus incrementals from `107` onward. There is **one source of truth**, and it is
the migration set.

**Do NOT create or alter tables at runtime.** The old `ensure-schema.ts` pattern —
a module lazily running `CREATE TABLE IF NOT EXISTS` on first use — is **removed**
(plan `self-contained-migration-baseline-2026-06-02`). It existed because the schema
used to be split between migrations and scattered runtime DDL, which meant
`empty Postgres → apply migrations → head` did **not** produce a working schema and
the integration-test tier couldn't stand the schema up without booting the whole app.
That is fixed: migrations alone now build the complete schema.

So, to change the schema:

1. Write a **new migration** `libs/papercusp/libs/db/sql/<NNN>-<slug>.sql` (next free
   `NNN` ≥ 107). Make it idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT
   EXISTS`, `CREATE INDEX IF NOT EXISTS`, `DROP POLICY IF EXISTS` + `CREATE POLICY`).
2. **Never** add an `ensureXxx()` / inline `CREATE TABLE` in operator runtime code.
   "Add a migration", not "add an ensure fn".
3. After migrating, refresh the Drizzle types: `node libs/papercusp/libs/db/scripts/pull-schema.mjs`.
4. The `000-baseline.sql` is **frozen** — don't hand-edit it; it's a generated dump.
   New schema is always a forward migration on top of it.

The boot path creates framework roles + the extensions **before** migrations
(`embedded-postgres-server/src/index.js`). `pgcrypto` and `pg_trgm` are trusted and
always created, so a migration may assume those exist. `vector` is **best-effort**:
it needs the compiled `.so` and is tolerated-if-missing (boot logs a `RAISE NOTICE`
and embedding features degrade to an in-memory fallback). A migration must **not**
hard-require `vector` — a `vector(N)` column on a server without the extension will
fail.

**Verification:** the migration set is gated by
`apps/operator/test/fresh-migrate.integration.test.ts` (the strict success gate:
empty → head applies with zero skips, builds the full schema, is idempotent) and the
`packages/operator-core/lib/db-tools/verify-baseline.ts` tool. Both must stay green. A new
migration that breaks `empty → head` fails CI loudly — there is no skip-tolerance.

**Fleet-member gotchas when adding a migration (EI-6955):**

* **`libs/papercusp` is a git submodule** — your new `.sql` file and the regenerated
  `generated.ts` live *inside* it, so `git status`/`git log` from the superproject show
  **nothing** for them (only a submodule-pointer bump). Verify they actually committed by
  `cd libs/papercusp && git status` / `git log`, not from the repo root.
* **`db:check_drift`'s `sql_dir` is the RELEASE checkout's sql directory**
  (`papercup-release/libs/papercusp/libs/db/sql`), not the staging tree you're editing — a
  migration you just added in staging does **not** show up as `missing` in `db:check_drift`,
  it simply isn't scanned at all until the file reaches release. Don't read a clean
  `db:check_drift` as confirmation your new migration doesn't need applying yet.
* **`db:migrate` is tree-agnostic** — it takes an explicit absolute `file` path and runs
  `psql -f <file>` against the live admin DB, so point it at your STAGING tree's new file
  directly. On this dev box the real apply is normally WITHHELD (`PAPERCUSP_ALLOW_DB_MIGRATE`
  is a host-level opt-in, not agent-settable) — but calling `db:migrate { file, confirm:true }`
  even so hands you back the *exact* `psql … BEGIN; \i <file>; INSERT INTO
  harness_shared.schema_migrations (filename, sha256) VALUES (...); COMMIT;` command to run by
  hand, matching the escape hatch above — call it first instead of hand-deriving the
  psql+schema\_migrations dance from memory.
* After applying to the dev DB by hand (or via the fallback command), run
  `node libs/papercusp/libs/db/scripts/pull-schema.mjs` to regenerate `generated.ts` — it reads
  the *live* DB, so it must already have your migration applied (chicken-and-egg: apply first,
  then regenerate).
* **Indexing a HOT high-churn table (`coord_event_log`, `work_items`, …) live under an active
  fleet: `CREATE`/`DROP INDEX CONCURRENTLY` can time out repeatedly** (EI-9151) — the fleet's
  continuous read/write traffic never leaves a clean window for CONCURRENTLY's
  wait-for-old-snapshots phase, even with `lock_timeout` raised to 120-240s (`PGOPTIONS='-c
  lock_timeout=240s' psql ...`). Each failed attempt leaves an **INVALID** index of the same
  name behind, and a subsequent `IF NOT EXISTS` attempt then silently no-ops on the name
  collision (fast, no error) *without* actually building it — always verify `SELECT indisvalid
  FROM pg_index JOIN pg_class ON pg_class.oid = pg_index.indexrelid WHERE relname = '<idx>'`
  before trusting a fast/clean return. If CONCURRENTLY keeps timing out, drop the invalid index
  (plain `DROP INDEX`, not `CONCURRENTLY` — still needs the lock, but is a single fast
  acquisition rather than CONCURRENTLY's multi-phase wait) and fall back to a **plain, blocking
  `CREATE INDEX`**: for a table in the tens-to-hundreds-of-k-rows range the actual build is
  sub-second once the lock is granted (the bottleneck is queueing for the lock, not the build
  itself), so a brief blocking build is the safer bet over CONCURRENTLY refusing to ever land.

## Acceptable file uses

Files are correct for these specific cases:

| Use                                                                     | Example                                                                      |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Bootstrap state needed before a PG connection exists                    | `~/.papercusp-workspaces/registry.json`, `~/.papercusp/db-encryption-key`    |
| Postgres's own data                                                     | `pglite-data/`, `embedded-pg-data/`                                          |
| Code, scripts, templates                                                | `provision/runner.ts:RUNTIME_LIB_SH`, plugin tarballs                        |
| Harness contract artifacts read by tools running inside the harness     | `<harness>/.papercusp/config.json`, `SPEC.md`, `supervisor-notes.md`         |
| Append-only logs at high volume where SQL log tables would dwarf state  | `.papercusp/action-runs/<runId>.log` (run metadata in PG, log bytes on disk) |
| Per-process resource leases (in-process / O\_EXCL)                      | `deployment/display-allocator.ts` per-agent DISPLAY leases                   |
| Plugin-sandbox storage (the plugin host exposes a virtual FS by design) | `plugin-host.ts` `read`/`write` API to plugins                               |
| Per-device UX preferences that should NOT sync across devices           | voice config (per audio stack), one-time UI hint dismissals                  |

## NOT acceptable

These patterns recur and have all been migrated; please don't reintroduce:

* **Plain JSON state files for app-level operator data.** Use PG.
* **Module-scoped `Map<>`s holding TTL'd auth/session state.** OAuth nonces
  (round 12), mobile pair tokens (round 13), rate-limit state (round 13)
  all looked fine until a restart killed an in-flight flow or a bypass
  emerged. Use PG.
* **localStorage that should sync across devices.** If "settings should
  follow the user, not the device", it's not localStorage data; it's
  `operator_user_profile` data with a small `/api/profile` REST surface +
  localStorage as a per-device cache (round 14 pattern).
* **File-primary, PG-mirror.** Round 11 caught two of these
  (`dismissed.json`, `prompt-user.md`); they always drift. Either go full
  PG or document a real reason the file is authoritative.
* **Duplicating bearer tokens or other secrets to disk** when they're
  already in PG. The duplicate is just an extra plaintext surface to leak
  (round 9 caught operator + oracle config files duplicating
  `token_index` rows).

## Dual-purpose state: PG-canonical, file materialized just-in-time

Some surfaces are **both** operator state (read by the UI) and harness
contract (read by tools inside the harness process). Feature notes are
the example: the orchestrator's role prompt directs LLMs to read
`<projectDir>/.papercusp/notes/<featureId>.md` so the autonomous worker
sees user guidance; the operator UI also reads/writes the same notes for
human-in-the-loop steering.

The pattern here is **PG-canonical with a just-in-time file projection** —
**not** a write-time PG+file mirror:

* Writes go to **PG only**. `appendOperatorNote()` upserts the merged content
  via `writeNotesContent` (a drizzle upsert) and explicitly does **not**
  `writeFile`. PG is the **runtime store-of-record**; cross-machine sync via the
  **sync authority** + encryption-at-rest are layers on top (see the two-axis
  section above).
* The on-disk `.papercusp/notes/<featureId>.md` is produced by a separate
  PG → FS materialization (`materializeNoteToFile` /
  orchestrator `feature-notes.materializeFeatureNote`) invoked right before each
  worker/validator/debugger run. The file is a transient projection of PG, valid
  for the lifetime of one invocation — best-effort (a write failure just means the
  worker runs without the file, which its "if present" prompt already handles).
* Reads still merge PG + file content, deduping by a stable key (e.g.
  `(author, ts)` for note blocks): a worker may append blocks directly to the
  file via tool use, and `readOperatorNotes` pulls those in too.

Round 6 (file→PG) missed this duality and removed the file entirely,
silently breaking the autonomous worker's view of user notes for \~weeks.
Round 17 restored the file — first as a write-time mirror, later
(2026-05-09) refactored to the just-in-time materialization above to
eliminate the PG↔FS two-way-sync hazard. The architectural rule is **no
PG↔FS mirror**: persisted state lives in PG, and if a downstream tool needs
a file, wrap the PG read (materialize on demand) rather than mirroring on
write. Verify by grepping the orchestrator role-prompt for the file path
before refactoring.

## When you genuinely need a file

If your state truly fits one of the acceptable buckets, document *why* in
the module's header doc. Lessons learned: the round-11 audit found a
"file fallback for offline/pre-migration safety" that nobody had updated
since the PG side was finished — the comment was right when written and
wrong by the time we found it. If you write a "we use a file because X"
comment, link to the issue or spec section that justifies it so the next
auditor can confirm the X still applies.

## Migration history

| Round | Surfaces                                                                                                                                                                                                                               |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1-5   | Operator state JSON files (budget, last-scan, idle-snapshot, voice-prefs, voice-creds, agent-config, scanner-session, first-run, user-profile, prompt-user, preferences, publish-credentials, oracle prompt+memory, marketplace token) |
| 6     | Harness registry, feature notes, provision state + audit log + trust store                                                                                                                                                             |
| 7     | pgcrypto encryption-at-rest for credentials-class tables                                                                                                                                                                               |
| 8     | Operator-config bifurcation; system principals; orphan cleanup                                                                                                                                                                         |
| 11    | `paused.flag`; `dismissed.json` flipped from file-primary to PG-primary                                                                                                                                                                |
| 12    | OAuth nonces (Map → PG)                                                                                                                                                                                                                |
| 13    | Mobile pair tokens; per-workspace rate limit (Maps → PG)                                                                                                                                                                               |
| 14    | Browser localStorage for cross-device preferences (auto\_scan, toast\_last\_seen\_ms)                                                                                                                                                  |

If you're adding new state and it's not obviously in this list, default to PG.
