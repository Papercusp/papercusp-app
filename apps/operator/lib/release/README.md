# Release gating — a green `main` branch, auto-served

Implements plan **`release-gate-ready-branch-2026-06-04`**, re-shaped by
**`staging-branch-pipeline-2026-06-06`** into the staging→main model. Decouples
*what the fleet runs* from *the churning working tree*: agents work on the
**`staging`** branch (the integration firehose); the **`main` branch is the
green pin** — it only ever fast-forwards to a staging commit that passed the
suite — and the deploy chokepoint **auto-serves** it from a separate
**release checkout** the operator runs from.

```
staging (integration) ──git-sync (all WIP, every ~10 min)──►  churns continuously
      │  green-checkpoint (hourly): fast-forward `main` to the latest GREEN commit
      ▼
   main (green, FF-only, automation-writes-only) ───────────►  always a tested state
      │  THE DEPLOY — AUTOMATIC (release-trigger, ≤15 min after main advances):
      │    drain → snapshot → swap release checkout to main → apply staged
      │    migrations → restart → health + path-verify → broadcast   (rollback on failure)
      ▼
   release checkout  ────────────────────────────────────────►  what the operator runs
   (/home/dev/papercupai-workspace/papercup-release)
```

A restart can **never** deploy raw churning HEAD by construction, and nothing
but green-checkpoint may move `main` (never push or `branch -f` it by hand).
Watch the whole pipeline at **`/admin/git`**.

## Why a separate checkout works (Phase 0)

The operator has no hot-reload, so the runtime is already pinned to whatever was on
disk at its last restart. We formalize that into a separate git worktree at
`PAPERCUSP_RELEASE_ROOT`. Runtime file reads (prompts, SQL, docs) are all
`process.cwd()`/`__dirname`-relative with **no** hardcoded absolute repo paths, so
running the operator with `cwd = <release>/apps/operator` makes every read resolve
under the release checkout automatically. `verify-release-paths.ts` asserts this.

The checkout is built by `bin/release/setup-release-checkout.sh`:
- a `git worktree` (shares the object store → submodule pins that were never pushed
  to origin are still reachable),
- **submodule source** extracted at each pinned sha via `git archive` from the
  integration tree's local objects (real, isolated files — not hardlinks, because
  the fleet edits submodule source),
- **node_modules** hardlink-copied (cheap; safe because it isn't hand-edited; the
  relative workspace symlinks resolve intra-release-tree).

## The pieces (all `tsx`-runnable standalone, even when the operator is down)

| File | Role |
|---|---|
| `bin/release/setup-release-checkout.sh` | Build/sync the release (or checkpoint) checkout to a ref. |
| `lib/release/git-ops.ts` | Git primitives — the green pin (`main`) only ever **fast-forwards**. |
| `lib/release/green-checkpoint.ts` | Phase 1: run the suite in an isolated checkout of the candidate (`staging` HEAD); FF `main` if green. |
| `lib/release/deploy.ts` + `deploy-deps.ts` + `deploy-cli.ts` | Phase 2: the chokepoint orchestration + real wiring + CLI. |
| `lib/release/migrate.ts` | D-007: deploy-time migration apply, **fail-loud**. |
| `lib/release/health-probe.ts` | D-011d: post-restart `/api/health` poll. |
| `lib/release/verify-release-paths.ts` | Phase 0: assert runtime reads resolve under the release checkout. |
| `lib/release/rollback.ts` | D-008: standalone revert (release ref + snapshot) + restart. |
| `lib/release/seed-release-routines.ts` | Seed the green-checkpoint + release-trigger routines (both ACTIVE — auto-serve). |
| `packages/operator-core/lib/harness/routines/release-actions.ts` | The `system:green-checkpoint` + `system:release-trigger` handlers. |
| `libs/papercusp/packages/harness/prompts/release-manager.md` | D-011: the Opus-4.8-xhigh release-manager agent's playbook. |

## Operating it

```bash
# Review what would deploy (no side effects):
npx tsx apps/operator/lib/release/deploy-cli.ts

# Deploy green `main` NOW (the auto-pipeline does this for you within ~15 min;
# needs PAPERCUSP_ALLOW_DEV_RESTART=1 for the real restart):
PAPERCUSP_ALLOW_DEV_RESTART=1 npx tsx apps/operator/lib/release/deploy-cli.ts --execute

# D-009 escape hatch — deploy a specific UN-GREEN commit (loud + audited):
PAPERCUSP_ALLOW_DEV_RESTART=1 npx tsx apps/operator/lib/release/deploy-cli.ts --deploy-commit <sha> --execute

# Advance `main` to the latest green staging commit (the hourly routine does this too):
npx tsx apps/operator/lib/release/green-checkpoint.ts

# Roll back the last deploy:
PAPERCUSP_ALLOW_DEV_RESTART=1 npx tsx apps/operator/lib/release/rollback.ts --execute
```

