# Reading git-sync bridge state — diagnosis runbook
URL: /internal/docs/agent-insights/reading-git-sync-bridge-state-runbook

Runbook for diagnosing a bridged git-sync pipeline from the exact routine row: interpret integrator and worktree-bridge watermarks, avoid the global lastEventId trap, distinguish decline history from current state, and verify sticky egress metadata against the live origin/staging ref.

# Preconditions

Use this runbook when a bridged hive appears to have stopped moving commits toward `origin/staging` and you need to distinguish an integrator stall, a worktree-bridge rejection loop, or an egress stall.

You need the exact `workspace_id` and managed install `slug`. A workspace can contain many `system:git-sync` routine rows; a plausible row from another install is worse than no row because its epochs and shas look valid.

# 1. Read exactly one routine row

Run this bounded query through `dev:pg_query`. Replace the two literals, but keep all three predicates (`workspace_id`, `install_slug`, and `target_role`):

```sql
SELECT
  workspace_id,
  install_slug,
  (metadata->'integrator'->>'epoch')::bigint AS integrator_epoch,
  (metadata->'integrator'->>'seq')::bigint AS integrator_seq,
  to_timestamp((metadata->'integrator'->>'at')::double precision / 1000) AS integrator_at,
  (metadata->'worktree_bridge'->'epochSeq'->>'epoch')::bigint AS bridge_epoch,
  (metadata->'worktree_bridge'->'epochSeq'->>'seq')::bigint AS bridge_seq,
  CASE
    WHEN metadata->'integrator'->>'epoch' =
         metadata->'worktree_bridge'->'epochSeq'->>'epoch'
    THEN (metadata->'integrator'->>'seq')::bigint -
         (metadata->'worktree_bridge'->'epochSeq'->>'seq')::bigint
    ELSE NULL
  END AS same_epoch_seq_gap,
  to_timestamp((metadata->'worktree_bridge'->>'at')::double precision / 1000) AS bridge_at,
  (metadata->'worktree_bridge'->>'consumed')::int AS bridge_consumed,
  (metadata->'worktree_bridge'->>'accepted')::int AS bridge_accepted,
  metadata->'worktree_bridge'->'rejectedTerminal' AS bridge_terminal_rejections,
  (metadata->'worktree_bridge'->>'acceptFreeTicks')::int AS accept_free_ticks,
  metadata->'integrator_status' AS last_integrator_decline_or_no_advance,
  metadata->'github_bridge'->>'egress_head' AS last_egressed_origin_staging,
  metadata->>'of_origin_sha' AS watchdog_last_observed_origin_staging
FROM harness_shared.routines
WHERE workspace_id = '<workspace-id>'
  AND install_slug = '<install-slug>'
  AND target_role = 'system:git-sync'
LIMIT 1
```

The query was validated against the production schema on 2026-08-31. Zero rows means the scope is wrong or the routine is absent; do not drop a predicate to make a row appear.

# 2. Interpret the integrator and bridge watermarks

`metadata.integrator` is written only after a real signed staging-advance announcement. Its `{epoch, seq, at}` is the latest announcement produced by this routine row.

`metadata.worktree_bridge.epochSeq` and `.stagingSha` are the latest announcement this row accepted. Compare the epoch before doing arithmetic:

* Same epoch: `integrator_seq - bridge_seq` is the local announcement-to-acceptance gap. `0` is caught up; a positive gap is pending or rejected work. Sample twice: a decreasing gap is catch-up, while a positive static gap plus fresh announcement traffic needs diagnosis.
* Different epochs: the sequence numbers are not subtractable. Epoch fencing is lexicographic; a successor authority can reset sequence within a higher epoch.
* A negative same-epoch gap should not be treated as progress. Re-check row scope and writer chronology; the accepted watermark should not outrun the announcement watermark on the same correctly scoped row.

The gap is a position signal, not a complete health detector. Current code also persists an acceptance census on every nonempty bridge tick:

* `consumed > 0, accepted > 0`: the bridge demonstrably advanced; `acceptFreeTicks` resets.
* `consumed > 0, accepted = 0`: the cursor consumed announcements while the accepted watermark stood still; `acceptFreeTicks` increments.
* `consumed = 0`: no usable announcement was processed; the streak is carried, not reset.
* `rejectedTerminal`: counts terminal reasons such as `non-fast-forward` for that tick.

Read `acceptFreeTicks` with `bridge_at`. A high streak beside a fresh timestamp is a live starvation signal. A high streak beside a stale timestamp is historical until new matching traffic arrives.

# 3. Do not read `lastEventId` as a progress count

