# Issue-tracker sync (jira-sync, linear-sync)

> **Status**: design accepted, implementation in progress (2026-04-30).
> **Replaces**: jira-sync@0.1 / linear-sync@0.1 — manual `create-issue` / `post-comment` / `list-issues` actions plus a thin auto-create on `mission-done`.

## Goal

Continuous, bidirectional, background sync between a harness's feature/issue queues and an external tracker (Jira Cloud or Linear). The user never *creates* an external issue; they *observe* a sync that already happened.

## Direction of truth

**Harness wins.** When a field is present on both sides and they diverge, the harness's value is canonical and is pushed to the remote. The exception is human-only metadata (assignee, sprint, fix-version, parent-link) which the harness has no opinion on; those are pulled remote → local into a JSON sidecar but never overwritten by the plugin.

| Field | Harness side | Jira side | Linear side | Direction |
|---|---|---|---|---|
| title | `harness_features.title` | summary | title | local → remote, last-writer-wins by `updated_ts` if remote was edited after last sync |
| summary/desc | `harness_features.summary` | description (ADF) | description (markdown) | local → remote with last-writer-wins |
| status | `harness_features.status` (`todo`/`in_progress`/`passed`/`failing`/`blocked`/`done`) | workflow status | issue state | **harness wins always** |
| labels | `harness_features.tags` JSONB | labels | labels | union; plugin owns `papercusp-*`, leaves others alone |
| comments | (no harness-native comment table — uses `worker_log` excerpts on transitions) | comments | comments | local → remote on transitions; remote → local stored in link sidecar JSON |
| assignee | — | assignee | assignee | remote → local sidecar only |
| priority | — | priority | priority | remote → local sidecar only |
| created/updated | `created_ts`/`updated_ts` | system | system | informational |

Same for `harness_issues` (bugs found during testing): mirrors as a separately-typed external issue (Jira `Bug` / Linear `Bug` label), uses `linked_feature_id` to set the external link relationship.

## Architecture

```
                    ┌─────────────────┐
                    │  cron routine   │  every 30s
                    │  sync-tick      │
                    └────────┬────────┘
                             │ inserts pending_event
                             ▼
              ┌────────────────────────────┐
              │  orchestrator              │
              │  dispatches to plugin role │  (target: 'sync-engine')
              └────────────┬───────────────┘
                           ▼
           ┌──────────────────────────────────┐
           │  sync-engine (plugin code, not   │
           │  an LLM role — handler exposed   │
           │  via api routine)                │
           │                                  │
           │  1. pull remote deltas (cursor)  │
           │  2. pull local deltas (cursor)   │
           │  3. resolve(local, remote)       │
           │  4. apply patches both sides     │
           │  5. advance cursors atomically   │
           └──────────────────────────────────┘

           ┌──────────────────────────────────┐
           │  webhook routine /webhook        │
           │  Jira/Linear POSTs here on mut.  │
           │  → inserts pending_event with    │
           │    {externalId, kind: 'remote-   │
           │     change'} → sync-engine picks │
           │    it up on next orchestrator    │
           │    tick (sub-second fast path)   │
           └──────────────────────────────────┘

           ┌──────────────────────────────────┐
           │  hook onPostValidator(featureId, │
           │  status)                         │
           │  → enqueue local-change event    │
           │    for that feature (push status │
           │  flip immediately, don't wait    │
           │  for next 30s tick)              │
           └──────────────────────────────────┘
```

The **routine** is the safety net that catches anything the webhook missed (network failures, Jira webhook setup gap, etc.). The **webhook** is the fast path. The **lifecycle hook** is the ultra-fast path for the common case (worker/validator finishes a feature, push immediately).

## Plugin schema

