# Project lifecycle — idea to completion
URL: /internal/docs/system/lifecycle

Authoritative walkthrough of how a project moves through the harness, traced from the live code (not stale prior docs).

import { Aside } from '@astrojs/starlight/components';

# Project lifecycle — from idea to completion

The harness *drivers* this page traces — bash `run.sh` and the TS run-loop
(`runMainLoop` / `main-loop.ts` / `bin/run.ts`) — are **retired**. The TS
run-loop cluster is archived at `libs/papercusp/_retired/orchestrator-run-loop/`
(plan `archive-legacy-orchestrator-deadcode-2026-06-06`; git tag
`legacy-orchestrator-run-loop-retired-2026-06-06`). The **live pipeline is the
DBOS durable orchestrator** (`packages/operator-core/lib/dbos/` — the decision
verbs now dispatch from `orchestrator-decide.ts`). The *conceptual* flow below
(scoper → worker → validator → reviewer, decision verbs, feature statuses,
hooks) still largely holds — the DBOS pipeline reuses `invoke.ts`, `lanes.ts`,
and the chunk-loop — but every `main-loop.ts` / `run.sh` code reference on this
page points at archived code. Trust the concepts, not the line numbers.

**The operator-side path references on this page have also drifted.** Live
operator code moved out of `apps/operator/lib/*` into
`packages/operator-core/lib/*` (e.g. `expirable-registry.ts`,
`harness-status-sweep.ts`, `expirable-registrations.ts`, `harness-fs-watcher.ts`,
`plugin-host-runtime.ts`, `harness-registry.ts` are all under
`packages/operator-core/lib/` now), and the monolithic Next-style
`apps/operator/app/api/_hono/harness.ts` was retired — the harness API is now
split into focused Hono handlers under
`packages/operator-core/lib/endpoint-route/routes/**`, so the `harness.ts:NNN`
line citations below no longer resolve. A few cited files
(`identity-files-watcher.ts`, `pm-dispatch.ts`, `claude-chat-stream.ts`,
`expert-dispatcher.ts`) no longer exist at all. Treat the directory/file
citations on this page as conceptual landmarks, not literal paths.

**Per-harness storage is consolidated.** The old per-harness physical-table model is retired. Migrations 032 and 116–121 moved entity state into harness\_shared.\**consolidated tables keyed by harness\_slug; a harness*\<slug> namespace, when present, exposes compatibility VIEWs only. The deleted 002-per-harness-template.sql and bin/scaffold-harness-schema.sh are not provisioning inputs. The live helper is packages/operator-core/lib/scaffold-harness-schema.ts: it creates the schema and slug-filtered views, never physical tables. Read the migrations and that helper for current behavior.

A later code-as-truth pass found that several specific claims on this page are
**wrong** — not merely citing archived line numbers, but describing behavior the
live system no longer has. Until the prose below is rewritten, trust this list:

1. **`/launch` has no SPEC.md gate.** The live route
   (`packages/operator-core/lib/endpoint-route/routes/harness/spawn.ts`) comments
   "No gate: a harness can always be launched. SPEC.md is deprecated
   (`plans-central-harness-ux-2026-05-26`, D-004)". It never returns 400 for a
   missing SPEC.md. With no started plan the orchestrator simply finds no eligible
   features and **idles** — it does not reject the launch.
2. **SPEC.md is deprecated — the system is plans-central.** Features come from a
   *started plan* (the `harness_plans` tables, migration 122+ and follow-ons), not
   from SPEC.md. The whole-page framing of SPEC.md as "the single source of intent"
   is stale; see the new "Plans" stage below.
3. **`launchRun` is a dead legacy stub.** `orchestratorRunBin()` resolves to the
   archived (missing) `orchestrator/bin/run.ts`, so `launchRun` returns
   `{ ok: false, error: 'orchestrator bin missing' }` and `/launch` returns HTTP
   **500** without spawning anything (`packages/operator-core/lib/harness-launch.ts`;
   bash `run.sh` was deleted 2026-05-30). The live driver is the in-process **DBOS
   durable pipeline** (`packages/operator-core/lib/dbos/orchestrator-workflow.ts`),
   not a spawned `run.sh` / `run.ts` whole-loop.
