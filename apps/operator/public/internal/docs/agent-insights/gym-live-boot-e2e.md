# Testing the gym live-boot path (runOneAutoloopCycle / runGymBlueprintCycle)
URL: /internal/docs/agent-insights/gym-live-boot-e2e

How to write a committed E2E that boots a real gym-operator (fake/zero-LLM), and the two env-seal gotchas that make /api/health/ready deadlock or flood the boot log. Plus why the wake-mode autonomous-cron chain is NOT a committed test.

## What

The gym has three live-boot runnables that provision an ephemeral gym PG
(testcontainer), boot a **real headless gym-operator** from this checkout, run a
cycle, and tear down. Each has a callable core + a thin CLI wrapper:

| Callable                                      | CLI                      | What it drives                                                                    |
| --------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------- |
| `runOneAutoloopCycle` (`autoloop-cycle.ts`)   | `gym-loop-run.ts`        | the bespoke optimization loop                                                     |
| `runGymBlueprintCycle` (`blueprint-cycle.ts`) | `blueprint-cycle-run.ts` | the gym **as a durable DBOS pipeline** (spine walk)                               |
| `runGymWakeMode` (`wake-mode.ts`)             | `wake-mode-run.ts`       | the **autonomous cron chain** (routinesTick → blueprint-run → orchestrator sweep) |

In **FAKE mode** (`fake: true`, default in the CLIs) they use `fixtures/fake-*-agent.mjs`

* deterministic fake judge/proposer — **zero LLM spend** — so they're a real
  assembly check, not a cost. Committed E2Es:
  `gym/__tests__/{autoloop-cycle,blueprint-cycle}.integration.test.ts`.

## Two env-seal gotchas (each cost a debugging run)

The gym boot-spec (`gym/boot-spec.ts`) merges `{ ...process.env, ...spec.env }`,
so anything it does **not** explicitly seal leaks from the launcher env. Two
leaks bite the live boot:

1. **`/api/health/ready` deadlock (the operator binds HTTP but never goes
   ready).** Readiness is `dbosEnabled ? dbosLaunched : true`. The gym sets
   `PAPERCUSP_DBOS_ENABLE=1`, so readiness needs `dbosStarted()`. But
   `backgroundWorkersEnabled()` (which bundles the DBOS launch) returns **false**
   under `VITEST` *or* an inherited `PAPERCUSP_BACKGROUND_WORKERS=0` (the dev box
   `.env.local` and the `:3170` staging operator both set it). DBOS never
   launches → `/api/health/ready` stays 503 → `waitForOperatorReady` times out at
   120s. **Fix (shipped):** `boot-spec.ts` now seals `PAPERCUSP_BACKGROUND_WORKERS: '1'`
   * blanks `VITEST` (the gym runs against its OWN isolated DB, so no EI-126
     two-host conflict; `UTILITY_HOST=1` still strips the dogfood/voice/embedder legs).

2. **Boot-log flooded with backup-scheduler errors (EI-596).** Once DBOS launches,
   `lib/dbos/periodic-workflows.ts` registered **all** the shared-DB periodic drains
   (backup cadence, orphan-cleanup, GC sweeps) unconditionally — and they throw
   against the gym's throwaway DB (`backupHost` has no config there) every cadence.
   Non-fatal (DBOS isolates the failing steps; the pipeline still runs) but noisy +
   wasteful. **Fix (shipped):** the registration is gated by
   `dbosPeriodicTimersActive()` = `dbosTimersActive() && !utilityHostEnabled()`
   (`dbos-flags.ts`). `dbosTimersActive()` itself is left intact (it also drives the
   legacy-fallback stand-down). The gym keeps the orchestrator/routines it needs —
   those are separate imports (`orchestrator-loop`, `routines-workflow`), not in
   `periodic-workflows.ts`.

## Which ones make good committed tests

* **`autoloop-cycle` (\~120s) + `blueprint-cycle` (\~45s)** converge reliably in
  fake mode (manual/explicit dispatch). Committed as `.integration.test.ts` with
  generous timeouts.
* **`wake-mode` is NOT committed.** Its autonomous chain is **cron-cadence-bound**
  (`*/15s` trigger + `*/30s` orchestrator sweep + a multi-hop pipeline), so it does
  not converge inside a bounded \~5min window — the decider fires (links 1–2 work)
  but the feature doesn't reach `passed`. A 5–10min timing-sensitive test would
  flake the suite. Its **pure** oracle/blueprint/judge logic is covered by
  `wake-mode.test.ts` (unit); the live chain stays the `wake-mode-run.ts` manual/
  nightly CLI.

## Inference-gateway routing for the in-process judge/proposer (FB-16 / EI-368)

`runOneAutoloopCycle` now routes the gym's IN-PROCESS judge and proposer
through the pacing gateway when `FLAGS.INFERENCE_GATEWAY` is ON (added
2026-06-25). The spawned pipeline agents already egress through it (the spawn
chokepoint merges `gatewaySpawnEnv` → `ANTHROPIC_BASE_URL`), but the in-process
`anthropic-direct` llmCalls (judgeCall/proposerCall in `loop-deps.ts`) never
passed through that chokepoint — on the live `:3070` cycle they hit
`api.anthropic.com` directly with the org-blocked OAuth → `LlmCallError 401`,
opening the circuit every tick. The fix sets `PAPERCUSP_ANTHROPIC_URL` (SDK
path) AND `ANTHROPIC_BASE_URL` (claude-CLI subprocess path) at call-start, flag-
OFF leaves egress unchanged.

The spawn env in `autoloop-cycle.ts` also directly pins three additional vars
on top of `boot-spec.ts`'s sealed env:
`PAPERCUSP_FLEET_SANDBOX: '0'`, `PAPERCUSP_USE_WORKER_CHUNK_LOOP: '0'`,
`PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES: 'none'`.

## How to add another gym live-boot E2E

Call the **callable** (never the CLI — it `process.exit`s and boots on import).
Pick a per-process port + slug so a parallel runner / a live `:3070`-`:3170`
never collide:

```ts
const out = await runGymBlueprintCycle({ fake: true, port: 4200 + (process.pid % 50), gymSlug: `g${process.pid % 1000}`, ... });
if (!out.ok) throw new Error(`... ${out.report.error}\n${out.report.operatorLogTail}`);
```

Surface `out.report.operatorLogTail` on failure — an env boot failure is opaque
otherwise. Docker required; these run only under the integration config.