The routine deploys are **scripted** (auto-serve): `system:release-trigger` runs
`deploy-cli --execute` itself; the green gate is the go/no-go. The
**release-manager** role (Claude Opus 4.8 @ `xhigh`, via
`AGENT_MODELS["release-manager"]`) remains for **interactive/incident** use —
un-green escape-hatch deploys, rollback judgment, deploy forensics — via
`psu --role release-manager`; the routine no longer dispatches it.

## Migration discipline (Phase 3)

- Allocate numbers with **`db:next-migration`** (atomic `migration_reservations` +
  advisory lock) — never hand-pick an `NNN` (it caused the `131` collision).
- Migrations apply **only at deploy** (fail-loud, atomically with their code) — stop
  running `psql -f` against the live DB out of band. The boot-time apply
  (`db-boot-migrate`) stays log-and-continue so a broken peer migration never wedges
  the shared dev-api; the **deploy** apply is fail-loud → a bad migration aborts the
  deploy and rolls back.

## ✅ The cutover happened (2026-06-05) — the standing two-port model

The live operator **runs from the release checkout**: `papercup-dev-api.service`
(`:3070`) has `WorkingDirectory=…/papercup-release/apps/operator` and
`PAPERCUSP_INTEGRATION_ROOT=…/papercup` in its unit env. A second **staging
operator** `papercup-staging-api.service` (`:3170`) runs from the integration
tree (the `staging` branch, DBOS/routines disabled) so server-side edits can be
tested live without touching the stable host:

- **Test a `lib/**` edit:** `dev:restart { target: 'staging', confirm: true, authorize: true, reason: 'reload the staging operator with updated code' }`,
  probe `:3170`. Never a raw `systemctl --user restart papercup-staging-api.service`
  — it bypasses the drain + the WI-4221 debounce (uncoordinated raw restarts fired
  every ~5-6min for hours across the fleet).
- **Promote to `:3070`:** the deploy chokepoint above (green-checkpoint → `deploy-cli
  --execute`). A raw `:3070` restart just reboots the same green snapshot.
- **Revert the cutover** (if ever needed): repoint `WorkingDirectory` back to
  `…/papercup/apps/operator`, `daemon-reload`, restart (≈30s recovery).

**Spawn-path invariant (step-4 audit, done 2026-06-05):** anything that spawns an
agent or resolves "the repo" must target the **integration tree**, not the release
checkout — `PAPERCUSP_INTEGRATION_ROOT` is the declared seam. `release-config.ts`,
`release-actions.ts`, `setup-release-checkout.sh`, `detectPapercupRoot()` (ambient
mode — covers `plans:launch/resume` cwd + harness registration) and
`console-launcher.ts`'s scripts-dir all honor it. Keep new spawn sites on that seam.

## Routine posture: AUTO-SERVE (decided 2026-06-06, supersedes "deploys stay deliberate")

- **`green-checkpoint` — ACTIVE, hourly** (`0 15 * * * *`). It never deploys: it
  fast-forwards green **`main`** when `staging` is green and broadcasts 🟩/🟥 — a
  continuous staging-health signal. (Hourly respects the shared box; tune the
  cron in `seed-release-routines.ts` for fresher mains.)
- **`release-trigger` — ACTIVE, every 15 min, SCRIPTED.** When green `main` is
  ahead of the release checkout it runs `deploy-cli --execute` directly (drain →
  snapshot → swap → migrate → restart → health-check, auto-rollback) and logs a
  `deploy` row to `pipeline_events`. The green gate is the go/no-go; no
  human/agent in the routine loop. Revert to deliberate deploys with
  `npx tsx apps/operator/lib/release/seed-release-routines.ts --inactive`.

`seed-release-routines.ts` encodes these per-routine defaults — running it with no
flags (re)applies the decided posture.

## Per-pot generalization (per-pot-git-and-release-gate-2026-06-29)

This gate is no longer papercusp-only. It is generalized to **every coding pot** via the
blueprint `releaseGate` knob — see `agent-insights/per-pot-staging-main-pipeline`. The
short version: this `release-config.ts` is **unchanged** (its env seam is the integration
point); `packages/operator-core/lib/harness/routines/hive-release-env.ts`
(`resolveHiveReleaseEnv` / `resolveCheckpointRouting`) computes a per-pot env overlay from
the pot's `releaseGate` knob + registry path, and the `system:green-checkpoint` handler
passes it to the subprocess. The **operator-home (papercusp) gets an EMPTY overlay**, so
everything above describes its behavior verbatim. Per-pot seeding
(`seed-pot-release-routines.ts`) is **flag-gated `PER_HIVE_RELEASE_GATE`, default-OFF**.
