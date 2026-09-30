# @papercupai/jira-sync

**Bidirectional background sync** between a Papercusp harness's `harness_features` and `harness_issues` queues and a Jira Cloud project.

> **v0.2.0 is a complete redesign.** v0.1 had dashboard "Create issue" buttons and one-shot lifecycle creates; that mental model was wrong. The new shape: every feature in the harness IS a Jira issue, every Jira issue tagged for the harness IS a feature/bug row. Continuous, automatic, with no buttons to press.

## How it works

| Trigger | When | Latency |
|---|---|---|
| `cron: */30s` | every 30 seconds | safety-net catch-all |
| `webhook` (Jira → us) | Jira fires `issue.*` webhook | sub-second |
| lifecycle hook `onPostValidator` | a worker/validator finishes a feature | immediate |
| lifecycle hook `beforeMissionStart` / `afterDone` | mission boundaries | immediate |

Each sync tick:

1. Reads features/issues from the harness's Postgres schema that changed since the last `local_cursor`.
2. Reads Jira issues tagged `papercusp-<harness-slug>` updated since the last `remote_cursor`.
3. Diffs by content hash. If hashes match the link table, no-op.
4. For divergent fields: **the harness always wins** for canonical fields (title, description, status, labels we own). Remote-only metadata (assignee, priority, sprint, fixVersions) is mirrored read-only into `links.remote_meta` JSONB.
5. Pushes patches to Jira (`PUT /issue/<key>` for fields, `POST /issue/<key>/transitions` for status).
6. Pulls new Jira issues (those with the slug label but no link row) into `harness_features` (default) or `harness_issues` (Jira issuetype=Bug or `papercusp-bug` label).
7. Logs every conflict to `plugin_jira_sync.conflicts` for the admin panel.

## Mapping

| Harness | Jira |
|---|---|
| `harness_features.feature_id` | issue with labels `papercusp-<slug>` + `papercusp-feat-<feature_id>` |
| `harness_features.title` | summary |
| `harness_features.summary` | description (ADF, paragraph-per-blank-line) |
| `harness_features.status` (`todo`/`in_progress`/`passed`/`failing`/`blocked`/`done`) | workflow status, mapped via `config.statusMap` (default → To Do / In Progress / Done / In Review / Blocked / Done) |
| `harness_features.tags` | labels (union with plugin-owned ones) |
| `harness_issues.issue_id` (`I-NNNN`) | issue with labels `papercusp-<slug>` + `papercusp-issue-<issue_id>` + `papercusp-bug`, issuetype=`Bug` |

## Configuration

```sh
export JIRA_BASE_URL=https://yourorg.atlassian.net
export JIRA_EMAIL=you@example.com
export JIRA_API_TOKEN=...                 # https://id.atlassian.com/manage-profile/security/api-tokens
export JIRA_WEBHOOK_SECRET=...             # optional; required if you wire Jira webhooks
```

`<state>/plugins/jira-sync/config.json`:

```json
{
  "defaultProjectKey": "ENG",
  "defaultIssueType": "Task",
  "bugIssueType": "Bug",
  "labelPrefix": "papercusp",
  "statusMap": {
    "todo": "To Do",
    "in_progress": "In Progress",
    "passed": "Done",
    "failing": "In Review",
    "blocked": "Blocked",
    "done": "Done"
  }
}
```

## Wiring Jira webhooks (recommended)

Jira → Project settings → Webhooks → Create webhook:

- URL: `https://<your-papercusp-host>/api/plugins/_papercupai_jira-sync/webhook?slug=<harness-slug>&secret=$JIRA_WEBHOOK_SECRET`
- Events: `Issue created`, `Issue updated`, `Issue deleted`, `Comment created`/`updated`/`deleted`
- JQL: `labels = "papercusp-<slug>"`

The webhook just bumps `cursors.remote_cursor` backwards by 5 minutes; the next 30s tick picks up the change. This avoids holding Jira's HTTP connection open while we do real work.

## Conflict policy

**Harness wins always** for the canonical fields above. Conflicts where both sides changed are logged but not blocked. Remote-only metadata (assignee, priority, sprint) is captured in `links.remote_meta` but never written back from the harness — that's human-only territory.

If a feature is deleted in Jira (404 on next fetch), the link is *tombstoned* (`tombstoned=true`) but the harness row is preserved. The plugin won't auto-recreate a tombstoned link on the next tick; reset by calling the `backfill-local-to-remote` action.

## Schema

All plugin state lives in Postgres schema `plugin_jira_sync`:

- `links` — `(harness_slug, entity_kind, entity_id) → (external_id, hashes, remote_meta, tombstoned)`
- `cursors` — `(harness_slug) → (local_cursor, remote_cursor, last_full_sync)`
- `conflicts` — append-only audit of resolutions

DDL is applied automatically on first load via `schema.sql`. Idempotent.

## Surfaces

The only UI surface is `plugin-detail`. Inside that page:

- Connection status: configured? webhook reachable? last sync timestamp.
- Cursors: local/remote watermarks.
- Drift: count of conflicts in last 24h, recent conflict log.
- Backfill controls: `Force full sync`, `Push every feature/issue`, `Import every tagged Jira issue`.

There are no `harness-toolbar`, `feature-row`, or `mission-done` surfaces — the user never creates an issue manually.

## API endpoints

Mounted at `/api/plugins/_papercupai_jira-sync/*`:

| Method | Path | Description |
|---|---|---|
| GET | `/ping` | health + configured? |
| GET | `/status?slug=<s>` | linkCount, cursor, recentConflicts |
| GET | `/links?slug=<s>` | full link rows |
| GET | `/conflicts?slug=<s>` | recent conflict log (last 50) |
| POST | `/sync?slug=<s>` | trigger a sync now |
| POST | `/webhook?slug=<s>&secret=...` | Jira webhook receiver |

## License

MIT
