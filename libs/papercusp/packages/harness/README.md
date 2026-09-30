# Autonomous 3-Agent Harness

A minimal harness that keeps coding agents iterating on a project without human
intervention, based on the Anthropic Mar 2026 ("Harness design for long-running
application development") and Factory.ai Apr 2026 ("How Missions Work")
architectures.

Four roles, each invoked with a **fresh context** via the agent CLI (default `omp -p` via Meridian + Claude Max; `claude -p` when `AGENT_BACKEND=claude-code`):

| Role | Role file | When it runs | What it decides |
|------|-----------|--------------|-----------------|
| **Planner** | `prompts/planner.md` | Once, at start | Writes `validation-contract.md` + `features.json` from `SPEC.md` |
| **Worker** | `prompts/worker.md` | Every iteration when a `todo`/`failing` feature exists | Implements the feature, writes tests first, commits |
| **Validator** | `prompts/validator.md` | Every iteration when a `validating` feature exists | Runs the assertions black-box, files bugs, sets status `passed` or `failing` |
| **Orchestrator** | `prompts/orchestrator.md` | Every iteration | Picks what to do next: `NEXT_WORKER`, `NEXT_VALIDATOR`, `CONVERTED`, `DONE`, `ESCALATE` |

A fifth role, the **Supervisor** (`bin/supervisor.sh`), runs periodically via
cron. It reviews progress without touching code and only pings you when the
harness is genuinely stuck.

## Quickstart

```bash
# 1. Go to your project
cd ~/my-project

# 2. Seed a spec file
cp ~/autonomous-harness/templates/SPEC.md.template ./SPEC.md
$EDITOR SPEC.md    # fill in Goal, Scope, Acceptance bar

# 3. Run the harness (foreground)
~/autonomous-harness/run.sh

# Or run in the background (tolerates terminal close):
nohup ~/autonomous-harness/run.sh > /tmp/harness.log 2>&1 &
```

## State layout (created in each project as `.papercusp/`)

```
.papercusp/
├── validation-contract.md   # Binding acceptance criteria (planner output)
├── features.json             # Work queue with status + attempts
├── issues.md                 # Append-only bug reports from validator
├── worker-log.md             # Last worker's handoff notes
├── knowledge.md              # Accumulated learnings (optional, validator-curated)
├── supervisor-notes.md       # Any nightly supervisor nudges
├── escalation.md             # Created when harness gives up
└── logs/
    ├── run.log               # Per-iteration log
    └── <run-id>.out/.err     # Each agent invocation's raw I/O
```

## Why fresh contexts per role?

From Anthropic's Mar 2026 post:

> When asked to evaluate work they've produced, agents tend to respond by
> confidently praising the work — even when, to a human observer, the quality
> is obviously mediocre. [...] Separating the agent doing the work from the
> agent judging it proves to be a strong lever.

And the dual failure mode:

> Irrelevant context accumulates. [...] Adversarial context accumulates. An
> agent that implemented something is worse at objectively evaluating its own
> work than a fresh, unbiased reviewer.

Every invocation of a role starts with the agent CLI (`omp -p` or `claude -p`)
+ the role prompt + pointers to state files. No shared context. Agents
communicate through `.papercusp/*.md`.

## Configuration knobs

```bash
AGENT_CMD="omp -p"                    # invocation template (default; set to "claude -p" or any wrapper)
MAX_ITERATIONS=200                    # safety cap; bumps cost to infinity otherwise
ITERATION_SLEEP=2                     # seconds between iterations
NOTIFY="push-notify-cmd"              # called on mission events: done, escalate, cost-cap, max-iter
```

## Per-role configuration (`.papercusp/config.json`)

Optional per-project config. Missing file → current behavior for all roles.

```json
{
  "models": {
    "scoper":       "opus",
    "worker":       "sonnet",
    "validator":    "opus",
    "orchestrator": "haiku",
    "reviewer":     "opus"
  },
  "promptOverrides": {
    "validator": "Be EXTRA paranoid. Reject anything that isn't fully tested with explicit RUN evidence.",
    "worker":    "./prompts/worker-override.md"
  },
  "snapshotRetention": 50,
  "maxCostUsd": 10.00,
  "timeouts": {
    "worker": 900,
    "validator": 600,
    "orchestrator": 120,
    "scoper": 300,
    "reviewer": 300
  },
  "branchIsolation": {
    "enabled": true,
    "baseBranch": "main",
    "onPass": "pr"
  },
  "autoScreenshot": {
    "enabled": true,
    "url": "http://localhost:5173"
  },
  "parallelWorkers": {
    "max": 2
  }
}
```

- **`models.<role>`** — passed as `--model <value>` to the agent CLI for that role. Accepts aliases (`opus`, `sonnet`, `haiku`) or full IDs (omp does fuzzy matching; claude wants exact IDs). If `$AGENT_CMD`/`$CLAUDE` env already contains `--model`, user wins.
- **`promptOverrides.<role>`** — **appended** to the role's baseline prompt as a "Droid specialization" section. Three forms:
  - Inline string: used verbatim
  - Relative path (`./...` or ending in `.md`/`.txt`): resolved from `.papercusp/`
  - Absolute path: used as-is
- **`snapshotRetention`** — integer. Keep only the N newest snapshots in `.papercusp/snapshots/`. Default 50. Oldest are pruned after each new snapshot.
- **`logRetention`** — integer. Keep only the N newest agent-run log sets (`.out`/`.err`/`.jsonl` trio per invocation) in `.papercusp/logs/`. Default 500. Oldest are pruned each iteration. `run.log` and hook logs are never pruned.
- **`maxCostUsd`** — float. Aborts the main loop (exit code 6) when the aggregated cost across all `.papercusp/logs/*.jsonl` files equals or exceeds this. Leave unset for unlimited. Checked after each iteration's snapshot.
- **`maxCostUsdWarnThreshold`** — float (default `0.8`). Fraction of `maxCostUsd` at which to fire a one-shot `cost-warn` notification. Lets you see the mission creeping toward the ceiling before hard-exit.
- **`maxCostUsdAutoPause`** — boolean (default `false`). When the warn threshold fires, auto-pause the harness (SIGSTOP on self). Use `/api/harness/:slug/unpause` to resume. Useful for missions where you want the chance to inspect state and decide before hitting the hard cap.
- **`timeouts.<role>`** — integer seconds. Wraps the agent invocation in `timeout <seconds>`. On SIGTERM rc=124 is returned; the main loop keeps going (next iteration picks up). Missing or zero → unlimited. Useful for catching runaway workers faster than the cost cap can.
- **`parallelWorkers.useChunkLoop`** — boolean (default `true` — the canonical worker model). When true, each feature is decomposed by a planner LLM into ordered chunks; each chunk acquires file-level locks, runs in a scratch worktree, passes an L1 typecheck gate, then commits straight to the integration branch. Per-feature branches/worktrees + the synthesizer step are bypassed entirely. On validator rejection, the prior plan is dropped and the planner replans with the validator's complaints in `PRIOR_VALIDATOR_LOG` context. Set to `false` to opt into the synthesizer + branchIsolation path described below.
- **`parallelWorkers.workingStateCheck`** — string (default `"pnpm typecheck"`). Command run in the scratch worktree after each chunk's edits. Non-zero exit triggers re-plan-this-chunk.
- **`parallelWorkers.replanStrikes`** — integer (default `3`). How many typecheck failures on a single chunk before escalating to `escalateToRole`.
- **`parallelWorkers.escalateToRole`** — string (default `"debugger"`). Role invoked when a chunk hits `replanStrikes` typecheck failures.
- **`branchIsolation.enabled`** — boolean (default `false`). **Only applies when `useChunkLoop: false`.** Each worker runs on its own `harness/<FEATURE_ID>` branch checked out off the base. Validator runs on the same branch. Keeps unrelated features from stomping on each other.
- **`branchIsolation.baseBranch`** — string (default auto-detect: `main` → `master`). Base branch that feature branches are cut from and (optionally) merged back to.
- **`branchIsolation.onPass`** — `"merge" | "pr" | "keep"` (default `merge`). What happens when validator passes a feature:
  - `merge` — checkout base, `git merge --no-ff harness/<id>` (creates merge commit)
  - `pr` — `git push -u origin` + `gh pr create`. Requires `gh` CLI authenticated and a GitHub remote. Leaves branch unmerged for human review.
  - `keep` — leave branch unmerged. User merges manually (or via a follow-up hook).
- **`autoScreenshot.enabled`** — boolean (default `false`). When true, after each worker invocation `verdict` captures a screenshot of `autoScreenshot.url` into `.papercusp/screenshots/<FEATURE_ID>-<ts>.png`. Silently no-ops if `verdict` isn't installed.
- **`autoScreenshot.url`** — string. URL to capture (e.g. `"http://localhost:5173"`). Required when `enabled: true`.
- **`planReviewer.enabled`** — boolean (default `true`). When true, runs the `plan-reviewer` role once after the planner. Writes `.papercusp/plan-review.md` with scope challenges, missing assertions, ordering concerns, risk calls, and a verdict. `VERDICT: reject` halts the mission (exit 7) with escalation.md.
- **`debugger.enabled`** — boolean (default `true`). When a feature's `attempts` ≥ `debugger.threshold` (default 3) and no debug notes exist, invoke the `debugger` role before the worker. Debugger writes `.papercusp/debug/<FID>.md` with failing assertion, first divergence, ranked hypotheses, and a recommendation. Worker reads that next attempt.
- **`debugger.threshold`** — integer (default 3). Minimum attempts before debugger fires.
- **`crosscheck.enabled`** — boolean (default `false`). After validator passes a feature, invoke the `crosscheck` role (usually with a different model via `models.crosscheck`) to re-validate. If `CROSSCHECK disagree`, feature is reverted to `failing` and re-queued.
- **`uiQa.enabled`** — boolean (default `false`). After validator passes a feature AND the feature has `VAL-UI-*` claims AND `verdict` CLI is available, invoke `ui-qa` to actually navigate the live app and verify visual/interaction assertions. Screenshots go to `.papercusp/screenshots/`.
- **`uiQa.url`** — string. Base URL the `ui-qa` role visits (e.g. `"http://localhost:5173"`).
- **`wipCheckpoint.enabled`** — boolean (default `false`). During worker invocations, background-commit dirty tree every N seconds with `WIP: <FID> <ts>` messages. Requires `branchIsolation.enabled` (otherwise would pollute main). Use `/ship`-style squash before merge/PR if your downstream flow cares.
- **`wipCheckpoint.intervalSeconds`** — integer (default 300). Seconds between WIP commits.
- **`parallelWorkers.max`** — integer (default `1`). Maximum concurrent workers. When `> 1`, workers run in parallel shell subshells with `.papercusp/lanes.json` tracking live PIDs. **Requires `branchIsolation.enabled: true`** (each concurrent worker must have its own branch — otherwise git conflicts are guaranteed). Validators always run serially; the main loop waits for all worker lanes to drain before invoking a validator.
- **`parallelWorkers.workersPerFeature`** — integer (default `1`). When `> 1`, dispatches that many workers on the SAME feature in sibling git worktrees instead of running 1 worker per feature. After workers commit, the synthesizer reads all candidate diffs and merges them into a single `<fid>-synthesis` worktree, which the validator then certifies. Requires `branchIsolation.useWorktrees: true`.
- **`parallelWorkers.adaptive`** — `{tiers: number[], labels: string[], rubric: string}`. When set, the orchestrator LLM picks N per feature from `tiers` (e.g. `[1, 2, 4]`) based on the rubric. Overrides `workersPerFeature` when present. Requires `branchIsolation.useWorktrees: true`.
- **`parallelWorkers.synthesizeSingle`** — boolean (default `true`). When `true` and only 1 worker dispatched, the synthesizer still runs as a code-review pass that can edit/polish the single worker's draft. Flip to `false` to skip the extra LLM call on N=1.
- **`branchIsolation.useWorktrees`** — boolean (default `false`). Composio-inspired. When `true` with `branchIsolation.enabled`, each feature gets its own `.papercusp/worktrees/<fid>/` filesystem directory instead of switching branches in the main tree. The worker/validator invocations run with cwd set to the worktree. On pass: merge branch + remove worktree; on fail: worktree retained for retry. `git worktree prune` runs at startup to clean up crashed leftovers.
- **`smokeTest.enabled`** — boolean (default `false`). claudecode-orchestrator-inspired service gate.
- **`smokeTest.onDone`** — boolean (default `true`). Run `bin/service-smoke-test.sh` when the orchestrator emits DONE. On failure: reopens the most-recently-passed feature as failing and re-enters the loop.
- **`smokeTest.onFeaturePass`** — boolean (default `false`). Run the smoke test after every validator pass. On failure: reverts the feature to `failing` before running documenter.
- **`smokeTest.urls`** — array of `{ url, expectStatus, expectText? }`. Checked via curl; text match is optional.
- **`smokeTest.startupCmd`** — string. If the first URL isn't responding, run this command in the project dir before checks. Wait up to `smokeTest.startupWaitSeconds` (default 30) for the service to come up.
- **`checkpoints.enabled`** — boolean (default `false`). Hermes-inspired named human-gated pauses. When enabled, the orchestrator can emit `CHECKPOINT <name>` (or run.sh auto-fires types with `triggerOn: "post-planner"` after plan-reviewer passes). The harness writes `.papercusp/checkpoint-<name>.md` and exits rc=8. Grant via UI (`POST /api/harness/:slug/checkpoint/:name/grant`) or `touch .papercusp/checkpoint-<name>.md.granted`; re-run to continue.
- **`checkpoints.types`** — array of `{ name, description, triggerDoc?, triggerOn? }`. `triggerOn: "post-planner"` auto-fires. Others are informational for the orchestrator.

### Cross-mission identity (Agent-Swarm-inspired)

`~/autonomous-harness/identity/<role>.md` — 12 files, one per role (architect, crosscheck, curator, debugger, documenter, orchestrator, planner, plan-reviewer, product, ui-qa, validator, worker). Curator-maintained, append-only. Auto-injected into every role's prompt alongside `.papercusp/memory/summary.md`. Contains patterns the role has learned across ALL missions (MEMORY.md is mission-scoped). No config flag — always on.

Browse the current state via UI: palette → 🧬 Identity, or `GET /api/harness/identity`.

### Worker self-evolution via TRICK: entries (MOLTRON-inspired)

Workers may prefix `.papercusp/memory/raw.md` entries with `TRICK:` to flag patterns for promotion:
```
[2026-04-24T10:05:00Z] worker F-023 TRICK: psql -f drizzle/*.sql applies migrations in filename order
```
Curator promotes TRICK entries to either this mission's MEMORY.md (codebase-specific) or to `identity/worker.md` (generalizable), based on whether the trick mentions codebase-specific paths.

## Mission notifications (`$NOTIFY`)

If the `NOTIFY` env var is set to a shell command, it's invoked on mission milestones as:

```
$NOTIFY <event-kind> <message> <project-dir>
```

Event kinds:
- `done` — all features passed
- `escalate` — orchestrator gave up; see `escalation.md`
- `cost-cap` — `maxCostUsd` exceeded
- `max-iter` — `MAX_ITERATIONS` reached without convergence

Example: fire a desktop notification + ntfy.sh push:

```bash
cat > ~/bin/harness-notify <<'EOF'
#!/usr/bin/env bash
kind="$1"; msg="$2"; proj="$3"
notify-send "Harness: $kind" "$msg" || true
curl -fsS -d "$msg" ntfy.sh/your-topic || true
EOF
chmod +x ~/bin/harness-notify
export NOTIFY="$HOME/bin/harness-notify"
```

Failures of `$NOTIFY` never halt the mission — the run keeps going.

Recommended defaults (what we run Sheets with): Opus for planner + validator (quality-critical), Sonnet for worker (fires most often), Haiku for orchestrator (one-line decisions). Rate-limit and cost friendly.

## Hooks (`.papercusp/hooks/*.sh`)

Lifecycle hooks fire at agent boundaries. All optional.

| Hook | Fires | Env |
|------|-------|-----|
| `pre-worker.sh` | Before each worker | `ROLE=worker FEATURE_ID PROJECT_DIR STATE_DIR` |
| `post-worker.sh` | After each worker | Same + `RC` (worker exit code) |
| `pre-validator.sh` | Before each validator | `ROLE=validator FEATURE_ID PROJECT_DIR STATE_DIR` |
| `post-validator.sh` | After each validator | Same + `RC` |
| `on-escalate.sh` | When orchestrator escalates | `REASON PROJECT_DIR STATE_DIR` |
| `on-feature-passed.sh` | When validator marks a feature `passed` | `FEATURE_ID STATUS=passed PROJECT_DIR STATE_DIR` |
| `on-feature-failing.sh` | When validator marks a feature `failing` | `FEATURE_ID STATUS=failing PROJECT_DIR STATE_DIR` |
| `on-checkpoint-fired.sh` | When a checkpoint is created (auto or via orchestrator) | `CHECKPOINT_NAME TRIGGER PROJECT_DIR STATE_DIR` |
| `on-smoke-pass.sh` | When the service smoke test passes | `TRIGGER=onDone\|onFeaturePass FEATURE_ID? PROJECT_DIR STATE_DIR` |
| `on-smoke-fail.sh` | When the service smoke test fails | Same as on-smoke-pass |
| `on-competition-start.sh` | When ≥2 workers spawn on the same feature | `FEATURE_ID LANE_COUNT PROJECT_DIR STATE_DIR` |
| `on-synthesis-won.sh` | When a synthesized branch passes validation and merges | `FEATURE_ID SYNTH_BRANCH LANE_COUNT PROJECT_DIR STATE_DIR` |

Hook output lands in `.papercusp/logs/hooks/<ts>-<name>.log`. Non-zero exits are warned but don't halt the mission.

## Snapshots

Each main-loop iteration snapshots `features.json` + `validation-contract.md` + `supervisor-notes.md` + `config.json` into `.papercusp/snapshots/<ts>-iter-NNN/`. Restore via the `/harness` UI or manually:

```bash
cp .papercusp/snapshots/<ts>-iter-042/features.json .papercusp/features.json
```

## Tuning the validator

The single highest-leverage thing. Out of the box, Claude is lenient when
evaluating generated code. After the first run:

1. Read `.papercusp/issues.md`.
2. Find cases where the validator said `PASS` but you can see problems.
3. Append a few few-shot failure examples into `prompts/validator.md` under a
   `## Known-good bug reports` section.
4. Re-run. Validator will now be more skeptical.

Repeat ~3 rounds. Same pattern Anthropic used.

## When to escalate to a real tool

This scaffold is ~200 LOC. It's designed for:
- Small-to-medium features (hours to a day)
- Projects where you want to read every agent trajectory
- Situations where you want to hack the prompts and iterate

For **multi-day production missions**, use:

- **Factory.ai `/missions`** — productized version of the same architecture.
- **Cognition Devin** — managed autonomous agent.
- **OpenHands** (open source) — full framework.

This harness is the minimal viable thing that captures the *pattern*. Graduate
to those when you need parallelism, remote compute, enterprise RBAC, or
cost controls.

## Supervisor (cron-based waker)

```bash
# every 6 hours, across all harness-enabled projects
crontab -e
# add:
0 */6 * * * for p in ~/proj1 ~/proj2; do cd "$p" && [ -f SPEC.md ] && ~/autonomous-harness/bin/supervisor.sh; done
```

Or chain the supervisor into `run.sh`:
```bash
~/autonomous-harness/run.sh || [ $? -eq 3 ] && ~/autonomous-harness/bin/supervisor.sh
```

## Not included (intentional)

- Sandboxing beyond `branchIsolation`. Workers have full FS access in the project dir; branch isolation only contains git-tracked changes. Use a container or chroot if you need stricter isolation.
- Multi-machine / cluster execution. All workers run on the same host.
- Retry budgets per role. Orchestrator's `attempts >= 5` rule is the only guard.