```sql
CREATE SCHEMA IF NOT EXISTS plugin_jira_sync;

-- Mapping table. One row per harness entity that has been mirrored.
CREATE TABLE plugin_jira_sync.links (
  harness_slug   TEXT NOT NULL,
  entity_kind    TEXT NOT NULL,          -- 'feature' | 'issue'
  entity_id      TEXT NOT NULL,          -- feature_id or issue_id
  external_id    TEXT NOT NULL,          -- Jira issue key e.g. ENG-42
  external_url   TEXT NOT NULL,
  local_hash     TEXT NOT NULL,          -- SHA-256 of canonical local payload at last sync
  remote_hash    TEXT NOT NULL,          -- SHA-256 of canonical remote payload at last sync
  remote_meta    JSONB NOT NULL DEFAULT '{}'::jsonb,  -- assignee, priority, sprint, etc. (read-only mirror)
  last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (harness_slug, entity_kind, entity_id)
);
CREATE UNIQUE INDEX links_external_idx
  ON plugin_jira_sync.links (harness_slug, entity_kind, external_id);

-- Cursor table. Tracks "what's the latest thing we've already synced
-- from each side." `local_cursor` is the most-recent updated_ts on
-- harness_features/harness_issues we processed. `remote_cursor` is
-- the most-recent Jira/Linear updatedAt we processed.
CREATE TABLE plugin_jira_sync.cursors (
  harness_slug    TEXT PRIMARY KEY,
  local_cursor    BIGINT NOT NULL DEFAULT 0,
  remote_cursor   TIMESTAMPTZ NOT NULL DEFAULT 'epoch',
  last_full_sync  TIMESTAMPTZ
);

-- Conflict log. Append-only audit of resolutions for debugging /
-- "what happened to my edit" questions.
CREATE TABLE plugin_jira_sync.conflicts (
  id             BIGSERIAL PRIMARY KEY,
  harness_slug   TEXT NOT NULL,
  entity_kind    TEXT NOT NULL,
  entity_id      TEXT NOT NULL,
  external_id    TEXT,
  field          TEXT NOT NULL,
  local_value    JSONB,
  remote_value   JSONB,
  resolution     TEXT NOT NULL,          -- 'local-wins' | 'remote-wins' | 'merged' | 'sidecar'
  resolved_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX conflicts_lookup_idx
  ON plugin_jira_sync.conflicts (harness_slug, entity_kind, entity_id, resolved_at DESC);
```

`linear-sync` mirrors this verbatim under `plugin_linear_sync`.

## Sync state machine (per entity, per tick)

For each `(entity_kind, entity_id)`:

1. **Discover**: row exists in harness, link row may or may not.
   - **No link**: this is a new local entity → push to remote, record link row.
   - **No harness row but link exists**: entity was deleted locally → close the remote (transition to Cancelled / status=Done with resolution=Won't Do, configurable) → mark link tombstoned.
   - **Both exist**: continue.
2. **Fetch remote**: by external_id (avoid stale 30s remote_cursor lag).
3. **Compute hashes**: `local_hash_now = sha256(canonical(local))`; `remote_hash_now = sha256(canonical(remote))`.
4. **Compare to stored hashes**:
   - `local_hash_now == links.local_hash && remote_hash_now == links.remote_hash`: no-op. Bump `last_synced_at`.
   - `local_hash_now != links.local_hash && remote_hash_now == links.remote_hash`: **local changed**. Push patch to remote. Record new hashes.
   - `local_hash_now == links.local_hash && remote_hash_now != links.remote_hash`: **remote changed**. For status/title/desc: remote → local **only** if the field is in the "remote-can-edit" set; else overwrite remote. For assignee/priority/etc: write to `remote_meta` JSONB. Record new hashes.
   - **Both changed**: **harness wins** for the canonical fields; log a conflict row per diverged field; write remote-only fields to `remote_meta`.
5. **Apply** in a single Postgres txn (link table update + harness row update if any).

Pull side (remote → local for *new* external entities not in link table):
- Plugin owns the label `papercusp-<harness-slug>`. Only entities with that label on the remote are considered candidates for inbound sync.
- Inbound entities create a new `harness_issues` row (default kind: bug) or `harness_features` row depending on the remote issue type.
- Once linked, normal compare-and-patch applies.

## Routines

```ts
routines: [
  {
    name: 'sync-tick',
    trigger: { kind: 'cron', expr: '*/30 * * * * *' },  // every 30s
    targetRole: 'sync-engine',                           // pseudo-role; really an api routine
    concurrency: 'skip',                                 // never overlap
    catchup: 'skip-old',                                 // don't backfill 1000 missed ticks
  },
  {
    name: 'webhook',
    trigger: { kind: 'webhook', tokenEnv: 'JIRA_WEBHOOK_SECRET' },
    targetRole: 'sync-engine',
    concurrency: 'queue',
  },
  {
    name: 'manual-sync',
    trigger: { kind: 'api', method: 'POST' },
    targetRole: 'sync-engine',
    concurrency: 'queue',
  },
]
```

`targetRole: 'sync-engine'` is special — instead of dispatching to an LLM role (which would burn tokens for every tick), the orchestrator recognizes it as an internal handler name and calls the plugin's exported `runSync(ctx, payload)` directly. (This needs a small substrate addition: an `internal` role kind that bypasses LLM dispatch.)

Until that substrate work lands, the v1 implementation falls back to: routine inserts `pending_event`, plugin's `onPostOrchestrator` hook checks for sync-engine events at the top of every orchestrator tick and runs the engine in-process. Slightly chatty in `pending_events` but works without substrate changes.

## Hooks (replacing the old action-trigger model)

```ts
hooks: {
  onLoad: ensure schema migrated, ensure cursor row exists,
  beforeMissionStart: trigger an immediate sync,
  onPostValidator(featureId, status): push status change to remote (fast path),
  onProposalAccepted(proposalPath): noop (handled by sync-tick),
  afterDone: final push, then trigger a full reconcile,
}
```

## Surfaces (replacing dashboard buttons)

Dropping `harness-toolbar`, `feature-row`, `mission-done`. Keep only:

- `plugin-detail` — full admin panel:
  - Status: connected? last sync timestamp, drift count, conflict count.
  - Cursors: local/remote watermarks, "force full re-sync" button (clears cursors).
  - Backfill controls: "import existing tracker issues" (one-time).
  - Recent conflicts (last 50 rows from `plugin_jira_sync.conflicts`).

## Backfill primitives (CLI subcommands)

```
papercusp plugin invoke jira-sync backfill-local-to-remote --harness=<slug>
papercusp plugin invoke jira-sync backfill-remote-to-local --harness=<slug>
papercusp plugin invoke jira-sync reconcile --harness=<slug>
```

These are still actions in the manifest, but they don't appear in any UI surface — only `plugin-detail` and CLI.

## Capabilities (manifest)

```
db:plugin-schema
secrets:read:JIRA_API_TOKEN
secrets:read:JIRA_EMAIL
secrets:read:JIRA_BASE_URL
secrets:read:JIRA_WEBHOOK_SECRET     (optional — only if webhook routine is wired)
http:fetch:*.atlassian.net
http:fetch:api.atlassian.com
events:listen:feature-passed
events:listen:feature-failed
events:listen:proposal-accepted
events:listen:mission-done
events:listen:post-validator
routines:read
routines:write
tasks:read
tasks:write
```

(`linear-sync` substitutes `LINEAR_API_KEY` + `http:fetch:api.linear.app` + `http:fetch:webhooks.linear.app`.)

## Operational properties

- **Idempotent**: every operation is keyed by `(harness_slug, entity_kind, entity_id)` and uses content hashing to suppress no-op writes.
- **Cost**: zero LLM calls. Bounded HTTP — at most one GET per linked entity per tick (trim with `if-modified-since` / cursor-scoped queries).
- **Privacy**: local-only data (e.g. `worker_log` content) is summarized into comment posts, but raw transcripts never cross the boundary. The `remote_meta` JSONB caches read-only fields to avoid re-fetch but never writes them back.
- **Failure mode**: a single failing entity logs to `conflicts` and is retried on the next tick; one bad entity doesn't block the rest of the queue.
