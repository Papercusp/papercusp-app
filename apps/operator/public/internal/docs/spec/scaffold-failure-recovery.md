# Scaffold failure recovery
URL: /internal/docs/spec/scaffold-failure-recovery

Runbook for partial scaffold failures (timeout, init failed, register failed). How to clean up and retry.

> **Webapp retired (2026-05-14).** Any `localhost:3055` or `localhost:3070` URL on this page is only reachable while the **Tauri dev shell** is running. Start it with `cd papercusp-desktop && npm run dev`.

`scaffold_harness` is the most complex executor verb (`doScaffoldHarness` in `packages/operator-core/lib/execute-action.ts`) — it shells out to `papercusp init`, writes `.papercusp/config.json`, scaffolds a PG schema, and registers the token. Any of these can fail mid-flight.

> **Token store changed.** The per-harness `config_token` table was retired (migration 121). `harness_shared.token_index` is now the single source of truth for bearer→slug auth; the recovery SQL below reflects that. The PG schema is provisioned by the inline `scaffoldHarnessSchema()` (`packages/operator-core/lib/scaffold-harness-schema.ts`) as views over `harness_shared.*_consolidated`, not by a bash script.

## Pre-flight validation failures (400, before any side effect)

Before `doScaffoldHarness` shells out or touches the FS/DB, it validates the request. These return **400** (not 500), so no cleanup is ever needed — but because they are *not* `internal`/5xx, they **are cached** against `actionId`:

* `validation_error` — bad `projectSlug` (must match `/^[a-z0-9][a-z0-9-]{1,63}$/`), or missing `template`/`spec`.
* `validation_error` — self-spawn (`callerSlug === projectSlug`), a pre-existing cycle in the parent chain, or depth `> MAX_SPAWN_DEPTH` (default 8, `PAPERCUSP_MAX_SPAWN_DEPTH`), from `detectCycleOrTooDeep`.
* `template_not_spawnable` (mapped to **400**) — the template isn't in the spawnable catalog.

Because these are validated *before* any FS or DB write, retrying the same `actionId` just replays the cached failure — fix the input and retry with a **fresh `actionId`**.

## Failure modes

### 1. `papercusp init` exited non-zero

* **Symptom**: `executeAction` returns `500 internal { detail: "papercusp init failed: ..." }`.
* **State**: any partial directory under `PAPERCUSP_PROJECTS_ROOT/<slug>` is rolled back automatically. No registry row, no schema.
* **Recovery**: re-run with same `actionId` (idempotency cache won't have it, since `internal` errors aren't cached). Or pick a different slug.

### 2. 5-minute timeout

