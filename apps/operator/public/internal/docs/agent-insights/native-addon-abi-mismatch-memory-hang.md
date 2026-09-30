# Green health check but memory handlers hang (native-addon ABI mismatch)
URL: /internal/docs/agent-insights/native-addon-abi-mismatch-memory-hang

/api/health is 200 but memory:* / MCP calls hang forever. Root cause class: a native addon (e.g. better-sqlite3) built for the wrong Node ABI fails at LOAD, mem0 never comes up, and every memory-touching handler awaits a promise that never resolves — invisible behind a shallow health probe. Diagnosis + the 4 shipped guards.

## Symptom

* `/api/health` returns **200** (fast) but the operator is effectively down:
  `memory:search` / `memory:remember` (and any MCP/HTTP handler that touches
  memory) **hang forever** — the MCP client eventually 55s-times-out; coord
  wakes stop flowing; systemd still shows the unit `active`.
* The host can look healthy to every shallow probe while no real work completes.

## Root cause class

A **native addon built for the wrong Node ABI** fails at *load* time, not install
time. The 2026-06-19 `:3070` outage: `papercup-release`'s `better-sqlite3` was
built for Node 22 (ABI 127) while the service runs Node 25 (ABI 141) — it threw
`Module did not self-register`, **mem0 never loaded**, and every memory call
awaited a promise that never resolved. Two independent gaps combined:

1. **Nothing rebuilt/verified native addons against the runtime Node** → the
   broken binary shipped to green undetected. The unit PATH carried BOTH nvm
   Node 22 *and* linuxbrew Node 25 — that drift is what produced the mismatch.
2. **The memory call path had no effective deadline, and the health probe
   exercised no subsystem** → the load failure became a silent infinite hang
   behind a green check.

## Diagnose (fast)

1. `curl :3070/api/health` (200, fast) **vs** `curl :3070/api/health/deep` — the
   deep probe round-trips PG + memory; a 503 with `memory.status: "down"` (or a
   `latencyMs` near the 3s deadline) points straight at a wedged memory
   subsystem. (`/api/health/ready` only reflects DBOS boot — a green `ready` does
   NOT mean memory works.)
2. Confirm the ABI: `node -e "console.log(process.versions.node, process.versions.modules)"`
   on the SERVICE's Node (ABI = `modules`). Then `npm run preflight:addons --root <install>`
   — a `FAIL` on a required addon (e.g. `better-sqlite3`) is the smoking gun.
3. `node -e "require('better-sqlite3')"` under the service Node reproduces the
   load throw directly.

Distinct from [event-loop saturation](/agent-insights/agent-mcp-slow-but-health-fast-event-loop-saturation/)
(MCP slow but health fast because the loop is *busy*) — here the loop is fine; a
specific subsystem never loaded.

## Immediate fix (the incident)

Rebuild the addon for the runtime Node ABI and restart:
`prebuild-install` (or `npm rebuild better-sqlite3`) against the **pinned** Node,
then restart `papercup-dev-api.service`. Verify with `npm run preflight:addons`
and `/api/health/deep` (both should pass).

## Prevention now in code (infra-fail-fast-build-integrity-2026-06-19)

The class is closed from four angles:

* **B1 — memory tools deadline, never hang.** `lib/memory/op-deadline.ts`
  (`withMemoryToolTimeout`) wraps every backend call in all five `memory:*` tools
  (incl. the `available()` probe, which itself hangs). A wedged mem0 now returns
  `{ ok:false, reason:'memory_timeout' }` instead of hanging — the silent-hang
  *symptom*. Shares a process-level degraded latch with the pre-turn inject path
  (`isMemoryDegraded()`) — **self-healing**, not a permanent-until-restart flag:
  a timeout arms a rolling *cooldown* (`memoryDegradedCooldownMs`, default 60s,
  env `PAPERCUSP_MEMORY_DEGRADED_COOLDOWN_MS`) that quiets the hot inject path
  and auto-clears once it elapses, re-arming on each fresh timeout — so a
  sustained outage costs at most one timed-out probe per cooldown, not one per
  turn, and the inject path resumes on its own once the backend recovers (no
  restart required). Env: `PAPERCUSP_MEMORY_TOOL_TIMEOUT_MS` (default 10s).
  A memory *write* additionally gets a bounded retry-on-timeout
  (`withMemoryWriteRetry`, EI-6684): a transient stall on the first attempt no
  longer silently drops the fact — up to `memoryWriteMaxAttempts()` (default 2,
  env `PAPERCUSP_MEMORY_WRITE_MAX_ATTEMPTS`) tries with a short backoff
  (`memoryWriteRetryBackoffMs`, default 250ms), skipped when the process was
  *already* degraded before the write started (fail fast on a known-sustained
  wedge instead of piling on retries).
* **A1 — deploy gate.** `npm run preflight:addons [--root <install>]`
  (`lib/native-addon-preflight.ts`) test-LOADS each required addon via its real
  package entry (NOT a raw `.node` scan — that false-alarms on the \~60 benign
  alternate-platform prebuilds) under the pinned Node and exits non-zero on
  failure, so a bad binary fails the promotion. `bare-*` (Bare-runtime) packages
  are skipped. Required set: `PAPERCUSP_PREFLIGHT_ADDONS` (default `better-sqlite3`).
* **A2 — boot self-check.** `runBootAddonPreflight()` in `host-bootstrap.ts`
  logs LOUDLY at boot if a required addon won't load (visible error, not silent
  hang). Safe by default; set `PAPERCUSP_ADDON_PREFLIGHT_FATAL=1` to exit
  non-zero so `Restart=always` surfaces a crashloop instead of a green-but-dead host.
* **B4 — deep readiness.** `GET /api/health/deep`
  (`lib/endpoint-route/routes/misc/health-deep.ts`) round-trips PG (`SELECT 1`) +
  memory (`available()`) under a 3s deadline. A *hang* → `down` → 503; a clean
  "memory disabled" (NoopBackend host) stays healthy (no false alarm).

## Still open / owner-gated

* **A3** — drop nvm Node 22 from the service unit PATH + pin linuxbrew Node 25
  (`.nvmrc`/`engines`, `npm rebuild` on every release refresh) to kill the drift
  at the source. Live systemd edit — owner-gated.
* Flip `PAPERCUSP_ADDON_PREFLIGHT_FATAL=1` once A2's required set is validated
  against every host shape (e.g. memory-disabled utility hosts).

Full audit: `BRIEF-infra-fail-fast-build-integrity-2026-06-19.md` (repo root).
