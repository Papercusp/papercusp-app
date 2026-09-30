# Spawn-env pins leak into vitest — tests that only fail when an agent runs them
URL: /internal/docs/agent-insights/spawn-env-leaks-into-vitest

Orchestrator-spawned agents carry per-spawn env pins (PAPERCUSP_WORKSPACE_ID, GIT_CONFIG_* mounting the fleet no-push hook, PAPERCUSP_PGBOUNCER defaulting ON for server-class hosts). Vitest inherits them, so env-sensitive tests (workspace-fallback asserts, real-git pushes, testcontainer-PG integration tests) fail under the green-checkpoint or any spawned runner while passing in every interactive shell. Fixed globally by the hermetic-env scrub in libs/test-config setup; diagnose by simulating the spawn env, not by re-running locally.

## Symptom

A small cluster of tests reds on the Tests tab at a steady cadence (every
green-checkpoint run), but **passes every time you re-run it locally** — solo
or batched. On 2026-06-11 the recurring set was:

* `workspace-context-middleware.test.ts`, `workspace-two-window-isolation.test.ts`,
  `papercusp-root.test.ts`, `workspace-map.test.ts` — asserts like
  `expected 'papercusp-workspace' to be 'ws-default'`: the test stubbed the
  global active workspace, but resolution returned the box's real workspace.
* `run-git-sync.test.ts` — every `git push` to its own `/tmp` origin blocked by
  "the fleet pre-push hook".

## Root cause

The runner was an **orchestrator-spawned agent** (the hourly green-checkpoint).
Spawns carry per-spawn env pins that vitest inherits:

* `PAPERCUSP_WORKSPACE_ID` — the process workspace pin, precedence step 2 in
  `workspace-registry.ts:activeWorkspaceId()`. Tests asserting the step-3
  global fallback get the pin instead.

* `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` — the spawn-env
  git-config injection (`gitConfigNoPushEnv` in orchestrator `invoke.ts`) that
  mounts `core.hooksPath` → the fleet no-push pre-push hook. git applies these
  env overrides in **every repo the test creates**, so real-git tests can't push
  to their own temp origins.

* `PAPERCUSP_INTEGRATION_ROOT` / `PAPERCUSP_RELEASE_ROOT` / `PAPERCUSP_CHECKPOINT_ROOT` /
  `PAPERCUSP_INTEGRATION_BRANCH` / `PAPERCUSP_RELEASE_REF` — the release-gate workspace-map config
  in gate/checkpoint runner envs. `resolveWorkspaceMapConfig` prefers them over
  sibling derivation, so `workspace-map.test.ts`'s derivation asserts got the
  runner's real paths (it stubbed only `PAPERCUSP_INTEGRATION_ROOT`, and the runner's
  `PAPERCUSP_RELEASE_ROOT` won).

* `PAPERCUSP_PGBOUNCER` — `pgbouncerEnabled()` defaults ON for a SERVER-class host
  (the dev box / a dedicated CI server) even when the env is unset, so
  `getOrgPg()`'s `maybePgbouncer()` rewrites every org connection to
  `127.0.0.1:6432` — the host's pooler. Integration tests point `getOrgPg` at a
  throwaway testcontainer with no bouncer, so the reroute hits the wrong Postgres:
  a FATAL `08P01` under transaction pooling, or "no such database: org\_\<rand>"
  against the host PG (and silently pollutes it). The classic "green in CI
  (workstation-class), red on the dev box (server-class)" leak. Pinned `OFF` as the
  test default via `??=` — a test that genuinely exercises the bouncer path sets it
  explicitly (the `??=` respects an explicit value).

An interactive shell has neither pin, which is why local re-runs are useless
for reproducing this class.

## Fix (landed)

`libs/test-config/src/setup-hermetic-env.ts` — prepended to every
`defineVitestConfig` setup (both console-noise branches) — scrubs the known leak
classes per worker, so tests behave identically under any runner:

* Deletes `PAPERCUSP_WORKSPACE_ID` (workspace-pin leak).
* Deletes the `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n`
  block (no-push hook injection).
* Deletes `PAPERCUSP_INTEGRATION_ROOT`, `PAPERCUSP_RELEASE_ROOT`,
  `PAPERCUSP_CHECKPOINT_ROOT`, `PAPERCUSP_INTEGRATION_BRANCH`,
  `PAPERCUSP_RELEASE_REF` (release-gate workspace-map config leak).
* Sets `PAPERCUSP_PGBOUNCER ??= '0'` (server-class bouncer default). Uses `??=`
  so a test that explicitly exercises the bouncer path can still set it to `'1'`.

Tests that need a specific pin set it themselves. Keep the scrub list to proven
leak classes; broad env wipes hide real bugs.

## How to diagnose the next one

If a test fails only under a spawned runner, don't chase the code — diff the
envs. Reproduce by simulating the spawn env locally:

```bash
# Workspace-pin + git no-push hook (green-checkpoint runner shape):
PAPERCUSP_WORKSPACE_ID=papercusp-workspace \
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.hooksPath GIT_CONFIG_VALUE_0=/tmp/some-hooks \
  npx vitest run <file>

# Server-class bouncer default (dev-box runner shape):
PAPERCUSP_PGBOUNCER=1 npx vitest run <file>
```

If that reproduces, add the offending variable to the hermetic scrub (with a
comment naming the incident) rather than patching the individual test.
