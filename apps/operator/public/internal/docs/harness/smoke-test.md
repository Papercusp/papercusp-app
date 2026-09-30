# Smoke-test gate
URL: /internal/docs/harness/smoke-test

The DONE-blocking smoke gate — why it exists, what's wired today (gate machinery, a manual run+persist+notify loop, the health signal), and what still awaits its port (the automatic DONE-gate invocation).

Validators verify code-level claims; they don't always start the real service
and hit real endpoints. A feature can "pass" — unit test green, contract
documented, migration applied — while the deployed service 500s from config
drift, a missing env var, or a startup race. The **smoke-test gate** exists to
catch that class of failure *before* a pipeline declares DONE. The principle
("quality through truth": verify service startup, don't trust test output
alone) came from the first harness generation and still holds.

## What is wired today

**The gate.** The durable finalizer's planner
(`planFinalization` in
`packages/operator-core/lib/dbos/orchestrator-finalize.ts`) treats the smoke
result as a first-class DONE gate, exactly like an open `needs-human` plan
item: when `smokeEnabled` is set and `smokePassed === false`, finalization is
**blocked** — no curator/documenter recipe runs and the pipeline does not
complete.

**A manual run.** A live, registered route runs the smoke script on
demand: `POST /api/harness/:slug/smoke-test/run`
(`packages/operator-core/lib/endpoint-route/routes/harness/orchestration-actions.ts`,
loopback-auth; flattened into the route table at `routes/index.ts`) spawns
`service-smoke-test.sh`, which writes the `smoke-pass.md` / `smoke-failure.md`
papercups (clearing the failure papercup on pass). It is also reachable
through the device-tier shim `POST /api/device/harnesses/:slug/smoke-test`
(`routes/device/harnesses.ts`). The script then POSTs its aggregated result
to `POST /api/internal/smoke-test-event`, which upserts the
`harness_shared.harness_smoke_test` row and — on a pass→fail *transition*
only — pushes a high-importance `smoke-fail` attention item. So the papercups
`smoke_test_clean` reads are exactly what this live endpoint writes; they are
not only "earlier engines / out-of-band".

**The health signal.** A smoke failure surfaces through two differently-named
composite checks with **different data sources**: `smoke_test_clean` (the
harness-readers composite health in
`packages/operator-core/lib/harness-readers.ts`) fails when the
`smoke-failure.md` FS papercup exists in the harness state dir; `smoke_passing`
(the operator-UI `HealthBadge`) fails when the latest PG `harness_smoke_test`
row has `status: 'fail'` (the "see smoke-failure.md" text it shows is only a
label, not its source). That same `harness_smoke_test` row (written by the
smoke-test-event route above) is also what the Planning attention feed reads to
list failing harnesses — so a failed smoke run is visible across the FS-fed
health check, the PG-fed badge, and the Planning feed.

**The hooks.** `on-smoke-pass` / `on-smoke-fail` are catalogued in the hook
registry (`packages/operator-core/lib/known-hooks.ts`) with `status: 'lost'` —
bash-era [lifecycle](/internal/docs/harness/hooks) points the bash→DBOS
migration dropped (EI-95 backlog): "not fired, not advertised". `runHook(name)`
itself takes any string and just looks for a `<name>.sh` file (no validation,
and a test exercises `on-smoke-pass` only for its `<ts>-<name>.log` log-file naming, not an env shape), but `getKnownHooks()` returns
only the `live` set (`afterDone`, `on-escalate`), and the hook write/delete API
rejects any non-live name with `unknown hook: <name>`. So an operator cannot
install an `on-smoke-pass.sh` / `on-smoke-fail.sh` hook through the API, and
nothing in the live pipeline ever fires them.

## What is NOT yet wired: the automatic DONE-gate invocation

The manual/on-demand loop above runs and persists a smoke result, but the
durable finalizer never *calls* the smoke runner itself as part of declaring
DONE. The runner call site passes the gate explicitly off
(`packages/operator-core/lib/dbos/orchestrator-runner.ts`:

> "Smoke gate is config-gated-off for \~all harnesses; not yet ported into the
> durable finalizer (`runSmokeTest` is a main-loop-internal). Tracked as a
> Phase F follow-up; pass not-run so it never blocks here."

— `smokeEnabled: false, smokePassed: null`). Because the finalizer always hands
the gate `smokeEnabled: false`, the DONE-gate machinery — which *would* block on
`smokeEnabled && smokePassed === false` — never trips on the automatic path. A
smoke run that fails today still records its papercup + PG row + attention item,
but it cannot, on its own, stop a pipeline from completing until that Phase F
follow-up wires the finalizer to invoke and consume the runner.

In short: **gate machinery live, manual runner wired, automatic gate
invocation pending.** If you need a service-level check on a harness today, run
it on demand (`POST /api/harness/:slug/smoke-test/run`) or lean on the testing
surface (the project's own test/E2E suites — see
[Testing](/internal/docs/testing)).

## The runner shape (and the bash-era gating still awaiting port)

`service-smoke-test.sh` is what the manual endpoint above spawns, and its
behavior is the shape the automatic gate will reuse: read the smoke config
(`urls` of `{ url, expectStatus, expectText? }`, optional `startupCmd` +
`startupWaitSeconds`, default 30), start the service if the first URL isn't
responding, curl each URL, then on all-pass write `smoke-pass.md` (clearing any
`smoke-failure.md`) and on any-fail write `smoke-failure.md` and reopen the
most-recently-passed feature as failing. The config is OFF by default
(`smokeTest.enabled: false`). What did **not** survive the bash→DBOS migration
is the two automatic *gating modes* the bash main loop ran: `onDone` (block
mission completion) and `onFeaturePass` (revert a feature before the documenter
runs, so docs are never generated for a broken state) — these are the Phase F
follow-up the finalizer still passes `smokeEnabled: false` in lieu of.

## Related

* [Lifecycle hooks](/internal/docs/harness/hooks) — `on-smoke-pass` /
  `on-smoke-fail`
* [Decision telemetry](/internal/docs/harness/decisions-timeline) — the
  health-check family `smoke_test_clean` belongs to