* **Symptom**: `executeAction` returns `500 internal { detail: "papercusp init timeout: ...", timeout: true }`.
* **State**: init child killed via timeout. The `execFile` shell-out sets only `timeout: 5 * 60 * 1000` with no `killSignal`, so the child receives a single SIGTERM (Node's default) — there is no follow-up SIGKILL escalation. Partial directory rolled back. Same as case 1.
* **Recovery**: same as case 1. If the install is genuinely too slow (heavy `npm install`, `git clone`), re-publish the template with smaller dependencies, or move heavy work to the role's first iteration.

### 3. config.json merge failed

* **Symptom**: `internal { detail: "failed to write .papercusp/config.json: ..." }`.
* **State**: `papercusp init` succeeded, dir exists, but `.papercusp/config.json` (which carries the `harness_token`, `parent_slug`, `slug`) may be partially written. Token + schema NOT yet registered.
* **Recovery**: drop the partial state, then retry with a fresh `actionId`. The harness registry lives in PG (`harness_shared.harness_registry`, created in `000-baseline.sql`) — one row per workspace, keyed by `workspace_id`, holding a JSONB `payload` with a `projects[]` array; there is no home-directory `registry.json` to edit. The DELETE endpoint removes the harness's **entry** from that `projects[]` payload (via `mutateHarnessRegistry`) — it never deletes the `harness_registry` row itself. The default project dir is `~/.papercusp/projects/<slug>`.

  The DELETE route is **loopback-only** (`auth: 'loopback'`) — run the curl from the host the operator runs on, not a remote/admin client. It cleans up **only** the registry entry: it does **not** touch `harness_shared.token_index` rows or the per-harness `harness_<slug>` PG schema. Use the slug-collision SQL below (explicit `DELETE` + `DROP SCHEMA`) to remove those.

  ```bash
  curl -X DELETE http://localhost:3055/api/harness/projects/<slug>
  rm -rf ~/.papercusp/projects/<slug>
  ```

### 4. Schema scaffold failed

* **Symptom**: `internal { detail: "schema scaffold failed: ..." }`.
* **State**: dir exists, config.json has token and parent\_slug, but the per-harness PG schema is partial or missing.
* **Recovery**: `scaffoldHarnessSchema()` is idempotent — re-running the scaffold (e.g. via a fresh `actionId` retry, or by calling the inline provisioner) re-creates the views cleanly. To re-mirror the token afterward:
  ```bash
  TOKEN=$(jq -r .harness_token <projectPath>/.papercusp/config.json)
  PGUSER=harness_admin psql -d papercusp -c \
    "INSERT INTO harness_shared.token_index (token, kind, harness_slug, workspace_id)
       VALUES ('$TOKEN', 'harness', '<slug>', 'default') ON CONFLICT (token) DO NOTHING;"
  ```

### 5. Token-index insert failed

* **Symptom**: surfaces as a generic `internal` (the token-index INSERT is unguarded; on failure the route's outer catch returns `500 internal`).
* **State**: harness exists on disk + registry, schema exists, but the token isn't in `harness_shared.token_index` → harness can't authenticate its own outbound `executeAction` calls.
* **Recovery**: the "re-mirror the token" SQL from case 4.

## Slug collisions

If `scaffold_harness` returns `409 slug_already_in_use`:

* A `harness_shared.token_index` row exists for that slug, or the on-disk path `~/.papercusp/projects/<slug>` already exists.
* Pick a different slug, OR delete the conflicting state:
  ```bash
  curl -X DELETE http://localhost:3055/api/harness/projects/<slug>
  rm -rf <projectPath>
  PGUSER=harness_admin psql -d papercusp -c "
    DELETE FROM harness_shared.token_index WHERE harness_slug = '<slug>';
    -- schema name sanitizes hyphens→underscores (harnessSchemaName), e.g. my-harness → harness_my_harness
    DROP SCHEMA IF EXISTS harness_<slug_underscored> CASCADE;
  "
  ```

## Idempotency replay

If you retry with the **same `actionId`** and the prior call succeeded, you'll get the cached `{ ok: true, ...result, cached: true }` even if the side effect was deleted out-of-band. Use a fresh `actionId` if you actually want to re-execute.

Failures tagged `error: 'internal'` (all five scaffold failure modes above) are NOT cached, so a same-`actionId` retry re-executes the verb. Note the skip keys on `error === 'internal'`, **not** on the HTTP status: a non-`internal` error that happens to map to 500 (the default in the error→status table — e.g. another op's `pg_error`) is still cached. The pre-flight 400s above are likewise non-`internal`, so they too are cached.

## Bulk reset (for development)

```bash
PGUSER=postgres_app PGPASSWORD=postgres psql -d papercusp <<SQL
DELETE FROM harness_shared.token_index WHERE harness_slug LIKE 'smoke-%';
DELETE FROM harness_shared.projects WHERE slug LIKE 'smoke-%';
SQL
rm -rf /home/dev/.papercusp/projects/smoke-* \
       /home/dev/.papercusp-workspaces/default/.papercusp/projects/smoke-*
```

For schema drops: enumerate `\dn harness_*` in psql and drop the offending ones with `DROP SCHEMA ... CASCADE`.
