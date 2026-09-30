# Gym-operator boot — liveness≠readiness, the Napi abort, and the :3456 Vikunja misdiagnosis
URL: /internal/docs/agent-insights/gym-boot-readiness-and-meridian-topology

>-

## The two traps

**1. ":3456 not listening, docker maps :3458" is a misdiagnosis (EI-261).**
The container publishing host `:3458` is `restart-vikunja-1` — Vikunja's
default *internal* port happens to be 3456, so `docker ps` shows
`0.0.0.0:3458->3456/tcp` and pattern-matches beautifully to "meridian's port
got remapped". It is a task-tracker, not an LLM router. Meridian (the npm
proxy, v1.42.1 on this box) simply isn't running — and **that is the healthy
state**: the omp token (`~/.omp/agent/auth.json`) expired 2026-04-11 and OMP
is dead (npm-unpublished), so `readMeridianToken()` returns null and
`chooseStatelessTransport` resolves **anthropic-direct** off the live Claude
session (EI-281, both halves in `libs/papercusp-shared/src/agent/chat-stream.ts`).
Verified live 2026-06-12: `llmCall` round-trip in 1.0s. Do NOT model
"learning-infra health" as ":3456 listening" — the correct probe is "stateless
transport resolvable" (a live `~/.claude/.credentials.json` or a live omp
token). A :3456 probe reads permanently red on a healthy box.

**2. "column was\_forked\_from does not exist" is the *symptom*; the disease is
a liveness probe passing before DBOS migrated (EI-368).** Boot order in
`bin/hono-host.ts`: the HTTP listener binds **before** the DBOS system-DB
migration runs. The gym runners' old `waitForHttp(…/llms.txt)` accepted any
HTTP status as "up", so when the gym-operator intermittently died mid-boot
(`terminate called after throwing an instance of 'Napi::Error'`, empty
`what()` — an async native-thread throw, \~2/15 boots), the fresh gym DB was
left with `dbos.workflow_status` created but the `was_forked_from` column
migration unapplied, and the cycle's `startPipeline` surfaced the missing
column minutes later. Total misdirection: the SQL error points at the DB; the
bug is the dead process behind it.

## The fix (2026-06-12, B-01 of self-improvement-consume-edges)

* **`GET /api/health/ready`** (`endpoint-route/routes/misc/health-ready.ts`) —
  readiness: 503 until `dbosStarted()` on a DBOS-enabled host; `/api/health`
  stays pure liveness.
* **`waitForOperatorReady`** (`lib/gym/operator-ready.ts`) — all five gym
  runners (autoloop-cycle, ab-run, blueprint-cycle-run, smoke, wake-mode) now
  gate on readiness AND **fail fast the moment the child exits**, with the
  boot-log tail in the error. Falls back to the legacy llms.txt probe when a
  pinned checkout predates the route (404). The blind `sleep(4000)` "giving
  DBOS a moment" is gone.
* **`PAPERCUSP_UTILITY_HOST=1`** (`lib/background-workers.ts` →
  `utilityHostEnabled`, set by `lib/gym/boot-spec.ts`) — the gym-operator now
  boots a *headless utility profile*: no voice cluster, no hyperbee/holepunch
  substrate, no boot-time embedder warm-up. `backgroundWorkersEnabled()`
  could not express this (it bundles the DBOS launch with the shared-DB
  drains; the gym needs DBOS ON).

## The Napi abort itself — subtraction-trap RESULT (2026-06-12/13, FB-16)

The armed subtraction trap has run. **Result: the abort does not reproduce by
isolated repeated boots — 0 crashes across 80+ boots** spanning every profile
(full-profile ×15 then ×25, two gdb-wrapped lanes, minimal utility-host),
serial and concurrent-across-lanes. And **zero Napi aborts have appeared in
any gym-operator log since the fix landed (2026-06-12 04:24)** — across every
real gym-cycle boot (latest observed 2026-06-13 02:20) plus the trap boots.
The crash is a load/timing-dependent native-init race, not a deterministic
boot failure, so the subtraction trap cannot collapse it to a single `.node`.

**Sharper localization from the two surviving captures**
(`/tmp/gym-loop-op-fde36122.log` 2026-06-12 02:10 and `-e2972346.log`
2026-06-11 01:10 — the only 2 of 61 gym-operator logs that carry the abort):
the `terminate called … 'Napi::Error'` (empty `what()`) fires in the boot
window **after** `[plugin-host] warmed` / `Running DBOS system database
migrations…` and **before** `Initializing DBOS (v4.18.10)` / `DBOS launched!`.
By that point `[voice-node] local audio socket` is already created and
`[hyperbee-substrate] boot complete` has logged — so **the holepunch/voice
natives (`sodium-native`, `udx-native`) are NOT the throw site; their init
completed cleanly before the abort.** The throw is an uncaught C++ exception
from a NAPI addon active in the concurrent DBOS-migration/late-boot phase
under Node 25.9. `@dbos-inc/dbos-sdk` 4.18.10 ships no `.node` of its own, so
DBOS is the *timing marker* here, not necessarily the culprit; the empty
`what()` + no usable core (apport skips non-dpkg linuxbrew node) leaves the
exact addon unconfirmed.

