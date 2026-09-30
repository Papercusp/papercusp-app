# TS orchestrator ↔ bash run.sh parity audit

Audit date: 2026-05-08. Runtime default already flipped to TS — bash
remains as the `PAPERCUSP_USE_TS_ORCHESTRATOR=0` opt-out (see
`bin/run.ts:28`). Goal: enumerate residual gaps that must close before
deleting `run.sh`.

Summary: most main-loop dispatch is ported (334 tests). The remaining
gaps below are primarily **proposal flow**, **WIP checkpoints**,
**screenshot post-worker**, and **the on-DONE auto-archive emitter** —
all opt-in features whose absence does not regress the default code
path the canary exercises.

## Confirmed-ported (no action)

| Bash function           | TS counterpart                                 |
|-------------------------|------------------------------------------------|
| `fire_plugin_hook`      | `plugin-hooks.ts → firePluginHook`             |
| `run_hook`              | `hooks.ts → runHook`                           |
| `check_cost_cap`        | `cost-cap.ts`                                  |
| `prune_logs`            | `prune-logs.ts`                                |
| `feature_attempts`      | `state.ts`                                     |
| `process_actions_block` | `actions-block.ts`                             |
| `notify_event`          | covered by main-loop event hooks               |
| `parallel_max_workers` / `lanes_*` | `lanes.ts` + lane handlers in main-loop |
| `branch_iso_*`          | `branch-iso.ts`                                |
| `worktree_*`            | `branch-iso.ts` + scratch-env (chunk loop)     |
| `service-smoke-test`    | `runSmokeTest` (main-loop.ts:1880)             |
| `iteration loop`        | `runMainLoop` / `runMainLoopBody`              |
| `_phase3_feature_counts`/status row | `dispatches-pg.ts`, `mission-state-pg.ts` |
| `extractResult` parse   | `invoke.ts → extractResult`                    |
| chunk loop              | `worker-chunk-loop.ts` + `chunk-loop-driver.ts` |
| multi-decision turns    | `decision-parse.ts → parseDecisions`           |

## Gaps (not ported, opt-in features)

### G1. Proposal pipeline (post-DONE scoper auto-apply)
**Bash:** `extract_proposal_bullets`, `apply_proposal_to_spec`,
`review_pending_proposals` (run.sh:981–1156).
**Effect:** When `proposals.enabled=true` + `proposals.afterDone=true`,
bash runs scoper after DONE then auto-applies reviewer-approved bullets
to SPEC.md. TS DONE handler does not.
**Risk:** none for default config — `proposals.enabled` defaults to
false. Only missions that explicitly opt in lose this auto-apply step.
**Action:** port in a follow-up; no canary blocker.

### G2. WIP checkpoint shadow commits
**Bash:** `wip_checkpoint_start`/`wip_checkpoint_stop` (run.sh:955–980).
A background loop snapshots in-flight worker edits to a papercup branch
so a SIGKILL doesn't lose work mid-feature. TS sequential worker path
calls `invoke worker` directly with no shadow.
**Risk:** crash recovery slightly weaker. Chunk-loop path obviates this
because each chunk commits on success — only legacy non-chunk-loop
single-feature runs are affected.
**Action:** port if/when we keep the non-chunk-loop path long-term.
Otherwise retire alongside `run.sh`.

### G3. Auto-screenshot post-worker
**Bash:** `auto_screenshot_post_worker` (run.sh:1254). Runs a
configurable headless-browser hook to capture a screenshot after each
worker. TS has no equivalent.
**Risk:** purely additive. UI-QA harnesses lose the artifact; coding
harnesses are unaffected.
**Action:** port when a user actually exercises it. Surface as gap in
the docs in the meantime.

### G4. Archive event poster on DONE — **PORTED 2026-05-08**
Implemented in `bus-posts.ts → postArchiveEvent`, wired into
`main-loop.ts:handleDone` after the tar.gz write. Best-effort POST
to `/api/internal/archive-event` with `id/sizeBytes/ts/phase`.
Also added archive-on-done tar logic itself (was a TODO). Tested in
`bus-posts.test.ts`.

