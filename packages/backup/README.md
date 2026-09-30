# Backup — per-workspace kopia repo

End-to-end backup system wired into the operator: deduplicated snapshots,
event triggers, restore-to-clone with promote/rollback safety net, agent
MCP tools, and dashboard surfaces in `/settings/backups` (Advanced) and
`/dev` → Backups tab.

## Layout

```
apps/operator/lib/backup/
├── types.ts            — public types + retention presets
├── password.ts         — HKDF from ~/.papercusp/db-encryption-key
├── password.test.ts    — derivation determinism + isolation
├── workspace-backup.ts — WorkspaceBackup class (everything)
├── singleton.ts        — per-workspaceId cache
├── server.ts           — kopia server lifecycle (iframe target)
├── scheduler.ts        — 1-min tick + triggerSnapshotEvent + kopia detect
├── hook.ts             — pre-snapshot pg_dump hook
├── index.ts            — public exports
└── README.md
```

## Repo layout per workspace

```
~/.papercusp-workspaces/<id>/backups/
├── kopia-repo/           — content-addressed store
├── repository.config     — kopia client config
├── cache/                — local cache
└── logs/                 — kopia client logs
~/.papercusp-workspaces/<id>/db-dumps/
├── pg-embedded.sql.gz    — transactional dump of the resolved harness-admin database
└── hook.log              — hook results
~/.papercusp-workspaces/<id>/.restored/<snapshotId>/<slug>/
~/.papercusp-workspaces/<id>/.broken-<ts>-<name>/    — pre-promote live
~/.papercusp-workspaces/<id>/.rolled-back-<ts>-<name>/ — post-rollback
~/.papercusp-workspaces/.archive/<id>-<ts>/          — pre-workspace-delete archive
```

## WorkspaceBackup API

```ts
class WorkspaceBackup {
  ensureRepo(): Promise<void>
  snapshot(reason, context?): Promise<SnapshotResult>
  list(limit?): Promise<SnapshotInfo[]>
  stats(): Promise<RepoStats>
  kopiaContentStats(): Promise<{ totalSize, objectCount } | null>
  verify(): Promise<VerifyResult>
  maintenance(level: 'quick' | 'full'): Promise<void>
  getSettings(): Promise<BackupSettings>
  updateSettings(partial): Promise<BackupSettings>
  restoreToClone({ kopiaSnapshotId, source?, target? }): Promise<{ targetPath }>
  promoteRestore({ restoredPath, liveTarget? }): Promise<{ broken, live }>
  rollbackPromote({ brokenPath }): Promise<{ liveBefore, liveAfter }>
  recentFailures(limit?): Promise<SnapshotInfo[]>
}
```

## API endpoints

```
GET    /api/backups                      — settings + stats
PUT    /api/backups                      — update settings
GET    /api/backups/snapshots            — list (PG-backed)
POST   /api/backups/snapshots            — manual snapshot
GET    /api/backups/events               — backup_events stream
GET    /api/backups/failures             — last N failures
GET    /api/backups/healthcheck          — UI banner state + kopia detect
POST   /api/backups/verify
POST   /api/backups/maintenance          — { level: 'quick' | 'full' }
POST   /api/backups/restore              — restore-to-clone
POST   /api/backups/promote              — atomic rename clone → live
POST   /api/backups/rollback             — undo a promote
GET    /api/backups/broken-list          — .broken-*/ dirs for rollback UI
GET    /api/backups/server               — start/return kopia server URL for iframe
DELETE /api/backups/server               — stop kopia server
```

## First-party MCP tools

```
backup:snapshot_create    — pre-destructive op snapshot (all roles)
backup:snapshot_list      — recent snapshots (all roles)
backup:diff               — file-level diff between two snapshots (all roles)
backup:restore            — restore-to-clone (operator/debugger/reviewer)
backup:restore_clone_cleanup — preview/remove aged restore clones (operator/debugger)
backup:promote            — promote clone → live (operator/debugger)
backup:rollback           — undo a promote (operator/debugger)
backup:settings_get       — settings + stats (all roles)
backup:settings_set       — patch settings (operator/debugger)
```

Restore clones are retained for 30 days by the daily `backupRecoveryDebrisCleanup`
workflow. The cleanup tool is preview-first (`dryRun: true`); an explicit
`dryRun: false` pass removes only direct `.restored/<snapshot>/<slug>` directories
whose restore-event liveness and promotion-sidecar reference proofs both succeed.
Unreadable or malformed proof sources are retained.

## Event triggers wired

`triggerSnapshotEvent(workspaceId, reason, context)` — call from any
destructive code path. Currently wired at:

- `app/api/plugins/uninstall` — before removing a plugin
- `app/api/backups/promote` — auto-snapshot before promoting
- `lib/branch-actions.ts` runAction() — before every harness run
- `lib/agent-tools/backup/promote.ts` — agent-driven promotion

Per-workspace `event_triggers` setting gates which reasons fire.

## Pre-snapshot DB hook

`hook.ts` runs once per `snapshot()` call. Currently dumps the resolved
harness-admin database's `harness_shared` schema into
`<workspaceRoot>/db-dumps/pg-embedded.sql.gz`, excluding DATA for multi-GB
derived telemetry/audit streams while keeping their schema. Release-critical
state (harness registry, plans, work items, backup metadata, settings, etc.) is
included with data; plugin-private schemas are outside this event-driven
hot-state backup. Failures log to `hook.log` and never abort the snapshot.

## Threat model — what this protects against

- **Agent destroys files in the workspace** → restore from any
  snapshot, default to clone-not-overwrite.
- **Bad merge / bad migration** → restore the pre-op snapshot, diff
  against live, promote or cherry-pick.
- **User deletes a workspace by mistake** → kopia repo is archived to
  `~/.papercusp-workspaces/.archive/<id>-<ts>/` before the dir is
  removed, so the snapshots survive.
- **Hot DB state (operator PG)** → transactional pg_dump on
  every snapshot.

## Threat model — what this does NOT protect against

- **Loss of `~/.papercusp/db-encryption-key`** — without that the kopia
  repo can't be decrypted. Same domain as PG encryption today.
- **Hardware failure on the drive containing the workspace** — local
  backups only; offsite (S3/B2/rclone) UI exists in settings but the
  implementation is deferred.
- **Bad-faith local attacker** — same UID as the operator can read the
  unencrypted live data; backups don't change that surface.

## Operational notes

- Scheduler is in-process (boot-hooked from `instrumentation.ts`); no
  systemd dependency, works on Linux + macOS + future Windows.
- Cadence is per-workspace (`workspace_backup_settings.cadence_minutes`).
- Repo password is derived (HKDF), not stored.
- Kopia binary must be on `$PATH` or `KOPIA_BIN` env var. Missing-binary
  state is surfaced via `/api/backups/healthcheck.kopia` and the
  /dev + /settings banners.
- Maintenance is manual (settings button or `kopia:settings_set` not
  implemented for maintenance — use POST /api/backups/maintenance).

## Migration

`apps/operator/lib/commands/migrations/013_workspace_backups.sql`
creates `workspace_backup_settings`, `backup_snapshots`, `backup_events`
in `harness_shared`. Idempotent CREATE IF NOT EXISTS.

## Tests

`password.test.ts` — 3 tests covering format, determinism, per-workspace
isolation. Backend integration testing requires a live kopia binary +
PG; run manually via `kopia snapshot create` against a scratch workspace.