**Disposition:** the deployed containment — the utility-host minimal profile
(removes the heavy natives) + the fail-fast readiness gate (turns a dying boot
into an immediate logged error with the boot-log tail, instead of a downstream
`was_forked_from` SQL symptom) — has held with zero recurrence. Exact-native
identification is blocked on a reproduction that does not occur in isolation;
chasing it further would need the original concurrent-load conditions of the
live `:3070` host, not a boot loop. EI-368 is contained, not root-fixed.

## Postscript — the vocabulary itself was retired (2026-06-12, EI-399)

This page is the historical record of the topology; the codebase no longer
uses the word. FB-17 renamed the stateless backend `meridian` →
`anthropic-direct` (`AGENT_BACKENDS`, `TurnBackend`, `BACKEND_PROFILES`,
`LLM_TEST_BACKEND` default, the `[meridian]`/`meridian error:` log + error
prefixes, `setMeridianUsageSink` → `setStatelessUsageSink`) and **removed the
dead omp-token transport leg** from `chooseStatelessTransport` — a stateless
call now resolves anthropic-direct off the live Claude session or fails with
one honest error. References to "Meridian" that remain in the tree name the
real external router product (`@rynfar/meridian`) on the omp runtime path —
desktop setup wizard, frame bootstrap for `backend=omp` frames, the
`/settings/meridian` iframe page — not the LLM client.

## Sequel — when a gateway is interposed, "credential resolves" is necessary-but-not-sufficient (2026-06-13, EI-478)

The trap-1 fix above said: model learning-infra health as "**stateless transport
resolvable**" (a live credential), never ":3456 listening." That was right for a
box egressing DIRECT to `api.anthropic.com` — there the only failure mode is a
missing/expired credential, and `api.anthropic.com` is effectively always
reachable.

**The pot inference-gateway (`pot-inference-gateway-2026-06-09`) reintroduced a
reachability dimension** — the exact *mirror* of trap 1. When the
`INFERENCE_GATEWAY` flag is ON, the gym judge/proposer, llm-testing, and cup
spawns no longer hit `api.anthropic.com`; `operator-spawn.ts` + `autoloop-cycle.ts`
point `ANTHROPIC_BASE_URL` / `PAPERCUSP_ANTHROPIC_URL` at a **localhost pacing
gateway** (`127.0.0.1:8788`). That gateway is a real process that can die while a
Claude credential still sits on disk — so a credential-presence probe reads a
confident **false "ok"** (the mirror of the false "offline" the :3456 TCP probe
gave). `learning-infra-health.ts`'s `llm-spine` leg now checks BOTH dimensions:
the credential resolves (unchanged), AND — *only when the flag is on* — the
gateway's `GET /healthz` answers.

Two things keep this faithful rather than a relapse into trap 1:

* **Gate the reachability check on the flag.** Probing the gateway when the flag
  is OFF would be the :3456 mistake all over again (probing a thing the calls
  don't use). The gateway probe runs *only* when the gateway is actually in the
  egress path.
* **Any HTTP answer = reachable; only a transport-level refusal = down.** The
  gateway returns `503` while rate-limit-PAUSED — that's it *pacing*, by design,
  not an outage. Treating a 503 as down would re-create the false-alarm class.
  So `reachable` is "the process answered at all"; `down` is ECONNREFUSED/timeout,
  mirroring what a real `llmCall` through the gateway would hit.

Orthogonality that fell out of the live proof (2026-06-13): with the gateway
healthy (`/healthz` 200, serving) the composite still read **degraded** because
`gym-circuit` was OPEN (11 consecutive errors). Correct — the `llm-spine` leg
must NOT absorb "the gym is failing"; that's the `gym-circuit` leg's job. A gym
that errors while its LLM transport is demonstrably reachable is a gym/upstream
problem (the gateway's own `/stats` shows `upstream429`/`upstreamErrors`), not a
spine-reachability problem — the two legs disagreeing is the signal, not a bug.

## Coda — an even-earlier boot preflight landed ahead of the DBOS race (2026-06-25)

`apps/operator/bin/hono-host.ts` now imports `./boot-integrity-first` as its
**very first statement**, ahead of `host-bootstrap` (and therefore ahead of the
DBOS-migration/HTTP-listen race trap 2 describes). It is a dependency-free
`runBootIntegrityGuardOrExit()` check (imports only `node:module`) that fails
fast with a single named diagnostic when `node_modules` is inconsistent with
source — the "every cluster worker crash-loops on a raw `MODULE_NOT_FOUND` for
\~35 minutes" class from the 2026-06-25 inconsistent-release incident, not the
Napi abort this page is otherwise about.

This does **not** change the trap-2 boot order: the HTTP listener still binds
before the DBOS system-DB migration completes (`onWorker` calls
`runBootstrap()` — which kicks off the DBOS launch without awaiting it — then
immediately `startRequestServers()`, which calls `.listen()`), so
`GET /api/health/ready`'s `dbosStarted()` gate (`health-ready.ts`) and
`waitForOperatorReady` (`operator-ready.ts`) remain the correct readiness
mechanism described above. The integrity preflight is a distinct, *earlier*
fail-fast for an unrelated failure mode (a broken checkout, not a native
runtime abort) — see
[the two-port model](/internal/docs/system/repo-conventions) and
`boot-integrity-first.ts`'s own doc-comment for detail.