`worktree_bridge.lastEventId` is the primary-key coordinate of `harness_shared.coord_event_log`, whose `id` is one table-wide identity sequence. The bridge stores that coordinate inside a per-repo object and queries only rows matching the workspace, hive, staging-advance key, and `repo_key`.

Therefore:

* a delta of 5,000 does not mean 5,000 announcements were consumed; unrelated coord rows can occupy almost all intervening ids;
* a moving value is not proof of acceptance; terminal rejections can advance the cursor while the watermark stays still;
* a frozen value is not proof of a stuck bridge; an empty matching queue returns before writing bridge metadata.

Use `{epoch, seq}`, the acceptance census, and timestamps for progress. Use `lastEventId` only as a resume coordinate.

# 4. Distinguish the bridge branches

Current `runWorktreeBridgeTick` and its persistence seam have four operational shapes:

1. **No matching rows:** the outer leg returns before calling the tick and does not update `worktree_bridge.at`. A stale timestamp can mean healthy idle.
2. **Accepted:** watermark advances; `accepted` increments; the cursor advances.
3. **Terminal rejection:** stale, malformed, forged, wrong-device, or non-fast-forward input is skipped and processing continues. The cursor advances. These reasons are persisted in `rejectedTerminal`; they do not enter `errors[]`.
4. **Retryable stop:** `unknown-sha`, `ungranted-epoch`, or fetch failure stops the batch and holds the cursor immediately before the stopped row. `already-in-flight` also holds without adding an error. After the six-hour retry TTL, a still-retryable row is consumed as lost with a warning so one poisoned row cannot wedge all later announcements.

The tick-level `errors[]` array is not persisted into `metadata.worktree_bridge`, and this best-effort leg does not copy it into routine-level `last_error`; it only emits operator log warnings. A null `last_error` therefore cannot rule out a retryable bridge failure. Use the persisted cursor/census for state and the bounded service logs for the detailed transient error.

# 5. Treat `integrator_status` as a historical outcome, not current state

`integrator_status` is written by the integrator leg's `decline()` helper for registry/identity/authority/grant declines and for `ran_no_advance`. A successful announcement writes `metadata.integrator` instead; it does not clear the older status object.

Consequently, a frozen `integrator_status.skipped = "not_authority"` means only that the last recorded decline had that reason. It does not prove the routine is still declining. Compare its millisecond `at` with `metadata.integrator.at`:

* newer `integrator.at`: a real announcement happened after the decline; the status is stale history;
* newer `integrator_status.at`: the latest integrator attempt declined or ran without an advance; read `skipped` and `detail` as that attempt's outcome.

# 6. Separate sticky egress evidence from the live remote

`github_bridge.egress_head` is sticky by design: it is the last sha egress successfully pushed (or verified already present) on `origin/staging`. A quiet tick does not erase it. `of_origin_sha` is the origin-freshness watchdog's last observed watermark and is also historical state.

Neither field is a network read. Check the actual remote ref from the managed checkout:

```bash
git ls-remote --refs origin refs/heads/staging
```

Interpret the three values separately:

* live remote equals `egress_head`: the last recorded egress is still present;
* live remote ahead of `egress_head`: another writer advanced it or metadata lagged;
* live remote behind/diverged from `egress_head`: investigate remote history and egress CAS; never force from this observation alone;
* bridge watermark ahead of live remote: acceptance succeeded but egress has not yet landed.

# Verify and stop conditions

The pipeline is demonstrably healthy when repeated observations show the bridge gap at zero (or closing), `acceptFreeTicks` reset/low with accepted traffic, and the live `origin/staging` ref reaches the bridge watermark. Do not claim recovery from `last_status = "synced"` alone: local commit sync and bridged egress are separate legs.

Escalate the exact failing leg, not “git-sync” generically:

* integrator gap grows while `integrator_status` stays newer than `integrator.at`: integrator/authority/grant problem;
* fresh bridge ticks consume but accept nothing: worktree-bridge rejection problem;
* bridge watermark advances but live `origin/staging` does not: GitHub bridge/egress problem;
* no new integrator or bridge traffic and no work exists: healthy idle.

# Source anchors

* `packages/operator-core/lib/harness/git-sync/git-sync-action.ts` — row scoping, integrator/status writers, bridge collection/persistence, GitHub egress metadata.
* `packages/operator-core/lib/harness/git-sync/worktree-bridge-state.ts` — complete persisted bridge shape and acceptance-streak semantics.
* `packages/operator-core/lib/sync/pot-git/worktree-bridge-tick.ts` — accepted, terminal-rejection, retryable-stop, cursor-hold, and six-hour TTL contracts.
* `packages/operator-core/lib/release/origin-freshness-watchdog.ts` — sticky egress/origin-watermark interpretation.
