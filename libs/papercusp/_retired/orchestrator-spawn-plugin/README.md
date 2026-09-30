# @papercupai/orchestrator-spawn

Phase 9 spawn primitive — agents spawning agents as a tool call.

## Tools

| Tool | What |
|---|---|
| `orchestrator.spawn` | Launch a child agent of a given role with feature/chunk/run context inherited from the caller. Returns immediately with a `spawnId`. |
| `orchestrator.poll` | Read the current state of a spawn — `{ status: running\|done\|failed\|cancelled, startedAtMs, finishedAtMs?, exitCode?, output?, error? }`. |
| `orchestrator.list_active` | List spawns currently running. `scope='mine'` (default) filters to children of the caller; `scope='all'` shows everything in the operator process. |
| `orchestrator.cancel` | Send SIGTERM to a running spawn (then SIGKILL after 2s). Same allowlist as spawn — if you can spawn the role, you can cancel it. |

## Allowlist

Who can spawn whom:

| Caller role | Can spawn |
|---|---|
| `operator` | worker, validator, scoper, reviewer, debugger, documenter, curator, architect |
| `architect` | worker, validator, scoper, reviewer, debugger |
| `scoper` | validator, reviewer |
| `debugger` | validator |
| `reviewer` | architect |
| `worker`, `validator`, `documenter`, `curator` | (nothing) |

Workers and validators are the leaves; nothing fans out from them. Reviewer→architect lets a reviewer kick a re-architect cycle without involving the orchestrator.

## Safety caps

Each enforced server-side; spawn returns a typed error code on cap violation.

| Limit | Code | Default |
|---|---|---|
| Spawn lineage depth | `spawn_depth_exceeded` | 3 |
| Children per parent (in-process) | `spawn_children_exceeded` | 5 |
| Total concurrent (in-process) | `spawn_concurrent_exceeded` | 10 |
| Worker without `chunkId` | `spawn_invalid_input` | — |
| Caller role not in allowlist | `spawn_role_not_allowed` | — |

The depth check counts the **in-process** parent chain. Cross-restart depth would need PG persistence; v1 doesn't bother since the caps are tight enough that depth-aware limits matter most for tight bursts within one operator session.

## State + lifecycle

State is a module-level `Map<spawnId, SpawnRecord>` — same pattern as `gitnexus-bridge`. **Lost on operator restart.** Real cross-restart history lives in `harness_shared.tool_invocations` (the orchestrator's invoke writes a row per child tool call, and the recursive view at `tool_invocations_spawn_tree` joins them by `parent_spawn_id`).

`spawn` does not block. The handler:

1. Allocates `spawnId`
2. Builds an `InvokeContext` from the caller's `ctx` (project/state dirs, harness pkg, phase from config.json, `omp -p` claudeCmd default)
3. Fires `invoke()` from `@papercusp/orchestrator/invoke` as a background `Promise` — not awaited
4. Returns immediately with the spawnId
5. The promise's resolve/reject updates the spawn record's `status`, `exitCode`, `output`, `error`, `durationMs`

Cancel works because Phase 9 also extended `InvokeOptions` with `signal?: AbortSignal`. The plugin's `cancel` calls `abortController.abort()`; the orchestrator's spawn flow listens on the signal and SIGTERMs the child, then SIGKILLs after 2s if it doesn't exit.

## What lights up downstream automatically

- `tool_invocations.parent_spawn_id` is recorded by the dispatcher whenever the child agent makes any tool call (the framework reads it from the spawn URL).
- `harness_shared.tool_invocations_spawn_tree` (Migration 048) recursively joins by `parent_spawn_id` — depth>0 rows appear the moment children fire their own tool calls.
- The Intel panel's **Spawns** sub-tab renders the depth-prefixed tree (e.g. `· repomix.pack`) without any further changes.

## Use cases

**Architect fans out three workers in parallel:**
```
spawn(role='worker', featureId='F-001', chunkId='F-001-1')  → s-...-a
spawn(role='worker', featureId='F-002', chunkId='F-002-1')  → s-...-b
spawn(role='worker', featureId='F-003', chunkId='F-003-1')  → s-...-c
list_active(scope='mine')                                    → 3 running
poll(spawnId='s-...-a')                                       → still running
... wait ...
poll(spawnId='s-...-a')                                       → done, exitCode=0
```

**Reviewer asks for a re-architect:**
```
spawn(role='architect', extras=['REVIEW_NOTE=auth pattern unclear, please re-plan'])
```

**Scoper prepares validation contracts in parallel:**
```
spawn(role='validator', featureId='F-001', chunkId='dryrun-F-001')
spawn(role='reviewer',  featureId='F-001')
```

## Limits

- **No cross-restart resume.** A spawn launched before an operator restart cannot be polled or cancelled after; PG telemetry survives but the in-process abort handle is gone.
- **No queue.** When `MAX_CONCURRENT` is hit, spawn returns `spawn_concurrent_exceeded` — the caller has to retry later. v2 could add a queue with FIFO ordering.
- **Cancel is best-effort.** SIGTERM goes to the agent process; if the agent has subprocesses, those may survive. The orchestrator's existing kill path covers this for the immediate child but doesn't traverse the process tree.

## Capabilities

The plugin declares `tools:orchestrator:spawn:<role>` for every role. Today the framework's plugin-tool gating treats these as descriptive (audit-3 finding D); the plugin itself enforces the allowlist by mapping caller-role → allowed-children-roles. When framework-level capability enforcement on plugin tools lands, the role caps line up cleanly.
