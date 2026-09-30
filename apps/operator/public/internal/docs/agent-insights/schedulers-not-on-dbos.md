# Which schedulers deliberately stay OFF DBOS (and why)
URL: /internal/docs/agent-insights/schedulers-not-on-dbos

The audit (dbos-scheduler-consolidation-2026-06-03) moved every portable periodic job onto DBOS scheduled workflows. This is the catalog of the loops that deliberately did NOT move, with the one-line reason for each — so the next agent doesn't try to "finish the migration" by porting something that can't or shouldn't be a DBOS cron.

The scheduler-consolidation pass ported the portable periodic jobs (backup
orphan-cleanup, push-credential refresh, telemetry/scratch-gc/memory/embed timers,
test-runs prune) onto **DBOS scheduled workflows**
(`packages/operator-core/lib/dbos/periodic-workflows.ts` — grep `DBOS.registerScheduled`
for the live set). A set of recurring loops were **deliberately kept off DBOS**. If
you're tempted to "finish the migration," check this list first — these are conscious
keeps, not stragglers.

> **Correction (EI-1622):** the original pass ALSO put a batch of high-frequency,
> no-durability-need checks on DBOS — `harnessStatusSweep` (the harness-status sweep),
> `completionRefVerify` (the completion-ref verifier), `systemHealth`,
> `connectionPressure`, `serviceHealth`, `spawnReclaimSweep`, `staleClaimSweep`,
> `learningInfraHealth`, `steeringChurnSweep`. Those were later converted **back off
> DBOS** to lightweight in-process intervals (`dbos/in-process-periodic.ts`, armed from
> `host-bootstrap`): they wrote \~200k `dbos.workflow_status` rows/day for zero
> durability gain (the recurring routine-engine freeze). So they are NOT in
> `periodic-workflows.ts` anymore — grep the symbol names in `in-process-periodic.ts`
> instead. This is the doc's own rule of thumb in action: no durability need ⇒ don't
> keep it on DBOS.

## The keep list (consolidation D-002)

* **All Rust schedulers** (`papercusp-desktop/src-tauri`, `papercup-rust-server`,
  `papercup-native`, `papercup-rust-mobile`). DBOS is a Node/TS library — it cannot
  run a Rust `tokio`/thread loop. The work is runtime-bound: Axum SSE keepalives,
  PG `LISTEN` reconnect, PG/zero-cache process spawn+kill lifecycle, WebSocket/
  EventSource reconnect.

* **Per-connection / per-request / per-spawn loops.** `expert-dispatcher` (≈100ms
  result-file poll during one agent run), `pty-ws`/`pty-bridge`/`device-voice-ws`/
  `voice-engines/deepgram` keepalives, `run-command-sse`, the `pty` route,
  `agent-tools/locks/acquire` wait-poll, `voice-engine-health`, and `provision/
  runner`'s `drainFifo`. Each is bound to a live in-process handle (socket / child
  process / session) that a detached periodic cron has no reference to. Not crons.

* **In-memory sweepers.** `expirable-registry` sweeps a process-local `Map` of
  TTL'd entries; `harness-fs-watcher`'s 60s tick is a reconcile **backstop** to its
  event-driven (chokidar) watcher. A detached DBOS cron can't see in-process memory
  or the watcher's view. (Each carries an inline `// not a DBOS candidate` note.)

* **`sync/hyperbee/outbox-drain`** — native at-least-once draining is the right fit;
  DBOS is a worse fit here (prior DBOS plan D-006).

* **UI** — `ui/use-ui-presence` is a client-side React hook.

* **Infra / CI** — the systemd *services* (mac VM, cloudflared ×2, pg-tunnel) and
  the `.github` nightly Actions cron are OS/platform-level, not operator work.
  `llm-test-nightly.timer` stays systemd too (a heavy external test-suite runner
  needing `ANTHROPIC_API_KEY`, \~90min — CI-shaped, not operator maintenance; D-004).

## Update (2026-06-28): off-DBOS ≠ invisible anymore

These loops still deliberately stay OFF DBOS — but they are no longer runtime-INVISIBLE. The
`schedule-inventory-and-ephemeral-tier-2026-06-26` pass routed **every** operator-host
`setInterval` through `managedSetInterval` (`@papercusp/scheduled-registry`), so each off-DBOS
keep here (`expirable-registry`, `harness-fs-watcher`, `outbox-drain`, the per-connection
keepalives, the watchdogs) now appears in `schedule:inventory` / `/admin/schedules` with a name +
category + last-fire — *visibility ≠ control* (registering does NOT move it onto a central
scheduler). A bare `setInterval` is now a `lint:no-raw-setinterval` build failure. See
[The scheduler layer model](/agent-insights/two-tier-scheduler-and-timer-visibility/) for the full
two-tier model (DBOS durable / in-process `managedSetInterval` / the ephemeral blueprint cadence).

## The rule of thumb

DBOS scheduled workflows are for **periodic, durable, operator-process maintenance
jobs that read/write Postgres**. If a loop (a) runs in another runtime (Rust),
(b) is bound to a live in-process handle (socket/child/session/Map), (c) is
genuinely event-driven with the timer only a backstop, or (d) is OS/CI infra —
it stays where it is.
