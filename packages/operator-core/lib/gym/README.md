# Harness Gym — runner (`apps/operator/lib/gym/`)

The eval-driven optimizer for the harness itself. Plan:
`apps/operator/docs/plans/harness-gym-eval-optimizer-2026-06-02.md`.
This directory is the **measurement spine** (Phases 0–3) plus the proposer + autonomous
loop (Phases 4–5). All phases are **code-built + unit-tested**; the spine (P-001) is
additionally **validated end-to-end** (see Status). The proposer/loop (P-015+) are
**validation-gated** behind the **P-014 human milestone** — built, but not trusted to
run unattended until P-014's real-LLM A/B + human go/no-go clears them.

## The minimal bootable unit (P-001)

A gym **run** = execute the real multi-agent pipeline (scoper→…→curator) on one
synthetic task with one prompt-variant overlay, then capture the result. Per
**D-018 (Option A)** the unit that boots is **one dedicated, long-lived
gym-operator instance**, reused across runs — *not* the live `:3070` fleet operator,
and *not* a fresh process per run.

```
┌──────────────────────────────── gym CONTROLLER (latest code) ─────────────────────────────┐
│  runGymPipeline (gym-runner.ts) · judge · proposer · loop driver                           │
│  — talks to the gym-operator over HTTP + reads the gym PG directly —                       │
└───────────────┬──────────────────────────────────────────────────────────────────────────┘
                │ HTTP (:39xx)  +  PG (papercusp_gym)  +  local git
                ▼
┌──────────── gym-OPERATOR (PINNED checkout @ harnessCommit) ───────────────────────────────┐
│  bin/hono-host.ts + DBOS orchestrator + dedicated gym PG database                          │
│  runs the REAL pipeline with the variant's promptOverrides                                 │
│  boot env: see boot-spec.ts → buildGymOperatorBootSpec()                                    │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

### What is pinned vs not (sharpens D-016)

D-016 pins the **harness-under-test** — the thing being *measured*. That is the
pipeline code + the role prompts, i.e. the **gym-operator's pinned checkout**. It is
**not** the gym's own measurement apparatus (runner orchestration, judge, proposer,
loop). Those live in the **controller** and stay on the latest code, so improving the
gym never forces a re-pin. The controller therefore talks to the gym-operator only
through its stable surfaces (HTTP API + the gym PG), never by sharing its process.

### Boot env (the dedicated gym-operator)

Built purely by `buildGymOperatorBootSpec()` (`boot-spec.ts`); the caller spawns it
as `npx tsx bin/hono-host.ts` from `<pinnedCheckout>/apps/operator` with
`{ ...process.env, ...spec.env }`:

| Env | Why |
| --- | --- |
| `DATABASE_URL` + `HARNESS_ADMIN_DATABASE_URL` + `PAPERCUSP_DATABASE_URL` = gym PG DSN | ALL THREE DSN keys: `getHarnessAdminUrl()` (operator) reads the first two; the orchestrator `pg-bootstrap` in the spawned **worker subprocess** reads `PAPERCUSP_DATABASE_URL` > `embedded-pg.json` > `:5432/papercusp`. Pin all three or the worker silently connects to the live dev DB (hermeticity breach) → `UPDATE harness_features` 42P01. |
| `PAPERCUSP_DBOS_ENABLE=1` | Boots the durable orchestrator (registers `featurePipeline`). |
| `PAPERCUSP_DBOS_ORCHESTRATOR_HARNESSES=none` (default) | Autoloop off — the runner starts each pipeline explicitly (deterministic, 1 feature/harness). |
| `PAPERCUSP_HONO_PORT` / `PAPERCUSP_BIND_HOST=127.0.0.1` | Dedicated port, loopback only. |
| `PAPERCUSP_WORKSPACE_ID` | Pinned for the instance lifetime. |
| `DBOS__APPVERSION=gym-<commit12>` | Isolates the gym DBOS app from the live one; stable workflow recovery. |
| `PAPERCUSP_IPC_ENABLE=0` | Not the Tauri/desktop context. |

### Per-run lifecycle (`runGymPipeline`, gym-runner.ts)

For each `(task × variant × cycle)`:

1. **identity** — `gymRunIdentity()` → a `gym-`prefixed, PG-schema-safe `harnessSlug`
   (→ its own `harness_<slug>` schema in the gym PG), a task-derived `F-GYM-*`
   feature id, and a clone dir name. Deterministic & collision-free.
2. **clone** — throwaway substrate clone at the pinned commit (`clone.ts`,
   `--local` for local sources); `git checkout --detach <commit>` (D-009).
3. **register** — register the clone as a throwaway harness (scaffolds its schema).
4. **overlay** — apply the variant's prompt overrides (`variant-overlay.ts` →
   `setPromptOverride`); baseline applies none (D-010/D-012/D-015).
5. **file feature** — file the synthetic feature (spec + intent) into the harness.
6. **start pipeline** — `ensureFeaturePipeline` / `POST /api/admin/dbos/pipeline/start`.
7. **poll to terminal** — `classifyGymRun()` over `(workflow status, feature status)`
   until terminal or `timeoutMs` (`pipeline-status.ts`). Outcome is **observability**
   (terminal_state), never a reward (D-011).

The runner does **not** tear down on success: the trace collector (P-002) reads the
clone (for `git diff <commit> HEAD`) and the harness schema (for the transcript)
*after* the run, then teardown drops the schema + removes the clone.

Isolation between concurrent runs (P-004) is by construction: distinct `harness_<slug>`
schemas + distinct clone dirs + distinct feature ids, all within the one gym PG /
gym-operator, bounded by the DBOS pipeline queue concurrency.

## Module map

| File | Role | Tested |
| --- | --- | --- |
| `run-identity.ts` | deterministic schema-safe run identity | `__tests__/run-identity.test.ts` |
| `clone.ts` | pinned-commit substrate clone command plans | `__tests__/clone.test.ts` |
| `variant-overlay.ts` | prompt-override overlay planning | `__tests__/variant-overlay.test.ts` |
| `pipeline-status.ts` | poll-to-terminal classifier | `__tests__/pipeline-status.test.ts` |
| `boot-spec.ts` | the minimal bootable unit (boot env) | `__tests__/boot-spec.test.ts` |
| `gym-runner.ts` | run orchestration (injected ports) | `__tests__/gym-runner.test.ts` |

Full integration (a real gym-operator + a real pipeline on a real A/B) is validated at
the **P-014** milestone, not in unit tests.

## Status & runbook (overnight build, 2026-06-02)

**Built + tested + committed:** every plan item's logic/cores (P-001..P-030 except the
human gates) — 194 unit tests + live-PG integration, green. Modules cover the spine
(runner/clone/identity/boot-spec/schema/collector/signals/cost/concurrency), task side
(task-generator/probe-generator/task-pools/real-anchor), judge (judge-scoring/judge/
distill/rejudge), and the full loop (proposer/changelog/gates/frontier/gate-engine/loop/
promotion/circuit-breaker/optin/variance/grader-opt). Plus `runner-ports.ts`
(createGymRunnerPorts) + `../harness-seed.ts` (shared w/ harness-test-coverage) +
`gym-db-init.ts` (provisionGymDatabase).

**CAPTURE CHAIN validated end-to-end, zero LLM** by `smoke.ts` (run:
`cd apps/operator && npx tsx lib/gym/smoke.ts`, ~50s, deterministic PASS). Provision a
dedicated gym PG → boot a headless gym-operator (DBOS on the gym DB) → register +
scaffold harness → file feature (direct PG) → deterministic start (admin route +
`~/.papercusp/superuser-token` bearer) → a **real multi-role pipeline runs**
(director/worker/validator/curator/documenter/debugger; worker COMMITS real work) →
**P-002 collector** assembles a real `RawTrace` (real `harness_run_output` transcripts +
real `git diff <base> HEAD`) and writes a bundle → **P-029 distillation** compresses it
into a bounded, deterministic, judge-sized input (diff section preserved) →
process-group teardown. `SMOKE: PASS`, 0 × 42P01.

> **Fake-agent fidelity (why the smoke gates on the capture chain, not workflow SUCCESS):**
> the fake validator prints `[PASS]` but the orchestrator reads feature status from PG,
> not stdout, so the synthetic feature stays `failing` and the pipeline cycles a
> nondeterministic 25–123+ debugger/rework turns to its iteration cap. That's a fixture
> artifact (real agents converge), so the smoke breaks the poll once a substantial real
> run exists (≥12 rows) and PASSES on collector + distill; only a real DBOS
> `ERROR`/`RETRIES_EXCEEDED` fails. A future fixture refinement could have the fake
> validator/worker set the PG feature status so the fake pipeline converges cleanly.

What is NOT yet validated against a real run (both are the **P-014** boundary):
**P-003 signals** (`regressionsFromTests` needs a real substrate *with a test suite*; the
synthetic substrate has none) and the **P-008 Opus judge** (real LLM). Everything up to
those — boot, run, collect, distill — is validated zero-LLM.

### RESOLVED — worker invoke `harness_features` 42P01 (the last mile to REAL work)

**Root cause (FIXED 2026-06-02, commit `7eb79a46d`): a hermeticity breach, not a
search_path bug.** The orchestrator's `pg-bootstrap.defaultDsn()` resolves its DSN from
`PAPERCUSP_DATABASE_URL` > `~/.papercusp/embedded-pg.json` > hardcoded `:5432/papercusp`
— it does **not** read `DATABASE_URL`/`HARNESS_ADMIN_DATABASE_URL`. The boot-spec pinned
only the latter two, so the spawned **worker subprocess connected to the LIVE dev DB**,
where the gym's per-harness `harness_<slug>` schema doesn't exist → `UPDATE
harness_features` 42P01'd at parse. The worker's `SHOW search_path` log was a false
reassurance — Postgres accepts a search_path naming a *missing* schema. The live fleet
was unaffected only because live harnesses live in `:5432/papercusp` = the fallback; the
gym is the first caller whose DB ≠ the fallback, exposing the latent divergence. (A
reproduction with the exact `pg-bootstrap` client config — `max:4 + connection:{search_path}`
— against the gym PG resolved `harness_features` on all pooled connections, proving the
config + view were fine and isolating it to the wrong *database*.)

**Fix (both TDD'd, both live-safe):**
- `boot-spec.ts` also pins `PAPERCUSP_DATABASE_URL = gymDatabaseUrl` (gym self-hermetic).
- `harness-invoke-once.ts` sets `PAPERCUSP_DATABASE_URL = PAPERCUSP_DATABASE_URL ||
  DATABASE_URL || getHarnessAdminUrl()` so the worker's bootstrap tracks the operator's
  DB — completing the file's existing "hit the SAME Postgres the operator uses" intent;
  a no-op for the live fleet (equals `DATABASE_URL` there).
- `runner-ports.ts` `registerThrowawayHarness` now **fails loud** on
  `provisioning.ok===false` instead of swallowing a scaffold failure (defensive).

### Open item 1 — P-014 (human gate): the real A/B  ← **the next action, needs a human**

The worker now does real work (the hermeticity fix above), so the spine is ready for the
real-LLM milestone. This gate is a **STOP**: it needs real coding-agent + Opus-4-8 spend
**and** a human go/no-go on whether the signal is sound enough to trust the loop (P-015+).
Deliberately not run unattended (D-019: fake-agent-first is the unattended deliverable;
real agents are slow/nondeterministic and the go/no-go is a human call).

**Runbook (for a human, bounded per D-019 — ≤2 variants × ≤3 tasks, 1 run each):**

1. **Real agent instead of the fake.** `smoke.ts` boots the gym-operator via
   `buildGymOperatorBootSpec` with `agentCmd` (→ `AGENT_CMD`) pointing at the fake
   (`fixtures/fake-agent.mjs`). Point it at a real CLI (`claude -p` / `omp -p`) — and set
   `agentModels` (→ `AGENT_MODELS`) per-role if you want a stronger worker model.
2. **Two variants.** Run baseline (empty overlay) + one candidate (a `{promptOverrides}`
   overlay) over the same ≤3 train tasks (`task-generator.ts` / `task-pools.ts`), via
   `runGymPipeline` + `createGymRunnerPorts` (the real adapter). Each run → `gym_runs`.
3. **Real judge.** Score each run's distilled trace with the frozen Opus-4-8 judge
   (`judge.ts` `judgeGymRun`, `judge-scoring.ts` — pinned model/weights/temp/`rubric_hash`)
   → `gym_scores`. Capture per-run `$`/tokens via `cost.ts`.
4. **Measure + decide (the gate):** `variance.ts` over the per-(task) composites →
   derive **ε/δ/min-n** (is 1 run too noisy? if so promote **P-025** repeats into v1);
   `cost.ts` → the **$/cycle + $/converged-run** estimate; **real-anchor correlation**
   (`real-anchor.ts` + `read-api.ts`) → does the gym score track the held-out real-anchor
   (D-014 falsifiability)? Read the A/B via `read-api.ts` `compareVariants`/`frontierView`.
5. **Human go/no-go:** only if variance supports a usable ε/δ at acceptable cost **and**
   the real-anchor correlates, proceed to wire/run the proposer→loop (P-015–P-022). If
   the signal is noisy or the anchor doesn't move, the optimization premise is unproven —
   fix that before building the loop. **Never** point a real *production* harness at a
   champion without P-023 sign-off (the gym's own harness is promoted unattended; a prod
   harness is not).

### Open item 2 — P-024 dashboard (UI)

Deferred: the `read-api.ts` data layer (compareVariants/frontierView/cycleHistory/
variantLineage) is ready; the nuqs operator UI is a focused design-aware task (Tauri-only
operator UI can't be driven autonomously without focus-stealing; importance: low).