### G5. Curator output-event poster — **PORTED 2026-05-08**
Implemented in `bus-posts.ts → postCuratorOutputs`. Reads
`<harnessDir>/identity/*.md` (or `~/autonomous-harness/identity` as
fallback) and `<stateDir>/skills/*.md`, POSTs to
`/api/internal/identity-snapshot` and `/api/internal/skill-snapshot`.
Wired into `handleDone` after curator finishes. Empty-list POST on
missing skills dir mirrors bash behavior. Tested.

### G6. Test-snapshot poster — **PORTED 2026-05-08**
Implemented in `bus-posts.ts → postTestSnapshot`. Reads
`<stateDir>/tests/*.json`, POSTs to `/api/internal/test-snapshot` with
files + phase. Wired into `handleRunTests`. Skips malformed JSON
silently. Tested.

### G7. Sidecar prompt drift
**Was a runtime bug** during the live canary attempt. Resolved by
`papercusp-desktop/bin/sync-sidecar-prompts.sh` (added 2026-05-08)
which rsyncs prompts/identity/templates from source into the bundled
sidecar. `--check` mode added for CI / pre-flight.

## Non-gaps (intentional differences)

- TS uses Postgres-backed dispatches/lanes/papercups by default while
  bash falls back to filesystem state. This is a feature, not a gap —
  bash retains the FS path for legacy harnesses.
- `chunk-loop` exists only in TS. Bash will be retired before chunk-loop
  is port-back-targeted, so this is fine.

## Cleanup-before-deletion checklist

Before `rm run.sh`:

1. ☑ G4 archive event poster (2026-05-08).
2. ☑ G5 curator output-event poster (2026-05-08).
3. ☑ G6 test-snapshot poster (2026-05-08).
4. ☐ G3 auto-screenshot (nice-to-have, deferable).
5. ☑ **All operator runtime call sites moved off run.sh** (2026-05-08):
   - `launchRun` (main "start" entry) → TS via `bin/run.ts`.
   - `MAX_ITERATIONS=0` replan path → TS via `bin/run.ts`.
   - `invokeScoperBackground` → TS via new `bin/invoke-once.ts`.
   - `/invoke` direct-call endpoint → TS via `bin/invoke-once.ts`.
   - `scanForRunShCwd` / `scanRunShProcesses` / kill-pid / liveness
     scans now match `orchestrator/bin/run.ts` cmdline as well.
   - `desktop/preflight/route.ts` checks for `bin/run.ts` first, falls
     back to `run.sh`.
   - `lib/known-hooks.ts` reads hook names from `main-loop.ts` first,
     unions with `run.sh` fallback.
   - `bin/run.ts` itself: bash fallback removed; the
     `PAPERCUSP_USE_TS_ORCHESTRATOR=0` flag is now a warning-and-ignore.
   - New `bin/invoke-once.ts` ports the bash sourced-functions pattern
     for single-role invocations.
   ☐ Remaining: lib-version mirror at
   `libs/papercusp/apps/web/app/api/_hono/harness.ts` is still on bash
   (4611 lines vs operator's 7161 — appears unused at runtime). Check
   before deleting.
   ☐ Remaining: harness `bin/supervisor.sh` and other helper bash
   scripts may still reference run.sh — audit before deletion.
6. ☐ Confirm `bin/supervisor.sh` and `bin/service-smoke-test.sh` only
   reference `run.sh` from comments, not from runtime invocation.
7. ☐ Search-and-update docs that say "run.sh starts the harness".
8. ☐ G1 proposal flow OR document explicit removal.
9. ☐ G2 WIP checkpoints OR document that chunk-loop replaces them.

G1/G2 are optional if we agree to gate these features behind chunk-loop
going forward.

## Slug resolution bug — **FIXED 2026-05-08**

`handleChunkLoopWorker` previously read the harness slug from
`config.slug` (defaulting to empty string), which silently disabled
PG persistence of chunk plans for any harness whose `config.json`
didn't carry `slug`. Sheets-clone hit this. Fixed: now uses
`harnessSlug(ctx)` which consults `HARNESS_SLUG`/`PAPERCUSP_HARNESS_SLUG`
env, the operator harness registry (`/api/harness/projects` reverse
lookup, memoized), then falls back to `basename(projectDir)`.

This means chunk plans now actually persist to
`harness_shared.harness_chunk_plans` and the operator UI's
`chunkPlans.byHarness` Zero query returns rows on next run.
