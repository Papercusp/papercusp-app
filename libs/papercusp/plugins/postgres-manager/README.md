# @papercupai/postgres-manager

Reference plugin for the `db:plugin-schema` capability. Reserves a per-plugin
Postgres schema so harness-local data has a dedicated home.

## Install

```sh
papercusp install @papercupai/postgres-manager --harness <slug>
papercusp plugin enable @papercupai/postgres-manager --harness <slug>
```

## Capabilities

- `db:plugin-schema` — single capability, three actions all narrow from it.

## Actions

| Action | Trigger | Notes |
|---|---|---|
| `migrate` | toolbar | `dryRun` param checks schema exists; otherwise creates schema + `_migrations` bookkeeping. |
| `inspect` | toolbar | Lists tables in the plugin schema. |
| `reset`   | toolbar | Drops + recreates. Requires `params.confirm=true` (destructive). |

## Config

```json
{ "schemaName": "plugin_local" }
```

Schema name is validated `[a-z][a-z0-9_]{0,63}` to keep DDL strings safe.

## Substrate-side note

The plugin uses `HARNESS_DATABASE_URL` from the substrate's process env until
the typed DB-service proxy lands (spec §10). When that arrives this plugin
should be retrofitted to receive a scoped `ctx.api.db` rather than opening
its own pool.