4. **The per-feature decider is the `director` role, not `orchestrator`.** Each
   director runs in a fresh context, makes exactly ONE decision for a single
   `FEATURE_ID`, and exits; the DBOS `featurePipeline` loops the director per turn.
   There is *also* a separate **global orchestrator** (`orchestrator-loop.ts`, "the
   dispatcher") that scans the queue and starts per-feature pipelines — but it does
   not emit the per-feature `NEXT_WORKER` / `NEXT_VALIDATOR` verbs this page
   attributes to "the orchestrator".
5. **`deriveNext` over a blueprint spine supersedes the `classifyDecision` switch.**
   `orchestrator-workflow.ts` calls `deriveNext(spine, parsed, featureId)`; the
   17-branch `classifyDecision` switch (`orchestrator-decide.ts`) is **retained only
   as a golden-reference oracle** that `derive-next-equivalence.test.ts` checks the
   coding blueprint against. The live coding blueprint is **`coding-factory`**
   (`loadBuiltinBlueprint('coding-factory')`), and `MAX_TURNS` is now a blueprint knob
   (`spine.maxTurns`, default 200, overridable via
   `PAPERCUSP_DBOS_PIPELINE_MAX_TURNS`) — not `MAX_ITERATIONS` / `run.sh`. See the new
   "Blueprints" subsection.
6. **The default backend is `claude-code`, not `omp`.** `DEFAULT_CONFIG.backend`
   is `'claude-code'` (`agent-config.ts`); `effectiveBackend()` returns the
   configured backend as-is and only collapses the explicit `'auto'` setting to
   `'omp'`. (Defaulting to `omp` was tried and **reverted** — Owner ask 2026-06-18
   — because it silently launched omp in fresh workspaces.) The dead legacy
   `launchRun` stub still defaults `AGENT_CMD` to `'omp -p'`. A third backend,
   **`codex`**, also exists.
7. **Role prompts moved.** `libs/papercusp/packages/harness/prompts/` no longer
   exists. Prompts now live under a blueprints tree:
   `libs/papercusp/packages/harness/blueprints/base/prompts/<role>.md`, and there is
   a whole **blueprints catalog** (`base`, `coding`, `coding-factory`, `research`,
   `audit`, `review`, `gym`, `migration`, `dist-*`, … \~46 dirs). New roles also exist
   (`director`, `mug`, `cup`, `auditor`, `planner`, `overwatch`, `papercup`, …).
   Every `prompts/<role>.md` path citation below is stale.
8. **There is no `fumadocs` plugin.** The live docs-tab plugin is **`starlight`**
   (`libs/papercusp/plugins/starlight`); the fumadocs→starlight migration replaced
   it.

This document is the **authoritative walkthrough** of how a project moves through the
harness, traced from the actual codebase as of 2026-05-06. Earlier docs in this tree
may be out of date; trust this one and the code references it cites.

## Mental model in one paragraph

The user has an idea. They author a **plan** and **start** it — its items become
the eligible feature queue (SPEC.md is deprecated; see the "Plans" stage below).
A **harness** wraps the project — slug-keyed rows in shared Postgres tables + a
`.papercusp/` directory + a registered slug. When they hit "start", the live driver
is the in-process **DBOS durable pipeline** (`packages/operator-core/lib/dbos/`),
*not* a spawned `run.sh`. The **global orchestrator** (`orchestrator-loop.ts`, "the
dispatcher") scans the queue and starts a durable **per-feature pipeline**; inside
each pipeline a **director** agent (one decision, one feature, fresh context, then
exit) drives the turn loop, alternating a **worker** (writes code) and a
**validator** (runs tests). A **scoper** decomposes intent into features and a
**reviewer** gates the plan up front (`MODE=plan`). When a feature has been retried
`debugger.threshold` times (default 3), the **NEXT\_WORKER** handler invokes the
**debugger** inline before re-running the worker. State lives in Postgres + a few
markdown files. A pipeline terminates when the director emits `DONE` (or
`ESCALATE`); `orchestrator-finalize.ts` then runs the curator/documenter and fires
the `afterDone` plugin hook.

What roles run, which decision verbs are valid, the decider role, and the max-turns
cap are all defined by a **blueprint spine** — coding harnesses resolve to the
built-in **`coding-factory`** blueprint (see "Blueprints" below).

Code reference: `packages/operator-core/lib/dbos/orchestrator-workflow.ts` (live
per-feature pipeline), `orchestrator-loop.ts` (global dispatcher),
`orchestrator-finalize.ts` (terminal curator/documenter/afterDone).

The narrative below still describes the **archived** `run.sh` / `main-loop.ts`
run-loop, the `orchestrator` decider, the `classifyDecision` switch, and SPEC.md as
the source of intent. Read the conceptual flow (scoper → worker → validator →
reviewer, the decision verbs, feature statuses, hooks) — it largely still holds in
the DBOS pipeline — but for the live mechanism, names, and paths, trust the two
Asides above and the "Plans" and "Blueprints" subsections.

***

## Stage 0 — User has an idea

**Where this lives:** outside the system. The user knows what they want to build.

If the idea is half-formed, they have **two pre-spec surfaces** in the operator UI to
explore it before committing to a SPEC.md:

| Surface             | URL                                                                                                            | What it does                                                                                                                                                       | Persists to                                                                                                                                                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Brainstorm chat** | `/harness/<slug>?panel=brainstorm`                                                                             | Conversational LLM partner that explores, suggests analogues, challenges assumptions. Can emit `promote:spec` / `promote:feature` / `promote:issue` action blocks. | Brainstorm scratchpad **PG-canonical** in `harness_shared.harness_brainstorm` (Migration 033), with `.papercusp/brainstorm.{md,canvas.json,mindmap.json}` as a dual-written file mirror so the orchestrator subprocess can read it. |
| **Architect chat**  | `/harness/<slug>` — embedded inside the **Inbox panel** of the dashboard via `<ArchitectInbox><ArchitectChat>` | More structured — Socratic clarifying questions, proposes concrete `proposal:SPEC.md` or `proposal:contract` diff blocks the user can accept.                      | On accept: writes `harness_shared.harness_project_files` (Migration 034) for SPEC.md / validation-contract.md / config.json (PG-canonical, file-mirror) via `POST /:slug/architect/apply`.                                          |

Both are backed by `runClaudeChat`, which spawns the configured agent CLI per the
resolved backend (`claude -p` by default; `omp -p` / `codex` when selected — see
`effectiveBackend()` in `packages/operator-core/lib/agent-config.ts`, which defaults
`'auto'` to `omp`).

The `promote:*` action-block parser lives at `apps/operator/app/api/_hono/harness.ts:5556`
in `harness.post('/:slug/brainstorm/promote', ...)`. It routes:

* `target: 'feature'` → appends to `.papercusp/features.json` as `F-IDEA-<NNN>` — note: this is the **one writer that hasn't been migrated** to the API yet. Per Stage 2.5, scoper + validator now POST to `/api/harness/<slug>/features/import`; brainstorm/promote still writes the file directly. PG ingestion of those F-IDEA entries happens via run.sh's import shim on the next launch.
* `target: 'spec'` → updates `SPEC.md` via `harness_shared.harness_project_files` (Migration 034); the file mirror is dual-written for editor convenience.
* `target: 'issue'` → appends to `.papercusp/issues.json` (file-canonical; mirrored to per-harness `harness_issues` PG via `syncIssuesToPg`).

**Output of Stage 0:** intent the user is ready to commit to. The modern path is to
turn that intent into a **plan** and start it (see the "Plans" stage). SPEC.md is
**deprecated** (`plans-central-harness-ux-2026-05-26`, D-004): the live
`POST /:slug/launch` route carries **no SPEC.md gate** and never returns a 400 for a
missing spec — it comments "No gate: a harness can always be launched." With no
started plan, the orchestrator simply finds no eligible features and idles.

***

## Stage 0.5 — Plans are the source of intent

The system is **plans-central** (`plans-central-harness-ux-2026-05-26`, D-004), not
SPEC.md-central. The user authors a **plan** (a structured list of items / features)
and **starts** it; its items become the eligible feature queue the global
orchestrator dispatches. SPEC.md is deprecated and optional — a started plan, not a
spec file, drives what gets built.

* **Storage.** Plans live in the `harness_plans` family of tables, introduced at
  `libs/papercusp/libs/db/sql/122-harness-plans.sql` with follow-on migrations
  (128, 140–142, …). The plan-authoring and plan-status agent tools live under
  `packages/operator-core/lib/agent-tools/plans/`.
* **Lifecycle.** Until a plan is *started*, launching the harness is a no-op idle
  (no eligible features). Flipping a plan item's status (`plans:set-status`) moves
  it through the queue; a started plan's items are what the dispatcher leases and
  hands to per-feature pipelines.
* **Why it changed.** SPEC.md was a single opaque blob the scoper had to re-decompose
  every run; plans make the unit of intent a first-class, individually-status-tracked
  item that the orchestrator can pick, lease, and finalize one at a time.

***

## Stage 1 — Harness creation

The user **registers a project** (an existing dir on disk) as a harness. Three entry points:

| Entry point                                   | Route                                                                     | What gets created                                                               |
| --------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Manually-typed slug + path in the operator UI | POST /api/harness/projects                                                | Register the slug/path and ensure the shared-state compatibility views          |
| From a saved template                         | `POST /api/templates/<slug>/<version>/install`                            | Materialise template files into a target dir, then `POST /api/harness/projects` |
| From a marketplace snapshot                   | `POST /api/marketplace/install` or `POST /api/snapshots/[id]/instantiate` | Fork a snapshot into a fresh harness                                            |

The project-registration handler does:

1. **Register the slug.** Add the slug → project-path mapping to the workspace harness registry.
2. **Ensure compatibility views.** The live helper packages/operator-core/lib/scaffold-harness-schema.ts creates the harness\_\<slug> namespace and slug-filtered auto-updatable VIEWs over the harness\_shared.\*\_consolidated tables. It creates no physical per-harness tables, does not apply a deleted SQL template, and does not add a per-harness table set to a publication.
3. **Keep shared state canonical.** Features, issues, runs, snapshots, chats, and related records are stored in the corresponding harness\_shared consolidated tables, keyed by harness\_slug; the per-harness views exist only for compatibility with slug-scoped writers.
4. **Return** the registration and provisioning result to the caller.

**Output of Stage 1:** a slug + project directory + shared, slug-keyed state with compatibility views where the registered harness needs them.

## Stage 2 — Pre-loop bootstrap (planning)

User clicks **"Start"** in the operator dashboard.

The live `POST /:slug/launch` route
(`packages/operator-core/lib/endpoint-route/routes/harness/spawn.ts`) calls
`launchRun(project)`, but `launchRun` is now a **dead legacy stub**:
`orchestratorRunBin()` resolves to the archived (missing)
`orchestrator/bin/run.ts`, so it returns `{ ok: false, error: 'orchestrator bin
missing' }` and the route returns HTTP **500** without spawning anything
(`packages/operator-core/lib/harness-launch.ts`). It still fires the
`beforeMissionStart` plugin lifecycle hook and emits a `launch` pipeline event. The
**actual** orchestration is the in-process **DBOS durable pipeline**
(`packages/operator-core/lib/dbos/orchestrator-workflow.ts`), driven by the global
orchestrator-loop dispatcher — not the spawned `run.sh` / `run.ts` whole-loop
described below. Bash `run.sh` was deleted 2026-05-30.

The legacy preflight below (`run.sh:start`) is **archived**; the live DBOS pipeline
reuses its *concepts* (scoper/reviewer gates, feature statuses) but not its
mechanism. It did:

1. **Resolve env** — `HARNESS_DIR` / `PROJECT_DIR` / `STATE_DIR=$PROJECT_DIR/.papercusp` / `LOG_DIR=$STATE_DIR/logs`. Reads `phase` from `.papercusp/config.json` (defaults `staging`). Picks `$AGENT_CMD` (or legacy `$CLAUDE`) and `$AGENT_BACKEND` (claude-code or omp; auto-inferred from binary name).
2. **Ensure directories** — at startup, `mkdir -p $STATE_DIR $LOG_DIR` (run.sh:138). Other subdirectories (`memory/`, `proposals/`, `experts/`, `worktrees/`, `screenshots/`, `archives/`, `debug/`, `logs/hooks/`) are created **lazily on first use**, not all up front.
3. **Pre-loop gate** (`pre-loop.ts:runPreLoop` in TS, run.sh:1574-1601 in bash): if `.papercusp/validation-contract.md` is missing OR no features exist, invoke the **scoper** with `MODE=initial`. The scoper reads `SPEC.md` (canonical in `harness_shared.harness_project_files`, Migration 034; file mirror at project root) and writes:

   * `.papercusp/validation-contract.md` — the acceptance bar (markdown-formatted invariants the validator will enforce). PG-canonical in `harness_shared.harness_project_files.contract` (Migration 034); the file is a dual-written mirror.
   * `.papercusp/features.json` — array of `{id, title, status:'todo', attempts:0, claims:[]}` features (transient staging file; see Stage 2.5)

   *Backend divergence: bash `features_exist()` (run.sh:1083) checks `harness_features` PG via `psql`; TS `state.ts:featuresExist` (line 32) checks `features.json` on disk. Re-running an already-scoped harness in TS mode without features.json present will re-fire the scoper.*
4. **Plan-review gate** (formerly "plan-gate"): invoke the **reviewer** with `MODE=plan`. Reviewer reads SPEC.md + scoper output and writes `.papercusp/plan-review.md` with `VERDICT: accept | accept-with-notes | reject | unknown`. The file is mirrored to `harness_shared.harness_plan_review` by the operator's fs-watcher; both the operator prompt builder (`loadHarnessPlanReviews`) and the mobile-intervention watcher read PG, not the file. On `reject`, run.sh exits 7 — no work begins. On `accept-with-notes`, the loop proceeds and the `PlanReviewBanner` (operator UI) surfaces the notes for the human to act on.
5. **Ensure docs** (`bin/ensure-docs.sh`): scaffold the per-harness docs dir if missing.
6. **Auto-checkpoints**: per `config.checkpoints.types`, write `.papercusp/checkpoint-<name>.md` markers so the orchestrator can pause for human approval on configured boundaries.
7. **Worktree prune**: if `branchIsolation.useWorktrees`, garbage-collect stale per-feature git worktrees from previous runs.

**Output of Stage 2:** mission state ready — SPEC.md + validation-contract.md + features (in features.json AND mirrored to `harness_features` PG via the run.sh import shim) + plan-review\.md verdict + (optional) checkpoint markers.

### Stage 2.5 — features.json status (mostly dead, fallback only)

The scoper prompt was migrated 2026-05-01 (see the migration note at the top of
`libs/papercusp/packages/harness/prompts/scoper.md`): it now POSTs directly to
`/api/harness/<slug>/features/import` which writes to PG with INSERT…ON CONFLICT
semantics. The validator prompt is also migrated and explicitly says
"never write to features.json directly".

A **legacy fallback** still exists: if an agent writes `.papercusp/features.json`
anyway, run.sh has a shim that imports it to PG. But the preferred (and now
default-prompted) path is the API endpoint. Treat features.json as essentially
retired in agent flow; the file may still be created by the scoper for snapshot
parity (snapshots include it in their tarball).

***

## Stage 3 — The pipeline loop

The pseudocode below describes the **archived** `run.sh` / `main-loop.ts` loop. In
the live system (`packages/operator-core/lib/dbos/orchestrator-workflow.ts`) the
shape is the same — a per-turn decide → dispatch loop — but the moving parts differ:

* The per-turn decider is the **`director`** role (`director.md`), not
  `orchestrator`. Each director runs in a fresh context, makes exactly ONE decision
  for a single `FEATURE_ID`, and exits.
* The decision is classified by **`deriveNext(spine, parsed, featureId)`** over the
  blueprint spine, *not* by the `classifyDecision`/`main-loop.ts` switch. That switch
  (`orchestrator-decide.ts`) survives only as a golden-reference **oracle** that
  `derive-next-equivalence.test.ts` checks the coding blueprint against.
* The turn cap is **`spine.maxTurns`** (default 200, overridable via
  `PAPERCUSP_DBOS_PIPELINE_MAX_TURNS`), not `MAX_ITERATIONS`.
* A separate **global orchestrator** (`orchestrator-loop.ts`) leases a feature and
  *starts* this per-feature pipeline; it does not emit the per-feature verbs.

See the "DBOS durable pipeline" and "Blueprints" subsections below for the live flow.

The archived `run.sh` / `main-loop.ts` loop iterated up to `MAX_ITERATIONS`
(default 200):

```
// TS: for (let iteration = 1; iteration <= maxIterations; iteration++) — main-loop.ts:162
// bash: while [ $iteration -lt $MAX_ITERATIONS ] — semantic equivalent
for iteration in 1..MAX_ITERATIONS:
  log("── iteration $iteration ──")
  decision = invoke(primaryRole)   // archived: default 'orchestrator'.
                                   // LIVE: the per-feature 'director' decides
  case decision:
    DONE → handleDone(); exit 0
    IDLE → sleep 30s; continue
    ESCALATE <reason> → handleEscalate(); fires on-escalate hook,
                        runs curator (TRIGGER=escalate),
                        notify_event escalate, exit 3.
                        Note: the LLM writes escalation.md as part of
                        its decision (per orchestrator.md §E); the
                        handler only logs.
    CHECKPOINT <name> [message] → handleCheckpoint(); writes
                                  .papercusp/checkpoint-<name>.md and
                                  EXITS the loop with code 8. To
                                  resume: `touch checkpoint-<name>.md.granted`
                                  + re-run. Not a pause — it's a
                                  terminal exit waiting for human grant.
    NEXT_WORKER <fid> [N=k] → handleNextWorker(); routes through 1 of 4 paths:
                        single (max=1) / parallel-lane / competition / adaptive.
                        Adaptive mode reads N from the verb (e.g. NEXT_WORKER F-001 N=2)
                        and validates against the configured tier vocabulary
                        (global, edited at /settings/orchestrator). N=1 acts
                        like lane mode; N>1 acts like competition. ALSO fires
                        the debugger BEFORE the worker if
                        attempts >= debugger.threshold (default 3)
                        AND .papercusp/debug/<fid>.md doesn't exist yet
    NEXT_WORKER_CEO_MODE → CEO-mode worker (self-prompt expansion)
    NEXT_VALIDATOR <fid> → handleNextValidator() — drains lanes, runs validator,
                           updates feature status. Does NOT fire the debugger.
    NEXT_TESTER → handleSimpleInvoke('tester')
    NEXT_SECURITY → handleSimpleInvoke('security-reviewer')
    GENERATE_TESTS → handleSimpleInvoke('test-writer')
    NEXT_MONITOR → handleSimpleInvoke('monitor')   (production phase)
    NEXT_ARCHITECT → handleNextArchitect()
    CONVERTED → log + idle (orchestrator converted issues to fix-features)
    FEATURE_FREEZE <phase> → log + idle
    RUN_TESTS → handleRunTests()
    READY_FOR_PROD → graduate-to-production hook
    NEXT_HARNESS <child-slug> --role=<role> → cross-harness dispatch
    default → exit 4 (unparsable-decision; reachable for verbs that are in
              DECISION_VERBS but lack a switch case, currently
              NEXT_PROJECT_MANAGER and NEXT_SUMMARIZER)
  sleep iterationSleep (default 2s)
end
```

Code (archived): `main-loop.ts` — `switch (parsed.verb)`, 17 explicit case branches.
In the **live** pipeline that switch is `classifyDecision` in
`packages/operator-core/lib/dbos/orchestrator-decide.ts`, and it is **superseded** by
`deriveNext` over the blueprint spine (P-004, D-002) — `classifyDecision` is retained
only as the byte-equivalence oracle, not the live router.

**Exit codes by branch (archived loop):** `DONE`=0, `IDLE`=continues, `ESCALATE`=3, `CHECKPOINT`=8, `default`=4. Non-terminal branches (`READY_FOR_PROD`, `CONVERTED`, `FEATURE_FREEZE`, etc.) just log + continue.

### The DBOS durable pipeline (live)

The live orchestration is a **DBOS durable workflow**, not a spawned run-loop. Two
components, one named "orchestrator" each:

* **Global orchestrator / dispatcher** (`orchestrator-loop.ts`, formerly "the
  dispatcher"). The deterministic cross-feature selector: it scans the eligible
  feature queue (from started plans), **claims** a feature via a work-item lease, and
  **starts** a durable per-feature pipeline for it. It owns cross-feature concerns
  (parallel lanes, `NEXT_HARNESS`, CEO mode) that are deliberately carved out of the
  per-feature model.
* **Per-feature pipeline** (`featurePipeline` in `orchestrator-workflow.ts`). A
  durable, checkpointed workflow for ONE feature. Each turn:
  1. **Decide** — run the `director` (a checkpointed DBOS step). The decide step
     tolerates a transient 429 / overload in-process (`runWithRateLimitTolerance`)
     so a rate-limit blip under fleet load doesn't error the whole pipeline; a
     genuine empty/failed invoke throws so DBOS retries (3× over \~15s) and then
     errors rather than false-succeeding.
  2. **Classify** — `deriveNext(spine, parsed, featureId)` maps the director's verb
     to a `dispatch` / `terminal` / `unsupported` action.
  3. **Renew lease** — before any side-effecting dispatch, a checkpointed
     `lease-heartbeat` step renews and verifies the work-item lease; if the lease
     lapsed or another Swarm stole it (`renewed:false`), the pipeline self-aborts and
     leaves the feature for the live holder.
  4. **Dispatch** — run the chosen role (worker / validator / architect / …) as a
     checkpointed step, then loop.
  5. On `DONE` / `ESCALATE`, **`orchestrator-finalize.ts`** runs: the curator distils
     run memory, the documenter writes docs, an optional archive runs, and the
     `afterDone` plugin hook fires (a harness-scoped needs-human DONE-gate guards
     finalization). IDLE / unsupported / max-turns stop without finalizing — the
     dispatcher re-scans.

### Blueprints

What the pipeline *does* — which roles run, which decision verbs are valid, the
decider role, and the max-turns cap — is defined by a **blueprint spine**, not
hard-coded. A spine carries at least `decider` (the per-feature decider role),
`edges` (the valid verb vocabulary → next-action map), and `maxTurns`.

* Coding harnesses resolve to the built-in **`coding-factory`** spine
  (`loadBuiltinBlueprint('coding-factory')`), whose `decider` is `director` and whose
  `deriveNext` output is **byte-equivalent** to the legacy `classifyDecision` switch
  (proven across the full verb vocabulary by `derive-next-equivalence.test.ts`).
* A non-coding harness passes its own resolved spine via `PipelineInput.spine`
  (e.g. `research` → a `research-director` decider) and parses the director's output
  against that spine's own verb set.
* There is a large **blueprints catalog** (\~46 dirs under
  `libs/papercusp/packages/harness/blueprints/`): `base`, `coding`, `coding-factory`,
  `research`, `audit`, `review`, `gym`, `migration`, the `dist-*` distributed-agent
  blueprints, and more. **Role prompts now live under that tree** —
  `blueprints/base/prompts/<role>.md` — *not* the retired
  `libs/papercusp/packages/harness/prompts/` directory cited elsewhere on this page.

### Concrete walk-through — one mission, many iterations

You hit "Start" on the `sheets` harness. That's **one mission**. During that mission, this happens:

```
beforeMissionStart fires            ← mission begins
── iteration 1 ──                   ← iteration 1: orchestrator says "NEXT_WORKER F-001"
                                     worker runs, takes 90 seconds
                                     iteration 1 ends
[sleep 2s — iterationSleepMs]
── iteration 2 ──                   ← iteration 2: orchestrator says "NEXT_VALIDATOR F-001"
                                     validator runs, takes 30 seconds
                                     iteration 2 ends
[sleep 2s]
── iteration 3 ──                   ← orchestrator says "NEXT_WORKER F-002"
...
── iteration 87 ──                  ← orchestrator says "DONE"
                                     handleDone runs, fires afterDone hook
                                     handleDone returns terminal MainLoopExit
                                     ← mission ends (exit 0, "done")
```

One mission, 87 iterations, \~2 hours of wall-clock time, \~12 features shipped.

A **mission** is the entire `runMainLoopBody` execution; an **iteration** is one trip through the for-loop. Iterations are nested inside the mission — they're not different *kinds* of things, they're different scales.

**Verb-set divergence between backends:**

|                                    | Bash (run.sh)                                                   | TS (main-loop.ts)                         |
| ---------------------------------- | --------------------------------------------------------------- | ----------------------------------------- |
| Recognized verbs                   | 20                                                              | 19                                        |
| Handled verbs                      | 20                                                              | 17 (other 2 fall to default → exit 4)     |
| Bash-only                          | `NEXT_EXPERT` @2186, `NEXT_FEEDBACK` @2204, `NEXT_SCOPER` @2228 | —                                         |
| TS-only (recognized but unhandled) | —                                                               | `NEXT_PROJECT_MANAGER`, `NEXT_SUMMARIZER` |

An agent emitting `NEXT_EXPERT` works in bash but is ignored by TS. One emitting `NEXT_PROJECT_MANAGER` is exit-4'd by TS and treated as unparsed by bash.

**Important**: `NEXT_DEBUGGER` is **not** a decision verb. The debugger role is invoked from inside the **`NEXT_WORKER` handler** (`handleNextWorker` in main-loop.ts:438–456 — the comment in code reads "Optional debugger before the worker.") when a feature has hit the `debugger.threshold` attempts AND `.papercusp/debug/<fid>.md` doesn't exist yet. The flow is: validator returns failing → orchestrator decides `NEXT_WORKER F-001` again → handleNextWorker runs the debugger first, then re-runs the worker. Don't expect the orchestrator agent to emit `NEXT_DEBUGGER` directly, and don't look for the debugger fire-point inside handleNextValidator — it isn't there.

### How an agent runs (`invoke()`)

This is the universal subprocess primitive. Code: `invoke.ts:invoke` (TS) and `run.sh:invoke()` (bash).

For each role invocation:

1. **Resolve prompt file** — 4-tier lookup, first match wins (per `prompt-resolve.ts:candidatesFor` and `run.sh:1229-1262`): `harness/prompts/<phase>/departments/<dept>/<role>.md` → `harness/prompts/<phase>/<role>.md` → `harness/prompts/department/<role>.md` (legacy, only when `phase=department`) → `harness/prompts/<role>.md` (root fallback). The `prompts/base/` directory contains role *base files* that prompts elsewhere `cat` in by hand — it is **not** part of the lookup chain.
2. **Compose prompt** (per `prompt-build.ts:54+ buildPrompt`, in order):
   * **Substrate context** — Tier 1 (this harness's slug + parent harness if any) + Tier 2 (sibling harnesses) + Tier 3 (templates available) + bounded supervisor inbox. Fetched via `fetchSubstrateContext` in invoke.ts:362; goes BEFORE the role prompt so role instructions can refer to "the parent harness above". Empty string on fetch failure.
   * Base prompt content (the resolved `<role>.md` file)
   * User-edited prompt overrides (`config.json#promptOverrides.<role>`)
   * `.papercusp/memory/summary.md` (curated cross-iteration learnings — populated by the curator). PG-canonical in `harness_shared.harness_text_artifacts` (Migration 035); the file is a dual-written mirror so the orchestrator subprocess can read it. **Skipped for the curator role** to avoid feedback loop.
   * Per-role identity at `<harness-package>/identity/<role>.md` (cross-mission patterns the curator maintains). PG-mirrored in `harness_shared.identity_files` (Migration 041) by the operator's `identity-files-watcher`; the operator UI's IdentityPanel reads PG, but the orchestrator subprocess still reads the file at prompt-build time.
   * Runtime-context footer: extras (e.g. `FEATURE_ID=F-001`, `MODE=initial`), cwd (or worktree path), project root, state dir, run ID, and a memory-discipline reminder telling the role to append a one-line observation to `.papercusp/memory/raw.md` if it learned anything actionable. The file is dual-written from `harness_shared.harness_text_artifacts` (Migration 035) when written via the operator UI; subprocess writes (LLM Edit/Write tool) update the file directly and the fs-watcher catches up. **The memory-discipline reminder is omitted for the curator role.**
3. **Run ID:** `<unix-ts>-<role>[-<featureId>]`
4. **CWD:** project root, OR a per-feature git worktree if branch-isolation + worktrees are enabled (avoids workers stomping each other).
5. **Spawn** the agent CLI with backend-specific flags (the default backend is
   **`omp`**, not `claude-code`; `codex` is a third option — see `effectiveBackend()`):
   * **claude:** `claude -p --output-format stream-json --verbose --include-partial-messages` ; prompt → stdin
   * **omp (in-loop, orchestrator's invoke.ts):** appends `--mode json --no-session` (`streamFormatFlags` in invoke.ts) ; prompt → tmpfile → `@<path>` positional arg ; stdin closed
   * **omp (chat surfaces, libs/papercusp-shared/src/agent/chat-stream.ts):** appends `-p --mode json` plus `--no-session` (only when no `sessionId` opt is set) plus `--no-skills --no-rules` (chat surfaces don't want plugin/skill chatter); same `@<path>` prompt-file pattern. The chat-stream's flag set differs from the orchestrator's because chat surfaces tune for a single-turn predictable response, not a tool-using agent loop.
   * Both backends honour per-role `--model` from `config.json#models.<role>` (or env `AGENT_MODELS` JSON).
6. **Stream capture:** stdout → `<runId>.jsonl`, stderr → `<runId>.err`. The terminal `result` event (claude) or `message_end` (omp) yields the final assistant text → written to `<runId>.out`.
7. **Decision parse:** for the **primary role** (`config.primaryRole`, default `'orchestrator'`; org/department harnesses sometimes set this to `coordinator`), the `.out` body is regexp'd by `decision-parse.ts` to extract the last `DECISION_VERB [arg]` line. Other roles' `.out` is read by their callers as freeform text or parsed for action blocks.
8. **Hooks** — three distinct categories fire around an invoke():

   **User hooks** (fixed set, fire from `runHook()` in main-loop.ts):

   * Pre/post for spawned subprocesses only: `pre-worker`@467, `post-worker`@496, `pre-validator`@556, `post-validator`@588 (+ `pre-worker`@759, `post-worker`@780 in parallel-lane path).
   * Other lifecycle hooks: `on-smoke-pass`@366, `on-smoke-fail`@369, `on-competition-start`@648, `on-competition-won`@875, `on-escalate`@922, `on-checkpoint-fired`@983 (also pre-loop.ts:159).
   * No `pre-`/`post-` hooks exist for orchestrator/scoper/reviewer/debugger/curator/etc. — adding a `pre-curator` script will silently no-op.

   **Plugin lifecycle hooks** — fired from two places:

   * **Operator Hono routes** call `firePluginLifecycle` for UI-driven transitions: `beforeMissionStart` (POST /launch, harness.ts:1999), `onFeaturePassed` (PATCH features → passed, harness.ts:1410), `onProposalAccepted` (POST proposals/:id/accept, harness.ts:3258).
   * **Orchestrator** (run.sh and TS main-loop.ts) shells out to the `papercusp-fire-hook` CLI for loop-internal transitions. TS fires 7 hooks: `onLoad`@114, `beforeMissionStart`@160, `onPostOrchestrator`@167, `onPostWorker`@509, `onPostValidator`@601, `afterDone`@393, `onUnload`@118 (in `finally` so it runs on abort). Bash fires the same set minus the TS-only `onLoad`/`onUnload`.

   **Event-bus events** — plugins can subscribe via `events:listen:<name>` capability; see plugin manifests for available events.

### Per-feature workflow

Typical happy path for one feature:

1. **orchestrator** → emits `NEXT_WORKER F-001`
2. **worker** runs. First, `handleNextWorker` flips status to `in_progress` and bumps `attempts` (main-loop.ts:476). The worker then reads SPEC.md + claim list for F-001 + recent issues, writes code, and at completion sets status to **`validating`** (per `prompts/worker.md` "Definition of done", via `PATCH /api/harness/<slug>/features/<id>`). The `in_progress` write is the orchestrator's; the `validating` write is the worker's.
3. **orchestrator** → emits `NEXT_VALIDATOR F-001`
4. **validator** runs → executes acceptance scripts from `validation-contract.md`, writes pass/fail. On fail: appends to `.papercusp/issues.md` + sets feature status `failing`
5. If `failing`: orchestrator → `NEXT_WORKER F-001` again → `handleNextWorker` first fires the **debugger** (when `attempts >= config.debugger.threshold` (default 3) and no `.papercusp/debug/<fid>.md` exists yet), then re-invokes the worker
6. If still failing after debugger: orchestrator escalates → `NEXT_ARCHITECT F-001` for re-plan, or eventually `ESCALATE`
7. On pass: orchestrator picks next feature

A typical feature ships in 5–15 iterations. Total cost is tracked in `total_cost_usd`
fields across the .jsonl logs and surfaces via `cost-cap.ts` — over budget triggers
SIGTERM on the entire process group.

### Roles catalogue

Prompt-file paths in this catalogue are stale. The
`libs/papercusp/packages/harness/prompts/` directory no longer exists — role prompts
moved to **`libs/papercusp/packages/harness/blueprints/base/prompts/<role>.md`** (and
phase/department overrides under the blueprints tree). New roles also exist
(`director`, `mug`, `cup`, `auditor`, `planner`, `overwatch`, `papercup`, …). The
"When invoked" descriptions referencing `main-loop.ts` / `run.sh` describe the
archived loop; the live decider is the per-feature `director`.

**In-loop roles (called by main-loop.ts or run.sh during iteration):**

| Role                  | When invoked                                                                                                                                                                                                                               | Reads                                                               | Writes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **scoper**            | pre-loop step 1 (`MODE=initial`) when contract or features missing; also on `POST /:slug/replan`                                                                                                                                           | SPEC.md                                                             | POSTs `/api/harness/<slug>/features/import` (PG); writes `.papercusp/validation-contract.md` (PG-mirrored to `harness_project_files.contract`)                                                                                                                                                                                                                                                                                                                                                                                         |
| **reviewer**          | pre-loop step 1.5 (`MODE=plan`) — **only here**, not on completion                                                                                                                                                                         | scoper output, SPEC.md                                              | `.papercusp/plan-review.md` (`VERDICT: …`) — PG-mirrored to `harness_shared.harness_plan_review` by fs-watcher                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **orchestrator**      | every loop iteration                                                                                                                                                                                                                       | `.papercusp/` state, recent run.log, memory                         | last-line decision verb (one of 19 in `DECISION_VERBS`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **worker**            | `NEXT_WORKER` (single / parallel-lanes / competition path)                                                                                                                                                                                 | SPEC.md, feature claims, recent issues                              | project code; PATCHes `/api/harness/<slug>/features/<id>` for status changes                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **validator**         | `NEXT_VALIDATOR`                                                                                                                                                                                                                           | validation-contract.md, feature claims                              | `harness_features.status` via PATCH; `.papercusp/issues.md` (PG-canonical in `harness_text_artifacts`, Migration 035; file mirror); POSTs `/api/harness/<slug>/issues/append-pending` per finding                                                                                                                                                                                                                                                                                                                                      |
| **debugger**          | invoked inline by the **`NEXT_WORKER` handler** (`handleNextWorker` in main-loop.ts:438–456) BEFORE the worker runs, when `attempts ≥ debugger.threshold` (default 3) AND `.papercusp/debug/<fid>.md` doesn't exist (one-shot per feature) | failing feature's issues, recent worker output                      | code (fix attempts), `.papercusp/debug/<fid>.md` marker                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **architect**         | `NEXT_ARCHITECT` decision (in-loop)                                                                                                                                                                                                        | SPEC.md, contract, features, issues                                 | proposals — emits fenced `proposal:contract` / `proposal:SPEC.md` blocks in stdout (parsed per `prompts/architect.md` line 55+); the orchestrator extracts those blocks and writes `.papercusp/proposals/<id>.md`; `apps/operator/lib/harness-fs-watcher.ts` then mirrors the file into `harness_shared.harness_proposals_shared`. There is **no** `POST /api/harness/<slug>/proposals` endpoint — only `GET /:slug/proposals`, `GET /:slug/proposals/:id`, and `POST /:slug/proposals/:id/accept` / `…/reject` (harness.ts:3189–3290) |
| **curator**           | on `DONE` (`TRIGGER=done`) and on `ESCALATE` (`TRIGGER=escalate`)                                                                                                                                                                          | `.papercusp/memory/raw.md` (PG-canonical, Migration 035 dual-write) | `memory/summary.md`, `memory/MEMORY.md` (both PG-canonical via Migration 035), role identity files (PG-mirrored via Migration 041)                                                                                                                                                                                                                                                                                                                                                                                                     |
| **documenter**        | on `DONE` (`TRIGGER=done`)                                                                                                                                                                                                                 | feature docs, issues, summary                                       | per-harness docs dir                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **ui-qa**             | invoked **automatically by run.sh:2105** post-worker, when feature has any `VAL-UI-*` claim AND `verdict` CLI is on PATH (NOT via `NEXT_TESTER`)                                                                                           | `auto_screenshot_post_worker` output                                | `UIQA_PASS`/`UIQA_FAIL` line; on fail, run.sh sets feature status `failing`                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **crosscheck**        | invoked from run.sh:2040 inside the validator handler when `config.crosscheck.enabled = true` (currently bash-only — TS port doesn't fire it)                                                                                              | feature claims                                                      | second-opinion verdict line                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **security-reviewer** | `NEXT_SECURITY`                                                                                                                                                                                                                            | code diff for feature                                               | security verdict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

**Out-of-loop roles (invoked by operator code, not by the main loop):**

| Role                         | Invoked by                                                                    | Notes                                                                      |
| ---------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **architect** (chat surface) | `runClaudeChat` from `/api/harness/<slug>/architect/chat` (`harness.ts:5259`) | conversational variant of the in-loop architect role                       |
| **scanner**                  | `runClaudeChat` from `/api/agent-mcp/operator-scan`                           | OS-level workspace scan; writes suggestion JSON cards back to the operator |
| **project\_manager**         | `apps/operator/lib/pm-dispatch.ts` on `pm_due` events                         | scheduled spec-revision proposals                                          |
| **expert**                   | `apps/operator/lib/expert-dispatcher.ts` (POST `/:slug/experts/dispatch`)     | one-shot autonomous role dispatched from the /experts panel                |

**Roles with prompt files but no live invocation path** (verify before relying on them):

| Role                                     | Status                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **infra-reviewer**                       | Live, but only via the **expert** path (not in main-loop). Has `prompts/infra-reviewer.md` + `prompts/infra-reviewer.role.json` registering it with the role-registry. Reachable via human dispatch (`POST /:slug/experts/dispatch` → `experts.ts:411` → `dispatchExpert`) or auto-trigger (`expert-triggers.ts` on configured `role.alwaysFireOn` events). The scoper prompt recommends it as a consultant for infra-touching changes. |
| **summarizer**                           | `NEXT_SUMMARIZER` is in `DECISION_VERBS` but lacks a switch case in main-loop.ts — falls to default and exits 4. Prompt file exists but the verb is effectively dead.                                                                                                                                                                                                                                                                   |
| **feedback**                             | prompt file exists but `agent-chats.ts:73` explicitly excludes it (`if (role === 'feedback') return false`). Likely a dead role from an earlier design.                                                                                                                                                                                                                                                                                 |
| **tester**, **test-writer**, **monitor** | Phase-scoped. Invoked from `main-loop.ts` via `handleSimpleInvoke(...)` for `NEXT_TESTER` / `GENERATE_TESTS` / `NEXT_MONITOR`. Prompts at `prompts/testing/{tester,test-writer}.md` and `prompts/production/monitor.md` — resolve only when `config.json#phase` matches. No root-level fallback, so invocation outside the matching phase fails at prompt-resolve. The staging-phase orchestrator is unlikely to emit these verbs.      |

`identity/<role>.md` files (cross-mission) are maintained by the curator across runs. PG-mirrored to `harness_shared.identity_files` (Migration 041) by `apps/operator/lib/identity-files-watcher.ts`; the operator UI's IdentityPanel reads PG, but the orchestrator subprocess at `prompt-build.ts:87` still reads the file directly per role contract.

***

## Stage 4 — Live monitoring (parallel to Stage 3)

While the loop runs, the operator UI surfaces live state:

| UI surface                                | Code                                                 | Data source                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **HarnessDashboard** at `/harness/<slug>` | `app/harness/HarnessDashboard.tsx`                   | Six Zero subscriptions: `features<HarnessName>.all` (e.g. `featuresSheets.all`) for the work queue, `agentRuns<HarnessName>.all` (reads per-harness `agent_runs`), `proposalsShared.byHarness` (cross-harness `harness_shared.harness_proposals_shared`), `harnessStatus.byHarness`, `pendingReviews.byHarness`, `harnessLanes.byHarness`. Sub-components subscribe further (IssuesList → `issues<HarnessName>.all`, SnapshotsPanel → `snapshots<HarnessName>.all`). |
| **Run log tail**                          | rendered inside `HarnessDashboard.tsx` (\~line 2509) | SSE: `GET /api/harness/:slug/log/stream?phase=…&tail=500` (route at `harness.ts:1809`) — streams structured events from `.papercusp/logs/run.log.jsonl`. (A separate `GET /:slug/stream` at `harness.ts:1654` tails the plain `run.log` text — used by other surfaces, not the dashboard.)                                                                                                                                                                           |
| **Plan review banner**                    | `app/harness/PlanReviewBanner.tsx`                   | `GET /:slug/plan-review` (file content) + `GET /:slug/plan-review/sse` for change events                                                                                                                                                                                                                                                                                                                                                                             |
| **Proposals panel**                       | `app/harness/ProposalsPanel.tsx`                     | Zero query `proposalsShared.byHarness` reading `harness_shared.harness_proposals_shared` (cross-harness shared table — NOT per-harness). Accept/reject via `POST /:slug/proposals/:id/accept` and `POST /:slug/proposals/:id/reject`                                                                                                                                                                                                                                 |
| **Issues list**                           | `app/harness/issues/IssuesList.tsx`                  | Zero query `issues<HarnessName>.all` (camelCase per-harness, e.g. `issuesSheets.all`, `issuesOrgRd.all`)                                                                                                                                                                                                                                                                                                                                                             |
| **Feature list**                          | `app/harness/FeatureList.tsx`                        | Zero query `features<HarnessName>.all` (camelCase per-harness, e.g. `featuresSheets.all`) — canonical UI read path post-2026-04-27 PG migration                                                                                                                                                                                                                                                                                                                      |
| **Recent agents**                         | dashboard panel                                      | Zero query `agentRuns<HarnessName>.all` (e.g. `agentRunsSheets.all`); reads per-harness `agent_runs` (no `harness_` prefix)                                                                                                                                                                                                                                                                                                                                          |
| **Snapshots panel**                       | `app/harness/SnapshotsPanel.tsx`                     | Zero query `snapshots<HarnessName>.all`                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Recent actions popover**                | chrome-mounted `RecentActionsCenter`                 | Zero query `userActions.byHarness` (or REST poll fallback off-/harness routes; see `OperatorActionLog.tsx`)                                                                                                                                                                                                                                                                                                                                                          |
| **Oracle dock**                           | `app/_components/OracleDock.tsx`                     | global concierge — runs `runClaudeChat` with the Oracle MCP server attached, can navigate / dispatch agents / list chats                                                                                                                                                                                                                                                                                                                                             |

### Human in the loop, optional

The user can intervene at any iteration without stopping the loop:

* **Edit features manually** via `FeatureEditor` — `PATCH /:slug/features/<id>` (writes PG directly).
* **Edit SPEC.md or validation-contract.md** — agents pick up the change on next iteration.
* **Trigger /replan** — `POST /:slug/replan` (harness.ts:3321) records a `replan` user\_action and kicks off `invokeScoperBackground(project, 'replan')`. *Note: a duplicate handler at harness.ts:3654 with backup-on-overwrite semantics is unreachable (Hono dispatches the first registration); treat as latent dead code.*
* **Accept/reject proposals** — `POST /:slug/proposals/:id/accept` and `POST /:slug/proposals/:id/reject` (architect / scoper proposed changes await human approval).
* **Dispatch experts** via `/experts` panel — `POST /:slug/experts/dispatch` calls `expert-dispatcher.ts:dispatchExpert()` which runs a one-shot autonomous role outside the main loop, lockfile-guarded, recorded as a user\_action row.
* **Inter-agent messages** are stored in the per-harness `messages` table (created by the schema template), not as on-disk files.

***

## Stage 5 — Completion

The orchestrator emits `DONE` when every feature in `harness_features` has status `passed` and validation-contract.md acceptance has been demonstrated.

`handleDone()` (`main-loop.ts:342`, with bash equivalent in run.sh) runs in this order:

1. **Smoke-test gate** — if `config.smokeTest.enabled` AND `smokeTest.onDone`, run the configured smoke test (a bash script).
   * On **pass**: fires the `on-smoke-pass` user hook, then continues to step 2.
   * On **fail**: fires `on-smoke-fail`, returns `{terminal: false, reason: 'idle'}` (TS) / `continue`s the loop (bash) — **steps 2–6 below are SKIPPED** in this case. No feature is "reopened"; the orchestrator just gets another iteration to decide what to do next.
2. **Curator** — `invoke('curator', TRIGGER=done)` — distils the run's `memory/raw.md` into `memory/summary.md` and updates per-role `identity/<role>.md` cross-mission notes.
3. **Documenter** — `invoke('documenter', TRIGGER=done, FEATURE_ID=-)` — generates user-facing docs for the project.
4. **(Optional, bash only) Scoper in proposal mode** — if `config.proposals.enabled` AND `config.proposals.afterDone` (or legacy `product.enabled` / `product.triggerOnDone`): `invoke('scoper', MODE=proposal)` to propose next-phase features. Reviewer can auto-approve via `proposals.autoApply` (default true). The TS port skips this — see `main-loop.ts:390` ("Skipping optional scoper-on-done + archive-on-done — minor polish.").
5. **(Optional, bash only) Archive-on-done** — if `config.archiveOnDone=true`: `tar czf .papercusp/archives/<unix-ts>-done.tar.gz -C $STATE_DIR --exclude=archives .`. TS port skips this.
6. **Plugin lifecycle** — *(updated 2026-06-12, plugin-system-pot-port P-006)* the DBOS finalizer fires the in-process typed hook `firePluginLifecycle('afterDone', …)` and emits the `pipeline:done:<slug>:<feature>` event; the old `firePluginHook` shell-out via the `papercusp-fire-hook` CLI is retired, as is the addAction/addFilter event bus — plugins subscribe via event-reaction rules (`reactions` in the manifest/SDK).

   Live plugin set in `libs/papercusp/plugins/` and their event subscriptions:

   | Plugin                                                        | Event subscriptions                                                                                                                             |
   | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
   | `@papercupai/cloudflare-pages`                                | `mission-done` → publishes to Cloudflare Pages                                                                                                  |
   | `@papercupai/jira-sync`                                       | `feature-passed`, `feature-failed`, `proposal-accepted`, `mission-done`                                                                         |
   | `@papercupai/linear-sync`                                     | same four as jira-sync                                                                                                                          |
   | `@papercupai/notion-export`                                   | `mission-done` (action: `exportMission`)                                                                                                        |
   | `@papercupai/slack-notifier`                                  | `mission-done`, `action-failed`                                                                                                                 |
   | `starlight`, `pi-coding`, `postgres-manager`, `vscode-server` | none — UI tabs / manual actions only (the docs-tab plugin is `starlight`, at `libs/papercusp/plugins/starlight`; there is no `fumadocs` plugin) |

   *briefings is not a plugin* — it's a separate app in a separate internal project; the `afterDone` hook can't reach it directly.
7. **Notify** — `notify_event('done', 'Mission complete: all features passed after N iterations')`.
   * TS (`log.ts:33`): appends `[ts] body` to `<eventsDir>/done.log` and writes `EVENT done: …` into run.log.
   * Bash: runs `$NOTIFY <kind> <message> <project-dir>` if `$NOTIFY` is set (e.g. `pushnotify`, `slack-send`); otherwise just logs.
   * Neither path posts to an operator notification API. No notification card auto-appears in the UI.
8. **Exit 0.**

The operator's harness page reflects completion via Zero subscriptions to `harness_features` (all rows now `status='passed'`), `agent_runs` (final curator/documenter rows visible), and `userActions` (any `mission.done`-related user\_action rows the operator wrote separately).

***

## Failure / escalation paths

Any of these can short-circuit the happy path:

| Path                         | Trigger                                                                                                                          | Effect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Plan rejected**            | reviewer writes `VERDICT: reject` in plan-review\.md                                                                             | Pre-loop exits 7 with reason "plan-rejected"; user must edit SPEC.md and re-launch                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Stuck feature**            | feature `attempts >= debugger.threshold` (default 3); after debugger fires once, further failures lead to architect/escalate     | Orchestrator emits `NEXT_ARCHITECT` for replan, or eventually `ESCALATE`                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **ESCALATE**                 | orchestrator decision after exhausting options                                                                                   | LLM writes `.papercusp/escalation.md` (per orchestrator.md §E), then prints `ESCALATE <reason>`. handleEscalate fires `on-escalate` hook, runs curator (`TRIGGER=escalate`), notify\_event, exits 3. The **supervisor cron** (`bin/supervisor.sh`, suggested `0 */6 * * *`; user owns the actual crontab) wakes periodically, reads escalation.md + recent logs, decides: unblock / expand spec / ping human. *Note: escalation.md is also written system-side by run.sh:1620 / pre-loop.ts:87 on plan-reviewer reject — that path exits 7, not 3.* |
| **Cost cap exceeded**        | `cost-cap.ts` (or `run.sh:check_cost_cap`) sums each `.jsonl`'s last `total_cost_usd` per iteration; exceeds `config.maxCostUsd` | Clean **exit 6** (not SIGTERM); `notify_event cost-cap` fires. Soft warn at `config.maxCostUsdWarnThreshold` \* cap (default 0.8, dedup'd by `.papercusp/.cost-warn-fired` papercup). Optional `config.maxCostUsdAutoPause=true` SIGSTOPs the process at warn threshold; `/api/harness/<slug>/unpause` SIGCONTs it.                                                                                                                                                                                                                                 |
| **Timeout**                  | per-role `config.timeouts.<role>` exceeded                                                                                       | invoke() returns rc=124; orchestrator treats as failure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Smoke test fails on done** | `smokeTest.onDone` script exits non-zero                                                                                         | Feature reopens, loop continues                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Manual stop**              | user kills the process or hits "Stop" in UI                                                                                      | `POST /:slug/stop` walks `/proc`, matches processes whose cwd starts with `project.path` AND whose cmdline contains `autonomous-harness/run.sh` or `/harness/run.sh`, then SIGTERMs each                                                                                                                                                                                                                                                                                                                                                            |

***

## State summary — what lives where

### Postgres (canonical, queryable)

Per-harness compatibility namespace:

* A registered harness may have a harness\_\<slug> schema, but its relations are auto-updatable VIEWs over shared consolidated tables, not physical per-harness tables.
* The live helper packages/operator-core/lib/scaffold-harness-schema.ts creates the schema and views for features, issues, runs, snapshots, chats, supervisor notes, directive summaries, and executed actions. It deliberately does not mint retired config-token, proposals, or new messages relations.
* Canonical entity data lives in harness\_shared.\*\_consolidated tables keyed by harness\_slug. Schema changes belong in numbered migrations under libs/papercusp/libs/db/sql/; do not add runtime DDL or resurrect the deleted template.

Cross-harness shared schema `harness_shared`:

* `delegates` — Claude/agent conversation sessions for the voice layer + Oracle dock (column `agent_backend` distinguishes claude-code vs omp post-Wave-3 of the omp routing migration)
* `user_actions` — user-initiated long-running actions. Actual `kind` values in code (verified by grep over `recordUserAction(slug, '<kind>'` calls): `replan`, `cleanup` (both in `harness.ts`), `snapshot.create` / `snapshot.publish` / `snapshot.fork` (snapshots routes), `branch.action` (branch action-run route), `expert.dispatch` (`expert-dispatcher.ts:154`). No `plugin.install` kind exists today, despite older comments referencing it. (The `consolidate` kind was retired alongside the route — `cleanup` covers the intent.)
* `harness_proposals_shared` — **proposals live here**, NOT in a per-harness `harness_proposals` table. Single shared table; ProposalsPanel reads `proposalsShared.byHarness(slug)`.
* The shared consolidated tables are the canonical cross-harness stores; queries filter by harness\_slug instead of UNIONing physical per-harness tables.
* harness\_features\_consolidated and the other \**consolidated tables are base tables. Compatibility views under harness*\<slug> select from them; there is no per-harness trigger mirror to maintain.
* The zero\_harness publication, where still used by a legacy consumer, publishes canonical shared tables. New schema changes are migrations, not per-harness publication edits.

All UI reads go through Zero-synced named queries (`libs/zero-harness/src/queries.ts`),
which subscribe to the publication `zero_harness` on the `papercusp` Postgres database.

### Filesystem (transient + append-only blobs)

Most per-project text/structured artifacts have been pulled into Postgres. The on-disk file is retained as a dual-written mirror because the orchestrator subprocess (run.sh / TS main-loop) reads role contracts directly from disk per the role-prompt files in `libs/papercusp/packages/harness/prompts/`. Operator UI code reads PG.

**Storage policy reference:** `/internal/docs/system/storage-policy` documents the PG-by-default rule and the dual-write pattern.

`.papercusp/` per-project — by category:

**PG-canonical, file mirror (operator UI reads PG; orchestrator/curator subprocess reads the file):**

| File                                                                     | PG location                                                                                                                                                                                                                                    | Migration |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `config.json`                                                            | `harness_shared.harness_project_files.config`                                                                                                                                                                                                  | 034       |
| `validation-contract.md`                                                 | `harness_shared.harness_project_files.contract`                                                                                                                                                                                                | 034       |
| `brainstorm.md`, `brainstorm.canvas.json`, `brainstorm.mindmap.json`     | `harness_shared.harness_brainstorm` (content / canvas / mindmap columns)                                                                                                                                                                       | 033       |
| `memory/raw.md`, `memory/summary.md`, `memory/MEMORY.md`                 | `harness_shared.harness_text_artifacts` (rel\_path key)                                                                                                                                                                                        | 035       |
| `issues.md`                                                              | `harness_shared.harness_text_artifacts`                                                                                                                                                                                                        | 035       |
| `escalation.md`                                                          | `harness_shared.harness_text_artifacts`                                                                                                                                                                                                        | 035       |
| `supervisor-notes.md`                                                    | `harness_shared.harness_text_artifacts` (Migration 035, round 18 dual-write fix). Also mirrored to `harness_shared.harness_escalations.supervisor_notes` column by `harness-fs-watcher.ts` for the operator's escalations panel (legacy view). | 035       |
| `prompts/<role>.md`, `worker-log.md`, etc. (any free-form text artifact) | `harness_shared.harness_text_artifacts`                                                                                                                                                                                                        | 035       |

The `.papercusp/config.json` notes the phase/dept/models/timeouts/smokeTest/branchIsolation/checkpoints/autoScreenshot/debugger-threshold/cost-cap settings. **Plugin enables are NOT here** — those live at `~/.papercusp/harnesses/<slug>/enabled-plugins.json` (CLI-authoritative) and mirror to `harness_shared.plugin_enables` via `plugin-enables-pg.ts`.

**File-canonical, PG-mirrored (the file is the source of truth for the worker; PG mirror serves operator UI):**

| File                   | PG mirror                                 | Mirror mechanism                                                                                |
| ---------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `plan-review.md`       | `harness_shared.harness_plan_review`      | `harness-fs-watcher.ts`                                                                         |
| `pending-issues.jsonl` | `harness_shared.harness_pending_issues`   | fs-watcher; ids without explicit `id` synthesized as `PENDING-<n>` to match the operator reader |
| `issues.json`          | per-harness `harness_issues` table        | `syncIssuesToPg` called by every operator-side write                                            |
| `proposals/<id>.md`    | `harness_shared.harness_proposals_shared` | fs-watcher (mirror 6 in `harness-fs-watcher.ts`)                                                |

**Largely retired (legacy fallback only):**

* `features.json` — scoper + validator prompts migrated 2026-05-01 to the `/api/harness/<slug>/features/import` and `/features/<id>` PATCH endpoints. run.sh keeps a legacy "features.json → psql" import shim for back-compat. Snapshots may still include this file in their tarball for restore parity.

**File-only by design (legitimate file usage per the storage policy):**

* `events/<eventName>.log` — append-only log per event-kind (`done`, `escalate`, `cost-cap`, `cost-warn`, `checkpoint`, `max-iter`, etc.). Written by `notifyEvent`/`notify_event`. Per-event files keep the body separately from `logs/run.log` so a downstream supervisor can grep for events of one kind without scanning the full log.
* `.cost-warn-fired` — papercup file (zero-byte) created the first time the soft cost-cap warn fires this mission; prevents duplicate warns on subsequent iterations. (O\_EXCL-style papercup — file existence is the contract.)
* `experts/runs/<safeName>-ua-<userActionId>.log` — expert run output. `safeName` is the role id with `:`, `/`, and `@` replaced by `_` (matters for plugin-contributed roles like `@scope/role:variant`); `userActionId` is the row id from `user_actions` created at dispatch time (`expert-dispatcher.ts:158`).
* `logs/run.log` — plain-text append-only iteration log written by `log()` in both run.sh + orchestrator's `log.ts`. The legacy SSE `/:slug/stream` endpoint tails this; the dashboard does not.
* `logs/run.log.jsonl` — structured-event log written by run.sh (path defined at run.sh:143 as `LOG_JSONL`). The dashboard's run-log panel tails this via `/:slug/log/stream` (harness.ts:1809). Rotated to `run.log.jsonl.<N>.gz` at `PAPERCUSP_LOG_ROTATE_BYTES` threshold.
* `logs/<runId>.{jsonl,out,err,prompt.md}` — per-invocation stream-json log, extracted final assistant text (parsed by orchestrator for next decision), stderr capture, and (omp only) the assembled prompt.
* `snapshots/<id>.tar.gz` — snapshot tarballs (paths.ts:38-46). Read via `readManifestFromTarball` (snapshot-discovery.ts:101). Per-capture scratch at `.papercusp/snapshot-staging/`. Metadata in `harness_snapshots` PG table.
* `archives/<ts>-done.tar.gz` — `.tar.gz` of state-dir snapshots created on `archiveOnDone` (run.sh:1820); read by the operator's archives panel.
* `screenshots/<feature-id>-<unix-ts>.png` — auto-captured by `auto_screenshot_post_worker` (run.sh:848-868) when `config.autoScreenshot.enabled=true` AND `autoScreenshot.url` is set AND `verdict` CLI is on PATH. Keyed on feature ID + timestamp.
* `worktrees/<feature-id>/` — per-feature git worktrees if branch-iso enabled.
* `debug/<fid>.md` — debugger one-shot marker; presence prevents the debugger from re-firing on the same feature.

`SPEC.md` lives at the project root, not in `.papercusp/`. It's the user-authored intent file. Now PG-canonical in `harness_shared.harness_project_files.spec` (Migration 034); the file mirror is dual-written for editor convenience and so the worker subprocess can read it.

### User registry + global config

* `<workspace-root>/registry.json` — per-workspace slug → path registry (read by every API route via `loadRegistry()` in `apps/operator/lib/harness-registry.ts`). Bootstrap-class file (needed before PG is reachable). `~/.restart-harness-projects.json` is a legacy global file written only by the CLI for transition compat; operator code ignores it.
* `~/.papercusp-workspaces/<workspaceId>/.papercusp/` — per-workspace operator state (credentials, oracle config, agent config, plugin configs, plugin data).
  * **Credentials** (operator API keys, voice creds, marketplace tokens, publish creds, trust store) are PG-canonical in `harness_shared.operator_*` tables and **encrypted at rest** via pgcrypto (Migration 027 + 028).
  * **Plugin OAuth tokens** at `~/.papercusp/harnesses/<slug>/plugin-configs/<plugin>.json` are file-canonical because the substrate plugin loader reads them synchronously and cannot decrypt; the PG mirror at `harness_shared.plugin_configs` is encrypted (Migration 039), and the on-disk file is mode 0600.
  * **Most other operator state** (operator\_credentials, operator\_voice\_credentials, operator\_paused, oauth\_nonces, mobile\_pair\_tokens, operator\_rate\_limit, cooldown\_marks, profile state) lives in PG; see `/internal/docs/system/storage-policy` for the full list.
* `~/.papercusp-workspaces/registry.json` — active workspace selection (bootstrap).
* `~/.papercusp/db-encryption-key` — symmetric key (32 random bytes, base64, mode 0600) for the pgcrypto encryption-at-rest. Override via `PAPERCUSP_DB_ENCRYPTION_KEY`.
* `<papercuspRoot>/agent/config.json` — agent backend selection (claude-code | omp | auto), custom command, per-role model overrides; written by `/settings/agent` UI.

***

## Cleanup of ephemeral state

Several tables hold "this thing is happening right now" state that has to disappear when it's no longer true. Two distinct mechanisms handle this, split by signal kind.

### TTL-based: `apps/operator/lib/expirable-registry.ts`

For state with a clear "lease until" semantic. Writers set `expires_at` on every write; the registry runs a single 30-second sweep loop that DELETEs (or in `harness_status`'s case, flips status to `stalled`) any row whose `expires_at` is in the past. One `setInterval`, declarative registrations, no per-table sweep code.

Registered tables (manifest at `expirable-registrations.ts`):

| Table                                | Lease                          | On expire                                           | Notes                                                                      |
| ------------------------------------ | ------------------------------ | --------------------------------------------------- | -------------------------------------------------------------------------- |
| `harness_shared.operator_scan_locks` | 60s                            | delete                                              | Was lazy-deleted on next acquire; now also actively reaped                 |
| `harness_shared.operator_claims`     | 90s                            | delete                                              | Previously had no sweeper at all — accumulated until manually overwritten  |
| `harness_shared.harness_status`      | 5min, refreshed each iteration | mark-status `running`→`stalled`, write `updated_at` | unix-ms `expires_at` column populated by `POST /:slug/orchestrator/status` |
| `papercusp_auth.magic_link_requests` | per-row, unix-ms               | delete                                              | 15-min auth tokens                                                         |
| `papercusp_auth.sessions`            | per-row, unix-ms               | delete                                              | 30-day sessions, hourly cadence (no rush)                                  |

Adding a new TTL table: schema gets `expires_at`, writers compute `now() + lease`, one `registerExpirable()` line. No new sweep code, no new interval, no new file.

Future migration: when pg\_cron is installed, each registered sweep becomes one `pg_cron.schedule(...)` call; writers don't change.

### PID-liveness: `apps/operator/lib/harness-status-sweep.ts`

For state owned by a long-running process where TTL would force a heartbeat. Run.sh's `pg_write_lane` records the PID; the sweeper drops rows whose recorded PID no longer exists in `/proc`. Used for:

* `harness_shared.harness_lanes` — per-iteration lane state. Workers can run an hour+ on a single invoke; PID-based liveness means no bash heartbeat plumbing needed.
* per-harness `agent_runs.running` — same reasoning; the sweeper flips `running=false` when the recorded PID is gone.

Lanes also have a 24h age fallback for legacy rows that pre-date PID capture. As long as a row has a PID and that PID is alive, it's not swept regardless of age.

### What goes where

The split rule: **TTL when there's a clear lease and the writer can refresh on its own cadence; PID-liveness when the writer is a long-running process that already exists in `/proc`.** Filesystem-paired tables (the 20+ DELETE statements in `harness-fs-watcher.ts`) are a third category — the file is the source of truth and chokidar handles cleanup; not a sweep at all.

***

## Where to look for X

| If you want to understand…                           | Read this                                                                                                                                                                                                                                             |
| ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The orchestrator decision verbs                      | `libs/papercusp/packages/orchestrator/src/decision-parse.ts`                                                                                                                                                                                          |
| The live per-feature dispatch loop                   | `packages/operator-core/lib/dbos/orchestrator-workflow.ts` (`deriveNext` over the `coding-factory` blueprint spine)                                                                                                                                   |
| The global dispatcher (selects work)                 | `packages/operator-core/lib/dbos/orchestrator-loop.ts`                                                                                                                                                                                                |
| Terminal finalization (curator/documenter/afterDone) | `packages/operator-core/lib/dbos/orchestrator-finalize.ts`                                                                                                                                                                                            |
| The decision classifier (oracle, not live router)    | `packages/operator-core/lib/dbos/orchestrator-decide.ts` (`classifyDecision` — retained for `derive-next-equivalence.test.ts`)                                                                                                                        |
| How an agent gets spawned                            | `libs/papercusp/packages/orchestrator/src/invoke.ts` and `libs/papercusp/packages/harness/run.sh:invoke()`                                                                                                                                            |
| Pre-loop bootstrap                                   | `libs/papercusp/packages/orchestrator/src/pre-loop.ts:runPreLoop`                                                                                                                                                                                     |
| What happens on DONE                                 | `libs/papercusp/packages/orchestrator/src/main-loop.ts:handleDone` (line 342)                                                                                                                                                                         |
| Role prompts                                         | `libs/papercusp/packages/harness/blueprints/base/prompts/<role>.md` (the old `packages/harness/prompts/` dir is retired)                                                                                                                              |
| Blueprints catalog                                   | `libs/papercusp/packages/harness/blueprints/` (\~46 spines: `coding-factory`, `research`, `audit`, `migration`, `dist-*`, …)                                                                                                                          |
| Cross-mission identities                             | `libs/papercusp/packages/harness/identity/<role>.md` (file-canonical for orchestrator subprocess; PG-mirrored to `harness_shared.identity_files` via Migration 041 for operator UI reads)                                                             |
| All API routes                                       | `apps/operator/app/api/_hono/harness.ts` (mostly), `apps/operator/app/api/agent-mcp/*` (operator-scan, delegate-chat, agent-config), `apps/operator/app/api/agent-config/*` (settings)                                                                |
| Chat-stream backend                                  | `apps/operator/lib/claude-chat-stream.ts` (operator wrapper) → `libs/papercusp-shared/src/agent/chat-stream.ts` (shared runtime)                                                                                                                      |
| Schema + Zero queries                                | `libs/zero-harness/src/{schema,queries}.ts`                                                                                                                                                                                                           |
| Per-harness PG compatibility views                   | packages/operator-core/lib/scaffold-harness-schema.ts                                                                                                                                                                                                 |
| Plugin lifecycle                                     | `packages/operator-core/lib/plugin-host-runtime.ts` (`firePluginLifecycle` + `ServerActionRegistry` + plugin reaction-rule registration; the orchestrator-side `plugin-hooks.ts` shell-out and the `papercusp-fire-hook` CLI were retired 2026-06-12) |
| Cleanup of ephemeral state                           | `apps/operator/lib/expirable-registry.ts` (TTL) + `apps/operator/lib/harness-status-sweep.ts` (PID-liveness); declarative manifest at `apps/operator/lib/expirable-registrations.ts`                                                                  |

***

## Caveats — what's currently in flux

These reflect known in-progress migrations as of 2026-05-06; expect them to drift:

* **`features.json` is mostly retired.** UI reads from PG; the **scoper** (2026-05-01) and **validator** prompts have both been migrated to the API (`/api/harness/<slug>/features/import` and `/features/<id>` PATCH respectively). run.sh's "features.json → psql" import shim still works as a legacy fallback for any agent prompt that hasn't been migrated, but the file is no longer the canonical write path.
* **TS orchestrator port is feature-flagged off** (`PAPERCUSP_USE_TS_ORCHESTRATOR=1`); bash `run.sh` is the default. The TS port covers Stage 5a parallel-lane + competition workers, but is **not** a strict superset of bash — known divergences:

  * TS doesn't recognize `NEXT_EXPERT` / `NEXT_FEEDBACK` / `NEXT_SCOPER` (3 bash-only verbs).
  * TS recognizes `NEXT_PROJECT_MANAGER` / `NEXT_SUMMARIZER` in DECISION\_VERBS but has no switch case (exit 4); bash doesn't recognize either.
  * `crosscheck` fires only in bash.
  * TS fires plugin lifecycle hooks `onLoad` / `onUnload`; bash doesn't.
  * TS `state.ts:featuresExist` reads `features.json` on disk (legacy); bash `features_exist()` queries `harness_features` PG (canonical post-2026-05-01).

  For harnesses that lean on `NEXT_EXPERT` etc., TS will silently drop those decisions — backend choice matters.
* **`claude-code` is the default backend**, not `omp` (`DEFAULT_CONFIG.backend` in `packages/operator-core/lib/agent-config.ts`; defaulting to `omp` was reverted per Owner ask 2026-06-18). `effectiveBackend()` returns the configured backend as-is and only resolves the explicit `'auto'` setting to `omp`; the dead legacy `launchRun` stub still defaults `AGENT_CMD` to `'omp -p'`. A third backend, **`codex`**, also exists. `/settings/agent` lets you flip per-workspace (`claude-code` / `omp` / `codex` / `auto`).
* **Doc files in this tree may be stale.** Several mention `features.json` as the canonical source — that's no longer true. Trust this lifecycle doc + the code over older specs.
* **Storage policy supersedes earlier "files everywhere" wording.** As of 2026-05-07, durable mutable state defaults to Postgres; files remain only for bootstrap, code/contracts, locks/papercups, append-only logs, and substrate-read contracts (where the orchestrator subprocess needs to read directly). See `/internal/docs/system/storage-policy` for the full rule.
* **Voice tool aliasing.** `delegate_to_claude` and `delegate_to_agent` both map to the same handler (Wave 3 of the omp migration); EL agents may reference either name.

For a one-page summary of recent migrations and their commit hashes, see
`/home/dev/.claude/projects/-tmp/memory/project_omp_routing_migration.md`
and `/home/dev/.claude/projects/-tmp/memory/project_filesystem_to_pg_migration.md`.
