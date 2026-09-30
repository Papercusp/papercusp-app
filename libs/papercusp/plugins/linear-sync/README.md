# @papercupai/linear-sync

**Bidirectional background sync** between a Papercusp harness's `harness_features` and `harness_issues` queues and a Linear team. GraphQL counterpart to [`@papercupai/jira-sync`](../jira-sync/README.md) — same architecture, same data flow, different transport.

> **v0.2.0 is a complete redesign.** v0.1's manual `create-issue` actions and dashboard buttons are gone. The model now: every harness feature IS a Linear issue, every tagged Linear issue IS a feature/bug row. Continuous, automatic.

## How it works

| Trigger | When | Latency |
|---|---|---|
| `cron: */30s` | every 30 seconds | safety-net catch-all |
| `webhook` (Linear → us) | Linear fires `Issue` webhook | sub-second |
| lifecycle hook `onPostValidator` | a worker/validator finishes a feature | immediate |
| lifecycle hook `beforeMissionStart` / `afterDone` | mission boundaries | immediate |

The sync engine is identical to jira-sync; only the API calls differ:
- `IssueCreate` mutation instead of `POST /issue`
- `IssueUpdate` instead of `PUT /issue/<key>`
- State transition is part of `IssueUpdate.stateId`, not a separate transitions endpoint
- Labels resolved per-team via `team.labels`, missing names auto-created with `IssueLabelCreate`

## Mapping

| Harness | Linear |
|---|---|
| `harness_features.feature_id` | issue with labels `papercusp-<slug>` + `papercusp-feat-<feature_id>` |
| `harness_features.title` | title |
| `harness_features.summary` | description (markdown) |
| `harness_features.status` | state (resolved by name → `state.id`), default map: To Do / In Progress / Done / In Review / Backlog / Done |
| `harness_features.tags` | labels (union with plugin-owned ones) |
| `harness_issues.issue_id` (`I-NNNN`) | issue with labels `papercusp-<slug>` + `papercusp-issue-<issue_id>` + `papercusp-bug` |

State names must exist in the team's workflow. Missing states fall through to the issue's existing state and the conflict is logged. Override via `config.statusMap`.

## Configuration

```sh
export LINEAR_API_KEY=lin_api_...        # https://linear.app/<workspace>/settings/api
export LINEAR_WEBHOOK_SECRET=...         # optional; required if you wire Linear webhooks
```

`<state>/plugins/linear-sync/config.json`:

```json
{
  "defaultTeamKey": "ENG",
  "labelPrefix": "papercusp",
  "statusMap": {
    "todo": "Todo",
    "in_progress": "In Progress",
    "passed": "Done",
    "failing": "In Review",
    "blocked": "Backlog",
    "done": "Done"
  }
}
```

Either `defaultTeamKey` (resolved at sync time) or `defaultTeamId` (UUID, faster) is required.

## Wiring Linear webhooks (recommended)

Linear → Settings → API → Webhooks → New webhook:

- URL: `https://<your-papercusp-host>/api/plugins/_papercupai_linear-sync/webhook?slug=<harness-slug>`
- Resources: `Issue`, `Comment`, `Issue label`
- Headers: `Linear-Signature: $LINEAR_WEBHOOK_SECRET`

Webhook fires bump `cursors.remote_cursor` backwards by 5 minutes — the next 30s tick handles the change. We don't sync inline because Linear's webhook timeout is short and a real sync can take seconds.

## Conflict policy

Same as jira-sync. **Harness wins always** for title/description/status/owned labels. Remote-only metadata (assignee, priority, project) is mirrored read-only into `plugin_linear_sync.links.remote_meta`.

## Schema

`plugin_linear_sync` schema with the same three tables as jira-sync (`links`, `cursors`, `conflicts`). Plus a column `external_identifier` (Linear's human-readable e.g. `ENG-42`) alongside `external_id` (UUID).

## API endpoints

Mounted at `/api/plugins/_papercupai_linear-sync/*`:

| Method | Path | Description |
|---|---|---|
| GET | `/ping` | health + configured? |
| GET | `/status?slug=<s>` | linkCount, cursor, recentConflicts |
| GET | `/links?slug=<s>` | full link rows |
| GET | `/conflicts?slug=<s>` | recent conflict log |
| POST | `/sync?slug=<s>` | trigger a sync now |
| POST | `/webhook?slug=<s>` | Linear webhook receiver |

## License

MIT
