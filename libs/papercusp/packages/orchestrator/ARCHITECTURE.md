# Orchestrator architecture (post-PG migration)

This document captures the orchestrator's storage architecture after the
8-phase migration from filesystem-canonical state to Postgres-canonical
state. Anything you see in `<harness>/.papercusp/` that isn't in this
document's "stays on disk" list is either dormant FS-fallback (waiting
for `ctx.pg` to be wired by the caller) or a stale leftover that
`scripts/audit-harness-fs.mjs` will flag.

## State lives in Postgres

When the caller (operator, CLI bootstrap) passes a `pg` client + a
`workspaceId` on `InvokeContext`, every piece of mission state goes
through Postgres tables in `harness_shared.*`:

| File the orchestrator used to write | PG home |
|---|---|
| `<stateDir>/features.json` | `harness_<slug>.harness_features` (Phase 1) |
| `<stateDir>/lanes.json` | `harness_shared.harness_mission_state.lanes` (JSONB) |
| `<stateDir>/escalation.md` | `harness_shared.harness_mission_state.escalation_md` |
| `<stateDir>/.cost-warn-fired` | `harness_shared.harness_mission_state.cost_warn_fired` |
| `<stateDir>/ready-for-prod.flag` | `harness_shared.harness_mission_state.ready_for_prod_at` |
| `<stateDir>/checkpoint-*.md` | `harness_shared.harness_checkpoints` (status='pending') |
| `<stateDir>/checkpoint-*.md.granted` | `harness_shared.harness_checkpoints.status='granted'` |
| `<stateDir>/.checkpoint-*.fired` | implicit "any row exists" predicate |
| `<stateDir>/logs/<runId>.{jsonl,out,err}` | `harness_shared.harness_run_output` (Phase 4) |
| `<stateDir>/logs/<runId>.prompt.md` | `harness_shared.harness_run_output.prompt_body` |
| `<stateDir>/logs/nexth-*.json` | `harness_shared.harness_dispatches` |
| `<stateDir>/snapshots/<ts>-iter-NNN/` | `harness_shared.harness_snapshots` (Phase 7) |

All tables include `workspace_id` for RLS scoping. DDL for each is
exported as a constant from the corresponding `*-pg.ts` module.

## What stays on disk

Three categories of legitimate filesystem use survive the migration:

### 1. Read-only inputs the orchestrator consumes

These are user-authored or operator-authored. The orchestrator reads
them every iteration; it never writes them.

- `<stateDir>/config.json` — harness config
- `<harnessDir>/prompts/<phase>/<role>.md` — role prompt files
- `<harnessDir>/identity/<role>.md` — cross-mission persona

### 2. Operational streams (live tail, post-mortem)

Subprocess output streams that other tools consume in real-time:

- `<stateDir>/logs/run.log` — the orchestrator's own append-only log
- `<stateDir>/logs/event-<ts>.log` — per-event timestamped log
- `<stateDir>/logs/<runId>.{jsonl,out,err}` — claude/omp subprocess output

These remain on disk **during the run** for `tail -f` debugging and the
operator's live LogView SSE stream. **At subprocess exit**, when
`ctx.pg` is set, their contents are ingested into `harness_run_output`
as a single canonical row. Files can be retained or pruned per
`config.logRetention` without losing post-hoc replayability.

### 3. Ephemeral subprocess input materializations

When an external program insists on a file path (omp's `@file` argv,
omp's `mcp.json` config), the orchestrator materializes the body to a
short-lived directory under `ramTmpRoot()` and `rm`s it after the
subprocess closes. The path looks like `/dev/shm/papercusp-XXXXXX/` on
Linux, `os.tmpdir()/papercusp-XXXXXX/` elsewhere — page-cache-backed,
verified to never hit physical disk for our workload (see
`disk-proof-test.mjs`).

The harness directory itself never contains these files.

## How the dispatch works

Every PG-aware operation is gated on `ctx.pg && ctx.workspaceId`:

```ts
// state.ts pattern (used everywhere)
if (ctx.pg && ctx.workspaceId) {
  // PG path: query harness_features etc.
} else {
  // FS fallback: read features.json
}
```

The FS fallback is intentional — the orchestrator runs in two modes:

1. **With operator** — operator passes `ctx.pg` + `ctx.workspaceId` →
   PG-canonical
2. **Standalone CLI** — no operator running, no PG client → FS-canonical
   (matches the bash run.sh behavior the orchestrator originally ported)

A future arc will add CLI-mode PG bootstrap so standalone mode can also
be PG-canonical; until then, the dispatch keeps the orchestrator usable
in both worlds.

## Notification architecture (Phase 3)

Checkpoints emit `pg_notify('checkpoint:fired', json)` on insert and
`pg_notify('checkpoint:granted', json)` on grant. The operator's UI
subscribes to these via `LISTEN` for real-time updates without
polling. Notifies are best-effort — row state is always canonical, and
the orchestrator's existing pre-loop pass picks up any missed grants
on the next iteration.

## Hook context contract (Phase 6)

Hooks receive auto-injected env vars so they can query operator/PG
without reading harness FS state:

- `HARNESS_SLUG` — current harness (defaults to `basename(projectDir)`)
- `WORKSPACE_ID` — active workspace
- `OPERATOR_BASE` — operator API base URL (default `http://localhost:3055`)

Recommended pattern:

```bash
features=$(curl -fsS "$OPERATOR_BASE/api/harness/$HARNESS_SLUG/features")
status=$(echo "$features" | jq -r '.[] | select(.id == "'"$FEATURE_ID"'") | .status')
```

## Auditing

`scripts/audit-harness-fs.mjs <path/to/.harness>` walks a harness's
state directory and reports any of the now-stale state files listed at
the top of this document. Exit code:

- `0` — clean (no stale state files found)
- `1` — stale state files present
- `2` — argument missing or directory unreadable

Run in CI to catch regressions where a code change accidentally writes
a state file that should be in PG.

## Module map

| Module | Purpose |
|---|---|
| `tmpfs.ts` | `ramTmpRoot()`, `withTmpDir()` — cross-platform RAM-resident scratch space |
| `workspace.ts` | `activeWorkspaceId()` — resolves workspace from env or registry |
| `state.ts` | features dispatcher (FS ↔ `harness_features`) |
| `state-pg.ts` | features PG queries |
| `mission-state-pg.ts` | escalation / cost_warn / ready_for_prod / lanes JSONB |
| `dispatches-pg.ts` | inter-harness dispatch log |
| `checkpoints.ts` | checkpoint gate dispatcher |
| `checkpoints-pg.ts` | checkpoint INSERT/UPDATE + pg_notify |
| `run-output-pg.ts` | subprocess output ingestion at exit |
| `snapshots-pg.ts` | per-iteration snapshot rows + retention prune |
| `snapshot-state.ts` | snapshot dispatcher (FS ↔ PG) |

DDL for every PG table is exported from its module as a `*_DDL` const,
ready for the operator's schema bootstrap to apply.
